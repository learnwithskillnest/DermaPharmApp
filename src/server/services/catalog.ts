import type { Queryable } from '../db/db.ts';
import type { Classification } from './pricing.ts';

export interface ProductImage {
  url: string;
  alt: string;
}

export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  brand_name: string;
  brand_slug: string;
  category_slug: string;
  category_name: string;
  short_description: string;
  key_active: string | null;
  key_active_strength: string | null;
  classification: Classification;
  requires_prescription: boolean;
  images: ProductImage[];
  is_sample: boolean;
  variant_id: string | null;
  variant_name: string | null;
  price_paise: number | null;
  mrp_paise: number | null;
  total_stock: number;
  variant_count: number;
}

export interface Variant {
  id: string;
  sku: string;
  name: string;
  mrp_paise: number;
  price_paise: number;
  stock: number;
  low_stock_threshold: number;
  is_default: boolean;
}

export interface ProductDetail extends ProductCard {
  description: string;
  ingredients: string | null;
  usage_instructions: string | null;
  warnings: string | null;
  storage: string | null;
  manufacturer_name: string | null;
  manufacturer_address: string | null;
  marketed_by: string | null;
  country_of_origin: string | null;
  classification_verified: boolean;
  hsn_code: string | null;
  tax_rate_bps: number;
  tags: string[];
  skin_types: string[];
  seo_title: string | null;
  seo_description: string | null;
  category_department: string;
  updated_at: Date;
  variants: Variant[];
  nearest_expiry: string | null;
}

export interface Visibility {
  otcVisible: boolean;
  rxListingVisible: boolean;
}

export const SORTS = {
  relevance: 'Most relevant',
  newest: 'Newest',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  name: 'Name: A–Z',
} as const;
export type SortKey = keyof typeof SORTS;

export interface ListParams {
  q?: string;
  categorySlugs?: string[];
  department?: string;
  brandSlugs?: string[];
  minPaise?: number;
  maxPaise?: number;
  inStock?: boolean;
  sort?: SortKey;
  page?: number;
  perPage?: number;
  featuredOnly?: boolean;
  classifications?: Classification[];
  /** General catalogue/search excludes prescription items; pharmacy pages opt in. */
  includePrescription?: boolean;
  excludeIds?: string[];
}

const CARD_SELECT = `
  p.id, p.slug, p.name, b.name AS brand_name, b.slug AS brand_slug, c.slug AS category_slug, c.name AS category_name,
  p.short_description, p.key_active, p.key_active_strength, p.classification, p.requires_prescription, p.images, p.is_sample,
  v.id AS variant_id, v.name AS variant_name, v.price_paise, v.mrp_paise,
  coalesce(st.total_stock, 0)::int AS total_stock, coalesce(st.variant_count, 0)::int AS variant_count`;

const CARD_JOINS = `
  JOIN brands b ON b.id = p.brand_id
  JOIN categories c ON c.id = p.category_id
  LEFT JOIN LATERAL (
    SELECT id, name, price_paise, mrp_paise FROM product_variants
     WHERE product_id = p.id AND is_active ORDER BY is_default DESC, price_paise ASC, sort_order LIMIT 1
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT sum(stock) AS total_stock, count(*) AS variant_count FROM product_variants WHERE product_id = p.id AND is_active
  ) st ON true`;

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

function visibilityClause(vis: Visibility, includeRx: boolean, add: (v: unknown) => string): string {
  const allowed: Classification[] = ['cosmetic', 'personal_care'];
  if (vis.otcVisible) allowed.push('otc_pharmacy');
  if (includeRx && vis.rxListingVisible) allowed.push('prescription');
  return `p.classification = ANY(${add(allowed)}::product_class[])`;
}

