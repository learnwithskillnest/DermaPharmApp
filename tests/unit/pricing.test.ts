import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, couponDiscount, couponProblem, inclusiveTax, priceCart, type CouponRule, type PricingLineInput } from '../../src/server/services/pricing.ts';

const line = (o: Partial<PricingLineInput> = {}): PricingLineInput => ({
  variantId: 'v1',
  productId: 'p1',
  productName: 'Face wash',
  variantName: '100 ml',
  sku: 'SKU1',
  unitPricePaise: 34900,
  unitMrpPaise: 39900,
  quantity: 1,
  taxRateBps: 1800,
  classification: 'cosmetic',
  requiresPrescription: false,
  ...o,
});
const shipping = { flatFeePaise: 4900, freeThresholdPaise: 49900, codFeePaise: 3000 };
const coupon = (o: Partial<CouponRule> = {}): CouponRule => ({
  id: 'c1',
  code: 'WELCOME10',
  kind: 'percent',
  value: 10,
  min_subtotal_paise: 49900,
  max_discount_paise: 15000,
  starts_at: null,
  ends_at: null,
  usage_limit: null,
  per_user_limit: 1,
  used_count: 0,
  exclude_pharmacy: true,
  is_active: true,
  ...o,
});

test('inclusive GST is extracted from a tax-inclusive price', () => {
  assert.equal(inclusiveTax(11800, 1800), 1800); // ₹118 incl. 18% → ₹18 tax
  assert.equal(inclusiveTax(10500, 500), 500);
  assert.equal(inclusiveTax(0, 1800), 0);
  assert.equal(inclusiveTax(1000, 0), 0);
});

test('subtotal, shipping below threshold, and totals', () => {
  const q = priceCart({ lines: [line({ quantity: 1 })], shipping });
  assert.equal(q.subtotalPaise, 34900);
  assert.equal(q.mrpTotalPaise, 39900);
  assert.equal(q.shippingPaise, 4900);
  assert.equal(q.totalPaise, 34900 + 4900);
  assert.equal(q.itemCount, 1);
  assert.equal(q.taxPaise, inclusiveTax(34900, 1800));
});

test('free shipping at or above the threshold', () => {
  const q = priceCart({ lines: [line({ unitPricePaise: 49900, unitMrpPaise: 49900 })], shipping });
  assert.equal(q.shippingPaise, 0);
  assert.equal(q.totalPaise, 49900);
});

test('COD fee is added only for cash on delivery', () => {
  const online = priceCart({ lines: [line({ quantity: 2 })], shipping, paymentMethod: 'online' });
  const cod = priceCart({ lines: [line({ quantity: 2 })], shipping, paymentMethod: 'cod' });
  assert.equal(online.codFeePaise, 0);
  assert.equal(cod.codFeePaise, 3000);
  assert.equal(cod.totalPaise - online.totalPaise, 3000);
});

test('empty cart totals to zero with no shipping', () => {
  const q = priceCart({ lines: [], shipping });
  assert.equal(q.totalPaise, 0);
  assert.equal(q.shippingPaise, 0);
});

test('invalid quantities and prices are rejected', () => {
  for (const quantity of [0, -1, 1.5, Number.NaN]) assert.throws(() => priceCart({ lines: [line({ quantity })], shipping }), /Invalid quantity/);
  assert.throws(() => priceCart({ lines: [line({ unitPricePaise: 0 })], shipping }), /Invalid price/);
  assert.throws(() => priceCart({ lines: [line({ unitPricePaise: 99.5 })], shipping }), /Invalid price/);
});

