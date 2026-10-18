/**
 * Seeds the development database with CLEARLY MARKED SAMPLE DATA.
 * Idempotent: products/variants are upserted by slug/SKU; stock is only set
 * when a variant is first created. Re-running is safe.
 *
 *   npm run db:seed               catalogue + coupons + demo accounts (dev only)
 *   npm run db:seed -- --no-users catalogue + coupons only
 *
 * Refuses to create demo accounts when NODE_ENV=production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../src/server/config.ts';
import { createDatabase, asJson, type Queryable } from '../src/server/db/db.ts';
import { hashPassword } from '../src/server/auth/password.ts';
import { moveStock } from '../src/server/services/inventory.ts';
import { BRANDS, CATEGORIES, COUPONS, PRODUCTS, SAMPLE_MANUFACTURER, SAMPLE_MANUFACTURER_ADDRESS } from './seed-data.ts';
import { FAVICON_SVG, PLACEHOLDER_SVG, productArt } from './art.ts';

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const prod = process.env.NODE_ENV === 'production';
const withUsers = !process.argv.includes('--no-users') && !prod;

/** Development-only demo password. Documented in README; never used in production. */
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'GlowDemo#2026';
const DEMO_USERS = [
  { email: 'admin@glowderma.test', name: 'Demo Admin', role: 'admin', reg: null },
  { email: 'staff@glowderma.test', name: 'Demo Staff', role: 'staff', reg: null },
  { email: 'pharmacist@glowderma.test', name: 'Demo Pharmacist', role: 'pharmacist', reg: 'DEMO-PHARM-0001' },
  { email: 'customer@glowderma.test', name: 'Asha Demo', role: 'customer', reg: null },
] as const;

const publicDir = path.resolve(process.cwd(), 'public');

function writeArt() {
  const dir = path.join(publicDir, 'images/products');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'images/placeholder.svg'), PLACEHOLDER_SVG);
  fs.writeFileSync(path.join(publicDir, 'favicon.svg'), FAVICON_SVG);
  fs.writeFileSync(
    path.join(publicDir, 'site.webmanifest'),
    JSON.stringify(
      {
        name: 'GlowDerma Store',
        short_name: 'GlowDerma',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#163a2d',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      null,
      2,
    ),
  );
  const brandName = new Map<string, string>(BRANDS.map((b) => [b.slug, b.name]));
  const dept = new Map<string, string>(CATEGORIES.map((c) => [c.slug, c.department]));
  for (const p of PRODUCTS) {
    const svg = productArt({
      name: p.name,
      brandName: brandName.get(p.brand)!,
      strength: p.strength,
      department: dept.get(p.category)!,
      form: p.form,
      rx: p.classification === 'prescription',
    });
    fs.writeFileSync(path.join(dir, `${p.slug}.svg`), svg);
  }
}

