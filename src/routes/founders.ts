import { Router } from "express";
import { z } from "zod";
import { asUsdc, HttpError, parseParams, supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);

const CampaignId = z.string().uuid();

function walletLinked(address: string | null | undefined): boolean {
  const trimmed = address?.trim();
  return Boolean(trimmed && trimmed.length >= 32 && trimmed.length <= 64);
}

router.get("/flags", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const profile = await supabase
      .from("profiles")
      .select("x_username, x_followed, tg_joined, wallet_address")
      .eq("id", user.id)
      .maybeSingle();
    if (profile.error) throwDb(profile.error, "load founder profile");
    if (!profile.data) throw new HttpError(404, "Profile not found");

    const awaiting = await supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("founder_id", user.id)
      .eq("status", "awaiting_deposit");
    if (awaiting.error) throwDb(awaiting.error, "count awaiting deposits");

    const xUsernameSet = Boolean(profile.data.x_username?.trim());
    const xFollowed = profile.data.x_followed === true;
    const tgJoined = profile.data.tg_joined === true;
    const wallet = walletLinked(profile.data.wallet_address as string | null);
    const payoutGatesComplete = xFollowed && tgJoined && wallet;

    const pending: string[] = [];
    if (!xUsernameSet) pending.push("set_x_username");
    if (!xFollowed) pending.push("verify_x_follow");
    if (!tgJoined) pending.push("verify_telegram");
    if (!wallet) pending.push("link_wallet");

    res.json({
      ok: true,
      status: pending.length === 0 ? "complete" : "pending",
      flags: {
        xUsernameSet,
        xFollowed,
        tgJoined,
        walletLinked: wallet,
        payoutGatesComplete,
        canRequestPayout: payoutGatesComplete,
      },
      pending,
      campaignsAwaitingDeposit: awaiting.count ?? 0,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/performance", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const campaignId = req.query.campaignId
      ? parseParams(CampaignId, String(req.query.campaignId))
      : null;

    const campaignsQuery = supabase
    .from("campaigns")
    .select("id, project_name, status, total_budget_usdc, remaining_budget_usdc, ends_at, created_at")
    .eq("founder_id", user.id);
    if (campaignId) campaignsQuery.eq("id", campaignId);

    const campaigns = await campaignsQuery;
    if (campaigns.error) throwDb(campaigns.error, "load campaigns");
    const rows = campaigns.data ?? [];
    if (campaignId && rows.length === 0) throw new HttpError(404, "Campaign not found");

    const campaignIds = rows.map((row) => row.id as string);
    let submissions: { campaign_id: string; status: string; earned_usdc: number | string }[] = [];
    if (campaignIds.length) {
      const loaded = await supabase
        .from("submissions")
        .select("campaign_id, status, earned_usdc")
        .in("campaign_id", campaignIds);
      if (loaded.error) throwDb(loaded.error, "load submissions");
      submissions = loaded.data ?? [];
    }

    const performance = rows.map((camp) => {
    const subs = submissions.filter((s) => s.campaign_id === camp.id);
    const verified = subs.filter((s) => s.status === "verified");
    const rejected = subs.filter((s) => s.status === "rejected");
    const spent = asUsdc(Number(camp.total_budget_usdc) - Number(camp.remaining_budget_usdc));
    const earnedOut = verified.reduce((sum, row) => sum + asUsdc(row.earned_usdc), 0);
      return {
        campaignId: camp.id,
        projectName: camp.project_name ?? null,
        status: camp.status,
        totalBudgetUsdc: asUsdc(camp.total_budget_usdc),
        remainingBudgetUsdc: asUsdc(camp.remaining_budget_usdc),
        spentBudgetUsdc: spent,
        paidToRaidersUsdc: earnedOut,
        endsAt: camp.ends_at,
        submissionsTotal: subs.length,
        submissionsVerified: verified.length,
        submissionsRejected: rejected.length,
        conversionRate: subs.length ? Math.round((verified.length / subs.length) * 1000) / 10 : 0,
      };
    });

    res.json({
      ok: true,
      campaigns: performance,
      totals: {
        campaigns: performance.length,
        submissions: submissions.length,
        verified: submissions.filter((s) => s.status === "verified").length,
        rejected: submissions.filter((s) => s.status === "rejected").length,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;