test('percentage coupon with cap, excluding pharmacy lines', () => {
  const q = priceCart({
    lines: [
      line({ unitPricePaise: 100000, unitMrpPaise: 100000 }),
      line({ variantId: 'v2', sku: 'RX', unitPricePaise: 50000, unitMrpPaise: 50000, classification: 'otc_pharmacy', taxRateBps: 500 }),
    ],
    shipping,
    coupon: coupon(),
  });
  assert.equal(q.coupon?.applied, true);
  assert.equal(q.discountPaise, 10000); // 10% of the ₹1000 eligible line, under the ₹150 cap
  assert.equal(q.lines[0].lineDiscountPaise, 10000);
  assert.equal(q.lines[1].lineDiscountPaise, 0);
  assert.equal(q.totalPaise, 150000 - 10000);
  // GST is computed on the discounted line value.
  assert.equal(q.lines[0].taxPaise, inclusiveTax(90000, 1800));
});

test('coupon cap and minimum spend', () => {
  assert.equal(couponDiscount(coupon(), 500000), 15000);
  assert.match(couponProblem(coupon(), 40000, 0)!, /Spend ₹499/);
  const q = priceCart({ lines: [line()], shipping, coupon: coupon() });
  assert.equal(q.coupon?.applied, false);
  assert.equal(q.discountPaise, 0);
});

test('coupon validity rules', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  assert.match(couponProblem(coupon({ is_active: false }), 60000, 0, now)!, /no longer active/);
  assert.match(couponProblem(coupon({ starts_at: new Date('2026-11-01') }), 60000, 0, now)!, /not active yet/);
  assert.match(couponProblem(coupon({ ends_at: new Date('2026-10-01') }), 60000, 0, now)!, /expired/);
  assert.match(couponProblem(coupon({ usage_limit: 5, used_count: 5 }), 60000, 0, now)!, /usage limit/);
  assert.match(couponProblem(coupon(), 60000, 1, now)!, /already used/);
  assert.match(couponProblem(coupon(), 0, 0, now)!, /pharmacy/);
  assert.equal(couponProblem(coupon(), 60000, 0, now), null);
});

test('fixed coupon never exceeds the eligible subtotal', () => {
  assert.equal(couponDiscount(coupon({ kind: 'fixed', value: 50000, max_discount_paise: null, min_subtotal_paise: 0 }), 30000), 30000);
});

test('unknown coupon code is reported, not applied', () => {
  const q = priceCart({ lines: [line()], shipping, couponCode: 'NOPE' });
  assert.equal(q.coupon?.applied, false);
  assert.match(q.coupon!.message!, /not valid/);
});

test('allocate splits exactly and proportionally', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(0, [5, 5]), [0, 0]);
  assert.deepEqual(allocate(10, [0, 0]), [0, 0]);
  for (let i = 0; i < 200; i++) {
    const w = Array.from({ length: 1 + (i % 6) }, (_, k) => ((i * 7919 + k * 104729) % 50000) + 1);
    const total = (i * 31337) % 20000;
    const out = allocate(total, w);
    assert.equal(
      out.reduce((a, b) => a + b, 0),
      total,
    );
    assert.ok(out.every((x) => Number.isInteger(x) && x >= 0));
  }
});

test('totals stay integral and consistent across many carts (property check)', () => {
  for (let i = 1; i < 300; i++) {
    const lines = Array.from({ length: 1 + (i % 4) }, (_, k) =>
      line({
        variantId: 'v' + k,
        sku: 'S' + k,
        unitPricePaise: 1000 + ((i * 97 + k * 13) % 90000),
        unitMrpPaise: 100000,
        quantity: 1 + ((i + k) % 5),
        taxRateBps: [0, 500, 1200, 1800][k % 4],
      }),
    );
    const q = priceCart({ lines, shipping, coupon: coupon({ exclude_pharmacy: false, max_discount_paise: null }) });
    const sumLines = q.lines.reduce((a, l) => a + l.lineTotalPaise - l.lineDiscountPaise, 0);
    assert.equal(sumLines, q.subtotalPaise - q.discountPaise);
    assert.equal(q.totalPaise, q.subtotalPaise - q.discountPaise + q.shippingPaise + q.codFeePaise);
    assert.ok(q.totalPaise >= 0 && Number.isInteger(q.totalPaise));
  }
});
