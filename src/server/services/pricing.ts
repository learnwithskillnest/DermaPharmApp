/**
 * Pure pricing engine — the single source of truth for every total the
 * customer sees and pays. Never trust prices sent from the browser.
 *
 * Conventions:
 *  - Integer paise everywhere; no floating-point money.
 *  - Selling prices are GST-inclusive (Indian MRP convention). The GST
 *    component is derived for invoices: tax = taxable × rate / (100% + rate).
 *  - Coupon discounts are allocated across eligible lines (largest-remainder),
 *    so per-line GST is computed on the discounted value.
 */

export type Classification = 'cosmetic' | 'personal_care' | 'otc_pharmacy' | 'prescription';

export interface PricingLineInput {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  sku: string;
  unitPricePaise: number;
  unitMrpPaise: number;
  quantity: number;
  taxRateBps: number;
  classification: Classification;
  requiresPrescription: boolean;
  hsnCode?: string | null;
}

export interface CouponRule {
  id: string;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  min_subtotal_paise: number;
  max_discount_paise: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  usage_limit: number | null;
  per_user_limit: number;
  used_count: number;
  exclude_pharmacy: boolean;
  is_active: boolean;
}

export interface ShippingRules {
  flatFeePaise: number;
  freeThresholdPaise: number;
  codFeePaise: number;
}

export interface PricedLine extends PricingLineInput {
  lineTotalPaise: number;
  lineDiscountPaise: number;
  taxPaise: number;
}

export interface Quote {
  lines: PricedLine[];
  itemCount: number;
  subtotalPaise: number;
  mrpTotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  codFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  coupon: { code: string; applied: boolean; message: string | null; couponId: string | null } | null;
}

const isPharmacy = (c: Classification) => c === 'otc_pharmacy' || c === 'prescription';

/** GST component contained in a tax-inclusive amount. */
export function inclusiveTax(amountPaise: number, rateBps: number): number {
  if (rateBps <= 0 || amountPaise <= 0) return 0;
  return Math.round((amountPaise * rateBps) / (10_000 + rateBps));
}

export function couponProblem(c: CouponRule, eligibleSubtotal: number, userUses: number, now = new Date()): string | null {
  if (!c.is_active) return 'This coupon is no longer active.';
  if (c.starts_at && c.starts_at > now) return 'This coupon is not active yet.';
  if (c.ends_at && c.ends_at < now) return 'This coupon has expired.';
  if (c.usage_limit !== null && c.used_count >= c.usage_limit) return 'This coupon has reached its usage limit.';
  if (userUses >= c.per_user_limit) return 'You have already used this coupon.';
  if (eligibleSubtotal <= 0) return c.exclude_pharmacy ? 'This coupon does not apply to pharmacy products.' : 'Add items to use this coupon.';
  if (eligibleSubtotal < c.min_subtotal_paise) {
    return `Spend ₹${(c.min_subtotal_paise / 100).toLocaleString('en-IN')} on eligible items to use this coupon.`;
  }
  return null;
}

export function couponDiscount(c: CouponRule, eligibleSubtotal: number): number {
  let d = c.kind === 'percent' ? Math.floor((eligibleSubtotal * c.value) / 100) : c.value;
  if (c.max_discount_paise !== null && c.max_discount_paise !== undefined) d = Math.min(d, c.max_discount_paise);
  return Math.max(0, Math.min(d, eligibleSubtotal));
}

/** Split `total` across `weights` proportionally, summing exactly to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rem <= 0) break;
    out[i]++;
    rem--;
  }
  return out;
}

export function priceCart(input: {
  lines: PricingLineInput[];
  shipping: ShippingRules;
  paymentMethod?: 'online' | 'cod';
  coupon?: CouponRule | null;
  couponCode?: string | null;
  userCouponUses?: number;
  now?: Date;
}): Quote {
  for (const l of input.lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) throw new Error(`Invalid quantity for ${l.sku}`);
    if (!Number.isInteger(l.unitPricePaise) || l.unitPricePaise <= 0) throw new Error(`Invalid price for ${l.sku}`);
  }
  const lines: PricedLine[] = input.lines.map((l) => ({ ...l, lineTotalPaise: l.unitPricePaise * l.quantity, lineDiscountPaise: 0, taxPaise: 0 }));
  const subtotal = lines.reduce((a, l) => a + l.lineTotalPaise, 0);
  const mrpTotal = lines.reduce((a, l) => a + l.unitMrpPaise * l.quantity, 0);

  let discount = 0;
  let coupon: Quote['coupon'] = null;
  const code = input.coupon?.code ?? input.couponCode ?? null;
  if (code) {
    if (!input.coupon) {
      coupon = { code, applied: false, message: 'That coupon code is not valid.', couponId: null };
    } else {
      const c = input.coupon;
      const eligible = lines.filter((l) => !(c.exclude_pharmacy && isPharmacy(l.classification)));
      const eligibleSubtotal = eligible.reduce((a, l) => a + l.lineTotalPaise, 0);
      const problem = couponProblem(c, eligibleSubtotal, input.userCouponUses ?? 0, input.now);
      if (problem) {
        coupon = { code: c.code, applied: false, message: problem, couponId: c.id };
      } else {
        discount = couponDiscount(c, eligibleSubtotal);
        const shares = allocate(
          discount,
          eligible.map((l) => l.lineTotalPaise),
        );
        eligible.forEach((l, i) => (l.lineDiscountPaise = shares[i]));
        coupon = { code: c.code, applied: true, message: null, couponId: c.id };
      }
    }
  }

  for (const l of lines) l.taxPaise = inclusiveTax(l.lineTotalPaise - l.lineDiscountPaise, l.taxRateBps);

  const afterDiscount = subtotal - discount;
  const shipping = lines.length === 0 || afterDiscount >= input.shipping.freeThresholdPaise ? 0 : input.shipping.flatFeePaise;
  const codFee = input.paymentMethod === 'cod' && lines.length > 0 ? input.shipping.codFeePaise : 0;
  const tax = lines.reduce((a, l) => a + l.taxPaise, 0);

  return {
    lines,
    itemCount: lines.reduce((a, l) => a + l.quantity, 0),
    subtotalPaise: subtotal,
    mrpTotalPaise: mrpTotal,
    discountPaise: discount,
    shippingPaise: shipping,
    codFeePaise: codFee,
    taxPaise: tax,
    totalPaise: afterDiscount + shipping + codFee,
    coupon,
  };
}
