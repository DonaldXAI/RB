# RaidHive Render API — example JSON shapes (non-sensitive)

**Base URL:** `https://rb-d5yp.onrender.com`  
**Auth:** `Authorization: Bearer <supabase_access_token>` on all routes below except where noted.  
**Errors:** `{ "error": "human-readable message" }`

---

## GET /api/raids/history?limit=50

```json
{
  "ok": true,
  "history": [
    {
      "submissionId": "550e8400-e29b-41d4-a716-446655440001",
      "campaignId": "550e8400-e29b-41d4-a716-446655440002",
      "actionType": "repost",
      "tweetUrl": "https://x.com/someuser/status/1234567890",
      "status": "verified",
      "earnedUsdc": 1.25,
      "vestsAt": "2026-11-27T22:00:00.000Z",
      "vested": false,
      "aiReason": "Reply matched campaign brief.",
      "createdAt": "2026-11-27T19:00:00.000Z",
      "campaign": {
        "id": "550e8400-e29b-41d4-a716-446655440002",
        "project_name": "Example Project",
        "project_handle": "example-project",
        "status": "active",
        "ends_at": "2026-11-30T12:00:00.000Z"
      }
    }
  ]
}
```

- `actionType`: `follow` | `repost` | `reply` | `quote` | `post`
- `status`: `verified` | `rejected`
- `campaign`: object or `null`

Empty:

```json
{ "ok": true, "history": [] }
```

---

## GET /api/payouts/receipts?limit=50

```json
{
  "ok": true,
  "receipts": [
    {
      "kind": "payout",
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "requestType": "raider_payout",
      "status": "paid",
      "grossAmountUsdc": 25.0,
      "netAmountUsdc": 24.85,
      "gasFeeUsdc": 0.15,
      "destinationWallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuZZosRA",
      "txHash": "5VERv8NMvzbJMEkVzxHfX9ExampleSignatureOnly",
      "campaignId": null,
      "createdAt": "2026-11-28T08:00:00.000Z",
      "processedAt": "2026-11-28T09:30:00.000Z"
    },
    {
      "kind": "payout",
      "id": "660e8400-e29b-41d4-a716-446655440002",
      "requestType": "campaign_refund",
      "status": "queued",
      "grossAmountUsdc": 100.0,
      "netAmountUsdc": 99.85,
      "gasFeeUsdc": 0.15,
      "destinationWallet": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuZZosRA",
      "txHash": null,
      "campaignId": "550e8400-e29b-41d4-a716-446655440010",
      "createdAt": "2026-11-27T15:00:00.000Z",
      "processedAt": null
    },
    {
      "kind": "campaign_deposit",
      "id": "550e8400-e29b-41d4-a716-446655440010",
      "campaignId": "550e8400-e29b-41d4-a716-446655440010",
      "projectName": "Example Project",
      "status": "active",
      "totalBudgetUsdc": 500.0,
      "txHash": "4VERv8NMvzbJMEkVzxHfX9ExampleSignatureOnly",
      "createdAt": "2026-11-25T12:00:00.000Z",
      "processedAt": null
    }
  ]
}
```

- `kind`: `payout` | `campaign_deposit`
- `requestType` (payout only): `raider_payout` | `campaign_refund`
- `status`: `queued` | `paid` | `rejected`

---

## GET /api/founders/flags

Founder / payout gates (no eligibility step):

**Pending example:**

```json
{
  "ok": true,
  "status": "pending",
  "flags": {
    "xUsernameSet": true,
    "xFollowed": true,
    "tgJoined": false,
    "walletLinked": true,
    "payoutGatesComplete": false,
    "canRequestPayout": false
  },
  "pending": ["verify_telegram"],
  "campaignsAwaitingDeposit": 1
}
```

**Complete example:**

```json
{
  "ok": true,
  "status": "complete",
  "flags": {
    "xUsernameSet": true,
    "xFollowed": true,
    "tgJoined": true,
    "walletLinked": true,
    "payoutGatesComplete": true,
    "canRequestPayout": true
  },
  "pending": [],
  "campaignsAwaitingDeposit": 0
}
```

`pending` item codes: `set_x_username` | `verify_x_follow` | `verify_telegram` | `link_wallet`

---

## GET /api/account/verification

Signed-in onboarding (includes raider eligibility):

**Pending example:**

```json
{
  "ok": true,
  "status": "pending",
  "flags": {
    "xUsernameSet": true,
    "xFollowed": true,
    "tgJoined": true,
    "walletLinked": true,
    "verificationStatus": "rejected",
    "isCryptoVerified": false,
    "eligibilityPassed": false,
    "socialGatesComplete": true,
    "payoutGatesComplete": true
  },
  "pending": ["complete_eligibility"],
  "lastEligibilityCheckAt": "2026-11-27T18:00:00.000Z"
}
```

**Complete example:**

```json
{
  "ok": true,
  "status": "complete",
  "flags": {
    "xUsernameSet": true,
    "xFollowed": true,
    "tgJoined": true,
    "walletLinked": true,
    "verificationStatus": "verified",
    "isCryptoVerified": true,
    "eligibilityPassed": true,
    "socialGatesComplete": true,
    "payoutGatesComplete": true
  },
  "pending": [],
  "lastEligibilityCheckAt": "2026-11-27T18:00:00.000Z"
}
```

`pending` codes: `set_x_username` | `verify_x_follow` | `verify_telegram` | `link_wallet` | `complete_eligibility`

**Fix actions:**

| pending code | Action |
|--------------|--------|
| `set_x_username` | Update profile `x_username` (client) |
| `verify_x_follow` | `POST /api/social/verify-x` `{}` |
| `verify_telegram` | `POST /api/social/verify-telegram` |
| `link_wallet` | Update profile `wallet_address` |
| `complete_eligibility` | `POST /api/eligibility/verify` `{}` |

Use **`GET /api/founders/flags`** for founder-only UI (skip `complete_eligibility`).  
Use **`GET /api/account/verification`** for raider onboarding.

---

## Related (browse + launch)

**GET /api/campaigns/browse** — no auth.

```json
{
  "ok": true,
  "campaigns": [
    {
      "campaignId": "550e8400-e29b-41d4-a716-446655440002",
      "status": "active",
      "projectName": "Example Project",
      "projectHandle": "example-project",
      "brief": "Raid our launch tweet",
      "tickerOrHashtag": "$EXMP",
      "targetUsername": "example",
      "targetTweetId": "1234567890",
      "minFollowers": 150,
      "baseRates": { "repost": 1.0, "reply": 1.5, "quote": 2.0, "follow": 0.5, "post": 0 },
      "remainingBudgetUsdc": 420.5,
      "totalBudgetUsdc": 500.0,
      "endsAt": "2026-11-30T12:00:00.000Z",
      "createdAt": "2026-11-25T12:00:00.000Z"
    }
  ]
}
```

**POST /api/campaigns/launch** — then **`POST /api/campaigns/verify-deposit`** for funding.