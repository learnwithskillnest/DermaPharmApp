import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkout, Client, newCustomer, resetTestDb, startServer, variantBySku, type TestServer } from '../helpers.ts';

let s: TestServer;
let admin: Client;
let staff: Client;
before(async () => {
  await resetTestDb();
  s = await startServer();
  admin = new Client(s.url);
  await admin.login('admin@glowderma.test');
  staff = new Client(s.url);
  await staff.login('staff@glowderma.test');
});
after(async () => s?.close());

const ids = async () => ({
  brand: (await s.app.db.one<{ id: string }>(`SELECT id FROM brands WHERE slug = 'mintwell-labs'`))!.id,
  category: (await s.app.db.one<{ id: string }>(`SELECT id FROM categories WHERE slug = 'moisturizers'`))!.id,
});

test('staff create, publish, edit and archive a product; changes are audited', async () => {
  const { brand, category } = await ids();
  await staff.get('/admin/products/new');
  const base = {
    name: 'Test Barrier Balm',
    slug: 'test-barrier-balm',
    brandId: brand,
    categoryId: category,
    shortDescription: 'A test balm used by the automated test suite.',
    description: 'Test only.',
    classification: 'cosmetic',
    taxRatePercent: '18',
    hsnCode: '3304',
    status: 'draft',
    variantCount: '1',
    defaultVariant: '0',
    v0_name: '30 g',
    v0_sku: 'TEST-TBB-30',
    v0_mrp: '450',
    v0_price: '399',
    v0_lowStock: '5',
    v0_weight: '60',
    v0_initialStock: '12',
    v0_isActive: 'on',
  };
  const badPrice = await staff.post('/admin/products/new', { ...base, v0_price: '500' });
  assert.equal(badPrice.status, 422);
  assert.match(badPrice.text, /cannot be more than MRP/);
  const badSlug = await staff.post('/admin/products/new', { ...base, slug: 'Bad Slug!' });
  assert.equal(badSlug.status, 422);
  const xss = await staff.post('/admin/products/new', { ...base, images: 'javascript:alert(1) | x' });
  assert.equal(xss.status, 422);

  const created = await staff.post('/admin/products/new', base);
  assert.equal(created.status, 303, created.text.slice(0, 500));
  const p = await s.app.db.one<{ id: string; status: string }>(`SELECT id, status FROM products WHERE slug = 'test-barrier-balm'`);
  assert.equal(p!.status, 'draft');
  assert.equal((await variantBySku(s.app, 'TEST-TBB-30')).stock, 12);
  assert.equal((await new Client(s.url).get('/p/test-barrier-balm')).status, 404, 'drafts are not public');

  await staff.get(`/admin/products/${p!.id}`);
  assert.equal((await staff.post(`/admin/products/${p!.id}/status`, { status: 'active' })).status, 303);
  assert.equal((await new Client(s.url).get('/p/test-barrier-balm')).status, 200);
  assert.equal((await staff.post(`/admin/products/${p!.id}/status`, { status: 'archived' })).status, 303);
  assert.equal((await new Client(s.url).get('/p/test-barrier-balm')).status, 404);
  const audit = await s.app.db.many<{ action: string }>(`SELECT action FROM audit_logs WHERE entity = 'product' AND entity_id = $1`, [p!.id]);
  assert.ok(audit.some((a) => a.action === 'product.published') && audit.some((a) => a.action === 'product.archived'));
});

