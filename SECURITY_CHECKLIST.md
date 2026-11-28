# RaidHive backend security checklist (Render worker)

## Deploy env

- Set `NODE_ENV=production` on Render (enforces https `FRONTEND_ORIGIN` / `CORS_EXTRA_ORIGINS`).
- Set **`ADMIN_TELEGRAM_CHAT_ID`** on production (escrow underfunding alerts; logs always).
- Production `GET /api` returns route **count only** (full manifest is dev-only; do not rely on `PUBLIC_ROUTE_MANIFEST` in prod).
- Never add env vars whose names match `*PRIVATE*KEY*`, `*MNEMONIC*`, etc. (startup aborts).
- Rotate `SUPABASE_SERVICE_ROLE_KEY`, `HELIUS_API_KEY` if leaked.

## Staging vs production

- **Separate Render service** (or branch) for staging; never point Lovable preview at prod if testing destructive flows.
- Staging should use **separate** Supabase project or isolated data; never paste **prod** `SUPABASE_SERVICE_ROLE_KEY` into preview builds.
- Use different escrow/revenue wallets on staging, or clearly labeled test wallets.
- Lovable preview env: `VITE_API_URL` → staging Render URL only.

## Dependencies

- Monthly: `npm run audit:deps` (high severity). Review Solana advisories before major downgrades.
- Pin Node **22 LTS** on Render (`engines.node >= 22`).

## Supabase

- Run `sql/security_rls_hardening.sql` after base schema.
- Run `sql/security_advisor_fixes.sql`, `sql/security_rls_explicit_deny.sql`, `sql/campaign_templates_worker_only.sql`, `sql/admin_nonces_message.sql` as needed.

Templates, drafts, and saved raids are **Render API only**.

## Operations

- **IP:** `profiles.last_ip` updates on every authenticated API call (audit signal only, not auth).
- **Admin audit:** `admin_audit_logs` includes list + mutate actions and `admin.auth.failed` (IP in `details`).
- **Solvency:** cron every 5m; logs underfunding; Telegram at most once/hour when `ADMIN_TELEGRAM_CHAT_ID` set.
- **Webhooks:** see `docs/WEBHOOKS.md` before adding any.

## Verify

- `GET /api` → `cors.allowedOrigins`; production `routes` is `{ count: N }` only.
- Deposit: exact USDC on single-tx and split-tx.
- Admin: SIWS only; 3-minute TTL; audit required on money-moving POSTs.

## Lovable

- No `VITE_*` service secrets; money via Render only.
- Staging API URL for preview; production URL for live domain only.