import type { Request } from "express";
import { supabase } from "../config.js";

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
    details,
  });
  if (row.error) console.error(`[audit] ${action}: ${row.error.message}`);
}