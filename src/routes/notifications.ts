import { Router } from "express";
import { supabase, throwDb } from "../config.js";
import { currentUser, requireUser } from "../middleware/auth.js";

const router = Router();
router.use(requireUser);

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  href?: string;
};

router.get("/", async (req, res, next) => {
  try {
    const user = currentUser(req);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const items: NotificationItem[] = [];

    const [payouts, submissions, campaigns] = await Promise.all([
      supabase
        .from("payout_requests")
        .select("id, status, created_at, net_amount_usdc")
        .eq("user_id", user.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("submissions")
        .select("id, status, created_at, campaign_id, earned_usdc")
        .eq("raider_id", user.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("campaigns")
        .select("id, project_name, status, ends_at, created_at")
        .eq("founder_id", user.id)
        .in("status", ["awaiting_deposit", "active"])
        .gte("created_at", since)
        .limit(20),
    ]);

    if (payouts.error) throwDb(payouts.error, "load payout notifications");
    if (submissions.error) throwDb(submissions.error, "load submission notifications");
    if (campaigns.error) throwDb(campaigns.error, "load campaign notifications");

    for (const row of payouts.data ?? []) {
      if (row.status === "queued") {
        items.push({
          id: `payout:${row.id}`,
          type: "payout_queued",
          title: "Payout queued",
          body: "Your USDC withdrawal is waiting for processing.",
          read: false,
          createdAt: row.created_at as string,
        });
      } else if (row.status === "paid") {
        items.push({
          id: `payout:${row.id}:paid`,
          type: "payout_paid",
          title: "Payout sent",
          body: `Your payout of ${row.net_amount_usdc} USDC was processed.`,
          read: false,
          createdAt: row.created_at as string,
        });
      } else if (row.status === "rejected") {
        items.push({
          id: `payout:${row.id}:rejected`,
          type: "payout_rejected",
          title: "Payout not completed",
          body: "A payout request was rejected. Check details in your wallet page.",
          read: false,
          createdAt: row.created_at as string,
        });
      }
    }

    for (const row of submissions.data ?? []) {
      if (row.status === "verified") {
        items.push({
          id: `submission:${row.id}:verified`,
          type: "raid_verified",
          title: "Raid verified",
          body: "Your raid passed verification and is in the vesting window.",
          read: false,
          createdAt: row.created_at as string,
          href: `/campaigns/${row.campaign_id}`,
        });
      } else if (row.status === "rejected") {
        items.push({
          id: `submission:${row.id}:rejected`,
          type: "raid_rejected",
          title: "Raid needs a new try",
          body: "Your raid was rejected. You can resubmit if the campaign is still active.",
          read: false,
          createdAt: row.created_at as string,
          href: `/campaigns/${row.campaign_id}`,
        });
      }
    }

    for (const row of campaigns.data ?? []) {
      if (row.status === "awaiting_deposit") {
        items.push({
          id: `campaign:${row.id}:deposit`,
          type: "campaign_awaiting_deposit",
          title: "Finish campaign funding",
          body: `Complete the USDC deposit for ${row.project_name ?? "your campaign"}.`,
          read: false,
          createdAt: row.created_at as string,
        });
      }
    }

    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    res.json({ ok: true, notifications: items, unreadCount: items.length });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/read", async (req, res, next) => {
  try {
    res.json({ ok: true, id: req.params.id, read: true });
  } catch (error) {
    next(error);
  }
});

router.post("/read-all", async (req, res, next) => {
  try {
    currentUser(req);
    res.json({ ok: true, read: true });
  } catch (error) {
    next(error);
  }
});

export default router;