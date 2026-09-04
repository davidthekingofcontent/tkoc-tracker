/**
 * INTERNAL BENCHMARKS — the agency's own negotiations become the benchmark.
 *
 * recomputeInternalBenchmarks() reads every CampaignInfluencer with an
 * agreedFee, buckets the deals into cells (platform × tier × format), and
 * writes the own percentiles to Setting 'benchmark_internal_stats'
 * (InternalCellStats[]) plus a summary in 'benchmark_internal_meta'. The
 * blending with the seed happens at read time (blendFeeRange in
 * '@/lib/benchmarks', k = 10, min sample 20, trim 5 %).
 *
 * Rules (David + audit, 2026-09-04):
 *   - Tier comes ONLY from influencer.followers (detectTier).
 *   - Format: ci.negotiatedFormat when the column exists → majority of the
 *     creator's delivered media in that campaign → platform default.
 *   - Fees are Spain-normalized: agreedFee ÷ marketMultiplier(campaign country,
 *     falling back to the creator's country). Spain = 1.0.
 *   - Percentiles p25/p50/p75/p90 after trimming trimPct from each tail
 *     (only when the trimmed sample keeps ≥ 5 values — see trimmed()).
 *   - CPM p25/p50/p75 = normalized fee ÷ influencer.avgViews × 1000 when
 *     avgViews > 0 (same trimming). STORY cells are ONE story.
 *   - negotiationDiscount = median of (askingFee − agreedFee) ÷ askingFee when
 *     the deal carries an askingFee (column added by another agent; read
 *     defensively so this compiles before and after the migration).
 *
 * Runs monthly from the cron (/api/cron/benchmarks) and on demand from
 * POST /api/admin/benchmarks/recompute. Never throws on empty data.
 */

import { prisma } from '@/lib/db'
import { loadBenchmarkConfig, loadInternalStats, invalidateBenchmarkCaches } from '@/lib/benchmarks-server'
import {
  detectTier,
  normalizePlatform,
  normalizeFormat,
  mediaTypeToFormat,
  marketMultiplier,
  percentile,
  trimmed,
  type FeeFormat,
  type FeeRange,
  type InternalCellStats,
  type Platform,
  type Tier,
} from '@/lib/benchmarks'

export const INTERNAL_STATS_SETTING_KEY = 'benchmark_internal_stats'
export const INTERNAL_META_SETTING_KEY = 'benchmark_internal_meta'
/** Bump when the shape or the method of the stored cells changes. */
export const INTERNAL_STATS_VERSION = 1

export interface InternalBenchmarkMeta {
  computedAt: string
  /** Deals considered (agreedFee > 0 with a resolvable creator). */
  deals: number
  /** Cells written (platform × tier × format with ≥ 1 deal). */
  cells: number
  /** Median of (askingFee − agreedFee) ÷ askingFee over deals with an askingFee; null when none. */
  negotiationDiscount: number | null
  /** Deals that carried an askingFee (sample behind negotiationDiscount). */
  negotiationDiscountSample: number
  version: number
  /** Blend rules in force when the cells were computed. */
  trimPct: number
}

export interface RecomputeInternalBenchmarksResult {
  cells: InternalCellStats[]
  deals: number
  computedAt: string
  negotiationDiscount: number | null
  meta: InternalBenchmarkMeta
}

interface DealRow {
  platform: Platform
  tier: Tier
  format: FeeFormat
  /** Spain-normalized fee (EUR). */
  fee: number
  /** Spain-normalized CPM on the creator's median views, or null. */
  cpm: number | null
  askingFee: number | null
  agreedFee: number
}

