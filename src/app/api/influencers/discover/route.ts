import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform, Prisma } from '@/generated/prisma/client'
import {
  isApifyConfigured,
  isApifyExhausted,
  isApifyOverSoftLimit,
  getApifyResumeDate,
  scrapeProfile,
  scrapeHashtag,
  type HashtagResult,
} from '@/lib/apify'
import {
  resolveCategoryQuery,
  resolveHashtagLimit,
  resolveEnrichLimit,
  estimateHashtagCostUsd,
  buildHashtagCacheKey,
  getCachedHashtagSearch,
  runHashtagSearchCoalesced,
  cleanHashtag,
  type CategoryMatch,
} from '@/lib/discover-cache'
import { afterInfluencerUpsert, scrapedProfileHasData, scrapedProfileUpdate } from '@/lib/influencer-upsert'

// POST /api/influencers/discover
//
// mode 'username' → direct Apify profile lookup (unchanged, ~0,0023 $).
// mode 'category' → CHEAP FLOW (David 2026-09-14: "apify cobra demasiado"):
//   1. Free: search our own DB (Influencer + CreatorProfile) for the category.
//   2. Free: serve a HashtagSearchCache hit (< 7 days) if we already paid for it.
//   3. Paid: only when the body carries `confirmPaid: true`, and only after the
//      budget gates (breaker → 503, soft limit → 402). resultsLimit comes from
//      DISCOVER_HASHTAG_LIMIT (default 60, hard cap 150) — never 500 again.

type ResultSource = 'apify' | 'database' | 'apify-cache'

interface DiscoverResult {
  /** Legacy Influencer id when the creator has a row — lets the UI use the durable avatar copy. */
  influencerId?: string
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
  source: ResultSource
  enriched?: boolean
  bio?: string | null
  country?: string | null
  city?: string | null
  /** Category slugs known for this creator (CreatorProfile). */
  categories?: string[]
  /** Why a DB row matched: category | signal | hashtag | bio | name. */
  matchReason?: string
}

type ScrapePlatform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

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

function toPlatform(p: string): Platform | null {
  return Object.values(Platform).includes(p as Platform) ? (p as Platform) : null
}

/** Drop the internal ranking score before the rows leave the API. */
function stripScore<T extends { _score: number }>(rows: T[]): Omit<T, '_score'>[] {
  return rows.map(r => {
    const copy: Record<string, unknown> = { ...r }
    delete copy._score
    return copy as Omit<T, '_score'>
  })
}

// ============ MODE 1: username lookup (unchanged) ============

