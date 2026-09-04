/**
 * BENCHMARKS — single source of truth for pricing benchmarks.
 *
 * Seed: "SPAIN 2026 v1" (David + consultant audit, 2026-09-04). Everything here
 * is editable in Ajustes → Benchmarks (Setting keys benchmark_*), optionally
 * per brand (suffix _{brandId}); server code loads the merged config with
 * loadBenchmarkConfig() from '@/lib/benchmarks-server' and passes it to the
 * pure functions in this file. Client code uses DEFAULT_BENCHMARKS or a config
 * fetched from GET /api/settings/benchmarks.
 *
 * Four blocks, kept separate on purpose:
 *   1. Fee benchmark      — is this fee cheap or expensive vs the market? (p25/p50/p75/p90 per platform × tier × format)
 *   2. Performance (CPM)  — what CPM should we accept for this format × tier? (fee ÷ median views × 1000)
 *   3. EMV                — see src/lib/emv.ts (David's decision: post 10 €, reel 14 €, story 8 €)
 *   4. Commercial modifiers — rights, whitelisting, exclusivity, urgency, crossposting, bundles (applied on p50)
 * Plus a market multiplier (Spain = 1.0) and the blending rule with the agency's own negotiations.
 *
 * Followers only pick the tier; prices are evaluated on MEDIAN VIEWS of the format.
 */

export type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
export type Tier = 'NANO' | 'MICRO' | 'MID' | 'MACRO' | 'MEGA'
/** Negotiation formats. YouTube VIDEO (legacy) maps to INTEGRATION; TikTok SHORT (legacy) maps to VIDEO. */
export type FeeFormat = 'POST' | 'REEL' | 'STORY' | 'VIDEO' | 'INTEGRATION' | 'DEDICATED' | 'SHORT'
/** [p25, p50, p75, p90] in EUR, excl. VAT and agency commission. */
export type FeeRange = [number, number, number, number]

export interface CpmThreshold {
  platform: Platform
  format: FeeFormat
  tier: Tier
  /** Green ceiling: CPM we aim to pay (fee ÷ median views × 1000). */
  cpmTarget: number
  /** Yellow ceiling: max acceptable; above = red. */
  cpmMax: number
}

export interface CommercialModifiers {
  /** Usage/paid rights by duration (share added on p50). */
  rights: { d30: number; d90: number; d180: number; perpetual: number }
  /** Brand runs the content as ads from the creator's handle (whitelisting / Spark Ads). */
  whitelisting: number
  /** Category exclusivity by duration. */
  exclusivity: { d30: number; d90: number; d365: number }
  /** Delivery in < 7 days. */
  urgency: number
  /** Same content published on a second platform. */
  crossposting: number
  /** 3+ pieces in one deal (negative = discount). */
  bundle3: number
  /** Recurring collaboration ≥ 6 months (negative = discount). */
  recurring6m: number
}

export interface PercentileLabels {
  p25: string
  p50: string
  p75: string
  p90: string
}

export interface InternalBlendRules {
  /** Effective negotiations needed in a cell before its own percentiles are trusted at all. */
  minSample: number
  /** Shrinkage: blended = (n·own + k·seed) / (n + k). k = 10 → 10 deals weigh as much as the seed. */
  shrinkageK: number
  /** Trim this share from each tail before computing percentiles. */
  trimPct: number
  /**
   * Distinct clients (brand handle of the campaign) a cell needs before its own
   * data may move the seed. One client's fixed-fee programme is a price list,
   * not a market observation.
   */
  minBrands: number
  /** Deals older than this (dealClosedAt, else updatedAt) are ignored by the recompute. */
  maxAgeMonths: number
}

export interface BenchmarkConfig {
  version: string
  feeRanges: Record<Platform, Record<Tier, Partial<Record<FeeFormat, FeeRange>>>>
  /** Story pack of 3 = single story × this (packs are negotiated with a discount). */
  storyPackMultiplier: number
  cpmThresholds: CpmThreshold[]
  /** ISO-3166 alpha-2 country → price multiplier (Spain = 1.0). */
  markets: Record<string, number>
  modifiers: CommercialModifiers
  percentileLabels: { es: PercentileLabels; en: PercentileLabels }
  internalBlend: InternalBlendRules
}

// ============ SEED: SPAIN 2026 v1 ============

const TIERS: Tier[] = ['NANO', 'MICRO', 'MID', 'MACRO', 'MEGA']

