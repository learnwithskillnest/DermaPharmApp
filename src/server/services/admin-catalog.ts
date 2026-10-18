import { z } from 'zod';
import { asJson, isUniqueViolation, type Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import { checkbox, intField, rupeesField, slugField, uuidField } from '../validation.ts';
import { audit, type Actor } from './audit.ts';
import { moveStock } from './inventory.ts';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : null));

const lines = (raw: string | undefined, sep: RegExp) =>
  (raw ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);

export const productSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a product name.').max(160),
    slug: slugField,
    brandId: uuidField,
    categoryId: uuidField,
    shortDescription: z.string().trim().min(10, 'Write a short description (10+ characters).').max(300),
    description: z.string().trim().max(8000).default(''),
    keyActive: text(80),
    keyActiveStrength: text(20),
    ingredients: text(6000),
    usageInstructions: text(3000),
    warnings: text(3000),
    storage: text(500),
    manufacturerName: text(200),
    manufacturerAddress: text(400),
    marketedBy: text(200),
    countryOfOrigin: text(80),
    classification: z.enum(['cosmetic', 'personal_care', 'otc_pharmacy', 'prescription']),
    classificationVerified: checkbox,
    requiresPrescription: checkbox,
    hsnCode: z
      .string()
      .trim()
      .regex(/^(\d{4}|\d{6}|\d{8})?$/, 'HSN codes are 4, 6 or 8 digits.')
      .optional()
      .transform((v) => v || null),
    taxRatePercent: z.coerce.number().min(0, 'GST rate cannot be negative.').max(28, 'GST rate looks too high.'),
    status: z.enum(['draft', 'active', 'archived']),
    isFeatured: checkbox,
    isSample: checkbox,
    images: z.string().max(4000).optional(),
    tags: z.string().max(500).optional(),
    skinTypes: z.string().max(200).optional(),
    seoTitle: text(70),
    seoDescription: text(170),
  })
  .transform((d) => ({
    ...d,
    requiresPrescription: d.classification === 'prescription' ? true : d.requiresPrescription,
    taxRateBps: Math.round(d.taxRatePercent * 100),
    images: lines(d.images, /\n/).map((l) => {
      const [url, alt] = l.split('|').map((s) => s.trim());
      return { url, alt: alt || d.name };
    }),
    tags: lines(d.tags, /,/).map((t) => t.toLowerCase()),
    skinTypes: lines(d.skinTypes, /,/),
  }))
  .superRefine((d, ctx) => {
    for (const img of d.images) {
      if (!/^\/images\/[A-Za-z0-9/_.-]+$/.test(img.url) && !/^https:\/\/[^\s"'<>]+$/.test(img.url)) {
        ctx.addIssue({ code: 'custom', path: ['images'], message: `Image "${img.url}" must be a /images/… path or an https:// URL.` });
      }
    }
  });

export const variantSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    name: z.string().trim().min(1, 'Enter the pack size, e.g. 100 ml.').max(60),
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{3,40}$/, 'SKUs use 3–40 capital letters, numbers and hyphens.'),
    mrp: rupeesField('the MRP'),
    price: rupeesField('the selling price'),
    lowStock: intField('Low-stock alert', 0, 10000),
    weight: intField('Weight', 1, 50000),
    initialStock: z.coerce.number().int().min(0).max(100000).optional(),
    isActive: checkbox,
    isDefault: checkbox,
  })
  .refine((v) => v.price <= v.mrp, { path: ['price'], message: 'Selling price cannot be more than MRP (Legal Metrology rules).' });

export type ProductInput = z.infer<typeof productSchema>;
export type VariantInput = z.infer<typeof variantSchema>;

/** Parses the variant rows (fields named v{i}_{field}). Returns per-row errors keyed `v{i}_{field}`. */
export function parseVariants(form: Record<string, string>) {
  const count = Math.min(Number(form.variantCount ?? 0) || 0, 20);
  const rows: VariantInput[] = [];
  const errors: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const raw = {
      id: form[`v${i}_id`],
      name: form[`v${i}_name`] ?? '',
      sku: form[`v${i}_sku`] ?? '',
      mrp: form[`v${i}_mrp`] ?? '',
      price: form[`v${i}_price`] ?? '',
      lowStock: form[`v${i}_lowStock`] ?? '5',
      weight: form[`v${i}_weight`] ?? '100',
      initialStock: form[`v${i}_initialStock`] || undefined,
      isActive: form[`v${i}_isActive`],
      isDefault: form.defaultVariant === String(i) ? 'on' : '',
    };
    // A completely blank "new" row is ignored.
    if (!raw.id && !raw.name && !raw.sku && !raw.mrp && !raw.price) continue;
    const r = variantSchema.safeParse(raw);
    if (r.success) rows.push(r.data);
    else for (const issue of r.error.issues) errors[`v${i}_${issue.path[0]}`] ??= issue.message;
  }
  if (!rows.length && !Object.keys(errors).length) errors.variants = 'Add at least one pack size.';
  return { rows, errors };
}

