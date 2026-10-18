import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, resetTestDb, startServer, type TestServer } from '../helpers.ts';
import { can, type Role } from '../../src/server/auth/permissions.ts';

let s: TestServer;
const clients: Partial<Record<Role | 'guest', Client>> = {};
before(async () => {
  await resetTestDb();
  s = await startServer();
  clients.guest = new Client(s.url);
  for (const role of ['customer', 'staff', 'pharmacist', 'admin'] as const) {
    const c = new Client(s.url);
    await c.login(`${role}@glowderma.test`);
    clients[role] = c;
  }
});
after(async () => s?.close());

const FAKE_ID = '00000000-0000-4000-8000-000000000000';
const concrete = (p: string) => p.replace(/:[a-zA-Z]+/g, FAKE_ID);
const adminRoutes = () => s.app.router.routes.filter((r) => r.path.startsWith('/admin'));

test('every admin route declares a permission', () => {
  const routes = adminRoutes();
  assert.ok(routes.length >= 35, `found ${routes.length} admin routes`);
  for (const r of routes) assert.ok(r.opts.perm, `${r.method} ${r.path} has no permission`);
});

test('guests are sent to sign-in for admin pages and refused for admin actions', async () => {
  for (const r of adminRoutes()) {
    const res = r.method === 'GET' ? await clients.guest!.get(concrete(r.path)) : await clients.guest!.post(concrete(r.path), {});
    if (r.method === 'GET') {
      assert.equal(res.status, 303, `${r.path}`);
      assert.match(res.location!, /^\/login\?next=/);
    } else {
      assert.ok([401, 403].includes(res.status), `${r.method} ${r.path} → ${res.status}`);
    }
  }
});

test('customers cannot reach any admin route (GET or POST)', async () => {
  for (const r of adminRoutes()) {
    const res = r.method === 'GET' ? await clients.customer!.get(concrete(r.path)) : await clients.customer!.post(concrete(r.path), {});
    assert.equal(res.status, 403, `${r.method} ${r.path} → ${res.status}`);
  }
});

test('staff and pharmacists only reach routes their role permits', async () => {
  for (const role of ['staff', 'pharmacist'] as const) {
    for (const r of adminRoutes()) {
      if (can(role, r.opts.perm!)) continue;
      const res = r.method === 'GET' ? await clients[role]!.get(concrete(r.path)) : await clients[role]!.post(concrete(r.path), {});
      assert.equal(res.status, 403, `${role} ${r.method} ${r.path} → ${res.status}`);
    }
  }
});

test('permitted roles can open their admin pages', async () => {
  const pages: Array<[Role, string]> = [
    ['admin', '/admin'],
    ['admin', '/admin/settings'],
    ['admin', '/admin/customers'],
    ['admin', '/admin/coupons'],
    ['admin', '/admin/reports'],
    ['admin', '/admin/audit'],
    ['admin', '/admin/users'],
    ['staff', '/admin'],
    ['staff', '/admin/orders'],
    ['staff', '/admin/products'],
    ['staff', '/admin/products/new'],
    ['staff', '/admin/taxonomy'],
    ['staff', '/admin/inventory'],
    ['staff', '/admin/inventory/batches'],
    ['staff', '/admin/returns'],
    ['staff', '/admin/messages'],
    ['pharmacist', '/admin'],
    ['pharmacist', '/admin/prescriptions'],
  ];
  for (const [role, p] of pages) assert.equal((await clients[role]!.get(p)).status, 200, `${role} ${p}`);
  // Staff do not see sales figures they are not entitled to on reports
  assert.equal((await clients.staff!.get('/admin/reports')).status, 403);
  assert.equal((await clients.pharmacist!.get('/admin/products')).status, 403);
});

test('customer data is isolated between accounts', async () => {
  const other = new Client(s.url);
  await other.get('/register');
  await other.post('/register', { name: 'Other', email: 'other@example.test', password: 'Glow-Derma-2026', confirm: 'Glow-Derma-2026', terms: 'on' });
  other.csrf = '';
  const addr = await s.app.db.one<{ id: string }>(`SELECT a.id FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.email = 'customer@glowderma.test'`);
  assert.equal((await other.get(`/account/addresses/${addr!.id}`)).status, 404, 'cannot open another customer address');
  const del = await other.post(`/account/addresses/${addr!.id}/delete`, {});
  assert.ok([303, 404].includes(del.status));
  assert.ok(await s.app.db.one('SELECT 1 FROM addresses WHERE id = $1', [addr!.id]), 'address not deleted by another user');
});

test('admin API errors do not leak stack traces', async () => {
  const r = await clients.admin!.get('/admin/orders/not-a-uuid');
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.text, /at \w+ \(|node_modules|\.ts:\d+/);
});
