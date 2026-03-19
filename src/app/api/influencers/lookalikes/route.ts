import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { isApifyConfigured, scrapeProfile } from '@/lib/apify'

function calculateMatchScore(
  source: { followers: number; engagementRate: number; platform: string },
  candidate: { followers: number; engagementRate: number; platform: string; email: string | null }
): number {
  let score = 0

  // Follower similarity: 40 points max
  if (source.followers > 0 && candidate.followers > 0) {
    const ratio = Math.min(source.followers, candidate.followers) / Math.max(source.followers, candidate.followers)
    score += Math.round(ratio * 40)
  }

  // Engagement rate similarity: 30 points max
  if (source.engagementRate > 0 && candidate.engagementRate > 0) {
    const diff = Math.abs(source.engagementRate - candidate.engagementRate)
    const similarity = Math.max(0, 1 - diff / Math.max(source.engagementRate, 1))
    score += Math.round(similarity * 30)
  }

  // Same platform: 20 points
  if (source.platform === candidate.platform) {
    score += 20
  }

  // Has email: 10 points
  if (candidate.email) {
    score += 10
  }

  return Math.min(score, 100)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const handle = searchParams.get('handle')
    const platform = (searchParams.get('platform') || 'INSTAGRAM') as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    const cleanHandle = handle.replace(/^@/, '').trim()

    // Find or scrape the source influencer
    let source = await prisma.influencer.findFirst({
      where: {
        username: { equals: cleanHandle, mode: 'insensitive' },
        platform,
      },
    })

    // If not found in DB and Apify is configured, scrape the profile
    if (!source && isApifyConfigured()) {
      try {
        const scraped = await scrapeProfile(cleanHandle, platform)
        if (scraped) {
          source = await prisma.influencer.upsert({
            where: { username_platform: { username: scraped.username, platform } },
            create: {
              username: scraped.username,
              platform,
              displayName: scraped.displayName,
              bio: scraped.bio,
              avatarUrl: scraped.avatarUrl,
              followers: scraped.followers,
              following: scraped.following,
              postsCount: scraped.postsCount,
              engagementRate: scraped.engagementRate,
              avgLikes: scraped.avgLikes,
              avgComments: scraped.avgComments,
              avgViews: scraped.avgViews,
              isVerified: scraped.isVerified,
              email: scraped.email,
              country: scraped.country,
              city: scraped.city,
            },
            update: {
              displayName: scraped.displayName,
              avatarUrl: scraped.avatarUrl,
              followers: scraped.followers,
              engagementRate: scraped.engagementRate,
              avgLikes: scraped.avgLikes,
              avgComments: scraped.avgComments,
              avgViews: scraped.avgViews,
            },
          })
        }
      } catch (err) {
        console.error('Failed to scrape source profile:', err)
      }
    }

    if (!source) {
      return NextResponse.json({ lookalikes: [], source: null })
    }

    const sourceFollowers = source.followers || 1000
    const sourceER = source.engagementRate || 0

    // Find similar influencers: same platform, follower range 0.2x-5x, engagement rate ±3%
    const similar = await prisma.influencer.findMany({
      where: {
        platform,
        id: { not: source.id },
        followers: {
          gte: Math.floor(sourceFollowers * 0.2),
          lte: Math.ceil(sourceFollowers * 5),
        },
        ...(sourceER > 0 ? {
          engagementRate: {
            gte: Math.max(0, sourceER - 3),
            lte: sourceER + 3,
          },
        } : {}),
      },
      take: 50,
      orderBy: { followers: 'desc' },
    })

    // Score and sort by match quality
    const lookalikes = similar
      .map((inf) => ({
        username: inf.username,
        displayName: inf.displayName || inf.username,
        platform: inf.platform,
        followers: inf.followers || 0,
        engagementRate: inf.engagementRate || 0,
        matchScore: calculateMatchScore(
          { followers: sourceFollowers, engagementRate: sourceER, platform },
          { followers: inf.followers, engagementRate: inf.engagementRate, platform: inf.platform, email: inf.email }
        ),
        bio: inf.bio || '',
        avatarUrl: inf.avatarUrl,
        profileUrl: inf.platform === 'TIKTOK'
          ? `https://tiktok.com/@${inf.username}`
          : inf.platform === 'YOUTUBE'
            ? `https://youtube.com/@${inf.username}`
            : `https://instagram.com/${inf.username}`,
      }))
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 12)

    return NextResponse.json({
      lookalikes,
      source: {
        username: source.username,
        displayName: source.displayName,
        followers: source.followers,
        platform: source.platform,
        engagementRate: source.engagementRate,
      },
    })
  } catch (error) {
    console.error('Lookalikes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
