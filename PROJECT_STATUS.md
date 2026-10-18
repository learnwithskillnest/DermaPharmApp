# Project status — GlowDerma Store

_Last updated: 18 October 2026 (end of autonomous build session 2)._

## Summary

A working, tested e-commerce application: storefront, accounts, cart, server-priced checkout with a sandbox payment gateway, order lifecycle (fulfilment, cancellation, returns, refunds), a role-based admin dashboard, and a gated prescription workflow. It runs locally with documented commands on persistent PostgreSQL data. **It is not ready for public launch**: legal approvals, real product data, production credentials and the items in "Required before launch" are outstanding.

## Test results (exact, from `npm run validate` on 18 Oct 2026)

| Check | Command | Result |
| --- | --- | --- |
| TypeScript (strict, incl. tests) | `npm run typecheck` | **Pass** — 0 errors |
| Unit tests | `npm test` (tests/unit) | **27 / 27 pass** |
| Integration tests (real PostgreSQL 16) | `npm test` (tests/integration) | **49 / 49 pass** |
| Production build | `npm run build` | **Pass** |
| Browser tests (Playwright, Chromium; desktop 1366px + Pixel 7) | `npm run test:e2e` | **22 / 22 pass** |
| Automated accessibility checks (17 pages, incl. checkout & admin) | part of e2e | **Pass** (custom checks; axe-core not installable offline) |
| Security/config check | `npm run security:check` | **Pass** — 0 failures, 2 warnings (dev mode; `npm audit` needs registry access) |
| Formatting | `npx prettier --check .` | **Pass** |
| Not run | Docker image build (no Docker daemon); `npm audit` (no registry); Razorpay sandbox (no network/credentials) | — |

Total automated tests: **98**, all passing. Also run during the session: a link crawler that signed in as guest, customer, staff, pharmacist and admin and visited ~600 pages with 0 errors after fixes.

### Required scenarios → where they are tested

| # | Scenario | Tests |
| --- | --- | --- |
| 1 | Browse products and search | catalogue.test.ts; e2e "browse, search and filter" |
| 2 | Filter by category and price | catalogue.test.ts "filter by category, brand and price"; e2e |
| 3 | Add, update, remove cart items | cart.test.ts; e2e "add, update and remove cart items" |
| 4 | Reject invalid quantities / insufficient stock | cart.test.ts (0, −2, 21, 1.5, "abc", null; stock 4 → 5 refused; out-of-stock); core.test.ts |
| 5 | Calculate totals correctly | pricing.test.ts (incl. 300-cart property check); cart.test.ts server totals, GST, coupons |
| 6 | Sandbox/demo checkout | orders.test.ts "complete sandbox checkout"; e2e checkout + failed-then-retry |
| 7 | Reject unverified payment confirmations | orders.test.ts forged signature, uncaptured payment, missing params, other user's order, bad webhook signature; duplicate webhooks/callbacks idempotent; amount mismatch flagged |
| 8 | Customers cannot access admin routes | authz.test.ts — all 43 admin routes × guest/customer/staff/pharmacist; e2e |
| 9 | Restrict prescription-only checkout | rx.test.ts (server flag + settings + licence gating; upload validation; pharmacist-only review; Rx order held until approved; no COD); cart.test.ts; e2e |
| 10 | Mobile layouts and form errors | e2e mobile.spec.ts (no horizontal scroll on 9 pages, menu, error summary focus, add to cart) |

### Defects found and fixed by testing this session

1. **Product create/edit/publish always failed (HTTP 500)** — a SQL parameter was used both as an enum column and in a text comparison (`inconsistent types deduced`). Fixed with explicit casts in 3 statements.
2. **Valid mobile numbers starting with 91 were rejected** — the phone normaliser stripped "91" as a country code even from 10-digit numbers. Fixed; tests added.
3. **Double-submitted checkout could send the customer to an empty cart** — the second request waited on stock row locks and then found the cart already emptied. Fixed with a transaction-scoped advisory lock on the idempotency key (passes 5/5 repeated runs).
4. **Tailwind arbitrary-value classes were missing from the CSS** (muted text colour, dark sections) — the class scanner split on parentheses. Fixed.
5. **Duplicate form IDs and a skipped heading level on listing pages** (accessibility). Fixed.
6. Staff saw a dashboard link to a page they cannot open; database pool `close()` was not idempotent; account deletion did not re-confirm the password; empty dashboard chart showed meaningless axis labels. All fixed.

