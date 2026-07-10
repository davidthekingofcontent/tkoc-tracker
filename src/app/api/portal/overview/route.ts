import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import {
  resolveBrandScope,
  resolveBrandScopeForBrandId,
} from '@/lib/brand-scope'

// GET /api/portal/overview
// Brand-scoped, read-only overview: the brand's campaigns with public counts
// and engagement sums. NO fees, NO budget, NO costs — ever.
// ADMIN may pass ?brandId= to preview the portal as a given brand.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'BRAND' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const brandIdParam = searchParams.get('brandId')

    const scope =
      session.role === 'ADMIN' && brandIdParam
        ? await resolveBrandScopeForBrandId(brandIdParam)
        : await resolveBrandScope(session.id)

    if (scope.campaignIds.length === 0) {
      return NextResponse.json({
        brandName: scope.brandName,
        brandLogo: scope.brandLogo,
        campaigns: [],
      })
    }

    const [campaigns, mediaSums] = await Promise.all([
      prisma.campaign.findMany({
        where: { id: { in: scope.campaignIds } },
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          platforms: true,
          createdAt: true,
          _count: { select: { influencers: true, media: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.media.groupBy({
        by: ['campaignId'],
        where: { campaignId: { in: scope.campaignIds } },
        _sum: { likes: true, comments: true, views: true },
      }),
    ])

    const sumsByCampaign = new Map(mediaSums.map((m) => [m.campaignId, m._sum]))

    return NextResponse.json({
      brandName: scope.brandName,
      brandLogo: scope.brandLogo,
      campaigns: campaigns.map((c) => {
        const sums = sumsByCampaign.get(c.id)
        const likes = sums?.likes || 0
        const comments = sums?.comments || 0
        const views = sums?.views || 0
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          startDate: c.startDate,
          endDate: c.endDate,
          platforms: c.platforms,
          counts: {
            influencers: c._count.influencers,
            media: c._count.media,
          },
          metrics: {
            likes,
            comments,
            views,
            interactions: likes + comments + views,
          },
        }
      }),
    })
  } catch (error) {
    console.error('Portal overview error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
