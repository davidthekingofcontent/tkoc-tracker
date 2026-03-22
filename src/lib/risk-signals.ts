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
 */

// ============ TYPES ============

export type RiskLevel = 'critical' | 'warning' | 'info'
export type RiskCategory = 'engagement' | 'followers' | 'compliance' | 'delivery' | 'pricing' | 'quality'

export interface RiskSignal {
  id: string                 // Unique signal ID
  category: RiskCategory
  level: RiskLevel
  title: string
  description: string
  titleKey: string           // i18n key
  descriptionKey: string     // i18n key
  metric?: string            // e.g. "-32% engagement"
  actionable: string         // What to do about it
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

  if (change <= -30) {
    signals.push({
      id: 'engagement_drop_severe',
      category: 'engagement',
      level: 'critical',
      title: 'Severe engagement drop',
      description: `Engagement rate dropped ${Math.abs(Math.round(change))}% in the last 30 days (${input.previousEngagementRate.toFixed(1)}% → ${input.engagementRate.toFixed(1)}%).`,
      titleKey: 'risk_engagement_drop_severe',
      descriptionKey: 'risk_engagement_drop_severe_desc',
      metric: `${Math.round(change)}%`,
      actionable: 'Pause new agreements. Review if audience interest is declining or if content strategy changed.',
    })
  } else if (change <= -20) {
    signals.push({
      id: 'engagement_drop_moderate',
      category: 'engagement',
      level: 'warning',
      title: 'Engagement declining',
      description: `Engagement rate dropped ${Math.abs(Math.round(change))}% recently.`,
      titleKey: 'risk_engagement_drop',
      descriptionKey: 'risk_engagement_drop_desc',
      metric: `${Math.round(change)}%`,
      actionable: 'Monitor for another period before committing to new campaigns.',
    })
  }
}

function checkFollowerAnomaly(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.previousFollowers == null || input.previousFollowers <= 0) return

  const growth = ((input.followers - input.previousFollowers) / input.previousFollowers) * 100

  // Suspicious: >30% growth in 30 days for accounts >10K
  if (growth > 30 && input.followers > 10_000) {
    signals.push({
      id: 'follower_spike',
      category: 'followers',
      level: 'warning',
      title: 'Unusual follower spike',
      description: `Followers grew ${Math.round(growth)}% in 30 days (+${(input.followers - input.previousFollowers).toLocaleString()}). Could indicate purchased followers.`,
      titleKey: 'risk_follower_spike',
      descriptionKey: 'risk_follower_spike_desc',
      metric: `+${Math.round(growth)}%`,
      actionable: 'Check if engagement grew proportionally. If engagement stayed flat while followers spiked, this is a red flag.',
    })
  }

  // Follower loss
  if (growth < -10) {
    signals.push({
      id: 'follower_loss',
      category: 'followers',
      level: 'info',
      title: 'Followers declining',
      description: `Lost ${Math.abs(Math.round(growth))}% of followers recently.`,
      titleKey: 'risk_follower_loss',
      descriptionKey: 'risk_follower_loss_desc',
      metric: `${Math.round(growth)}%`,
      actionable: 'May indicate reduced content quality or platform algorithm changes. Review recent content.',
    })
  }
}

function checkContentDeletion(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.deletedPostsCount == null || input.deletedPostsCount <= 0) return
  if (input.totalPostsTracked == null || input.totalPostsTracked <= 0) return

  const deletionRate = input.deletedPostsCount / input.totalPostsTracked

  if (deletionRate >= 0.3) {
    signals.push({
      id: 'content_deletion_high',
      category: 'compliance',
      level: 'critical',
      title: 'Campaign content being deleted',
      description: `${input.deletedPostsCount} of ${input.totalPostsTracked} campaign posts have been deleted (${Math.round(deletionRate * 100)}%).`,
      titleKey: 'risk_deletion_high',
      descriptionKey: 'risk_deletion_high_desc',
      metric: `${input.deletedPostsCount} deleted`,
      actionable: 'Contact the creator immediately. Review contract terms about content permanence.',
    })
  } else if (input.deletedPostsCount >= 1) {
    signals.push({
      id: 'content_deletion',
      category: 'compliance',
      level: 'warning',
      title: 'Post deleted after campaign',
      description: `${input.deletedPostsCount} campaign post(s) have been removed.`,
      titleKey: 'risk_deletion',
      descriptionKey: 'risk_deletion_desc',
      metric: `${input.deletedPostsCount} deleted`,
      actionable: 'Check if deletion was intentional. Consider adding content permanence clauses to future contracts.',
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
      titleKey: 'risk_no_disclosure',
      descriptionKey: 'risk_no_disclosure_desc',
      actionable: 'Ask the creator to add disclosure immediately. This is a legal requirement in most jurisdictions.',
    })
  }
}

