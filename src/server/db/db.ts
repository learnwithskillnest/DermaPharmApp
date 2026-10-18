import { PgConnection, parseDatabaseUrl, type PgConnectOptions, type QueryResult } from './pg-wire.ts';
import { logger } from '../logger.ts';

export { asJson, PgError } from './pg-wire.ts';

/** The only database surface the rest of the app depends on. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  many<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Database extends Queryable {
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
  withConnection<T>(fn: (c: PgConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  stats(): { total: number; idle: number; waiting: number };
}

const SLOW_QUERY_MS = 500;

function wrap(run: <T>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>): Queryable {
  return {
    query: run,
    async one<T>(sql: string, params?: unknown[]) {
      const r = await run<T>(sql, params);
      return r.rows[0] ?? null;
    },
    async many<T>(sql: string, params?: unknown[]) {
      return (await run<T>(sql, params)).rows;
    },
  };
}

export function createDatabase(url: string, opts: { max?: number; acquireTimeoutMs?: number } = {}): Database {
  const config: PgConnectOptions = parseDatabaseUrl(url);
  const max = opts.max ?? 10;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 10_000;
  const idle: PgConnection[] = [];
  const waiting: Array<{ resolve: (c: PgConnection) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  let total = 0;
  let closing = false;

  async function create(): Promise<PgConnection> {
    const c = new PgConnection();
    c.onError = () => {
      const i = idle.indexOf(c);
      if (i >= 0) idle.splice(i, 1);
    };
    total++;
    try {
      await c.connect(config);
      return c;
    } catch (e) {
      total--;
      throw e;
    }
  }

  async function acquire(): Promise<PgConnection> {
    if (closing) throw new Error('Database pool is closing');
    while (idle.length) {
      const c = idle.pop()!;
      if (!c.closed) return c;
      total--;
    }
    if (total < max) return create();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiting.findIndex((w) => w.timer === timer);
        if (i >= 0) waiting.splice(i, 1);
        reject(new Error('Timed out waiting for a database connection'));
      }, acquireTimeoutMs);
      waiting.push({ resolve, reject, timer });
    });
  }

  function release(c: PgConnection) {
    if (c.closed || c.broken || c.txStatus !== 'I') {
      total--;
      void c.end();
      // A slot opened up — let a waiter create a fresh connection.
      const w = waiting.shift();
      if (w) {
        clearTimeout(w.timer);
        create().then(w.resolve, w.reject);
      }
      return;
    }
    const w = waiting.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(c);
    } else idle.push(c);
  }

  async function timed<T>(c: PgConnection, sql: string, params?: unknown[]) {
    const start = performance.now();
    try {
      return await c.query<T>(sql, params ?? []);
    } finally {
      const ms = performance.now() - start;
      if (ms > SLOW_QUERY_MS) logger.warn('slow_query', { ms: Math.round(ms), sql: sql.slice(0, 160) });
    }
  }

  async function run<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const c = await acquire();
    try {
      return await timed<T>(c, sql, params);
    } finally {
      release(c);
    }
  }

  const base = wrap(run);
  return {
    ...base,
    async tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> {
      const c = await acquire();
      try {
        await c.query('BEGIN');
        const result = await fn(wrap(<R>(sql: string, params?: unknown[]) => timed<R>(c, sql, params)));
        await c.query('COMMIT');
        return result;
      } catch (e) {
        if (!c.closed) {
          try {
            await c.query('ROLLBACK');
          } catch {
            /* connection unusable; release() will discard it */
          }
        }
        throw e;
      } finally {
        release(c);
      }
    },
    async withConnection<T>(fn: (c: PgConnection) => Promise<T>) {
      const c = await acquire();
      try {
        return await fn(c);
      } finally {
        release(c);
      }
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const w of waiting.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error('Database pool closed'));
      }
      await Promise.all(idle.splice(0).map((c) => c.end()));
    },
    stats: () => ({ total, idle: idle.length, waiting: waiting.length }),
  };
}

/** True when an error is a unique-constraint violation. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}
