import crypto from 'node:crypto';
import type { App } from '../app.ts';
import { asJson, isUniqueViolation, type Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import { logger } from '../logger.ts';
import { formatINR } from '../../shared/money.ts';
import { audit, type Actor } from './audit.ts';
import { viewCart, type CartOwner } from './cart.ts';
import { moveStock } from './inventory.ts';
import { sendSafely } from './mail.ts';
import type { ClientCallback } from './payments/provider.ts';
import type { Settings } from './settings.ts';

export type OrderStatus =
  | 'pending_payment'
  | 'payment_failed'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancellation_requested'
  | 'cancelled'
  | 'return_requested'
  | 'returned'
  | 'refunded'
  | 'needs_attention';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Awaiting payment',
  payment_failed: 'Payment failed',
  confirmed: 'Confirmed',
  processing: 'Being packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancellation_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
  refunded: 'Refunded',
  needs_attention: 'Under review',
};

/** Allowed admin transitions. Anything else is rejected server-side. */
export const ADMIN_TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  cancellation_requested: ['cancelled', 'processing'],
  return_requested: ['returned', 'delivered'],
  needs_attention: ['confirmed', 'cancelled'],
  payment_failed: ['cancelled'],
  pending_payment: ['cancelled'],
};

export interface OrderRow {
  id: string;
  number: string;
  user_id: string | null;
  email: string;
  phone: string;
  status: OrderStatus;
  payment_method: 'online' | 'cod';
  payment_status: string;
  subtotal_paise: number;
  discount_paise: number;
  shipping_paise: number;
  cod_fee_paise: number;
  tax_paise: number;
  total_paise: number;
  coupon_code: string | null;
  shipping_address: Record<string, string | null>;
  customer_note: string | null;
  requires_rx_review: boolean;
  rx_review_status: 'pending' | 'approved' | 'rejected' | null;
  prescription_id: string | null;
  reservation_expires_at: Date | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_name: string;
  sku: string;
  unit_price_paise: number;
  unit_mrp_paise: number;
  quantity: number;
  tax_rate_bps: number;
  line_total_paise: number;
  line_discount_paise: number;
  tax_paise: number;
  requires_prescription: boolean;
  hsn_code: string | null;
  product_slug?: string | null;
}

const ORDER_COLS = `o.id, o.number, o.user_id, o.email, o.phone, o.status, o.payment_method, o.payment_status, o.subtotal_paise,
  o.discount_paise, o.shipping_paise, o.cod_fee_paise, o.tax_paise, o.total_paise, o.coupon_code, o.shipping_address, o.customer_note,
  o.requires_rx_review, o.rx_review_status, o.prescription_id, o.reservation_expires_at, o.paid_at, o.cancelled_at, o.cancel_reason,
  o.created_at, o.updated_at`;

async function event(t: Queryable, orderId: string, status: string, note: string | null, actorId: string | null = null, visible = true) {
  await t.query('INSERT INTO order_events (order_id, status, note, actor_id, visible_to_customer) VALUES ($1, $2, $3, $4, $5)', [orderId, status, note, actorId, visible]);
}

// ─────────────────────────── Placing orders ───────────────────────────

export interface PlaceOrderInput {
  addressId: string;
  paymentMethod: 'online' | 'cod';
  prescriptionId?: string;
  note: string | null;
  idempotencyKey: string;
}

export async function placeOrder(app: App, user: { id: string; email: string; phone: string | null }, owner: CartOwner, input: PlaceOrderInput) {
  const settings = await app.settings.all();
  const rxEnabled = await app.settings.rxOrderingEnabled();

  // Idempotency: a double-submitted checkout returns the first order. The
  // unique index on idempotency_key settles concurrent duplicates.
  const findDup = () => app.db.one<{ number: string }>('SELECT number FROM orders WHERE idempotency_key = $1 AND user_id = $2', [input.idempotencyKey, user.id]);
  const dup = await findDup();
  if (dup) return { number: dup.number, duplicate: true };

  try {
    return await placeOrderTx(app, user, owner, input, settings, rxEnabled);
  } catch (e) {
    if (isUniqueViolation(e, 'orders_idempotency_key')) {
      const again = await findDup();
      if (again) return { number: again.number, duplicate: true };
    }
    throw e;
  }
}

