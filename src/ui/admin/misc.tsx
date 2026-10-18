import { AdminShell, Kpis, Panel, RevenueBars, fmtDate, fmtDay } from './layout.tsx';
import { ActionButton, Checkbox, Form, FormErrors, SelectField, TextArea, TextField, type Errors, type Values } from '../forms.tsx';
import { formatINR, paiseToRupeesInput } from '../../shared/money.ts';
import { STATUS_LABEL, type OrderStatus } from '../../server/services/orders.ts';
import type { Settings } from '../../server/services/settings.ts';
import { useUi } from '../context.tsx';
import { can } from '../../server/auth/permissions.ts';

export interface DashboardData {
  showSales: boolean;
  today: { orders: number; revenue: number };
  last30: { orders: number; revenue: number; aov: number };
  toShip: number;
  daily: Array<{ day: string; revenue_paise: number; orders: number }>;
  lowStock: Array<{ sku: string; product_name: string; variant_name: string; stock: number; product_id: string }>;
  expiring: Array<{ batch_no: string; product_name: string; expiry_date: string; days_left: number; quantity: number }>;
  rxPending: number;
  rxOrdersPending: number;
  returnsOpen: number;
  messagesOpen: number;
  recent: Array<{ id: string; number: string; status: OrderStatus; total_paise: number; created_at: Date }>;
  rxBlockers: string[];
  sandbox: boolean;
}

