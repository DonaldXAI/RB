import { Router } from "express";
import { z } from "zod";
import { AD_PRICE_USDC, config, HttpError, parseBody, parseParams, supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";
import { adsActionLimiter, adsBookLimiter } from "../middleware/rateLimits.js";
import { verifyUsdcTransfer } from "../services/helius.js";

const router = Router();

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "URL must use https");

const txSignature = z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{64,128}$/);
const bookingId = z.string().uuid();

router.post("/reserve", requireUser, adsBookLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    parseBody(z.object({}).strict().optional().default({}), req.body ?? {});

    const reserved = await supabase.rpc("reserve_ad_banner_slot", { p_user_id: user.id });
    if (reserved.error) throwDb(reserved.error, "reserve ad");

    const row = await supabase
      .from("ad_banner_bookings")
      .select("id, status, expires_at")
      .eq("id", reserved.data as string)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load reservation");

    res.status(201).json({ ok: true, reservation: row.data });
  } catch (error) {
    next(error);
  }
});

router.post("/book", requireUser, adsBookLimiter, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const body = parseBody(
      z.object({
        reservationId: bookingId,
        headline: z.string().trim().min(1).max(80),
        imageUrl: httpsUrl,
        targetUrl: httpsUrl,
        txSignature,
      }),
      req.body,
    );

    const used = await supabase.from("used_transactions").select("signature").eq("signature", body.txSignature).maybeSingle();
    if (used.error) throwDb(used.error, "check ad transaction");
    if (used.data) throw new HttpError(409, "Transaction signature was already used");

    const transfer = await verifyUsdcTransfer(body.txSignature, [
      { destinationWallet: config.REVENUE_WALLET_ADDRESS, minAmountUsdc: AD_PRICE_USDC },
    ]);
    if (!transfer.verified) throw new HttpError(400, "Ad payment could not be verified");

    const booked = await supabase.rpc("confirm_ad_banner_booking", {
      p_reservation_id: body.reservationId,
      p_user_id: user.id,
      p_headline: body.headline,
      p_image_url: body.imageUrl,
      p_target_url: body.targetUrl,
      p_tx_signature: body.txSignature,
    });
    if (booked.error) throwDb(booked.error, "book ad");

    const row = await supabase.from("ad_banner_bookings").select("*").eq("id", booked.data as string).maybeSingle();
    if (row.error) throwDb(row.error, "load ad booking");
    res.status(201).json({ ok: true, booking: row.data });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/impression", adsActionLimiter, async (req, res, next) => {
  try {
    const id = parseParams(bookingId, req.params.id);
    const bumped = await supabase.rpc("bump_ad_stat", { p_id: id, p_field: "impressions" });
    if (bumped.error) throwDb(bumped.error, "count impression");
    res.json({ ok: true, impressions: bumped.data });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/click", adsActionLimiter, async (req, res, next) => {
  try {
    const id = parseParams(bookingId, req.params.id);
    const bumped = await supabase.rpc("bump_ad_stat", { p_id: id, p_field: "clicks" });
    if (bumped.error) throwDb(bumped.error, "count click");
    res.json({ ok: true, clicks: bumped.data });
  } catch (error) {
    next(error);
  }
});

export default router;