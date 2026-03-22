/**
 * Market Benchmark™ — Reference pricing data for influencer collaborations.
 *
 * Provides market-standard pricing ranges by:
 * - Platform (Instagram, TikTok, YouTube)
 * - Tier (Nano, Micro, Mid, Macro, Mega)
 * - Format (Post, Reel, Story, Video, Short)
 * - Country (Spain, etc.)
 *
 * Data sources:
 * 1. Built-in benchmark tables (curated from industry data)
 * 2. Historical campaign data (from campaigns managed in the platform)
 *
 * Over time, as more campaigns are tracked, the benchmarks become
 * more accurate and platform-specific.
 */

import { prisma } from './db'

// ============ TYPES ============

export interface BenchmarkQuery {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  format?: string           // POST, REEL, STORY, VIDEO, SHORT
  country?: string          // ISO code e.g. "ES"
}

export interface BenchmarkResult {
  tier: string
  platform: string
  format: string | null

  // Fee range (€)
  feeMin: number            // 25th percentile
  feeTarget: number         // 50th percentile (median)
  feeMax: number            // 75th percentile
  feeCeiling: number        // 90th percentile (above this = clearly overpriced)

  // CPM range (€ per 1000 views)
  cpmMin: number
  cpmTarget: number
  cpmMax: number

  // Context
  dataPoints: number        // How many data points this is based on
  source: 'benchmark' | 'historical' | 'blended'  // Where the data comes from
  confidence: 'high' | 'medium' | 'low'          // How reliable is this
  trend?: 'rising' | 'stable' | 'declining'       // Price trend
  lastUpdated: string       // ISO date
}

// ============ BUILT-IN BENCHMARKS ============
// Curated from industry reports, agency data, and market analysis
// Format: [p25, p50, p75, p90]

const FEE_BENCHMARKS: Record<string, Record<string, Record<string, [number, number, number, number]>>> = {
  INSTAGRAM: {
    NANO:  { POST: [40, 80, 150, 250],   REEL: [60, 120, 200, 350],   STORY: [20, 50, 100, 150] },
    MICRO: { POST: [120, 250, 450, 650],  REEL: [180, 350, 600, 900],  STORY: [60, 120, 200, 350] },
    MID:   { POST: [350, 650, 1100, 1600], REEL: [450, 800, 1400, 2200], STORY: [150, 300, 500, 800] },
    MACRO: { POST: [700, 1300, 2200, 3500], REEL: [900, 1700, 2800, 4500], STORY: [300, 600, 1000, 1600] },
    MEGA:  { POST: [1800, 3500, 6000, 10000], REEL: [2500, 5000, 8000, 14000], STORY: [800, 1500, 2500, 4000] },
  },
  TIKTOK: {
    NANO:  { VIDEO: [30, 70, 140, 220],   SHORT: [25, 55, 110, 180] },
    MICRO: { VIDEO: [100, 220, 400, 600], SHORT: [80, 170, 300, 480] },
    MID:   { VIDEO: [300, 600, 1000, 1500], SHORT: [220, 450, 750, 1100] },
    MACRO: { VIDEO: [600, 1200, 2000, 3200], SHORT: [450, 900, 1500, 2400] },
    MEGA:  { VIDEO: [1500, 3000, 5500, 9000], SHORT: [1100, 2200, 4000, 6500] },
  },
  YOUTUBE: {
    NANO:  { VIDEO: [100, 200, 400, 600],   SHORT: [50, 100, 200, 350] },
    MICRO: { VIDEO: [300, 550, 900, 1300],  SHORT: [150, 280, 450, 700] },
    MID:   { VIDEO: [700, 1300, 2200, 3200], SHORT: [350, 650, 1100, 1600] },
    MACRO: { VIDEO: [1500, 3000, 5000, 8000], SHORT: [700, 1400, 2300, 3800] },
    MEGA:  { VIDEO: [3500, 7000, 12000, 20000], SHORT: [1500, 3000, 5000, 8500] },
  },
}

const CPM_BENCHMARKS: Record<string, Record<string, [number, number, number]>> = {
  INSTAGRAM: { NANO: [15, 25, 40], MICRO: [12, 20, 30], MID: [10, 18, 28], MACRO: [8, 16, 25], MEGA: [6, 13, 22] },
  TIKTOK:    { NANO: [8, 15, 25], MICRO: [6, 12, 20], MID: [5, 10, 18], MACRO: [4, 9, 15], MEGA: [3, 9, 14] },
  YOUTUBE:   { NANO: [12, 22, 35], MICRO: [10, 18, 30], MID: [8, 15, 25], MACRO: [6, 13, 22], MEGA: [5, 11, 18] },
}

