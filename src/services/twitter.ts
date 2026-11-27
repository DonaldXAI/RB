import { config, HttpError, type RaidAction } from "../config.js";

const BASE = "https://api.twitterapi.io";
const MIN_ACCOUNT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const RETWEETER_PAGES = 5;

export type XBadgeType = "gold" | "blue" | "grey" | "none";

export type XProfile = {
  id: string;
  username: string;
  followers: number;
  following: number;
  tweetCount: number;
  createdAt: string;
  ageDays: number;
  bio: string;
  profileImage: string | null;
  badgeType: XBadgeType;
};

export type GetUserProfileOptions = {
  /** Eligibility uses true; follow/raid lookups should pass false. */
  requireMinAge?: boolean;
};

/** Maps twitterapi.io verification fields to RaidHive pay tiers (no paid X plan on RaidHive). */
export function mapXBadgeType(data: Record<string, unknown>): XBadgeType {
  const verifiedType = String(data.verifiedType ?? data.verified_type ?? "")
    .trim()
    .toLowerCase();
  if (verifiedType === "business") return "gold";
  if (verifiedType === "government") return "grey";
  if (data.isBlueVerified === true || data.is_blue_verified === true) return "blue";
  return "none";
}

export type RaidVerification = {
  tweetText: string;
};

type Query = Record<string, string | number | undefined>;

async function twitterGet<T>(path: string, query: Query = {}): Promise<T> {
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "X-API-Key": config.TWITTERAPI_IO_KEY },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error("[twitter] request failed", error);
    throw new HttpError(502, "Twitter lookup failed");
  }
  if (!response.ok) throw new HttpError(502, "Twitter lookup failed");
  return (await response.json()) as T;
}

export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function tweetIdFromUrl(value: string): string {
  const match = value.trim().match(/status(?:es)?\/(\d+)/i);
  if (match) return match[1];
  if (/^\d{8,}$/.test(value.trim())) return value.trim();
  throw new HttpError(400, "Invalid request");
}

export function assertProofTweetUrl(tweetUrl: string, raiderUsername: string, tweetId: string): void {
  const handle = normalizeHandle(raiderUsername);
  const pattern = new RegExp(
    `^https://(x\\.com|twitter\\.com)/${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/status/${tweetId}(?:\\?.*)?$`,
    "i",
  );
  const normalized = tweetUrl.trim().replace(/\/$/, "");
  if (!pattern.test(normalized)) {
    throw new HttpError(400, "Proof URL must match your X account and tweet id");
  }
}

function parseCreatedAt(value: string): Date {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new HttpError(400, "Tweet timestamp could not be read");
  return new Date(parsed);
}

export async function getUserProfile(
  username: string,
  options: GetUserProfileOptions = {},
): Promise<XProfile> {
  const requireMinAge = options.requireMinAge !== false;
  const handle = normalizeHandle(username);
  const body = await twitterGet<{
    status?: string;
    msg?: string;
    data?: Record<string, unknown> & { unavailable?: boolean; unavailableReason?: string };
  }>("/twitter/user/info", { userName: handle });

  const data = body.data;
  if (body.status === "error" || !data || data.unavailable) {
    throw new HttpError(400, "X account was not found or is unavailable");
  }

  const createdAtRaw = String(data.createdAt ?? data.created_at ?? "");
  const createdAt = parseCreatedAt(createdAtRaw);
  const ageMs = Date.now() - createdAt.getTime();
  if (requireMinAge && ageMs < MIN_ACCOUNT_AGE_MS) {
    throw new HttpError(400, "X account must be at least 90 days old");
  }

  const userName = String(data.userName ?? data.username ?? "");
  const id = String(data.id ?? "");
  if (!id || !userName) throw new HttpError(502, "Twitter lookup failed");

  return {
    id,
    username: userName,
    followers: Number(data.followers ?? data.followersCount ?? 0),
    following: Number(data.following ?? data.followingCount ?? data.friendsCount ?? 0),
    tweetCount: Number(data.statusesCount ?? data.tweetCount ?? data.statuses_count ?? 0),
    createdAt: createdAt.toISOString(),
    ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
    bio: String(data.description ?? data.bio ?? ""),
    profileImage: data.profilePicture ? String(data.profilePicture) : data.profileImageUrl ? String(data.profileImageUrl) : null,
    badgeType: mapXBadgeType(data),
  };
}

async function userFollows(sourceUserName: string, targetUserName: string): Promise<boolean> {
  const body = await twitterGet<{
    status?: string;
    message?: string;
    data?: { following?: boolean };
  }>("/twitter/user/check_follow_relationship", {
    source_user_name: normalizeHandle(sourceUserName),
    target_user_name: normalizeHandle(targetUserName),
  });
  if (body.status === "error") throw new HttpError(502, "Follow check failed");
  return Boolean(body.data?.following);
}

type TweetRecord = {
  id: string;
  text: string;
  authorUserName: string;
  createdAt: Date;
  inReplyToId: string | null;
  quotedId: string | null;
  retweetedId: string | null;
};

