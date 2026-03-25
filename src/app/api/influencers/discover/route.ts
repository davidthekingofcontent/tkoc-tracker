import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'
import { isApifyConfigured, scrapeProfile, scrapeHashtag } from '@/lib/apify'

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
  enriched?: boolean
  bio?: string | null
  country?: string | null
  city?: string | null
}

function looksLikeUsername(query: string): boolean {
  // Usernames: starts with @, or is a single word with dots/underscores/periods, or looks like a URL
  return (
    query.startsWith('@') ||
    query.includes('instagram.com/') ||
    query.includes('tiktok.com/') ||
    query.includes('youtube.com/') ||
    (/^[\w.]+$/.test(query) && !query.includes(' ') && query.length <= 30)
  )
}

function extractUsernameFromUrl(query: string): string {
  // Extract username from Instagram/TikTok/YouTube URLs
  const patterns = [
    /instagram\.com\/([^/?]+)/,
    /tiktok\.com\/@?([^/?]+)/,
    /youtube\.com\/@?([^/?]+)/,
  ]
  for (const p of patterns) {
    const m = query.match(p)
    if (m) return m[1]
  }
  return query.replace(/^@/, '')
}

/**
 * Mode 1: Direct profile lookup by username (fast, ~10s)
 */
async function searchViaApifyProfile(
  query: string,
  platform: string,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  try {
    const cleanUsername = extractUsernameFromUrl(query)
    const scraped = await scrapeProfile(cleanUsername, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
    if (!scraped) return []
    if (minFollowers && scraped.followers < minFollowers) return []
    if (maxFollowers && scraped.followers > maxFollowers) return []
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
      enriched: true,
      bio: scraped.bio || null,
      country: scraped.country || null,
      city: scraped.city || null,
    }]
  } catch (err) {
    console.error('[Discover] Profile scrape error:', err)
    return []
  }
}

/**
 * Mode 2: Hashtag-based category search (slower, ~1-2 min)
 * Scrapes #keyword posts, extracts unique authors, enriches top 10
 */
