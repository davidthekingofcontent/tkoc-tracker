import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, isApifyExhausted, scrapeStories } from '@/lib/apify'
import { notifyAllTeam } from '@/lib/notifications'
import {
  mediaMatchesCampaignRules,
  campaignHasTargets,
  scrapedStoryToRuleItem,
  upsertCampaignStory,
} from '@/lib/campaign-capture'

/**
 * Cron job endpoint: Scrape Instagram stories for all influencers in active campaigns.
 * Should be called every 4-6 hours via an external cron service (e.g., cron-job.org, Railway cron).
 *
 * PRECISE CAPTURE: a story is attached to a campaign ONLY IF
 *   (1) the creator is a member of THAT campaign,
 *   (2) it is dated inside THAT campaign's [startDate, endDate],
 *   (3) its mentions[]/hashtags[] reference one of THAT campaign's targets.
 * Rules are evaluated PER CAMPAIGN when a creator belongs to several.
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
    if (isApifyExhausted()) {
      return NextResponse.json({ error: 'Apify monthly limit exhausted', storiesFound: 0 }, { status: 503 })
    }

    // Find all active campaigns (ACTIVE or IN_PROGRESS)
    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        status: { in: ['ACTIVE'] },
        type: { in: ['INFLUENCER_TRACKING', 'UGC'] },
      },
      select: {
        id: true,
        name: true,
        targetAccounts: true,
        targetHashtags: true,
        startDate: true,
        endDate: true,
        influencers: {
          where: {
            status: { in: ['POSTED', 'CONTRACTED', 'AGREED'] },
          },
          select: {
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

    // Campaigns without targets can never satisfy rule (3) → skip them entirely
    const campaignsById = new Map<string, (typeof activeCampaigns)[number]>()
    for (const c of activeCampaigns) {
      if (!campaignHasTargets(c)) {
        console.log(`[Cron/Stories] Campaign "${c.name}" has no target accounts/hashtags — skipping`)
        continue
      }
      campaignsById.set(c.id, c)
    }

    // Collect all Instagram usernames across campaigns (lowercased for matching)
    const usernameMap = new Map<string, { influencerId: string; username: string; campaignIds: string[] }>()

    for (const campaign of campaignsById.values()) {
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'INSTAGRAM') continue
        const key = ci.influencer.username.toLowerCase()
        const existing = usernameMap.get(key)
        if (existing) {
          if (!existing.campaignIds.includes(campaign.id)) {
            existing.campaignIds.push(campaign.id)
          }
        } else {
          usernameMap.set(key, {
            influencerId: ci.influencer.id,
            username: ci.influencer.username,
            campaignIds: [campaign.id],
          })
        }
      }
    }

    const usernames = Array.from(usernameMap.values()).map(m => m.username)
    if (usernames.length === 0) {
      return NextResponse.json({ message: 'No Instagram influencers in active campaigns with targets', storiesFound: 0 })
    }

    console.log(`[Cron/Stories] Scraping stories for ${usernames.length} influencers: ${usernames.join(', ')}`)

    // Scrape in batches of 20 (Apify limit)
    let totalStories = 0
    let newStories = 0
    let rejectedByRules = 0

    for (let i = 0; i < usernames.length; i += 20) {
      if (isApifyExhausted()) break
      const batch = usernames.slice(i, i + 20)
      const results = await scrapeStories(batch, 'INSTAGRAM')

      for (const result of results) {
        const mapping = usernameMap.get(result.username.toLowerCase())
        if (!mapping) continue

        for (const story of result.stories) {
          totalStories++
          if (!story.externalId) continue

          // Media has a global unique on (externalId, platform): a story can
          // belong to at most ONE campaign. Skip stories already attached; a
          // previously detached row (campaignId null) may be re-claimed.
          const existing = await prisma.media.findFirst({
            where: { externalId: story.externalId, platform: 'INSTAGRAM' },
            select: { id: true, campaignId: true },
          })
          if (existing?.campaignId) continue

          // Evaluate the rules PER CAMPAIGN; attach to the first campaign that qualifies
          const item = scrapedStoryToRuleItem(story)
          const matchingCampaignId = mapping.campaignIds.find(cid => {
            const campaign = campaignsById.get(cid)
            return campaign ? mediaMatchesCampaignRules(campaign, item) : false
          })

          if (!matchingCampaignId) {
            rejectedByRules++
            continue
          }

          if (await upsertCampaignStory(matchingCampaignId, mapping.influencerId, story)) {
            newStories++
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

    console.log(`[Cron/Stories] Done. Total: ${totalStories}, New: ${newStories}, Rejected by rules: ${rejectedByRules}`)

    return NextResponse.json({
      success: true,
      usernamesChecked: usernames.length,
      totalStories,
      newStories,
      rejectedByRules,
      campaigns: campaignsById.size,
    })
  } catch (error) {
    console.error('[Cron/Stories] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
