import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { calculateWarmScore, type WarmScoreInput } from '@/lib/matching-engine'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    // 1. Load the match with its client contact and creator profile
    const match = await prisma.clientCreatorMatch.findFirst({
      where: { id, userId: session.id },
      include: {
        clientContact: true,
        creatorProfile: {
          include: {
            platformProfiles: {
              select: {
                followers: true,
                engagementRate: true,
                avgViews: true,
              },
            },
          },
        },
      },
    })

    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 })
    }

    if (match.matchStatus !== 'USER_CONFIRMED') {
      return NextResponse.json(
        { error: 'Can only calculate warm score for confirmed matches' },
        { status: 400 }
      )
    }

    // 2. Load recent creator posts to estimate posts/month
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const recentPosts = await prisma.creatorPost.findMany({
      where: {
        creatorId: match.creatorProfileId,
        postedAt: { gte: thirtyDaysAgo },
      },
      select: { id: true, isBrandCollab: true },
    })

    const postsPerMonth = recentPosts.length
    const brandCollabs = recentPosts.filter((p) => p.isBrandCollab).length
    const promotionalRatio = postsPerMonth > 0 ? brandCollabs / postsPerMonth : 0
    const hasConsistentContent = postsPerMonth >= 4

    // 3. Load brand mentions
    const brandMentions = await prisma.creatorBrandMention.findMany({
      where: { creatorId: match.creatorProfileId },
      select: { id: true },
    })

    // 4. Aggregate platform profile metrics
    const profiles = match.creatorProfile.platformProfiles
    const totalFollowers = profiles.reduce((sum, p) => sum + p.followers, 0)
    const avgEngagement =
      profiles.length > 0
        ? profiles.reduce((sum, p) => sum + p.engagementRate, 0) / profiles.length
        : 0
    const avgViews =
      profiles.length > 0
        ? profiles.reduce((sum, p) => sum + p.avgViews, 0) / profiles.length
        : 0

    // 5. Calculate the warm score
    const scoreInput: WarmScoreInput = {
      relationshipType: match.clientContact.relationshipType,
      relationshipStatus: match.clientContact.relationshipStatus,
      lastActivityAt: match.clientContact.lastActivityAt,
      followers: totalFollowers,
      engagementRate: avgEngagement,
      postsPerMonth,
      avgViews,
      confidenceScore: match.confidenceScore,
      hasMentionedBrand: brandMentions.length > 0,
      brandMentionCount: brandMentions.length,
      hasConsistentContent,
      promotionalRatio,
      nicheAlignment: 0.5, // Default — can be enriched later
      geoAlignment: false, // Default — can be enriched later
    }

    const result = calculateWarmScore(scoreInput)

    // 6. Upsert the WarmCreatorScore record
    const scoreData = {
      opportunityScore: result.opportunityScore,
      opportunityGrade: result.opportunityGrade,
      opportunityReasons: JSON.parse(JSON.stringify(result.opportunityReasons)),
      riskFlags: JSON.parse(JSON.stringify(result.riskFlags)),
      recommendedUse: result.recommendedUse,
      brandFitScore: result.brandFitScore,
      easeOfActivation: result.easeOfActivation,
      expectedResponseRate: result.expectedResponseRate,
      scoredAt: new Date(),
      scoringVersion: '1.0',
    }

    const warmScore = await prisma.warmCreatorScore.upsert({
      where: { matchId: match.id },
      create: {
        userId: session.id,
        matchId: match.id,
        creatorProfileId: match.creatorProfileId,
        ...scoreData,
      },
      update: scoreData,
    })

    return NextResponse.json({ warmScore })
  } catch (error) {
    console.error('Calculate warm score error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    // Verify the match belongs to this user
    const match = await prisma.clientCreatorMatch.findFirst({
      where: { id, userId: session.id },
    })

    if (!match) {
      return NextResponse.json({ error: 'Match not found' }, { status: 404 })
    }

    const warmScore = await prisma.warmCreatorScore.findUnique({
      where: { matchId: id },
    })

    if (!warmScore) {
      return NextResponse.json(
        { error: 'Warm score not yet calculated for this match' },
        { status: 404 }
      )
    }

    return NextResponse.json({ warmScore })
  } catch (error) {
    console.error('Get warm score error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