async function searchViaApifyHashtag(
  query: string,
  platform: string,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  try {
    const cleanTag = query.replace(/^#/, '').replace(/\s+/g, '').toLowerCase()
    console.log(`[Discover] Hashtag search: #${cleanTag} on ${platform}, fetching 200 posts`)

    const hashtagResults = await scrapeHashtag(cleanTag, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', 200)
    if (!hashtagResults || hashtagResults.length === 0) {
      console.log('[Discover] Hashtag search returned 0 posts')
      return []
    }

    console.log(`[Discover] Got ${hashtagResults.length} posts from hashtag`)

    // Collect unique authors, track their best post engagement for sorting
    const authorMap = new Map<string, {
      result: DiscoverResult
      bestEngagement: number
    }>()

    for (const hr of hashtagResults) {
      const username = hr.authorUsername
      if (!username) continue

      const postLikes = hr.posts[0]?.likes || 0
      const postComments = hr.posts[0]?.comments || 0
      const postViews = hr.posts[0]?.views || 0
      const engagement = postLikes + postComments

      const existing = authorMap.get(username)
      if (existing) {
        // Keep highest engagement post stats
        if (engagement > existing.bestEngagement) {
          existing.bestEngagement = engagement
          existing.result.avgLikes = postLikes
          existing.result.avgComments = postComments
          existing.result.avgViews = postViews
        }
        continue
      }

      authorMap.set(username, {
        bestEngagement: engagement,
        result: {
          username,
          displayName: hr.authorDisplayName,
          avatarUrl: hr.authorAvatarUrl,
          followers: hr.authorFollowers || 0,
          engagementRate: 0,
          avgLikes: postLikes,
          avgComments: postComments,
          avgViews: postViews,
          email: null,
          platform,
          source: 'apify',
          enriched: false,
          bio: null,
          country: null,
          city: null,
        },
      })
    }

    console.log(`[Discover] Found ${authorMap.size} unique authors from hashtag posts`)

    // Enrich with DB data first (cheap)
    const usernames = Array.from(authorMap.keys())
    if (usernames.length > 0) {
      const dbProfiles = await prisma.influencer.findMany({
        where: { username: { in: usernames }, platform: platform as Platform },
      })
      for (const db of dbProfiles) {
        const entry = authorMap.get(db.username)
        if (entry) {
          entry.result.followers = db.followers || entry.result.followers
          entry.result.engagementRate = db.engagementRate || 0
          entry.result.avgLikes = db.avgLikes || entry.result.avgLikes
          entry.result.avgComments = db.avgComments || entry.result.avgComments
          entry.result.avgViews = db.avgViews || entry.result.avgViews
          entry.result.avatarUrl = db.avatarUrl || entry.result.avatarUrl
          entry.result.displayName = db.displayName || entry.result.displayName
          entry.result.email = db.email || null
          entry.result.bio = db.bio || entry.result.bio
          entry.result.country = db.country || entry.result.country
          entry.result.city = db.city || entry.result.city
          entry.result.enriched = true
        }
      }
    }

    // Sort by post engagement to pick the top creators for enrichment
    const sortedEntries = Array.from(authorMap.values())
      .sort((a, b) => b.bestEngagement - a.bestEngagement)

    // Enrich TOP 10 that are not already enriched, via Apify profile scraping in parallel
    const needsEnrichment = sortedEntries
      .filter(e => !e.result.enriched)
      .slice(0, 20)

    if (needsEnrichment.length > 0) {
      console.log(`[Discover] Enriching ${needsEnrichment.length} profiles via Apify in parallel...`)
      const enrichPromises = needsEnrichment.map(async (entry) => {
        try {
          const profile = await scrapeProfile(entry.result.username, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
          if (profile) {
            entry.result.followers = profile.followers || entry.result.followers
            entry.result.engagementRate = profile.engagementRate || entry.result.engagementRate
            entry.result.avgLikes = profile.avgLikes || entry.result.avgLikes
            entry.result.avgComments = profile.avgComments || entry.result.avgComments
            entry.result.avgViews = profile.avgViews || entry.result.avgViews
            entry.result.avatarUrl = profile.avatarUrl || entry.result.avatarUrl
            entry.result.displayName = profile.displayName || entry.result.displayName
            entry.result.email = profile.email || entry.result.email
            entry.result.bio = profile.bio || entry.result.bio
            entry.result.country = profile.country || entry.result.country
            entry.result.city = profile.city || entry.result.city
            entry.result.enriched = true
          }
        } catch { /* skip enrichment errors */ }
      })
      await Promise.allSettled(enrichPromises)
      console.log('[Discover] Enrichment complete')
    }

    // Build final results: enriched first, then non-enriched
    let allResults = sortedEntries.map(e => e.result)

    // Apply follower filters after enrichment
    if (minFollowers) allResults = allResults.filter(r => r.followers >= minFollowers || r.followers === 0)
    if (maxFollowers) allResults = allResults.filter(r => r.followers <= maxFollowers || r.followers === 0)

    // Sort: enriched profiles first (sorted by followers), then non-enriched (sorted by engagement)
    const enriched = allResults.filter(r => r.enriched).sort((a, b) => b.followers - a.followers)
    const notEnriched = allResults.filter(r => !r.enriched).sort((a, b) => (b.avgLikes + b.avgComments) - (a.avgLikes + a.avgComments))

    return [...enriched, ...notEnriched]
  } catch (err) {
    console.error('[Discover] Hashtag search error:', err)
    return []
  }
}

/**
 * Fallback: Search internal database
 */
async function searchInternalDatabase(
  query: string,
  platform: string | undefined,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  const cleanQuery = (query || '').trim()
  const queryWords = cleanQuery ? cleanQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2) : []

  const dbWhere: Prisma.InfluencerWhereInput = {
    AND: [
      ...(cleanQuery ? [{
        OR: [
          { username: { contains: cleanQuery, mode: 'insensitive' as const } },
          { displayName: { contains: cleanQuery, mode: 'insensitive' as const } },
          { bio: { contains: cleanQuery, mode: 'insensitive' as const } },
          ...queryWords.map(word => ({
            OR: [
              { username: { contains: word, mode: 'insensitive' as const } },
              { displayName: { contains: word, mode: 'insensitive' as const } },
              { bio: { contains: word, mode: 'insensitive' as const } },
            ],
          })),
        ],
      }] : []),
    ],
  }

  if (platform && Object.values(Platform).includes(platform as Platform)) {
    dbWhere.platform = platform as Platform
  }
  if (minFollowers || maxFollowers) {
    dbWhere.followers = {}
    if (minFollowers) dbWhere.followers.gte = minFollowers
    if (maxFollowers) dbWhere.followers.lte = maxFollowers
  }

  const influencers = await prisma.influencer.findMany({
    where: dbWhere,
    take: 50,
    orderBy: { followers: 'desc' },
  })

  // Score and sort results
  const searchLower = cleanQuery.toLowerCase()
  const scored = influencers.map((inf) => {
    let score = 0
    const bioLower = (inf.bio || '').toLowerCase()
    const displayLower = (inf.displayName || '').toLowerCase()
    const usernameLower = inf.username.toLowerCase()

    if (bioLower.includes(searchLower)) score += 30
    for (const word of queryWords) {
      if (bioLower.includes(word)) score += 10
    }
    if (displayLower.includes(searchLower)) score += 15
    if (usernameLower.includes(searchLower)) score += 5

    return {
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
      bio: inf.bio || null,
      country: inf.country || null,
      city: inf.city || null,
      _score: score,
    }
  })

  scored.sort((a, b) => b._score - a._score || b.followers - a.followers)
  return scored.map(({ _score, ...rest }) => rest)
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { query, platform, minFollowers, maxFollowers, mode } = body as {
      query: string
      platform: string
      minFollowers?: number
      maxFollowers?: number
      mode?: 'username' | 'category'
    }

    const cleanQuery = (query || '').trim()
    const normalizedPlatform = platform?.toUpperCase() || 'INSTAGRAM'

    let results: DiscoverResult[] = []
    let source: 'apify' | 'database' = 'database'
    let searchMode: 'username' | 'category' = mode || 'category'

    // Auto-detect mode if not explicitly set
    if (!mode && cleanQuery) {
      if (looksLikeUsername(cleanQuery)) {
        searchMode = 'username'
      }
    }

    // Try Apify search
    if (cleanQuery && isApifyConfigured()) {
      try {
        if (searchMode === 'username') {
          // Mode 1: Direct profile lookup (fast)
          console.log(`[Discover] Mode: username lookup for "${cleanQuery}" on ${normalizedPlatform}`)
          results = await searchViaApifyProfile(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
        } else {
          // Mode 2: Hashtag/category search (slower but finds many creators)
          console.log(`[Discover] Mode: category search for "${cleanQuery}" on ${normalizedPlatform}`)
          results = await searchViaApifyHashtag(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
        }

        if (results.length > 0) source = 'apify'
        console.log(`[Discover] Apify returned ${results.length} results`)
      } catch (apifyError) {
        console.error('[Discover] Apify error, falling back to database:', apifyError)
      }
    }

    // Fallback to internal database if Apify returned nothing
    if (results.length === 0) {
      console.log('[Discover] Falling back to database search')
      results = await searchInternalDatabase(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
      source = 'database'
    }

    return NextResponse.json({
      results,
      total: results.length,
      source,
      mode: searchMode,
    })
  } catch (error) {
    console.error('Discover influencers error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
