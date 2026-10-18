import type { OrderItemRow, OrderRow } from '../../server/services/orders.ts';
import { CUSTOMER_CANCELLABLE, STATUS_LABEL } from '../../server/services/orders.ts';
import type { PrescriptionRow } from '../../server/services/prescriptions.ts';
import { RETURN_REASONS, RETURN_STATUS_LABEL, type ReturnRow } from '../../server/services/returns.ts';
import type { ProductCard } from '../../server/services/catalog.ts';
import { formatINR } from '../../shared/money.ts';
import { AccountShell, EmptyState } from '../layout.tsx';
import { ActionButton, Checkbox, Form, FormErrors, SelectField, TextArea, TextField, type Errors, type Values } from '../forms.tsx';
import { AddressFields, AddressText, type AddressRow } from './checkout.tsx';
import { ProductGrid, ProductTile } from '../product.tsx';

const dt = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dtt = (d: Date | string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export function StatusPill({ status }: { status: OrderRow['status'] }) {
  const tone = ['cancelled', 'payment_failed', 'needs_attention'].includes(status)
    ? 'pill-danger'
    : ['pending_payment', 'cancellation_requested', 'return_requested'].includes(status)
      ? 'pill-rx'
      : ['delivered', 'refunded', 'returned'].includes(status)
        ? 'pill-muted'
        : '';
  return <span className={`pill ${tone}`}>{STATUS_LABEL[status]}</span>;
}

export function AccountHome({
  name,
  orders,
  wishlistCount,
  addressCount,
}: {
  name: string;
  orders: Array<OrderRow & { item_count: number }>;
  wishlistCount: number;
  addressCount: number;
}) {
  return (
    <AccountShell current="/account" title={`Hello, ${name.split(' ')[0]}`}>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ['/account/orders', 'Orders', `${orders.length} placed`],
          ['/account/wishlist', 'Wishlist', `${wishlistCount} saved`],
          ['/account/addresses', 'Addresses', `${addressCount} saved`],
        ].map(([href, t, s]) => (
          <a key={href} href={href} className="rounded-2xl border border-[var(--color-line)] p-5 hover:border-[var(--color-forest-600)]">
            <span className="block font-semibold text-[var(--color-forest-900)]">{t}</span>
            <span className="tabular text-sm text-[var(--color-muted)]">{s}</span>
          </a>
        ))}
      </div>
      <h2 className="mt-10 mb-4 text-xl">Recent orders</h2>
      <OrderList orders={orders.slice(0, 3)} />
    </AccountShell>
  );
}

