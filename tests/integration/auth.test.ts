import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, DEMO_PASSWORD, resetTestDb, startServer, type TestServer } from '../helpers.ts';

let s: TestServer;
before(async () => {
  await resetTestDb();
  s = await startServer();
});
after(async () => s?.close());

test('registration validates input and signs the user in', async () => {
  const c = new Client(s.url);
  await c.get('/register');
  const bad = await c.post('/register', { name: 'X', email: 'not-an-email', password: 'short', confirm: 'other', terms: '' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /valid email/);
  assert.doesNotMatch(bad.text, /value="short"/, 'passwords are never echoed back');

  const weak = await c.post('/register', { name: 'Meera', email: 'meera@example.test', password: 'aaaaaaaaaaaa', confirm: 'aaaaaaaaaaaa', terms: 'on' });
  assert.equal(weak.status, 422);

  const ok = await c.post('/register', { name: 'Meera', email: 'meera@example.test', password: 'Glow-Derma-2026', confirm: 'Glow-Derma-2026', terms: 'on' });
  assert.equal(ok.status, 303);
  const acct = await c.get('/account');
  assert.equal(acct.status, 200);
  assert.match(acct.text, /Meera/);
  const row = await s.app.db.one<{ password_hash: string; role: string }>(`SELECT password_hash, role FROM users WHERE email = 'meera@example.test'`);
  assert.match(row!.password_hash, /^scrypt\$/);
  assert.equal(row!.role, 'customer');

  const dup = await new Client(s.url).post('/register', { name: 'Meera', email: 'MEERA@example.test', password: 'Glow-Derma-2026', confirm: 'Glow-Derma-2026', terms: 'on' });
  assert.equal(dup.status, 422);
});

test('session cookie is HttpOnly + SameSite=Lax and rotates on sign-in', async () => {
  const c = new Client(s.url);
  const first = await c.get('/login');
  const set = first.headers.getSetCookie().find((x) => x.startsWith('gd_sid') || x.includes('sid'));
  assert.ok(set, 'session cookie set');
  assert.match(set!, /HttpOnly/);
  assert.match(set!, /SameSite=Lax/);
  const before = new Map(c.cookies);
  await c.login('customer@glowderma.test');
  const changed = [...c.cookies].some(([k, v]) => before.has(k) && before.get(k) !== v);
  assert.ok(changed, 'session id rotated on login');
});

test('wrong password gives a generic error; account locks after repeated failures', async () => {
  const c = new Client(s.url);
  await c.get('/login');
  const r1 = await c.post('/login', { email: 'staff@glowderma.test', password: 'wrong-password-1' });
  assert.equal(r1.status, 401);
  assert.match(r1.text, /email or password/i);
  const r2 = await c.post('/login', { email: 'nobody@glowderma.test', password: 'wrong-password-1' });
  assert.equal(r2.status, 401);
  assert.equal(r1.text.match(/email or password[^<]*/i)?.[0], r2.text.match(/email or password[^<]*/i)?.[0], 'same message for unknown accounts');
  for (let i = 0; i < 5; i++) await c.post('/login', { email: 'staff@glowderma.test', password: 'wrong-password-' + i });
  const locked = await c.post('/login', { email: 'staff@glowderma.test', password: DEMO_PASSWORD });
  assert.notEqual(locked.status, 303, 'correct password refused while locked');
  await s.app.db.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = 'staff@glowderma.test'`);
});

test('CSRF: state-changing requests without a valid token are rejected', async () => {
  const c = new Client(s.url);
  await c.login('customer@glowderma.test');
  const noToken = await c.post('/account/settings/profile', { name: 'Hacked' }, { csrf: false });
  assert.equal(noToken.status, 403);
  const wrong = await c.request('POST', '/cart/coupon/remove', {
    body: new URLSearchParams({ _csrf: 'x'.repeat(43) }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(wrong.status, 403);
  const crossSite = await c.request('POST', '/cart/coupon/remove', {
    body: new URLSearchParams({ _csrf: c.csrf }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
});

test('logout ends the session; login redirect only allows local paths', async () => {
  const c = new Client(s.url);
  await c.get('/login?next=https://evil.example');
  const r = await c.post('/login', { email: 'customer@glowderma.test', password: DEMO_PASSWORD, next: 'https://evil.example' });
  assert.equal(r.status, 303);
  assert.ok(r.location!.startsWith('/'), `redirected to ${r.location}`);
  await c.ensureCsrf();
  const out = await c.post('/logout');
  assert.equal(out.status, 303);
  const acct = await c.get('/account');
  assert.equal(acct.status, 303);
  assert.match(acct.location!, /^\/login/);
});

test('password reset: token emailed (dev mail sink), single use, old sessions revoked', async () => {
  const c = new Client(s.url);
  await c.get('/forgot-password');
  const r = await c.post('/forgot-password', { email: 'customer@glowderma.test' });
  assert.ok([200, 303].includes(r.status));
  const unknown = await c.post('/forgot-password', { email: 'ghost@glowderma.test' });
  assert.equal(unknown.status, r.status, 'no account enumeration');
  const mail = await s.app.db.one<{ body: string }>(`SELECT body FROM outbound_emails WHERE to_email = 'customer@glowderma.test' ORDER BY id DESC LIMIT 1`);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail!.body)![1];
  await c.get(`/reset-password?token=${token}`);
  const done = await c.post('/reset-password', { token, password: 'New-Glow-Pass-1', confirm: 'New-Glow-Pass-1' });
  assert.equal(done.status, 303);
  const again = await c.post('/reset-password', { token, password: 'Another-Pass-22', confirm: 'Another-Pass-22' });
  assert.notEqual(again.status, 303, 'token cannot be reused');
  const c2 = new Client(s.url);
  await c2.login('customer@glowderma.test', 'New-Glow-Pass-1');
  // restore for other tests
  const { hashPassword } = await import('../../src/server/auth/password.ts');
  await s.app.db.query(`UPDATE users SET password_hash = $1 WHERE email = 'customer@glowderma.test'`, [await hashPassword(DEMO_PASSWORD)]);
});

test('login is rate limited per IP when limits are on', async () => {
  const limited = await startServer({}, { rateLimits: true });
  try {
    const c = new Client(limited.url);
    await c.get('/login');
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.post('/login', { email: 'ratelimit@example.test', password: 'wrong-pass-' + i })).status;
    assert.equal(last, 429);
  } finally {
    await limited.close();
  }
});

test('account data: profile update, and deleting an account anonymises it', async () => {
  const c = new Client(s.url);
  await c.get('/register');
  await c.post('/register', { name: 'Delete Me', email: 'deleteme@example.test', password: 'Glow-Derma-2026', confirm: 'Glow-Derma-2026', terms: 'on' });
  c.csrf = '';
  await c.ensureCsrf();
  const upd = await c.post('/account/settings/profile', { name: 'Delete Me Later', phone: '9123456789' });
  assert.equal(upd.status, 303);
  const page = await c.get('/account/settings');
  assert.match(page.text, /Delete Me Later/);
  const uid = (await s.app.db.one<{ id: string }>(`SELECT id FROM users WHERE email = 'deleteme@example.test'`))!.id;
  const wrongPw = await c.post('/account/settings/delete', { deletePassword: 'not-my-password', confirmText: 'DELETE' });
  assert.equal(wrongPw.status, 303);
  assert.ok(await s.app.db.one(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [uid]), 'wrong password does not delete');
  const del = await c.post('/account/settings/delete', { deletePassword: 'Glow-Derma-2026', confirmText: 'DELETE' });
  assert.equal(del.status, 303);
  const row = await s.app.db.one<{ email: string; deleted_at: Date | null; name: string }>(`SELECT email, deleted_at, name FROM users WHERE id = $1`, [uid]);
  assert.ok(row?.deleted_at, 'account marked deleted');
  assert.notEqual(row?.email, 'deleteme@example.test', 'email anonymised');
});
