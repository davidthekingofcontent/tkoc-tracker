import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { scrapeHashtag, scrapeAccountMentions, scrapeStories, isApifyConfigured, detectCountry } from '@/lib/apify'
import { searchVideos as ytSearchVideos, isYouTubeApiConfigured } from '@/lib/youtube-api'

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export interface CronTrackingResults {
  campaignsProcessed: number
  totalPostsFound: number
  storiesCaptured: number
  errors: string[]
}

import type { HashtagResult } from '@/lib/apify'

/**
 * Adapter: search YouTube videos by hashtag and return HashtagResult-compatible format.
 * Uses YouTube Data API search endpoint (100 quota units per call).
 */
async function getYouTubeHashtagResults(hashtag: string): Promise<HashtagResult[]> {
  try {
    const cleanTag = hashtag.replace(/^#/, '')
    const videos = await ytSearchVideos(`#${cleanTag}`, 20)
    if (!videos.length) return []

    // YouTube search doesn't give author info per video, group by channel ID approach
    // For now, return each video as its own result with minimal author info
    return videos.map(video => ({
      posts: [video],
      authorUsername: '', // Will be populated via channel lookup if needed
      authorDisplayName: null,
      authorAvatarUrl: null,
      authorFollowers: 0,
    }))
  } catch (error) {
    console.warn(`[Cron/Track] YouTube hashtag search failed for #${hashtag}:`, error)
    return []
  }
}

/**
 * Core tracking logic extracted for reuse by both the HTTP endpoint and
 * the instrumentation auto-tracker.
 */
export async function runCronTracking(): Promise<CronTrackingResults> {
  if (!isApifyConfigured()) {
    throw new Error('Apify not configured')
  }

  // Find all active campaigns with hashtags OR accounts to track
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { targetHashtags: { isEmpty: false } },
        { targetAccounts: { isEmpty: false } },
      ],
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

  // Helper: process scraped results for a campaign
  async function processResults(
    scrapedResults: HashtagResult[],
    campaign: typeof campaigns[0],
    platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
    source: string
  ): Promise<number> {
    let postsFound = 0
    const campaignStartDate = campaign.startDate ? new Date(campaign.startDate) : null

    for (const result of scrapedResults) {
      if (!result.authorUsername) continue

      try {
        const influencer = await prisma.influencer.upsert({
          where: {
            username_platform: { username: result.authorUsername, platform },
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

        // Country filtering
        if (campaign.country) {
          let influencerCountry = influencer.country

          if (!influencerCountry && result.authorCountry) {
            influencerCountry = result.authorCountry
            await prisma.influencer.update({
              where: { id: influencer.id },
              data: { country: result.authorCountry },
            })
          }

          if (!influencerCountry) {
            const postData = result.posts[0]
            if (postData) {
              const postAsAny = postData as unknown as Record<string, unknown>
              const detectedFromPost = detectCountry({
                locationName: (postAsAny.locationName as string) || '',
                location: (postAsAny.location as string) || '',
                biography: postData.caption || '',
              })
              if (detectedFromPost) {
                influencerCountry = detectedFromPost
                await prisma.influencer.update({
                  where: { id: influencer.id },
                  data: { country: detectedFromPost },
                })
              }
            }
          }

          // Skip if country doesn't match
          if (influencerCountry && influencerCountry !== campaign.country) {
            continue
          }

          // If still no country detected but campaign requires one,
          // skip by default (strict filtering) unless language heuristics allow it
          if (!influencerCountry) {
            const caption = result.posts[0]?.caption || ''
            // Non-latin script patterns — always skip these regardless of target country
            const nonLatinPatterns = [
              /[\u0400-\u04FF]/, // Cyrillic (Russian, etc.)
              /[\u4E00-\u9FFF]/, // Chinese
              /[\u3040-\u309F\u30A0-\u30FF]/, // Japanese
              /[\uAC00-\uD7AF]/, // Korean
              /[\u0600-\u06FF]/, // Arabic
              /[\u0E00-\u0E7F]/, // Thai
              /[\u0900-\u097F]/, // Hindi/Devanagari
            ]
            if (nonLatinPatterns.some(p => p.test(caption))) {
              continue // Skip non-latin-script content
            }

            // For Spanish campaigns, allow latin-script content through (could be Spanish)
            // For all other countries, skip unknown-country content
            if (campaign.country !== 'ES') {
              continue // Strict: skip content with no country detected
            }
          }
        }

        const campaignInfluencerResult = await prisma.campaignInfluencer.upsert({
          where: {
            campaignId_influencerId: {
              campaignId: campaign.id,
              influencerId: influencer.id,
            },
          },
          create: {
            campaignId: campaign.id,
            influencerId: influencer.id,
            ...(influencer.followers >= 1000 ? { status: 'PROSPECT' as const } : {}),
          },
          update: {},
        })

        // Notify on new creator discovery
        const isNewlyCreated = (Date.now() - new Date(campaignInfluencerResult.createdAt).getTime()) < 5000
        if (isNewlyCreated && influencer.followers >= 1000) {
          try {
            await prisma.notification.create({
              data: {
                userId: campaign.userId,
                type: 'creator_discovered',
                title: 'Nuevo creador descubierto',
                message: `🔍 @${influencer.username} (${formatFollowers(influencer.followers)}) descubierto via ${source} en ${campaign.name}`,
                link: `/campaigns/${campaign.id}`,
              },
            })
          } catch { /* skip */ }
        }

        for (const post of result.posts) {
          if (!post.externalId) continue

          // Date filter: skip posts older than campaign start date
          if (campaignStartDate && post.postedAt) {
            const postDate = new Date(post.postedAt)
            if (postDate < campaignStartDate) continue
          }

          try {
            await prisma.media.upsert({
              where: {
                externalId_platform: { externalId: post.externalId, platform },
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
          } catch { /* skip duplicate */ }
        }
      } catch { /* skip */ }
    }
    return postsFound
  }

  for (const campaign of campaigns) {
    try {
      // ===== 1. HASHTAG TRACKING =====
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

            const hashtagResults = (platform === 'YOUTUBE' && isYouTubeApiConfigured())
              ? await getYouTubeHashtagResults(hashtag)
              : await scrapeHashtag(hashtag, platform, 30)

            const postsFound = await processResults(hashtagResults, campaign, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', `#${hashtag}`)

            await prisma.scrapeJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETED', itemsFound: postsFound, completedAt: new Date() },
            })
            results.totalPostsFound += postsFound
          } catch (err) {
            results.errors.push(`${campaign.name}: ${hashtag}@${platform} - ${err instanceof Error ? err.message : 'Error'}`)
          }
        }
      }

      // ===== 2. ACCOUNT MENTIONS TRACKING (tagged posts) =====
      for (const account of campaign.targetAccounts) {
        for (const platform of campaign.platforms) {
          try {
            const job = await prisma.scrapeJob.create({
              data: {
                jobType: 'cron-mentions',
                platform,
                targetUsername: account,
                campaignId: campaign.id,
                status: 'RUNNING',
                startedAt: new Date(),
              },
            })

            const mentionResults = await scrapeAccountMentions(account, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', 50)
            const postsFound = await processResults(mentionResults, campaign, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', `@${account}`)

            await prisma.scrapeJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETED', itemsFound: postsFound, completedAt: new Date() },
            })
            results.totalPostsFound += postsFound
          } catch (err) {
            results.errors.push(`${campaign.name}: @${account}@${platform} - ${err instanceof Error ? err.message : 'Error'}`)
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
