/**
 * Deal Advisor™ — Intelligent pricing advisor for influencer collaborations.
 *
 * Evolves the CPM Calculator into a narrative-driven decision tool.
 * Instead of just showing if a CPM is green/yellow/red, it tells you:
 * - What this creator should cost based on the market (p25/p50/p75/p90 per
 *   platform × tier × format, from the shared benchmark config)
 * - How the asked fee compares to that range, once market (country) and
 *   commercial modifiers (rights, whitelisting, exclusivity…) are applied
 * - A specific recommendation with savings/overcost
 * - Context about WHY (views vs expected, tier position, CPM)
 *
 * Business rules (David + audit, 2026-09-04): followers only pick the tier;
 * the fee is evaluated against the format's percentiles; modifiers apply on
 * p50 additively and are shown itemized; the market multiplier scales by country.
 */

import { calculateCPM, formatLabel, tierLabel, type CPMResult } from './cpm-calculator'
import {
  DEFAULT_BENCHMARKS,
  applyModifiers,
  blendFeeRange,
  detectTier,
  findInternalCell,
  getFeeRange,
  normalizeFormat,
  normalizePlatform,
  type AppliedModifier,
  type BenchmarkConfig,
  type DealTerms,
  type FeeFormat,
  type FeeRange,
  type InternalCellExclusion,
  type InternalCellStats,
  type PercentileLabels,
  type Platform,
  type Tier,
} from './benchmarks'

// ============ TYPES ============

export interface DealAdvisorInput {
  username: string
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  avgViews: number
  avgLikes: number
  avgComments: number
  engagementRate: number
  askedFee: number           // What the creator is asking (for ONE piece of `format`)
  agreedFee?: number | null  // What was negotiated (if any)
  format?: string | null     // reel, post, story, video, integration, dedicated, short (normalized)
  /** ISO-3166 alpha-2 country of the campaign/creator → market multiplier (ES = 1.0). */
  country?: string | null
  /** Commercial terms → modifiers applied on p50 (rights, whitelisting, exclusivity, urgency…). */
  terms?: DealTerms | null
}

export interface DealAdvisorOptions {
  config?: BenchmarkConfig
  locale?: 'es' | 'en'
  /**
   * Own-negotiation cells (Setting benchmark_internal_stats). When given, the
   * Spain seed is blended with the matching cell (guarded by eligibility) before
   * the market multiplier — the same path getMarketBenchmark uses.
   */
  internalStats?: InternalCellStats[] | null
}

export type DealVerdict = 'excellent_deal' | 'fair_deal' | 'slightly_above' | 'overpriced' | 'way_overpriced'
export type PercentileBand = 'p25' | 'p50' | 'p75' | 'p90' | 'above_p90'

export interface PercentileRange { p25: number; p50: number; p75: number; p90: number }

export interface DealAdvisorResult {
  // Core verdict
  verdict: DealVerdict
  verdictSignal: 'green' | 'yellow' | 'red'
  verdictLabel: string       // "Precio de mercado", "Caro", etc. (localized)

  // Pricing analysis
  askedFee: number
  /** Recommended range = market range (p25–p75) × performance multiplier. */
  recommendedFeeMin: number
  recommendedFeeMax: number
  /** Recommended target = p50 after market, modifiers and performance. */
  recommendedFee: number
  /** Market range p25 / p75 after market multiplier and modifiers (no performance adjustment). */
  marketRangeMin: number
  marketRangeMax: number
  savingsOrOvercost: number  // positive = savings vs recommendedFee, negative = overcost
  savingsPercent: number

  // CPM data
  cpmReal: number
  cpmBenchmark: number | null
  cpmSignal: 'green' | 'yellow' | 'red' | 'gray'
  tier: Tier

  // Narrative
  narrative: string           // Full paragraph explaining the deal (localized)
  negotiationTip: string      // One-liner for negotiation (localized)
  narrativeKey: string        // i18n key

  // Underlying CPM result
  cpmResult: CPMResult

