import type { ReactNode } from 'react';
import type { Flash } from '../server/http/context.ts';
import { Ui, useUi, type UiContext } from './context.tsx';
import { Island } from './island.tsx';
import { ActionButton } from './forms.tsx';

export interface PageMeta {
  title: string;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  jsonLd?: object[];
  ogImage?: string;
}

export interface ShellData {
  ui: UiContext;
  meta: PageMeta;
  appUrl: string;
  assets: { css: string; js: string };
  nonce: string;
  flash: Flash | null;
  cartCount: number;
  nav: Array<{ href: string; label: string }>;
  searchQuery?: string;
  analytics: { provider: string; id?: string } | null;
  footer: { storeName: string; legalName: string; supportHours: string };
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" aria-hidden="true" className={small ? 'size-7' : 'size-8'}>
        <circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--color-champagne-500)" strokeWidth="1.2" />
        <path d="M16 6.5c3.6 4.6 6.2 8.2 6.2 11.6a6.2 6.2 0 0 1-12.4 0c0-3.4 2.6-7 6.2-11.6z" fill="var(--color-forest-900)" />
        <path d="M13.2 18.6a3 3 0 0 0 2.8 2.6" stroke="var(--color-mint-200)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
      <span className={`font-semibold tracking-[-0.02em] text-[var(--color-forest-900)] ${small ? 'text-lg' : 'text-xl'}`}>
        GlowDerma<span className="font-normal text-[var(--color-forest-600)]"> Store</span>
      </span>
    </span>
  );
}

