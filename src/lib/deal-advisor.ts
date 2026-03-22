/**
 * Deal Advisor™ — Intelligent pricing advisor for influencer collaborations.
 *
 * Evolves the CPM Calculator into a narrative-driven decision tool.
 * Instead of just showing if a CPM is green/yellow/red, it tells you:
 * - What this creator should cost based on their performance
 * - How the asked fee compares to market
 * - A specific recommendation with savings/overcost
 * - Context about WHY (engagement, views, tier position)
 */

import { calculateCPM, detectTier, type CPMResult, type Platform as CPMPlatform } from './cpm-calculator'

// ============ TYPES ============

export interface DealAdvisorInput {
  username: string
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  avgViews: number
  avgLikes: number
  avgComments: number
  engagementRate: number
  askedFee: number           // What the creator is asking
  agreedFee?: number | null  // What was negotiated (if any)
  format?: string            // reel, post, story, video, short
}

export interface DealAdvisorResult {
  // Core verdict
  verdict: 'excellent_deal' | 'fair_deal' | 'slightly_above' | 'overpriced' | 'way_overpriced'
  verdictSignal: 'green' | 'yellow' | 'red'
  verdictLabel: string       // "Excellent Deal", "Overpriced", etc.

  // Pricing analysis
  askedFee: number
  recommendedFeeMin: number
  recommendedFeeMax: number
  marketRangeMin: number
  marketRangeMax: number
  savingsOrOvercost: number  // positive = savings, negative = overcost
  savingsPercent: number

  // CPM data
  cpmReal: number
  cpmBenchmark: number | null
  cpmSignal: 'green' | 'yellow' | 'red' | 'gray'
  tier: string

  // Narrative
  narrative: string           // Full paragraph explaining the deal
  negotiationTip: string      // One-liner for negotiation
  narrativeKey: string        // i18n key

  // Underlying CPM result
  cpmResult: CPMResult
}

// ============ MARKET RANGES ============

// Extended market ranges by platform × tier (€)
// Format: [min, target, max, ceiling]
const MARKET_RANGES: Record<string, Record<string, [number, number, number, number]>> = {
  INSTAGRAM: {
    NANO:  [50, 100, 200, 300],
    MICRO: [150, 300, 500, 700],
    MID:   [400, 700, 1200, 1800],
    MACRO: [800, 1500, 2500, 4000],
    MEGA:  [2000, 4000, 7000, 12000],
  },
  TIKTOK: {
    NANO:  [30, 80, 150, 250],
    MICRO: [100, 200, 400, 600],
    MID:   [300, 600, 1000, 1500],
    MACRO: [600, 1200, 2000, 3500],
    MEGA:  [1500, 3000, 5500, 10000],
  },
  YOUTUBE: {
    NANO:  [100, 200, 400, 600],
    MICRO: [300, 500, 800, 1200],
    MID:   [600, 1200, 2000, 3000],
    MACRO: [1500, 3000, 5000, 8000],
    MEGA:  [3000, 6000, 10000, 20000],
  },
}

// ============ MAIN FUNCTION ============

export function analyzeDeal(input: DealAdvisorInput): DealAdvisorResult {
  const tier = detectTier(input.followers)
  const platformKey = input.platform as CPMPlatform

  // Get CPM analysis
  const cpmResult = calculateCPM({
    platform: platformKey,
    followers: input.followers,
    avgViews: input.avgViews,
    fee: input.askedFee,
  })

  // Get market range for this tier
  const range = MARKET_RANGES[input.platform]?.[tier] || [100, 500, 1000, 2000]
  const [rangeMin, rangeTarget, rangeMax, rangeCeiling] = range

  // Adjust range based on actual performance
  // If creator performs significantly above/below tier average, adjust
  const performanceMultiplier = calculatePerformanceMultiplier(input)
  const adjustedMin = Math.round(rangeMin * performanceMultiplier)
  const adjustedMax = Math.round(rangeMax * performanceMultiplier)

  // Determine verdict
  const { verdict, verdictSignal, verdictLabel } = determineVerdict(
    input.askedFee, adjustedMin, adjustedMax, rangeTarget * performanceMultiplier, rangeCeiling * performanceMultiplier
  )

  // Calculate savings/overcost
  const midPoint = Math.round((adjustedMin + adjustedMax) / 2)
  const savingsOrOvercost = midPoint - input.askedFee
  const savingsPercent = midPoint > 0 ? Math.round((savingsOrOvercost / midPoint) * 100) : 0

  // Generate narrative
  const { narrative, negotiationTip, narrativeKey } = generateNarrative(input, verdict, tier, adjustedMin, adjustedMax, cpmResult)

  return {
    verdict,
    verdictSignal,
    verdictLabel,
    askedFee: input.askedFee,
    recommendedFeeMin: adjustedMin,
    recommendedFeeMax: adjustedMax,
    marketRangeMin: rangeMin,
    marketRangeMax: rangeMax,
    savingsOrOvercost,
    savingsPercent,
    cpmReal: cpmResult.cpmReal || 0,
    cpmBenchmark: cpmResult.cpmTarget || null,
    cpmSignal: cpmResult.trafficLight,
    tier,
    narrative,
    negotiationTip,
    narrativeKey,
    cpmResult,
  }
}

