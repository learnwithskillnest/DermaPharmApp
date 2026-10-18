import type { ReactNode } from 'react';
import type { Ctx } from '../../http/context.ts';
import { render } from '../../render.tsx';

/** Admin pages use the bare document (no storefront header/footer) and are never indexed. */
export function renderAdmin(ctx: Ctx, title: string, body: ReactNode, status = 200) {
  return render(ctx, { title: `${title} — Admin`, noindex: true }, body, { bare: true, status });
}

export function formValues(form: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (k !== '_csrf') out[k] = v;
  return out;
}