export async function saveProduct(
  db: Queryable & { tx: <T>(fn: (t: Queryable) => Promise<T>) => Promise<T> },
  id: string | null,
  p: ProductInput,
  variants: VariantInput[],
  actor: Actor,
) {
  if (p.status === 'active' && !variants.some((v) => v.isActive)) throw new UserFacingError('A published product needs at least one active pack size.');
  if (p.classification === 'prescription' && p.isFeatured) throw new UserFacingError('Prescription medicines cannot be featured or promoted.');
  try {
    return await db.tx(async (t) => {
      const cols = [
        p.name,
        p.slug,
        p.brandId,
        p.categoryId,
        p.shortDescription,
        p.description,
        p.keyActive,
        p.keyActiveStrength,
        p.ingredients,
        p.usageInstructions,
        p.warnings,
        p.storage,
        p.manufacturerName,
        p.manufacturerAddress,
        p.marketedBy,
        p.countryOfOrigin,
        p.classification,
        p.classificationVerified,
        p.requiresPrescription,
        p.hsnCode,
        p.taxRateBps,
        p.status,
        p.isFeatured,
        asJson(p.images),
        p.tags,
        p.skinTypes,
        p.seoTitle,
        p.seoDescription,
        p.isSample,
      ];
      let productId = id;
      if (id) {
        const r = await t.one<{ id: string }>(
          `UPDATE products SET name=$2, slug=$3, brand_id=$4, category_id=$5, short_description=$6, description=$7, key_active=$8,
             key_active_strength=$9, ingredients=$10, usage_instructions=$11, warnings=$12, storage=$13, manufacturer_name=$14,
             manufacturer_address=$15, marketed_by=$16, country_of_origin=$17, classification=$18, classification_verified=$19,
             requires_prescription=$20, hsn_code=$21, tax_rate_bps=$22, status=$23, is_featured=$24, images=$25, tags=$26, skin_types=$27,
             seo_title=$28, seo_description=$29, is_sample=$30, updated_at=now(),
             published_at = CASE WHEN $23::product_status = 'active' AND published_at IS NULL THEN now() ELSE published_at END
           WHERE id = $1 RETURNING id`,
          [id, ...cols],
        );
        if (!r) throw new UserFacingError('Product not found.', 'not_found', 404);
      } else {
        const r = await t.one<{ id: string }>(
          `INSERT INTO products (name, slug, brand_id, category_id, short_description, description, key_active, key_active_strength, ingredients,
             usage_instructions, warnings, storage, manufacturer_name, manufacturer_address, marketed_by, country_of_origin, classification,
             classification_verified, requires_prescription, hsn_code, tax_rate_bps, status, is_featured, images, tags, skin_types, seo_title,
             seo_description, is_sample, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             CASE WHEN $22::product_status = 'active' THEN now() END) RETURNING id`,
          cols,
        );
        productId = r!.id;
      }
      const hasDefault = variants.some((v) => v.isDefault);
      for (const [i, v] of variants.entries()) {
        const isDefault = hasDefault ? v.isDefault : i === 0;
        if (v.id) {
          const r = await t.one(
            `UPDATE product_variants SET name=$3, sku=$4, mrp_paise=$5, price_paise=$6, low_stock_threshold=$7, weight_grams=$8, is_active=$9, is_default=$10, sort_order=$11
              WHERE id = $1 AND product_id = $2 RETURNING id`,
            [v.id, productId, v.name, v.sku, v.mrp, v.price, v.lowStock, v.weight, v.isActive, isDefault, i],
          );
          if (!r) throw new UserFacingError('A pack size could not be found. Reload the page.');
        } else {
          const r = await t.one<{ id: string }>(
            `INSERT INTO product_variants (product_id, name, sku, mrp_paise, price_paise, low_stock_threshold, weight_grams, is_active, is_default, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [productId, v.name, v.sku, v.mrp, v.price, v.lowStock, v.weight, v.isActive, isDefault, i],
          );
          if (v.initialStock) await moveStock(t, { variantId: r!.id, delta: v.initialStock, reason: 'initial', actorId: actor.id, note: 'Opening stock' });
        }
      }
      await audit(t, actor, id ? 'product.updated' : 'product.created', 'product', productId, { name: p.name, status: p.status, classification: p.classification });
      return productId!;
    });
  } catch (e) {
    if (isUniqueViolation(e, 'products_slug_key')) throw new UserFacingError('Another product already uses that URL slug.', 'slug');
    if (isUniqueViolation(e, 'product_variants_sku_key')) throw new UserFacingError('One of the SKUs is already used by another product.', 'sku');
    throw e;
  }
}

export async function setProductStatus(db: Queryable, id: string, status: 'draft' | 'active' | 'archived', actor: Actor) {
  if (status === 'active') {
    const v = await db.one('SELECT 1 FROM product_variants WHERE product_id = $1 AND is_active', [id]);
    if (!v) throw new UserFacingError('Add an active pack size before publishing.');
  }
  const r = await db.one<{ name: string }>(
    `UPDATE products SET status = $2::product_status, updated_at = now(), published_at = CASE WHEN $2::product_status = 'active' AND published_at IS NULL THEN now() ELSE published_at END
      WHERE id = $1 RETURNING name`,
    [id, status],
  );
  if (!r) throw new UserFacingError('Product not found.', 'not_found', 404);
  await audit(db, actor, `product.${status === 'active' ? 'published' : status}`, 'product', id, { name: r.name });
}

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugField,
  description: text(400),
  department: z.enum(['skincare', 'cosmetology', 'body-hair', 'pharmacy']),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  isActive: checkbox,
});

export const brandSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugField,
  description: text(400),
  isSample: checkbox,
});

export const stockAdjustSchema = z.object({
  variantId: uuidField,
  delta: z.coerce
    .number()
    .int('Enter a whole number.')
    .refine((n) => n !== 0, 'Enter a non-zero change.')
    .refine((n) => Math.abs(n) <= 100000, 'That change is too large.'),
  reason: z.enum(['adjustment', 'restock', 'damage', 'expiry', 'return']),
  note: text(200),
});

export const batchSchema = z
  .object({
    variantId: uuidField,
    batchNo: z.string().trim().min(1, 'Enter the batch number.').max(40),
    mfgDate: z
      .string()
      .optional()
      .transform((v) => v || null),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the expiry date.'),
    quantity: intField('Quantity', 0, 1_000_000),
    addToStock: checkbox,
    notes: text(200),
  })
  .refine((b) => !b.mfgDate || b.mfgDate < b.expiryDate, { path: ['expiryDate'], message: 'Expiry must be after the manufacturing date.' });

export const couponAdminSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,30}$/, 'Codes are 3–30 letters, numbers, - or _.'),
    description: z.string().trim().max(200).default(''),
    kind: z.enum(['percent', 'fixed']),
    value: z.string().trim(),
    minSubtotal: z.string().trim().optional(),
    maxDiscount: z.string().trim().optional(),
    startsAt: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v + 'T00:00:00+05:30') : null)),
    endsAt: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v + 'T23:59:59+05:30') : null)),
    usageLimit: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : null)),
    perUserLimit: z.coerce.number().int().min(1).max(100).default(1),
    excludePharmacy: checkbox,
  })
  .transform((c, ctx) => {
    const num = (s: string | undefined) => (s ? Number(s.replace(/[₹,]/g, '')) : NaN);
    const value = c.kind === 'percent' ? Math.round(num(c.value)) : Math.round(num(c.value) * 100);
    if (!Number.isFinite(value) || value <= 0 || (c.kind === 'percent' && value > 90)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: c.kind === 'percent' ? 'Enter a percentage between 1 and 90.' : 'Enter the discount in rupees.' });
    }
    const minSubtotalPaise = c.minSubtotal ? Math.round(num(c.minSubtotal) * 100) : 0;
    const maxDiscountPaise = c.maxDiscount ? Math.round(num(c.maxDiscount) * 100) : null;
    if (!Number.isFinite(minSubtotalPaise) || minSubtotalPaise < 0) ctx.addIssue({ code: 'custom', path: ['minSubtotal'], message: 'Enter a rupee amount.' });
    if (maxDiscountPaise !== null && (!Number.isFinite(maxDiscountPaise) || maxDiscountPaise <= 0))
      ctx.addIssue({ code: 'custom', path: ['maxDiscount'], message: 'Enter a rupee amount.' });
    if (c.usageLimit !== null && (!Number.isInteger(c.usageLimit) || c.usageLimit < 1)) ctx.addIssue({ code: 'custom', path: ['usageLimit'], message: 'Enter a whole number.' });
    if (c.startsAt && c.endsAt && c.endsAt < c.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'End date must be after the start date.' });
    return { ...c, value, minSubtotalPaise, maxDiscountPaise };
  });
