// CPM Calculator — Influencer Pricing Evaluation
//
// Thresholds come from the shared benchmark config (src/lib/benchmarks.ts,
// seed "SPAIN 2026 v1", editable in Ajustes → Benchmarks). Followers only pick
// the tier; the accepted CPM (fee ÷ median views of the format × 1000) depends
// on platform × format × tier and falls with tier. Server code should load the
// merged config with loadBenchmarkConfig() and pass it in; client code can use
// DEFAULT_BENCHMARKS (the default).

import {
  DEFAULT_BENCHMARKS,
  TIER_BOUNDS,
  detectTier,
  getCpmThreshold,
  normalizeFormat,
  normalizePlatform,
  type BenchmarkConfig,
  type FeeFormat,
  type Platform,
  type Tier,
} from './benchmarks'

export type { Platform, Tier, FeeFormat } from './benchmarks'
export { detectTier }
export type TrafficLight = 'green' | 'yellow' | 'red' | 'gray'

// ============ THRESHOLDS (derived from the shared config) ============

export interface CPMThreshold {
  platform: Platform
  tier: Tier
  /** Negotiation format the threshold applies to (REEL / POST / STORY / VIDEO / INTEGRATION / DEDICATED / SHORT). */
  format: FeeFormat
  minFollowers: number
  maxFollowers: number
  cpmTarget: number      // Green ceiling = CPM objetivo
  cpmMax: number         // Yellow ceiling = CPM máximo aceptable (above = red)
}

/** Default (headline) format per platform used when no format is given. */
export const DEFAULT_CPM_FORMAT: Record<Platform, FeeFormat> = {
  INSTAGRAM: 'REEL',
  TIKTOK: 'VIDEO',
  YOUTUBE: 'INTEGRATION',
}

/**
 * Backward-compatible flat table: thresholds for the default format of each
 * platform (Instagram REEL, TikTok VIDEO, YouTube INTEGRATION), every tier.
 * Derived from DEFAULT_BENCHMARKS — do not edit here, edit the seed.
 */
export const CPM_THRESHOLDS: CPMThreshold[] = DEFAULT_BENCHMARKS.cpmThresholds
  .filter(t => t.format === DEFAULT_CPM_FORMAT[t.platform])
  .map(t => ({
    platform: t.platform,
    tier: t.tier,
    format: t.format,
    minFollowers: TIER_BOUNDS[t.tier][0],
    maxFollowers: TIER_BOUNDS[t.tier][1],
    cpmTarget: t.cpmTarget,
    cpmMax: t.cpmMax,
  }))

/**
 * Threshold for a platform + follower count (tier) + optional format.
 * Kept for backward compatibility; new code can call getCpmThreshold() directly.
 */
export function findThreshold(
  platform: Platform | string,
  followers: number,
  format?: string | null,
  config: BenchmarkConfig = DEFAULT_BENCHMARKS
): CPMThreshold | null {
  const plat = normalizePlatform(platform)
  const tier = detectTier(followers || 0)
  const t = getCpmThreshold(config, plat, tier, format)
  if (!t) return null
  return {
    platform: t.platform,
    tier: t.tier,
    format: t.format,
    minFollowers: TIER_BOUNDS[t.tier][0],
    maxFollowers: TIER_BOUNDS[t.tier][1],
    cpmTarget: t.cpmTarget,
    cpmMax: t.cpmMax,
  }
}

// ============ LABELS ============

const TIER_LABEL: Record<Tier, string> = { NANO: 'Nano', MICRO: 'Micro', MID: 'Mid', MACRO: 'Macro', MEGA: 'Mega' }

const FORMAT_LABEL: Record<'es' | 'en', Record<FeeFormat, string>> = {
  es: { POST: 'post', REEL: 'reel', STORY: 'story', VIDEO: 'vídeo', INTEGRATION: 'integración', DEDICATED: 'vídeo dedicado', SHORT: 'short' },
  en: { POST: 'post', REEL: 'reel', STORY: 'story', VIDEO: 'video', INTEGRATION: 'integration', DEDICATED: 'dedicated video', SHORT: 'short' },
}

export function formatLabel(format: FeeFormat, locale: 'es' | 'en' = 'es'): string {
  return FORMAT_LABEL[locale][format] || format.toLowerCase()
}

