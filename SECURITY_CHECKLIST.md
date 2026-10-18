# Security checklist

✅ = implemented and covered by automated tests · ☐ = action required before launch

## Implemented

**Authentication & sessions**
- ✅ Passwords hashed with scrypt (Node `crypto`, N=2^15, per-user salt); transparent rehash on parameter change
- ✅ Password rules: 10+ chars, mixed classes, not common, not the email name
- ✅ Generic sign-in errors (no account enumeration); account lock after 5 failures for 15 min
- ✅ Server-side sessions; cookie holds a random token, DB stores only its SHA-256; `HttpOnly`, `SameSite=Lax`, `Secure` on https
- ✅ New session on sign-in (fixation-safe); other sessions revoked on password change/reset, role change and account disable
- ✅ Password reset: single-use, 1-hour, hashed tokens; same response for unknown emails
- ✅ Account deletion requires password re-entry

**Request security**
- ✅ CSRF: per-session HMAC token on every state-changing request + Origin/Referer check; webhooks exempt (signature-verified instead)
- ✅ Rate limits: login (per IP and per account), registration, password reset, contact, checkout, payment, uploads, cart, admin writes
- ✅ Strict CSP with per-request nonces (no inline scripts), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP, HSTS on https
- ✅ All input validated server-side with Zod; all SQL uses bound parameters
- ✅ Output encoded by React; JSON-LD escaped; `dangerouslySetInnerHTML` limited to 3 audited places (checked by `npm run security:check`)
- ✅ Open-redirect protection on all `next=` parameters; same-origin redirects only
- ✅ Errors return friendly messages + request id; stack traces only in server logs
- ✅ Request body size limits; multipart parsing only on the upload route

**Authorization**
- ✅ Role → permission matrix (`src/server/auth/permissions.ts`); every admin route declares a permission and the router enforces it before the handler (test asserts every route has one, and that customers get 403 on all of them)
- ✅ Customer data scoped by user id on every query (orders, addresses, prescriptions, payment callbacks)
- ✅ Prescription documents: pharmacists only (not admins); each view audit-logged; `no-store`, sandboxed CSP

**Payments & orders**
- ✅ No card data handled; hosted gateway
- ✅ Order paid only after signature verification **and** server-side status + amount check; amount mismatch → "needs attention"
- ✅ Webhooks: HMAC over raw body, de-duplicated by event id; capture is idempotent under concurrency (tested)
- ✅ Prices, discounts, shipping and tax computed on the server; client-sent prices ignored (tested)
- ✅ Stock can never go negative (DB `CHECK` + conditional update + row locks; concurrency tested); every change in `stock_movements`
- ✅ Idempotent checkout (advisory lock + unique key; double-submit tested)

**Uploads**
- ✅ Type detected from file content (PDF/JPEG/PNG magic bytes), size limit, random file names, stored outside the web root with 0600 permissions, never served statically

**Data minimisation & audit**
- ✅ Audit log for admin changes, role changes, settings (before/after), customer record views, report exports, prescription actions
- ✅ CSV exports exclude names, emails, phones and street addresses (spreadsheet formula injection neutralised)
- ✅ Retention jobs: sessions, prescriptions past retention, view history (90 d), guest carts (30 d), reset tokens
- ✅ Logs redact passwords, tokens, secrets, cookies, signatures
- ✅ Production start-up refuses: http `APP_URL`, sandbox payments, non-production mail, short secrets
- ✅ Non-production `robots.txt` blocks all crawling; admin/account pages are `noindex`
- ✅ Bots receive no session (no DB writes for crawlers)

## Before launch

- ☐ Replace the in-repo Postgres client with `pg` (DEPLOYMENT.md §1) and re-run the full test suite
- ☐ Commit `package-lock.json`; run `npm audit` and fix high/critical issues; enable Dependabot/Renovate
- ☐ Generate fresh production secrets in a secret manager; never reuse development values
- ☐ `DATABASE_URL` with `sslmode=verify-full`; least-privilege DB user (no superuser); automated backups + tested restore
- ☐ Encrypted storage for prescription files; restrict shell/SSH access to the server
- ☐ Real mail provider (`MAIL_DRIVER=webhook`) with SPF/DKIM/DMARC on the sending domain
- ☐ Razorpay staging test (DEPLOYMENT.md §5) including webhook replay
- ☐ If running more than one instance: shared rate-limit store
- ☐ Create the first admin with `npm run admin:create`; enforce strong unique passwords for staff. Consider adding 2FA for admin/pharmacist accounts (not implemented)
- ☐ External penetration test / security review
- ☐ Log shipping and alerting; incident-response contact (CERT-In 6-hour reporting)
- ☐ Remove all sample products and demo data; confirm no `@glowderma.test` accounts exist in production
- ☐ Self-host fonts (removes the Google Fonts third-party request)
- ☐ Review LAUNCH_COMPLIANCE.md §D with a data-protection adviser

## Known limitations

- Rate limiter is in-process (resets on restart; per instance).
- `sslmode=require` does not verify the server certificate (matches libpq semantics) — use `verify-full`.
- No 2FA, no admin IP allow-listing, no virus scanning of uploads (files are content-checked and never executed or served inline as HTML).
