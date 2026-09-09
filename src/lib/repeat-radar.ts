/**
 * Repeat Radar™ — Analyzes campaign history to answer
 * "Which creators should we work with again?"
 *
 * Definitions (src/lib/metrics.ts), identical to the campaign page:
 *  - interacciones = likes + comentarios + shares + saves (3A);
 *  - vistas reales = plausible platform views (views ≥ likes); the caller feeds
 *    each campaign's perInfluencer.er.{numerator, denominator, pieces} so the
 *    radar aggregates the SAME base the overview published;
 *  - ER = Σ interacciones ÷ Σ vistas reales of the same pieces, published only
 *    with ≥ 1 piece, ≥ 500 views and ≤ 100 % (engagementRateOnViews); there is
 *    NO fallback to followers — without real views the ER is "sin dato";
 *  - CPM = coste ÷ vistas reales × 1000 on a reliable base only (null otherwise);
 *  - Ratio EMV = EMV ÷ coste, null without cost; never called ROI.
 * Missing data never scores: a null ER or CPM adds 0 points and raises no hard
 * flag; a creator with no real base at all is "consider" with an explicit
 * "sin dato real" reason instead of a verdict.
 *
 * Output: REPEAT (green) / CONSIDER (yellow) / SKIP (red) + reasoning
 */

import { cpmOf, emvRatioOf, engagementRateOnViews, viewsBaseReliable, type ViewsBase } from '@/lib/metrics'

// ============ TYPES ============

export interface RepeatRadarCampaign {
  campaignId: string
  campaignName: string
  /** Coste del creador en la campaña (fee acordado, si no coste). 0 when unknown. */
  agreedFee: number
  /** Σ plausible views of the creator's publications (perInfluencer.er.denominator). */
  realViews: number
  /** Pieces behind realViews (perInfluencer.er.pieces). */
  realViewsPieces: number
  /** Interacciones of those SAME pieces (perInfluencer.er.numerator). */
  engagementsOnViews: number
  /** All interacciones of the creator in the campaign (informative). */
  engagements: number
  mediaPosts: number
  status: string         // POSTED, COMPLETED, etc.
  contentDelivered: boolean
  emvGenerated: number   // EMV (extended) of the creator in this campaign
}

export interface RepeatRadarInput {
  influencerId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  campaigns: RepeatRadarCampaign[]
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
  reason: string           // One-line explanation (English fallback; the UI resolves reasonKey)
  reasonKey: string        // i18n key

  // Key metrics (null = no real data, never 0 standing for "unknown")
  totalCampaigns: number
  totalSpent: number
  totalEMV: number
  /** Ratio EMV = EMV ÷ spent (field name kept for API compatibility; label it "Ratio EMV"). null without cost. */
  roiRatio: number | null
  /** € per 1000 real views on the aggregated reliable base; null without cost or base. */
  avgCPM: number | null
  /** ER on real views (%), null without a reliable base. */
  avgEngagementRate: number | null
  /** Σ real views behind the ER / CPM. */
  realViews: number
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

  // Aggregate metrics (same base as the campaign overviews)
  const totalSpent = campaigns.reduce((sum, c) => sum + (c.agreedFee || 0), 0)
  const totalEMV = campaigns.reduce((sum, c) => sum + (c.emvGenerated || 0), 0)
  const totalMedia = campaigns.reduce((sum, c) => sum + (c.mediaPosts || 0), 0)
  const base: ViewsBase = {
    views: campaigns.reduce((sum, c) => sum + (c.realViews || 0), 0),
    pieces: campaigns.reduce((sum, c) => sum + (c.realViewsPieces || 0), 0),
    engagements: campaigns.reduce((sum, c) => sum + (c.engagementsOnViews || 0), 0),
  }
  const deliveredCampaigns = campaigns.filter(c => c.contentDelivered || c.status === 'COMPLETED' || c.status === 'POSTED').length
  const deliveryRate = deliveredCampaigns / totalCampaigns

  const er = engagementRateOnViews(base)                 // ≥ 1 piece, ≥ 500 views, ≤ 100 %
  const avgEngagementRate = er.value
  const reliable = viewsBaseReliable(base)
  const avgCPM = reliable && totalSpent > 0 ? cpmOf(totalSpent, base.views) : null
  const roiRatio = totalMedia > 0 ? emvRatioOf(totalEMV, totalSpent) : null

  // Score components (real data only; missing data scores 0, never a bonus)
  let score = 0

  // 1. Engagement quality (35 %)
  if (avgEngagementRate !== null) {
    if (avgEngagementRate >= 5.0) score += 35
    else if (avgEngagementRate >= 3.0) score += 28
    else if (avgEngagementRate >= 2.0) score += 20
    else if (avgEngagementRate >= 1.0) score += 12
    else score += 4
  }

  // 2. Delivery reliability (25 %)
  if (deliveryRate >= 1.0) score += 25
  else if (deliveryRate >= 0.8) score += 18
  else if (deliveryRate >= 0.5) score += 10
  else score += 2

