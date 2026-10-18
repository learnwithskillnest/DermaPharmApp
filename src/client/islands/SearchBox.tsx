import { useEffect, useRef, useState } from 'react';
import { formatINR } from '../../shared/money.ts';

interface Suggestion {
  products: Array<{ slug: string; name: string; brand: string; price_paise: number | null; image: string | null }>;
  categories: Array<{ slug: string; name: string }>;
}

interface Option {
  href: string;
  label: string;
  meta: string;
}

/**
 * Accessible combobox (WAI-ARIA 1.2 pattern). Without JavaScript it is a plain
 * GET form to /search, so search always works.
 */
export function SearchBox({ initial = '', compact = false, idBase = 'search' }: { initial?: string; compact?: boolean; idBase?: string }) {
  // Explicit id base: two search boxes (desktop + mobile) render on every page.
  const id = idBase;
  const [q, setQ] = useState(initial);
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setOptions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      ctrl.current?.abort();
      ctrl.current = new AbortController();
      try {
        const res = await fetch(`/api/search/suggest?q=${encodeURIComponent(term)}`, { signal: ctrl.current.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const data = (await res.json()) as Suggestion;
        const next: Option[] = [
          ...data.categories.map((c) => ({ href: `/c/${c.slug}`, label: c.name, meta: 'Category' })),
          ...data.products.map((p) => ({ href: `/p/${p.slug}`, label: p.name, meta: `${p.brand}${p.price_paise ? ' — ' + formatINR(p.price_paise) : ''}` })),
        ];
        setOptions(next);
        setActive(-1);
        setOpen(true);
      } catch {
        /* aborted or offline: the plain form still works */
      }
    }, 180);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  const listId = `${id}-list`;
  const showList = open && options.length > 0;

  return (
    <form
      action="/search"
      method="get"
      role="search"
      className="relative w-full"
      onSubmit={(e: { preventDefault(): void }) => {
        if (active >= 0 && options[active]) {
          e.preventDefault();
          window.location.href = options[active].href;
        }
      }}
    >
      <label htmlFor={`${id}-q`} className="sr-only">
        Search products, ingredients and brands
      </label>
      <div className="relative">
        <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-[var(--color-forest-600)]">
          <circle cx="8.5" cy="8.5" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          id={`${id}-q`}
          name="q"
          type="search"
          value={q}
          autoComplete="off"
          maxLength={100}
          placeholder={compact ? 'Search' : 'Search “niacinamide”, “SPF 50”, “face wash”'}
          className={`input rounded-full pl-10 ${compact ? 'min-h-10' : 'min-h-11'} bg-[var(--color-mint-50)] border-transparent`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          onChange={(e: { target: { value: string } }) => setQ(e.target.value)}
          onFocus={() => options.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e: { key: string; preventDefault(): void }) => {
            if (!showList) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => (a + 1) % options.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
            } else if (e.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            }
          }}
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Suggestions"
        hidden={!showList}
        className="absolute top-full right-0 left-0 z-50 mt-2 overflow-hidden rounded-xl border border-[var(--color-line)] bg-white py-1"
      >
        {options.map((o, i) => (
          <li
            key={o.href}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            className={`cursor-pointer px-4 py-2.5 ${i === active ? 'bg-[var(--color-mint-100)]' : ''}`}
            onMouseDown={(e: { preventDefault(): void }) => {
              e.preventDefault();
              window.location.href = o.href;
            }}
          >
            <span className="block text-sm font-semibold text-[var(--color-forest-900)]">{o.label}</span>
            <span className="block text-xs text-[var(--color-muted)]">{o.meta}</span>
          </li>
        ))}
      </ul>
      <button type="submit" className="sr-only">
        Search
      </button>
    </form>
  );
}