  // ---- Benchmark context (added 2026-09) ----
  locale: 'es' | 'en'
  format: FeeFormat
  country: string | null
  /** Market multiplier applied (ES = 1.0). */
  marketMultiplier: number
  /** Seed range for platform × tier × format, market-scaled, BEFORE modifiers. */
  seedRange: PercentileRange
  /** Range after market multiplier and modifiers (the one the pricing scenarios use). */
  marketRange: PercentileRange
  /** Range after market, modifiers AND performance (the one the verdict uses). */
  recommendedRange: PercentileRange
  /** Itemized modifiers applied on p50 (e.g. "Derechos 30 días +20 %"). */
  appliedModifiers: AppliedModifier[]
  /** Sum of modifier shares (0.20 = +20 %). */
  modifiersPct: number
  /** p50 after market and modifiers — the reference price to negotiate around. */
  referenceFee: number
  /** Where the asked fee sits: ≤p25, ≤p50, ≤p75, ≤p90 or above (against recommendedRange). */
  percentileBand: PercentileBand
  /** Label of that band, from the config ("Buen precio", "Precio de mercado"…). */
  percentileLabel: string
  percentileLabels: PercentileLabels
  /** avgViews ÷ expected views for the format, clamped 0.7–1.5. */
  performanceMultiplier: number
  benchmarkVersion: string
  /** Own negotiations in this platform × tier × format cell (0 when none). */
  ownDeals: number
  /** Where the base range came from: seed only, blended with own deals, or own deals dominating. */
  blendSource: 'seed' | 'blended' | 'internal'
  /** Weight of the own data in the base range (0–1). */
  blendWeight: number
  /** Why an existing own cell was NOT allowed to move the seed (single client, flat rate…). */
  blendExcluded: InternalCellExclusion | null
}

// ============ MAIN FUNCTION ============

export function analyzeDeal(input: DealAdvisorInput, options: DealAdvisorOptions = {}): DealAdvisorResult {
  const config = options.config ?? DEFAULT_BENCHMARKS
  const locale: 'es' | 'en' = options.locale === 'en' ? 'en' : 'es'
  const platform = normalizePlatform(input.platform)
  const tier = detectTier(input.followers || 0)
  const format = normalizeFormat(platform, input.format)
  const country = input.country ? input.country.toUpperCase() : null
  const labels = config.percentileLabels[locale] || DEFAULT_BENCHMARKS.percentileLabels[locale]

  // 1. CPM analysis (fee ÷ median views of the format × 1000 vs format × tier thresholds)
  const cpmResult = calculateCPM({
    platform,
    followers: input.followers,
    avgViews: input.avgViews,
    fee: input.askedFee,
    format,
  }, locale, config)

  // 2. Market range for platform × tier × format: Spain seed → guarded blend with the
  //    agency's own cell (own data is Spain-normalized, so blend first) → country multiplier
  const seed = getFeeRange(config, platform, tier, format, country)
  const seedRange = toRange(seed.range)
  const cell = findInternalCell(options.internalStats, platform, tier, format)
  const blend = blendFeeRange(getFeeRange(config, platform, tier, format).range, cell, config.internalBlend)
  const baseArr = blend.range.map(v => Math.round(v * seed.multiplier)) as FeeRange

  // 3. Commercial modifiers on p50 (and the whole range scaled by the same share)
  const mods = applyModifiers(baseArr[1], input.terms, config, locale)
  const scale = 1 + mods.totalPct
  const marketArr: FeeRange = [
    Math.round(baseArr[0] * scale),
    mods.fee,
    Math.round(baseArr[2] * scale),
    Math.round(baseArr[3] * scale),
  ]
  const marketRange = toRange(marketArr)
  const referenceFee = mods.fee

  // 4. Performance: views vs what the format usually gets for this follower count
  const performanceMultiplier = calculatePerformanceMultiplier(platform, format, input.followers, input.avgViews)
  const recArr = marketArr.map(v => Math.round(v * performanceMultiplier)) as FeeRange
  const recommendedRange = toRange(recArr)

  // 5. Verdict against the performance-adjusted percentiles
  const { verdict, verdictSignal, band } = determineVerdict(input.askedFee, recArr)
  const verdictLabel = VERDICT_LABELS[locale][verdict]
  const percentileLabel = band === 'above_p90'
    ? (locale === 'es' ? 'Fuera de mercado' : 'Out of market')
    : labels[band]

  // 6. Savings / overcost vs the recommended target (p50)
  const recommendedFee = recArr[1]
  const savingsOrOvercost = recommendedFee - input.askedFee
  const savingsPercent = recommendedFee > 0 ? Math.round((savingsOrOvercost / recommendedFee) * 100) : 0

  // 7. Narrative
  const ctx: NarrativeContext = {
    input, locale, verdict, tier, platform, format, recArr, marketArr, cpmResult,
    performanceMultiplier, applied: mods.applied, marketMultiplier: seed.multiplier, country, labels,
  }
  const { narrative, negotiationTip, narrativeKey } = generateNarrative(ctx)

  return {
    verdict,
    verdictSignal,
    verdictLabel,
    askedFee: input.askedFee,
    recommendedFeeMin: recArr[0],
    recommendedFeeMax: recArr[2],
    recommendedFee,
    marketRangeMin: marketArr[0],
    marketRangeMax: marketArr[2],
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
    locale,
    format,
    country,
    marketMultiplier: seed.multiplier,
    seedRange,
    marketRange,
    recommendedRange,
    appliedModifiers: mods.applied,
    modifiersPct: mods.totalPct,
    referenceFee,
    percentileBand: band,
    percentileLabel,
    percentileLabels: labels,
    performanceMultiplier,
    benchmarkVersion: config.version,
    ownDeals: cell?.n ?? 0,
    blendSource: blend.source,
    blendWeight: blend.weight,
    blendExcluded: blend.excluded,
  }
}

