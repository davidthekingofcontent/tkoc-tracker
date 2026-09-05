/**
 * METRICS — the single set of definitions for every number TKOC Intelligence
 * shows about a campaign. Pure functions (no database, client-safe).
 *
 * Decisions (David, 2026-09-05):
 *  3A  Interacciones = likes + comentarios + shares + saves. Everywhere.
 *  4A  (David 2026-09-05, replaces 4C) Tasa de engagement = Σ interacciones ÷
 *      Σ audiencia REAL × 100. Estimates never enter the ER, the CPM or the
 *      target comparison; they are reported apart and only as information.
 *      Without any real audience the ER is null ("sin dato"), never invented.
 *  5   Audiencia (alcance) per publication, in this order: alcance real →
 *      impresiones reales → vistas reales (any source: Meta API, Apify,
 *      manual). Without real data: stories use the EMV story estimate
 *      (followers × tier rate × 0.85^n), feed posts/reels/videos use
 *      followers × postReachRates[tier]. Estimates are ALWAYS labelled.
 *  6   Coste de un creador = fee acordado; si no hay fee, coste (producto…).
 *  7B  Publicaciones borradas por el creador se mantienen en los totales y se
 *      marcan; su número se reporta aparte.
 *  9B  EMV ÷ coste se llama "Ratio EMV" y se muestra como ×2,4. Nunca ROI.
 *
 * Every surface (campaign page, report, portal, exports, dashboard, compare,
 * intelligence, AI knowledge) must consume the server-side overview built on
 * these functions (src/lib/campaign-overview.ts) instead of recomputing.
 */

import { getFollowerTier, type EMVResult, type EmvRates, DEFAULT_EMV_RATES } from './emv'

// ============ INPUT SHAPES ============

/** The subset of a Media row the metrics need. */
export interface MetricMedia {
  id: string
  mediaType?: string | null
  platform?: string | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  saves?: number | null
  views?: number | null
  reach?: number | null
  impressions?: number | null
  postedAt?: Date | string | null
  influencerId?: string | null
  isDeleted?: boolean | null
}

/** The subset of a CampaignInfluencer row the cost needs. */
export interface MetricMember {
  agreedFee?: number | null
  cost?: number | null
}

// ============ INTERACCIONES (3A) ============

export function engagementsOf(m: Pick<MetricMedia, 'likes' | 'comments' | 'shares' | 'saves'>): number {
  return (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0)
}

// ============ AUDIENCIA (5) ============

export type AudienceBasis =
  | 'reach'            // alcance real
  | 'impressions'      // impresiones reales (sin alcance)
  | 'views'            // vistas reales (vídeo sin alcance ni impresiones)
  | 'estimated_story'  // story sin datos: estimación EMV por tier y secuencia
  | 'estimated_post'   // post/reel/vídeo sin datos: seguidores × tasa por tier
  | 'none'             // sin datos ni seguidores: no cuenta en la base del ER

export interface AudienceResult {
  value: number
  basis: AudienceBasis
  estimated: boolean
}

export const REAL_BASES: ReadonlySet<AudienceBasis> = new Set<AudienceBasis>(['reach', 'impressions', 'views'])

export function isStoryType(mediaType: string | null | undefined): boolean {
  return (mediaType || '').toUpperCase() === 'STORY'
}

/**
 * Audience of one publication. `emvItem` is the aligned result of
 * calculateCampaignEMV for the same row — it carries the story estimate so the
 * metrics and the EMV can never disagree on a story's audience.
 */
export function audienceOf(
  m: MetricMedia,
  ctx: { followers?: number | null; emvItem?: EMVResult | null; rates?: EmvRates }
): AudienceResult {
  if ((m.reach || 0) > 0) return { value: m.reach as number, basis: 'reach', estimated: false }
  if ((m.impressions || 0) > 0) return { value: m.impressions as number, basis: 'impressions', estimated: false }
  if ((m.views || 0) > 0) return { value: m.views as number, basis: 'views', estimated: false }

  const followers = ctx.followers || 0
  if (isStoryType(m.mediaType)) {
    const est = ctx.emvItem?.estimated ? ctx.emvItem.audience : 0
    return est > 0 ? { value: est, basis: 'estimated_story', estimated: true } : { value: 0, basis: 'none', estimated: true }
  }
  if (followers > 0) {
    const rates = ctx.rates ?? DEFAULT_EMV_RATES
    const rate = rates.postReachRates[getFollowerTier(followers)]
    const est = Math.round(followers * rate)
    return est > 0 ? { value: est, basis: 'estimated_post', estimated: true } : { value: 0, basis: 'none', estimated: true }
  }
  return { value: 0, basis: 'none', estimated: true }
}

