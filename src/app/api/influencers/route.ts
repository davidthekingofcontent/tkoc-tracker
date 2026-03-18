import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const search = searchParams.get('search')
    const platform = searchParams.get('platform')
    const page = parseInt(searchParams.get('page') || '1', 10)
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
    const skip = (page - 1) * limit

    const where: Prisma.InfluencerWhereInput = {}

    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ]
    }

    if (platform && Object.values(Platform).includes(platform as Platform)) {
      where.platform = platform as Platform
    }

    const [influencers, total] = await Promise.all([
      prisma.influencer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { followers: 'desc' },
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
