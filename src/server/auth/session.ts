import crypto from 'node:crypto';
import type { Ctx, SessionUser } from '../http/context.ts';
import type { Queryable } from '../db/db.ts';

const ANON_TTL_MS = 14 * 24 * 3600_000;
const USER_TTL_MS = 30 * 24 * 3600_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl\/|wget/i;

export function sessionCookieName(ctx: Ctx) {
  // __Host- prefix requires Secure + Path=/ + no Domain; only possible over https.
  return ctx.secureCookies ? '__Host-gd_sid' : 'gd_sid';
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export async function loadSession(ctx: Ctx, opts: { create: boolean }) {
  const token = ctx.cookies[sessionCookieName(ctx)];
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const row = await ctx.app.db.one<{
      id: string;
      csrf_secret: string;
      user_id: string | null;
      last_seen_at: Date;
      u_email: string | null;
      u_name: string | null;
      u_phone: string | null;
      u_role: SessionUser['role'] | null;
      u_blocked: boolean | null;
    }>(
      `SELECT s.id, s.csrf_secret, s.user_id, s.last_seen_at,
              u.email AS u_email, u.name AS u_name, u.phone AS u_phone, u.role AS u_role,
              (u.disabled_at IS NOT NULL OR u.deleted_at IS NOT NULL) AS u_blocked
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
    if (row && !row.u_blocked) {
      ctx.session = { id: row.id, csrfSecret: row.csrf_secret, userId: row.user_id, lastSeenAt: row.last_seen_at, isNew: false };
      if (row.user_id && row.u_email && row.u_role) {
        ctx.user = { id: row.user_id, email: row.u_email, name: row.u_name ?? '', phone: row.u_phone, role: row.u_role };
      }
      if (Date.now() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
        const ttl = row.user_id ? USER_TTL_MS : ANON_TTL_MS;
        await ctx.app.db.query('UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1', [row.id, new Date(Date.now() + ttl)]);
      }
      return;
    }
    if (row?.u_blocked) await ctx.app.db.query('DELETE FROM sessions WHERE id = $1', [row.id]);
  }
  if (opts.create && !BOT_UA.test(ctx.req.headers['user-agent'] ?? '')) await createSession(ctx, null);
}

export async function createSession(ctx: Ctx, userId: string | null, db: Queryable = ctx.app.db) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const csrfSecret = crypto.randomBytes(24).toString('base64url');
  const ttl = userId ? USER_TTL_MS : ANON_TTL_MS;
  await db.query(`INSERT INTO sessions (id, user_id, csrf_secret, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`, [
    id,
    userId,
    csrfSecret,
    new Date(Date.now() + ttl),
    ctx.ip,
    (ctx.req.headers['user-agent'] ?? '').slice(0, 300),
  ]);
  ctx.session = { id, csrfSecret, userId, lastSeenAt: new Date(), isNew: true };
  ctx.setCookie(sessionCookieName(ctx), token, { maxAge: ttl / 1000, httpOnly: true, sameSite: 'Lax' });
  return id;
}

/**
 * Sign-in: issue a brand-new session (prevents fixation), move the anonymous
 * cart and recently-viewed items to the user, and drop the old session.
 */
export async function signIn(ctx: Ctx, user: SessionUser) {
  const oldId = ctx.session?.id ?? null;
  await ctx.app.db.tx(async (t) => {
    const newId = await createSession(ctx, user.id, t);
    if (oldId) {
      await mergeAnonymousCart(t, oldId, user.id);
      await t.query(
        `INSERT INTO recently_viewed (owner_key, product_id, viewed_at)
           SELECT $2, product_id, viewed_at FROM recently_viewed WHERE owner_key = $1
         ON CONFLICT (owner_key, product_id) DO UPDATE SET viewed_at = GREATEST(recently_viewed.viewed_at, EXCLUDED.viewed_at)`,
        ['s:' + oldId, 'u:' + user.id],
      );
      await t.query('DELETE FROM sessions WHERE id = $1', [oldId]);
    }
    return newId;
  });
  ctx.user = user;
}

async function mergeAnonymousCart(t: Queryable, sessionId: string, userId: string) {
  const anon = await t.one<{ id: string }>('SELECT id FROM carts WHERE session_id = $1', [sessionId]);
  if (!anon) return;
  const mine = await t.one<{ id: string }>('SELECT id FROM carts WHERE user_id = $1', [userId]);
  if (!mine) {
    await t.query('UPDATE carts SET user_id = $1, session_id = NULL, updated_at = now() WHERE id = $2', [userId, anon.id]);
    return;
  }
  await t.query(
    `INSERT INTO cart_items (cart_id, variant_id, quantity)
       SELECT $1, variant_id, quantity FROM cart_items WHERE cart_id = $2
     ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = LEAST(20, cart_items.quantity + EXCLUDED.quantity)`,
    [mine.id, anon.id],
  );
  await t.query('DELETE FROM carts WHERE id = $1', [anon.id]);
}

export async function signOut(ctx: Ctx) {
  if (ctx.session) await ctx.app.db.query('DELETE FROM sessions WHERE id = $1', [ctx.session.id]);
  ctx.session = null;
  ctx.user = null;
  ctx.clearCookie(sessionCookieName(ctx));
  await createSession(ctx, null);
}

export async function revokeOtherSessions(db: Queryable, userId: string, keepSessionId?: string) {
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> coalesce($2, '')", [userId, keepSessionId ?? null]);
}

export async function purgeExpiredSessions(db: Queryable) {
  const r = await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return r.rowCount;
}
