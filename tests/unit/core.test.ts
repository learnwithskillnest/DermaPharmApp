import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatINR, percentOff, rupeesToPaise } from '../../src/shared/money.ts';
import { hashPassword, passwordProblem, verifyPassword } from '../../src/server/auth/password.ts';
import { phoneField, addressSchema, cartAddSchema, cartUpdateSchema, couponSchema, parseWith, placeOrderSchema, registerSchema, trackSchema } from '../../src/server/validation.ts';
import { safeNext } from '../../src/server/http/context.ts';
import { RateLimiter } from '../../src/server/http/rate-limit.ts';
import { SandboxProvider } from '../../src/server/services/payments/sandbox.ts';
import { RazorpayProvider } from '../../src/server/services/payments/razorpay.ts';
import { hmacHex, safeEqualHex } from '../../src/server/services/payments/provider.ts';
import { can, ALL_PERMISSIONS } from '../../src/server/auth/permissions.ts';
import { sniffMime } from '../../src/server/services/prescriptions.ts';
import { readConfig } from '../../src/server/config.ts';
import { serializeCookie } from '../../src/server/http/cookies.ts';

test('money helpers', () => {
  assert.equal(formatINR(34900), '₹349');
  assert.equal(formatINR(123456789), '₹12,34,567.89');
  assert.equal(rupeesToPaise('349'), 34900);
  assert.equal(rupeesToPaise('1,299.50'), 129950);
  assert.equal(rupeesToPaise('abc'), null);
  assert.equal(rupeesToPaise('-5'), null);
  assert.equal(percentOff(39900, 34900), 12);
  assert.equal(percentOff(34900, 34900), 0);
});

test('password hashing (scrypt) and strength rules', async () => {
  const h = await hashPassword('Str0ng-pass!');
  assert.match(h, /^scrypt\$/);
  assert.ok(await verifyPassword('Str0ng-pass!', h));
  assert.ok(!(await verifyPassword('wrong-pass!1', h)));
  assert.notEqual(h, await hashPassword('Str0ng-pass!')); // salted
  assert.match(passwordProblem('short1!')!, /10 characters/);
  assert.match(passwordProblem('password123')!, /common/);
  assert.match(passwordProblem('aaaaaaaaaaaa')!, /Mix/);
  assert.match(passwordProblem('priya-2026-x', 'priya@example.com')!, /email/);
  assert.equal(passwordProblem('Glow-Derma-2026'), null);
});

test('cart quantity validation rejects invalid input', () => {
  const id = '6f1c1b1e-7a2d-4c1a-9a5e-1f2b3c4d5e6f';
  assert.equal(parseWith(cartAddSchema, { variantId: id, quantity: '2' }).ok, true);
  for (const quantity of ['0', '-1', '21', '1.5', 'abc', '']) assert.equal(parseWith(cartAddSchema, { variantId: id, quantity }).ok, false, `qty ${quantity}`);
  assert.equal(parseWith(cartAddSchema, { variantId: 'not-a-uuid', quantity: '1' }).ok, false);
  assert.equal(parseWith(cartUpdateSchema, { variantId: id, quantity: '0' }).ok, true); // 0 = remove
  assert.equal(parseWith(cartUpdateSchema, { variantId: id, quantity: '-3' }).ok, false);
});

test('Indian mobile numbers: country code / trunk prefix stripped only when present', () => {
  const ph = (v: string) => phoneField.safeParse(v);
  for (const [input, out] of [
    ['9123456789', '9123456789'],
    ['+91 91234 56789', '9123456789'],
    ['919123456789', '9123456789'],
    ['09123456789', '9123456789'],
    ['98765-43210', '9876543210'],
  ]) {
    const r = ph(input);
    assert.ok(r.success, input);
    if (r.success) assert.equal(r.data, out, input);
  }
  for (const bad of ['5123456789', '12345', '+1 415 555 0100', '91234567890123']) assert.equal(ph(bad).success, false, bad);
});

test('address validation (Indian PIN, phone, state)', () => {
  const ok = { fullName: 'Asha', phone: '9876543210', line1: '1 Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
  assert.equal(parseWith(addressSchema, ok).ok, true);
  const bad = parseWith(addressSchema, { ...ok, pincode: '011001', phone: '12345', state: 'Atlantis' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.pincode && bad.errors.phone && bad.errors.state);
  }
});

test('registration, coupon, order and tracking schemas', () => {
  const r = parseWith(registerSchema, { name: 'A', email: 'bad', password: 'x', confirm: 'y', terms: '' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.email && r.errors.confirm && r.errors.terms);
  assert.equal(parseWith(couponSchema, { code: 'welcome10' }).ok, true);
  assert.equal(parseWith(couponSchema, { code: "x'; drop table" }).ok, false);
  const po = parseWith(placeOrderSchema, { addressId: '', paymentMethod: 'bitcoin', idempotencyKey: 'short', acceptTerms: '' });
  assert.equal(po.ok, false);
  if (!po.ok) assert.ok(po.errors.addressId && po.errors.paymentMethod && po.errors.idempotencyKey && po.errors.acceptTerms);
  assert.equal(parseWith(trackSchema, { number: 'gd-1001', email: 'a@b.co' }).ok, true);
});

test('safeNext blocks open redirects', () => {
  assert.equal(safeNext('/account'), '/account');
  for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '', null]) assert.equal(safeNext(bad as string), '/');
});

