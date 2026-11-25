import { Router } from "express";
import { z } from "zod";
import { HttpError, parseParams, supabase, throwDb } from "../config.js";
import { adsActionLimiter } from "../middleware/rateLimits.js";

const router = Router();
const bookingId = z.string().uuid();

async function recordClick(id: string): Promise<{ targetUrl: string; clicks: number }> {
  const row = await supabase
    .from("ad_banner_bookings")
    .select("id, target_url, status")
    .eq("id", id)
    .maybeSingle();
  if (row.error) throwDb(row.error, "load ad for click");
  if (!row.data) throw new HttpError(404, "Ad not found");
  if (row.data.status !== "active" && row.data.status !== "queued") {
    throw new HttpError(404, "Ad link is not active");
  }
  if (!row.data.target_url) throw new HttpError(404, "Ad has no target URL");

  const bumped = await supabase.rpc("bump_ad_stat", { p_id: id, p_field: "clicks" });
  if (bumped.error) throwDb(bumped.error, "count click");

  return {
    targetUrl: row.data.target_url as string,
    clicks: Number(bumped.data ?? 0),
  };
}

router.get("/:id", adsActionLimiter, async (req, res, next) => {
  try {
    const id = parseParams(bookingId, req.params.id);
    const result = await recordClick(id);
    res.json({
      ok: true,
      bookingId: id,
      url: result.targetUrl,
      targetUrl: result.targetUrl,
      clicks: result.clicks,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/:id", adsActionLimiter, async (req, res, next) => {
  try {
    const id = parseParams(bookingId, req.params.id);
    const result = await recordClick(id);
    res.json({ ok: true, bookingId: id, url: result.targetUrl, clicks: result.clicks });
  } catch (error) {
    next(error);
  }
});

export default router;