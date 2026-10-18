import type { CartView } from '../../server/services/cart.ts';
import type { OrderItemRow, OrderRow } from '../../server/services/orders.ts';
import { STATUS_LABEL } from '../../server/services/orders.ts';
import type { PrescriptionRow } from '../../server/services/prescriptions.ts';
import { INDIAN_STATES } from '../../server/validation.ts';
import { formatINR } from '../../shared/money.ts';
import { Breadcrumbs, Logo } from '../layout.tsx';
import { Checkbox, Form, FormErrors, SelectField, TextField, type Errors, type Values } from '../forms.tsx';
import { Summary } from './cart.tsx';
import { Island } from '../island.tsx';
import type { RazorpayCheckoutProps } from '../../client/islands/RazorpayCheckout.tsx';
import { useUi } from '../context.tsx';

export interface AddressRow {
  id: string;
  label: string | null;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  is_default: boolean;
}

export function AddressText({ a }: { a: Pick<AddressRow, 'full_name' | 'line1' | 'line2' | 'landmark' | 'city' | 'state' | 'pincode' | 'phone'> }) {
  return (
    <span className="text-sm leading-relaxed">
      <strong className="text-[var(--color-forest-900)]">{a.full_name}</strong>
      <br />
      {a.line1}
      {a.line2 ? `, ${a.line2}` : ''}
      {a.landmark ? `, near ${a.landmark}` : ''}
      <br />
      {a.city}, {a.state} {a.pincode}
      <br />
      Phone {a.phone}
    </span>
  );
}

export function AddressFields({ values, errors }: { values?: Values; errors?: Errors }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField name="fullName" label="Recipient name" required autoComplete="name" value={values?.fullName} errors={errors} className="sm:col-span-2" />
      <TextField
        name="phone"
        label="Mobile number"
        required
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={values?.phone}
        errors={errors}
        hint="10 digits. The courier may call this number."
      />
      <TextField name="pincode" label="PIN code" required inputMode="numeric" autoComplete="postal-code" maxLength={6} value={values?.pincode} errors={errors} />
      <TextField name="line1" label="Flat, house no., building, street" required autoComplete="address-line1" value={values?.line1} errors={errors} className="sm:col-span-2" />
      <TextField name="line2" label="Area, locality" autoComplete="address-line2" value={values?.line2} errors={errors} className="sm:col-span-2" />
      <TextField name="landmark" label="Landmark" value={values?.landmark} errors={errors} />
      <TextField name="city" label="Town or city" required autoComplete="address-level2" value={values?.city} errors={errors} />
      <SelectField
        name="state"
        label="State or union territory"
        required
        options={INDIAN_STATES.map((s) => ({ value: s, label: s }))}
        placeholder="Choose…"
        value={values?.state}
        errors={errors}
      />
      <TextField name="label" label="Label" value={values?.label} errors={errors} placeholder="Home, Office…" />
      <div className="sm:col-span-2">
        <Checkbox name="isDefault" label="Make this my default address" checked={values?.isDefault === 'on'} />
      </div>
    </div>
  );
}

export interface CheckoutProps {
  cart: CartView;
  addresses: AddressRow[];
  selectedAddressId: string | null;
  paymentMethod: 'online' | 'cod';
  cod: { enabled: boolean; feePaise: number; maxPaise: number };
  prescriptions: PrescriptionRow[];
  rxOrderingEnabled: boolean;
  idempotencyKey: string;
  errors?: Errors;
  showAddressForm: boolean;
  addressValues?: Values;
  addressErrors?: Errors;
  sandbox: boolean;
}

