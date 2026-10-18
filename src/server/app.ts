import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import { createDatabase, type Database } from './db/db.ts';
import { Ctx, safeNext } from './http/context.ts';
import { parseBody } from './http/body.ts';
import { HttpError } from './http/errors.ts';
import { RateLimiter } from './http/rate-limit.ts';
import { Router } from './http/router.ts';
import { loadSession } from './auth/session.ts';
import { can } from './auth/permissions.ts';
import { logger } from './logger.ts';
import { SettingsService } from './services/settings.ts';
import { createMailer, type Mailer } from './services/mail.ts';
import type { PaymentProvider } from './services/payments/provider.ts';
import { SandboxProvider } from './services/payments/sandbox.ts';
import { RazorpayProvider } from './services/payments/razorpay.ts';
import { renderError } from './render.tsx';
import { registerRoutes } from './routes/index.ts';

export interface AssetManifest {
  css: string;
  js: string;
}

export interface App {
  config: Config;
  db: Database;
  limiter: RateLimiter;
  settings: SettingsService;
  payments: PaymentProvider;
  sandbox: SandboxProvider | null;
  mailer: Mailer;
  router: Router;
  assets(): AssetManifest;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
const BUILD_DIR = path.resolve(process.cwd(), 'dist/public');

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function loadManifest(): AssetManifest {
  try {
    return JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'assets/manifest.json'), 'utf8'));
  } catch {
    return { css: '', js: '' };
  }
}

