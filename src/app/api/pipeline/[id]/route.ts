import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus } from '@/generated/prisma/client'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params
    const body = await request.json()
    const { status } = body

    if (!status) {
      return NextResponse.json({ error: 'status is required' }, { status: 400 })
    }

    if (!Object.values(InfluencerStatus).includes(status as InfluencerStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
    }

    const existing = await prisma.campaignInfluencer.findUnique({
      where: { id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Campaign influencer not found' }, { status: 404 })
    }

    const updated = await prisma.campaignInfluencer.update({
      where: { id },
      data: { status: status as InfluencerStatus },
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
    })

    return NextResponse.json({ item: updated })
  } catch (error) {
    console.error('Update pipeline status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
