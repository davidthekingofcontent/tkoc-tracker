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
    const confidenceLevel = searchParams.get('confidenceLevel')
    const matchStatus = searchParams.get('matchStatus')
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10)))
    const skip = (page - 1) * limit

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { userId: session.id }

    if (confidenceLevel) {
      where.confidenceLevel = confidenceLevel
    }

    if (matchStatus) {
      where.matchStatus = matchStatus
    }

    const creatorProfileId = searchParams.get('creatorProfileId')
    if (creatorProfileId) {
      where.creatorProfileId = creatorProfileId
    }

    const [matches, total] = await Promise.all([
      prisma.clientCreatorMatch.findMany({
        where,
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
                  avatarUrl: true,
                  isVerified: true,
                },
              },
            },
          },
          warmScore: true,
        },
        orderBy: { confidenceScore: 'desc' },
        skip,
        take: limit,
      }),
      prisma.clientCreatorMatch.count({ where }),
    ])

    return NextResponse.json({
      matches,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('List matches error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
