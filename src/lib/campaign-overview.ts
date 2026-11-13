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
 *
 * A creator is a person with several profiles (Nov 2026). Media.influencerId is
 * the CREDITED member of the campaign, so every count and per-creator row here
 * groups by it and a person is never counted twice. When another profile of
 * hers published the piece (her TikTok, a second Instagram),
 * Media.publishedByInfluencerId names that profile and three things follow it:
 *  - audience estimates use the followers of the account that published;
 *  - "vs su habitual" only compares pieces from the member's own profile;
 *  - perMedia.publishedBy and perInfluencer.byPlatform say where each piece is.
 * With no linked profile every figure is the one it was before.
 *
 * LATE PIECES (Nov 2026, src/lib/assignment-rules.ts). Team figures only, on
 * top of the existing keys (whose values do not change):
 *  - perMedia[].lateDays: days after the end of the campaign, null inside it;
 *  - perInfluencer[].latePieces / maxLateDays;
 *  - delivery.summary: { expected, delivered, late, notPublished, inProgress }.
 * «Fuera de plazo» never reaches the client: stripTeamOnly() removes the four
 * keys and stripEconomics() (every brand projection) calls it; the portal and
 * the exports project without them.
 */

import { prisma } from '@/lib/db'
import { campaignWindowEndExclusive, keepsLateHandAddedRow, lateDaysOf } from '@/lib/assignment-rules'
import { calculateCampaignEMV, type EmvRates } from '@/lib/emv'
import { loadEmvRates, campaignBrandId, getCreatorStoryViewRates } from '@/lib/emv-server'
import { compareWithBaseline, familyOf, parseBaseline } from '@/lib/creator-baseline'
import { isDisclosed } from '@/lib/disclosure'
import {
  ER_MIN_PIECES_CAMPAIGN,
  audienceOf,
  buildBusinessResults,
  compareTargets,
  cpmOf,
  emvRatioOf,
  engagementRateOf,
  engagementRateOnViews,
  engagementsOf,
  hasPlausibleViews,
  isStoryType,
  madridDayKey,
  memberCost,
  sumAudience,
  totalCostOf,
  type AudienceResult,
  type CampaignOverview,
  type PerInfluencerMetrics,
  type PerMediaMetrics,
  type PlatformBreakdown,
  type TimelinePoint,
  viewsBaseOf,
  type CampaignBalance,
  type DeliveryChecklist,
  type EngagementRateResult,
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
  /** The instant "has the campaign ended?" is judged at (delivery.summary). Default: now. */
  now?: Date
}

/**
 * The team's delivery summary over the members with status AGREED or later
 * (COMPLETED included). Each one is in exactly one bucket, so the four add up
 * to `expected`:
 *   delivered    her commitment (her number of deliverables, or 1 without a
 *                number) is met and no piece of hers is late;
 *   late         at least one late piece, or the campaign has ended and she
 *                published part of a defined number;
 *   notPublished no piece;
 *   inProgress   the campaign is still running and she published part of a
 *                defined number.
 * TEAM ONLY: never in the portal, the client report, the PDF or the exports.
 */
export interface DeliverySummary {
  expected: number
  delivered: number
  late: number
  notPublished: number
  inProgress: number
}

/** A publication of the team overview: days after the end of the campaign, null inside it. */
export type TeamPerMediaMetrics = PerMediaMetrics & { lateDays: number | null }
/** A creator of the team overview: her late pieces and the most days late of them (null without any). */
export type TeamPerInfluencerMetrics = PerInfluencerMetrics & { latePieces: number; maxLateDays: number | null }
export type TeamDeliveryChecklist = DeliveryChecklist & { summary: DeliverySummary }

/** What computeCampaignOverview returns: the shared overview plus the team-only late figures. */
export interface TeamCampaignOverview extends Omit<CampaignOverview, 'perMedia' | 'perInfluencer' | 'delivery'> {
  perMedia: TeamPerMediaMetrics[]
  perInfluencer: TeamPerInfluencerMetrics[]
  delivery: TeamDeliveryChecklist
}