function tweetCreatedAt(raw: Record<string, unknown>): Date {
  const candidate = String(raw.createdAt ?? raw.created_at ?? "");
  return parseCreatedAt(candidate);
}

function asTweet(raw: Record<string, unknown>): TweetRecord | null {
  const author = (raw.author ?? {}) as { userName?: string };
  const quoted = (raw.quoted_tweet ?? raw.quotedTweet ?? {}) as { id?: string };
  const retweeted = (raw.retweeted_tweet ?? raw.retweetedTweet ?? {}) as { id?: string };
  const id = String(raw.id ?? "");
  const authorUserName = String(author.userName ?? raw.authorUserName ?? "");
  if (!id || !authorUserName) return null;
  return {
    id,
    text: String(raw.text ?? ""),
    authorUserName,
    createdAt: tweetCreatedAt(raw),
    inReplyToId: raw.inReplyToId ? String(raw.inReplyToId) : null,
    quotedId: quoted.id ? String(quoted.id) : null,
    retweetedId: retweeted.id ? String(retweeted.id) : null,
  };
}

async function getTweet(tweetId: string): Promise<TweetRecord> {
  const body = await twitterGet<{
    status?: string;
    msg?: string;
    tweets?: Record<string, unknown>[];
    data?: Record<string, unknown> | Record<string, unknown>[];
  }>("/twitter/tweets", { tweet_ids: tweetId });

  const list = body.tweets ?? (Array.isArray(body.data) ? body.data : body.data ? [body.data] : []);
  const tweet = list[0] ? asTweet(list[0]) : null;
  if (!tweet || body.status === "error") throw new HttpError(400, "Tweet was not found");
  return tweet;
}

function assertTweetAfterCampaign(tweet: TweetRecord, campaignCreatedAt: string): void {
  const campaignStart = Date.parse(campaignCreatedAt);
  if (!Number.isFinite(campaignStart)) return;
  if (tweet.createdAt.getTime() <= campaignStart) {
    throw new HttpError(400, "Proof tweet must be posted after the campaign started");
  }
}

async function userRetweeted(tweetId: string, username: string): Promise<boolean> {
  const target = normalizeHandle(username);
  let cursor = "";
  for (let page = 0; page < RETWEETER_PAGES; page += 1) {
    const body = await twitterGet<{
      users?: { userName?: string }[];
      has_next_page?: boolean;
      next_cursor?: string;
    }>("/twitter/tweet/retweeters", { tweetId, cursor });

    if ((body.users ?? []).some((user) => normalizeHandle(user.userName ?? "") === target)) return true;
    if (!body.has_next_page || !body.next_cursor) return false;
    cursor = body.next_cursor;
  }
  return false;
}

export async function verifyOfficialFollow(raiderUsername: string): Promise<boolean> {
  return userFollows(raiderUsername, config.OFFICIAL_X_USERNAME);
}

export async function verifyRaidAction(input: {
  actionType: RaidAction;
  tweetUrl: string;
  targetTweetId: string;
  targetUsername: string;
  raiderUsername: string;
  campaignCreatedAt: string;
}): Promise<RaidVerification> {
  if (input.actionType === "follow") {
    if (!input.targetUsername) throw new HttpError(500, "Something went wrong");
    const following = await userFollows(input.raiderUsername, input.targetUsername);
    if (!following) throw new HttpError(400, "Follow was not found");
    return { tweetText: "" };
  }

  if (input.actionType === "repost") {
    if (!input.targetTweetId) throw new HttpError(500, "Something went wrong");
    const listed = await userRetweeted(input.targetTweetId, input.raiderUsername);
    if (listed) return { tweetText: "" };

    const tweetId = tweetIdFromUrl(input.tweetUrl);
    assertProofTweetUrl(input.tweetUrl, input.raiderUsername, tweetId);
    const proof = await getTweet(tweetId);
    const authored = normalizeHandle(proof.authorUserName) === normalizeHandle(input.raiderUsername);
    assertTweetAfterCampaign(proof, input.campaignCreatedAt);
    if (authored && proof.retweetedId === input.targetTweetId) return { tweetText: proof.text };
    throw new HttpError(400, "Repost was not found");
  }

  const tweetId = tweetIdFromUrl(input.tweetUrl);
  assertProofTweetUrl(input.tweetUrl, input.raiderUsername, tweetId);
  const tweet = await getTweet(tweetId);
  assertTweetAfterCampaign(tweet, input.campaignCreatedAt);
  if (normalizeHandle(tweet.authorUserName) !== normalizeHandle(input.raiderUsername)) {
    throw new HttpError(400, "Tweet was not posted by the linked X account");
  }

  if (input.actionType === "reply" && tweet.inReplyToId !== input.targetTweetId) {
    throw new HttpError(400, "Reply does not target the campaign tweet");
  }
  if (input.actionType === "quote" && tweet.quotedId !== input.targetTweetId) {
    throw new HttpError(400, "Quote does not target the campaign tweet");
  }
  if (input.actionType === "reply" || input.actionType === "quote" || input.actionType === "post") {
    return { tweetText: tweet.text };
  }

  throw new HttpError(400, "Unsupported raid action");
}