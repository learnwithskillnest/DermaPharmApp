import type { App } from '../app.ts';
import type { Ctx } from '../http/context.ts';
import { HttpError, UserFacingError } from '../http/errors.ts';
import { render } from '../render.tsx';
import { addToCart, cartCount, loadCoupon, removeCartLine, setCartCoupon, updateCartLine, viewCart } from '../services/cart.ts';
import { listProducts } from '../services/catalog.ts';
import { cartAddSchema, cartUpdateSchema, couponSchema, parseWith } from '../validation.ts';
import { CartPage } from '../../ui/pages/cart.tsx';
import { owner, visibility } from './helpers.ts';
import { safeNext } from '../http/context.ts';
import { formatINR } from '../../shared/money.ts';

async function showCart(ctx: Ctx, couponErrors?: Record<string, string>, status = 200) {
  const settings = await ctx.app.settings.all();
  const rx = await ctx.app.settings.rxOrderingEnabled();
  const cart = await viewCart(ctx.app.db, owner(ctx), settings, rx);
  const suggestions = cart.lines.length ? [] : (await listProducts(ctx.app.db, { featuredOnly: true, perPage: 4 }, visibility(settings))).items;
  await render(
    ctx,
    { title: 'Your cart', noindex: true },
    <CartPage cart={cart} couponErrors={couponErrors} suggestions={suggestions} freeShippingPaise={settings.shipping.freeThresholdPaise} />,
    { status },
  );
}

async function doAdd(ctx: Ctx, input: unknown) {
  const v = parseWith(cartAddSchema, input);
  if (!v.ok) throw new UserFacingError(Object.values(v.errors)[0] ?? 'Invalid request.', 'invalid');
  const settings = await ctx.app.settings.all();
  const rx = await ctx.app.settings.rxOrderingEnabled();
  return addToCart(ctx.app.db, owner(ctx), v.data.variantId, v.data.quantity, settings, rx);
}

export function cartRoutes(app: App) {
  const r = app.router;

  r.get('/cart', (ctx) => showCart(ctx));

  // HTML form fallback (no JavaScript).
  r.post(
    '/cart/add',
    async (ctx) => {
      try {
        const res = await doAdd(ctx, ctx.form);
        ctx.setFlash('success', `Added ${res.productName} (${res.variantName}) to your cart.`);
        ctx.redirect('/cart');
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
        let back = '/cart';
        try {
          const ref = new URL(ctx.req.headers.referer ?? '/cart', ctx.app.config.APP_URL);
          if (ref.origin === new URL(ctx.app.config.APP_URL).origin) back = ref.pathname;
        } catch {
          /* keep /cart */
        }
        ctx.redirect(safeNext(back, '/cart'));
      }
    },
    { rateLimit: 'cart' },
  );

  // JSON API used by the Add to cart island.
  r.post(
    '/api/cart/items',
    async (ctx) => {
      try {
        const res = await doAdd(ctx, ctx.body?.json ?? {});
        ctx.json({ ok: true, quantity: res.quantity, count: await cartCount(ctx.app.db, owner(ctx)) });
      } catch (e) {
        if (e instanceof UserFacingError) return ctx.json({ error: e.message, code: e.code }, e.status);
        throw e;
      }
    },
    { rateLimit: 'cart' },
  );

  r.get('/api/cart', async (ctx) => {
    const settings = await ctx.app.settings.all();
    const cart = await viewCart(ctx.app.db, owner(ctx), settings, await ctx.app.settings.rxOrderingEnabled());
    ctx.json({
      lines: cart.lines.map((l) => ({
        variantId: l.variantId,
        sku: l.sku,
        name: l.productName,
        variant: l.variantName,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
        issue: l.issue,
      })),
      totals: {
        subtotalPaise: cart.quote.subtotalPaise,
        discountPaise: cart.quote.discountPaise,
        shippingPaise: cart.quote.shippingPaise,
        taxPaise: cart.quote.taxPaise,
        totalPaise: cart.quote.totalPaise,
      },
      coupon: cart.quote.coupon,
      canCheckout: cart.canCheckout,
    });
  });

  r.post(
    '/cart/update',
    async (ctx) => {
      const v = parseWith(cartUpdateSchema, ctx.form);
      if (!v.ok) {
        ctx.setFlash('error', Object.values(v.errors)[0] ?? 'Enter a valid quantity.');
        return ctx.redirect('/cart');
      }
      try {
        await updateCartLine(ctx.app.db, owner(ctx), v.data.variantId, v.data.quantity);
        ctx.setFlash('success', v.data.quantity === 0 ? 'Item removed.' : 'Cart updated.');
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect('/cart');
    },
    { rateLimit: 'cart' },
  );

  r.post(
    '/cart/remove',
    async (ctx) => {
      const id = ctx.form.variantId ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Invalid item.');
      await removeCartLine(ctx.app.db, owner(ctx), id);
      ctx.setFlash('success', 'Item removed.');
      ctx.redirect('/cart');
    },
    { rateLimit: 'cart' },
  );

  r.post(
    '/cart/coupon',
    async (ctx) => {
      const v = parseWith(couponSchema, ctx.form);
      if (!v.ok) return showCart(ctx, v.errors, 422);
      const c = await loadCoupon(ctx.app.db, v.data.code);
      if (!c || !c.is_active) return showCart(ctx, { code: 'That coupon code is not valid.' }, 422);
      await setCartCoupon(ctx.app.db, owner(ctx), c.code);
      const settings = await ctx.app.settings.all();
      const cart = await viewCart(ctx.app.db, owner(ctx), settings, await ctx.app.settings.rxOrderingEnabled());
      if (cart.quote.coupon?.applied) ctx.setFlash('success', `Coupon ${c.code} applied: you save ${formatINR(cart.quote.discountPaise)}.`);
      else ctx.setFlash('error', cart.quote.coupon?.message ?? 'That coupon can’t be used on this cart.');
      ctx.redirect('/cart');
    },
    { rateLimit: 'cart' },
  );

  r.post('/cart/coupon/remove', async (ctx) => {
    await setCartCoupon(ctx.app.db, owner(ctx), null);
    ctx.setFlash('info', 'Coupon removed.');
    ctx.redirect('/cart');
  });
}
