import type { ReactNode } from 'react';
import type { Ctx } from './http/context.ts';
import { Document, type PageMeta, type ShellData } from '../ui/layout.tsx';
import { cartCount } from './services/cart.ts';
import { ErrorPage } from '../ui/pages/misc.tsx';

export const NAV = [
  { href: '/skincare', label: 'Skincare' },
  { href: '/cosmetology', label: 'Cosmetology' },
  { href: '/body-hair', label: 'Body & hair' },
  { href: '/pharmacy', label: 'Pharmacy' },
  { href: '/shop', label: 'Shop all' },
];

export async function shellData(ctx: Ctx, meta: PageMeta, extra: { searchQuery?: string } = {}): Promise<ShellData> {
  const settings = await ctx.app.settings.all();
  const count = ctx.session ? await cartCount(ctx.app.db, { userId: ctx.user?.id ?? null, sessionId: ctx.session.id }) : 0;
  const c = ctx.app.config;
  return {
    ui: {
      csrf: ctx.csrfToken(),
      user: ctx.user ? { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role } : null,
      storeName: settings.store.name,
      path: ctx.url.pathname,
      sandbox: ctx.app.payments.isSandbox,
    },
    meta,
    appUrl: c.APP_URL.replace(/\/$/, ''),
    assets: ctx.app.assets(),
    nonce: ctx.nonce,
    flash: ctx.flash,
    cartCount: count,
    nav: NAV,
    searchQuery: extra.searchQuery,
    analytics: c.ANALYTICS_PROVIDER ? { provider: c.ANALYTICS_PROVIDER, id: c.ANALYTICS_ID } : null,
    footer: { storeName: settings.store.name, legalName: settings.store.legalName, supportHours: settings.store.supportHours },
  };
}

/** Render a full storefront page. */
export async function render(ctx: Ctx, meta: PageMeta, body: ReactNode, opts: { status?: number; searchQuery?: string; bare?: boolean } = {}) {
  const data = await shellData(ctx, meta, { searchQuery: opts.searchQuery });
  // Personal pages (account, cart, checkout, admin) are never indexed.
  if (/^\/(account|cart|checkout|admin|login|register|orders|sandbox-gateway|reset-password|forgot-password)/.test(ctx.url.pathname)) data.meta.noindex = true;
  ctx.html(
    <Document data={data} bare={opts.bare}>
      {body}
    </Document>,
    opts.status ?? 200,
  );
}

export async function renderError(ctx: Ctx, status: number, message: string) {
  const titles: Record<number, string> = {
    400: 'Bad request',
    401: 'Please sign in',
    403: 'Access denied',
    404: 'Page not found',
    405: 'Not allowed',
    413: 'Too large',
    415: 'Unsupported upload',
    422: 'Check your details',
    429: 'Slow down',
    500: 'Something went wrong',
  };
  await render(ctx, { title: titles[status] ?? 'Error', noindex: true }, <ErrorPage status={status} title={titles[status] ?? 'Error'} message={message} />, { status });
}
