import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeProfile, isApifyConfigured, searchInstagramAccounts, scrapeInstagramSimilarAccounts } from '@/lib/apify'
import { Platform } from '@/generated/prisma/client'

// ---------------------------------------------------------------------------
// GET /api/influencers/[id]/lookalikes
// Finds similar influencer profiles (lookalikes) for a given influencer.
// ---------------------------------------------------------------------------

interface LookalikeEntry {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  matchScore: number
}

function calculateMatchScore(
  source: { followers: number; engagementRate: number; platform: Platform },
  candidate: {
    followers: number
    engagementRate: number
    platform: Platform
    email: string | null
  }
): number {
  let score = 0

  // Follower similarity: 40 points max (closer = higher)
  const followerRatio =
    source.followers > 0
      ? Math.min(candidate.followers, source.followers) /
        Math.max(candidate.followers, source.followers)
      : 0
  score += Math.round(followerRatio * 40)

  // Engagement rate similarity: 30 points max (closer = higher)
  const erDiff = Math.abs(source.engagementRate - candidate.engagementRate)
  // 0 diff => 30 pts, >=6 diff => 0 pts
  score += Math.round(Math.max(0, 30 - (erDiff / 6) * 30))

  // Same platform: 20 points
  if (source.platform === candidate.platform) {
    score += 20
  }

  // Has email: 10 points
  if (candidate.email) {
    score += 10
  }

  return Math.min(100, Math.max(0, score))
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 1. Authenticate
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  // 2. Fetch source influencer
  const source = await prisma.influencer.findUnique({
    where: { id },
  })

  if (!source) {
    return NextResponse.json(
      { error: 'Influencer not found' },
      { status: 404 }
    )
  }

  // 3. Prepare search parameters
  const minFollowers = Math.round(source.followers * 0.2)
  const maxFollowers = Math.round(source.followers * 5)
  const minER = source.engagementRate - 3
  const maxER = source.engagementRate + 3
  const existingUsernames = new Set([source.username])

  const lookalikes: LookalikeEntry[] = []

  // Strategy 1: Try Instagram's "similar accounts" / suggested profiles first
  if (isApifyConfigured() && source.platform === 'INSTAGRAM') {
    try {
      const similarAccounts = await scrapeInstagramSimilarAccounts(source.username)

      for (const result of similarAccounts) {
        if (lookalikes.length >= 12) break
        if (!result.username || existingUsernames.has(result.username)) continue

        existingUsernames.add(result.username)
        lookalikes.push({
          id: `ext_${result.username}`,
          username: result.username,
          displayName: result.displayName,
          avatarUrl: result.avatarUrl,
          platform: source.platform,
          followers: result.followers,
          engagementRate: 0,
          avgLikes: 0,
          avgComments: 0,
          avgViews: 0,
          email: null,
          matchScore: calculateMatchScore(source, {
            followers: result.followers,
            engagementRate: 0,
            platform: source.platform,
            email: null,
          }),
        })
      }
    } catch (err) {
      console.error('[Lookalikes] Instagram similar accounts error:', err)
    }
  }

  // Strategy 2: Supplement with local DB matches
  const dbResults = await prisma.influencer.findMany({
    where: {
      id: { not: source.id },
      platform: source.platform,
      username: { notIn: Array.from(existingUsernames) },
      followers: { gte: minFollowers, lte: maxFollowers },
      engagementRate: { gte: minER, lte: maxER },
    },
    orderBy: {
      followers: 'asc',
    },
    take: 12,
  })

  // Sort by closest follower count to source
  dbResults.sort(
    (a, b) =>
      Math.abs(a.followers - source.followers) -
      Math.abs(b.followers - source.followers)
  )

  for (const inf of dbResults) {
    if (lookalikes.length >= 12) break
    if (existingUsernames.has(inf.username)) continue

    existingUsernames.add(inf.username)
    lookalikes.push({
      id: inf.id,
      username: inf.username,
      displayName: inf.displayName,
      avatarUrl: inf.avatarUrl,
      platform: inf.platform,
      followers: inf.followers,
      engagementRate: inf.engagementRate,
      avgLikes: inf.avgLikes,
      avgComments: inf.avgComments,
      avgViews: inf.avgViews,
      email: inf.email,
      matchScore: calculateMatchScore(source, inf),
    })
  }

  // Strategy 3: Fallback — if still fewer than 5, try keyword-based search
  if (lookalikes.length < 5 && isApifyConfigured()) {
    try {
      const bio = source.bio || ''
      const bioWords = bio
        .replace(/[\n\r]/g, ' ')
        .replace(/[^\w\sáéíóúñü]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5)
      const searchQuery = bioWords.length > 0
        ? bioWords.join(' ')
        : source.displayName || source.username

      if (source.platform === 'INSTAGRAM') {
        const searchResults = await searchInstagramAccounts(searchQuery, { limit: 20 })

        for (const result of searchResults) {
          if (lookalikes.length >= 12) break
          if (!result.username || existingUsernames.has(result.username)) continue
          if (result.followers > 0 && (result.followers < minFollowers || result.followers > maxFollowers)) continue

          existingUsernames.add(result.username)
          lookalikes.push({
            id: `ext_${result.username}`,
            username: result.username,
            displayName: result.displayName,
            avatarUrl: result.avatarUrl,
            platform: source.platform,
            followers: result.followers,
            engagementRate: 0,
            avgLikes: 0,
            avgComments: 0,
            avgViews: 0,
            email: null,
            matchScore: calculateMatchScore(source, {
              followers: result.followers,
              engagementRate: 0,
              platform: source.platform,
              email: null,
            }),
          })
        }
      } else {
        // For non-Instagram: try scraping the source profile to trigger DB re-query
        const scraped = await scrapeProfile(
          source.username,
          source.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
        )

        if (scraped) {
          const additionalResults = await prisma.influencer.findMany({
            where: {
              id: { notIn: [source.id, ...lookalikes.map((l) => l.id)] },
              platform: source.platform,
              username: { notIn: Array.from(existingUsernames) },
              followers: { gte: minFollowers, lte: maxFollowers },
              engagementRate: { gte: minER, lte: maxER },
            },
            orderBy: { followers: 'asc' },
            take: 12 - lookalikes.length,
          })

          additionalResults.sort(
            (a, b) =>
              Math.abs(a.followers - source.followers) -
              Math.abs(b.followers - source.followers)
          )

          for (const inf of additionalResults) {
            if (existingUsernames.has(inf.username)) continue
            existingUsernames.add(inf.username)
            lookalikes.push({
              id: inf.id,
              username: inf.username,
              displayName: inf.displayName,
              avatarUrl: inf.avatarUrl,
              platform: inf.platform,
              followers: inf.followers,
              engagementRate: inf.engagementRate,
              avgLikes: inf.avgLikes,
              avgComments: inf.avgComments,
              avgViews: inf.avgViews,
              email: inf.email,
              matchScore: calculateMatchScore(source, inf),
            })
          }
        }
      }
    } catch (error) {
      // Apify failures are non-fatal — we still return DB results
      console.error('[Lookalikes] Apify search failed:', error)
    }
  }

  // Sort final results by match score descending
  lookalikes.sort((a, b) => b.matchScore - a.matchScore)

  return NextResponse.json({
    source: {
      id: source.id,
      username: source.username,
      platform: source.platform,
      followers: source.followers,
      engagementRate: source.engagementRate,
    },
    lookalikes,
  })
}
