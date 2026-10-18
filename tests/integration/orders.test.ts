import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkout, Client, newCustomer, resetTestDb, startServer, variantBySku, type TestServer } from '../helpers.ts';
import { expireReservations, handlePaymentWebhook } from '../../src/server/services/orders.ts';
import type { SandboxProvider } from '../../src/server/services/payments/sandbox.ts';

let s: TestServer;
before(async () => {
  await resetTestDb();
  s = await startServer();
});
after(async () => s?.close());

const order = (n: string) =>
  s.app.db.one<{ id: string; status: string; payment_status: string; total_paise: number; reservation_expires_at: Date | null }>(
    'SELECT id, status, payment_status, total_paise, reservation_expires_at FROM orders WHERE number = $1',
    [n],
  );
const stock = async (sku: string) => (await variantBySku(s.app, sku)).stock;
const numberFrom = (loc: string | null) => /GD-\d+/.exec(loc ?? '')![0];
const gatewayId = (html: string) => /\/sandbox-gateway\/(sbx_order_[A-Za-z0-9_-]+)/.exec(html)![1];

test('complete sandbox checkout: reserve stock → verified payment → confirmed order', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const sku = 'DMC-MFS50-50';
  const before = await stock(sku);
  const v = await variantBySku(s.app, sku);
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 2 });

  const placed = await checkout(c, s.app, email);
  assert.equal(placed.status, 303, placed.text.slice(0, 400));
  assert.match(placed.location!, /^\/checkout\/pay\/GD-\d+$/);
  const num = numberFrom(placed.location);
  assert.equal(await stock(sku), before - 2, 'stock reserved at order placement');
  let o = await order(num);
  assert.equal(o!.status, 'pending_payment');
  assert.equal(o!.total_paise, 2 * 49900, 'free delivery over ₹499; server-side total');
  assert.equal((await c.get('/api/cart')).json<{ lines: unknown[] }>().lines.length, 0, 'cart emptied');

  // Browser redirect alone must not confirm the order.
  const early = await c.get(`/orders/${num}/confirmation`);
  assert.equal(early.status, 303);
  assert.match(early.location!, /\/account\/orders\//);

  const pay = await c.get(`/checkout/pay/${num}`);
  assert.equal(pay.status, 200);
  assert.match(pay.text, /Sandbox/i);
  const gw = gatewayId(pay.text);
  const gwPage = await c.get(`/sandbox-gateway/${gw}`);
  assert.equal(gwPage.status, 200);
  const done = await c.post(`/sandbox-gateway/${gw}`, { outcome: 'captured' });
  assert.equal(done.status, 303);
  const cb = await c.get(done.location!);
  assert.equal(cb.status, 303);
  assert.equal(cb.location, `/orders/${num}/confirmation`);
  const conf = await c.get(cb.location!);
  assert.equal(conf.status, 200);
  assert.match(conf.text, new RegExp(num));

  o = await order(num);
  assert.equal(o!.status, 'confirmed');
  assert.equal(o!.payment_status, 'paid');
  assert.equal(o!.reservation_expires_at, null);
  assert.equal(await stock(sku), before - 2, 'stock not double-decremented');
  const att = await s.app.db.one<{ status: string; signature_verified: boolean }>('SELECT status, signature_verified FROM payment_attempts WHERE order_id = $1', [o!.id]);
  assert.equal(att!.status, 'captured');
  assert.equal(att!.signature_verified, true);
  const mail = await s.app.db.one(`SELECT 1 FROM outbound_emails WHERE to_email = $1 AND subject LIKE '%confirmed%'`, [email]);
  assert.ok(mail, 'confirmation email queued');

  // Order history, detail and tracking
  assert.match((await c.get('/account/orders')).text, new RegExp(num));
  assert.equal((await c.get(`/account/orders/${num}`)).status, 200);
  const t = new Client(s.url);
  await t.get('/track');
  const track = await t.post('/track', { number: num, email });
  assert.equal(track.status, 200);
  assert.match(track.text, /Confirmed|Order placed|confirmed/);
});

