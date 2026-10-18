import { createContext, useContext } from 'react';
import type { Role } from '../server/auth/permissions.ts';

/** Request-scoped values every server-rendered component may need. */
export interface UiContext {
  csrf: string;
  user: { id: string; name: string; email: string; role: Role } | null;
  storeName: string;
  path: string;
  sandbox: boolean;
}

export const Ui = createContext<UiContext>({ csrf: '', user: null, storeName: 'GlowDerma Store', path: '/', sandbox: true });

export function useUi() {
  return useContext(Ui);
}

export function CsrfField() {
  const { csrf } = useUi();
  return <input type="hidden" name="_csrf" value={csrf} />;
}
