/**
 * CAMPAIGN OVERVIEW — the one server-side computation every surface consumes.
 *
 * computeCampaignOverview(campaignId) loads ALL media of the campaign (never a
 * page), values it with the campaign brand's EMV rates and the creators' real
 * story view rates, and applies the definitions in src/lib/metrics.ts. Returns
 * campaign totals, per-creator and per-publication figures, the daily timeline
 * (Europe/Madrid days), the target comparison and the client-provided business
 * results. Used by: GET /api/campaigns/[id], the portal campaign API, the report,
 * CSV/JSON exports, compare, dashboard, intelligence handlers, AI assistant.
 *
 * Deleted publications (isDeleted) stay in the totals and are counted apart
 * (David, decision 7B).
 */

import { prisma } from '@/lib/db'
import { calculateCampaignEMV, type EmvRates } from '@/lib/emv'
import { loadEmvRates, campaignBrandId, getCreatorStoryViewRates } from '@/lib/emv-server'
import { compareWithBaseline, familyOf, parseBaseline } from '@/lib/creator-baseline'
import {
  ER_MIN_PIECES_CAMPAIGN,
  audienceOf,
  buildBusinessResults,
  compareTargets,
  cpmOf,
  emvRatioOf,
  engagementRateOf,
  engagementsOf,
  isStoryType,
  madridDayKey,
  memberCost,
  sumAudience,
  totalCostOf,
  type AudienceResult,
  type CampaignOverview,
  type PerInfluencerMetrics,
  type PerMediaMetrics,
  type TimelinePoint,
} from '@/lib/metrics'

export interface ComputeOverviewOptions {
  /** Pre-loaded rates (skips the Setting lookup). */
  rates?: EmvRates
  /**
   * Report view: publications and creators the agency hid from the client
   * (ReportConfig.hiddenMediaIds / hiddenInfluencerIds) are left out of EVERY
   * figure, so the report totals match its tables. The PM's campaign page never
   * passes this and sees everything.
   */
  exclude?: { mediaIds?: string[]; influencerIds?: string[] }
}

const MEDIA_SELECT = {
  id: true, mediaType: true, platform: true, likes: true, comments: true, shares: true, saves: true,
  views: true, reach: true, impressions: true, postedAt: true, influencerId: true, isDeleted: true,
} as const

