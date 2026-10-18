/**
 * Minimal React type declarations.
 *
 * WHY THIS EXISTS: the build sandbox had no npm registry access, so
 * @types/react and @types/react-dom could not be installed. This shim gives
 * TypeScript enough to type-check our own component props and hooks.
 *
 * TO REMOVE: `npm i -D @types/react@19 @types/react-dom@19`, then delete this
 * file. Expect a handful of stricter JSX attribute errors to fix.
 */
declare module 'react' {
  export type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  export interface ReactElement {
    type: unknown;
    props: unknown;
    key: string | null;
  }
  export type CSSProperties = Record<string, string | number | undefined>;
  export type FC<P = Record<string, never>> = (props: P) => ReactNode;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export interface MutableRefObject<T> {
    current: T;
  }
  export interface RefObject<T> {
    current: T | null;
  }
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): MutableRefObject<T>;
  export function useRef<T>(initial: T | null): RefObject<T>;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  export function useId(): string;
  export function useTransition(): [boolean, (cb: () => void) => void];
  export interface Context<T> {
    Provider: (props: { value: T; children?: ReactNode }) => ReactElement | null;
  }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(ctx: Context<T>): T;
  export const Fragment: unique symbol;
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): ReactElement;
  export const StrictMode: unique symbol;
  const React: {
    createElement: typeof createElement;
    Fragment: typeof Fragment;
  };
  export default React;
}

declare module 'react/jsx-runtime' {
  export namespace JSX {
    type Element = import('react').ReactElement;
    interface ElementChildrenAttribute {
      children: unknown;
    }
    interface IntrinsicAttributes {
      key?: string | number | null;
    }
    interface IntrinsicElements {
      // Attribute checking for DOM elements is relaxed until @types/react is installed.
      [elemName: string]: Record<string, unknown>;
    }
  }
  export const jsx: unknown;
  export const jsxs: unknown;
  export const Fragment: unknown;
}

declare module 'react/jsx-dev-runtime' {
  export * from 'react/jsx-runtime';
}

declare module 'react-dom/server' {
  export function renderToString(element: unknown): string;
  export function renderToStaticMarkup(element: unknown): string;
}

declare module 'react-dom/client' {
  export interface Root {
    render(element: unknown): void;
    unmount(): void;
  }
  export function hydrateRoot(container: Element, element: unknown): Root;
  export function createRoot(container: Element): Root;
}
