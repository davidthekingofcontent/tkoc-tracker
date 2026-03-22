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

export interface CreatorScoreResult {
  score: number           // 0-100
  grade: string           // A+, A, B+, B, C, D, F
  signal: 'green' | 'yellow' | 'red'
  summary: string         // One-line verdict
  summaryKey: string      // i18n key

  components: {
    engagementQuality: { score: number; weight: number; detail: string }
    valueEfficiency: { score: number; weight: number; detail: string }
    consistency: { score: number; weight: number; detail: string }
    trackRecord: { score: number; weight: number; detail: string }
    audienceQuality: { score: number; weight: number; detail: string }
  }
}

// ============ BENCHMARKS ============

// Engagement rate benchmarks by platform and tier (median values)
const ENGAGEMENT_BENCHMARKS: Record<string, Record<string, number>> = {
  INSTAGRAM: { NANO: 5.0, MICRO: 3.5, MID: 2.5, MACRO: 1.8, MEGA: 1.2 },
  TIKTOK:    { NANO: 8.0, MICRO: 6.0, MID: 4.5, MACRO: 3.0, MEGA: 2.0 },
  YOUTUBE:   { NANO: 6.0, MICRO: 4.0, MID: 3.0, MACRO: 2.0, MEGA: 1.5 },
}

// CPM benchmarks (€ per 1000 views) by platform and tier
const CPM_BENCHMARKS: Record<string, Record<string, number>> = {
  INSTAGRAM: { NANO: 25, MICRO: 20, MID: 18, MACRO: 16, MEGA: 13 },
  TIKTOK:    { NANO: 15, MICRO: 12, MID: 10, MACRO: 9, MEGA: 9 },
  YOUTUBE:   { NANO: 30, MICRO: 25, MID: 20, MACRO: 18, MEGA: 15 },
}

// ============ HELPERS ============

