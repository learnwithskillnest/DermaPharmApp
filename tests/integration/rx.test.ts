import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkout, Client, newCustomer, resetTestDb, startServer, variantBySku, type TestServer } from '../helpers.ts';

let s: TestServer;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

before(async () => {
  await resetTestDb();
});
after(async () => {
  if (s) await s.close();
});

async function enableRxSettings(app: TestServer['app']) {
  const cur = await app.settings.all();
  await app.settings.update(
    'pharmacy',
    { ...cur.pharmacy, rxOrderingEnabled: true, drugLicenceNumbers: 'TEST-DL-20B-0001, TEST-DL-21B-0001', pharmacistName: 'Demo Pharmacist', pharmacistRegNo: 'DEMO-PHARM-0001' },
    null,
  );
}

test('Rx ordering stays OFF unless the server flag AND every store condition are met', async () => {
  s = await startServer({ ENABLE_PRESCRIPTION_ORDERING: 'false' });
  const blockers = await s.app.settings.rxOrderingBlockers();
  assert.ok(blockers.some((b) => /ENABLE_PRESCRIPTION_ORDERING/.test(b)));
  assert.ok(blockers.some((b) => /licence/.test(b)));
  await enableRxSettings(s.app);
  assert.equal(await s.app.settings.rxOrderingEnabled(), false, 'admin settings alone cannot enable it');
  const page = await new Client(s.url).get('/p/tretinoin-0025-cream-rx-demo');
  assert.equal(page.status, 200);
  assert.match(page.text, /Prescription required/);
  assert.match(page.text, /not available/i);
  assert.doesNotMatch(page.text, />Add to cart</, 'no add-to-cart button while disabled');
  await s.close();
  s = undefined as unknown as TestServer;
});

test('Rx listings can be hidden entirely from the storefront', async () => {
  s = await startServer();
  const cur = await s.app.settings.all();
  await s.app.settings.update('pharmacy', { ...cur.pharmacy, rxListingVisible: false }, null);
  const c = new Client(s.url);
  assert.equal((await c.get('/p/tretinoin-0025-cream-rx-demo')).status, 404);
  assert.doesNotMatch((await c.get('/pharmacy')).text, /Tretinoin/);
  assert.doesNotMatch((await c.get('/search?q=tretinoin')).text, /Tretinoin 0.025% Cream/);
  await s.app.settings.update('pharmacy', { ...cur.pharmacy, rxListingVisible: true }, null);
  await s.close();
  s = undefined as unknown as TestServer;
});