function checkPricingRisk(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (!input.agreedFee || input.agreedFee <= 0 || input.avgViews <= 0) return

  const cpm = (input.agreedFee / input.avgViews) * 1000

  // Platform-specific CPM ceilings
  const ceilings: Record<string, number> = {
    INSTAGRAM: 35,
    TIKTOK: 25,
    YOUTUBE: 40,
  }

  const ceiling = ceilings[input.platform] || 30

  if (cpm > ceiling * 1.5) {
    signals.push({
      id: 'cpm_extreme',
      category: 'pricing',
      level: 'critical',
      title: 'CPM extremely above market',
      description: `CPM of €${cpm.toFixed(0)} is ${Math.round(cpm / ceiling * 100 - 100)}% above the market ceiling.`,
      titleKey: 'risk_cpm_extreme',
      descriptionKey: 'risk_cpm_extreme_desc',
      metric: `€${cpm.toFixed(0)} CPM`,
      actionable: 'Renegotiate immediately or find alternative creators.',
    })
  } else if (cpm > ceiling) {
    signals.push({
      id: 'cpm_high',
      category: 'pricing',
      level: 'warning',
      title: 'CPM above market',
      description: `CPM of €${cpm.toFixed(0)} exceeds the typical ceiling of €${ceiling}.`,
      titleKey: 'risk_cpm_high',
      descriptionKey: 'risk_cpm_high_desc',
      metric: `€${cpm.toFixed(0)} CPM`,
      actionable: 'Consider negotiating a lower fee for future collaborations.',
    })
  }
}

function checkDeliveryRisk(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (!input.totalCampaigns || input.totalCampaigns < 2) return

  const completionRate = (input.completedCampaigns || 0) / input.totalCampaigns

  if (completionRate < 0.5) {
    signals.push({
      id: 'low_delivery',
      category: 'delivery',
      level: 'critical',
      title: 'Poor delivery track record',
      description: `Only ${Math.round(completionRate * 100)}% of campaigns completed (${input.completedCampaigns || 0}/${input.totalCampaigns}).`,
      titleKey: 'risk_low_delivery',
      descriptionKey: 'risk_low_delivery_desc',
      metric: `${Math.round(completionRate * 100)}% delivery`,
      actionable: 'Reconsider future collaborations. Require upfront content delivery or milestone payments.',
    })
  } else if (completionRate < 0.8) {
    signals.push({
      id: 'inconsistent_delivery',
      category: 'delivery',
      level: 'warning',
      title: 'Inconsistent delivery',
      description: `${Math.round(completionRate * 100)}% campaign completion rate.`,
      titleKey: 'risk_inconsistent_delivery',
      descriptionKey: 'risk_inconsistent_delivery_desc',
      metric: `${Math.round(completionRate * 100)}%`,
      actionable: 'Set clearer expectations and deadlines for upcoming campaigns.',
    })
  }
}

function checkEngagementQuality(input: RiskAssessmentInput, signals: RiskSignal[]): void {
  if (input.avgLikes <= 0 || input.followers <= 0) return

  const likeRate = (input.avgLikes / input.followers) * 100

  // Suspiciously high engagement (bot activity)
  if (likeRate > 20 && input.followers > 5_000) {
    signals.push({
      id: 'suspicious_engagement',
      category: 'quality',
      level: 'warning',
      title: 'Suspiciously high engagement',
      description: `Like rate of ${likeRate.toFixed(1)}% is unusually high for ${input.followers.toLocaleString()} followers.`,
      titleKey: 'risk_suspicious_engagement',
      descriptionKey: 'risk_suspicious_engagement_desc',
      metric: `${likeRate.toFixed(1)}% like rate`,
      actionable: 'May indicate bot activity or engagement pods. Verify comment quality manually.',
    })
  }

  // Very low engagement (dead audience)
  if (likeRate < 0.2 && input.followers > 50_000) {
    signals.push({
      id: 'dead_audience',
      category: 'quality',
      level: 'warning',
      title: 'Very low audience engagement',
      description: `Like rate of ${likeRate.toFixed(2)}% suggests many followers are inactive.`,
      titleKey: 'risk_dead_audience',
      descriptionKey: 'risk_dead_audience_desc',
      metric: `${likeRate.toFixed(2)}%`,
      actionable: 'Actual reach may be much lower than follower count suggests. Factor this into fee negotiations.',
    })
  }
}
