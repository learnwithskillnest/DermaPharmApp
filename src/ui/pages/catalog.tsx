import type { ReactNode } from 'react';
import type { CategoryRow, ProductCard, ProductDetail, SortKey } from '../../server/services/catalog.ts';
import { SORTS } from '../../server/services/catalog.ts';
import { paiseToRupeesInput, formatINR } from '../../shared/money.ts';
import { Breadcrumbs, EmptyState, MedicalNote, Pagination } from '../layout.tsx';
import { ProductGrid, FormulaLabel, ClassBadge } from '../product.tsx';
import { Island } from '../island.tsx';
import { ActionButton } from '../forms.tsx';
import { useUi } from '../context.tsx';

export interface ListingState {
  q?: string;
  categories: string[];
  brands: string[];
  min?: number;
  max?: number;
  inStock: boolean;
  sort: SortKey;
  page: number;
}

export interface ListingProps {
  title: string;
  intro?: ReactNode;
  crumbs: Array<{ href?: string; label: string }>;
  basePath: string;
  state: ListingState;
  result: { items: ProductCard[]; total: number; page: number; pages: number };
  facets: { brands: Array<{ slug: string; name: string; count: number }>; minPaise: number; maxPaise: number };
  categoryOptions: CategoryRow[];
  lockedCategory?: boolean;
  notice?: ReactNode;
  emptyHint?: ReactNode;
  suggestions?: ProductCard[];
  extraSections?: ReactNode;
}

export function listingHref(base: string, s: ListingState, patch: Partial<ListingState> = {}) {
  const n = { ...s, ...patch };
  const u = new URLSearchParams();
  if (n.q) u.set('q', n.q);
  for (const c of n.categories) u.append('category', c);
  for (const b of n.brands) u.append('brand', b);
  if (n.min !== undefined) u.set('min', paiseToRupeesInput(n.min));
  if (n.max !== undefined) u.set('max', paiseToRupeesInput(n.max));
  if (n.inStock) u.set('instock', '1');
  if (n.sort && n.sort !== (n.q ? 'relevance' : 'newest')) u.set('sort', n.sort);
  if (n.page > 1) u.set('page', String(n.page));
  const qs = u.toString();
  return qs ? `${base}?${qs}` : base;
}

