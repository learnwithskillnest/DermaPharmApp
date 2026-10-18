import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, resetTestDb, startServer, variantBySku, type TestServer } from '../helpers.ts';
import { inclusiveTax } from '../../src/server/services/pricing.ts';

let s: TestServer;
before(async () => {
  await resetTestDb();
  s = await startServer();
});
after(async () => s?.close());

interface CartJson {
  lines: Array<{ sku: string; quantity: number; unitPricePaise: number; issue: string | null }>;
  totals: { subtotalPaise: number; discountPaise: number; shippingPaise: number; taxPaise: number; totalPaise: number };
  coupon: { applied: boolean; message: string | null } | null;
  canCheckout: boolean;
}

test('add, update and remove cart items (JSON API and HTML forms)', async () => {
  const c = new Client(s.url);
  const fw = await variantBySku(s.app, 'MWL-SAFW-100'); // ₹349
  const add = await c.postJson('/api/cart/items', { variantId: fw.id, quantity: 2 });
  assert.equal(add.status, 200);
  assert.equal(add.json<{ count: number }>().count, 2);

  let cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.lines[0].quantity, 2);
  assert.equal(cart.totals.subtotalPaise, 69800);

  const upd = await c.post('/cart/update', { variantId: fw.id, quantity: 3 });
  assert.equal(upd.status, 303);
  cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.lines[0].quantity, 3);

  const page = await c.get('/cart');
  assert.match(page.text, /Salicylic Acid 2% Face Wash/);

  await c.post('/cart/remove', { variantId: fw.id });
  cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.lines.length, 0);
  assert.equal(cart.totals.totalPaise, 0);
});

test('invalid quantities are rejected server-side', async () => {
  const c = new Client(s.url);
  const v = await variantBySku(s.app, 'AUR-CER-50');
  for (const quantity of [0, -2, 21, 1.5, 'abc', null]) {
    const r = await c.postJson('/api/cart/items', { variantId: v.id, quantity });
    assert.equal(r.status, 422, `quantity ${quantity}`);
  }
  const unknown = await c.postJson('/api/cart/items', { variantId: '00000000-0000-4000-8000-000000000000', quantity: 1 });
  assert.equal(unknown.status, 404);
  const bad = await c.postJson('/api/cart/items', { variantId: "1' OR 1=1 --", quantity: 1 });
  assert.equal(bad.status, 422);
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const neg = await c.post('/cart/update', { variantId: v.id, quantity: -1 });
  assert.equal(neg.status, 303);
  assert.equal((await c.get('/api/cart')).json<CartJson>().lines[0].quantity, 1, 'negative update ignored');
  const over = await c.postJson('/api/cart/items', { variantId: v.id, quantity: 20 });
  assert.equal(over.status, 422, 'line total may not exceed 20');
});

test('insufficient and zero stock are rejected', async () => {
  const c = new Client(s.url);
  const low = await variantBySku(s.app, 'KSB-MCW-200'); // stock 4
  const tooMany = await c.postJson('/api/cart/items', { variantId: low.id, quantity: 5 });
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.json<{ error: string }>().error, /Only 4/);
  assert.equal((await c.postJson('/api/cart/items', { variantId: low.id, quantity: 4 })).status, 200);
  assert.equal((await c.postJson('/api/cart/items', { variantId: low.id, quantity: 1 })).status, 422, 'cumulative quantity checked');
  const out = await variantBySku(s.app, 'MWL-NZG-15'); // stock 0
  const r = await c.postJson('/api/cart/items', { variantId: out.id, quantity: 1 });
  assert.equal(r.status, 422);
  assert.match(r.json<{ error: string }>().error, /out of stock/);

  // Stock drops after the item is in the cart: checkout is blocked with a clear issue.
  await s.app.db.query('UPDATE product_variants SET stock = 2 WHERE id = $1', [low.id]);
  const cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.canCheckout, false);
  assert.match(cart.lines[0].issue!, /Only 2 available/);
  await s.app.db.query('UPDATE product_variants SET stock = 4 WHERE id = $1', [low.id]);
});