test('stock adjustments are logged and can never go negative; batches track expiry', async () => {
  const v = await variantBySku(s.app, 'AUR-POC-50');
  await staff.get('/admin/inventory');
  const neg = await staff.post('/admin/inventory/adjust', { variantId: v.id, delta: String(-(v.stock + 1)), reason: 'damage', note: 'test' });
  assert.ok([303, 422].includes(neg.status));
  assert.equal((await variantBySku(s.app, 'AUR-POC-50')).stock, v.stock, 'stock unchanged');
  const ok = await staff.post('/admin/inventory/adjust', { variantId: v.id, delta: '10', reason: 'restock', note: 'PO-1' });
  assert.equal(ok.status, 303);
  assert.equal((await variantBySku(s.app, 'AUR-POC-50')).stock, v.stock + 10);
  const mv = await s.app.db.one<{ delta: number; balance_after: number; reason: string }>(
    `SELECT delta, balance_after, reason FROM stock_movements WHERE variant_id = $1 ORDER BY id DESC LIMIT 1`,
    [v.id],
  );
  assert.deepEqual(mv, { delta: 10, balance_after: v.stock + 10, reason: 'restock' });

  await staff.get('/admin/inventory/batches');
  const badBatch = await staff.post('/admin/inventory/batches', { variantId: v.id, batchNo: 'B1', mfgDate: '2026-10-01', expiryDate: '2026-09-01', quantity: '5' });
  assert.equal(badBatch.status, 422);
  const batch = await staff.post('/admin/inventory/batches', { variantId: v.id, batchNo: 'TESTB-01', mfgDate: '2026-08-01', expiryDate: '2028-08-01', quantity: '5' });
  assert.equal(batch.status, 303);
  assert.ok(await s.app.db.one(`SELECT 1 FROM inventory_batches WHERE batch_no = 'TESTB-01'`));
  const dash = await staff.get('/admin');
  assert.match(dash.text, /Low stock/);
  assert.match(dash.text, /expired|days/, 'expiring batches surfaced');
});

test('order fulfilment: status transitions are validated; shipment required before shipped', async () => {
  const { c, email } = await newCustomer(s.url, s.app);
  const v = await variantBySku(s.app, 'KSB-OBW-250');
  await c.postJson('/api/cart/items', { variantId: v.id, quantity: 2 });
  const num = /GD-\d+/.exec((await checkout(c, s.app, email, 'cod')).location!)![0];
  const id = (await s.app.db.one<{ id: string }>('SELECT id FROM orders WHERE number = $1', [num]))!.id;
  await staff.get(`/admin/orders/${id}`);
  const skip = await staff.post(`/admin/orders/${id}/status`, { status: 'delivered' });
  assert.equal(skip.status, 422);
  assert.equal((await staff.post(`/admin/orders/${id}/status`, { status: 'processing' })).status, 303);
  const noShip = await staff.post(`/admin/orders/${id}/status`, { status: 'shipped' });
  assert.equal(noShip.status, 422);
  const badUrl = await staff.post(`/admin/orders/${id}/shipment`, { carrier: 'Demo Courier', trackingNumber: 'TRK123456', trackingUrl: 'http://insecure.example/t' });
  assert.equal(badUrl.status, 422);
  assert.equal(
    (await staff.post(`/admin/orders/${id}/shipment`, { carrier: 'Demo Courier', trackingNumber: 'TRK123456', trackingUrl: 'https://track.example/TRK123456' })).status,
    303,
  );
  assert.equal((await s.app.db.one<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id]))!.status, 'shipped');
  assert.equal((await staff.post(`/admin/orders/${id}/status`, { status: 'delivered' })).status, 303);
  const o = await s.app.db.one<{ status: string; payment_status: string }>('SELECT status, payment_status FROM orders WHERE id = $1', [id]);
  assert.deepEqual(o, { status: 'delivered', payment_status: 'cod_collected' });
  const detail = await c.get(`/account/orders/${num}`);
  assert.match(detail.text, /TRK123456/);

  // Return → approve → received (restock) → refunded
  await c.post(`/account/orders/${num}/return`, { reason: 'damaged', details: 'Leaking bottle' });
  const ret = await s.app.db.one<{ id: string }>(`SELECT r.id FROM return_requests r WHERE r.order_id = $1`, [id]);
  const before = (await variantBySku(s.app, 'KSB-OBW-250')).stock;
  await staff.get('/admin/returns');
  assert.equal((await staff.post(`/admin/returns/${ret!.id}`, { status: 'approved' })).status, 303);
  assert.equal((await staff.post(`/admin/returns/${ret!.id}`, { status: 'received', restock: 'on' })).status, 303);
  assert.equal((await variantBySku(s.app, 'KSB-OBW-250')).stock, before + 2, 'returned stock added back');
  assert.equal((await staff.post(`/admin/returns/${ret!.id}`, { status: 'refunded', refund: '698', reference: 'UPI-REF-1' })).status, 303);
  const r2 = await s.app.db.one<{ status: string; refund_paise: number }>('SELECT status, refund_paise FROM return_requests WHERE id = $1', [ret!.id]);
  assert.deepEqual(r2, { status: 'refunded', refund_paise: 69800 });
  assert.match((await c.get(`/account/orders/${num}`)).text, /[Rr]efund/);
});

