import { Router } from "express";
import { z } from "zod";
import { HttpError, parseBody, supabase, throwDb } from "../config.js";
import { currentUser, requireUser, touchProfileIp } from "../middleware/auth.js";
import { assessBotRisk } from "../services/openai.js";
import { getUserProfile } from "../services/twitter.js";

const router = Router();
router.use(requireUser);

const DAY_MS = 24 * 60 * 60 * 1000;

type ProfileRow = {
  id: string;
  x_username: string | null;
  verification_status?: string | null;
  is_crypto_verified?: boolean | null;
  ai_verification_notes?: Record<string, unknown> | null;
};

function lastEligibilityCheckAt(notes: Record<string, unknown> | null | undefined): number | null {
  const raw = notes?.eligibilityLastCheckAt;
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

router.post("/verify", async (req, res, next) => {
  try {
    const user = currentUser(req);
    await touchProfileIp(user.id, req);
    parseBody(z.object({}).strict(), req.body ?? {});

    const loaded = await supabase
      .from("profiles")
      .select("id, x_username, verification_status, is_crypto_verified, ai_verification_notes")
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
    const startedNotes = {
      ...notes,
      eligibilityStatus: "started",
      eligibilityStartedAt: startedAt,
    };
    const started = await supabase
      .from("profiles")
      .update({
        verification_status: "pending",
        ai_verification_notes: startedNotes,
      })
      .eq("id", user.id);
    if (started.error) throwDb(started.error, "mark eligibility started");

    const xProfile = await getUserProfile(xUsername);
    const risk = await assessBotRisk(xProfile);
    const passed = !risk.isBotLikely;
    const finishedAt = new Date().toISOString();

    const resultNotes = {
      ...startedNotes,
      eligibilityStatus: passed ? "passed" : "failed",
      eligibilityLastCheckAt: finishedAt,
      eligibility: {
        checkedAt: finishedAt,
        isBotLikely: risk.isBotLikely,
        reason: risk.reason,
        followers: xProfile.followers,
        following: xProfile.following,
        tweetCount: xProfile.tweetCount,
        ageDays: xProfile.ageDays,
      },
    };

    const saved = await supabase
      .from("profiles")
      .update({
        x_followers: xProfile.followers,
        verification_status: passed ? "verified" : "rejected",
        is_crypto_verified: passed,
        ai_verification_notes: resultNotes,
      })
      .eq("id", user.id)
      .select("id, verification_status, is_crypto_verified, x_followers")
      .single();
    if (saved.error) throwDb(saved.error, "save eligibility result");

    if (!passed) throw new HttpError(403, "Eligibility check did not pass");

    res.json({
      ok: true,
      verificationStatus: saved.data.verification_status,
      isCryptoVerified: saved.data.is_crypto_verified,
    });
  } catch (error) {
    next(error);
  }
});

export default router;