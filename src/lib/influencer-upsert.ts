import type { Prisma } from '@/generated/prisma/client'
import type { ScrapedProfile } from '@/lib/apify'

/**
 * Shared guard for every code path that writes a scraped profile onto an
 * Influencer row. An Apify run that comes back "empty" (0 followers and no
 * posts — private/renamed account, rate-limited actor, transient failure)
 * must never wipe real metrics with zeros nor stamp lastScraped as if it had
 * refreshed the profile.
 */

const METRIC_KEYS = [
  'followers',
  'following',
  'postsCount',
  'engagementRate',
  'avgLikes',
  'avgComments',
  'avgViews',
] as const

type MetricKey = (typeof METRIC_KEYS)[number]

/** The subset of the existing row the guard looks at (any Influencer select that includes it works). */
export type ExistingInfluencerMetrics = Partial<Record<MetricKey, number | null>> | null

/** True when the scrape actually carried profile data (followers or at least one post). */
export function scrapedProfileHasData(scraped: Pick<ScrapedProfile, 'followers' | 'recentPosts'>): boolean {
  return isPositive(scraped.followers) || (scraped.recentPosts?.length ?? 0) > 0
}

function isPositive(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * Prisma `update` data for an Influencer from a scraped profile.
 *
 * - Empty scrape (followers 0 and no posts): metrics and lastScraped are left
 *   untouched; only non-empty profile text (name, bio, avatar, …) is refreshed.
 * - Scrape with data: positive metrics are written. A 0/null metric never
 *   overwrites a positive value already stored on `existing`; when the caller
 *   does not pass `existing` (bulk, lookalikes, campaign-capture) the column is
 *   left untouched, so a header-only scrape (followers > 0, no posts → avg* 0)
 *   cannot wipe real metrics.
 * - lastScraped is only stamped when the scrape carried data.
 */
export function scrapedProfileUpdate(
  scraped: ScrapedProfile,
  existing?: ExistingInfluencerMetrics,
): Prisma.InfluencerUpdateInput {
  const hasData = scrapedProfileHasData(scraped)

  const data: Prisma.InfluencerUpdateInput = {
    email: scraped.email || undefined,
    website: scraped.website || undefined,
    country: scraped.country || undefined,
    city: scraped.city || undefined,
  }

  if (!hasData) {
    // Nothing trustworthy came back: refresh only the text fields that are present.
    if (scraped.displayName) data.displayName = scraped.displayName
    if (scraped.bio) data.bio = scraped.bio
    if (scraped.avatarUrl) data.avatarUrl = scraped.avatarUrl
    return data
  }

  data.displayName = scraped.displayName
  data.bio = scraped.bio
  data.avatarUrl = scraped.avatarUrl
  data.isVerified = scraped.isVerified
  data.lastScraped = new Date()

  for (const key of METRIC_KEYS) {
    const value = scraped[key]
    if (isPositive(value)) {
      data[key] = value
    } else if (existing && !isPositive(existing[key])) {
      // Row known and holds no better value: write the scraped one (normalised to 0).
      data[key] = typeof value === 'number' && Number.isFinite(value) ? value : 0
    }
    // else: keep whatever is already on the row (positive, or unknown to us)
  }

  return data
}
