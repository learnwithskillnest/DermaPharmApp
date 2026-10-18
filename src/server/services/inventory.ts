import type { Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';

export type StockReason = 'initial' | 'adjustment' | 'restock' | 'order_reserved' | 'order_released' | 'return' | 'damage' | 'expiry';

/**
 * Atomically changes a variant's stock and records the movement.
 * MUST be called inside a transaction. The conditional UPDATE plus the
 * `stock >= 0` CHECK constraint make negative stock impossible even under
 * concurrent requests.
 */
export async function moveStock(
  t: Queryable,
  m: { variantId: string; delta: number; reason: StockReason; reference?: string | null; note?: string | null; actorId?: string | null },
): Promise<number> {
  if (!Number.isInteger(m.delta) || m.delta === 0) throw new UserFacingError('Stock change must be a non-zero whole number.');
  const row = await t.one<{ stock: number }>(`UPDATE product_variants SET stock = stock + $2 WHERE id = $1 AND stock + $2 >= 0 RETURNING stock`, [m.variantId, m.delta]);
  if (!row) {
    const cur = await t.one<{ stock: number; sku: string }>('SELECT stock, sku FROM product_variants WHERE id = $1', [m.variantId]);
    if (!cur) throw new UserFacingError('Product variant not found.', 'not_found', 404);
    throw new UserFacingError(`Not enough stock for ${cur.sku}: ${cur.stock} on hand.`, 'insufficient_stock');
  }
  await t.query(`INSERT INTO stock_movements (variant_id, delta, balance_after, reason, reference, note, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    m.variantId,
    m.delta,
    row.stock,
    m.reason,
    m.reference ?? null,
    m.note ?? null,
    m.actorId ?? null,
  ]);
  return row.stock;
}

export async function lowStock(db: Queryable, limit = 50) {
  return db.many<{ variant_id: string; sku: string; product_name: string; variant_name: string; stock: number; low_stock_threshold: number; product_id: string }>(
    `SELECT v.id AS variant_id, v.sku, p.name AS product_name, v.name AS variant_name, v.stock, v.low_stock_threshold, p.id AS product_id
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.is_active AND p.status <> 'archived' AND v.stock <= v.low_stock_threshold
      ORDER BY v.stock ASC, p.name LIMIT $1`,
    [limit],
  );
}

export async function expiringBatches(db: Queryable, withinDays: number) {
  return db.many<{ id: string; batch_no: string; expiry_date: string; quantity: number; sku: string; product_name: string; variant_name: string; days_left: number }>(
    `SELECT b.id, b.batch_no, b.expiry_date::text, b.quantity, v.sku, p.name AS product_name, v.name AS variant_name,
            (b.expiry_date - current_date)::int AS days_left
       FROM inventory_batches b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
      WHERE b.quantity > 0 AND b.expiry_date <= current_date + $1::int
      ORDER BY b.expiry_date`,
    [withinDays],
  );
}
