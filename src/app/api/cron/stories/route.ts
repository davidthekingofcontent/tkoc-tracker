import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, isApifyExhausted, scrapeStories } from '@/lib/apify'
import { notifyAllTeam } from '@/lib/notifications'
import {
  mediaMatchesCampaignRules,
  campaignHasTargets,
  isWithinCampaignDates,
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

    // All ACTIVE campaigns, whatever their type: the rule is membership + brand
    // tag + dates (the annual "contratos" campaign is Social Listening and must
    // receive its members' stories too).
    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        status: { in: ['ACTIVE'] },
      },
      select: {
        id: true,
        name: true,
        targetAccounts: true,
        targetHashtags: true,
        startDate: true,
        endDate: true,
        influencers: {
          // Rule (1) is MEMBERSHIP, same as posts — PMs rarely move statuses
          // past Prospecto, so filtering by status silently captured nothing.
          select: {
            status: true,
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

    // Campaigns without targets can never satisfy rule (3) → skip them entirely.
    // Stories live 24h, so only campaigns whose date window includes NOW can
    // receive one (rule 2) — past/future campaigns are skipped, which also
    // keeps the pay-per-story Apify cost bounded.
    const now = new Date()
    const campaignsById = new Map<string, (typeof activeCampaigns)[number]>()
    for (const c of activeCampaigns) {
      if (!campaignHasTargets(c)) {
        console.log(`[Cron/Stories] Campaign "${c.name}" has no target accounts/hashtags — skipping`)
        continue
      }
      if (!isWithinCampaignDates(c, now)) {
        console.log(`[Cron/Stories] Campaign "${c.name}" is outside its date window today — skipping`)
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

    console.log(`[Cron/Stories] Scraping stories for ${usernames.length} influencers across ${campaignsById.size} live campaigns (pay-per-story actor): ${usernames.join(', ')}`)

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

          // One row per (story, campaign): attach the story to EVERY campaign
          // whose rules it satisfies (member + brand tag + inside dates).
          const item = scrapedStoryToRuleItem(story)
          const matchingCampaignIds = mapping.campaignIds.filter(cid => {
            const campaign = campaignsById.get(cid)
            return campaign ? mediaMatchesCampaignRules(campaign, item) : false
          })

          if (matchingCampaignIds.length === 0) {
            rejectedByRules++
            continue
          }

          for (const cid of matchingCampaignIds) {
            const already = await prisma.media.findFirst({
              where: { externalId: story.externalId, platform: 'INSTAGRAM', campaignId: cid },
              select: { id: true },
            })
            if (already) continue
            if (await upsertCampaignStory(cid, mapping.influencerId, story)) {
              newStories++
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
