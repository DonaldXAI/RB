import { config } from "./config.js";

export const PRODUCTION_ORIGINS = [
  "https://raidhive.xyz",
  "https://www.raidhive.xyz",
  "https://raidhive.lovable.app",
] as const;

/** Browsers preflight these on cross-origin admin + authenticated API calls. */
export const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "x-admin-wallet",
  "x-admin-message",
  "x-admin-signature",
  "x-admin-nonce",
  "x-admin-timestamp",
] as const;

/** Exact origin allowlist used by the CORS middleware (env + defaults). */
export function listAllowedOrigins(): string[] {
  const set = new Set<string>([...PRODUCTION_ORIGINS, config.FRONTEND_ORIGIN, ...config.corsExtraOrigins]);
  return [...set].sort();
}

export function allowedOriginsSet(): Set<string> {
  return new Set(listAllowedOrigins());
}