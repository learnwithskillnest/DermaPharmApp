import { verifyPassword } from '../auth/password.ts';
import type { App } from '../app.ts';
import type { Ctx } from '../http/context.ts';
import { HttpError, UserFacingError } from '../http/errors.ts';
import { render } from '../render.tsx';
import { signOut } from '../auth/session.ts';
import { productsByIds } from '../services/catalog.ts';
import { customerCancel, orderForUser, orderItems, orderShipments, orderTimeline, ordersForUser } from '../services/orders.ts';
import { getPrescription, prescriptionsForUser, readPrescriptionFile, savePrescription } from '../services/prescriptions.ts';
import { requestReturn, returnsForOrder } from '../services/returns.ts';
import { changePassword, deleteAccount } from '../services/users.ts';
import { addressSchema, changePasswordSchema, parseWith, profileSchema, returnRequestSchema, rxUploadSchema } from '../validation.ts';
import { AccountHome, AddressesPage, AddressFormPage, OrderDetailPage, OrdersPage, PrescriptionsPage, SettingsPage, WishlistPage } from '../../ui/pages/account.tsx';
import { actor, echo, requireUuid, visibility } from './helpers.ts';
import { saveAddress, userAddresses } from './checkout.tsx';
import type { Errors } from '../../ui/forms.tsx';

const auth = { auth: 'user' as const };

async function showOrder(ctx: Ctx, number: string, errors?: Errors, status = 200) {
  const order = await orderForUser(ctx.app.db, number, ctx.user!.id);
  if (!order) throw new HttpError(404, 'Order not found.');
  const settings = await ctx.app.settings.all();
  const [items, timeline, shipments, returns] = await Promise.all([
    orderItems(ctx.app.db, order.id),
    orderTimeline(ctx.app.db, order.id, true),
    orderShipments(ctx.app.db, order.id),
    returnsForOrder(ctx.app.db, order.id),
  ]);
  const deliveredAt = shipments.find((s) => s.delivered_at)?.delivered_at ?? order.updated_at;
  const returnWindowOpen = Date.now() < deliveredAt.getTime() + settings.orders.returnWindowDays * 86_400_000;
  await render(
    ctx,
    { title: `Order ${order.number}`, noindex: true },
    <OrderDetailPage order={order} items={items} timeline={timeline} shipments={shipments} returns={returns} returnWindowOpen={returnWindowOpen} errors={errors} />,
    { status },
  );
}

async function showPrescriptions(ctx: Ctx, errors?: Errors, values?: Record<string, string>, status = 200) {
  const list = await prescriptionsForUser(ctx.app.db, ctx.user!.id);
  await render(
    ctx,
    { title: 'Prescriptions', noindex: true },
    <PrescriptionsPage
      list={list}
      errors={errors}
      values={values}
      rxOrderingEnabled={await ctx.app.settings.rxOrderingEnabled()}
      maxMb={Math.round(ctx.app.config.PRESCRIPTION_MAX_BYTES / 1_000_000)}
    />,
    { status },
  );
}

async function showSettings(ctx: Ctx, extra: { profileErrors?: Errors; passwordErrors?: Errors } = {}, status = 200) {
  const u = await ctx.app.db.one<{ name: string; phone: string | null; email: string; marketing_opt_in: boolean }>(
    'SELECT name, phone, email, marketing_opt_in FROM users WHERE id = $1',
    [ctx.user!.id],
  );
  const sessions = await ctx.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()', [ctx.user!.id]);
  await render(
    ctx,
    { title: 'Profile & security', noindex: true },
    <SettingsPage values={{ name: u!.name, phone: u!.phone ?? '', email: u!.email, marketing: u!.marketing_opt_in ? 'on' : '' }} sessions={sessions?.n ?? 1} {...extra} />,
    { status },
  );
}