## Completed features

**Storefront**: home (hero, search, ingredient index, departments, offers, featured, new arrivals, routine guide), catalogue with pagination/sort/category/brand/price/in-stock filters, department pages (skincare, cosmetology, body & hair), pharmacy page, category pages, product pages (gallery, pack sizes, price vs MRP, stock, ingredients, usage, warnings, storage, manufacturer, batch-based expiry note, related, recently viewed, JSON-LD), search with suggestions and helpful empty state, cart (quantities, stock issues, coupons, free-delivery progress), checkout (addresses, online/COD, review, terms), sandbox payment, confirmation, order tracking (by number + email), contact form, FAQ, shipping/returns/privacy/terms/product-safety/seller-information pages, responsive header with mobile menu, accessible footer, 404/403/500 pages.

**Accounts**: register, sign in/out, lockout, password reset (email via dev mail sink), profile, password change, account deletion, addresses (add/edit/default/delete), order history and detail with timeline and shipments, cancellation (immediate before packing, request after), return requests, refund status, wishlist, recently viewed, prescription uploads.

**Admin** (role-based: admin, staff, pharmacist): overview (sales KPIs, revenue chart, attention items, low stock, expiring batches, Rx status), orders (filters, status transitions, shipments, Rx approval), products (create/edit/publish/archive, variants, classifications, SEO), categories & brands, stock adjustments with movement log, batches & expiry, returns & refunds (restock, gateway refund), prescription queue/review (pharmacist only), customers (audited views, disable), coupons, reports with date filter and CSV export, customer messages, staff roles, audit log, store settings (store, shipping/COD, pharmacy & compliance).

**Platform**: PostgreSQL schema (30 tables) with checksummed migrations, idempotent seed, background jobs, structured logging, security headers/CSP, CSRF, rate limiting, sitemap, robots, canonical URLs, analytics hooks (off), Dockerfile + compose, docs.

## Incomplete / not built

- **Real payments untested**: Razorpay adapter written to the documented API but never run against Razorpay (no network/credentials).
- **GST tax invoices** (numbered invoice PDFs, CGST/SGST/IGST split) are not generated.
- **Batch allocation per sold unit** (which batch shipped in which order) is not recorded; batches and expiry are tracked per variant.
- No product image upload in admin (images are referenced by path/URL); no bulk CSV product import.
- No 2FA for staff; rate limiter is single-instance.
- No courier integration (tracking numbers are entered manually); no SMS/WhatsApp notifications; email only via a generic webhook driver.
- No Schedule H/H1/X field (classification is cosmetic / personal care / OTC pharmacy / prescription).
- Policy pages are drafts awaiting legal review.

## Known issues / technical debt

- Stack deviates from the preferred Next.js + Prisma because the npm registry was blocked in the build environment; an in-repo Postgres wire client and a React type shim are used. Replacement steps are in DEPLOYMENT.md §1.
- Fonts load from Google Fonts (blocked in the build sandbox, so tests ran with system fallback fonts).
- Docker image not built or run here.
- `package-lock.json` not yet generated.

## Credentials and approvals still required

- Razorpay account (KYC, business category approval for pharmacy if applicable), test then live API keys and webhook secret.
- Production PostgreSQL, hosting, domain + TLS, email provider — none purchased or created.
- Drug sale licence(s), registered pharmacist details, legal confirmation that online medicine sale is permitted for this business (see LAUNCH_COMPLIANCE.md).
- GSTIN, legal entity name, registered address, grievance officer, CIN; reviewed policies.
- Real product data: labels, ingredient lists, manufacturer details, licensed photography, verified classifications, confirmed HSN/GST rates.

## Next session — suggested order

1. On a networked machine: `npm install`, commit the lockfile, swap in `pg` and `@types/react`, re-run `npm run validate`.
2. Razorpay test-mode integration on a private staging deployment.
3. GST invoices and batch allocation at dispatch.
4. Admin image upload and CSV import; replace sample catalogue.