test('forged or unverified payment confirmations are rejected', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const v = await variantBySku(s.app, 'AUR-HGS30-50');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const num = numberFrom((await checkout(c, s.app, email)).location);
  const gw = gatewayId((await c.get(`/checkout/pay/${num}`)).text);

  // 1. Fake signature
  const forged = await c.get(`/checkout/callback?order_number=${num}&provider_order_id=${gw}&provider_payment_id=sbx_pay_fake&signature=${'ab'.repeat(32)}`);
  assert.equal(forged.status, 400);
  assert.equal((await order(num))!.payment_status, 'pending');

  // 2. Valid signature for a payment the provider never captured
  const sandbox = s.app.payments as SandboxProvider;
  const sig = sandbox.sign(gw, 'sbx_pay_never_captured');
  const uncaptured = await c.get(`/checkout/callback?order_number=${num}&provider_order_id=${gw}&provider_payment_id=sbx_pay_never_captured&signature=${sig}`);
  assert.notEqual(uncaptured.location, `/orders/${num}/confirmation`);
  assert.equal((await order(num))!.payment_status, 'pending');

  // 3. Missing parameters
  const missing = await c.get(`/checkout/callback?order_number=${num}&provider_order_id=${gw}`);
  assert.equal(missing.status, 303);
  assert.match(missing.location!, /failed=1/);

  // 4. Someone else's order
  const other = await newCustomer(s.url, s.app);
  const steal = await other.c.get(`/checkout/callback?order_number=${num}&provider_order_id=${gw}&provider_payment_id=x&signature=y`);
  assert.equal(steal.status, 404);
  assert.equal((await other.c.get(`/checkout/pay/${num}`)).status, 404);
  assert.equal((await other.c.get(`/account/orders/${num}`)).status, 404);

  // 5. Unsigned / mis-signed webhook
  const bad = await fetch(`${s.url}/webhooks/payments`, {
    method: 'POST',
    body: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', order_id: gw, amount: 1 } } } }),
    headers: { 'content-type': 'application/json', 'x-sandbox-signature': 'deadbeef' },
  });
  assert.equal(bad.status, 400);
  assert.equal((await order(num))!.payment_status, 'pending');
});