function OrderList({ orders }: { orders: Array<OrderRow & { item_count: number }> }) {
  if (!orders.length) return <EmptyState title="No orders yet" action={{ href: '/shop', label: 'Start shopping' }} />;
  return (
    <ul className="divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]">
      {orders.map((o) => (
        <li key={o.id}>
          <a
            href={`/account/orders/${o.number}`}
            className="grid grid-cols-[1fr_auto] gap-2 py-4 hover:bg-[var(--color-mint-50)] sm:grid-cols-[8rem_1fr_auto_auto] sm:items-center sm:gap-6 sm:px-2"
          >
            <span className="tabular font-semibold text-[var(--color-forest-900)]">{o.number}</span>
            <span className="text-sm text-[var(--color-muted)] sm:order-none">
              {dt(o.created_at)}, {o.item_count} item{o.item_count === 1 ? '' : 's'}
            </span>
            <StatusPill status={o.status} />
            <span className="tabular text-right font-semibold">{formatINR(o.total_paise)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function OrdersPage({ orders }: { orders: Array<OrderRow & { item_count: number }> }) {
  return (
    <AccountShell current="/account/orders" title="Your orders">
      <OrderList orders={orders} />
    </AccountShell>
  );
}

const PROGRESS: OrderRow['status'][] = ['confirmed', 'processing', 'shipped', 'delivered'];

export function OrderDetailPage({
  order,
  items,
  timeline,
  shipments,
  returns,
  returnWindowOpen,
  errors,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  timeline: Array<{ status: string; note: string | null; created_at: Date }>;
  shipments: Array<{ carrier: string; tracking_number: string; tracking_url: string | null; status: string; shipped_at: Date }>;
  returns: ReturnRow[];
  returnWindowOpen: boolean;
  errors?: Errors;
}) {
  const step = PROGRESS.indexOf(order.status);
  const addr = order.shipping_address as unknown as AddressRow;
  const canPay = order.payment_method === 'online' && ['pending_payment', 'payment_failed'].includes(order.status);
  const canCancel = CUSTOMER_CANCELLABLE.includes(order.status) || order.status === 'processing';
  const openReturn = returns.some((r) => ['requested', 'approved', 'received'].includes(r.status));
  return (
    <AccountShell current="/account/orders" title={`Order ${order.number}`}>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <StatusPill status={order.status} />
        <span className="text-sm text-[var(--color-muted)]">Placed {dtt(order.created_at)}</span>
      </div>
      <FormErrors errors={errors} />
      {step >= 0 ? (
        <ol className="mb-10 grid grid-cols-4 gap-2" aria-label="Order progress">
          {PROGRESS.map((s, i) => (
            <li key={s} className="grid gap-2">
              <span className={`h-1.5 rounded-full ${i <= step ? 'bg-[var(--color-forest-700)]' : 'bg-[var(--color-line)]'}`} aria-hidden="true" />
              <span className={`text-xs ${i <= step ? 'font-semibold text-[var(--color-forest-900)]' : 'text-[var(--color-muted)]'}`}>
                {STATUS_LABEL[s]}
                {i <= step ? <span className="sr-only"> (done)</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {order.requires_rx_review ? (
        <p className="notice notice-warning mb-6">
          Prescription check:{' '}
          {order.rx_review_status === 'approved'
            ? 'verified by our pharmacist.'
            : order.rx_review_status === 'rejected'
              ? 'our pharmacist could not verify the prescription. We will contact you.'
              : 'awaiting pharmacist review.'}
        </p>
      ) : null}
      {canPay ? (
        <div className="notice notice-warning mb-6 flex flex-wrap items-center justify-between gap-3">
          <span>This order is waiting for payment.</span>
          <a className="btn btn-primary btn-sm" href={`/checkout/pay/${order.number}`}>
            Pay {formatINR(order.total_paise)}
          </a>
        </div>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
        <div className="grid content-start gap-10">
          <section aria-labelledby="o-items">
            <h2 id="o-items" className="mb-3 text-lg">
              Items
            </h2>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Product</th>
                  <th scope="col" className="text-right">
                    Qty
                  </th>
                  <th scope="col" className="text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.product_slug ? (
                        <a className="link" href={`/p/${i.product_slug}`}>
                          {i.product_name}
                        </a>
                      ) : (
                        i.product_name
                      )}
                      <span className="block text-xs text-[var(--color-muted)]">
                        {i.variant_name}, SKU {i.sku}
                      </span>
                    </td>
                    <td className="tabular text-right">{i.quantity}</td>
                    <td className="tabular text-right">{formatINR(i.line_total_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-4 ml-auto grid max-w-xs gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt>Items</dt>
                <dd className="tabular">{formatINR(order.subtotal_paise)}</dd>
              </div>
              {order.discount_paise ? (
                <div className="flex justify-between">
                  <dt>Coupon {order.coupon_code}</dt>
                  <dd className="tabular">−{formatINR(order.discount_paise)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt>Delivery</dt>
                <dd className="tabular">{order.shipping_paise ? formatINR(order.shipping_paise) : 'Free'}</dd>
              </div>
              {order.cod_fee_paise ? (
                <div className="flex justify-between">
                  <dt>Cash on delivery fee</dt>
                  <dd className="tabular">{formatINR(order.cod_fee_paise)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-[var(--color-line)] pt-2 font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{formatINR(order.total_paise)}</dd>
              </div>
              <p className="text-xs text-[var(--color-muted)]">Includes GST of {formatINR(order.tax_paise)}.</p>
            </dl>
          </section>

          {shipments.length ? (
            <section aria-labelledby="o-ship">
              <h2 id="o-ship" className="mb-3 text-lg">
                Shipment
              </h2>
              {shipments.map((s) => (
                <p key={s.tracking_number} className="text-sm">
                  {s.carrier}, tracking number <span className="tabular font-semibold">{s.tracking_number}</span>
                  {s.tracking_url ? (
                    <>
                      {' '}
                      <a className="link" href={s.tracking_url} rel="noopener noreferrer" target="_blank">
                        Track with carrier
                      </a>
                    </>
                  ) : null}
                </p>
              ))}
            </section>
          ) : null}

          <section aria-labelledby="o-timeline">
            <h2 id="o-timeline" className="mb-3 text-lg">
              Updates
            </h2>
            <ol className="grid gap-3 border-l-2 border-[var(--color-mint-200)] pl-5">
              {timeline.map((t, i) => (
                <li key={i} className="text-sm">
                  <span className="block text-xs text-[var(--color-muted)]">{dtt(t.created_at)}</span>
                  {t.note ?? t.status}
                </li>
              ))}
            </ol>
          </section>

          {returns.length ? (
            <section aria-labelledby="o-refunds">
              <h2 id="o-refunds" className="mb-3 text-lg">
                Returns & refunds
              </h2>
              <ul className="grid gap-3">
                {returns.map((r) => (
                  <li key={r.id} className="rounded-xl border border-[var(--color-line)] p-4 text-sm">
                    <p className="font-semibold">{RETURN_STATUS_LABEL[r.status]}</p>
                    <p className="text-[var(--color-muted)]">
                      {r.kind === 'refund_only' ? 'Refund for cancelled order' : (RETURN_REASONS[r.reason as keyof typeof RETURN_REASONS] ?? r.reason)}, requested{' '}
                      {dt(r.created_at)}
                    </p>
                    {r.refund_paise ? <p className="tabular mt-1">Refund amount: {formatINR(r.refund_paise)}</p> : null}
                    {r.refund_reference ? <p className="mt-1">Reference: {r.refund_reference}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="grid content-start gap-6">
          <section aria-labelledby="o-addr">
            <h2 id="o-addr" className="mb-2 text-base">
              Delivery address
            </h2>
            <AddressText a={addr} />
          </section>
          <section aria-labelledby="o-pay">
            <h2 id="o-pay" className="mb-2 text-base">
              Payment
            </h2>
            <p className="text-sm">{order.payment_method === 'cod' ? 'Cash on delivery' : 'Online payment'}</p>
            <p className="text-sm text-[var(--color-muted)]">Status: {order.payment_status.replace(/_/g, ' ')}</p>
          </section>
          {canCancel ? (
            <Form action={`/account/orders/${order.number}/cancel`} className="grid gap-3 rounded-xl border border-[var(--color-line)] p-4" ariaLabel="Cancel this order">
              <h2 className="text-base">Cancel order</h2>
              <p className="text-xs text-[var(--color-muted)]">
                {order.status === 'processing'
                  ? 'Your order is being packed — we’ll confirm if it can be stopped.'
                  : 'Cancels immediately. Paid orders are refunded to the original payment method.'}
              </p>
              <SelectField
                name="reason"
                label="Reason"
                required
                options={[
                  { value: 'Ordered by mistake', label: 'Ordered by mistake' },
                  { value: 'Found a better price', label: 'Found a better price' },
                  { value: 'Delivery too slow', label: 'Delivery too slow' },
                  { value: 'Other', label: 'Other' },
                ]}
                value="Ordered by mistake"
              />
              <button type="submit" className="btn btn-danger btn-sm">
                {order.status === 'processing' ? 'Request cancellation' : 'Cancel order'}
              </button>
            </Form>
          ) : null}
          {order.status === 'delivered' && returnWindowOpen && !openReturn ? (
            <Form action={`/account/orders/${order.number}/return`} className="grid gap-3 rounded-xl border border-[var(--color-line)] p-4" ariaLabel="Request a return">
              <h2 className="text-base">Request a return</h2>
              <SelectField
                name="reason"
                label="Reason"
                required
                options={Object.entries(RETURN_REASONS).map(([value, label]) => ({ value, label }))}
                placeholder="Choose a reason"
                errors={errors}
              />
              <TextArea name="details" label="Details" rows={3} maxLength={1000} errors={errors} />
              <button type="submit" className="btn btn-secondary btn-sm">
                Request return
              </button>
            </Form>
          ) : null}
          <a href="/contact" className="link text-sm">
            Need help with this order?
          </a>
        </aside>
      </div>
    </AccountShell>
  );
}

export function AddressesPage({ addresses }: { addresses: AddressRow[] }) {
  return (
    <AccountShell current="/account/addresses" title="Addresses">
      <a href="/account/addresses/new" className="btn btn-primary btn-sm mb-6">
        Add an address
      </a>
      {addresses.length ? (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((a) => (
            <li key={a.id} className="grid gap-3 rounded-2xl border border-[var(--color-line)] p-5">
              <div className="flex flex-wrap gap-2">
                {a.label ? <span className="pill">{a.label}</span> : null}
                {a.is_default ? <span className="pill pill-muted">Default</span> : null}
              </div>
              <AddressText a={a} />
              <div className="flex flex-wrap gap-1">
                <a href={`/account/addresses/${a.id}`} className="btn btn-quiet btn-sm -ml-3">
                  Edit
                </a>
                {!a.is_default ? <ActionButton action={`/account/addresses/${a.id}/default`} label="Make default" /> : null}
                <ActionButton action={`/account/addresses/${a.id}/delete`} label="Delete" confirm="Delete this address?" ariaLabel={`Delete address for ${a.full_name}`} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No saved addresses">Add one now or during checkout.</EmptyState>
      )}
    </AccountShell>
  );
}

export function AddressFormPage({ id, values, errors }: { id: string | null; values?: Values; errors?: Errors }) {
  return (
    <AccountShell current="/account/addresses" title={id ? 'Edit address' : 'Add an address'}>
      <Form action={id ? `/account/addresses/${id}` : '/account/addresses/new'} className="grid max-w-2xl gap-6" ariaLabel="Address">
        <FormErrors errors={errors} />
        <AddressFields values={values} errors={errors} />
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary">
            Save address
          </button>
          <a href="/account/addresses" className="btn btn-quiet">
            Cancel
          </a>
        </div>
      </Form>
    </AccountShell>
  );
}

export function WishlistPage({ items }: { items: ProductCard[] }) {
  return (
    <AccountShell current="/account/wishlist" title="Wishlist">
      {items.length ? (
        <ul className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-3">
          {items.map((p) => (
            <li key={p.id} className="grid content-start gap-2">
              <ProductTile p={p} />
              <ActionButton
                action={`/wishlist/${p.id}/toggle`}
                fields={{ next: '/account/wishlist' }}
                label="Remove"
                className="btn btn-quiet btn-sm -ml-3 w-fit"
                ariaLabel={`Remove ${p.name} from wishlist`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing saved yet" action={{ href: '/shop', label: 'Browse products' }}>
          Use “Save to wishlist” on any product page.
        </EmptyState>
      )}
    </AccountShell>
  );
}

export function RecentlyViewedPage({ items }: { items: ProductCard[] }) {
  return (
    <div className="wrap py-10">
      <h1 className="mb-8 text-3xl">Recently viewed</h1>
      {items.length ? <ProductGrid items={items} /> : <EmptyState title="You haven’t viewed any products yet" action={{ href: '/shop', label: 'Browse products' }} />}
    </div>
  );
}

const RX_STATUS: Record<string, string> = { pending: 'Awaiting pharmacist review', approved: 'Approved', rejected: 'Not approved', expired: 'Expired' };

export function PrescriptionsPage({
  list,
  errors,
  values,
  rxOrderingEnabled,
  maxMb,
}: {
  list: PrescriptionRow[];
  errors?: Errors;
  values?: Values;
  rxOrderingEnabled: boolean;
  maxMb: number;
}) {
  return (
    <AccountShell current="/account/prescriptions" title="Prescriptions">
      {!rxOrderingEnabled ? (
        <p className="notice notice-warning mb-6">
          Online ordering of prescription medicines is not available yet. You can still upload a prescription for our pharmacist to review, but it can’t be used to place an order
          until the service launches.
        </p>
      ) : null}
      <p className="mb-6 max-w-2xl text-sm text-[var(--color-muted)]">
        Prescriptions are stored privately and seen only by our registered pharmacist. They are deleted automatically after the retention period. Upload a clear photo or PDF that
        shows the patient name, doctor’s name, registration number, date and signature.
      </p>
      <Form action="/account/prescriptions" multipart className="mb-10 grid max-w-xl gap-5 rounded-2xl border border-[var(--color-line)] p-5" ariaLabel="Upload a prescription">
        <FormErrors errors={errors} />
        <div className="field">
          <label className="label" htmlFor="f-file">
            Prescription file
          </label>
          <input
            id="f-file"
            name="file"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            className="text-sm"
            aria-describedby="file-hint"
            aria-invalid={errors?.file ? 'true' : undefined}
          />
          <p id="file-hint" className="hint">
            PDF, JPG or PNG, up to {maxMb} MB.
          </p>
          {errors?.file ? <p className="error-text">{errors.file}</p> : null}
        </div>
        <TextField name="patientName" label="Patient name" required value={values?.patientName} errors={errors} />
        <TextField name="doctorName" label="Doctor’s name" value={values?.doctorName} errors={errors} />
        <TextField name="issuedOn" label="Date issued" type="date" value={values?.issuedOn} errors={errors} />
        <Checkbox name="consent" errors={errors} label="I consent to GlowDerma’s registered pharmacist viewing this prescription to verify my orders." />
        <div>
          <button type="submit" className="btn btn-primary">
            Upload prescription
          </button>
        </div>
      </Form>
      {list.length ? (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Uploaded</th>
              <th scope="col">Patient</th>
              <th scope="col">Status</th>
              <th scope="col">File</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{dt(r.created_at)}</td>
                <td>{r.patient_name}</td>
                <td>
                  {RX_STATUS[r.status]}
                  {r.status === 'approved' && r.valid_until ? <span className="block text-xs text-[var(--color-muted)]">Valid until {r.valid_until}</span> : null}
                  {r.status === 'rejected' && r.review_notes ? <span className="block text-xs text-[var(--color-danger)]">{r.review_notes}</span> : null}
                </td>
                <td>
                  <a className="link" href={`/account/prescriptions/${r.id}/file`} target="_blank" rel="noopener">
                    View
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </AccountShell>
  );
}

export function SettingsPage({ values, profileErrors, passwordErrors, sessions }: { values: Values; profileErrors?: Errors; passwordErrors?: Errors; sessions: number }) {
  return (
    <AccountShell current="/account/settings" title="Profile & security">
      <div className="grid max-w-xl gap-12">
        <Form action="/account/settings/profile" className="grid gap-5" ariaLabel="Profile">
          <h2 className="text-lg">Profile</h2>
          <FormErrors errors={profileErrors} />
          <TextField name="name" label="Full name" required value={values.name} errors={profileErrors} autoComplete="name" />
          <TextField name="phone" label="Mobile number" type="tel" value={values.phone} errors={profileErrors} autoComplete="tel" />
          <p className="text-sm text-[var(--color-muted)]">Email: {values.email} (contact support to change it)</p>
          <Checkbox name="marketing" checked={values.marketing === 'on'} label="Email me occasional offers." />
          <div>
            <button type="submit" className="btn btn-primary">
              Save profile
            </button>
          </div>
        </Form>
        <Form action="/account/settings/password" className="grid gap-5" ariaLabel="Change password">
          <h2 className="text-lg">Password</h2>
          <FormErrors errors={passwordErrors} />
          <TextField name="current" label="Current password" type="password" required autoComplete="current-password" errors={passwordErrors} />
          <TextField name="password" label="New password" type="password" required autoComplete="new-password" errors={passwordErrors} />
          <TextField name="confirm" label="Confirm new password" type="password" required autoComplete="new-password" errors={passwordErrors} />
          <p className="text-sm text-[var(--color-muted)]">Changing your password signs you out on {sessions > 1 ? `your ${sessions - 1} other device(s)` : 'other devices'}.</p>
          <div>
            <button type="submit" className="btn btn-primary">
              Change password
            </button>
          </div>
        </Form>
        <Form action="/account/settings/delete" className="grid gap-4 rounded-2xl border border-[color-mix(in_oklab,var(--color-danger)_35%,white)] p-5" ariaLabel="Delete account">
          <h2 className="text-lg">Delete account</h2>
          <p className="text-sm">
            This erases your profile, addresses, wishlist and prescriptions. Order records are kept in pseudonymised form where tax law requires. This cannot be undone.
          </p>
          <TextField name="deletePassword" label="Your password" type="password" required autoComplete="current-password" />
          <TextField name="confirmText" label='Type "DELETE" to confirm' required />
          <div>
            <button type="submit" className="btn btn-danger">
              Delete my account
            </button>
          </div>
        </Form>
      </div>
    </AccountShell>
  );
}
