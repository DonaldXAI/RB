import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cron from "node-cron";
import { allowedOriginsSet, CORS_ALLOWED_HEADERS } from "./corsPolicy.js";
import { AD_VISIBLE_SLOT_COUNT, config, HttpError, REFERRAL_VEST_BONUS_USDC, supabase } from "./config.js";
import accountRouter from "./routes/account.js";
import adminRouter from "./routes/admin.js";
import adsRouter from "./routes/ads.js";
import clickLinksRouter from "./routes/clickLinks.js";
import eligibilityRouter from "./routes/eligibility.js";
import campaignsRouter from "./routes/campaigns.js";
import foundersRouter from "./routes/founders.js";
import projectsRouter from "./routes/projects.js";
import reputationRouter from "./routes/reputation.js";
import notificationsRouter from "./routes/notifications.js";
import payoutsRouter from "./routes/payouts.js";
import { raidVerifyHandler } from "./routes/raids.js";
import raidsRouter from "./routes/raids.js";
import metaRouter from "./routes/meta.js";
import socialRouter from "./routes/social.js";
import { requireUser } from "./middleware/auth.js";
import { adminLimiter, raidsSubmitLimiter } from "./middleware/rateLimits.js";
import { readEscrowUsdcBalance, readOwedObligationsUsdc } from "./services/escrow.js";

const allowedOrigins = allowedOriginsSet();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed"));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: ["Content-Type"],
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", metaRouter);
app.use("/api/account", accountRouter);
app.use("/api/campaigns", campaignsRouter);
app.post("/api/verify", requireUser, raidsSubmitLimiter, raidVerifyHandler);
app.post("/verify", requireUser, raidsSubmitLimiter, raidVerifyHandler);
app.use("/api/raids", raidsRouter);
app.use("/api/eligibility", eligibilityRouter);
app.use("/api/founders", foundersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/social", socialRouter);
app.use("/api/payouts", payoutsRouter);
app.use("/api/ads", adsRouter);
app.use("/api/reputation", reputationRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/click-links", clickLinksRouter);
app.use("/api/admin", adminLimiter, adminRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    if (!res.headersSent) res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.message === "Origin is not allowed") {
    if (!res.headersSent) res.status(403).json({ error: "Forbidden" });
    return;
  }
  console.error("[http] unhandled", error);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong" });
});

async function releaseVestedRaids(): Promise<number> {
  const now = new Date().toISOString();
  const due = await supabase
    .from("submissions")
    .select("id")
    .eq("status", "verified")
    .eq("vested", false)
    .lte("vests_at", now)
    .order("vests_at", { ascending: true });
  if (due.error) throw new Error(due.error.message);

  let released = 0;
  for (const row of due.data ?? []) {
    const result = await supabase.rpc("release_vested_submission", {
      p_submission_id: row.id,
      p_referral_bonus: REFERRAL_VEST_BONUS_USDC,
    });
    if (result.error) {
      console.error(`[cron] vest ${row.id} failed: ${result.error.message}`);
      continue;
    }
    if (result.data === true) released += 1;
  }
  return released;
}

async function releaseExpiredAdReservations(): Promise<number> {
  const released = await supabase.rpc("release_expired_ad_reservations");
  if (released.error) throw new Error(released.error.message);
  return Number(released.data ?? 0);
}

async function countActiveAds(): Promise<number> {
  const active = await supabase.from("ad_banner_bookings").select("id", { count: "exact", head: true }).eq("status", "active");
  if (active.error) throw new Error(active.error.message);
  return active.count ?? 0;
}

async function rotateAdBanners(): Promise<{ completed: number; promoted: number }> {
  const now = new Date().toISOString();
  const completed = await supabase
    .from("ad_banner_bookings")
    .update({ status: "completed" })
    .eq("status", "active")
    .lte("ends_at", now)
    .select("id");
  if (completed.error) throw new Error(completed.error.message);

  let promoted = 0;
  for (let step = 0; step < AD_VISIBLE_SLOT_COUNT; step += 1) {
    const activeCount = await countActiveAds();
    if (activeCount >= AD_VISIBLE_SLOT_COUNT) break;

    const next = await supabase
      .from("ad_banner_bookings")
      .select("id")
      .eq("status", "queued")
      .lte("starts_at", now)
      .order("starts_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (next.error) throw new Error(next.error.message);
    if (!next.data) break;

    const move = await supabase
      .from("ad_banner_bookings")
      .update({ status: "active" })
      .eq("id", next.data.id)
      .eq("status", "queued")
      .select("id");
    if (move.error) throw new Error(move.error.message);
    if (move.data?.length) promoted += 1;
  }

  return { completed: completed.data?.length ?? 0, promoted };
}

async function expireCampaigns(): Promise<number> {
  const expired = await supabase
    .from("campaigns")
    .update({ status: "expired" })
    .eq("status", "active")
    .lte("ends_at", new Date().toISOString())
    .select("id");
  if (expired.error) throw new Error(expired.error.message);
  return expired.data?.length ?? 0;
}

const SOLVENCY_TELEGRAM_COOLDOWN_MS = 60 * 60 * 1000;
let lastSolvencyTelegramAt = 0;

async function checkEscrowSolvency(): Promise<void> {
  try {
    const [balance, owed] = await Promise.all([readEscrowUsdcBalance(), readOwedObligationsUsdc()]);
    if (balance + 0.000001 >= owed) return;

    console.error(
      `[solvency] UNDERFUNDED on-chain=${balance.toFixed(6)} USDC obligations=${owed.toFixed(6)} USDC escrow=${config.ESCROW_WALLET_ADDRESS}`,
    );

    if (!config.ADMIN_TELEGRAM_CHAT_ID) {
      console.error("[solvency] Set ADMIN_TELEGRAM_CHAT_ID on Render for Telegram alerts");
      return;
    }

    const now = Date.now();
    if (now - lastSolvencyTelegramAt < SOLVENCY_TELEGRAM_COOLDOWN_MS) return;
    lastSolvencyTelegramAt = now;

    const text = [
      "URGENT: RaidHive escrow is underfunded.",
      `On-chain balance: ${balance.toFixed(2)} USDC`,
      `Recorded obligations: ${owed.toFixed(2)} USDC`,
      `Escrow: ${config.ESCROW_WALLET_ADDRESS}`,
    ].join("\n");
    const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.ADMIN_TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) console.error(`[cron] solvency alert failed: HTTP ${response.status}`);
  } catch (error) {
    console.error("[cron] solvency check failed", error);
  }
}

let maintenanceRunning = false;
async function runMaintenance(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const vested = await releaseVestedRaids();
    const reservations = await releaseExpiredAdReservations();
    const ads = await rotateAdBanners();
    const expired = await expireCampaigns();
    await checkEscrowSolvency();
    if (vested || reservations || ads.completed || ads.promoted || expired) {
      console.log(
        `[cron] vested ${vested}, reservations released ${reservations}, ads completed ${ads.completed}, ads promoted ${ads.promoted}, campaigns expired ${expired}`,
      );
    }
  } catch (error) {
    console.error("[cron] maintenance failed", error);
  } finally {
    maintenanceRunning = false;
  }
}

const maintenance = cron.schedule("*/5 * * * *", () => {
  void runMaintenance();
});

const server = app.listen(config.PORT, () => {
  console.log(`[raidhive] listening on ${config.PORT}`);
});

function shutdown(): void {
  maintenance.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);