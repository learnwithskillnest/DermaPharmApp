import type { App } from '../app.ts';
import type { Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import { audit, type Actor } from './audit.ts';
import { moveStock } from './inventory.ts';
import type { OrderRow } from './orders.ts';
import { logger } from '../logger.ts';

export const RETURN_REASONS = {
  damaged: 'Arrived damaged or leaking',
  wrong_item: 'Wrong item received',
  expired: 'Expired or close to expiry',
  not_as_described: 'Not as described',
  sealed_unopened: 'Changed my mind (sealed, unopened)',
  other: 'Something else',
} as const;

export const RETURN_STATUS_LABEL: Record<string, string> = {
  requested: 'Requested — awaiting review',
  approved: 'Approved — refund in progress',
  rejected: 'Not approved',
  received: 'Item received — refund in progress',
  refunded: 'Refunded',
};

export interface ReturnRow {
  id: string;
  order_id: string;
  order_number: string;
  kind: 'return' | 'refund_only';
  reason: string;
  details: string | null;
  status: 'requested' | 'approved' | 'rejected' | 'received' | 'refunded';
  refund_paise: number | null;
  refund_reference: string | null;
  admin_note: string | null;
  created_at: Date;
  updated_at: Date;
  customer_email?: string;
  total_paise?: number;
  payment_method?: string;
}

export async function returnsForOrder(db: Queryable, orderId: string) {
  return db.many<ReturnRow>(`SELECT r.*, o.number AS order_number FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 ORDER BY r.created_at DESC`, [
    orderId,
  ]);
}

export async function requestReturn(app: App, order: OrderRow, userId: string, reason: keyof typeof RETURN_REASONS, details: string | null) {
  const settings = await app.settings.all();
  if (order.status !== 'delivered') throw new UserFacingError('Returns can be requested once an order is delivered.');
  const delivered = await app.db.one<{ at: Date | null }>(`SELECT max(delivered_at) AS at FROM shipments WHERE order_id = $1`, [order.id]);
  const deliveredAt = delivered?.at ?? order.updated_at;
  const deadline = new Date(deliveredAt.getTime() + settings.orders.returnWindowDays * 86_400_000);
  if (new Date() > deadline) throw new UserFacingError(`The ${settings.orders.returnWindowDays}-day return window for this order has closed.`);
  if (order.requires_rx_review) {
    // Medicines are generally not resaleable once dispatched; only defects qualify.
    if (!['damaged', 'wrong_item', 'expired'].includes(reason)) throw new UserFacingError('Medicines can only be returned if damaged, expired or incorrect.');
  }
  const open = await app.db.one(`SELECT 1 FROM return_requests WHERE order_id = $1 AND status IN ('requested', 'approved', 'received')`, [order.id]);
  if (open) throw new UserFacingError('A return is already open for this order.');
  await app.db.tx(async (t) => {
    await t.query(`INSERT INTO return_requests (order_id, user_id, reason, details) VALUES ($1, $2, $3, $4)`, [order.id, userId, reason, details]);
    await t.query(`UPDATE orders SET status = 'return_requested', updated_at = now() WHERE id = $1`, [order.id]);
    await t.query(`INSERT INTO order_events (order_id, status, note, actor_id) VALUES ($1, 'return_requested', $2, $3)`, [
      order.id,
      `Return requested: ${RETURN_REASONS[reason]}.`,
      userId,
    ]);
  });
}

export async function listReturns(db: Queryable, status?: string) {
  return db.many<ReturnRow>(
    `SELECT r.*, o.number AS order_number, o.email AS customer_email, o.total_paise, o.payment_method
       FROM return_requests r JOIN orders o ON o.id = r.order_id
      ${status ? 'WHERE r.status = $1::return_status' : ''} ORDER BY r.created_at DESC LIMIT 200`,
    status ? [status] : [],
  );
}

/**
 * Staff workflow: requested → approved|rejected → received (restock) → refunded.
 * Refunds for online payments are issued through the payment provider; the
 * provider's refund id is stored as the reference.
 */
export async function updateReturn(
  app: App,
  id: string,
  change: { status: ReturnRow['status']; refundPaise?: number | null; reference?: string | null; note?: string | null; restock?: boolean; viaGateway?: boolean },
  actor: Actor,
) {
  const r = await app.db.one<ReturnRow & { total_paise: number; payment_method: string; order_status: string }>(
    `SELECT r.*, o.number AS order_number, o.total_paise, o.payment_method, o.status AS order_status FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = $1`,
    [id],
  );
  if (!r) throw new UserFacingError('Return not found.', 'not_found', 404);
  const flow: Record<string, string[]> = { requested: ['approved', 'rejected'], approved: ['received', 'refunded', 'rejected'], received: ['refunded'] };
  if (!(flow[r.status] ?? []).includes(change.status)) throw new UserFacingError(`Cannot move a return from ${r.status} to ${change.status}.`);
  const refund = change.refundPaise ?? r.refund_paise ?? r.total_paise;
  if (change.status === 'refunded' && (refund <= 0 || refund > r.total_paise)) throw new UserFacingError('Refund amount must be more than zero and no more than the order total.');

  let reference = change.reference ?? null;
  if (change.status === 'refunded' && change.viaGateway && r.payment_method === 'online') {
    const pay = await app.db.one<{ provider_payment_id: string }>(
      `SELECT provider_payment_id FROM payment_attempts WHERE order_id = $1 AND status = 'captured' AND provider = $2 LIMIT 1`,
      [r.order_id, app.payments.name],
    );
    if (!pay) throw new UserFacingError('No captured payment was found for this order with the active payment provider. Record a manual refund reference instead.');
    try {
      reference = (await app.payments.refund(pay.provider_payment_id, refund, `Return ${r.id}`)).refundId;
    } catch (e) {
      logger.error('refund_failed', { err: e, order: r.order_number });
      throw new UserFacingError('The payment provider rejected the refund. Check the provider dashboard and try again or record a manual refund.');
    }
  }
  if (change.status === 'refunded' && !reference) throw new UserFacingError('Enter the refund reference (UTR / gateway refund id).');

  await app.db.tx(async (t) => {
    await t.query(
      `UPDATE return_requests SET status = $2, refund_paise = $3, refund_reference = coalesce($4, refund_reference), admin_note = coalesce($5, admin_note), updated_at = now() WHERE id = $1`,
      [id, change.status, refund, reference, change.note ?? null],
    );
    if (change.status === 'received') {
      await t.query(`UPDATE orders SET status = 'returned', updated_at = now() WHERE id = $1 AND status = 'return_requested'`, [r.order_id]);
      if (change.restock) {
        const items = await t.many<{ variant_id: string | null; quantity: number }>('SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id', [
          r.order_id,
        ]);
        for (const i of items) if (i.variant_id) await moveStock(t, { variantId: i.variant_id, delta: i.quantity, reason: 'return', reference: r.order_number, actorId: actor.id });
      }
    }
    if (change.status === 'rejected' && r.order_status === 'return_requested') {
      await t.query(`UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1`, [r.order_id]);
    }
    if (change.status === 'refunded') {
      const full = refund >= r.total_paise;
      await t.query(
        `UPDATE orders SET payment_status = $2::payment_status, status = CASE WHEN status IN ('returned', 'return_requested', 'delivered') THEN 'refunded'::order_status ELSE status END, updated_at = now() WHERE id = $1`,
        [r.order_id, full ? 'refunded' : 'partially_refunded'],
      );
    }
    await t.query(`INSERT INTO order_events (order_id, status, note, actor_id) VALUES ($1, $2, $3, $4)`, [
      r.order_id,
      `return_${change.status}`,
      change.status === 'refunded' ? `Refund of ₹${(refund / 100).toFixed(2)} issued (ref ${reference}).` : RETURN_STATUS_LABEL[change.status],
      actor.id,
    ]);
    await audit(t, actor, `return.${change.status}`, 'return', id, { order: r.order_number, refund, reference });
  });
}
