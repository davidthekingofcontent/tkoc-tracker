import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Prisma, Platform } from '@/generated/prisma/client'
import { REAL_PROFILE_WHERE } from '@/lib/creator-pool'

// POST /api/discovery/search — search the creator pool (CreatorProfile).
// Only creators with at least one platform profile that passes
// REAL_PROFILE_WHERE (followers > 0) are listed: the hashtag shells created
// by the old discovery cron never reach the "Base de datos" tab.
export async function POST(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const {
    query,
    platform,
    minFollowers,
    maxFollowers,
    spainFitLevel,
    category,
    city,
    province,
    sortBy = 'followers',
    sortDir = 'desc',
    offset = 0,
    limit = 50,
  } = body

  // Build WHERE conditions for CreatorProfile
  const creatorWhere: Prisma.CreatorProfileWhereInput = {
    isSuppressed: false,
  }

  // Spain Fit Level filter
  if (spainFitLevel && spainFitLevel !== 'all') {
    creatorWhere.spainFitLevel = spainFitLevel
  }

  // Category filter: match creators with CategorySignal rows OR category in their categories array
  if (category) {
    const categoryCondition: Prisma.CreatorProfileWhereInput = {
      OR: [
        { categorySignals: { some: { category } } },
        { categories: { has: category } },
      ],
    }
    if (!creatorWhere.AND) creatorWhere.AND = []
    ;(creatorWhere.AND as Prisma.CreatorProfileWhereInput[]).push(categoryCondition)
  }

  // City filter
  if (city) {
    creatorWhere.geoCity = { contains: city, mode: 'insensitive' }
  }

  // Province filter
  if (province) {
    creatorWhere.geoProvince = { contains: province, mode: 'insensitive' }
  }

  // Platform filter, followers range and text search go through platformProfiles.
  // The gate is always on: whatever the other filters, a listed creator needs
  // one REAL platform profile (REAL_PROFILE_WHERE) matching platform/followers.
  const platformProfileWhere: Prisma.CreatorPlatformProfileWhereInput = { ...REAL_PROFILE_WHERE }

  if (platform && platform !== 'all') {
    const p = platform.toUpperCase() as Platform
    if (['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(p)) {
      platformProfileWhere.platform = p
    }
  }

  // Followers range (merged with the followers > 0 gate)
  if (minFollowers && minFollowers > 0) {
    platformProfileWhere.followers = {
      ...(platformProfileWhere.followers as Prisma.IntFilter ?? {}),
      gte: Number(minFollowers),
    }
  }
  if (maxFollowers && maxFollowers > 0) {
    platformProfileWhere.followers = {
      ...(platformProfileWhere.followers as Prisma.IntFilter ?? {}),
      lte: Number(maxFollowers),
    }
  }

  // Creators that have at least one real platform profile matching the filters
  // (kept even when a text query is added below, so the displayName branch
  // stays inside the gate too). The count uses this same where.
  creatorWhere.platformProfiles = { some: platformProfileWhere }

  // Text search: displayName on the creator, username/bio on the platform
  // profile — the profile branch carries the full platform/followers gate.
  if (query && query.trim()) {
    const q = query.trim()
    if (!creatorWhere.AND) creatorWhere.AND = []
    ;(creatorWhere.AND as Prisma.CreatorProfileWhereInput[]).push({
      OR: [
        { displayName: { contains: q, mode: 'insensitive' } },
        {
          platformProfiles: {
            some: {
              ...platformProfileWhere,
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { bio: { contains: q, mode: 'insensitive' } },
              ],
            },
          },
        },
      ],
    })
  }

  // Determine sort
  type SortableField = 'spainFitScore' | 'performanceScore' | 'createdAt'
  const validCreatorSorts: SortableField[] = ['spainFitScore', 'performanceScore', 'createdAt']
  let orderBy: Prisma.CreatorProfileOrderByWithRelationInput = { createdAt: 'desc' }

  if (validCreatorSorts.includes(sortBy as SortableField)) {
    orderBy = { [sortBy]: sortDir === 'asc' ? 'asc' : 'desc' }
  }
  // For followers/engagementRate, we sort on the platform profile level after fetch
  const needsClientSort = ['followers', 'engagementRate'].includes(sortBy)

  // Count total
  const total = await prisma.creatorProfile.count({ where: creatorWhere })

  // Fetch with extra limit if we need client sort
  const fetchLimit = needsClientSort ? Math.min(total, 500) : limit
  const fetchOffset = needsClientSort ? 0 : offset

  const creators = await prisma.creatorProfile.findMany({
    where: creatorWhere,
    include: {
      platformProfiles: {
        orderBy: { followers: 'desc' },
      },
      categorySignals: {
        orderBy: { confidence: 'desc' },
        take: 5,
      },
    },
    orderBy: needsClientSort ? undefined : orderBy,
    take: fetchLimit,
    skip: fetchOffset,
  })

  // Map to response format
  let results = creators.map((c) => {
    const primaryProfile = c.platformProfiles[0]
    return {
      id: c.id,
      displayName: c.displayName,
      primaryPlatform: c.primaryPlatform,
      spainFitScore: c.spainFitScore,
      spainFitLevel: c.spainFitLevel,
      categories: c.categories,
      categorySignals: c.categorySignals.map((cs) => ({
        category: cs.category,
        confidence: cs.confidence,
      })),
      geoCity: c.geoCity,
      geoProvince: c.geoProvince,
      geoCountry: c.geoCountry,
      performanceScore: c.performanceScore,
      platformProfiles: c.platformProfiles.map((pp) => ({
        id: pp.id,
        platform: pp.platform,
        username: pp.username,
        followers: pp.followers,
        engagementRate: pp.engagementRate,
        avgViews: pp.avgViews,
        avgLikes: pp.avgLikes,
        avatarUrl: pp.avatarUrl,
        bio: pp.bio,
        isVerified: pp.isVerified,
      })),
      // Flatten the primary profile for convenience
      username: primaryProfile?.username ?? '',
      platform: primaryProfile?.platform ?? c.primaryPlatform,
      followers: primaryProfile?.followers ?? 0,
      engagementRate: primaryProfile?.engagementRate ?? 0,
      avgViews: primaryProfile?.avgViews ?? 0,
      avgLikes: primaryProfile?.avgLikes ?? 0,
      avatarUrl: primaryProfile?.avatarUrl,
    }
  })

  // Client-side sort for followers/engagementRate
  if (needsClientSort) {
    results.sort((a, b) => {
      const aVal = sortBy === 'followers' ? a.followers : a.engagementRate
      const bVal = sortBy === 'followers' ? b.followers : b.engagementRate
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal
    })
    results = results.slice(offset, offset + limit)
  }

  return NextResponse.json({
    results,
    total,
    offset,
    limit,
    hasMore: offset + limit < total,
  })
}

