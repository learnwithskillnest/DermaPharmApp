import type { App } from '../app.ts';
import { storefrontRoutes } from './storefront.tsx';
import { authRoutes } from './auth.tsx';
import { cartRoutes } from './cart.tsx';
import { checkoutRoutes } from './checkout.tsx';
import { accountRoutes } from './account.tsx';
import { seoRoutes } from './seo.ts';
import { adminCatalogRoutes } from './admin/catalog.tsx';
import { adminOrderRoutes } from './admin/orders.tsx';
import { adminMiscRoutes } from './admin/misc.tsx';

export function registerRoutes(app: App) {
  // Health check: no session, no DB writes. Used by Docker/hosting probes.
  app.router.get(
    '/healthz',
    async (ctx) => {
      try {
        await ctx.app.db.one('SELECT 1 AS ok');
        ctx.json({ ok: true });
      } catch {
        ctx.json({ ok: false }, 503);
      }
    },
    { session: false },
  );
  seoRoutes(app);
  storefrontRoutes(app);
  authRoutes(app);
  cartRoutes(app);
  checkoutRoutes(app);
  accountRoutes(app);
  adminMiscRoutes(app);
  adminOrderRoutes(app);
  adminCatalogRoutes(app);
}
