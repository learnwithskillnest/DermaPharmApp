import { AdminShell, Panel, fmtDate, fmtDay } from './layout.tsx';
import { ActionButton, Checkbox, Form, FormErrors, SelectField, TextArea, TextField, type Errors, type Values } from '../forms.tsx';
import { formatINR, paiseToRupeesInput } from '../../shared/money.ts';

export interface AdminProductRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  classification: string;
  brand_name: string;
  category_name: string;
  variant_count: number;
  total_stock: number;
  min_price: number | null;
  is_sample: boolean;
  updated_at: Date;
}

const CLASS_OPTIONS = [
  { value: 'cosmetic', label: 'Cosmetic' },
  { value: 'personal_care', label: 'Personal care' },
  { value: 'otc_pharmacy', label: 'Pharmacy — non-prescription' },
  { value: 'prescription', label: 'Pharmacy — prescription only' },
];
const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft (hidden)' },
  { value: 'active', label: 'Published' },
  { value: 'archived', label: 'Archived' },
];

export function ProductsList({ rows, q, status }: { rows: AdminProductRow[]; q: string; status: string }) {
  return (
    <AdminShell
      title="Products"
      current="/admin/products"
      actions={
        <a href="/admin/products/new" className="btn btn-primary btn-sm">
          Add product
        </a>
      }
    >
      <form method="get" className="mb-4 flex flex-wrap items-end gap-2" aria-label="Filter products">
        <div className="field">
          <label htmlFor="pq" className="hint">
            Search
          </label>
          <input id="pq" name="q" className="input min-h-10 w-64" defaultValue={q} placeholder="Name or SKU" />
        </div>
        <div className="field">
          <label htmlFor="ps" className="hint">
            Status
          </label>
          <select id="ps" name="status" className="select min-h-10" defaultValue={status}>
            <option value="">All</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button className="btn btn-secondary btn-sm" type="submit">
          Filter
        </button>
      </form>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">
                From
              </th>
              <th scope="col" className="text-right">
                Stock
              </th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <a className="link font-semibold" href={`/admin/products/${p.id}`}>
                    {p.name}
                  </a>
                  <span className="block text-xs text-[var(--color-muted)]">
                    {p.brand_name}, {p.category_name}
                    {p.is_sample ? ' (sample)' : ''}
                  </span>
                </td>
                <td className="text-sm">{CLASS_OPTIONS.find((c) => c.value === p.classification)?.label}</td>
                <td>
                  <span className={`pill ${p.status === 'active' ? '' : 'pill-muted'}`}>{STATUS_OPTIONS.find((s) => s.value === p.status)?.label}</span>
                </td>
                <td className="tabular text-right">{p.min_price ? formatINR(p.min_price) : '—'}</td>
                <td className={`tabular text-right ${p.total_stock <= 0 ? 'text-[var(--color-danger)]' : ''}`}>{p.total_stock}</td>
                <td className="text-xs whitespace-nowrap">{fmtDay(p.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="p-6 text-center text-[var(--color-muted)]">No products match.</p> : null}
      </div>
    </AdminShell>
  );
}

export interface VariantFormRow {
  id?: string;
  name?: string;
  sku?: string;
  mrp?: string;
  price?: string;
  lowStock?: string;
  weight?: string;
  isActive?: boolean;
  stock?: number;
}

export function ProductForm({
  id,
  values,
  variants,
  defaultVariant,
  errors,
  brands,
  categories,
  canSeeRxNote,
}: {
  id: string | null;
  values: Values;
  variants: VariantFormRow[];
  defaultVariant: number;
  errors?: Errors;
  brands: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string; department: string }>;
  canSeeRxNote: boolean;
}) {
  const rows = [...variants, {} as VariantFormRow];
  return (
    <AdminShell
      title={id ? `Edit: ${values.name}` : 'Add product'}
      current="/admin/products"
      actions={
        id ? (
          <div className="flex flex-wrap gap-2">
            {values.slug && values.status === 'active' ? (
              <a href={`/p/${values.slug}`} className="btn btn-quiet btn-sm" target="_blank">
                View on store
              </a>
            ) : null}
            {values.status !== 'active' ? (
              <ActionButton action={`/admin/products/${id}/status`} fields={{ status: 'active' }} label="Publish" className="btn btn-secondary btn-sm" />
            ) : null}
            {values.status !== 'archived' ? (
              <ActionButton
                action={`/admin/products/${id}/status`}
                fields={{ status: 'archived' }}
                label="Archive"
                className="btn btn-danger btn-sm"
                confirm="Archive this product? It will be hidden from the store."
              />
            ) : null}
          </div>
        ) : null
      }
    >
      <Form action={id ? `/admin/products/${id}` : '/admin/products/new'} className="grid gap-6" ariaLabel="Product details">
        <FormErrors errors={errors} />
        <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
          <div className="grid content-start gap-6">
            <Panel title="Basics">
              <div className="grid gap-4 md:grid-cols-2">
                <TextField name="name" label="Product name" required value={values.name} errors={errors} className="md:col-span-2" />
                <TextField name="slug" label="URL slug" required value={values.slug} errors={errors} hint="Lowercase words joined by hyphens. Changing it breaks existing links." />
                <SelectField
                  name="brandId"
                  label="Brand"
                  required
                  options={brands.map((b) => ({ value: b.id, label: b.name }))}
                  placeholder="Choose…"
                  value={values.brandId}
                  errors={errors}
                />
                <SelectField
                  name="categoryId"
                  label="Category"
                  required
                  options={categories.map((c) => ({ value: c.id, label: `${c.name} (${c.department})` }))}
                  placeholder="Choose…"
                  value={values.categoryId}
                  errors={errors}
                />
                <TextField name="keyActive" label="Key active ingredient" value={values.keyActive} errors={errors} placeholder="Salicylic acid" />
                <TextField name="keyActiveStrength" label="Strength" value={values.keyActiveStrength} errors={errors} placeholder="2%" hint="Only if printed on the pack." />
                <TextArea
                  name="shortDescription"
                  label="Short description"
                  required
                  rows={2}
                  maxLength={300}
                  value={values.shortDescription}
                  errors={errors}
                  className="md:col-span-2"
                />
                <TextArea
                  name="description"
                  label="Full description"
                  rows={6}
                  value={values.description}
                  errors={errors}
                  className="md:col-span-2"
                  hint="Describe what the product is and does. Avoid treatment or cure claims unless verified."
                />
              </div>
            </Panel>
            <Panel title="Label information">
              <div className="grid gap-4 md:grid-cols-2">
                <TextArea name="ingredients" label="Full ingredient list" rows={4} value={values.ingredients} errors={errors} className="md:col-span-2" />
                <TextArea name="usageInstructions" label="How to use" rows={3} value={values.usageInstructions} errors={errors} />
                <TextArea name="warnings" label="Warnings" rows={3} value={values.warnings} errors={errors} />
                <TextField name="storage" label="Storage" value={values.storage} errors={errors} />
                <TextField name="countryOfOrigin" label="Country of origin" value={values.countryOfOrigin} errors={errors} />
                <TextField name="manufacturerName" label="Manufacturer" value={values.manufacturerName} errors={errors} />
                <TextField name="marketedBy" label="Marketed by" value={values.marketedBy} errors={errors} />
                <TextArea name="manufacturerAddress" label="Manufacturer address" rows={2} value={values.manufacturerAddress} errors={errors} className="md:col-span-2" />
              </div>
            </Panel>
            <Panel title="Pack sizes & prices">
              <input type="hidden" name="variantCount" value={String(rows.length)} />
              {errors?.variants ? <p className="error-text mb-2">{errors.variants}</p> : null}
              <div className="overflow-x-auto">
                <table className="table min-w-[56rem]">
                  <thead>
                    <tr>
                      <th scope="col">Default</th>
                      <th scope="col">Pack size</th>
                      <th scope="col">SKU</th>
                      <th scope="col">MRP (₹)</th>
                      <th scope="col">Price (₹)</th>
                      <th scope="col">Alert at</th>
                      <th scope="col">Weight (g)</th>
                      <th scope="col">{id ? 'Stock' : 'Opening stock'}</th>
                      <th scope="col">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v, i) => {
                      const err = (f: string) => errors?.[`v${i}_${f}`];
                      const cell = (f: string, val: string | undefined, w: string, label: string, mode?: string) => (
                        <td>
                          <input
                            className={`input min-h-9 py-1 ${w}`}
                            name={`v${i}_${f}`}
                            defaultValue={val ?? ''}
                            aria-label={`${label}, row ${i + 1}`}
                            aria-invalid={err(f) ? 'true' : undefined}
                            inputMode={mode}
                          />
                          {err(f) ? <span className="error-text block text-xs">{err(f)}</span> : null}
                        </td>
                      );
                      return (
                        <tr key={i}>
                          <td>
                            {v.id ? <input type="hidden" name={`v${i}_id`} value={v.id} /> : null}
                            <input type="radio" name="defaultVariant" value={String(i)} defaultChecked={i === defaultVariant} aria-label={`Default pack size, row ${i + 1}`} />
                          </td>
                          {cell('name', v.name, 'w-28', 'Pack size')}
                          {cell('sku', v.sku, 'w-36', 'SKU')}
                          {cell('mrp', v.mrp, 'w-24', 'MRP', 'decimal')}
                          {cell('price', v.price, 'w-24', 'Price', 'decimal')}
                          {cell('lowStock', v.lowStock ?? '5', 'w-16', 'Low-stock alert', 'numeric')}
                          {cell('weight', v.weight ?? '100', 'w-20', 'Weight', 'numeric')}
                          {v.id ? (
                            <td className="tabular text-sm">
                              {v.stock}{' '}
                              <a className="link text-xs" href="/admin/inventory">
                                adjust
                              </a>
                            </td>
                          ) : (
                            cell('initialStock', '', 'w-20', 'Opening stock', 'numeric')
                          )}
                          <td>
                            <input type="checkbox" name={`v${i}_isActive`} defaultChecked={v.id ? !!v.isActive : true} aria-label={`Active, row ${i + 1}`} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="hint mt-2">Fill the blank last row to add a pack size. Save to get another blank row. Selling price must not exceed MRP.</p>
            </Panel>
          </div>
          <div className="grid content-start gap-6">
            <Panel title="Publishing">
              <div className="grid gap-4">
                <SelectField name="status" label="Status" required options={STATUS_OPTIONS} value={values.status ?? 'draft'} errors={errors} />
                <Checkbox name="isFeatured" label="Feature on the homepage" checked={values.isFeatured === 'on'} />
                <Checkbox name="isSample" label="Sample / demo product" checked={values.isSample === 'on'} />
              </div>
            </Panel>
            <Panel title="Classification & tax">
              <div className="grid gap-4">
                <SelectField name="classification" label="Regulatory classification" required options={CLASS_OPTIONS} value={values.classification ?? 'cosmetic'} errors={errors} />
                <Checkbox name="requiresPrescription" label="Requires a prescription" checked={values.requiresPrescription === 'on'} />
                <Checkbox name="classificationVerified" label="Classification verified by a regulatory professional" checked={values.classificationVerified === 'on'} />
                {canSeeRxNote ? <p className="hint">Prescription-only products can’t be bought until prescription ordering is enabled in store settings.</p> : null}
                <TextField name="hsnCode" label="HSN code" value={values.hsnCode} errors={errors} inputMode="numeric" />
                <TextField
                  name="taxRatePercent"
                  label="GST rate (%)"
                  required
                  value={values.taxRatePercent ?? '18'}
                  errors={errors}
                  inputMode="decimal"
                  hint="Confirm rates with your tax adviser."
                />
              </div>
            </Panel>
            <Panel title="Images & search">
              <div className="grid gap-4">
                <TextArea
                  name="images"
                  label="Images"
                  rows={4}
                  value={values.images}
                  errors={errors}
                  hint="One per line: /images/products/file.svg | alt text. Use only images you own or are licensed to use."
                />
                <TextField name="tags" label="Tags" value={values.tags} errors={errors} hint="Comma separated." />
                <TextField name="skinTypes" label="Skin types" value={values.skinTypes} errors={errors} hint="Comma separated, e.g. Oily, Combination." />
                <TextField name="seoTitle" label="SEO title" value={values.seoTitle} errors={errors} maxLength={70} />
                <TextArea name="seoDescription" label="SEO description" rows={2} value={values.seoDescription} errors={errors} maxLength={170} />
              </div>
            </Panel>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary">
            {id ? 'Save changes' : 'Create product'}
          </button>
          <a href="/admin/products" className="btn btn-quiet">
            Cancel
          </a>
        </div>
      </Form>
    </AdminShell>
  );
}

export function TaxonomyPage({
  categories,
  brands,
  catErrors,
  brandErrors,
  catValues,
  brandValues,
}: {
  categories: Array<{ id: string; slug: string; name: string; department: string; sort_order: number; is_active: boolean; product_count: number; description: string | null }>;
  brands: Array<{ id: string; slug: string; name: string; is_sample: boolean; product_count: number }>;
  catErrors?: Errors;
  brandErrors?: Errors;
  catValues?: Values;
  brandValues?: Values;
}) {
  const DEPTS = [
    { value: 'skincare', label: 'Skincare' },
    { value: 'cosmetology', label: 'Cosmetology' },
    { value: 'body-hair', label: 'Body & hair' },
    { value: 'pharmacy', label: 'Pharmacy' },
  ];
  return (
    <AdminShell title="Categories & brands" current="/admin/taxonomy">
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Categories">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Department</th>
                <th scope="col" className="text-right">
                  Products
                </th>
                <th scope="col">Visible</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    <span className="block text-xs text-[var(--color-muted)]">/c/{c.slug}</span>
                  </td>
                  <td className="text-sm">{c.department}</td>
                  <td className="tabular text-right">{c.product_count}</td>
                  <td>{c.is_active ? 'Yes' : 'No'}</td>
                  <td>
                    <ActionButton action={`/admin/taxonomy/categories/${c.id}/toggle`} label={c.is_active ? 'Hide' : 'Show'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form action="/admin/taxonomy/categories" className="mt-5 grid gap-3 border-t border-[var(--color-line)] pt-4 md:grid-cols-2" ariaLabel="Add category">
            <h3 className="text-sm font-semibold md:col-span-2">Add category</h3>
            <FormErrors errors={catErrors} />
            <TextField name="name" label="Name" required value={catValues?.name} errors={catErrors} />
            <TextField name="slug" label="Slug" required value={catValues?.slug} errors={catErrors} />
            <SelectField name="department" label="Department" required options={DEPTS} value={catValues?.department ?? 'skincare'} errors={catErrors} />
            <TextField name="sortOrder" label="Sort order" value={catValues?.sortOrder ?? '0'} errors={catErrors} inputMode="numeric" />
            <TextArea name="description" label="Description" rows={2} value={catValues?.description} errors={catErrors} className="md:col-span-2" />
            <input type="hidden" name="isActive" value="on" />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Add category
              </button>
            </div>
          </Form>
        </Panel>
        <Panel title="Brands">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col" className="text-right">
                  Products
                </th>
              </tr>
            </thead>
            <tbody>
              {brands.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.name}
                    {b.is_sample ? <span className="pill pill-sample ml-2">Sample</span> : null}
                  </td>
                  <td className="text-sm">{b.slug}</td>
                  <td className="tabular text-right">{b.product_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Form action="/admin/taxonomy/brands" className="mt-5 grid gap-3 border-t border-[var(--color-line)] pt-4 md:grid-cols-2" ariaLabel="Add brand">
            <h3 className="text-sm font-semibold md:col-span-2">Add brand</h3>
            <FormErrors errors={brandErrors} />
            <TextField name="name" label="Name" required value={brandValues?.name} errors={brandErrors} />
            <TextField name="slug" label="Slug" required value={brandValues?.slug} errors={brandErrors} />
            <TextArea name="description" label="Description" rows={2} value={brandValues?.description} errors={brandErrors} className="md:col-span-2" />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Add brand
              </button>
            </div>
          </Form>
        </Panel>
      </div>
    </AdminShell>
  );
}

export interface StockRow {
  variant_id: string;
  sku: string;
  product_name: string;
  product_id: string;
  variant_name: string;
  stock: number;
  low_stock_threshold: number;
  status: string;
}

export function InventoryPage({
  rows,
  filter,
  errors,
  movements,
}: {
  rows: StockRow[];
  filter: string;
  errors?: Errors;
  movements: Array<{ sku: string; delta: number; balance_after: number; reason: string; reference: string | null; note: string | null; created_at: Date; actor: string | null }>;
}) {
  return (
    <AdminShell title="Stock" current="/admin/inventory">
      <FormErrors errors={errors} />
      <div className="mb-4 flex gap-2">
        <a href="/admin/inventory" className={`btn btn-sm ${filter === '' ? 'btn-primary' : 'btn-secondary'}`}>
          All
        </a>
        <a href="/admin/inventory?filter=low" className={`btn btn-sm ${filter === 'low' ? 'btn-primary' : 'btn-secondary'}`}>
          Low or out of stock
        </a>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-line)] bg-white">
        <table className="table min-w-[52rem]">
          <thead>
            <tr>
              <th scope="col">SKU</th>
              <th scope="col">Product</th>
              <th scope="col" className="text-right">
                On hand
              </th>
              <th scope="col">Adjust</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const low = r.stock <= r.low_stock_threshold;
              return (
                <tr key={r.variant_id}>
                  <td className="tabular text-sm">{r.sku}</td>
                  <td>
                    <a href={`/admin/products/${r.product_id}`} className="link">
                      {r.product_name}
                    </a>
                    <span className="block text-xs text-[var(--color-muted)]">{r.variant_name}</span>
                  </td>
                  <td className={`tabular text-right font-semibold ${r.stock === 0 ? 'text-[var(--color-danger)]' : low ? 'text-[var(--color-warning)]' : ''}`}>
                    {r.stock}
                    {low ? <span className="block text-xs font-normal">{r.stock === 0 ? 'Out of stock' : `Low (alert at ${r.low_stock_threshold})`}</span> : null}
                  </td>
                  <td>
                    <Form action="/admin/inventory/adjust" className="flex flex-wrap items-center gap-1.5" ariaLabel={`Adjust stock for ${r.sku}`}>
                      <input type="hidden" name="variantId" value={r.variant_id} />
                      <input name="delta" className="input min-h-9 w-20 py-1" inputMode="numeric" placeholder="+10" aria-label={`Change for ${r.sku}`} />
                      <select name="reason" className="select min-h-9 w-32 py-1" aria-label={`Reason for ${r.sku}`}>
                        <option value="restock">Restock</option>
                        <option value="adjustment">Count correction</option>
                        <option value="damage">Damaged</option>
                        <option value="expiry">Expired</option>
                        <option value="return">Customer return</option>
                      </select>
                      <input name="note" className="input min-h-9 w-36 py-1" placeholder="Note" aria-label={`Note for ${r.sku}`} />
                      <button type="submit" className="btn btn-secondary btn-sm">
                        Apply
                      </button>
                    </Form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-8">
        <Panel title="Recent stock movements">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">SKU</th>
                  <th scope="col" className="text-right">
                    Change
                  </th>
                  <th scope="col" className="text-right">
                    Balance
                  </th>
                  <th scope="col">Reason</th>
                  <th scope="col">By</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m, i) => (
                  <tr key={i}>
                    <td className="text-xs whitespace-nowrap">{fmtDate(m.created_at)}</td>
                    <td className="tabular text-sm">{m.sku}</td>
                    <td className={`tabular text-right ${m.delta < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td className="tabular text-right">{m.balance_after}</td>
                    <td className="text-sm">
                      {m.reason.replace(/_/g, ' ')}
                      {m.reference ? ` (${m.reference})` : ''}
                      {m.note ? <span className="block text-xs text-[var(--color-muted)]">{m.note}</span> : null}
                    </td>
                    <td className="text-sm">{m.actor ?? 'System'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </AdminShell>
  );
}

export function BatchesPage({
  batches,
  variants,
  errors,
  values,
}: {
  batches: Array<{ id: string; batch_no: string; expiry_date: string; mfg_date: string | null; quantity: number; sku: string; product_name: string; days_left: number }>;
  variants: Array<{ id: string; sku: string; label: string }>;
  errors?: Errors;
  values?: Values;
}) {
  return (
    <AdminShell title="Batches & expiry" current="/admin/inventory/batches">
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Batches by expiry date">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Expiry</th>
                  <th scope="col">Batch</th>
                  <th scope="col">Product</th>
                  <th scope="col" className="text-right">
                    Qty
                  </th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td className={`tabular ${b.days_left < 0 ? 'text-[var(--color-danger)]' : b.days_left <= 90 ? 'text-[var(--color-warning)]' : ''}`}>
                      {b.expiry_date}
                      <span className="block text-xs">{b.days_left < 0 ? 'Expired — quarantine' : b.days_left <= 90 ? `${b.days_left} days left` : ''}</span>
                    </td>
                    <td className="tabular text-sm">{b.batch_no}</td>
                    <td className="text-sm">
                      {b.product_name}
                      <span className="block text-xs text-[var(--color-muted)]">{b.sku}</span>
                    </td>
                    <td className="tabular text-right">{b.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="Receive a batch">
          <Form action="/admin/inventory/batches" className="grid gap-3" ariaLabel="Receive a batch">
            <FormErrors errors={errors} />
            <SelectField
              name="variantId"
              label="Product & pack"
              required
              options={variants.map((v) => ({ value: v.id, label: v.label }))}
              placeholder="Choose…"
              value={values?.variantId}
              errors={errors}
            />
            <TextField name="batchNo" label="Batch number" required value={values?.batchNo} errors={errors} />
            <TextField name="mfgDate" label="Manufactured on" type="date" value={values?.mfgDate} errors={errors} />
            <TextField name="expiryDate" label="Expiry date" type="date" required value={values?.expiryDate} errors={errors} />
            <TextField name="quantity" label="Quantity received" required inputMode="numeric" value={values?.quantity} errors={errors} />
            <Checkbox name="addToStock" label="Add this quantity to sellable stock" checked={values?.addToStock !== ''} />
            <TextField name="notes" label="Notes" value={values?.notes} errors={errors} />
            <div>
              <button className="btn btn-primary btn-sm" type="submit">
                Record batch
              </button>
            </div>
          </Form>
        </Panel>
      </div>
    </AdminShell>
  );
}

export function variantToForm(v: {
  id: string;
  name: string;
  sku: string;
  mrp_paise: number;
  price_paise: number;
  low_stock_threshold: number;
  weight_grams: number;
  is_active: boolean;
  stock: number;
}): VariantFormRow {
  return {
    id: v.id,
    name: v.name,
    sku: v.sku,
    mrp: paiseToRupeesInput(v.mrp_paise),
    price: paiseToRupeesInput(v.price_paise),
    lowStock: String(v.low_stock_threshold),
    weight: String(v.weight_grams),
    isActive: v.is_active,
    stock: v.stock,
  };
}
