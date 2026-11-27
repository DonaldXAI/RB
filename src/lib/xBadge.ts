import { asUsdc, supabase, throwDb } from "../config.js";
import type { XBadgeType } from "../services/twitter.js";

const MULTIPLIERS: Record<XBadgeType, number> = {
  gold: 2,
  blue: 1.5,
  grey: 1.25,
  none: 1,
};

export function badgePayMultiplier(badgeType: XBadgeType): number {
  return MULTIPLIERS[badgeType];
}

export async function persistXBadge(userId: string, badgeType: XBadgeType): Promise<{
  xBadgeType: XBadgeType;
  badgeMultiplier: number;
}> {
  const updated = await supabase
    .from("profiles")
    .update({ x_badge_type: badgeType })
    .eq("id", userId)
    .select("x_badge_type, badge_multiplier")
    .single();
  if (updated.error) throwDb(updated.error, "save x badge type");
  const stored = (updated.data?.x_badge_type as XBadgeType | null) ?? badgeType;
  const multiplier = asUsdc(updated.data?.badge_multiplier ?? badgePayMultiplier(stored));
  return { xBadgeType: stored, badgeMultiplier: multiplier };
}