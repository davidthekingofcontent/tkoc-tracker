import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus } from '@/generated/prisma/client'
import { calculateCampaignEMV } from '@/lib/emv'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // ADMIN sees all campaigns
    // EMPLOYEE sees own + assigned campaigns
    // BRAND sees only own campaigns
    let campaignWhere: Record<string, unknown> = {}
    if (session.role === 'EMPLOYEE') {
      campaignWhere = { OR: [{ userId: session.id }, { assignments: { some: { userId: session.id } } }] }
    } else if (session.role === 'BRAND') {
      campaignWhere = { userId: session.id }
    }

    // Active campaigns count
    const activeCampaigns = await prisma.campaign.count({
      where: { ...campaignWhere, status: CampaignStatus.ACTIVE },
    })

    const totalCampaigns = await prisma.campaign.count({
      where: campaignWhere,
    })

    // Total influencers across all campaigns
    const uniqueInfluencers = await prisma.campaignInfluencer.findMany({
      where: { campaign: campaignWhere },
      select: { influencerId: true },
      distinct: ['influencerId'],
    })

    // Total reach (sum of followers of all unique influencers)
    const influencerIds = uniqueInfluencers.map((ci) => ci.influencerId)
    const reachData = await prisma.influencer.aggregate({
      where: { id: { in: influencerIds } },
      _sum: { followers: true },
    })

    // Average engagement rate
    const engData = await prisma.influencer.aggregate({
      where: { id: { in: influencerIds } },
      _avg: { engagementRate: true },
    })

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

    // --- NEW: Extended dashboard data ---

    // 1. Total investment (sum of agreedFee from active campaign influencers)
    let totalInvestment = 0
    try {
      const investmentData = await prisma.campaignInfluencer.aggregate({
        where: {
          campaign: { ...campaignWhere, status: CampaignStatus.ACTIVE },
        },
        _sum: { agreedFee: true },
      })
      totalInvestment = investmentData._sum.agreedFee || 0
    } catch { totalInvestment = 0 }

    // 2. Total EMV - calculated from real media data
    let totalEMV = { basic: 0, extended: 0 }
    try {
      const allMedia = await prisma.media.findMany({
        where: { campaign: campaignWhere },
        select: {
          platform: true,
          impressions: true,
          reach: true,
          views: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
        },
      })
      totalEMV = calculateCampaignEMV(allMedia)
    } catch { totalEMV = { basic: 0, extended: 0 } }

    // 3-6. Media aggregates (totalMediaPosts, totalViews, totalLikes, totalComments)
    let totalMediaPosts = 0
    let totalViews = 0
    let totalLikes = 0
    let totalComments = 0
    try {
      const [mediaCount, mediaAgg] = await Promise.all([
        prisma.media.count({
          where: { campaign: campaignWhere },
        }),
        prisma.media.aggregate({
          where: { campaign: campaignWhere },
          _sum: { views: true, likes: true, comments: true },
        }),
      ])
      totalMediaPosts = mediaCount
      totalViews = mediaAgg._sum.views || 0
      totalLikes = mediaAgg._sum.likes || 0
      totalComments = mediaAgg._sum.comments || 0
    } catch { /* defaults remain 0 */ }

    // 7. Campaigns by status
    let campaignsByStatus = { active: 0, paused: 0, archived: 0 }
    try {
      const statusGroups = await prisma.campaign.groupBy({
        by: ['status'],
        where: campaignWhere,
        _count: true,
      })
      for (const g of statusGroups) {
        const key = g.status.toLowerCase() as keyof typeof campaignsByStatus
        if (key in campaignsByStatus) {
          campaignsByStatus[key] = g._count
        }
      }
    } catch { /* defaults remain 0 */ }

    // 8. Campaigns by type
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

    // 9. Top 5 influencers by total engagement
    let topInfluencers: Array<{
      username: string
      platform: string
      followers: number
      engagementRate: number
      avatarUrl: string | null
      totalLikes: number
      totalComments: number
      totalViews: number
    }> = []
    try {
      // Get campaign IDs the user has access to
      const userCampaignIds = await prisma.campaign.findMany({
        where: campaignWhere,
        select: { id: true },
      })
      const campaignIds = userCampaignIds.map((c) => c.id)

      if (campaignIds.length > 0) {
        // Aggregate media by influencer for these campaigns
        const mediaByInfluencer = await prisma.media.groupBy({
          by: ['influencerId'],
          where: { campaignId: { in: campaignIds } },
          _sum: { likes: true, comments: true, views: true },
          orderBy: {
            _sum: { likes: 'desc' },
          },
          take: 5,
        })

        if (mediaByInfluencer.length > 0) {
          const topInfluencerIds = mediaByInfluencer.map((m) => m.influencerId)
          const influencerDetails = await prisma.influencer.findMany({
            where: { id: { in: topInfluencerIds } },
            select: {
              id: true,
              username: true,
              platform: true,
              followers: true,
              engagementRate: true,
              avatarUrl: true,
            },
          })

          const detailsMap = new Map(influencerDetails.map((i) => [i.id, i]))

          topInfluencers = mediaByInfluencer
            .map((m) => {
              const details = detailsMap.get(m.influencerId)
              if (!details) return null
              return {
                username: details.username,
                platform: details.platform,
                followers: details.followers,
                engagementRate: details.engagementRate,
                avatarUrl: details.avatarUrl,
                totalLikes: m._sum.likes || 0,
                totalComments: m._sum.comments || 0,
                totalViews: m._sum.views || 0,
              }
            })
            .filter((i): i is NonNullable<typeof i> => i !== null)
        }
      }
    } catch { topInfluencers = [] }

    // 10. Recent activity - last 10 media posts
    let recentActivity: Array<{
      username: string
      platform: string
      likes: number
      comments: number
      views: number
      postedAt: Date | null
      campaignName: string | null
      permalink: string | null
    }> = []
    try {
      const recentMedia = await prisma.media.findMany({
        where: { campaign: campaignWhere },
        orderBy: { postedAt: 'desc' },
        take: 10,
        select: {
          platform: true,
          likes: true,
          comments: true,
          views: true,
          postedAt: true,
          permalink: true,
          influencer: { select: { username: true } },
          campaign: { select: { name: true } },
        },
      })

      recentActivity = recentMedia.map((m) => ({
        username: m.influencer.username,
        platform: m.platform,
        likes: m.likes,
        comments: m.comments,
        views: m.views,
        postedAt: m.postedAt,
        campaignName: m.campaign?.name || null,
        permalink: m.permalink,
      }))
    } catch { recentActivity = [] }

    // 11. Platform breakdown - influencers and media count by platform
    let platformBreakdown: Record<string, { influencers: number; media: number }> = {
      INSTAGRAM: { influencers: 0, media: 0 },
      TIKTOK: { influencers: 0, media: 0 },
      YOUTUBE: { influencers: 0, media: 0 },
    }
    try {
      const [influencersByPlatform, mediaByPlatform] = await Promise.all([
        prisma.influencer.groupBy({
          by: ['platform'],
          where: { id: { in: influencerIds } },
          _count: true,
        }),
        prisma.media.groupBy({
          by: ['platform'],
          where: { campaign: campaignWhere },
          _count: true,
        }),
      ])

      for (const g of influencersByPlatform) {
        if (g.platform in platformBreakdown) {
          platformBreakdown[g.platform].influencers = g._count
        }
      }
      for (const g of mediaByPlatform) {
        if (g.platform in platformBreakdown) {
          platformBreakdown[g.platform].media = g._count
        }
      }
    } catch { /* defaults remain 0 */ }

    // Transform platformBreakdown from object to array for frontend
    const platformBreakdownArray = Object.entries(platformBreakdown).map(([platform, data]) => ({
      platform,
      influencers: data.influencers,
      media: data.media,
    })).filter(p => p.influencers > 0 || p.media > 0)

    // Transform recentActivity to match frontend expected field names
    const recentActivityFormatted = recentActivity.map(a => ({
      influencerUsername: a.username,
      platform: a.platform,
      likes: a.likes,
      comments: a.comments,
      views: a.views,
      postedAt: a.postedAt,
      campaignName: a.campaignName || '',
      permalink: a.permalink,
    }))

    return NextResponse.json({
      stats: {
        activeCampaigns,
        totalCampaigns,
        totalInfluencers: uniqueInfluencers.length,
        totalReach: reachData._sum.followers || 0,
        avgEngagementRate: Math.round((engData._avg.engagementRate || 0) * 10) / 10,
        totalInvestment,
        totalEMV,
        totalMediaPosts,
        totalViews,
        totalLikes,
        totalComments,
      },
      campaignsByStatus,
      campaignsByType,
      topInfluencers,
      recentActivity: recentActivityFormatted,
      platformBreakdown: platformBreakdownArray,
      recentCampaigns,
      pinnedLists,
    })
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
