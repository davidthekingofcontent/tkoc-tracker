import { DEFAULT_BENCHMARKS, getCpmThreshold, normalizePlatform, type Tier } from '@/lib/benchmarks'

/**
 * Creator Score™ — A single 0-100 index that synthesizes an influencer's
 * professional value for brand collaborations.
 *
 * Components (weighted):
 * 1. Engagement Quality (30%) — Real engagement rate vs. tier benchmark
 * 2. Value Efficiency (25%) — CPM vs. market benchmark (are they worth the price?)
 * 3. Consistency (20%) — Posting frequency and engagement stability
 * 4. Collaboration Track Record (15%) — Campaign completion, content delivery
 * 5. Audience Quality (10%) — Comment-to-like ratio, organic signals
 *
 * Output: score (0-100), grade (A+/A/B/C/D/F), signal (green/yellow/red),
 *         component breakdown, and a one-line summary.
 *
 * Texts: the summary and each component detail expose an i18n key
 * (translations.*.intelligence) plus the params its template interpolates;
 * the English strings stay as fallbacks for consumers without translations.
 */

// ============ TYPES ============

export interface CreatorScoreInput {
  // Profile data
  followers: number
  engagementRate: number // as percentage e.g. 3.5
  avgLikes: number
  avgComments: number
  avgViews: number
  postsCount: number
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

  // Pricing (optional)
  standardFee?: number | null
  avgAgreedFee?: number | null // average fee across campaigns

  // Posting consistency (optional)
  postsPerWeek?: number | null
  engagementTrend?: 'rising' | 'stable' | 'declining' | null

  // Collaboration history (optional)
  totalCampaigns?: number
  completedCampaigns?: number
  contentDelivered?: number // number of posts actually delivered
  contentExpected?: number  // number of posts expected

  // Audience quality signals (optional)
  commentToLikeRatio?: number | null // higher = more authentic
  audienceQuality?: 'high' | 'medium' | 'low' | null
}

/**
 * Values the i18n templates interpolate. Numbers are formatted per locale by the
 * UI; `tier` is the lowercase tier code (nano | micro | mid | macro | mega) that
 * the UI turns into its localized word — never an English label.
 */
export type ScoreParams = Record<string, number | string>

export interface ScoreComponent {
  score: number
  weight: number
  /** English fallback */
  detail: string
  /** i18n key under translations.*.intelligence, rendered with detailParams */
  detailKey: string
  detailParams: ScoreParams
}

export interface CreatorScoreResult {
  score: number           // 0-100
  grade: string           // A+, A, B+, B, C, D, F
  signal: 'green' | 'yellow' | 'red'
  summary: string         // One-line verdict (English fallback)
  summaryKey: string      // i18n key
  summaryParams: ScoreParams

  components: {
    engagementQuality: ScoreComponent
    valueEfficiency: ScoreComponent
    consistency: ScoreComponent
    trackRecord: ScoreComponent
    audienceQuality: ScoreComponent
  }
}

/** Internal shape of each component calculation (weight is added by the main function). */
type ComponentCalc = Omit<ScoreComponent, 'weight'>

// ============ BENCHMARKS ============

// Engagement rate benchmarks by platform and tier (median values)
const ENGAGEMENT_BENCHMARKS: Record<string, Record<string, number>> = {
  INSTAGRAM: { NANO: 5.0, MICRO: 3.5, MID: 2.5, MACRO: 1.8, MEGA: 1.2 },
  TIKTOK:    { NANO: 8.0, MICRO: 6.0, MID: 4.5, MACRO: 3.0, MEGA: 2.0 },
  YOUTUBE:   { NANO: 6.0, MICRO: 4.0, MID: 3.0, MACRO: 2.0, MEGA: 1.5 },
}

// CPM benchmarks (€ per 1000 views) by platform and tier
// CPM reference comes from the shared benchmark seed (src/lib/benchmarks.ts), default format per platform.

// ============ HELPERS ============

function detectTier(followers: number): string {
  if (followers < 10_000) return 'NANO'
  if (followers < 50_000) return 'MICRO'
  if (followers < 250_000) return 'MID'
  if (followers < 1_000_000) return 'MACRO'
  return 'MEGA'
}

/** Tier as it reads inside the English fallback sentences ("nano", "mid-tier"…). */
function tierLabel(tier: string): string {
  return tier === 'MID' ? 'mid-tier' : tier.toLowerCase()
}

