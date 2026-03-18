import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'
import { isApifyConfigured } from '@/lib/apify'
import { ApifyClient } from 'apify-client'

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

async function searchInstagramViaApify(query: string, minFollowers?: number, maxFollowers?: number): Promise<DiscoverResult[]> {
  const token = process.env.APIFY_API_KEY
  if (!token) return []

  const client = new ApifyClient({ token })

  const run = await client.actor('apify/instagram-profile-scraper').call(
    {
      search: query,
      resultsLimit: 20,
    },
    {
      waitSecs: 120,
    }
  )

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  if (!items || items.length === 0) return []

  const results: DiscoverResult[] = []

  for (const item of items) {
    const profile = item as Record<string, unknown>
    const followers = (profile.followersCount as number) || 0

    // Apply follower filters
    if (minFollowers && followers < minFollowers) continue
    if (maxFollowers && followers > maxFollowers) continue

    // Calculate engagement from recent posts
    const posts = ((profile.latestPosts as Record<string, unknown>[]) || []).slice(0, 12)
    let totalLikes = 0
    let totalComments = 0
    let totalViews = 0

    for (const post of posts) {
      totalLikes += (post.likesCount as number) || 0
      totalComments += (post.commentsCount as number) || 0
      totalViews += (post.videoViewCount as number) || (post.videoPlayCount as number) || 0
    }

    const postCount = posts.length || 1
    const avgLikes = Math.round(totalLikes / postCount)
    const avgComments = Math.round(totalComments / postCount)
    const avgViews = Math.round(totalViews / postCount)
    const engagementRate = followers > 0
      ? parseFloat((((totalLikes + totalComments) / postCount / followers) * 100).toFixed(2))
      : 0

    // Extract email from bio
    const bio = (profile.biography as string) || ''
    const emailMatch = bio.match(/[\w.-]+@[\w.-]+\.\w+/)

    results.push({
      username: (profile.username as string) || '',
      displayName: (profile.fullName as string) || null,
      avatarUrl: (profile.profilePicUrl as string) || (profile.profilePicUrlHD as string) || null,
      followers,
      engagementRate,
      avgLikes,
      avgComments,
      avgViews,
      email: emailMatch ? emailMatch[0] : null,
      platform: 'INSTAGRAM',
      source: 'apify',
    })
  }

  return results
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

    // Try Apify for external search (Instagram only for now)
    if (isApifyConfigured() && normalizedPlatform === 'INSTAGRAM') {
      try {
        results = await searchInstagramViaApify(cleanQuery, minFollowers, maxFollowers)
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