test('rate limiter blocks after the limit and resets', () => {
  const l = new RateLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) assert.equal(l.hit('login', 'a@b.c', now), 0);
  assert.ok(l.hit('login', 'a@b.c', now) > 0);
  assert.equal(l.hit('login', 'other@b.c', now), 0);
  assert.equal(l.hit('login', 'a@b.c', now + 16 * 60_000), 0); // window passed
  l.reset('login', 'a@b.c');
  l.stop();
});

test('sandbox gateway signatures verify and reject tampering', () => {
  const p = new SandboxProvider(null as never, 'x'.repeat(40));
  const sig = p.sign('sbx_order_1', 'sbx_pay_1');
  assert.ok(p.verifyClientSignature({ providerOrderId: 'sbx_order_1', providerPaymentId: 'sbx_pay_1', signature: sig }));
  assert.ok(!p.verifyClientSignature({ providerOrderId: 'sbx_order_2', providerPaymentId: 'sbx_pay_1', signature: sig }));
  assert.ok(!p.verifyClientSignature({ providerOrderId: 'sbx_order_1', providerPaymentId: 'sbx_pay_1', signature: 'deadbeef' }));
  assert.ok(!p.verifyClientSignature({ providerOrderId: 'sbx_order_1', providerPaymentId: 'sbx_pay_1', signature: '' }));
  const hook = p.buildWebhook({ type: 'payment.captured', orderId: 'sbx_order_1', paymentId: 'sbx_pay_1', amountPaise: 1000 });
  assert.equal(p.parseWebhook(hook.body, hook.headers)?.outcome, 'captured');
  const tampered = Buffer.from(hook.body.toString().replace('1000', '1'));
  assert.equal(p.parseWebhook(tampered, hook.headers), null);
});

test('Razorpay signature checks follow the documented HMAC scheme', () => {
  const rp = new RazorpayProvider('rzp_test_dummy', 'key_secret_for_tests', 'webhook_secret_for_tests');
  const sig = hmacHex('key_secret_for_tests', 'order_ABC|pay_XYZ');
  assert.ok(rp.verifyClientSignature({ providerOrderId: 'order_ABC', providerPaymentId: 'pay_XYZ', signature: sig }));
  assert.ok(!rp.verifyClientSignature({ providerOrderId: 'order_ABC', providerPaymentId: 'pay_OTHER', signature: sig }));
  const body = Buffer.from(
    JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_XYZ', order_id: 'order_ABC', amount: 5000, status: 'captured' } } } }),
  );
  const ev = rp.parseWebhook(body, { 'x-razorpay-signature': hmacHex('webhook_secret_for_tests', body), 'x-razorpay-event-id': 'evt_1' });
  assert.equal(ev?.outcome, 'captured');
  assert.equal(ev?.amountPaise, 5000);
  assert.equal(rp.parseWebhook(body, { 'x-razorpay-signature': hmacHex('wrong', body) }), null);
  assert.ok(!safeEqualHex('zz', 'zz'));
});

test('permission matrix: customers have no admin permissions; documents are pharmacist-only', () => {
  for (const p of ALL_PERMISSIONS) assert.equal(can('customer', p), false, p);
  assert.equal(can(null, 'admin.access'), false);
  assert.equal(can('admin', 'rx.documents'), false);
  assert.equal(can('pharmacist', 'rx.documents'), true);
  assert.equal(can('staff', 'settings.manage'), false);
  assert.equal(can('pharmacist', 'products.manage'), false);
});

test('prescription upload type is sniffed from content, not the file name', () => {
  assert.equal(sniffMime(Buffer.from('%PDF-1.7 ...')), 'application/pdf');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffMime(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(sniffMime(Buffer.from('MZ\x90\x00')), null);
});

test('configuration refuses unsafe production settings', () => {
  const base = { DATABASE_URL: 'postgres://u:p@h/db', SESSION_SECRET: 's'.repeat(40), SANDBOX_PAYMENT_SECRET: 'x'.repeat(40) };
  assert.throws(() => readConfig({ ...base, NODE_ENV: 'production', APP_URL: 'http://shop.example' }), /https|Sandbox|MAIL_DRIVER/);
  assert.throws(() => readConfig({ ...base, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => readConfig({ ...base, PAYMENT_PROVIDER: 'razorpay' }), /RAZORPAY_KEY_ID/);
  assert.equal(readConfig(base).ENABLE_PRESCRIPTION_ORDERING, false);
});

test('session cookies are HttpOnly and SameSite', () => {
  const c = serializeCookie('gd_sid', 'abc', { httpOnly: true, sameSite: 'Lax', secure: true, path: '/' });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
});