// ============ HELPERS ============

function toRange(r: FeeRange): PercentileRange {
  return { p25: r[0], p50: r[1], p75: r[2], p90: r[3] }
}

/** Expected views as a share of followers, per platform × format. */
export const EXPECTED_VIEW_RATES: Record<Platform, Partial<Record<FeeFormat, number>> & { default: number }> = {
  INSTAGRAM: { REEL: 0.20, POST: 0.10, STORY: 0.07, default: 0.20 },
  TIKTOK: { VIDEO: 0.30, default: 0.30 },
  YOUTUBE: { INTEGRATION: 0.10, DEDICATED: 0.10, SHORT: 0.10, default: 0.10 },
}

export const PERFORMANCE_CLAMP: [number, number] = [0.7, 1.5]

/**
 * avgViews ÷ (followers × expected rate), clamped to 0.7–1.5 so an outlier
 * never moves the fee by more than ±50 % / −30 %.
 */
export function calculatePerformanceMultiplier(platform: Platform, format: FeeFormat, followers: number, avgViews: number): number {
  if (!followers || followers <= 0 || !avgViews || avgViews <= 0) return 1.0
  const rates = EXPECTED_VIEW_RATES[platform] || EXPECTED_VIEW_RATES.INSTAGRAM
  const expected = rates[format] ?? rates.default
  const ratio = (avgViews / followers) / expected
  const clamped = Math.max(PERFORMANCE_CLAMP[0], Math.min(PERFORMANCE_CLAMP[1], ratio))
  return Math.round(clamped * 100) / 100
}

const VERDICT_LABELS: Record<'es' | 'en', Record<DealVerdict, string>> = {
  es: {
    excellent_deal: 'Muy buen precio',
    fair_deal: 'Precio de mercado',
    slightly_above: 'Algo por encima del mercado',
    overpriced: 'Caro',
    way_overpriced: 'Muy caro',
  },
  en: {
    excellent_deal: 'Excellent deal',
    fair_deal: 'Fair deal',
    slightly_above: 'Slightly above market',
    overpriced: 'Overpriced',
    way_overpriced: 'Way overpriced',
  },
}

function determineVerdict(
  fee: number, [p25, p50, p75, p90]: FeeRange
): { verdict: DealVerdict; verdictSignal: DealAdvisorResult['verdictSignal']; band: PercentileBand } {
  if (fee <= p25) return { verdict: 'excellent_deal', verdictSignal: 'green', band: 'p25' }
  if (fee <= p50) return { verdict: 'fair_deal', verdictSignal: 'green', band: 'p50' }
  if (fee <= p75) return { verdict: 'slightly_above', verdictSignal: 'yellow', band: 'p75' }
  if (fee <= p90) return { verdict: 'overpriced', verdictSignal: 'red', band: 'p90' }
  return { verdict: 'way_overpriced', verdictSignal: 'red', band: 'above_p90' }
}

interface NarrativeContext {
  input: DealAdvisorInput
  locale: 'es' | 'en'
  verdict: DealVerdict
  tier: Tier
  platform: Platform
  format: FeeFormat
  recArr: FeeRange
  marketArr: FeeRange
  cpmResult: CPMResult
  performanceMultiplier: number
  applied: AppliedModifier[]
  marketMultiplier: number
  country: string | null
  labels: PercentileLabels
}

const eur = (n: number) => `€${Math.round(n).toLocaleString()}`
const pct = (p: number) => `${p > 0 ? '+' : ''}${Math.round(p * 100)} %`
const PLATFORM_NAME: Record<Platform, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

