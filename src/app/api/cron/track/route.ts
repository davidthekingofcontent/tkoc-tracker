import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { scrapeHashtag, scrapeStories, isApifyConfigured } from '@/lib/apify'

export interface CronTrackingResults {
  campaignsProcessed: number
  totalPostsFound: number
  storiesCaptured: number
  errors: string[]
}

/**
 * Core tracking logic extracted for reuse by both the HTTP endpoint and
 * the instrumentation auto-tracker.
 */
export async function runCronTracking(): Promise<CronTrackingResults> {
  if (!isApifyConfigured()) {
    throw new Error('Apify not configured')
  }

  // Find all active campaigns with hashtags to track
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      targetHashtags: { isEmpty: false },
    },
  })

  // Also find campaigns with influencers for story tracking
  const campaignsWithInfluencers = await prisma.campaign.findMany({
    where: { status: 'ACTIVE' },
    include: {
      influencers: {
        include: { influencer: { select: { username: true, platform: true } } },
      },
    },
  })

  const results: CronTrackingResults = {
    campaignsProcessed: 0,
    totalPostsFound: 0,
    storiesCaptured: 0,
    errors: [],
  }

  for (const campaign of campaigns) {
    try {
      for (const hashtag of campaign.targetHashtags) {
        for (const platform of campaign.platforms) {
          try {
            const job = await prisma.scrapeJob.create({
              data: {
                jobType: 'cron-hashtag',
                platform,
                targetUsername: hashtag,
                campaignId: campaign.id,
                status: 'RUNNING',
                startedAt: new Date(),
              },
            })

            const hashtagResults = await scrapeHashtag(hashtag, platform, 20)
            let postsFound = 0

            for (const result of hashtagResults) {
              if (!result.authorUsername) continue

              try {
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

                await prisma.campaignInfluencer.upsert({
                  where: {
                    campaignId_influencerId: {
                      campaignId: campaign.id,
                      influencerId: influencer.id,
                    },
                  },
                  create: {
                    campaignId: campaign.id,
                    influencerId: influencer.id,
                  },
                  update: {},
                })

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
                        campaignId: campaign.id,
                      },
                      update: {
                        likes: post.likes,
                        comments: post.comments,
                        shares: post.shares,
                        saves: post.saves,
                        views: post.views,
                        campaignId: campaign.id,
                      },
                    })
                    postsFound++
                  } catch {
                    // Skip
                  }
                }
              } catch {
                // Skip
              }
            }

            await prisma.scrapeJob.update({
              where: { id: job.id },
              data: {
                status: 'COMPLETED',
                itemsFound: postsFound,
                completedAt: new Date(),
              },
            })

            results.totalPostsFound += postsFound
          } catch (err) {
            results.errors.push(`${campaign.name}: ${hashtag}@${platform} - ${err instanceof Error ? err.message : 'Error'}`)
          }
        }
      }
      results.campaignsProcessed++
    } catch (err) {
      results.errors.push(`Campaign ${campaign.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  // Story tracking for campaigns with Instagram influencers
  for (const campaign of campaignsWithInfluencers) {
    const igInfluencers = campaign.influencers.filter(ci => ci.influencer.platform === 'INSTAGRAM')
    if (igInfluencers.length === 0) continue

    try {
      const usernames = igInfluencers.map(ci => ci.influencer.username)
      const storyResults = await scrapeStories(usernames, 'INSTAGRAM')

      for (const sr of storyResults) {
        const influencer = await prisma.influencer.findFirst({
          where: { username: sr.username, platform: 'INSTAGRAM' },
        })
        if (!influencer) continue

        for (const story of sr.stories) {
          try {
            await prisma.media.upsert({
              where: {
                externalId_platform: { externalId: story.externalId, platform: 'INSTAGRAM' },
              },
              create: {
                externalId: story.externalId,
                platform: 'INSTAGRAM',
                mediaType: 'STORY',
                mediaUrl: story.mediaUrl,
                thumbnailUrl: story.thumbnailUrl,
                views: story.views,
                mentions: story.mentions,
                hashtags: story.hashtags,
                postedAt: story.postedAt ? new Date(story.postedAt) : null,
                influencerId: influencer.id,
                campaignId: campaign.id,
              },
              update: {
                views: story.views,
                campaignId: campaign.id,
              },
            })
            results.storiesCaptured++
          } catch { /* skip duplicate */ }
        }
      }
    } catch (err) {
      results.errors.push(`Stories ${campaign.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }

  return results
}

// This endpoint can be called by a cron job (e.g., Railway cron, Vercel cron, or external)
// Secure with a secret key
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET || process.env.JWT_SECRET

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const results = await runCronTracking()

    return NextResponse.json({
      message: 'Cron tracking completed',
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('Cron track error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
