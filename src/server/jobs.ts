import type { App } from './app.ts';
import { logger } from './logger.ts';
import { expireReservations } from './services/orders.ts';
import { purgeExpiredPrescriptions } from './services/prescriptions.ts';
import { purgeExpiredSessions } from './auth/session.ts';

/**
 * In-process maintenance jobs. Safe to run on several instances at once:
 * every job is an idempotent, row-locked database operation.
 */
export function startJobs(app: App) {
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      const out = await fn();
      if (out) logger.info('job_done', { job: name, result: out as never });
    } catch (e) {
      logger.error('job_failed', { job: name, err: e });
    }
  };
  const minute = setInterval(() => run('expire_reservations', () => expireReservations(app)), 60_000);
  const hourly = setInterval(() => {
    void run('purge_sessions', () => purgeExpiredSessions(app.db));
    void run('purge_prescriptions', () => purgeExpiredPrescriptions(app));
    void run('purge_view_history', () => app.db.query(`DELETE FROM recently_viewed WHERE viewed_at < now() - interval '90 days'`).then((r) => r.rowCount));
    void run('purge_guest_carts', () => app.db.query(`DELETE FROM carts WHERE user_id IS NULL AND updated_at < now() - interval '30 days'`).then((r) => r.rowCount));
    void run('purge_reset_tokens', () => app.db.query(`DELETE FROM password_reset_tokens WHERE expires_at < now() - interval '1 day'`).then((r) => r.rowCount));
  }, 3600_000);
  minute.unref();
  hourly.unref();
  void run('expire_reservations', () => expireReservations(app));
  return () => {
    clearInterval(minute);
    clearInterval(hourly);
  };
}
