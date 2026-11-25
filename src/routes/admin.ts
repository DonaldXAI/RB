import { Router } from "express";
import { z } from "zod";
import { asUsdc, HttpError, parseBody, parseParams, supabase, throwDb, VESTING_HOURS } from "../config.js";
import { logAdminAction } from "../middleware/audit.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { verifyBatchPayoutTx } from "../services/helius.js";

const router = Router();
router.use(requireAdmin);

const listLimit = z.coerce.number().int().min(1).max(100).default(50);

router.get("/payouts", async (req, res, next) => {
  try {
    const query = parseBody(
      z.object({
        status: z.enum(["queued", "paid", "rejected"]).default("queued"),
        limit: listLimit,
      }),
      { status: req.query.status ?? "queued", limit: Number(req.query.limit ?? 50) },
    );
    const rows = await supabase
      .from("payout_requests")
      .select(
        "id, user_id, campaign_id, request_type, gross_amount_usdc, net_amount_usdc, gas_fee_usdc, destination_wallet, status, payout_tx_hash, created_at",
      )
      .eq("status", query.status)
      .order("created_at", { ascending: false })
      .limit(query.limit ?? 50);
    if (rows.error) throwDb(rows.error, "list payout requests");
    res.json({ ok: true, payouts: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get("/submissions", async (req, res, next) => {
  try {
    const query = parseBody(
      z.object({ limit: listLimit }),
      { limit: Number(req.query.limit ?? 50) },
    );
    const rows = await supabase
      .from("submissions")
      .select(
        "id, campaign_id, raider_id, action_type, tweet_url, status, earned_usdc, ai_reason, flagged_by_creator, flag_reason, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(query.limit ?? 50);
    if (rows.error) throwDb(rows.error, "list submissions");
    res.json({ ok: true, submissions: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const query = parseBody(
      z.object({
        q: z.string().trim().max(64).optional(),
        limit: listLimit,
      }),
      { q: req.query.q, limit: Number(req.query.limit ?? 50) },
    );
    let request = supabase
      .from("profiles")
      .select("id, x_username, wallet_address, strikes, is_banned, x_followers, available_usdc, created_at")
      .order("created_at", { ascending: false })
      .limit(query.limit ?? 50);
    if (query.q) {
      const term = query.q.replace(/[%(),]/g, "");
      if (term) request = request.or(`x_username.ilike.%${term}%,wallet_address.ilike.%${term}%`);
    }
    const rows = await request;
    if (rows.error) throwDb(rows.error, "list users");
    res.json({ ok: true, users: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get("/campaigns", async (req, res, next) => {
  try {
    const query = parseBody(
      z.object({
        status: z.string().trim().max(32).optional(),
        limit: listLimit,
      }),
      { status: req.query.status, limit: Number(req.query.limit ?? 50) },
    );
    let request = supabase
      .from("campaigns")
      .select("id, founder_id, status, project_name, total_budget_usdc, remaining_budget_usdc, ends_at, created_at")
      .order("created_at", { ascending: false })
      .limit(query.limit ?? 50);
    if (query.status) request = request.eq("status", query.status);
    const rows = await request;
    if (rows.error) throwDb(rows.error, "list campaigns");
    res.json({ ok: true, campaigns: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

type PayoutRequest = {
  id: string;
  status: string;
  request_type: string;
  net_amount_usdc: number | string;
  destination_wallet: string | null;
  payout_tx_hash: string | null;
};

const payoutTxHash = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/);

router.post("/payouts/confirm", async (req, res, next) => {
  try {
    const body = parseBody(
      z.object({
        requestIds: z.array(z.string().uuid()).min(1).max(50),
        payoutTxHash,
      }),
      req.body,
    );
    const requestIds = [...new Set(body.requestIds)];
    if (requestIds.length !== body.requestIds.length) throw new HttpError(400, "Invalid request");

    const loaded = await supabase
      .from("payout_requests")
      .select("id, status, request_type, net_amount_usdc, destination_wallet, payout_tx_hash")
      .in("id", requestIds);
    if (loaded.error) throwDb(loaded.error, "load payout requests");
    const requests = (loaded.data ?? []) as PayoutRequest[];
    if (requests.length !== requestIds.length) throw new HttpError(404, "One or more payout requests were not found");

    if (requests.every((request) => request.status === "paid" && request.payout_tx_hash === body.payoutTxHash)) {
      res.json({ ok: true, status: "paid", payoutTxHash: body.payoutTxHash, count: requests.length });
      return;
    }
    if (requests.some((request) => request.status !== "queued")) {
      throw new HttpError(409, "Every payout request must be queued");
    }

    const expectedTransfers = requests.map((request) => {
      if (!request.destination_wallet) throw new HttpError(409, "A payout request has no destination wallet");
      return { destinationWallet: request.destination_wallet, netAmountUsdc: asUsdc(request.net_amount_usdc) };
    });
    const transfer = await verifyBatchPayoutTx(body.payoutTxHash, expectedTransfers);
    if (!transfer.verified) throw new HttpError(400, "Payout transaction could not be verified");

    const confirmed = await supabase.rpc("confirm_payout_batch", {
      p_ids: requestIds,
      p_tx: body.payoutTxHash,
    });
    if (confirmed.error) throwDb(confirmed.error, "confirm payouts");

    await logAdminAction(req, "payouts.confirm", "payout_request", requestIds.join(","), {
      payoutTxHash: body.payoutTxHash,
      count: confirmed.data,
    });

    res.json({ ok: true, status: "paid", payoutTxHash: body.payoutTxHash, count: confirmed.data });
  } catch (error) {
    next(error);
  }
});

router.post("/payouts/reject", async (req, res, next) => {
  try {
    const body = parseBody(
      z.object({
        requestId: z.string().uuid(),
        rejectionReason: z.string().trim().min(1).max(500),
        refundBalance: z.boolean(),
      }),
      req.body,
    );

    const rejected = await supabase.rpc("reject_payout_request", {
      p_request_id: body.requestId,
      p_reason: body.rejectionReason,
      p_refund: body.refundBalance,
    });
    if (rejected.error) throwDb(rejected.error, "reject payout");

    await logAdminAction(req, "payouts.reject", "payout_request", body.requestId, {
      refundBalance: body.refundBalance,
      rejectionReason: body.rejectionReason,
    });

    res.json({ ok: true, requestId: body.requestId, result: rejected.data });
  } catch (error) {
    next(error);
  }
});

router.post("/submissions/override", async (req, res, next) => {
  try {
    const body = parseBody(
      z.object({
        submissionId: z.string().uuid(),
        decision: z.enum(["approve", "reject_strike"]),
        reason: z.string().trim().min(1).max(500),
      }),
      req.body,
    );

    const submission = await supabase
      .from("submissions")
      .select("campaign_id")
      .eq("id", body.submissionId)
      .maybeSingle();
    if (submission.error) throwDb(submission.error, "load submission");
    if (!submission.data) throw new HttpError(404, "Submission not found");

    const campaign = await supabase
      .from("campaigns")
      .select("base_rates")
      .eq("id", submission.data.campaign_id as string)
      .maybeSingle();
    if (campaign.error) throwDb(campaign.error, "load submission campaign");
    const rates = (campaign.data?.base_rates ?? {}) as Record<string, number>;
    const positives = Object.values(rates).map(Number).filter((rate) => Number.isFinite(rate) && rate > 0);
    const minRate = positives.length ? asUsdc(Math.min(...positives)) : 0;
    const vestsAt = new Date(Date.now() + VESTING_HOURS * 60 * 60 * 1000).toISOString();

    const updated = await supabase.rpc("override_submission", {
      p_submission_id: body.submissionId,
      p_decision: body.decision,
      p_reason: body.reason,
      p_vests_at: vestsAt,
      p_min_rate: minRate,
    });
    if (updated.error) throwDb(updated.error, "override submission");

    await logAdminAction(req, "submissions.override", "submission", body.submissionId, {
      decision: body.decision,
      reason: body.reason,
    });

    res.json({ ok: true, submissionId: body.submissionId, result: updated.data });
  } catch (error) {
    next(error);
  }
});

router.post("/users/moderate", async (req, res, next) => {
  try {
    const body = parseBody(
      z.object({
        userId: z.string().uuid(),
        action: z.enum(["add_strike", "reset_strikes", "ban", "unban"]),
      }),
      req.body,
    );
    const moderated = await supabase.rpc("moderate_user", {
      p_user_id: body.userId,
      p_action: body.action,
    });
    if (moderated.error) throwDb(moderated.error, "moderate user");

    await logAdminAction(req, "users.moderate", "profile", body.userId, { action: body.action });

    res.json({ ok: true, profile: moderated.data });
  } catch (error) {
    next(error);
  }
});

router.post("/campaigns/status", async (req, res, next) => {
  try {
    const body = parseBody(
      z.object({
        campaignId: z.string().uuid(),
        status: z.enum(["active", "paused", "hidden"]),
      }),
      req.body,
    );
    const { data, error } = await supabase
      .from("campaigns")
      .update({ status: body.status })
      .eq("id", body.campaignId)
      .select("id, status")
      .maybeSingle();
    if (error) throwDb(error, "set campaign status");
    if (!data) throw new HttpError(404, "Campaign not found");

    await logAdminAction(req, "campaigns.status", "campaign", body.campaignId, { status: body.status });

    res.json({ ok: true, campaign: data });
  } catch (error) {
    next(error);
  }
});

router.post("/ads/:id/takedown", async (req, res, next) => {
  try {
    const id = parseParams(z.string().uuid(), req.params.id);
    const existing = await supabase
      .from("ad_banner_bookings")
      .select("id, status, starts_at, ends_at")
      .eq("id", id)
      .maybeSingle();
    if (existing.error) throwDb(existing.error, "load ad");
    if (!existing.data) throw new HttpError(404, "Ad banner not found");
    if (existing.data.status === "refunded" || existing.data.status === "completed" || existing.data.status === "expired") {
      throw new HttpError(409, "Ad banner is already inactive");
    }

    const now = new Date();
    const refunded = await supabase
      .from("ad_banner_bookings")
      .update({ status: "refunded", ends_at: now.toISOString() })
      .eq("id", id)
      .in("status", ["active", "queued", "reserved"])
      .select("id, status")
      .maybeSingle();
    if (refunded.error) throwDb(refunded.error, "refund ad");
    if (!refunded.data) throw new HttpError(409, "Ad banner changed before takedown");

    let promoted: { id: string; status: string; starts_at: string; ends_at: string } | null = null;
    if (existing.data.status === "active") {
      const next = await supabase
        .from("ad_banner_bookings")
        .select("id, starts_at, ends_at")
        .eq("status", "queued")
        .order("starts_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (next.error) throwDb(next.error, "load next ad");
      if (next.data) {
        const startsAt = Date.parse(next.data.starts_at as string);
        const endsAt = Date.parse(next.data.ends_at as string);
        const keepWindow = startsAt <= now.getTime() && endsAt > now.getTime();
        const window = keepWindow
          ? { starts_at: next.data.starts_at as string, ends_at: next.data.ends_at as string }
          : {
              starts_at: now.toISOString(),
              ends_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
            };
        const update = await supabase
          .from("ad_banner_bookings")
          .update({ status: "active", ...window })
          .eq("id", next.data.id as string)
          .eq("status", "queued")
          .select("id, status, starts_at, ends_at")
          .maybeSingle();
        if (update.error) throwDb(update.error, "promote ad");
        promoted = update.data;
      }
    }

    await logAdminAction(req, "ads.takedown", "ad_banner", id, { previousStatus: existing.data.status, promoted: promoted?.id ?? null });

    res.json({ ok: true, refunded: refunded.data, promoted });
  } catch (error) {
    next(error);
  }
});

export default router;