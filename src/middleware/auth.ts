import type { NextFunction, Request, Response } from "express";
import { clientIp, HttpError, supabase } from "../config.js";

export type AuthUser = {
  id: string;
  email: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function touchProfileIp(userId: string, req: Request): Promise<void> {
  const ip = clientIp(req);
  if (!ip) return;
  const update = await supabase.from("profiles").update({ last_ip: ip }).eq("id", userId);
  if (update.error) console.error(`[auth] last_ip update failed: ${update.error.message}`);
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) throw new HttpError(401, "Missing bearer token");

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) throw new HttpError(401, "Invalid session");

    const profile = await supabase.from("profiles").select("is_banned").eq("id", data.user.id).maybeSingle();
    if (profile.error) {
      console.error(`[auth] profile lookup failed: ${profile.error.message}`);
      throw new HttpError(500, "Something went wrong");
    }
    if (!profile.data) throw new HttpError(403, "Profile not found");
    if (profile.data.is_banned === true) throw new HttpError(403, "This profile is banned");

    req.user = { id: data.user.id, email: data.user.email ?? null };
    next();
  } catch (error) {
    next(error);
  }
}

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Unauthorized");
  return req.user;
}