async function seedCatalogue(t: Queryable) {
  const catId = new Map<string, string>();
  for (const [i, c] of CATEGORIES.entries()) {
    const r = await t.one<{ id: string }>(
      `INSERT INTO categories (slug, name, description, department, sort_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, department = EXCLUDED.department, sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [c.slug, c.name, c.description, c.department, i * 10],
    );
    catId.set(c.slug, r!.id);
  }
  const brandId = new Map<string, string>();
  for (const b of BRANDS) {
    const r = await t.one<{ id: string }>(
      `INSERT INTO brands (slug, name, description, is_sample) VALUES ($1, $2, $3, true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description RETURNING id`,
      [b.slug, b.name, b.description],
    );
    brandId.set(b.slug, r!.id);
  }

  let created = 0;
  for (const p of PRODUCTS) {
    const images = [{ url: `/images/products/${p.slug}.svg`, alt: `${p.name} — sample packaging illustration, not the actual product` }];
    const prod = await t.one<{ id: string }>(
      `INSERT INTO products (slug, name, brand_id, category_id, short_description, description, key_active, key_active_strength, ingredients,
                             usage_instructions, warnings, storage, manufacturer_name, manufacturer_address, marketed_by, country_of_origin,
                             classification, classification_verified, requires_prescription, hsn_code, tax_rate_bps, status, is_featured, images,
                             tags, skin_types, seo_title, seo_description, is_sample, published_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'India',$16,false,$17,$18,$19,'active',$20,$21,$22,$23,$24,$25,true,
               now() - make_interval(days => $26), now() - make_interval(days => $26))
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, brand_id = EXCLUDED.brand_id, category_id = EXCLUDED.category_id,
         short_description = EXCLUDED.short_description, description = EXCLUDED.description, key_active = EXCLUDED.key_active,
         key_active_strength = EXCLUDED.key_active_strength, ingredients = EXCLUDED.ingredients, usage_instructions = EXCLUDED.usage_instructions,
         warnings = EXCLUDED.warnings, storage = EXCLUDED.storage, classification = EXCLUDED.classification,
         requires_prescription = EXCLUDED.requires_prescription, hsn_code = EXCLUDED.hsn_code, tax_rate_bps = EXCLUDED.tax_rate_bps,
         is_featured = EXCLUDED.is_featured, images = EXCLUDED.images, tags = EXCLUDED.tags, skin_types = EXCLUDED.skin_types,
         seo_title = EXCLUDED.seo_title, seo_description = EXCLUDED.seo_description, updated_at = now()
       RETURNING id`,
      [
        p.slug,
        p.name,
        brandId.get(p.brand),
        catId.get(p.category),
        p.short,
        p.description,
        p.keyActive ?? null,
        p.strength ?? null,
        p.ingredients ?? null,
        p.usage ?? null,
        p.warnings ?? null,
        p.storage ?? null,
        SAMPLE_MANUFACTURER,
        SAMPLE_MANUFACTURER_ADDRESS,
        '[Sample data] Marketed by — to be provided',
        p.classification,
        p.classification === 'prescription',
        p.hsn,
        p.taxBps,
        !!p.featured,
        asJson(images),
        p.tags ?? [],
        p.skinTypes ?? [],
        `${p.name} | GlowDerma Store`,
        p.short,
        p.daysAgo,
      ],
    );
    const productId = prod!.id;
    for (const [i, v] of p.variants.entries()) {
      const existing = await t.one<{ id: string }>('SELECT id FROM product_variants WHERE sku = $1', [v.sku]);
      if (existing) {
        await t.query(
          `UPDATE product_variants SET product_id = $2, name = $3, mrp_paise = $4, price_paise = $5, low_stock_threshold = $6, weight_grams = $7, is_default = $8, sort_order = $9 WHERE id = $1`,
          [existing.id, productId, v.name, v.mrp * 100, v.price * 100, v.threshold ?? 5, v.weight ?? 100, i === 0, i],
        );
        continue;
      }
      const ins = await t.one<{ id: string }>(
        `INSERT INTO product_variants (product_id, sku, name, mrp_paise, price_paise, stock, low_stock_threshold, weight_grams, is_default, sort_order)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9) RETURNING id`,
        [productId, v.sku, v.name, v.mrp * 100, v.price * 100, v.threshold ?? 5, v.weight ?? 100, i === 0, i],
      );
      if (v.stock > 0) await moveStock(t, { variantId: ins!.id, delta: v.stock, reason: 'initial', note: 'Seed: sample stock' });
      created++;
    }
    for (const b of p.batches ?? []) {
      await t.query(
        `INSERT INTO inventory_batches (variant_id, batch_no, mfg_date, expiry_date, quantity, notes)
         SELECT id, $2, current_date - $3::int, current_date + $4::int, $5, 'Sample batch' FROM product_variants WHERE sku = $1
         ON CONFLICT (variant_id, batch_no) DO NOTHING`,
        [b.sku, b.batchNo, b.mfgDaysAgo, b.expiresInDays, b.qty],
      );
    }
  }

  for (const c of COUPONS) {
    await t.query(
      `INSERT INTO coupons (code, description, kind, value, min_subtotal_paise, max_discount_paise, per_user_limit, exclude_pharmacy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (upper(code)) DO NOTHING`,
      [c.code, c.description, c.kind, c.value, c.minSubtotalPaise, c.maxDiscountPaise, c.perUserLimit, c.excludePharmacy],
    );
  }
  return created;
}

async function seedUsers(t: Queryable) {
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const u of DEMO_USERS) {
    await t.query(
      `INSERT INTO users (email, name, password_hash, role, pharmacist_reg_no, phone) VALUES ($1, $2, $3, $4, $5, '9000000000')
       ON CONFLICT (lower(email)) DO NOTHING`,
      [u.email, u.name, hash, u.role, u.reg],
    );
  }
  const cust = await t.one<{ id: string }>(`SELECT id FROM users WHERE email = 'customer@glowderma.test'`);
  if (cust) {
    const has = await t.one('SELECT 1 FROM addresses WHERE user_id = $1', [cust.id]);
    if (!has) {
      await t.query(
        `INSERT INTO addresses (user_id, label, full_name, phone, line1, line2, city, state, pincode, is_default)
         VALUES ($1, 'Home', 'Asha Demo', '9000000000', '12 Sample Street', 'Demo Apartments', 'Pune', 'Maharashtra', '411001', true)`,
        [cust.id],
      );
    }
  }
}

const db = createDatabase(url, { max: 2 });
try {
  try {
    writeArt();
  } catch (e) {
    // Read-only filesystems (e.g. the production container) already ship the committed artwork.
    console.warn(`skipped writing sample artwork: ${(e as Error).message}`);
  }
  const created = await db.tx(async (t) => {
    const n = await seedCatalogue(t);
    if (withUsers) await seedUsers(t);
    return n;
  });
  console.log(
    `seed complete: ${PRODUCTS.length} sample products (${created} new variants), ${CATEGORIES.length} categories, ${BRANDS.length} sample brands, ${COUPONS.length} coupons`,
  );
  if (withUsers) {
    console.log(`demo accounts (development only), password "${DEMO_PASSWORD}":`);
    for (const u of DEMO_USERS) console.log(`  ${u.role.padEnd(10)} ${u.email}`);
  } else if (prod) {
    console.log('NODE_ENV=production: demo accounts were NOT created. Use `npm run admin:create` for the first admin.');
  }
} catch (e) {
  console.error('seed failed:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
