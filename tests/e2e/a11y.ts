import type { Page } from 'playwright/test';

/**
 * Lightweight automated accessibility checks (axe-core could not be installed
 * offline; swap in @axe-core/playwright when available). Covers the WCAG
 * failures most common in storefronts: missing names, labels, alt text,
 * landmarks, heading structure, duplicate ids and low text contrast.
 */
export async function a11yProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const name = (el: Element) => {
      const lb = el.getAttribute('aria-labelledby');
      const fromIds = lb
        ? lb
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
        : '';
      return (
        (el.getAttribute('aria-label') ?? '') +
        fromIds +
        (el.textContent ?? '') +
        (el.getAttribute('title') ?? '') +
        ((el as HTMLInputElement).value && (el as HTMLInputElement).type === 'submit' ? (el as HTMLInputElement).value : '') +
        [...el.querySelectorAll('img[alt]')].map((i) => i.getAttribute('alt')).join('')
      );
    };
    if (!document.documentElement.lang) out.push('html is missing lang');
    if (!document.title.trim()) out.push('page has no <title>');
    if (document.querySelectorAll('main').length !== 1) out.push('page must have exactly one <main>');
    const h1 = [...document.querySelectorAll('h1')].filter(visible);
    if (h1.length !== 1) out.push(`expected one visible h1, found ${h1.length}`);
    for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) out.push(`img without alt: ${img.getAttribute('src')}`);
    for (const el of document.querySelectorAll('a[href], button, [role=button], summary')) {
      if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (!name(el).trim()) out.push(`control without accessible name: ${el.outerHTML.slice(0, 120)}`);
    }
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      const id = el.id;
      const labelled =
        (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label') || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (!labelled) out.push(`form field without label: ${el.outerHTML.slice(0, 120)}`);
    }
    const ids = new Map<string, number>();
    for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1) out.push(`duplicate id "${id}" ×${n}`);
    let last = 0;
    for (const h of document.querySelectorAll('main h1, main h2, main h3, main h4')) {
      const lvl = Number(h.tagName[1]);
      if (last && lvl > last + 1) out.push(`heading level skipped: h${last} → h${lvl} ("${h.textContent?.trim().slice(0, 40)}")`);
      last = lvl;
    }
    // Contrast check for visible text nodes on solid backgrounds (WCAG AA 4.5:1, 3:1 for large text).
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] | null => {
      while (el) {
        const cs = getComputedStyle(el);
        if (cs.backgroundImage !== 'none') return null; // gradients/images: skip
        const c = parse(cs.backgroundColor);
        if (c.length >= 3 && (c[3] === undefined || c[3] > 0.9)) return c.slice(0, 3);
        el = el.parentElement;
      }
      return [255, 255, 255];
    };
    const seen = new Set<string>();
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || !(el as HTMLElement).innerText?.trim() || [...el.childNodes].every((n) => n.nodeType !== 3 || !n.textContent?.trim())) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (fg[3] !== undefined && fg[3] < 0.9) continue;
      const bg = bgOf(el);
      if (!bg) continue;
      const [a, b] = [lum(fg.slice(0, 3)), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        const key = `${cs.color} on rgb(${bg.join(',')})`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(`low contrast ${ratio.toFixed(2)}:1 — ${key} — "${(el as HTMLElement).innerText.trim().slice(0, 40)}"`);
        }
      }
    }
    return out;
  });
}