function detectTier(followers: number): string {
  if (followers < 10_000) return 'NANO'
  if (followers < 50_000) return 'MICRO'
  if (followers < 250_000) return 'MID'
  if (followers < 1_000_000) return 'MACRO'
  return 'MEGA'
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

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
function calcEngagementQuality(input: CreatorScoreInput): { score: number; detail: string } {
  const tier = detectTier(input.followers)
  const benchmark = ENGAGEMENT_BENCHMARKS[input.platform]?.[tier] || 3.0

  if (input.engagementRate <= 0) {
    return { score: 10, detail: 'No engagement data available' }
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

  const detail = ratio >= 1.0
    ? `${input.engagementRate.toFixed(1)}% engagement (${Math.round(ratio * 100 - 100)}% above ${tier.toLowerCase()} benchmark)`
    : `${input.engagementRate.toFixed(1)}% engagement (${Math.round(100 - ratio * 100)}% below ${tier.toLowerCase()} benchmark)`

  return { score, detail }
}

/**
 * Component 2: Value Efficiency (25%)
 * Is this creator's price fair vs. what they deliver?
 */
function calcValueEfficiency(input: CreatorScoreInput): { score: number; detail: string } {
  const fee = input.avgAgreedFee || input.standardFee
  if (!fee || fee <= 0 || input.avgViews <= 0) {
    return { score: 50, detail: 'No pricing data — cannot evaluate value' }
  }

  const tier = detectTier(input.followers)
  const cpmBenchmark = CPM_BENCHMARKS[input.platform]?.[tier] || 15
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

  const detail = efficiency >= 1.0
    ? `CPM €${actualCPM.toFixed(0)} vs benchmark €${cpmBenchmark} — good value`
    : `CPM €${actualCPM.toFixed(0)} vs benchmark €${cpmBenchmark} — above market`

  return { score, detail }
}

/**
 * Component 3: Consistency (20%)
 * Does this creator post regularly and maintain engagement?
 */
function calcConsistency(input: CreatorScoreInput): { score: number; detail: string } {
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

  const trendLabel = input.engagementTrend || 'unknown'
  const detail = input.postsPerWeek != null
    ? `${input.postsPerWeek.toFixed(1)} posts/week, trend: ${trendLabel}`
    : `Engagement trend: ${trendLabel}`

  return { score, detail }
}

/**
 * Component 4: Collaboration Track Record (15%)
 * How reliably does this creator deliver on campaigns?
 */
function calcTrackRecord(input: CreatorScoreInput): { score: number; detail: string } {
  const total = input.totalCampaigns || 0
  const completed = input.completedCampaigns || 0

  if (total === 0) {
    return { score: 50, detail: 'No campaign history yet' }
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

  const detail = `${completed}/${total} campaigns completed (${Math.round(completionRate * 100)}% completion rate)`

  return { score, detail }
}

/**
 * Component 5: Audience Quality (10%)
 * Are the followers real and engaged?
 */
function calcAudienceQuality(input: CreatorScoreInput): { score: number; detail: string } {
  // Use explicit audience quality if available
  if (input.audienceQuality) {
    if (input.audienceQuality === 'high') return { score: 90, detail: 'High audience quality — strong comment-to-like ratio' }
    if (input.audienceQuality === 'medium') return { score: 60, detail: 'Medium audience quality' }
    return { score: 25, detail: 'Low audience quality — potential bot activity' }
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

    return { score, detail: `Comment-to-like ratio: ${ratio.toFixed(1)}%` }
  }

  // Fallback: derive from engagement rate vs. follower count
  if (input.followers > 0 && input.avgLikes > 0) {
    const likeRate = (input.avgLikes / input.followers) * 100
    const commentRate = input.avgComments > 0 ? (input.avgComments / input.avgLikes) * 100 : 0

    if (likeRate > 1 && commentRate > 1) return { score: 75, detail: 'Healthy like and comment ratios' }
    if (likeRate > 0.5) return { score: 55, detail: 'Moderate engagement signals' }
    return { score: 35, detail: 'Low engagement relative to followers' }
  }

  return { score: 50, detail: 'Insufficient data for audience quality assessment' }
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
  const { summary, summaryKey } = generateSummary(score, grade, signal, input, engagement, value)

  return {
    score,
    grade,
    signal,
    summary,
    summaryKey,
    components: {
      engagementQuality: { score: engagement.score, weight: weights.engagement, detail: engagement.detail },
      valueEfficiency: { score: value.score, weight: weights.value, detail: value.detail },
      consistency: { score: consistency.score, weight: weights.consistency, detail: consistency.detail },
      trackRecord: { score: trackRecord.score, weight: weights.trackRecord, detail: trackRecord.detail },
      audienceQuality: { score: audience.score, weight: weights.audience, detail: audience.detail },
    },
  }
}

// ============ SUMMARY GENERATOR ============

function generateSummary(
  score: number,
  grade: string,
  signal: string,
  input: CreatorScoreInput,
  engagement: { score: number },
  value: { score: number }
): { summary: string; summaryKey: string } {
  const tier = detectTier(input.followers).toLowerCase()

  if (score >= 85) {
    return {
      summary: `Top-tier ${tier} creator. Strong engagement, good value, reliable.`,
      summaryKey: 'creator_score_excellent',
    }
  }
  if (score >= 70) {
    if (value.score < 50) {
      return {
        summary: `Good creator but pricing is above market. Negotiate fee down.`,
        summaryKey: 'creator_score_good_overpriced',
      }
    }
    return {
      summary: `Solid ${tier} creator. Good performance-to-cost ratio.`,
      summaryKey: 'creator_score_good',
    }
  }
  if (score >= 55) {
    if (engagement.score >= 70 && value.score < 40) {
      return {
        summary: `Engaged audience but overpriced. Worth it only at a lower fee.`,
        summaryKey: 'creator_score_engaged_overpriced',
      }
    }
    return {
      summary: `Average performance for a ${tier} creator. Consider alternatives.`,
      summaryKey: 'creator_score_average',
    }
  }
  if (score >= 40) {
    return {
      summary: `Below average. Low engagement or poor value. Explore other options.`,
      summaryKey: 'creator_score_below_average',
    }
  }
  return {
    summary: `Not recommended. Multiple red flags in performance or pricing.`,
    summaryKey: 'creator_score_not_recommended',
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
