import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

function getInfluencerTier(followers: number): string {
  if (followers >= 1_000_000) return 'mega'
  if (followers >= 500_000) return 'macro'
  if (followers >= 100_000) return 'mid'
  if (followers >= 10_000) return 'micro'
  return 'nano'
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const ids = searchParams.get('ids')?.split(',').filter(Boolean) || []

    if (ids.length < 2 || ids.length > 3) {
      return NextResponse.json(
        { error: 'Please provide 2 or 3 campaign IDs' },
        { status: 400 }
      )
    }

    // Fetch all campaigns with their influencers and media
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: ids } },
      include: {
        influencers: {
          include: {
            influencer: {
              select: { id: true, followers: true },
            },
          },
        },
        media: {
          select: {
            platform: true,
            likes: true,
            comments: true,
            shares: true,
            saves: true,
            views: true,
            reach: true,
            impressions: true,
            mediaValue: true,
          },
        },
      },
    })

    if (campaigns.length !== ids.length) {
      const foundIds = campaigns.map((c) => c.id)
      const missing = ids.filter((id) => !foundIds.includes(id))
      return NextResponse.json(
        { error: `Campaigns not found: ${missing.join(', ')}` },
        { status: 404 }
      )
    }

    // BRAND users can only compare their own campaigns
    if (session.role === 'BRAND') {
      const forbidden = campaigns.filter((c) => c.userId !== session.id)
      if (forbidden.length > 0) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // Build comparison data for each campaign, preserving the requested order
    const comparisons = ids.map((id) => {
      const campaign = campaigns.find((c) => c.id === id)!

      const influencerCount = campaign.influencers.length
      const mediaCount = campaign.media.length

      const totalReach = campaign.media.reduce((sum, m) => sum + m.reach, 0)
      const totalImpressions = campaign.media.reduce((sum, m) => sum + m.impressions, 0)
      const totalEngagements = campaign.media.reduce(
        (sum, m) => sum + m.likes + m.comments + m.shares + m.saves,
        0
      )
      const engagementRate = totalReach > 0
        ? Math.round((totalEngagements / totalReach) * 100 * 100) / 100
        : 0
      const totalViews = campaign.media.reduce((sum, m) => sum + m.views, 0)

      const totalCost = campaign.influencers.reduce(
        (sum, ci) => sum + (ci.agreedFee || 0),
        0
      )

      const emvExtended = campaign.media.reduce((sum, m) => sum + m.mediaValue, 0)

      const roi = totalCost > 0
        ? Math.round((emvExtended / totalCost) * 100) / 100
        : null

      // Platform breakdown: count media by platform
      const platformBreakdown: Record<string, number> = {}
      for (const m of campaign.media) {
        platformBreakdown[m.platform] = (platformBreakdown[m.platform] || 0) + 1
      }

      // Tier breakdown: count influencers by follower tier
      const tierBreakdown: Record<string, number> = {
        nano: 0,
        micro: 0,
        mid: 0,
        macro: 0,
        mega: 0,
      }
      for (const ci of campaign.influencers) {
        const tier = getInfluencerTier(ci.influencer.followers)
        tierBreakdown[tier]++
      }

      return {
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        status: campaign.status,
        paymentType: campaign.paymentType,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        country: campaign.country,
        influencerCount,
        mediaCount,
        totalReach,
        totalImpressions,
        totalEngagements,
        engagementRate,
        totalViews,
        totalCost,
        emvExtended,
        roi,
        platformBreakdown,
        tierBreakdown,
      }
    })

    return NextResponse.json({ campaigns: comparisons })
  } catch (error) {
    console.error('Compare campaigns error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
