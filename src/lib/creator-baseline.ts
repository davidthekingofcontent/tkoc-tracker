/**
 * CREATOR BASELINE — "lo habitual" de un creador, congelado antes de que
 * publique para nosotros (David 2026-09-05, decision 2, zero extra cost).
 *
 * Method: median of the creator's last 12 publications of the negotiated
 * format family (video: REEL/VIDEO/SHORT · static: POST/CAROUSEL), published
 * in the 180 days before the deal closed, excluding anything that already
 * matches the campaign rules (brand tag). Minimum 6; with ≥ 8 the highest and
 * lowest values are dropped so one viral does not drag the median in short
 * samples. Branded content is included but its share is reported.
 *
 * Source of the posts: the SAME profile scrape the campaign tracking already
 * performs (src/lib/campaign-capture.ts) — nothing extra is fetched. Creators
 * connected through Meta OAuth can later feed exact numbers; PMs can type a
 * baseline by hand (source 'manual') when the sample is too small.
 */

import type { ScrapedPost } from '@/lib/apify'

export type BaselineFamily = 'video' | 'static'

export interface BaselineSnapshot {
  /** Format family the medians refer to. */
  family: BaselineFamily
  /** Negotiated/dominant format label the family was derived from (REEL, POST…). */
  format: string
  /** Publications used after trimming. */
  n: number
  /** Publications considered before trimming. */
  nRaw: number
  medianViews: number
  medianEngagement: number
  /** Share (0–1) of the sample detected as branded content. */
  pctBranded: number
  windowDays: number
  /** Publications had to be published before this instant (deal close). */
  before: string
  capturedAt: string
  source: 'apify' | 'meta' | 'manual'
}

export const BASELINE_MAX_N = 12
export const BASELINE_MIN_N = 6
export const BASELINE_WINDOW_DAYS = 180

const BRANDED_RE = /#(ad|ads|publi|publicidad|colab|colaboraci[oó]n|sponsored|gifted|anuncio|patrocinado)\b|colaboraci[oó]n pagada|paid partnership|publicidad\b/i

export function familyOf(mediaType: string | null | undefined): BaselineFamily | null {
  const t = (mediaType || '').toUpperCase()
  // YouTube long-form deals (INTEGRATION / DEDICATED) are videos too
  if (t === 'REEL' || t === 'VIDEO' || t === 'SHORT' || t === 'INTEGRATION' || t === 'DEDICATED') return 'video'
  if (t === 'POST' || t === 'CAROUSEL' || t === 'IMAGE' || t === 'SIDECAR') return 'static'
  return null // stories have no public history
}