test('admin: coupons, settings, staff roles, customers, reports and CSV export', async () => {
  await admin.get('/admin/coupons');
  const bad = await admin.post('/admin/coupons', { code: 'x', kind: 'percent', value: '95' });
  assert.equal(bad.status, 422);
  const ok = await admin.post('/admin/coupons', {
    code: 'TEST15',
    description: 'Test',
    kind: 'percent',
    value: '15',
    minSubtotal: '300',
    perUserLimit: '1',
    excludePharmacy: 'on',
  });
  assert.equal(ok.status, 303);
  assert.equal((await admin.post('/admin/coupons', { code: 'test15', kind: 'fixed', value: '50' })).status, 422, 'duplicate code');
  const cp = await s.app.db.one<{ id: string; value: number; min_subtotal_paise: number }>(`SELECT id, value, min_subtotal_paise FROM coupons WHERE code = 'TEST15'`);
  assert.deepEqual({ value: cp!.value, min: cp!.min_subtotal_paise }, { value: 15, min: 30000 });
  assert.equal((await admin.post(`/admin/coupons/${cp!.id}/toggle`, {})).status, 303);

  await admin.get('/admin/settings');
  const ship = await admin.post('/admin/settings/shipping', {
    flatFee: '59',
    freeThreshold: '599',
    codEnabled: 'on',
    codFee: '25',
    codMax: '4000',
    blocked: '744, 682551',
    dispatchTime: '1 day',
    deliveryEstimate: '2–5 days',
    returnWindow: '7',
    reservation: '30',
  });
  assert.equal(ship.status, 303);
  const st = await s.app.settings.all();
  assert.equal(st.shipping.flatFeePaise, 5900);
  assert.deepEqual(st.shipping.blockedPincodePrefixes, ['744', '682551']);
  const badShip = await admin.post('/admin/settings/shipping', {
    flatFee: 'abc',
    freeThreshold: '599',
    codFee: '0',
    codMax: '0',
    blocked: '0123',
    dispatchTime: '',
    deliveryEstimate: '',
    returnWindow: '7',
    reservation: '30',
  });
  assert.equal(badShip.status, 422);
  assert.ok(await s.app.db.one(`SELECT 1 FROM audit_logs WHERE action = 'settings.updated' AND entity_id = 'shipping'`));

  // Blocked PIN prefix refuses checkout
  const { c, email, uid } = await newCustomer(s.url, s.app);
  await s.app.db.query(`UPDATE addresses SET pincode = '744101' WHERE user_id = $1`, [uid]);
  await c.postJson('/api/cart/items', { variantId: (await variantBySku(s.app, 'MWL-SCT-100')).id, quantity: 1 });
  const blocked = await checkout(c, s.app, email, 'cod');
  assert.equal(blocked.status, 422);
  assert.match(blocked.text, /do not deliver to PIN code 744101/);

  // Staff role management safeguards
  await admin.get('/admin/users');
  assert.equal((await admin.post('/admin/users', { email: 'admin@glowderma.test', role: 'customer' })).status, 422, 'cannot demote yourself');
  assert.equal((await admin.post('/admin/users', { email: email, role: 'pharmacist' })).status, 422, 'pharmacist needs a reg. number');
  assert.equal((await admin.post('/admin/users', { email: email, role: 'staff' })).status, 303);
  assert.equal((await s.app.db.one<{ role: string }>('SELECT role FROM users WHERE id = $1', [uid]))!.role, 'staff');
  assert.equal((await c.get('/account')).status, 303, 'sessions revoked after role change');

  // Customer records: viewing is audited; disabling signs the customer out
  const cust = await s.app.db.one<{ id: string }>(`SELECT id FROM users WHERE email = 'customer@glowderma.test'`);
  assert.equal((await admin.get(`/admin/customers/${cust!.id}`)).status, 200);
  assert.ok(await s.app.db.one(`SELECT 1 FROM audit_logs WHERE action = 'customer.viewed' AND entity_id = $1`, [cust!.id]));
  const cc = new Client(s.url);
  await cc.login('customer@glowderma.test');
  assert.equal((await admin.post(`/admin/customers/${cust!.id}/toggle`, {})).status, 303);
  assert.equal((await cc.get('/account')).status, 303, 'disabled customer signed out');
  const relog = await new Client(s.url).post('/login', { email: 'customer@glowderma.test', password: 'GlowDemo#2026' });
  assert.notEqual(relog.status, 303, 'disabled customer cannot sign in');
  await admin.post(`/admin/customers/${cust!.id}/toggle`, {});

  // Reports + CSV
  const rep = await admin.get('/admin/reports?from=2020-01-01&to=2030-12-31');
  assert.equal(rep.status, 200);
  assert.match(rep.text, /Gross sales/);
  const csv = await admin.get('/admin/reports/export.csv?from=2020-01-01&to=2030-12-31');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type')!, /text\/csv/);
  assert.match(csv.text, /^number,created_at,status/);
  assert.doesNotMatch(csv.text, /@/, 'no customer emails in the export');
  const audit = await admin.get('/admin/audit?action=settings');
  assert.match(audit.text, /settings.updated/);
});

