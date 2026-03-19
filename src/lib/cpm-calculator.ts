// CPM Calculator — Influencer Pricing Evaluation
// Extensible config by platform + tier

export type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
export type Tier = 'NANO' | 'MICRO' | 'MID' | 'MACRO' | 'MEGA'
export type TrafficLight = 'green' | 'yellow' | 'red' | 'gray'

// ============ THRESHOLDS CONFIG ============
// Edit this table to add platforms, tiers, or adjust benchmarks

export interface CPMThreshold {
  platform: Platform
  tier: Tier
  minFollowers: number
  maxFollowers: number
  cpmTarget: number      // Green ceiling = CPM objetivo
  cpmMax: number         // Yellow ceiling = CPM máximo aceptable (above = red)
}

export const CPM_THRESHOLDS: CPMThreshold[] = [
  // Instagram
  { platform: 'INSTAGRAM', tier: 'MACRO', minFollowers: 250_000, maxFollowers: 1_000_000, cpmTarget: 16, cpmMax: 20 },
  { platform: 'INSTAGRAM', tier: 'MEGA',  minFollowers: 1_000_001, maxFollowers: Infinity, cpmTarget: 13, cpmMax: 17 },

  // TikTok
  { platform: 'TIKTOK', tier: 'MACRO', minFollowers: 250_000, maxFollowers: 1_000_000, cpmTarget: 9, cpmMax: 11 },
  { platform: 'TIKTOK', tier: 'MEGA',  minFollowers: 1_000_001, maxFollowers: Infinity, cpmTarget: 9, cpmMax: 12 },

  // Future: add YouTube, Micro, Nano, etc.
  // { platform: 'YOUTUBE', tier: 'MACRO', minFollowers: 250_000, maxFollowers: 1_000_000, cpmTarget: 12, cpmMax: 16 },
]

// ============ TIER DETECTION ============

export function detectTier(followers: number): Tier {
  if (followers < 10_000) return 'NANO'
  if (followers < 50_000) return 'MICRO'
  if (followers < 250_000) return 'MID'
  if (followers < 1_000_001) return 'MACRO'
  return 'MEGA'
}

export function findThreshold(platform: Platform, followers: number): CPMThreshold | null {
  return CPM_THRESHOLDS.find(t =>
    t.platform === platform &&
    followers >= t.minFollowers &&
    followers <= t.maxFollowers
  ) || null
}

// ============ CPM CALCULATION ============

export interface CPMInput {
  fee: number | null        // What the influencer charges (€)
  avgViews: number          // Average views per post
  platform: Platform
  followers: number         // For tier detection
}

export interface CPMResult {
  // Core metrics
  cpmReal: number | null
  trafficLight: TrafficLight
  tier: Tier

  // Thresholds
  cpmTarget: number | null
  cpmMax: number | null

  // Pricing recommendation
  feeRecommended: number | null
  feeMax: number | null
  savingsOrOvercost: number | null  // positive = overcost, negative = savings

  // Textual recommendation
  recommendation: string
  recommendationDetail: string

  // Status
  hasData: boolean
  missingFields: string[]
}

export function calculateCPM(input: CPMInput, locale: 'en' | 'es' = 'es'): CPMResult {
  const tier = detectTier(input.followers)
  const missingFields: string[] = []

  if (!input.platform) missingFields.push(locale === 'es' ? 'plataforma' : 'platform')
  if (!input.followers) missingFields.push(locale === 'es' ? 'seguidores' : 'followers')
  if (input.fee === null || input.fee === undefined) missingFields.push('fee')
  if (!input.avgViews || input.avgViews <= 0) missingFields.push(locale === 'es' ? 'visualizaciones medias' : 'avg views')

  const threshold = findThreshold(input.platform, input.followers)

  // If no threshold for this platform+tier combo
  if (!threshold) {
    // Still calculate CPM if we have fee and views
    if (input.fee !== null && input.fee > 0 && input.avgViews > 0) {
      const cpmReal = (input.fee / input.avgViews) * 1000
      return {
        cpmReal: Math.round(cpmReal * 100) / 100,
        trafficLight: 'gray',
        tier,
        cpmTarget: null,
        cpmMax: null,
        feeRecommended: null,
        feeMax: null,
        savingsOrOvercost: null,
        recommendation: locale === 'es' ? 'Sin benchmarks' : 'No benchmarks',
        recommendationDetail: locale === 'es'
          ? `No hay benchmarks configurados para ${input.platform} ${tier}. CPM calculado: €${cpmReal.toFixed(2)}`
          : `No benchmarks configured for ${input.platform} ${tier}. Calculated CPM: €${cpmReal.toFixed(2)}`,
        hasData: true,
        missingFields: [],
      }
    }

    return {
      cpmReal: null,
      trafficLight: 'gray',
      tier,
      cpmTarget: null,
      cpmMax: null,
      feeRecommended: null,
      feeMax: null,
      savingsOrOvercost: null,
      recommendation: locale === 'es' ? 'Sin datos' : 'No data',
      recommendationDetail: locale === 'es' ? 'Faltan datos para calcular' : 'Missing data to calculate',
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
      cpmTarget: threshold.cpmTarget,
      cpmMax: threshold.cpmMax,
      feeRecommended,
      feeMax,
      savingsOrOvercost: null,
      recommendation: locale === 'es' ? 'Introduce el fee' : 'Enter fee',
      recommendationDetail: feeRecommended
        ? (locale === 'es'
          ? `Basado en sus views medias, el fee recomendado seria €${feeRecommended.toLocaleString()} (max €${feeMax?.toLocaleString()})`
          : `Based on avg views, recommended fee is €${feeRecommended.toLocaleString()} (max €${feeMax?.toLocaleString()})`)
        : (locale === 'es' ? 'Faltan datos para calcular' : 'Missing data to calculate'),
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
    recommendation = locale === 'es' ? 'Contratar' : 'Hire'
    recommendationDetail = locale === 'es'
      ? `Precio razonable. Intentar cerrar en torno a €${feeRecommended.toLocaleString()}`
      : `Reasonable price. Try to close around €${feeRecommended.toLocaleString()}`
  } else if (cpmReal <= threshold.cpmMax) {
    trafficLight = 'yellow'
    recommendation = locale === 'es' ? 'Negociar' : 'Negotiate'
    recommendationDetail = locale === 'es'
      ? `Negociar. Intentar cerrar en €${feeRecommended.toLocaleString()} y no superar €${feeMax.toLocaleString()}`
      : `Negotiate. Try to close at €${feeRecommended.toLocaleString()} and don't exceed €${feeMax.toLocaleString()}`
  } else {
    trafficLight = 'red'
    recommendation = locale === 'es' ? 'No contratar' : 'Don\'t hire'
    recommendationDetail = locale === 'es'
      ? `No contratar a este precio. Solo tendria sentido si acepta alrededor de €${feeRecommended.toLocaleString()} y en ningun caso por encima de €${feeMax.toLocaleString()}`
      : `Don't hire at this price. Only makes sense if they accept around €${feeRecommended.toLocaleString()} and never above €${feeMax.toLocaleString()}`
  }

  return {
    cpmReal: Math.round(cpmReal * 100) / 100,
    trafficLight,
    tier,
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
