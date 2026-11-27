import { asUsdc } from "../config.js";

export const PUBLIC_CAMPAIGN_COLUMNS =
  "id, status, project_name, project_handle, brief, ticker_or_hashtag, target_username, target_tweet_id, min_followers, base_rates, remaining_budget_usdc, total_budget_usdc, ends_at, created_at";

export type CampaignBrowseRow = Record<string, unknown>;

export function mapPublicCampaign(row: CampaignBrowseRow) {
  return {
    campaignId: row.id,
    status: row.status,
    projectName: row.project_name ?? null,
    projectHandle: row.project_handle ?? null,
    brief: row.brief ?? "",
    tickerOrHashtag: row.ticker_or_hashtag ?? "",
    targetUsername: row.target_username ?? null,
    targetTweetId: row.target_tweet_id ?? null,
    minFollowers: Number(row.min_followers ?? 0),
    baseRates: (row.base_rates as Record<string, number>) ?? {},
    remainingBudgetUsdc: asUsdc(row.remaining_budget_usdc),
    totalBudgetUsdc: asUsdc(row.total_budget_usdc),
    endsAt: row.ends_at,
    createdAt: row.created_at,
  };
}