test('totals are calculated on the server: shipping threshold, GST, coupons', async () => {
  const c = new Client(s.url);
  const serum = await variantBySku(s.app, 'KSB-VCS-30'); // ₹649, 18%
  const ors = await variantBySku(s.app, 'SPC-ORS-10'); // ₹210, pharmacy 5%
  await c.postJson('/api/cart/items', { variantId: ors.id, quantity: 1 });
  let cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.totals.shippingPaise, 4900, 'below ₹499 pays delivery');
  assert.equal(cart.totals.totalPaise, 21000 + 4900);

  await c.postJson('/api/cart/items', { variantId: serum.id, quantity: 1 });
  cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.totals.subtotalPaise, 85900);
  assert.equal(cart.totals.shippingPaise, 0);
  assert.equal(cart.totals.taxPaise, inclusiveTax(64900, 1800) + inclusiveTax(21000, 500));

  // WELCOME10: 10% of eligible (non-pharmacy) ₹649 = ₹64.90
  await c.get('/cart');
  const applied = await c.post('/cart/coupon', { code: 'welcome10' });
  assert.equal(applied.status, 303);
  cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.coupon?.applied, true);
  assert.equal(cart.totals.discountPaise, 6490);
  assert.equal(cart.totals.totalPaise, 85900 - 6490);

  const bogus = await c.post('/cart/coupon', { code: 'FREEMONEY' });
  assert.equal(bogus.status, 422);
  // GLOW100 needs ₹999 of eligible items
  await c.post('/cart/coupon', { code: 'GLOW100' });
  cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.coupon?.applied, false);
  assert.match(cart.coupon!.message!, /Spend ₹999/);
  assert.equal(cart.totals.discountPaise, 0);
});

test('client-supplied prices are ignored', async () => {
  const c = new Client(s.url);
  const v = await variantBySku(s.app, 'AUR-HAS-30'); // ₹549
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1, price: 1, unitPricePaise: 1 });
  const cart = (await c.get('/api/cart')).json<CartJson>();
  assert.equal(cart.lines[0].unitPricePaise, 54900);
});

test('guest cart is merged into the account on sign-in', async () => {
  const c = new Client(s.url);
  const v = await variantBySku(s.app, 'DMC-U10-200');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 2 });
  await c.login('customer@glowderma.test');
  const cart = (await c.get('/api/cart')).json<CartJson>();
  assert.ok(cart.lines.some((l) => l.sku === 'DMC-U10-200' && l.quantity >= 2));
});

test('prescription-only items cannot be added while Rx ordering is disabled', async () => {
  const c = new Client(s.url);
  const rx = await variantBySku(s.app, 'SPC-TRT-20');
  const r = await c.postJson('/api/cart/items', { variantId: rx.id, quantity: 1 });
  assert.equal(r.status, 422);
  assert.match(r.json<{ error: string }>().error, /prescription/i);
});

test('wishlist and recently viewed', async () => {
  const c = new Client(s.url);
  await c.login('customer@glowderma.test');
  const p = await variantBySku(s.app, 'AUR-CER-50');
  await c.get('/p/ceramide-moisturizer');
  const recent = await c.get('/recently-viewed');
  assert.match(recent.text, /Ceramide Moisturizer/);
  const w = await c.post(`/wishlist/${p.product_id}/toggle`, { next: '/account/wishlist' });
  assert.equal(w.status, 303);
  assert.match((await c.get('/account/wishlist')).text, /Ceramide Moisturizer/);
  await c.post(`/wishlist/${p.product_id}/toggle`, { next: '/account/wishlist' });
  assert.doesNotMatch((await c.get('/account/wishlist')).text, /<h3[^>]*><a[^>]*>Ceramide Moisturizer/);
  const guest = await new Client(s.url).post(`/wishlist/${p.product_id}/toggle`, {});
  assert.equal(guest.status, 401, 'guests must sign in to use the wishlist');
});
