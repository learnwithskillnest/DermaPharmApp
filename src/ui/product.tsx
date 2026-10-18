import type { ProductCard as Card } from '../server/services/catalog.ts';
import { formatINR, percentOff } from '../shared/money.ts';
import { ActionButton } from './forms.tsx';

export function FormulaLabel({ active, strength }: { active: string | null; strength: string | null }) {
  if (!active) return null;
  return (
    <span className="formula" title="Key active ingredient">
      {strength ? <b>{strength}</b> : null}
      <span>{active}</span>
    </span>
  );
}

export function ClassBadge({ classification, requiresPrescription }: { classification: string; requiresPrescription: boolean }) {
  if (requiresPrescription) return <span className="pill pill-rx">Prescription required</span>;
  if (classification === 'otc_pharmacy') return <span className="pill">Pharmacy</span>;
  return null;
}

export function Price({ price, mrp, size = 'md' }: { price: number | null; mrp: number | null; size?: 'md' | 'lg' }) {
  if (price === null) return <span className="text-sm text-[var(--color-muted)]">Unavailable</span>;
  const off = mrp ? percentOff(mrp, price) : 0;
  return (
    <span className="tabular flex flex-wrap items-baseline gap-x-2">
      <span className={size === 'lg' ? 'text-2xl font-semibold' : 'font-semibold text-[var(--color-forest-900)]'}>{formatINR(price)}</span>
      {off > 0 && mrp ? (
        <>
          <span className="text-sm text-[var(--color-muted)] line-through">
            <span className="sr-only">MRP </span>
            {formatINR(mrp)}
          </span>
          <span className="text-sm font-semibold text-[var(--color-forest-600)]">{off}% off</span>
        </>
      ) : null}
    </span>
  );
}

export function ProductTile({ p, wishlisted, showWishlist }: { p: Card; wishlisted?: boolean; showWishlist?: boolean }) {
  const img = p.images[0];
  return (
    <article className="group relative flex flex-col gap-3" aria-labelledby={`pt-${p.id}`}>
      <a href={`/p/${p.slug}`} className="art block" tabIndex={-1} aria-hidden="true">
        <img
          src={img?.url ?? '/images/placeholder.svg'}
          alt=""
          width={400}
          height={500}
          loading="lazy"
          decoding="async"
          className="transition-transform duration-500 group-hover:scale-[1.02]"
        />
      </a>
      <div className="flex flex-wrap gap-1.5">
        <FormulaLabel active={p.key_active} strength={p.key_active_strength} />
        <ClassBadge classification={p.classification} requiresPrescription={p.requires_prescription} />
      </div>
      <div className="grid gap-1">
        <p className="text-xs font-semibold text-[var(--color-muted)]">{p.brand_name}</p>
        <h3 id={`pt-${p.id}`} className="text-[1rem] leading-snug font-semibold">
          <a href={`/p/${p.slug}`} className="after:absolute after:inset-0 after:content-[''] hover:underline">
            {p.name}
          </a>
        </h3>
        <p className="text-sm text-[var(--color-muted)]">
          {p.variant_name}
          {p.variant_count > 1 ? ` + ${p.variant_count - 1} more size${p.variant_count > 2 ? 's' : ''}` : ''}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <Price price={p.price_paise} mrp={p.mrp_paise} />
        {p.total_stock <= 0 ? <span className="pill pill-muted">Out of stock</span> : null}
      </div>
      {showWishlist ? (
        <div className="relative z-10">
          <ActionButton
            action={`/wishlist/${p.id}/toggle`}
            label={wishlisted ? 'Saved — remove' : 'Save for later'}
            className="btn btn-quiet btn-sm -ml-3"
            fields={{ next: `/p/${p.slug}` }}
            ariaLabel={wishlisted ? `Remove ${p.name} from wishlist` : `Save ${p.name} to wishlist`}
          />
        </div>
      ) : null}
    </article>
  );
}

export function ProductGrid({ items, wishlist, cols = 4 }: { items: Card[]; wishlist?: Set<string>; cols?: 3 | 4 }) {
  return (
    <ul className={`grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 ${cols === 4 ? 'md:grid-cols-3 lg:grid-cols-4' : 'md:grid-cols-3'}`}>
      {items.map((p) => (
        <li key={p.id} className="flex">
          <ProductTile p={p} wishlisted={wishlist?.has(p.id)} />
        </li>
      ))}
    </ul>
  );
}
