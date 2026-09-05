/**
 * GET /api/dashboard — agency-level KPIs.
 *
 * Every aggregate (investment, EMV, content, engagement, audience) uses the
 * SAME campaign filter: the role-scoped, non-archived campaigns. Each campaign
 * is valued by computeCampaignOverview (the one source of truth) and the
 * dashboard only sums. Posts that live in several campaigns (annual + monthly)
 * count ONCE at agency level: rows are deduplicated by post and the number of
 * duplicates removed is reported in `stats.dedupedPosts`. Cost is per campaign
 * membership (a creator paid in two campaigns has two fees).
 *
 * BRAND users never receive fees, cost, CPM or the EMV ratio.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus } from '@/generated/prisma/client'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { dedupeMediaByPost } from '@/lib/campaign-capture'
import {
  cpmOf,
  emvRatioOf,
  engagementRateOf,
  engagementsOf,
  isStoryType,
  sumAudience,
  type AudienceResult,
  type CampaignOverview,
  type PerMediaMetrics,
} from '@/lib/metrics'

/** One overview per campaign, a few at a time so the connection pool is not flooded. */
async function computeOverviews(ids: string[]): Promise<Map<string, CampaignOverview>> {
  const out = new Map<string, CampaignOverview>()
  const CHUNK = 5
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const results = await Promise.all(chunk.map(id => computeCampaignOverview(id)))
    results.forEach((o, j) => { if (o) out.set(chunk[j], o) })
  }
  return out
}

