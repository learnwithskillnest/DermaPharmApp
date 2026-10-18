import type { App } from '../app.ts';
import type { Ctx } from '../http/context.ts';
import { HttpError, UserFacingError } from '../http/errors.ts';
import { render } from '../render.tsx';
import { viewCart } from '../services/cart.ts';
import {
  applyFailure,
  cancelPaymentAttempt,
  confirmFromCallback,
  handlePaymentWebhook,
  newIdempotencyKey,
  orderForUser,
  orderItems,
  placeOrder,
  startPayment,
} from '../services/orders.ts';
import { approvedPrescriptions } from '../services/prescriptions.ts';
import { addressSchema, parseWith, placeOrderSchema } from '../validation.ts';
import { CheckoutPage, ConfirmationPage, PayPage, SandboxGatewayPage, type AddressRow } from '../../ui/pages/checkout.tsx';
import { echo, owner } from './helpers.ts';
import { logger } from '../logger.ts';
import { RazorpayProvider } from '../services/payments/razorpay.ts';
import type { Errors, Values } from '../../ui/forms.tsx';

export async function userAddresses(ctx: Ctx) {
  return ctx.app.db.many<AddressRow>(
    `SELECT id, label, full_name, phone, line1, line2, landmark, city, state, pincode, is_default FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [ctx.user!.id],
  );
}

export async function saveAddress(ctx: Ctx, data: ReturnType<typeof addressSchema.parse>, id: string | null) {
  return ctx.app.db.tx(async (t) => {
    const count = await t.one<{ n: number }>('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [ctx.user!.id]);
    if (!id && (count?.n ?? 0) >= 20) throw new UserFacingError('You can save up to 20 addresses.');
    const makeDefault = data.isDefault || (count?.n ?? 0) === 0;
    if (makeDefault) await t.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [ctx.user!.id]);
    const vals = [data.label, data.fullName, data.phone, data.line1, data.line2, data.landmark, data.city, data.state, data.pincode, makeDefault];
    if (id) {
      const r = await t.one<{ id: string }>(
        `UPDATE addresses SET label=$3, full_name=$4, phone=$5, line1=$6, line2=$7, landmark=$8, city=$9, state=$10, pincode=$11, is_default = is_default OR $12
          WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, ctx.user!.id, ...vals],
      );
      if (!r) throw new HttpError(404, 'Address not found.');
      return r.id;
    }
    const r = await t.one<{ id: string }>(
      `INSERT INTO addresses (user_id, label, full_name, phone, line1, line2, landmark, city, state, pincode, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.user!.id, ...vals],
    );
    return r!.id;
  });
}

async function showCheckout(
  ctx: Ctx,
  extra: { errors?: Errors; addressErrors?: Errors; addressValues?: Values; showAddressForm?: boolean; paymentMethod?: 'online' | 'cod'; selected?: string } = {},
  status = 200,
) {
  const settings = await ctx.app.settings.all();
  const rx = await ctx.app.settings.rxOrderingEnabled();
  const cart = await viewCart(ctx.app.db, owner(ctx), settings, rx, { paymentMethod: extra.paymentMethod ?? 'online' });
  if (!cart.lines.length) {
    ctx.setFlash('info', 'Your cart is empty.');
    return ctx.redirect('/cart');
  }
  const addresses = await userAddresses(ctx);
  const prescriptions = cart.hasPrescriptionItems ? await approvedPrescriptions(ctx.app.db, ctx.user!.id) : [];
  await render(
    ctx,
    { title: 'Checkout', noindex: true },
    <CheckoutPage
      cart={cart}
      addresses={addresses}
      selectedAddressId={extra.selected ?? ctx.query.get('address') ?? addresses.find((a) => a.is_default)?.id ?? addresses[0]?.id ?? null}
      paymentMethod={extra.paymentMethod ?? 'online'}
      cod={{ enabled: settings.shipping.codEnabled, feePaise: settings.shipping.codFeePaise, maxPaise: settings.shipping.codMaxOrderPaise }}
      prescriptions={prescriptions}
      rxOrderingEnabled={rx}
      idempotencyKey={newIdempotencyKey()}
      errors={extra.errors}
      showAddressForm={!!extra.showAddressForm || ctx.query.get('new_address') === '1'}
      addressValues={extra.addressValues}
      addressErrors={extra.addressErrors}
      sandbox={ctx.app.payments.isSandbox}
    />,
    { status },
  );
}

export function checkoutRoutes(app: App) {
  const r = app.router;

  r.get('/checkout', (ctx) => showCheckout(ctx), { auth: 'user' });

  r.post(
    '/checkout/address',
    async (ctx) => {
      const v = parseWith(addressSchema, ctx.form);
      if (!v.ok) return showCheckout(ctx, { addressErrors: v.errors, addressValues: echo(ctx.form), showAddressForm: true }, 422);
      const id = await saveAddress(ctx, v.data, null);
      ctx.redirect(`/checkout?address=${id}`);
    },
    { auth: 'user' },
  );

  r.post(
    '/checkout/place',
    async (ctx) => {
      const v = parseWith(placeOrderSchema, ctx.form);
      const pm = ctx.form.paymentMethod === 'cod' ? 'cod' : 'online';
      if (!v.ok) return showCheckout(ctx, { errors: v.errors, paymentMethod: pm, selected: ctx.form.addressId }, 422);
      try {
        const res = await placeOrder(ctx.app, { id: ctx.user!.id, email: ctx.user!.email, phone: ctx.user!.phone }, owner(ctx), {
          addressId: v.data.addressId,
          paymentMethod: v.data.paymentMethod,
          prescriptionId: v.data.prescriptionId,
          note: v.data.note,
          idempotencyKey: v.data.idempotencyKey,
        });
        logger.info('order_placed', { number: res.number, duplicate: res.duplicate, method: v.data.paymentMethod });
        if (v.data.paymentMethod === 'cod') return ctx.redirect(`/orders/${res.number}/confirmation`);
        return ctx.redirect(`/checkout/pay/${res.number}`);
      } catch (e) {
        if (e instanceof UserFacingError) return showCheckout(ctx, { errors: { _form: e.message }, paymentMethod: pm, selected: ctx.form.addressId }, 422);
        throw e;
      }
    },
    { auth: 'user', rateLimit: 'placeOrder' },
  );

  r.get(
    '/checkout/pay/:number',
    async (ctx) => {
      const order = await orderForUser(ctx.app.db, ctx.params.number, ctx.user!.id);
      if (!order) throw new HttpError(404, 'Order not found.');
      if (!['pending_payment', 'payment_failed'].includes(order.status)) return ctx.redirect(`/account/orders/${order.number}`);
      let started: { providerOrderId: string };
      try {
        started = await startPayment(ctx.app, order);
      } catch (e) {
        if (e instanceof UserFacingError) {
          ctx.setFlash('error', e.message);
          return ctx.redirect(`/account/orders/${order.number}`);
        }
        logger.error('payment_start_failed', { err: e, order: order.number });
        throw new HttpError(502, 'We couldn’t reach the payment provider. Please try again in a minute.');
      }
      const rp = ctx.app.payments instanceof RazorpayProvider ? ctx.app.payments : null;
      const settings = await ctx.app.settings.all();
      await render(
        ctx,
        { title: `Pay for ${order.number}`, noindex: true },
        <PayPage
          order={order}
          sandbox={ctx.app.payments.isSandbox}
          gatewayUrl={ctx.app.payments.isSandbox ? `/sandbox-gateway/${started.providerOrderId}` : null}
          razorpay={
            rp
              ? {
                  keyId: rp.keyId,
                  providerOrderId: started.providerOrderId,
                  amountPaise: order.total_paise,
                  orderNumber: order.number,
                  storeName: settings.store.name,
                  prefill: { name: ctx.user!.name, email: ctx.user!.email, contact: order.phone },
                  csrf: ctx.csrfToken(),
                }
              : null
          }
          expiresAt={order.reservation_expires_at}
          failed={order.status === 'payment_failed' || ctx.query.get('failed') === '1'}
        />,
      );
    },
    { auth: 'user' },
  );

  /**
   * Browser return from the gateway (GET for the sandbox redirect, POST for
   * Razorpay's handler). Signature AND provider status are verified server-side.
   */
  const callback = async (ctx: Ctx) => {
    const src = ctx.method === 'POST' ? ctx.form : Object.fromEntries(ctx.query);
    const orderNumber = String(src.order_number ?? '');
    const providerOrderId = String(src.provider_order_id ?? '');
    const providerPaymentId = String(src.provider_payment_id ?? '');
    const signature = String(src.signature ?? '');
    const status = String(src.status ?? '');
    const order = await orderForUser(ctx.app.db, orderNumber, ctx.user!.id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const attempt = await ctx.app.db.one('SELECT 1 FROM payment_attempts WHERE provider_order_id = $1 AND order_id = $2', [providerOrderId, order.id]);
    if (!attempt) throw new HttpError(400, 'That payment does not belong to this order.');

    if (status === 'cancelled') {
      await cancelPaymentAttempt(ctx.app, providerOrderId);
      ctx.setFlash('info', 'Payment cancelled. Your items stay reserved for a short while if you want to try again.');
      return ctx.redirect(`/checkout/pay/${order.number}`);
    }
    if (!providerPaymentId || !signature) {
      ctx.setFlash('error', 'We did not receive a payment confirmation. If money left your account, it will be reconciled automatically.');
      return ctx.redirect(`/checkout/pay/${order.number}?failed=1`);
    }
    const result = await confirmFromCallback(ctx.app, { providerOrderId, providerPaymentId, signature });
    if (result.ok) return ctx.redirect(`/orders/${order.number}/confirmation`);
    if (result.reason === 'bad_signature' || result.reason === 'order_mismatch') {
      throw new HttpError(
        400,
        'We could not verify this payment confirmation. Your order has not been marked as paid. If you were charged, contact support with your order number.',
      );
    }
    if (result.reason === 'not_captured') {
      ctx.setFlash('error', 'The payment did not go through. You can try again.');
      return ctx.redirect(`/checkout/pay/${order.number}?failed=1`);
    }
    ctx.setFlash('error', 'Your payment is being reviewed by our team. We will email you shortly.');
    return ctx.redirect(`/account/orders/${order.number}`);
  };
  r.get('/checkout/callback', callback, { auth: 'user' });
  r.post('/checkout/callback', callback, { auth: 'user', rateLimit: 'payment' });

  // Server-to-server webhook. No session, no CSRF; authenticity comes from the HMAC signature.
  r.post(
    '/webhooks/payments',
    async (ctx) => {
      const res = await handlePaymentWebhook(ctx.app, ctx.body!.raw, ctx.req.headers);
      if (res.status !== 200) logger.warn('webhook_rejected', { outcome: res.outcome, ip: ctx.ip });
      ctx.json({ ok: res.status === 200, outcome: res.outcome }, res.status);
    },
    { csrf: false, session: false, maxBytes: 100_000 },
  );

  r.get(
    '/orders/:number/confirmation',
    async (ctx) => {
      const order = await orderForUser(ctx.app.db, ctx.params.number, ctx.user!.id);
      if (!order) throw new HttpError(404, 'Order not found.');
      if (order.payment_method === 'online' && order.payment_status !== 'paid') return ctx.redirect(`/account/orders/${order.number}`);
      await render(ctx, { title: `Order ${order.number} confirmed`, noindex: true }, <ConfirmationPage order={order} items={await orderItems(ctx.app.db, order.id)} />);
    },
    { auth: 'user' },
  );

  // ── Sandbox gateway (only exists when PAYMENT_PROVIDER=sandbox) ──
  if (app.sandbox) {
    const sandbox = app.sandbox;
    r.get(
      '/sandbox-gateway/:id',
      async (ctx) => {
        const row = await ctx.app.db.one<{ amount_paise: number; status: string; number: string | null }>(
          `SELECT s.amount_paise, s.status, o.number FROM sandbox_payments s
             LEFT JOIN payment_attempts a ON a.provider_order_id = s.provider_order_id LEFT JOIN orders o ON o.id = a.order_id
            WHERE s.provider_order_id = $1 AND (o.user_id = $2)`,
          [ctx.params.id, ctx.user!.id],
        );
        if (!row) throw new HttpError(404, 'Payment session not found.');
        if (row.status !== 'created') throw new HttpError(409, 'This payment session has already been completed.');
        const settings = await ctx.app.settings.all();
        await render(
          ctx,
          { title: 'Sandbox payment gateway', noindex: true },
          <SandboxGatewayPage providerOrderId={ctx.params.id} amountPaise={row.amount_paise} merchant={settings.store.name} orderNumber={row.number} />,
          { bare: true },
        );
      },
      { auth: 'user' },
    );

    r.post(
      '/sandbox-gateway/:id',
      async (ctx) => {
        const id = ctx.params.id;
        const row = await ctx.app.db.one<{ number: string }>(
          `SELECT o.number FROM payment_attempts a JOIN orders o ON o.id = a.order_id WHERE a.provider_order_id = $1 AND o.user_id = $2`,
          [id, ctx.user!.id],
        );
        if (!row) throw new HttpError(404, 'Payment session not found.');
        const outcome = ctx.form.outcome;
        const back = new URLSearchParams({ order_number: row.number, provider_order_id: id });
        if (outcome === 'cancelled') {
          back.set('status', 'cancelled');
          return ctx.redirect(`/checkout/callback?${back}`);
        }
        if (outcome !== 'captured' && outcome !== 'failed') throw new HttpError(400, 'Choose an outcome.');
        const done = await sandbox.complete(id, outcome);
        if (!done) throw new HttpError(409, 'This payment session has already been completed.');
        // The "gateway" also notifies the store server-to-server, exactly like a real webhook.
        const hook = sandbox.buildWebhook({
          type: outcome === 'captured' ? 'payment.captured' : 'payment.failed',
          orderId: id,
          paymentId: done.paymentId,
          amountPaise: done.amountPaise,
        });
        setImmediate(() => {
          handlePaymentWebhook(ctx.app, hook.body, hook.headers).catch((e) => logger.error('sandbox_webhook_failed', { err: e }));
        });
        if (outcome === 'failed') await applyFailure(ctx.app, id, done.paymentId, 'Sandbox: simulated decline');
        back.set('provider_payment_id', done.paymentId);
        back.set('signature', done.signature);
        ctx.redirect(`/checkout/callback?${back}`);
      },
      { auth: 'user', rateLimit: 'payment' },
    );
  }
}
