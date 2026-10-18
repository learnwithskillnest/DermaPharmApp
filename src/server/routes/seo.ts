import type { App } from '../app.ts';
import { suggest } from '../services/catalog.ts';
import { visibility } from './helpers.ts';
import { HttpError } from '../http/errors.ts';

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function seoRoutes(app: App) {
  const r = app.router;

  r.get(
    '/robots.txt',
    (ctx) => {
      const body = ctx.app.config.isProd
        ? `User-agent: *\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nDisallow: /admin\nDisallow: /api/\nDisallow: /search\nDisallow: /sandbox-gateway\nSitemap: ${ctx.app.config.APP_URL}/sitemap.xml\n`
        : // Non-production environments must never be indexed.
          'User-agent: *\nDisallow: /\n';
      ctx.text(body, 200, 'text/plain; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
    },
    { session: false },
  );

  r.get(
    '/sitemap.xml',
    async (ctx) => {
      const settings = await ctx.app.settings.all();
      const vis = visibility(settings);
      const base = ctx.app.config.APP_URL.replace(/\/$/, '');
      const classes = ['cosmetic', 'personal_care', ...(vis.otcVisible ? ['otc_pharmacy'] : []), ...(vis.rxListingVisible ? ['prescription'] : [])];
      const products = await ctx.app.db.many<{ slug: string; updated_at: Date }>(
        `SELECT slug, updated_at FROM products WHERE status = 'active' AND classification = ANY($1::product_class[]) ORDER BY slug`,
        [classes],
      );
      const cats = await ctx.app.db.many<{ slug: string }>(`SELECT slug FROM categories WHERE is_active ORDER BY sort_order`);
      const statics = [
        '/',
        '/shop',
        '/skincare',
        '/cosmetology',
        '/body-hair',
        '/pharmacy',
        '/faq',
        '/contact',
        '/policies/shipping',
        '/policies/returns',
        '/policies/privacy',
        '/policies/terms',
        '/product-safety',
        '/seller-information',
      ];
      const urls = [
        ...statics.map((p) => `<url><loc>${xmlEscape(base + p)}</loc></url>`),
        ...cats.map((c) => `<url><loc>${xmlEscape(`${base}/c/${c.slug}`)}</loc></url>`),
        ...products.map((p) => `<url><loc>${xmlEscape(`${base}/p/${p.slug}`)}</loc><lastmod>${p.updated_at.toISOString().slice(0, 10)}</lastmod></url>`),
      ];
      ctx.text(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
        200,
        'application/xml; charset=utf-8',
        {
          'Cache-Control': 'public, max-age=3600',
        },
      );
    },
    { session: false },
  );

  r.get(
    '/api/search/suggest',
    async (ctx) => {
      if (ctx.app.limiter.hit('suggest', ctx.ip)) throw new HttpError(429, 'Too many requests.');
      const q = ctx.query.get('q') ?? '';
      const data = await suggest(ctx.app.db, q, visibility(await ctx.app.settings.all()));
      ctx.json(data, 200, { 'Cache-Control': 'public, max-age=60' });
    },
    { session: false },
  );

  r.get(
    '/api/health',
    async (ctx) => {
      let db = 'ok';
      try {
        await ctx.app.db.query('SELECT 1');
      } catch {
        db = 'unavailable';
      }
      ctx.json({ status: db === 'ok' ? 'ok' : 'degraded', db }, db === 'ok' ? 200 : 503);
    },
    { session: false },
  );
}
