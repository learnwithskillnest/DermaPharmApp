import { useState } from 'react';
import { formatINR, percentOff } from '../../shared/money.ts';

export interface AddToCartProps {
  csrf: string;
  productName: string;
  variants: Array<{ id: string; name: string; price: number; mrp: number; stock: number }>;
  initialVariantId: string;
  blockedReason: string | null;
  maxQty: number;
}

/**
 * Pack-size picker + quantity + add button. Posts a normal form without JS;
 * with JS it uses the cart API and updates the header count in place.
 */
export function AddToCart({ csrf, productName, variants, initialVariantId, blockedReason, maxQty }: AddToCartProps) {
  const [variantId, setVariantId] = useState(initialVariantId);
  const [qty, setQty] = useState(1);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const v = variants.find((x) => x.id === variantId) ?? variants[0];
  const off = v ? percentOff(v.mrp, v.price) : 0;
  const limit = v ? Math.max(0, Math.min(maxQty, v.stock)) : 0;
  const disabled = !!blockedReason || !v || v.stock <= 0;

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (disabled || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ variantId, quantity: qty }),
      });
      const data = (await res.json()) as { error?: string; count?: number };
      if (!res.ok) {
        setStatus({ kind: 'error', text: data.error ?? 'Could not add to cart.' });
      } else {
        setStatus({ kind: 'ok', text: `Added ${qty} × ${productName} (${v.name}) to your cart.` });
        window.dispatchEvent(new CustomEvent('cart:updated', { detail: { count: data.count } }));
      }
    } catch {
      setStatus({ kind: 'error', text: 'You appear to be offline. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!v) return <p className="notice">This product is not available right now.</p>;

  return (
    <form method="post" action="/cart/add" onSubmit={submit} className="grid gap-5" aria-label={`Buy ${productName}`}>
      <input type="hidden" name="_csrf" value={csrf} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="tabular text-3xl font-semibold text-[var(--color-forest-900)]" data-testid="price">
          {formatINR(v.price)}
        </span>
        {off > 0 ? (
          <>
            <span className="tabular text-[var(--color-muted)] line-through" aria-label={`MRP ${formatINR(v.mrp)}`}>
              MRP {formatINR(v.mrp)}
            </span>
            <span className="pill">{off}% off MRP</span>
          </>
        ) : (
          <span className="text-sm text-[var(--color-muted)]">MRP (incl. of all taxes)</span>
        )}
      </div>
      {off > 0 ? <p className="-mt-3 text-xs text-[var(--color-muted)]">Price inclusive of all taxes.</p> : null}

      {variants.length > 1 ? (
        <fieldset>
          <legend className="label mb-2">Pack size</legend>
          <div className="flex flex-wrap gap-2">
            {variants.map((x) => (
              <label
                key={x.id}
                className={`cursor-pointer rounded-full border-[1.5px] px-4 py-2 text-sm font-semibold has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-[var(--color-forest-600)] ${x.id === variantId ? 'border-[var(--color-forest-900)] bg-[var(--color-mint-100)]' : 'border-[var(--color-line)]'} ${x.stock <= 0 ? 'opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name="variantId"
                  value={x.id}
                  className="sr-only"
                  checked={x.id === variantId}
                  onChange={() => {
                    setVariantId(x.id);
                    setQty(1);
                  }}
                />
                {x.name}
                {x.stock <= 0 ? ' — out of stock' : ''}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <>
          <input type="hidden" name="variantId" value={v.id} />
          <p className="text-sm text-[var(--color-muted)]">Pack size: {v.name}</p>
        </>
      )}

      {blockedReason ? (
        <div className="notice notice-warning" role="note">
          {blockedReason}
        </div>
      ) : v.stock <= 0 ? (
        <p className="font-semibold text-[var(--color-danger)]">Out of stock</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="field w-24">
            <label className="label" htmlFor="qty">
              Quantity
            </label>
            <select id="qty" name="quantity" className="select" value={String(qty)} onChange={(e: { target: { value: string } }) => setQty(Number(e.target.value))}>
              {Array.from({ length: limit }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary min-w-48 flex-1 sm:flex-none" disabled={busy}>
            {busy ? 'Adding…' : 'Add to cart'}
          </button>
          {v.stock <= 5 ? <p className="w-full text-sm text-[var(--color-warning)]">Only {v.stock} left in stock.</p> : null}
        </div>
      )}
      <div aria-live="polite" className="min-h-[1.5rem] text-sm">
        {status ? (
          <p className={status.kind === 'ok' ? 'text-[var(--color-success)]' : 'error-text'}>
            {status.text}{' '}
            {status.kind === 'ok' ? (
              <a href="/cart" className="link font-semibold">
                View cart
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    </form>
  );
}
