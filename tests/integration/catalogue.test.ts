import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, resetTestDb, startServer, type TestServer } from '../helpers.ts';

let s: TestServer;
before(async () => {
  await resetTestDb();
  s = await startServer();
});
after(async () => s?.close());

test('home page renders featured products, categories, offers and security headers', async () => {
  const r = await new Client(s.url).get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Featured/);
  assert.match(r.text, /Salicylic Acid 2% Face Wash/);
  assert.match(r.text, /WELCOME10/);
  assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('cache-control')!, /no-store/);
});

test('catalogue lists active products with pagination and sorting', async () => {
  const c = new Client(s.url);
  const r = await c.get('/shop?sort=price_asc');
  assert.equal(r.status, 200);
  const prices = [...r.text.matchAll(/<span class="font-semibold text-\[var\(--color-forest-900\)\]">₹([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  assert.ok(prices.length >= 10, 'expected a page of products');
  assert.deepEqual(
    prices,
    [...prices].sort((a, b) => a - b),
    'sorted by price ascending',
  );
  const p2 = await c.get('/shop?page=2');
  assert.equal(p2.status, 200);
});

test('filter by category, brand and price range', async () => {
  const c = new Client(s.url);
  const cat = await c.get('/shop?category=sunscreen');
  assert.match(cat.text, /Matte Fluid Sunscreen SPF 50/);
  assert.doesNotMatch(cat.text, /Ceramide Moisturizer/);
  const brand = await c.get('/shop?brand=auralis-skin');
  assert.match(brand.text, /Ceramide Moisturizer/);
  assert.doesNotMatch(brand.text, /Vitamin C Face Serum/);
  const price = await c.get('/shop?min=100&max=200');
  assert.match(price.text, /Calamine Lotion/); // ₹115
  assert.doesNotMatch(price.text, /Ceramide Moisturizer/); // ₹499
  const page = await c.get('/c/sunscreen');
  assert.equal(page.status, 200);
  assert.match(page.text, /Hydrating Gel Sunscreen SPF 30/);
  assert.equal((await c.get('/c/does-not-exist')).status, 404);
  assert.equal((await c.get('/skincare')).status, 200);
  assert.equal((await c.get('/cosmetology')).status, 200);
});

test('search finds products by name and ingredient; empty state suggests alternatives', async () => {
  const c = new Client(s.url);
  const r = await c.get('/search?q=sunscreen');
  assert.match(r.text, /Matte Fluid Sunscreen/);
  const ing = await c.get('/search?q=niacinamide');
  assert.match(ing.text, /Niacinamide &amp; Zinc Blemish Gel/);
  const none = await c.get('/search?q=zzqqxx');
  assert.equal(none.status, 200);
  assert.match(none.text, /No (products|results)/i);
  const sug = await c.get('/api/search/suggest?q=vita');
  const data = sug.json<{ products: Array<{ name: string }> }>();
  assert.ok(data.products.some((p) => /Vitamin C/.test(p.name)));
  const injection = await c.get(`/search?q=${encodeURIComponent("'; DROP TABLE products; --<script>")}`);
  assert.equal(injection.status, 200);
  assert.doesNotMatch(injection.text, /<script>'/);
});

test('product page shows ingredients, warnings, pack sizes, stock and JSON-LD', async () => {
  const r = await new Client(s.url).get('/p/salicylic-acid-2-face-wash');
  assert.equal(r.status, 200);
  assert.match(r.text, /Full ingredient list/);
  assert.match(r.text, /Sodium Cocoyl Isethionate/);
  assert.match(r.text, /Warnings/);
  assert.match(r.text, /200 ml/);
  assert.match(r.text, /application\/ld\+json/);
  assert.match(r.text, /"@type":"Product"/);
  assert.match(r.text, /rel="canonical"/);
  assert.match(r.text, /not medical advice/i);
  assert.match(r.text, /Related products/);
  assert.doesNotMatch(r.text, /"ratingValue"|"review"/, 'no fabricated reviews or ratings');
});

test('draft and archived products are hidden; unknown slugs 404', async () => {
  await s.app.db.query(`UPDATE products SET status = 'draft' WHERE slug = 'oat-body-wash'`);
  const c = new Client(s.url);
  assert.equal((await c.get('/p/oat-body-wash')).status, 404);
  assert.doesNotMatch((await c.get('/shop?category=body-care')).text, /Colloidal Oat Body Wash/);
  assert.equal((await c.get('/p/nope-not-real')).status, 404);
  await s.app.db.query(`UPDATE products SET status = 'active' WHERE slug = 'oat-body-wash'`);
});

test('robots.txt, sitemap and policy pages', async () => {
  const c = new Client(s.url);
  const robots = await c.get('/robots.txt');
  // Non-production environments must never be indexed; production lists private paths + sitemap (see seo.ts).
  assert.match(robots.text, /^User-agent: \*\nDisallow: \/\n$/);
  const sm = await c.get('/sitemap.xml');
  assert.match(sm.text, /\/p\/salicylic-acid-2-face-wash/);
  assert.match(sm.text, /\/c\/sunscreen/);
  for (const p of [
    '/faq',
    '/contact',
    '/policies/shipping',
    '/policies/returns',
    '/policies/privacy',
    '/policies/terms',
    '/product-safety',
    '/seller-information',
    '/track',
    '/pharmacy',
  ]) {
    assert.equal((await c.get(p)).status, 200, p);
  }
});

test('contact form validates and stores messages', async () => {
  const c = new Client(s.url);
  await c.get('/contact');
  const bad = await c.post('/contact', { name: '', email: 'nope', topic: 'x', message: 'hi' });
  assert.equal(bad.status, 422);
  const ok = await c.post('/contact', { name: 'Ravi', email: 'ravi@example.test', topic: 'product', message: 'Is this suitable for oily skin?' });
  assert.equal(ok.status, 303);
  assert.ok(await s.app.db.one(`SELECT 1 FROM contact_messages WHERE email = 'ravi@example.test'`));
});

test('unknown routes return a styled 404 and HEAD works', async () => {
  const c = new Client(s.url);
  const r = await c.get('/definitely/not/here');
  assert.equal(r.status, 404);
  assert.match(r.text, /Page not found/);
  const h = await c.request('HEAD', '/');
  assert.equal(h.status, 200);
});
