import type { CartView } from '../../server/services/cart.ts';
import type { Quote } from '../../server/services/pricing.ts';
import { formatINR } from '../../shared/money.ts';
import { Breadcrumbs, EmptyState } from '../layout.tsx';
import { ActionButton, Form, type Errors } from '../forms.tsx';
import { ProductGrid } from '../product.tsx';
import type { ProductCard } from '../../server/services/catalog.ts';

export function Summary({ q, title = 'Order summary', showCod }: { q: Quote; title?: string; showCod?: boolean }) {
  const savings = q.mrpTotalPaise - q.subtotalPaise + q.discountPaise;
  const row = (label: string, value: string, opts: { strong?: boolean; testid?: string } = {}) => (
    <div className={`flex justify-between gap-4 ${opts.strong ? 'border-t border-[var(--color-line)] pt-3 text-lg font-semibold text-[var(--color-forest-900)]' : ''}`}>
      <dt>{label}</dt>
      <dd className="tabular" data-testid={opts.testid}>
        {value}
      </dd>
    </div>
  );
  return (
    <section aria-labelledby="summary-title" className="rounded-2xl bg-[var(--color-mint-50)] p-5 md:p-6">
      <h2 id="summary-title" className="mb-4 text-lg">
        {title}
      </h2>
      <dl className="grid gap-2.5 text-[0.95rem]">
        {row(`Items (${q.itemCount})`, formatINR(q.subtotalPaise), { testid: 'subtotal' })}
        {q.discountPaise ? row(`Coupon ${q.coupon?.code ?? ''}`, '−' + formatINR(q.discountPaise), { testid: 'discount' }) : null}
        {row('Delivery', q.shippingPaise ? formatINR(q.shippingPaise) : 'Free', { testid: 'shipping' })}
        {q.codFeePaise || showCod ? row('Cash on delivery fee', formatINR(q.codFeePaise), { testid: 'codfee' }) : null}
        {row('Total', formatINR(q.totalPaise), { strong: true, testid: 'total' })}
      </dl>
      <p className="mt-3 text-xs text-[var(--color-muted)]">Includes GST of {formatINR(q.taxPaise)}.</p>
      {savings > 0 ? <p className="mt-1 text-sm font-semibold text-[var(--color-forest-600)]">You save {formatINR(savings)} on MRP.</p> : null}
    </section>
  );
}