export interface AudienceTotals {
  /** real + estimated (informative only; never the base of ER/CPM). */
  total: number
  real: number
  estimated: number
  /** Share of the total that is estimated, 0–1. */
  estimatedShare: number
  byBasis: Record<AudienceBasis, number>
  /** Publications per basis (counts, not sums) — for the data-quality lines. */
  countsByBasis: Record<AudienceBasis, number>
  /** Publications with a REAL audience figure (reach, impressions or views). */
  realPieces: number
  /** Publications with no audience at all (excluded from every base). */
  withoutBase: number
}

export function sumAudience(results: AudienceResult[]): AudienceTotals {
  const byBasis: Record<AudienceBasis, number> = {
    reach: 0, impressions: 0, views: 0, estimated_story: 0, estimated_post: 0, none: 0,
  }
  const countsByBasis: Record<AudienceBasis, number> = {
    reach: 0, impressions: 0, views: 0, estimated_story: 0, estimated_post: 0, none: 0,
  }
  let real = 0, estimated = 0, withoutBase = 0, realPieces = 0
  for (const r of results) {
    byBasis[r.basis] += r.value
    countsByBasis[r.basis] += 1
    if (r.basis === 'none' || r.value <= 0) { withoutBase++; continue }
    if (r.estimated) estimated += r.value
    else { real += r.value; realPieces++ }
  }
  const total = real + estimated
  return { total, real, estimated, estimatedShare: total > 0 ? estimated / total : 0, byBasis, countsByBasis, realPieces, withoutBase }
}

// ============ TASA DE ENGAGEMENT (4C) ============

export interface EngagementRateResult {
  /** Percentage, 2 decimals; null when there is no REAL audience base ("sin dato"). */
  value: number | null
  /** Interacciones of the publications WITH a real audience figure (same rows as the denominator). */
  numerator: number
  /** Σ real audience (reach → impressions → views). */
  denominator: number
  /** Always 0 since 4A: estimates never enter the ER. Kept for old consumers. */
  estimatedShare: number
  /** Publications behind the figure. */
  pieces: number
}

/**
 * ER over REAL audience only (decision 4A). `engagementsReal` must be the
 * interacciones of the same publications that carry a real audience figure;
 * pass the campaign total only when every publication has one.
 */
export function engagementRateOf(engagementsReal: number, audience: AudienceTotals): EngagementRateResult {
  if (audience.real <= 0) return { value: null, numerator: engagementsReal, denominator: 0, estimatedShare: 0, pieces: 0 }
  return {
    value: Math.round((engagementsReal / audience.real) * 100 * 100) / 100,
    numerator: engagementsReal,
    denominator: audience.real,
    estimatedShare: 0,
    pieces: audience.realPieces,
  }
}

// ============ COSTE (6) ============

export function memberCost(ci: MetricMember): number {
  if (typeof ci.agreedFee === 'number' && ci.agreedFee > 0) return ci.agreedFee
  if (typeof ci.cost === 'number' && ci.cost > 0) return ci.cost
  return 0
}

export function totalCostOf(members: MetricMember[]): { total: number; membersWithCost: number } {
  let total = 0, membersWithCost = 0
  for (const ci of members) {
    const c = memberCost(ci)
    if (c > 0) { total += c; membersWithCost++ }
  }
  return { total: Math.round(total * 100) / 100, membersWithCost }
}

// ============ RATIO EMV (9B) ============

/** EMV ÷ coste, 2 decimals; null when there is no cost. Displayed as "×2,4". */
export function emvRatioOf(emv: number, cost: number): number | null {
  if (!(cost > 0)) return null
  return Math.round((emv / cost) * 100) / 100
}

