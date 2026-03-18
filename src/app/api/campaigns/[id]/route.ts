import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus } from '@/generated/prisma/client'

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

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        influencers: {
          include: {
            influencer: true,
          },
        },
        media: {
          orderBy: { postedAt: 'desc' },
          take: 20,
          include: {
            influencer: {
              select: { id: true, username: true, displayName: true, avatarUrl: true, platform: true },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // BRAND users can only view their own campaigns
    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Aggregate metrics from media
    const metrics = await prisma.media.aggregate({
      where: { campaignId: id },
      _sum: {
        reach: true,
        impressions: true,
        likes: true,
        comments: true,
        shares: true,
        saves: true,
        views: true,
        mediaValue: true,
      },
      _count: true,
    })

    const totalEngagements =
      (metrics._sum.likes || 0) +
      (metrics._sum.comments || 0) +
      (metrics._sum.shares || 0) +
      (metrics._sum.saves || 0)

    const totalReach = metrics._sum.reach || 0
    const engagementRate = totalReach > 0 ? (totalEngagements / totalReach) * 100 : 0

    // Count distinct influencers who posted
    const profilesPosted = await prisma.media.findMany({
      where: { campaignId: id },
      select: { influencerId: true },
      distinct: ['influencerId'],
    })

    // Media counts by type
    const mediaCounts = await prisma.media.groupBy({
      by: ['mediaType'],
      where: { campaignId: id },
      _count: true,
    })

    const overview = {
      totalReach,
      totalImpressions: metrics._sum.impressions || 0,
      totalEngagements,
      engagementRate: Math.round(engagementRate * 100) / 100,
      mediaValue: metrics._sum.mediaValue || 0,
      totalViews: metrics._sum.views || 0,
      profilesPosted: profilesPosted.length,
      totalMedia: metrics._count,
      mediaCounts: mediaCounts.reduce(
        (acc, item) => ({ ...acc, [item.mediaType]: item._count }),
        {} as Record<string, number>
      ),
    }

    return NextResponse.json({ campaign, overview })
  } catch (error) {
    console.error('Get campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()

    const existing = await prisma.campaign.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const { name, status, budget, isPinned, startDate, endDate, platforms, targetAccounts, targetHashtags, targetKeywords } = body

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(status !== undefined && Object.values(CampaignStatus).includes(status) && { status }),
        ...(budget !== undefined && { budget }),
        ...(isPinned !== undefined && { isPinned }),
        ...(startDate !== undefined && { startDate: new Date(startDate) }),
        ...(endDate !== undefined && { endDate: new Date(endDate) }),
        ...(platforms !== undefined && { platforms }),
        ...(targetAccounts !== undefined && { targetAccounts }),
        ...(targetHashtags !== undefined && { targetHashtags }),
        ...(targetKeywords !== undefined && { targetKeywords }),
      },
      include: {
        _count: { select: { influencers: true, media: true } },
      },
    })

    return NextResponse.json({ campaign })
  } catch (error) {
    console.error('Update campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    const existing = await prisma.campaign.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Soft delete by archiving
    await prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.ARCHIVED },
    })

    return NextResponse.json({ message: 'Campaign archived' })
  } catch (error) {
    console.error('Delete campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
