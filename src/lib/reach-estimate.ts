/**
 * Reach estimation for posts where Meta API data (real reach) is unavailable.
 *
 * When we only have Apify-scraped data we don't know true reach/impressions —
 * we can approximate it from follower count and engagement rate using a rough
 * industry benchmark: an average Instagram post reaches ~30-40% of followers,
 * and posts with higher engagement tend to reach further (algorithmic boost).
 *
 * Formula: estimated reach ≈ followers * (1 + ER/100 * 0.6)
 * ER is expected in percentage points (e.g. 3.5 for 3.5%).
 *
 * This is CLEARLY labelled as an estimate in the UI. Never present it as
 * verified data next to real Meta reach numbers.
 */

/**
 * Estimate reach from follower count and engagement rate.
 *
 * @param followers  Absolute follower count (>= 0).
 * @param engagement Engagement rate expressed as a percentage (e.g. 3.5 for 3.5%).
 * @returns Rounded integer estimate of reach, or 0 if inputs are invalid.
 */
export function estimateReach(followers: number, engagement: number): number {
  if (!Number.isFinite(followers) || followers <= 0) return 0
  const er = Number.isFinite(engagement) && engagement > 0 ? engagement : 0
  // Cap ER contribution — obscenely high ER (e.g. tiny nano influencers) shouldn't
  // 10x the estimate.
  const cappedEr = Math.min(er, 20)
  const multiplier = 1 + (cappedEr / 100) * 0.6
  return Math.round(followers * multiplier)
}

/**
 * Estimate reach from a post's raw engagement counts + author followers.
 * Used when we have (likes+comments) but not the pre-computed engagementRate.
 */
export function estimateReachFromCounts(
  followers: number,
  likes: number,
  comments: number,
): number {
  if (!Number.isFinite(followers) || followers <= 0) return 0
  const eng = (Number.isFinite(likes) ? likes : 0) + (Number.isFinite(comments) ? comments : 0)
  const erPct = (eng / followers) * 100
  return estimateReach(followers, erPct)
}