// ============ TIER DETECTION ============

function detectTier(followers: number): string {
  if (followers < 10_000) return 'NANO'
  if (followers < 50_000) return 'MICRO'
  if (followers < 250_000) return 'MID'
  if (followers < 1_000_000) return 'MACRO'
  return 'MEGA'
}

// ============ MAIN FUNCTIONS ============

/**
 * Get market benchmark for a specific query.
 * Combines built-in benchmarks with historical data from the platform.
 */
export async function getMarketBenchmark(query: BenchmarkQuery): Promise<BenchmarkResult> {
  const tier = detectTier(query.followers)
  const format = query.format || getDefaultFormat(query.platform)

  // 1. Get built-in benchmark
  const builtIn = getBuiltInBenchmark(query.platform, tier, format)

  // 2. Try to enrich with historical data from campaigns
  const historical = await getHistoricalBenchmark(query.platform, tier, format, query.country)

  // 3. Blend if historical data is available
  if (historical && historical.dataPoints >= 5) {
    return blendBenchmarks(builtIn, historical, tier, query.platform, format)
  }

  return builtIn
}

/**
 * Quick benchmark without async DB query (uses built-in data only).
 */
export function getQuickBenchmark(platform: string, followers: number, format?: string): BenchmarkResult {
  const tier = detectTier(followers)
  const fmt = format || getDefaultFormat(platform)
  return getBuiltInBenchmark(platform, tier, fmt)
}

/**
 * Get benchmark context for a specific fee — is it fair?
 */
export function evaluateFee(
  fee: number,
  platform: string,
  followers: number,
  format?: string
): {
  position: 'below_market' | 'fair' | 'above_market' | 'overpriced'
  percentile: number
  marketRange: string
  detail: string
} {
  const benchmark = getQuickBenchmark(platform, followers, format)

  let position: 'below_market' | 'fair' | 'above_market' | 'overpriced'
  let percentile: number

  if (fee <= benchmark.feeMin) {
    position = 'below_market'
    percentile = Math.round((fee / benchmark.feeMin) * 25)
  } else if (fee <= benchmark.feeTarget) {
    position = 'fair'
    percentile = 25 + Math.round(((fee - benchmark.feeMin) / (benchmark.feeTarget - benchmark.feeMin)) * 25)
  } else if (fee <= benchmark.feeMax) {
    position = 'fair'
    percentile = 50 + Math.round(((fee - benchmark.feeTarget) / (benchmark.feeMax - benchmark.feeTarget)) * 25)
  } else if (fee <= benchmark.feeCeiling) {
    position = 'above_market'
    percentile = 75 + Math.round(((fee - benchmark.feeMax) / (benchmark.feeCeiling - benchmark.feeMax)) * 15)
  } else {
    position = 'overpriced'
    percentile = 95
  }

  percentile = Math.max(1, Math.min(99, percentile))
  const marketRange = `€${benchmark.feeMin.toLocaleString()}-€${benchmark.feeMax.toLocaleString()}`

  const detail = position === 'below_market' ? `€${fee.toLocaleString()} is below the market range of ${marketRange}. Good value.` :
                 position === 'fair' ? `€${fee.toLocaleString()} falls within the market range of ${marketRange}.` :
                 position === 'above_market' ? `€${fee.toLocaleString()} is above the typical range of ${marketRange}.` :
                 `€${fee.toLocaleString()} exceeds the market ceiling of €${benchmark.feeCeiling.toLocaleString()}. Consider alternatives.`

  return { position, percentile, marketRange, detail }
}

// ============ HELPERS ============

function getDefaultFormat(platform: string): string {
  switch (platform) {
    case 'INSTAGRAM': return 'REEL'
    case 'TIKTOK': return 'VIDEO'
    case 'YOUTUBE': return 'VIDEO'
    default: return 'POST'
  }
}

