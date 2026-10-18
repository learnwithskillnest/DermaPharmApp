import { AdminShell, Panel, fmtDate, fmtDay } from './layout.tsx';
import { ActionButton, Checkbox, Form, FormErrors, SelectField, TextArea, TextField, type Errors } from '../forms.tsx';
import { formatINR, paiseToRupeesInput } from '../../shared/money.ts';
import { ADMIN_TRANSITIONS, STATUS_LABEL, type OrderItemRow, type OrderRow, type OrderStatus } from '../../server/services/orders.ts';
import { RETURN_REASONS, RETURN_STATUS_LABEL, type ReturnRow } from '../../server/services/returns.ts';
import type { PrescriptionRow } from '../../server/services/prescriptions.ts';
import { StatusPill } from '../pages/account.tsx';
import { AddressText, type AddressRow } from '../pages/checkout.tsx';
import { useUi } from '../context.tsx';
import { can } from '../../server/auth/permissions.ts';

export function OrdersList({
  rows,
  filters,
  page,
  pages,
}: {
  rows: Array<OrderRow & { customer_name: string | null; item_count: number }>;
  filters: Record<string, string>;
  page: number;
  pages: number;
}) {
  const qs = (p: number) => {
    const u = new URLSearchParams(filters);
    u.set('page', String(p));
    return `/admin/orders?${u}`;
  };
  return (
    <AdminShell title="Orders" current="/admin/orders">
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filter orders">
        <div className="field">
          <label htmlFor="oq" className="hint">
            Order no. or email
          </label>
          <input id="oq" name="q" className="input min-h-10 w-56" defaultValue={filters.q} />
        </div>
        <div className="field">
          <label htmlFor="os" className="hint">
            Status
          </label>
          <select id="os" name="status" className="select min-h-10" defaultValue={filters.status}>
            <option value="">Any</option>
            {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
            <option value="rx_pending">Prescription review pending</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="of" className="hint">
            From
          </label>
          <input id="of" type="date" name="from" className="input min-h-10" defaultValue={filters.from} />
        </div>
        <div className="field">
          <label htmlFor="ot" className="hint">
            To
          </label>
          <input id="ot" type="date" name="to" className="input min-h-10" defaultValue={filters.to} />
        </div>
        <button className="btn btn-secondary btn-sm" type="submit">
          Filter
        </button>
      </form>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table min-w-[48rem]">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Placed</th>
              <th scope="col">Customer</th>
              <th scope="col">Status</th>
              <th scope="col">Payment</th>
              <th scope="col" className="text-right">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <a className="link tabular font-semibold" href={`/admin/orders/${o.id}`}>
                    {o.number}
                  </a>
                  {o.requires_rx_review ? <span className="pill pill-rx ml-2">Rx {o.rx_review_status}</span> : null}
                </td>
                <td className="text-xs whitespace-nowrap">{fmtDate(o.created_at)}</td>
                <td className="text-sm">
                  {o.customer_name ?? '—'}
                  <span className="block text-xs text-[var(--color-muted)]">{o.item_count} items</span>
                </td>
                <td>
                  <StatusPill status={o.status} />
                </td>
                <td className="text-sm">
                  {o.payment_method === 'cod' ? 'COD' : 'Online'}, {o.payment_status.replace(/_/g, ' ')}
                </td>
                <td className="tabular text-right">{formatINR(o.total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-6 text-center text-[var(--color-muted)]">No orders match these filters.</p> : null}
      </div>
      {pages > 1 ? (
        <div className="mt-4 flex justify-between text-sm">
          {page > 1 ? (
            <a className="link" href={qs(page - 1)}>
              Previous
            </a>
          ) : (
            <span />
          )}
          <span className="tabular">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <a className="link" href={qs(page + 1)}>
              Next
            </a>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </AdminShell>
  );
}

export function OrderAdminPage({
  order,
  items,
  events,
  attempts,
  shipments,
  returns,
  customer,
  errors,
  prescription,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  events: Array<{ status: string; note: string | null; created_at: Date; actor: string | null; visible_to_customer: boolean }>;
  attempts: Array<{
    provider: string;
    provider_order_id: string;
    provider_payment_id: string | null;
    amount_paise: number;
    status: string;
    signature_verified: boolean;
    failure_reason: string | null;
    created_at: Date;
  }>;
  shipments: Array<{ carrier: string; tracking_number: string; status: string; shipped_at: Date }>;
  returns: ReturnRow[];
  customer: { id: string; name: string; email: string } | null;
  errors?: Errors;
  prescription: { id: string; status: string; patient_name: string } | null;
}) {
  const { user } = useUi();
  const next = ADMIN_TRANSITIONS[order.status] ?? [];
  const canManage = can(user?.role, 'orders.manage');
  return (
    <AdminShell title={`Order ${order.number}`} current="/admin/orders" actions={<StatusPill status={order.status} />}>
      <FormErrors errors={errors} />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="grid content-start gap-6">
          <Panel title="Items">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="text-right">
                    Unit
                  </th>
                  <th scope="col" className="text-right">
                    Qty
                  </th>
                  <th scope="col" className="text-right">
                    GST
                  </th>
                  <th scope="col" className="text-right">
                    Line
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.product_name}
                      {i.requires_prescription ? <span className="pill pill-rx ml-2">Rx</span> : null}
                      <span className="block text-xs text-[var(--color-muted)]">
                        {i.variant_name}, {i.sku}
                        {i.hsn_code ? `, HSN ${i.hsn_code}` : ''}
                      </span>
                    </td>
                    <td className="tabular text-right">{formatINR(i.unit_price_paise)}</td>
                    <td className="tabular text-right">{i.quantity}</td>
                    <td className="tabular text-right text-xs">
                      {formatINR(i.tax_paise)} @ {i.tax_rate_bps / 100}%
                    </td>
                    <td className="tabular text-right">
                      {formatINR(i.line_total_paise - i.line_discount_paise)}
                      {i.line_discount_paise ? <span className="block text-xs text-[var(--color-muted)]">after −{formatINR(i.line_discount_paise)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-3 ml-auto grid max-w-xs gap-1 text-sm">
              {[
                ['Subtotal', formatINR(order.subtotal_paise)],
                ['Discount', order.discount_paise ? `−${formatINR(order.discount_paise)} (${order.coupon_code})` : '—'],
                ['Delivery', formatINR(order.shipping_paise)],
                ['COD fee', formatINR(order.cod_fee_paise)],
                ['GST included', formatINR(order.tax_paise)],
                ['Total', formatINR(order.total_paise)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-[var(--color-muted)]">{k}</dt>
                  <dd className="tabular">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel title="Payment attempts">
            {attempts.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Created</th>
                    <th scope="col">Gateway ref</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="text-right">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.provider_order_id}>
                      <td className="text-xs">{fmtDate(a.created_at)}</td>
                      <td className="font-mono text-xs break-all">
                        {a.provider}: {a.provider_order_id}
                        {a.provider_payment_id ? <span className="block">{a.provider_payment_id}</span> : null}
                      </td>
                      <td className="text-sm">
                        {a.status}
                        {a.signature_verified ? <span className="block text-xs text-[var(--color-success)]">Signature verified</span> : null}
                        {a.failure_reason ? <span className="block text-xs text-[var(--color-danger)]">{a.failure_reason}</span> : null}
                      </td>
                      <td className="tabular text-right">{formatINR(a.amount_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">{order.payment_method === 'cod' ? 'Cash on delivery — no online attempts.' : 'No payment attempts yet.'}</p>
            )}
          </Panel>
          <Panel title="History">
            <ol className="grid gap-2 text-sm">
              {events.map((e, i) => (
                <li key={i} className="grid grid-cols-[9rem_1fr] gap-3">
                  <span className="text-xs text-[var(--color-muted)]">{fmtDate(e.created_at)}</span>
                  <span>
                    <strong>{e.status.replace(/_/g, ' ')}</strong> {e.note}
                    <span className="text-xs text-[var(--color-muted)]">
                      {' '}
                      {e.actor ? `by ${e.actor}` : ''}
                      {e.visible_to_customer ? '' : ' (internal)'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        <div className="grid content-start gap-6">
          <Panel title="Customer">
            {customer ? (
              <p className="text-sm">
                {customer.name}
                <br />
                {order.email}
                <br />
                {order.phone}
              </p>
            ) : (
              <p className="text-sm">{order.email}</p>
            )}
            <div className="mt-3">
              <AddressText a={order.shipping_address as unknown as AddressRow} />
            </div>
            {order.customer_note ? <p className="notice mt-3 text-sm">Note: {order.customer_note}</p> : null}
          </Panel>
          {order.requires_rx_review ? (
            <Panel title="Prescription check">
              <p className="text-sm">
                Status: <strong>{order.rx_review_status}</strong>
              </p>
              {prescription ? (
                <p className="mt-1 text-sm">
                  Linked prescription for {prescription.patient_name} ({prescription.status}).{' '}
                  {can(user?.role, 'rx.documents') ? (
                    <a className="link" href={`/admin/prescriptions/${prescription.id}`}>
                      Review
                    </a>
                  ) : null}
                </p>
              ) : null}
              {order.rx_review_status === 'pending' && can(user?.role, 'rx.review') ? (
                <div className="mt-3 flex gap-2">
                  <ActionButton action={`/admin/orders/${order.id}/rx`} fields={{ decision: 'approved' }} label="Verify & approve" className="btn btn-primary btn-sm" />
                  <ActionButton
                    action={`/admin/orders/${order.id}/rx`}
                    fields={{ decision: 'rejected' }}
                    label="Reject"
                    className="btn btn-danger btn-sm"
                    confirm="Reject this prescription order?"
                  />
                </div>
              ) : order.rx_review_status === 'pending' ? (
                <p className="hint mt-2">A pharmacist must review this order before it can be packed.</p>
              ) : null}
            </Panel>
          ) : null}
          {canManage && next.length ? (
            <Panel title="Update status">
              <Form action={`/admin/orders/${order.id}/status`} className="grid gap-3" ariaLabel="Update status">
                <SelectField name="status" label="New status" required options={next.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
                <TextField name="note" label="Note shown to the customer" />
                <button className="btn btn-primary btn-sm" type="submit">
                  Update status
                </button>
              </Form>
            </Panel>
          ) : null}
          {canManage && ['confirmed', 'processing', 'shipped'].includes(order.status) ? (
            <Panel title="Shipments">
              {shipments.map((s) => (
                <p key={s.tracking_number} className="mb-2 text-sm">
                  {s.carrier} <span className="tabular">{s.tracking_number}</span> ({s.status})
                </p>
              ))}
              <Form action={`/admin/orders/${order.id}/shipment`} className="grid gap-3" ariaLabel="Add shipment">
                <TextField name="carrier" label="Carrier" required />
                <TextField name="trackingNumber" label="Tracking number" required />
                <TextField name="trackingUrl" label="Tracking URL" type="url" />
                <button className="btn btn-secondary btn-sm" type="submit">
                  Add shipment & mark shipped
                </button>
              </Form>
            </Panel>
          ) : null}
          {returns.length ? (
            <Panel
              title="Returns & refunds"
              actions={
                <a className="link text-sm" href="/admin/returns">
                  Manage
                </a>
              }
            >
              {returns.map((r) => (
                <p key={r.id} className="text-sm">
                  {RETURN_STATUS_LABEL[r.status]}
                  {r.refund_paise ? `, ${formatINR(r.refund_paise)}` : ''}
                </p>
              ))}
            </Panel>
          ) : null}
        </div>
      </div>
    </AdminShell>
  );
}

export function ReturnsAdminPage({ rows, status }: { rows: ReturnRow[]; status: string }) {
  const tabs = ['', 'requested', 'approved', 'received', 'refunded', 'rejected'];
  return (
    <AdminShell title="Returns & refunds" current="/admin/returns">
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <a key={t} href={t ? `/admin/returns?status=${t}` : '/admin/returns'} className={`btn btn-sm ${status === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t ? t[0].toUpperCase() + t.slice(1) : 'All'}
          </a>
        ))}
      </div>
      <div className="grid gap-4">
        {rows.map((r) => {
          const next =
            ({ requested: ['approved', 'rejected'], approved: ['received', 'refunded', 'rejected'], received: ['refunded'] } as Record<string, string[]>)[r.status] ?? [];
          return (
            <Panel
              key={r.id}
              title={`${r.order_number}: ${r.kind === 'refund_only' ? 'Refund (cancelled order)' : 'Return'}`}
              actions={<span className="pill">{RETURN_STATUS_LABEL[r.status]}</span>}
            >
              <div className="grid gap-4 md:grid-cols-[1fr_24rem]">
                <div className="text-sm">
                  <p>
                    <a className="link" href={`/admin/orders/${r.order_id}`}>
                      View order
                    </a>{' '}
                    ({r.payment_method === 'cod' ? 'COD' : 'online'}, total {formatINR(r.total_paise ?? 0)})
                  </p>
                  <p className="mt-1">Reason: {RETURN_REASONS[r.reason as keyof typeof RETURN_REASONS] ?? r.reason}</p>
                  {r.details ? <p className="mt-1 text-[var(--color-muted)]">{r.details}</p> : null}
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Requested {fmtDay(r.created_at)}, {r.customer_email}
                  </p>
                  {r.refund_reference ? <p className="mt-1">Refund reference: {r.refund_reference}</p> : null}
                  {r.admin_note ? <p className="mt-1">Note: {r.admin_note}</p> : null}
                </div>
                {next.length ? (
                  <Form action={`/admin/returns/${r.id}`} className="grid gap-2" ariaLabel={`Update return for ${r.order_number}`}>
                    <SelectField name="status" label="Move to" required options={next.map((s) => ({ value: s, label: s }))} />
                    <TextField name="refund" label="Refund amount (₹)" value={paiseToRupeesInput(r.refund_paise ?? r.total_paise ?? 0)} inputMode="decimal" />
                    <TextField name="reference" label="Refund reference (UTR / gateway id)" />
                    {r.payment_method === 'online' ? <Checkbox name="viaGateway" label="Issue refund through the payment gateway" /> : null}
                    {r.status === 'approved' ? <Checkbox name="restock" label="Put returned items back into stock (sealed, saleable)" /> : null}
                    <TextField name="note" label="Internal note" />
                    <button className="btn btn-primary btn-sm" type="submit">
                      Update
                    </button>
                  </Form>
                ) : null}
              </div>
            </Panel>
          );
        })}
        {!rows.length ? <p className="text-[var(--color-muted)]">Nothing here.</p> : null}
      </div>
    </AdminShell>
  );
}

export function RxQueuePage({
  rows,
  status,
  orders,
}: {
  rows: Array<PrescriptionRow & { customer_name: string }>;
  status: string;
  orders: Array<{ id: string; number: string; created_at: Date; total_paise: number }>;
}) {
  return (
    <AdminShell title="Prescription review" current="/admin/prescriptions">
      <p className="notice mb-6 text-sm">
        Only registered pharmacists can open prescription documents or record decisions. Every view and decision is written to the audit log. Verify the prescriber’s registration,
        patient details, date, signature, and that each medicine and quantity is covered.
      </p>
      {orders.length ? (
        <Panel title="Orders waiting for a prescription check">
          <ul className="grid gap-1 text-sm">
            {orders.map((o) => (
              <li key={o.id}>
                <a className="link tabular" href={`/admin/orders/${o.id}`}>
                  {o.number}
                </a>{' '}
                placed {fmtDate(o.created_at)}, {formatINR(o.total_paise)}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <div className="my-4 flex flex-wrap gap-2">
        {['pending', 'approved', 'rejected', 'expired'].map((t) => (
          <a key={t} href={`/admin/prescriptions?status=${t}`} className={`btn btn-sm ${status === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t[0].toUpperCase() + t.slice(1)}
          </a>
        ))}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Uploaded</th>
              <th scope="col">Customer</th>
              <th scope="col">Patient</th>
              <th scope="col">Doctor</th>
              <th scope="col">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="text-xs">{fmtDate(r.created_at)}</td>
                <td className="text-sm">{r.customer_name}</td>
                <td className="text-sm">{r.patient_name}</td>
                <td className="text-sm">{r.doctor_name ?? '—'}</td>
                <td>
                  <a className="link text-sm" href={`/admin/prescriptions/${r.id}`}>
                    Review
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-6 text-center text-[var(--color-muted)]">No prescriptions in this list.</p> : null}
      </div>
    </AdminShell>
  );
}

export function RxReviewPage({
  rx,
  canReview,
  canView,
  errors,
}: {
  rx: PrescriptionRow & { customer_name: string; customer_email: string; reviewer_name: string | null };
  canReview: boolean;
  canView: boolean;
  errors?: Errors;
}) {
  return (
    <AdminShell title="Review prescription" current="/admin/prescriptions">
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Panel title="Document">
          {canView ? (
            rx.mime_type === 'application/pdf' ? (
              <p className="text-sm">
                <a className="btn btn-secondary btn-sm" href={`/admin/prescriptions/${rx.id}/file`} target="_blank" rel="noopener">
                  Open PDF in a new tab
                </a>
              </p>
            ) : (
              <img
                src={`/admin/prescriptions/${rx.id}/file`}
                alt={`Prescription uploaded for ${rx.patient_name}`}
                className="max-h-[70vh] rounded-lg border border-[var(--color-line)]"
              />
            )
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Only pharmacists can view prescription documents.</p>
          )}
          <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
            <dt className="text-[var(--color-muted)]">Customer</dt>
            <dd>
              {rx.customer_name} ({rx.customer_email})
            </dd>
            <dt className="text-[var(--color-muted)]">Patient</dt>
            <dd>{rx.patient_name}</dd>
            <dt className="text-[var(--color-muted)]">Doctor</dt>
            <dd>{rx.doctor_name ?? '—'}</dd>
            <dt className="text-[var(--color-muted)]">Issued</dt>
            <dd>{rx.issued_on ?? '—'}</dd>
            <dt className="text-[var(--color-muted)]">Status</dt>
            <dd>
              {rx.status}
              {rx.reviewer_name ? ` by ${rx.reviewer_name} on ${fmtDate(rx.reviewed_at)}` : ''}
            </dd>
            <dt className="text-[var(--color-muted)]">Delete after</dt>
            <dd>{rx.delete_after}</dd>
          </dl>
        </Panel>
        {canReview && rx.status === 'pending' ? (
          <Panel title="Decision">
            <Form action={`/admin/prescriptions/${rx.id}`} className="grid gap-3" ariaLabel="Record decision">
              <FormErrors errors={errors} />
              <SelectField
                name="decision"
                label="Decision"
                required
                options={[
                  { value: 'approved', label: 'Approve — valid prescription' },
                  { value: 'rejected', label: 'Reject' },
                ]}
                placeholder="Choose…"
                errors={errors}
              />
              <TextField name="doctorRegNo" label="Prescriber registration no." errors={errors} />
              <TextField name="validUntil" label="Valid until" type="date" errors={errors} hint="Leave blank to use the default validity period." />
              <TextArea name="notes" label="Notes (shown to the customer if rejected)" rows={3} errors={errors} />
              <button className="btn btn-primary btn-sm" type="submit">
                Save decision
              </button>
            </Form>
          </Panel>
        ) : null}
      </div>
    </AdminShell>
  );
}
