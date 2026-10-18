/**
 * Integration-test harness: a freshly migrated + seeded TEST database, an
 * in-process server on a random port, and a cookie-aware HTTP client.
 * Never points at DATABASE_URL — only TEST_DATABASE_URL.
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { loadDotEnv, readConfig, type Config } from '../src/server/config.ts';
import { createApp, type App } from '../src/server/app.ts';
import { createDatabase } from '../src/server/db/db.ts';
import { migrate } from '../src/server/db/migrate.ts';

loadDotEnv();
export const TEST_DB = process.env.TEST_DATABASE_URL ?? '';
if (!TEST_DB || TEST_DB === process.env.DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a separate, disposable database (see .env.example).');
export const DEMO_PASSWORD = 'GlowDemo#2026';

/** Drop & recreate the test schema, migrate, and seed sample data + demo users. */
export async function resetTestDb() {
  const db = createDatabase(TEST_DB, { max: 1 });
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
    await migrate(db, undefined, () => undefined);
  } finally {
    await db.close();
  }
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], {
    env: { ...process.env, DATABASE_URL: TEST_DB, NODE_ENV: 'development', SEED_DEMO_PASSWORD: DEMO_PASSWORD },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('seed failed: ' + r.stderr + r.stdout);
}

export interface TestServer {
  app: App;
  url: string;
  close(): Promise<void>;
}

export async function startServer(env: Record<string, string> = {}, opts: { rateLimits?: boolean } = {}): Promise<TestServer> {
  let app: App | null = null;
  const server = http.createServer((req, res) => void app!.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config: Config = readConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    APP_URL: `http://127.0.0.1:${port}`,
    PRESCRIPTION_STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gd-rx-')),
    PAYMENT_PROVIDER: 'sandbox',
    SANDBOX_PAYMENT_SECRET: 'test-sandbox-secret-0123456789abcdef0123456789',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
    ENABLE_PRESCRIPTION_ORDERING: 'false',
    MAIL_DRIVER: 'database',
    ...env,
  });
  app = createApp(config);
  if (!opts.rateLimits) app.limiter.disabled = true;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await app!.close();
    },
  };
}

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  location: string | null;
  json<T = unknown>(): T;
}

/** Browser-like client: cookie jar, CSRF token from the last HTML page, manual redirects. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly base: string) {}

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(method: string, p: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Res> {
    const res = await fetch(this.base + p, { method, body: init.body, headers: { cookie: this.cookieHeader(), ...(init.headers ?? {}) }, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (k === 'gd_sid' && this.cookies.get(k) !== v) this.csrf = ''; // session rotated: old token is void
      if (/max-age=0/i.test(c) || v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text) ?? /"csrf":"([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location'), json: () => JSON.parse(text) };
  }

  get(p: string, headers?: Record<string, string>) {
    return this.request('GET', p, { headers });
  }

  /** Follows one redirect hop if present and returns the final page. */
  async follow(r: Res): Promise<Res> {
    return r.location ? this.get(r.location) : r;
  }

  async ensureCsrf() {
    if (!this.csrf) await this.get('/contact');
    return this.csrf;
  }

  async post(p: string, form: Record<string, string | number | boolean> = {}, opts: { csrf?: boolean } = {}) {
    if (opts.csrf !== false) await this.ensureCsrf();
    const body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)]));
    if (opts.csrf !== false) body.set('_csrf', this.csrf);
    return this.request('POST', p, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  async postJson(p: string, data: unknown) {
    await this.ensureCsrf();
    return this.request('POST', p, { body: JSON.stringify(data), headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': this.csrf } });
  }

  async postMultipart(p: string, fields: Record<string, string>, file?: { field: string; filename: string; type: string; data: Buffer }) {
    await this.ensureCsrf();
    const fd = new FormData();
    fd.set('_csrf', this.csrf);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    if (file) fd.set(file.field, new Blob([new Uint8Array(file.data)], { type: file.type }), file.filename);
    return this.request('POST', p, { body: fd });
  }

  async login(email: string, password = DEMO_PASSWORD) {
    await this.get('/login');
    const r = await this.post('/login', { email, password });
    if (r.status !== 303) throw new Error(`login failed for ${email}: ${r.status} ${r.text.slice(0, 300)}`);
    this.csrf = ''; // session rotated on sign-in
    await this.ensureCsrf();
    return r;
  }
}

/** Variant + product ids by SKU, straight from the test DB. */
export async function variantBySku(app: App, sku: string) {
  const v = await app.db.one<{ id: string; product_id: string; stock: number; price_paise: number }>(
    'SELECT id, product_id, stock, price_paise FROM product_variants WHERE sku = $1',
    [sku],
  );
  if (!v) throw new Error('unknown sku ' + sku);
  return v;
}

export async function userId(app: App, email: string) {
  return (await app.db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))!.id;
}

/** Places an order through the real checkout form for a signed-in client. */
export async function checkout(c: Client, app: App, email: string, paymentMethod: 'online' | 'cod' = 'online', extra: Record<string, string> = {}) {
  const page = await c.get('/checkout');
  if (page.status !== 200) throw new Error('checkout page ' + page.status + ' ' + page.location);
  const key = /name="idempotencyKey" value="([^"]+)"/.exec(page.text)?.[1];
  const addr = await app.db.one<{ id: string }>('SELECT a.id FROM addresses a JOIN users u ON u.id = a.user_id WHERE u.email = $1 ORDER BY a.is_default DESC LIMIT 1', [email]);
  return c.post('/checkout/place', { addressId: addr!.id, paymentMethod, idempotencyKey: key!, acceptTerms: 'on', note: '', ...extra });
}

let counter = 0;
export async function newCustomer(base: string, app: App) {
  const c = new Client(base);
  const email = `t${Date.now()}${counter++}@example.test`;
  await c.get('/register');
  const r = await c.post('/register', { name: 'Test Customer', email, phone: '9876543210', password: 'Str0ng-pass!', confirm: 'Str0ng-pass!', terms: 'on' });
  if (r.status !== 303) throw new Error('register failed ' + r.status + r.text.slice(0, 500));
  c.csrf = '';
  await c.ensureCsrf();
  const uid = await userId(app, email);
  await app.db.query(
    `INSERT INTO addresses (user_id, full_name, phone, line1, city, state, pincode, is_default) VALUES ($1, 'Test Customer', '9876543210', '1 Test Road', 'Mumbai', 'Maharashtra', '400001', true)`,
    [uid],
  );
  return { c, email, uid };
}
