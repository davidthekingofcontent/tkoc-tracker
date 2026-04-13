import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

const VALID_STATUSES = ['USER_CONFIRMED', 'USER_REJECTED'] as const

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
    const { matchStatus } = body

    if (!matchStatus || !VALID_STATUSES.includes(matchStatus)) {
      return NextResponse.json(
        { error: `matchStatus must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    // Verify the match belongs to this user
    const existing = await prisma.clientCreatorMatch.findFirst({
      where: { id, userId: session.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 })
    }

    const match = await prisma.clientCreatorMatch.update({
      where: { id },
      data: {
        matchStatus,
        reviewedBy: session.id,
        reviewedAt: new Date(),
      },
      include: {
        clientContact: true,
        creatorProfile: {
          include: {
            platformProfiles: {
              select: {
                id: true,
                platform: true,
                username: true,
                followers: true,
                engagementRate: true,
              },
            },
          },
        },
      },
    })

    return NextResponse.json({ match })
  } catch (error) {
    console.error('Update match status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
