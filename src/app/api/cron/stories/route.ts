import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkApifyAuth, isApifyConfiguredAsync, isApifyExhausted, isApifyOverCoreReserve, scrapeStoriesDetailed, STORIES_BATCH_MAX } from '@/lib/apify'
import { cronGate, cronSkipped, markCronRun, restoreCronRun, markCronFailed, cronFailedRecently, GATE_SLACK_MS } from '@/lib/cron-throttle'

/** After a failed scan (which may have been charged) the next attempt waits at least this long, whoever ticks. */
const STORIES_RETRY_FLOOR_MS = 3 * 60 * 60 * 1000 + 50 * 60 * 1000

/** Stories live 24 h: two scans a day catch every one of them (CRON_STORIES_MIN_HOURS overrides). */
const STORIES_DEFAULT_MIN_HOURS = Number(process.env.STORIES_MIN_INTERVAL_HOURS || 12)
import { campaignTeamUserIds, notifyCampaignTeam, notifyApifyBudgetPauseOnce, notifyApifyTokenRejectedOnce, notifyStoriesScanFailedOnce } from '@/lib/notifications'
import {
  STORY_SCAN_STATUSES,
  storiesCampaignSkipReason,
  storyMatchesCampaign,
  upsertCampaignStory,
  type StoryVerdict,
} from '@/lib/campaign-capture'
import {
  noConfirmedNoticeDue,
  parseStoriesNotice,
  serializeStoriesNotice,
  storiesNoticeDetail,
  storiesNoticeDue,
  storiesNoticeKey,
  type StoriesNoticeReason,
} from '@/lib/stories-notices'

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

  // What the catch needs to undo a stamp written for a scan that then broke
  let stamped = false
  let previousRunAt: string | null = null
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
    const gate = await cronGate('stories', STORIES_DEFAULT_MIN_HOURS, force, GATE_SLACK_MS)
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
    // Rejected token (revoked or rotated by Apify): nothing can be read. Do
    // NOT stamp the run — a scan that cannot start is not a scan, and stories
    // die in 24 h — tell the ADMINs and let the next tick try again.
    if ((await checkApifyAuth(true)) === 'rejected') {
      console.error('[Cron/Stories] NOT RUN: Apify rejects the token (401). Replace APIFY_API_KEY; the next tick retries.')
      await notifyApifyTokenRejectedOnce()
      await recordStoriesRun({ at: new Date().toISOString(), failed: true, reason: 'apify_token', totalStories: 0, newStories: 0 })
      return NextResponse.json({ error: 'Apify rejects the token', skipped: 'apify_token', cron: 'stories', storiesFound: 0 }, { status: 503 })
    }
    // Retry floor: a scan that failed a moment ago (and may have been charged)
    // is not repeated by every scheduler tick
    if (!force) {
      const failedAt = await cronFailedRecently('stories', STORIES_RETRY_FLOOR_MS)
      if (failedAt) {
        console.log(`[Cron/Stories] Skipped: the last attempt failed at ${failedAt}; retrying no sooner than ${Math.round(STORIES_RETRY_FLOOR_MS / 60000)} min after it`)
        return NextResponse.json({ skipped: 'recent_failure', cron: 'stories', failedAt, storiesFound: 0 })
      }
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
        targetKeywords: true,
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
        // ALL its Instagram creators, whatever their status: the N of «0 de N en
        // Acordado o posterior» (the list above holds only the confirmed ones)
        _count: { select: { influencers: { where: { influencer: { platform: 'INSTAGRAM' } } } } },
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
    // Live campaigns with confirmed creators that are NOT scanned, and scanned
    // campaigns with NO confirmed creator three days after their start: their
    // team and the ADMINs are told, and told again every 7 days while it lasts
    // (never a silent gap again — Oct 2026; weekly since 16 Nov 2026).
    const skipped: StoriesSkip[] = []
    const notices: StoriesNotice[] = []
    for (const c of activeCampaigns) {
      const reason = storiesCampaignSkipReason(c, now)
      const confirmed = c.influencers.filter(ci => ci.influencer.platform === 'INSTAGRAM').length
      const instagramCreators = c._count.influencers
      if (reason === null) {
        campaignsById.set(c.id, c)
        if (noConfirmedNoticeDue(c, { confirmedCreators: confirmed, instagramCreators }, now)) {
          const detail = storiesNoticeDetail('no_confirmed', c, { instagramCreators })
          console.log(`[Cron/Stories] Campaign "${c.name}" has nobody to scan (no_confirmed): ${detail}`)
          notices.push({ id: c.id, name: c.name, reason: 'no_confirmed', detail })
        }
        continue
      }
      if (reason === 'window') {
        console.log(`[Cron/Stories] Campaign "${c.name}" is outside its date window today — skipping`)
        continue
      }
      const detail = storiesNoticeDetail(reason, c)
      console.log(`[Cron/Stories] Campaign "${c.name}" skipped (${reason}): ${detail}`)
      if (confirmed > 0) {
        skipped.push({ id: c.id, name: c.name, reason, detail })
        notices.push({ id: c.id, name: c.name, reason, detail })
      }
    }
    const noticesSent = await notifyStoriesNotices(notices, Array.from(campaignsById.keys()), now)

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
      await recordStoriesRun({
        at: now.toISOString(),
        usernamesChecked: 0,
        totalStories: 0,
        newStories: 0,
        newByReshare: 0,
        rejectedByRules: 0,
        // The eligible campaigns, each with nobody to read (the Stories tab reads this per campaign)
        campaigns: Array.from(campaignsById.values()).map(c => ({ id: c.id, name: c.name, creators: 0, newStories: 0 })),
        skipped,
        noticesSent,
      })
      return NextResponse.json({
        message: 'No confirmed Instagram creators (status Acordado or later) in live campaigns with targets',
        storiesFound: 0,
        skipped: skipped.map(s => ({ name: s.name, reason: s.reason })),
        noticesSent,
      })
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
    previousRunAt = gate.lastRunAt
    await markCronRun('stories')
    stamped = true

    let partial = false
    // Every batch that is not read to the end counts as failed, also the ones
    // never started because the monthly limit tripped mid-scan
    const expectedBatches = Math.ceil(usernames.length / STORIES_BATCH_MAX)
    let readBatches = 0
    for (let i = 0; i < usernames.length; i += STORIES_BATCH_MAX) {
      if (isApifyExhausted()) break
      const batch = usernames.slice(i, i + STORIES_BATCH_MAX)
      const scrape = await scrapeStoriesDetailed(batch, 'INSTAGRAM')
      if (scrape.partial) partial = true
      // A scrape that could not be done returns an empty list too: it is not
      // counted as read, so it is never reported as "nobody has stories"
      if (!scrape.failed) readBatches++
      const results = scrape.results

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

    // FAILED scan (no batch could be read): it does not count as a run. Put the
    // previous stamp back so the next tick (4 h) retries instead of waiting 12 h
    // behind a scan that never happened, and tell the ADMINs. Never silent.
    const failedBatches = expectedBatches - readBatches
    if (failedBatches > 0) {
      // What was read is already saved and its teams notified above; the
      // scan as a whole is repeated on a later tick
      stamped = false
      await restoreCronRun('stories', previousRunAt)
      await markCronFailed('stories')
      const tokenRejected = (await checkApifyAuth()) === 'rejected'
      const reason = tokenRejected ? 'apify_token' : isApifyExhausted() ? 'apify_exhausted' : 'actors_failed'
      console.error(`[Cron/Stories] FAILED: ${failedBatches} of ${expectedBatches} batches could not be read (${reason}). Not counted as a run; retried on a later tick.`)
      if (tokenRejected) await notifyApifyTokenRejectedOnce()
      else await notifyStoriesScanFailedOnce()
      await recordStoriesRun({
        at: now.toISOString(),
        failed: true,
        reason,
        failedBatches,
        usernamesChecked: usernames.length,
        totalStories,
        newStories,
        skipped,
        noticesSent,
      })
      return NextResponse.json({ error: 'Stories scan failed', failed: true, reason, failedBatches, usernamesChecked: usernames.length, storiesFound: totalStories, newStories }, { status: 502 })
    }

    console.log(`[Cron/Stories] Done. Total: ${totalStories}${partial ? ' (PARTIAL: the actor run had not finished)' : ''}, New: ${newStories} (${newByLink} via a brand link, ${newByReshare} via a shared post), Rejected by rules: ${rejectedByRules}`)
    await recordStoriesRun({
      at: now.toISOString(),
      usernamesChecked: usernames.length,
      partial,
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
      noticesSent,
    })

    return NextResponse.json({
      success: true,
      usernamesChecked: usernames.length,
      totalStories,
      newStories,
      newByLink,
      newByReshare,
      rejectedByRules,
      partial,
      campaigns: campaignsById.size,
      skipped: skipped.map(s => ({ name: s.name, reason: s.reason })),
      noticesSent,
    })
  } catch (error) {
    console.error('[Cron/Stories] Error:', error)
    // The stamp was written for a scan that then broke (database error, an
    // unexpected actor payload, the monthly limit tripping mid-scan): put the
    // previous one back and tell the ADMINs, or the next ticks would answer
    // "too soon" for 12 h behind a scan that never finished.
    if (stamped) {
      await restoreCronRun('stories', previousRunAt)
      await markCronFailed('stories')
      await notifyStoriesScanFailedOnce()
      await recordStoriesRun({ at: new Date().toISOString(), failed: true, reason: 'exception', detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** A live campaign with confirmed creators left out of the scan (cron_stories_last_result.skipped) */
interface StoriesSkip {
  id: string
  name: string
  reason: Exclude<StoriesNoticeReason, 'no_confirmed'>
  detail: string
}

/** A campaign whose team is told «Stories sin rastrear»: a skip, or a scan with nobody confirmed */
interface StoriesNotice {
  id: string
  name: string
  reason: StoriesNoticeReason
  detail: string
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
 * «Stories sin rastrear»: one notification per campaign to that campaign's
 * team AND to the active ADMINs (each person once) when a live campaign with
 * confirmed creators is not scanned, or when a scanned campaign has nobody in
 * Acordado or later three days after its start. Setting
 * stories_skip_notice_<campaignId> holds { reason, at }: the notice is sent
 * again when the reason changes and every 7 days while it persists (until 16
 * Nov 2026 it was sent once per reason and the gap stayed silent for weeks).
 * The setting is removed when the campaign is scanned with somebody to read,
 * so a later exclusion notifies at once. Returns what was sent this run.
 * Never throws.
 */
async function notifyStoriesNotices(
  notices: StoriesNotice[],
  scannedIds: string[],
  now: Date
): Promise<Array<{ id: string; name: string; reason: StoriesNoticeReason }>> {
  const sent: Array<{ id: string; name: string; reason: StoriesNoticeReason }> = []
  try {
    const pending = new Set(notices.map(n => n.id))
    const cleared = scannedIds.filter(id => !pending.has(id))
    if (cleared.length > 0) {
      await prisma.setting.deleteMany({ where: { key: { in: cleared.map(storiesNoticeKey) } } })
    }
    if (notices.length === 0) return sent
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })
    for (const n of notices) {
      const key = storiesNoticeKey(n.id)
      const existing = await prisma.setting.findUnique({ where: { key }, select: { value: true } })
      if (!storiesNoticeDue(parseStoriesNotice(existing?.value), n.reason, now)) continue
      // Team (creator of the campaign + assigned staff) and ADMINs, deduped
      const recipients = new Set<string>([...(await campaignTeamUserIds(n.id)), ...admins.map(a => a.id)])
      if (recipients.size === 0) continue // nobody active to tell: tried again next tick
      const value = serializeStoriesNotice(n.reason, now)
      await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
      await prisma.notification.createMany({
        data: Array.from(recipients).map(userId => ({
          userId,
          type: 'cron_stale',
          title: 'Stories sin rastrear',
          message: `Las stories de "${n.name}" no se están rastreando: ${n.detail}`,
          link: `/campaigns/${n.id}`,
        })),
      })
      sent.push({ id: n.id, name: n.name, reason: n.reason })
      console.log(`[Cron/Stories] «Stories sin rastrear» sent for "${n.name}" (${n.reason}) to ${recipients.size} people; next in 7 days if it persists`)
    }
  } catch (err) {
    console.error('[Cron/Stories] skip notices failed:', err instanceof Error ? err.message : err)
  }
  return sent
}
