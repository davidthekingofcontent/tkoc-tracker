/**
 * Risk Signals™ — Proactive risk detection for influencer collaborations.
 *
 * Detects warning signs that should be surfaced as alerts:
 * 1. Engagement drop (>20% decline in 30 days)
 * 2. Suspicious follower spike (potential bot activity)
 * 3. Content deletion post-campaign
 * 4. Disclosure non-compliance (missing #ad in paid campaigns)
 * 5. CPM way above market
 * 6. Low delivery rate across campaigns
 * 7. Engagement-to-follower ratio anomaly
 *
 * Every signal carries i18n keys (translations.*.intelligence) plus the numeric
 * `params` its templates interpolate ({pct}, {days}, {cpm}, {ceiling}…). The
 * English `title` / `description` / `actionable` / `metric` strings are kept as
 * fallbacks for consumers without translations (API clients, exports).
 */

// ============ TYPES ============

export type RiskLevel = 'critical' | 'warning' | 'info'
export type RiskCategory = 'engagement' | 'followers' | 'compliance' | 'delivery' | 'pricing' | 'quality'

/** Values the i18n templates interpolate. Numbers are formatted per locale by the UI. */
export type RiskSignalParams = Record<string, number | string>

export interface RiskSignal {
  id: string                 // Unique signal ID
  category: RiskCategory
  level: RiskLevel
  // English fallbacks
  title: string
  description: string
  actionable: string         // What to do about it
  metric?: string            // e.g. "-32%"
  // i18n keys under translations.*.intelligence, rendered with `params`
  titleKey: string
  descriptionKey: string
  actionableKey: string
  metricKey?: string
  params: RiskSignalParams
}

export interface RiskAssessmentInput {
  // Current profile
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

  // Historical (optional)
  previousFollowers?: number | null    // 30 days ago
  previousEngagementRate?: number | null  // 30 days ago

  // Campaign context (optional)
  agreedFee?: number | null
  /** Negotiated format (REEL, POST, STORY, VIDEO…) — lets the caller pick the CPM ceiling. */
  format?: string | null
  /**
   * Max acceptable CPM for this format × tier from the shared benchmarks
   * (getCpmThreshold(...).cpmMax). When missing, a coarse per-platform
   * fallback is used — callers should always pass it.
   */
  cpmMax?: number | null
  campaignPaymentType?: string | null  // 'PAID', 'GIFTED'
  mediaHasDisclosure?: boolean | null  // Has #ad or equivalent
  deletedPostsCount?: number
  totalPostsTracked?: number

  // Track record (optional)
  totalCampaigns?: number
  completedCampaigns?: number
  contentDelivered?: number
  contentExpected?: number
}

export interface RiskAssessment {
  overallRisk: 'low' | 'medium' | 'high'
  riskScore: number         // 0-100 (higher = more risky)
  signals: RiskSignal[]
  criticalCount: number
  warningCount: number
  infoCount: number
}

/** The comparison window of the historical inputs (previousFollowers / previousEngagementRate). */
const HISTORY_DAYS = 30

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

// ============ MAIN FUNCTION ============

export function assessRisks(input: RiskAssessmentInput): RiskAssessment {
  const signals: RiskSignal[] = []

  // 1. Engagement drop detection
  checkEngagementDrop(input, signals)

  // 2. Suspicious follower activity
  checkFollowerAnomaly(input, signals)

  // 3. Content deletion
  checkContentDeletion(input, signals)

  // 4. Disclosure compliance
  checkDisclosureCompliance(input, signals)

  // 5. Overpriced fee
  checkPricingRisk(input, signals)

  // 6. Delivery reliability
  checkDeliveryRisk(input, signals)

  // 7. Engagement quality
  checkEngagementQuality(input, signals)

  // Calculate overall risk
  const criticalCount = signals.filter(s => s.level === 'critical').length
  const warningCount = signals.filter(s => s.level === 'warning').length
  const infoCount = signals.filter(s => s.level === 'info').length

  let riskScore = criticalCount * 30 + warningCount * 15 + infoCount * 5
  riskScore = Math.min(100, riskScore)

  const overallRisk: RiskAssessment['overallRisk'] =
    criticalCount > 0 ? 'high' :
    warningCount >= 2 ? 'medium' :
    warningCount >= 1 ? 'medium' :
    'low'

  return {
    overallRisk,
    riskScore,
    signals,
    criticalCount,
    warningCount,
    infoCount,
  }
}

