import type { XBadgeType } from "../services/twitter.js";

export type ProfileBadgeKind = "x" | "raidhive";

export type ProfileBadgeItem = {
  kind: ProfileBadgeKind;
  /** X pay tier when kind is x; omitted for raidhive (use app logo). */
  variant?: XBadgeType;
};

export type ProfileBadges = {
  /** X Premium / org / gov tier from twitterapi.io (pay multiplier only; not RaidHive approval). */
  xBadgeType: XBadgeType;
  /** Passed full RaidHive eligibility (the RaidHive logo seal). */
  raidHiveVerified: boolean;
  /** Badges to render left-to-right: X tier if any, then RaidHive seal if verified. */
  badges: ProfileBadgeItem[];
};

export function normalizeXBadgeType(value: string | null | undefined): XBadgeType {
  const raw = (value ?? "none").toLowerCase();
  if (raw === "gold" || raw === "blue" || raw === "grey") return raw;
  return "none";
}

export function raidHiveVerified(
  isCryptoVerified: boolean | null | undefined,
  verificationStatus: string | null | undefined,
): boolean {
  return isCryptoVerified === true && verificationStatus === "verified";
}

/** UI: two badges when X tier + RaidHive verified; only RaidHive logo when verified but xBadgeType is none. */
export function buildProfileBadges(
  xBadgeType: string | null | undefined,
  isCryptoVerified: boolean | null | undefined,
  verificationStatus: string | null | undefined,
): ProfileBadges {
  const xType = normalizeXBadgeType(xBadgeType);
  const hiveVerified = raidHiveVerified(isCryptoVerified, verificationStatus);
  const badges: ProfileBadgeItem[] = [];
  if (xType !== "none") badges.push({ kind: "x", variant: xType });
  if (hiveVerified) badges.push({ kind: "raidhive" });
  return { xBadgeType: xType, raidHiveVerified: hiveVerified, badges };
}