import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import {
  asUsdc,
  GRADED_ACTIONS,
  HttpError,
  parseBody,
  RAID_ACTIONS,
  type RaidAction,
  supabase,
  throwDb,
  VESTING_HOURS,
} from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { raidsSubmitLimiter } from "../middleware/rateLimits.js";
import { gradeRaidSubmission } from "../services/openai.js";
import { getUserProfile, verifyRaidAction } from "../services/twitter.js";

const router = Router();
router.use(requireUser);

const proofUrl = z
  .string()
  .trim()
  .url()
  .max(300)
  .refine((value) => /^(https:\/\/(x\.com|twitter\.com)\/)/i.test(value), "Proof must be an X status URL");

type Campaign = {
  id: string;
  status: string;
  created_at: string;
  ends_at: string;
  remaining_budget_usdc: number | string;
  min_followers: number | string;
  base_rates: Record<string, number> | null;
  brief: string | null;
  ticker_or_hashtag: string | null;
  target_tweet_id: string | null;
  target_username: string | null;
};

export async function raidVerifyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
    const replaceRejected = req.originalUrl.includes("/resubmit");
    const body = parseBody(
      z.object({
        campaignId: z.string().uuid(),
        actionType: z.enum(RAID_ACTIONS),
        tweetUrl: proofUrl.optional(),
      }),
      req.body,
    );
    if (body.actionType !== "follow" && !body.tweetUrl) throw new HttpError(400, "Invalid request");

    const profileResult = await supabase
      .from("profiles")
      .select("x_username, badge_multiplier")
      .eq("id", user.id)
      .maybeSingle();
    if (profileResult.error) throwDb(profileResult.error, "load raider");
    const xUsername = profileResult.data?.x_username as string | null;
    if (!xUsername) throw new HttpError(400, "Set your X username before submitting a raid");

    const multiplier = asUsdc(profileResult.data?.badge_multiplier ?? 1);
    if (multiplier < 1 || multiplier > 2) throw new HttpError(409, "Raider badge multiplier is out of range");

    const existing = await supabase
      .from("submissions")
      .select("id, status")
      .eq("campaign_id", body.campaignId)
      .eq("raider_id", user.id)
      .maybeSingle();
    if (existing.error) throwDb(existing.error, "check submission");
    if (existing.data) {
      const priorStatus = existing.data.status as string;
      if (replaceRejected && priorStatus === "rejected") {
        const removed = await supabase
          .from("submissions")
          .delete()
          .eq("id", existing.data.id)
          .eq("raider_id", user.id)
          .eq("status", "rejected");
        if (removed.error) throwDb(removed.error, "clear rejected submission");
      } else {
        throw new HttpError(409, "You already submitted a raid for this campaign");
      }
    }

    const campaignResult = await supabase.from("campaigns").select("*").eq("id", body.campaignId).maybeSingle();
    if (campaignResult.error) throwDb(campaignResult.error, "load campaign");
    const campaign = campaignResult.data as Campaign | null;
    if (!campaign) throw new HttpError(404, "Campaign not found");
    if (campaign.status !== "active") throw new HttpError(409, "Campaign is not active");
    if (Date.parse(campaign.ends_at) <= Date.now()) throw new HttpError(409, "Campaign has ended");

    const xProfile = await getUserProfile(xUsername);
    const minFollowers = Number(campaign.min_followers ?? 0);
    if (xProfile.followers < minFollowers) {
      throw new HttpError(403, `This campaign requires at least ${minFollowers} followers`);
    }
    await supabase.from("profiles").update({ x_followers: xProfile.followers }).eq("id", user.id);

    const rates = campaign.base_rates ?? {};
    const baseRate = Number(rates[body.actionType]);
    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      throw new HttpError(400, "Campaign does not pay for this action");
    }
    const payoutAmount = asUsdc(baseRate * multiplier);
    if (asUsdc(campaign.remaining_budget_usdc) < payoutAmount) {
      throw new HttpError(409, "Campaign budget cannot cover this raid");
    }
    const minRate = minActionRate(rates);

    const proof = await verifyRaidAction({
      actionType: body.actionType,
      tweetUrl: body.tweetUrl ?? "",
      targetTweetId: campaign.target_tweet_id ?? "",
      targetUsername: campaign.target_username ?? "",
      raiderUsername: xUsername,
      campaignCreatedAt: campaign.created_at,
    });

    let aiReason = "";
    if (GRADED_ACTIONS.has(body.actionType)) {
      const grade = await gradeRaidSubmission({
        actionType: body.actionType,
        tweetText: proof.tweetText,
        campaignBrief: campaign.brief ?? "",
        tickerOrHashtag: campaign.ticker_or_hashtag ?? "",
      });
      aiReason = grade.reason;
      if (!grade.approved) {
        const rejected = await insertRejected({
          campaignId: campaign.id,
          raiderId: user.id,
          actionType: body.actionType,
          tweetUrl: body.tweetUrl ?? "",
          tweetText: proof.tweetText,
          aiReason,
          earnedUsdc: payoutAmount,
        });
        res.status(201).json({ ok: true, submission: rejected, grade });
        return;
      }
    }

    const vestsAt = new Date(Date.now() + VESTING_HOURS * 60 * 60 * 1000).toISOString();
    const created = await supabase.rpc("apply_verified_raid", {
      p_campaign_id: campaign.id,
      p_raider_id: user.id,
      p_amount: payoutAmount,
      p_min_rate: minRate,
      p_action_type: body.actionType,
      p_tweet_url: body.tweetUrl ?? "",
      p_tweet_text: proof.tweetText,
      p_ai_reason: aiReason,
      p_vests_at: vestsAt,
    });
    if (created.error) throwDb(created.error, "verify raid");

    res.status(201).json({
      ok: true,
      submission: {
        id: created.data,
        status: "verified",
        earnedUsdc: payoutAmount,
        vestsAt,
      },
    });
  } catch (error) {
    next(error);
  }
}