// ============ SIGNAL DETECTORS ============

function checkEngagementDrop(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.previousEngagementRate == null || input.previousEngagementRate <= 0) return

  const change = ((input.engagementRate - input.previousEngagementRate) / input.previousEngagementRate) * 100
  const pct = Math.abs(Math.round(change))
  const from = round1(input.previousEngagementRate)
  const to = round1(input.engagementRate)

  if (change <= -30) {
    signals.push({
      id: 'engagement_drop_severe',
      category: 'engagement',
      level: 'critical',
      title: 'Severe engagement drop',
      description: `Engagement rate dropped ${pct}% in the last ${HISTORY_DAYS} days (${from.toFixed(1)}% → ${to.toFixed(1)}%).`,
      actionable: 'Pause new agreements. Review if audience interest is declining or if content strategy changed.',
      metric: `${Math.round(change)}%`,
      titleKey: 'risk_engagement_drop_severe',
      descriptionKey: 'risk_engagement_drop_severe_desc',
      actionableKey: 'risk_engagement_drop_severe_action',
      metricKey: 'risk_metric_pct_change',
      params: { pct, days: HISTORY_DAYS, from, to, change: Math.round(change) },
    })
  } else if (change <= -20) {
    signals.push({
      id: 'engagement_drop_moderate',
      category: 'engagement',
      level: 'warning',
      title: 'Engagement declining',
      description: `Engagement rate dropped ${pct}% in the last ${HISTORY_DAYS} days.`,
      actionable: 'Monitor for another period before committing to new campaigns.',
      metric: `${Math.round(change)}%`,
      titleKey: 'risk_engagement_drop',
      descriptionKey: 'risk_engagement_drop_desc',
      actionableKey: 'risk_engagement_drop_action',
      metricKey: 'risk_metric_pct_change',
      params: { pct, days: HISTORY_DAYS, from, to, change: Math.round(change) },
    })
  }
}

function checkFollowerAnomaly(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.previousFollowers == null || input.previousFollowers <= 0) return

  const growth = ((input.followers - input.previousFollowers) / input.previousFollowers) * 100
  const delta = input.followers - input.previousFollowers

  // Suspicious: >30% growth in 30 days for accounts >10K
  if (growth > 30 && input.followers > 10_000) {
    const pct = Math.round(growth)
    signals.push({
      id: 'follower_spike',
      category: 'followers',
      level: 'warning',
      title: 'Unusual follower spike',
      description: `Followers grew ${pct}% in ${HISTORY_DAYS} days (+${delta.toLocaleString()}). Could indicate purchased followers.`,
      actionable: 'Check if engagement grew proportionally. If engagement stayed flat while followers spiked, this is a red flag.',
      metric: `+${pct}%`,
      titleKey: 'risk_follower_spike',
      descriptionKey: 'risk_follower_spike_desc',
      actionableKey: 'risk_follower_spike_action',
      metricKey: 'risk_metric_pct_gain',
      params: { pct, days: HISTORY_DAYS, delta },
    })
  }

  // Follower loss
  if (growth < -10) {
    const pct = Math.abs(Math.round(growth))
    signals.push({
      id: 'follower_loss',
      category: 'followers',
      level: 'info',
      title: 'Followers declining',
      description: `Lost ${pct}% of followers in the last ${HISTORY_DAYS} days.`,
      actionable: 'May indicate reduced content quality or platform algorithm changes. Review recent content.',
      metric: `${Math.round(growth)}%`,
      titleKey: 'risk_follower_loss',
      descriptionKey: 'risk_follower_loss_desc',
      actionableKey: 'risk_follower_loss_action',
      metricKey: 'risk_metric_pct_change',
      params: { pct, days: HISTORY_DAYS, delta, change: Math.round(growth) },
    })
  }
}

