import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

// GET /api/discovery/creators/[id] — full creator profile with all relations
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const creator = await prisma.creatorProfile.findUnique({
    where: { id },
    include: {
      platformProfiles: true,
      posts: {
        orderBy: { postedAt: 'desc' },
        take: 20,
      },
      brandMentions: {
        orderBy: { detectedAt: 'desc' },
        take: 50,
      },
      geoSignals: {
        orderBy: { confidence: 'desc' },
      },
      categorySignals: {
        orderBy: { confidence: 'desc' },
      },
      scores: {
        orderBy: { calculatedAt: 'desc' },
      },
      snapshots: {
        orderBy: { capturedAt: 'desc' },
        take: 30,
      },
    },
  })

  if (!creator) {
    return NextResponse.json({ error: 'Creator not found' }, { status: 404 })
  }

  if (creator.isSuppressed) {
    return NextResponse.json({ error: 'Creator data suppressed' }, { status: 410 })
  }

  // Get the Spain Fit score record for breakdown
  const spainFitScore = creator.scores.find((s) => s.scoreType === 'spain_fit')

  // Deduplicate brand mentions by brand name
  const uniqueBrands = new Map<string, typeof creator.brandMentions[0]>()
  for (const bm of creator.brandMentions) {
    const key = bm.brandName.toLowerCase()
    if (!uniqueBrands.has(key) || bm.confidence > (uniqueBrands.get(key)?.confidence ?? 0)) {
      uniqueBrands.set(key, bm)
    }
  }

  return NextResponse.json({
    id: creator.id,
    displayName: creator.displayName,
    primaryPlatform: creator.primaryPlatform,
    spainFitScore: creator.spainFitScore,
    spainFitLevel: creator.spainFitLevel,
    categories: creator.categories,
    primaryCategory: creator.primaryCategory,
    primaryLanguage: creator.primaryLanguage,
    geoCity: creator.geoCity,
    geoProvince: creator.geoProvince,
    geoCountry: creator.geoCountry,
    geoConfidence: creator.geoConfidence,
    contactEmail: creator.contactEmail,
    websiteUrl: creator.websiteUrl,
    performanceScore: creator.performanceScore,
    riskLevel: creator.riskLevel,
    dataQualityScore: creator.dataQualityScore,
    creatorType: creator.creatorType,
    isVerifiedCreator: creator.isVerifiedCreator,
    lastEnriched: creator.lastEnriched,
    createdAt: creator.createdAt,

    platformProfiles: creator.platformProfiles.map((pp) => ({
      id: pp.id,
      platform: pp.platform,
      username: pp.username,
      followers: pp.followers,
      following: pp.following,
      postsCount: pp.postsCount,
      engagementRate: pp.engagementRate,
      avgViews: pp.avgViews,
      avgLikes: pp.avgLikes,
      avgComments: pp.avgComments,
      medianViews: pp.medianViews,
      bio: pp.bio,
      avatarUrl: pp.avatarUrl,
      isVerified: pp.isVerified,
      lastScraped: pp.lastScraped,
      dataSource: pp.dataSource,
    })),

    posts: creator.posts.map((p) => ({
      id: p.id,
      platform: p.platform,
      mediaType: p.mediaType,
      caption: p.caption?.substring(0, 200),
      likes: p.likes,
      comments: p.comments,
      views: p.views,
      shares: p.shares,
      saves: p.saves,
      permalink: p.permalink,
      thumbnailUrl: p.thumbnailUrl,
      postedAt: p.postedAt,
      hashtags: p.hashtags,
      isBrandCollab: p.isBrandCollab,
      detectedBrand: p.detectedBrand,
    })),

    brandMentions: Array.from(uniqueBrands.values()).map((bm) => ({
      brandName: bm.brandName,
      platform: bm.platform,
      mentionType: bm.mentionType,
      confidence: bm.confidence,
      detectedAt: bm.detectedAt,
    })),

    geoSignals: creator.geoSignals.map((gs) => ({
      signalType: gs.signalType,
      value: gs.value,
      confidence: gs.confidence,
      source: gs.source,
    })),

    categorySignals: creator.categorySignals.map((cs) => ({
      category: cs.category,
      confidence: cs.confidence,
      source: cs.source,
    })),

    spainFitBreakdown: spainFitScore
      ? {
          score: spainFitScore.score,
          signal: spainFitScore.signal,
          explanation: spainFitScore.explanation,
          components: spainFitScore.components,
          confidence: spainFitScore.confidence,
          isInferred: spainFitScore.isInferred,
          calculatedAt: spainFitScore.calculatedAt,
        }
      : null,

    scoreRecords: creator.scores.map((s) => ({
      scoreType: s.scoreType,
      score: s.score,
      signal: s.signal,
      explanation: s.explanation,
      confidence: s.confidence,
      calculatedAt: s.calculatedAt,
    })),

    snapshots: creator.snapshots.map((s) => ({
      platform: s.platform,
      followers: s.followers,
      engagementRate: s.engagementRate,
      avgViews: s.avgViews,
      capturedAt: s.capturedAt,
    })),
  })
}