export async function listProducts(db: Queryable, params: ListParams, vis: Visibility) {
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [`p.status = 'active'`, `c.is_active`, visibilityClause(vis, !!params.includePrescription, add)];
  let rank = '0';
  const q = params.q?.trim().slice(0, 100);
  if (q) {
    const tsq = add(q);
    const like = add('%' + escapeLike(q.toLowerCase()) + '%');
    where.push(
      `(p.search_vector @@ websearch_to_tsquery('simple', ${tsq}) OR lower(p.name) LIKE ${like} OR lower(coalesce(p.key_active, '')) LIKE ${like} OR lower(b.name) LIKE ${like})`,
    );
    rank = `ts_rank(p.search_vector, websearch_to_tsquery('simple', ${tsq})) + CASE WHEN lower(p.name) LIKE ${like} THEN 1 ELSE 0 END`;
  }
  if (params.categorySlugs?.length) where.push(`c.slug = ANY(${add(params.categorySlugs)}::text[])`);
  if (params.department) where.push(`c.department = ${add(params.department)}`);
  if (params.brandSlugs?.length) where.push(`b.slug = ANY(${add(params.brandSlugs)}::text[])`);
  if (params.classifications?.length) where.push(`p.classification = ANY(${add(params.classifications)}::product_class[])`);
  if (params.featuredOnly) where.push('p.is_featured');
  if (params.excludeIds?.length) where.push(`NOT (p.id = ANY(${add(params.excludeIds)}::uuid[]))`);
  if (params.minPaise !== undefined) where.push(`v.price_paise >= ${add(params.minPaise)}`);
  if (params.maxPaise !== undefined) where.push(`v.price_paise <= ${add(params.maxPaise)}`);
  if (params.inStock) where.push('coalesce(st.total_stock, 0) > 0');

  const sort = params.sort ?? (q ? 'relevance' : 'newest');
  const orderBy = {
    relevance: q ? `${rank} DESC, p.is_featured DESC, p.name` : 'p.is_featured DESC, p.published_at DESC NULLS LAST, p.name',
    newest: 'p.published_at DESC NULLS LAST, p.created_at DESC, p.name',
    price_asc: 'v.price_paise ASC NULLS LAST, p.name',
    price_desc: 'v.price_paise DESC NULLS LAST, p.name',
    name: 'p.name ASC',
  }[sort];

  const perPage = Math.min(Math.max(params.perPage ?? 12, 1), 48);
  const page = Math.max(params.page ?? 1, 1);
  const whereSql = where.join(' AND ');
  const countRow = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM products p ${CARD_JOINS} WHERE ${whereSql}`, values);
  const total = countRow?.n ?? 0;
  const items = await db.many<ProductCard>(
    `SELECT ${CARD_SELECT} FROM products p ${CARD_JOINS} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
    values,
  );
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)), sort };
}

/** Brand facet + price bounds for the current non-brand, non-price filters. */
export async function listFacets(db: Queryable, params: ListParams, vis: Visibility) {
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [`p.status = 'active'`, 'c.is_active', visibilityClause(vis, !!params.includePrescription, add)];
  if (params.categorySlugs?.length) where.push(`c.slug = ANY(${add(params.categorySlugs)}::text[])`);
  if (params.department) where.push(`c.department = ${add(params.department)}`);
  if (params.classifications?.length) where.push(`p.classification = ANY(${add(params.classifications)}::product_class[])`);
  const q = params.q?.trim().slice(0, 100);
  if (q) {
    const tsq = add(q);
    const like = add('%' + escapeLike(q.toLowerCase()) + '%');
    where.push(
      `(p.search_vector @@ websearch_to_tsquery('simple', ${tsq}) OR lower(p.name) LIKE ${like} OR lower(coalesce(p.key_active, '')) LIKE ${like} OR lower(b.name) LIKE ${like})`,
    );
  }
  const w = where.join(' AND ');
  const brands = await db.many<{ slug: string; name: string; count: number }>(
    `SELECT b.slug, b.name, count(*)::int AS count FROM products p ${CARD_JOINS} WHERE ${w} GROUP BY b.slug, b.name ORDER BY b.name`,
    values,
  );
  const bounds = await db.one<{ min: number | null; max: number | null }>(
    `SELECT min(v.price_paise)::int AS min, max(v.price_paise)::int AS max FROM products p ${CARD_JOINS} WHERE ${w}`,
    values,
  );
  return { brands, minPaise: bounds?.min ?? 0, maxPaise: bounds?.max ?? 0 };
}

export async function getProductBySlug(db: Queryable, slug: string, vis: Visibility, opts: { includeDraft?: boolean } = {}): Promise<ProductDetail | null> {
  const p = await db.one<ProductDetail>(
    `SELECT ${CARD_SELECT}, p.description, p.ingredients, p.usage_instructions, p.warnings, p.storage, p.manufacturer_name,
            p.manufacturer_address, p.marketed_by, p.country_of_origin, p.classification_verified, p.hsn_code, p.tax_rate_bps,
            p.tags, p.skin_types, p.seo_title, p.seo_description, p.updated_at, p.status, c.department AS category_department
       FROM products p ${CARD_JOINS}
      WHERE p.slug = $1 ${opts.includeDraft ? '' : `AND p.status = 'active'`}`,
    [slug],
  );
  if (!p) return null;
  if (!opts.includeDraft) {
    if (p.classification === 'otc_pharmacy' && !vis.otcVisible) return null;
    if (p.classification === 'prescription' && !vis.rxListingVisible) return null;
  }
  p.variants = await db.many<Variant>(
    `SELECT id, sku, name, mrp_paise, price_paise, stock, low_stock_threshold, is_default
       FROM product_variants WHERE product_id = $1 AND is_active ORDER BY sort_order, price_paise`,
    [p.id],
  );
  const exp = await db.one<{ d: string | null }>(
    `SELECT min(b.expiry_date)::text AS d FROM inventory_batches b JOIN product_variants v ON v.id = b.variant_id
      WHERE v.product_id = $1 AND b.quantity > 0 AND b.expiry_date >= current_date`,
    [p.id],
  );
  p.nearest_expiry = exp?.d ?? null;
  return p;
}