async function searchViaApifyProfile(
  query: string,
  platform: string,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  try {
    const cleanUsername = extractUsernameFromUrl(query)
    const scraped = await scrapeProfile(cleanUsername, platform as ScrapePlatform)
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
 * Username-mode fallback: free-text search of the legacy Influencer table.
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

  const p = platform ? toPlatform(platform) : null
  if (p) dbWhere.platform = p
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
      influencerId: inf.id,
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
  return stripScore(scored)
}

// ============ MODE 2a: category search in OUR database (free) ============

const DB_TAKE = 100
const RECENT_HASHTAG_DAYS = 180

async function searchDatabaseByCategory(
  match: CategoryMatch,
  platform: Platform,
  minFollowers?: number,
  maxFollowers?: number
): Promise<DiscoverResult[]> {
  const q = match.terms[0] || ''
  const slug = match.category?.slug || null
  const bioTerms = match.terms.map(t => ({ bio: { contains: t, mode: 'insensitive' as const } }))
  const hashtagVariants = Array.from(new Set(match.hashtags.flatMap(h => [h, `#${h}`])))
  const since = new Date(Date.now() - RECENT_HASHTAG_DAYS * 24 * 60 * 60 * 1000)

  const followersFilter: Prisma.IntFilter | undefined = (minFollowers || maxFollowers)
    ? { ...(minFollowers ? { gte: minFollowers } : {}), ...(maxFollowers ? { lte: maxFollowers } : {}) }
    : undefined

  const [influencers, platformProfiles] = await Promise.all([
    prisma.influencer.findMany({
      where: {
        platform,
        ...(followersFilter ? { followers: followersFilter } : {}),
        OR: [
          ...bioTerms,
          ...(q ? [{ displayName: { contains: q, mode: 'insensitive' as const } }] : []),
        ],
      },
      take: DB_TAKE,
      orderBy: { followers: 'desc' },
    }),
    prisma.creatorPlatformProfile.findMany({
      where: {
        platform,
        ...(followersFilter ? { followers: followersFilter } : {}),
        creator: { isSuppressed: false },
        OR: [
          ...(slug ? [
            { creator: { categories: { has: slug } } },
            { creator: { primaryCategory: slug } },
            { creator: { categorySignals: { some: { category: slug } } } },
          ] : []),
          ...(hashtagVariants.length > 0 ? [{
            creator: { posts: { some: { hashtags: { hasSome: hashtagVariants }, capturedAt: { gte: since } } } },
          }] : []),
          ...bioTerms,
        ],
      },
      include: {
        creator: {
          select: {
            categories: true,
            primaryCategory: true,
            geoCountry: true,
            geoCity: true,
            contactEmail: true,
            categorySignals: slug ? { where: { category: slug }, take: 1, select: { id: true } } : false,
          },
        },
      },
      take: DB_TAKE,
      orderBy: { followers: 'desc' },
    }),
  ])

  const qLower = q.toLowerCase()
  const scoreText = (bio: string | null | undefined, name: string | null | undefined): { score: number; reason: string | null } => {
    const b = (bio || '').toLowerCase()
    const n = (name || '').toLowerCase()
    if (qLower && b.includes(qLower)) return { score: 25, reason: 'bio' }
    if (qLower && n.includes(qLower)) return { score: 20, reason: 'name' }
    if (match.terms.some(t => b.includes(t))) return { score: 15, reason: 'bio' }
    return { score: 0, reason: null }
  }

  type Scored = DiscoverResult & { _score: number }
  const byKey = new Map<string, Scored>()

  for (const pp of platformProfiles) {
    const c = pp.creator
    let score = 0
    let reason: string | null = null
    if (slug && (c.categories.includes(slug) || c.primaryCategory === slug)) { score = 60; reason = 'category' }
    else if (slug && Array.isArray(c.categorySignals) && c.categorySignals.length > 0) { score = 50; reason = 'signal' }
    const txt = scoreText(pp.bio, null)
    if (txt.score > 0) { score += txt.score; reason = reason || txt.reason }
    if (!reason) { score = 30; reason = 'hashtag' }

    byKey.set(`${pp.platform}:${pp.username.toLowerCase()}`, {
      influencerId: pp.influencerId ?? undefined,
      username: pp.username,
      displayName: null,
      avatarUrl: pp.avatarUrl,
      followers: pp.followers,
      engagementRate: pp.engagementRate,
      avgLikes: pp.avgLikes,
      avgComments: pp.avgComments,
      avgViews: pp.avgViews,
      email: c.contactEmail,
      platform: pp.platform,
      source: 'database',
      enriched: true,
      bio: pp.bio || null,
      country: c.geoCountry,
      city: c.geoCity,
      categories: c.categories,
      matchReason: reason,
      _score: score,
    })
  }

  for (const inf of influencers) {
    const key = `${inf.platform}:${inf.username.toLowerCase()}`
    const txt = scoreText(inf.bio, inf.displayName)
    const existing = byKey.get(key)
    if (existing) {
      // Merge the richer legacy fields into the creator row.
      existing.influencerId = existing.influencerId || inf.id
      existing.displayName = existing.displayName || inf.displayName
      existing.email = existing.email || inf.email
      existing.avatarUrl = existing.avatarUrl || inf.avatarUrl
      existing.bio = existing.bio || inf.bio || null
      existing.country = existing.country || inf.country
      existing.city = existing.city || inf.city
      existing.followers = existing.followers || inf.followers
      existing.engagementRate = existing.engagementRate || inf.engagementRate
      existing._score += txt.score
      continue
    }
    byKey.set(key, {
      influencerId: inf.id,
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
      source: 'database',
      enriched: true,
      bio: inf.bio || null,
      country: inf.country || null,
      city: inf.city || null,
      matchReason: txt.reason || 'bio',
      _score: txt.score || 10,
    })
  }

  return stripScore(
    Array.from(byKey.values())
      .sort((a, b) => b._score - a._score || b.followers - a.followers || b.engagementRate - a.engagementRate)
  )
}

// ============ MODE 2b: hashtag posts (cache or paid) → creators ============

interface AuthorEntry { result: DiscoverResult; bestEngagement: number }

function authorsFromHashtagPosts(posts: HashtagResult[], platform: string, source: ResultSource): Map<string, AuthorEntry> {
  const authorMap = new Map<string, AuthorEntry>()
  for (const hr of posts) {
    const username = (hr.authorUsername || '').trim()
    if (!username) continue
    const key = username.toLowerCase()

    const postLikes = hr.posts[0]?.likes || 0
    const postComments = hr.posts[0]?.comments || 0
    const postViews = hr.posts[0]?.views || 0
    const engagement = postLikes + postComments

    const existing = authorMap.get(key)
    if (existing) {
      if (engagement > existing.bestEngagement) {
        existing.bestEngagement = engagement
        existing.result.avgLikes = postLikes
        existing.result.avgComments = postComments
        existing.result.avgViews = postViews
      }
      continue
    }
    authorMap.set(key, {
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
        source,
        enriched: false,
        bio: null,
        country: hr.authorCountry || null,
        city: null,
      },
    })
  }
  return authorMap
}

