import type { App } from '../../app.ts';
import type { Ctx } from '../../http/context.ts';
import { HttpError, UserFacingError } from '../../http/errors.ts';
import { isUniqueViolation } from '../../db/db.ts';
import { audit } from '../../services/audit.ts';
import { moveStock } from '../../services/inventory.ts';
import { batchSchema, brandSchema, categorySchema, parseVariants, productSchema, saveProduct, setProductStatus, stockAdjustSchema } from '../../services/admin-catalog.ts';
import { parseWith, type FieldErrors } from '../../validation.ts';
import { BatchesPage, InventoryPage, ProductForm, ProductsList, TaxonomyPage, variantToForm, type AdminProductRow, type VariantFormRow } from '../../../ui/admin/catalog.tsx';
import { actor, requireUuid } from '../helpers.ts';
import { formValues, renderAdmin } from './common.tsx';

async function productFormData(ctx: Ctx) {
  const [brands, categories] = await Promise.all([
    ctx.app.db.many<{ id: string; name: string }>('SELECT id, name FROM brands ORDER BY name'),
    ctx.app.db.many<{ id: string; name: string; department: string }>('SELECT id, name, department FROM categories ORDER BY department, sort_order, name'),
  ]);
  return { brands, categories };
}

async function showProductForm(ctx: Ctx, id: string | null, values: Record<string, string>, variants: VariantFormRow[], errors?: FieldErrors, status = 200) {
  const { brands, categories } = await productFormData(ctx);
  const def = Number(values.defaultVariant ?? 0) || 0;
  await renderAdmin(
    ctx,
    id ? 'Edit product' : 'Add product',
    <ProductForm id={id} values={values} variants={variants} defaultVariant={def} errors={errors} brands={brands} categories={categories} canSeeRxNote />,
    status,
  );
}

function variantsFromForm(form: Record<string, string>): VariantFormRow[] {
  const n = Math.min(Number(form.variantCount ?? 0) || 0, 20);
  const out: VariantFormRow[] = [];
  for (let i = 0; i < n; i++) {
    const row: VariantFormRow = {
      id: form[`v${i}_id`] || undefined,
      name: form[`v${i}_name`],
      sku: form[`v${i}_sku`],
      mrp: form[`v${i}_mrp`],
      price: form[`v${i}_price`],
      lowStock: form[`v${i}_lowStock`],
      weight: form[`v${i}_weight`],
      isActive: form[`v${i}_isActive`] === 'on',
    };
    if (row.id || row.name || row.sku || row.mrp || row.price) out.push(row);
  }
  return out;
}