const publicCampaignColumns =
  "id, status, project_name, brief, ticker_or_hashtag, target_username, target_tweet_id, min_followers, base_rates, remaining_budget_usdc, ends_at, created_at";

router.get("/saved", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const rows = await supabase
      .from("saved_campaigns")
      .select(`campaign_id, created_at, campaigns (${publicCampaignColumns})`)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (rows.error) throwDb(rows.error, "load saved raids");
    const saved = (rows.data ?? []).map((row) => ({
      campaignId: row.campaign_id,
      savedAt: row.created_at,
      campaign: row.campaigns,
    }));
    res.json({ ok: true, saved });
  } catch (error) {
    next(error);
  }
});

router.post("/saved", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(z.object({ campaignId: z.string().uuid() }), req.body);
    const campaign = await supabase.from("campaigns").select("id, status").eq("id", body.campaignId).maybeSingle();
    if (campaign.error) throwDb(campaign.error, "load campaign");
    if (!campaign.data) throw new HttpError(404, "Campaign not found");
    if (!["active", "paused"].includes(campaign.data.status as string)) {
      throw new HttpError(409, "Only active raids can be saved");
    }

    const saved = await supabase
      .from("saved_campaigns")
      .upsert({ user_id: user.id, campaign_id: body.campaignId }, { onConflict: "user_id,campaign_id", ignoreDuplicates: false })
      .select("campaign_id, created_at")
      .maybeSingle();
    if (saved.error) throwDb(saved.error, "save raid");
    res.json({ ok: true, campaignId: body.campaignId, savedAt: saved.data?.created_at ?? new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.post("/saved/delete", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(z.object({ campaignId: z.string().uuid() }), req.body);
    const removed = await supabase
      .from("saved_campaigns")
      .delete()
      .eq("user_id", user.id)
      .eq("campaign_id", body.campaignId)
      .select("campaign_id")
      .maybeSingle();
    if (removed.error) throwDb(removed.error, "unsave raid");
    if (!removed.data) throw new HttpError(404, "Saved raid not found");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/submit", raidsSubmitLimiter, raidVerifyHandler);
router.post("/resubmit", raidsSubmitLimiter, raidVerifyHandler);

function minActionRate(rates: Record<string, number>): number {
  const positives = RAID_ACTIONS.map((action) => Number(rates[action])).filter((rate) => Number.isFinite(rate) && rate > 0);
  if (!positives.length) return 0;
  return asUsdc(Math.min(...positives));
}

async function insertRejected(input: {
  campaignId: string;
  raiderId: string;
  actionType: RaidAction;
  tweetUrl: string;
  tweetText: string;
  aiReason: string;
  earnedUsdc: number;
}) {
  const { data, error } = await supabase
    .from("submissions")
    .insert({
      campaign_id: input.campaignId,
      raider_id: input.raiderId,
      action_type: input.actionType,
      tweet_url: input.tweetUrl,
      tweet_text: input.tweetText,
      status: "rejected",
      ai_reason: input.aiReason,
      earned_usdc: input.earnedUsdc,
      vested: false,
    })
    .select("id, status, ai_reason, earned_usdc")
    .single();
  if (error) throwDb(error, "reject raid");
  return data;
}

export default router;