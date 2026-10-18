import type { Config } from '../config.ts';
import type { Queryable } from '../db/db.ts';
import { logger } from '../logger.ts';

export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

/**
 * Drivers:
 *  - database: stores mail in `outbound_emails` (development/test only; lets tests read reset links)
 *  - log:      writes subject to the log (body only in development)
 *  - webhook:  POSTs JSON {from,to,subject,text} to MAIL_WEBHOOK_URL with a bearer token —
 *              point it at your provider's HTTP API or a small relay (see DEPLOYMENT.md).
 */
export function createMailer(config: Config, db: Queryable): Mailer {
  switch (config.MAIL_DRIVER) {
    case 'database':
      return {
        async send(to, subject, body) {
          await db.query('INSERT INTO outbound_emails (to_email, subject, body) VALUES ($1, $2, $3)', [to, subject, body]);
        },
      };
    case 'log':
      return {
        async send(to, subject, body) {
          logger.info('mail', { to: to.replace(/(.).*@/, '$1***@'), subject, ...(config.NODE_ENV === 'development' ? { body } : {}) });
        },
      };
    case 'webhook':
      return {
        async send(to, subject, body) {
          const res = await fetch(config.MAIL_WEBHOOK_URL!, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.MAIL_WEBHOOK_TOKEN ?? ''}` },
            body: JSON.stringify({ from: config.MAIL_FROM, to, subject, text: body }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Mail webhook responded ${res.status}`);
        },
      };
  }
}

/** Mail failures are logged, never thrown: a bounced email must not fail an order. */
export async function sendSafely(mailer: Mailer, to: string, subject: string, body: string) {
  try {
    await mailer.send(to, subject, body);
  } catch (e) {
    logger.error('mail_failed', { subject, err: e });
  }
}