/**
 * Turn hashtag posts into creator cards. Handles already in our DB are filled
 * from existing rows (never re-scraped); at most `enrichLimit` unknown handles
 * are enriched via the profile scraper, and only when `allowPaidEnrich` is true.
 */
async function creatorsFromHashtagPosts(
  posts: HashtagResult[],
  platform: Platform,
  source: ResultSource,
  enrichLimit: number,
  allowPaidEnrich: boolean,
  minFollowers?: number,
  maxFollowers?: number
): Promise<{ results: DiscoverResult[]; enrichedViaApify: number }> {
  const authorMap = authorsFromHashtagPosts(posts, platform, source)
  const usernames = Array.from(authorMap.values()).map(e => e.result.username)
  let enrichedViaApify = 0

  if (usernames.length > 0) {
    const [dbProfiles, creatorRows] = await Promise.all([
      prisma.influencer.findMany({ where: { username: { in: usernames, mode: 'insensitive' }, platform } }),
      prisma.creatorPlatformProfile.findMany({
        where: { username: { in: usernames, mode: 'insensitive' }, platform },
        include: { creator: { select: { categories: true, geoCountry: true, geoCity: true, contactEmail: true } } },
      }),
    ])
    for (const db of dbProfiles) {
      const entry = authorMap.get(db.username.toLowerCase())
      if (!entry) continue
      const r = entry.result
      r.influencerId = db.id
      r.followers = db.followers || r.followers
      r.engagementRate = db.engagementRate || 0
      r.avgLikes = db.avgLikes || r.avgLikes
      r.avgComments = db.avgComments || r.avgComments
      r.avgViews = db.avgViews || r.avgViews
      r.avatarUrl = db.avatarUrl || r.avatarUrl
      r.displayName = db.displayName || r.displayName
      r.email = db.email || null
      r.bio = db.bio || r.bio
      r.country = db.country || r.country
      r.city = db.city || r.city
      r.enriched = true
    }
    for (const cp of creatorRows) {
      const entry = authorMap.get(cp.username.toLowerCase())
      if (!entry) continue
      const r = entry.result
      r.influencerId = r.influencerId || cp.influencerId || undefined
      r.followers = r.followers || cp.followers
      r.engagementRate = r.engagementRate || cp.engagementRate
      r.avgLikes = r.avgLikes || cp.avgLikes
      r.avgComments = r.avgComments || cp.avgComments
      r.avgViews = r.avgViews || cp.avgViews
      r.avatarUrl = r.avatarUrl || cp.avatarUrl
      r.bio = r.bio || cp.bio || null
      r.email = r.email || cp.creator.contactEmail
      r.country = r.country || cp.creator.geoCountry
      r.city = r.city || cp.creator.geoCity
      r.categories = cp.creator.categories
      r.enriched = true
    }
  }

  const sortedEntries = Array.from(authorMap.values()).sort((a, b) => b.bestEngagement - a.bestEngagement)

  if (allowPaidEnrich && enrichLimit > 0) {
    const needsEnrichment = sortedEntries.filter(e => !e.result.enriched).slice(0, enrichLimit)
    if (needsEnrichment.length > 0) {
      console.log(`[Discover] Enriching ${needsEnrichment.length} NEW handles via Apify (≈ ${estimateHashtagCostUsd(0, needsEnrichment.length)} $)`)
      await Promise.allSettled(needsEnrichment.map(async (entry) => {
        try {
          const profile = await scrapeProfile(entry.result.username, platform)
          if (!profile) return
          const r = entry.result
          r.followers = profile.followers || r.followers
          r.engagementRate = profile.engagementRate || r.engagementRate
          r.avgLikes = profile.avgLikes || r.avgLikes
          r.avgComments = profile.avgComments || r.avgComments
          r.avgViews = profile.avgViews || r.avgViews
          r.avatarUrl = profile.avatarUrl || r.avatarUrl
          r.displayName = profile.displayName || r.displayName
          r.email = profile.email || r.email
          r.bio = profile.bio || r.bio
          r.country = profile.country || r.country
          r.city = profile.city || r.city
          r.enriched = true
          enrichedViaApify++
          // Persist what we just paid for: the next search (another hashtag of
          // the category, or this one after the 7-day TTL) fills it from the DB.
          try {
            const saved = await prisma.influencer.upsert({
              where: { username_platform: { username: profile.username, platform } },
              create: {
                username: profile.username,
                platform,
                displayName: profile.displayName,
                bio: profile.bio,
                avatarUrl: profile.avatarUrl,
                email: profile.email,
                website: profile.website,
                followers: profile.followers,
                following: profile.following,
                postsCount: profile.postsCount,
                engagementRate: profile.engagementRate,
                avgLikes: profile.avgLikes,
                avgComments: profile.avgComments,
                avgViews: profile.avgViews,
                isVerified: profile.isVerified,
                country: profile.country,
                city: profile.city,
                lastScraped: scrapedProfileHasData(profile) ? new Date() : null,
                dataSource: 'apify',
              },
              update: scrapedProfileUpdate(profile),
              select: { id: true },
            })
            r.influencerId = saved.id
            afterInfluencerUpsert(saved.id, profile.avatarUrl)
          } catch (err) {
            console.error(`[Discover] could not persist enriched @${profile.username}:`, err instanceof Error ? err.message : err)
          }
        } catch { /* skip enrichment errors */ }
      }))
    }
  }

  let all = sortedEntries.map(e => e.result)
  // Unknown follower counts (0) pass the filters — we cannot judge them yet.
  if (minFollowers) all = all.filter(r => r.followers >= minFollowers || r.followers === 0)
  if (maxFollowers) all = all.filter(r => r.followers <= maxFollowers || r.followers === 0)

  const enriched = all.filter(r => r.enriched).sort((a, b) => b.followers - a.followers)
  const notEnriched = all.filter(r => !r.enriched).sort((a, b) => (b.avgLikes + b.avgComments) - (a.avgLikes + a.avgComments))
  return { results: [...enriched, ...notEnriched], enrichedViaApify }
}

