import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'
import { isApifyConfigured, scrapeProfile, scrapeHashtag, searchInstagramAccounts } from '@/lib/apify'

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

function looksLikeUsername(query: string): boolean {
  // Usernames: no spaces, starts with @, or is a single word with dots/underscores
  return query.startsWith('@') || (/^[\w.]+$/.test(query) && !query.includes(' '))
}

async function searchViaApifyProfile(query: string, platform: string, minFollowers?: number, maxFollowers?: number): Promise<DiscoverResult[]> {
  try {
    const cleanUsername = query.replace(/^@/, '')
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
    }]
  } catch {
    return []
  }
}

async function searchViaApifyDiscovery(query: string, platform: string, minFollowers?: number, maxFollowers?: number): Promise<DiscoverResult[]> {
  if (platform !== 'INSTAGRAM') return []
  try {
    const searchResults = await searchInstagramAccounts(query, { limit: 30 })
    if (!searchResults || searchResults.length === 0) return []

    const results: DiscoverResult[] = []
    for (const r of searchResults) {
      if (!r.username) continue
      if (minFollowers && r.followers > 0 && r.followers < minFollowers) continue
      if (maxFollowers && r.followers > 0 && r.followers > maxFollowers) continue
      results.push({
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        followers: r.followers,
        engagementRate: 0,
        avgLikes: 0,
        avgComments: 0,
        avgViews: 0,
        email: null,
        platform,
        source: 'apify',
      })
    }

    // Enrich with local DB data if available
    const usernames = results.map(r => r.username)
    if (usernames.length > 0) {
      const dbProfiles = await prisma.influencer.findMany({
        where: { username: { in: usernames }, platform: platform as Platform },
      })
      for (const db of dbProfiles) {
        const existing = results.find(r => r.username === db.username)
        if (existing) {
          existing.followers = db.followers || existing.followers
          existing.engagementRate = db.engagementRate || 0
          existing.avgLikes = db.avgLikes || existing.avgLikes
          existing.avgComments = db.avgComments || existing.avgComments
          existing.avgViews = db.avgViews || existing.avgViews
          existing.avatarUrl = db.avatarUrl || existing.avatarUrl
          existing.displayName = db.displayName || existing.displayName
          existing.email = db.email || null
        }
      }
    }

    return results.sort((a, b) => b.followers - a.followers)
  } catch (err) {
    console.error('Instagram discovery search error:', err)
    return []
  }
}

