import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Get active campaigns' aggregate metrics
    const campaigns = await prisma.campaign.findMany({
      where: { status: 'ACTIVE' },
      include: {
        media: {
          select: {
            likes: true,
            comments: true,
            views: true,
            reach: true,
            engagementRate: true,
          },
        },
        _count: {
          select: { influencers: true, media: true },
        },
      },
    })

    let brandTotalReach = 0
    let brandTotalLikes = 0
    let brandTotalComments = 0
    let brandTotalViews = 0
    let brandTotalPosts = 0
    let brandEngSum = 0

    for (const campaign of campaigns) {
      for (const m of campaign.media) {
        brandTotalReach += m.reach
        brandTotalLikes += m.likes
        brandTotalComments += m.comments
        brandTotalViews += m.views
        brandEngSum += m.engagementRate
        brandTotalPosts++
      }
    }

    const brandAvgEngagement = brandTotalPosts > 0 ? brandEngSum / brandTotalPosts : 0
    const brandAvgLikes = brandTotalPosts > 0 ? Math.round(brandTotalLikes / brandTotalPosts) : 0
    const brandAvgComments = brandTotalPosts > 0 ? Math.round(brandTotalComments / brandTotalPosts) : 0

    const brandMetrics = {
      name: 'Your Brand',
      totalReach: brandTotalReach,
      totalPosts: brandTotalPosts,
      avgEngagement: parseFloat(brandAvgEngagement.toFixed(2)),
      avgLikes: brandAvgLikes,
      avgComments: brandAvgComments,
      totalViews: brandTotalViews,
      activeCampaigns: campaigns.length,
    }

    // Get competitors' aggregate metrics
    const competitors = await prisma.competitorAccount.findMany({
      include: {
        _count: { select: { posts: true } },
      },
    })

    const competitorMetrics = competitors.map((c) => ({
      id: c.id,
      name: c.displayName || c.username,
      username: c.username,
      platform: c.platform,
      avatarUrl: c.avatarUrl,
      followers: c.followers,
      engagementRate: c.engagementRate,
      avgLikes: c.avgLikes,
      avgComments: c.avgComments,
      avgViews: c.avgViews,
      postsCount: c.postsCount,
      totalPosts: c._count.posts,
      lastScraped: c.lastScraped,
    }))

    return NextResponse.json({
      brand: brandMetrics,
      competitors: competitorMetrics,
    })
  } catch (error) {
    console.error('Error comparing competitors:', error)
    return NextResponse.json({ error: 'Failed to compare' }, { status: 500 })
  }
}