function checkContentDeletion(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.deletedPostsCount == null || input.deletedPostsCount <= 0) return
  if (input.totalPostsTracked == null || input.totalPostsTracked <= 0) return

  const deleted = input.deletedPostsCount
  const total = input.totalPostsTracked
  const deletionRate = deleted / total
  const pct = Math.round(deletionRate * 100)

  if (deletionRate >= 0.3) {
    signals.push({
      id: 'content_deletion_high',
      category: 'compliance',
      level: 'critical',
      title: 'Campaign content being deleted',
      description: `${deleted} of ${total} campaign posts have been deleted (${pct}%).`,
      actionable: 'Contact the creator immediately. Review contract terms about content permanence.',
      metric: `${deleted} deleted`,
      titleKey: 'risk_deletion_high',
      descriptionKey: 'risk_deletion_high_desc',
      actionableKey: 'risk_deletion_high_action',
      metricKey: 'risk_metric_deleted',
      params: { deleted, total, pct },
    })
  } else if (deleted >= 1) {
    signals.push({
      id: 'content_deletion',
      category: 'compliance',
      level: 'warning',
      title: 'Post deleted after campaign',
      description: `${deleted} campaign post(s) have been removed.`,
      actionable: 'Check if deletion was intentional. Consider adding content permanence clauses to future contracts.',
      metric: `${deleted} deleted`,
      titleKey: 'risk_deletion',
      descriptionKey: 'risk_deletion_desc',
      actionableKey: 'risk_deletion_action',
      metricKey: 'risk_metric_deleted',
      params: { deleted, total, pct },
    })
  }
}

function checkDisclosureCompliance(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.campaignPaymentType !== 'PAID') return
  if (input.mediaHasDisclosure == null) return

  if (!input.mediaHasDisclosure) {
    signals.push({
      id: 'missing_disclosure',
      category: 'compliance',
      level: 'critical',
      title: 'Missing ad disclosure',
      description: 'Paid content is missing required disclosure (#ad, #sponsored, etc.). This violates advertising regulations.',
      actionable: 'Ask the creator to add disclosure immediately. This is a legal requirement in most jurisdictions.',
      titleKey: 'risk_no_disclosure',
      descriptionKey: 'risk_no_disclosure_desc',
      actionableKey: 'risk_no_disclosure_action',
      params: {},
    })
  }
}

function checkPricingRisk(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (!input.agreedFee || input.agreedFee <= 0 || input.avgViews <= 0) return

  // Pre-campaign estimate on the creator's profile (fee ÷ average views of the
  // profile) — not a campaign figure; campaign CPMs come from the overview.
  const cpmRaw = (input.agreedFee / input.avgViews) * 1000

  // Ceiling = the shared benchmark's cpmMax for this format × tier (same number the CPM row
  // and the Deal Advisor use). Coarse per-platform fallback only when the caller gave none.
  const fallbackCeilings: Record<string, number> = { INSTAGRAM: 35, TIKTOK: 25, YOUTUBE: 40 }
  const ceiling = typeof input.cpmMax === 'number' && input.cpmMax > 0
    ? input.cpmMax
    : (fallbackCeilings[input.platform] || 30)

  const cpm = Math.round(cpmRaw)
  const ceilingRounded = round2(ceiling)

  if (cpmRaw > ceiling * 1.5) {
    const pct = Math.round(cpmRaw / ceiling * 100 - 100)
    signals.push({
      id: 'cpm_extreme',
      category: 'pricing',
      level: 'critical',
      title: 'CPM extremely above market',
      description: `CPM of €${cpm} is ${pct}% above the market ceiling (€${ceilingRounded}).`,
      actionable: 'Renegotiate immediately or find alternative creators.',
      metric: `€${cpm} CPM`,
      titleKey: 'risk_cpm_extreme',
      descriptionKey: 'risk_cpm_extreme_desc',
      actionableKey: 'risk_cpm_extreme_action',
      metricKey: 'risk_metric_cpm',
      params: { cpm, ceiling: ceilingRounded, pct },
    })
  } else if (cpmRaw > ceiling) {
    const pct = Math.round(cpmRaw / ceiling * 100 - 100)
    signals.push({
      id: 'cpm_high',
      category: 'pricing',
      level: 'warning',
      title: 'CPM above market',
      description: `CPM of €${cpm} exceeds the typical ceiling of €${ceilingRounded}.`,
      actionable: 'Consider negotiating a lower fee for future collaborations.',
      metric: `€${cpm} CPM`,
      titleKey: 'risk_cpm_high',
      descriptionKey: 'risk_cpm_high_desc',
      actionableKey: 'risk_cpm_high_action',
      metricKey: 'risk_metric_cpm',
      params: { cpm, ceiling: ceilingRounded, pct },
    })
  }
}

