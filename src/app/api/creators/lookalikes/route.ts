import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import {
  isApifyConfigured,
  scrapeProfile,
  scrapeInstagramSimilarAccounts,
} from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceData {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  categories: string[]
  primaryCategory: string | null
  spainFitLevel: string | null
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  brandNames: string[]
}

interface LookalikeResult {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  matchScore: number
  matchReasons: string[]
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
  source: 'creator_profile' | 'influencer' | 'apify'
  profileUrl: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProfileUrl(username: string, platform: string): string {
  switch (platform.toUpperCase()) {
    case 'TIKTOK':
      return `https://tiktok.com/@${username}`
    case 'YOUTUBE':
      return `https://youtube.com/@${username}`
    default:
      return `https://instagram.com/${username}`
  }
}

function scoreCategoryMatch(
  source: SourceData,
  candidateCategories: string[],
  candidatePrimary: string | null
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Same primaryCategory: +20
  if (
    source.primaryCategory &&
    candidatePrimary &&
    source.primaryCategory.toLowerCase() === candidatePrimary.toLowerCase()
  ) {
    score += 20
    reasons.push(`Misma categoria: ${candidatePrimary}`)
  }

  // Overlapping categories: +5 each, max 15
  const sourceSet = new Set(source.categories.map((c) => c.toLowerCase()))
  let overlap = 0
  for (const cat of candidateCategories) {
    if (sourceSet.has(cat.toLowerCase())) overlap++
  }
  const catBonus = Math.min(15, overlap * 5)
  score += catBonus
  if (overlap > 0 && !reasons.length) {
    reasons.push(`${overlap} categorias en comun`)
  }

  return { score: Math.min(35, score), reasons }
}

function scoreFollowerSimilarity(
  sourceFollowers: number,
  candidateFollowers: number
): { score: number; reasons: string[] } {
  if (sourceFollowers <= 0 || candidateFollowers <= 0) return { score: 0, reasons: [] }
  const ratio =
    Math.min(sourceFollowers, candidateFollowers) /
    Math.max(sourceFollowers, candidateFollowers)
  const score = Math.round(ratio * 20)
  const reasons: string[] = []
  if (ratio > 0.5) reasons.push('Seguidores similares')
  return { score, reasons }
}

function scoreEngagementSimilarity(
  sourceER: number,
  candidateER: number
): { score: number; reasons: string[] } {
  if (sourceER <= 0 && candidateER <= 0) return { score: 0, reasons: [] }
  const diff = Math.abs(sourceER - candidateER)
  const score = Math.max(0, Math.round(15 - (diff / 6) * 15))
  const reasons: string[] = []
  if (score >= 10) reasons.push('Engagement similar')
  return { score, reasons }
}

function scoreGeoMatch(
  source: SourceData,
  candidateCity: string | null,
  candidateProvince: string | null,
  candidateCountry: string | null
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  if (source.geoCity && candidateCity && source.geoCity.toLowerCase() === candidateCity.toLowerCase()) {
    score += 10
    reasons.push(`Misma ciudad: ${candidateCity}`)
    if (
      source.geoProvince &&
      candidateProvince &&
      source.geoProvince.toLowerCase() === candidateProvince.toLowerCase()
    ) {
      score += 5
    }
  } else if (
    source.geoProvince &&
    candidateProvince &&
    source.geoProvince.toLowerCase() === candidateProvince.toLowerCase()
  ) {
    score += 8
    reasons.push(`Misma provincia: ${candidateProvince}`)
  } else if (
    source.geoCountry &&
    candidateCountry &&
    source.geoCountry.toLowerCase() === candidateCountry.toLowerCase()
  ) {
    score += 5
    reasons.push(`Mismo pais: ${candidateCountry}`)
  }

  return { score: Math.min(15, score), reasons }
}

function scoreBrandOverlap(
  sourceBrands: string[],
  candidateBrands: string[]
): { score: number; reasons: string[] } {
  const sourceSet = new Set(sourceBrands.map((b) => b.toLowerCase()))
  let overlaps = 0
  for (const b of candidateBrands) {
    if (sourceSet.has(b.toLowerCase())) overlaps++
  }
  const score = Math.min(10, overlaps * 3)
  const reasons: string[] = []
  if (overlaps > 0) reasons.push(`${overlaps} marcas en comun`)
  return { score, reasons }
}

function scoreSpainFitAlignment(
  sourceLevel: string | null,
  candidateLevel: string | null
): { score: number; reasons: string[] } {
  if (
    sourceLevel &&
    candidateLevel &&
    sourceLevel.toLowerCase() === candidateLevel.toLowerCase() &&
    sourceLevel.toLowerCase() !== 'unknown'
  ) {
    return { score: 5, reasons: ['Mismo Spain Fit'] }
  }
  return { score: 0, reasons: [] }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { handle, platform: rawPlatform, creatorId } = body as {
      handle?: string
      platform?: string
      creatorId?: string
    }

    const platform = ((rawPlatform || 'INSTAGRAM').toUpperCase()) as Platform
    if (!['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    const cleanHandle = (handle || '').replace(/^@/, '').trim()
    if (!cleanHandle && !creatorId) {
      return NextResponse.json({ error: 'handle or creatorId is required' }, { status: 400 })
    }

    // ===================================================================
    // Stage A: Resolve the source creator
    // ===================================================================

    let sourceData: SourceData | null = null

    // A1: Try by creatorId
    if (creatorId) {
      const cp = await prisma.creatorProfile.findUnique({
        where: { id: creatorId },
        include: {
          platformProfiles: true,
          categorySignals: true,
          brandMentions: true,
          geoSignals: true,
        },
      })
      if (cp) {
        const pp = cp.platformProfiles.find((p) => p.platform === platform) || cp.platformProfiles[0]
        sourceData = {
          id: cp.id,
          username: pp?.username || cleanHandle,
          displayName: cp.displayName || pp?.username || null,
          avatarUrl: pp?.avatarUrl || null,
          platform,
          followers: pp?.followers || 0,
          engagementRate: pp?.engagementRate || 0,
          categories: cp.categories,
          primaryCategory: cp.primaryCategory,
          spainFitLevel: cp.spainFitLevel,
          geoCity: cp.geoCity,
          geoProvince: cp.geoProvince,
          geoCountry: cp.geoCountry,
          brandNames: cp.brandMentions.map((bm) => bm.brandName),
        }
      }
    }

    // A2: Try by handle in CreatorPlatformProfile
    if (!sourceData && cleanHandle) {
      const pp = await prisma.creatorPlatformProfile.findUnique({
        where: { platform_username: { platform, username: cleanHandle } },
        include: {
          creator: {
            include: {
              categorySignals: true,
              brandMentions: true,
              geoSignals: true,
            },
          },
        },
      })
      if (pp) {
        const cp = pp.creator
        sourceData = {
          id: cp.id,
          username: pp.username,
          displayName: cp.displayName || pp.username,
          avatarUrl: pp.avatarUrl,
          platform,
          followers: pp.followers,
          engagementRate: pp.engagementRate,
          categories: cp.categories,
          primaryCategory: cp.primaryCategory,
          spainFitLevel: cp.spainFitLevel,
          geoCity: cp.geoCity,
          geoProvince: cp.geoProvince,
          geoCountry: cp.geoCountry,
          brandNames: cp.brandMentions.map((bm) => bm.brandName),
        }
      }
    }

    // A3: Try the old Influencer table
    if (!sourceData && cleanHandle) {
      const inf = await prisma.influencer.findFirst({
        where: {
          username: { equals: cleanHandle, mode: 'insensitive' },
          platform,
        },
      })
      if (inf) {
        sourceData = {
          id: inf.id,
          username: inf.username,
          displayName: inf.displayName || inf.username,
          avatarUrl: inf.avatarUrl || null,
          platform,
          followers: inf.followers,
          engagementRate: inf.engagementRate,
          categories: [],
          primaryCategory: null,
          spainFitLevel: null,
          geoCity: inf.city || null,
          geoProvince: null,
          geoCountry: inf.country || null,
          brandNames: [],
        }
      }
    }

    // A4: Scrape via Apify if not found
    if (!sourceData && cleanHandle && isApifyConfigured()) {
      try {
        const scraped = await scrapeProfile(cleanHandle, platform)
        if (scraped) {
          await enrichCreatorFull(scraped, platform)
          // Try to retrieve the newly created CreatorProfile
          const pp = await prisma.creatorPlatformProfile.findUnique({
            where: { platform_username: { platform, username: scraped.username } },
            include: {
              creator: {
                include: {
                  categorySignals: true,
                  brandMentions: true,
                  geoSignals: true,
                },
              },
            },
          })
          if (pp) {
            const cp = pp.creator
            sourceData = {
              id: cp.id,
              username: pp.username,
              displayName: cp.displayName || pp.username,
              avatarUrl: pp.avatarUrl,
              platform,
              followers: pp.followers,
              engagementRate: pp.engagementRate,
              categories: cp.categories,
              primaryCategory: cp.primaryCategory,
              spainFitLevel: cp.spainFitLevel,
              geoCity: cp.geoCity,
              geoProvince: cp.geoProvince,
              geoCountry: cp.geoCountry,
              brandNames: cp.brandMentions.map((bm) => bm.brandName),
            }
          } else {
            // Fallback: use scraped data directly
            sourceData = {
              id: `ext_${scraped.username}`,
              username: scraped.username,
              displayName: scraped.displayName,
              avatarUrl: scraped.avatarUrl,
              platform,
              followers: scraped.followers,
              engagementRate: scraped.engagementRate,
              categories: [],
              primaryCategory: null,
              spainFitLevel: null,
              geoCity: scraped.city || null,
              geoProvince: null,
              geoCountry: scraped.country || null,
              brandNames: [],
            }
          }
        }
      } catch (err) {
        console.error('[Lookalikes] Apify scrape failed:', err)
      }
    }

    if (!sourceData) {
      return NextResponse.json({ source: null, lookalikes: [] })
    }

    // ===================================================================
    // Stage B: Find lookalikes using CreatorProfile (new system)
    // ===================================================================

    const allLookalikes: LookalikeResult[] = []
    const seenUsernames = new Set<string>([sourceData.username.toLowerCase()])
    const seenIds = new Set<string>([sourceData.id])

    const sourceFollowers = sourceData.followers || 1000
    const minFollowers = Math.floor(sourceFollowers * 0.1)
    const maxFollowers = Math.ceil(sourceFollowers * 10)

    // Build where clause for candidates
    const candidates = await prisma.creatorProfile.findMany({
      where: {
        id: { not: sourceData.id },
        isSuppressed: false,
        OR: [
          ...(sourceData.categories.length > 0
            ? [{ categories: { hasSome: sourceData.categories } }]
            : []),
          ...(sourceData.primaryCategory
            ? [{ primaryCategory: sourceData.primaryCategory }]
            : []),
          {
            platformProfiles: {
              some: {
                platform,
                followers: { gte: minFollowers, lte: maxFollowers },
              },
            },
          },
        ],
      },
      include: {
        platformProfiles: {
          where: { platform },
        },
        brandMentions: true,
      },
      take: 200,
    })

    for (const candidate of candidates) {
      const pp =
        candidate.platformProfiles.find((p) => p.platform === platform) ||
        candidate.platformProfiles[0]
      if (!pp) continue

      const uLower = pp.username.toLowerCase()
      if (seenUsernames.has(uLower)) continue
      seenUsernames.add(uLower)
      seenIds.add(candidate.id)

      const candidateBrands = candidate.brandMentions.map((bm) => bm.brandName)

      // Scoring
      const cat = scoreCategoryMatch(sourceData, candidate.categories, candidate.primaryCategory)
      const fol = scoreFollowerSimilarity(sourceFollowers, pp.followers)
      const eng = scoreEngagementSimilarity(sourceData.engagementRate, pp.engagementRate)
      const geo = scoreGeoMatch(sourceData, candidate.geoCity, candidate.geoProvince, candidate.geoCountry)
      const brand = scoreBrandOverlap(sourceData.brandNames, candidateBrands)
      const spain = scoreSpainFitAlignment(sourceData.spainFitLevel, candidate.spainFitLevel)

      const totalScore = cat.score + fol.score + eng.score + geo.score + brand.score + spain.score
      const allReasons = [
        ...cat.reasons,
        ...fol.reasons,
        ...eng.reasons,
        ...geo.reasons,
        ...brand.reasons,
        ...spain.reasons,
      ]

      if (totalScore < 10) continue

      allLookalikes.push({
        id: candidate.id,
        username: pp.username,
        displayName: candidate.displayName || pp.username,
        avatarUrl: pp.avatarUrl,
        platform,
        followers: pp.followers,
        engagementRate: pp.engagementRate,
        matchScore: Math.min(100, totalScore),
        matchReasons: allReasons,
        categories: candidate.categories,
        spainFitLevel: candidate.spainFitLevel,
        geoCity: candidate.geoCity,
        source: 'creator_profile',
        profileUrl: getProfileUrl(pp.username, platform),
      })
    }

    // ===================================================================
    // Stage C: Supplement with Influencer table if < 10 results
    // ===================================================================

    if (allLookalikes.length < 10) {
      const infCandidates = await prisma.influencer.findMany({
        where: {
          platform,
          username: { notIn: Array.from(seenUsernames) },
          followers: {
            gte: Math.floor(sourceFollowers * 0.2),
            lte: Math.ceil(sourceFollowers * 5),
          },
          ...(sourceData.engagementRate > 0
            ? {
                engagementRate: {
                  gte: Math.max(0, sourceData.engagementRate - 3),
                  lte: sourceData.engagementRate + 3,
                },
              }
            : {}),
        },
        take: 50,
        orderBy: { followers: 'desc' },
      })

      for (const inf of infCandidates) {
        if (allLookalikes.length >= 20) break
        const uLower = inf.username.toLowerCase()
        if (seenUsernames.has(uLower)) continue
        seenUsernames.add(uLower)

        const fol = scoreFollowerSimilarity(sourceFollowers, inf.followers)
        const eng = scoreEngagementSimilarity(sourceData.engagementRate, inf.engagementRate)

        const rawScore = fol.score + eng.score
        // Cap old-system results at 60
        const totalScore = Math.min(60, rawScore)
        const allReasons = [...fol.reasons, ...eng.reasons]

        if (totalScore < 10) continue

        allLookalikes.push({
          id: inf.id,
          username: inf.username,
          displayName: inf.displayName || inf.username,
          avatarUrl: inf.avatarUrl,
          platform: inf.platform,
          followers: inf.followers,
          engagementRate: inf.engagementRate,
          matchScore: totalScore,
          matchReasons: allReasons.length > 0 ? allReasons : ['Seguidores similares'],
          categories: [],
          spainFitLevel: null,
          geoCity: inf.city || null,
          source: 'influencer',
          profileUrl: getProfileUrl(inf.username, inf.platform),
        })
      }
    }

    // ===================================================================
    // Stage D: Supplement with Apify if < 5 results AND Instagram
    // ===================================================================

    if (allLookalikes.length < 5 && platform === 'INSTAGRAM' && isApifyConfigured()) {
      try {
        const similarAccounts = await scrapeInstagramSimilarAccounts(cleanHandle || sourceData.username)

        for (const account of similarAccounts) {
          if (allLookalikes.length >= 20) break
          if (!account.username) continue
          const uLower = account.username.toLowerCase()
          if (seenUsernames.has(uLower)) continue
          seenUsernames.add(uLower)

          const fol = scoreFollowerSimilarity(sourceFollowers, account.followers)
          // Cap Apify results at 50
          const totalScore = Math.min(50, fol.score + 15) // +15 base for being IG-suggested
          const reasons: string[] = ['Sugerido por Instagram']
          if (fol.reasons.length > 0) reasons.push(...fol.reasons)

          allLookalikes.push({
            id: `ext_${account.username}`,
            username: account.username,
            displayName: account.displayName || account.username,
            avatarUrl: account.avatarUrl,
            platform: 'INSTAGRAM',
            followers: account.followers,
            engagementRate: 0,
            matchScore: totalScore,
            matchReasons: reasons,
            categories: [],
            spainFitLevel: null,
            geoCity: null,
            source: 'apify',
            profileUrl: getProfileUrl(account.username, 'INSTAGRAM'),
          })
        }
      } catch (err) {
        console.error('[Lookalikes] Apify similar accounts failed:', err)
      }
    }

    // Sort by score DESC, return top 20
    allLookalikes.sort((a, b) => b.matchScore - a.matchScore)
    const topResults = allLookalikes.slice(0, 20)

    return NextResponse.json({
      source: {
        id: sourceData.id,
        username: sourceData.username,
        displayName: sourceData.displayName,
        avatarUrl: sourceData.avatarUrl,
        platform: sourceData.platform,
        followers: sourceData.followers,
        engagementRate: sourceData.engagementRate,
        categories: sourceData.categories,
        spainFitLevel: sourceData.spainFitLevel,
        geoCity: sourceData.geoCity,
      },
      lookalikes: topResults,
    })
  } catch (error) {
    console.error('[Lookalikes] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
