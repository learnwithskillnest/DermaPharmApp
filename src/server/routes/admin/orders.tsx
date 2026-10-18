import { z } from 'zod';
import type { App } from '../../app.ts';
import type { Ctx } from '../../http/context.ts';
import { HttpError, UserFacingError } from '../../http/errors.ts';
import { can } from '../../auth/permissions.ts';
import { addShipment, adminSetStatus, orderItems, orderShipments, STATUS_LABEL, type OrderRow, type OrderStatus } from '../../services/orders.ts';
import { getPrescription, readPrescriptionFile, reviewPrescription, reviewRxOrder, rxQueue } from '../../services/prescriptions.ts';
import { listReturns, returnsForOrder, updateReturn } from '../../services/returns.ts';
import { sendSafely } from '../../services/mail.ts';
import { checkbox, parseWith } from '../../validation.ts';
import { rupeesToPaise } from '../../../shared/money.ts';
import { OrderAdminPage, OrdersList, ReturnsAdminPage, RxQueuePage, RxReviewPage } from '../../../ui/admin/orders.tsx';
import { actor, requireUuid } from '../helpers.ts';
import { renderAdmin } from './common.tsx';
import type { FieldErrors } from '../../validation.ts';

const shipmentSchema = z.object({
  carrier: z.string().trim().min(2, 'Enter the carrier name.').max(60),
  trackingNumber: z.string().trim().min(4, 'Enter the tracking number.').max(60),
  trackingUrl: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null)
    .pipe(z.string().url('Enter a full https:// link.').startsWith('https://', 'Tracking links must use https.').nullable()),
});

const rxDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected'], { errorMap: () => ({ message: 'Choose a decision.' }) }),
  doctorRegNo: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => v || null),
  validUntil: z
    .string()
    .optional()
    .transform((v) => v || null),
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
});

const returnUpdateSchema = z.object({
  status: z.enum(['approved', 'rejected', 'received', 'refunded']),
  refund: z.string().optional(),
  reference: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || null),
  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => v || null),
  viaGateway: checkbox,
  restock: checkbox,
});