export function accountRoutes(app: App) {
  const r = app.router;

  r.get(
    '/account',
    async (ctx) => {
      const [orders, wl, ad] = await Promise.all([
        ordersForUser(ctx.app.db, ctx.user!.id),
        ctx.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM wishlist_items WHERE user_id = $1', [ctx.user!.id]),
        ctx.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [ctx.user!.id]),
      ]);
      await render(ctx, { title: 'Your account', noindex: true }, <AccountHome name={ctx.user!.name} orders={orders} wishlistCount={wl?.n ?? 0} addressCount={ad?.n ?? 0} />);
    },
    auth,
  );

  r.get('/account/orders', async (ctx) => render(ctx, { title: 'Your orders', noindex: true }, <OrdersPage orders={await ordersForUser(ctx.app.db, ctx.user!.id)} />), auth);
  r.get('/account/orders/:number', (ctx) => showOrder(ctx, ctx.params.number), auth);

  r.post(
    '/account/orders/:number/cancel',
    async (ctx) => {
      const order = await orderForUser(ctx.app.db, ctx.params.number, ctx.user!.id);
      if (!order) throw new HttpError(404, 'Order not found.');
      const reason = (ctx.form.reason ?? 'Other').slice(0, 120);
      try {
        const res = await customerCancel(ctx.app, order, ctx.user!.id, reason);
        ctx.setFlash(
          'success',
          res.result === 'cancelled' ? (res.refund ? 'Order cancelled. Your refund is being processed.' : 'Order cancelled.') : 'Cancellation requested. We’ll confirm shortly.',
        );
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect(`/account/orders/${order.number}`);
    },
    auth,
  );

  r.post(
    '/account/orders/:number/return',
    async (ctx) => {
      const order = await orderForUser(ctx.app.db, ctx.params.number, ctx.user!.id);
      if (!order) throw new HttpError(404, 'Order not found.');
      const v = parseWith(returnRequestSchema, ctx.form);
      if (!v.ok) return showOrder(ctx, order.number, v.errors, 422);
      try {
        await requestReturn(ctx.app, order, ctx.user!.id, v.data.reason, v.data.details);
        ctx.setFlash('success', 'Return requested. We’ll review it within 2 business days.');
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect(`/account/orders/${order.number}`);
    },
    auth,
  );

  // ── Addresses ──
  r.get('/account/addresses', async (ctx) => render(ctx, { title: 'Addresses', noindex: true }, <AddressesPage addresses={await userAddresses(ctx)} />), auth);
  r.get('/account/addresses/new', async (ctx) => render(ctx, { title: 'Add an address', noindex: true }, <AddressFormPage id={null} />), auth);
  r.post(
    '/account/addresses/new',
    async (ctx) => {
      const v = parseWith(addressSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Add an address' }, <AddressFormPage id={null} errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      try {
        await saveAddress(ctx, v.data, null);
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return render(ctx, { title: 'Add an address' }, <AddressFormPage id={null} errors={{ _form: e.message }} values={echo(ctx.form)} />, { status: 422 });
      }
      ctx.setFlash('success', 'Address saved.');
      ctx.redirect('/account/addresses');
    },
    auth,
  );
  r.get(
    '/account/addresses/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const a = (await userAddresses(ctx)).find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'Address not found.');
      const values = {
        label: a.label,
        fullName: a.full_name,
        phone: a.phone,
        line1: a.line1,
        line2: a.line2,
        landmark: a.landmark,
        city: a.city,
        state: a.state,
        pincode: a.pincode,
        isDefault: a.is_default ? 'on' : '',
      };
      await render(ctx, { title: 'Edit address', noindex: true }, <AddressFormPage id={id} values={values} />);
    },
    auth,
  );
  r.post(
    '/account/addresses/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const v = parseWith(addressSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Edit address' }, <AddressFormPage id={id} errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      await saveAddress(ctx, v.data, id);
      ctx.setFlash('success', 'Address updated.');
      ctx.redirect('/account/addresses');
    },
    auth,
  );
  r.post(
    '/account/addresses/:id/default',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      await ctx.app.db.tx(async (t) => {
        const ok = await t.one('SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2', [id, ctx.user!.id]);
        if (!ok) throw new HttpError(404, 'Address not found.');
        await t.query('UPDATE addresses SET is_default = (id = $2) WHERE user_id = $1', [ctx.user!.id, id]);
      });
      ctx.setFlash('success', 'Default address updated.');
      ctx.redirect('/account/addresses');
    },
    auth,
  );
  r.post(
    '/account/addresses/:id/delete',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      await ctx.app.db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [id, ctx.user!.id]);
      ctx.setFlash('success', 'Address deleted.');
      ctx.redirect('/account/addresses');
    },
    auth,
  );

  // ── Wishlist ──
  r.get(
    '/account/wishlist',
    async (ctx) => {
      const ids = (await ctx.app.db.many<{ product_id: string }>('SELECT product_id FROM wishlist_items WHERE user_id = $1 ORDER BY created_at DESC', [ctx.user!.id])).map(
        (x) => x.product_id,
      );
      const items = await productsByIds(ctx.app.db, ids, visibility(await ctx.app.settings.all()));
      await render(ctx, { title: 'Wishlist', noindex: true }, <WishlistPage items={items} />);
    },
    auth,
  );

  // ── Prescriptions ──
  r.get('/account/prescriptions', (ctx) => showPrescriptions(ctx), auth);
  r.post(
    '/account/prescriptions',
    async (ctx) => {
      const v = parseWith(rxUploadSchema, ctx.form);
      if (!v.ok) return showPrescriptions(ctx, v.errors, echo(ctx.form), 422);
      try {
        await savePrescription(
          ctx.app,
          ctx.user!.id,
          ctx.body?.files.find((f) => f.field === 'file'),
          {
            patientName: v.data.patientName,
            doctorName: v.data.doctorName,
            issuedOn: v.data.issuedOn,
          },
        );
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showPrescriptions(ctx, { [e.code === 'file' ? 'file' : '_form']: e.message }, echo(ctx.form), 422);
      }
      ctx.setFlash('success', 'Prescription uploaded. Our pharmacist will review it.');
      ctx.redirect('/account/prescriptions');
    },
    { auth: 'user', multipart: true, maxBytes: 21_000_000, rateLimit: 'upload' },
  );
  r.get(
    '/account/prescriptions/:id/file',
    async (ctx) => {
      const rx = await getPrescription(ctx.app.db, requireUuid(ctx.params.id));
      if (!rx || rx.user_id !== ctx.user!.id) throw new HttpError(404, 'Prescription not found.');
      const data = await readPrescriptionFile(ctx.app, rx, actor(ctx));
      ctx.send(200, data, rx.mime_type, {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `inline; filename="prescription.${rx.mime_type === 'application/pdf' ? 'pdf' : rx.mime_type === 'image/png' ? 'png' : 'jpg'}"`,
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
    },
    auth,
  );

  // ── Settings ──
  r.get('/account/settings', (ctx) => showSettings(ctx), auth);
  r.post(
    '/account/settings/profile',
    async (ctx) => {
      const v = parseWith(profileSchema, ctx.form);
      if (!v.ok) return showSettings(ctx, { profileErrors: v.errors }, 422);
      await ctx.app.db.query('UPDATE users SET name = $2, phone = $3, marketing_opt_in = $4, updated_at = now() WHERE id = $1', [
        ctx.user!.id,
        v.data.name,
        v.data.phone ?? null,
        v.data.marketing,
      ]);
      ctx.setFlash('success', 'Profile saved.');
      ctx.redirect('/account/settings');
    },
    auth,
  );
  r.post(
    '/account/settings/password',
    async (ctx) => {
      const v = parseWith(changePasswordSchema, ctx.form);
      if (!v.ok) return showSettings(ctx, { passwordErrors: v.errors }, 422);
      try {
        await changePassword(ctx.app.db, ctx.user!.id, v.data.current, v.data.password, ctx.session!.id);
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showSettings(ctx, { passwordErrors: { [e.code === 'current' ? 'current' : 'password']: e.message } }, 422);
      }
      ctx.setFlash('success', 'Password changed. Other devices have been signed out.');
      ctx.redirect('/account/settings');
    },
    { auth: 'user', rateLimit: 'passwordReset' },
  );
  r.post(
    '/account/settings/delete',
    async (ctx) => {
      if (ctx.form.confirmText !== 'DELETE') {
        ctx.setFlash('error', 'Type DELETE in capitals to confirm account deletion.');
        return ctx.redirect('/account/settings');
      }
      if (ctx.user!.role !== 'customer') throw new HttpError(403, 'Staff accounts must be removed by an administrator.');
      const row = await ctx.app.db.one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [ctx.user!.id]);
      if (!row || !(await verifyPassword(ctx.form.deletePassword ?? '', row.password_hash))) {
        ctx.setFlash('error', 'Your password was not correct. Your account has not been deleted.');
        return ctx.redirect('/account/settings');
      }
      await deleteAccount(ctx.app, ctx.user!.id);
      await signOut(ctx);
      ctx.setFlash('success', 'Your account has been deleted.');
      ctx.redirect('/');
    },
    { auth: 'user', rateLimit: 'passwordReset' },
  );
}
