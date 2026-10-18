# Deployment

**Nothing has been deployed.** No domain, hosting, production database or live payment account has been created or paid for. This guide is for when you are ready.

## 1. Recommended changes before the first deploy

These close gaps caused by the offline build environment. Do them on a machine with internet access.

1. `npm install` and **commit `package-lock.json`** (the Dockerfile switches to `npm ci` automatically).
2. Replace the in-repo PostgreSQL client with the maintained `pg` driver: `npm i pg`, then implement `createDatabase()` in `src/server/db/db.ts` on top of `pg.Pool` keeping the same `query/one/many/tx/withConnection/close` interface. Run `npm test` — the integration suite exercises every query path.
3. `npm i -D @types/react@19 @types/react-dom@19` and delete `types/react-shim.d.ts`; fix any stricter JSX typing errors.
4. Optional: `npm i -D @axe-core/playwright` and add axe scans next to `tests/e2e/a11y.ts`.
5. Self-host the Hanken Grotesk font (download the WOFF2 files into `public/fonts/`, add `@font-face` in `src/styles/app.css`, remove the Google Fonts `<link>` and CSP entries in `src/ui/layout.tsx` / `src/server/app.ts`). Avoids sending visitor IPs to a third party and improves load time.
6. Run `npm run validate` and `npm audit`.

## 2. Hosting requirements

- Node.js 22.12+ process (container or VM), behind HTTPS. Any host that runs a Docker image works (e.g. AWS ECS/App Runner, Google Cloud Run, Azure Container Apps, Render, Railway, Fly.io). Choose an **India region** if you want data stored in India.
- Managed PostgreSQL 14+ with automated backups and TLS (`?sslmode=verify-full`).
- A persistent, **encrypted** volume (or object storage via a small adapter) for `PRESCRIPTION_STORAGE_DIR`. Not needed while prescription ordering is off.
- An email provider with an HTTP API or a relay that accepts `POST {from,to,subject,text}` with a bearer token (`MAIL_DRIVER=webhook`).
- **Single instance** by default: the rate limiter is in memory. For multiple instances, move the counters to Redis/Postgres first (`src/server/http/rate-limit.ts`). Background jobs are safe on several instances.

## 3. Environment (production)

Set via your host's secret manager — never a committed file.

| Variable | Production value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | `https://your-domain` (https is enforced) |
| `HOST` / `PORT` | `0.0.0.0` / host-provided port |
| `TRUST_PROXY` | `true` only behind your load balancer (so client IPs and rate limits are correct) |
| `DATABASE_URL` | managed Postgres URL with `?sslmode=verify-full` |
| `SESSION_SECRET` | 64 random hex characters; rotating it signs everyone out |
| `PAYMENT_PROVIDER` | `razorpay` (sandbox is refused in production) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | from Razorpay dashboard |
| `MAIL_DRIVER` / `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_TOKEN` / `MAIL_FROM` | your mail provider (required in production) |
| `PRESCRIPTION_STORAGE_DIR` | encrypted volume path |
| `ENABLE_PRESCRIPTION_ORDERING` | `false` until LAUNCH_COMPLIANCE.md §A is signed off |
| `ANALYTICS_PROVIDER` / `ANALYTICS_ID` | empty unless covered by your privacy notice |

The app validates configuration at start-up and exits with a clear message if anything is unsafe or missing.

## 4. Release steps

```bash
docker build -t glowderma-store .
# release step (once per deploy, before starting the new version):
docker run --rm --env-file prod.env glowderma-store node dist/migrate.mjs
# first deploy only — catalogue structure without demo accounts (or create your own catalogue in /admin):
docker run --rm --env-file prod.env glowderma-store node dist/seed.mjs --no-users
docker run --rm -it --env-file prod.env glowderma-store node dist/create-admin.mjs --email you@yourco.in --name "Owner"
docker run -d --env-file prod.env -p 3000:3000 -v rx:/data/prescriptions glowderma-store
```

Health check: `GET /healthz` → `{"ok":true}` (checks the database).

**Before going live, delete or replace every sample product** (all are flagged `is_sample`; Admin → Products shows "(sample)"). Brands, images, prices and descriptions are placeholders.

## 5. Razorpay

1. Complete Razorpay KYC for the business; confirm your business category permits the products you sell (pharmacy products may need additional approval).
2. In **Test mode**, create API keys → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
3. Create a webhook: URL `https://your-domain/webhooks/payments`, events `payment.captured` and `payment.failed`, a strong secret → `RAZORPAY_WEBHOOK_SECRET`.
4. Deploy to a **private staging** URL with test keys and run the full journey: success, failure, retry, closing the popup, duplicate webhook delivery (Razorpay dashboard → webhook → resend). Check `payment_events` and the order timeline.
5. Only after sign-off, switch to Live keys and a new Live webhook secret.

Implementation notes: orders are created with the Razorpay Orders API; Checkout.js is loaded only on the payment page (the CSP allows `checkout.razorpay.com` only when `PAYMENT_PROVIDER=razorpay`); the client callback signature is `HMAC_SHA256(order_id|payment_id, key_secret)`, then the payment is fetched server-side and its status and amount must match. Refunds marked "via gateway" in Admin → Returns call the Razorpay refund API. **This adapter has not been exercised against Razorpay's sandbox** (no network or credentials in the build environment) — step 4 is mandatory.

## 6. Operations

- **Backups**: daily automated Postgres backups with point-in-time recovery; test a restore before launch.
- **Logs**: JSON lines on stdout/stderr (secrets and tokens redacted). Ship to your host's log service; alert on `level=error`, `payment_amount_mismatch`, `webhook_rejected`, `csrf_rejected` spikes.
- **Jobs** (in-process): expire unpaid reservations (every minute); purge expired sessions, prescriptions past retention, 90-day-old view history, 30-day-old guest carts (hourly).
- **Monitoring**: uptime check on `/healthz`; watch the Admin overview for low stock, expiring batches and orders "Needs attention".
- **Schema changes**: add a new numbered file in `migrations/` — never edit an applied one (checksums are enforced).
