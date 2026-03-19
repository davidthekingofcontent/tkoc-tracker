import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeHashtag, scrapeProfile, scrapeStories, isApifyConfigured, detectCountry } from '@/lib/apify'
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
      postsFilteredByCountry: 0,
      influencersFound: 0,
      storiesCaptured: 0,
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

              // Country filtering: if campaign has a country set, check influencer's country
              if (campaign.country) {
                // Try to detect country from the influencer's existing DB data
                let influencerCountry = influencer.country

                // If no country in DB yet, try to detect from a quick profile scrape
                if (!influencerCountry) {
                  try {
                    const profileData = await scrapeProfile(
                      result.authorUsername,
                      platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
                    )
                    if (profileData?.country) {
                      influencerCountry = profileData.country
                      await prisma.influencer.update({
                        where: { id: influencer.id },
                        data: { country: profileData.country, city: profileData.city },
                      })
                    }
                  } catch {
                    // If profile scrape fails, keep influencerCountry as null
                  }
                }

                // If we know the influencer's country and it doesn't match, skip their posts
                if (influencerCountry && influencerCountry !== campaign.country) {
                  results.postsFilteredByCountry += result.posts.length
                  continue // Skip to next influencer
                }
              }

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

    // ===== STORY CAPTURE =====
    // Capture Instagram Stories from all campaign influencers
    const instagramInfluencers = existingInfluencers
      .filter(ci => ci.influencer.platform === 'INSTAGRAM')
      .map(ci => ci.influencer)

    if (instagramInfluencers.length > 0) {
      try {
        const storyJob = await prisma.scrapeJob.create({
          data: {
            jobType: 'stories',
            platform: 'INSTAGRAM' as Platform,
            targetUsername: instagramInfluencers.map(i => i.username).join(','),
            campaignId: id,
            status: 'RUNNING',
            startedAt: new Date(),
          },
        })

        const storyResults = await scrapeStories(
          instagramInfluencers.map(i => i.username),
          'INSTAGRAM'
        )

        let storiesInBatch = 0

        for (const storyResult of storyResults) {
          // Find the matching influencer
          const matchingInf = instagramInfluencers.find(
            i => i.username.toLowerCase() === storyResult.username.toLowerCase()
          )
          if (!matchingInf) continue

          for (const story of storyResult.stories) {
            try {
              await prisma.media.upsert({
                where: {
                  externalId_platform: {
                    externalId: story.externalId,
                    platform: 'INSTAGRAM' as Platform,
                  },
                },
                create: {
                  externalId: story.externalId,
                  platform: 'INSTAGRAM' as Platform,
                  mediaType: 'STORY',
                  mediaUrl: story.mediaUrl,
                  thumbnailUrl: story.thumbnailUrl,
                  views: story.views,
                  mentions: story.mentions,
                  hashtags: story.hashtags,
                  postedAt: story.postedAt ? new Date(story.postedAt) : null,
                  influencerId: matchingInf.id,
                  campaignId: id,
                },
                update: {
                  views: story.views,
                  campaignId: id,
                },
              })
              storiesInBatch++
            } catch {
              // Skip duplicate/invalid stories
            }
          }
        }

        results.storiesCaptured = storiesInBatch

        await prisma.scrapeJob.update({
          where: { id: storyJob.id },
          data: {
            status: 'COMPLETED',
            itemsFound: storiesInBatch,
            completedAt: new Date(),
          },
        })
      } catch (err) {
        const errorMsg = `Failed to scrape stories: ${err instanceof Error ? err.message : 'Unknown error'}`
        results.errors.push(errorMsg)
        console.error(errorMsg)
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
