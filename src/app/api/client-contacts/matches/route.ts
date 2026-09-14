import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { MatchConfidenceLevel, MatchStatus } from '@/generated/prisma/client'

// ---- Query validation: a bad value answers 400 instead of a Prisma 500 ----

function parseEnumParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  name: string
): { value: T | null } | { error: string } {
  if (!value) return { value: null }
  if ((allowed as readonly string[]).includes(value)) return { value: value as T }
  return { error: `Invalid ${name}. Use one of: ${allowed.join(', ')}` }
}

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  name: string
): { value: number } | { error: string } {
  if (value === null || value === '') return { value: fallback }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return { error: `Invalid ${name}: must be an integer between ${min} and ${max}` }
  }
  return { value: n }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const levelParam = parseEnumParam(searchParams.get('confidenceLevel'), Object.values(MatchConfidenceLevel), 'confidenceLevel')
    if ('error' in levelParam) return NextResponse.json({ error: levelParam.error }, { status: 400 })
    const statusParam = parseEnumParam(searchParams.get('matchStatus'), Object.values(MatchStatus), 'matchStatus')
    if ('error' in statusParam) return NextResponse.json({ error: statusParam.error }, { status: 400 })
    const pageParam = parseIntParam(searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page')
    if ('error' in pageParam) return NextResponse.json({ error: pageParam.error }, { status: 400 })
    const limitParam = parseIntParam(searchParams.get('limit'), 25, 1, 100, 'limit')
    if ('error' in limitParam) return NextResponse.json({ error: limitParam.error }, { status: 400 })

    const confidenceLevel = levelParam.value
    const matchStatus = statusParam.value
    const page = pageParam.value
    const limit = limitParam.value
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