function Filters({ p, idp }: { p: ListingProps; idp: string }) {
  const s = p.state;
  return (
    <form method="get" action={p.basePath} className="grid gap-7" aria-label="Filter products">
      {s.q ? <input type="hidden" name="q" value={s.q} /> : null}
      <input type="hidden" name="sort" value={s.sort} />
      {!p.lockedCategory && p.categoryOptions.length > 1 ? (
        <fieldset>
          <legend className="label mb-2">Category</legend>
          <div className="grid gap-2">
            {p.categoryOptions.map((c) => (
              <label key={c.slug} className="check">
                <input type="checkbox" name="category" value={c.slug} defaultChecked={s.categories.includes(c.slug)} />
                <span>{c.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {p.facets.brands.length ? (
        <fieldset>
          <legend className="label mb-2">Brand</legend>
          <div className="grid gap-2">
            {p.facets.brands.map((b) => (
              <label key={b.slug} className="check">
                <input type="checkbox" name="brand" value={b.slug} defaultChecked={s.brands.includes(b.slug)} />
                <span>
                  {b.name} <span className="tabular text-[var(--color-muted)]">({b.count})</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <fieldset>
        <legend className="label mb-2">Price (₹)</legend>
        <div className="grid grid-cols-2 gap-2">
          <div className="field">
            <label htmlFor={`${idp}-min`} className="hint">
              Min
            </label>
            <input
              id={`${idp}-min`}
              className="input"
              name="min"
              inputMode="numeric"
              defaultValue={s.min !== undefined ? paiseToRupeesInput(s.min) : ''}
              placeholder={paiseToRupeesInput(p.facets.minPaise || 0)}
            />
          </div>
          <div className="field">
            <label htmlFor={`${idp}-max`} className="hint">
              Max
            </label>
            <input
              id={`${idp}-max`}
              className="input"
              name="max"
              inputMode="numeric"
              defaultValue={s.max !== undefined ? paiseToRupeesInput(s.max) : ''}
              placeholder={paiseToRupeesInput(p.facets.maxPaise || 0)}
            />
          </div>
        </div>
      </fieldset>
      <label className="check">
        <input type="checkbox" name="instock" value="1" defaultChecked={s.inStock} />
        <span>In stock only</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary btn-sm">
          Apply filters
        </button>
        <a
          href={listingHref(p.basePath, { ...s, categories: p.lockedCategory ? s.categories : [], brands: [], min: undefined, max: undefined, inStock: false, page: 1 })}
          className="btn btn-quiet btn-sm"
        >
          Clear
        </a>
      </div>
    </form>
  );
}

export function ListingPage(p: ListingProps) {
  const s = p.state;
  const activeFilters = s.brands.length + (p.lockedCategory ? 0 : s.categories.length) + (s.min !== undefined ? 1 : 0) + (s.max !== undefined ? 1 : 0) + (s.inStock ? 1 : 0);
  return (
    <div className="wrap py-8 md:py-10">
      <Breadcrumbs items={p.crumbs} />
      <div className="mt-4 mb-8 grid gap-3">
        <h1 className="text-3xl md:text-[2.5rem]">{p.title}</h1>
        {p.intro ? <div className="max-w-2xl text-[var(--color-muted)]">{p.intro}</div> : null}
      </div>
      {p.notice ? <div className="mb-8">{p.notice}</div> : null}
      <div className="grid gap-8 lg:grid-cols-[15rem_1fr] lg:gap-12">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <details className="disclosure rounded-xl border border-[var(--color-line)] p-4 lg:hidden">
            <summary className="flex items-center justify-between font-semibold">
              Filters{activeFilters ? ` (${activeFilters})` : ''}
              <span aria-hidden="true">+</span>
            </summary>
            <div className="mt-5">
              <Filters p={p} idp="fm" />
            </div>
          </details>
          <div className="hidden lg:block">
            <Filters p={p} idp="fd" />
          </div>
        </aside>
        <div className="min-w-0">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <p className="tabular text-sm text-[var(--color-muted)]" role="status">
              {p.result.total} {p.result.total === 1 ? 'product' : 'products'}
              {s.q ? ` for “${s.q}”` : ''}
            </p>
            <form method="get" action={p.basePath} className="flex items-center gap-2">
              {s.q ? <input type="hidden" name="q" value={s.q} /> : null}
              {s.categories.map((c) => (
                <input key={c} type="hidden" name="category" value={c} />
              ))}
              {s.brands.map((b) => (
                <input key={b} type="hidden" name="brand" value={b} />
              ))}
              {s.min !== undefined ? <input type="hidden" name="min" value={paiseToRupeesInput(s.min)} /> : null}
              {s.max !== undefined ? <input type="hidden" name="max" value={paiseToRupeesInput(s.max)} /> : null}
              {s.inStock ? <input type="hidden" name="instock" value="1" /> : null}
              <label htmlFor="sort" className="text-sm text-[var(--color-muted)]">
                Sort by
              </label>
              <select id="sort" name="sort" className="select min-h-10 w-auto py-1.5 text-sm" defaultValue={s.sort} data-autosubmit>
                {(Object.keys(SORTS) as SortKey[])
                  .filter((k) => k !== 'relevance' || s.q)
                  .map((k) => (
                    <option key={k} value={k}>
                      {SORTS[k]}
                    </option>
                  ))}
              </select>
              <noscript>
                <button className="btn btn-secondary btn-sm" type="submit">
                  Sort
                </button>
              </noscript>
            </form>
          </div>
          {p.result.items.length ? (
            <>
              <h2 className="sr-only">Products</h2>
              <ProductGrid items={p.result.items} cols={3} />
              <Pagination page={p.result.page} pages={p.result.pages} hrefFor={(n) => listingHref(p.basePath, s, { page: n })} />
            </>
          ) : (
            <>
              <EmptyState title={s.q ? `No products match “${s.q}”` : 'No products match these filters'}>
                {p.emptyHint ?? (
                  <>
                    Try a broader term such as “cleanser” or an ingredient like “niacinamide”, or{' '}
                    <a className="link" href={p.basePath}>
                      clear the filters
                    </a>
                    .
                  </>
                )}
              </EmptyState>
              {p.suggestions?.length ? (
                <section aria-labelledby="sugg" className="mt-12">
                  <h2 id="sugg" className="mb-6 text-xl">
                    You might be looking for
                  </h2>
                  <ProductGrid items={p.suggestions} cols={3} />
                </section>
              ) : null}
            </>
          )}
          {p.extraSections}
        </div>
      </div>
    </div>
  );
}

function DetailBlock({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="border-t border-[var(--color-line)] py-6">
      <h2 id={id} className="mb-3 text-lg">
        {title}
      </h2>
      <div className="max-w-[68ch] text-[0.975rem] whitespace-pre-line">{children}</div>
    </section>
  );
}

export interface ProductPageProps {
  p: ProductDetail;
  related: ProductCard[];
  recent: ProductCard[];
  blockedReason: string | null;
  rxOrderingEnabled: boolean;
  inWishlist: boolean;
  delivery: { freeThresholdPaise: number; dispatchTime: string; deliveryEstimate: string };
}

const CLASS_LABEL: Record<string, string> = {
  cosmetic: 'Cosmetic',
  personal_care: 'Personal care',
  otc_pharmacy: 'Non-prescription pharmacy product',
  prescription: 'Prescription medicine',
};

export function ProductPage({ p, related, recent, blockedReason, rxOrderingEnabled, inWishlist, delivery }: ProductPageProps) {
  const { csrf, user } = useUi();
  const dept = {
    skincare: ['/skincare', 'Skincare'],
    cosmetology: ['/cosmetology', 'Cosmetology'],
    'body-hair': ['/body-hair', 'Body & hair'],
    pharmacy: ['/pharmacy', 'Pharmacy'],
  }[p.category_department] ?? ['/shop', 'Shop'];
  const defaultVariant = p.variants.find((v) => v.is_default && v.stock > 0) ?? p.variants.find((v) => v.stock > 0) ?? p.variants[0];
  return (
    <div className="wrap py-8 md:py-10">
      <Breadcrumbs items={[{ href: '/', label: 'Home' }, { href: dept[0], label: dept[1] }, { href: `/c/${p.category_slug}`, label: p.category_name }, { label: p.name }]} />
      <div className="mt-6 grid gap-10 md:grid-cols-2 md:gap-14">
        <Island name="ProductGallery" props={{ images: p.images, name: p.name }} />
        <div className="grid content-start gap-5">
          <div className="grid gap-2">
            <a href={`/shop?brand=${p.brand_slug}`} className="text-sm font-semibold text-[var(--color-forest-600)] hover:underline">
              {p.brand_name}
            </a>
            <h1 className="text-[1.9rem] leading-tight md:text-[2.4rem]">{p.name}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <FormulaLabel active={p.key_active} strength={p.key_active_strength} />
              <ClassBadge classification={p.classification} requiresPrescription={p.requires_prescription} />
              {p.is_sample ? <span className="pill pill-sample">Sample product for demonstration</span> : null}
            </div>
          </div>
          <p className="text-lg text-[var(--color-muted)]">{p.short_description}</p>
          {p.requires_prescription ? (
            <div className="notice notice-warning grid gap-2" role="note">
              <p className="font-semibold">Prescription required</p>
              {rxOrderingEnabled ? (
                <p>
                  Upload a valid prescription from a registered medical practitioner. Our registered pharmacist verifies it before the order is dispatched.{' '}
                  <a className="link" href="/account/prescriptions">
                    Upload a prescription
                  </a>
                </p>
              ) : (
                <p>
                  Online ordering of prescription medicines is not available at the moment. This page is for information only. Please consult your doctor and buy from a licensed
                  pharmacy.
                </p>
              )}
            </div>
          ) : null}
          <Island
            name="AddToCart"
            props={{
              csrf,
              productName: p.name,
              variants: p.variants.map((v) => ({ id: v.id, name: v.name, price: v.price_paise, mrp: v.mrp_paise, stock: v.stock })),
              initialVariantId: defaultVariant?.id ?? '',
              blockedReason,
              maxQty: 10,
            }}
          />
          <div className="flex flex-wrap gap-2">
            {user ? (
              <ActionButton
                action={`/wishlist/${p.id}/toggle`}
                fields={{ next: `/p/${p.slug}` }}
                label={inWishlist ? 'Saved to wishlist — remove' : 'Save to wishlist'}
                className="btn btn-secondary btn-sm"
              />
            ) : (
              <a href={`/login?next=/p/${p.slug}`} className="btn btn-secondary btn-sm">
                Sign in to save to wishlist
              </a>
            )}
          </div>
          <ul className="grid gap-1.5 rounded-xl bg-[var(--color-mint-50)] p-4 text-sm">
            <li>Free delivery on orders over {formatINR(delivery.freeThresholdPaise)}.</li>
            <li>
              Dispatched in {delivery.dispatchTime}; delivered in {delivery.deliveryEstimate}.
            </li>
            {p.nearest_expiry ? (
              <li>Units we ship have an expiry date of {new Date(p.nearest_expiry).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })} or later.</li>
            ) : null}
            <li>
              <a className="link" href="/policies/returns">
                Returns & refunds policy
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_20rem]">
        <div>
          <DetailBlock title="About this product" id="about">
            {p.description}
          </DetailBlock>
          {p.ingredients ? (
            <DetailBlock title="Full ingredient list" id="ingredients">
              <p className="text-sm leading-relaxed">{p.ingredients}</p>
            </DetailBlock>
          ) : null}
          {p.usage_instructions ? (
            <DetailBlock title="How to use" id="usage">
              {p.usage_instructions}
            </DetailBlock>
          ) : null}
          {p.warnings ? (
            <DetailBlock title="Warnings" id="warnings">
              {p.warnings}
            </DetailBlock>
          ) : null}
          {p.storage ? (
            <DetailBlock title="Storage" id="storage">
              {p.storage}
            </DetailBlock>
          ) : null}
          <div className="border-t border-[var(--color-line)] pt-6">
            <MedicalNote />
          </div>
        </div>
        <aside aria-labelledby="facts" className="self-start rounded-2xl border border-[var(--color-line)] p-5 text-sm">
          <h2 id="facts" className="mb-3 text-base">
            Product facts
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-[var(--color-muted)]">Type</dt>
            <dd>
              {CLASS_LABEL[p.classification]}
              {!p.classification_verified ? <span className="block text-xs text-[var(--color-warning)]">Classification pending regulatory review</span> : null}
            </dd>
            {p.skin_types.length ? (
              <>
                <dt className="text-[var(--color-muted)]">Skin types</dt>
                <dd>{p.skin_types.join(', ')}</dd>
              </>
            ) : null}
            <dt className="text-[var(--color-muted)]">Manufacturer</dt>
            <dd>
              {p.manufacturer_name ?? '—'}
              {p.manufacturer_address ? <span className="block text-xs text-[var(--color-muted)]">{p.manufacturer_address}</span> : null}
            </dd>
            {p.marketed_by ? (
              <>
                <dt className="text-[var(--color-muted)]">Marketed by</dt>
                <dd>{p.marketed_by}</dd>
              </>
            ) : null}
            <dt className="text-[var(--color-muted)]">Country of origin</dt>
            <dd>{p.country_of_origin ?? '—'}</dd>
            <dt className="text-[var(--color-muted)]">SKU</dt>
            <dd className="tabular">{p.variants.map((v) => v.sku).join(', ')}</dd>
          </dl>
        </aside>
      </div>

      {related.length ? (
        <section aria-labelledby="related" className="mt-16">
          <h2 id="related" className="mb-8 text-2xl">
            Related products
          </h2>
          <ProductGrid items={related} />
        </section>
      ) : null}
      {recent.length ? (
        <section aria-labelledby="recent" className="mt-16">
          <h2 id="recent" className="mb-8 text-2xl">
            Recently viewed
          </h2>
          <ProductGrid items={recent.slice(0, 4)} />
        </section>
      ) : null}
    </div>
  );
}
