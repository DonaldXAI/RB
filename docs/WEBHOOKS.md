# Inbound webhooks (future)

When adding Helius, payment, or partner webhooks:

1. **Verify signature** — HMAC-SHA256 of raw body with a Render-only secret (`WEBHOOK_SECRET_*`).
2. **Reject** if timestamp skew > 5 minutes (if provider sends one).
3. **Idempotency** — store `event_id` in a table; return 200 on duplicate delivery.
4. **Never** trust client JSON for amounts; reconcile on-chain or against DB.

Do not mount webhooks without these checks.