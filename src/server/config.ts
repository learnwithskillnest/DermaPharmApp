import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Load .env (KEY=VALUE lines) without overriding real environment variables. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    TRUST_PROXY: bool,
    PAYMENT_PROVIDER: z.enum(['sandbox', 'razorpay']).default('sandbox'),
    SANDBOX_PAYMENT_SECRET: z.string().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    PRESCRIPTION_STORAGE_DIR: z.string().default('./storage/prescriptions'),
    PRESCRIPTION_MAX_BYTES: z.coerce.number().int().min(100_000).max(20_000_000).default(5_000_000),
    ENABLE_PRESCRIPTION_ORDERING: bool,
    MAIL_DRIVER: z.enum(['log', 'database', 'webhook']).default('database'),
    MAIL_WEBHOOK_URL: z.string().url().optional(),
    MAIL_WEBHOOK_TOKEN: z.string().optional(),
    MAIL_FROM: z.string().default('GlowDerma Store <no-reply@example.invalid>'),
    ANALYTICS_PROVIDER: z.enum(['', 'plausible', 'ga4']).default(''),
    ANALYTICS_ID: z.string().optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.PAYMENT_PROVIDER === 'razorpay') {
      for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
        if (!c[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required when PAYMENT_PROVIDER=razorpay` });
      }
    }
    if (c.PAYMENT_PROVIDER === 'sandbox' && (!c.SANDBOX_PAYMENT_SECRET || c.SANDBOX_PAYMENT_SECRET.length < 32)) {
      ctx.addIssue({ code: 'custom', path: ['SANDBOX_PAYMENT_SECRET'], message: 'SANDBOX_PAYMENT_SECRET (32+ chars) is required for the sandbox gateway' });
    }
    if (c.NODE_ENV === 'production') {
      if (!c.APP_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'APP_URL must be https in production' });
      if (c.MAIL_DRIVER !== 'webhook') ctx.addIssue({ code: 'custom', path: ['MAIL_DRIVER'], message: 'Production requires MAIL_DRIVER=webhook (a real mail provider)' });
      if (c.PAYMENT_PROVIDER === 'sandbox' && process.env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
        ctx.addIssue({
          code: 'custom',
          path: ['PAYMENT_PROVIDER'],
          message: 'Sandbox payments are blocked in production (set ALLOW_SANDBOX_IN_PRODUCTION=true only for a private staging site)',
        });
      }
    }
  });

export type Config = z.infer<typeof schema> & { isProd: boolean; isTest: boolean };

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}\nSee .env.example.`);
  }
  return { ...parsed.data, isProd: parsed.data.NODE_ENV === 'production', isTest: parsed.data.NODE_ENV === 'test' };
}
