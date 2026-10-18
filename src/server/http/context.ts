import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { App } from '../app.ts';
import type { ParsedBody } from './body.ts';
import { parseCookies, serializeCookie } from './cookies.ts';
import type { Role } from '../auth/permissions.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
}

export interface SessionData {
  id: string; // hashed id (DB primary key)
  csrfSecret: string;
  userId: string | null;
  lastSeenAt: Date;
  isNew: boolean;
}

export type FlashKind = 'success' | 'error' | 'info';
export interface Flash {
  kind: FlashKind;
  message: string;
}

export class Ctx {
  readonly url: URL;
  readonly method: string;
  readonly cookies: Record<string, string>;
  readonly requestId = crypto.randomUUID();
  readonly nonce = crypto.randomBytes(16).toString('base64');
  readonly ip: string;
  params: Record<string, string> = {};
  session: SessionData | null = null;
  user: SessionUser | null = null;
  body: ParsedBody | null = null;
  flash: Flash | null = null;
  private outCookies: string[] = [];
  responded = false;

  constructor(
    readonly app: App,
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
  ) {
    this.url = new URL(req.url ?? '/', app.config.APP_URL);
    this.method = (req.method ?? 'GET').toUpperCase();
    this.cookies = parseCookies(req.headers.cookie);
    const fwd = app.config.TRUST_PROXY
      ? String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          .trim()
      : '';
    this.ip = fwd || req.socket.remoteAddress || 'unknown';
  }

  get query() {
    return this.url.searchParams;
  }

  get form(): Record<string, string> {
    return this.body?.form ?? {};
  }

  get secureCookies() {
    return this.app.config.APP_URL.startsWith('https://');
  }

  setCookie(name: string, value: string, opts: Parameters<typeof serializeCookie>[2] = {}) {
    this.outCookies.push(serializeCookie(name, value, { secure: this.secureCookies, ...opts }));
  }

  clearCookie(name: string) {
    this.setCookie(name, '', { maxAge: 0 });
  }

  /** CSRF token bound to the session (HMAC of a per-session secret). */
  csrfToken(): string {
    if (!this.session) return '';
    return crypto
      .createHmac('sha256', this.app.config.SESSION_SECRET)
      .update('csrf:' + this.session.csrfSecret)
      .digest('base64url');
  }

  setFlash(kind: FlashKind, message: string) {
    const payload = Buffer.from(JSON.stringify({ kind, message })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.app.config.SESSION_SECRET)
      .update('flash:' + payload)
      .digest('base64url')
      .slice(0, 22);
    this.setCookie('gd_flash', `${payload}.${sig}`, { maxAge: 60 });
  }

  readFlash() {
    const raw = this.cookies.gd_flash;
    if (!raw) return;
    this.clearCookie('gd_flash');
    const [payload, sig] = raw.split('.');
    const expect = crypto
      .createHmac('sha256', this.app.config.SESSION_SECRET)
      .update('flash:' + payload)
      .digest('base64url')
      .slice(0, 22);
    if (!sig || sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return;
    try {
      const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Flash;
      if (typeof v.message === 'string' && ['success', 'error', 'info'].includes(v.kind)) this.flash = v;
    } catch {
      /* ignore */
    }
  }

  private writeHead(status: number, headers: Record<string, string>) {
    if (this.responded) return;
    this.responded = true;
    if (this.outCookies.length) this.res.setHeader('Set-Cookie', this.outCookies);
    this.res.writeHead(status, headers);
  }

  send(status: number, body: string | Buffer, contentType: string, extra: Record<string, string> = {}) {
    this.writeHead(status, { 'Content-Type': contentType, ...extra });
    this.res.end(this.method === 'HEAD' ? undefined : body);
  }

  html(element: ReactElement, status = 200, extra: Record<string, string> = {}) {
    const markup = '<!doctype html>' + renderToString(element);
    // Personalised pages must never be stored by shared caches.
    this.send(status, markup, 'text/html; charset=utf-8', { 'Cache-Control': 'private, no-store', ...extra });
  }

  json(data: unknown, status = 200, extra: Record<string, string> = {}) {
    this.send(status, JSON.stringify(data), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
  }

  text(body: string, status = 200, contentType = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
    this.send(status, body, contentType, extra);
  }

  redirect(location: string, status = 303) {
    // Only allow same-origin relative redirects (prevents open redirects).
    const safe = location.startsWith('/') && !location.startsWith('//') ? location : '/';
    this.writeHead(status, { Location: safe, 'Cache-Control': 'no-store' });
    this.res.end();
  }

  /** Redirect to an external absolute URL (payment gateways only). */
  redirectExternal(location: string) {
    this.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
    this.res.end();
  }

  wantsJson(): boolean {
    return (this.req.headers.accept ?? '').includes('application/json') || this.url.pathname.startsWith('/api/');
  }
}

/** Only accept local paths for "return to" parameters. */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}
