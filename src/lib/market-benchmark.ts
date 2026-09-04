/**
 * Market Benchmark™ — Reference pricing data for influencer collaborations (server).
 *
 * Source of truth: the shared benchmark config (src/lib/benchmarks.ts, seed
 * "SPAIN 2026 v1", editable in Ajustes → Benchmarks, optionally per brand),
 * blended with the agency's OWN negotiations per platform × tier × format
 * (Setting benchmark_internal_stats, written by the recompute job) using
 * shrinkage: blended = (n·own + k·seed) / (n + k), k = 10, min sample 20.
 *
 * The blend happens on the Spain (×1.0) seed and the market multiplier of the
 * requested country is applied afterwards, because own negotiations are stored
 * in the currency/market they were closed in (Spain).
 *
 * Followers only pick the tier; fees are evaluated per format:
 *   Instagram POST / REEL / STORY (ONE story), TikTok VIDEO,
 *   YouTube INTEGRATION / DEDICATED / SHORT (legacy YouTube VIDEO = INTEGRATION).
 */

import {
  DEFAULT_BENCHMARKS,
  blendFeeRange,
  type InternalCellExclusion,
  detectTier,
  getCpmThreshold,
  getFeeRange,
  marketMultiplier,
  normalizeFormat,
  normalizePlatform,
  type BenchmarkConfig,
  type FeeFormat,
  type FeeRange,
  type PercentileLabels,
  type Platform,
  type Tier,
} from './benchmarks'
import { findCell, loadBenchmarkConfig, loadInternalStats } from './benchmarks-server'
import {
  benchmarkFormatLabel,
  evaluateFeeAgainstRange,
  getPercentileLabels,
  getQuickBenchmark as getQuickBenchmarkClient,
  type BenchmarkLocale,
  type FeeEvaluation,
  type QuickBenchmark,
} from './market-benchmark-client'

export type { BenchmarkLocale, FeeEvaluation, QuickBenchmark } from './market-benchmark-client'

// ============ TYPES ============

export interface BenchmarkQuery {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | string
  followers: number
  format?: string | null    // POST, REEL, STORY, VIDEO, INTEGRATION, DEDICATED, SHORT (normalized)
  country?: string | null   // ISO code e.g. "ES" → market multiplier
  /** Brand whose benchmark overrides should be used (Setting suffix _{brandId}). */
  brandId?: string | null
  locale?: BenchmarkLocale
}

export interface BenchmarkResult {
  tier: Tier
  platform: Platform
  format: FeeFormat

  // Fee range (€) — after own-negotiation blend and market multiplier
  feeMin: number            // p25 — "Buen precio"
  feeTarget: number         // p50 — "Precio de mercado"
  feeMax: number            // p75 — "Máximo justificable"
  feeCeiling: number        // p90 — "Excepcional (solo con justificación)"

  // CPM range (€ per 1000 median views of the format)
  cpmMin: number            // 0.6 × target (orientative floor)
  cpmTarget: number
  cpmMax: number

  // Context
  dataPoints: number        // Own negotiations in this cell (n)
  source: 'seed' | 'blended' | 'internal'
  confidence: 'high' | 'medium' | 'low'
  trend?: 'rising' | 'stable' | 'declining'
  lastUpdated: string       // ISO date

  // Benchmark metadata
  version: string
  labels: PercentileLabels
  /** Market multiplier applied (ES = 1.0). */
  marketMultiplier: number
  country: string | null
  /** Seed range (Spain, before blend and market multiplier). */
  seedRange: FeeRange
  /** Weight of the own data in the blend (effective n / (effective n + k)). */
  blendWeight: number
  /** Own negotiations in the cell, counted even when they were not allowed to move the seed. */
  ownDeals: number
  /** Why an existing own cell did not move the seed (single client, flat rate…); null otherwise. */
  blendExcluded: InternalCellExclusion | null
  /** Story pack of 3 = one story × this. */
  storyPackMultiplier: number
}

// ============ MAIN FUNCTIONS ============

/**
 * Market benchmark for a query: merged config (global + brand) blended with the
 * agency's own negotiation cell, then scaled to the requested market.
 */