/** Tier code the i18n templates receive as {tier} (nano | micro | mid | macro | mega). */
function tierCode(tier: string): string {
  return tier.toLowerCase()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const round1 = (n: number) => Math.round(n * 10) / 10

function scoreToGrade(score: number): string {
  if (score >= 90) return 'A+'
  if (score >= 80) return 'A'
  if (score >= 70) return 'B+'
  if (score >= 60) return 'B'
  if (score >= 50) return 'C'
  if (score >= 35) return 'D'
  return 'F'
}

function scoreToSignal(score: number): 'green' | 'yellow' | 'red' {
  if (score >= 65) return 'green'
  if (score >= 40) return 'yellow'
  return 'red'
}

// ============ COMPONENT CALCULATIONS ============

/**
 * Component 1: Engagement Quality (30%)
 * How does this creator's engagement compare to their tier benchmark?
 */
function calcEngagementQuality(input: CreatorScoreInput): ComponentCalc {
  const tier = detectTier(input.followers)
  const benchmark = ENGAGEMENT_BENCHMARKS[input.platform]?.[tier] || 3.0

  if (input.engagementRate <= 0) {
    return { score: 10, detail: 'No engagement data available', detailKey: 'creator_score_engagement_no_data', detailParams: {} }
  }

  // Ratio of actual engagement to benchmark
  const ratio = input.engagementRate / benchmark

  // Score: 1.5x benchmark = 100, 1x = 70, 0.5x = 35, 0.2x = 10
  let score: number
  if (ratio >= 2.0) score = 100
  else if (ratio >= 1.5) score = 85 + (ratio - 1.5) * 30
  else if (ratio >= 1.0) score = 65 + (ratio - 1.0) * 40
  else if (ratio >= 0.5) score = 30 + (ratio - 0.5) * 70
  else score = ratio * 60

  score = clamp(Math.round(score), 0, 100)

  const er = round1(input.engagementRate)
  const label = tierLabel(tier)
  const code = tierCode(tier)
  if (ratio >= 1.0) {
    const pct = Math.round(ratio * 100 - 100)
    return {
      score,
      detail: `${er.toFixed(1)}% engagement (${pct}% above ${label} benchmark)`,
      detailKey: 'creator_score_engagement_above',
      detailParams: { er, pct, tier: code },
    }
  }
  const pct = Math.round(100 - ratio * 100)
  return {
    score,
    detail: `${er.toFixed(1)}% engagement (${pct}% below ${label} benchmark)`,
    detailKey: 'creator_score_engagement_below',
    detailParams: { er, pct, tier: code },
  }
}

/**
 * Component 2: Value Efficiency (25%)
 * Is this creator's price fair vs. what they deliver?
 */
function calcValueEfficiency(input: CreatorScoreInput): ComponentCalc {
  const fee = input.avgAgreedFee || input.standardFee
  if (!fee || fee <= 0 || input.avgViews <= 0) {
    return { score: 50, detail: 'No pricing data — cannot evaluate value', detailKey: 'creator_score_value_no_pricing', detailParams: {} }
  }

  const tier = detectTier(input.followers)
  const cpmBenchmark = getCpmThreshold(DEFAULT_BENCHMARKS, normalizePlatform(input.platform), tier as Tier)?.cpmTarget || 15
  // Profile-level estimate (fee ÷ average views of the profile), not a campaign figure.
  const actualCPM = (fee / input.avgViews) * 1000

  // Ratio: lower CPM = better value. benchmark/actual = efficiency
  const efficiency = cpmBenchmark / actualCPM

  let score: number
  if (efficiency >= 2.0) score = 100  // Paying half the benchmark = amazing
  else if (efficiency >= 1.5) score = 90
  else if (efficiency >= 1.0) score = 70 + (efficiency - 1.0) * 40
  else if (efficiency >= 0.7) score = 40 + (efficiency - 0.7) * 100
  else if (efficiency >= 0.5) score = 15 + (efficiency - 0.5) * 125
  else score = efficiency * 30

  score = clamp(Math.round(score), 0, 100)

  const cpm = Math.round(actualCPM)
  const detailParams: ScoreParams = { cpm, benchmark: cpmBenchmark }
  return efficiency >= 1.0
    ? { score, detail: `CPM €${cpm} vs benchmark €${cpmBenchmark} — good value`, detailKey: 'creator_score_value_good', detailParams }
    : { score, detail: `CPM €${cpm} vs benchmark €${cpmBenchmark} — above market`, detailKey: 'creator_score_value_above_market', detailParams }
}

/**
 * Component 3: Consistency (20%)
 * Does this creator post regularly and maintain engagement?
 */
function calcConsistency(input: CreatorScoreInput): ComponentCalc {
  let score = 50 // default when no data

  // Posting frequency factor (if available)
  if (input.postsPerWeek != null && input.postsPerWeek > 0) {
    // Ideal: 3-7 posts/week. Less than 1 = concerning. More than 14 = spam risk.
    if (input.postsPerWeek >= 3 && input.postsPerWeek <= 7) score = 80
    else if (input.postsPerWeek >= 2) score = 70
    else if (input.postsPerWeek >= 1) score = 55
    else score = 30
  }

  // Engagement trend factor (if available)
  if (input.engagementTrend) {
    if (input.engagementTrend === 'rising') score = Math.min(100, score + 20)
    else if (input.engagementTrend === 'stable') score = Math.min(100, score + 5)
    else if (input.engagementTrend === 'declining') score = Math.max(0, score - 20)
  }

  score = clamp(score, 0, 100)

  const trend = input.engagementTrend || 'unknown'
  if (input.postsPerWeek != null) {
    const perWeek = round1(input.postsPerWeek)
    return {
      score,
      detail: `${perWeek.toFixed(1)} posts/week, trend: ${trend}`,
      detailKey: `creator_score_consistency_posts_${trend}`,
      detailParams: { perWeek },
    }
  }
  return {
    score,
    detail: `Engagement trend: ${trend}`,
    detailKey: `creator_score_consistency_trend_${trend}`,
    detailParams: {},
  }
}

/**
 * Component 4: Collaboration Track Record (15%)
 * How reliably does this creator deliver on campaigns?
 */
function calcTrackRecord(input: CreatorScoreInput): ComponentCalc {
  const total = input.totalCampaigns || 0
  const completed = input.completedCampaigns || 0

  if (total === 0) {
    return { score: 50, detail: 'No campaign history yet', detailKey: 'creator_score_track_no_history', detailParams: {} }
  }

  // Completion rate
  const completionRate = completed / total

  // Content delivery rate
  let deliveryRate = 1.0
  if (input.contentExpected && input.contentExpected > 0 && input.contentDelivered != null) {
    deliveryRate = Math.min(1.0, input.contentDelivered / input.contentExpected)
  }

  // Experience bonus: more campaigns = more reliable signal
  const experienceBonus = Math.min(15, total * 3) // up to +15 for 5+ campaigns

  let score = (completionRate * 50 + deliveryRate * 35 + experienceBonus)
  score = clamp(Math.round(score), 0, 100)

  const pct = Math.round(completionRate * 100)
  return {
    score,
    detail: `${completed}/${total} campaigns completed (${pct}% completion rate)`,
    detailKey: 'creator_score_track_completed',
    detailParams: { completed, total, pct },
  }
}

/**
 * Component 5: Audience Quality (10%)
 * Are the followers real and engaged?
 */
function calcAudienceQuality(input: CreatorScoreInput): ComponentCalc {
  // Use explicit audience quality if available
  if (input.audienceQuality) {
    if (input.audienceQuality === 'high') return { score: 90, detail: 'High audience quality — strong comment-to-like ratio', detailKey: 'creator_score_audience_high', detailParams: {} }
    if (input.audienceQuality === 'medium') return { score: 60, detail: 'Medium audience quality', detailKey: 'creator_score_audience_medium', detailParams: {} }
    return { score: 25, detail: 'Low audience quality — potential bot activity', detailKey: 'creator_score_audience_low', detailParams: {} }
  }

  // Calculate from comment-to-like ratio
  if (input.commentToLikeRatio != null && input.commentToLikeRatio > 0) {
    // Healthy: 2-5% comments/likes. Very high (>10%) can be suspicious too.
    const ratio = input.commentToLikeRatio * 100
    let score: number
    if (ratio >= 2 && ratio <= 8) score = 85
    else if (ratio >= 1 && ratio <= 12) score = 65
    else if (ratio >= 0.5) score = 45
    else score = 25

    const pct = round1(ratio)
    return { score, detail: `Comment-to-like ratio: ${pct.toFixed(1)}%`, detailKey: 'creator_score_audience_comment_ratio', detailParams: { pct } }
  }

  // Fallback: derive from engagement rate vs. follower count
  if (input.followers > 0 && input.avgLikes > 0) {
    const likeRate = (input.avgLikes / input.followers) * 100
    const commentRate = input.avgComments > 0 ? (input.avgComments / input.avgLikes) * 100 : 0

    if (likeRate > 1 && commentRate > 1) return { score: 75, detail: 'Healthy like and comment ratios', detailKey: 'creator_score_audience_healthy', detailParams: {} }
    if (likeRate > 0.5) return { score: 55, detail: 'Moderate engagement signals', detailKey: 'creator_score_audience_moderate', detailParams: {} }
    return { score: 35, detail: 'Low engagement relative to followers', detailKey: 'creator_score_audience_low_relative', detailParams: {} }
  }

  return { score: 50, detail: 'Insufficient data for audience quality assessment', detailKey: 'creator_score_audience_insufficient', detailParams: {} }
}

// ============ MAIN FUNCTION ============

/**
 * Calculate the Creator Score™ for an influencer.
 * Returns a comprehensive score with component breakdown.
 */
export function calculateCreatorScore(input: CreatorScoreInput): CreatorScoreResult {
  const engagement = calcEngagementQuality(input)
  const value = calcValueEfficiency(input)
  const consistency = calcConsistency(input)
  const trackRecord = calcTrackRecord(input)
  const audience = calcAudienceQuality(input)

  // Weighted total
  const weights = { engagement: 0.30, value: 0.25, consistency: 0.20, trackRecord: 0.15, audience: 0.10 }

  const score = Math.round(
    engagement.score * weights.engagement +
    value.score * weights.value +
    consistency.score * weights.consistency +
    trackRecord.score * weights.trackRecord +
    audience.score * weights.audience
  )

  const grade = scoreToGrade(score)
  const signal = scoreToSignal(score)

  // Generate summary
  const { summary, summaryKey, summaryParams } = generateSummary(score, input, engagement, value)

  return {
    score,
    grade,
    signal,
    summary,
    summaryKey,
    summaryParams,
    components: {
      engagementQuality: { ...engagement, weight: weights.engagement },
      valueEfficiency: { ...value, weight: weights.value },
      consistency: { ...consistency, weight: weights.consistency },
      trackRecord: { ...trackRecord, weight: weights.trackRecord },
      audienceQuality: { ...audience, weight: weights.audience },
    },
  }
}

// ============ SUMMARY GENERATOR ============

function generateSummary(
  score: number,
  input: CreatorScoreInput,
  engagement: { score: number },
  value: { score: number }
): { summary: string; summaryKey: string; summaryParams: ScoreParams } {
  const detected = detectTier(input.followers)
  const tier = tierLabel(detected)
  const summaryParams: ScoreParams = { tier: tierCode(detected) }

  if (score >= 85) {
    return {
      summary: `Top-tier ${tier} creator. Strong engagement, good value, reliable.`,
      summaryKey: 'creator_score_excellent',
      summaryParams,
    }
  }
  if (score >= 70) {
    if (value.score < 50) {
      return {
        summary: `Good creator but pricing is above market. Negotiate fee down.`,
        summaryKey: 'creator_score_good_overpriced',
        summaryParams,
      }
    }
    return {
      summary: `Solid ${tier} creator. Good performance-to-cost ratio.`,
      summaryKey: 'creator_score_good',
      summaryParams,
    }
  }
  if (score >= 55) {
    if (engagement.score >= 70 && value.score < 40) {
      return {
        summary: `Engaged audience but overpriced. Worth it only at a lower fee.`,
        summaryKey: 'creator_score_engaged_overpriced',
        summaryParams,
      }
    }
    return {
      summary: `Average performance for a ${tier} creator. Consider alternatives.`,
      summaryKey: 'creator_score_average',
      summaryParams,
    }
  }
  if (score >= 40) {
    return {
      summary: `Below average. Low engagement or poor value. Explore other options.`,
      summaryKey: 'creator_score_below_average',
      summaryParams,
    }
  }
  return {
    summary: `Not recommended. Multiple red flags in performance or pricing.`,
    summaryKey: 'creator_score_not_recommended',
    summaryParams,
  }
}

// ============ BATCH SCORING ============

/**
 * Score multiple creators and return sorted by score (highest first).
 */
export function rankCreators(inputs: Array<CreatorScoreInput & { id: string; username: string }>): Array<CreatorScoreResult & { id: string; username: string }> {
  return inputs
    .map(input => ({
      ...calculateCreatorScore(input),
      id: input.id,
      username: input.username,
    }))
    .sort((a, b) => b.score - a.score)
}
