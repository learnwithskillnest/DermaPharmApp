import { z } from 'zod';
import type { App } from '../../app.ts';
import type { Ctx } from '../../http/context.ts';
import { HttpError } from '../../http/errors.ts';
import { can } from '../../auth/permissions.ts';
import { revokeOtherSessions } from '../../auth/session.ts';
import { audit } from '../../services/audit.ts';
import { couponAdminSchema } from '../../services/admin-catalog.ts';
import { expiringBatches, lowStock } from '../../services/inventory.ts';
import { settingsSchema, type Settings } from '../../services/settings.ts';
import { checkbox, emailField, parseWith, type FieldErrors } from '../../validation.ts';
import { rupeesToPaise } from '../../../shared/money.ts';
import {
  AuditPage,
  CouponsPage,
  CustomerPage,
  CustomersPage,
  DashboardPage,
  MessagesPage,
  ReportsPage,
  SettingsAdminPage,
  StaffPage,
  type CouponRow,
} from '../../../ui/admin/misc.tsx';
import type { OrderStatus } from '../../services/orders.ts';
import { actor, requireUuid } from '../helpers.ts';
import { formValues, renderAdmin } from './common.tsx';

/** Orders that count as sales: placed and not cancelled / unpaid. */
const COUNTED = `o.status NOT IN ('pending_payment', 'payment_failed', 'cancelled')`;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function istDay(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function dailyRevenue(ctx: Ctx, from: string, to: string) {
  return ctx.app.db.many<{ day: string; revenue_paise: number; orders: number }>(
    `SELECT d::date::text AS day,
            coalesce(sum(o.total_paise), 0)::int AS revenue_paise,
            count(o.id)::int AS orders
       FROM generate_series($1::date, $2::date, interval '1 day') d
       LEFT JOIN orders o ON (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = d::date AND ${COUNTED}
      GROUP BY d ORDER BY d`,
    [from, to],
  );
}

const staffSchema = z
  .object({
    email: emailField,
    role: z.enum(['customer', 'staff', 'pharmacist', 'admin']),
    pharmacistRegNo: z
      .string()
      .trim()
      .max(40)
      .optional()
      .transform((v) => v || null),
  })
  .refine((v) => v.role !== 'pharmacist' || !!v.pharmacistRegNo, { path: ['pharmacistRegNo'], message: 'Enter the pharmacist registration number.' });

const rupees = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, c) => {
      const p = rupeesToPaise(v || '0');
      if (p === null) {
        c.addIssue({ code: 'custom', message: `Enter ${label} in rupees.` });
        return z.NEVER;
      }
      return p;
    });

const shippingForm = z.object({
  flatFee: rupees('the delivery charge'),
  freeThreshold: rupees('the free delivery threshold'),
  codEnabled: checkbox,
  codFee: rupees('the COD fee'),
  codMax: rupees('the COD maximum'),
  blocked: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[1-9][0-9]{0,5}$/, 'PIN code prefixes are 1–6 digits and cannot start with 0.')).max(500)),
  dispatchTime: z.string().trim().max(80),
  deliveryEstimate: z.string().trim().max(80),
  returnWindow: z.coerce.number().int('Return window must be whole days.').min(0).max(60),
  reservation: z.coerce.number().int().min(5, 'Reservation must be at least 5 minutes.').max(240),
});