const IG = (post: FeeRange, reel: FeeRange, story: FeeRange) => ({ POST: post, REEL: reel, STORY: story })
const TT = (video: FeeRange) => ({ VIDEO: video })
const YT = (integration: FeeRange, dedicated: FeeRange, short: FeeRange) => ({ INTEGRATION: integration, DEDICATED: dedicated, SHORT: short })
const x = (r: FeeRange, m: number): FeeRange => r.map(v => Math.round(v * m / 10) * 10) as FeeRange

export const DEFAULT_BENCHMARKS: BenchmarkConfig = {
  version: 'SPAIN 2026 v1',
  feeRanges: {
    INSTAGRAM: {
      NANO:  IG([50, 90, 150, 220],          [80, 150, 250, 350],            [20, 35, 55, 80]),
      MICRO: IG([150, 250, 400, 600],        [250, 400, 600, 850],           [45, 75, 120, 180]),
      MID:   IG([450, 750, 1200, 1800],      [700, 1100, 1800, 2800],        [130, 220, 350, 550]),
      MACRO: IG([1400, 2300, 3800, 6000],    [2200, 3500, 6000, 9000],       [350, 600, 1000, 1600]),
      MEGA:  IG([4500, 8000, 13000, 20000],  [8000, 13000, 20000, 32000],    [1100, 1800, 3000, 4800]),
    },
    TIKTOK: {
      NANO:  TT([60, 110, 180, 280]),
      MICRO: TT([150, 250, 400, 600]),
      MID:   TT([400, 650, 1100, 1800]),
      MACRO: TT([1100, 2000, 3500, 5500]),
      MEGA:  TT([3500, 6000, 10000, 16000]),
    },
    YOUTUBE: {
      NANO:  YT([120, 200, 350, 500],        x([120, 200, 350, 500], 1.8),        [60, 100, 170, 260]),
      MICRO: YT([300, 500, 800, 1200],       x([300, 500, 800, 1200], 1.8),       [150, 250, 400, 600]),
      MID:   YT([700, 1200, 2000, 3200],     x([700, 1200, 2000, 3200], 1.8),     [350, 600, 1000, 1500]),
      MACRO: YT([2000, 3500, 6000, 9000],    x([2000, 3500, 6000, 9000], 1.8),    [900, 1600, 2800, 4500]),
      MEGA:  YT([6000, 10000, 18000, 30000], x([6000, 10000, 18000, 30000], 1.8), [2500, 4500, 7500, 12000]),
    },
  },
  storyPackMultiplier: 2.5,
  // CPM accepted for a creator fee = fee ÷ median views of the format × 1000.
  // Views are bought cheaper at scale, so the acceptable CPM FALLS with tier.
  cpmThresholds: [
    ...cpmRow('INSTAGRAM', 'REEL',        [[40, 60], [30, 45], [22, 32], [16, 24], [12, 18]]),
    ...cpmRow('INSTAGRAM', 'POST',        [[45, 65], [35, 50], [25, 38], [18, 28], [14, 22]]),
    ...cpmRow('INSTAGRAM', 'STORY',       [[40, 60], [30, 45], [25, 38], [20, 30], [16, 25]]),
    ...cpmRow('TIKTOK',    'VIDEO',       [[25, 40], [18, 30], [12, 20], [8, 14],  [6, 10]]),
    ...cpmRow('YOUTUBE',   'INTEGRATION', [[30, 45], [25, 35], [25, 35], [22, 32], [20, 30]]),
    ...cpmRow('YOUTUBE',   'DEDICATED',   [[40, 60], [35, 55], [35, 55], [30, 48], [28, 45]]),
    ...cpmRow('YOUTUBE',   'SHORT',       [[22, 35], [18, 30], [15, 25], [12, 20], [10, 16]]),
  ],
  markets: { ES: 1.0, PT: 0.8, MX: 0.5, CO: 0.4, AR: 0.4, CL: 0.5, PE: 0.4, GB: 1.4, DE: 1.3, FR: 1.3, IT: 1.0, US: 1.6 },
  modifiers: {
    rights: { d30: 0.20, d90: 0.40, d180: 0.70, perpetual: 1.20 },
    whitelisting: 0.40,
    exclusivity: { d30: 0.25, d90: 0.50, d365: 1.00 },
    urgency: 0.25,
    crossposting: 0.25,
    bundle3: -0.15,
    recurring6m: -0.25,
  },
  percentileLabels: {
    es: { p25: 'Buen precio', p50: 'Precio de mercado', p75: 'Máximo justificable', p90: 'Excepcional (solo con justificación)' },
    en: { p25: 'Good price', p50: 'Market price', p75: 'Max justifiable', p90: 'Exceptional (needs justification)' },
  },
  internalBlend: { minSample: 20, shrinkageK: 10, trimPct: 0.05, minBrands: 3, maxAgeMonths: 24 },
}

