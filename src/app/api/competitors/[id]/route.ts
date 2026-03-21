import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile } from '@/lib/apify'

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

    const competitor = await prisma.competitorAccount.findUnique({
      where: { id },
      include: {
        posts: {
          orderBy: { postedAt: 'desc' },
          take: 30,
        },
      },
    })

    if (!competitor) {
      return NextResponse.json({ error: 'Competitor not found' }, { status: 404 })
    }

    return NextResponse.json({ competitor })
  } catch (error) {
    console.error('Error fetching competitor:', error)
    return NextResponse.json({ error: 'Failed to fetch competitor' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    await prisma.competitorAccount.delete({ where: { id } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting competitor:', error)
    return NextResponse.json({ error: 'Failed to delete competitor' }, { status: 500 })
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
    const body = await request.json()

    if (body.action !== 'refresh') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const competitor = await prisma.competitorAccount.findUnique({ where: { id } })
    if (!competitor) {
      return NextResponse.json({ error: 'Competitor not found' }, { status: 404 })
    }

    // Re-scrape profile
    const profile = await scrapeProfile(
      competitor.username,
      competitor.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
    )

    if (!profile) {
      return NextResponse.json({ error: 'Could not scrape profile' }, { status: 500 })
    }

    // Update competitor account
    const updated = await prisma.competitorAccount.update({
      where: { id },
      data: {
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        bio: profile.bio,
        followers: profile.followers,
        following: profile.following,
        postsCount: profile.postsCount,
        engagementRate: profile.engagementRate,
        avgLikes: profile.avgLikes,
        avgComments: profile.avgComments,
        avgViews: profile.avgViews,
        lastScraped: new Date(),
      },
    })

    // Upsert recent posts
    if (profile.recentPosts && profile.recentPosts.length > 0) {
      for (const post of profile.recentPosts) {
        try {
          await prisma.competitorPost.upsert({
            where: {
              externalId_platform: {
                externalId: post.externalId,
                platform: competitor.platform as Platform,
              },
            },
            update: {
              likes: post.likes,
              comments: post.comments,
              shares: post.shares,
              views: post.views,
              caption: post.caption,
              mediaUrl: post.mediaUrl,
              thumbnailUrl: post.thumbnailUrl,
            },
            create: {
              externalId: post.externalId,
              platform: competitor.platform as Platform,
              caption: post.caption,
              mediaUrl: post.mediaUrl,
              thumbnailUrl: post.thumbnailUrl,
              permalink: post.permalink,
              mediaType: post.mediaType,
              likes: post.likes,
              comments: post.comments,
              shares: post.shares,
              views: post.views,
              hashtags: post.hashtags,
              mentions: post.mentions,
              postedAt: post.postedAt ? new Date(post.postedAt) : null,
              competitorId: id,
            },
          })
        } catch (e) {
          console.log('Skipping competitor post upsert error:', (e as Error).message)
        }
      }
    }

    const result = await prisma.competitorAccount.findUnique({
      where: { id },
      include: { _count: { select: { posts: true } } },
    })

    return NextResponse.json({ competitor: result })
  } catch (error) {
    console.error('Error refreshing competitor:', error)
    return NextResponse.json({ error: 'Failed to refresh competitor' }, { status: 500 })
  }
}