export async function computeCampaignOverview(campaignId: string, options: ComputeOverviewOptions = {}): Promise<CampaignOverview | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      targetViews: true, targetReach: true, targetEngagement: true, targetER: true, targetCpmMax: true,
      promoCode: true, codeRedemptions: true, clientReportedSales: true, clientReportedLeads: true,
      clientReportedRevenue: true, businessResultsSource: true, businessResultsReportedAt: true, businessResultsNotes: true,
      influencers: {
        select: {
          influencerId: true, agreedFee: true, cost: true, status: true, deliverablesPlanned: true,
          negotiatedFormat: true, baselineSnapshot: true,
          influencer: { select: { id: true, username: true, platform: true, displayName: true, followers: true } },
        },
      },
    },
  })
  if (!campaign) return null

  const hiddenMedia = new Set(options.exclude?.mediaIds ?? [])
  const hiddenInfluencers = new Set(options.exclude?.influencerIds ?? [])
  if (hiddenInfluencers.size > 0) {
    campaign.influencers = campaign.influencers.filter(ci => !hiddenInfluencers.has(ci.influencerId))
  }

  const [allMedia, rates, storyViewRates] = await Promise.all([
    prisma.media.findMany({ where: { campaignId }, select: MEDIA_SELECT, orderBy: { postedAt: 'asc' } }),
    options.rates ? Promise.resolve(options.rates) : campaignBrandId(campaignId).then(b => loadEmvRates(b)),
    getCreatorStoryViewRates(campaign.influencers.map(ci => ci.influencerId)),
  ])
  const media = hiddenMedia.size > 0 || hiddenInfluencers.size > 0
    ? allMedia.filter(m => !hiddenMedia.has(m.id) && !hiddenInfluencers.has(m.influencerId))
    : allMedia

  const followersById = new Map<string, number>()
  for (const ci of campaign.influencers) followersById.set(ci.influencerId, ci.influencer?.followers || 0)

  // EMV per item (story estimates live here — single source for the audience of estimated stories)
  const emv = calculateCampaignEMV(
    media.map(m => ({
      platform: m.platform,
      impressions: m.impressions, reach: m.reach, views: m.views,
      likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
      mediaType: m.mediaType, postedAt: m.postedAt, influencerId: m.influencerId,
      followers: followersById.get(m.influencerId) ?? null,
    })),
    { rates, storyViewRates }
  )

  // Per publication
  const audienceResults: AudienceResult[] = []
  const perMedia: PerMediaMetrics[] = []
  media.forEach((m, i) => {
    const a = audienceOf(m, { followers: followersById.get(m.influencerId) ?? null, emvItem: emv.items[i], rates })
    audienceResults.push(a)
    perMedia.push({
      id: m.id,
      views: m.views || 0,
      mediaType: m.mediaType,
      audience: a.value,
      audienceBasis: a.basis,
      audienceEstimated: a.estimated,
      engagements: engagementsOf(m),
      emvBasic: emv.items[i]?.basic ?? 0,
      emvExtended: emv.items[i]?.extended ?? 0,
      isDeleted: !!m.isDeleted,
    })
  })

  // Totals
  const audience = sumAudience(audienceResults)
  const sum = (f: (m: typeof media[number]) => number) => media.reduce((s, m) => s + f(m), 0)
  const likes = sum(m => m.likes || 0), comments = sum(m => m.comments || 0), shares = sum(m => m.shares || 0), saves = sum(m => m.saves || 0)
  const engagements = likes + comments + shares + saves
  const views = sum(m => m.views || 0)
  const reachReal = sum(m => m.reach || 0)
  const impressionsRealSum = sum(m => m.impressions || 0)
  const cost = totalCostOf(campaign.influencers)
  const stories = media.filter(m => isStoryType(m.mediaType)).length
  const mediaCounts: Record<string, number> = {}
  for (const m of media) mediaCounts[m.mediaType] = (mediaCounts[m.mediaType] || 0) + 1
  // 4A: ER and CPM on REAL audience only — interacciones of the same publications that have a real figure
  const isRealIdx = (i: number) => !audienceResults[i].estimated && audienceResults[i].value > 0
  const engagementsReal = media.reduce((s, m, i) => s + (isRealIdx(i) ? engagementsOf(m) : 0), 0)
  // Campaign ER is published only with ≥ 3 publications with real audience and a plausible ratio
  const er = engagementRateOf(engagementsReal, audience, { minPieces: ER_MIN_PIECES_CAMPAIGN })
  const cpm = cpmOf(cost.total, audience.real)

  // Per creator (over ALL media, never a page)
  const mediaByInfluencer = new Map<string, number[]>()
  media.forEach((m, i) => {
    const arr = mediaByInfluencer.get(m.influencerId) || []
    arr.push(i)
    mediaByInfluencer.set(m.influencerId, arr)
  })
  const perInfluencer: PerInfluencerMetrics[] = campaign.influencers
    .filter(ci => ci.influencer)
    .map(ci => {
      const idxs = mediaByInfluencer.get(ci.influencerId) || []
      const own = idxs.map(i => media[i])
      const ownAudience = sumAudience(idxs.map(i => audienceResults[i]))
      const ownEng = own.reduce((s, m) => s + engagementsOf(m), 0)
      const ownEngReal = idxs.reduce((s, i) => s + (isRealIdx(i) ? engagementsOf(media[i]) : 0), 0)
      const ownViews = own.reduce((s, m) => s + (m.views || 0), 0)
      const ownEmvBasic = idxs.reduce((s, i) => s + (emv.items[i]?.basic ?? 0), 0)
      const ownEmvExt = idxs.reduce((s, i) => s + (emv.items[i]?.extended ?? 0), 0)
      const c = memberCost(ci)
      const st = own.filter(m => isStoryType(m.mediaType)).length

      // Baseline comparison per piece: median of the campaign pieces of the baseline's family
      let vsBaseline: PerInfluencerMetrics['vsBaseline'] = null
      const snapshot = parseBaseline(ci.baselineSnapshot)
      if (snapshot) {
        const pieces = own.filter(m => familyOf(m.mediaType) === snapshot.family)
        if (pieces.length > 0) {
          const med = (vals: number[]) => { const s = [...vals].sort((x, y) => x - y); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2) }
          const cmp = compareWithBaseline(snapshot, {
            views: med(pieces.map(m => m.views || 0)),
            engagement: med(pieces.map(m => engagementsOf(m))),
            family: snapshot.family,
          })
          if (cmp) vsBaseline = { ...cmp, piecesCompared: pieces.length }
        }
      }
      return {
        influencerId: ci.influencerId,
        username: ci.influencer!.username,
        platform: ci.influencer!.platform,
        displayName: ci.influencer!.displayName ?? null,
        followers: ci.influencer!.followers || 0,
        media: own.length,
        stories: st,
        posts: own.length - st,
        deleted: own.filter(m => m.isDeleted).length,
        views: ownViews,
        engagements: ownEng,
        audience: ownAudience,
        er: engagementRateOf(ownEngReal, ownAudience),
        cost: c,
        emvBasic: Math.round(ownEmvBasic * 100) / 100,
        emvExtended: Math.round(ownEmvExt * 100) / 100,
        emvRatio: emvRatioOf(ownEmvExt, c),
        cpm: cpmOf(c, ownAudience.real),
        deliverablesPlanned: ci.deliverablesPlanned ?? null,
        status: ci.status,
        vsBaseline,
      }
    })

  // Timeline by Madrid day
  const byDay = new Map<string, TimelinePoint>()
  media.forEach((m, i) => {
    if (!m.postedAt) return
    const key = madridDayKey(m.postedAt)
    if (!key) return
    const row = byDay.get(key) || { date: key, posts: 0, likes: 0, comments: 0, views: 0, engagements: 0, audience: 0, reach: 0 }
    row.posts++
    row.likes += m.likes || 0
    row.comments += m.comments || 0
    row.views += m.views || 0
    row.engagements += engagementsOf(m)
    row.audience += audienceResults[i].value
    row.reach = row.audience
    byDay.set(key, row)
  })
  const timeline = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date))

  const targets = compareTargets(campaign, {
    views,
    audience: audience.real,
    engagements,
    er: er.value,
    cpm,
  })

  return {
    definitionsVersion: 2,
    totals: {
      media: media.length,
      mediaDeleted: media.filter(m => m.isDeleted).length,
      stories,
      posts: media.length - stories,
      creatorsActive: mediaByInfluencer.size,
      views, likes, comments, shares, saves, engagements,
      audience,
      reachReal,
      impressionsReal: impressionsRealSum > 0 ? impressionsRealSum : null,
      er,
      cost: cost.total,
      membersWithCost: cost.membersWithCost,
      members: campaign.influencers.length,
      emvBasic: emv.basic,
      emvExtended: emv.extended,
      emvEstimatedStories: emv.estimatedStories,
      emvRealStories: emv.realStories,
      emvEstimatedAudience: emv.estimatedAudience,
      emvRatio: emvRatioOf(emv.extended, cost.total),
      cpm,
      mediaCounts,
    },
    perInfluencer,
    perMedia,
    timeline,
    targets,
    business: buildBusinessResults(campaign, cost.total),
  }
}

