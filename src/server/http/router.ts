import type { Ctx } from './context.ts';
import type { Permission } from '../auth/permissions.ts';
import type { RuleName } from './rate-limit.ts';

export type Handler = (ctx: Ctx) => Promise<void> | void;

export interface RouteOptions {
  /** 'user' = any signed-in user. Admin routes use `perm` instead. */
  auth?: 'user';
  perm?: Permission;
  /** CSRF is enforced on every non-GET route unless explicitly disabled (webhooks only). */
  csrf?: boolean;
  multipart?: boolean;
  maxBytes?: number;
  rateLimit?: RuleName;
  /** Skip loading the session entirely (static-like or signed server-to-server routes). */
  session?: false;
}

export interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  path: string;
  handler: Handler;
  opts: RouteOptions;
}

export class Router {
  routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: RouteOptions = {}) {
    const keys: string[] = [];
    const source = path
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${source}/?$`), keys, path, handler, opts });
    return this;
  }

  get(path: string, h: Handler, o?: RouteOptions) {
    return this.add('GET', path, h, o);
  }
  post(path: string, h: Handler, o?: RouteOptions) {
    return this.add('POST', path, h, o);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed: string[] = [];
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) {
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            params[k] = m[i + 1];
          }
        });
        return { route: r, params };
      }
      allowed.push(r.method);
    }
    return allowed.length ? { allowed } : null;
  }
}
