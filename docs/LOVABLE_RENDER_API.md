# RaidHive Render API — Lovable integration reference

**Base URL:** `https://rb-d5yp.onrender.com`  
**Env:** `VITE_API_URL=https://rb-d5yp.onrender.com` (no trailing slash)

## Authentication

| Audience | Headers |
|----------|---------|
| User routes | `Authorization: Bearer <supabase.access_token>` |
| Admin (`/api/admin/*`) | `x-admin-wallet`, `x-admin-message`, `x-admin-signature`, `x-admin-nonce`, `x-admin-timestamp` (escrow SIWS — not Bearer) |

**Errors:** `{ "error": "human-readable message" }` with HTTP status.

**Browser:** Supabase **anon** key only for auth + safe profile updates. Do **not** read/write `campaigns`, `submissions`, `payout_requests`, templates, or drafts via Supabase client (worker-only / RLS).

---

## 0. New Lovable-critical routes (deploy Render after pull)

| Need | Route |
|------|--------|
| Browse raids | `GET /api/campaigns/browse?limit=30&includeEnded=false` (no auth) |
| Launch new raid | `POST /api/campaigns/launch` (auth) → `awaiting_deposit` + `deposit` fee breakdown |
| Raider history | `GET /api/raids/history?limit=50` |
| Receipts | `GET /api/payouts/receipts?limit=50` (payouts + founder deposit txs) |
| Signed-in verification pending | `GET /api/account/verification` → `{ status, flags, pending[] }` |
| Founder flags | `GET /api/founders/flags` → social/wallet gates + `campaignsAwaitingDeposit` |

---

## 1. Campaign & history reads

### Browse active raids (public)

`GET /api/campaigns/browse` — no Bearer required.

```json
{ "ok": true, "campaigns": [ { "campaignId", "projectName", "baseRates", "remainingBudgetUsdc", "endsAt", ... } ] }
```

### Launch campaign (founder)

`POST /api/campaigns/launch` — body accepts camelCase or snake_case: `projectName`, `totalBudgetUsdc` (min 10), `baseRates`, optional `durationHours` / `endsAt`, `draftId`.

```json
{
  "ok": true,
  "campaign": { ... },
  "status": "awaiting_deposit",
  "deposit": { "escrowUsdc", "revenueUsdc", "platformFeeUsdc", "boostFeeUsdc" }
}
```

Then `POST /api/campaigns/verify-deposit`.

### Founder — all campaigns + aggregates

`GET /api/founders/performance`  
Query (optional): `campaignId=<uuid>`

```json
{
  "ok": true,
  "campaigns": [
    {
      "campaignId": "uuid",
      "projectName": "string | null",
      "status": "awaiting_deposit | active | paused | hidden | expired | refund_queued | completed",
      "totalBudgetUsdc": 0,
      "remainingBudgetUsdc": 0,
      "spentBudgetUsdc": 0,
      "paidToRaidersUsdc": 0,
      "endsAt": "ISO8601",
      "submissionsTotal": 0,
      "submissionsVerified": 0,
      "submissionsRejected": 0,
      "conversionRate": 0
    }
  ],
  "totals": {
    "campaigns": 0,
    "submissions": 0,
    "verified": 0,
    "rejected": 0
  }
}
```

### Founder — submissions for one owned campaign

`GET /api/campaigns/:campaignId/submissions`

```json
{
  "ok": true,
  "campaignId": "uuid",
  "submissions": [
    {
      "id": "uuid",
      "raider_id": "uuid",
      "action_type": "follow | repost | reply | quote | post",
      "tweet_url": "string",
      "tweet_text": "string",
      "status": "verified | rejected",
      "earned_usdc": 0,
      "vests_at": "ISO8601 | null",
      "vested": false,
      "ai_reason": "string",
      "created_at": "ISO8601",
      "flagged_by_creator": false,
      "flag_reason": "string | null"
    }
  ]
}
```

### Founder — drafts & templates

| Method | Path | Response (success) |
|--------|------|-------------------|
| GET | `/api/campaigns/drafts` | `{ ok, drafts: [{ id, campaignId, draft, createdAt, updatedAt }] }` |
| GET | `/api/campaigns/drafts/:draftId` | `{ ok, draft: { id, campaign_id, draft, created_at, updated_at } }` |
| GET | `/api/campaigns/templates` | `{ templates: [{ id, name, draft }] }` |