/** Merge hashtag creators after the DB results, skipping handles the DB already returned. */
function mergeResults(dbResults: DiscoverResult[], apifyResults: DiscoverResult[]): { merged: DiscoverResult[]; apifyNew: number } {
  const seen = new Set(dbResults.map(r => `${r.platform}:${r.username.toLowerCase()}`))
  const extra: DiscoverResult[] = []
  for (const r of apifyResults) {
    const key = `${r.platform}:${r.username.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    extra.push(r)
  }
  return { merged: [...dbResults, ...extra], apifyNew: extra.length }
}

// ============ HANDLER ============

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { query, platform, minFollowers, maxFollowers, mode, confirmPaid, confirmed } = body as {
      query: string
      platform: string
      minFollowers?: number
      maxFollowers?: number
      mode?: 'username' | 'category'
      confirmPaid?: boolean
      /** What the PM saw in the confirmation box; the paid run must match it exactly. */
      confirmed?: { hashtag?: string; platform?: string; limit?: number }
    }

    const cleanQuery = (query || '').trim()
    const normalizedPlatform = platform?.toUpperCase() || 'INSTAGRAM'
    const dbPlatform = toPlatform(normalizedPlatform) || Platform.INSTAGRAM

    let searchMode: 'username' | 'category' = mode || 'category'
    if (!mode && cleanQuery && looksLikeUsername(cleanQuery)) searchMode = 'username'

    // ---------- MODE 1: username (untouched behaviour) ----------
    if (searchMode === 'username') {
      let results: DiscoverResult[] = []
      let source: ResultSource = 'database'
      if (cleanQuery && isApifyConfigured()) {
        try {
          console.log(`[Discover] Mode: username lookup for "${cleanQuery}" on ${normalizedPlatform}`)
          results = await searchViaApifyProfile(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
          if (results.length > 0) source = 'apify'
        } catch (apifyError) {
          console.error('[Discover] Apify error, falling back to database:', apifyError)
        }
      }
      if (results.length === 0) {
        results = await searchInternalDatabase(cleanQuery, normalizedPlatform, minFollowers, maxFollowers)
        source = 'database'
      }
      return NextResponse.json({ results, total: results.length, source, mode: searchMode })
    }

    // ---------- MODE 2: category — DB first, cache second, Apify only on request ----------
    if (!cleanQuery) {
      return NextResponse.json({ results: [], total: 0, source: 'database', mode: 'category', apifyAvailable: false, estimatedApifyCostUsd: 0 })
    }

    const match = resolveCategoryQuery(cleanQuery)
    const hashtagLimit = resolveHashtagLimit(process.env.DISCOVER_HASHTAG_LIMIT)
    const enrichLimit = resolveEnrichLimit(process.env.DISCOVER_ENRICH_LIMIT)
    const estimatedApifyCostUsd = estimateHashtagCostUsd(hashtagLimit, enrichLimit)
    const cacheKey = buildHashtagCacheKey(dbPlatform, match.hashtag, hashtagLimit)

    console.log(`[Discover] Category "${cleanQuery}" → ${match.category?.slug ?? '(no category)'} #${match.hashtag} on ${dbPlatform}; confirmPaid=${confirmPaid === true}`)

    const [dbResults, cached] = await Promise.all([
      searchDatabaseByCategory(match, dbPlatform, minFollowers, maxFollowers),
      match.hashtag ? getCachedHashtagSearch(cacheKey) : Promise.resolve(null),
    ])

    const categoryInfo = match.category
      ? { slug: match.category.slug, nameEs: match.category.nameEs, nameEn: match.category.nameEn }
      : null

    const baseResponse = {
      mode: 'category' as const,
      category: categoryInfo,
      hashtag: match.hashtag,
      apifyLimit: hashtagLimit,
      enrichLimit,
      estimatedApifyCostUsd,
      dbCount: dbResults.length,
    }

    // 2b. Free: a cached hashtag run (< 7 days) is served without confirmation.
    if (cached) {
      const { results: apifyResults } = await creatorsFromHashtagPosts(
        cached.results, dbPlatform, 'apify-cache', 0, false, minFollowers, maxFollowers
      )
      const { merged, apifyNew } = mergeResults(dbResults, apifyResults)
      return NextResponse.json({
        ...baseResponse,
        results: merged,
        total: merged.length,
        source: dbResults.length > 0 ? (apifyNew > 0 ? 'mixed' : 'database') : 'apify-cache',
        apifyCount: apifyNew,
        cached: true,
        cacheFetchedAt: cached.fetchedAt.toISOString(),
        apifyAvailable: false,
        apifyUnavailableReason: 'cached',
      })
    }

    // Can a paid search be offered / executed right now?
    let apifyUnavailableReason: 'not_configured' | 'exhausted' | 'soft_limit' | 'no_hashtag' | null = null
    let softLimit: { usd: number | null; softLimit: number } | null = null
    if (!match.hashtag) apifyUnavailableReason = 'no_hashtag'
    else if (!isApifyConfigured()) apifyUnavailableReason = 'not_configured'
    else if (isApifyExhausted()) apifyUnavailableReason = 'exhausted'
    else {
      const s = await isApifyOverSoftLimit()
      softLimit = { usd: s.usd, softLimit: s.softLimit }
      if (s.over) apifyUnavailableReason = 'soft_limit'
    }

    if (confirmPaid !== true) {
      return NextResponse.json({
        ...baseResponse,
        results: dbResults,
        total: dbResults.length,
        source: 'database',
        apifyCount: 0,
        cached: false,
        cacheFetchedAt: null,
        apifyAvailable: apifyUnavailableReason === null,
        apifyUnavailableReason,
        apifyUsage: softLimit,
      })
    }

    // 3. Paid search — explicit request. Gates first.
    if (apifyUnavailableReason === 'exhausted') {
      return NextResponse.json({ error: 'apify_exhausted', resumesAt: getApifyResumeDate() }, { status: 503 })
    }
    if (apifyUnavailableReason === 'soft_limit') {
      return NextResponse.json({ error: 'apify_soft_limit', usd: softLimit?.usd ?? null, softLimit: softLimit?.softLimit ?? null }, { status: 402 })
    }
    if (apifyUnavailableReason !== null) {
      return NextResponse.json({ error: apifyUnavailableReason }, { status: 503 })
    }
    // The run must be the one the PM confirmed (the input or the platform may
    // have changed since the free search that produced the estimate).
    const confirmedPlatform = toPlatform(String(confirmed?.platform || '').toUpperCase())
    if (
      !confirmed ||
      cleanHashtag(String(confirmed.hashtag || '')) !== match.hashtag ||
      confirmedPlatform !== dbPlatform ||
      confirmed.limit !== hashtagLimit
    ) {
      console.warn(`[Discover] confirm_mismatch: confirmed ${JSON.stringify(confirmed ?? null)} vs #${match.hashtag} ${dbPlatform} ${hashtagLimit}`)
      return NextResponse.json({ error: 'confirm_mismatch', hashtag: match.hashtag, platform: dbPlatform, apifyLimit: hashtagLimit }, { status: 409 })
    }

    console.log(`[Discover] PAID hashtag run #${match.hashtag} limit=${hashtagLimit} (≈ ${estimatedApifyCostUsd} $) by ${session.email}`)
    const run = await runHashtagSearchCoalesced(cacheKey, () => scrapeHashtag(match.hashtag, dbPlatform, hashtagLimit))
    if (run.exhausted) {
      // The breaker tripped during the run: an empty answer is a failure, not a result.
      return NextResponse.json({ error: 'apify_exhausted', resumesAt: getApifyResumeDate() }, { status: 503 })
    }
    const posts = run.results
    console.log(`[Discover] Got ${posts.length} posts from #${match.hashtag}${run.cacheWritten ? '' : ' (NOT cached — write failed)'}`)

    const { results: apifyResults, enrichedViaApify } = await creatorsFromHashtagPosts(
      posts, dbPlatform, 'apify', enrichLimit, true, minFollowers, maxFollowers
    )
    const { merged, apifyNew } = mergeResults(dbResults, apifyResults)

    return NextResponse.json({
      ...baseResponse,
      results: merged,
      total: merged.length,
      source: dbResults.length > 0 ? (apifyNew > 0 ? 'mixed' : 'database') : 'apify',
      apifyCount: apifyNew,
      enrichedViaApify,
      cached: false,
      cacheFetchedAt: null,
      apifyAvailable: false,
      apifyUnavailableReason: run.cacheWritten ? 'cached' : null,
      // The run was paid but could not be stored: repeating it will cost again.
      cacheWriteFailed: !run.cacheWritten,
      apifyUsage: softLimit,
    })
  } catch (error) {
    console.error('Discover influencers error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
