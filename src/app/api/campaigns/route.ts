import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus, CampaignType, Prisma } from '@/generated/prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const type = searchParams.get('type')
    const pinned = searchParams.get('pinned')
    const search = searchParams.get('search')

    const where: Prisma.CampaignWhereInput = {}

    // ADMIN sees all campaigns
    // EMPLOYEE sees campaigns they created OR are assigned to
    // BRAND sees only campaigns they created
    if (session.role === 'EMPLOYEE') {
      where.OR = [
        { userId: session.id },
        { assignments: { some: { userId: session.id } } },
      ]
    } else if (session.role === 'BRAND') {
      where.userId = session.id
    }

    if (status && Object.values(CampaignStatus).includes(status as CampaignStatus)) {
      where.status = status as CampaignStatus
    } else {
      // By default exclude archived
      where.status = { not: CampaignStatus.ARCHIVED }
    }

    if (type && Object.values(CampaignType).includes(type as CampaignType)) {
      where.type = type as CampaignType
    }

    if (pinned === 'true') {
      where.isPinned = true
    }

    if (search) {
      where.name = { contains: search, mode: 'insensitive' }
    }

    const campaigns = await prisma.campaign.findMany({
      where,
      include: {
        _count: {
          select: {
            influencers: true,
            media: true,
          },
        },
        user: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
    })

    return NextResponse.json({ campaigns })
  } catch (error) {
    console.error('List campaigns error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json(
        { error: 'Only employees and admins can create campaigns' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { name, type, platforms, targetAccounts, targetHashtags, targetKeywords, startDate, endDate, country } = body

    if (!name) {
      return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
    }

    const campaign = await prisma.campaign.create({
      data: {
        name,
        type: type && Object.values(CampaignType).includes(type) ? type : CampaignType.INFLUENCER_TRACKING,
        platforms: platforms || [],
        targetAccounts: targetAccounts || [],
        targetHashtags: targetHashtags || [],
        targetKeywords: targetKeywords || [],
        ...(startDate && { startDate: new Date(startDate) }),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(country && { country }),
        userId: session.id,
        // Auto-assign creator
        assignments: {
          create: { userId: session.id },
        },
      },
      include: {
        _count: {
          select: { influencers: true, media: true },
        },
      },
    })

    return NextResponse.json({ campaign }, { status: 201 })
  } catch (error) {
    console.error('Create campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
