/**
 * Market Benchmark — Client-safe version (no prisma dependency).
 * Pure functions over the shared benchmark config (src/lib/benchmarks.ts,
 * seed "SPAIN 2026 v1"). Safe to import in 'use client' components: pass the
 * config fetched from GET /api/settings/benchmarks when you have it, otherwise
 * DEFAULT_BENCHMARKS is used.
 *
 * The server module (src/lib/market-benchmark.ts) reuses these helpers and adds
 * the blend with the agency's own negotiations.
 */

import {
  DEFAULT_BENCHMARKS,
  detectTier,
  getCpmThreshold,
  getFeeRange,
  normalizeFormat,
  normalizePlatform,
  type BenchmarkConfig,
  type FeeFormat,
  type FeeRange,
  type PercentileLabels,
  type Platform,
  type Tier,
} from './benchmarks'

export type BenchmarkLocale = 'es' | 'en'
export type FeePosition = 'below_market' | 'fair' | 'above_market' | 'overpriced'
export type FeeBand = 'p25' | 'p50' | 'p75' | 'p90' | 'above_p90'

export interface QuickBenchmark {
  feeMin: number            // p25 — "Buen precio"
  feeTarget: number         // p50 — "Precio de mercado"
  feeMax: number            // p75 — "Máximo justificable"
  feeCeiling: number        // p90 — "Excepcional (solo con justificación)"
  tier: Tier
  platform: Platform
  format: FeeFormat
  /** Market multiplier applied (ES = 1.0). */
  marketMultiplier: number
  country: string | null
  /** CPM thresholds for this format × tier (fee ÷ median views × 1000). */
  cpmTarget: number | null
  cpmMax: number | null
  labels: PercentileLabels
  version: string
}

/** Percentile labels of a config in a locale (default Spanish). */
export function getPercentileLabels(config: BenchmarkConfig = DEFAULT_BENCHMARKS, locale: BenchmarkLocale = 'es'): PercentileLabels {
  return config.percentileLabels?.[locale] || DEFAULT_BENCHMARKS.percentileLabels[locale]
}

/**
 * Seed benchmark (no own-negotiation blend) for platform × followers (tier) × format.
 * `platform` accepts any casing; unknown → INSTAGRAM. `format` is normalized
 * (legacy YouTube VIDEO → INTEGRATION, TikTok always VIDEO).
 */
export function getQuickBenchmark(
  platform: string,
  followers: number,
  format?: string | null,
  config: BenchmarkConfig = DEFAULT_BENCHMARKS,
  country?: string | null,
  locale: BenchmarkLocale = 'es'
): QuickBenchmark {
  const plat = normalizePlatform(platform)
  const tier = detectTier(followers || 0)
  const { range, format: fmt, multiplier } = getFeeRange(config, plat, tier, format, country)
  const cpm = getCpmThreshold(config, plat, tier, fmt)
  return {
    feeMin: range[0],
    feeTarget: range[1],
    feeMax: range[2],
    feeCeiling: range[3],
    tier,
    platform: plat,
    format: fmt,
    marketMultiplier: multiplier,
    country: country ? country.toUpperCase() : null,
    cpmTarget: cpm?.cpmTarget ?? null,
    cpmMax: cpm?.cpmMax ?? null,
    labels: getPercentileLabels(config, locale),
    version: config.version,
  }
}

export interface FeeEvaluation {
  position: FeePosition
  /** Which percentile band the fee falls in. */
  band: FeeBand
  /** Label of that band from the config ("Precio de mercado"…); "Fuera de mercado" above p90. */
  label: string
  /** Approximate percentile of the fee within the range (1–99). */
  percentile: number
  /** "€p25–€p75" */
  marketRange: string
  detail: string
  tier: Tier
  format: FeeFormat
  labels: PercentileLabels
}

/**
 * Evaluate a fee against a [p25, p50, p75, p90] range. Shared by the client and
 * server evaluators so the wording and the bands stay identical.
 */
