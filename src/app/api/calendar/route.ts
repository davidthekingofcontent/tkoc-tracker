import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Prisma } from '@/generated/prisma/client'

function getColorForType(type: string): string {
  switch (type) {
    case 'SOCIAL_LISTENING':
      return '#3b82f6' // blue-500
    case 'INFLUENCER_TRACKING':
      return '#a855f7' // purple-500
    case 'UGC':
      return '#f59e0b' // amber-500
    default:
      return '#6b7280' // gray-500
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const where: Prisma.CampaignWhereInput = {}

    // Role-based filtering (same as campaigns route)
    if (session.role === 'EMPLOYEE') {
      where.OR = [
        { userId: session.id },
        { assignments: { some: { userId: session.id } } },
      ]
    } else if (session.role === 'BRAND') {
      where.userId = session.id
    }

    // Only include campaigns with dates set
    where.startDate = { not: undefined }

    const campaigns = await prisma.campaign.findMany({
      where,
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        type: true,
        status: true,
        _count: {
          select: {
            influencers: true,
          },
        },
      },
      orderBy: {
        startDate: 'asc',
      },
    })

    const events = campaigns.map((campaign) => ({
      id: campaign.id,
      title: campaign.name,
      start: campaign.startDate.toISOString(),
      end: campaign.endDate
        ? campaign.endDate.toISOString()
        : campaign.startDate.toISOString(),
      type: campaign.type,
      status: campaign.status,
      color: getColorForType(campaign.type),
      influencerCount: campaign._count.influencers,
    }))

    return NextResponse.json({ events })
  } catch (error) {
    console.error('Calendar API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 }
    )
  }
}
