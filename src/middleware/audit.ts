import type { Request } from "express";
import { clientIp, HttpError, supabase } from "../config.js";

function auditDetails(req: Request, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    client_ip: clientIp(req),
    method: req.method,
    path: req.originalUrl.split("?")[0],
  };
}

export async function logAdminAction(
  req: Request,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const wallet = req.adminWallet;
  if (!wallet) return;
  const row = await supabase.from("admin_audit_logs").insert({
    admin_wallet: wallet,
    action,
    target_type: targetType,
    target_id: targetId,
    details: auditDetails(req, details),
  });
  if (row.error) console.error(`[audit] ${action}: ${row.error.message}`);
}

/** Money-moving admin actions must leave an audit trail. */
export async function logAdminActionOrThrow(
  req: Request,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const wallet = req.adminWallet;
  if (!wallet) throw new HttpError(500, "Admin wallet missing from request");
  const row = await supabase.from("admin_audit_logs").insert({
    admin_wallet: wallet,
    action,
    target_type: targetType,
    target_id: targetId,
    details: auditDetails(req, details),
  });
  if (row.error) {
    console.error(`[audit] ${action}: ${row.error.message}`);
    throw new HttpError(500, "Could not record admin audit");
  }
}

export async function logAdminAuthFailure(req: Request, reason: string, walletHint?: string): Promise<void> {
  const wallet = walletHint?.trim() || "unknown";
  const nonce = (req.get("x-admin-nonce") ?? "").trim();
  const row = await supabase.from("admin_audit_logs").insert({
    admin_wallet: wallet.slice(0, 64),
    action: "admin.auth.failed",
    target_type: "admin_request",
    target_id: req.originalUrl.split("?")[0] || req.path,
    details: auditDetails(req, {
      reason,
      nonce_prefix: nonce ? nonce.slice(0, 12) : null,
    }),
  });
  if (row.error) console.error(`[audit] admin.auth.failed: ${row.error.message}`);
}