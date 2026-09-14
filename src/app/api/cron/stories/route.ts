import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, isApifyExhausted, isApifyOverSoftLimit, scrapeStories, STORIES_BATCH_MAX } from '@/lib/apify'

/** Stories live 24 h: two scans a day catch every one of them. Whatever the external scheduler does, the route refuses to run more often than this (override with ?force=1). */
const STORIES_MIN_INTERVAL_HOURS = Number(process.env.STORIES_MIN_INTERVAL_HOURS || 12)
const LAST_RUN_KEY = 'cron_stories_last_run'
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
    const force = request.nextUrl.searchParams.get('force') === '1'
    // Throttle: at most one scan per STORIES_MIN_INTERVAL_HOURS (server-side, independent of the caller's schedule)
    if (!force) {
      const last = await prisma.setting.findUnique({ where: { key: LAST_RUN_KEY } }).catch(() => null)
      const lastAt = last?.value ? Date.parse(last.value) : NaN
      const minMs = STORIES_MIN_INTERVAL_HOURS * 60 * 60 * 1000
      if (Number.isFinite(lastAt) && Date.now() - lastAt < minMs) {
        const nextAllowedAt = new Date(lastAt + minMs).toISOString()
        console.log(`[Cron/Stories] Skipped: last scan ${last?.value}, next allowed ${nextAllowedAt} (every ${STORIES_MIN_INTERVAL_HOURS} h)`)
        return NextResponse.json({ skipped: 'too_soon', lastRunAt: last?.value, nextAllowedAt, storiesFound: 0 })
      }
    }
    // Soft monthly budget: stories are the most expensive scrape (0,099 $ per run start); stop them first
    const budget = await isApifyOverSoftLimit()
    if (budget.over && !force) {
      console.log(`[Cron/Stories] Skipped: Apify usage ${budget.usd} $ ≥ soft limit ${budget.softLimit} $`)
      return NextResponse.json({ skipped: 'soft_limit', apifyUsageUsd: budget.usd, softLimitUsd: budget.softLimit, storiesFound: 0 })
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
          // Stories are scraped with a PAY-PER-STORY actor, so only creators the
          // PM has CONFIRMED (Acordado or later) are scanned. Posts still follow
          // plain membership. Story @mentions of the brand also arrive in real
          // time through the Instagram Messaging webhook (story_mention) for
          // creators of any status, once the brand's Instagram allows message
          // access to the app.
          where: {
            status: { in: ['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] },
          },
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
      console.log('[Cron/Stories] No CONFIRMED (Acordado+) Instagram creators in live campaigns — nothing scraped (PMs must set the status)')
      return NextResponse.json({ message: 'No confirmed Instagram creators (status Acordado or later) in live campaigns with targets', storiesFound: 0 })
    }

    console.log(`[Cron/Stories] Scraping stories for ${usernames.length} influencers across ${campaignsById.size} live campaigns (pay-per-story actor): ${usernames.join(', ')}`)

    // One actor run per STORIES_BATCH_MAX (100) usernames: the actor charges per run start
    let totalStories = 0
    let newStories = 0
    let rejectedByRules = 0
    await prisma.setting.upsert({ where: { key: LAST_RUN_KEY }, update: { value: new Date().toISOString() }, create: { key: LAST_RUN_KEY, value: new Date().toISOString() } }).catch(() => {})

    for (let i = 0; i < usernames.length; i += STORIES_BATCH_MAX) {
      if (isApifyExhausted()) break
      const batch = usernames.slice(i, i + STORIES_BATCH_MAX)
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
