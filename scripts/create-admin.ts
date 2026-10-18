/**
 * Creates (or promotes) the first administrator without any default password.
 *   npm run admin:create -- --email owner@example.com --name "Store Owner"
 * The password is read from ADMIN_PASSWORD or prompted on the terminal (not echoed).
 */
import readline from 'node:readline';
import { loadDotEnv } from '../src/server/config.ts';
import { createDatabase } from '../src/server/db/db.ts';
import { hashPassword, passwordProblem } from '../src/server/auth/password.ts';

loadDotEnv();
function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function promptHidden(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
    muted = true;
  });
}

const email = (arg('email') ?? '').trim().toLowerCase();
const name = (arg('name') ?? 'Store Admin').trim();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run admin:create -- --email you@example.com --name "Your Name"');
  process.exit(1);
}
const password = process.env.ADMIN_PASSWORD || (await promptHidden('Password (10+ chars): '));
const problem = passwordProblem(password, email);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const db = createDatabase(process.env.DATABASE_URL!, { max: 1 });
try {
  const hash = await hashPassword(password);
  const row = await db.one<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (lower(email)) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash, disabled_at = NULL, updated_at = now()
     RETURNING id`,
    [email, name, hash],
  );
  await db.query(`INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, details) VALUES (NULL, 'cli', 'user.admin_created', 'user', $1, '{}')`, [row!.id]);
  console.log(`Admin ready: ${email}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