test('with licensing in place: upload → pharmacist review → order held for Rx review → dispatch gated', async () => {
  s = await startServer({ ENABLE_PRESCRIPTION_ORDERING: 'true' });
  await enableRxSettings(s.app);
  assert.equal(await s.app.settings.rxOrderingEnabled(), true);

  const { c, email } = await newCustomer(s.url, s.app);
  const rx = await variantBySku(s.app, 'SPC-TRT-20');
  assert.equal((await c.postJson('/api/cart/items', { variantId: rx.id, quantity: 1 })).status, 200);

  // Cannot check out without an approved prescription
  const noRx = await checkout(c, s.app, email);
  assert.equal(noRx.status, 422);
  assert.match(noRx.text, /approved prescription/);

  // Upload validation: content sniffing, required consent
  await c.get('/account/prescriptions');
  const fake = await c.postMultipart(
    '/account/prescriptions',
    { patientName: 'Test Customer', consent: 'on' },
    { field: 'file', filename: 'rx.png', type: 'image/png', data: Buffer.from('<script>alert(1)</script>') },
  );
  assert.equal(fake.status, 422);
  assert.match(fake.text, /PDF, JPG or PNG/);
  const noConsent = await c.postMultipart('/account/prescriptions', { patientName: 'Test Customer' }, { field: 'file', filename: 'rx.png', type: 'image/png', data: PNG });
  assert.equal(noConsent.status, 422);
  const up = await c.postMultipart(
    '/account/prescriptions',
    { patientName: 'Test Customer', doctorName: 'Dr Demo', consent: 'on' },
    { field: 'file', filename: 'rx.png', type: 'image/png', data: PNG },
  );
  assert.equal(up.status, 303);
  const rxRow = await s.app.db.one<{ id: string; status: string; storage_key: string }>(
    `SELECT p.id, p.status, p.storage_key FROM prescriptions p JOIN users u ON u.id = p.user_id WHERE u.email = $1`,
    [email],
  );
  assert.equal(rxRow!.status, 'pending');
  assert.doesNotMatch(rxRow!.storage_key, /rx\.png/, 'stored under a random name');

  // File access: owner yes; other customers, guests, admins and staff no; pharmacist yes (audited)
  const own = await c.get(`/account/prescriptions/${rxRow!.id}/file`);
  assert.equal(own.status, 200);
  assert.match(own.headers.get('cache-control')!, /no-store/);
  assert.match(own.headers.get('content-security-policy')!, /sandbox/);
  const other = await newCustomer(s.url, s.app);
  assert.equal((await other.c.get(`/account/prescriptions/${rxRow!.id}/file`)).status, 404);
  assert.equal((await new Client(s.url).get(`/account/prescriptions/${rxRow!.id}/file`)).status, 303);
  const admin = new Client(s.url);
  await admin.login('admin@glowderma.test');
  assert.equal((await admin.get(`/admin/prescriptions/${rxRow!.id}/file`)).status, 403, 'admins cannot open prescription documents');
  const pharm = new Client(s.url);
  await pharm.login('pharmacist@glowderma.test');
  assert.equal((await pharm.get(`/admin/prescriptions/${rxRow!.id}/file`)).status, 200);
  assert.ok(
    await s.app.db.one(`SELECT 1 FROM audit_logs WHERE action LIKE 'prescription.%view%' OR action LIKE 'prescription.file%' OR action LIKE 'prescription.document%'`),
    'document access is audited',
  );

  // Admin cannot approve; pharmacist can, rejection needs a note
  assert.equal((await admin.post(`/admin/prescriptions/${rxRow!.id}`, { decision: 'approved' })).status, 403);
  await pharm.get(`/admin/prescriptions/${rxRow!.id}`);
  const noNote = await pharm.post(`/admin/prescriptions/${rxRow!.id}`, { decision: 'rejected' });
  assert.equal(noNote.status, 422);
  const ok = await pharm.post(`/admin/prescriptions/${rxRow!.id}`, { decision: 'approved', doctorRegNo: 'MCI-TEST-1' });
  assert.equal(ok.status, 303);

  // COD not allowed for Rx; online order is held for review
  const cod = await checkout(c, s.app, email, 'cod', { prescriptionId: rxRow!.id });
  assert.equal(cod.status, 422);
  const placed = await checkout(c, s.app, email, 'online', { prescriptionId: rxRow!.id });
  assert.equal(placed.status, 303, placed.text.slice(0, 300));
  const num = /GD-\d+/.exec(placed.location!)![0];
  const o = await s.app.db.one<{ id: string; requires_rx_review: boolean; rx_review_status: string }>(
    'SELECT id, requires_rx_review, rx_review_status FROM orders WHERE number = $1',
    [num],
  );
  assert.equal(o!.requires_rx_review, true);
  assert.equal(o!.rx_review_status, 'pending');

  // Pay, then staff cannot pack until the pharmacist approves the order
  await s.app.db.query(`UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = $1`, [o!.id]);
  const staff = new Client(s.url);
  await staff.login('staff@glowderma.test');
  await staff.get(`/admin/orders/${o!.id}`);
  const pack = await staff.post(`/admin/orders/${o!.id}/status`, { status: 'processing' });
  assert.equal(pack.status, 422);
  assert.match(pack.text, /pharmacist must approve/);
  assert.equal((await staff.post(`/admin/orders/${o!.id}/rx`, { decision: 'approved' })).status, 403, 'staff cannot approve Rx');
  await pharm.get(`/admin/orders/${o!.id}`);
  assert.equal((await pharm.post(`/admin/orders/${o!.id}/rx`, { decision: 'approved' })).status, 303);
  assert.equal((await staff.post(`/admin/orders/${o!.id}/status`, { status: 'processing' })).status, 303);
  await s.close();
  s = undefined as unknown as TestServer;
});
