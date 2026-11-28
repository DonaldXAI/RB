/** Eligibility activity rules (lifetime floor + crypto signal in a deep tweet sample). */

/** Minimum total public posts — anti-empty-account; not the crypto window. */
export const MIN_LIFETIME_PUBLIC_POSTS = 15;

/** Tweets fetched from timeline (up to 5 API pages × 20). */
export const ACTIVITY_TWEET_SAMPLE_SIZE = 100;

/** Max pages from twitterapi.io user/last_tweets per verify (cost vs depth). */
export const ACTIVITY_TWEET_MAX_PAGES = 5;

/** Share of the sample that should mention crypto (e.g. 25 → 25 of 100 at full depth). */
export const MIN_CRYPTO_SAMPLE_RATIO = 0.25;

export function requiredCryptoHitsInSample(sampleSize: number): number {
  if (sampleSize <= 0) return 1;
  return Math.min(sampleSize, Math.max(1, Math.ceil(sampleSize * MIN_CRYPTO_SAMPLE_RATIO)));
}