function Icon({ d, label }: { d: string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden={label ? undefined : 'true'} role={label ? 'img' : undefined} aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const ICON_USER = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0';
const ICON_HEART = 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z';
const ICON_BAG = 'M6 8h12l-1 12H7L6 8zm3 0V6a3 3 0 0 1 6 0v2';
const ICON_MENU = 'M4 7h16M4 12h16M4 17h16';

function Header({ data }: { data: ShellData }) {
  const { user, sandbox } = data.ui;
  const staff = user && user.role !== 'customer';
  return (
    <header className="border-b border-[var(--color-line)] bg-white">
      {sandbox ? (
        <div className="bg-[var(--color-forest-900)] text-[0.8rem] text-[var(--color-mint-100)]">
          <p className="wrap py-1.5 text-center">Demo store with sample products and sandbox payments. Nothing is charged or shipped.</p>
        </div>
      ) : null}
      <div className="wrap flex items-center gap-3 py-3 md:gap-6 md:py-4">
        <details className="disclosure md:hidden" id="mobile-nav">
          <summary className="btn btn-quiet -ml-3 px-2" aria-label="Open menu">
            <Icon d={ICON_MENU} />
          </summary>
          <nav aria-label="Mobile" className="fixed inset-x-0 top-0 bottom-0 z-50 overflow-y-auto bg-white p-5">
            <div className="mb-6 flex items-center justify-between">
              <Logo small />
              <a href={data.ui.path} className="btn btn-quiet" aria-label="Close menu">
                Close
              </a>
            </div>
            <ul className="grid gap-1 text-lg">
              {data.nav.map((n) => (
                <li key={n.href}>
                  <a className="block border-b border-[var(--color-line)] py-3 font-semibold text-[var(--color-forest-900)]" href={n.href}>
                    {n.label}
                  </a>
                </li>
              ))}
              <li>
                <a className="block border-b border-[var(--color-line)] py-3" href="/account/wishlist">
                  Wishlist
                </a>
              </li>
              <li>
                <a className="block border-b border-[var(--color-line)] py-3" href="/track">
                  Track an order
                </a>
              </li>
              <li>
                <a className="block py-3" href="/contact">
                  Help & contact
                </a>
              </li>
            </ul>
          </nav>
        </details>
        <a href="/" className="shrink-0" aria-label={`${data.footer.storeName} — home`}>
          <Logo />
        </a>
        <div className="hidden flex-1 md:block">
          <Island name="SearchBox" props={{ initial: data.searchQuery ?? '', idBase: 'search-d' }} />
        </div>
        <nav aria-label="Account" className="ml-auto flex items-center gap-0.5 md:ml-0">
          {staff ? (
            <a href="/admin" className="btn btn-quiet btn-sm hidden lg:inline-flex">
              Admin
            </a>
          ) : null}
          <a href={user ? '/account' : '/login'} className="btn btn-quiet px-2.5" aria-label={user ? 'Your account' : 'Sign in'}>
            <Icon d={ICON_USER} />
            <span className="hidden text-sm lg:inline">{user ? user.name.split(' ')[0] : 'Sign in'}</span>
          </a>
          <a href="/account/wishlist" className="btn btn-quiet hidden px-2.5 sm:inline-flex" aria-label="Wishlist">
            <Icon d={ICON_HEART} />
          </a>
          <a href="/cart" className="btn btn-quiet relative px-2.5" data-cart-label aria-label={`Cart, ${data.cartCount} item${data.cartCount === 1 ? '' : 's'}`}>
            <Icon d={ICON_BAG} />
            <span
              data-cart-count
              hidden={data.cartCount === 0}
              className="tabular absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-[var(--color-forest-900)] px-1 text-[0.7rem] leading-5 font-bold text-white"
            >
              {data.cartCount}
            </span>
          </a>
        </nav>
      </div>
      <div className="wrap pb-3 md:hidden">
        <Island name="SearchBox" props={{ initial: data.searchQuery ?? '', compact: true, idBase: 'search-m' }} />
      </div>
      <nav aria-label="Departments" className="hidden border-t border-[var(--color-line)] md:block">
        <ul className="wrap flex gap-1 py-1.5 text-[0.925rem]">
          {data.nav.map((n) => {
            const current = data.ui.path === n.href || (n.href !== '/' && data.ui.path.startsWith(n.href + '/'));
            return (
              <li key={n.href}>
                <a
                  href={n.href}
                  aria-current={current ? 'page' : undefined}
                  className={`inline-block rounded-full px-3 py-1.5 font-medium hover:bg-[var(--color-mint-100)] ${current ? 'bg-[var(--color-mint-100)] text-[var(--color-forest-900)]' : 'text-[var(--color-forest-800)]'}`}
                >
                  {n.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}

function Footer({ data }: { data: ShellData }) {
  const col = (title: string, links: Array<[string, string]>) => (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-forest-900)]">{title}</h2>
      <ul className="grid gap-2 text-sm">
        {links.map(([href, label]) => (
          <li key={href}>
            <a href={href} className="text-[var(--color-forest-800)] hover:underline">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <footer className="mt-20 border-t border-[var(--color-line)] bg-[var(--color-mint-50)]">
      <div className="wrap grid gap-10 py-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="grid content-start gap-4">
          <Logo small />
          <p className="max-w-sm text-sm text-[var(--color-muted)]">
            Skincare, cosmetology and pharmacy essentials with the full ingredient list on every page. Product information here is general and is not medical advice.
          </p>
          <p className="text-sm text-[var(--color-muted)]">Support: {data.footer.supportHours}</p>
        </div>
        {col('Shop', [
          ['/skincare', 'Skincare'],
          ['/cosmetology', 'Cosmetology'],
          ['/body-hair', 'Body & hair'],
          ['/pharmacy', 'Pharmacy'],
          ['/recently-viewed', 'Recently viewed'],
        ])}
        {col('Help', [
          ['/contact', 'Contact us'],
          ['/faq', 'FAQs'],
          ['/track', 'Track an order'],
          ['/policies/shipping', 'Shipping'],
          ['/policies/returns', 'Returns & refunds'],
        ])}
        {col('Policies', [
          ['/policies/privacy', 'Privacy'],
          ['/policies/terms', 'Terms of use'],
          ['/product-safety', 'Product safety'],
          ['/seller-information', 'Seller & licence details'],
          ['/seller-information#grievance', 'Grievance officer'],
        ])}
      </div>
      <div className="border-t border-[var(--color-line)]">
        <p className="wrap py-5 text-xs text-[var(--color-muted)]">
          © {new Date().getFullYear()} {data.footer.legalName}. Prices are in Indian rupees and include GST. Always read the label and consult a doctor or pharmacist for medical
          advice.
        </p>
      </div>
    </footer>
  );
}

export function FlashBanner({ flash }: { flash: Flash | null }) {
  if (!flash) return null;
  const cls = flash.kind === 'error' ? 'notice-error' : flash.kind === 'success' ? 'notice-success' : '';
  return (
    <div className="wrap mt-4">
      <div className={`notice ${cls}`} role={flash.kind === 'error' ? 'alert' : 'status'}>
        {flash.message}
      </div>
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ href?: string; label: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-[var(--color-muted)]">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden="true">/</span> : null}
            {it.href ? (
              <a href={it.href} className="hover:underline">
                {it.label}
              </a>
            ) : (
              <span aria-current="page" className="text-[var(--color-forest-900)]">
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Document({ data, children, bare }: { data: ShellData; children: ReactNode; bare?: boolean }) {
  const m = data.meta;
  const title = m.title.includes(data.footer.storeName) ? m.title : `${m.title} | ${data.footer.storeName}`;
  return (
    <html lang="en-IN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {m.description ? <meta name="description" content={m.description} /> : null}
        {m.canonical ? <link rel="canonical" href={data.appUrl + m.canonical} /> : null}
        {m.noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
        <meta name="theme-color" content="#163a2d" />
        <meta property="og:site_name" content={data.footer.storeName} />
        <meta property="og:title" content={m.title} />
        {m.description ? <meta property="og:description" content={m.description} /> : null}
        {m.canonical ? <meta property="og:url" content={data.appUrl + m.canonical} /> : null}
        <meta property="og:type" content="website" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300..800&display=swap" />
        {data.assets.css ? <link rel="stylesheet" href={`/assets/${data.assets.css}`} /> : null}
        {(m.jsonLd ?? []).map((j, i) => (
          <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(j).replace(/</g, '\\u003c') }} />
        ))}
      </head>
      <body>
        <Ui.Provider value={data.ui}>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          {bare ? null : <Header data={data} />}
          <FlashBanner flash={data.flash} />
          <main id="main" tabIndex={-1} className="outline-none">
            {children}
          </main>
          {bare ? null : <Footer data={data} />}
        </Ui.Provider>
        {data.assets.js ? <script type="module" src={`/assets/${data.assets.js}`} nonce={data.nonce} /> : null}
        {data.analytics ? <AnalyticsHook nonce={data.nonce} provider={data.analytics.provider} id={data.analytics.id} /> : null}
      </body>
    </html>
  );
}

/**
 * Analytics is OFF unless ANALYTICS_PROVIDER is configured. Even then this
 * only defines a dataLayer queue; loading a vendor script should happen
 * after cookie consent is implemented (see PROJECT_STATUS.md).
 */
function AnalyticsHook({ nonce, provider, id }: { nonce: string; provider: string; id?: string }) {
  const js = `window.dataLayer=window.dataLayer||[];window.gdTrack=function(e,p){window.dataLayer.push(Object.assign({event:e},p||{}))};window.gdAnalytics=${JSON.stringify({ provider, id: id ?? '' }).replace(/</g, '\\u003c')};`;
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: js }} />;
}

/** Account area sub-navigation. */
export function AccountNav({ current }: { current: string }) {
  const { user } = useUi();
  const items: Array<[string, string]> = [
    ['/account', 'Overview'],
    ['/account/orders', 'Orders'],
    ['/account/addresses', 'Addresses'],
    ['/account/wishlist', 'Wishlist'],
    ['/account/prescriptions', 'Prescriptions'],
    ['/account/settings', 'Profile & security'],
  ];
  return (
    <nav aria-label="Account" className="grid content-start gap-1">
      <p className="mb-2 text-sm text-[var(--color-muted)]">
        Signed in as <span className="font-semibold text-[var(--color-forest-900)]">{user?.email}</span>
      </p>
      <ul className="flex gap-1 overflow-x-auto md:grid">
        {items.map(([href, label]) => (
          <li key={href}>
            <a
              href={href}
              aria-current={current === href ? 'page' : undefined}
              className={`block rounded-lg px-3 py-2 text-sm whitespace-nowrap ${current === href ? 'bg-[var(--color-mint-100)] font-semibold text-[var(--color-forest-900)]' : 'hover:bg-[var(--color-mint-50)]'}`}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <ActionButton action="/logout" label="Sign out" className="btn btn-quiet btn-sm -ml-3" />
      </div>
    </nav>
  );
}

export function AccountShell({ current, title, children }: { current: string; title: string; children: ReactNode }) {
  return (
    <div className="wrap grid gap-8 py-8 md:grid-cols-[14rem_1fr] md:py-12">
      <AccountNav current={current} />
      <section aria-labelledby="page-title" className="min-w-0">
        <h1 id="page-title" className="mb-6 text-2xl md:text-3xl">
          {title}
        </h1>
        {children}
      </section>
    </div>
  );
}

export function Pagination({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (p: number) => string }) {
  if (pages <= 1) return null;
  const nums = Array.from({ length: pages }, (_, i) => i + 1).filter((n) => n === 1 || n === pages || Math.abs(n - page) <= 1);
  return (
    <nav aria-label="Pagination" className="mt-12 flex items-center justify-center gap-1">
      {page > 1 ? (
        <a className="btn btn-quiet btn-sm" href={hrefFor(page - 1)} rel="prev">
          Previous
        </a>
      ) : null}
      {nums.map((n, i) => (
        <span key={n} className="flex items-center">
          {i > 0 && n - nums[i - 1] > 1 ? <span className="px-1 text-[var(--color-muted)]">…</span> : null}
          <a
            href={hrefFor(n)}
            aria-current={n === page ? 'page' : undefined}
            className={`tabular grid size-9 place-items-center rounded-full text-sm ${n === page ? 'bg-[var(--color-forest-900)] font-semibold text-white' : 'hover:bg-[var(--color-mint-100)]'}`}
          >
            {n}
          </a>
        </span>
      ))}
      {page < pages ? (
        <a className="btn btn-quiet btn-sm" href={hrefFor(page + 1)} rel="next">
          Next
        </a>
      ) : null}
    </nav>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--color-mint-300)] bg-[var(--color-mint-50)] px-6 py-12 text-center">
      <h2 className="text-xl">{title}</h2>
      {children ? <div className="mx-auto mt-2 max-w-md text-[var(--color-muted)]">{children}</div> : null}
      {action ? (
        <a className="btn btn-primary mt-6" href={action.href}>
          {action.label}
        </a>
      ) : null}
    </div>
  );
}

export function MedicalNote({ compact }: { compact?: boolean }) {
  return (
    <p className={`rounded-xl border-l-[3px] border-[var(--color-champagne-500)] bg-[var(--color-mint-50)] px-4 py-3 text-[var(--color-muted)] ${compact ? 'text-xs' : 'text-sm'}`}>
      General product information, not medical advice. It does not replace a consultation with a doctor or pharmacist. Patch-test new skincare, and stop use if irritation occurs.
    </p>
  );
}