async function placeOrderTx(app: App, user: { id: string; email: string; phone: string | null }, owner: CartOwner, input: PlaceOrderInput, settings: Settings, rxEnabled: boolean) {
  return app.db.tx(async (t) => {
    // Serialise concurrent submissions of the same checkout (double-click, retry):
    // the second waits here, then sees the first order instead of an emptied cart.
    await t.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['order:' + input.idempotencyKey]);
    const existing = await t.one<{ number: string }>('SELECT number FROM orders WHERE idempotency_key = $1 AND user_id = $2', [input.idempotencyKey, user.id]);
    if (existing) return { number: existing.number, duplicate: true as const, orderId: '', isCod: input.paymentMethod === 'cod' };

    const address = await t.one<Record<string, string | null>>(
      'SELECT full_name, phone, line1, line2, landmark, city, state, pincode FROM addresses WHERE id = $1 AND user_id = $2',
      [input.addressId, user.id],
    );
    if (!address) throw new UserFacingError('Choose one of your saved delivery addresses.', 'address');
    const pin = address.pincode ?? '';
    if (settings.shipping.blockedPincodePrefixes.some((p) => pin.startsWith(p))) {
      throw new UserFacingError(`We do not deliver to PIN code ${pin} yet.`, 'not_serviceable');
    }

    // Locks the variant rows (ordered by id → no deadlocks) for the rest of the transaction.
    const cart = await viewCart(t, owner, settings, rxEnabled, { paymentMethod: input.paymentMethod, lockRows: true });
    if (!cart.cartId || cart.lines.length === 0) throw new UserFacingError('Your cart is empty.', 'empty');
    if (cart.issues.length) throw new UserFacingError(cart.issues[0], 'cart_issue');
    const q = cart.quote;
    if (q.coupon && !q.coupon.applied) throw new UserFacingError(q.coupon.message ?? 'Remove the coupon and try again.', 'coupon');

    let prescriptionId: string | null = null;
    if (cart.hasPrescriptionItems) {
      if (!rxEnabled) throw new UserFacingError('Prescription medicines cannot be ordered online at the moment.', 'rx_disabled');
      if (!input.prescriptionId) throw new UserFacingError('Choose an approved prescription for the prescription items in your cart.', 'rx_required');
      const rx = await t.one<{ id: string }>(
        `SELECT id FROM prescriptions WHERE id = $1 AND user_id = $2 AND status = 'approved' AND (valid_until IS NULL OR valid_until >= current_date)`,
        [input.prescriptionId, user.id],
      );
      if (!rx) throw new UserFacingError('That prescription is not approved or has expired. Upload a current prescription.', 'rx_invalid');
      prescriptionId = rx.id;
    }

    if (input.paymentMethod === 'cod') {
      if (cart.hasPrescriptionItems) throw new UserFacingError('Cash on delivery is not available for prescription orders.', 'cod_rx');
      if (!settings.shipping.codEnabled) throw new UserFacingError('Cash on delivery is not available right now.', 'cod_disabled');
      if (q.totalPaise > settings.shipping.codMaxOrderPaise) {
        throw new UserFacingError(`Cash on delivery is available for orders up to ${formatINR(settings.shipping.codMaxOrderPaise)}.`, 'cod_limit');
      }
    }

    const seq = await t.one<{ n: number }>(`SELECT nextval('order_number_seq')::int AS n`);
    const number = `GD-${seq!.n}`;
    const isCod = input.paymentMethod === 'cod';
    const reservationExpires = isCod ? null : new Date(Date.now() + settings.orders.reservationMinutes * 60_000);
    const order = await t.one<{ id: string }>(
      `INSERT INTO orders (number, user_id, email, phone, status, payment_method, payment_status, subtotal_paise, discount_paise,
         shipping_paise, cod_fee_paise, tax_paise, total_paise, coupon_code, shipping_address, customer_note, requires_rx_review,
         rx_review_status, prescription_id, reservation_expires_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [
        number,
        user.id,
        user.email,
        address.phone ?? user.phone ?? '',
        isCod ? 'confirmed' : 'pending_payment',
        input.paymentMethod,
        isCod ? 'cod_pending' : 'pending',
        q.subtotalPaise,
        q.discountPaise,
        q.shippingPaise,
        q.codFeePaise,
        q.taxPaise,
        q.totalPaise,
        q.coupon?.applied ? q.coupon.code : null,
        asJson(address),
        input.note,
        cart.hasPrescriptionItems,
        cart.hasPrescriptionItems ? 'pending' : null,
        prescriptionId,
        reservationExpires,
        input.idempotencyKey,
      ],
    );
    const orderId = order!.id;

    for (const l of q.lines) {
      await t.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_name, sku, unit_price_paise, unit_mrp_paise,
           quantity, tax_rate_bps, line_total_paise, line_discount_paise, tax_paise, requires_prescription, hsn_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          orderId,
          l.productId,
          l.variantId,
          l.productName,
          l.variantName,
          l.sku,
          l.unitPricePaise,
          l.unitMrpPaise,
          l.quantity,
          l.taxRateBps,
          l.lineTotalPaise,
          l.lineDiscountPaise,
          l.taxPaise,
          l.requiresPrescription,
          l.hsnCode ?? null,
        ],
      );
      // Reserve stock now; released automatically if payment never completes.
      await moveStock(t, { variantId: l.variantId, delta: -l.quantity, reason: 'order_reserved', reference: number });
    }

    if (q.coupon?.applied && q.coupon.couponId) {
      await t.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [q.coupon.couponId]);
      await t.query('INSERT INTO coupon_redemptions (coupon_id, order_id, user_id) VALUES ($1, $2, $3)', [q.coupon.couponId, orderId, user.id]);
    }

    await t.query('DELETE FROM cart_items WHERE cart_id = $1', [cart.cartId]);
    await t.query('UPDATE carts SET coupon_code = NULL WHERE id = $1', [cart.cartId]);
    await event(t, orderId, isCod ? 'confirmed' : 'pending_payment', isCod ? 'Order confirmed — pay cash on delivery.' : 'Waiting for payment.', user.id);
    return { number, duplicate: false as const, orderId, isCod };
  });
}

// ─────────────────────────── Queries ───────────────────────────

export async function orderByNumber(db: Queryable, number: string) {
  return db.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.number = $1`, [number]);
}

export async function orderForUser(db: Queryable, number: string, userId: string) {
  return db.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.number = $1 AND o.user_id = $2`, [number, userId]);
}

export async function orderItems(db: Queryable, orderId: string) {
  return db.many<OrderItemRow>(`SELECT i.*, p.slug AS product_slug FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY i.product_name`, [
    orderId,
  ]);
}

export async function orderTimeline(db: Queryable, orderId: string, customerView: boolean) {
  return db.many<{ status: string; note: string | null; created_at: Date }>(
    `SELECT status, note, created_at FROM order_events WHERE order_id = $1 ${customerView ? 'AND visible_to_customer' : ''} ORDER BY created_at, id`,
    [orderId],
  );
}

export async function orderShipments(db: Queryable, orderId: string) {
  return db.many<{ id: string; carrier: string; tracking_number: string; tracking_url: string | null; status: string; shipped_at: Date; delivered_at: Date | null }>(
    'SELECT id, carrier, tracking_number, tracking_url, status, shipped_at, delivered_at FROM shipments WHERE order_id = $1 ORDER BY shipped_at',
    [orderId],
  );
}

export async function ordersForUser(db: Queryable, userId: string) {
  return db.many<OrderRow & { item_count: number }>(
    `SELECT ${ORDER_COLS}, (SELECT coalesce(sum(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o WHERE o.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
    [userId],
  );
}

// ─────────────────────────── Payments ───────────────────────────

/** Creates (or reuses) a gateway order for an unpaid order. */
export async function startPayment(app: App, order: OrderRow) {
  if (order.payment_method !== 'online') throw new UserFacingError('This order is cash on delivery.');
  if (!['pending_payment', 'payment_failed'].includes(order.status)) throw new UserFacingError('This order no longer needs payment.', 'not_payable');
  if (order.reservation_expires_at && order.reservation_expires_at < new Date()) {
    await expireReservations(app);
    throw new UserFacingError('The time to pay for this order has run out and it was cancelled. Your items are back in stock — please order again.', 'expired');
  }
  const existing = await app.db.one<{ provider_order_id: string }>(
    `SELECT provider_order_id FROM payment_attempts WHERE order_id = $1 AND status = 'created' AND amount_paise = $2 AND provider = $3
      ORDER BY created_at DESC LIMIT 1`,
    [order.id, order.total_paise, app.payments.name],
  );
  if (existing) return { providerOrderId: existing.provider_order_id };
  const created = await app.payments.createOrder({ amountPaise: order.total_paise, receipt: order.number, notes: { order_number: order.number } });
  await app.db.query('INSERT INTO payment_attempts (order_id, provider, provider_order_id, amount_paise) VALUES ($1, $2, $3, $4)', [
    order.id,
    app.payments.name,
    created.providerOrderId,
    order.total_paise,
  ]);
  return created;
}

export type PaymentResult =
  | { ok: true; orderNumber: string; already: boolean }
  | { ok: false; reason: 'bad_signature' | 'unknown_attempt' | 'not_captured' | 'amount_mismatch' | 'order_mismatch'; orderNumber?: string };

/**
 * Browser callback. The redirect itself proves nothing: we verify the HMAC
 * signature AND ask the provider for the payment's status and amount before
 * marking anything paid.
 */
export async function confirmFromCallback(app: App, cb: ClientCallback): Promise<PaymentResult> {
  if (!app.payments.verifyClientSignature(cb)) {
    logger.warn('payment_signature_rejected', { providerOrderId: cb.providerOrderId });
    await app.db.query(`UPDATE payment_attempts SET failure_reason = 'signature_mismatch', updated_at = now() WHERE provider_order_id = $1 AND status = 'created'`, [
      cb.providerOrderId,
    ]);
    return { ok: false, reason: 'bad_signature' };
  }
  const payment = await app.payments.fetchPayment(cb.providerPaymentId);
  if (!payment || payment.orderId !== cb.providerOrderId) return { ok: false, reason: 'order_mismatch' };
  if (payment.status === 'failed') {
    await applyFailure(app, cb.providerOrderId, cb.providerPaymentId, 'Payment declined by the gateway');
    const o = await app.db.one<{ number: string }>('SELECT o.number FROM orders o JOIN payment_attempts a ON a.order_id = o.id WHERE a.provider_order_id = $1', [
      cb.providerOrderId,
    ]);
    return { ok: false, reason: 'not_captured', orderNumber: o?.number };
  }
  if (payment.status !== 'captured') return { ok: false, reason: 'not_captured' };
  return applyCapture(app, { providerOrderId: cb.providerOrderId, providerPaymentId: cb.providerPaymentId, amountPaise: payment.amountPaise, source: 'callback' });
}

/** Idempotent: safe to call any number of times for the same payment (callback + webhook + retries). */
export async function applyCapture(
  app: App,
  p: { providerOrderId: string; providerPaymentId: string; amountPaise: number; source: 'callback' | 'webhook' },
): Promise<PaymentResult> {
  const result = await app.db.tx(async (t): Promise<PaymentResult & { notify?: { email: string; number: string; total: number } }> => {
    const attempt = await t.one<{ id: string; order_id: string; status: string; amount_paise: number }>(
      'SELECT id, order_id, status, amount_paise FROM payment_attempts WHERE provider_order_id = $1 FOR UPDATE',
      [p.providerOrderId],
    );
    if (!attempt) return { ok: false, reason: 'unknown_attempt' };
    const order = await t.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1 FOR UPDATE`, [attempt.order_id]);
    if (!order) return { ok: false, reason: 'unknown_attempt' };
    if (attempt.status === 'captured') return { ok: true, orderNumber: order.number, already: true };
    if (p.amountPaise !== attempt.amount_paise || attempt.amount_paise !== order.total_paise) {
      await t.query(`UPDATE orders SET status = 'needs_attention', updated_at = now() WHERE id = $1`, [order.id]);
      await event(t, order.id, 'needs_attention', `Amount mismatch: captured ${p.amountPaise}, expected ${order.total_paise}`, null, false);
      logger.error('payment_amount_mismatch', { order: order.number, captured: p.amountPaise, expected: order.total_paise });
      return { ok: false, reason: 'amount_mismatch', orderNumber: order.number };
    }
    await t.query(`UPDATE payment_attempts SET status = 'captured', provider_payment_id = $2, signature_verified = true, updated_at = now() WHERE id = $1`, [
      attempt.id,
      p.providerPaymentId,
    ]);

    if (order.status === 'pending_payment' || order.status === 'payment_failed') {
      await t.query(`UPDATE orders SET status = 'confirmed', payment_status = 'paid', paid_at = now(), reservation_expires_at = NULL, updated_at = now() WHERE id = $1`, [
        order.id,
      ]);
      await event(t, order.id, 'confirmed', `Payment received (${formatINR(p.amountPaise)}).`);
    } else if (order.status === 'cancelled') {
      // Paid after the reservation lapsed: try to re-reserve, otherwise flag for refund.
      const items = await t.many<{ variant_id: string; quantity: number }>('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id', [order.id]);
      try {
        for (const i of items)
          await moveStock(t, { variantId: i.variant_id, delta: -i.quantity, reason: 'order_reserved', reference: order.number, note: 'Late payment re-reservation' });
        await t.query(
          `UPDATE orders SET status = 'confirmed', payment_status = 'paid', paid_at = now(), cancelled_at = NULL, cancel_reason = NULL, updated_at = now() WHERE id = $1`,
          [order.id],
        );
        await event(t, order.id, 'confirmed', 'Payment received after the reservation window; items re-reserved.');
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        await t.query(`UPDATE orders SET status = 'needs_attention', payment_status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1`, [order.id]);
        await event(t, order.id, 'needs_attention', 'Payment received after cancellation; stock unavailable. A refund will be issued.');
      }
    } else {
      await t.query(`UPDATE orders SET payment_status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now() WHERE id = $1`, [order.id]);
    }
    return { ok: true, orderNumber: order.number, already: false, notify: { email: order.email, number: order.number, total: order.total_paise } };
  });
  if (result.ok && !result.already && result.notify) {
    await sendSafely(
      app.mailer,
      result.notify.email,
      `Order ${result.notify.number} confirmed`,
      `Thank you. We received your payment of ${formatINR(result.notify.total)} for order ${result.notify.number}.\n\nTrack it at ${app.config.APP_URL}/account/orders/${result.notify.number}`,
    );
  }
  return result.ok ? { ok: true, orderNumber: result.orderNumber, already: result.already } : result;
}

export async function applyFailure(app: App, providerOrderId: string, providerPaymentId: string | null, reason: string) {
  await app.db.tx(async (t) => {
    const attempt = await t.one<{ id: string; order_id: string; status: string }>('SELECT id, order_id, status FROM payment_attempts WHERE provider_order_id = $1 FOR UPDATE', [
      providerOrderId,
    ]);
    if (!attempt || attempt.status === 'captured' || attempt.status === 'failed') return;
    await t.query(`UPDATE payment_attempts SET status = 'failed', provider_payment_id = coalesce($2, provider_payment_id), failure_reason = $3, updated_at = now() WHERE id = $1`, [
      attempt.id,
      providerPaymentId,
      reason,
    ]);
    const r = await t.query(`UPDATE orders SET status = 'payment_failed', payment_status = 'failed', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [
      attempt.order_id,
    ]);
    if (r.rowCount) await event(t, attempt.order_id, 'payment_failed', 'Payment did not go through. You can retry before the reservation expires.');
  });
}

export async function cancelPaymentAttempt(app: App, providerOrderId: string) {
  await app.db.query(`UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE provider_order_id = $1 AND status = 'created'`, [providerOrderId]);
}

/** Webhook entry point: verifies signature, dedupes by event id, applies outcome. */
export async function handlePaymentWebhook(app: App, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  const ev = app.payments.parseWebhook(raw, headers);
  if (!ev) return { status: 400 as const, outcome: 'invalid_signature' };
  const inserted = await app.db.one<{ id: number }>(
    `INSERT INTO payment_events (provider, event_id, event_type, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [app.payments.name, ev.eventId, ev.type, asJson(ev.raw)],
  );
  if (!inserted) return { status: 200 as const, outcome: 'duplicate' };
  let outcome = 'ignored';
  if (ev.outcome === 'captured' && ev.providerOrderId && ev.providerPaymentId && ev.amountPaise !== null) {
    const r = await applyCapture(app, { providerOrderId: ev.providerOrderId, providerPaymentId: ev.providerPaymentId, amountPaise: ev.amountPaise, source: 'webhook' });
    outcome = r.ok ? (r.already ? 'already_captured' : 'captured') : r.reason;
  } else if (ev.outcome === 'failed' && ev.providerOrderId) {
    await applyFailure(app, ev.providerOrderId, ev.providerPaymentId, 'Gateway reported failure');
    outcome = 'failed';
  }
  await app.db.query('UPDATE payment_events SET processed_at = now(), outcome = $2 WHERE id = $1', [inserted.id, outcome]);
  return { status: 200 as const, outcome };
}

// ─────────────────────────── Cancellation & lifecycle ───────────────────────────

async function releaseOrderStock(t: Queryable, orderId: string, number: string, actorId: string | null) {
  const items = await t.many<{ variant_id: string | null; quantity: number }>('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id', [orderId]);
  for (const i of items) {
    if (i.variant_id) await moveStock(t, { variantId: i.variant_id, delta: i.quantity, reason: 'order_released', reference: number, actorId });
  }
  const red = await t.one<{ coupon_id: string }>('DELETE FROM coupon_redemptions WHERE order_id = $1 RETURNING coupon_id', [orderId]);
  if (red) await t.query('UPDATE coupons SET used_count = greatest(0, used_count - 1) WHERE id = $1', [red.coupon_id]);
}

/** Cancels unpaid online orders whose reservation window has passed. */
export async function expireReservations(app: App) {
  const due = await app.db.many<{ id: string }>(`SELECT id FROM orders WHERE status IN ('pending_payment', 'payment_failed') AND reservation_expires_at < now() LIMIT 200`);
  for (const { id } of due) {
    await app.db.tx(async (t) => {
      const o = await t.one<{ number: string; status: string }>(`SELECT number, status FROM orders WHERE id = $1 FOR UPDATE`, [id]);
      if (!o || !['pending_payment', 'payment_failed'].includes(o.status)) return;
      await releaseOrderStock(t, id, o.number, null);
      await t.query(
        `UPDATE orders SET status = 'cancelled', payment_status = 'failed', cancelled_at = now(), cancel_reason = 'Payment not completed in time', updated_at = now() WHERE id = $1`,
        [id],
      );
      await t.query(`UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'created'`, [id]);
      await event(t, id, 'cancelled', 'Cancelled automatically because payment was not completed in time.');
    });
  }
  return due.length;
}

export const CUSTOMER_CANCELLABLE: OrderStatus[] = ['pending_payment', 'payment_failed', 'confirmed'];

/**
 * Customer cancellation. Before packing it is immediate (stock released, refund
 * queued if paid). Once packing starts it becomes a request for staff.
 */
export async function customerCancel(app: App, order: OrderRow, userId: string, reason: string) {
  return app.db.tx(async (t) => {
    const o = await t.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1 AND o.user_id = $2 FOR UPDATE`, [order.id, userId]);
    if (!o) throw new UserFacingError('Order not found.', 'not_found', 404);
    if (CUSTOMER_CANCELLABLE.includes(o.status)) {
      await releaseOrderStock(t, o.id, o.number, userId);
      const paid = o.payment_status === 'paid';
      await t.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, reservation_expires_at = NULL,
           payment_status = CASE WHEN payment_status = 'paid' THEN 'refund_pending'::payment_status
                                 WHEN payment_status = 'cod_pending' THEN payment_status ELSE 'failed'::payment_status END,
           updated_at = now() WHERE id = $1`,
        [o.id, reason],
      );
      await t.query(`UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status = 'created'`, [o.id]);
      if (paid) {
        await t.query(
          `INSERT INTO return_requests (order_id, user_id, kind, reason, status, refund_paise) VALUES ($1, $2, 'refund_only', 'Order cancelled before dispatch', 'approved', $3)`,
          [o.id, userId, o.total_paise],
        );
      }
      await event(
        t,
        o.id,
        'cancelled',
        paid ? `Cancelled by you. A refund of ${formatINR(o.total_paise)} will be issued to the original payment method.` : 'Cancelled by you.',
        userId,
      );
      return { result: 'cancelled' as const, refund: paid };
    }
    if (o.status === 'processing') {
      await t.query(`UPDATE orders SET status = 'cancellation_requested', cancel_reason = $2, updated_at = now() WHERE id = $1`, [o.id, reason]);
      await event(t, o.id, 'cancellation_requested', 'Cancellation requested. Our team will confirm shortly.', userId);
      return { result: 'requested' as const, refund: false };
    }
    throw new UserFacingError('This order can no longer be cancelled. You can request a return after delivery.', 'not_cancellable');
  });
}

/** Admin status change, validated against ADMIN_TRANSITIONS. */
export async function adminSetStatus(app: App, orderId: string, to: OrderStatus, actor: Actor, note: string | null) {
  return app.db.tx(async (t) => {
    const o = await t.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw new UserFacingError('Order not found.', 'not_found', 404);
    const allowed = ADMIN_TRANSITIONS[o.status] ?? [];
    if (!allowed.includes(to)) throw new UserFacingError(`Cannot move an order from "${STATUS_LABEL[o.status]}" to "${STATUS_LABEL[to]}".`, 'bad_transition');
    if (to === 'processing' && o.requires_rx_review && o.rx_review_status !== 'approved') {
      throw new UserFacingError('A pharmacist must approve this prescription order before it can be packed.', 'rx_review');
    }
    if (to === 'shipped') {
      const s = await t.one('SELECT 1 FROM shipments WHERE order_id = $1', [orderId]);
      if (!s) throw new UserFacingError('Add a shipment with a tracking number before marking the order shipped.', 'no_shipment');
    }
    if (to === 'cancelled') {
      await releaseOrderStock(t, o.id, o.number, actor.id);
      const paid = o.payment_status === 'paid';
      await t.query(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce($2, cancel_reason, 'Cancelled by store'),
           payment_status = CASE WHEN payment_status = 'paid' THEN 'refund_pending'::payment_status ELSE payment_status END, updated_at = now() WHERE id = $1`,
        [o.id, note],
      );
      if (paid) {
        await t.query(
          `INSERT INTO return_requests (order_id, user_id, kind, reason, status, refund_paise) VALUES ($1, $2, 'refund_only', 'Order cancelled', 'approved', $3)
           ON CONFLICT DO NOTHING`,
          [o.id, o.user_id, o.total_paise],
        );
      }
    } else {
      await t.query(`UPDATE orders SET status = $2, updated_at = now() WHERE id = $1`, [o.id, to]);
      if (to === 'delivered') {
        await t.query(`UPDATE shipments SET status = 'delivered', delivered_at = coalesce(delivered_at, now()) WHERE order_id = $1`, [o.id]);
        if (o.payment_method === 'cod') await t.query(`UPDATE orders SET payment_status = 'cod_collected' WHERE id = $1 AND payment_status = 'cod_pending'`, [o.id]);
      }
    }
    await event(t, o.id, to, note ?? STATUS_LABEL[to], actor.id);
    await audit(t, actor, 'order.status', 'order', o.id, { from: o.status, to, number: o.number });
    return { from: o.status, to, email: o.email, number: o.number };
  });
}

