import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus } from '@/generated/prisma/client'
import { calculateCampaignEMV } from '@/lib/emv'

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

    const { searchParams } = new URL(request.url)
    const mediaOffset = parseInt(searchParams.get('mediaOffset') || '0', 10)
    const mediaLimit = parseInt(searchParams.get('mediaLimit') || '50', 10)

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
          skip: mediaOffset,
          take: Math.min(mediaLimit, 100),
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

    // Calculate total cost from agreedFees
    const totalCost = campaign.influencers.reduce(
      (sum, ci) => sum + (ci.agreedFee || 0),
      0
    )

    const overview = {
      totalReach,
      totalImpressions: metrics._sum.impressions || 0,
      totalEngagements,
      engagementRate: Math.round(engagementRate * 100) / 100,
      mediaValue: metrics._sum.mediaValue || 0,
      totalViews: metrics._sum.views || 0,
      profilesPosted: profilesPosted.length,
      totalMedia: metrics._count,
      totalCost,
      mediaCounts: mediaCounts.reduce(
        (acc, item) => ({ ...acc, [item.mediaType]: item._count }),
        {} as Record<string, number>
      ),
    }

    // Timeline data for growth charts — group media by date
    const timelineMedia = await prisma.media.findMany({
      where: { campaignId: id, postedAt: { not: null } },
      select: {
        postedAt: true,
        likes: true,
        comments: true,
        shares: true,
        views: true,
        reach: true,
        mediaType: true,
      },
      orderBy: { postedAt: 'asc' },
    })

    // Aggregate by day
    const timelineMap = new Map<string, {
      date: string
      posts: number
      likes: number
      comments: number
      views: number
      reach: number
      engagements: number
    }>()

    for (const m of timelineMedia) {
      if (!m.postedAt) continue
      const dateKey = m.postedAt.toISOString().split('T')[0]
      const existing = timelineMap.get(dateKey) || {
        date: dateKey,
        posts: 0,
        likes: 0,
        comments: 0,
        views: 0,
        reach: 0,
        engagements: 0,
      }
      existing.posts++
      existing.likes += m.likes || 0
      existing.comments += m.comments || 0
      existing.views += m.views || 0
      existing.reach += m.reach || 0
      existing.engagements += (m.likes || 0) + (m.comments || 0) + (m.shares || 0)
      timelineMap.set(dateKey, existing)
    }

    const timeline = Array.from(timelineMap.values())

    // Calculate EMV using the proper TKOC formula
    const allMediaForEMV = await prisma.media.findMany({
      where: { campaignId: id },
      select: {
        likes: true, comments: true, shares: true, saves: true,
        views: true, reach: true, impressions: true,
        influencer: { select: { platform: true } },
      },
    })

    const emv = calculateCampaignEMV(
      allMediaForEMV.map(m => ({
        platform: m.influencer?.platform || 'INSTAGRAM',
        impressions: m.impressions || 0,
        reach: m.reach || 0,
        views: m.views || 0,
        likes: m.likes || 0,
        comments: m.comments || 0,
        shares: m.shares || 0,
        saves: m.saves || 0,
      }))
    )

    return NextResponse.json({ campaign, overview: { ...overview, emvBasic: emv.basic, emvExtended: emv.extended }, timeline })
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

    const { name, status, budget, isPinned, startDate, endDate, platforms, targetAccounts, targetHashtags, targetKeywords, country, paymentType, briefText, briefFiles } = body

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(status !== undefined && Object.values(CampaignStatus).includes(status) && { status }),
        ...(budget !== undefined && { budget }),
        ...(isPinned !== undefined && { isPinned }),
        ...(startDate !== undefined && startDate && { startDate: new Date(startDate) }),
        ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : undefined }),
        ...(platforms !== undefined && { platforms }),
        ...(targetAccounts !== undefined && { targetAccounts }),
        ...(targetHashtags !== undefined && { targetHashtags }),
        ...(targetKeywords !== undefined && { targetKeywords }),
        ...(country !== undefined && { country: country || null }),
        ...(paymentType !== undefined && ['PAID', 'GIFTED'].includes(paymentType) && { paymentType }),
        ...(briefText !== undefined && { briefText: briefText || null }),
        ...(briefFiles !== undefined && { briefFiles }),
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
