import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { calculateEMV, calculateCampaignEMV } from '@/lib/emv'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { campaignId, email, frequency } = body

    if (!campaignId) {
      return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    if (frequency && !['weekly', 'monthly'].includes(frequency)) {
      return NextResponse.json({ error: 'Frequency must be "weekly" or "monthly"' }, { status: 400 })
    }

    // Verify campaign exists and user has access
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        influencers: {
          include: { influencer: true },
        },
        media: {
          orderBy: { postedAt: 'desc' },
          include: {
            influencer: {
              select: {
                username: true,
                displayName: true,
                platform: true,
                followers: true,
                engagementRate: true,
              },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Generate the report immediately
    let totalReach = 0, totalLikes = 0, totalComments = 0, totalShares = 0
    let totalViews = 0, totalSaves = 0, totalImpressions = 0

    for (const m of campaign.media) {
      totalReach += m.reach || 0
      totalLikes += m.likes || 0
      totalComments += m.comments || 0
      totalShares += m.shares || 0
      totalViews += m.views || 0
      totalSaves += m.saves || 0
      totalImpressions += m.impressions || 0
    }

    const totalEngagements = totalLikes + totalComments + totalShares
    const engRate = totalReach > 0 ? (totalEngagements / totalReach) * 100 : 0
    const emv = calculateCampaignEMV(campaign.media.map(m => ({
      platform: m.influencer?.platform || 'INSTAGRAM',
      impressions: m.impressions || 0, reach: m.reach || 0, views: m.views || 0,
      likes: m.likes || 0, comments: m.comments || 0, shares: m.shares || 0, saves: m.saves || 0,
    })))

    const totalCost = campaign.influencers.reduce(
      (sum, ci) => sum + (ci.agreedFee || ci.cost || 0), 0
    )

    // Aggregate per-influencer metrics
    const influencerMetricsMap = new Map<string, {
      totalLikes: number; totalComments: number; totalShares: number; totalSaves: number
      totalViews: number; totalReach: number; totalImpressions: number; totalEMV: number; mediaCount: number
    }>()

    for (const m of campaign.media) {
      const username = m.influencer?.username || 'unknown'
      const existing = influencerMetricsMap.get(username) || {
        totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0,
        totalViews: 0, totalReach: 0, totalImpressions: 0, totalEMV: 0, mediaCount: 0,
      }
      existing.totalLikes += m.likes || 0
      existing.totalComments += m.comments || 0
      existing.totalShares += m.shares || 0
      existing.totalSaves += m.saves || 0
      existing.totalViews += m.views || 0
      existing.totalReach += m.reach || 0
      existing.totalImpressions += m.impressions || 0
      existing.mediaCount++
      const mediaEMV = calculateEMV({
        platform: m.influencer?.platform || 'INSTAGRAM',
        impressions: m.impressions || 0, reach: m.reach || 0, views: m.views || 0,
        clicks: 0, likes: m.likes || 0, comments: m.comments || 0, shares: m.shares || 0, saves: m.saves || 0,
      })
      existing.totalEMV += mediaEMV.extended
      influencerMetricsMap.set(username, existing)
    }

    const report = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        status: campaign.status,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        country: campaign.country,
        platforms: campaign.platforms,
        targetHashtags: campaign.targetHashtags,
        targetAccounts: campaign.targetAccounts,
      },
      overview: {
        totalInfluencers: campaign.influencers.length,
        totalMedia: campaign.media.length,
        totalReach,
        totalImpressions,
        totalEngagements,
        engagementRate: Math.round(engRate * 100) / 100,
        totalLikes,
        totalComments,
        totalShares,
        totalSaves,
        totalViews,
        totalCost,
        emvBasic: Math.round(emv.basic * 100) / 100,
        emvExtended: Math.round(emv.extended * 100) / 100,
      },
      influencers: campaign.influencers.map(ci => {
        const inf = ci.influencer
        const metrics = influencerMetricsMap.get(inf.username) || {
          totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0,
          totalViews: 0, totalReach: 0, totalImpressions: 0, totalEMV: 0, mediaCount: 0,
        }
        return {
          username: inf.username,
          displayName: inf.displayName,
          platform: inf.platform,
          followers: inf.followers,
          status: ci.status,
          agreedFee: ci.agreedFee || 0,
          cost: ci.cost || 0,
          metrics: {
            likes: metrics.totalLikes,
            comments: metrics.totalComments,
            shares: metrics.totalShares,
            saves: metrics.totalSaves,
            views: metrics.totalViews,
            reach: metrics.totalReach,
            impressions: metrics.totalImpressions,
            emv: Math.round(metrics.totalEMV * 100) / 100,
            mediaCount: metrics.mediaCount,
          },
        }
      }),
      generatedAt: new Date().toISOString(),
      scheduledConfig: {
        email: email || null,
        frequency: frequency || null,
        status: 'generated',
        note: 'Scheduled delivery is not yet implemented. Report generated immediately.',
      },
    }

    return NextResponse.json(report)
  } catch (error) {
    console.error('Scheduled report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
