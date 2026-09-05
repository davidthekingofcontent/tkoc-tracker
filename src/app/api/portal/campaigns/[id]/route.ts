import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { resolveBrandScope, sanitizeCampaignForBrand } from '@/lib/brand-scope'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import { buildCampaignLearnings, toClientLearnings } from '@/lib/campaign-learnings'
import { loadReportConfig, reportConfigForBrand } from '@/lib/report-config'
import type { CampaignOverview } from '@/lib/metrics'

// Brands are not a Prisma model: Setting 'campaign_brand_{campaignId}' holds
// the brandId, and Setting key=brandId holds JSON { name, logo?, ... } (see
// src/lib/brand-scope.ts). The report cover needs name + logo. Never throws.
async function resolveCampaignBrand(
  campaignId: string
): Promise<{ name: string; logo: string | null } | null> {
  try {
    const mapping = await prisma.setting.findUnique({
      where: { key: `campaign_brand_${campaignId}` },
    })
    if (!mapping?.value) return null
    const brandSetting = await prisma.setting.findUnique({ where: { key: mapping.value } })
    if (!brandSetting) return null
    const data = JSON.parse(brandSetting.value) as { name?: unknown; logo?: unknown }
    if (!data || typeof data.name !== 'string' || !data.name.trim()) return null
    return {
      name: data.name.trim(),
      logo: typeof data.logo === 'string' && data.logo.trim() ? data.logo.trim() : null,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Brand-facing projection of the ONE campaign computation.
//
// The numbers come from computeCampaignOverview (src/lib/campaign-overview.ts)
// — never recomputed here. stripEconomics() zeroes fees/ratio/CPM; on top of
// that we drop the keys themselves so a brand never even sees the field names:
// cost, membersWithCost, emvBasic, emvRatio, cpm and the CPM target row.
// The only EMV a client sees is the extended one (David, decision 9B).
// Field names match what GET /api/campaigns/[id] exposes so the shared
// report component can read both responses with the same code.
// ---------------------------------------------------------------------------

type PortalTotals = Omit<CampaignOverview['totals'], 'cost' | 'membersWithCost' | 'emvBasic' | 'emvRatio' | 'cpm'>
type PortalInfluencer = Omit<CampaignOverview['perInfluencer'][number], 'cost' | 'emvBasic' | 'emvRatio' | 'cpm'>
type PortalMedia = Omit<CampaignOverview['perMedia'][number], 'emvBasic'>

interface PortalOverview {
  definitionsVersion: CampaignOverview['definitionsVersion']
  totals: PortalTotals
  perInfluencer: PortalInfluencer[]
  perMedia: PortalMedia[]
  timeline: CampaignOverview['timeline']
  targets: CampaignOverview['targets']
  business: CampaignOverview['business']
  // Legacy keys kept for old portal clients (same values as the totals above).
  totalMedia: number
  totalLikes: number
  totalComments: number
  totalViews: number
  /** Audiencia total (real + estimada) — what the old client called "reach". */
  totalReach: number
  totalImpressions: number | null
  totalEngagements: number
  engagementRate: number
  profilesPosted: number
  mediaCounts: Record<string, number>
  emvExtended: number
  emvEstimatedStories: number
  emvRealStories: number
  emvEstimatedAudience: number
}

function toPortalOverview(full: CampaignOverview): PortalOverview {
  const ov = stripEconomics(full)
  const t = ov.totals
  const totals: PortalTotals = {
    media: t.media,
    mediaDeleted: t.mediaDeleted,
    stories: t.stories,
    posts: t.posts,
    creatorsActive: t.creatorsActive,
    views: t.views,
    likes: t.likes,
    comments: t.comments,
    shares: t.shares,
    saves: t.saves,
    engagements: t.engagements,
    audience: t.audience,
    reachReal: t.reachReal,
    impressionsReal: t.impressionsReal,
    er: t.er,
    members: t.members,
    emvExtended: t.emvExtended,
    emvEstimatedStories: t.emvEstimatedStories,
    emvRealStories: t.emvRealStories,
    emvEstimatedAudience: t.emvEstimatedAudience,
    mediaCounts: t.mediaCounts,
  }

  const perInfluencer: PortalInfluencer[] = ov.perInfluencer.map(p => ({
    influencerId: p.influencerId,
    username: p.username,
    platform: p.platform,
    displayName: p.displayName,
    followers: p.followers,
    media: p.media,
    stories: p.stories,
    posts: p.posts,
    deleted: p.deleted,
    views: p.views,
    engagements: p.engagements,
    audience: p.audience,
    er: p.er,
    emvExtended: p.emvExtended,
    deliverablesPlanned: p.deliverablesPlanned,
    status: p.status,
    vsBaseline: p.vsBaseline,
  }))
  const perMedia: PortalMedia[] = ov.perMedia.map(m => ({
    id: m.id,
    views: m.views,
    mediaType: m.mediaType,
    audience: m.audience,
    audienceBasis: m.audienceBasis,
    audienceEstimated: m.audienceEstimated,
    engagements: m.engagements,
    emvExtended: m.emvExtended,
    isDeleted: m.isDeleted,
  }))

  return {
    definitionsVersion: ov.definitionsVersion,
    totals,
    perInfluencer,
    perMedia,
    timeline: ov.timeline,
    // The CPM target compares against cost: not for brands.
    targets: ov.targets.filter(t => t.key !== 'cpm'),
    business: ov.business,
    totalMedia: totals.media,
    totalLikes: totals.likes,
    totalComments: totals.comments,
    totalViews: totals.views,
    totalReach: totals.audience.total,
    totalImpressions: totals.impressionsReal,
    totalEngagements: totals.engagements,
    engagementRate: totals.er.value ?? 0,
    profilesPosted: totals.creatorsActive,
    mediaCounts: totals.mediaCounts,
    emvExtended: totals.emvExtended,
    emvEstimatedStories: totals.emvEstimatedStories,
    emvRealStories: totals.emvRealStories,
    emvEstimatedAudience: totals.emvEstimatedAudience,
  }
}

// GET /api/portal/campaigns/[id]
// Brand-facing, read-only campaign detail. Response shape is compatible with
// what the campaign report page expects from GET /api/campaigns/[id]:
//   { campaign: { ..., influencers: [{ influencer, status }], media: [...] }, overview }
// but with ALL confidential fields stripped (agreedFee, cost, commission,
// notes, budget, ratio EMV, CPM, shipping*). Media keeps the `source` field so
// the report can badge Meta vs public data, and `isDeleted` so deleted posts
// are marked (decision 7B: they stay in the totals).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'BRAND' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    // BRAND users only see campaigns inside their resolved scope.
    // Out-of-scope ids get a 404 (not 403) to avoid existence leaks.
    // ADMIN bypasses the scope check (portal testing).
    if (session.role !== 'ADMIN') {
      const scope = await resolveBrandScope(session.id)
      if (!scope.campaignIds.includes(id)) {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
      }
    }

    const { searchParams } = new URL(request.url)
    const mediaOffset = Math.max(
      parseInt(searchParams.get('mediaOffset') || '0', 10) || 0,
      0
    )
    const mediaLimit = Math.min(
      Math.max(parseInt(searchParams.get('mediaLimit') || '50', 10) || 50, 1),
      100
    )

    // The campaign row (with ONE page of media) and the full overview (over
    // ALL media, never a page) are independent: load them together.
    // What the agency hid from the client (ReportConfig) never leaves the server:
    // hidden publications/creators are excluded from the lists AND from every figure.
    const reportConfig = await loadReportConfig(id)
    const hiddenMediaIds = reportConfig.hiddenMediaIds
    const hiddenInfluencerIds = reportConfig.hiddenInfluencerIds

    const learningsMediaWhere = (hiddenMediaIds.length > 0 || hiddenInfluencerIds.length > 0)
      ? {
          ...(hiddenMediaIds.length > 0 ? { id: { notIn: hiddenMediaIds } } : {}),
          ...(hiddenInfluencerIds.length > 0 ? { influencerId: { notIn: hiddenInfluencerIds } } : {}),
        }
      : {}

    const [campaign, fullOverview, brand, learningsRows] = await Promise.all([
      prisma.campaign.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          platforms: true,
          paymentType: true,
          objective: true,
          createdAt: true,
          // Objetivos numéricos (decisión 1B): the client may see what was
          // agreed, except the CPM cap, which is a cost figure.
          targetViews: true,
          targetReach: true,
          targetEngagement: true,
          targetER: true,
          targetsFrozenAt: true,
          // Resultados de negocio aportados por el propio cliente (decisión 14A).
          promoCode: true,
          codeRedemptions: true,
          clientReportedSales: true,
          clientReportedLeads: true,
          clientReportedRevenue: true,
          businessResultsSource: true,
          businessResultsReportedAt: true,
          businessResultsNotes: true,
          influencers: {
            where: hiddenInfluencerIds.length > 0 ? { influencerId: { notIn: hiddenInfluencerIds } } : undefined,
            select: {
              id: true,
              status: true,
              contentDelivered: true,
              deliverablesPlanned: true,
              // "Vs su habitual" in the report: the creator's frozen baseline
              // (public medians, no economics) and the format it refers to.
              baselineSnapshot: true,
              negotiatedFormat: true,
              influencer: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  avatarUrl: true,
                  platform: true,
                  followers: true,
                  engagementRate: true,
                },
              },
            },
          },
          media: {
            where: (hiddenMediaIds.length > 0 || hiddenInfluencerIds.length > 0)
              ? {
                  ...(hiddenMediaIds.length > 0 ? { id: { notIn: hiddenMediaIds } } : {}),
                  ...(hiddenInfluencerIds.length > 0 ? { influencerId: { notIn: hiddenInfluencerIds } } : {}),
                }
              : undefined,
            orderBy: { postedAt: 'desc' },
            skip: mediaOffset,
            take: mediaLimit,
            select: {
              id: true,
              platform: true,
              mediaType: true,
              caption: true,
              thumbnailUrl: true,
              permalink: true,
              likes: true,
              comments: true,
              shares: true,
              saves: true,
              views: true,
              reach: true,
              impressions: true,
              engagementRate: true,
              source: true,
              postedAt: true,
              isDeleted: true,
              deletedAt: true,
              // Provenance of creator-provided statistics (badge "Estadísticas del creador"); never insightsBy (staff email)
              insightsSource: true,
              insightsCapturedAt: true,
              influencer: {
                select: {
                  id: true,
                  username: true,
                  displayName: true,
                  avatarUrl: true,
                  platform: true,
                },
              },
            },
          },
        },
      }),
      computeCampaignOverview(id, { exclude: { mediaIds: hiddenMediaIds, influencerIds: hiddenInfluencerIds } }),
      // Brand info for the report cover: { name, logo } | null
      resolveCampaignBrand(id),
      // Minimal rows for the learnings (likes/comments/shares/saves split + formats), same exclusions.
      prisma.media.findMany({
        where: { campaignId: id, ...learningsMediaWhere },
        select: { influencerId: true, likes: true, comments: true, shares: true, saves: true, mediaType: true },
      }),
    ])

    if (!campaign || !fullOverview) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const overview = toPortalOverview(fullOverview)

    // Client-safe learnings from the same overview: no grade, no Ratio EMV, no
    // worst performer, no skip list, no budget advice, no € / CPM wording.
    const learnings = toClientLearnings(buildCampaignLearnings({
      overview: fullOverview,
      campaignName: campaign.name,
      objective: campaign.objective,
      media: learningsRows,
      locale: 'es',
    }))

    // Defense in depth: the selects above are already narrow and the overview
    // projection drops every economic key, but strip any confidential key that
    // might sneak in if a select widens later.
    return NextResponse.json(sanitizeCampaignForBrand({
      campaign: { ...campaign, brand },
      overview,
      learnings,
      // Client-safe projection of the agency's report configuration (texts, hidden sections/columns)
      reportConfig: reportConfigForBrand(reportConfig),
    }))
  } catch (error) {
    console.error('Portal campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
