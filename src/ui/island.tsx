import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { islands, type IslandName } from '../client/registry.ts';

/**
 * Renders an interactive component on the server as its OWN React root (so
 * useId and markup match the browser's hydrateRoot exactly) and marks it for
 * hydration. Props must be JSON-serialisable and must not contain secrets.
 */
export function Island<N extends IslandName>({ name, props, className }: { name: N; props: Parameters<(typeof islands)[N]>[0]; className?: string }) {
  const html = renderToString(createElement(islands[name] as (p: unknown) => unknown, props as object));
  return <div className={className} data-island={name} data-props={JSON.stringify(props)} dangerouslySetInnerHTML={{ __html: html }} />;
}