function getBuiltInBenchmark(platform: string, tier: string, format: string): BenchmarkResult {
  // Get fee benchmark
  const fees = FEE_BENCHMARKS[platform]?.[tier]?.[format]
    || FEE_BENCHMARKS[platform]?.[tier]?.[getDefaultFormat(platform)]
    || [100, 300, 600, 1000]

  // Get CPM benchmark
  const cpms = CPM_BENCHMARKS[platform]?.[tier] || [10, 15, 25]

  return {
    tier,
    platform,
    format,
    feeMin: fees[0],
    feeTarget: fees[1],
    feeMax: fees[2],
    feeCeiling: fees[3],
    cpmMin: cpms[0],
    cpmTarget: cpms[1],
    cpmMax: cpms[2],
    dataPoints: 0,
    source: 'benchmark',
    confidence: 'medium',
    lastUpdated: new Date().toISOString().split('T')[0],
  }
}

async function getHistoricalBenchmark(
  platform: string,
  tier: string,
  _format: string,
  country?: string
): Promise<{ fees: number[]; cpms: number[]; dataPoints: number } | null> {
  try {
    // Get follower ranges for this tier
    const tierRanges: Record<string, [number, number]> = {
      NANO: [0, 10_000],
      MICRO: [10_000, 50_000],
      MID: [50_000, 250_000],
      MACRO: [250_000, 1_000_000],
      MEGA: [1_000_000, 999_000_000],
    }
    const [minFollowers, maxFollowers] = tierRanges[tier] || [0, 999_000_000]

    // Query historical fees from campaign influencers
    const historicalData = await prisma.campaignInfluencer.findMany({
      where: {
        agreedFee: { gt: 0 },
        influencer: {
          platform: platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
          followers: { gte: minFollowers, lt: maxFollowers },
          ...(country ? { country } : {}),
        },
      },
      select: {
        agreedFee: true,
        influencer: {
          select: { avgViews: true },
        },
      },
      take: 100,
    })

    if (historicalData.length < 3) return null

    const fees = historicalData
      .map(d => d.agreedFee)
      .filter((f): f is number => f != null && f > 0)
      .sort((a, b) => a - b)

    const cpms = historicalData
      .map(d => {
        const views = d.influencer?.avgViews || 0
        return views > 0 && d.agreedFee ? (d.agreedFee / views) * 1000 : null
      })
      .filter((c): c is number => c != null && c > 0)
      .sort((a, b) => a - b)

    return {
      fees,
      cpms,
      dataPoints: fees.length,
    }
  } catch (error) {
    console.error('[MarketBenchmark] Historical query error:', error)
    return null
  }
}

function blendBenchmarks(
  builtIn: BenchmarkResult,
  historical: { fees: number[]; cpms: number[]; dataPoints: number },
  tier: string,
  platform: string,
  format: string | null
): BenchmarkResult {
  const fees = historical.fees
  const cpms = historical.cpms

  // Calculate percentiles from historical data
  const p25 = (arr: number[]) => arr[Math.floor(arr.length * 0.25)] || 0
  const p50 = (arr: number[]) => arr[Math.floor(arr.length * 0.50)] || 0
  const p75 = (arr: number[]) => arr[Math.floor(arr.length * 0.75)] || 0
  const p90 = (arr: number[]) => arr[Math.floor(arr.length * 0.90)] || 0

  // Blend: 60% historical, 40% built-in (if enough data points)
  const weight = historical.dataPoints >= 20 ? 0.7 :
                 historical.dataPoints >= 10 ? 0.6 :
                 0.5

  return {
    tier,
    platform,
    format,
    feeMin: Math.round(p25(fees) * weight + builtIn.feeMin * (1 - weight)),
    feeTarget: Math.round(p50(fees) * weight + builtIn.feeTarget * (1 - weight)),
    feeMax: Math.round(p75(fees) * weight + builtIn.feeMax * (1 - weight)),
    feeCeiling: Math.round(p90(fees) * weight + builtIn.feeCeiling * (1 - weight)),
    cpmMin: cpms.length >= 3 ? Math.round(p25(cpms) * weight + builtIn.cpmMin * (1 - weight)) : builtIn.cpmMin,
    cpmTarget: cpms.length >= 3 ? Math.round(p50(cpms) * weight + builtIn.cpmTarget * (1 - weight)) : builtIn.cpmTarget,
    cpmMax: cpms.length >= 3 ? Math.round(p75(cpms) * weight + builtIn.cpmMax * (1 - weight)) : builtIn.cpmMax,
    dataPoints: historical.dataPoints,
    source: 'blended',
    confidence: historical.dataPoints >= 20 ? 'high' : 'medium',
    lastUpdated: new Date().toISOString().split('T')[0],
  }
}