type DashMedia = {
  id: string; externalId: string | null; platform: string; permalink: string | null; mediaType: string
  views: number; likes: number; comments: number; shares: number; saves: number
  postedAt: Date | null; influencerId: string
  influencer: { username: string; followers: number }
  campaign: { name: string } | null
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const isBrand = session.role === 'BRAND'

    // ADMIN sees all campaigns
    // EMPLOYEE sees own + assigned campaigns + campaigns from assigned brands
    // BRAND sees only own campaigns
    // ALWAYS exclude archived campaigns from dashboard metrics
    let campaignWhere: Record<string, unknown> = {
      status: { not: CampaignStatus.ARCHIVED },
    }
    if (session.role === 'EMPLOYEE') {
      // Look up brands assigned to this employee
      const brandAssignmentSettings = await prisma.setting.findMany({
        where: { key: { startsWith: 'brand_assignment_' } },
      })
      const assignedBrandIds: string[] = []
      for (const setting of brandAssignmentSettings) {
        try {
          const employeeIds = JSON.parse(setting.value) as string[]
          if (employeeIds.includes(session.id)) {
            const brandUserId = setting.key.replace('brand_assignment_', '')
            assignedBrandIds.push(brandUserId)
          }
        } catch { /* skip malformed entries */ }
      }

      const orConditions: Record<string, unknown>[] = [
        { userId: session.id },
        { assignments: { some: { userId: session.id } } },
      ]
      if (assignedBrandIds.length > 0) {
        orConditions.push({ user: { id: { in: assignedBrandIds } } })
      }
      campaignWhere = { ...campaignWhere, OR: orConditions }
    } else if (isBrand) {
      campaignWhere = { ...campaignWhere, userId: session.id }
    }

    // THE filter: the exact campaign ids every aggregate below is built on.
    const campaignRows = await prisma.campaign.findMany({ where: campaignWhere, select: { id: true, status: true } })
    const campaignIds = campaignRows.map(c => c.id)
    const activeCampaigns = campaignRows.filter(c => c.status === CampaignStatus.ACTIVE).length
    const totalCampaigns = campaignRows.length

    // Total influencers across those campaigns
    const uniqueInfluencers = campaignIds.length > 0
      ? await prisma.campaignInfluencer.findMany({
          where: { campaignId: { in: campaignIds } },
          select: { influencerId: true },
          distinct: ['influencerId'],
        })
      : []
    const influencerIds = uniqueInfluencers.map((ci) => ci.influencerId)

    // Recent campaigns with influencer counts
    const recentCampaigns = await prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        _count: { select: { influencers: true, media: true } },
      },
    })

    // Pinned lists
    const pinnedLists = await prisma.list.findMany({
      where: { userId: session.id, isPinned: true, isArchived: false },
      include: { _count: { select: { items: true } } },
      take: 5,
    })

    // --- Campaign numbers: one overview per campaign, then sum ---
    let cost = 0
    let membersWithCost = 0
    let emvBasic = 0
    let emvExtended = 0
    let views = 0, likes = 0, comments = 0, shares = 0, saves = 0, engagements = 0
    // 4A: the ER numerator is the interacciones of the SAME publications that carry a
    // real audience figure (mirrors isRealIdx in campaign-overview.ts), never the total.
    let engagementsReal = 0
    let mediaDeleted = 0, stories = 0
    let dedupedPosts = 0
    let uniqueMedia: DashMedia[] = []
    const audienceResults: AudienceResult[] = []
    try {
      const overviews = await computeOverviews(campaignIds)

      // Cost is per campaign membership — summed straight from the overviews.
      for (const o of overviews.values()) {
        cost += o.totals.cost
        membersWithCost += o.totals.membersWithCost
      }

      // Per-publication figures from the overviews, keyed by Media row id.
      const perMediaById = new Map<string, PerMediaMetrics>()
      for (const o of overviews.values()) for (const pm of o.perMedia) perMediaById.set(pm.id, pm)

      // Media rows of the same campaigns, deduplicated by post (annual + monthly = one post).
      const allMedia: DashMedia[] = campaignIds.length > 0
        ? await prisma.media.findMany({
            where: { campaignId: { in: campaignIds } },
            select: {
              id: true, externalId: true, platform: true, permalink: true, mediaType: true,
              views: true, likes: true, comments: true, shares: true, saves: true,
              postedAt: true, influencerId: true,
              influencer: { select: { username: true, followers: true } },
              campaign: { select: { name: true } },
            },
            orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
          })
        : []
      uniqueMedia = dedupeMediaByPost(allMedia)
      dedupedPosts = allMedia.length - uniqueMedia.length

      for (const m of uniqueMedia) {
        views += m.views || 0
        likes += m.likes || 0
        comments += m.comments || 0
        shares += m.shares || 0
        saves += m.saves || 0
        engagements += engagementsOf(m)
        if (isStoryType(m.mediaType)) stories++
        const pm = perMediaById.get(m.id)
        if (!pm) continue
        emvBasic += pm.emvBasic
        emvExtended += pm.emvExtended
        if (pm.isDeleted) mediaDeleted++
        audienceResults.push({ value: pm.audience, basis: pm.audienceBasis, estimated: pm.audienceEstimated })
        if (!pm.audienceEstimated && pm.audience > 0) engagementsReal += engagementsOf(m)
      }
      cost = Math.round(cost * 100) / 100
      emvBasic = Math.round(emvBasic * 100) / 100
      emvExtended = Math.round(emvExtended * 100) / 100
    } catch (err) {
      console.error('Dashboard campaign numbers failed:', err instanceof Error ? err.message : err)
    }

    const audience = sumAudience(audienceResults)
    // 4A: ER = interacciones of the real-audience publications ÷ real audience
    const er = engagementRateOf(engagementsReal, audience)
    const media = uniqueMedia.length

    // BRAND users never receive fees, cost, CPM or the EMV ratio (decision 9B + portal rule).
    if (isBrand) {
      cost = 0
      membersWithCost = 0
    }
    const emvRatio = isBrand ? null : emvRatioOf(emvExtended, cost)
    // 4A: CPM on REAL audience only
    const cpm = isBrand ? null : cpmOf(cost, audience.real)

    // Campaigns by status
    const campaignsByStatus = { active: 0, paused: 0, archived: 0 }
    for (const c of campaignRows) {
      const key = c.status.toLowerCase() as keyof typeof campaignsByStatus
      if (key in campaignsByStatus) campaignsByStatus[key]++
    }

    // Campaigns by type
    let campaignsByType = { SOCIAL_LISTENING: 0, INFLUENCER_TRACKING: 0, UGC: 0 }
    try {
      const typeGroups = await prisma.campaign.groupBy({
        by: ['type'],
        where: campaignWhere,
        _count: true,
      })
      for (const g of typeGroups) {
        if (g.type in campaignsByType) {
          campaignsByType[g.type as keyof typeof campaignsByType] = g._count
        }
      }
    } catch { /* defaults remain 0 */ }

    // Top 5 influencers by interacciones (likes + comentarios + shares + saves) — from the deduplicated posts
    let topInfluencers: Array<{
      username: string
      platform: string
      followers: number
      engagementRate: number
      avatarUrl: string | null
      totalEngagements: number
      totalLikes: number
      totalComments: number
      totalViews: number
    }> = []
    try {
      const sums = new Map<string, { engagements: number; likes: number; comments: number; views: number }>()
      for (const m of uniqueMedia) {
        const acc = sums.get(m.influencerId) || { engagements: 0, likes: 0, comments: 0, views: 0 }
        acc.engagements += engagementsOf(m)
        acc.likes += m.likes || 0
        acc.comments += m.comments || 0
        acc.views += m.views || 0
        sums.set(m.influencerId, acc)
      }
      const top = Array.from(sums.entries()).sort((a, b) => b[1].engagements - a[1].engagements).slice(0, 5)
      if (top.length > 0) {
        const influencerDetails = await prisma.influencer.findMany({
          where: { id: { in: top.map(([id]) => id) } },
          select: { id: true, username: true, platform: true, followers: true, engagementRate: true, avatarUrl: true },
        })
        const detailsMap = new Map(influencerDetails.map((i) => [i.id, i]))
        topInfluencers = top
          .map(([id, sum]) => {
            const details = detailsMap.get(id)
            if (!details) return null
            return {
              username: details.username,
              platform: details.platform,
              followers: details.followers,
              engagementRate: details.engagementRate,
              avatarUrl: details.avatarUrl,
              totalEngagements: sum.engagements,
              totalLikes: sum.likes,
              totalComments: sum.comments,
              totalViews: sum.views,
            }
          })
          .filter((i): i is NonNullable<typeof i> => i !== null)
      }
    } catch { topInfluencers = [] }

    // Recent activity - last 10 distinct posts
    const recentActivity = [...uniqueMedia]
      .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
      .slice(0, 10)
      .map((m) => ({
        influencerUsername: m.influencer.username,
        platform: m.platform,
        likes: m.likes,
        comments: m.comments,
        views: m.views,
        engagements: engagementsOf(m),
        postedAt: m.postedAt,
        campaignName: m.campaign?.name || '',
        permalink: m.permalink,
      }))

    // Platform breakdown - influencers and DISTINCT posts by platform
    const platformBreakdown: Record<string, { influencers: number; media: number }> = {
      INSTAGRAM: { influencers: 0, media: 0 },
      TIKTOK: { influencers: 0, media: 0 },
      YOUTUBE: { influencers: 0, media: 0 },
    }
    try {
      if (influencerIds.length > 0) {
        const influencersByPlatform = await prisma.influencer.groupBy({
          by: ['platform'],
          where: { id: { in: influencerIds } },
          _count: true,
        })
        for (const g of influencersByPlatform) {
          if (g.platform in platformBreakdown) {
            platformBreakdown[g.platform].influencers = g._count
          }
        }
      }
      for (const m of uniqueMedia) {
        if (m.platform in platformBreakdown) platformBreakdown[m.platform].media++
      }
    } catch { /* defaults remain 0 */ }

    const platformBreakdownArray = Object.entries(platformBreakdown).map(([platform, data]) => ({
      platform,
      influencers: data.influencers,
      media: data.media,
    })).filter(p => p.influencers > 0 || p.media > 0)

    return NextResponse.json({
      definitionsVersion: 2,
      stats: {
        activeCampaigns,
        totalCampaigns,
        totalInfluencers: uniqueInfluencers.length,
        /** Campaigns the numbers below are built on (role-scoped, non-archived). */
        campaignsIncluded: campaignIds.length,

        // Content (distinct posts at agency level)
        media,
        mediaDeleted,
        stories,
        posts: media - stories,
        /** Media rows removed because the same post lives in several campaigns. */
        dedupedPosts,

        // Interacciones (3A) and audiencia (5)
        views,
        likes,
        comments,
        shares,
        saves,
        engagements,
        audience,
        er,

        // Economics (zero / null for BRAND)
        cost,
        membersWithCost,
        emvBasic,
        emvExtended,
        emvRatio,
        cpm,

        // Legacy keys the dashboard page still reads
        totalInvestment: cost,
        totalEMV: { basic: emvBasic, extended: emvExtended },
        // 4A: headline reach is REAL audience; the estimate travels apart
        totalReach: audience.real,
        totalReachEstimated: audience.estimated,
        engagementRate: er.value,
        avgEngagementRate: er.value ?? 0,
        totalMediaPosts: media,
        totalViews: views,
        totalLikes: likes,
        totalComments: comments,
      },
      campaignsByStatus,
      campaignsByType,
      topInfluencers,
      recentActivity,
      platformBreakdown: platformBreakdownArray,
      recentCampaigns,
      pinnedLists,
    })
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