/** Read an optional column that may not exist yet in the generated client. */
function optionalNumber(row: unknown, key: string): number | null {
  const v = (row as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function optionalString(row: unknown, key: string): string | null {
  const v = (row as Record<string, unknown> | null | undefined)?.[key]
  return typeof v === 'string' && v.trim() ? v : null
}

function cellKey(platform: Platform, tier: Tier, format: FeeFormat): string {
  return `${platform}|${tier}|${format}`
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

/**
 * Majority delivered format per (campaignId, influencerId), from the media
 * the creator actually published in that campaign. Used only when the deal
 * has no explicit negotiatedFormat.
 */
async function deliveredFormats(
  pairs: Array<{ campaignId: string; influencerId: string; platform: Platform }>
): Promise<Map<string, FeeFormat>> {
  const out = new Map<string, FeeFormat>()
  if (pairs.length === 0) return out
  const campaignIds = Array.from(new Set(pairs.map(p => p.campaignId)))
  const influencerIds = Array.from(new Set(pairs.map(p => p.influencerId)))
  const platformOf = new Map(pairs.map(p => [`${p.campaignId}|${p.influencerId}`, p.platform]))

  const media = await prisma.media.findMany({
    // Deleted posts still tell us the delivered format, so no isDeleted filter.
    where: { campaignId: { in: campaignIds }, influencerId: { in: influencerIds } },
    select: { campaignId: true, influencerId: true, mediaType: true },
  })

  const counts = new Map<string, Map<FeeFormat, number>>()
  for (const m of media) {
    if (!m.campaignId) continue
    const key = `${m.campaignId}|${m.influencerId}`
    const platform = platformOf.get(key)
    if (!platform) continue
    const fmt = mediaTypeToFormat(platform, m.mediaType)
    const byFmt = counts.get(key) || new Map<FeeFormat, number>()
    byFmt.set(fmt, (byFmt.get(fmt) || 0) + 1)
    counts.set(key, byFmt)
  }
  for (const [key, byFmt] of counts) {
    let best: FeeFormat | null = null
    let bestN = 0
    for (const [fmt, n] of byFmt) {
      if (n > bestN) { best = fmt; bestN = n }
    }
    if (best) out.set(key, best)
  }
  return out
}

/** Own p25/p50/p75/p90 (and CPM percentiles) per cell from a list of deals. */
export function computeInternalCells(deals: DealRow[], trimPct: number, computedAt: string): InternalCellStats[] {
  const byCell = new Map<string, DealRow[]>()
  for (const d of deals) {
    const key = cellKey(d.platform, d.tier, d.format)
    const arr = byCell.get(key) || []
    arr.push(d)
    byCell.set(key, arr)
  }

  const cells: InternalCellStats[] = []
  for (const rows of byCell.values()) {
    const fees = trimmed(rows.map(r => r.fee), trimPct)
    if (fees.length === 0) continue
    const feeRange: FeeRange = [
      Math.round(percentile(fees, 0.25)),
      Math.round(percentile(fees, 0.5)),
      Math.round(percentile(fees, 0.75)),
      Math.round(percentile(fees, 0.9)),
    ]
    const cpms = trimmed(rows.map(r => r.cpm ?? 0), trimPct)
    const cpm = cpms.length > 0
      ? { p25: round(percentile(cpms, 0.25)), p50: round(percentile(cpms, 0.5)), p75: round(percentile(cpms, 0.75)) }
      : null
    const { platform, tier, format } = rows[0]
    cells.push({ platform, tier, format, n: fees.length, fees: feeRange, cpm, updatedAt: computedAt })
  }

  // Stable order: platform, tier, format.
  const tierOrder: Tier[] = ['NANO', 'MICRO', 'MID', 'MACRO', 'MEGA']
  cells.sort((a, b) =>
    a.platform.localeCompare(b.platform) ||
    tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) ||
    a.format.localeCompare(b.format)
  )
  return cells
}

/** Median of (askingFee − agreedFee) ÷ askingFee; null without data. */
export function computeNegotiationDiscount(deals: Array<{ askingFee: number | null; agreedFee: number }>): { value: number | null; sample: number } {
  const ratios = deals
    .filter(d => d.askingFee !== null && d.askingFee > 0 && d.agreedFee > 0)
    .map(d => ((d.askingFee as number) - d.agreedFee) / (d.askingFee as number))
    .filter(v => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (ratios.length === 0) return { value: null, sample: 0 }
  return { value: round(percentile(ratios, 0.5), 4), sample: ratios.length }
}

export async function recomputeInternalBenchmarks(): Promise<RecomputeInternalBenchmarksResult> {
  const computedAt = new Date().toISOString()
  const config = await loadBenchmarkConfig()
  const trimPct = config.internalBlend.trimPct

  const rows = await prisma.campaignInfluencer.findMany({
    where: { agreedFee: { gt: 0 } },
    include: {
      influencer: { select: { platform: true, followers: true, avgViews: true, country: true } },
      campaign: { select: { id: true, country: true } },
    },
  })

  // Resolve the format of every deal: explicit column → delivered media → platform default.
  const needsMedia: Array<{ campaignId: string; influencerId: string; platform: Platform }> = []
  const explicitFormat = new Map<string, FeeFormat>()
  for (const ci of rows) {
    if (!ci.influencer) continue
    const platform = normalizePlatform(ci.influencer.platform)
    const negotiated = optionalString(ci, 'negotiatedFormat')
    const key = `${ci.campaignId}|${ci.influencerId}`
    if (negotiated) explicitFormat.set(key, normalizeFormat(platform, negotiated))
    else needsMedia.push({ campaignId: ci.campaignId, influencerId: ci.influencerId, platform })
  }
  const delivered = await deliveredFormats(needsMedia)

  const deals: DealRow[] = []
  for (const ci of rows) {
    if (!ci.influencer || !ci.agreedFee || ci.agreedFee <= 0) continue
    const platform = normalizePlatform(ci.influencer.platform)
    const tier = detectTier(ci.influencer.followers || 0)
    const key = `${ci.campaignId}|${ci.influencerId}`
    const format = explicitFormat.get(key) || delivered.get(key) || normalizeFormat(platform, undefined)

    const country = ci.campaign?.country || ci.influencer.country || null
    const multiplier = marketMultiplier(config, country)
    const fee = ci.agreedFee / multiplier
    const avgViews = ci.influencer.avgViews || 0
    const cpm = avgViews > 0 ? (fee / avgViews) * 1000 : null

    deals.push({ platform, tier, format, fee, cpm, askingFee: optionalNumber(ci, 'askingFee'), agreedFee: ci.agreedFee })
  }

  const cells = computeInternalCells(deals, trimPct, computedAt)
  const discount = computeNegotiationDiscount(deals)

  const meta: InternalBenchmarkMeta = {
    computedAt,
    deals: deals.length,
    cells: cells.length,
    negotiationDiscount: discount.value,
    negotiationDiscountSample: discount.sample,
    version: INTERNAL_STATS_VERSION,
    trimPct,
  }

  await prisma.$transaction([
    prisma.setting.upsert({
      where: { key: INTERNAL_STATS_SETTING_KEY },
      update: { value: JSON.stringify(cells) },
      create: { key: INTERNAL_STATS_SETTING_KEY, value: JSON.stringify(cells) },
    }),
    prisma.setting.upsert({
      where: { key: INTERNAL_META_SETTING_KEY },
      update: { value: JSON.stringify(meta) },
      create: { key: INTERNAL_META_SETTING_KEY, value: JSON.stringify(meta) },
    }),
  ])
  invalidateBenchmarkCaches()

  console.log(`[benchmarks-internal] recomputed ${cells.length} cell(s) from ${deals.length} deal(s)` +
    (discount.value !== null ? `, negotiation discount ${Math.round(discount.value * 100)} % (n=${discount.sample})` : ''))

  return { cells, deals: deals.length, computedAt, negotiationDiscount: discount.value, meta }
}

/** Stored summary of the last recompute, or null when it has never run. */
export async function loadInternalBenchmarkMeta(): Promise<InternalBenchmarkMeta | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: INTERNAL_META_SETTING_KEY } })
    if (!row?.value) return null
    const parsed = JSON.parse(row.value) as Partial<InternalBenchmarkMeta>
    if (!parsed || typeof parsed.computedAt !== 'string') return null
    return {
      computedAt: parsed.computedAt,
      deals: typeof parsed.deals === 'number' ? parsed.deals : 0,
      cells: typeof parsed.cells === 'number' ? parsed.cells : 0,
      negotiationDiscount: typeof parsed.negotiationDiscount === 'number' ? parsed.negotiationDiscount : null,
      negotiationDiscountSample: typeof parsed.negotiationDiscountSample === 'number' ? parsed.negotiationDiscountSample : 0,
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      trimPct: typeof parsed.trimPct === 'number' ? parsed.trimPct : 0,
    }
  } catch {
    return null
  }
}

/** Meta + cells as stored (what GET /api/admin/benchmarks/recompute returns). */
export async function loadInternalBenchmarks(): Promise<{ meta: InternalBenchmarkMeta | null; cells: InternalCellStats[] }> {
  const [meta, cells] = await Promise.all([loadInternalBenchmarkMeta(), loadInternalStats()])
  return { meta, cells }
}
