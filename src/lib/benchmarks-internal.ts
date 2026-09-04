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
 *   - Only deals in status AGREED or later (CONTRACTED, SHIPPING, POSTED,
 *     COMPLETED) and closed within internalBlend.maxAgeMonths count. A fee on
 *     a PROSPECT/NEGOTIATING row is a draft, not a negotiation.
 *   - Anti-bias guard (assessInternalCell): every deal carries a client key
 *     (campaign brand handle → campaign brand id → campaign id); per cell we
 *     store the distinct clients, n × (1 − HHI) as the effective sample and
 *     whether the fees are a flat rate (p25 = p90). A cell with < minBrands
 *     clients or a flat rate is written and shown but marked eligible=false,
 *     so blendFeeRange leaves the seed untouched. One brand paying 100 € to
 *     105 micros is a price list, not the Spanish market.
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
  assessInternalCell,
  detectTier,
  normalizePlatform,
  normalizeFormat,
  mediaTypeToFormat,
  marketMultiplier,
  percentile,
  trimmed,
  type FeeFormat,
  type FeeRange,
  type InternalBlendRules,
  type InternalCellStats,
  type Platform,
  type Tier,
} from '@/lib/benchmarks'

/** Pipeline states that mean "this fee was actually agreed". */
export const CLOSED_DEAL_STATUSES = ['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] as const

export const INTERNAL_STATS_SETTING_KEY = 'benchmark_internal_stats'
export const INTERNAL_META_SETTING_KEY = 'benchmark_internal_meta'
/** Bump when the shape or the method of the stored cells changes. */
export const INTERNAL_STATS_VERSION = 2

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
  minBrands: number
  maxAgeMonths: number
  /** Cells allowed to move the seed (≥ minBrands clients, no flat rate, effective n ≥ 1). */
  eligibleCells: number
  /** Distinct clients across all counted deals. */
  clients: number
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
  /** Client identity for the concentration guard. */
  clientKey: string
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

/** Client key of a campaign: brand handle (what the creators tag) → brand id → campaign id. */
export function campaignClientKey(campaign: { id: string; targetAccounts?: unknown } | null | undefined, brandId: string | null | undefined): string {
  let accounts: unknown = campaign?.targetAccounts
  if (typeof accounts === 'string') {
    try { accounts = JSON.parse(accounts) } catch { accounts = [accounts] }
  }
  if (Array.isArray(accounts)) {
    const first = accounts.find(a => typeof a === 'string' && a.trim())
    if (typeof first === 'string') return `handle:${first.trim().replace(/^@/, '').toLowerCase()}`
  }
  if (brandId) return `brand:${brandId}`
  return `campaign:${campaign?.id ?? 'unknown'}`
}

/** Own p25/p50/p75/p90 (and CPM percentiles) per cell from a list of deals, with the anti-bias assessment. */
export function computeInternalCells(deals: DealRow[], rules: InternalBlendRules, computedAt: string): InternalCellStats[] {
  const trimPct = rules.trimPct
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
    const perClient = new Map<string, number>()
    for (const r of rows) perClient.set(r.clientKey, (perClient.get(r.clientKey) || 0) + 1)
    const guard = assessInternalCell(fees.length, feeRange, Array.from(perClient.values()), rules)
    cells.push({
      platform, tier, format,
      n: fees.length,
      fees: feeRange,
      cpm,
      updatedAt: computedAt,
      brands: guard.brands,
      nEffective: guard.nEffective,
      flatRate: guard.flatRate,
      eligible: guard.eligible,
      reason: guard.reason,
    })
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
  const rules = config.internalBlend
  const trimPct = rules.trimPct
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - Math.max(1, rules.maxAgeMonths || 24))

  const [rawRows, brandSettings] = await Promise.all([
    prisma.campaignInfluencer.findMany({
      where: { agreedFee: { gt: 0 }, status: { in: [...CLOSED_DEAL_STATUSES] } },
      include: {
        influencer: { select: { platform: true, followers: true, avgViews: true, country: true } },
        campaign: { select: { id: true, country: true, targetAccounts: true } },
      },
    }),
    prisma.setting.findMany({ where: { key: { startsWith: 'campaign_brand_' } }, select: { key: true, value: true } }),
  ])
  const brandOfCampaign = new Map(brandSettings.map(s => [s.key.slice('campaign_brand_'.length), s.value]))
  // Recency: the deal date is dealClosedAt when stamped, else the row's last update.
  const rows = rawRows.filter(ci => {
    const closedAt = (ci as { dealClosedAt?: Date | null }).dealClosedAt ?? null
    const when = closedAt instanceof Date ? closedAt : ci.updatedAt
    return !(when instanceof Date) || when >= cutoff
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

    const clientKey = campaignClientKey(ci.campaign, brandOfCampaign.get(ci.campaignId) ?? null)

    deals.push({ platform, tier, format, fee, cpm, askingFee: optionalNumber(ci, 'askingFee'), agreedFee: ci.agreedFee, clientKey })
  }

  const cells = computeInternalCells(deals, rules, computedAt)
  const discount = computeNegotiationDiscount(deals)

  const meta: InternalBenchmarkMeta = {
    computedAt,
    deals: deals.length,
    cells: cells.length,
    negotiationDiscount: discount.value,
    negotiationDiscountSample: discount.sample,
    version: INTERNAL_STATS_VERSION,
    trimPct,
    minBrands: rules.minBrands,
    maxAgeMonths: rules.maxAgeMonths,
    eligibleCells: cells.filter(c => c.eligible).length,
    clients: new Set(deals.map(d => d.clientKey)).size,
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

  console.log(`[benchmarks-internal] recomputed ${cells.length} cell(s) from ${deals.length} deal(s), ${meta.clients} client(s), ${meta.eligibleCells} eligible to move the seed` +
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
      minBrands: typeof parsed.minBrands === 'number' ? parsed.minBrands : 0,
      maxAgeMonths: typeof parsed.maxAgeMonths === 'number' ? parsed.maxAgeMonths : 0,
      eligibleCells: typeof parsed.eligibleCells === 'number' ? parsed.eligibleCells : 0,
      clients: typeof parsed.clients === 'number' ? parsed.clients : 0,
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
