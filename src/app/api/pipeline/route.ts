import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const campaignId = searchParams.get('campaignId')

    const where = campaignId ? { campaignId } : {}

    const items = await prisma.campaignInfluencer.findMany({
      where,
      include: {
        influencer: {
          select: {
            username: true,
            displayName: true,
            avatarUrl: true,
            platform: true,
            followers: true,
            engagementRate: true,
            avgViews: true,
          },
        },
        campaign: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ items })
  } catch (error) {
    console.error('List pipeline items error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
