/**
 * DESTRUCTIVE: drops every table in the DEVELOPMENT database, re-runs migrations and seeds.
 *   npm run db:reset -- --yes
 * Refuses unless the database host is local and NODE_ENV is not production.
 */
import { spawnSync } from 'node:child_process';
import { loadDotEnv } from '../src/server/config.ts';
import { createDatabase } from '../src/server/db/db.ts';
import { parseDatabaseUrl } from '../src/server/db/pg-wire.ts';
import { migrate } from '../src/server/db/migrate.ts';

loadDotEnv();
const url = process.env.DATABASE_URL ?? '';
const host = url ? parseDatabaseUrl(url).host : '';
if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1', 'db', 'postgres'].includes(host)) {
  console.error(`Refusing to reset: NODE_ENV=${process.env.NODE_ENV ?? ''}, host=${host}. This command is for local development databases only.`);
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('This deletes ALL data in the development database. Re-run with --yes to confirm.');
  process.exit(1);
}
const db = createDatabase(url, { max: 1 });
try {
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await migrate(db);
} finally {
  await db.close();
}
const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed.ts'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
