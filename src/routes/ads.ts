import { Router } from "express";
import { z } from "zod";
import {
  AD_DURATION_HOURS,
  AD_PRICE_USDC,
  AD_QUEUE_SLOT_COUNT,
  AD_VISIBLE_SLOT_COUNT,
  config,
  HttpError,
  parseBody,
  parseParams,
  supabase,
  throwDb,
} from "../config.js";
import { padAdSections } from "../lib/adSlots.js";
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

const publicAdColumns =
  "id, user_id, headline, image_url, target_url, status, starts_at, ends_at, impressions, clicks, expires_at, created_at";

type AdRow = Record<string, unknown>;

router.get("/slots", async (_req, res, next) => {
  try {
    const active = await supabase
      .from("ad_banner_bookings")
      .select(publicAdColumns)
      .eq("status", "active")
      .order("starts_at", { ascending: true })
      .limit(AD_VISIBLE_SLOT_COUNT);
    if (active.error) throwDb(active.error, "load active ads");

    const queued = await supabase
      .from("ad_banner_bookings")
      .select(publicAdColumns)
      .eq("status", "queued")
      .order("starts_at", { ascending: true })
      .limit(AD_QUEUE_SLOT_COUNT);
    if (queued.error) throwDb(queued.error, "load queued ads");

    const visibleRows = (active.data ?? []) as AdRow[];
    const queueRows = (queued.data ?? []) as AdRow[];
    const padded = padAdSections(visibleRows, queueRows);

    res.json({
      ok: true,
      slotCount: AD_VISIBLE_SLOT_COUNT + AD_QUEUE_SLOT_COUNT,
      visibleSlotCount: AD_VISIBLE_SLOT_COUNT,
      queueSlotCount: AD_QUEUE_SLOT_COUNT,
      priceUsdc: AD_PRICE_USDC,
      durationHours: AD_DURATION_HOURS,
      visible: padded.visible,
      queue: padded.queue,
      slots: padded.slots,
      slotMeta: padded.slotMeta,
      /** @deprecated use visible + queue */
      active: visibleRows[0] ?? null,
      filledCount: padded.slots.filter(Boolean).length,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/my-ads", requireUser, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const rows = await supabase
      .from("ad_banner_bookings")
      .select(publicAdColumns + ", tx_signature")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (rows.error) throwDb(rows.error, "load my ads");
    res.json({ ok: true, ads: rows.data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.get("/reservations/current", requireUser, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const row = await supabase
      .from("ad_banner_bookings")
      .select(publicAdColumns)
      .eq("user_id", user.id)
      .eq("status", "reserved")
      .order("expires_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load ad reservation");
    res.json({ ok: true, reservation: row.data });
  } catch (error) {
    next(error);
  }
});

router.delete("/reservations/:id", requireUser, async (req, res, next) => {
  try {
    const user = currentUser(req);
    const id = parseParams(bookingId, req.params.id);
    const updated = await supabase
      .from("ad_banner_bookings")
      .update({ status: "expired" })
      .eq("id", id)
      .eq("user_id", user.id)
      .eq("status", "reserved")
      .select("id, status")
      .maybeSingle();
    if (updated.error) throwDb(updated.error, "cancel ad reservation");
    if (!updated.data) throw new HttpError(404, "Ad reservation not found");
    res.json({ ok: true, reservation: updated.data });
  } catch (error) {
    next(error);
  }
});

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

    res.status(201).json({ ok: true, reservation: row.data, priceUsdc: AD_PRICE_USDC, durationHours: AD_DURATION_HOURS });
  } catch (error) {
    next(error);
  }
});

router.post("/clicks", adsActionLimiter, async (req, res, next) => {
  try {
    const body = parseBody(
      z
        .object({
          id: bookingId.optional(),
          bookingId: bookingId.optional(),
        })
        .refine((value) => Boolean(value.id ?? value.bookingId), { message: "id is required" }),
      req.body,
    );
    const id = (body.bookingId ?? body.id)!;
    const bumped = await supabase.rpc("bump_ad_stat", { p_id: id, p_field: "clicks" });
    if (bumped.error) throwDb(bumped.error, "count click");
    res.json({ ok: true, clicks: bumped.data });
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

    const row = await supabase.from("ad_banner_bookings").select(publicAdColumns + ", tx_signature").eq("id", booked.data as string).maybeSingle();
    if (row.error) throwDb(row.error, "load ad booking");
    res.status(201).json({ ok: true, booking: row.data, priceUsdc: AD_PRICE_USDC, durationHours: AD_DURATION_HOURS });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/click", adsActionLimiter, async (req, res, next) => {
  try {
    const id = parseParams(bookingId, req.params.id);
    const row = await supabase
      .from("ad_banner_bookings")
      .select("id, target_url, status")
      .eq("id", id)
      .maybeSingle();
    if (row.error) throwDb(row.error, "load ad");
    if (!row.data?.target_url) throw new HttpError(404, "Ad not found");
    const bumped = await supabase.rpc("bump_ad_stat", { p_id: id, p_field: "clicks" });
    if (bumped.error) throwDb(bumped.error, "count click");
    res.json({ ok: true, url: row.data.target_url, targetUrl: row.data.target_url, clicks: bumped.data });
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