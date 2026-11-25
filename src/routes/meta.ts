import { Router } from "express";

const router = Router();

/** Lets the frontend confirm deployed API routes (e.g. after Railway deploy). */
router.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "raidhive-backend",
    routes: [
      "GET /health",
      "GET /api",
      "GET /api/ads/slots",
      "GET /api/ads/my-ads",
      "GET /api/ads/reservations/current",
      "DELETE /api/ads/reservations/:id",
      "POST /api/ads/reserve",
      "POST /api/ads/book",
      "POST /api/verify",
      "POST /verify",
      "POST /api/raids/submit",
      "POST /api/raids/resubmit",
      "GET /api/founders/performance",
      "GET /api/notifications",
      "GET /api/notifications/preferences",
      "POST /api/notifications/preferences",
      "PATCH /api/notifications/:id/read",
      "POST /api/notifications/read-all",
      "GET /api/campaigns/:campaignId/submissions",
      "POST /api/campaigns/verify-deposit",
      "POST /api/social/verify-x",
      "POST /api/payouts/request",
    ],
  });
});

export default router;