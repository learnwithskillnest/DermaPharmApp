/**
 * Fixed-window rate limiter held in process memory.
 * Correct for a single app instance; for horizontal scaling move the counters
 * to Redis or Postgres (documented in DEPLOYMENT.md).
 */
export interface LimitRule {
  limit: number;
  windowMs: number;
}

export const RULES = {
  login: { limit: 10, windowMs: 15 * 60_000 },
  loginIp: { limit: 40, windowMs: 15 * 60_000 },
  register: { limit: 10, windowMs: 60 * 60_000 },
  passwordReset: { limit: 5, windowMs: 60 * 60_000 },
  contact: { limit: 5, windowMs: 60 * 60_000 },
  placeOrder: { limit: 20, windowMs: 10 * 60_000 },
  payment: { limit: 40, windowMs: 10 * 60_000 },
  upload: { limit: 10, windowMs: 60 * 60_000 },
  suggest: { limit: 120, windowMs: 60_000 },
  cart: { limit: 120, windowMs: 60_000 },
  adminWrite: { limit: 300, windowMs: 60_000 },
} satisfies Record<string, LimitRule>;

export type RuleName = keyof typeof RULES;

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private timer: NodeJS.Timeout;
  disabled = false;

  constructor() {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  /** Returns seconds until retry if the limit is exceeded, otherwise 0. */
  hit(rule: RuleName, key: string, now = Date.now()): number {
    if (this.disabled) return 0;
    const r = RULES[rule];
    const k = `${rule}:${key}`;
    const cur = this.hits.get(k);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(k, { count: 1, resetAt: now + r.windowMs });
      return 0;
    }
    cur.count++;
    if (cur.count > r.limit) return Math.ceil((cur.resetAt - now) / 1000);
    return 0;
  }

  reset(rule: RuleName, key: string) {
    this.hits.delete(`${rule}:${key}`);
  }

  clear() {
    this.hits.clear();
  }

  private sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }

  stop() {
    clearInterval(this.timer);
  }
}