### Raider — saved raids (embedded campaign fields)

`GET /api/raids/saved`

```json
{
  "ok": true,
  "saved": [
    {
      "campaignId": "uuid",
      "savedAt": "ISO8601",
      "campaign": {
        "id": "uuid",
        "status": "string",
        "project_name": "string",
        "brief": "string",
        "ticker_or_hashtag": "string",
        "target_username": "string | null",
        "target_tweet_id": "string | null",
        "min_followers": 0,
        "base_rates": {},
        "remaining_budget_usdc": 0,
        "ends_at": "ISO8601",
        "created_at": "ISO8601"
      }
    }
  ]
}
```

### Activity feed (last 30 days — payouts, submissions, founder campaigns)

`GET /api/notifications`

```json
{
  "items": [
    {
      "id": "string",
      "type": "string",
      "title": "string",
      "body": "string",
      "read": false,
      "createdAt": "ISO8601",
      "href": "string (optional)"
    }
  ]
}
```

### Public project page (no auth)

`GET /api/projects/:handle/reputation` — `handle` = slug or X username (lowercase, no `@`)

```json
{
  "ok": true,
  "handle": "string",
  "projectName": "string | null",
  "reputation": { "see section 3" },
  "campaigns": [
    {
      "campaignId": "uuid",
      "status": "string",
      "projectName": "string | null",
      "totalBudgetUsdc": 0,
      "remainingBudgetUsdc": 0,
      "endsAt": "ISO8601"
    }
  ]
}
```

Do not use `supabase.from("campaigns")` from the browser for browse/launch — use `browse` + `launch` above.

---

## 2. Wallet linking

There is **no** `POST /api/wallet/link`.

| Flow | Behavior |
|------|----------|
| **Profile payout wallet** | Authenticated user updates own `profiles.wallet_address` (Solana public base58). Unique across profiles → duplicate returns **409** `"That wallet is already linked to another profile"`. |
| **Eligibility** | `POST /api/eligibility/verify` checks wallet via checklist item `id: "wallet"`. |
| **Founder deposit** | `POST /api/campaigns/verify-deposit` may set `wallet_address = coalesce(existing, deposit_sender_wallet)`. |
| **Raider payout** | `POST /api/payouts/request` body: `{ "amountUsdc": number, "destinationWallet": "base58" }` → `{ ok, payoutRequestId, grossAmountUsdc, status: "queued" }`. Refunds require profile wallet or server returns `WALLET_REQUIRED`. |

Never store private keys in the client.

### Deposit verify (founder)

`POST /api/campaigns/verify-deposit`

```json
{
  "campaignId": "uuid",
  "deposit_tx_hash": "base58-signature",
  "revenue_tx_hash": "base58-signature (optional; must differ from deposit)"
}
```

Success:

```json
{
  "ok": true,
  "campaignId": "uuid",
  "status": "active",
  "escrowUsdc": 0,
  "platformFeeUsdc": 0,
  "boostFeeUsdc": 0,
  "remainingBudgetUsdc": 0,
  "depositTxHash": "string",
  "revenueTxHash": "string | null",
  "referralBonusUsdc": 0
}
```

---

## 3. Founder / raider proof & verification flags

### Social gates (required before payout)

| Flag | Set by |
|------|--------|
| `x_followed` | `POST /api/social/verify-x` — body `{}`. Returns `{ ok, profile: { x_username, x_followed, x_followers } }`. Requires `x_username` on profile. |
| `tg_joined` | `POST /api/social/verify-telegram` — `{ "telegramUserId": "...", "authData": { ... } optional }`. Returns `{ ok, profile: { telegram_user_id, tg_joined } }`. |

If either false, payout fails with **403** `"Verify X and Telegram before requesting a payout"` (`SOCIAL_GATES`).

### Crypto eligibility (raider)

`GET /api/eligibility/status`