export async function relatedProducts(db: Queryable, p: ProductDetail, vis: Visibility, limit = 4) {
  const { items } = await listProducts(
    db,
    { categorySlugs: [p.category_slug], excludeIds: [p.id], perPage: limit, sort: 'relevance', includePrescription: p.classification === 'prescription' },
    vis,
  );
  if (items.length >= limit) return items;
  const more = await listProducts(db, { department: p.category_department, excludeIds: [p.id, ...items.map((i) => i.id)], perPage: limit - items.length }, vis);
  return [...items, ...more.items];
}

export async function productsByIds(db: Queryable, ids: string[], vis: Visibility): Promise<ProductCard[]> {
  if (!ids.length) return [];
  const rows = await db.many<ProductCard>(`SELECT ${CARD_SELECT} FROM products p ${CARD_JOINS} WHERE p.id = ANY($1::uuid[]) AND p.status = 'active'`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is ProductCard => !!r)
    .filter((r) => (r.classification === 'otc_pharmacy' ? vis.otcVisible : r.classification === 'prescription' ? vis.rxListingVisible : true));
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  department: string;
  product_count: number;
}

export async function listCategories(db: Queryable, opts: { activeOnly?: boolean } = {}) {
  return db.many<CategoryRow>(
    `SELECT c.id, c.slug, c.name, c.description, c.department,
            (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.status = 'active') AS product_count
       FROM categories c ${opts.activeOnly === false ? '' : 'WHERE c.is_active'}
      ORDER BY c.sort_order, c.name`,
  );
}

export async function getCategory(db: Queryable, slug: string) {
  return db.one<CategoryRow>(`SELECT c.id, c.slug, c.name, c.description, c.department, 0 AS product_count FROM categories c WHERE c.slug = $1 AND c.is_active`, [slug]);
}

export async function suggest(db: Queryable, q: string, vis: Visibility) {
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return { products: [], categories: [] };
  const { items } = await listProducts(db, { q: term, perPage: 6, sort: 'relevance' }, vis);
  const like = '%' + escapeLike(term.toLowerCase()) + '%';
  const categories = await db.many<{ slug: string; name: string }>(`SELECT slug, name FROM categories WHERE is_active AND lower(name) LIKE $1 ORDER BY sort_order LIMIT 3`, [like]);
  return {
    products: items.map((p) => ({ slug: p.slug, name: p.name, brand: p.brand_name, price_paise: p.price_paise, image: p.images[0]?.url ?? null })),
    categories,
  };
}

/** Distinct key actives for "shop by active ingredient". */
export async function activeIngredients(db: Queryable, _vis: Visibility) {
  return db.many<{ key_active: string; key_active_strength: string | null; slug: string; count: number }>(
    `SELECT p.key_active,
            CASE WHEN count(DISTINCT coalesce(p.key_active_strength, '')) = 1 THEN min(p.key_active_strength) END AS key_active_strength, min(p.slug) AS slug, count(*)::int AS count
       FROM products p WHERE p.status = 'active' AND p.key_active IS NOT NULL
        AND p.classification IN ('cosmetic', 'personal_care') -- skincare actives only; pharmacy items are browsed under /pharmacy
      GROUP BY p.key_active ORDER BY count(*) DESC, p.key_active LIMIT 8`,
  );
}

export async function recordView(db: Queryable, ownerKey: string, productId: string) {
  await db.query(
    `INSERT INTO recently_viewed (owner_key, product_id) VALUES ($1, $2)
     ON CONFLICT (owner_key, product_id) DO UPDATE SET viewed_at = now()`,
    [ownerKey, productId],
  );
  // Keep the list short.
  await db.query(
    `DELETE FROM recently_viewed WHERE owner_key = $1 AND product_id NOT IN (
       SELECT product_id FROM recently_viewed WHERE owner_key = $1 ORDER BY viewed_at DESC LIMIT 12)`,
    [ownerKey],
  );
}

export async function recentlyViewed(db: Queryable, ownerKey: string, vis: Visibility, excludeId?: string) {
  const ids = (
    await db.many<{ product_id: string }>(
      `SELECT product_id FROM recently_viewed WHERE owner_key = $1 AND product_id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000') ORDER BY viewed_at DESC LIMIT 8`,
      [ownerKey, excludeId ?? null],
    )
  ).map((r) => r.product_id);
  return productsByIds(db, ids, vis);
}
