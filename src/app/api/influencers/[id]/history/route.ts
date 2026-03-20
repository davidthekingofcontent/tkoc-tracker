import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus } from '@/generated/prisma/client'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    // Fetch the influencer with their engagement rate
    const influencer = await prisma.influencer.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        platform: true,
        engagementRate: true,
        followers: true,
      },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Fetch all campaign participations with campaign details
    const campaignInfluencers = await prisma.campaignInfluencer.findMany({
      where: { influencerId: id },
      include: {
        campaign: {
          select: {
            id: true,
            name: true,
            type: true,
            startDate: true,
            endDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Fetch media value per campaign for this influencer
    const mediaBycamp = await prisma.media.groupBy({
      by: ['campaignId'],
      where: {
        influencerId: id,
        campaignId: { not: null },
      },
      _sum: {
        mediaValue: true,
      },
    })

    const mediaValueMap = new Map<string, number>()
    for (const entry of mediaBycamp) {
      if (entry.campaignId) {
        mediaValueMap.set(entry.campaignId, entry._sum.mediaValue ?? 0)
      }
    }

    // Build price history
    const priceHistory = campaignInfluencers.map((ci) => ({
      campaignId: ci.campaign.id,
      campaignName: ci.campaign.name,
      campaignType: ci.campaign.type,
      agreedFee: ci.agreedFee,
      cost: ci.cost,
      status: ci.status,
      startDate: ci.campaign.startDate,
      endDate: ci.campaign.endDate,
      mediaValue: mediaValueMap.get(ci.campaign.id) ?? 0,
    }))

    // --- Scoring ---

    const totalCampaigns = campaignInfluencers.length

    // Engagement score (0-100): normalize engagement rate
    // Typical good ER is 3-6%, exceptional is 10%+
    const engagementScore = Math.min(100, (influencer.engagementRate / 6) * 100)

    // Delivery reliability: % of campaigns reaching POSTED or COMPLETED
    const deliveredStatuses: InfluencerStatus[] = [
      InfluencerStatus.POSTED,
      InfluencerStatus.COMPLETED,
    ]
    const deliveredCount = campaignInfluencers.filter((ci) =>
      deliveredStatuses.includes(ci.status)
    ).length
    const reliabilityScore =
      totalCampaigns > 0 ? (deliveredCount / totalCampaigns) * 100 : 0

    // ROI: total EMV vs total cost
    const totalMediaValue = Array.from(mediaValueMap.values()).reduce(
      (sum, v) => sum + v,
      0
    )
    const totalCost = campaignInfluencers.reduce(
      (sum, ci) => sum + (ci.cost ?? ci.agreedFee ?? 0),
      0
    )
    // ROI score: 1x return = 50, 2x = 75, 4x+ = 100, 0 cost = 100 if there's media value
    let roiScore: number
    if (totalCost === 0) {
      roiScore = totalMediaValue > 0 ? 100 : 0
    } else {
      const roiRatio = totalMediaValue / totalCost
      roiScore = Math.min(100, roiRatio * 25) // 4x ROI = 100
    }

    // Consistency: based on number of campaigns
    // 1 campaign = 20, 5+ = 100
    const consistencyScore = Math.min(100, (totalCampaigns / 5) * 100)

    // Weighted total
    const totalScore = Math.round(
      engagementScore * 0.3 +
        reliabilityScore * 0.3 +
        roiScore * 0.2 +
        consistencyScore * 0.2
    )

    const score = {
      total: Math.min(100, Math.max(0, totalScore)),
      engagement: Math.round(engagementScore),
      reliability: Math.round(reliabilityScore),
      roi: Math.round(roiScore),
      consistency: Math.round(consistencyScore),
    }

    return NextResponse.json({
      influencerId: influencer.id,
      username: influencer.username,
      platform: influencer.platform,
      totalCampaigns,
      priceHistory,
      score,
    })
  } catch (error) {
    console.error('Error fetching influencer history:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
