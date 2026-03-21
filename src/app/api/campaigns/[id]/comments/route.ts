import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeComments } from '@/lib/apify'
import { analyzeSentiment } from '@/lib/sentiment'
import { Platform } from '@/generated/prisma/client'

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
    const { searchParams } = new URL(request.url)
    const mediaIdFilter = searchParams.get('mediaId')

    // Get all media for campaign
    const mediaWhere = mediaIdFilter
      ? { id: mediaIdFilter, campaignId: id }
      : { campaignId: id }

    const mediaIds = await prisma.media.findMany({
      where: mediaWhere,
      select: { id: true },
    })

    if (mediaIds.length === 0) {
      return NextResponse.json({
        stats: { positive: 0, negative: 0, neutral: 0, total: 0, avgScore: 0 },
        topPositive: [],
        topNegative: [],
        comments: [],
      })
    }

    const ids = mediaIds.map((m) => m.id)

    // Get all comments for these media
    const comments = await prisma.comment.findMany({
      where: { mediaId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        media: {
          select: {
            id: true,
            permalink: true,
            caption: true,
            influencer: {
              select: { username: true, displayName: true },
            },
          },
        },
      },
    })

    // Calculate stats
    const positive = comments.filter((c) => c.sentiment === 'positive').length
    const negative = comments.filter((c) => c.sentiment === 'negative').length
    const neutral = comments.filter((c) => c.sentiment === 'neutral').length
    const total = comments.length
    const avgScore = total > 0
      ? parseFloat(
          (comments.reduce((sum, c) => sum + (c.sentimentScore || 0), 0) / total).toFixed(3)
        )
      : 0

    // Top positive and negative
    const topPositive = comments
      .filter((c) => c.sentiment === 'positive')
      .sort((a, b) => (b.sentimentScore || 0) - (a.sentimentScore || 0) || b.likes - a.likes)
      .slice(0, 5)

    const topNegative = comments
      .filter((c) => c.sentiment === 'negative')
      .sort((a, b) => (a.sentimentScore || 0) - (b.sentimentScore || 0) || b.likes - a.likes)
      .slice(0, 5)

    return NextResponse.json({
      stats: { positive, negative, neutral, total, avgScore },
      topPositive,
      topNegative,
      comments,
    })
  } catch (error) {
    console.error('Error fetching comments:', error)
    return NextResponse.json(
      { error: 'Failed to fetch comments' },
      { status: 500 }
    )
  }
}

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

    // Get all media with permalinks for this campaign
    const mediaList = await prisma.media.findMany({
      where: {
        campaignId: id,
        permalink: { not: null },
      },
      select: {
        id: true,
        permalink: true,
        platform: true,
        externalId: true,
      },
    })

    if (mediaList.length === 0) {
      return NextResponse.json(
        { error: 'No media with permalinks found for this campaign' },
        { status: 404 }
      )
    }

    // Group media by platform
    const mediaByPlatform = new Map<Platform, typeof mediaList>()
    for (const m of mediaList) {
      const existing = mediaByPlatform.get(m.platform) || []
      existing.push(m)
      mediaByPlatform.set(m.platform, existing)
    }

    let totalNew = 0
    let totalAnalyzed = 0

    for (const [platform, platformMedia] of mediaByPlatform.entries()) {
      const urls = platformMedia
        .map((m) => m.permalink!)
        .filter(Boolean)

      if (urls.length === 0) continue

      // Scrape comments
      const scrapedComments = await scrapeComments(urls, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', 50)

      // Map scraped comments to media IDs (best effort: use the first media for now)
      // In practice, Apify returns comments with post reference
      for (const comment of scrapedComments) {
        const sentimentResult = analyzeSentiment(comment.text)
        totalAnalyzed++

        // Try to find the matching media for this comment
        // Default to first media if we can't match
        const targetMedia = platformMedia[0]

        try {
          await prisma.comment.upsert({
            where: {
              externalId_platform: {
                externalId: comment.externalId,
                platform,
              },
            },
            create: {
              externalId: comment.externalId,
              platform,
              text: comment.text,
              authorUsername: comment.authorUsername,
              authorAvatarUrl: comment.authorAvatarUrl,
              likes: comment.likes,
              replies: comment.replies,
              sentiment: sentimentResult.sentiment,
              sentimentScore: sentimentResult.score,
              postedAt: comment.postedAt ? new Date(comment.postedAt) : null,
              mediaId: targetMedia.id,
            },
            update: {
              text: comment.text,
              likes: comment.likes,
              replies: comment.replies,
              sentiment: sentimentResult.sentiment,
              sentimentScore: sentimentResult.score,
            },
          })
          totalNew++
        } catch (err) {
          console.error('Error saving comment:', err)
        }
      }
    }

    return NextResponse.json({
      success: true,
      totalAnalyzed,
      totalSaved: totalNew,
      mediaCount: mediaList.length,
    })
  } catch (error) {
    console.error('Error scraping comments:', error)
    return NextResponse.json(
      { error: 'Failed to scrape comments' },
      { status: 500 }
    )
  }
}