function cpmRow(platform: Platform, format: FeeFormat, pairs: Array<[number, number]>): CpmThreshold[] {
  return pairs.map(([cpmTarget, cpmMax], i) => ({ platform, format, tier: TIERS[i], cpmTarget, cpmMax }))
}

// ============ HELPERS ============

export const TIER_BOUNDS: Record<Tier, [number, number]> = {
  NANO: [0, 10_000],
  MICRO: [10_000, 50_000],
  MID: [50_000, 250_000],
  MACRO: [250_000, 1_000_000],
  MEGA: [1_000_000, Number.POSITIVE_INFINITY],
}

export function detectTier(followers: number): Tier {
  if (followers >= 1_000_000) return 'MEGA'
  if (followers >= 250_000) return 'MACRO'
  if (followers >= 50_000) return 'MID'
  if (followers >= 10_000) return 'MICRO'
  return 'NANO'
}

export function normalizePlatform(p: string | null | undefined): Platform {
  const u = (p || '').toUpperCase()
  return u === 'TIKTOK' || u === 'YOUTUBE' ? u : 'INSTAGRAM'
}

/** Canonical negotiation format for a platform (legacy aliases resolved). */
export function normalizeFormat(platform: Platform, format?: string | null): FeeFormat {
  const f = (format || '').toUpperCase().replace(/S$/, '') // "REELS" → "REEL"
  if (platform === 'TIKTOK') return 'VIDEO'
  if (platform === 'YOUTUBE') {
    if (f === 'SHORT') return 'SHORT'
    if (f === 'DEDICATED') return 'DEDICATED'
    return 'INTEGRATION' // VIDEO (legacy) and default
  }
  if (f === 'STORY') return 'STORY'
  if (f === 'POST' || f === 'CAROUSEL' || f === 'IMAGE') return 'POST'
  return 'REEL' // REEL, VIDEO and default
}

/** Map a captured Media.mediaType to the negotiation format of its platform. */
export function mediaTypeToFormat(platform: Platform, mediaType: string | null | undefined): FeeFormat {
  const t = (mediaType || '').toUpperCase()
  if (platform === 'TIKTOK') return 'VIDEO'
  if (platform === 'YOUTUBE') return t === 'SHORT' ? 'SHORT' : 'INTEGRATION'
  if (t === 'STORY') return 'STORY'
  if (t === 'REEL' || t === 'VIDEO') return 'REEL'
  return 'POST'
}

export function formatsFor(platform: Platform): FeeFormat[] {
  if (platform === 'TIKTOK') return ['VIDEO']
  if (platform === 'YOUTUBE') return ['INTEGRATION', 'DEDICATED', 'SHORT']
  return ['POST', 'REEL', 'STORY']
}

export function marketMultiplier(config: BenchmarkConfig, country?: string | null): number {
  if (!country) return 1
  const m = config.markets[country.toUpperCase()]
  return typeof m === 'number' && m > 0 ? m : 1
}

/** Fee range for platform × tier × format, scaled by market. STORY is ONE story. */
export function getFeeRange(
  config: BenchmarkConfig,
  platform: Platform,
  tier: Tier,
  format?: string | null,
  country?: string | null
): { range: FeeRange; format: FeeFormat; multiplier: number } {
  const fmt = normalizeFormat(platform, format)
  const byTier = config.feeRanges[platform]?.[tier] || {}
  const base = byTier[fmt] || byTier[formatsFor(platform)[0]] || DEFAULT_BENCHMARKS.feeRanges[platform][tier][fmt] || [100, 300, 600, 1000]
  const multiplier = marketMultiplier(config, country)
  const range = base.map(v => Math.round(v * multiplier)) as FeeRange
  return { range, format: fmt, multiplier }
}