export function evaluateFeeAgainstRange(
  fee: number,
  range: FeeRange,
  labels: PercentileLabels,
  locale: BenchmarkLocale = 'es',
  meta: { tier: Tier; format: FeeFormat; formatLabel?: string }
): FeeEvaluation {
  const [p25, p50, p75, p90] = range
  const es = locale === 'es'
  const eur = (n: number) => `€${Math.round(n).toLocaleString()}`
  const lerp = (lo: number, hi: number, from: number, to: number) =>
    hi > lo ? from + Math.round(((fee - lo) / (hi - lo)) * (to - from)) : from

  let position: FeePosition
  let band: FeeBand
  let percentile: number
  if (fee <= p25) {
    position = 'below_market'; band = 'p25'
    percentile = p25 > 0 ? Math.round((fee / p25) * 25) : 1
  } else if (fee <= p50) {
    position = 'fair'; band = 'p50'
    percentile = lerp(p25, p50, 25, 50)
  } else if (fee <= p75) {
    position = 'fair'; band = 'p75'
    percentile = lerp(p50, p75, 50, 75)
  } else if (fee <= p90) {
    position = 'above_market'; band = 'p90'
    percentile = lerp(p75, p90, 75, 90)
  } else {
    position = 'overpriced'; band = 'above_p90'
    percentile = 95
  }
  percentile = Math.max(1, Math.min(99, percentile))

  const label = band === 'above_p90' ? (es ? 'Fuera de mercado' : 'Out of market') : labels[band]
  const marketRange = `${eur(p25)}–${eur(p75)}`
  const fmt = meta.formatLabel ? ` (${meta.formatLabel})` : ''

  let detail: string
  switch (band) {
    case 'p25':
      detail = es
        ? `${eur(fee)} está por debajo del rango de mercado ${marketRange}${fmt}: ${labels.p25.toLowerCase()}.`
        : `${eur(fee)} is below the market range ${marketRange}${fmt}: ${labels.p25.toLowerCase()}.`
      break
    case 'p50':
      detail = es
        ? `${eur(fee)} está dentro del rango de mercado ${marketRange}${fmt}, por debajo del precio de mercado (${eur(p50)}).`
        : `${eur(fee)} is within the market range ${marketRange}${fmt}, below the market price (${eur(p50)}).`
      break
    case 'p75':
      detail = es
        ? `${eur(fee)} está dentro del rango de mercado ${marketRange}${fmt}, por encima del precio de mercado (${eur(p50)}) pero dentro del máximo justificable.`
        : `${eur(fee)} is within the market range ${marketRange}${fmt}, above the market price (${eur(p50)}) but within the max justifiable.`
      break
    case 'p90':
      detail = es
        ? `${eur(fee)} supera el máximo justificable (${eur(p75)}); hasta ${eur(p90)} solo con justificación.`
        : `${eur(fee)} exceeds the max justifiable (${eur(p75)}); up to ${eur(p90)} only with justification.`
      break
    default:
      detail = es
        ? `${eur(fee)} supera el techo de mercado de ${eur(p90)}. Buscar alternativas.`
        : `${eur(fee)} exceeds the market ceiling of ${eur(p90)}. Consider alternatives.`
  }

  return { position, band, label, percentile, marketRange, detail, tier: meta.tier, format: meta.format, labels }
}

const FORMAT_LABEL: Record<BenchmarkLocale, Record<FeeFormat, string>> = {
  es: { POST: 'post', REEL: 'reel', STORY: 'story', VIDEO: 'vídeo', INTEGRATION: 'integración', DEDICATED: 'vídeo dedicado', SHORT: 'short' },
  en: { POST: 'post', REEL: 'reel', STORY: 'story', VIDEO: 'video', INTEGRATION: 'integration', DEDICATED: 'dedicated video', SHORT: 'short' },
}

export function benchmarkFormatLabel(format: FeeFormat, locale: BenchmarkLocale = 'es'): string {
  return FORMAT_LABEL[locale][format] || format.toLowerCase()
}

/**
 * Evaluate a fee against the seed market benchmarks (client-safe, no DB).
 * Detail text in Spanish by default; pass locale 'en' for English.
 */
export function evaluateFeeClient(
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