// GET /api/discovery/search — returns filter options from actual data
export async function GET(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get available categories from SpainCategory table
  const categories = await prisma.spainCategory.findMany({
    orderBy: { nameEs: 'asc' },
  })

  // Get distinct cities and provinces
  const citiesRaw = await prisma.creatorProfile.findMany({
    where: { geoCity: { not: null } },
    select: { geoCity: true },
    distinct: ['geoCity'],
    take: 200,
  })

  const provincesRaw = await prisma.creatorProfile.findMany({
    where: { geoProvince: { not: null } },
    select: { geoProvince: true },
    distinct: ['geoProvince'],
    take: 100,
  })

  // Get Spain Fit level counts
  const levelCounts = await prisma.creatorProfile.groupBy({
    by: ['spainFitLevel'],
    _count: true,
    where: { isSuppressed: false },
  })

  // Group categories by parent
  const categoryGroups: Record<string, Array<{ slug: string; nameEs: string; nameEn: string }>> = {}
  for (const cat of categories) {
    const parent = cat.parentSlug || 'other'
    if (!categoryGroups[parent]) categoryGroups[parent] = []
    categoryGroups[parent].push({ slug: cat.slug, nameEs: cat.nameEs, nameEn: cat.nameEn })
  }

  return NextResponse.json({
    categories: categoryGroups,
    cities: citiesRaw.map((c) => c.geoCity).filter(Boolean).sort(),
    provinces: provincesRaw.map((p) => p.geoProvince).filter(Boolean).sort(),
    spainFitLevels: levelCounts.map((l) => ({
      level: l.spainFitLevel,
      count: l._count,
    })),
  })
}