/** CPM real (€ por mil) sobre la audiencia REAL; null sin coste o sin base real. */
export function cpmOf(cost: number, audience: number): number | null {
  if (!(cost > 0) || !(audience > 0)) return null
  return Math.round((cost / audience) * 1000 * 100) / 100
}

// ============ FECHAS (evolución diaria en día de Madrid) ============

/** YYYY-MM-DD of the instant in Europe/Madrid — the day PMs and clients live in. */
export function madridDayKey(d: Date | string): string | null {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return null
  // sv-SE renders ISO-like "YYYY-MM-DD" and honours timeZone
  return date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' })
}

// ============ OBJETIVOS (1B) ============

export type TargetKey = 'views' | 'reach' | 'engagement' | 'er' | 'cpm'

export interface CampaignTargets {
  targetViews?: number | null
  targetReach?: number | null
  targetEngagement?: number | null
  targetER?: number | null
  targetCpmMax?: number | null
}

export type TargetVerdict = 'above' | 'on_target' | 'below' | 'no_data'

export interface TargetComparison {
  key: TargetKey
  target: number
  actual: number | null
  /** (actual − target) ÷ target, signed; for CPM the sign is inverted so + is good. */
  variationPct: number | null
  /** true when a lower value is better (CPM). */
  lowerIsBetter: boolean
  verdict: TargetVerdict
}

/** ±10 % around the target counts as "en objetivo". */
export const TARGET_TOLERANCE = 0.10

export function compareTargets(
  targets: CampaignTargets,
  actual: { views: number; audience: number; engagements: number; er: number | null; cpm: number | null }
): TargetComparison[] {
  const rows: TargetComparison[] = []
  const push = (key: TargetKey, target: number | null | undefined, value: number | null, lowerIsBetter = false) => {
    if (!(typeof target === 'number' && target > 0)) return
    if (value === null || value === undefined || !Number.isFinite(value)) {
      rows.push({ key, target, actual: null, variationPct: null, lowerIsBetter, verdict: 'no_data' })
      return
    }
    const raw = (value - target) / target
    const variation = lowerIsBetter ? -raw : raw
    const verdict: TargetVerdict = variation >= TARGET_TOLERANCE ? 'above' : variation <= -TARGET_TOLERANCE ? 'below' : 'on_target'
    rows.push({ key, target, actual: value, variationPct: Math.round(variation * 1000) / 10, lowerIsBetter, verdict })
  }
  push('views', targets.targetViews, actual.views)
  // Reach target is judged on REAL audience only (4A); without real data → no_data
  push('reach', targets.targetReach, actual.audience > 0 ? actual.audience : null)
  push('engagement', targets.targetEngagement, actual.engagements)
  push('er', targets.targetER, actual.er)
  push('cpm', targets.targetCpmMax, actual.cpm, true)
  return rows
}

// ============ OVERVIEW SHAPES (shared by server and client) ============

export interface PerMediaMetrics {
  id: string
  /** Real views of the piece (0 when the platform gives none). */
  views: number
  /** Media type as stored (REEL, POST, STORY…). */
  mediaType: string
  audience: number
  audienceBasis: AudienceBasis
  audienceEstimated: boolean
  engagements: number
  emvBasic: number
  emvExtended: number
  isDeleted: boolean
}

export interface PerInfluencerMetrics {
  influencerId: string
  username: string
  platform: string
  displayName: string | null
  followers: number
  media: number
  stories: number
  posts: number
  deleted: number
  views: number
  engagements: number
  audience: AudienceTotals
  er: EngagementRateResult
  cost: number
  emvBasic: number
  emvExtended: number
  emvRatio: number | null
  cpm: number | null
  deliverablesPlanned: number | null
  status: string
  /**
   * "×1,37 sobre su habitual": the creator's frozen baseline (median per piece)
   * compared with the MEDIAN per piece of the same format family published in
   * this campaign — never with the creator's total. null without baseline or pieces.
   */
  vsBaseline: {
    multiplier: number | null
    metric: 'views' | 'engagement'
    baseline: number
    actual: number
    n: number
    piecesCompared: number
    source: 'apify' | 'meta' | 'manual'
  } | null
}

