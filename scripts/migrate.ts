import { loadDotEnv } from '../src/server/config.ts';
import { createDatabase } from '../src/server/db/db.ts';
import { migrate } from '../src/server/db/migrate.ts';

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (see .env.example)');
  process.exit(1);
}
const db = createDatabase(url, { max: 2 });
try {
  await migrate(db);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
