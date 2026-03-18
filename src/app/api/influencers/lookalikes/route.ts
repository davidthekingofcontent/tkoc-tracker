import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')
    const platform = searchParams.get('platform') || 'INSTAGRAM'

    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    // Find the source influencer in our database
    const source = await prisma.influencer.findFirst({
      where: {
        OR: [
          { username: { contains: handle, mode: 'insensitive' } },
          { displayName: { contains: handle, mode: 'insensitive' } },
        ],
      },
    })

    // Find similar influencers from our database based on platform, follower range, etc.
    const similar = await prisma.influencer.findMany({
      where: {
        platform: platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
        ...(source ? {
          id: { not: source.id },
          followers: {
            gte: Math.floor((source.followers || 0) * 0.3),
            lte: Math.ceil((source.followers || 0) * 3),
          },
        } : {}),
      },
      take: 12,
      orderBy: { followers: 'desc' },
    })

    const lookalikes = similar.map((inf) => {
      // Calculate a simple match score based on follower similarity
      let matchScore = 70
      if (source && source.followers && inf.followers) {
        const ratio = Math.min(source.followers, inf.followers) / Math.max(source.followers, inf.followers)
        matchScore = Math.round(60 + ratio * 35)
      }

      return {
        username: inf.username,
        displayName: inf.displayName || inf.username,
        platform: inf.platform,
        followers: inf.followers || 0,
        engagementRate: inf.engagementRate || 0,
        matchScore,
        bio: inf.bio || '',
        profileUrl: inf.platform === 'TIKTOK' ? `https://tiktok.com/@${inf.username}` : inf.platform === 'YOUTUBE' ? `https://youtube.com/@${inf.username}` : `https://instagram.com/${inf.username}`,
      }
    })

    return NextResponse.json({
      lookalikes,
      source: source ? {
        username: source.username,
        displayName: source.displayName,
        followers: source.followers,
        platform: source.platform,
      } : null,
    })
  } catch (error) {
    console.error('Lookalikes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
