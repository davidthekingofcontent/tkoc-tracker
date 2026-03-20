import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, scrapeStories } from '@/lib/apify'
import { notifyAllTeam } from '@/lib/notifications'

/**
 * Cron job endpoint: Scrape Instagram stories for all influencers in active campaigns.
 * Should be called every 4-6 hours via an external cron service (e.g., cron-job.org, Railway cron).
 *
 * Security: Uses CRON_SECRET header to authenticate.
 * Usage: GET /api/cron/stories (with header x-cron-secret)
 */
export async function GET(request: NextRequest) {
  // Verify cron secret (skip in development)
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const isConfigured = await isApifyConfiguredAsync()
    if (!isConfigured) {
      return NextResponse.json({ error: 'Apify not configured' }, { status: 400 })
    }

    // Find all active campaigns (ACTIVE or IN_PROGRESS)
    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        status: { in: ['ACTIVE'] },
        type: { in: ['INFLUENCER_TRACKING', 'UGC'] },
      },
      include: {
        influencers: {
          where: {
            status: { in: ['POSTED', 'CONTRACTED', 'AGREED'] },
          },
          include: {
            influencer: {
              select: { id: true, username: true, platform: true },
            },
          },
        },
      },
    })

    if (activeCampaigns.length === 0) {
      return NextResponse.json({ message: 'No active campaigns', storiesFound: 0 })
    }

    // Collect all Instagram usernames across campaigns
    const usernameMap = new Map<string, { influencerId: string; campaignIds: string[] }>()

    for (const campaign of activeCampaigns) {
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'INSTAGRAM') continue
        const username = ci.influencer.username
        const existing = usernameMap.get(username)
        if (existing) {
          if (!existing.campaignIds.includes(campaign.id)) {
            existing.campaignIds.push(campaign.id)
          }
        } else {
          usernameMap.set(username, {
            influencerId: ci.influencer.id,
            campaignIds: [campaign.id],
          })
        }
      }
    }

    const usernames = Array.from(usernameMap.keys())
    if (usernames.length === 0) {
      return NextResponse.json({ message: 'No Instagram influencers in active campaigns', storiesFound: 0 })
    }

    console.log(`[Cron/Stories] Scraping stories for ${usernames.length} influencers: ${usernames.join(', ')}`)

    // Scrape in batches of 20 (Apify limit)
    let totalStories = 0
    let newStories = 0

    for (let i = 0; i < usernames.length; i += 20) {
      const batch = usernames.slice(i, i + 20)
      const results = await scrapeStories(batch, 'INSTAGRAM')

      for (const result of results) {
        const mapping = usernameMap.get(result.username)
        if (!mapping) continue

        for (const story of result.stories) {
          totalStories++

          // Check if this story already exists in DB (by externalId)
          const existing = await prisma.media.findFirst({
            where: {
              externalId: story.externalId,
              platform: 'INSTAGRAM',
              mediaType: 'STORY',
            },
          })

          if (existing) continue // Skip already-tracked stories

          // Save story to DB for each campaign this influencer belongs to
          for (const campaignId of mapping.campaignIds) {
            try {
              await prisma.media.create({
                data: {
                  externalId: story.externalId,
                  platform: 'INSTAGRAM',
                  mediaType: 'STORY',
                  mediaUrl: story.mediaUrl,
                  thumbnailUrl: story.thumbnailUrl,
                  views: story.views,
                  postedAt: story.postedAt ? new Date(story.postedAt) : new Date(),
                  mentions: story.mentions,
                  hashtags: story.hashtags,
                  influencerId: mapping.influencerId,
                  campaignId,
                },
              })
              newStories++
            } catch (err) {
              // Unique constraint violation = already exists, skip
              console.log(`[Cron/Stories] Skipping duplicate story: ${story.externalId}`)
            }
          }
        }
      }
    }

    // If new stories were found, notify the team
    if (newStories > 0) {
      notifyAllTeam({
        type: 'media_posted',
        title: 'New Stories Detected',
        message: `${newStories} new Instagram stories captured from active campaigns. Check the Stories tab to see them.`,
        link: `/campaigns`,
      }).catch(() => {})
    }

    console.log(`[Cron/Stories] Done. Total: ${totalStories}, New: ${newStories}`)

    return NextResponse.json({
      success: true,
      usernamesChecked: usernames.length,
      totalStories,
      newStories,
      campaigns: activeCampaigns.length,
    })
  } catch (error) {
    console.error('[Cron/Stories] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