async function searchViaApifyHashtag(query: string, platform: string, minFollowers?: number, maxFollowers?: number): Promise<DiscoverResult[]> {
  try {
    // Search by hashtag to discover creators in a niche/category
    const cleanTag = query.replace(/^#/, '').replace(/\s+/g, '')
    const hashtagResults = await scrapeHashtag(cleanTag, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', 50)
    if (!hashtagResults || hashtagResults.length === 0) return []

    // Collect unique authors
    const authorMap = new Map<string, DiscoverResult>()
    for (const result of hashtagResults) {
      const username = result.authorUsername
      if (!username || authorMap.has(username)) continue
      const followers = result.authorFollowers || 0
      if (minFollowers && followers < minFollowers && followers > 0) continue
      if (maxFollowers && followers > maxFollowers && followers > 0) continue
      authorMap.set(username, {
        username,
        displayName: result.authorDisplayName,
        avatarUrl: result.authorAvatarUrl,
        followers,
        engagementRate: 0,
        avgLikes: result.posts[0]?.likes || 0,
        avgComments: result.posts[0]?.comments || 0,
        avgViews: result.posts[0]?.views || 0,
        email: null,
        platform,
        source: 'apify',
      })
    }

    // Enrich with DB data first
    const usernames = Array.from(authorMap.keys())
    if (usernames.length > 0) {
      const dbProfiles = await prisma.influencer.findMany({
        where: { username: { in: usernames }, platform: platform as Platform },
      })
      for (const db of dbProfiles) {
        const existing = authorMap.get(db.username)
        if (existing) {
          existing.followers = db.followers || existing.followers
          existing.engagementRate = db.engagementRate || 0
          existing.avgLikes = db.avgLikes || existing.avgLikes
          existing.avgComments = db.avgComments || existing.avgComments
          existing.avgViews = db.avgViews || existing.avgViews
          existing.avatarUrl = db.avatarUrl || existing.avatarUrl
          existing.displayName = db.displayName || existing.displayName
          existing.email = db.email || null
        }
      }
    }

    // For top authors without full data, enrich via Apify profile scraping (max 5 to keep it fast)
    const needsEnrichment = Array.from(authorMap.values())
      .filter(r => r.followers === 0 || r.engagementRate === 0)
      .slice(0, 5)

    if (needsEnrichment.length > 0) {
      console.log(`[Discover] Enriching ${needsEnrichment.length} profiles via Apify...`)
      const enrichPromises = needsEnrichment.map(async (r) => {
        try {
          const profile = await scrapeProfile(r.username, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
          if (profile) {
            r.followers = profile.followers || r.followers
            r.engagementRate = profile.engagementRate || r.engagementRate
            r.avgLikes = profile.avgLikes || r.avgLikes
            r.avgComments = profile.avgComments || r.avgComments
            r.avgViews = profile.avgViews || r.avgViews
            r.avatarUrl = profile.avatarUrl || r.avatarUrl
            r.displayName = profile.displayName || r.displayName
            r.email = profile.email || r.email
          }
        } catch { /* skip enrichment errors */ }
      })
      await Promise.allSettled(enrichPromises)
    }

    // Apply follower filters after enrichment
    let enrichedResults = Array.from(authorMap.values())
    if (minFollowers) enrichedResults = enrichedResults.filter(r => r.followers >= minFollowers || r.followers === 0)
    if (maxFollowers) enrichedResults = enrichedResults.filter(r => r.followers <= maxFollowers || r.followers === 0)

    return enrichedResults.sort((a, b) => b.followers - a.followers).slice(0, 50)
  } catch (err) {
    console.error('Hashtag search error:', err)
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
    const { query, platform, minFollowers, maxFollowers, bioKeyword, location } = body as {
      query: string
      platform: string
      minFollowers?: number
      maxFollowers?: number
      bioKeyword?: string
      location?: string
    }

    const cleanQuery = (query || '').trim()
    const normalizedPlatform = platform?.toUpperCase() || 'INSTAGRAM'

    let results: DiscoverResult[] = []
    let source: 'apify' | 'database' = 'database'

    // Try Apify for external search (only if there's a search query)
    if (cleanQuery && isApifyConfigured()) {
      try {
        if (looksLikeUsername(cleanQuery)) {
          // Direct profile lookup
          results = await searchViaApifyProfile(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
        } else {
          // Run BOTH discovery and hashtag search in parallel for speed
          console.log(`[Discover] Searching "${cleanQuery}" on ${normalizedPlatform} — running discovery + hashtag in parallel`)
          const [discoveryResults, hashtagResults] = await Promise.allSettled([
            searchViaApifyDiscovery(cleanQuery, normalizedPlatform, minFollowers, maxFollowers),
            searchViaApifyHashtag(cleanQuery, normalizedPlatform, minFollowers, maxFollowers),
          ])

          const discovery = discoveryResults.status === 'fulfilled' ? discoveryResults.value : []
          const hashtag = hashtagResults.status === 'fulfilled' ? hashtagResults.value : []

          // Merge and deduplicate by username
          const mergedMap = new Map<string, DiscoverResult>()
          for (const r of [...discovery, ...hashtag]) {
            const existing = mergedMap.get(r.username)
            if (!existing || r.followers > existing.followers) {
              mergedMap.set(r.username, r)
            }
          }
          results = Array.from(mergedMap.values()).sort((a, b) => b.followers - a.followers)

          console.log(`[Discover] Found ${discovery.length} via discovery, ${hashtag.length} via hashtag, ${results.length} merged`)
        }
        if (results.length > 0) source = 'apify'
      } catch (apifyError) {
        console.error('Apify discover error, falling back to database:', apifyError)
      }
    }

    // Fallback to internal database if Apify returned no results or is not configured
    // Use relaxed search: OR across username, displayName, bio, and also match category/niche keywords
    if (results.length === 0) {
      const queryWords = cleanQuery ? cleanQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2) : []
      const dbWhere: Prisma.InfluencerWhereInput = {
        AND: [
          // Main search query (only if provided)
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
          // Bio keyword filter
          ...(bioKeyword ? [{ bio: { contains: bioKeyword, mode: 'insensitive' as const } }] : []),
          // Location filter (search in bio and displayName)
          ...(location ? [{
            OR: [
              { bio: { contains: location, mode: 'insensitive' as const } },
              { displayName: { contains: location, mode: 'insensitive' as const } },
            ],
          }] : []),
        ],
      }

      if (normalizedPlatform && Object.values(Platform).includes(normalizedPlatform as Platform)) {
        dbWhere.platform = normalizedPlatform as Platform
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

      // Score and sort results: bio matches rank highest, then displayName, then username
      const searchLower = cleanQuery.toLowerCase()
      const scored = influencers.map((inf) => {
        let score = 0
        const bioLower = (inf.bio || '').toLowerCase()
        const displayLower = (inf.displayName || '').toLowerCase()
        const usernameLower = inf.username.toLowerCase()

        // Bio match is most relevant for niche/category searches
        if (bioLower.includes(searchLower)) score += 30
        // Also score individual word matches in bio
        for (const word of queryWords) {
          if (bioLower.includes(word)) score += 10
        }
        // DisplayName match is second priority
        if (displayLower.includes(searchLower)) score += 15
        // Username match is lowest priority (literal name match, not niche)
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
          _score: score,
        }
      })

      // Sort by relevance score first, then by followers for ties
      scored.sort((a, b) => b._score - a._score || b.followers - a.followers)

      results = scored.map(({ _score, ...rest }) => rest)
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