```json
{
  "ok": true,
  "passed": true,
  "verificationStatus": "verified | rejected | pending | null",
  "isCryptoVerified": true,
  "accountAgeDays": 0,
  "followers": 0,
  "postsCount": 0,
  "lastCheckAt": "ISO8601 | null",
  "checklist": [
    {
      "id": "account_age | reach | activity | wallet",
      "passed": true,
      "message": "string",
      "current": 0,
      "required": 0
    }
  ]
}
```

`passed` === `isCryptoVerified === true` **and** `verificationStatus === "verified"`.

`POST /api/eligibility/verify` — body `{}`, max once per 24h (except `canRecheckImmediately: true` when only the wallet row failed). Response always has **`ok: true`** on HTTP 200; use **`passed`** for badge outcome, not `ok`. Activity row uses AI on **recent tweet samples** for crypto/web3 topics. Same fields + updates profile. Requires `x_username` set first.

### Reputation (UI badges — includes social flags)

`GET /api/reputation/me` (auth) or `GET /api/reputation/:profileId`

```json
{
  "ok": true,
  "reputation": {
    "profileId": "uuid",
    "xUsername": "string | null",
    "displayName": "string | null",
    "raiderTier": "bronze | silver | gold",
    "strikes": 0,
    "badgeType": "gold | blue | grey | none",
    "xBadgeType": "gold | blue | grey | none",
    "raidHiveVerified": true,
    "badges": [{ "kind": "x", "variant": "blue" }, { "kind": "raidhive" }],
    "badgeMultiplier": 1,
    "xFollowers": 0,
    "totalEarnedUsdc": 0,
    "xFollowed": false,
    "tgJoined": false,
    "isBanned": false,
    "reputationScore": 0,
    "level": "standard | trusted | elite | restricted"
  }
}
```

**UI mapping:** Payout-ready → `reputation.xFollowed && reputation.tgJoined`. Crypto-verified raider → `reputation.raidHiveVerified` or `eligibility.passed`. Set `x_username` on own profile (allowed client update) before X verify or raid submit.

### Dual badges (X pay tier vs RaidHive verified)

| Field | Meaning |
|-------|---------|
| `xBadgeType` | `gold` \| `blue` \| `grey` \| `none` — X/Premium/org icon only; affects **pay multiplier**, not RaidHive approval |
| `raidHiveVerified` | `true` after full eligibility (`verification_status === "verified"`) — show **RaidHive logo** seal |
| `badges` | Array to render: `{ kind: "x", variant: "blue" }` and/or `{ kind: "raidhive" }` |

**Display rules**

1. X tier + RaidHive verified → **two** icons (X tier + RaidHive logo).
2. RaidHive verified, `xBadgeType === "none"` → **only** RaidHive logo.
3. X tier only, not RaidHive verified → **only** X tier (no RaidHive logo).
4. Neither → no badges.

Do not conflate X OAuth or `verify-x` follow with `raidHiveVerified`. Eligibility `POST /api/eligibility/verify` sets the RaidHive seal.

Reputation and eligibility responses include `xBadgeType`, `raidHiveVerified`, and `badges` (legacy `badgeType` on reputation = `xBadgeType`).

---

## 4. Raid submit (proof URL)

`POST /api/raids/submit` or `POST /api/raids/resubmit`

```json
{
  "campaignId": "uuid",
  "actionType": "follow | repost | reply | quote | post",
  "tweetUrl": "https://x.com/... or https://twitter.com/... (required except follow)"
}
```

Success (verified):

```json
{
  "ok": true,
  "submission": {
    "id": "uuid",
    "status": "verified",
    "earnedUsdc": 0,
    "vestsAt": "ISO8601"
  }
}
```

Rejected (graded actions):

```json
{
  "ok": true,
  "submission": { "id", "status": "rejected", "ai_reason", "earned_usdc" },
  "grade": { ... }
}
```

---

## 5. Client implementation checklist

- [ ] Single `apiFetch` → `VITE_API_URL` + Bearer
- [ ] Campaign/history via endpoints in §1 — not Supabase table reads
- [ ] Wallet via profile `wallet_address` + §2 payouts/deposit
- [ ] Show flags from §3 (`reputation` + `eligibility` + social verify POSTs)
- [ ] CORS already allows `raidhive.xyz`, `raidhive.lovable.app`, and configured Lovable preview origins

**Discovery:** `GET /api` → `{ ok, service: "raidhive-backend", cors, routes }`.