export function CartPage({ cart, couponErrors, suggestions, freeShippingPaise }: { cart: CartView; couponErrors?: Errors; suggestions: ProductCard[]; freeShippingPaise: number }) {
  const q = cart.quote;
  if (!cart.lines.length) {
    return (
      <div className="wrap py-10">
        <h1 className="mb-8 text-3xl">Your cart</h1>
        <EmptyState title="Your cart is empty" action={{ href: '/shop', label: 'Browse products' }}>
          Saved items live in your wishlist.
        </EmptyState>
        {suggestions.length ? (
          <section className="mt-16" aria-labelledby="pop">
            <h2 id="pop" className="mb-8 text-2xl">
              Featured products
            </h2>
            <ProductGrid items={suggestions} />
          </section>
        ) : null}
      </div>
    );
  }
  const toFree = freeShippingPaise - (q.subtotalPaise - q.discountPaise);
  return (
    <div className="wrap py-8 md:py-10">
      <Breadcrumbs items={[{ href: '/', label: 'Home' }, { label: 'Cart' }]} />
      <h1 className="mt-4 mb-8 text-3xl">Your cart</h1>
      {cart.issues.length ? (
        <div className="notice notice-error mb-6" role="alert">
          <p className="font-semibold">Some items need your attention before checkout:</p>
          <ul className="mt-1 list-disc pl-5">
            {cart.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
        <div>
          <ul className="divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]" aria-label="Items in your cart">
            {cart.lines.map((l) => (
              <li key={l.variantId} className="grid grid-cols-[5rem_1fr] gap-4 py-5 sm:grid-cols-[6rem_1fr_auto]" data-testid="cart-line">
                <a href={`/p/${l.productSlug}`} className="art block" aria-hidden="true" tabIndex={-1}>
                  <img src={l.image?.url ?? '/images/placeholder.svg'} alt="" width={96} height={120} loading="lazy" />
                </a>
                <div className="grid content-start gap-1">
                  <p className="text-xs font-semibold text-[var(--color-muted)]">{l.brandName}</p>
                  <a href={`/p/${l.productSlug}`} className="font-semibold text-[var(--color-forest-900)] hover:underline">
                    {l.productName}
                  </a>
                  <p className="text-sm text-[var(--color-muted)]">
                    {l.variantName}, {formatINR(l.unitPricePaise)} each
                  </p>
                  {l.requiresPrescription ? <span className="pill pill-rx w-fit">Prescription required</span> : null}
                  {l.issue ? <p className="error-text">{l.issue}</p> : null}
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Form action="/cart/update" className="flex items-end gap-2" ariaLabel={`Quantity for ${l.productName}`}>
                      <input type="hidden" name="variantId" value={l.variantId} />
                      <div className="field">
                        <label className="hint" htmlFor={`q-${l.variantId}`}>
                          Qty
                        </label>
                        <input
                          id={`q-${l.variantId}`}
                          className="input tabular min-h-9 w-20 py-1"
                          type="number"
                          name="quantity"
                          min={0}
                          max={20}
                          defaultValue={l.quantity}
                          inputMode="numeric"
                        />
                      </div>
                      <button type="submit" className="btn btn-secondary btn-sm">
                        Update
                      </button>
                    </Form>
                    <ActionButton action="/cart/remove" fields={{ variantId: l.variantId }} label="Remove" ariaLabel={`Remove ${l.productName} from cart`} />
                  </div>
                </div>
                <p className="tabular col-start-2 font-semibold text-[var(--color-forest-900)] sm:col-start-3 sm:text-right">{formatINR(l.unitPricePaise * l.quantity)}</p>
              </li>
            ))}
          </ul>
          <a href="/shop" className="link mt-6 inline-block text-sm font-semibold">
            Continue shopping
          </a>
        </div>
        <div className="grid content-start gap-5">
          {toFree > 0 ? <p className="notice text-sm">Add {formatINR(toFree)} more for free delivery.</p> : null}
          <Summary q={q} />
          <div className="rounded-2xl border border-[var(--color-line)] p-5">
            {q.coupon?.applied ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm">
                  Coupon <strong>{q.coupon.code}</strong> applied.
                </p>
                <ActionButton action="/cart/coupon/remove" label="Remove" />
              </div>
            ) : (
              <Form action="/cart/coupon" className="grid gap-2" ariaLabel="Apply a coupon">
                <label className="label" htmlFor="f-code">
                  Coupon code
                </label>
                <div className="flex gap-2">
                  <input
                    id="f-code"
                    name="code"
                    className="input uppercase"
                    defaultValue={q.coupon?.code ?? ''}
                    aria-invalid={couponErrors?.code || q.coupon?.message ? 'true' : undefined}
                    aria-describedby="code-error"
                    maxLength={30}
                    autoComplete="off"
                  />
                  <button type="submit" className="btn btn-secondary">
                    Apply
                  </button>
                </div>
                {couponErrors?.code || q.coupon?.message ? (
                  <p className="error-text" id="code-error">
                    {couponErrors?.code ?? q.coupon?.message}
                  </p>
                ) : null}
              </Form>
            )}
          </div>
          {cart.canCheckout ? (
            <a href="/checkout" className="btn btn-primary btn-block">
              Proceed to checkout
            </a>
          ) : (
            <button type="button" className="btn btn-primary btn-block" disabled aria-describedby="checkout-blocked">
              Proceed to checkout
            </button>
          )}
          {!cart.canCheckout ? (
            <p id="checkout-blocked" className="text-sm text-[var(--color-muted)]">
              Resolve the items marked above to continue.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
