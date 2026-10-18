import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from './db.ts';

// Resolved from the working directory so it works both from source (tsx) and from the bundled dist/.
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

/**
 * Applies pending SQL migrations in filename order, each inside its own
 * transaction. Applied files are checksummed; editing one after it ran is an error.
 */
export async function migrate(db: Database, dir = MIGRATIONS_DIR, log: (s: string) => void = console.log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await db.many<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).map((r) => [r.name, r.checksum]));
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  let count = 0;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const prior = applied.get(file);
    if (prior) {
      if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      continue;
    }
    await db.withConnection(async (c) => {
      await c.simpleQuery('BEGIN');
      try {
        await c.simpleQuery(sql);
        await c.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await c.simpleQuery('COMMIT');
      } catch (e) {
        await c.simpleQuery('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    });
    log(`applied ${file}`);
    count++;
  }
  if (count === 0) log('database is up to date');
  return count;
}
