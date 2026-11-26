# RaidHive backend security checklist (Render worker)

## Deploy env

- Set `NODE_ENV=production` on Render (enforces https `FRONTEND_ORIGIN` / `CORS_EXTRA_ORIGINS`).
- Never add env vars whose names match `*PRIVATE*KEY*`, `*MNEMONIC*`, etc. (startup aborts).
- Rotate `SUPABASE_SERVICE_ROLE_KEY`, `HELIUS_API_KEY` if leaked.

## Supabase

- Run `sql/security_rls_hardening.sql` after base schema.
- Run `sql/admin_nonces_message.sql` if not applied.

## Verify

- `GET /api` → `cors.allowedOrigins` matches Render env.
- Deposit: single-tx and split-tx both require exact USDC amounts.
- Admin: SIWS only; 3-minute signature TTL; 60 req / 15 min per wallet.

## Lovable

See paste block in chat / project docs — no `VITE_*` service secrets; money via Render API.