export function DashboardPage(d: DashboardData) {
  const { user } = useUi();
  return (
    <AdminShell title="Overview" current="/admin">
      {d.sandbox ? (
        <p className="notice notice-warning mb-4 text-sm">Sandbox payments are active. No real money is collected. Configure Razorpay before launch (see DEPLOYMENT.md).</p>
      ) : null}
      {d.showSales ? (
        <Kpis
          items={[
            { label: 'Orders today', value: String(d.today.orders), note: formatINR(d.today.revenue) },
            { label: 'Revenue, last 30 days', value: formatINR(d.last30.revenue), note: `${d.last30.orders} paid or COD orders` },
            { label: 'Average order value', value: formatINR(d.last30.aov), note: 'Last 30 days' },
            { label: 'Waiting to ship', value: String(d.toShip), note: 'Confirmed or packing', href: '/admin/orders?status=confirmed' },
          ]}
        />
      ) : null}
      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-6">
          {d.showSales ? (
            <Panel
              title="Revenue per day, last 30 days"
              actions={
                can(user?.role, 'reports.view') ? (
                  <a href="/admin/reports" className="link text-sm">
                    Full report
                  </a>
                ) : undefined
              }
            >
              <RevenueBars data={d.daily} />
            </Panel>
          ) : null}
          {d.showSales ? (
            <Panel
              title="Latest orders"
              actions={
                <a href="/admin/orders" className="link text-sm">
                  All orders
                </a>
              }
            >
              {!d.recent.length ? <p className="text-sm text-[var(--color-muted)]">No orders yet.</p> : null}
              <table className="table">
                <tbody>
                  {d.recent.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <a className="link tabular" href={`/admin/orders/${o.id}`}>
                          {o.number}
                        </a>
                      </td>
                      <td className="text-xs">{fmtDate(o.created_at)}</td>
                      <td className="text-sm">{STATUS_LABEL[o.status]}</td>
                      <td className="tabular text-right">{formatINR(o.total_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}
        </div>
        <div className="grid content-start gap-6">
          <Panel title="Needs attention">
            <ul className="grid gap-2 text-sm">
              {can(user?.role, 'rx.queue') ? (
                <li>
                  <a className="link" href="/admin/prescriptions">
                    {d.rxPending} prescriptions and {d.rxOrdersPending} orders awaiting pharmacist review
                  </a>
                </li>
              ) : null}
              {can(user?.role, 'returns.manage') ? (
                <li>
                  <a className="link" href="/admin/returns?status=requested">
                    {d.returnsOpen} return requests to review
                  </a>
                </li>
              ) : null}
              {can(user?.role, 'messages.view') ? (
                <li>
                  <a className="link" href="/admin/messages">
                    {d.messagesOpen} open customer messages
                  </a>
                </li>
              ) : null}
            </ul>
          </Panel>
          {can(user?.role, 'inventory.manage') ? (
            <Panel
              title="Low stock"
              actions={
                <a href="/admin/inventory?filter=low" className="link text-sm">
                  Restock
                </a>
              }
            >
              {d.lowStock.length ? (
                <ul className="grid gap-1.5 text-sm">
                  {d.lowStock.slice(0, 8).map((s) => (
                    <li key={s.sku} className="flex justify-between gap-2">
                      <a className="link truncate" href={`/admin/products/${s.product_id}`}>
                        {s.product_name} <span className="text-[var(--color-muted)]">{s.variant_name}</span>
                      </a>
                      <span className={`tabular font-semibold ${s.stock === 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}`}>{s.stock}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--color-muted)]">All stock is above alert levels.</p>
              )}
            </Panel>
          ) : null}
          {can(user?.role, 'inventory.manage') ? (
            <Panel
              title="Expiring within 90 days"
              actions={
                <a href="/admin/inventory/batches" className="link text-sm">
                  Batches
                </a>
              }
            >
              {d.expiring.length ? (
                <ul className="grid gap-1.5 text-sm">
                  {d.expiring.slice(0, 8).map((b) => (
                    <li key={b.batch_no + b.product_name}>
                      {b.product_name}, batch {b.batch_no}:{' '}
                      <span className={b.days_left < 0 ? 'font-semibold text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}>
                        {b.days_left < 0 ? 'expired' : `${b.days_left} days`}
                      </span>{' '}
                      ({b.quantity} units)
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--color-muted)]">No batches expire in the next 90 days.</p>
              )}
            </Panel>
          ) : null}
          <Panel title="Prescription ordering">
            {d.rxBlockers.length ? (
              <>
                <p className="text-sm font-semibold">Disabled. Before enabling:</p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {d.rxBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm">Enabled. Every prescription order is held for pharmacist review.</p>
            )}
          </Panel>
        </div>
      </div>
    </AdminShell>
  );
}

export function ReportsPage({
  from,
  to,
  totals,
  daily,
  byStatus,
  topProducts,
  byCategory,
}: {
  from: string;
  to: string;
  totals: { orders: number; revenue: number; discount: number; tax: number; shipping: number; refunds: number };
  daily: Array<{ day: string; revenue_paise: number; orders: number }>;
  byStatus: Array<{ status: OrderStatus; n: number; total: number }>;
  topProducts: Array<{ product_name: string; qty: number; revenue: number }>;
  byCategory: Array<{ category: string; qty: number; revenue: number }>;
}) {
  return (
    <AdminShell title="Sales reports" current="/admin/reports">
      <form method="get" className="mb-6 flex flex-wrap items-end gap-2" aria-label="Report period">
        <div className="field">
          <label htmlFor="rf" className="hint">
            From
          </label>
          <input id="rf" type="date" name="from" className="input min-h-10" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="rt" className="hint">
            To
          </label>
          <input id="rt" type="date" name="to" className="input min-h-10" defaultValue={to} />
        </div>
        <button className="btn btn-secondary btn-sm" type="submit">
          Apply
        </button>
        <a className="btn btn-quiet btn-sm" href={`/admin/reports/export.csv?from=${from}&to=${to}`}>
          Download orders CSV
        </a>
      </form>
      <p className="mb-3 text-sm text-[var(--color-muted)]">Counts paid online orders and cash-on-delivery orders that were not cancelled. Dates are IST.</p>
      <Kpis
        items={[
          { label: 'Orders', value: String(totals.orders) },
          { label: 'Gross sales (incl. GST)', value: formatINR(totals.revenue) },
          { label: 'GST included', value: formatINR(totals.tax) },
          { label: 'Refunded', value: formatINR(totals.refunds) },
        ]}
      />
      <div className="mt-6 grid gap-6">
        <Panel title="Revenue per day">
          <RevenueBars data={daily} />
        </Panel>
        <div className="grid gap-6 xl:grid-cols-3">
          <Panel title="Top products">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="text-right">
                    Units
                  </th>
                  <th scope="col" className="text-right">
                    Sales
                  </th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((p) => (
                  <tr key={p.product_name}>
                    <td className="text-sm">{p.product_name}</td>
                    <td className="tabular text-right">{p.qty}</td>
                    <td className="tabular text-right">{formatINR(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="By category">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col" className="text-right">
                    Units
                  </th>
                  <th scope="col" className="text-right">
                    Sales
                  </th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map((c) => (
                  <tr key={c.category}>
                    <td className="text-sm">{c.category}</td>
                    <td className="tabular text-right">{c.qty}</td>
                    <td className="tabular text-right">{formatINR(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="All orders by status">
            <table className="table">
              <tbody>
                {byStatus.map((s) => (
                  <tr key={s.status}>
                    <td className="text-sm">{STATUS_LABEL[s.status]}</td>
                    <td className="tabular text-right">{s.n}</td>
                    <td className="tabular text-right">{formatINR(s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>
    </AdminShell>
  );
}

export function CustomersPage({
  rows,
  q,
}: {
  rows: Array<{
    id: string;
    name: string;
    email: string;
    phone: string | null;
    created_at: Date;
    orders: number;
    spent: number;
    deleted_at: Date | null;
    disabled_at: Date | null;
  }>;
  q: string;
}) {
  return (
    <AdminShell title="Customers" current="/admin/customers">
      <form method="get" className="mb-4 flex gap-2" aria-label="Search customers">
        <label htmlFor="cq" className="sr-only">
          Search
        </label>
        <input id="cq" name="q" className="input min-h-10 w-64" defaultValue={q} placeholder="Name, email or phone" />
        <button className="btn btn-secondary btn-sm" type="submit">
          Search
        </button>
      </form>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Joined</th>
              <th scope="col" className="text-right">
                Orders
              </th>
              <th scope="col" className="text-right">
                Spent
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <a className="link" href={`/admin/customers/${c.id}`}>
                    {c.name}
                  </a>
                  {c.deleted_at ? <span className="pill pill-muted ml-2">Deleted</span> : c.disabled_at ? <span className="pill pill-danger ml-2">Disabled</span> : null}
                  <span className="block text-xs text-[var(--color-muted)]">{c.email}</span>
                </td>
                <td className="text-xs">{fmtDay(c.created_at)}</td>
                <td className="tabular text-right">{c.orders}</td>
                <td className="tabular text-right">{formatINR(c.spent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}

export function CustomerPage({
  c,
  addresses,
  orders,
}: {
  c: { id: string; name: string; email: string; phone: string | null; created_at: Date; marketing_opt_in: boolean; disabled_at: Date | null; deleted_at: Date | null };
  addresses: Array<{ id: string; full_name: string; city: string; state: string; pincode: string; phone: string }>;
  orders: Array<{ id: string; number: string; status: OrderStatus; total_paise: number; created_at: Date }>;
}) {
  return (
    <AdminShell
      title={c.name}
      current="/admin/customers"
      actions={
        !c.deleted_at ? (
          <ActionButton
            action={`/admin/customers/${c.id}/toggle`}
            label={c.disabled_at ? 'Re-enable account' : 'Disable account'}
            className={c.disabled_at ? 'btn btn-secondary btn-sm' : 'btn btn-danger btn-sm'}
            confirm={c.disabled_at ? undefined : 'Disable this account? The customer will be signed out and unable to sign in.'}
          />
        ) : null
      }
    >
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Profile">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-[var(--color-muted)]">Email</dt>
            <dd>{c.email}</dd>
            <dt className="text-[var(--color-muted)]">Phone</dt>
            <dd>{c.phone ?? '—'}</dd>
            <dt className="text-[var(--color-muted)]">Joined</dt>
            <dd>{fmtDay(c.created_at)}</dd>
            <dt className="text-[var(--color-muted)]">Marketing</dt>
            <dd>{c.marketing_opt_in ? 'Opted in' : 'Not opted in'}</dd>
          </dl>
          <p className="hint mt-3">Viewing customer records is logged. Prescriptions are visible to pharmacists only.</p>
        </Panel>
        <Panel title="Addresses">
          <ul className="grid gap-1 text-sm">
            {addresses.map((a) => (
              <li key={a.id}>
                {a.full_name}, {a.city}, {a.state} {a.pincode}
              </li>
            ))}
            {!addresses.length ? <li className="text-[var(--color-muted)]">None saved.</li> : null}
          </ul>
        </Panel>
        <Panel title="Orders">
          <table className="table">
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <a className="link tabular" href={`/admin/orders/${o.id}`}>
                      {o.number}
                    </a>
                  </td>
                  <td className="text-xs">{fmtDay(o.created_at)}</td>
                  <td className="text-sm">{STATUS_LABEL[o.status]}</td>
                  <td className="tabular text-right">{formatINR(o.total_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </AdminShell>
  );
}

export interface CouponRow {
  id: string;
  code: string;
  description: string;
  kind: 'percent' | 'fixed';
  value: number;
  min_subtotal_paise: number;
  max_discount_paise: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  usage_limit: number | null;
  per_user_limit: number;
  used_count: number;
  exclude_pharmacy: boolean;
  is_active: boolean;
}

export function CouponsPage({ rows, errors, values }: { rows: CouponRow[]; errors?: Errors; values?: Values }) {
  return (
    <AdminShell title="Coupons" current="/admin/coupons">
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Coupons">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Discount</th>
                  <th scope="col">Valid</th>
                  <th scope="col" className="text-right">
                    Used
                  </th>
                  <th scope="col">Active</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <span className="tabular font-semibold">{c.code}</span>
                      <span className="block text-xs text-[var(--color-muted)]">{c.description}</span>
                    </td>
                    <td className="text-sm">
                      {c.kind === 'percent' ? `${c.value}%` : formatINR(c.value)}
                      {c.max_discount_paise ? ` up to ${formatINR(c.max_discount_paise)}` : ''}
                      {c.min_subtotal_paise ? <span className="block text-xs">min {formatINR(c.min_subtotal_paise)}</span> : null}
                      {c.exclude_pharmacy ? <span className="block text-xs">excl. pharmacy</span> : null}
                    </td>
                    <td className="text-xs">
                      {c.starts_at ? fmtDay(c.starts_at) : 'Now'} – {c.ends_at ? fmtDay(c.ends_at) : 'no end'}
                    </td>
                    <td className="tabular text-right">
                      {c.used_count}
                      {c.usage_limit ? ` / ${c.usage_limit}` : ''}
                    </td>
                    <td>{c.is_active ? 'Yes' : 'No'}</td>
                    <td>
                      <ActionButton action={`/admin/coupons/${c.id}/toggle`} label={c.is_active ? 'Deactivate' : 'Activate'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Create coupon">
          <Form action="/admin/coupons" className="grid gap-3" ariaLabel="Create coupon">
            <FormErrors errors={errors} />
            <TextField name="code" label="Code" required value={values?.code} errors={errors} />
            <TextField name="description" label="Description shown to customers" value={values?.description} errors={errors} />
            <SelectField
              name="kind"
              label="Type"
              required
              options={[
                { value: 'percent', label: 'Percentage off' },
                { value: 'fixed', label: 'Fixed rupee amount off' },
              ]}
              value={values?.kind ?? 'percent'}
              errors={errors}
            />
            <TextField name="value" label="Value (% or ₹)" required value={values?.value} errors={errors} inputMode="decimal" />
            <TextField name="minSubtotal" label="Minimum eligible spend (₹)" value={values?.minSubtotal} errors={errors} inputMode="decimal" />
            <TextField name="maxDiscount" label="Maximum discount (₹)" value={values?.maxDiscount} errors={errors} inputMode="decimal" />
            <TextField name="startsAt" label="Starts" type="date" value={values?.startsAt} errors={errors} />
            <TextField name="endsAt" label="Ends" type="date" value={values?.endsAt} errors={errors} />
            <TextField name="usageLimit" label="Total uses allowed" value={values?.usageLimit} errors={errors} inputMode="numeric" />
            <TextField name="perUserLimit" label="Uses per customer" value={values?.perUserLimit ?? '1'} errors={errors} inputMode="numeric" />
            <Checkbox name="excludePharmacy" label="Exclude pharmacy products (recommended)" checked={values ? values.excludePharmacy === 'on' : true} />
            <p className="hint">Discounts on medicines may be restricted. Confirm with your regulatory adviser before including them.</p>
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Create coupon
              </button>
            </div>
          </Form>
        </Panel>
      </div>
    </AdminShell>
  );
}

export function MessagesPage({
  rows,
}: {
  rows: Array<{ id: string; name: string; email: string; topic: string; order_number: string | null; message: string; status: string; created_at: Date }>;
}) {
  return (
    <AdminShell title="Customer messages" current="/admin/messages">
      <div className="grid gap-3">
        {rows.map((m) => (
          <Panel
            key={m.id}
            title={`${m.topic}: ${m.name}`}
            actions={m.status === 'open' ? <ActionButton action={`/admin/messages/${m.id}/close`} label="Mark resolved" /> : <span className="pill pill-muted">Resolved</span>}
          >
            <p className="text-xs text-[var(--color-muted)]">
              {fmtDate(m.created_at)}, {m.email}
              {m.order_number ? `, order ${m.order_number}` : ''}
            </p>
            <p className="mt-2 text-sm whitespace-pre-line">{m.message}</p>
          </Panel>
        ))}
        {!rows.length ? <p className="text-[var(--color-muted)]">No messages yet.</p> : null}
      </div>
    </AdminShell>
  );
}

export function StaffPage({
  rows,
  errors,
  values,
}: {
  rows: Array<{ id: string; name: string; email: string; role: string; disabled_at: Date | null; pharmacist_reg_no: string | null }>;
  errors?: Errors;
  values?: Values;
}) {
  return (
    <AdminShell title="Staff accounts" current="/admin/users">
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Staff">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.name}
                    <span className="block text-xs text-[var(--color-muted)]">{u.email}</span>
                  </td>
                  <td className="text-sm">
                    {u.role}
                    {u.pharmacist_reg_no ? <span className="block text-xs">Reg. {u.pharmacist_reg_no}</span> : null}
                  </td>
                  <td className="text-sm">{u.disabled_at ? 'Disabled' : 'Active'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Grant a role">
          <Form action="/admin/users" className="grid gap-3" ariaLabel="Grant a role">
            <FormErrors errors={errors} />
            <p className="hint">The person must first create a customer account. Then set their role here.</p>
            <TextField name="email" label="Account email" type="email" required value={values?.email} errors={errors} />
            <SelectField
              name="role"
              label="Role"
              required
              options={[
                { value: 'staff', label: 'Staff — orders, products, stock' },
                { value: 'pharmacist', label: 'Pharmacist — prescription review' },
                { value: 'admin', label: 'Admin — everything' },
                { value: 'customer', label: 'Customer — remove staff access' },
              ]}
              value={values?.role}
              errors={errors}
            />
            <TextField name="pharmacistRegNo" label="Pharmacist registration no." value={values?.pharmacistRegNo} errors={errors} hint="Required for pharmacists." />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Save role
              </button>
            </div>
          </Form>
        </Panel>
      </div>
    </AdminShell>
  );
}

export function AuditPage({
  rows,
  filter,
}: {
  rows: Array<{
    id: number;
    actor: string | null;
    actor_role: string | null;
    action: string;
    entity: string;
    entity_id: string | null;
    details: unknown;
    ip: string | null;
    created_at: Date;
  }>;
  filter: string;
}) {
  return (
    <AdminShell title="Audit log" current="/admin/audit">
      <form method="get" className="mb-4 flex gap-2" aria-label="Filter audit log">
        <label htmlFor="af" className="sr-only">
          Action contains
        </label>
        <input id="af" name="action" className="input min-h-10 w-64" defaultValue={filter} placeholder="e.g. prescription, order.status" />
        <button className="btn btn-secondary btn-sm" type="submit">
          Filter
        </button>
      </form>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table min-w-[50rem]">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="text-xs whitespace-nowrap">{fmtDate(r.created_at)}</td>
                <td className="text-sm">
                  {r.actor ?? 'System'}
                  <span className="block text-xs text-[var(--color-muted)]">
                    {r.actor_role}
                    {r.ip ? `, ${r.ip}` : ''}
                  </span>
                </td>
                <td className="text-sm">
                  <span className="font-semibold">{r.action}</span>
                  <span className="block font-mono text-xs text-[var(--color-muted)]">
                    {r.entity} {r.entity_id?.slice(0, 8)}
                  </span>
                </td>
                <td className="max-w-md font-mono text-xs break-all">{JSON.stringify(r.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}

export function SettingsAdminPage({ s, errors, rxBlockers, envFlag }: { s: Settings; errors?: Errors; rxBlockers: string[]; envFlag: boolean }) {
  const rupee = (p: number) => paiseToRupeesInput(p);
  return (
    <AdminShell title="Store settings" current="/admin/settings">
      <FormErrors errors={errors} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Store & seller details">
          <Form action="/admin/settings/store" className="grid gap-3" ariaLabel="Store details">
            <TextField name="name" label="Store name" required value={s.store.name} />
            <TextField name="legalName" label="Legal entity name" required value={s.store.legalName} />
            <TextArea name="address" label="Registered address" rows={2} value={s.store.address} />
            <TextField name="gstin" label="GSTIN" value={s.store.gstin} />
            <TextField name="email" label="Support email" type="email" value={s.store.email} />
            <TextField name="phone" label="Support phone" value={s.store.phone} />
            <TextField name="supportHours" label="Support hours" value={s.store.supportHours} />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Save store details
              </button>
            </div>
          </Form>
        </Panel>
        <Panel title="Shipping & payment">
          <Form action="/admin/settings/shipping" className="grid gap-3" ariaLabel="Shipping settings">
            <TextField name="flatFee" label="Delivery charge (₹)" required value={rupee(s.shipping.flatFeePaise)} inputMode="decimal" />
            <TextField name="freeThreshold" label="Free delivery from (₹)" required value={rupee(s.shipping.freeThresholdPaise)} inputMode="decimal" />
            <Checkbox name="codEnabled" label="Offer cash on delivery" checked={s.shipping.codEnabled} />
            <TextField name="codFee" label="COD fee (₹)" value={rupee(s.shipping.codFeePaise)} inputMode="decimal" />
            <TextField name="codMax" label="COD maximum order (₹)" value={rupee(s.shipping.codMaxOrderPaise)} inputMode="decimal" />
            <TextField name="blocked" label="Blocked PIN code prefixes" value={s.shipping.blockedPincodePrefixes.join(', ')} hint="Comma separated, e.g. 744, 682551" />
            <TextField name="dispatchTime" label="Dispatch time text" value={s.shipping.dispatchTime} />
            <TextField name="deliveryEstimate" label="Delivery estimate text" value={s.shipping.deliveryEstimate} />
            <TextField name="returnWindow" label="Return window (days)" value={String(s.orders.returnWindowDays)} inputMode="numeric" />
            <TextField name="reservation" label="Unpaid order reservation (minutes)" value={String(s.orders.reservationMinutes)} inputMode="numeric" />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Save shipping settings
              </button>
            </div>
          </Form>
        </Panel>
        <Panel title="Pharmacy & compliance">
          <div className={`notice mb-4 text-sm ${rxBlockers.length ? 'notice-warning' : 'notice-success'}`}>
            {rxBlockers.length ? (
              <>
                <p className="font-semibold">Prescription ordering is OFF.</p>
                <ul className="mt-1 list-disc pl-5">
                  {rxBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                {!envFlag ? <p className="mt-2">The server flag can only be changed by whoever deploys the app, after legal sign-off.</p> : null}
              </>
            ) : (
              <p>Prescription ordering is ON. Every order is held for pharmacist review.</p>
            )}
          </div>
          <Form action="/admin/settings/pharmacy" className="grid gap-3" ariaLabel="Pharmacy settings">
            <Checkbox name="otcVisible" label="Show non-prescription pharmacy products" checked={s.pharmacy.otcVisible} />
            <Checkbox name="rxListingVisible" label="List prescription medicines (information only unless ordering is on)" checked={s.pharmacy.rxListingVisible} />
            <Checkbox name="rxOrderingEnabled" label="Allow prescription orders (requires all conditions above)" checked={s.pharmacy.rxOrderingEnabled} />
            <TextArea name="drugLicenceNumbers" label="Drug sale licence number(s)" rows={2} value={s.pharmacy.drugLicenceNumbers} />
            <TextField name="pharmacistName" label="Registered pharmacist" value={s.pharmacy.pharmacistName} />
            <TextField name="pharmacistRegNo" label="Pharmacist registration no." value={s.pharmacy.pharmacistRegNo} />
            <TextField name="rxValidityDays" label="Default prescription validity (days)" value={String(s.pharmacy.rxValidityDays)} inputMode="numeric" />
            <TextField
              name="rxRetentionDays"
              label="Prescription retention (days)"
              value={String(s.pharmacy.rxRetentionDays)}
              inputMode="numeric"
              hint="Confirm against record-keeping rules."
            />
            <TextField name="grievanceOfficerName" label="Grievance officer name" value={s.compliance.grievanceOfficerName} />
            <TextField name="grievanceOfficerEmail" label="Grievance officer email" type="email" value={s.compliance.grievanceOfficerEmail} />
            <TextField name="grievanceOfficerPhone" label="Grievance officer phone" value={s.compliance.grievanceOfficerPhone} />
            <TextField name="cin" label="Company CIN" value={s.compliance.cin} />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Save pharmacy & compliance
              </button>
            </div>
          </Form>
        </Panel>
      </div>
    </AdminShell>
  );
}