export function getCpmThreshold(
  config: BenchmarkConfig,
  platform: Platform,
  tier: Tier,
  format?: string | null
): CpmThreshold | null {
  const fmt = normalizeFormat(platform, format)
  return (
    config.cpmThresholds.find(t => t.platform === platform && t.format === fmt && t.tier === tier) ||
    DEFAULT_BENCHMARKS.cpmThresholds.find(t => t.platform === platform && t.format === fmt && t.tier === tier) ||
    null
  )
}

export interface DealTerms {
  rightsDays?: number | null        // 30 / 90 / 180 / -1 (perpetual)
  whitelisting?: boolean | null
  exclusivityDays?: number | null   // 30 / 90 / 365
  urgent?: boolean | null
  crossposting?: boolean | null
  bundle3?: boolean | null
  recurring6m?: boolean | null
}

export interface AppliedModifier { key: string; label: string; pct: number }

/**
 * Commercial modifiers are applied on the market price (p50), additively, and
 * returned itemized so the PM sees why the reference moved.
 */
export function applyModifiers(
  baseFee: number,
  terms: DealTerms | null | undefined,
  config: BenchmarkConfig,
  locale: 'es' | 'en' = 'es'
): { fee: number; totalPct: number; applied: AppliedModifier[] } {
  const m = config.modifiers
  const applied: AppliedModifier[] = []
  const L = (es: string, en: string) => (locale === 'es' ? es : en)
  if (terms?.rightsDays) {
    const d = terms.rightsDays
    if (d < 0) applied.push({ key: 'rights_perpetual', label: L('Derechos perpetuos', 'Perpetual rights'), pct: m.rights.perpetual })
    else if (d >= 180) applied.push({ key: 'rights_180', label: L('Derechos 180 días', 'Rights 180 days'), pct: m.rights.d180 })
    else if (d >= 90) applied.push({ key: 'rights_90', label: L('Derechos 90 días', 'Rights 90 days'), pct: m.rights.d90 })
    else applied.push({ key: 'rights_30', label: L('Derechos 30 días', 'Rights 30 days'), pct: m.rights.d30 })
  }
  if (terms?.whitelisting) applied.push({ key: 'whitelisting', label: L('Whitelisting / Spark Ads', 'Whitelisting / Spark Ads'), pct: m.whitelisting })
  if (terms?.exclusivityDays) {
    const d = terms.exclusivityDays
    if (d >= 365) applied.push({ key: 'excl_365', label: L('Exclusividad 12 meses', 'Exclusivity 12 months'), pct: m.exclusivity.d365 })
    else if (d >= 90) applied.push({ key: 'excl_90', label: L('Exclusividad 90 días', 'Exclusivity 90 days'), pct: m.exclusivity.d90 })
    else applied.push({ key: 'excl_30', label: L('Exclusividad 30 días', 'Exclusivity 30 days'), pct: m.exclusivity.d30 })
  }
  if (terms?.urgent) applied.push({ key: 'urgency', label: L('Urgencia (< 7 días)', 'Urgency (< 7 days)'), pct: m.urgency })
  if (terms?.crossposting) applied.push({ key: 'crossposting', label: L('Crossposting 2ª plataforma', 'Crossposting 2nd platform'), pct: m.crossposting })
  if (terms?.bundle3) applied.push({ key: 'bundle3', label: L('Bundle 3+ piezas', 'Bundle 3+ pieces'), pct: m.bundle3 })
  if (terms?.recurring6m) applied.push({ key: 'recurring6m', label: L('Colaboración recurrente 6 meses', 'Recurring 6 months'), pct: m.recurring6m })
  const totalPct = applied.reduce((s, a) => s + a.pct, 0)
  return { fee: Math.round(baseFee * (1 + totalPct)), totalPct, applied }
}

// ============ INTERNAL NEGOTIATIONS → OWN PERCENTILES ============

/** Why a cell is shown but not allowed to move the seed. */
export type InternalCellExclusion = 'single_client' | 'few_clients' | 'flat_rate' | 'no_effective_sample'

export interface InternalCellStats {
  platform: Platform
  tier: Tier
  format: FeeFormat
  n: number
  fees: FeeRange            // own p25/p50/p75/p90 after trimming
  cpm?: { p25: number; p50: number; p75: number } | null
  updatedAt: string
  /** Distinct clients behind the deals (campaign brand handle → brand id → campaign). */
  brands?: number
  /** n discounted by client concentration: round(n × (1 − HHI)). One client → 0. */
  nEffective?: number
  /** p25 = p90 after trimming: a fixed-fee programme, not a market. */
  flatRate?: boolean
  /** True only when the recompute assessed the cell and allowed it to move the seed. Missing (legacy v1 cell) = not eligible. */
  eligible?: boolean
  reason?: InternalCellExclusion | null
}

