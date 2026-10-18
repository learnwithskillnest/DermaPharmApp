import type { ReactNode } from 'react';
import { can, type Permission } from '../../server/auth/permissions.ts';
import { useUi } from '../context.tsx';
import { Logo } from '../layout.tsx';
import { ActionButton } from '../forms.tsx';
import { formatINR } from '../../shared/money.ts';

const NAV: Array<{ href: string; label: string; perm: Permission }> = [
  { href: '/admin', label: 'Overview', perm: 'admin.access' },
  { href: '/admin/orders', label: 'Orders', perm: 'orders.manage' },
  { href: '/admin/products', label: 'Products', perm: 'products.manage' },
  { href: '/admin/taxonomy', label: 'Categories & brands', perm: 'taxonomy.manage' },
  { href: '/admin/inventory', label: 'Stock', perm: 'inventory.manage' },
  { href: '/admin/inventory/batches', label: 'Batches & expiry', perm: 'inventory.manage' },
  { href: '/admin/returns', label: 'Returns & refunds', perm: 'returns.manage' },
  { href: '/admin/prescriptions', label: 'Prescription review', perm: 'rx.queue' },
  { href: '/admin/customers', label: 'Customers', perm: 'customers.view' },
  { href: '/admin/coupons', label: 'Coupons', perm: 'coupons.manage' },
  { href: '/admin/reports', label: 'Reports', perm: 'reports.view' },
  { href: '/admin/messages', label: 'Messages', perm: 'messages.view' },
  { href: '/admin/users', label: 'Staff accounts', perm: 'users.manage' },
  { href: '/admin/audit', label: 'Audit log', perm: 'audit.view' },
  { href: '/admin/settings', label: 'Store settings', perm: 'settings.manage' },
];

export function AdminShell({ title, children, actions, current }: { title: string; children: ReactNode; actions?: ReactNode; current: string }) {
  const { user } = useUi();
  const items = NAV.filter((n) => can(user?.role, n.perm));
  return (
    <div className="grid min-h-dvh bg-[#fbfcfb] md:grid-cols-[15rem_1fr]">
      <aside className="border-b border-[var(--color-line)] bg-white md:border-r md:border-b-0">
        <div className="flex items-center justify-between p-4 md:block">
          <a href="/admin" aria-label="Admin home">
            <Logo small />
          </a>
          <p className="mt-1 text-xs text-[var(--color-muted)] md:mt-2">
            Admin, signed in as {user?.name} ({user?.role})
          </p>
        </div>
        <nav aria-label="Admin" className="px-2 pb-4">
          <ul className="flex gap-1 overflow-x-auto md:grid">
            {items.map((n) => {
              const active = current === n.href;
              return (
                <li key={n.href}>
                  <a
                    href={n.href}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-lg px-3 py-2 text-sm whitespace-nowrap ${active ? 'bg-[var(--color-mint-100)] font-semibold text-[var(--color-forest-900)]' : 'text-[var(--color-forest-800)] hover:bg-[var(--color-mint-50)]'}`}
                  >
                    {n.label}
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex gap-1 border-t border-[var(--color-line)] px-1 pt-3 md:grid">
            <a href="/" className="btn btn-quiet btn-sm justify-start">
              View store
            </a>
            <ActionButton action="/logout" label="Sign out" className="btn btn-quiet btn-sm" />
          </div>
        </nav>
      </aside>
      <div className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl">{title}</h1>
          {actions}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Kpis({ items }: { items: Array<{ label: string; value: string; note?: string; href?: string }> }) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-[var(--color-line)] overflow-hidden rounded-2xl border border-[var(--color-line)] bg-white md:grid-cols-4 md:divide-y-0">
      {items.map((k) => (
        <div key={k.label} className="p-4">
          <dt className="text-xs font-semibold text-[var(--color-muted)]">{k.label}</dt>
          <dd className="tabular mt-1 text-2xl font-semibold text-[var(--color-forest-900)]">
            {k.href ? (
              <a href={k.href} className="hover:underline">
                {k.value}
              </a>
            ) : (
              k.value
            )}
          </dd>
          {k.note ? <dd className="text-xs text-[var(--color-muted)]">{k.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--color-line)] bg-white p-4 md:p-5" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * Single-series daily revenue bars. One hue (forest), 4px rounded data ends,
 * 2px gaps, recessive grid, native SVG <title> tooltips per bar, and a data
 * table alternative for screen readers.
 */
export function RevenueBars({ data }: { data: Array<{ day: string; revenue_paise: number; orders: number }> }) {
  if (!data.some((d) => d.revenue_paise > 0)) {
    return <p className="py-10 text-center text-sm text-[var(--color-muted)]">No paid or cash-on-delivery orders in this period yet.</p>;
  }
  const W = 720;
  const H = 200;
  const pad = { l: 56, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.revenue_paise));
  const nice = Math.pow(10, Math.floor(Math.log10(max))) * Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max))));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bw = data.length ? iw / data.length : iw;
  const y = (v: number) => pad.t + ih - (v / nice) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * nice);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Revenue per day for the selected period. Data table follows.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e7ece9" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="#55635c">
              {formatINR(t).replace('.00', '')}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const h = Math.max(0, (d.revenue_paise / nice) * ih);
          const x = pad.l + i * bw + 1;
          const w = Math.max(1, bw - 2);
          const r = Math.min(4, w / 2, h);
          const yt = pad.t + ih - h;
          const path = h > 0 ? `M${x},${pad.t + ih} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + w - r} Q${x + w},${yt} ${x + w},${yt + r} V${pad.t + ih} Z` : '';
          return (
            <g key={d.day}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={ih} fill="transparent">
                <title>{`${d.day}: ${formatINR(d.revenue_paise)} from ${d.orders} order${d.orders === 1 ? '' : 's'}`}</title>
              </rect>
              {path ? <path d={path} fill="#2c5f4a" pointerEvents="none" /> : null}
              {i % Math.ceil(data.length / 8) === 0 ? (
                <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="#55635c">
                  {d.day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} stroke="#c9d3ce" />
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-[var(--color-muted)]">Show data table</summary>
        <table className="table mt-2">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col" className="text-right">
                Orders
              </th>
              <th scope="col" className="text-right">
                Revenue
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td className="tabular">{d.day}</td>
                <td className="tabular text-right">{d.orders}</td>
                <td className="tabular text-right">{formatINR(d.revenue_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
export const fmtDay = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