export function CheckoutPage(p: CheckoutProps) {
  const q = p.cart.quote;
  const codTotal = q.totalPaise + (p.paymentMethod === 'cod' ? 0 : p.cod.feePaise);
  const codAllowed = p.cod.enabled && codTotal <= p.cod.maxPaise && !p.cart.hasPrescriptionItems;
  return (
    <div className="wrap py-8 md:py-10">
      <Breadcrumbs items={[{ href: '/cart', label: 'Cart' }, { label: 'Checkout' }]} />
      <h1 className="mt-4 mb-8 text-3xl">Checkout</h1>
      <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-10">
          <section aria-labelledby="addr-h">
            <h2 id="addr-h" className="mb-4 text-xl">
              1. Delivery address
            </h2>
            {p.showAddressForm || p.addresses.length === 0 ? (
              <Form action="/checkout/address" className="grid gap-5 rounded-2xl border border-[var(--color-line)] p-5" ariaLabel="Add a delivery address">
                <FormErrors errors={p.addressErrors} />
                <AddressFields values={p.addressValues} errors={p.addressErrors} />
                <div className="flex gap-2">
                  <button type="submit" className="btn btn-primary">
                    Save address
                  </button>
                  {p.addresses.length ? (
                    <a href="/checkout" className="btn btn-quiet">
                      Cancel
                    </a>
                  ) : null}
                </div>
              </Form>
            ) : (
              <a href="/checkout?new_address=1" className="btn btn-secondary btn-sm mb-4">
                Add a new address
              </a>
            )}
          </section>

          {p.addresses.length ? (
            <Form action="/checkout/place" className="grid gap-10" ariaLabel="Place your order" id="place-order">
              <input type="hidden" name="idempotencyKey" value={p.idempotencyKey} />
              <FormErrors errors={p.errors} />
              <fieldset className="-mt-6">
                <legend className="sr-only">Choose a delivery address</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {p.addresses.map((a) => (
                    <label
                      key={a.id}
                      className="flex cursor-pointer gap-3 rounded-2xl border-[1.5px] border-[var(--color-line)] p-4 has-[:checked]:border-[var(--color-forest-900)] has-[:checked]:bg-[var(--color-mint-50)]"
                    >
                      <input type="radio" name="addressId" value={a.id} defaultChecked={a.id === p.selectedAddressId} className="mt-1 size-4 accent-[var(--color-forest-700)]" />
                      <span>
                        {a.label ? <span className="pill mb-1">{a.label}</span> : null}
                        <span className="block">
                          <AddressText a={a} />
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {p.errors?.addressId ? <p className="error-text mt-2">{p.errors.addressId}</p> : null}
              </fieldset>

              <fieldset>
                <legend className="mb-4 text-xl font-semibold text-[var(--color-forest-900)]">2. Payment</legend>
                <div className="grid gap-3">
                  <label className="flex cursor-pointer gap-3 rounded-2xl border-[1.5px] border-[var(--color-line)] p-4 has-[:checked]:border-[var(--color-forest-900)] has-[:checked]:bg-[var(--color-mint-50)]">
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="online"
                      defaultChecked={p.paymentMethod === 'online'}
                      className="mt-1 size-4 accent-[var(--color-forest-700)]"
                    />
                    <span>
                      <span className="font-semibold">Pay online</span>
                      <span className="block text-sm text-[var(--color-muted)]">
                        {p.sandbox ? 'Sandbox gateway — test mode, no real money is taken.' : 'UPI, cards, net banking and wallets via Razorpay.'}
                      </span>
                    </span>
                  </label>
                  <label
                    className={`flex gap-3 rounded-2xl border-[1.5px] border-[var(--color-line)] p-4 has-[:checked]:border-[var(--color-forest-900)] has-[:checked]:bg-[var(--color-mint-50)] ${codAllowed ? 'cursor-pointer' : 'opacity-60'}`}
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value="cod"
                      defaultChecked={p.paymentMethod === 'cod'}
                      disabled={!codAllowed}
                      className="mt-1 size-4 accent-[var(--color-forest-700)]"
                    />
                    <span>
                      <span className="font-semibold">Cash on delivery</span>
                      <span className="block text-sm text-[var(--color-muted)]">
                        {!p.cod.enabled
                          ? 'Not available right now.'
                          : p.cart.hasPrescriptionItems
                            ? 'Not available for prescription orders.'
                            : codTotal > p.cod.maxPaise
                              ? `Available for orders up to ${formatINR(p.cod.maxPaise)}.`
                              : `Adds a ${formatINR(p.cod.feePaise)} handling fee. Total payable on delivery: ${formatINR(codTotal)}.`}
                      </span>
                    </span>
                  </label>
                </div>
                {p.errors?.paymentMethod ? <p className="error-text mt-2">{p.errors.paymentMethod}</p> : null}
              </fieldset>

              {p.cart.hasPrescriptionItems ? (
                <fieldset>
                  <legend className="mb-4 text-xl font-semibold text-[var(--color-forest-900)]">3. Prescription</legend>
                  {!p.rxOrderingEnabled ? (
                    <p className="notice notice-warning">Prescription medicines can’t be ordered online right now. Remove them from your cart to continue.</p>
                  ) : p.prescriptions.length ? (
                    <div className="grid gap-3">
                      {p.prescriptions.map((r) => (
                        <label key={r.id} className="check rounded-xl border border-[var(--color-line)] p-3">
                          <input type="radio" name="prescriptionId" value={r.id} />
                          <span>
                            Prescription for {r.patient_name}
                            {r.doctor_name ? ` by ${r.doctor_name}` : ''}, valid until {r.valid_until}
                          </span>
                        </label>
                      ))}
                      <p className="hint">Our pharmacist checks the prescription against your order before dispatch.</p>
                    </div>
                  ) : (
                    <p className="notice">
                      You need an approved prescription.{' '}
                      <a className="link" href="/account/prescriptions">
                        Upload one
                      </a>
                      ; our pharmacist reviews it, then you can complete this order.
                    </p>
                  )}
                  {p.errors?.prescriptionId ? <p className="error-text mt-2">{p.errors.prescriptionId}</p> : null}
                </fieldset>
              ) : null}

              <section aria-labelledby="review-h">
                <h2 id="review-h" className="mb-4 text-xl">
                  {p.cart.hasPrescriptionItems ? '4' : '3'}. Review items
                </h2>
                <ul className="divide-y divide-[var(--color-line)] rounded-2xl border border-[var(--color-line)]">
                  {q.lines.map((l) => (
                    <li key={l.variantId} className="flex justify-between gap-4 px-4 py-3 text-sm">
                      <span>
                        <span className="font-semibold text-[var(--color-forest-900)]">{l.productName}</span> <span className="text-[var(--color-muted)]">({l.variantName})</span> ×{' '}
                        {l.quantity}
                      </span>
                      <span className="tabular">{formatINR(l.lineTotalPaise)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 grid gap-4">
                  <div className="field">
                    <label className="label" htmlFor="f-note">
                      Delivery note <span className="font-normal text-[var(--color-muted)]">(optional)</span>
                    </label>
                    <textarea id="f-note" name="note" className="textarea min-h-16" maxLength={300} rows={2} />
                  </div>
                  <Checkbox
                    name="acceptTerms"
                    errors={p.errors}
                    label={
                      <>
                        I have reviewed my order and accept the{' '}
                        <a className="link" href="/policies/terms" target="_blank">
                          terms
                        </a>{' '}
                        and{' '}
                        <a className="link" href="/policies/returns" target="_blank">
                          return policy
                        </a>
                        .
                      </>
                    }
                  />
                  <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={!p.cart.canCheckout}>
                    Place order
                  </button>
                </div>
              </section>
            </Form>
          ) : null}
        </div>
        <div className="grid content-start gap-4 lg:sticky lg:top-6 lg:self-start">
          <Summary q={q} />
          <a href="/cart" className="link text-sm">
            Edit cart
          </a>
        </div>
      </div>
    </div>
  );
}

export function PayPage({
  order,
  sandbox,
  gatewayUrl,
  razorpay,
  expiresAt,
  failed,
}: {
  order: OrderRow;
  sandbox: boolean;
  gatewayUrl: string | null;
  razorpay: RazorpayCheckoutProps | null;
  expiresAt: Date | null;
  failed: boolean;
}) {
  return (
    <div className="wrap max-w-xl py-10">
      <h1 className="text-3xl">Pay for order {order.number}</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Amount due: <strong className="tabular text-[var(--color-forest-900)]">{formatINR(order.total_paise)}</strong>
      </p>
      {failed ? (
        <div className="notice notice-error mt-6" role="alert">
          The last payment attempt did not go through. No money was taken by us. You can try again.
        </div>
      ) : null}
      {expiresAt ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">
          Your items are reserved until {expiresAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST.
        </p>
      ) : null}
      <div className="mt-8 grid gap-4">
        {sandbox && gatewayUrl ? (
          <>
            <a href={gatewayUrl} className="btn btn-primary btn-block">
              Continue to sandbox payment
            </a>
            <p className="text-sm text-[var(--color-muted)]">You’ll see a test gateway where you can simulate a successful or failed payment. No money moves.</p>
          </>
        ) : razorpay ? (
          <Island name="RazorpayCheckout" props={razorpay} />
        ) : null}
        <a href={`/account/orders/${order.number}`} className="btn btn-quiet">
          View order
        </a>
      </div>
    </div>
  );
}

export function SandboxGatewayPage({
  providerOrderId,
  amountPaise,
  merchant,
  orderNumber,
}: {
  providerOrderId: string;
  amountPaise: number;
  merchant: string;
  orderNumber: string | null;
}) {
  return (
    <div className="min-h-dvh bg-[#f4f5f7] py-12">
      <div className="mx-auto max-w-md rounded-2xl border border-[#d5d8de] bg-white p-6 md:p-8">
        <p className="inline-block rounded bg-[#fff1c2] px-2 py-1 text-xs font-bold text-[#6b4f00]">TEST MODE — SANDBOX GATEWAY</p>
        <h1 className="mt-4 text-2xl text-[#1d2433]">Simulated payment</h1>
        <p className="mt-1 text-sm text-[#5a6272]">This page stands in for a real payment provider. Choose an outcome to test the store’s verification flow.</p>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[#5a6272]">Merchant</dt>
          <dd>{merchant}</dd>
          <dt className="text-[#5a6272]">Order</dt>
          <dd>{orderNumber ?? '—'}</dd>
          <dt className="text-[#5a6272]">Gateway ref</dt>
          <dd className="font-mono text-xs break-all">{providerOrderId}</dd>
          <dt className="text-[#5a6272]">Amount</dt>
          <dd className="tabular text-lg font-semibold">{formatINR(amountPaise)}</dd>
        </dl>
        <div className="mt-8 grid gap-3">
          <Form action={`/sandbox-gateway/${providerOrderId}`} ariaLabel="Approve payment">
            <input type="hidden" name="outcome" value="captured" />
            <button type="submit" className="btn btn-block bg-[#1f6b45] text-white hover:bg-[#185837]">
              Simulate successful payment
            </button>
          </Form>
          <Form action={`/sandbox-gateway/${providerOrderId}`} ariaLabel="Decline payment">
            <input type="hidden" name="outcome" value="failed" />
            <button type="submit" className="btn btn-danger btn-block">
              Simulate failed payment
            </button>
          </Form>
          <Form action={`/sandbox-gateway/${providerOrderId}`} ariaLabel="Cancel payment">
            <input type="hidden" name="outcome" value="cancelled" />
            <button type="submit" className="btn btn-quiet btn-block">
              Cancel and return to store
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}

export function ConfirmationPage({ order, items }: { order: OrderRow; items: OrderItemRow[] }) {
  const { user } = useUi();
  const addr = order.shipping_address;
  return (
    <div className="wrap max-w-3xl py-10 md:py-14">
      <div className="reveal">
        <Logo small />
        <h1 className="mt-6 text-3xl md:text-4xl">{order.payment_method === 'cod' ? 'Order placed.' : 'Payment received. Order confirmed.'}</h1>
        <p className="mt-3 text-lg text-[var(--color-muted)]">
          Thank you{user ? `, ${user.name.split(' ')[0]}` : ''}. Your order number is <strong className="tabular text-[var(--color-forest-900)]">{order.number}</strong>. We’ve
          emailed a copy to {order.email}.
        </p>
      </div>
      {order.requires_rx_review ? <p className="notice notice-warning mt-6">Our registered pharmacist will verify your prescription before this order is dispatched.</p> : null}
      <div className="mt-10 grid gap-8 md:grid-cols-2">
        <section aria-labelledby="c-items">
          <h2 id="c-items" className="mb-3 text-lg">
            Items
          </h2>
          <ul className="grid gap-2 text-sm">
            {items.map((i) => (
              <li key={i.id} className="flex justify-between gap-3">
                <span>
                  {i.product_name} ({i.variant_name}) × {i.quantity}
                </span>
                <span className="tabular">{formatINR(i.line_total_paise)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex justify-between border-t border-[var(--color-line)] pt-3 font-semibold">
            <span>{order.payment_method === 'cod' ? 'To pay on delivery' : 'Paid'}</span>
            <span className="tabular">{formatINR(order.total_paise)}</span>
          </p>
        </section>
        <section aria-labelledby="c-addr">
          <h2 id="c-addr" className="mb-3 text-lg">
            Delivering to
          </h2>
          <AddressText a={addr as unknown as AddressRow} />
          <p className="mt-4 text-sm text-[var(--color-muted)]">Status: {STATUS_LABEL[order.status]}</p>
        </section>
      </div>
      <div className="mt-10 flex flex-wrap gap-3">
        <a href={`/account/orders/${order.number}`} className="btn btn-primary">
          Track this order
        </a>
        <a href="/shop" className="btn btn-secondary">
          Continue shopping
        </a>
      </div>
    </div>
  );
}