export interface TimelinePoint {
  /** YYYY-MM-DD in Europe/Madrid */
  date: string
  posts: number
  likes: number
  comments: number
  views: number
  engagements: number
  audience: number
  /** Kept for old chart code: same as audience. */
  reach: number
}

export interface BusinessResults {
  promoCode: string | null
  codeRedemptions: number | null
  clientReportedSales: number | null
  clientReportedLeads: number | null
  clientReportedRevenue: number | null
  source: string | null
  reportedAt: string | null
  /**
   * Client-provided notes (Campaign.businessResultsNotes). Deliberately NOT
   * named `notes`: the brand-scope sanitizer deep-strips every key with that
   * name (meant for CampaignInfluencer.notes) and would drop it from the portal.
   */
  businessNotes: string | null
  /** cost ÷ (sales or leads); null without inputs. Labelled "aportado por el cliente". */
  cpa: number | null
  /** revenue ÷ cost; null without inputs. */
  roas: number | null
}

export interface CampaignOverview {
  /** Bump when a definition changes so clients can detect stale caches. */
  definitionsVersion: 2
  totals: {
    media: number
    mediaDeleted: number
    stories: number
    posts: number
    creatorsActive: number
    views: number
    likes: number
    comments: number
    shares: number
    saves: number
    engagements: number
    audience: AudienceTotals
    /** Real reach only (Σ reach) — the honest "alcance real" figure. */
    reachReal: number
    /** Real impressions only (Σ impressions); null when none. */
    impressionsReal: number | null
    er: EngagementRateResult
    cost: number
    membersWithCost: number
    members: number
    emvBasic: number
    emvExtended: number
    emvEstimatedStories: number
    emvRealStories: number
    emvEstimatedAudience: number
    emvRatio: number | null
    cpm: number | null
    mediaCounts: Record<string, number>
  }
  perInfluencer: PerInfluencerMetrics[]
  perMedia: PerMediaMetrics[]
  timeline: TimelinePoint[]
  targets: TargetComparison[]
  business: BusinessResults | null
}

/** Business results only when the client actually provided something (David's principle). */
export function buildBusinessResults(
  c: {
    promoCode?: string | null; codeRedemptions?: number | null; clientReportedSales?: number | null
    clientReportedLeads?: number | null; clientReportedRevenue?: number | null; businessResultsSource?: string | null
    businessResultsReportedAt?: Date | string | null; businessResultsNotes?: string | null
  },
  cost: number
): BusinessResults | null {
  const filled = (c.promoCode && c.promoCode.trim()) || (c.codeRedemptions ?? 0) > 0 || (c.clientReportedSales ?? 0) > 0
    || (c.clientReportedLeads ?? 0) > 0 || (c.clientReportedRevenue ?? 0) > 0
  if (!filled) return null
  const conversions = (c.clientReportedSales ?? 0) > 0 ? (c.clientReportedSales as number) : (c.clientReportedLeads ?? 0) > 0 ? (c.clientReportedLeads as number) : null
  const reportedAt = c.businessResultsReportedAt
    ? (c.businessResultsReportedAt instanceof Date ? c.businessResultsReportedAt.toISOString() : String(c.businessResultsReportedAt))
    : null
  return {
    promoCode: c.promoCode?.trim() || null,
    codeRedemptions: c.codeRedemptions ?? null,
    clientReportedSales: c.clientReportedSales ?? null,
    clientReportedLeads: c.clientReportedLeads ?? null,
    clientReportedRevenue: c.clientReportedRevenue ?? null,
    source: c.businessResultsSource?.trim() || null,
    reportedAt,
    businessNotes: c.businessResultsNotes?.trim() || null,
    cpa: cost > 0 && conversions ? Math.round((cost / conversions) * 100) / 100 : null,
    roas: cost > 0 && (c.clientReportedRevenue ?? 0) > 0 ? Math.round(((c.clientReportedRevenue as number) / cost) * 100) / 100 : null,
  }
}