test('duplicate webhooks and callbacks are idempotent; amount mismatches are flagged', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const v = await variantBySku(s.app, 'AUR-CER-50');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const num = numberFrom((await checkout(c, s.app, email)).location);
  const gw = gatewayId((await c.get(`/checkout/pay/${num}`)).text);
  const sandbox = s.app.payments as SandboxProvider;
  const done = await sandbox.complete(gw, 'captured');
  const hook = sandbox.buildWebhook({ type: 'payment.captured', orderId: gw, paymentId: done!.paymentId, amountPaise: done!.amountPaise });

  const send = () =>
    fetch(`${s.url}/webhooks/payments`, { method: 'POST', body: hook.body, headers: { 'content-type': 'application/json', ...hook.headers } }).then(
      (r) => r.json() as Promise<{ outcome: string }>,
    );
  const [a, b] = await Promise.all([send(), send()]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['captured', 'duplicate']);
  assert.equal((await send()).outcome, 'duplicate');
  // Same payment, new event id (provider retry with a different id) → already captured, no double effects.
  const retry = sandbox.buildWebhook({ type: 'payment.captured', orderId: gw, paymentId: done!.paymentId, amountPaise: done!.amountPaise });
  assert.equal((await handlePaymentWebhook(s.app, retry.body, retry.headers)).outcome, 'already_captured');
  // Browser callback after the webhook
  const cb = await c.get(`/checkout/callback?order_number=${num}&provider_order_id=${gw}&provider_payment_id=${done!.paymentId}&signature=${done!.signature}`);
  assert.equal(cb.location, `/orders/${num}/confirmation`);
  const events = await s.app.db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.number = $1 AND e.status = 'confirmed'`,
    [num],
  );
  assert.equal(events!.n, 1, 'exactly one confirmation event');

  // Amount mismatch
  const c2 = await newCustomer(s.url, s.app);
  await c2.c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const num2 = numberFrom((await checkout(c2.c, s.app, c2.email)).location);
  const gw2 = gatewayId((await c2.c.get(`/checkout/pay/${num2}`)).text);
  const d2 = await sandbox.complete(gw2, 'captured');
  const wrong = sandbox.buildWebhook({ type: 'payment.captured', orderId: gw2, paymentId: d2!.paymentId, amountPaise: 100 });
  assert.equal((await handlePaymentWebhook(s.app, wrong.body, wrong.headers)).outcome, 'amount_mismatch');
  assert.equal((await order(num2))!.status, 'needs_attention');
});

test('failed and cancelled payments, retry, and reservation expiry release stock', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const sku = 'KSB-HNC-50';
  const start = await stock(sku);
  const v = await variantBySku(s.app, sku);
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const num = numberFrom((await checkout(c, s.app, email)).location);

  // Cancel at the gateway → back to pay page, order still payable
  let gw = gatewayId((await c.get(`/checkout/pay/${num}`)).text);
  const cancel = await c.post(`/sandbox-gateway/${gw}`, { outcome: 'cancelled' });
  const back = await c.get(cancel.location!);
  assert.equal(back.location, `/checkout/pay/${num}`);
  assert.equal((await order(num))!.status, 'pending_payment');

  // Decline → payment_failed, stock still reserved, retry allowed with a new gateway order
  gw = gatewayId((await c.get(`/checkout/pay/${num}`)).text);
  const fail = await c.post(`/sandbox-gateway/${gw}`, { outcome: 'failed' });
  const fb = await c.get(fail.location!);
  assert.match(fb.location!, /failed=1/);
  assert.equal((await order(num))!.status, 'payment_failed');
  assert.equal(await stock(sku), start - 1);
  const gw2 = gatewayId((await c.get(`/checkout/pay/${num}`)).text);
  assert.notEqual(gw2, gw, 'a fresh gateway order is created for the retry');

  // Reservation lapses → order cancelled, stock released
  await s.app.db.query(`UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE number = $1`, [num]);
  await expireReservations(s.app);
  assert.equal((await order(num))!.status, 'cancelled');
  assert.equal(await stock(sku), start, 'stock released after expiry');
});

test('customer cancellation before dispatch releases stock; COD orders respect settings', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const sku = 'MWL-SCT-100';
  const start = await stock(sku);
  const v = await variantBySku(s.app, sku);
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 3 });
  const cod = await checkout(c, s.app, email, 'cod');
  assert.equal(cod.status, 303);
  assert.match(cod.location!, /\/orders\/GD-\d+\/confirmation/);
  const num = numberFrom(cod.location);
  const o = await order(num);
  assert.equal(o!.status, 'confirmed');
  assert.equal(o!.payment_status, 'cod_pending');
  assert.equal(o!.total_paise, 3 * 13900 + 4900 + 3000, 'items + delivery + COD fee');
  assert.equal(await stock(sku), start - 3);

  const can = await c.post(`/account/orders/${num}/cancel`, { reason: 'Changed my mind' });
  assert.equal(can.status, 303);
  assert.equal((await order(num))!.status, 'cancelled');
  assert.equal(await stock(sku), start);

  // COD disabled in settings → refused
  const s0 = await s.app.settings.all();
  await s.app.settings.update('shipping', { ...s0.shipping, codEnabled: false }, null);
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const refused = await checkout(c, s.app, email, 'cod');
  assert.equal(refused.status, 422);
  assert.match(refused.text, /Cash on delivery is not available/);
  await s.app.settings.update('shipping', { ...s0.shipping, codEnabled: true }, null);
});

test('double-submitted checkout creates exactly one order (idempotency key)', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const v = await variantBySku(s.app, 'KSB-ROD-50');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const page = await c.get('/checkout');
  const key = /name="idempotencyKey" value="([^"]+)"/.exec(page.text)![1];
  const addr = await s.app.db.one<{ id: string }>('SELECT a.id FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.email = $1', [email]);
  const form = { addressId: addr!.id, paymentMethod: 'online', idempotencyKey: key, acceptTerms: 'on' };
  const [r1, r2] = await Promise.all([c.post('/checkout/place', form), c.post('/checkout/place', form)]);
  const locs = [r1, r2].filter((r) => r.status === 303).map((r) => r.location);
  assert.ok(locs.length >= 1);
  assert.equal(new Set(locs).size, 1, 'both submissions resolve to the same order');
  const n = await s.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', [key]);
  assert.equal(n!.n, 1);
});

test('concurrent buyers cannot oversell the last units', async () => {
  const sku = 'KSB-NHC-180'; // stock 3
  const v = await variantBySku(s.app, sku);
  await s.app.db.query('UPDATE product_variants SET stock = 2 WHERE id = $1', [v.id]);
  const buyers = await Promise.all([0, 1, 2].map(() => newCustomer(s.url, s.app)));
  for (const b of buyers) assert.equal((await b.c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 })).status, 200);
  const results = await Promise.all(buyers.map((b) => checkout(b.c, s.app, b.email)));
  const ok = results.filter((r) => r.status === 303).length;
  const refused = results.filter((r) => r.status === 422);
  assert.equal(ok, 2);
  assert.equal(refused.length, 1);
  assert.match(refused[0].text, /Out of stock|Only|available/);
  assert.equal(await stock(sku), 0, 'never negative');
  const neg = await s.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM product_variants WHERE stock < 0');
  assert.equal(neg!.n, 0);
});

test('checkout requires sign-in and a valid address; returns are requested after delivery', async () => {
  const guest = new Client(s.url);
  const r = await guest.get('/checkout');
  assert.equal(r.status, 303);
  assert.match(r.location!, /^\/login\?next=%2Fcheckout/);

  const { c, email, uid } = await newCustomer(s.url, s.app);
  const v = await variantBySku(s.app, 'MWL-OFGM-50');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 1 });
  const page = await c.get('/checkout');
  const key = /name="idempotencyKey" value="([^"]+)"/.exec(page.text)![1];
  const noAddr = await c.post('/checkout/place', { addressId: '', paymentMethod: 'online', idempotencyKey: key, acceptTerms: 'on' });
  assert.equal(noAddr.status, 422);
  assert.match(noAddr.text, /Choose a delivery address/);
  const badAddr = await c.post('/checkout/address', { fullName: '', phone: '123', line1: '', city: '', state: 'Nowhere', pincode: '000000' });
  assert.equal(badAddr.status, 422);
  assert.match(badAddr.text, /6-digit PIN code/);

  const cod = await checkout(c, s.app, email, 'cod');
  const num = numberFrom(cod.location);
  // Customer cannot return before delivery
  const early = await c.post(`/account/orders/${num}/return`, { reason: 'damaged', details: 'x' });
  assert.equal(early.status, 303);
  assert.equal((await s.app.db.one<{ n: number }>('SELECT count(*)::int AS n FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE o.number = $1', [num]))!.n, 0);
  await s.app.db.query(`UPDATE orders SET status = 'delivered' WHERE number = $1 AND user_id = $2`, [num, uid]);
  await s.app.db.query(`INSERT INTO order_events (order_id, status, note) SELECT id, 'delivered', 'test' FROM orders WHERE number = $1`, [num]);
  const ret = await c.post(`/account/orders/${num}/return`, { reason: 'damaged', details: 'Seal broken on arrival' });
  assert.equal(ret.status, 303);
  assert.equal(
    (await s.app.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE o.number = $1 AND r.status = 'requested'`, [
      num,
    ]))!.n,
    1,
  );
});