const pharmacyForm = z.object({
  otcVisible: checkbox,
  rxListingVisible: checkbox,
  rxOrderingEnabled: checkbox,
  drugLicenceNumbers: z.string().trim().max(300),
  pharmacistName: z.string().trim().max(120),
  pharmacistRegNo: z.string().trim().max(60),
  rxValidityDays: z.coerce.number().int().min(1).max(730),
  rxRetentionDays: z.coerce.number().int().min(30, 'Retention must be at least 30 days.').max(3650),
  grievanceOfficerName: z.string().trim().max(120),
  grievanceOfficerEmail: z.string().trim().email('Enter a valid email.').or(z.literal('')),
  grievanceOfficerPhone: z.string().trim().max(30),
  cin: z.string().trim().max(30),
});

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function adminMiscRoutes(app: App) {
  const r = app.router;

  // ── Overview ──
  r.get(
    '/admin',
    async (ctx) => {
      const db = ctx.app.db;
      const showSales = can(ctx.user!.role, 'dashboard.sales');
      const [today, last30, toShip, daily, low, expiring, rx, rxOrders, returnsOpen, messagesOpen, recent, rxBlockers] = await Promise.all([
        db.one<{ orders: number; revenue: number }>(
          `SELECT count(*)::int AS orders, coalesce(sum(total_paise), 0)::int AS revenue FROM orders o
            WHERE ${COUNTED} AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
          [istDay()],
        ),
        db.one<{ orders: number; revenue: number }>(
          `SELECT count(*)::int AS orders, coalesce(sum(total_paise), 0)::int AS revenue FROM orders o
            WHERE ${COUNTED} AND o.created_at >= now() - interval '30 days'`,
        ),
        db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE status IN ('confirmed', 'processing')`),
        showSales ? dailyRevenue(ctx, istDay(-29), istDay()) : Promise.resolve([]),
        lowStock(db, 20),
        expiringBatches(db, 90),
        db.one<{ n: number }>(`SELECT count(*)::int AS n FROM prescriptions WHERE status = 'pending'`),
        db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE requires_rx_review AND rx_review_status = 'pending' AND status <> 'cancelled'`),
        db.one<{ n: number }>(`SELECT count(*)::int AS n FROM return_requests WHERE status = 'requested'`),
        db.one<{ n: number }>(`SELECT count(*)::int AS n FROM contact_messages WHERE status = 'open'`),
        db.many<{ id: string; number: string; status: OrderStatus; total_paise: number; created_at: Date }>(
          'SELECT id, number, status, total_paise, created_at FROM orders ORDER BY created_at DESC LIMIT 8',
        ),
        ctx.app.settings.rxOrderingBlockers(),
      ]);
      const l30 = last30 ?? { orders: 0, revenue: 0 };
      await renderAdmin(
        ctx,
        'Overview',
        <DashboardPage
          showSales={showSales}
          today={today ?? { orders: 0, revenue: 0 }}
          last30={{ ...l30, aov: l30.orders ? Math.round(l30.revenue / l30.orders) : 0 }}
          toShip={toShip?.n ?? 0}
          daily={daily}
          lowStock={low}
          expiring={expiring}
          rxPending={rx?.n ?? 0}
          rxOrdersPending={rxOrders?.n ?? 0}
          returnsOpen={returnsOpen?.n ?? 0}
          messagesOpen={messagesOpen?.n ?? 0}
          recent={showSales ? recent : []}
          rxBlockers={rxBlockers}
          sandbox={ctx.app.payments.isSandbox}
        />,
      );
    },
    { perm: 'admin.access' },
  );

  // ── Reports ──
  const period = (ctx: Ctx) => {
    let from = ctx.query.get('from') ?? '';
    let to = ctx.query.get('to') ?? '';
    if (!ISO_DAY.test(from)) from = istDay(-29);
    if (!ISO_DAY.test(to)) to = istDay();
    if (from > to) [from, to] = [to, from];
    // Cap at ~2 years so generate_series stays small.
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span > 731) from = new Date(Date.parse(to) - 731 * 86_400_000).toISOString().slice(0, 10);
    return { from, to };
  };
  const inPeriod = `(o.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`;

  r.get(
    '/admin/reports',
    async (ctx) => {
      const { from, to } = period(ctx);
      const db = ctx.app.db;
      const [totals, refunds, daily, byStatus, topProducts, byCategory] = await Promise.all([
        db.one<{ orders: number; revenue: number; discount: number; tax: number; shipping: number }>(
          `SELECT count(*)::int AS orders, coalesce(sum(total_paise), 0)::int AS revenue, coalesce(sum(discount_paise), 0)::int AS discount,
                  coalesce(sum(tax_paise), 0)::int AS tax, coalesce(sum(shipping_paise), 0)::int AS shipping
             FROM orders o WHERE ${COUNTED} AND ${inPeriod}`,
          [from, to],
        ),
        db.one<{ refunds: number }>(
          `SELECT coalesce(sum(refund_paise), 0)::int AS refunds FROM return_requests
            WHERE status = 'refunded' AND (updated_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`,
          [from, to],
        ),
        dailyRevenue(ctx, from, to),
        db.many<{ status: OrderStatus; n: number; total: number }>(
          `SELECT o.status, count(*)::int AS n, coalesce(sum(total_paise), 0)::int AS total FROM orders o WHERE ${inPeriod} GROUP BY o.status ORDER BY n DESC`,
          [from, to],
        ),
        db.many<{ product_name: string; qty: number; revenue: number }>(
          `SELECT i.product_name, sum(i.quantity)::int AS qty, sum(i.line_total_paise - i.line_discount_paise)::int AS revenue
             FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE ${COUNTED} AND ${inPeriod} GROUP BY i.product_name ORDER BY revenue DESC LIMIT 10`,
          [from, to],
        ),
        db.many<{ category: string; qty: number; revenue: number }>(
          `SELECT coalesce(c.name, 'Removed products') AS category, sum(i.quantity)::int AS qty, sum(i.line_total_paise - i.line_discount_paise)::int AS revenue
             FROM order_items i JOIN orders o ON o.id = i.order_id
             LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
            WHERE ${COUNTED} AND ${inPeriod} GROUP BY 1 ORDER BY revenue DESC`,
          [from, to],
        ),
      ]);
      await renderAdmin(
        ctx,
        'Sales reports',
        <ReportsPage
          from={from}
          to={to}
          totals={{ ...(totals ?? { orders: 0, revenue: 0, discount: 0, tax: 0, shipping: 0 }), refunds: refunds?.refunds ?? 0 }}
          daily={daily}
          byStatus={byStatus}
          topProducts={topProducts}
          byCategory={byCategory}
        />,
      );
    },
    { perm: 'reports.view' },
  );

  r.get(
    '/admin/reports/export.csv',
    async (ctx) => {
      const { from, to } = period(ctx);
      const rows = await ctx.app.db.many<Record<string, unknown>>(
        `SELECT o.number, o.created_at, o.status, o.payment_method, o.payment_status, o.subtotal_paise, o.discount_paise,
                o.shipping_paise, o.cod_fee_paise, o.tax_paise, o.total_paise, o.coupon_code,
                o.shipping_address->>'state' AS ship_state, o.shipping_address->>'pincode' AS ship_pincode
           FROM orders o WHERE ${inPeriod} ORDER BY o.created_at`,
        [from, to],
      );
      // Data minimisation: no customer names, emails, phones or street addresses in the export.
      const cols = [
        'number',
        'created_at',
        'status',
        'payment_method',
        'payment_status',
        'subtotal_paise',
        'discount_paise',
        'shipping_paise',
        'cod_fee_paise',
        'tax_paise',
        'total_paise',
        'coupon_code',
        'ship_state',
        'ship_pincode',
      ];
      const csv = [cols.join(','), ...rows.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join('\r\n');
      await audit(ctx.app.db, actor(ctx), 'report.exported', 'orders', null, { from, to, rows: rows.length });
      ctx.text(csv, 200, 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="glowderma-orders-${from}-to-${to}.csv"`,
        'Cache-Control': 'private, no-store',
      });
    },
    { perm: 'reports.view' },
  );

  // ── Customers ──
  r.get(
    '/admin/customers',
    async (ctx) => {
      const q = (ctx.query.get('q') ?? '')
        .trim()
        .slice(0, 80)
        .replace(/[%_\\]/g, '');
      const rows = await ctx.app.db.many<{
        id: string;
        name: string;
        email: string;
        phone: string | null;
        created_at: Date;
        orders: number;
        spent: number;
        deleted_at: Date | null;
        disabled_at: Date | null;
      }>(
        `SELECT u.id, u.name, u.email, u.phone, u.created_at, u.deleted_at, u.disabled_at,
                count(o.id)::int AS orders, coalesce(sum(o.total_paise) FILTER (WHERE ${COUNTED}), 0)::int AS spent
           FROM users u LEFT JOIN orders o ON o.user_id = u.id
          WHERE u.role = 'customer' AND ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
          GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`,
        [q],
      );
      await renderAdmin(ctx, 'Customers', <CustomersPage rows={rows} q={q} />);
    },
    { perm: 'customers.view' },
  );

  r.get(
    '/admin/customers/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const db = ctx.app.db;
      const c = await db.one<{
        id: string;
        name: string;
        email: string;
        phone: string | null;
        created_at: Date;
        marketing_opt_in: boolean;
        disabled_at: Date | null;
        deleted_at: Date | null;
      }>(`SELECT id, name, email, phone, created_at, marketing_opt_in, disabled_at, deleted_at FROM users WHERE id = $1 AND role = 'customer'`, [id]);
      if (!c) throw new HttpError(404, 'Customer not found.');
      const [addresses, orders] = await Promise.all([
        db.many<{ id: string; full_name: string; city: string; state: string; pincode: string; phone: string }>(
          'SELECT id, full_name, city, state, pincode, phone FROM addresses WHERE user_id = $1 ORDER BY created_at',
          [id],
        ),
        db.many<{ id: string; number: string; status: OrderStatus; total_paise: number; created_at: Date }>(
          'SELECT id, number, status, total_paise, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
          [id],
        ),
      ]);
      await audit(db, actor(ctx), 'customer.viewed', 'user', id);
      await renderAdmin(ctx, c.name, <CustomerPage c={c} addresses={addresses} orders={orders} />);
    },
    { perm: 'customers.view' },
  );

  r.post(
    '/admin/customers/:id/toggle',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const row = await ctx.app.db.tx(async (t) => {
        const u = await t.one<{ disabled_at: Date | null }>(
          `UPDATE users SET disabled_at = CASE WHEN disabled_at IS NULL THEN now() ELSE NULL END, updated_at = now()
            WHERE id = $1 AND role = 'customer' AND deleted_at IS NULL RETURNING disabled_at`,
          [id],
        );
        if (!u) throw new HttpError(404, 'Customer not found.');
        if (u.disabled_at) await revokeOtherSessions(t, id);
        await audit(t, actor(ctx), u.disabled_at ? 'customer.disabled' : 'customer.enabled', 'user', id);
        return u;
      });
      ctx.setFlash('success', row.disabled_at ? 'Account disabled and signed out everywhere.' : 'Account re-enabled.');
      ctx.redirect(`/admin/customers/${id}`);
    },
    { perm: 'customers.view', rateLimit: 'adminWrite' },
  );

  // ── Coupons ──
  const showCoupons = async (ctx: Ctx, errors?: FieldErrors, values?: Record<string, string>, status = 200) => {
    const rows = await ctx.app.db.many<CouponRow>('SELECT * FROM coupons ORDER BY created_at DESC');
    await renderAdmin(ctx, 'Coupons', <CouponsPage rows={rows} errors={errors} values={values} />, status);
  };
  r.get('/admin/coupons', (ctx) => showCoupons(ctx), { perm: 'coupons.manage' });
  r.post(
    '/admin/coupons',
    async (ctx) => {
      const v = parseWith(couponAdminSchema, ctx.form);
      if (!v.ok) return showCoupons(ctx, v.errors, formValues(ctx.form), 422);
      const c = v.data;
      const exists = await ctx.app.db.one('SELECT 1 FROM coupons WHERE upper(code) = $1', [c.code]);
      if (exists) return showCoupons(ctx, { code: 'That code already exists.' }, formValues(ctx.form), 422);
      const row = await ctx.app.db.tx(async (t) => {
        const ins = await t.one<{ id: string }>(
          `INSERT INTO coupons (code, description, kind, value, min_subtotal_paise, max_discount_paise, starts_at, ends_at, usage_limit, per_user_limit, exclude_pharmacy)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [c.code, c.description, c.kind, c.value, c.minSubtotalPaise, c.maxDiscountPaise, c.startsAt, c.endsAt, c.usageLimit, c.perUserLimit, c.excludePharmacy],
        );
        await audit(t, actor(ctx), 'coupon.created', 'coupon', ins!.id, { code: c.code, kind: c.kind, value: c.value });
        return ins!;
      });
      ctx.setFlash('success', `Coupon ${c.code} created.`);
      ctx.redirect(`/admin/coupons#${row.id}`);
    },
    { perm: 'coupons.manage', rateLimit: 'adminWrite' },
  );
  r.post(
    '/admin/coupons/:id/toggle',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const row = await ctx.app.db.one<{ code: string; is_active: boolean }>('UPDATE coupons SET is_active = NOT is_active WHERE id = $1 RETURNING code, is_active', [id]);
      if (!row) throw new HttpError(404, 'Coupon not found.');
      await audit(ctx.app.db, actor(ctx), row.is_active ? 'coupon.activated' : 'coupon.deactivated', 'coupon', id, { code: row.code });
      ctx.setFlash('success', `${row.code} ${row.is_active ? 'activated' : 'deactivated'}.`);
      ctx.redirect('/admin/coupons');
    },
    { perm: 'coupons.manage', rateLimit: 'adminWrite' },
  );

  // ── Messages ──
  r.get(
    '/admin/messages',
    async (ctx) => {
      const rows = await ctx.app.db.many<{
        id: string;
        name: string;
        email: string;
        topic: string;
        order_number: string | null;
        message: string;
        status: string;
        created_at: Date;
      }>(`SELECT id, name, email, topic, order_number, message, status, created_at FROM contact_messages ORDER BY (status = 'open') DESC, created_at DESC LIMIT 100`);
      await renderAdmin(ctx, 'Customer messages', <MessagesPage rows={rows} />);
    },
    { perm: 'messages.view' },
  );
  r.post(
    '/admin/messages/:id/close',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      await ctx.app.db.query(`UPDATE contact_messages SET status = 'closed' WHERE id = $1`, [id]);
      ctx.setFlash('success', 'Message marked resolved.');
      ctx.redirect('/admin/messages');
    },
    { perm: 'messages.view', rateLimit: 'adminWrite' },
  );

  // ── Staff accounts ──
  const showStaff = async (ctx: Ctx, errors?: FieldErrors, values?: Record<string, string>, status = 200) => {
    const rows = await ctx.app.db.many<{ id: string; name: string; email: string; role: string; disabled_at: Date | null; pharmacist_reg_no: string | null }>(
      `SELECT id, name, email, role, disabled_at, pharmacist_reg_no FROM users WHERE role <> 'customer' AND deleted_at IS NULL ORDER BY role, name`,
    );
    await renderAdmin(ctx, 'Staff accounts', <StaffPage rows={rows} errors={errors} values={values} />, status);
  };
  r.get('/admin/users', (ctx) => showStaff(ctx), { perm: 'users.manage' });
  r.post(
    '/admin/users',
    async (ctx) => {
      const v = parseWith(staffSchema, ctx.form);
      if (!v.ok) return showStaff(ctx, v.errors, formValues(ctx.form), 422);
      const target = await ctx.app.db.one<{ id: string; role: string }>('SELECT id, role FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [v.data.email]);
      if (!target) return showStaff(ctx, { email: 'No account uses that email. Ask the person to register first.' }, formValues(ctx.form), 422);
      if (target.id === ctx.user!.id && v.data.role !== 'admin') return showStaff(ctx, { role: 'You cannot remove your own admin role.' }, formValues(ctx.form), 422);
      if (target.role === 'admin' && v.data.role !== 'admin') {
        const admins = await ctx.app.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND deleted_at IS NULL`);
        if ((admins?.n ?? 0) <= 1) return showStaff(ctx, { role: 'At least one admin must remain.' }, formValues(ctx.form), 422);
      }
      await ctx.app.db.tx(async (t) => {
        await t.query(`UPDATE users SET role = $2, pharmacist_reg_no = $3, updated_at = now() WHERE id = $1`, [
          target.id,
          v.data.role,
          v.data.role === 'pharmacist' ? v.data.pharmacistRegNo : null,
        ]);
        // Role changes take effect on the next request; force re-login for safety.
        await revokeOtherSessions(t, target.id, target.id === ctx.user!.id ? ctx.session!.id : undefined);
        await audit(t, actor(ctx), 'user.role_changed', 'user', target.id, { from: target.role, to: v.data.role });
      });
      ctx.setFlash('success', `Role set to ${v.data.role}.`);
      ctx.redirect('/admin/users');
    },
    { perm: 'users.manage', rateLimit: 'adminWrite' },
  );

  // ── Audit log ──
  r.get(
    '/admin/audit',
    async (ctx) => {
      const filter = (ctx.query.get('action') ?? '')
        .trim()
        .slice(0, 60)
        .replace(/[%_\\]/g, '');
      const rows = await ctx.app.db.many<{
        id: number;
        actor: string | null;
        actor_role: string | null;
        action: string;
        entity: string;
        entity_id: string | null;
        details: unknown;
        ip: string | null;
        created_at: Date;
      }>(
        `SELECT a.id, u.name AS actor, a.actor_role, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
          WHERE $1 = '' OR a.action ILIKE '%' || $1 || '%' OR a.entity ILIKE '%' || $1 || '%'
          ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
        [filter],
      );
      await renderAdmin(ctx, 'Audit log', <AuditPage rows={rows} filter={filter} />);
    },
    { perm: 'audit.view' },
  );

  // ── Settings ──
  const showSettings = async (ctx: Ctx, errors?: FieldErrors, status = 200) => {
    const [s, rxBlockers] = await Promise.all([ctx.app.settings.all(), ctx.app.settings.rxOrderingBlockers()]);
    await renderAdmin(ctx, 'Store settings', <SettingsAdminPage s={s} errors={errors} rxBlockers={rxBlockers} envFlag={ctx.app.config.ENABLE_PRESCRIPTION_ORDERING} />, status);
  };
  const saveGroup = async <K extends keyof Settings>(ctx: Ctx, group: K, value: Settings[K]) => {
    const parsed = settingsSchema[group].safeParse(value);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const i of parsed.error.issues) errs[String(i.path[0] ?? '_form')] ??= i.message;
      return showSettings(
        ctx,
        {
          _form: `Could not save: ${Object.entries(errs)
            .map(([k, m]) => `${k} — ${m}`)
            .join('; ')}`,
        },
        422,
      );
    }
    const before = (await ctx.app.settings.all())[group];
    await ctx.app.settings.update(group, parsed.data as Settings[K], ctx.user!.id);
    await audit(ctx.app.db, actor(ctx), 'settings.updated', 'settings', group, { before, after: parsed.data });
    return true;
  };

  r.get('/admin/settings', (ctx) => showSettings(ctx), { perm: 'settings.manage' });
  r.post(
    '/admin/settings/store',
    async (ctx) => {
      const f = ctx.form;
      const ok = await saveGroup(ctx, 'store', {
        name: (f.name ?? '').trim(),
        legalName: (f.legalName ?? '').trim(),
        address: (f.address ?? '').trim(),
        gstin: (f.gstin ?? '').trim().toUpperCase(),
        email: (f.email ?? '').trim(),
        phone: (f.phone ?? '').trim(),
        supportHours: (f.supportHours ?? '').trim(),
      });
      if (ok !== true) return;
      ctx.setFlash('success', 'Store details saved.');
      ctx.redirect('/admin/settings');
    },
    { perm: 'settings.manage', rateLimit: 'adminWrite' },
  );
  r.post(
    '/admin/settings/shipping',
    async (ctx) => {
      const v = parseWith(shippingForm, ctx.form);
      if (!v.ok) return showSettings(ctx, { _form: Object.values(v.errors)[0] ?? 'Check the shipping settings.' }, 422);
      const d = v.data;
      const ok1 = await saveGroup(ctx, 'shipping', {
        flatFeePaise: d.flatFee,
        freeThresholdPaise: d.freeThreshold,
        codEnabled: d.codEnabled,
        codFeePaise: d.codFee,
        codMaxOrderPaise: d.codMax,
        blockedPincodePrefixes: d.blocked,
        dispatchTime: d.dispatchTime,
        deliveryEstimate: d.deliveryEstimate,
      });
      if (ok1 !== true) return;
      const ok2 = await saveGroup(ctx, 'orders', { returnWindowDays: d.returnWindow, reservationMinutes: d.reservation });
      if (ok2 !== true) return;
      ctx.setFlash('success', 'Shipping settings saved.');
      ctx.redirect('/admin/settings');
    },
    { perm: 'settings.manage', rateLimit: 'adminWrite' },
  );
  r.post(
    '/admin/settings/pharmacy',
    async (ctx) => {
      const v = parseWith(pharmacyForm, ctx.form);
      if (!v.ok) return showSettings(ctx, { _form: Object.values(v.errors)[0] ?? 'Check the pharmacy settings.' }, 422);
      const d = v.data;
      const ok1 = await saveGroup(ctx, 'pharmacy', {
        otcVisible: d.otcVisible,
        rxListingVisible: d.rxListingVisible,
        rxOrderingEnabled: d.rxOrderingEnabled,
        drugLicenceNumbers: d.drugLicenceNumbers,
        pharmacistName: d.pharmacistName,
        pharmacistRegNo: d.pharmacistRegNo,
        rxValidityDays: d.rxValidityDays,
        rxRetentionDays: d.rxRetentionDays,
      });
      if (ok1 !== true) return;
      const ok2 = await saveGroup(ctx, 'compliance', {
        grievanceOfficerName: d.grievanceOfficerName,
        grievanceOfficerEmail: d.grievanceOfficerEmail,
        grievanceOfficerPhone: d.grievanceOfficerPhone,
        cin: d.cin,
      });
      if (ok2 !== true) return;
      const blockers = await ctx.app.settings.rxOrderingBlockers();
      ctx.setFlash(
        blockers.length && d.rxOrderingEnabled ? 'info' : 'success',
        blockers.length && d.rxOrderingEnabled ? 'Saved. Prescription ordering stays off until every listed condition is met.' : 'Pharmacy and compliance settings saved.',
      );
      ctx.redirect('/admin/settings');
    },
    { perm: 'settings.manage', rateLimit: 'adminWrite' },
  );
}
