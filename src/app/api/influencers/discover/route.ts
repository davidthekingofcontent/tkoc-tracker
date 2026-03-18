import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'
import { isApifyConfigured, scrapeProfile } from '@/lib/apify'

interface DiscoverResult {
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  platform: string
  source: 'apify' | 'database'
}

async function searchInstagramViaApify(query: string, platform: string, minFollowers?: number, maxFollowers?: number): Promise<DiscoverResult[]> {
  // Use scrapeProfile to look up the query as a username
  try {
    const scraped = await scrapeProfile(query, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
    if (!scraped) return []

    const followers = scraped.followers
    if (minFollowers && followers < minFollowers) return []
    if (maxFollowers && followers > maxFollowers) return []

    return [{
      username: scraped.username,
      displayName: scraped.displayName,
      avatarUrl: scraped.avatarUrl,
      followers: scraped.followers,
      engagementRate: scraped.engagementRate,
      avgLikes: scraped.avgLikes,
      avgComments: scraped.avgComments,
      avgViews: scraped.avgViews,
      email: scraped.email,
      platform,
      source: 'apify',
    }]
  } catch {
    return []
  }
}

async function searchInternalDatabase(
  query: string,
  platform: string | undefined,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  const where: Prisma.InfluencerWhereInput = {}

  if (query) {
    where.OR = [
      { username: { contains: query, mode: 'insensitive' } },
      { displayName: { contains: query, mode: 'insensitive' } },
      { bio: { contains: query, mode: 'insensitive' } },
    ]
  }

  if (platform && Object.values(Platform).includes(platform as Platform)) {
    where.platform = platform as Platform
  }

  if (minFollowers || maxFollowers) {
    where.followers = {}
    if (minFollowers) where.followers.gte = minFollowers
    if (maxFollowers) where.followers.lte = maxFollowers
  }

  const influencers = await prisma.influencer.findMany({
    where,
    take: 50,
    orderBy: { followers: 'desc' },
  })

  return influencers.map((inf) => ({
    username: inf.username,
    displayName: inf.displayName,
    avatarUrl: inf.avatarUrl,
    followers: inf.followers,
    engagementRate: inf.engagementRate,
    avgLikes: inf.avgLikes,
    avgComments: inf.avgComments,
    avgViews: inf.avgViews,
    email: inf.email,
    platform: inf.platform,
    source: 'database' as const,
  }))
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { query, platform, minFollowers, maxFollowers } = body as {
      query: string
      platform: string
      minFollowers?: number
      maxFollowers?: number
    }

    if (!query || !query.trim()) {
      return NextResponse.json(
        { error: 'Search query is required' },
        { status: 400 }
      )
    }

    const cleanQuery = query.trim()
    const normalizedPlatform = platform?.toUpperCase() || 'INSTAGRAM'

    let results: DiscoverResult[] = []
    let source: 'apify' | 'database' = 'database'

    // Try Apify for external search
    if (isApifyConfigured()) {
      try {
        results = await searchInstagramViaApify(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
        source = 'apify'
      } catch (apifyError) {
        console.error('Apify discover error, falling back to database:', apifyError)
        // Fall through to database search
      }
    }

    // Fallback to internal database if Apify returned no results or is not configured
    if (results.length === 0) {
      results = await searchInternalDatabase(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
      source = 'database'
    }

    return NextResponse.json({
      results,
      total: results.length,
      source,
    })
  } catch (error) {
    console.error('Discover influencers error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
