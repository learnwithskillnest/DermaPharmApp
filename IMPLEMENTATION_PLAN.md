# GlowDerma Store — Implementation Plan

Living document. Status markers: `[x]` done · `[~]` partial · `[ ]` not started.
See PROJECT_STATUS.md for test results and known issues.

## Phase A — Inspection findings (2026-10-18)

- Repository: empty; new project.
- Runtime: Node 22.22, local PostgreSQL 16 server binaries, Playwright 1.56 + Chromium.
- **Blocker: the build sandbox's network policy denies the npm registry (HTTP 403 at the egress proxy).**
  Next.js, Prisma, `pg`, `@types/react`, axe-core, typescript-eslint and nodemailer could not be installed.
- Offline packages available and used: React 19.2, react-dom 19.2, Zod 3.25, Tailwind CSS 4.3 (core
  compiler), esbuild 0.28, TypeScript 6.0, tsx 4.23, Playwright 1.56, Prettier 3.8.

### Decision: adapt the stack instead of stopping

| Preferred            | Used here                                                     | Swap path                                                    |
| -------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Next.js              | React 19 SSR on `node:http` + small router; hydrated islands   | Pages/components are plain React; routes map 1:1 to App Router |
| Prisma ORM           | Versioned SQL migrations + typed query functions               | `prisma db pull` on the migrated DB generates a schema        |
| `pg` driver          | In-repo wire-protocol client (SCRAM, TLS, bound params)        | Replace `src/server/db/pg-wire.ts` behind the `Queryable` API |
| Auth library         | DB-backed sessions + Node `crypto.scrypt` (built-in, maintained) | Auth.js/Lucia-style adapters if moving to Next.js            |
| Tailwind CLI         | Tailwind v4 `compile()` API driven by our build script         | `@tailwindcss/cli` once installable                           |
| zod                  | zod (installed)                                                | —                                                            |
| axe-core             | Custom Playwright accessibility checks                         | `@axe-core/playwright` once installable                      |

### Assumptions

- Prices are GST-inclusive (Indian MRP convention). GST rates/HSN codes are configurable per product and
  are **placeholders pending review by a chartered accountant**.
- Customers must sign in to check out (needed for order history, prescription linkage, and data rights).
- Stock is reserved when an order is placed and released if payment fails or the reservation expires
  (30 min default), preventing overselling between "place order" and "payment captured".
- Prescription-only ordering is **off** unless BOTH `ENABLE_PRESCRIPTION_ORDERING=true` and the admin
  setting are on, and licence/pharmacist fields are filled. Off is the shipped default.
- All products, brands and images are invented sample data, labelled as such.

### Risks

- Hand-written DB driver: covered by tests, but the `pg` swap is recommended before launch.
- In-memory rate limiter: correct for a single instance; use Redis/DB-backed limits when scaling out.
- Razorpay adapter written to Razorpay's documented API but **not sandbox-tested** (no network/credentials).
- Regulatory: Indian online pharmacy rules are unsettled (draft e-pharmacy rules); legal review is required.

## Milestones

1. [x] Project scaffold, offline dependency linking, Postgres cluster
2. [x] DB driver, pool, transactions, migration runner, schema
3. [x] Server core: router, body parsing, cookies, sessions, CSRF, rate limit, security headers, logging
4. [x] Domain services: catalogue, pricing/GST, cart, coupons, inventory, orders, payments, Rx, returns, settings, audit
5. [x] Seed data + original SVG placeholder product art (session 2)
6. [x] Storefront UI (design system, home, catalogue, PDP, categories, pharmacy, search, cart, checkout, orders, account, policies)
7. [x] Admin dashboard — catalogue/orders/Rx/returns (session 1); overview, reports + CSV, customers, coupons, messages, staff, audit, settings routes (session 2)
8. [x] SEO: metadata, canonical, sitemap, robots, JSON-LD
9. [x] Tests: 27 unit, 49 integration, 22 Playwright e2e incl. accessibility — all passing (session 2)
10. [x] Build pipeline (esbuild + Tailwind compile API), server entry + jobs, Docker/compose, docs, status report (session 2)

## Session log

- **Session 1 (17 Oct 2026)**: inspection, stack decision, schema, server core, services, storefront and most admin UI.
- **Session 2 (18 Oct 2026)**: registry still blocked (403 at egress gateway, re-checked). Added the missing route index and
  admin routes, server entry/background jobs, build pipeline, seed + artwork, scripts, full test suites, Docker, docs.
  Testing found and fixed 6 defects (see PROJECT_STATUS.md). `npm run validate` passes end to end.

## Next milestones (not started)

11. [ ] Swap in `pg`, `@types/react`, lockfile, `npm audit` (needs a networked machine)
12. [ ] Razorpay test-mode verification on private staging
13. [ ] GST invoice generation; batch allocation at dispatch
14. [ ] Admin image upload, CSV product import, 2FA for staff
15. [ ] Legal/regulatory sign-off per LAUNCH_COMPLIANCE.md, then real catalogue
