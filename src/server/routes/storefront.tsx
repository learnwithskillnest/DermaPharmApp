import type { App } from '../app.ts';
import type { Ctx } from '../http/context.ts';
import { HttpError } from '../http/errors.ts';
import { render } from '../render.tsx';
import {
  activeIngredients,
  getCategory,
  getProductBySlug,
  listCategories,
  listFacets,
  listProducts,
  recentlyViewed,
  recordView,
  relatedProducts,
  type ListParams,
} from '../services/catalog.ts';
import { HomePage } from '../../ui/pages/home.tsx';
import { ListingPage, type ListingState } from '../../ui/pages/catalog.tsx';
import { ProductPage } from '../../ui/pages/catalog.tsx';
import { RecentlyViewedPage } from '../../ui/pages/account.tsx';
import { ContactPage, FaqPage, PrivacyPolicy, ProductSafetyPage, ReturnsPolicy, SellerInfoPage, ShippingPolicy, TermsPage, TrackPage } from '../../ui/pages/misc.tsx';
import { echo, ownerKey, parseListing, requireUuid, visibility } from './helpers.ts';
import { contactSchema, parseWith, trackSchema } from '../validation.ts';
import { safeNext } from '../http/context.ts';
import { orderByNumber, orderShipments, orderTimeline, STATUS_LABEL } from '../services/orders.ts';

const DEPARTMENTS: Record<string, { title: string; intro: string; description: string }> = {
  skincare: {
    title: 'Skincare',
    intro: 'Cleansers, sunscreen, moisturisers and targeted actives. Every product lists its full ingredients and key-active strength.',
    description: 'Shop face washes, sunscreens, moisturisers, night creams and acne-care skincare with full ingredient lists.',
  },
  cosmetology: {
    title: 'Cosmetology',
    intro: 'Serums and cosmetic treatments for texture, tone and radiance. Cosmetic products — not medicines.',
    description: 'Vitamin C, niacinamide and azelaic acid serums and cosmetic treatments.',
  },
  'body-hair': {
    title: 'Body & hair',
    intro: 'Everyday care for body, scalp and hair.',
    description: 'Body lotions, hair care and personal care essentials.',
  },
};

async function listing(
  ctx: Ctx,
  opts: {
    title: string;
    intro?: string;
    basePath: string;
    base: Partial<ListParams>;
    crumbs: Array<{ href?: string; label: string }>;
    department?: string;
    lockedCategory?: boolean;
    notice?: unknown;
    description?: string;
    canonical: string;
  },
) {
  const settings = await ctx.app.settings.all();
  const vis = visibility(settings);
  const state: ListingState = parseListing(ctx.query);
  if (opts.lockedCategory && opts.base.categorySlugs) state.categories = opts.base.categorySlugs;
  const params: ListParams = {
    ...opts.base,
    q: state.q,
    categorySlugs: state.categories.length ? state.categories : opts.base.categorySlugs,
    brandSlugs: state.brands,
    minPaise: state.min,
    maxPaise: state.max,
    inStock: state.inStock,
    sort: state.sort,
    page: state.page,
    perPage: 12,
  };
  const [result, facets, categories] = await Promise.all([
    listProducts(ctx.app.db, params, vis),
    listFacets(ctx.app.db, { ...params, brandSlugs: undefined }, vis),
    listCategories(ctx.app.db),
  ]);
  const categoryOptions = categories.filter((c) => (opts.department ? c.department === opts.department : c.department !== 'pharmacy' || vis.otcVisible));
  const suggestions = result.total === 0 ? (await listProducts(ctx.app.db, { featuredOnly: true, perPage: 3 }, vis)).items : [];
  const filtered = state.brands.length || state.min !== undefined || state.max !== undefined || state.inStock || state.page > 1 || state.q;
  await render(
    ctx,
    { title: opts.title, description: opts.description ?? opts.intro, canonical: opts.canonical, noindex: !!filtered },
    <ListingPage
      title={opts.title}
      intro={opts.intro}
      crumbs={opts.crumbs}
      basePath={opts.basePath}
      state={state}
      result={result}
      facets={facets}
      categoryOptions={categoryOptions}
      lockedCategory={opts.lockedCategory}
      notice={opts.notice as never}
      suggestions={suggestions}
    />,
    { searchQuery: state.q },
  );
}

