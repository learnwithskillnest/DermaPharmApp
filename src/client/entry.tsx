import { hydrateRoot } from 'react-dom/client';
import { createElement } from 'react';
import { islands, type IslandName } from './registry.ts';

// 1. Hydrate server-rendered islands.
for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-island]'))) {
  const name = el.dataset.island as IslandName;
  const Component = islands[name] as unknown as (p: unknown) => unknown;
  if (!Component) continue;
  let props: unknown = {};
  try {
    props = JSON.parse(el.dataset.props ?? '{}');
  } catch {
    continue;
  }
  hydrateRoot(el, createElement(Component, props as object));
}

// 2. Confirmation for destructive one-button forms.
document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  const msg = form.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// 3. Live cart badge.
window.addEventListener('cart:updated', (e) => {
  const count = (e as CustomEvent<{ count?: number }>).detail?.count;
  if (typeof count !== 'number') return;
  document.querySelectorAll<HTMLElement>('[data-cart-count]').forEach((n) => {
    n.textContent = String(count);
    n.hidden = count === 0;
  });
  document.querySelectorAll<HTMLElement>('[data-cart-label]').forEach((n) => {
    n.setAttribute('aria-label', `Cart, ${count} item${count === 1 ? '' : 's'}`);
  });
});

// 4. Move focus to the error summary after a failed form submission.
document.getElementById('form-errors')?.focus();

// 5. Auto-submit selects marked data-autosubmit (sort, filters) — the button stays for no-JS users.
document.querySelectorAll<HTMLSelectElement>('select[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form?.requestSubmit()));
