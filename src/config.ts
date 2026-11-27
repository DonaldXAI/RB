import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}
import bs58 from "bs58";
import OpenAI from "openai";
import { z } from "zod";
import { assertKeylessEnvironment, assertProductionOrigins } from "./security/keylessEnv.js";

export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  FRONTEND_ORIGIN: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  HELIUS_API_KEY: z.string().min(1),
  ESCROW_WALLET_ADDRESS: z.string().min(32),
  REVENUE_WALLET_ADDRESS: z.string().min(32),
  USDC_MINT_ADDRESS: z.string().min(32).default(MAINNET_USDC_MINT),
  TWITTERAPI_IO_KEY: z.string().min(1),
  OFFICIAL_X_USERNAME: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  ADMIN_TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  /** Comma-separated https origins (e.g. Lovable preview URLs). */
  CORS_EXTRA_ORIGINS: z.string().optional().default(""),
});

function parseCorsExtraOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function publicAddress(value: string, name: string): string {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) throw new Error(`${name} must be a public wallet address`);
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 32) throw new Error("wrong length");
    return new PublicKey(decoded).toBase58();
  } catch {
    throw new Error(`${name} is not a Solana public wallet address`);
  }
}

function loadConfig() {
  assertKeylessEnvironment(process.env);
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${fields}`);
  }

  const data = parsed.data;
  const usdcMint = publicAddress(data.USDC_MINT_ADDRESS, "USDC_MINT_ADDRESS");
  if (usdcMint !== MAINNET_USDC_MINT) {
    throw new Error(`USDC_MINT_ADDRESS must be mainnet USDC (${MAINNET_USDC_MINT})`);
  }
  const corsExtraOrigins: string[] = [];
  for (const origin of parseCorsExtraOrigins(data.CORS_EXTRA_ORIGINS ?? "")) {
    if (!origin.startsWith("https://")) {
      throw new Error(`CORS_EXTRA_ORIGINS entries must use https:// (${origin})`);
    }
    corsExtraOrigins.push(origin);
  }
  assertProductionOrigins(data.FRONTEND_ORIGIN, corsExtraOrigins);

  if (process.env.NODE_ENV === "production" && !data.ADMIN_TELEGRAM_CHAT_ID) {
    console.warn("[config] ADMIN_TELEGRAM_CHAT_ID is unset; escrow underfunding will only appear in logs");
  }

  return {
    ...data,
    corsExtraOrigins,
    ESCROW_WALLET_ADDRESS: publicAddress(data.ESCROW_WALLET_ADDRESS, "ESCROW_WALLET_ADDRESS"),
    REVENUE_WALLET_ADDRESS: publicAddress(data.REVENUE_WALLET_ADDRESS, "REVENUE_WALLET_ADDRESS"),
    USDC_MINT_ADDRESS: MAINNET_USDC_MINT,
    OFFICIAL_X_USERNAME: data.OFFICIAL_X_USERNAME.trim().replace(/^@/, ""),
  };
}

export const config = loadConfig();

export const GAS_FEE_USDC = 0.15;
export const MIN_PAYOUT_USDC = 2;
export const AD_PRICE_USDC = 100;
/** Home banner: 1 live slot + 5 queued slots (Lovable expects a fixed-size list). */
export const AD_BANNER_SLOT_COUNT = 6;
export const VESTING_HOURS = 12;
export const REFERRAL_DEPOSIT_RATE = 0.02;
export const REFERRAL_VEST_BONUS_USDC = 0.05;
export const PLATFORM_FEE_RATE = 0.1;
export const USDC_DECIMALS = 6;

export const RAID_ACTIONS = ["follow", "repost", "reply", "quote", "post"] as const;
export type RaidAction = (typeof RAID_ACTIONS)[number];
export const GRADED_ACTIONS = new Set<RaidAction>(["reply", "quote", "post"]);

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const solanaConnection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
  "confirmed",
);

export const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function asUsdc(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 10 ** USDC_DECIMALS) / 10 ** USDC_DECIMALS;
}

export function assertWalletAddress(value: string): string {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) throw new HttpError(400, "Send a public wallet address, not a seed phrase");
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 32) throw new Error("wrong length");
    return new PublicKey(decoded).toBase58();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Wallet address is not a valid Solana public key");
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    console.error("[validation] body", result.error.flatten());
    throw new HttpError(400, "Invalid request");
  }
  return result.data;
}

export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    console.error("[validation] params", result.error.flatten());
    throw new HttpError(400, "Invalid request");
  }
  return result.data;
}

