import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile } from '@/lib/apify'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const competitors = await prisma.competitorAccount.findMany({
      include: {
        _count: {
          select: { posts: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ competitors })
  } catch (error) {
    console.error('Error fetching competitors:', error)
    return NextResponse.json({ error: 'Failed to fetch competitors' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { username, platform } = body

    if (!username || !platform) {
      return NextResponse.json({ error: 'Username and platform are required' }, { status: 400 })
    }

    if (!Object.values(Platform).includes(platform as Platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    // Clean username
    const cleanUsername = username.replace(/^@/, '').trim()

    // Check if already exists
    const existing = await prisma.competitorAccount.findUnique({
      where: { username_platform: { username: cleanUsername, platform: platform as Platform } },
    })

    if (existing) {
      return NextResponse.json({ error: 'Competitor already exists', competitor: existing }, { status: 409 })
    }

    // Scrape profile
    const profile = await scrapeProfile(cleanUsername, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')

    if (!profile) {
      return NextResponse.json({ error: 'Could not find profile. Check the username and try again.' }, { status: 404 })
    }

    // Create competitor account
    const competitor = await prisma.competitorAccount.create({
      data: {
        username: cleanUsername,
        platform: platform as Platform,
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

    // Save recent posts
    if (profile.recentPosts && profile.recentPosts.length > 0) {
      for (const post of profile.recentPosts) {
        try {
          await prisma.competitorPost.create({
            data: {
              externalId: post.externalId,
              platform: platform as Platform,
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
              competitorId: competitor.id,
            },
          })
        } catch (e) {
          // Skip duplicate posts
          console.log('Skipping duplicate competitor post:', (e as Error).message)
        }
      }
    }

    // Return with posts count
    const result = await prisma.competitorAccount.findUnique({
      where: { id: competitor.id },
      include: { _count: { select: { posts: true } } },
    })

    return NextResponse.json({ competitor: result }, { status: 201 })
  } catch (error) {
    console.error('Error adding competitor:', error)
    return NextResponse.json({ error: 'Failed to add competitor' }, { status: 500 })
  }
}