export async function addShipment(app: App, orderId: string, s: { carrier: string; trackingNumber: string; trackingUrl: string | null }, actor: Actor) {
  return app.db.tx(async (t) => {
    const o = await t.one<OrderRow>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1 FOR UPDATE`, [orderId]);
    if (!o) throw new UserFacingError('Order not found.', 'not_found', 404);
    if (!['processing', 'confirmed', 'shipped'].includes(o.status)) throw new UserFacingError('Shipments can only be added to confirmed or packed orders.');
    if (o.requires_rx_review && o.rx_review_status !== 'approved') throw new UserFacingError('Pharmacist approval is required before dispatch.', 'rx_review');
    await t.query('INSERT INTO shipments (order_id, carrier, tracking_number, tracking_url) VALUES ($1, $2, $3, $4)', [orderId, s.carrier, s.trackingNumber, s.trackingUrl]);
    if (o.status !== 'shipped') {
      await t.query(`UPDATE orders SET status = 'shipped', updated_at = now() WHERE id = $1`, [orderId]);
      await event(t, orderId, 'shipped', `Shipped with ${s.carrier}. Tracking number ${s.trackingNumber}.`, actor.id);
    }
    await audit(t, actor, 'order.shipment_added', 'order', orderId, { carrier: s.carrier, tracking: s.trackingNumber });
    return o;
  });
}

export function newIdempotencyKey() {
  return crypto.randomBytes(18).toString('base64url');
}