/**
 * Strip every economic figure for brand-portal consumers when fees must not be
 * shown: cost, ratio, CPM (totals, per creator, the CPM target row) and the
 * cost-derived business figures. Basic EMV is internal too (David 8A: the
 * client sees ONE EMV, the extended one).
 */
export function stripEconomics(overview: CampaignOverview): CampaignOverview {
  return {
    ...overview,
    totals: { ...overview.totals, cost: 0, membersWithCost: 0, emvRatio: null, cpm: null, emvBasic: 0 },
    perInfluencer: overview.perInfluencer.map(p => ({ ...p, cost: 0, emvRatio: null, cpm: null, emvBasic: 0 })),
    perMedia: overview.perMedia.map(m => ({ ...m, emvBasic: 0 })),
    targets: overview.targets.filter(t => t.key !== 'cpm'),
    business: overview.business ? { ...overview.business, cpa: null, roas: null } : null,
  }
}

/**
 * Several campaigns at once with bounded concurrency (dashboard, radar, compare).
 * Returns a Map campaignId → overview (missing campaigns are absent).
 */
export async function computeCampaignOverviews(
  campaignIds: string[],
  options: ComputeOverviewOptions & { concurrency?: number } = {}
): Promise<Map<string, CampaignOverview>> {
  const out = new Map<string, CampaignOverview>()
  const ids = Array.from(new Set(campaignIds))
  const size = Math.max(1, options.concurrency ?? 5)
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size)
    const results = await Promise.all(chunk.map(async id => {
      try { return [id, await computeCampaignOverview(id, options)] as const }
      catch (err) { console.error(`[campaign-overview] failed for ${id}:`, err instanceof Error ? err.message : err); return [id, null] as const }
    }))
    for (const [id, ov] of results) if (ov) out.set(id, ov)
  }
  return out
}