export function recalculateCampaignDepositFees(campaign: {
  total_budget_usdc: unknown;
  boost_fee_usdc?: unknown;
  bundle_boost_fee_usdc?: unknown;
}): { escrowUsdc: number; platformFeeUsdc: number; boostFeeUsdc: number; revenueUsdc: number } {
  const escrowUsdc = asUsdc(campaign.total_budget_usdc);
  const platformFeeUsdc = asUsdc(escrowUsdc * PLATFORM_FEE_RATE);
  const bundle = campaign.bundle_boost_fee_usdc ?? campaign.boost_fee_usdc ?? 0;
  const boostFeeUsdc = asUsdc(bundle);
  return {
    escrowUsdc,
    platformFeeUsdc,
    boostFeeUsdc,
    revenueUsdc: asUsdc(platformFeeUsdc + boostFeeUsdc),
  };
}

export function clientIp(req: { ip?: string; headers: Record<string, unknown> }): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0]?.trim() ?? null;
  if (Array.isArray(forwarded) && forwarded[0]) return String(forwarded[0]).split(",")[0]?.trim() ?? null;
  return req.ip ?? null;
}

const DB_MESSAGES: Record<string, { status: number; message: string }> = {
  BUDGET_NOT_RESERVED: { status: 409, message: "Campaign budget is no longer available" },
  NOT_OWNER: { status: 403, message: "You do not own this campaign" },
  NOT_AWAITING_DEPOSIT: { status: 409, message: "Campaign is not awaiting a deposit" },
  NOT_EXPIRED: { status: 409, message: "Campaign has not ended" },
  NOT_REFUNDABLE: { status: 409, message: "Campaign cannot be refunded" },
  FEE_EXCEEDS_BUDGET: { status: 400, message: "Remaining budget does not cover the 0.15 USDC network fee" },
  REFUND_ALREADY_QUEUED: { status: 409, message: "A refund is already queued for this campaign" },
  WALLET_REQUIRED: { status: 400, message: "No public wallet is linked to this profile" },
  PROFILE_NOT_FOUND: { status: 404, message: "Profile not found" },
  BANNED: { status: 403, message: "This profile is banned" },
  TOO_MANY_STRIKES: { status: 403, message: "Payouts are locked after 3 strikes" },
  SOCIAL_GATES: { status: 403, message: "Verify X and Telegram before requesting a payout" },
  INSUFFICIENT_AVAILABLE: { status: 400, message: "Available balance is too low" },
  NET_NOT_POSITIVE: { status: 400, message: "Payout does not cover the network fee" },
  PAYOUT_NOT_QUEUED: { status: 409, message: "Payout request is no longer queued" },
  TX_USED: { status: 409, message: "Transaction signature was already used" },
  SUBMISSION_NOT_FOUND: { status: 404, message: "Submission not found" },
  ALREADY_VERIFIED: { status: 409, message: "Submission is already verified" },
  NO_PAYOUT_AMOUNT: { status: 409, message: "Submission has no payout amount to approve" },
  PENDING_TOO_LOW: { status: 409, message: "Pending balance is lower than this submission" },
  AD_NOT_FOUND: { status: 404, message: "Ad banner not found" },
  BAD_FIELD: { status: 400, message: "Unknown ad counter" },
  BAD_ACTION: { status: 400, message: "Unknown moderation action" },
  BAD_DECISION: { status: 400, message: "Unknown decision" },
  SELF_REFERRAL: { status: 409, message: "Referral bonus was not applied" },
  RESERVATION_NOT_FOUND: { status: 404, message: "Ad reservation not found" },
  RESERVATION_EXPIRED: { status: 409, message: "Ad reservation has expired" },
  RESERVATION_IN_USE: { status: 409, message: "Ad slot is temporarily reserved" },
};

export function throwDb(error: { message: string; code?: string }, scope: string): never {
  console.error(`[db] ${scope}: ${error.message}`);
  const msg = error.message.toLowerCase();
  if (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    (msg.includes("column") && msg.includes("does not exist")) ||
    msg.includes("could not find the")
  ) {
    throw new HttpError(
      503,
      "Database is missing eligibility columns. Run sql/profiles_eligibility_badge.sql in Supabase, then retry.",
    );
  }
  if (error.code === "23505") {
    if (error.message.includes("submissions_campaign_raider")) {
      throw new HttpError(409, "You already submitted a raid for this campaign");
    }
    if (error.message.includes("profiles_wallet")) {
      throw new HttpError(409, "That wallet is already linked to another profile");
    }
    if (error.message.includes("used_transactions") || error.message.includes("deposit_tx_hash") || error.message.includes("tx_signature")) {
      throw new HttpError(409, "Transaction signature was already used");
    }
    if (error.message.includes("ad_banner_one_active")) {
      throw new HttpError(409, "Another banner is already active");
    }
    throw new HttpError(409, "This record already exists");
  }
  for (const [code, mapped] of Object.entries(DB_MESSAGES)) {
    if (error.message.includes(code)) throw new HttpError(mapped.status, mapped.message);
  }
  throw new HttpError(500, "Something went wrong");
}
