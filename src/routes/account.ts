import { Router } from "express";
import { HttpError, supabase, throwDb } from "../config.js";
import { buildProfileBadges } from "../lib/badges.js";
import { currentUser, requireUser } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);

function walletValid(address: string | null | undefined): boolean {
  const trimmed = address?.trim();
  return Boolean(trimmed && trimmed.length >= 32 && trimmed.length <= 64);
}

function buildPending(flags: {
  xUsernameSet: boolean;
  xFollowed: boolean;
  tgJoined: boolean;
  walletLinked: boolean;
  isCryptoVerified: boolean;
  verificationStatus: string | null;
}): string[] {
  const pending: string[] = [];
  if (!flags.xUsernameSet) pending.push("set_x_username");
  if (!flags.xFollowed) pending.push("verify_x_follow");
  if (!flags.tgJoined) pending.push("verify_telegram");
  if (!flags.walletLinked) pending.push("link_wallet");
  if (!flags.isCryptoVerified || flags.verificationStatus !== "verified") {
    pending.push("complete_eligibility");
  }
  return pending;
}

router.get("/verification", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const row = await supabase
      .from("profiles")
      .select(
        "x_username, x_followed, tg_joined, wallet_address, verification_status, is_crypto_verified, x_badge_type, ai_verification_notes",
      )
      .eq("id", user.id)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load profile verification");
    if (!row.data) throw new HttpError(404, "Profile not found");

    const notes = (row.data.ai_verification_notes ?? {}) as Record<string, unknown>;
    const xUsernameSet = Boolean(row.data.x_username?.trim());
    const xFollowed = row.data.x_followed === true;
    const tgJoined = row.data.tg_joined === true;
    const walletLinked = walletValid(row.data.wallet_address as string | null);
    const verificationStatus = (row.data.verification_status as string | null) ?? null;
    const isCryptoVerified = row.data.is_crypto_verified === true;
    const eligibilityPassed = isCryptoVerified && verificationStatus === "verified";
    const socialGatesComplete = xFollowed && tgJoined;
    const payoutGatesComplete = socialGatesComplete && walletLinked;

    const flags = {
      xUsernameSet,
      xFollowed,
      tgJoined,
      walletLinked,
      verificationStatus,
      isCryptoVerified,
      eligibilityPassed,
      socialGatesComplete,
      payoutGatesComplete,
    };

    const pending = buildPending({
      xUsernameSet,
      xFollowed,
      tgJoined,
      walletLinked,
      isCryptoVerified,
      verificationStatus,
    });

    const profileBadges = buildProfileBadges(
      row.data.x_badge_type as string | null,
      isCryptoVerified,
      verificationStatus,
    );

    res.json({
      ok: true,
      status: pending.length === 0 ? "complete" : "pending",
      flags,
      pending,
      lastEligibilityCheckAt: (notes.eligibilityLastCheckAt as string | undefined) ?? null,
      xBadgeType: profileBadges.xBadgeType,
      raidHiveVerified: profileBadges.raidHiveVerified,
      badges: profileBadges.badges,
    });
  } catch (error) {
    next(error);
  }
});

export default router;