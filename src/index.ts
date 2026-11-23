import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cron from "node-cron";
import { config, HttpError, REFERRAL_VEST_BONUS_USDC, supabase } from "./config.js";
import adminRouter from "./routes/admin.js";
import adsRouter from "./routes/ads.js";
import campaignsRouter from "./routes/campaigns.js";
import payoutsRouter from "./routes/payouts.js";
import raidsRouter from "./routes/raids.js";
import socialRouter from "./routes/social.js";
import { readEscrowUsdcBalance, readOwedObligationsUsdc } from "./services/escrow.js";

const PRODUCTION_ORIGINS = [
  "https://raidhive.xyz",
  "https://www.raidhive.xyz",
  "https://raidhive.lovable.app",
] as const;

const allowedOrigins = new Set<string>([...PRODUCTION_ORIGINS, config.FRONTEND_ORIGIN]);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed"));
    },
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

app.use("/api/campaigns", campaignsRouter);
app.use("/api/raids", raidsRouter);
app.use("/api/social", socialRouter);
app.use("/api/payouts", payoutsRouter);
app.use("/api/ads", adsRouter);
app.use("/api/admin", adminRouter);

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

async function rotateAdBanners(): Promise<{ completed: number; promoted: number }> {
  const now = new Date().toISOString();
  const completed = await supabase
    .from("ad_banner_bookings")
    .update({ status: "completed" })
    .eq("status", "active")
    .lte("ends_at", now)
    .select("id");
  if (completed.error) throw new Error(completed.error.message);

  const active = await supabase.from("ad_banner_bookings").select("id").eq("status", "active").limit(1);
  if (active.error) throw new Error(active.error.message);
  if (active.data?.length) return { completed: completed.data?.length ?? 0, promoted: 0 };

  const next = await supabase
    .from("ad_banner_bookings")
    .select("id")
    .eq("status", "queued")
    .lte("starts_at", now)
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (next.error) throw new Error(next.error.message);
  if (!next.data) return { completed: completed.data?.length ?? 0, promoted: 0 };

  const promoted = await supabase
    .from("ad_banner_bookings")
    .update({ status: "active" })
    .eq("id", next.data.id)
    .eq("status", "queued")
    .select("id");
  if (promoted.error) throw new Error(promoted.error.message);
  return { completed: completed.data?.length ?? 0, promoted: promoted.data?.length ?? 0 };
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

async function checkEscrowSolvency(): Promise<void> {
  if (!config.ADMIN_TELEGRAM_CHAT_ID) return;
  try {
    const [balance, owed] = await Promise.all([readEscrowUsdcBalance(), readOwedObligationsUsdc()]);
    if (balance + 0.000001 >= owed) return;
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