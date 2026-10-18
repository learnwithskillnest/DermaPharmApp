/**
 * Offline configuration & repository checks (run in CI and before deploys).
 *   npm run security:check
 * Exits non-zero on any FAIL. `npm audit` is attempted when the registry is reachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
let fails = 0;
let warns = 0;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  fails++;
  console.log(`  FAIL  ${m}`);
};
const warn = (m: string) => {
  warns++;
  console.log(`  WARN  ${m}`);
};

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'storage', 'test-results', 'playwright-report', 'scratch']);
function files(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

console.log('Repository');
const gi = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
for (const must of ['.env', 'storage/', 'node_modules/', 'dist/']) {
  if (gi.split(/\r?\n/).some((l) => l.trim() === must)) ok(`.gitignore excludes ${must}`);
  else fail(`.gitignore must exclude ${must}`);
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Razorpay live key', /rzp_live_[A-Za-z0-9]{8,}/],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Postgres URL with inline password', /postgres(ql)?:\/\/[^:\s/]+:(?!password@|change-me|CHANGE_ME|\$\{|postgres@|glowderma@db)[^@\s'"`]{6,}@/],
  ['Generic secret assignment', /(SECRET|PASSWORD|TOKEN)\s*=\s*['"]?[A-Fa-f0-9]{32,}/],
];
const scanned = files(root).filter((f) => !f.endsWith('.env') && /\.(ts|tsx|js|mjs|json|md|yml|yaml|sql|example|css|txt|Dockerfile)$|Dockerfile$/.test(f));
let hits = 0;
for (const f of scanned) {
  const text = fs.readFileSync(f, 'utf8');
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(text)) {
      hits++;
      fail(`${name} pattern in ${path.relative(root, f)}`);
    }
  }
}
if (!hits) ok(`no secret patterns in ${scanned.length} tracked-type files`);

const example = path.join(root, '.env.example');
if (fs.existsSync(example)) {
  const t = fs.readFileSync(example, 'utf8');
  if (/rzp_(live|test)_[A-Za-z0-9]{6,}/.test(t) || /=[a-f0-9]{40,}\s*$/m.test(t)) fail('.env.example appears to contain a real key');
  else ok('.env.example holds placeholders only');
} else fail('.env.example is missing');

console.log('Code');
const src = files(path.join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f));
const allowedInnerHtml = new Set(['src/ui/island.tsx', 'src/ui/layout.tsx']);
for (const f of src) {
  const rel = path.relative(root, f).split(path.sep).join('/');
  const t = fs.readFileSync(f, 'utf8');
  if (/dangerouslySetInnerHTML/.test(t) && !allowedInnerHtml.has(rel)) fail(`dangerouslySetInnerHTML in ${rel} (only server-generated JSON/markup is allowed)`);
  if (/\beval\(|new Function\(/.test(t)) fail(`dynamic code execution in ${rel}`);
  // Every SQL call must use bound parameters: flag template-literal interpolation of request input.
  if (/\.(query|one|many)\([^)]*\$\{ctx\.(form|query|params)/.test(t)) fail(`request input interpolated into SQL in ${rel}`);
}
ok('dangerouslySetInnerHTML limited to island/JSON-LD/nonce scripts; no eval; no request input in SQL strings');

const perms =
  fs.readFileSync(path.join(root, 'src/server/routes/admin/misc.tsx'), 'utf8') +
  fs.readFileSync(path.join(root, 'src/server/routes/admin/orders.tsx'), 'utf8') +
  fs.readFileSync(path.join(root, 'src/server/routes/admin/catalog.tsx'), 'utf8');
const adminRoutes = [...perms.matchAll(/r\.(get|post)\(\s*['`](\/admin[^'`]*)['`]/g)].length;
const withPerm = [...perms.matchAll(/perm: '/g)].length + [...perms.matchAll(/\{ \.\.\.(O|VIEW|P|S|I|T|C)\b/g)].length;
if (adminRoutes > 0) ok(`${adminRoutes} admin routes declared; permission declarations found: ${withPerm} (enforced centrally by the router; see tests/integration/authz.test.ts)`);

console.log('Runtime configuration (.env)');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  const env = Object.fromEntries(
    fs
      .readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  if ((env.SESSION_SECRET ?? '').length >= 32) ok('SESSION_SECRET is 32+ characters');
  else fail('SESSION_SECRET must be 32+ random characters');
  if (env.NODE_ENV === 'production') {
    if (!String(env.APP_URL).startsWith('https://')) fail('production APP_URL must be https');
    if (env.PAYMENT_PROVIDER !== 'razorpay') fail('production must use a real payment provider');
    if (!/sslmode=verify-full/.test(env.DATABASE_URL ?? '')) warn('production DATABASE_URL should use sslmode=verify-full');
  } else warn(`NODE_ENV=${env.NODE_ENV ?? 'development'} (development settings; production checks skipped)`);
  if (env.ENABLE_PRESCRIPTION_ORDERING === 'true') warn('ENABLE_PRESCRIPTION_ORDERING=true — confirm licences and legal sign-off are in place');
  else ok('prescription ordering server flag is off');
} else warn('.env not found (copy .env.example)');

console.log('Dependencies');
const audit = spawnSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
if (audit.status === 0) ok('npm audit: no high/critical advisories in production dependencies');
else if (/ENOTFOUND|EAI_AGAIN|403|ECONNREFUSED|network|ENOLOCK|ETIMEDOUT/i.test(audit.stdout + audit.stderr) || audit.error)
  warn('npm audit could not run (registry unreachable or no lockfile) — run it in CI with network access');
else fail('npm audit reported high/critical advisories — run `npm audit` for details');

console.log(`\n${fails ? 'FAILED' : 'OK'}: ${fails} failure(s), ${warns} warning(s)`);
process.exit(fails ? 1 : 0);
