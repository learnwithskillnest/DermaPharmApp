import type { CategoryRow, ProductCard } from '../../server/services/catalog.ts';
import { formatINR } from '../../shared/money.ts';
import { ProductGrid } from '../product.tsx';

interface Props {
  actives: Array<{ key_active: string; key_active_strength: string | null; count: number }>;
  featured: ProductCard[];
  newest: ProductCard[];
  recent: ProductCard[];
  categories: CategoryRow[];
  offers: Array<{ code: string; description: string; kind: string; value: number; min_subtotal_paise: number }>;
  freeShippingPaise: number;
}

const DEPARTMENTS: Array<{ key: string; href: string; title: string; blurb: string }> = [
  { key: 'skincare', href: '/skincare', title: 'Skincare', blurb: 'Cleansers, sunscreen, moisturisers and targeted actives.' },
  { key: 'cosmetology', href: '/cosmetology', title: 'Cosmetology', blurb: 'Serums and cosmetic treatments for texture and tone.' },
  { key: 'body-hair', href: '/body-hair', title: 'Body & hair', blurb: 'Everyday care for scalp, hair and body.' },
  { key: 'pharmacy', href: '/pharmacy', title: 'Pharmacy', blurb: 'Over-the-counter essentials, sold under pharmacy rules.' },
];

function Section({ id, title, link, children }: { id: string; title: string; link?: { href: string; label: string }; children: unknown }) {
  return (
    <section aria-labelledby={id} className="wrap mt-20">
      <div className="mb-8 flex items-end justify-between gap-4">
        <h2 id={id} className="text-2xl md:text-[1.75rem]">
          {title}
        </h2>
        {link ? (
          <a href={link.href} className="link text-sm font-semibold">
            {link.label}
          </a>
        ) : null}
      </div>
      {children as never}
    </section>
  );
}

