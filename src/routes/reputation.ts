import { Router } from "express";
import { z } from "zod";
import { asUsdc, HttpError, parseParams, supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";

const router = Router();

const ProfileId = z.string().uuid();

function mapReputation(row: Record<string, unknown>) {
  const strikes = Number(row.strikes ?? 0);
  const tier = (row.raider_tier as string | null) ?? "bronze";
  return {
    profileId: row.id,
    xUsername: row.x_username ?? null,
    displayName: row.display_name ?? null,
    raiderTier: tier,
    strikes,
    badgeType: row.x_badge_type ?? "none",
    badgeMultiplier: asUsdc(row.badge_multiplier ?? 1),
    xFollowers: Number(row.x_followers ?? 0),
    totalEarnedUsdc: asUsdc(row.total_earned_usdc ?? 0),
    xFollowed: row.x_followed === true,
    tgJoined: row.tg_joined === true,
    isBanned: row.is_banned === true,
    reputationScore: Math.max(0, 100 - strikes * 15),
    level:
      strikes >= 3 ? "restricted" : tier === "gold" ? "elite" : tier === "silver" ? "trusted" : "standard",
  };
}

const reputationColumns =
  "id, x_username, display_name, raider_tier, strikes, x_badge_type, badge_multiplier, x_followers, total_earned_usdc, x_followed, tg_joined, is_banned";

router.get("/me", requireUser, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const row = await supabase.from("profiles").select(reputationColumns).eq("id", user.id).maybeSingle();
    if (row.error) throwDb(row.error, "load reputation");
    if (!row.data) throw new HttpError(404, "Profile not found");
    res.json({ ok: true, reputation: mapReputation(row.data as Record<string, unknown>) });
  } catch (error) {
    next(error);
  }
});

router.get("/:profileId", async (req, res, next) => {
  try {
    const profileId = parseParams(ProfileId, req.params.profileId);
    const row = await supabase
      .from("profiles")
      .select(reputationColumns)
      .eq("id", profileId)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load reputation");
    if (!row.data) throw new HttpError(404, "Profile not found");
    res.json({ ok: true, reputation: mapReputation(row.data as Record<string, unknown>) });
  } catch (error) {
    next(error);
  }
});

export default router;