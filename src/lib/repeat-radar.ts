/**
 * Repeat Radar™ — Analyzes campaign history to answer
 * "Which creators should we work with again?"
 *
 * Scoring based on:
 * 1. Performance vs. cost (Ratio EMV = EMV ÷ fee — never called ROI)
 * 2. Engagement quality (vs. tier benchmark)
 * 3. Content delivery reliability
 * 4. Engagement trend (growing = bonus)
 * 5. CPM efficiency
 *
 * Definitions (src/lib/metrics.ts): interacciones = likes + comentarios +
 * shares + saves (3A); the ER and the CPM are computed over the audience of the
 * creator's publications as the campaign overview defines it — alcance →
 * impresiones → vistas → estimaciones etiquetadas (4C / 5) — so the radar can
 * never disagree with the campaign page. Views are the base only when a
 * campaign carries no audience at all.
 *
 * Output: REPEAT (green) / CONSIDER (yellow) / SKIP (red) + reasoning
 */

// ============ TYPES ============

export interface RepeatRadarInput {
  influencerId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number

  // Campaign performance data (aggregated across all campaigns)
  campaigns: Array<{
    campaignId: string
    campaignName: string
    agreedFee: number
    totalLikes: number
    totalComments: number
    totalViews: number
    /**
     * Audience of the creator's publications in this campaign as the overview
     * defines it (perInfluencer.audience.total: reach → impressions → views →
     * labelled estimates). Base of the ER and the CPM; views only fall back in
     * when this is 0.
     */
    audience: number
    totalShares: number
    totalSaves: number
    mediaPosts: number
    status: string         // POSTED, COMPLETED, etc.
    contentDelivered: boolean
    emvGenerated: number   // EMV for this creator in this campaign
  }>
}

export interface RepeatRadarResult {
  influencerId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number

  // Verdict
  verdict: 'repeat' | 'consider' | 'skip'
  signal: 'green' | 'yellow' | 'red'
  score: number            // 0-100 repeat worthiness
  reason: string           // One-line explanation
  reasonKey: string        // i18n key

  // Key metrics
  totalCampaigns: number
  totalSpent: number
  totalEMV: number
  roiRatio: number         // Ratio EMV = EMV ÷ spent (field name kept for API compatibility; label it "Ratio EMV")
  avgCPM: number
  avgEngagementRate: number
  deliveryRate: number     // % of campaigns with content delivered
  totalMedia: number
}

// ============ MAIN FUNCTION ============

export function analyzeRepeatWorthiness(input: RepeatRadarInput): RepeatRadarResult {
  const campaigns = input.campaigns
  const totalCampaigns = campaigns.length

  if (totalCampaigns === 0) {
    return createEmptyResult(input)
  }

  // Aggregate metrics
  const totalSpent = campaigns.reduce((sum, c) => sum + (c.agreedFee || 0), 0)
  const totalEMV = campaigns.reduce((sum, c) => sum + c.emvGenerated, 0)
  const totalMedia = campaigns.reduce((sum, c) => sum + c.mediaPosts, 0)
  const totalViews = campaigns.reduce((sum, c) => sum + c.totalViews, 0)
  const totalAudience = campaigns.reduce((sum, c) => sum + (c.audience || 0), 0)
  const totalLikes = campaigns.reduce((sum, c) => sum + c.totalLikes, 0)
  const totalComments = campaigns.reduce((sum, c) => sum + c.totalComments, 0)
  const totalShares = campaigns.reduce((sum, c) => sum + (c.totalShares || 0), 0)
  const totalSaves = campaigns.reduce((sum, c) => sum + (c.totalSaves || 0), 0)
  // Interacciones (decision 3A): likes + comentarios + shares + saves
  const totalEngagements = totalLikes + totalComments + totalShares + totalSaves
  const deliveredCampaigns = campaigns.filter(c => c.contentDelivered || c.status === 'COMPLETED' || c.status === 'POSTED').length
  const deliveryRate = deliveredCampaigns / totalCampaigns

  // Calculate key ratios — ER and CPM over the audience (decisions 4C / 5), the
  // same base as the campaign page; views only when no campaign has an audience.
  const roiRatio = totalSpent > 0 ? totalEMV / totalSpent : 0
  const base = totalAudience > 0 ? totalAudience : totalViews
  const avgCPM = base > 0 ? (totalSpent / base) * 1000 : 0
  const avgEngagementRate = base > 0 ? (totalEngagements / base) * 100 :
                            input.followers > 0 ? (totalEngagements / input.followers) * 100 : 0

  // Score components (based on real data only, NOT the Ratio EMV)
  let score = 0

  // 1. Engagement quality (35% weight) — primary decision factor
  if (avgEngagementRate >= 5.0) score += 35
  else if (avgEngagementRate >= 3.0) score += 28
  else if (avgEngagementRate >= 2.0) score += 20
  else if (avgEngagementRate >= 1.0) score += 12
  else score += 4

  // 2. Delivery reliability (25% weight) — did they actually deliver?
  if (deliveryRate >= 1.0) score += 25
  else if (deliveryRate >= 0.8) score += 18
  else if (deliveryRate >= 0.5) score += 10
  else score += 2

  // 3. CPM efficiency (20% weight) — are they worth the price?
  if (avgCPM > 0 && avgCPM <= 10) score += 20
  else if (avgCPM <= 15) score += 16
  else if (avgCPM <= 20) score += 12
  else if (avgCPM <= 30) score += 6
  else score += 2

  // 4. Volume / experience (10% weight)
  if (totalCampaigns >= 3) score += 10
  else if (totalCampaigns >= 2) score += 7
  else score += 4

  // 5. Content volume (10% weight) — did they produce enough content?
  if (totalMedia >= 5) score += 10
  else if (totalMedia >= 3) score += 7
  else if (totalMedia >= 1) score += 4
  else score += 1

  score = Math.min(100, score)

  // Determine verdict
  const { verdict, signal, reason, reasonKey } = determineVerdict(score, roiRatio, deliveryRate, avgEngagementRate, avgCPM, totalCampaigns)

  return {
    influencerId: input.influencerId,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    platform: input.platform,
    followers: input.followers,
    verdict,
    signal,
    score,
    reason,
    reasonKey,
    totalCampaigns,
    totalSpent,
    totalEMV,
    roiRatio: Math.round(roiRatio * 100) / 100,
    avgCPM: Math.round(avgCPM * 100) / 100,
    avgEngagementRate: Math.round(avgEngagementRate * 100) / 100,
    deliveryRate: Math.round(deliveryRate * 100) / 100,
    totalMedia,
  }
}