export function storefrontRoutes(app: App) {
  const r = app.router;

  r.get('/', async (ctx) => {
    const settings = await ctx.app.settings.all();
    const vis = visibility(settings);
    const key = ownerKey(ctx);
    const [actives, featured, newest, categories, offers, recent] = await Promise.all([
      activeIngredients(ctx.app.db, vis),
      listProducts(ctx.app.db, { featuredOnly: true, perPage: 8, sort: 'relevance' }, vis),
      listProducts(ctx.app.db, { perPage: 4, sort: 'newest' }, vis),
      listCategories(ctx.app.db),
      ctx.app.db.many<{ code: string; description: string; kind: string; value: number; min_subtotal_paise: number }>(
        `SELECT code, description, kind, value, min_subtotal_paise FROM coupons
          WHERE is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
            AND (usage_limit IS NULL OR used_count < usage_limit) AND description <> '' ORDER BY created_at LIMIT 2`,
      ),
      key ? recentlyViewed(ctx.app.db, key, vis) : Promise.resolve([]),
    ]);
    await render(
      ctx,
      {
        title: `${settings.store.name} — skincare, cosmetology & pharmacy essentials`,
        description: 'Shop skincare, cosmetology and pharmacy essentials with complete ingredient lists and clear directions. Prices include GST.',
        canonical: '/',
        jsonLd: [
          { '@context': 'https://schema.org', '@type': 'Organization', name: settings.store.name, url: ctx.app.config.APP_URL },
          {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: settings.store.name,
            url: ctx.app.config.APP_URL,
            potentialAction: { '@type': 'SearchAction', target: `${ctx.app.config.APP_URL}/search?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
          },
        ],
      },
      <HomePage
        actives={actives}
        featured={featured.items}
        newest={newest.items}
        recent={recent}
        categories={categories.filter((c) => c.department !== 'pharmacy' || vis.otcVisible)}
        offers={offers}
        freeShippingPaise={settings.shipping.freeThresholdPaise}
      />,
    );
  });

  r.get('/shop', (ctx) =>
    listing(ctx, {
      title: 'All products',
      intro: 'Browse the full catalogue. Filter by category, brand and price.',
      basePath: '/shop',
      base: {},
      crumbs: [{ href: '/', label: 'Home' }, { label: 'Shop' }],
      canonical: '/shop',
    }),
  );

  r.get('/search', async (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    if (!q) return ctx.redirect('/shop');
    return listing(ctx, {
      title: 'Search results',
      basePath: '/search',
      base: {},
      crumbs: [{ href: '/', label: 'Home' }, { label: 'Search' }],
      canonical: '/search',
    });
  });

  for (const [dept, d] of Object.entries(DEPARTMENTS)) {
    r.get(`/${dept}`, (ctx) =>
      listing(ctx, {
        title: d.title,
        intro: d.intro,
        description: d.description,
        basePath: `/${dept}`,
        base: { department: dept },
        department: dept,
        crumbs: [{ href: '/', label: 'Home' }, { label: d.title }],
        canonical: `/${dept}`,
      }),
    );
  }

  r.get('/pharmacy', async (ctx) => {
    const settings = await ctx.app.settings.all();
    const blockers = await ctx.app.settings.rxOrderingBlockers();
    if (!settings.pharmacy.otcVisible && !settings.pharmacy.rxListingVisible) throw new HttpError(404, 'The pharmacy is not open yet.');
    return listing(ctx, {
      title: 'Pharmacy',
      intro: 'Over-the-counter pharmacy products, sold in line with pharmacy regulations. Read the label and ask a doctor or pharmacist if you are unsure.',
      basePath: '/pharmacy',
      base: { department: 'pharmacy', includePrescription: true },
      department: 'pharmacy',
      crumbs: [{ href: '/', label: 'Home' }, { label: 'Pharmacy' }],
      canonical: '/pharmacy',
      notice: (
        <div className="grid gap-3 md:grid-cols-2">
          <p className="notice">
            <strong>Information, not advice.</strong> We don’t diagnose conditions, prescribe, or suggest substitutes for prescribed medicines. Talk to your doctor or pharmacist.
          </p>
          <p className={`notice ${blockers.length ? 'notice-warning' : ''}`}>
            <strong>Prescription medicines:</strong>{' '}
            {blockers.length
              ? 'listed for information only. Online ordering is not available yet.'
              : 'need a valid prescription, verified by our registered pharmacist before dispatch.'}
          </p>
        </div>
      ),
    });
  });

  r.get('/c/:slug', async (ctx) => {
    const cat = await getCategory(ctx.app.db, ctx.params.slug);
    if (!cat) throw new HttpError(404, 'That category does not exist.');
    const settings = await ctx.app.settings.all();
    if (cat.department === 'pharmacy' && !settings.pharmacy.otcVisible && !settings.pharmacy.rxListingVisible) throw new HttpError(404, 'That category does not exist.');
    const deptLabel = cat.department === 'pharmacy' ? 'Pharmacy' : (DEPARTMENTS[cat.department]?.title ?? 'Shop');
    return listing(ctx, {
      title: cat.name,
      intro: cat.description ?? undefined,
      basePath: `/c/${cat.slug}`,
      base: { categorySlugs: [cat.slug], includePrescription: cat.department === 'pharmacy' },
      lockedCategory: true,
      crumbs: [{ href: '/', label: 'Home' }, { href: `/${cat.department}`, label: deptLabel }, { label: cat.name }],
      canonical: `/c/${cat.slug}`,
    });
  });

  r.get('/p/:slug', async (ctx) => {
    const settings = await ctx.app.settings.all();
    const vis = visibility(settings);
    const p = await getProductBySlug(ctx.app.db, ctx.params.slug, vis);
    if (!p) throw new HttpError(404, 'That product is not available.');
    const rxEnabled = await ctx.app.settings.rxOrderingEnabled();
    const key = ownerKey(ctx);
    const [related, recent, wish] = await Promise.all([
      relatedProducts(ctx.app.db, p, vis),
      key ? recentlyViewed(ctx.app.db, key, vis, p.id) : Promise.resolve([]),
      ctx.user ? ctx.app.db.one('SELECT 1 FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [ctx.user.id, p.id]) : Promise.resolve(null),
    ]);
    if (key) await recordView(ctx.app.db, key, p.id);
    const blockedReason = p.requires_prescription && !rxEnabled ? 'Not available to order online. Prescription medicines can’t be bought on this site yet.' : null;
    const v = p.variants[0];
    const url = `${ctx.app.config.APP_URL}/p/${p.slug}`;
    await render(
      ctx,
      {
        title: p.seo_title ?? `${p.name} — ${p.brand_name}`,
        description: p.seo_description ?? p.short_description,
        canonical: `/p/${p.slug}`,
        jsonLd: [
          {
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: p.name,
            description: p.short_description,
            brand: { '@type': 'Brand', name: p.brand_name },
            sku: v?.sku,
            image: p.images.map((i) => ctx.app.config.APP_URL + i.url),
            url,
            offers: p.variants.map((x) => ({
              '@type': 'Offer',
              sku: x.sku,
              priceCurrency: 'INR',
              price: (x.price_paise / 100).toFixed(2),
              availability: x.stock > 0 && !blockedReason ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
              url,
            })),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: 'Home', item: ctx.app.config.APP_URL },
              { '@type': 'ListItem', position: 2, name: p.category_name, item: `${ctx.app.config.APP_URL}/c/${p.category_slug}` },
              { '@type': 'ListItem', position: 3, name: p.name, item: url },
            ],
          },
        ],
      },
      <ProductPage
        p={p}
        related={related}
        recent={recent}
        blockedReason={blockedReason}
        rxOrderingEnabled={rxEnabled}
        inWishlist={!!wish}
        delivery={{ freeThresholdPaise: settings.shipping.freeThresholdPaise, dispatchTime: settings.shipping.dispatchTime, deliveryEstimate: settings.shipping.deliveryEstimate }}
      />,
    );
  });

  r.get('/recently-viewed', async (ctx) => {
    const key = ownerKey(ctx);
    const items = key ? await recentlyViewed(ctx.app.db, key, visibility(await ctx.app.settings.all())) : [];
    await render(ctx, { title: 'Recently viewed', noindex: true }, <RecentlyViewedPage items={items} />);
  });

  r.post(
    '/wishlist/:productId/toggle',
    async (ctx) => {
      const pid = requireUuid(ctx.params.productId);
      const exists = await ctx.app.db.one('SELECT 1 FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [ctx.user!.id, pid]);
      if (exists) {
        await ctx.app.db.query('DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2', [ctx.user!.id, pid]);
        ctx.setFlash('success', 'Removed from your wishlist.');
      } else {
        const p = await ctx.app.db.one(`SELECT 1 FROM products WHERE id = $1 AND status = 'active'`, [pid]);
        if (!p) throw new HttpError(404, 'That product is not available.');
        await ctx.app.db.query('INSERT INTO wishlist_items (user_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ctx.user!.id, pid]);
        ctx.setFlash('success', 'Saved to your wishlist.');
      }
      ctx.redirect(safeNext(ctx.form.next, '/account/wishlist'));
    },
    { auth: 'user' },
  );

  // ── Information pages ──
  const info = (path: string, title: string, description: string, el: (ctx: Ctx) => Promise<unknown>) =>
    r.get(path, async (ctx) => render(ctx, { title, description, canonical: path }, (await el(ctx)) as never));
  info('/policies/shipping', 'Shipping policy', 'Delivery charges, timelines and tracking.', async (ctx) => <ShippingPolicy s={await ctx.app.settings.all()} />);
  info('/policies/returns', 'Returns & refunds', 'How to cancel, return and get a refund.', async (ctx) => <ReturnsPolicy s={await ctx.app.settings.all()} />);
  info('/policies/privacy', 'Privacy policy', 'How we collect, use and protect your personal data.', async (ctx) => <PrivacyPolicy s={await ctx.app.settings.all()} />);
  info('/policies/terms', 'Terms of use', 'The terms for using this store.', async (ctx) => <TermsPage s={await ctx.app.settings.all()} />);
  info('/product-safety', 'Product safety', 'Patch testing, actives that need care, and what to do if you react to a product.', async () => <ProductSafetyPage />);
  info('/faq', 'FAQs', 'Answers to common questions about orders, delivery, returns and prescriptions.', async () => <FaqPage />);
  info('/seller-information', 'Seller & licence details', 'Seller, licence and grievance officer details.', async (ctx) => (
    <SellerInfoPage s={await ctx.app.settings.all()} rxBlockers={await ctx.app.settings.rxOrderingBlockers()} />
  ));

  r.get('/contact', async (ctx) => {
    await render(
      ctx,
      { title: 'Contact us', description: 'Get help with orders, products, returns and prescriptions.', canonical: '/contact' },
      <ContactPage s={await ctx.app.settings.all()} sent={ctx.query.get('sent') === '1'} />,
    );
  });
  r.post(
    '/contact',
    async (ctx) => {
      const settings = await ctx.app.settings.all();
      const v = parseWith(contactSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Contact us' }, <ContactPage s={settings} errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      await ctx.app.db.query('INSERT INTO contact_messages (name, email, phone, topic, order_number, message) VALUES ($1, $2, $3, $4, $5, $6)', [
        v.data.name,
        v.data.email,
        v.data.phone ?? null,
        v.data.topic,
        v.data.orderNumber,
        v.data.message,
      ]);
      ctx.redirect('/contact?sent=1');
    },
    { rateLimit: 'contact' },
  );

  r.get('/track', async (ctx) => render(ctx, { title: 'Track an order', canonical: '/track' }, <TrackPage />));
  r.post(
    '/track',
    async (ctx) => {
      const v = parseWith(trackSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Track an order' }, <TrackPage errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      const o = await orderByNumber(ctx.app.db, v.data.number);
      if (!o || o.email.toLowerCase() !== v.data.email) {
        return render(ctx, { title: 'Track an order' }, <TrackPage errors={{ _form: 'We couldn’t find an order with that number and email.' }} values={echo(ctx.form)} />, {
          status: 404,
        });
      }
      if (ctx.user && o.user_id === ctx.user.id) return ctx.redirect(`/account/orders/${o.number}`);
      const fmt = (d: Date) => d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      const [events, shipments] = await Promise.all([orderTimeline(ctx.app.db, o.id, true), orderShipments(ctx.app.db, o.id)]);
      return render(
        ctx,
        { title: `Order ${o.number}`, noindex: true },
        <TrackPage
          result={{
            number: o.number,
            statusLabel: STATUS_LABEL[o.status],
            placed: fmt(o.created_at),
            events: events.map((e) => ({ when: fmt(e.created_at), note: e.note ?? e.status })),
            shipments: shipments.map((x) => ({ carrier: x.carrier, tracking: x.tracking_number })),
          }}
        />,
      );
    },
    { rateLimit: 'contact' },
  );
}