// ============ HELPERS ============

function calculatePerformanceMultiplier(input: DealAdvisorInput): number {
  // If views are significantly above/below what's expected for follower count
  if (input.followers <= 0 || input.avgViews <= 0) return 1.0

  const viewToFollowerRatio = input.avgViews / input.followers

  // Expected ratios by platform
  const expectedRatios: Record<string, number> = {
    INSTAGRAM: 0.15,  // 15% of followers see content
    TIKTOK: 0.30,     // TikTok has higher organic reach
    YOUTUBE: 0.10,    // YouTube is more subscription-based
  }

  const expected = expectedRatios[input.platform] || 0.15
  const ratio = viewToFollowerRatio / expected

  // Clamp multiplier: 0.6x to 1.8x
  return Math.max(0.6, Math.min(1.8, ratio))
}

function determineVerdict(
  fee: number, min: number, max: number, target: number, ceiling: number
): { verdict: DealAdvisorResult['verdict']; verdictSignal: DealAdvisorResult['verdictSignal']; verdictLabel: string } {
  if (fee <= min) {
    return { verdict: 'excellent_deal', verdictSignal: 'green', verdictLabel: 'Excellent Deal' }
  }
  if (fee <= target) {
    return { verdict: 'fair_deal', verdictSignal: 'green', verdictLabel: 'Fair Deal' }
  }
  if (fee <= max) {
    return { verdict: 'slightly_above', verdictSignal: 'yellow', verdictLabel: 'Slightly Above Market' }
  }
  if (fee <= ceiling) {
    return { verdict: 'overpriced', verdictSignal: 'red', verdictLabel: 'Overpriced' }
  }
  return { verdict: 'way_overpriced', verdictSignal: 'red', verdictLabel: 'Way Overpriced' }
}

function generateNarrative(
  input: DealAdvisorInput,
  verdict: string,
  tier: string,
  recMin: number,
  recMax: number,
  cpmResult: CPMResult
): { narrative: string; negotiationTip: string; narrativeKey: string } {
  const fee = input.askedFee
  const feeStr = `€${fee.toLocaleString()}`
  const rangeStr = `€${recMin.toLocaleString()}-€${recMax.toLocaleString()}`
  const cpmStr = `€${(cpmResult.cpmReal || 0).toFixed(0)}`
  const viewsStr = input.avgViews.toLocaleString()
  const platform = input.platform.charAt(0) + input.platform.slice(1).toLowerCase()
  const tierLabel = tier.charAt(0) + tier.slice(1).toLowerCase()

  switch (verdict) {
    case 'excellent_deal':
      return {
        narrative: `@${input.username} is asking ${feeStr} which is below the market range of ${rangeStr} for a ${tierLabel} ${platform} creator. With ${viewsStr} avg views, their CPM is ${cpmStr} — excellent value. This is a strong deal.`,
        negotiationTip: `Accept this fee. It\'s below market — locking it in is smart.`,
        narrativeKey: 'deal_excellent',
      }
    case 'fair_deal':
      return {
        narrative: `@${input.username} is asking ${feeStr}, within the fair range of ${rangeStr} for a ${tierLabel} ${platform} creator. With ${viewsStr} avg views and a CPM of ${cpmStr}, this is a reasonable deal aligned with market standards.`,
        negotiationTip: `Fair price. You could try negotiating to ${`€${recMin.toLocaleString()}`} but this fee is defensible.`,
        narrativeKey: 'deal_fair',
      }
    case 'slightly_above':
      return {
        narrative: `@${input.username} is asking ${feeStr}, slightly above the recommended range of ${rangeStr}. Their CPM of ${cpmStr} is higher than the ${tierLabel} benchmark. The fee might be justified if engagement or content quality is exceptional.`,
        negotiationTip: `Negotiate down to ${rangeStr}. Mention market benchmarks to support your counter-offer.`,
        narrativeKey: 'deal_above',
      }
    case 'overpriced':
      return {
        narrative: `@${input.username} is asking ${feeStr} — significantly above the market range of ${rangeStr} for a ${tierLabel} ${platform} creator. With ${viewsStr} avg views, the CPM of ${cpmStr} is well above benchmark. Consider negotiating or exploring alternatives.`,
        negotiationTip: `Counter at ${rangeStr}. If they won\'t budge, look at similar creators in this tier — there are better deals available.`,
        narrativeKey: 'deal_overpriced',
      }
    default: // way_overpriced
      return {
        narrative: `@${input.username} is asking ${feeStr} — this is far above any reasonable market range (${rangeStr}) for a ${tierLabel} ${platform} creator. The CPM of ${cpmStr} is unsustainable. We strongly recommend exploring alternatives.`,
        negotiationTip: `Do not accept this fee. Counter at ${rangeStr} or find an alternative creator.`,
        narrativeKey: 'deal_way_overpriced',
      }
  }
}