async function showOrder(ctx: Ctx, id: string, errors?: FieldErrors, status = 200) {
  const db = ctx.app.db;
  const order = await db.one<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
  if (!order) throw new HttpError(404, 'Order not found.');
  const [items, events, attempts, shipments, returns, customer, prescription] = await Promise.all([
    orderItems(db, id),
    db.many<{ status: string; note: string | null; created_at: Date; actor: string | null; visible_to_customer: boolean }>(
      'SELECT e.status, e.note, e.created_at, u.name AS actor, e.visible_to_customer FROM order_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.order_id = $1 ORDER BY e.created_at, e.id',
      [id],
    ),
    db.many<{
      provider: string;
      provider_order_id: string;
      provider_payment_id: string | null;
      amount_paise: number;
      status: string;
      signature_verified: boolean;
      failure_reason: string | null;
      created_at: Date;
    }>(
      'SELECT provider, provider_order_id, provider_payment_id, amount_paise, status, signature_verified, failure_reason, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at',
      [id],
    ),
    orderShipments(db, id),
    returnsForOrder(db, id),
    order.user_id ? db.one<{ id: string; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = $1', [order.user_id]) : Promise.resolve(null),
    order.prescription_id
      ? db.one<{ id: string; status: string; patient_name: string }>('SELECT id, status, patient_name FROM prescriptions WHERE id = $1', [order.prescription_id])
      : Promise.resolve(null),
  ]);
  await renderAdmin(
    ctx,
    `Order ${order.number}`,
    <OrderAdminPage
      order={order}
      items={items}
      events={events}
      attempts={attempts}
      shipments={shipments}
      returns={returns}
      customer={customer}
      errors={errors}
      prescription={prescription}
    />,
    status,
  );
}

export function adminOrderRoutes(app: App) {
  const r = app.router;
  // Pharmacists may open an order to review its prescription; status changes need orders.manage.
  const VIEW = { perm: 'admin.access' as const };
  const O = { perm: 'orders.manage' as const };

  r.get(
    '/admin/orders',
    async (ctx) => {
      if (!can(ctx.user!.role, 'orders.manage') && !can(ctx.user!.role, 'rx.queue')) throw new HttpError(403, 'You do not have access to this page.');
      const f = {
        q: (ctx.query.get('q') ?? '').trim().slice(0, 80),
        status: ctx.query.get('status') ?? '',
        from: /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('from') ?? '') ? ctx.query.get('from')! : '',
        to: /^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('to') ?? '') ? ctx.query.get('to')! : '',
      };
      if (f.status && f.status !== 'rx_pending' && !(f.status in STATUS_LABEL)) f.status = '';
      if (!can(ctx.user!.role, 'orders.manage')) f.status = 'rx_pending'; // pharmacists only see orders needing review
      const page = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
      const where = `($1 = '' OR o.number ILIKE '%' || $1 || '%' OR o.email ILIKE '%' || $1 || '%')
        AND ($2 = '' OR ($2 = 'rx_pending' AND o.requires_rx_review AND o.rx_review_status = 'pending') OR o.status::text = $2)
        AND ($3 = '' OR o.created_at >= ($3 || ' 00:00:00+05:30')::timestamptz)
        AND ($4 = '' OR o.created_at <= ($4 || ' 23:59:59+05:30')::timestamptz)`;
      const params = [f.q.replace(/[%_\\]/g, ''), f.status, f.from, f.to];
      const total = (await ctx.app.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders o WHERE ${where}`, params))?.n ?? 0;
      const rows = await ctx.app.db.many<OrderRow & { customer_name: string | null; item_count: number }>(
        `SELECT o.*, u.name AS customer_name, (SELECT coalesce(sum(quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
           FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE ${where} ORDER BY o.created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
        params,
      );
      await renderAdmin(ctx, 'Orders', <OrdersList rows={rows} filters={f} page={page} pages={Math.max(1, Math.ceil(total / 50))} />);
    },
    VIEW,
  );

  r.get(
    '/admin/orders/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      if (!can(ctx.user!.role, 'orders.manage')) {
        const o = await ctx.app.db.one('SELECT 1 FROM orders WHERE id = $1 AND requires_rx_review', [id]);
        if (!o || !can(ctx.user!.role, 'rx.queue')) throw new HttpError(403, 'You do not have access to this page.');
      }
      await showOrder(ctx, id);
    },
    VIEW,
  );

  r.post(
    '/admin/orders/:id/status',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const to = ctx.form.status as OrderStatus;
      if (!(to in STATUS_LABEL)) throw new HttpError(400, 'Invalid status.');
      const note = (ctx.form.note ?? '').trim().slice(0, 300) || null;
      try {
        const res = await adminSetStatus(ctx.app, id, to, actor(ctx), note);
        await sendSafely(
          ctx.app.mailer,
          res.email,
          `Order ${res.number}: ${STATUS_LABEL[to]}`,
          `Your order ${res.number} is now: ${STATUS_LABEL[to]}.${note ? `\n\n${note}` : ''}`,
        );
        ctx.setFlash('success', `Order moved to ${STATUS_LABEL[to]}.`);
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showOrder(ctx, id, { _form: e.message }, 422);
      }
      ctx.redirect(`/admin/orders/${id}`);
    },
    { ...O, rateLimit: 'adminWrite' },
  );

  r.post(
    '/admin/orders/:id/shipment',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const v = parseWith(shipmentSchema, ctx.form);
      if (!v.ok) return showOrder(ctx, id, v.errors, 422);
      try {
        const o = await addShipment(ctx.app, id, v.data, actor(ctx));
        await sendSafely(
          ctx.app.mailer,
          o.email,
          `Order ${o.number} has shipped`,
          `Your order ${o.number} shipped with ${v.data.carrier}. Tracking number: ${v.data.trackingNumber}.`,
        );
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showOrder(ctx, id, { _form: e.message }, 422);
      }
      ctx.setFlash('success', 'Shipment added and order marked shipped.');
      ctx.redirect(`/admin/orders/${id}`);
    },
    { ...O, rateLimit: 'adminWrite' },
  );

  r.post(
    '/admin/orders/:id/rx',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const decision = ctx.form.decision;
      if (decision !== 'approved' && decision !== 'rejected') throw new HttpError(400, 'Invalid decision.');
      try {
        await reviewRxOrder(ctx.app, id, decision, (ctx.form.note ?? '').slice(0, 300) || null, actor(ctx));
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showOrder(ctx, id, { _form: e.message }, 422);
      }
      ctx.setFlash('success', decision === 'approved' ? 'Prescription verified for this order.' : 'Order prescription rejected.');
      ctx.redirect(`/admin/orders/${id}`);
    },
    { perm: 'rx.review' },
  );

  // ── Returns ──
  r.get(
    '/admin/returns',
    async (ctx) => {
      const status = ['requested', 'approved', 'received', 'refunded', 'rejected'].includes(ctx.query.get('status') ?? '') ? ctx.query.get('status')! : '';
      await renderAdmin(ctx, 'Returns & refunds', <ReturnsAdminPage rows={await listReturns(ctx.app.db, status || undefined)} status={status} />);
    },
    { perm: 'returns.manage' },
  );
  r.post(
    '/admin/returns/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const v = parseWith(returnUpdateSchema, ctx.form);
      if (!v.ok) {
        ctx.setFlash('error', Object.values(v.errors)[0] ?? 'Check the form.');
        return ctx.redirect('/admin/returns');
      }
      const refund = v.data.refund ? rupeesToPaise(v.data.refund) : null;
      if (v.data.refund && refund === null) {
        ctx.setFlash('error', 'Enter the refund amount in rupees.');
        return ctx.redirect('/admin/returns');
      }
      try {
        await updateReturn(
          ctx.app,
          id,
          { status: v.data.status, refundPaise: refund, reference: v.data.reference, note: v.data.note, restock: v.data.restock, viaGateway: v.data.viaGateway },
          actor(ctx),
        );
        ctx.setFlash('success', `Return marked ${v.data.status}.`);
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect('/admin/returns');
    },
    { perm: 'returns.manage', rateLimit: 'adminWrite' },
  );

  // ── Prescriptions ──
  r.get(
    '/admin/prescriptions',
    async (ctx) => {
      const status = ['pending', 'approved', 'rejected', 'expired'].includes(ctx.query.get('status') ?? '') ? ctx.query.get('status')! : 'pending';
      const [rows, orders] = await Promise.all([
        rxQueue(ctx.app.db, status),
        ctx.app.db.many<{ id: string; number: string; created_at: Date; total_paise: number }>(
          `SELECT id, number, created_at, total_paise FROM orders WHERE requires_rx_review AND rx_review_status = 'pending' AND status NOT IN ('cancelled') ORDER BY created_at LIMIT 50`,
        ),
      ]);
      await renderAdmin(ctx, 'Prescription review', <RxQueuePage rows={rows} status={status} orders={orders} />);
    },
    { perm: 'rx.queue' },
  );
  const showRx = async (ctx: Ctx, errors?: FieldErrors, status = 200) => {
    const rx = await getPrescription(ctx.app.db, requireUuid(ctx.params.id));
    if (!rx) throw new HttpError(404, 'Prescription not found.');
    await renderAdmin(
      ctx,
      'Review prescription',
      <RxReviewPage rx={rx} canReview={can(ctx.user!.role, 'rx.review')} canView={can(ctx.user!.role, 'rx.documents')} errors={errors} />,
      status,
    );
  };
  r.get('/admin/prescriptions/:id', (ctx) => showRx(ctx), { perm: 'rx.queue' });
  r.post(
    '/admin/prescriptions/:id',
    async (ctx) => {
      const v = parseWith(rxDecisionSchema, ctx.form);
      if (!v.ok) return showRx(ctx, v.errors, 422);
      try {
        await reviewPrescription(
          ctx.app,
          requireUuid(ctx.params.id),
          { status: v.data.decision, notes: v.data.notes, doctorRegNo: v.data.doctorRegNo, validUntil: v.data.validUntil },
          actor(ctx),
        );
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        return showRx(ctx, { _form: e.message }, 422);
      }
      ctx.setFlash('success', 'Decision recorded.');
      ctx.redirect('/admin/prescriptions');
    },
    { perm: 'rx.review' },
  );
  r.get(
    '/admin/prescriptions/:id/file',
    async (ctx) => {
      const rx = await getPrescription(ctx.app.db, requireUuid(ctx.params.id));
      if (!rx) throw new HttpError(404, 'Prescription not found.');
      const data = await readPrescriptionFile(ctx.app, rx, actor(ctx));
      ctx.send(200, data, rx.mime_type, {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      });
    },
    { perm: 'rx.documents' },
  );
}