// ============ HELPERS ============

function determineVerdict(
  score: number,
  emvRatio: number,
  delivery: number,
  engagement: number,
  cpm: number,
  campaigns: number
): { verdict: RepeatRadarResult['verdict']; signal: RepeatRadarResult['signal']; reason: string; reasonKey: string } {
  // Hard red flags
  if (delivery < 0.5 && campaigns >= 2) {
    return { verdict: 'skip', signal: 'red', reason: 'Unreliable delivery — failed to deliver content in most campaigns.', reasonKey: 'repeat_unreliable' }
  }

  if (emvRatio < 0.3 && campaigns >= 2) {
    return { verdict: 'skip', signal: 'red', reason: 'Very low EMV ratio — the EMV generated does not justify the fee.', reasonKey: 'repeat_low_roi' }
  }

  // Scoring thresholds
  if (score >= 75) {
    if (emvRatio >= 2.5) {
      return { verdict: 'repeat', signal: 'green', reason: `Excellent performer. EMV ratio ${emvRatio.toFixed(1)}× with strong engagement. Definitely repeat.`, reasonKey: 'repeat_excellent' }
    }
    return { verdict: 'repeat', signal: 'green', reason: 'Strong performance across campaigns. Reliable and good value.', reasonKey: 'repeat_strong' }
  }

  if (score >= 50) {
    if (cpm > 25 && emvRatio < 1.5) {
      return { verdict: 'consider', signal: 'yellow', reason: 'Decent engagement but CPM is high. Repeat only at a lower fee.', reasonKey: 'repeat_consider_fee' }
    }
    if (campaigns === 1) {
      return { verdict: 'consider', signal: 'yellow', reason: 'Only one campaign — too early to judge. Consider repeating to gather more data.', reasonKey: 'repeat_consider_early' }
    }
    return { verdict: 'consider', signal: 'yellow', reason: 'Average performance. Worth repeating if fee can be negotiated down.', reasonKey: 'repeat_consider_average' }
  }

  return { verdict: 'skip', signal: 'red', reason: 'Below-average performance and/or poor value. Explore alternatives.', reasonKey: 'repeat_skip' }
}

function createEmptyResult(input: RepeatRadarInput): RepeatRadarResult {
  return {
    influencerId: input.influencerId,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    platform: input.platform,
    followers: input.followers,
    verdict: 'consider',
    signal: 'yellow',
    score: 50,
    reason: 'No campaign history — cannot evaluate. Consider for a first collaboration.',
    reasonKey: 'repeat_no_history',
    totalCampaigns: 0,
    totalSpent: 0,
    totalEMV: 0,
    roiRatio: 0,
    avgCPM: 0,
    avgEngagementRate: 0,
    deliveryRate: 0,
    totalMedia: 0,
  }
}

// ============ BATCH ANALYSIS ============

/**
 * Analyze all influencers and return sorted by repeat worthiness.
 */
export function analyzeRepeatBatch(inputs: RepeatRadarInput[]): RepeatRadarResult[] {
  return inputs
    .map(input => analyzeRepeatWorthiness(input))
    .sort((a, b) => b.score - a.score)
}