/**
 * Anti-bias assessment of an own-negotiation cell. `clientCounts` = deals per
 * distinct client. Herfindahl index HHI = Σ share²; effective n = n × (1 − HHI),
 * so 50 deals from one client count as 0 and 50 deals split evenly across 5
 * clients count as 40.
 */
export function assessInternalCell(
  n: number,
  fees: FeeRange,
  clientCounts: number[],
  rules: InternalBlendRules
): { brands: number; nEffective: number; flatRate: boolean; eligible: boolean; reason: InternalCellExclusion | null } {
  const total = clientCounts.reduce((a, b) => a + b, 0)
  const hhi = total > 0 ? clientCounts.reduce((acc, c) => acc + (c / total) ** 2, 0) : 1
  const brands = clientCounts.filter(c => c > 0).length
  const nEffective = Math.max(0, Math.round(n * (1 - hhi)))
  const flatRate = n > 0 && fees[0] === fees[3]
  let reason: InternalCellExclusion | null = null
  if (brands <= 1) reason = 'single_client'
  else if (brands < rules.minBrands) reason = 'few_clients'
  else if (flatRate) reason = 'flat_rate'
  else if (nEffective < 1) reason = 'no_effective_sample'
  return { brands, nEffective, flatRate, eligible: reason === null, reason }
}

/** Pure lookup of a cell (server code wraps it; the deal advisor uses it directly). */
export function findInternalCell(
  stats: InternalCellStats[] | null | undefined,
  platform: Platform,
  tier: Tier,
  format: FeeFormat
): InternalCellStats | null {
  if (!stats || stats.length === 0) return null
  return stats.find(s => s.platform === platform && s.tier === tier && s.format === format) || null
}

/** Percentile with linear interpolation on a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Trim `trimPct` from each tail (winsorize by dropping) and return sorted values. */
export function trimmed(values: number[], trimPct: number): number[] {
  const sorted = [...values].filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const cut = Math.floor(sorted.length * trimPct)
  return cut > 0 && sorted.length - 2 * cut >= 5 ? sorted.slice(cut, sorted.length - cut) : sorted
}

/**
 * Blend the seed with the agency's own negotiations for a cell:
 * blended = (n·own + k·seed) / (n + k). Below minSample the own data only
 * nudges the seed; at n = k they weigh the same; at n ≫ k the seed vanishes.
 */
export function blendFeeRange(seed: FeeRange, own: InternalCellStats | null | undefined, rules: InternalBlendRules): {
  range: FeeRange
  /** Own negotiations in the cell (informative even when excluded). */
  n: number
  weight: number
  source: 'seed' | 'blended' | 'internal'
  /** Set when the cell exists but was not allowed to move the seed. */
  excluded: InternalCellExclusion | null
} {
  if (!own || own.n <= 0) return { range: seed, n: 0, weight: 0, source: 'seed', excluded: null }
  // Only cells the recompute explicitly cleared may move the seed; legacy cells without the
  // guard fields are shown but ignored until the next recompute assesses them.
  if (own.eligible !== true) {
    return { range: seed, n: own.n, weight: 0, source: 'seed', excluded: own.reason ?? 'no_effective_sample' }
  }
  const nEff = typeof own.nEffective === 'number' && Number.isFinite(own.nEffective) ? Math.max(0, own.nEffective) : own.n
  if (nEff < 1) return { range: seed, n: own.n, weight: 0, source: 'seed', excluded: 'no_effective_sample' }
  const weight = nEff / (nEff + rules.shrinkageK)
  const range = seed.map((s, i) => Math.round(own.fees[i] * weight + s * (1 - weight))) as FeeRange
  return { range, n: own.n, weight, source: nEff >= rules.minSample && weight > 0.8 ? 'internal' : 'blended', excluded: null }
}

// ============ CONFIG MERGE (tolerant of old stored shapes) ============

const OLD_YT_ALIAS: Record<string, FeeFormat> = { VIDEO: 'INTEGRATION' }

