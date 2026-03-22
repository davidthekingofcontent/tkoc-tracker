/**
 * Market Benchmark — Client-safe version (no prisma dependency).
 * Only uses built-in benchmark data, no DB queries.
 * Safe to import in 'use client' components.
 */

// Fee benchmarks by platform × tier × format: [p25, p50, p75, p90]
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

function detectTier(followers: number): string {
  if (followers < 10_000) return 'NANO'
  if (followers < 50_000) return 'MICRO'
  if (followers < 250_000) return 'MID'
  if (followers < 1_000_000) return 'MACRO'
  return 'MEGA'
}

function getDefaultFormat(platform: string): string {
  switch (platform) {
    case 'INSTAGRAM': return 'REEL'
    case 'TIKTOK': return 'VIDEO'
    case 'YOUTUBE': return 'VIDEO'
    default: return 'POST'
  }
}

export interface QuickBenchmark {
  feeMin: number
  feeTarget: number
  feeMax: number
  feeCeiling: number
  tier: string
}

export function getQuickBenchmark(platform: string, followers: number, format?: string): QuickBenchmark {
  const tier = detectTier(followers)
  const fmt = format || getDefaultFormat(platform)
  const fees = FEE_BENCHMARKS[platform]?.[tier]?.[fmt]
    || FEE_BENCHMARKS[platform]?.[tier]?.[getDefaultFormat(platform)]
    || [100, 300, 600, 1000]

  return {
    feeMin: fees[0],
    feeTarget: fees[1],
    feeMax: fees[2],
    feeCeiling: fees[3],
    tier,
  }
}

/**
 * Evaluate a fee against market benchmarks (client-safe, no DB).
 */
export function evaluateFeeClient(
  fee: number,
  platform: string,
  followers: number,
  format?: string
): {
  position: 'below_market' | 'fair' | 'above_market' | 'overpriced'
  marketRange: string
  detail: string
} {
  const benchmark = getQuickBenchmark(platform, followers, format)

  let position: 'below_market' | 'fair' | 'above_market' | 'overpriced'

  if (fee <= benchmark.feeMin) {
    position = 'below_market'
  } else if (fee <= benchmark.feeMax) {
    position = 'fair'
  } else if (fee <= benchmark.feeCeiling) {
    position = 'above_market'
  } else {
    position = 'overpriced'
  }

  const marketRange = `€${benchmark.feeMin.toLocaleString()}-€${benchmark.feeMax.toLocaleString()}`

  const detail = position === 'below_market' ? `€${fee.toLocaleString()} is below market (${marketRange}). Good value.` :
                 position === 'fair' ? `€${fee.toLocaleString()} is within market range (${marketRange}).` :
                 position === 'above_market' ? `€${fee.toLocaleString()} is above typical range (${marketRange}).` :
                 `€${fee.toLocaleString()} exceeds market ceiling of €${benchmark.feeCeiling.toLocaleString()}.`

  return { position, marketRange, detail }
}
