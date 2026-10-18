import type { Ctx } from '../http/context.ts';
import type { CartOwner } from '../services/cart.ts';
import type { Settings } from '../services/settings.ts';
import type { Visibility } from '../services/catalog.ts';
import { SORTS, type SortKey } from '../services/catalog.ts';
import { rupeesToPaise } from '../../shared/money.ts';
import type { ListingState } from '../../ui/pages/catalog.tsx';
import type { Actor } from '../services/audit.ts';
import { HttpError } from '../http/errors.ts';

export function owner(ctx: Ctx): CartOwner {
  return { userId: ctx.user?.id ?? null, sessionId: ctx.session?.id ?? null };
}

export function ownerKey(ctx: Ctx): string | null {
  if (ctx.user) return 'u:' + ctx.user.id;
  if (ctx.session) return 's:' + ctx.session.id;
  return null;
}

export function visibility(s: Settings): Visibility {
  return { otcVisible: s.pharmacy.otcVisible, rxListingVisible: s.pharmacy.rxListingVisible };
}

export function actor(ctx: Ctx): Actor {
  return { id: ctx.user?.id ?? null, role: ctx.user?.role ?? null, ip: ctx.ip };
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseListing(q: URLSearchParams): ListingState {
  const term = (q.get('q') ?? '').trim().slice(0, 100) || undefined;
  const sortRaw = q.get('sort') as SortKey | null;
  const sort: SortKey = sortRaw && sortRaw in SORTS ? sortRaw : term ? 'relevance' : 'newest';
  const min = q.get('min') ? (rupeesToPaise(q.get('min')!) ?? undefined) : undefined;
  const max = q.get('max') ? (rupeesToPaise(q.get('max')!) ?? undefined) : undefined;
  const page = Math.min(Math.max(Number.parseInt(q.get('page') ?? '1', 10) || 1, 1), 500);
  return {
    q: term,
    categories: q
      .getAll('category')
      .filter((c) => SLUG.test(c))
      .slice(0, 20),
    brands: q
      .getAll('brand')
      .filter((b) => SLUG.test(b))
      .slice(0, 20),
    min,
    max: max !== undefined && min !== undefined && max < min ? undefined : max,
    inStock: q.get('instock') === '1',
    sort: sort === 'relevance' && !term ? 'newest' : sort,
    page,
  };
}

export function requireUuid(v: string | undefined): string {
  if (!v || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new HttpError(404, 'We could not find that page.');
  return v;
}

/** Form values echo for re-rendering after validation errors (never echo passwords). */
export function echo(form: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (!/password|confirm|current|_csrf|token/i.test(k)) out[k] = v;
  return out;
}