export function mergeBenchmarkConfig(partial: Partial<Record<string, unknown>> | null | undefined): BenchmarkConfig {
  const p = (partial || {}) as Record<string, unknown>
  const cfg: BenchmarkConfig = JSON.parse(JSON.stringify(DEFAULT_BENCHMARKS))

  // Fee ranges: accept the legacy shape { INSTAGRAM: { NANO: { POST: [...] } } }
  const fr = p.feeRanges as Record<string, Record<string, Record<string, unknown>>> | undefined
  if (fr && typeof fr === 'object') {
    for (const plat of Object.keys(fr)) {
      const platform = normalizePlatform(plat)
      for (const tierKey of Object.keys(fr[plat] || {})) {
        const tier = tierKey.toUpperCase() as Tier
        if (!TIERS.includes(tier)) continue
        for (const fmtKey of Object.keys(fr[plat][tierKey] || {})) {
          const raw = fr[plat][tierKey][fmtKey]
          if (!Array.isArray(raw) || raw.length < 4) continue
          const nums = raw.slice(0, 4).map(Number)
          if (nums.some(n => !Number.isFinite(n) || n < 0)) continue
          let fmt = fmtKey.toUpperCase()
          if (platform === 'YOUTUBE' && OLD_YT_ALIAS[fmt]) fmt = OLD_YT_ALIAS[fmt]
          if (platform === 'TIKTOK' && fmt === 'SHORT') continue // dropped format
          if (!formatsFor(platform).includes(fmt as FeeFormat)) continue
          cfg.feeRanges[platform][tier][fmt as FeeFormat] = nums as FeeRange
        }
      }
    }
  }
  if (typeof p.storyPackMultiplier === 'number' && p.storyPackMultiplier > 0) cfg.storyPackMultiplier = p.storyPackMultiplier

  // CPM thresholds: accept the legacy list [{platform, tier, cpmTarget, cpmMax}] (no format → all formats of the platform)
  const ct = p.cpmThresholds ?? p.cpmRates
  if (Array.isArray(ct)) {
    for (const row of ct as Array<Record<string, unknown>>) {
      const platform = normalizePlatform(String(row.platform))
      const tier = String(row.tier || '').toUpperCase() as Tier
      const cpmTarget = Number(row.cpmTarget), cpmMax = Number(row.cpmMax)
      if (!TIERS.includes(tier) || !Number.isFinite(cpmTarget) || !Number.isFinite(cpmMax)) continue
      const formats: FeeFormat[] = row.format ? [normalizeFormat(platform, String(row.format))] : formatsFor(platform)
      for (const format of formats) {
        const idx = cfg.cpmThresholds.findIndex(t => t.platform === platform && t.format === format && t.tier === tier)
        const entry = { platform, format, tier, cpmTarget, cpmMax }
        if (idx >= 0) cfg.cpmThresholds[idx] = entry; else cfg.cpmThresholds.push(entry)
      }
    }
  }

  const mk = p.markets as Record<string, unknown> | undefined
  if (mk && typeof mk === 'object') {
    for (const [k, v] of Object.entries(mk)) if (typeof v === 'number' && v > 0) cfg.markets[k.toUpperCase()] = v
  }
  const mod = p.modifiers as Partial<CommercialModifiers> | undefined
  if (mod && typeof mod === 'object') {
    cfg.modifiers = {
      rights: { ...cfg.modifiers.rights, ...(mod.rights || {}) },
      whitelisting: typeof mod.whitelisting === 'number' ? mod.whitelisting : cfg.modifiers.whitelisting,
      exclusivity: { ...cfg.modifiers.exclusivity, ...(mod.exclusivity || {}) },
      urgency: typeof mod.urgency === 'number' ? mod.urgency : cfg.modifiers.urgency,
      crossposting: typeof mod.crossposting === 'number' ? mod.crossposting : cfg.modifiers.crossposting,
      bundle3: typeof mod.bundle3 === 'number' ? mod.bundle3 : cfg.modifiers.bundle3,
      recurring6m: typeof mod.recurring6m === 'number' ? mod.recurring6m : cfg.modifiers.recurring6m,
    }
  }
  const ib = p.internalBlend as Partial<InternalBlendRules> | undefined
  if (ib && typeof ib === 'object') cfg.internalBlend = { ...cfg.internalBlend, ...ib }
  if (typeof p.version === 'string' && p.version) cfg.version = p.version
  return cfg
}
