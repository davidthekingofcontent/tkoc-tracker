import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { username, platform } = body

    if (!username || !platform) {
      return NextResponse.json(
        { error: 'Username and platform are required' },
        { status: 400 }
      )
    }

    if (!Object.values(Platform).includes(platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    // Clean the username (remove @ prefix if present)
    const cleanUsername = username.replace(/^@/, '')

    // Find existing or create a new record
    let influencer = await prisma.influencer.findUnique({
      where: { username_platform: { username: cleanUsername, platform } },
      include: {
        _count: { select: { campaigns: true, media: true } },
      },
    })

    if (!influencer) {
      influencer = await prisma.influencer.create({
        data: {
          username: cleanUsername,
          platform,
        },
        include: {
          _count: { select: { campaigns: true, media: true } },
        },
      })
    }

    // TODO: In the future, trigger Apify scraping here to populate/update metrics
    // For now, just return the existing record

    return NextResponse.json({
      influencer,
      analyzed: true,
      message: 'Profile record created. Full analysis with Apify coming soon.',
    })
  } catch (error) {
    console.error('Analyze influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
