import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'

// ---- Query validation: a bad value answers 400 instead of a Prisma 500 ----

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
    const search = searchParams.get('search')
    const platform = searchParams.get('platform')
    const sort = searchParams.get('sort') // 'lastScraped', 'followers', 'engagement'

    if (platform && !Object.values(Platform).includes(platform as Platform)) {
      return NextResponse.json(
        { error: `Invalid platform. Use one of: ${Object.values(Platform).join(', ')}` },
        { status: 400 }
      )
    }
    const pageParam = parseIntParam(searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page')
    if ('error' in pageParam) return NextResponse.json({ error: pageParam.error }, { status: 400 })
    const limitParam = parseIntParam(searchParams.get('limit'), 20, 1, 100, 'limit')
    if ('error' in limitParam) return NextResponse.json({ error: limitParam.error }, { status: 400 })
    const page = pageParam.value
    const limit = limitParam.value
    const skip = (page - 1) * limit

    const where: Prisma.InfluencerWhereInput = {}

    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { bio: { contains: search, mode: 'insensitive' } },
      ]
    }

    if (platform) {
      where.platform = platform as Platform
    }

    // Determine sort order
    let orderBy: Prisma.InfluencerOrderByWithRelationInput = { followers: 'desc' }
    if (sort === 'lastScraped') {
      orderBy = { lastScraped: 'desc' }
    } else if (sort === 'engagement') {
      orderBy = { engagementRate: 'desc' }
    }

    const [influencers, total] = await Promise.all([
      prisma.influencer.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          _count: {
            select: { campaigns: true, media: true },
          },
        },
      }),
      prisma.influencer.count({ where }),
    ])

    return NextResponse.json({
      influencers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('List influencers error:', error)
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
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { username, platform, displayName, bio, email, phone, website, country, city, language, gender } = body

    if (!username || !platform) {
      return NextResponse.json(
        { error: 'Username and platform are required' },
        { status: 400 }
      )
    }

    if (!Object.values(Platform).includes(platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    // Check for existing influencer
    const existing = await prisma.influencer.findUnique({
      where: { username_platform: { username, platform } },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'Influencer already exists', influencer: existing },
        { status: 409 }
      )
    }

    const influencer = await prisma.influencer.create({
      data: {
        username,
        platform,
        displayName,
        bio,
        email,
        phone,
        website,
        country,
        city,
        language,
        gender,
      },
    })

    return NextResponse.json({ influencer }, { status: 201 })
  } catch (error) {
    console.error('Create influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