export function HomePage({ actives, featured, newest, recent, categories, offers, freeShippingPaise }: Props) {
  return (
    <>
      <section className="wrap grid items-center gap-10 pt-10 md:grid-cols-[1.05fr_1fr] md:gap-16 md:pt-16">
        <div className="reveal">
          <h1 className="text-[2.6rem] leading-[1.02] font-[680] tracking-[-0.035em] md:text-[4rem]">Know what’s in the bottle.</h1>
          <p className="mt-5 max-w-[34rem] text-lg text-[var(--color-muted)]">
            Skincare, cosmetology and pharmacy essentials with the complete ingredient list, the strength of every key active, and plain directions on each page.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="/skincare" className="btn btn-primary">
              Shop skincare
            </a>
            <a href="/pharmacy" className="btn btn-secondary">
              Browse pharmacy
            </a>
          </div>
          <p className="mt-6 text-sm text-[var(--color-muted)]">Free delivery on orders over {formatINR(freeShippingPaise)}. Prices include GST.</p>
        </div>
        <div className="rounded-[1.75rem] bg-[var(--color-mint-50)] px-6 py-6 md:px-8 md:py-8">
          <h2 className="text-sm font-semibold text-[var(--color-forest-700)]">Shop by active ingredient</h2>
          <ul className="active-index mt-2">
            {actives.map((a, i) => (
              <li key={a.key_active} className="reveal" style={{ animationDelay: `${120 + i * 60}ms` }}>
                <a href={`/shop?q=${encodeURIComponent(a.key_active)}`}>
                  <span className="active-strength">{a.key_active_strength ?? '—'}</span>
                  <span className="active-name">{a.key_active}</span>
                  <span className="tabular text-sm text-[var(--color-muted)]">
                    {a.count} {a.count === 1 ? 'product' : 'products'}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="departments" className="wrap mt-20">
        <h2 id="departments" className="sr-only">
          Departments
        </h2>
        <div className="grid gap-8 border-y border-[var(--color-line)] py-10 sm:grid-cols-2 lg:grid-cols-4">
          {DEPARTMENTS.map((d) => (
            <div key={d.key} className="grid content-start gap-3">
              <a href={d.href} className="text-xl font-semibold text-[var(--color-forest-900)] hover:underline">
                {d.title}
              </a>
              <p className="text-sm text-[var(--color-muted)]">{d.blurb}</p>
              <ul className="grid gap-1.5 text-sm">
                {categories
                  .filter((c) => c.department === d.key)
                  .map((c) => (
                    <li key={c.slug}>
                      <a href={`/c/${c.slug}`} className="text-[var(--color-forest-700)] hover:underline">
                        {c.name}
                      </a>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {offers.length ? (
        <section aria-labelledby="offers" className="wrap mt-16">
          <h2 id="offers" className="sr-only">
            Current offers
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {offers.map((o) => (
              <li key={o.code} className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--color-champagne-400)] px-5 py-4">
                <div>
                  <p className="font-semibold text-[var(--color-forest-900)]">{o.description}</p>
                  <p className="text-sm text-[var(--color-muted)]">
                    {o.min_subtotal_paise ? `On eligible orders over ${formatINR(o.min_subtotal_paise)}. ` : ''}Excludes pharmacy products.
                  </p>
                </div>
                <span className="tabular rounded-lg bg-[var(--color-mint-100)] px-3 py-1.5 font-semibold tracking-wide text-[var(--color-forest-900)]">{o.code}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {featured.length ? (
        <Section id="featured" title="Featured" link={{ href: '/shop', label: 'Shop all products' }}>
          <ProductGrid items={featured} />
        </Section>
      ) : null}

      <section
        aria-labelledby="routine"
        className="wrap mt-24 grid gap-10 rounded-[1.75rem] bg-[var(--color-forest-900)] px-6 py-12 text-[var(--color-mint-100)] md:grid-cols-[1fr_1.4fr] md:px-12"
      >
        <div>
          <h2 id="routine" className="text-2xl text-white md:text-3xl">
            A morning routine, in order
          </h2>
          <p className="mt-3 max-w-sm text-[var(--color-mint-200)]">Layer thinnest to thickest so each step can do its job. One new active at a time; patch-test first.</p>
          <a href="/product-safety" className="mt-6 inline-block font-semibold text-white underline underline-offset-4">
            Read our product safety guide
          </a>
        </div>
        <ol className="grid gap-5 sm:grid-cols-2">
          {[
            ['Cleanse', 'A gentle face wash removes oil and sweat without stripping the skin barrier.', '/c/face-wash-cleansers'],
            ['Treat', 'Serums with a targeted active, such as vitamin C or niacinamide.', '/c/serums-treatments'],
            ['Moisturise', 'Ceramides and humectants help keep the barrier comfortable.', '/c/moisturizers'],
            ['Protect', 'Broad-spectrum SPF 30 or higher, reapplied every two hours outdoors.', '/c/sunscreen'],
          ].map(([t, d, href], i) => (
            <li key={t} className="grid grid-cols-[2.25rem_1fr] gap-3">
              <span className="tabular grid size-9 place-items-center rounded-full border border-[var(--color-champagne-400)] text-sm font-semibold text-[var(--color-champagne-200)]">
                {i + 1}
              </span>
              <div>
                <a href={href} className="font-semibold text-white hover:underline">
                  {t}
                </a>
                <p className="mt-1 text-sm text-[var(--color-mint-200)]">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {newest.length ? (
        <Section id="new" title="New arrivals" link={{ href: '/shop?sort=newest', label: 'See everything new' }}>
          <ProductGrid items={newest} />
        </Section>
      ) : null}

      {recent.length ? (
        <Section id="recent" title="Recently viewed" link={{ href: '/recently-viewed', label: 'View all' }}>
          <ProductGrid items={recent.slice(0, 4)} />
        </Section>
      ) : null}
    </>
  );
}
