# RaidHive backend security checklist (Render worker)

## Deploy env

- Set `NODE_ENV=production` on Render (enforces https `FRONTEND_ORIGIN` / `CORS_EXTRA_ORIGINS`).
- Never add env vars whose names match `*PRIVATE*KEY*`, `*MNEMONIC*`, etc. (startup aborts).
- Rotate `SUPABASE_SERVICE_ROLE_KEY`, `HELIUS_API_KEY` if leaked.

## Supabase

- Run `sql/security_rls_hardening.sql` after base schema.
- Run `sql/security_advisor_fixes.sql` (Security Advisor: RPC execute + search_path).
- Run `sql/security_rls_explicit_deny.sql` (clears "RLS enabled no policy" on worker-only tables).
- Run `sql/campaign_templates_worker_only.sql` if templates had old client RLS policies.
- Run `sql/admin_nonces_message.sql` if not applied.
- **Auth:** enable [Leaked password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) in Dashboard → Authentication.

Templates, drafts, and saved raids are **Render API only** (no direct Supabase from the browser).

## Verify

- `GET /api` → `cors.allowedOrigins` matches Render env.
- Deposit: single-tx and split-tx both require exact USDC amounts.
- Admin: SIWS only; 3-minute signature TTL; 60 req / 15 min per wallet.

## Lovable

See paste block in chat / project docs — no `VITE_*` service secrets; money via Render API.