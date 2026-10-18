import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string | Buffer, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

// OWASP-recommended scrypt parameters (N=2^17 is the strong option; 2^15 balances latency).
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 128 * PARAMS.N * PARAMS.r * 2,
  });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const N = Number(n);
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return crypto.timingSafeEqual(key, expected);
}

/** Pre-computed hash used to spend equal time when the email doesn't exist. */
let dummy: Promise<string> | null = null;
export function dummyHash() {
  dummy ??= hashPassword('not-a-real-password-' + crypto.randomUUID());
  return dummy;
}

export function needsRehash(stored: string) {
  return !stored.startsWith(`scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$`);
}

/** Basic strength rule: 10+ chars, not all one class, not a top-common password. */
const COMMON = new Set(['password123', 'qwerty12345', '1234567890', 'iloveyou12', 'password@123', 'admin12345', 'welcome123']);
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Choose another.';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    return 'Your password should not contain your email name.';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 2) return 'Mix letters with numbers or symbols.';
  return null;
}
