import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, isApifyExhausted, isApifyOverCoreReserve, scrapeStories, STORIES_BATCH_MAX } from '@/lib/apify'
import { cronGate, cronSkipped, markCronRun } from '@/lib/cron-throttle'

/** Stories live 24 h: two scans a day catch every one of them (CRON_STORIES_MIN_HOURS overrides). */
const STORIES_DEFAULT_MIN_HOURS = Number(process.env.STORIES_MIN_INTERVAL_HOURS || 12)
import { notifyCampaignTeam, notifyApifyBudgetPauseOnce } from '@/lib/notifications'
import {
  STORIES_MAX_CAMPAIGN_DAYS,
  STORY_SCAN_STATUSES,
  campaignSpanDays,
  storiesCampaignSkipReason,
  storyMatchesCampaign,
  upsertCampaignStory,
  type StoriesSkipReason,
  type StoryVerdict,
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
    // Throttle: at most one scan per interval (server-side, independent of the caller's schedule)
    const gate = await cronGate('stories', STORIES_DEFAULT_MIN_HOURS, force)
    if (!gate.allowed) {
      console.log(`[Cron/Stories] Skipped: last scan ${gate.lastRunAt}, next allowed ${gate.nextAllowedAt} (every ${gate.minHours} h)`)
      return NextResponse.json(cronSkipped('stories', gate, { storiesFound: 0 }))
    }
    // CORE budget reserve: stories are core capture and run until 95 % of the
    // Apify plan (the old fixed 40 $ soft limit silently stopped them for two
    // weeks in Sept 2026). A pause is always visible: ADMIN alert once a day.
    const budget = await isApifyOverCoreReserve()
    if (budget.over && !force) {
      console.log(`[Cron/Stories] Skipped: Apify usage ${budget.usd} $ ≥ core reserve ${budget.coreLimit} $ (${budget.usedPct} % of the plan; cycle ends ${budget.cycleEndsAt ?? 'unknown'})`)
      await notifyApifyBudgetPauseOnce('stories', { usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt })
      return NextResponse.json({ skipped: 'apify_budget', cron: 'stories', usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt, storiesFound: 0 })
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
        type: true,
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
            status: { in: [...STORY_SCAN_STATUSES] },
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
    // The eligibility rule is shared with the watchdog (storiesCampaignSkipReason).
    // Live campaigns with confirmed creators that are NOT scanned: their team
    // is told once per reason (never a silent gap again — Oct 2026).
    const skipped: StoriesSkip[] = []
    for (const c of activeCampaigns) {
      const reason = storiesCampaignSkipReason(c, now)
      if (reason === null) {
        campaignsById.set(c.id, c)
        continue
      }
      if (reason === 'window') {
        console.log(`[Cron/Stories] Campaign "${c.name}" is outside its date window today — skipping`)
        continue
      }
      const detail = skipDetail(reason, c)
      console.log(`[Cron/Stories] Campaign "${c.name}" skipped (${reason}): ${detail}`)
      const confirmed = c.influencers.filter(ci => ci.influencer.platform === 'INSTAGRAM').length
      if (confirmed > 0) skipped.push({ id: c.id, name: c.name, reason, detail })
    }
    await notifyStoriesSkips(skipped, Array.from(campaignsById.keys()))

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
      // A completed run with nothing to scan is still a completed run (the
      // watchdog shares the eligibility rule, so it expects no work either).
      await markCronRun('stories')
      await recordStoriesRun({ at: now.toISOString(), usernamesChecked: 0, totalStories: 0, newStories: 0, newByReshare: 0, rejectedByRules: 0, campaigns: [], skipped })
      return NextResponse.json({ message: 'No confirmed Instagram creators (status Acordado or later) in live campaigns with targets', storiesFound: 0 })
    }

    console.log(`[Cron/Stories] Scraping stories for ${usernames.length} influencers across ${campaignsById.size} live campaigns (pay-per-story actor): ${usernames.join(', ')}`)

    // One actor run per STORIES_BATCH_MAX (100) usernames: the actor charges per run start
    let totalStories = 0
    let newStories = 0
    let rejectedByRules = 0
    let newByReshare = 0
    let newByLink = 0
    // New stories per campaign: each campaign's team is notified separately
    const newStoriesByCampaign = new Map<string, number>()
    await markCronRun('stories')

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
          // whose rules it satisfies (member + brand signal + inside dates).
          const matches: Array<{ cid: string; verdict: StoryVerdict }> = []
          for (const cid of mapping.campaignIds) {
            const campaign = campaignsById.get(cid)
            if (!campaign) continue
            const verdict = await storyMatchesCampaign(campaign, mapping.influencerId, story)
            if (verdict.ok) matches.push({ cid, verdict })
          }

          if (matches.length === 0) {
            rejectedByRules++
            continue
          }

          for (const { cid, verdict } of matches) {
            const already = await prisma.media.findFirst({
              where: { externalId: story.externalId, platform: 'INSTAGRAM', campaignId: cid },
              select: { id: true },
            })
            if (already) continue
            if (await upsertCampaignStory(cid, mapping.influencerId, story, verdict)) {
              newStories++
              if (verdict.via === 'reshare') newByReshare++
              if (verdict.via === 'link') newByLink++
              newStoriesByCampaign.set(cid, (newStoriesByCampaign.get(cid) || 0) + 1)
            }
          }
        }
      }
    }

    // One notification per campaign with new stories, to THAT campaign's team
    // (creator + assigned PMs) — never a global message to the whole agency.
    for (const [cid, count] of newStoriesByCampaign) {
      const name = campaignsById.get(cid)?.name || cid
      await notifyCampaignTeam(cid, {
        type: 'media_posted',
        title: 'Stories nuevas',
        message: `${count} stories nuevas capturadas en la campaña "${name}"`,
        link: `/campaigns/${cid}`,
      })
    }

    console.log(`[Cron/Stories] Done. Total: ${totalStories}, New: ${newStories} (${newByLink} via a brand link, ${newByReshare} via a shared post), Rejected by rules: ${rejectedByRules}`)
    await recordStoriesRun({
      at: now.toISOString(),
      usernamesChecked: usernames.length,
      totalStories,
      newStories,
      newByLink,
      newByReshare,
      rejectedByRules,
      campaigns: Array.from(campaignsById.values()).map(c => ({
        id: c.id,
        name: c.name,
        creators: c.influencers.filter(ci => ci.influencer.platform === 'INSTAGRAM').length,
        newStories: newStoriesByCampaign.get(c.id) || 0,
      })),
      skipped,
    })

    return NextResponse.json({
      success: true,
      usernamesChecked: usernames.length,
      totalStories,
      newStories,
      newByLink,
      newByReshare,
      rejectedByRules,
      campaigns: campaignsById.size,
      skipped: skipped.map(s => ({ name: s.name, reason: s.reason })),
    })
  } catch (error) {
    console.error('[Cron/Stories] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface StoriesSkip {
  id: string
  name: string
  reason: StoriesSkipReason
  detail: string
}

/** What the campaign team is told when its campaign is not scanned. */
function skipDetail(reason: Exclude<StoriesSkipReason, 'window'>, c: { startDate: Date; endDate: Date | null }): string {
  switch (reason) {
    case 'listening':
      return 'es una campaña de Social Listening; las stories solo se rastrean en las campañas de seguimiento de influencers y UGC.'
    case 'no_targets':
      return 'no tiene Cuentas de Marca Objetivo ni hashtags; añádelos en Configurar para que sus stories entren.'
    case 'too_long':
      return `dura ${campaignSpanDays(c) ?? '?'} días (máximo ${STORIES_MAX_CAMPAIGN_DAYS}) o no tiene fecha de fin; acorta la campaña o registra sus stories a mano.`
  }
}

/** Last run's figures, readable without Railway logs (Setting cron_stories_last_result). */
async function recordStoriesRun(summary: Record<string, unknown>): Promise<void> {
  try {
    const value = JSON.stringify(summary)
    await prisma.setting.upsert({
      where: { key: 'cron_stories_last_result' },
      update: { value },
      create: { key: 'cron_stories_last_result', value },
    })
  } catch (err) {
    console.error('[Cron/Stories] could not record the run summary:', err instanceof Error ? err.message : err)
  }
}

/**
 * One notification per campaign and reason to that campaign's team when a live
 * campaign with confirmed creators is not scanned for stories (Setting
 * stories_skip_notice_<campaignId> = reason). Cleared when the campaign is
 * scanned again, so a later exclusion notifies again. Never throws.
 */
async function notifyStoriesSkips(skipped: StoriesSkip[], scannedIds: string[]): Promise<void> {
  try {
    if (scannedIds.length > 0) {
      await prisma.setting.deleteMany({ where: { key: { in: scannedIds.map(id => `stories_skip_notice_${id}`) } } })
    }
    for (const s of skipped) {
      const key = `stories_skip_notice_${s.id}`
      const existing = await prisma.setting.findUnique({ where: { key }, select: { value: true } })
      if (existing?.value === s.reason) continue
      await prisma.setting.upsert({ where: { key }, update: { value: s.reason }, create: { key, value: s.reason } })
      await notifyCampaignTeam(s.id, {
        type: 'cron_stale',
        title: 'Stories sin rastrear',
        message: `Las stories de "${s.name}" no se están rastreando: ${s.detail}`,
        link: `/campaigns/${s.id}`,
      })
    }
  } catch (err) {
    console.error('[Cron/Stories] skip notices failed:', err instanceof Error ? err.message : err)
  }
}