function securityHeaders(ctx: Ctx, app: App) {
  const razorpay = app.payments.name === 'razorpay';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${ctx.nonce}'${razorpay ? ' https://checkout.razorpay.com' : ''}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `img-src 'self' data:${razorpay ? ' https://*.razorpay.com' : ''}`,
    `connect-src 'self'${razorpay ? ' https://*.razorpay.com' : ''}`,
    `frame-src ${razorpay ? 'https://api.razorpay.com https://checkout.razorpay.com' : `'none'`}`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    ...(app.config.APP_URL.startsWith('https://') ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  const res = ctx.res;
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com")');
  res.setHeader('Cross-Origin-Opener-Policy', razorpay ? 'same-origin-allow-popups' : 'same-origin');
  res.setHeader('X-Request-Id', ctx.requestId);
  if (app.config.APP_URL.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function serveStatic(ctx: Ctx): boolean {
  const p = ctx.url.pathname;
  let root: string | null = null;
  let rel = '';
  let immutable = false;
  if (p.startsWith('/assets/')) {
    root = path.join(BUILD_DIR, 'assets');
    rel = p.slice('/assets/'.length);
    immutable = /\.[a-f0-9]{8,}\./.test(rel);
  } else if (p.startsWith('/images/') || p === '/favicon.svg' || p === '/site.webmanifest') {
    root = PUBLIC_DIR;
    rel = p.slice(1);
  }
  if (!root) return false;
  const file = path.resolve(root, decodeURIComponent(rel));
  if (!file.startsWith(root + path.sep) || rel.includes('\0')) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (ctx.req.headers['if-none-match'] === etag) {
    ctx.res.writeHead(304, { ETag: etag });
    ctx.res.end();
    ctx.responded = true;
    return true;
  }
  ctx.send(200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream', {
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    ETag: etag,
  });
  return true;
}

function originAllowed(ctx: Ctx): boolean {
  const origin = ctx.req.headers.origin;
  if (!origin || origin === 'null') {
    const ref = ctx.req.headers.referer;
    if (!ref) return true; // some privacy setups strip both; the CSRF token still applies
    try {
      return new URL(ref).origin === new URL(ctx.app.config.APP_URL).origin;
    } catch {
      return false;
    }
  }
  return origin === new URL(ctx.app.config.APP_URL).origin;
}

function csrfValid(ctx: Ctx): boolean {
  if (!ctx.session) return false;
  const sent =
    ctx.body?.form._csrf ??
    (typeof ctx.req.headers['x-csrf-token'] === 'string' ? ctx.req.headers['x-csrf-token'] : undefined) ??
    (ctx.body?.json as { _csrf?: string } | undefined)?._csrf ??
    '';
  const expected = ctx.csrfToken();
  return typeof sent === 'string' && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

export function createApp(config: Config, opts: { db?: Database } = {}): App {
  const db = opts.db ?? createDatabase(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
  const limiter = new RateLimiter();
  const settings = new SettingsService(db, config);
  const sandbox = config.PAYMENT_PROVIDER === 'sandbox' ? new SandboxProvider(db, config.SANDBOX_PAYMENT_SECRET!) : null;
  const payments: PaymentProvider = sandbox ?? new RazorpayProvider(config.RAZORPAY_KEY_ID!, config.RAZORPAY_KEY_SECRET!, config.RAZORPAY_WEBHOOK_SECRET!);
  const router = new Router();
  let manifest = loadManifest();
  let manifestAt = Date.now();

  const app: App = {
    config,
    db,
    limiter,
    settings,
    payments,
    sandbox,
    mailer: createMailer(config, db),
    router,
    assets() {
      if (!config.isProd && Date.now() - manifestAt > 1000) {
        manifest = loadManifest();
        manifestAt = Date.now();
      }
      return manifest;
    },
    async handle(req, res) {
      const started = performance.now();
      const ctx = new Ctx(app, req, res);
      securityHeaders(ctx, app);
      try {
        await dispatch(ctx);
      } catch (e) {
        await handleError(ctx, e);
      } finally {
        const ms = Math.round(performance.now() - started);
        if (!ctx.url.pathname.startsWith('/assets/')) {
          logger.info('request', { id: ctx.requestId, method: ctx.method, path: ctx.url.pathname, status: res.statusCode, ms, user: ctx.user?.id });
        }
      }
    },
    async close() {
      limiter.stop();
      await db.close();
    },
  };

  async function dispatch(ctx: Ctx) {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') && serveStatic(ctx)) return;
    const m = router.match(ctx.method, ctx.url.pathname);
    if (!m) {
      await loadSession(ctx, { create: false });
      throw new HttpError(404, 'We could not find that page.');
    }
    if ('allowed' in m) {
      ctx.res.setHeader('Allow', [...new Set(m.allowed)].join(', '));
      throw new HttpError(405, 'That action is not allowed here.');
    }
    const { route, params } = m;
    ctx.params = params;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(ctx.method);

    if (route.opts.session !== false) {
      await loadSession(ctx, { create: !unsafe });
      ctx.readFlash();
    }
    if (unsafe) {
      if (route.opts.rateLimit) {
        const retry = limiter.hit(route.opts.rateLimit, ctx.ip);
        if (retry) {
          ctx.res.setHeader('Retry-After', String(retry));
          throw new HttpError(429, 'Too many attempts. Please wait a moment and try again.');
        }
      }
      ctx.body = await parseBody(ctx.req, { multipart: route.opts.multipart, maxBytes: route.opts.maxBytes });
      if (route.opts.csrf !== false) {
        if (!originAllowed(ctx) || !csrfValid(ctx)) {
          logger.warn('csrf_rejected', { path: ctx.url.pathname, ip: ctx.ip, hasSession: !!ctx.session });
          throw new HttpError(403, 'Your session expired or the form was out of date. Go back, refresh the page and try again.', 'csrf');
        }
      }
    }
    if (route.opts.auth === 'user' || route.opts.perm) {
      if (!ctx.user) {
        if (ctx.wantsJson() || unsafe) throw new HttpError(401, 'Please sign in to continue.', 'auth');
        return ctx.redirect(`/login?next=${encodeURIComponent(safeNext(ctx.url.pathname + ctx.url.search))}`);
      }
      if (route.opts.perm && !can(ctx.user.role, route.opts.perm)) {
        logger.warn('forbidden', { path: ctx.url.pathname, user: ctx.user.id, role: ctx.user.role, perm: route.opts.perm });
        throw new HttpError(403, 'You do not have access to this page.', 'forbidden');
      }
    }
    await route.handler(ctx);
    if (!ctx.responded) throw new Error(`Handler for ${route.method} ${route.path} did not respond`);
  }

  async function handleError(ctx: Ctx, e: unknown) {
    if (ctx.responded) {
      logger.error('error_after_response', { id: ctx.requestId, err: e });
      return;
    }
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof HttpError ? e.message : 'Something went wrong on our side. Please try again in a moment.';
    if (status >= 500) logger.error('unhandled_error', { id: ctx.requestId, path: ctx.url.pathname, err: e });
    if (ctx.wantsJson()) return ctx.json({ error: message, code: e instanceof HttpError ? e.code : 'server_error', requestId: ctx.requestId }, status);
    try {
      await renderError(ctx, status, message);
    } catch (e2) {
      logger.error('error_page_failed', { err: e2 });
      ctx.text(message, status);
    }
  }

  registerRoutes(app);
  return app;
}