test('taxonomy: create category and brand, reject duplicate slugs, toggle category', async () => {
  await staff.get('/admin/taxonomy');
  const cat = await staff.post('/admin/taxonomy/categories', { name: 'Lip care', slug: 'lip-care', description: 'Balms', department: 'skincare', sortOrder: '50', isActive: 'on' });
  assert.equal(cat.status, 303);
  assert.equal((await staff.post('/admin/taxonomy/categories', { name: 'Lip care 2', slug: 'lip-care', department: 'skincare' })).status, 422);
  assert.equal((await staff.post('/admin/taxonomy/categories', { name: 'X', slug: 'Bad Slug', department: 'mars' })).status, 422);
  const brand = await staff.post('/admin/taxonomy/brands', { name: 'Test Brand', slug: 'test-brand', description: 'Fictional' });
  assert.equal(brand.status, 303);
  assert.equal((await staff.post('/admin/taxonomy/brands', { name: 'Test Brand', slug: 'test-brand' })).status, 422);
  const id = (await s.app.db.one<{ id: string }>(`SELECT id FROM categories WHERE slug = 'lip-care'`))!.id;
  assert.equal((await staff.post(`/admin/taxonomy/categories/${id}/toggle`, {})).status, 303);
  assert.equal((await s.app.db.one<{ is_active: boolean }>('SELECT is_active FROM categories WHERE id = $1', [id]))!.is_active, false);
  assert.equal((await new Client(s.url).get('/c/lip-care')).status, 404, 'inactive categories are hidden');
});

test('customer account: addresses (add, edit, default, delete) and password change', async () => {
  const { c, uid } = await newCustomer(s.url, s.app);
  await c.get('/account/addresses/new');
  const add = await c.post('/account/addresses/new', {
    label: 'Office',
    fullName: 'Test Customer',
    phone: '9876543210',
    line1: '5 Work St',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600001',
  });
  assert.equal(add.status, 303);
  const a = await s.app.db.one<{ id: string; is_default: boolean }>(`SELECT id, is_default FROM addresses WHERE user_id = $1 AND label = 'Office'`, [uid]);
  assert.equal(a!.is_default, false);
  await c.get(`/account/addresses/${a!.id}`);
  const edit = await c.post(`/account/addresses/${a!.id}`, {
    label: 'Office',
    fullName: 'Test Customer',
    phone: '9876543210',
    line1: '6 Work St',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600002',
  });
  assert.equal(edit.status, 303);
  assert.equal((await c.post(`/account/addresses/${a!.id}/default`, {})).status, 303);
  const rows = await s.app.db.many<{ id: string; is_default: boolean; pincode: string }>('SELECT id, is_default, pincode FROM addresses WHERE user_id = $1', [uid]);
  assert.equal(rows.filter((r) => r.is_default).length, 1, 'exactly one default address');
  assert.equal(rows.find((r) => r.id === a!.id)!.pincode, '600002');
  assert.equal((await c.post(`/account/addresses/${a!.id}/delete`, {})).status, 303);
  assert.equal(await s.app.db.one('SELECT 1 FROM addresses WHERE id = $1', [a!.id]), null);

  await c.get('/account/settings');
  const wrong = await c.post('/account/settings/password', { current: 'nope-nope-1', password: 'Brand-New-Pass-9', confirm: 'Brand-New-Pass-9' });
  assert.equal(wrong.status, 422);
  const ok = await c.post('/account/settings/password', { current: 'Str0ng-pass!', password: 'Brand-New-Pass-9', confirm: 'Brand-New-Pass-9' });
  assert.equal(ok.status, 303);
  assert.equal((await c.get('/account')).status, 200, 'current session kept after password change');
});
