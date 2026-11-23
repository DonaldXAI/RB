import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config, HttpError } from "../config.js";

const ACTIVE = new Set(["member", "administrator", "creator"]);
const LOGIN_MAX_AGE_SECONDS = 86_400;

type ChatMemberResponse = {
  ok: boolean;
  description?: string;
  result?: { status?: string };
};

export type TelegramLoginPayload = Record<string, string | number>;

function loginCheckString(payload: TelegramLoginPayload): string {
  return Object.entries(payload)
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function verifyTelegramLoginWidget(payload: TelegramLoginPayload): boolean {
  const hash = String(payload.hash ?? "");
  if (!hash) return false;

  const authDate = Number(payload.auth_date);
  if (!Number.isFinite(authDate)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > LOGIN_MAX_AGE_SECONDS) return false;

  const secret = createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(loginCheckString(payload)).digest("hex");

  try {
    const provided = Buffer.from(hash, "hex");
    const target = Buffer.from(expected, "hex");
    if (provided.length !== target.length) return false;
    return timingSafeEqual(provided, target);
  } catch {
    return false;
  }
}

export async function verifyChannelMembership(telegramUserId: string | number): Promise<boolean> {
  const url = new URL(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getChatMember`);
  url.searchParams.set("chat_id", config.TELEGRAM_CHANNEL_ID);
  url.searchParams.set("user_id", String(telegramUserId));

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    console.error("[telegram] getChatMember failed", error);
    throw new HttpError(502, "Telegram lookup failed");
  }

  const body = (await response.json().catch(() => null)) as ChatMemberResponse | null;
  if (!response.ok && response.status >= 500) throw new HttpError(502, "Telegram lookup failed");
  if (!body?.ok || !body.result?.status) return false;
  return ACTIVE.has(body.result.status);
}