function generateNarrative(ctx: NarrativeContext): { narrative: string; negotiationTip: string; narrativeKey: string } {
  const { input, locale, verdict, tier, platform, format, recArr, cpmResult, performanceMultiplier, applied, marketMultiplier, country } = ctx
  const es = locale === 'es'
  const [recMin, recP50, recMax, recP90] = recArr
  const fee = input.askedFee
  const feeStr = eur(fee)
  const rangeStr = `${eur(recMin)}–${eur(recMax)}`
  const p50Str = eur(recP50)
  const p90Str = eur(recP90)
  const cpmStr = `€${(cpmResult.cpmReal || 0).toFixed(0)}`
  const cpmTargetStr = cpmResult.cpmTarget !== null ? `€${cpmResult.cpmTarget}` : null
  const viewsStr = input.avgViews.toLocaleString()
  const platformStr = PLATFORM_NAME[platform] || platform
  const tierStr = tierLabel(tier)
  const fmtStr = formatLabel(format, locale)
  const who = `@${input.username}`

  // Context sentences shared by every verdict
  const perfNote = performanceMultiplier > 1.05
    ? (es ? ` Sus vistas están por encima de lo habitual para su tamaño (×${performanceMultiplier.toFixed(2)} sobre el rango).` : ` Their views are above what is usual for their size (×${performanceMultiplier.toFixed(2)} on the range).`)
    : performanceMultiplier < 0.95
      ? (es ? ` Sus vistas están por debajo de lo habitual para su tamaño (×${performanceMultiplier.toFixed(2)} sobre el rango).` : ` Their views are below what is usual for their size (×${performanceMultiplier.toFixed(2)} on the range).`)
      : ''
  const modsNote = applied.length > 0
    ? (es
      ? ` El rango incluye ${applied.map(a => `${a.label} ${pct(a.pct)}`).join(', ')}.`
      : ` The range includes ${applied.map(a => `${a.label} ${pct(a.pct)}`).join(', ')}.`)
    : ''
  const marketNote = country && marketMultiplier !== 1
    ? (es ? ` Mercado ${country} (×${marketMultiplier}).` : ` ${country} market (×${marketMultiplier}).`)
    : ''
  const cpmNote = cpmTargetStr
    ? (es ? `CPM ${cpmStr} frente a un objetivo de ${cpmTargetStr}` : `CPM ${cpmStr} vs a target of ${cpmTargetStr}`)
    : (es ? `CPM ${cpmStr}` : `CPM ${cpmStr}`)
  // Fee benchmark and CPM performance are two separate checks: warn when they disagree.
  const feeOk = verdict === 'excellent_deal' || verdict === 'fair_deal'
  const cpmMaxStr = cpmResult.cpmMax !== null ? `€${cpmResult.cpmMax}` : null
  const cpmCaveat = feeOk && cpmResult.trafficLight === 'red' && cpmMaxStr
    ? (es
      ? ` Ojo: el CPM supera el máximo aceptable (${cpmMaxStr}) para este formato y tier; sus vistas no justifican el fee aunque el precio esté en rango${cpmResult.feeMax !== null ? ` (por CPM no pagar más de ${eur(cpmResult.feeMax)})` : ''}.`
      : ` Note: the CPM exceeds the max acceptable (${cpmMaxStr}) for this format and tier; the views don't justify the fee even though the price is in range${cpmResult.feeMax !== null ? ` (by CPM don't pay more than ${eur(cpmResult.feeMax)})` : ''}.`)
    : !feeOk && cpmResult.trafficLight === 'green'
      ? (es
        ? ` Eso sí, el CPM está dentro del objetivo: sus vistas son altas para el fee que pide.`
        : ` That said, the CPM is within target: the views are high for the fee asked.`)
      : ''
  const tail = `${cpmCaveat}${perfNote}${modsNote}${marketNote}`

  switch (verdict) {
    case 'excellent_deal':
      return {
        narrative: es
          ? `${who} pide ${feeStr} por un ${fmtStr}, por debajo del rango de mercado de ${rangeStr} para un creador ${tierStr} de ${platformStr}. Con ${viewsStr} vistas medias, ${cpmNote}: muy buen valor.${tail}`
          : `${who} is asking ${feeStr} for a ${fmtStr}, below the market range of ${rangeStr} for a ${tierStr} ${platformStr} creator. With ${viewsStr} avg views, ${cpmNote}: excellent value.${tail}`,
        negotiationTip: es
          ? `Aceptar este fee. Está por debajo de mercado: cerrarlo ya es lo inteligente.`
          : `Accept this fee. It's below market — locking it in is smart.`,
        narrativeKey: 'deal_excellent',
      }
    case 'fair_deal':
      return {
        narrative: es
          ? `${who} pide ${feeStr} por un ${fmtStr}, dentro del rango de mercado de ${rangeStr} (precio de mercado ${p50Str}) para un creador ${tierStr} de ${platformStr}. Con ${viewsStr} vistas medias, ${cpmNote}: un acuerdo razonable y alineado con el mercado.${tail}`
          : `${who} is asking ${feeStr} for a ${fmtStr}, within the market range of ${rangeStr} (market price ${p50Str}) for a ${tierStr} ${platformStr} creator. With ${viewsStr} avg views, ${cpmNote}: a reasonable deal aligned with the market.${tail}`,
        negotiationTip: es
          ? `Precio justo. Puedes intentar bajar a ${eur(recMin)}, pero este fee es defendible.`
          : `Fair price. You could try negotiating to ${eur(recMin)} but this fee is defensible.`,
        narrativeKey: 'deal_fair',
      }
    case 'slightly_above':
      return {
        narrative: es
          ? `${who} pide ${feeStr} por un ${fmtStr}, por encima del precio de mercado (${p50Str}) aunque dentro del máximo justificable (${eur(recMax)}) para un creador ${tierStr} de ${platformStr}. ${cpmNote.charAt(0).toUpperCase()}${cpmNote.slice(1)}. Solo se justifica si el engagement o la calidad del contenido son excepcionales.${tail}`
          : `${who} is asking ${feeStr} for a ${fmtStr}, above the market price (${p50Str}) though within the max justifiable (${eur(recMax)}) for a ${tierStr} ${platformStr} creator. ${cpmNote.charAt(0).toUpperCase()}${cpmNote.slice(1)}. Only justified if engagement or content quality is exceptional.${tail}`,
        negotiationTip: es
          ? `Negociar hacia ${p50Str} (rango ${rangeStr}). Apóyate en los benchmarks de mercado para la contraoferta.`
          : `Negotiate down to ${p50Str} (range ${rangeStr}). Mention market benchmarks to support your counter-offer.`,
        narrativeKey: 'deal_above',
      }
    case 'overpriced':
      return {
        narrative: es
          ? `${who} pide ${feeStr} por un ${fmtStr}, claramente por encima del rango de mercado de ${rangeStr} para un creador ${tierStr} de ${platformStr} (solo excepcionalmente se paga hasta ${p90Str}). Con ${viewsStr} vistas medias, ${cpmNote}: muy por encima del benchmark. Negociar o buscar alternativas.${tail}`
          : `${who} is asking ${feeStr} for a ${fmtStr}, clearly above the market range of ${rangeStr} for a ${tierStr} ${platformStr} creator (only exceptionally up to ${p90Str}). With ${viewsStr} avg views, ${cpmNote}: well above benchmark. Negotiate or explore alternatives.${tail}`,
        negotiationTip: es
          ? `Contraofertar en ${rangeStr}. Si no cede, mira creadores similares de este tier: hay mejores acuerdos disponibles.`
          : `Counter at ${rangeStr}. If they won't budge, look at similar creators in this tier — there are better deals available.`,
        narrativeKey: 'deal_overpriced',
      }
    default: // way_overpriced
      return {
        narrative: es
          ? `${who} pide ${feeStr} por un ${fmtStr}, muy por encima de cualquier rango razonable (${rangeStr}, excepcional hasta ${p90Str}) para un creador ${tierStr} de ${platformStr}. ${cpmNote.charAt(0).toUpperCase()}${cpmNote.slice(1)}: insostenible. Recomendamos buscar alternativas.${tail}`
          : `${who} is asking ${feeStr} for a ${fmtStr}, far above any reasonable market range (${rangeStr}, exceptional up to ${p90Str}) for a ${tierStr} ${platformStr} creator. ${cpmNote.charAt(0).toUpperCase()}${cpmNote.slice(1)}: unsustainable. We strongly recommend exploring alternatives.${tail}`,
        negotiationTip: es
          ? `No aceptar este fee. Contraofertar en ${rangeStr} o buscar otro creador.`
          : `Do not accept this fee. Counter at ${rangeStr} or find an alternative creator.`,
        narrativeKey: 'deal_way_overpriced',
      }
  }
}
