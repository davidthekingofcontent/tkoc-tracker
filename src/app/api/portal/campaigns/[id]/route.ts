import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { resolveBrandScope, sanitizeCampaignForBrand } from '@/lib/brand-scope'

// GET /api/portal/campaigns/[id]
// Brand-facing, read-only campaign detail. Response shape is compatible with
// what the campaign report page expects from GET /api/campaigns/[id]:
//   { campaign: { ..., influencers: [{ influencer, status }], media: [...] }, overview }
// but with ALL confidential fields stripped (agreedFee, cost, commission,
// notes, budget, ROI, shipping*). Media keeps the `source` field so the
// report can badge Meta vs public data.
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

    const campaign = await prisma.campaign.findUnique({
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
        influencers: {
          select: {
            id: true,
            status: true,
            contentDelivered: true,
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
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Overview aggregates — public metrics only (no cost, no mediaValue).
    const [metrics, profilesPosted, mediaCounts] = await Promise.all([
      prisma.media.aggregate({
        where: { campaignId: id },
        _sum: {
          reach: true,
          impressions: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
          views: true,
        },
        _count: true,
      }),
      prisma.media.findMany({
        where: { campaignId: id },
        select: { influencerId: true },
        distinct: ['influencerId'],
      }),
      prisma.media.groupBy({
        by: ['mediaType'],
        where: { campaignId: id },
        _count: true,
      }),
    ])

    const totalLikes = metrics._sum.likes || 0
    const totalComments = metrics._sum.comments || 0
    const totalReach = metrics._sum.reach || 0
    const totalViews = metrics._sum.views || 0
    const totalImpressions = metrics._sum.impressions || 0
    const totalEngagements =
      totalLikes +
      totalComments +
      (metrics._sum.shares || 0) +
      (metrics._sum.saves || 0)

    const engagementDenominator =
      totalReach > 0 ? totalReach : totalViews > 0 ? totalViews : 0
    const engagementRate =
      engagementDenominator > 0
        ? ((totalLikes + totalComments) / engagementDenominator) * 100
        : 0

    const overview = {
      totalMedia: metrics._count,
      totalLikes,
      totalComments,
      totalViews,
      totalReach: totalReach > 0 ? totalReach : totalViews,
      totalImpressions: totalImpressions > 0 ? totalImpressions : null,
      totalEngagements,
      engagementRate: Math.round(engagementRate * 100) / 100,
      profilesPosted: profilesPosted.length,
      mediaCounts: mediaCounts.reduce(
        (acc, item) => ({ ...acc, [item.mediaType]: item._count }),
        {} as Record<string, number>
      ),
    }

    // Defense in depth: the selects above are already narrow, but strip any
    // confidential key that might sneak in if a select widens later.
    return NextResponse.json(sanitizeCampaignForBrand({ campaign, overview }))
  } catch (error) {
    console.error('Portal campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
