import { Router } from "express";
import { z } from "zod";
import { HttpError, parseParams, supabase, throwDb } from "../config.js";
import { mapReputation, reputationColumns } from "../lib/reputation.js";
import { currentUser, requireUser } from "../middleware/auth.js";

const router = Router();

const ProfileId = z.string().uuid();

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