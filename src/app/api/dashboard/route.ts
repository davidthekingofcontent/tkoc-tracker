import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus } from '@/generated/prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const userId = session.id

    // Active campaigns count
    const activeCampaigns = await prisma.campaign.count({
      where: { userId, status: CampaignStatus.ACTIVE },
    })

    const totalCampaigns = await prisma.campaign.count({
      where: { userId },
    })

    // Total influencers across all campaigns
    const uniqueInfluencers = await prisma.campaignInfluencer.findMany({
      where: { campaign: { userId } },
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
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: {
        _count: { select: { influencers: true, media: true } },
      },
    })

    // Pinned lists
    const pinnedLists = await prisma.list.findMany({
      where: { userId, isPinned: true, isArchived: false },
      include: { _count: { select: { items: true } } },
      take: 5,
    })

    return NextResponse.json({
      stats: {
        activeCampaigns,
        totalCampaigns,
        totalInfluencers: uniqueInfluencers.length,
        totalReach: reachData._sum.followers || 0,
        avgEngagementRate: Math.round((engData._avg.engagementRate || 0) * 10) / 10,
      },
      recentCampaigns,
      pinnedLists,
    })
  } catch (error) {
    console.error('Dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
