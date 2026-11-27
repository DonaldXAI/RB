import { Router } from "express";
import { z } from "zod";
import { asUsdc, assertWalletAddress, HttpError, parseBody, supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";
import { persistXBadge } from "../lib/xBadge.js";
import { assessBotRisk } from "../services/openai.js";
import { getUserProfile } from "../services/twitter.js";

const router = Router();
router.use(requireUser);

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ACCOUNT_AGE_DAYS = 90;
const MIN_FOLLOWERS_DEFAULT = 150;
const MIN_FOLLOWERS_BADGE = 100;
const MIN_PUBLIC_POSTS = 20;
const BADGE_FOLLOWER_TYPES = new Set(["gold", "blue", "grey"]);

export type EligibilityChecklistItem = {
  id: "account_age" | "reach" | "activity" | "wallet";
  passed: boolean;
  message: string;
  current?: number;
  required?: number;
};

type ProfileRow = {
  id: string;
  x_username: string | null;
  wallet_address: string | null;
  x_badge_type: string | null;
  verification_status?: string | null;
  is_crypto_verified?: boolean | null;
  ai_verification_notes?: Record<string, unknown> | null;
  account_age_days?: number | null;
  posts_count?: number | null;
};

function lastEligibilityCheckAt(notes: Record<string, unknown> | null | undefined): number | null {
  const raw = notes?.eligibilityLastCheckAt;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function minFollowers(badgeType: string | null | undefined): number {
  const badge = (badgeType ?? "none").toLowerCase();
  return BADGE_FOLLOWER_TYPES.has(badge) ? MIN_FOLLOWERS_BADGE : MIN_FOLLOWERS_DEFAULT;
}

function walletValid(address: string | null | undefined): boolean {
  if (!address?.trim()) return false;
  try {
    assertWalletAddress(address);
    return true;
  } catch {
    return false;
  }
}

router.get("/status", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const row = await supabase
      .from("profiles")
      .select(
        "verification_status, is_crypto_verified, account_age_days, x_followers, posts_count, ai_verification_notes, x_badge_type, badge_multiplier",
      )
      .eq("id", user.id)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load eligibility status");
    if (!row.data) throw new HttpError(404, "Profile not found");

    const notes = (row.data.ai_verification_notes ?? {}) as Record<string, unknown>;
    const checklist = notes.eligibilityChecklist as EligibilityChecklistItem[] | undefined;

    res.json({
      ok: true,
      passed: row.data.is_crypto_verified === true && row.data.verification_status === "verified",
      verificationStatus: row.data.verification_status,
      isCryptoVerified: row.data.is_crypto_verified,
      accountAgeDays: row.data.account_age_days,
      followers: row.data.x_followers,
      postsCount: row.data.posts_count,
      lastCheckAt: notes.eligibilityLastCheckAt ?? null,
      checklist: checklist ?? [],
      xBadgeType: row.data.x_badge_type ?? "none",
      badgeMultiplier: asUsdc(row.data.badge_multiplier ?? 1),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/verify", async (req, res, next) => {
  try {
    const user = currentUser(req);
    parseBody(z.object({}).strict(), req.body ?? {});

    const loaded = await supabase
      .from("profiles")
      .select(
        "id, x_username, wallet_address, x_badge_type, verification_status, is_crypto_verified, ai_verification_notes, account_age_days, posts_count",
      )
      .eq("id", user.id)
      .maybeSingle();
    if (loaded.error) throwDb(loaded.error, "load profile");
    if (!loaded.data) throw new HttpError(404, "Profile not found");

    const profile = loaded.data as ProfileRow;
    const notes = (profile.ai_verification_notes ?? {}) as Record<string, unknown>;
    const lastAt = lastEligibilityCheckAt(notes);
    if (lastAt !== null && Date.now() - lastAt < DAY_MS) {
      throw new HttpError(429, "You can re-check once every 24 hours");
    }

    const xUsername = profile.x_username?.trim();
    if (!xUsername) throw new HttpError(400, "Set your X username before an eligibility check");

    const startedAt = new Date().toISOString();
    const pending = await supabase
      .from("profiles")
      .update({
        verification_status: "pending",
        ai_verification_notes: {
          ...notes,
          eligibilityStatus: "started",
          eligibilityStartedAt: startedAt,
        },
      })
      .eq("id", user.id);
    if (pending.error) throwDb(pending.error, "mark eligibility pending");

    const xProfile = await getUserProfile(xUsername, { requireMinAge: false });
    const badge = await persistXBadge(user.id, xProfile.badgeType);
    const risk = await assessBotRisk(xProfile);
    const followerTarget = minFollowers(badge.xBadgeType);

    const checklist: EligibilityChecklistItem[] = [];

    const ageOk = xProfile.ageDays >= MIN_ACCOUNT_AGE_DAYS;
    const ageRemaining = Math.max(0, MIN_ACCOUNT_AGE_DAYS - xProfile.ageDays);
    checklist.push({
      id: "account_age",
      passed: ageOk,
      current: xProfile.ageDays,
      required: MIN_ACCOUNT_AGE_DAYS,
      message: ageOk
        ? "Your X account is old enough."
        : `Your X account needs ${ageRemaining} more days. Re-check once it's ${MIN_ACCOUNT_AGE_DAYS} days old.`,
    });

    const reachOk = xProfile.followers >= followerTarget;
    const followersToGo = Math.max(0, followerTarget - xProfile.followers);
    checklist.push({
      id: "reach",
      passed: reachOk,
      current: xProfile.followers,
      required: followerTarget,
      message: reachOk
        ? "You meet the follower requirement."
        : `Grow to ${followerTarget} followers (${followersToGo} to go), then re-check.`,
    });

    const postsOk = xProfile.tweetCount >= MIN_PUBLIC_POSTS;
    const postsToGo = Math.max(0, MIN_PUBLIC_POSTS - xProfile.tweetCount);
    let activityMessage = postsOk
      ? "Your public post history looks sufficient."
      : `Post ${postsToGo} more public posts on X, then re-check.`;
    if (postsOk && risk.isBotLikely) {
      activityMessage =
        risk.reason ||
        "Post genuinely on Crypto Twitter — your activity did not pass our AI review. Re-check after more real engagement.";
    }
    const activityOk = postsOk && !risk.isBotLikely;
    checklist.push({
      id: "activity",
      passed: activityOk,
      current: xProfile.tweetCount,
      required: MIN_PUBLIC_POSTS,
      message: activityMessage,
    });

    const walletOk = walletValid(profile.wallet_address);
    checklist.push({
      id: "wallet",
      passed: walletOk,
      message: walletOk
        ? "A valid Solana payout wallet is on your profile."
        : "Save a valid Solana wallet address in your dashboard.",
    });

    const passed = checklist.every((item) => item.passed);
    const finishedAt = new Date().toISOString();

    const resultNotes = {
      ...notes,
      eligibilityStatus: passed ? "passed" : "failed",
      eligibilityLastCheckAt: finishedAt,
      eligibilityChecklist: checklist,
      eligibility: {
        checkedAt: finishedAt,
        passed,
        accountAgeDays: xProfile.ageDays,
        followers: xProfile.followers,
        following: xProfile.following,
        postsCount: xProfile.tweetCount,
        tweetCount: xProfile.tweetCount,
        isBotLikely: risk.isBotLikely,
        botReason: risk.reason,
        followerTarget,
      },
    };

    const saved = await supabase
      .from("profiles")
      .update({
        account_age_days: xProfile.ageDays,
        x_followers: xProfile.followers,
        posts_count: xProfile.tweetCount,
        x_badge_type: badge.xBadgeType,
        verification_status: passed ? "verified" : "rejected",
        is_crypto_verified: passed,
        ai_verification_notes: resultNotes,
      })
      .eq("id", user.id)
      .select(
        "id, verification_status, is_crypto_verified, account_age_days, x_followers, posts_count, ai_verification_notes",
      )
      .single();
    if (saved.error) throwDb(saved.error, "save eligibility result");

    res.json({
      ok: passed,
      passed,
      message: passed ? "Eligibility check passed" : "Eligibility check not passed",
      verificationStatus: saved.data.verification_status,
      isCryptoVerified: saved.data.is_crypto_verified,
      accountAgeDays: xProfile.ageDays,
      followers: xProfile.followers,
      postsCount: xProfile.tweetCount,
      checklist,
      lastCheckAt: finishedAt,
      xBadgeType: badge.xBadgeType,
      badgeMultiplier: badge.badgeMultiplier,
    });
  } catch (error) {
    next(error);
  }
});

export default router;