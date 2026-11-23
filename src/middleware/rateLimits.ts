import type { Request } from "express";
import rateLimit, { type Options } from "express-rate-limit";

function clientKey(req: Request): string {
  const userId = req.user?.id;
  if (userId) return `user:${userId}`;
  return `ip:${req.ip ?? "unknown"}`;
}

function limiter(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
    ...options,
  });
}

export const raidsSubmitLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 8,
  keyGenerator: clientKey,
});

export const payoutsRequestLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: clientKey,
});

export const socialVerifyLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: clientKey,
});

export const adsActionLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => req.ip ?? "unknown",
});

export const adsBookLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: clientKey,
});