export function tierLabel(tier: Tier): string {
  return TIER_LABEL[tier] || tier
}

const eur = (n: number) => `€${Math.round(n).toLocaleString()}`

// ============ CPM CALCULATION ============

export interface CPMInput {
  fee: number | null        // What the influencer charges (€) for ONE piece of this format
  avgViews: number          // Median/average views per piece of this format
  platform: Platform
  followers: number         // Only used to pick the tier
  /** Negotiation format (REEL, POST, STORY, VIDEO, INTEGRATION, DEDICATED, SHORT). Defaults to the platform's headline format. */
  format?: string | null
}

export interface CPMResult {
  // Core metrics
  cpmReal: number | null
  trafficLight: TrafficLight
  tier: Tier
  /** Normalized format the thresholds were taken for. */
  format: FeeFormat

  // Thresholds
  cpmTarget: number | null
  cpmMax: number | null

  // Pricing recommendation
  feeRecommended: number | null   // avgViews/1000 × cpmTarget
  feeMax: number | null           // avgViews/1000 × cpmMax
  savingsOrOvercost: number | null  // positive = overcost, negative = savings

  // Textual recommendation
  recommendation: string
  recommendationDetail: string

  // Status
  hasData: boolean
  missingFields: string[]
}

export function calculateCPM(
  input: CPMInput,
  locale: 'en' | 'es' = 'es',
  config: BenchmarkConfig = DEFAULT_BENCHMARKS
): CPMResult {
  const platform = normalizePlatform(input.platform)
  const tier = detectTier(input.followers || 0)
  const format = normalizeFormat(platform, input.format)
  const es = locale === 'es'
  const fmtStr = formatLabel(format, locale)
  const tierStr = tierLabel(tier)
  const missingFields: string[] = []

  if (!input.platform) missingFields.push(es ? 'plataforma' : 'platform')
  if (!input.followers) missingFields.push(es ? 'seguidores' : 'followers')
  if (input.fee === null || input.fee === undefined) missingFields.push('fee')
  if (!input.avgViews || input.avgViews <= 0) missingFields.push(es ? 'visualizaciones medias' : 'avg views')

  const threshold = getCpmThreshold(config, platform, tier, format)

  // No threshold for this platform × format × tier (should be rare: the seed covers every cell)
  if (!threshold) {
    if (input.fee !== null && input.fee > 0 && input.avgViews > 0) {
      const cpmReal = (input.fee / input.avgViews) * 1000
      return {
        cpmReal: Math.round(cpmReal * 100) / 100,
        trafficLight: 'gray',
        tier,
        format,
        cpmTarget: null,
        cpmMax: null,
        feeRecommended: null,
        feeMax: null,
        savingsOrOvercost: null,
        recommendation: es ? 'Sin benchmarks' : 'No benchmarks',
        recommendationDetail: es
          ? `No hay benchmarks configurados para ${platform} ${fmtStr} ${tierStr}. CPM calculado: €${cpmReal.toFixed(2)}`
          : `No benchmarks configured for ${platform} ${fmtStr} ${tierStr}. Calculated CPM: €${cpmReal.toFixed(2)}`,
        hasData: true,
        missingFields: [],
      }
    }

    return {
      cpmReal: null,
      trafficLight: 'gray',
      tier,
      format,
      cpmTarget: null,
      cpmMax: null,
      feeRecommended: null,
      feeMax: null,
      savingsOrOvercost: null,
      recommendation: es ? 'Sin datos' : 'No data',
      recommendationDetail: es ? 'Faltan datos para calcular' : 'Missing data to calculate',
      hasData: false,
      missingFields,
    }
  }

  // Missing required data
  if (missingFields.length > 0 || input.fee === null || input.avgViews <= 0) {
    // Even without fee, suggest what they should pay
    const feeRecommended = input.avgViews > 0 ? Math.round((input.avgViews / 1000) * threshold.cpmTarget) : null
    const feeMax = input.avgViews > 0 ? Math.round((input.avgViews / 1000) * threshold.cpmMax) : null

    return {
      cpmReal: null,
      trafficLight: 'gray',
      tier,
      format,
      cpmTarget: threshold.cpmTarget,
      cpmMax: threshold.cpmMax,
      feeRecommended,
      feeMax,
      savingsOrOvercost: null,
      recommendation: es ? 'Introduce el fee' : 'Enter fee',
      recommendationDetail: feeRecommended !== null && feeMax !== null
        ? (es
          ? `Con sus ${input.avgViews.toLocaleString()} vistas medias por ${fmtStr} (${tierStr}), el fee recomendado sería ${eur(feeRecommended)} (CPM objetivo €${threshold.cpmTarget}) y el máximo ${eur(feeMax)} (CPM máx. €${threshold.cpmMax})`
          : `With ${input.avgViews.toLocaleString()} avg views per ${fmtStr} (${tierStr}), the recommended fee is ${eur(feeRecommended)} (target CPM €${threshold.cpmTarget}) and the max ${eur(feeMax)} (max CPM €${threshold.cpmMax})`)
        : (es ? 'Faltan datos para calcular' : 'Missing data to calculate'),
      hasData: false,
      missingFields: input.fee === null ? ['fee'] : missingFields,
    }
  }

  // Full calculation
  const cpmReal = (input.fee / input.avgViews) * 1000
  const feeRecommended = Math.round((input.avgViews / 1000) * threshold.cpmTarget)
  const feeMax = Math.round((input.avgViews / 1000) * threshold.cpmMax)
  const savingsOrOvercost = input.fee - feeRecommended

  // Traffic light
  let trafficLight: TrafficLight
  let recommendation: string
  let recommendationDetail: string

  if (cpmReal <= threshold.cpmTarget) {
    trafficLight = 'green'
    recommendation = es ? 'Contratar' : 'Hire'
    recommendationDetail = es
      ? `CPM €${cpmReal.toFixed(2)}, dentro del objetivo (€${threshold.cpmTarget}) para un ${fmtStr} de un creador ${tierStr}. Precio razonable: intentar cerrar en torno a ${eur(feeRecommended)}`
      : `CPM €${cpmReal.toFixed(2)}, within the target (€${threshold.cpmTarget}) for a ${tierStr} creator's ${fmtStr}. Reasonable price: try to close around ${eur(feeRecommended)}`
  } else if (cpmReal <= threshold.cpmMax) {
    trafficLight = 'yellow'
    recommendation = es ? 'Negociar' : 'Negotiate'
    recommendationDetail = es
      ? `CPM €${cpmReal.toFixed(2)}, por encima del objetivo (€${threshold.cpmTarget}) pero dentro del máximo (€${threshold.cpmMax}) para un ${fmtStr} ${tierStr}. Negociar: intentar cerrar en ${eur(feeRecommended)} y no superar ${eur(feeMax)}`
      : `CPM €${cpmReal.toFixed(2)}, above the target (€${threshold.cpmTarget}) but within the max (€${threshold.cpmMax}) for a ${tierStr} ${fmtStr}. Negotiate: try to close at ${eur(feeRecommended)} and don't exceed ${eur(feeMax)}`
  } else {
    trafficLight = 'red'
    recommendation = es ? 'No contratar' : 'Don\'t hire'
    recommendationDetail = es
      ? `CPM €${cpmReal.toFixed(2)}, por encima del máximo aceptable (€${threshold.cpmMax}) para un ${fmtStr} de un creador ${tierStr}. No contratar a este precio: solo tendría sentido si acepta alrededor de ${eur(feeRecommended)} y en ningún caso por encima de ${eur(feeMax)}`
      : `CPM €${cpmReal.toFixed(2)}, above the max acceptable (€${threshold.cpmMax}) for a ${tierStr} creator's ${fmtStr}. Don't hire at this price: only makes sense if they accept around ${eur(feeRecommended)} and never above ${eur(feeMax)}`
  }

  return {
    cpmReal: Math.round(cpmReal * 100) / 100,
    trafficLight,
    tier,
    format,
    cpmTarget: threshold.cpmTarget,
    cpmMax: threshold.cpmMax,
    feeRecommended,
    feeMax,
    savingsOrOvercost,
    recommendation,
    recommendationDetail,
    hasData: true,
    missingFields: [],
  }
}
