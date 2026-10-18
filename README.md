# GlowDerma Store

Online skincare, cosmetology and **regulated pharmacy** store for India: storefront, customer accounts, cart and checkout with server-verified payments, a role-based admin dashboard, and a prescription-review workflow that stays **switched off** until the business is licensed.

> **Everything in the catalogue is sample data.** Brands are fictional, product images are original placeholder illustrations labelled "Sample image", prices and stock are invented, and every regulatory classification is stored as *unverified*. Payments run through a built-in **sandbox** gateway — no money moves.

| | |
| --- | --- |
| Status | Working application, tested — see [PROJECT_STATUS.md](PROJECT_STATUS.md) |
| Before launch | [LAUNCH_COMPLIANCE.md](LAUNCH_COMPLIANCE.md) (legal/regulatory) · [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) · [DEPLOYMENT.md](DEPLOYMENT.md) |
| Build history | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |

## Quick start (local)

Requirements: **Node.js 22.12+** and **PostgreSQL 14+** (16 recommended).

```bash
# 1. Install dependencies
npm install

# 2. Create two local databases (dev + disposable test)
createuser -P glowderma            # choose a password
createdb -O glowderma glowderma_dev
createdb -O glowderma glowderma_test

# 3. Configure
cp .env.example .env
#   edit DATABASE_URL / TEST_DATABASE_URL (your password), and set
#   SESSION_SECRET and SANDBOX_PAYMENT_SECRET to random values:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Create tables and load sample data
npm run db:migrate
npm run db:seed

# 5. Run
npm run dev          # http://localhost:3000 (restarts on change)
# or the production build:
npm run build && npm start
```

On Windows, use PowerShell or Git Bash; `createdb`/`createuser` come with the PostgreSQL installer (or use pgAdmin). Docker users can instead run `docker compose up -d db` (see `docker-compose.yml`).

### Demo accounts (development only)

`npm run db:seed` creates these accounts with the password `GlowDemo#2026` (override with `SEED_DEMO_PASSWORD`). They are **never** created when `NODE_ENV=production`.

| Role | Email | Can do |
| --- | --- | --- |
| Admin | admin@glowderma.test | Everything except opening prescription documents |
| Staff | staff@glowderma.test | Orders, products, stock, returns, messages |
| Pharmacist | pharmacist@glowderma.test | Prescription queue and review, Rx order approval |
| Customer | customer@glowderma.test | Shopping, orders, addresses (one saved address in Pune) |

Sample coupons: `WELCOME10` (10% off ₹499+, excl. pharmacy), `GLOW100` (₹100 off ₹999+).

### Try the full journey

1. Browse `/shop`, search "niacinamide", filter by category and price.
2. Add a product, sign in as the customer, check out with **Pay online**.
3. On the **sandbox gateway** choose *Simulate successful payment* (or *failed* to test retry).
4. Sign in as staff → `/admin/orders` → move the order to *Packing*, add a shipment, mark delivered.
5. As the customer, request a return; as staff, approve → received → refunded.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Build CSS/JS and run the server with auto-restart |
| `npm run build` | Production build into `dist/` (server bundle, scripts, hashed assets) |
| `npm start` | Run the production build (`node dist/server.mjs`) |
| `npm run db:migrate` | Apply pending SQL migrations (checksummed, transactional) |
| `npm run db:seed` | Upsert sample catalogue, coupons and (dev only) demo accounts — safe to re-run |
| `npm run db:reset -- --yes` | **Destructive**: wipe and re-seed the *local* dev database (refuses non-local hosts) |
| `npm run admin:create -- --email you@example.com --name "Name"` | Create/promote an administrator (prompts for password) |
| `npm run typecheck` | TypeScript, strict mode (includes tests) |
| `npm test` | Unit + integration tests (uses `TEST_DATABASE_URL`, which is wiped) |
| `npm run test:e2e` | Playwright browser tests against the production build (run `npm run build` first) |
| `npm run security:check` | Secret scan, config checks, `npm audit` when online |
| `npm run validate` | typecheck → tests → build → e2e → security check |
| `npm run format` | Prettier |

First run of `npm run test:e2e` on a new machine: `npx playwright install chromium`.

## Architecture

```
src/
  server/
    index.ts            HTTP server, graceful shutdown, background jobs
    app.ts              request pipeline: static files → route → session → rate limit → body → CSRF → auth/permission → handler
    config.ts           validated environment (refuses unsafe production settings)
    db/                 PostgreSQL client, pool, transactions, migration runner
    auth/               scrypt passwords, DB sessions, role → permission matrix
    services/           business logic: catalog, pricing (pure), cart, orders, payments, inventory,
                        prescriptions, returns, settings, audit, mail
    routes/             storefront, auth, cart, checkout, account, SEO, admin/*
  ui/                   server-rendered React components (pages, admin, forms, layout)
  client/               hydrated "islands" (search suggestions, add to cart, gallery, Razorpay)
  styles/app.css        Tailwind v4 + design tokens
migrations/             versioned SQL schema
scripts/                build, migrate, seed (+ sample data and artwork), admin, security check
tests/                  unit, integration (real Postgres), e2e (Playwright)
```

Key design decisions:

- **Money is integer paise**; prices are GST-inclusive (Indian MRP convention). Every total is computed on the server by the pure pricing engine (`services/pricing.ts`).
- **Stock is reserved when an order is placed** (row-locked, `CHECK (stock >= 0)`), released if payment fails to arrive within the reservation window (30 min default) or the order is cancelled. Overselling is impossible even under concurrency (tested).
- **Payments are verified server-side**: HMAC signature on the browser callback *and* a server-to-server status/amount lookup; webhooks are signature-checked and de-duplicated by event id. The browser redirect alone never marks an order paid.
- **Pharmacy is a gated workflow**: prescription-only products are information-only until the server flag *and* admin settings *and* licence/pharmacist details are all present. Rx orders are held for pharmacist approval before packing.
- **Progressive enhancement**: every form works without JavaScript; islands add instant cart updates and search suggestions.

### Why not Next.js / Prisma?

The build environment had **no access to the npm registry**, so Next.js, Prisma and the `pg` driver could not be installed. Rather than stop, the app was built on the packages that were available (React 19 SSR, Zod, Tailwind v4, esbuild, Playwright) with:

- a small router and server-rendered React pages (route-for-route portable to the Next.js App Router),
- versioned SQL migrations (run `npx prisma db pull` against the migrated database to generate a Prisma schema),
- an in-repo PostgreSQL wire-protocol client behind a 3-method interface (`Queryable` in `src/server/db/db.ts`) — **replace it with `pg` before launch** (see DEPLOYMENT.md §Recommended changes).

`types/react-shim.d.ts` stands in for `@types/react`; delete it after `npm i -D @types/react@19 @types/react-dom@19`.

## Payments

`PAYMENT_PROVIDER=sandbox` (default) uses the built-in test gateway at `/sandbox-gateway/:id`. It follows the same contract as a real provider (signed callback, signed webhook, server-side status lookup), so switching to Razorpay changes configuration, not code. Production is refused with the sandbox unless explicitly overridden for a private staging site. Razorpay setup: [DEPLOYMENT.md](DEPLOYMENT.md#razorpay).

## Data and privacy

- Prescription files are stored outside the web root with random names, served only to their owner and to pharmacists (every staff view is audit-logged), and deleted after the configured retention period.
- Customers can delete their account (password re-confirmation); order records are pseudonymised.
- CSV exports contain no names, emails, phone numbers or street addresses.
- Analytics hooks are off unless configured.