function checkDeliveryRisk(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (!input.totalCampaigns || input.totalCampaigns < 2) return

  const total = input.totalCampaigns
  const completed = input.completedCampaigns || 0
  const completionRate = completed / total
  const pct = Math.round(completionRate * 100)

  if (completionRate < 0.5) {
    signals.push({
      id: 'low_delivery',
      category: 'delivery',
      level: 'critical',
      title: 'Poor delivery track record',
      description: `Only ${pct}% of campaigns completed (${completed}/${total}).`,
      actionable: 'Reconsider future collaborations. Require upfront content delivery or milestone payments.',
      metric: `${pct}% delivery`,
      titleKey: 'risk_low_delivery',
      descriptionKey: 'risk_low_delivery_desc',
      actionableKey: 'risk_low_delivery_action',
      metricKey: 'risk_metric_delivery',
      params: { pct, completed, total },
    })
  } else if (completionRate < 0.8) {
    signals.push({
      id: 'inconsistent_delivery',
      category: 'delivery',
      level: 'warning',
      title: 'Inconsistent delivery',
      description: `${pct}% campaign completion rate (${completed}/${total}).`,
      actionable: 'Set clearer expectations and deadlines for upcoming campaigns.',
      metric: `${pct}%`,
      titleKey: 'risk_inconsistent_delivery',
      descriptionKey: 'risk_inconsistent_delivery_desc',
      actionableKey: 'risk_inconsistent_delivery_action',
      metricKey: 'risk_metric_pct',
      params: { pct, completed, total },
    })
  }
}

function checkEngagementQuality(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.avgLikes <= 0 || input.followers <= 0) return

  const likeRate = (input.avgLikes / input.followers) * 100

  // Suspiciously high engagement (bot activity)
  if (likeRate > 20 && input.followers > 5_000) {
    const pct = round1(likeRate)
    signals.push({
      id: 'suspicious_engagement',
      category: 'quality',
      level: 'warning',
      title: 'Suspiciously high engagement',
      description: `Like rate of ${pct.toFixed(1)}% is unusually high for ${input.followers.toLocaleString()} followers.`,
      actionable: 'May indicate bot activity or engagement pods. Verify comment quality manually.',
      metric: `${pct.toFixed(1)}% like rate`,
      titleKey: 'risk_suspicious_engagement',
      descriptionKey: 'risk_suspicious_engagement_desc',
      actionableKey: 'risk_suspicious_engagement_action',
      metricKey: 'risk_metric_like_rate',
      params: { pct, followers: input.followers },
    })
  }

  // Very low engagement (dead audience)
  if (likeRate < 0.2 && input.followers > 50_000) {
    const pct = round2(likeRate)
    signals.push({
      id: 'dead_audience',
      category: 'quality',
      level: 'warning',
      title: 'Very low audience engagement',
      description: `Like rate of ${pct.toFixed(2)}% suggests many followers are inactive.`,
      actionable: 'Actual reach may be much lower than follower count suggests. Factor this into fee negotiations.',
      metric: `${pct.toFixed(2)}%`,
      titleKey: 'risk_dead_audience',
      descriptionKey: 'risk_dead_audience_desc',
      actionableKey: 'risk_dead_audience_action',
      metricKey: 'risk_metric_pct',
      params: { pct, followers: input.followers },
    })
  }
}
