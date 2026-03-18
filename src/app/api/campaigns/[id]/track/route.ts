import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeHashtag, scrapeProfile, isApifyConfigured } from '@/lib/apify'
import { Platform } from '@/generated/prisma/client'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!isApifyConfigured()) {
      return NextResponse.json(
        { error: 'Apify is not configured. Add APIFY_API_KEY to enable tracking.' },
        { status: 400 }
      )
    }

    const { id } = await params

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        influencers: {
          include: { influencer: true },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (campaign.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'Campaign must be active to track' },
        { status: 400 }
      )
    }

    const results = {
      hashtagsScraped: 0,
      postsFound: 0,
      influencersFound: 0,
      errors: [] as string[],
    }

    // Track hashtags
    for (const hashtag of campaign.targetHashtags) {
      for (const platform of campaign.platforms) {
        try {
          const job = await prisma.scrapeJob.create({
            data: {
              jobType: 'hashtag',
              platform,
              targetUsername: hashtag,
              campaignId: id,
              status: 'RUNNING',
              startedAt: new Date(),
            },
          })

          const hashtagResults = await scrapeHashtag(hashtag, platform, 30)
          results.hashtagsScraped++

          let postsInThisBatch = 0

          for (const result of hashtagResults) {
            if (!result.authorUsername) continue

            try {
              // Upsert the influencer
              const influencer = await prisma.influencer.upsert({
                where: {
                  username_platform: {
                    username: result.authorUsername,
                    platform,
                  },
                },
                create: {
                  username: result.authorUsername,
                  platform,
                  displayName: result.authorDisplayName,
                  avatarUrl: result.authorAvatarUrl,
                  followers: result.authorFollowers,
                },
                update: {
                  ...(result.authorDisplayName && { displayName: result.authorDisplayName }),
                  ...(result.authorAvatarUrl && { avatarUrl: result.authorAvatarUrl }),
                  ...(result.authorFollowers > 0 && { followers: result.authorFollowers }),
                },
              })

              // Link influencer to campaign if not already linked
              await prisma.campaignInfluencer.upsert({
                where: {
                  campaignId_influencerId: {
                    campaignId: id,
                    influencerId: influencer.id,
                  },
                },
                create: {
                  campaignId: id,
                  influencerId: influencer.id,
                },
                update: {},
              })

              // Save the posts
              for (const post of result.posts) {
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
                      campaignId: id,
                    },
                    update: {
                      likes: post.likes,
                      comments: post.comments,
                      shares: post.shares,
                      saves: post.saves,
                      views: post.views,
                      campaignId: id,
                    },
                  })
                  postsInThisBatch++
                } catch {
                  // Skip invalid media
                }
              }

              results.influencersFound++
            } catch {
              // Skip individual influencer errors
            }
          }

          results.postsFound += postsInThisBatch

          await prisma.scrapeJob.update({
            where: { id: job.id },
            data: {
              status: 'COMPLETED',
              itemsFound: postsInThisBatch,
              completedAt: new Date(),
            },
          })
        } catch (err) {
          const errorMsg = `Failed to scrape ${hashtag} on ${platform}: ${err instanceof Error ? err.message : 'Unknown error'}`
          results.errors.push(errorMsg)
          console.error(errorMsg)
        }
      }
    }

    // Also refresh profiles of campaign influencers
    const existingInfluencers = campaign.influencers || []
    for (const ci of existingInfluencers) {
      const inf = ci.influencer
      const isStale = !inf.lastScraped || (Date.now() - inf.lastScraped.getTime()) > 24 * 60 * 60 * 1000

      if (isStale) {
        try {
          const scraped = await scrapeProfile(inf.username, inf.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
          if (scraped) {
            await prisma.influencer.update({
              where: { id: inf.id },
              data: {
                displayName: scraped.displayName,
                bio: scraped.bio,
                avatarUrl: scraped.avatarUrl,
                followers: scraped.followers,
                following: scraped.following,
                postsCount: scraped.postsCount,
                engagementRate: scraped.engagementRate,
                avgLikes: scraped.avgLikes,
                avgComments: scraped.avgComments,
                avgViews: scraped.avgViews,
                isVerified: scraped.isVerified,
                lastScraped: new Date(),
              },
            })
          }
        } catch {
          // Skip profile refresh errors
        }
      }
    }

    return NextResponse.json({
      message: 'Tracking completed',
      results,
    })
  } catch (error) {
    console.error('Track campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
