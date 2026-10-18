import { asJson, type Queryable } from '../db/db.ts';

export interface Actor {
  id: string | null;
  role?: string | null;
  ip?: string | null;
}

/** Append-only record of sensitive actions (admin changes, Rx document access, refunds…). */
export async function audit(db: Queryable, actor: Actor, action: string, entity: string, entityId: string | null, details: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    actor.id,
    actor.role ?? null,
    action,
    entity,
    entityId,
    asJson(details),
    actor.ip ?? null,
  ]);
}