export function adminCatalogRoutes(app: App) {
  const r = app.router;
  const P = { perm: 'products.manage' as const };

  r.get(
    '/admin/products',
    async (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim().slice(0, 80);
      const status = ['draft', 'active', 'archived'].includes(ctx.query.get('status') ?? '') ? ctx.query.get('status')! : '';
      const rows = await ctx.app.db.many<AdminProductRow>(
        `SELECT p.id, p.name, p.slug, p.status, p.classification, p.is_sample, p.updated_at, b.name AS brand_name, c.name AS category_name,
                (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
                (SELECT coalesce(sum(stock), 0)::int FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS total_stock,
                (SELECT min(price_paise) FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS min_price
           FROM products p JOIN brands b ON b.id = p.brand_id JOIN categories c ON c.id = p.category_id
          WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku ILIKE '%' || $1 || '%'))
            AND ($2 = '' OR p.status::text = $2)
          ORDER BY p.updated_at DESC LIMIT 300`,
        [q.replace(/[%_\\]/g, ''), status],
      );
      await renderAdmin(ctx, 'Products', <ProductsList rows={rows} q={q} status={status} />);
    },
    P,
  );

  r.get('/admin/products/new', (ctx) => showProductForm(ctx, null, { status: 'draft', classification: 'cosmetic', taxRatePercent: '18' }, []), P);

  const saveHandler = (isNew: boolean) => async (ctx: Ctx) => {
    const id = isNew ? null : requireUuid(ctx.params.id);
    const form = ctx.form;
    const p = parseWith(productSchema, form);
    const v = parseVariants(form);
    const errors: FieldErrors = { ...(p.ok ? {} : p.errors), ...v.errors };
    if (!p.ok || Object.keys(v.errors).length) return showProductForm(ctx, id, formValues(form), variantsFromForm(form), errors, 422);
    try {
      const savedId = await saveProduct(ctx.app.db, id, p.data, v.rows, actor(ctx));
      ctx.setFlash('success', isNew ? 'Product created.' : 'Product saved.');
      ctx.redirect(`/admin/products/${savedId}`);
    } catch (e) {
      if (!(e instanceof UserFacingError)) throw e;
      return showProductForm(ctx, id, formValues(form), variantsFromForm(form), { [e.code === 'slug' ? 'slug' : '_form']: e.message }, 422);
    }
  };
  r.post('/admin/products/new', saveHandler(true), { ...P, rateLimit: 'adminWrite' });

  r.get(
    '/admin/products/:id',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const p = await ctx.app.db.one<Record<string, unknown>>('SELECT * FROM products WHERE id = $1', [id]);
      if (!p) throw new HttpError(404, 'Product not found.');
      const variants = await ctx.app.db.many<{
        id: string;
        name: string;
        sku: string;
        mrp_paise: number;
        price_paise: number;
        low_stock_threshold: number;
        weight_grams: number;
        is_active: boolean;
        is_default: boolean;
        stock: number;
      }>(
        'SELECT id, name, sku, mrp_paise, price_paise, low_stock_threshold, weight_grams, is_active, is_default, stock FROM product_variants WHERE product_id = $1 ORDER BY sort_order, created_at',
        [id],
      );
      const on = (b: unknown) => (b ? 'on' : '');
      const values: Record<string, string> = {
        name: String(p.name),
        slug: String(p.slug),
        brandId: String(p.brand_id),
        categoryId: String(p.category_id),
        shortDescription: String(p.short_description ?? ''),
        description: String(p.description ?? ''),
        keyActive: String(p.key_active ?? ''),
        keyActiveStrength: String(p.key_active_strength ?? ''),
        ingredients: String(p.ingredients ?? ''),
        usageInstructions: String(p.usage_instructions ?? ''),
        warnings: String(p.warnings ?? ''),
        storage: String(p.storage ?? ''),
        manufacturerName: String(p.manufacturer_name ?? ''),
        manufacturerAddress: String(p.manufacturer_address ?? ''),
        marketedBy: String(p.marketed_by ?? ''),
        countryOfOrigin: String(p.country_of_origin ?? ''),
        classification: String(p.classification),
        classificationVerified: on(p.classification_verified),
        requiresPrescription: on(p.requires_prescription),
        hsnCode: String(p.hsn_code ?? ''),
        taxRatePercent: String(Number(p.tax_rate_bps) / 100),
        status: String(p.status),
        isFeatured: on(p.is_featured),
        isSample: on(p.is_sample),
        images: (p.images as Array<{ url: string; alt: string }>).map((i) => `${i.url} | ${i.alt}`).join('\n'),
        tags: (p.tags as string[]).join(', '),
        skinTypes: (p.skin_types as string[]).join(', '),
        seoTitle: String(p.seo_title ?? ''),
        seoDescription: String(p.seo_description ?? ''),
        defaultVariant: String(
          Math.max(
            0,
            variants.findIndex((x) => x.is_default),
          ),
        ),
      };
      await showProductForm(ctx, id, values, variants.map(variantToForm));
    },
    P,
  );
  r.post('/admin/products/:id', saveHandler(false), { ...P, rateLimit: 'adminWrite' });

  r.post(
    '/admin/products/:id/status',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const s = ctx.form.status;
      if (s !== 'active' && s !== 'archived' && s !== 'draft') throw new HttpError(400, 'Invalid status.');
      try {
        await setProductStatus(ctx.app.db, id, s, actor(ctx));
        ctx.setFlash('success', s === 'active' ? 'Product published.' : s === 'archived' ? 'Product archived.' : 'Product moved to drafts.');
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect(`/admin/products/${id}`);
    },
    P,
  );

  // ── Taxonomy ──
  const T = { perm: 'taxonomy.manage' as const };
  const showTaxonomy = async (ctx: Ctx, extra: Parameters<typeof TaxonomyPage>[0] extends infer X ? Partial<X> : never = {}, status = 200) => {
    const [categories, brands] = await Promise.all([
      ctx.app.db.many<{ id: string; slug: string; name: string; department: string; sort_order: number; is_active: boolean; product_count: number; description: string | null }>(
        `SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id) AS product_count FROM categories c ORDER BY department, sort_order, name`,
      ),
      ctx.app.db.many<{ id: string; slug: string; name: string; is_sample: boolean; product_count: number }>(
        `SELECT b.*, (SELECT count(*)::int FROM products p WHERE p.brand_id = b.id) AS product_count FROM brands b ORDER BY name`,
      ),
    ]);
    await renderAdmin(ctx, 'Categories & brands', <TaxonomyPage categories={categories} brands={brands} {...extra} />, status);
  };
  r.get('/admin/taxonomy', (ctx) => showTaxonomy(ctx), T);
  r.post(
    '/admin/taxonomy/categories',
    async (ctx) => {
      const v = parseWith(categorySchema, ctx.form);
      if (!v.ok) return showTaxonomy(ctx, { catErrors: v.errors, catValues: formValues(ctx.form) }, 422);
      try {
        const row = await ctx.app.db.one<{ id: string }>(
          'INSERT INTO categories (name, slug, description, department, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [v.data.name, v.data.slug, v.data.description, v.data.department, v.data.sortOrder, v.data.isActive],
        );
        await audit(ctx.app.db, actor(ctx), 'category.created', 'category', row!.id, { name: v.data.name });
      } catch (e) {
        if (isUniqueViolation(e)) return showTaxonomy(ctx, { catErrors: { slug: 'That slug is already used.' }, catValues: formValues(ctx.form) }, 422);
        throw e;
      }
      ctx.setFlash('success', 'Category added.');
      ctx.redirect('/admin/taxonomy');
    },
    T,
  );
  r.post(
    '/admin/taxonomy/categories/:id/toggle',
    async (ctx) => {
      const id = requireUuid(ctx.params.id);
      const row = await ctx.app.db.one<{ is_active: boolean; name: string }>('UPDATE categories SET is_active = NOT is_active WHERE id = $1 RETURNING is_active, name', [id]);
      if (!row) throw new HttpError(404, 'Category not found.');
      await audit(ctx.app.db, actor(ctx), row.is_active ? 'category.shown' : 'category.hidden', 'category', id, { name: row.name });
      ctx.setFlash('success', `${row.name} is now ${row.is_active ? 'visible' : 'hidden'}.`);
      ctx.redirect('/admin/taxonomy');
    },
    T,
  );
  r.post(
    '/admin/taxonomy/brands',
    async (ctx) => {
      const v = parseWith(brandSchema, ctx.form);
      if (!v.ok) return showTaxonomy(ctx, { brandErrors: v.errors, brandValues: formValues(ctx.form) }, 422);
      try {
        const row = await ctx.app.db.one<{ id: string }>('INSERT INTO brands (name, slug, description, is_sample) VALUES ($1,$2,$3,$4) RETURNING id', [
          v.data.name,
          v.data.slug,
          v.data.description,
          v.data.isSample,
        ]);
        await audit(ctx.app.db, actor(ctx), 'brand.created', 'brand', row!.id, { name: v.data.name });
      } catch (e) {
        if (isUniqueViolation(e)) return showTaxonomy(ctx, { brandErrors: { slug: 'That slug is already used.' }, brandValues: formValues(ctx.form) }, 422);
        throw e;
      }
      ctx.setFlash('success', 'Brand added.');
      ctx.redirect('/admin/taxonomy');
    },
    T,
  );

  // ── Inventory ──
  const I = { perm: 'inventory.manage' as const };
  const showInventory = async (ctx: Ctx, errors?: FieldErrors, status = 200) => {
    const filter = ctx.query.get('filter') === 'low' ? 'low' : '';
    const rows = await ctx.app.db.many<{
      variant_id: string;
      sku: string;
      product_name: string;
      product_id: string;
      variant_name: string;
      stock: number;
      low_stock_threshold: number;
      status: string;
    }>(
      `SELECT v.id AS variant_id, v.sku, p.name AS product_name, p.id AS product_id, v.name AS variant_name, v.stock, v.low_stock_threshold, p.status
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.status <> 'archived' ${filter === 'low' ? 'AND v.stock <= v.low_stock_threshold' : ''}
        ORDER BY (v.stock <= v.low_stock_threshold) DESC, p.name, v.sort_order LIMIT 500`,
    );
    const movements = await ctx.app.db.many<{
      sku: string;
      delta: number;
      balance_after: number;
      reason: string;
      reference: string | null;
      note: string | null;
      created_at: Date;
      actor: string | null;
    }>(
      `SELECT v.sku, m.delta, m.balance_after, m.reason, m.reference, m.note, m.created_at, u.name AS actor
         FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id LEFT JOIN users u ON u.id = m.actor_id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 40`,
    );
    await renderAdmin(ctx, 'Stock', <InventoryPage rows={rows} filter={filter} errors={errors} movements={movements} />, status);
  };
  r.get('/admin/inventory', (ctx) => showInventory(ctx), I);
  r.post(
    '/admin/inventory/adjust',
    async (ctx) => {
      const v = parseWith(stockAdjustSchema, ctx.form);
      if (!v.ok) return showInventory(ctx, v.errors, 422);
      try {
        const balance = await ctx.app.db.tx(async (t) => {
          const b = await moveStock(t, { variantId: v.data.variantId, delta: v.data.delta, reason: v.data.reason, note: v.data.note, actorId: ctx.user!.id });
          await audit(t, actor(ctx), 'stock.adjusted', 'variant', v.data.variantId, { delta: v.data.delta, reason: v.data.reason, balance: b });
          return b;
        });
        ctx.setFlash('success', `Stock updated. New balance: ${balance}.`);
      } catch (e) {
        if (!(e instanceof UserFacingError)) throw e;
        ctx.setFlash('error', e.message);
      }
      ctx.redirect('/admin/inventory');
    },
    { ...I, rateLimit: 'adminWrite' },
  );

  const showBatches = async (ctx: Ctx, errors?: FieldErrors, values?: Record<string, string>, status = 200) => {
    const [batches, variants] = await Promise.all([
      ctx.app.db.many<{ id: string; batch_no: string; expiry_date: string; mfg_date: string | null; quantity: number; sku: string; product_name: string; days_left: number }>(
        `SELECT b.id, b.batch_no, b.expiry_date::text, b.mfg_date::text, b.quantity, v.sku, p.name AS product_name, (b.expiry_date - current_date)::int AS days_left
           FROM inventory_batches b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
          WHERE b.quantity > 0 ORDER BY b.expiry_date LIMIT 300`,
      ),
      ctx.app.db.many<{ id: string; sku: string; label: string }>(
        `SELECT v.id, v.sku, p.name || ' — ' || v.name || ' (' || v.sku || ')' AS label FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.status <> 'archived' ORDER BY p.name`,
      ),
    ]);
    await renderAdmin(ctx, 'Batches & expiry', <BatchesPage batches={batches} variants={variants} errors={errors} values={values} />, status);
  };
  r.get('/admin/inventory/batches', (ctx) => showBatches(ctx), I);
  r.post(
    '/admin/inventory/batches',
    async (ctx) => {
      const v = parseWith(batchSchema, ctx.form);
      if (!v.ok) return showBatches(ctx, v.errors, formValues(ctx.form), 422);
      try {
        await ctx.app.db.tx(async (t) => {
          const row = await t.one<{ id: string }>(
            `INSERT INTO inventory_batches (variant_id, batch_no, mfg_date, expiry_date, quantity, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [v.data.variantId, v.data.batchNo, v.data.mfgDate, v.data.expiryDate, v.data.quantity, v.data.notes, ctx.user!.id],
          );
          if (v.data.addToStock && v.data.quantity > 0) {
            await moveStock(t, { variantId: v.data.variantId, delta: v.data.quantity, reason: 'restock', reference: `batch ${v.data.batchNo}`, actorId: ctx.user!.id });
          }
          await audit(t, actor(ctx), 'batch.received', 'batch', row!.id, { batch: v.data.batchNo, qty: v.data.quantity, expiry: v.data.expiryDate });
        });
      } catch (e) {
        if (isUniqueViolation(e)) return showBatches(ctx, { batchNo: 'This batch number is already recorded for that product.' }, formValues(ctx.form), 422);
        throw e;
      }
      ctx.setFlash('success', 'Batch recorded.');
      ctx.redirect('/admin/inventory/batches');
    },
    { ...I, rateLimit: 'adminWrite' },
  );
}
