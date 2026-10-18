import crypto from 'node:crypto';
import type { App } from '../app.ts';
import { isUniqueViolation, type Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import { dummyHash, hashPassword, needsRehash, passwordProblem, verifyPassword } from '../auth/password.ts';
import type { SessionUser } from '../http/context.ts';
import { sendSafely } from './mail.ts';
import { audit } from './audit.ts';

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

export async function registerUser(db: Queryable, input: { name: string; email: string; phone?: string; password: string; marketing: boolean }) {
  const problem = passwordProblem(input.password, input.email);
  if (problem) throw new UserFacingError(problem, 'password');
  const hash = await hashPassword(input.password);
  try {
    const row = await db.one<SessionUser>(
      `INSERT INTO users (email, name, phone, password_hash, marketing_opt_in) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, phone, role`,
      [input.email, input.name, input.phone ?? null, hash, input.marketing],
    );
    return row!;
  } catch (e) {
    // Same wording as a generic failure so the form can't be used to enumerate accounts too easily.
    if (isUniqueViolation(e, 'users_email_key')) throw new UserFacingError('An account with this email already exists. Sign in or reset your password.', 'email_taken');
    throw e;
  }
}

/** Returns the user on success, or a generic error (no account enumeration). */
export async function authenticate(db: Queryable, email: string, password: string): Promise<SessionUser> {
  const u = await db.one<SessionUser & { password_hash: string; failed_logins: number; locked_until: Date | null; disabled_at: Date | null; deleted_at: Date | null }>(
    `SELECT id, email, name, phone, role, password_hash, failed_logins, locked_until, disabled_at, deleted_at FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const generic = new UserFacingError('The email or password is incorrect.', 'bad_credentials', 401);
  if (!u) {
    await verifyPassword(password, await dummyHash());
    throw generic;
  }
  if (u.locked_until && u.locked_until > new Date()) {
    throw new UserFacingError('Too many failed attempts. Try again in a few minutes or reset your password.', 'locked', 429);
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok || u.disabled_at || u.deleted_at) {
    if (!ok) {
      const fails = u.failed_logins + 1;
      await db.query(`UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1`, [
        u.id,
        fails >= LOCK_AFTER ? 0 : fails,
        fails >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      ]);
    }
    throw generic;
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
  if (needsRehash(u.password_hash)) await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(password)]);
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };
}

const RESET_TTL_MS = 60 * 60_000;
const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Always behaves the same whether or not the email exists. */
export async function requestPasswordReset(app: App, email: string) {
  const u = await app.db.one<{ id: string; email: string }>(`SELECT id, email FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND disabled_at IS NULL`, [email]);
  if (!u) return;
  const token = crypto.randomBytes(32).toString('base64url');
  await app.db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [u.id]);
  await app.db.query('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), u.id, new Date(Date.now() + RESET_TTL_MS)]);
  await sendSafely(
    app.mailer,
    u.email,
    'Reset your GlowDerma password',
    `Use this link within 1 hour to choose a new password:\n\n${app.config.APP_URL}/reset-password?token=${token}\n\nIf you didn't ask for this, you can ignore this email.`,
  );
}

export async function resetPassword(app: App, token: string, password: string) {
  return app.db.tx(async (t) => {
    const row = await t.one<{ user_id: string; email: string }>(
      `SELECT r.user_id, u.email FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() FOR UPDATE OF r`,
      [tokenHash(token)],
    );
    if (!row) throw new UserFacingError('This reset link is invalid or has expired. Request a new one.', 'bad_token');
    const problem = passwordProblem(password, row.email);
    if (problem) throw new UserFacingError(problem, 'password');
    await t.query('UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [row.user_id, await hashPassword(password)]);
    await t.query('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1', [tokenHash(token)]);
    await t.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id]); // sign out everywhere
    await audit(t, { id: row.user_id, role: 'customer' }, 'user.password_reset', 'user', row.user_id, {});
  });
}

export async function changePassword(db: Queryable, userId: string, current: string, next: string, keepSessionId: string) {
  const u = await db.one<{ email: string; password_hash: string }>('SELECT email, password_hash FROM users WHERE id = $1', [userId]);
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new UserFacingError('Your current password is incorrect.', 'current');
  const problem = passwordProblem(next, u.email);
  if (problem) throw new UserFacingError(problem, 'password');
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [userId, await hashPassword(next)]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, keepSessionId]);
}

/**
 * Account deletion (data-subject request). Personal data is erased; order
 * records are kept with the email pseudonymised because tax law requires
 * invoices to be retained. Prescriptions are deleted with their files by the
 * retention purge (they reference the user with ON DELETE CASCADE on hard delete).
 */
export async function deleteAccount(app: App, userId: string) {
  await app.db.tx(async (t) => {
    const anon = `deleted-${userId.slice(0, 8)}@deleted.invalid`;
    await t.query(`UPDATE users SET email = $2, name = 'Deleted customer', phone = NULL, password_hash = 'deleted', deleted_at = now(), marketing_opt_in = false WHERE id = $1`, [
      userId,
      anon,
    ]);
    await t.query('DELETE FROM addresses WHERE user_id = $1', [userId]);
    await t.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await t.query('DELETE FROM wishlist_items WHERE user_id = $1', [userId]);
    await t.query('DELETE FROM carts WHERE user_id = $1', [userId]);
    await t.query(`DELETE FROM recently_viewed WHERE owner_key = $1`, ['u:' + userId]);
    await t.query(`UPDATE prescriptions SET delete_after = current_date - 1 WHERE user_id = $1`, [userId]);
    await t.query(`UPDATE orders SET email = $2, phone = '' WHERE user_id = $1`, [userId, anon]);
    await audit(t, { id: userId, role: 'customer' }, 'user.deleted', 'user', userId, {});
  });
}
