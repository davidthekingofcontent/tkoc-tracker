import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile, isApifyConfigured } from '@/lib/apify'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { username, platform } = body

    if (!username || !platform) {
      return NextResponse.json(
        { error: 'Username and platform are required' },
        { status: 400 }
      )
    }

    if (!Object.values(Platform).includes(platform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }

    // Clean the username (remove @ prefix, URL parts, etc.)
    let cleanUsername = username.trim()
    // Handle full URLs: https://instagram.com/username, https://tiktok.com/@username, etc.
    if (cleanUsername.includes('/')) {
      const parts = cleanUsername.split('/').filter(Boolean)
      cleanUsername = parts[parts.length - 1]
    }
    cleanUsername = cleanUsername.replace(/^@/, '')

    // Check if we already have a recent scrape (less than 24h old)
    const existing = await prisma.influencer.findUnique({
      where: { username_platform: { username: cleanUsername, platform } },
      include: {
        _count: { select: { campaigns: true, media: true } },
        media: {
          take: 12,
          orderBy: { postedAt: 'desc' },
        },
      },
    })

    const hasNoData = existing && existing.followers === 0 && existing.engagementRate === 0
    const isStale = !existing?.lastScraped ||
      (Date.now() - existing.lastScraped.getTime()) > 24 * 60 * 60 * 1000 ||
      hasNoData

    // If Apify is configured and data is stale or doesn't exist, scrape fresh data
    if (isApifyConfigured() && (!existing || isStale)) {
      try {
        // Create a scrape job record
        const job = await prisma.scrapeJob.create({
          data: {
            jobType: 'profile',
            platform,
            targetUsername: cleanUsername,
            status: 'RUNNING',
            startedAt: new Date(),
          },
        })

        const scraped = await scrapeProfile(cleanUsername, platform)

        if (scraped) {
          // Upsert the influencer with scraped data
          const influencer = await prisma.influencer.upsert({
            where: { username_platform: { username: cleanUsername, platform } },
            create: {
              username: cleanUsername,
              platform,
              displayName: scraped.displayName,
              bio: scraped.bio,
              avatarUrl: scraped.avatarUrl,
              email: scraped.email,
              website: scraped.website,
              followers: scraped.followers,
              following: scraped.following,
              postsCount: scraped.postsCount,
              engagementRate: scraped.engagementRate,
              avgLikes: scraped.avgLikes,
              avgComments: scraped.avgComments,
              avgViews: scraped.avgViews,
              isVerified: scraped.isVerified,
              country: scraped.country,
              city: scraped.city,
              lastScraped: new Date(),
            },
            update: {
              displayName: scraped.displayName,
              bio: scraped.bio,
              avatarUrl: scraped.avatarUrl,
              email: scraped.email || undefined,
              website: scraped.website || undefined,
              followers: scraped.followers,
              following: scraped.following,
              postsCount: scraped.postsCount,
              engagementRate: scraped.engagementRate,
              avgLikes: scraped.avgLikes,
              avgComments: scraped.avgComments,
              avgViews: scraped.avgViews,
              isVerified: scraped.isVerified,
              country: scraped.country || undefined,
              city: scraped.city || undefined,
              lastScraped: new Date(),
            },
            include: {
              _count: { select: { campaigns: true, media: true } },
            },
          })

          // Save recent posts as media records
          let savedMediaCount = 0
          for (const post of scraped.recentPosts) {
            if (!post.externalId) continue
            try {
              await prisma.media.upsert({
                where: {
                  externalId_platform: {
                    externalId: post.externalId,
                    platform,
                  },
                },
                create: {
                  externalId: post.externalId,
                  platform,
                  mediaType: post.mediaType,
                  caption: post.caption,
                  mediaUrl: post.mediaUrl,
                  thumbnailUrl: post.thumbnailUrl,
                  permalink: post.permalink,
                  likes: post.likes,
                  comments: post.comments,
                  shares: post.shares,
                  saves: post.saves,
                  views: post.views,
                  hashtags: post.hashtags,
                  mentions: post.mentions,
                  postedAt: post.postedAt ? new Date(post.postedAt) : null,
                  influencerId: influencer.id,
                },
                update: {
                  likes: post.likes,
                  comments: post.comments,
                  shares: post.shares,
                  saves: post.saves,
                  views: post.views,
                },
              })
              savedMediaCount++
            } catch {
              // Skip duplicate or invalid media
            }
          }

          // Update scrape job
          await prisma.scrapeJob.update({
            where: { id: job.id },
            data: {
              status: 'COMPLETED',
              itemsFound: savedMediaCount,
              completedAt: new Date(),
            },
          })

          // Re-fetch with media for the response
          const fullInfluencer = await prisma.influencer.findUnique({
            where: { id: influencer.id },
            include: {
              _count: { select: { campaigns: true, media: true } },
              media: {
                take: 12,
                orderBy: { postedAt: 'desc' },
              },
            },
          })

          return NextResponse.json({
            influencer: fullInfluencer,
            analyzed: true,
            source: 'apify',
            message: `Profile scraped successfully. Found ${savedMediaCount} posts.`,
          })
        }

        // Scraping returned null - update job as failed
        await prisma.scrapeJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            errorMessage: 'No data returned from scraper',
            completedAt: new Date(),
          },
        })
      } catch (scrapeError) {
        console.error('Apify scrape error:', scrapeError)
        // Continue to return existing data if scraping fails
      }
    }

    // If we have existing data (even if scraping failed), return it
    if (existing) {
      return NextResponse.json({
        influencer: existing,
        analyzed: true,
        source: existing.lastScraped ? 'cached' : 'database',
        message: existing.lastScraped
          ? `Showing cached data from ${existing.lastScraped.toISOString()}`
          : 'Profile data loaded from cache.',
      })
    }

    // No existing data and no Apify - create a basic record
    const newInfluencer = await prisma.influencer.create({
      data: {
        username: cleanUsername,
        platform,
      },
      include: {
        _count: { select: { campaigns: true, media: true } },
      },
    })

    return NextResponse.json({
      influencer: newInfluencer,
      analyzed: false,
      source: 'placeholder',
      message: 'Profile created. Analyzing data...',
    })
  } catch (error) {
    console.error('Analyze influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