export async function getMarketBenchmark(query: BenchmarkQuery): Promise<BenchmarkResult> {
  const [config, stats] = await Promise.all([loadBenchmarkConfig(query.brandId), loadInternalStats()])
  const platform = normalizePlatform(query.platform)
  const tier = detectTier(query.followers || 0)
  const format = normalizeFormat(platform, query.format)
  const locale: BenchmarkLocale = query.locale === 'en' ? 'en' : 'es'
  const country = query.country ? query.country.toUpperCase() : null

  // 1. Seed range for Spain (multiplier 1) — the blend must happen in the same market as the own data
  const seed = getFeeRange(config, platform, tier, format)

  // 2. Blend with the own-negotiation cell by shrinkage
  const cell = findCell(stats, platform, tier, format)
  const blended = blendFeeRange(seed.range, cell, config.internalBlend)

  // 3. Market multiplier for the requested country
  const multiplier = marketMultiplier(config, country)
  const range = blended.range.map(v => Math.round(v * multiplier)) as FeeRange

  // 4. CPM acceptance for this format × tier
  const cpm = getCpmThreshold(config, platform, tier, format)
  const cpmTarget = cpm?.cpmTarget ?? 15
  const cpmMax = cpm?.cpmMax ?? 25

  const confidence: BenchmarkResult['confidence'] =
    blended.source === 'internal' ? 'high'
      : blended.source === 'blended' ? (blended.n >= config.internalBlend.minSample ? 'high' : 'medium')
        : 'medium'

  return {
    tier,
    platform,
    format,
    feeMin: range[0],
    feeTarget: range[1],
    feeMax: range[2],
    feeCeiling: range[3],
    cpmMin: Math.round(cpmTarget * 0.6 * 10) / 10,
    cpmTarget,
    cpmMax,
    dataPoints: blended.n,
    source: blended.source,
    confidence,
    trend: 'stable',
    lastUpdated: (cell?.updatedAt || new Date().toISOString()).split('T')[0],
    version: config.version,
    labels: getPercentileLabels(config, locale),
    marketMultiplier: multiplier,
    country,
    seedRange: seed.range,
    blendWeight: blended.weight,
    ownDeals: cell?.n ?? 0,
    blendExcluded: blended.excluded,
    storyPackMultiplier: config.storyPackMultiplier,
  }
}

/**
 * Quick benchmark without async DB query (seed config only, no own-negotiation blend).
 * Sync; pass a loaded config to honour Ajustes overrides.
 */
export function getQuickBenchmark(
  platform: string,
  followers: number,
  format?: string | null,
  config: BenchmarkConfig = DEFAULT_BENCHMARKS,
  country?: string | null,
  locale: BenchmarkLocale = 'es'
): BenchmarkResult {
  const q: QuickBenchmark = getQuickBenchmarkClient(platform, followers, format, config, country, locale)
  const cpmTarget = q.cpmTarget ?? 15
  const cpmMax = q.cpmMax ?? 25
  const seed = getFeeRange(config, q.platform, q.tier, q.format)
  return {
    tier: q.tier,
    platform: q.platform,
    format: q.format,
    feeMin: q.feeMin,
    feeTarget: q.feeTarget,
    feeMax: q.feeMax,
    feeCeiling: q.feeCeiling,
    cpmMin: Math.round(cpmTarget * 0.6 * 10) / 10,
    cpmTarget,
    cpmMax,
    dataPoints: 0,
    source: 'seed',
    confidence: 'medium',
    trend: 'stable',
    lastUpdated: new Date().toISOString().split('T')[0],
    version: q.version,
    labels: q.labels,
    marketMultiplier: q.marketMultiplier,
    country: q.country,
    seedRange: seed.range,
    blendWeight: 0,
    ownDeals: 0,
    blendExcluded: null,
    storyPackMultiplier: config.storyPackMultiplier,
  }
}

/**
 * Is this fee fair? Sync evaluation against the seed range (pass a loaded
 * config to honour Ajustes overrides). Texts in Spanish by default, English
 * with locale 'en'.
 */
export function evaluateFee(
  fee: number,
  platform: string,
  followers: number,
  format?: string | null,
  config: BenchmarkConfig = DEFAULT_BENCHMARKS,
  locale: BenchmarkLocale = 'es',
  country?: string | null
): FeeEvaluation {
  const plat = normalizePlatform(platform)
  const tier = detectTier(followers || 0)
  const fmt = normalizeFormat(plat, format)
  const { range } = getFeeRange(config, plat, tier, fmt, country)
  return evaluateFeeAgainstRange(fee, range, getPercentileLabels(config, locale), locale, {
    tier, format: fmt, formatLabel: benchmarkFormatLabel(fmt, locale),
  })
}

/**
 * Evaluate a fee against the BLENDED benchmark (own negotiations + seed, market-scaled).
 * Async because it loads the config and the internal stats.
 */
export async function evaluateFeeBlended(
  fee: number,
  query: BenchmarkQuery
): Promise<FeeEvaluation & { benchmark: BenchmarkResult }> {
  const benchmark = await getMarketBenchmark(query)
  const locale: BenchmarkLocale = query.locale === 'en' ? 'en' : 'es'
  const range: FeeRange = [benchmark.feeMin, benchmark.feeTarget, benchmark.feeMax, benchmark.feeCeiling]
  const evaluation = evaluateFeeAgainstRange(fee, range, benchmark.labels, locale, {
    tier: benchmark.tier, format: benchmark.format, formatLabel: benchmarkFormatLabel(benchmark.format, locale),
  })
  return { ...evaluation, benchmark }
}