const MEDIA_SELECT = {
  id: true, mediaType: true, platform: true, likes: true, comments: true, shares: true, saves: true,
  views: true, reach: true, impressions: true, postedAt: true, influencerId: true, isDeleted: true,
  caption: true, isAdDisclosed: true, isPaidPartnership: true,
  publishedByInfluencerId: true,
  // How the row was added: a late piece the rule keeps counts as inside the dates (delivery.dates)
  source: true, externalId: true,
} as const

const CLOSED_STATUSES = new Set(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'])

/**
 * The OTHER profile that published a piece, or null when the credited member
 * published it from her own profile (publishedByInfluencerId null, which is
 * every row before Nov 2026, or equal to the member).
 */
function otherPublisherOf(m: { influencerId: string; publishedByInfluencerId: string | null }): string | null {
  return m.publishedByInfluencerId && m.publishedByInfluencerId !== m.influencerId ? m.publishedByInfluencerId : null
}

export async function computeCampaignOverview(campaignId: string, options: ComputeOverviewOptions = {}): Promise<TeamCampaignOverview | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true, startDate: true, endDate: true, type: true,
      targetViews: true, targetReach: true, targetEngagement: true, targetER: true, targetCpmMax: true,
      promoCode: true, codeRedemptions: true, clientReportedSales: true, clientReportedLeads: true,
      clientReportedRevenue: true, businessResultsSource: true, businessResultsReportedAt: true, businessResultsNotes: true,
      influencers: {
        select: {
          influencerId: true, agreedFee: true, cost: true, status: true, deliverablesPlanned: true,
          negotiatedFormat: true, baselineSnapshot: true, trackedClicks: true,
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

  // Pieces published from ANOTHER profile of the member's person: load those
  // profiles once. A campaign with none loads nothing here and every figure
  // below is computed exactly as before Nov 2026.
  const publisherIds = Array.from(new Set(media.map(otherPublisherOf).filter((id): id is string => id !== null)))
  const publisherById = new Map<string, { id: string; username: string; platform: string; followers: number }>()
  if (publisherIds.length > 0) {
    const [profiles, publisherStoryRates] = await Promise.all([
      prisma.influencer.findMany({ where: { id: { in: publisherIds } }, select: { id: true, username: true, platform: true, followers: true } }),
      getCreatorStoryViewRates(publisherIds),
    ])
    for (const p of profiles) publisherById.set(p.id, p)
    for (const [id, rate] of publisherStoryRates) if (!storyViewRates.has(id)) storyViewRates.set(id, rate)
  }
  /**
   * Followers behind an audience estimate: those of the ACCOUNT THAT PUBLISHED
   * the piece (her TikTok may have 29.000 where her Instagram has 2.382). A
   * publishing profile with no followers on record gives no estimate at all,
   * never one borrowed from the member's other account.
   */
  const followersOf = (m: typeof media[number]): number | null => {
    const other = otherPublisherOf(m)
    if (!other) return followersById.get(m.influencerId) ?? null
    const publisher = publisherById.get(other)
    return publisher ? publisher.followers || 0 : null
  }

  // EMV per item (story estimates live here — single source for the audience of estimated stories)
  const emv = calculateCampaignEMV(
    media.map(m => ({
      platform: m.platform,
      impressions: m.impressions, reach: m.reach, views: m.views,
      likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
      mediaType: m.mediaType, postedAt: m.postedAt,
      // The publishing ACCOUNT: a story sequence and a learned story view rate
      // belong to one account, like the followers they multiply
      influencerId: otherPublisherOf(m) ?? m.influencerId,
      followers: followersOf(m),
    })),
    { rates, storyViewRates }
  )

  // Days after the end of the campaign of each piece (null inside the window): team only
  const lateDaysByIdx = media.map(m => lateDaysOf(m.postedAt, campaign.endDate))

  // Per publication
  const audienceResults: AudienceResult[] = []
  const perMedia: TeamPerMediaMetrics[] = []
  media.forEach((m, i) => {
    const a = audienceOf(m, { followers: followersOf(m), emvItem: emv.items[i], rates })
    audienceResults.push(a)
    const other = otherPublisherOf(m)
    const publisher = other ? publisherById.get(other) : undefined
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
      influencerId: m.influencerId,
      viewsPlausible: hasPlausibleViews(m),
      publishedBy: publisher ? { influencerId: publisher.id, username: publisher.username, platform: publisher.platform } : null,
      lateDays: lateDaysByIdx[i],
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
  // 4B: ER and CPM on real VIEWS (same pieces in numerator and denominator); ≥ 3 pieces with views for the campaign
  const isRealIdx = (i: number) => !audienceResults[i].estimated && audienceResults[i].value > 0
  const viewsBase = viewsBaseOf(media)
  const er = engagementRateOnViews(viewsBase, { minPieces: ER_MIN_PIECES_CAMPAIGN })
  // CPM on the same reliable sample as the ER: never "45.000 €" from one reel with 37 views
  // CPM is published exactly when the ER is (same reliable, plausible sample)
  const cpm = er.value !== null ? cpmOf(cost.total, viewsBase.views) : null
  // Secondary ER over REAL reach (only pieces where the creator provided reach)
  const reachRows = media.filter(m => (m.reach || 0) > 0)
  const erOnReach: EngagementRateResult | null = reachRows.length > 0
    ? engagementRateOf(
        reachRows.reduce((s, m) => s + engagementsOf(m), 0),
        { ...audience, real: reachRows.reduce((s, m) => s + (m.reach || 0), 0), realPieces: reachRows.length },
        { minPieces: 1 }
      )
    : null

  // Per creator (over ALL media, never a page)
  const mediaByInfluencer = new Map<string, number[]>()
  media.forEach((m, i) => {
    const arr = mediaByInfluencer.get(m.influencerId) || []
    arr.push(i)
    mediaByInfluencer.set(m.influencerId, arr)
  })
  const perInfluencer: TeamPerInfluencerMetrics[] = campaign.influencers
    .filter(ci => ci.influencer)
    .map(ci => {
      const idxs = mediaByInfluencer.get(ci.influencerId) || []
      const lateOwn = idxs.map(i => lateDaysByIdx[i]).filter((d): d is number => d !== null)
      const own = idxs.map(i => media[i])
      const ownAudience = sumAudience(idxs.map(i => audienceResults[i]))
      const ownEng = own.reduce((s, m) => s + engagementsOf(m), 0)
      void isRealIdx
      const ownViews = own.reduce((s, m) => s + (m.views || 0), 0)
      const ownViewsBase = viewsBaseOf(own)
      const ownEr = engagementRateOnViews(ownViewsBase)
      const ownEmvBasic = idxs.reduce((s, i) => s + (emv.items[i]?.basic ?? 0), 0)
      const ownEmvExt = idxs.reduce((s, i) => s + (emv.items[i]?.extended ?? 0), 0)
      const c = memberCost(ci)
      const st = own.filter(m => isStoryType(m.mediaType)).length

      // Her pieces by the network of the publication (sums = media / views / engagements of this row)
      const perNetwork = new Map<string, PlatformBreakdown>()
      for (const m of own) {
        const row = perNetwork.get(m.platform) || { pieces: 0, views: 0, engagements: 0 }
        row.pieces++
        row.views += m.views || 0
        row.engagements += engagementsOf(m)
        perNetwork.set(m.platform, row)
      }
      const byPlatform: Record<string, PlatformBreakdown> = {}
      for (const network of Array.from(perNetwork.keys()).sort()) byPlatform[network] = perNetwork.get(network)!

      // Baseline comparison per piece: median of the campaign pieces of the baseline's family.
      // The baseline is the habit of the profile she is a member with, so only pieces
      // published from that profile are compared (never her TikTok against her Instagram).
      let vsBaseline: PerInfluencerMetrics['vsBaseline'] = null
      const snapshot = parseBaseline(ci.baselineSnapshot)
      if (snapshot) {
        const pieces = own.filter(m => otherPublisherOf(m) === null && familyOf(m.mediaType) === snapshot.family)
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
        er: ownEr,
        cost: c,
        emvBasic: Math.round(ownEmvBasic * 100) / 100,
        emvExtended: Math.round(ownEmvExt * 100) / 100,
        emvRatio: emvRatioOf(ownEmvExt, c),
        cpm: ownEr.value !== null ? cpmOf(c, ownViewsBase.views) : null,
        deliverablesPlanned: ci.deliverablesPlanned ?? null,
        status: ci.status,
        trackedClicks: ci.trackedClicks ?? null,
        vsBaseline,
        byPlatform,
        latePieces: lateOwn.length,
        maxLateDays: lateOwn.length > 0 ? Math.max(...lateOwn) : null,
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

  // ----- Prometido vs entregado (real data; green only when it is true) -----
  const plannedMembers = campaign.influencers.filter(ci => CLOSED_STATUSES.has(ci.status))
  const creatorsPlanned = plannedMembers.length
  const creatorsDelivered = plannedMembers.filter(ci => (mediaByInfluencer.get(ci.influencerId)?.length ?? 0) > 0).length
  const plannedPieces = campaign.influencers.reduce((s, ci) => s + (ci.deliverablesPlanned ?? 0), 0)
  const hasPlannedPieces = campaign.influencers.some(ci => typeof ci.deliverablesPlanned === 'number' && ci.deliverablesPlanned > 0)
  const start = campaign.startDate ? new Date(campaign.startDate).getTime() : null
  const end = campaign.endDate ? new Date(campaign.endDate).getTime() + 24 * 60 * 60 * 1000 : null
  const dated = media.filter(m => m.postedAt)
  // A piece published after the end that the late rule accepted (added by hand
  // «fuera de plazo», at most LATE_ACCEPT_MAX_DAYS late, not Social Listening)
  // keeps the agreed terms: it counts as inside the dates. Otherwise the row
  // «Fechas» would fail for a piece the rule accepted, and that failure is
  // what the client sees (portal, client report, PDF): «fuera de plazo» is
  // team only. Nothing else changes: other rows after the end still fail it.
  const inWindow = dated.filter(m => {
    const t = new Date(m.postedAt as Date).getTime()
    return ((start === null || t >= start) && (end === null || t < end)) || keepsLateHandAddedRow(campaign, m)
  }).length
  const feed = media.filter(m => !isStoryType(m.mediaType))
  const disclosedRows = feed.filter(m => isDisclosed(m))

  // Team summary (see DeliverySummary): one bucket per member in AGREED or later
  const windowEnd = campaignWindowEndExclusive(campaign.endDate)
  const ended = windowEnd !== null && (options.now ?? new Date()).getTime() >= windowEnd.getTime()
  const summary: DeliverySummary = { expected: plannedMembers.length, delivered: 0, late: 0, notPublished: 0, inProgress: 0 }
  for (const ci of plannedMembers) {
    const idxs = mediaByInfluencer.get(ci.influencerId) ?? []
    const planned = typeof ci.deliverablesPlanned === 'number' && ci.deliverablesPlanned > 0 ? ci.deliverablesPlanned : null
    if (idxs.length === 0) summary.notPublished++
    else if (idxs.some(i => lateDaysByIdx[i] !== null)) summary.late++
    else if (idxs.length >= (planned ?? 1)) summary.delivered++
    else if (ended) summary.late++
    else summary.inProgress++
  }

  const delivery: TeamDeliveryChecklist = {
    creators: { planned: creatorsPlanned, delivered: creatorsDelivered, ok: creatorsPlanned > 0 && creatorsDelivered >= creatorsPlanned },
    pieces: {
      planned: hasPlannedPieces ? plannedPieces : null,
      delivered: media.length,
      ok: hasPlannedPieces ? media.length >= plannedPieces : media.length > 0,
    },
    dates: { inWindow, total: dated.length, ok: dated.length > 0 && inWindow === dated.length },
    disclosure: {
      disclosed: disclosedRows.length,
      total: feed.length,
      ok: feed.length > 0 && disclosedRows.length === feed.length,
      missingMediaIds: feed.filter(m => !isDisclosed(m)).map(m => m.id),
    },
    allOk: false,
    summary,
  }
  delivery.allOk = delivery.creators.ok && delivery.pieces.ok && delivery.dates.ok && delivery.disclosure.ok

  // ----- Balance in four labelled dimensions -----
  const realShare = media.length > 0 ? media.filter(m => hasPlausibleViews(m) || (m.reach || 0) > 0).length / media.length : 0
  const verdicts = targets.map(t => t.verdict)
  const cpmTarget = targets.find(t => t.key === 'cpm')
  const balance: CampaignBalance = {
    execution: media.length === 0 && creatorsPlanned === 0 ? 'no_data'
      : delivery.allOk ? 'complete'
        : (!delivery.pieces.ok || !delivery.creators.ok) ? 'incomplete' : 'issues',
    results: verdicts.length === 0 ? 'no_targets'
      : verdicts.includes('below') ? 'below'
        : verdicts.includes('above') ? 'above'
          : verdicts.includes('on_target') ? 'on_target' : 'no_targets',
    efficiency: !cpmTarget || cpmTarget.verdict === 'no_data' ? 'no_data'
      : cpmTarget.verdict === 'above' ? 'better' : cpmTarget.verdict === 'below' ? 'worse' : 'in_range',
    dataReliability: media.length === 0 ? 'no_data' : realShare >= 0.8 ? 'high' : realShare >= 0.5 ? 'medium' : 'low',
    realShare: Math.round(realShare * 100) / 100,
  }

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
      emvTrustMultiplier: rates.trustMultiplier > 1 ? rates.trustMultiplier : 1,
      cpm,
      mediaCounts,
    },
    perInfluencer,
    perMedia,
    timeline,
    targets,
    business: buildBusinessResults(campaign, cost.total),
    erOnReach,
    delivery,
    balance,
  }
}

/**
 * The overview without the team-only late figures (perMedia[].lateDays,
 * perInfluencer[].latePieces / maxLateDays, delivery.summary): what may leave
 * the team (anything a brand reads, the exports). «Fuera de plazo» is team
 * only (owner's decision, Nov 2026). Every other key is untouched.
 */
export function stripTeamOnly(overview: CampaignOverview): CampaignOverview {
  const { summary: _summary, ...delivery } = overview.delivery as DeliveryChecklist & { summary?: unknown }
  void _summary
  return {
    ...overview,
    perMedia: overview.perMedia.map(m => {
      const { lateDays: _lateDays, ...rest } = m as PerMediaMetrics & { lateDays?: unknown }
      void _lateDays
      return rest
    }),
    perInfluencer: overview.perInfluencer.map(p => {
      const { latePieces: _latePieces, maxLateDays: _maxLateDays, ...rest } = p as PerInfluencerMetrics & { latePieces?: unknown; maxLateDays?: unknown }
      void _latePieces
      void _maxLateDays
      return rest
    }),
    delivery,
  }
}

/**
 * Strip every economic figure for brand-portal consumers when fees must not be
 * shown: cost, ratio, CPM (totals, per creator, the CPM target row) and the
 * cost-derived business figures. Basic EMV is internal too (David 8A: the
 * client sees ONE EMV, the extended one). Every brand projection goes through
 * here, so it also drops the team-only late figures (stripTeamOnly).
 */
export function stripEconomics(full: CampaignOverview): CampaignOverview {
  const overview = stripTeamOnly(full)
  return {
    ...overview,
    totals: { ...overview.totals, cost: 0, membersWithCost: 0, emvRatio: null, cpm: null, emvBasic: 0 },
    perInfluencer: overview.perInfluencer.map(p => ({ ...p, cost: 0, emvRatio: null, cpm: null, emvBasic: 0 })),
    perMedia: overview.perMedia.map(m => ({ ...m, emvBasic: 0 })),
    targets: overview.targets.filter(t => t.key !== 'cpm'),
    business: overview.business ? { ...overview.business, cpa: null, roas: null } : null,
    // Efficiency is a cost judgement: never exposed to the client
    balance: { ...overview.balance, efficiency: 'no_data' },
  }
}

/**
 * Several campaigns at once with bounded concurrency (dashboard, radar, compare).
 * Returns a Map campaignId → overview (missing campaigns are absent).
 */
export async function computeCampaignOverviews(
  campaignIds: string[],
  options: ComputeOverviewOptions & { concurrency?: number } = {}
): Promise<Map<string, TeamCampaignOverview>> {
  const out = new Map<string, TeamCampaignOverview>()
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