export function engagementOfPost(p: Pick<ScrapedPost, 'likes' | 'comments' | 'shares' | 'saves'>): number {
  return (p.likes || 0) + (p.comments || 0) + (p.shares || 0) + (p.saves || 0)
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Drop the highest and lowest value when the sample allows it (≥ 8). */
function trimmedSorted(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length >= 8 ? sorted.slice(1, -1) : sorted
}

export interface ComputeBaselineOptions {
  /** Negotiated format (REEL, POST…); when missing the dominant family of the sample is used. */
  format?: string | null
  /** Publications at or after this instant are excluded (deal close / now). */
  before: Date
  /** Returns true for a publication that belongs to the campaign (brand tag) — excluded. */
  isCampaignPost?: (post: ScrapedPost) => boolean
  source?: BaselineSnapshot['source']
  now?: Date
}

/** Returns null when fewer than BASELINE_MIN_N eligible publications exist. */
export function computeBaseline(posts: ScrapedPost[], options: ComputeBaselineOptions): BaselineSnapshot | null {
  const now = options.now ?? new Date()
  const before = options.before.getTime()
  const from = before - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000

  const eligible = posts.filter(p => {
    if (!p.postedAt) return false
    const t = new Date(p.postedAt).getTime()
    if (!Number.isFinite(t) || t >= before || t < from) return false
    if (options.isCampaignPost && options.isCampaignPost(p)) return false
    return familyOf(p.mediaType) !== null
  })
  if (eligible.length === 0) return null

  // Family: negotiated format first, else the dominant family of the sample
  let family = familyOf(options.format)
  let formatLabel = (options.format || '').toUpperCase()
  if (!family) {
    const counts = { video: 0, static: 0 }
    for (const p of eligible) counts[familyOf(p.mediaType) as BaselineFamily]++
    family = counts.video >= counts.static ? 'video' : 'static'
    formatLabel = family === 'video' ? 'REEL' : 'POST'
  }

  const sample = eligible
    .filter(p => familyOf(p.mediaType) === family)
    .sort((a, b) => new Date(b.postedAt as string).getTime() - new Date(a.postedAt as string).getTime())
    .slice(0, BASELINE_MAX_N)
  if (sample.length < BASELINE_MIN_N) return null

  const views = trimmedSorted(sample.map(p => p.views || 0))
  const eng = trimmedSorted(sample.map(engagementOfPost))
  const branded = sample.filter(p => BRANDED_RE.test(p.caption || '')).length

  return {
    family,
    format: formatLabel,
    n: views.length,
    nRaw: sample.length,
    medianViews: median(views),
    medianEngagement: median(eng),
    pctBranded: Math.round((branded / sample.length) * 100) / 100,
    windowDays: BASELINE_WINDOW_DAYS,
    before: new Date(before).toISOString(),
    capturedAt: now.toISOString(),
    source: options.source ?? 'apify',
  }
}

/** Manual baseline typed by a PM from the creator's own statistics. */
export function manualBaseline(input: { format: string; medianViews: number; medianEngagement: number; n?: number }, now = new Date()): BaselineSnapshot {
  const family = familyOf(input.format) ?? 'video'
  return {
    family,
    format: input.format.toUpperCase(),
    n: Math.max(1, Math.round(input.n ?? BASELINE_MAX_N)),
    nRaw: Math.max(1, Math.round(input.n ?? BASELINE_MAX_N)),
    medianViews: Math.max(0, Math.round(input.medianViews)),
    medianEngagement: Math.max(0, Math.round(input.medianEngagement)),
    pctBranded: 0,
    windowDays: BASELINE_WINDOW_DAYS,
    before: now.toISOString(),
    capturedAt: now.toISOString(),
    source: 'manual',
  }
}

export interface BaselineComparison {
  /** actual ÷ baseline median (×1,37); null without a usable baseline or actual. */
  multiplier: number | null
  metric: 'views' | 'engagement'
  baseline: number
  actual: number
  n: number
  source: BaselineSnapshot['source']
}

/**
 * "×1,37 sobre su habitual": compares the campaign publication(s) of the same
 * family with the frozen baseline. Video → views; static → engagement.
 */
export function compareWithBaseline(
  snapshot: BaselineSnapshot | null | undefined,
  actual: { views: number; engagement: number; family: BaselineFamily | null }
): BaselineComparison | null {
  if (!snapshot || snapshot.n <= 0) return null
  if (actual.family && actual.family !== snapshot.family) return null
  const metric: BaselineComparison['metric'] = snapshot.family === 'video' ? 'views' : 'engagement'
  const base = metric === 'views' ? snapshot.medianViews : snapshot.medianEngagement
  const value = metric === 'views' ? actual.views : actual.engagement
  if (!(base > 0) || !(value > 0)) return { multiplier: null, metric, baseline: base, actual: value, n: snapshot.n, source: snapshot.source }
  return { multiplier: Math.round((value / base) * 100) / 100, metric, baseline: base, actual: value, n: snapshot.n, source: snapshot.source }
}

/** Parse a stored Json column defensively. */
export function parseBaseline(raw: unknown): BaselineSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<BaselineSnapshot>
  if (typeof r.medianViews !== 'number' || typeof r.n !== 'number' || (r.family !== 'video' && r.family !== 'static')) return null
  return r as BaselineSnapshot
}
