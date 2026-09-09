/**
 * APRENDER INPUT — the ONE projection of the campaign overview the Aprender
 * verdicts (playbook, learnings, report "Aprendizajes") are built from.
 *
 * Every figure comes from computeCampaignOverview (src/lib/campaign-overview.ts
 * → src/lib/metrics.ts definitions) and nothing is re-derived here:
 *   - interacciones          = perInfluencer.engagements (likes+comments+shares+saves, 3A)
 *   - vistas reales          = perInfluencer.er.denominator (Σ plausible views: views ≥ likes, 4B)
 *   - tasa de engagement     = perInfluencer.er (published only with ≥ 1 piece, ≥ 500 views, ≤ 100 %)
 *   - CPM                    = perInfluencer.cpm (null without cost or reliable base)
 *   - coste                  = perInfluencer.cost (fee acordado, si no coste, 6)
 *   - EMV / Ratio EMV        = perInfluencer.emvExtended / emvRatio (9B)
 *   - ×1,37 sobre su habitual = perInfluencer.vsBaseline
 *   - Prometido vs entregado = overview.delivery; balance = overview.balance
 *   - formats                = overview.perMedia grouped by mediaType, real views only
 * Estimated audiences, impressions and profile ERs never enter this object.
 *
 * Used by src/lib/campaign-learnings.ts (report + portal) and by
 * POST /api/intelligence { type: 'playbook' } (Aprender tab) — the same builder,
 * so both surfaces judge the same facts.
 */

import type { CampaignOverview, PerMediaMetrics } from '@/lib/metrics'
import type { PlaybookCreator, PlaybookFormatGroup, PlaybookInput } from '@/lib/campaign-playbook'

export interface BuildPlaybookInputArgs {
  overview: CampaignOverview
  campaignName: string
  /** awareness | engagement | traffic | conversion | content (null → 'awareness'). */
  objective?: string | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * Plausibility of a per-piece views figure. The overview marks it
 * (viewsPlausible); an old serialized overview without the flag falls back to
 * the conservative test "views ≥ interacciones" (which implies views ≥ likes).
 */
function pieceHasRealViews(m: PerMediaMetrics): boolean {
  if (typeof m.viewsPlausible === 'boolean') return m.viewsPlausible
  return m.views > 0 && m.views >= m.engagements
}

/** Formats grouped from overview.perMedia (deleted pieces excluded — their figures froze at deletion). */
export function buildFormatGroups(perMedia: PerMediaMetrics[]): PlaybookFormatGroup[] {
  const groups = new Map<string, PerMediaMetrics[]>()
  for (const m of perMedia) {
    if (m.isDeleted) continue
    const key = (m.mediaType || '').toUpperCase() || 'UNKNOWN'
    const arr = groups.get(key) || []
    arr.push(m)
    groups.set(key, arr)
  }
  return Array.from(groups.entries()).map(([format, rows]) => {
    const real = rows.filter(pieceHasRealViews)
    return {
      format,
      pieces: rows.length,
      piecesWithRealViews: real.length,
      realViews: real.reduce((s, m) => s + m.views, 0),
      medianRealViews: median(real.map(m => m.views)),
      engagements: rows.reduce((s, m) => s + m.engagements, 0),
      medianEngagements: median(rows.map(m => m.engagements)) ?? 0,
    }
  })
}

export function buildPlaybookInput(args: BuildPlaybookInputArgs): PlaybookInput {
  const { overview } = args
  const t = overview.totals

  // Per-creator piece facts from perMedia (formats used, partial views)
  const piecesByCreator = new Map<string, PerMediaMetrics[]>()
  for (const m of overview.perMedia) {
    if (!m.influencerId) continue
    const arr = piecesByCreator.get(m.influencerId) || []
    arr.push(m)
    piecesByCreator.set(m.influencerId, arr)
  }
  const partialOf = (rows: PerMediaMetrics[]) => rows.filter(m => m.views > 0 && !pieceHasRealViews(m)).length
  const noViewsOf = (rows: PerMediaMetrics[]) => rows.filter(m => m.views <= 0).length

  const creators: PlaybookCreator[] = overview.perInfluencer.map(p => {
    const rows = piecesByCreator.get(p.influencerId) || []
    return {
      influencerId: p.influencerId,
      username: p.username,
      platform: p.platform,
      media: p.media,
      stories: p.stories,
      posts: p.posts,
      deleted: p.deleted,
      engagements: p.engagements,
      realViews: p.er.denominator,
      realViewsPieces: p.er.pieces,
      partialViewsPieces: partialOf(rows),
      noViewsPieces: noViewsOf(rows),
      er: p.er,
      cost: p.cost,
      cpm: p.cpm,
      emvExtended: p.emvExtended,
      emvRatio: p.emvRatio,
      vsBaseline: p.vsBaseline,
      deliverablesPlanned: p.deliverablesPlanned,
      status: p.status,
      clicks: typeof p.trackedClicks === 'number' && p.trackedClicks >= 0 ? p.trackedClicks : null,
      formats: Array.from(new Set(rows.filter(m => !m.isDeleted).map(m => (m.mediaType || '').toUpperCase()).filter(Boolean))),
    }
  })

  const clicksKnown = creators.filter(c => c.clicks !== null)

  return {
    campaignName: args.campaignName,
    objective: args.objective || 'awareness',
    totals: {
      media: t.media,
      mediaDeleted: t.mediaDeleted,
      stories: t.stories,
      posts: t.posts,
      creatorsActive: t.creatorsActive,
      members: t.members,
      membersWithCost: t.membersWithCost,
      views: t.views,
      realViews: t.er.denominator,
      realViewsPieces: t.er.pieces,
      partialViewsPieces: partialOf(overview.perMedia),
      reachReal: t.reachReal,
      engagements: t.engagements,
      saves: t.saves,
      er: t.er,
      cost: t.cost,
      emvExtended: t.emvExtended,
      emvRatio: t.emvRatio,
      cpm: t.cpm,
      clicks: clicksKnown.length > 0 ? clicksKnown.reduce((s, c) => s + (c.clicks as number), 0) : null,
      creatorsWithClicks: clicksKnown.filter(c => (c.clicks as number) > 0).length,
    },
    creators,
    formats: buildFormatGroups(overview.perMedia),
    delivery: overview.delivery ?? null,
    balance: overview.balance ?? null,
    targets: overview.targets ?? [],
    business: overview.business ?? null,
  }
}
