import type { Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import { priceCart, type Classification, type CouponRule, type PricingLineInput, type Quote } from './pricing.ts';
import type { Settings } from './settings.ts';
import type { ProductImage } from './catalog.ts';

export interface CartOwner {
  userId: string | null;
  sessionId: string | null;
}

export const MAX_LINE_QTY = 20;
export const MAX_CART_LINES = 30;

export interface CartLine extends PricingLineInput {
  productSlug: string;
  brandName: string;
  image: ProductImage | null;
  stock: number;
  available: boolean; // product + variant active and visible
  issue: string | null;
}

export interface CartView {
  cartId: string | null;
  lines: CartLine[];
  quote: Quote;
  issues: string[];
  hasPrescriptionItems: boolean;
  canCheckout: boolean;
}

function ownerWhere(o: CartOwner): [string, unknown] {
  return o.userId ? ['user_id = $1', o.userId] : ['session_id = $1', o.sessionId];
}

export async function findCart(db: Queryable, o: CartOwner) {
  if (!o.userId && !o.sessionId) return null;
  const [w, v] = ownerWhere(o);
  return db.one<{ id: string; coupon_code: string | null }>(`SELECT id, coupon_code FROM carts WHERE ${w}`, [v]);
}

async function ensureCart(db: Queryable, o: CartOwner) {
  const existing = await findCart(db, o);
  if (existing) return existing.id;
  if (!o.userId && !o.sessionId) throw new UserFacingError('Your browser blocked our session cookie. Enable cookies to use the cart.');
  const row = await db.one<{ id: string }>(
    o.userId
      ? `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id`
      : `INSERT INTO carts (session_id) VALUES ($1) ON CONFLICT (session_id) DO UPDATE SET updated_at = now() RETURNING id`,
    [o.userId ?? o.sessionId],
  );
  return row!.id;
}

interface VariantInfo {
  variant_id: string;
  sku: string;
  variant_name: string;
  price_paise: number;
  mrp_paise: number;
  stock: number;
  variant_active: boolean;
  product_id: string;
  product_name: string;
  product_slug: string;
  product_status: string;
  classification: Classification;
  requires_prescription: boolean;
  tax_rate_bps: number;
  hsn_code: string | null;
  images: ProductImage[];
  brand_name: string;
}

const VARIANT_SELECT = `
  v.id AS variant_id, v.sku, v.name AS variant_name, v.price_paise, v.mrp_paise, v.stock, v.is_active AS variant_active,
  p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.status AS product_status, p.classification,
  p.requires_prescription, p.tax_rate_bps, p.hsn_code, p.images, b.name AS brand_name`;

async function variantInfo(db: Queryable, variantId: string) {
  return db.one<VariantInfo>(`SELECT ${VARIANT_SELECT} FROM product_variants v JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id WHERE v.id = $1`, [
    variantId,
  ]);
}

function sellability(v: VariantInfo, settings: Settings, rxOrderingEnabled: boolean): string | null {
  if (v.product_status !== 'active' || !v.variant_active) return 'This product is no longer available.';
  if (v.classification === 'otc_pharmacy' && !settings.pharmacy.otcVisible) return 'This product is not available right now.';
  if (v.requires_prescription && !rxOrderingEnabled) {
    return 'Prescription medicines cannot be ordered online at the moment. Please consult your doctor or a local pharmacy.';
  }
  return null;
}

export async function addToCart(db: Queryable, o: CartOwner, variantId: string, quantity: number, settings: Settings, rxOrderingEnabled: boolean) {
  const v = await variantInfo(db, variantId);
  if (!v) throw new UserFacingError('That product could not be found.', 'not_found', 404);
  const problem = sellability(v, settings, rxOrderingEnabled);
  if (problem) throw new UserFacingError(problem, 'not_sellable');
  const cartId = await ensureCart(db, o);
  const existing = await db.one<{ quantity: number }>('SELECT quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2', [cartId, variantId]);
  const lineCount = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM cart_items WHERE cart_id = $1', [cartId]);
  if (!existing && (lineCount?.n ?? 0) >= MAX_CART_LINES) throw new UserFacingError(`Your cart can hold up to ${MAX_CART_LINES} different products.`);
  const next = (existing?.quantity ?? 0) + quantity;
  if (next > MAX_LINE_QTY) throw new UserFacingError(`You can buy at most ${MAX_LINE_QTY} of an item per order.`, 'qty_limit');
  if (v.stock <= 0) throw new UserFacingError(`${v.product_name} (${v.variant_name}) is out of stock.`, 'out_of_stock');
  if (next > v.stock) {
    throw new UserFacingError(`Only ${v.stock} of ${v.product_name} (${v.variant_name}) ${v.stock === 1 ? 'is' : 'are'} available.`, 'insufficient_stock');
  }
  await db.query(
    `INSERT INTO cart_items (cart_id, variant_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = $3`,
    [cartId, variantId, next],
  );
  await db.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
  return { quantity: next, productName: v.product_name, variantName: v.variant_name };
}

export async function updateCartLine(db: Queryable, o: CartOwner, variantId: string, quantity: number) {
  const cart = await findCart(db, o);
  if (!cart) throw new UserFacingError('Your cart is empty.', 'empty', 404);
  if (quantity === 0) return removeCartLine(db, o, variantId);
  const v = await variantInfo(db, variantId);
  if (!v) throw new UserFacingError('That product could not be found.', 'not_found', 404);
  if (quantity > v.stock) {
    throw new UserFacingError(v.stock > 0 ? `Only ${v.stock} of ${v.product_name} (${v.variant_name}) available.` : `${v.product_name} is out of stock.`, 'insufficient_stock');
  }
  const r = await db.query('UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND variant_id = $2', [cart.id, variantId, quantity]);
  if (r.rowCount === 0) throw new UserFacingError('That item is not in your cart.', 'not_in_cart', 404);
}

export async function removeCartLine(db: Queryable, o: CartOwner, variantId: string) {
  const cart = await findCart(db, o);
  if (!cart) return;
  await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2', [cart.id, variantId]);
}

export async function setCartCoupon(db: Queryable, o: CartOwner, code: string | null) {
  const cartId = await ensureCart(db, o);
  await db.query('UPDATE carts SET coupon_code = $2, updated_at = now() WHERE id = $1', [cartId, code]);
}

export async function cartCount(db: Queryable, o: CartOwner): Promise<number> {
  if (!o.userId && !o.sessionId) return 0;
  const [w, v] = ownerWhere(o);
  const r = await db.one<{ n: number }>(`SELECT coalesce(sum(i.quantity), 0)::int AS n FROM carts c JOIN cart_items i ON i.cart_id = c.id WHERE c.${w}`, [v]);
  return r?.n ?? 0;
}

export async function loadCoupon(db: Queryable, code: string, forUpdate = false) {
  return db.one<CouponRule>(
    `SELECT id, code, kind, value, min_subtotal_paise, max_discount_paise, starts_at, ends_at, usage_limit, per_user_limit,
            used_count, exclude_pharmacy, is_active
       FROM coupons WHERE upper(code) = upper($1) ${forUpdate ? 'FOR UPDATE' : ''}`,
    [code],
  );
}

export async function couponUsesByUser(db: Queryable, couponId: string, userId: string | null) {
  if (!userId) return 0;
  const r = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id
      WHERE r.coupon_id = $1 AND r.user_id = $2 AND o.status <> 'cancelled'`,
    [couponId, userId],
  );
  return r?.n ?? 0;
}

/** Loads the cart with live prices/stock and returns a server-computed quote. */
export async function viewCart(
  db: Queryable,
  o: CartOwner,
  settings: Settings,
  rxOrderingEnabled: boolean,
  opts: { paymentMethod?: 'online' | 'cod'; lockRows?: boolean } = {},
): Promise<CartView> {
  const cart = await findCart(db, o);
  const rows = cart
    ? await db.many<VariantInfo & { quantity: number }>(
        `SELECT ${VARIANT_SELECT}, i.quantity
           FROM cart_items i JOIN product_variants v ON v.id = i.variant_id
           JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id
          WHERE i.cart_id = $1 ORDER BY v.id ${opts.lockRows ? 'FOR UPDATE OF v' : ''}`,
        [cart.id],
      )
    : [];

  const lines: CartLine[] = rows.map((r) => {
    let issue = sellability(r, settings, rxOrderingEnabled);
    if (!issue && r.stock <= 0) issue = 'Out of stock — remove it to continue.';
    else if (!issue && r.quantity > r.stock) issue = `Only ${r.stock} available — reduce the quantity to continue.`;
    return {
      variantId: r.variant_id,
      productId: r.product_id,
      productName: r.product_name,
      variantName: r.variant_name,
      sku: r.sku,
      unitPricePaise: r.price_paise,
      unitMrpPaise: r.mrp_paise,
      quantity: r.quantity,
      taxRateBps: r.tax_rate_bps,
      classification: r.classification,
      requiresPrescription: r.requires_prescription,
      hsnCode: r.hsn_code,
      productSlug: r.product_slug,
      brandName: r.brand_name,
      image: r.images[0] ?? null,
      stock: r.stock,
      available: !sellability(r, settings, rxOrderingEnabled),
      issue,
    };
  });

  let coupon: CouponRule | null = null;
  let uses = 0;
  if (cart?.coupon_code) {
    coupon = await loadCoupon(db, cart.coupon_code, opts.lockRows);
    if (coupon) uses = await couponUsesByUser(db, coupon.id, o.userId);
  }
  const priceable = lines.filter((l) => l.available);
  const quote = priceCart({
    lines: priceable,
    shipping: settings.shipping,
    paymentMethod: opts.paymentMethod,
    coupon,
    couponCode: cart?.coupon_code ?? null,
    userCouponUses: uses,
  });
  const issues = lines.filter((l) => l.issue).map((l) => `${l.productName}: ${l.issue}`);
  return {
    cartId: cart?.id ?? null,
    lines,
    quote,
    issues,
    hasPrescriptionItems: lines.some((l) => l.requiresPrescription),
    canCheckout: lines.length > 0 && issues.length === 0,
  };
}
