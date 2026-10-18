/**
 * Original placeholder packaging art (no third-party images). Every image is
 * captioned "Sample image" so it is never mistaken for real product photography.
 */
import type { ArtForm } from './seed-data.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PALETTES: Record<string, { bg1: string; bg2: string; pack: string; band: string; ink: string; cap: string }> = {
  skincare: { bg1: '#eef8f2', bg2: '#d4eddf', pack: '#ffffff', band: '#214c3b', ink: '#163a2d', cap: '#cdb784' },
  cosmetology: { bg1: '#f7f2e6', bg2: '#ede3cc', pack: '#ffffff', band: '#163a2d', ink: '#163a2d', cap: '#bfa46a' },
  'body-hair': { bg1: '#f1f6f3', bg2: '#dfece5', pack: '#fbfdfc', band: '#2c5f4a', ink: '#1a3f31', cap: '#9fc7b2' },
  pharmacy: { bg1: '#f3f6f8', bg2: '#dfe8ee', pack: '#ffffff', band: '#1f4e6b', ink: '#173a50', cap: '#a7c0cf' },
};

function wrap(text: string, max: number): string[] {
  const words = text.replace(/\s*\(Rx demonstration listing\)/, '').split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function shape(form: ArtForm, c: (typeof PALETTES)[string]): { svg: string; label: Box } {
  const shadow = (cx: number, w: number) => `<ellipse cx="${cx}" cy="448" rx="${w / 2}" ry="10" fill="#000" opacity="0.07"/>`;
  switch (form) {
    case 'pump':
      return {
        svg: `${shadow(200, 150)}<rect x="186" y="58" width="28" height="40" rx="4" fill="${c.cap}"/><rect x="150" y="60" width="62" height="12" rx="6" fill="${c.cap}"/><rect x="170" y="96" width="60" height="26" rx="6" fill="${c.cap}"/><rect x="128" y="118" width="144" height="330" rx="34" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/>`,
        label: { x: 128, y: 190, w: 144, h: 190 },
      };
    case 'tube':
      return {
        svg: `${shadow(200, 130)}<path d="M138 70 h124 l-12 330 h-100 z" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/><rect x="138" y="62" width="124" height="14" rx="3" fill="${c.bg2}"/><rect x="168" y="400" width="64" height="48" rx="8" fill="${c.cap}"/>`,
        label: { x: 146, y: 140, w: 108, h: 200 },
      };
    case 'dropper':
      return {
        svg: `${shadow(200, 140)}<rect x="186" y="56" width="28" height="56" rx="14" fill="#2b2b2b" opacity="0.85"/><rect x="174" y="108" width="52" height="48" rx="6" fill="${c.cap}"/><rect x="134" y="152" width="132" height="296" rx="26" fill="#a8742c" opacity="0.92"/><rect x="134" y="152" width="132" height="296" rx="26" fill="url(#gl)"/>`,
        label: { x: 144, y: 230, w: 112, h: 160 },
      };
    case 'jar':
      return {
        svg: `${shadow(200, 230)}<rect x="96" y="214" width="208" height="56" rx="12" fill="${c.cap}"/><rect x="88" y="262" width="224" height="186" rx="30" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/>`,
        label: { x: 100, y: 282, w: 200, h: 140 },
      };
    case 'spray':
    case 'bottle':
      return {
        svg: `${shadow(200, 150)}<rect x="168" y="70" width="64" height="58" rx="10" fill="${c.cap}"/><path d="M180 126 h40 v24 c34 8 52 26 52 60 v210 c0 16 -12 28 -28 28 h-88 c-16 0 -28 -12 -28 -28 v-210 c0 -34 18 -52 52 -60 z" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/>`,
        label: { x: 128, y: 230, w: 144, h: 170 },
      };
    case 'sachet':
      return {
        svg: `${shadow(200, 220)}<path d="M100 96 h200 v352 h-200 z" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/><path d="M100 96 h200 v26 h-200 z" fill="${c.bg2}"/><path d="M100 422 h200 v26 h-200 z" fill="${c.bg2}"/>`,
        label: { x: 112, y: 150, w: 176, h: 230 },
      };
    case 'box':
    case 'strip':
    default:
      return {
        svg: `${shadow(200, 250)}<path d="M84 150 l40 -30 h192 l-40 30 z" fill="${c.bg2}"/><path d="M276 150 l40 -30 v268 l-40 30 z" fill="${c.cap}" opacity="0.7"/><rect x="84" y="150" width="192" height="268" rx="4" fill="${c.pack}" stroke="${c.bg2}" stroke-width="2"/>`,
        label: { x: 92, y: 180, w: 176, h: 200 },
      };
  }
}

export function productArt(p: { name: string; brandName: string; strength?: string; department: string; form: ArtForm; rx: boolean }): string {
  const c = PALETTES[p.department] ?? PALETTES.skincare;
  const { svg, label } = shape(p.form, c);
  const maxChars = Math.max(9, Math.floor(label.w / 9.5));
  const lines = wrap(p.name.replace(/\s*\d+(\.\d+)?%\s*/, ' ').trim(), maxChars);
  const cx = label.x + label.w / 2;
  const dark = p.form === 'dropper';
  const ink = dark ? '#fffaf0' : c.ink;
  let y = label.y + 22;
  const parts: string[] = [];
  parts.push(
    `<text x="${cx}" y="${y}" font-size="10" letter-spacing="2" font-weight="700" fill="${dark ? '#f3e7c9' : c.band}" text-anchor="middle">${esc(p.brandName.toUpperCase())}</text>`,
  );
  y += 10;
  parts.push(`<line x1="${cx - 22}" x2="${cx + 22}" y1="${y}" y2="${y}" stroke="${c.cap}" stroke-width="1.5"/>`);
  if (p.strength) {
    y += 34;
    parts.push(`<text x="${cx}" y="${y}" font-size="30" font-weight="300" fill="${ink}" text-anchor="middle">${esc(p.strength)}</text>`);
  }
  y += 22;
  for (const l of lines) {
    parts.push(`<text x="${cx}" y="${y}" font-size="13" font-weight="600" fill="${ink}" text-anchor="middle">${esc(l)}</text>`);
    y += 16;
  }
  if (p.rx) {
    y += 6;
    parts.push(
      `<rect x="${cx - 34}" y="${y - 12}" width="68" height="18" rx="9" fill="#8a1c1c"/><text x="${cx}" y="${y + 1}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">Rx ONLY</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" width="400" height="500" font-family="Hanken Grotesk, Segoe UI, Arial, sans-serif">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.bg1}"/><stop offset="1" stop-color="${c.bg2}"/></linearGradient>
<linearGradient id="gl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0.25"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.12"/></linearGradient></defs>
<rect width="400" height="500" fill="url(#bg)"/>
<circle cx="330" cy="70" r="110" fill="#fff" opacity="0.35"/>
${svg}
${parts.join('\n')}
<text x="200" y="486" font-size="10" letter-spacing="1.5" fill="${c.ink}" opacity="0.55" text-anchor="middle">SAMPLE IMAGE · NOT ACTUAL PRODUCT</text>
</svg>`;
}

export const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" width="400" height="500"><rect width="400" height="500" fill="#f3faf6"/><circle cx="200" cy="230" r="54" fill="none" stroke="#b3dcc6" stroke-width="3"/><path d="M178 230 h44 M200 208 v44" stroke="#b3dcc6" stroke-width="3" stroke-linecap="round"/><text x="200" y="330" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="#55635c" text-anchor="middle">Image coming soon</text></svg>`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#163a2d"/><path d="M32 14c-8 10-13 17-13 24a13 13 0 0 0 26 0c0-7-5-14-13-24z" fill="#d4eddf"/><circle cx="32" cy="39" r="4" fill="#cdb784"/></svg>`;