  // 3. CPM efficiency (20 %) — only with cost AND a reliable views base
  if (avgCPM !== null) {
    if (avgCPM <= 10) score += 20
    else if (avgCPM <= 15) score += 16
    else if (avgCPM <= 20) score += 12
    else if (avgCPM <= 30) score += 6
    else score += 2
  }

  // 4. Volume / experience (10 %)
  if (totalCampaigns >= 3) score += 10
  else if (totalCampaigns >= 2) score += 7
  else score += 4

  // 5. Content volume (10 %)
  if (totalMedia >= 5) score += 10
  else if (totalMedia >= 3) score += 7
  else if (totalMedia >= 1) score += 4
  else score += 1

  score = Math.min(100, score)

  const { verdict, signal, reason, reasonKey } = determineVerdict({
    score, emvRatio: roiRatio, delivery: deliveryRate, engagement: avgEngagementRate, cpm: avgCPM,
    campaigns: totalCampaigns, hasCost: totalSpent > 0, totalMedia,
  })

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
    roiRatio,
    avgCPM,
    avgEngagementRate,
    realViews: base.views,
    deliveryRate: Math.round(deliveryRate * 100) / 100,
    totalMedia,
  }
}

// ============ HELPERS ============

interface VerdictContext {
  score: number
  emvRatio: number | null
  delivery: number
  engagement: number | null
  cpm: number | null
  campaigns: number
  hasCost: boolean
  totalMedia: number
}

function determineVerdict(ctx: VerdictContext): { verdict: RepeatRadarResult['verdict']; signal: RepeatRadarResult['signal']; reason: string; reasonKey: string } {
  const { score, emvRatio, delivery, engagement, cpm, campaigns, hasCost, totalMedia } = ctx

  // Hard red flag: unreliable delivery (real data: content delivered or not)
  if (delivery < 0.5 && campaigns >= 2) {
    return { verdict: 'skip', signal: 'red', reason: 'Unreliable delivery: failed to deliver content in most campaigns.', reasonKey: 'repeat_unreliable' }
  }

  // No real base at all: no verdict, only a data status
  if (engagement === null && cpm === null) {
    if (totalMedia === 0) {
      return { verdict: 'consider', signal: 'yellow', reason: 'No publications tracked yet: cannot evaluate.', reasonKey: 'repeat_no_content' }
    }
    return { verdict: 'consider', signal: 'yellow', reason: 'No real views on the publications: cannot evaluate. Ask for their insights.', reasonKey: 'repeat_no_real_data' }
  }

  // Hard red flag on the Ratio EMV only when there is a cost to judge against
  if (emvRatio !== null && emvRatio < 0.3 && campaigns >= 2) {
    return { verdict: 'skip', signal: 'red', reason: 'Very low EMV ratio: the EMV generated does not justify the fee.', reasonKey: 'repeat_low_roi' }
  }

  if (score >= 75) {
    if (emvRatio !== null && emvRatio >= 2.5) {
      return { verdict: 'repeat', signal: 'green', reason: `Excellent performer. EMV ratio ${emvRatio.toFixed(1)}× with strong engagement. Definitely repeat.`, reasonKey: 'repeat_excellent' }
    }
    if (!hasCost) {
      return { verdict: 'repeat', signal: 'green', reason: 'Strong engagement on real views across campaigns. No cost recorded to judge value.', reasonKey: 'repeat_strong_no_cost' }
    }
    return { verdict: 'repeat', signal: 'green', reason: 'Strong performance across campaigns. Reliable and good value.', reasonKey: 'repeat_strong' }
  }

  if (score >= 50) {
    if (cpm !== null && cpm > 25 && (emvRatio === null || emvRatio < 1.5)) {
      return { verdict: 'consider', signal: 'yellow', reason: 'Decent engagement but CPM is high. Repeat only at a lower fee.', reasonKey: 'repeat_consider_fee' }
    }
    if (campaigns === 1) {
      return { verdict: 'consider', signal: 'yellow', reason: 'Only one campaign: too early to judge. Consider repeating to gather more data.', reasonKey: 'repeat_consider_early' }
    }
    if (!hasCost) {
      return { verdict: 'consider', signal: 'yellow', reason: 'Average engagement on real views. No cost recorded to judge value.', reasonKey: 'repeat_consider_no_cost' }
    }
    return { verdict: 'consider', signal: 'yellow', reason: 'Average performance. Worth repeating if the fee can be negotiated down.', reasonKey: 'repeat_consider_average' }
  }

  // Below 50 with only one of the two real-data axes: too thin to condemn
  if (engagement === null || (cpm === null && hasCost)) {
    return { verdict: 'consider', signal: 'yellow', reason: 'Partial real data (views or cost missing). Complete it before deciding.', reasonKey: 'repeat_consider_partial_data' }
  }

  return { verdict: 'skip', signal: 'red', reason: 'Below-average performance on real views and/or poor value. Explore alternatives.', reasonKey: 'repeat_skip' }
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
    reason: 'No campaign history: cannot evaluate. Consider for a first collaboration.',
    reasonKey: 'repeat_no_history',
    totalCampaigns: 0,
    totalSpent: 0,
    totalEMV: 0,
    roiRatio: null,
    avgCPM: null,
    avgEngagementRate: null,
    realViews: 0,
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
