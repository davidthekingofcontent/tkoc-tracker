import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { acquireCronLock, cronGate, cronInFlight, cronLockHeldSince, cronSkipped, markCronRun, releaseCronLock, renewCronLock, type CronLock } from '@/lib/cron-throttle'
import { scrapeHashtag, scrapeAccountMentions, isApifyConfigured, isApifyOverCoreReserve, checkApifyAuth, detectCountry } from '@/lib/apify'
import { searchVideos as ytSearchVideos, isYouTubeApiConfigured } from '@/lib/youtube-api'
import {
  loadCampaignBrandAccounts,
  mediaMatchesCampaignRules,
  normalizeTargets,
  scrapedPostToRuleItem,
  upsertCampaignPost,
} from '@/lib/campaign-capture'
import { isBrandAccount } from '@/lib/campaign-targets'
import { CAMPAIGN_ENDED_GRACE_DAYS, campaignEndedForCrons, type SkippedCampaign } from '@/lib/campaign-ended'
import { loadCampaignRoster, type Roster } from '@/lib/campaign-roster'
import type { Platform } from '@/generated/prisma/client'
import { afterInfluencerUpsert } from '@/lib/influencer-upsert'
import { campaignTeamUserIds, notifyApifyBudgetPauseOnce, notifyApifyTokenRejectedOnce } from '@/lib/notifications'

/**
 * Networks where scrapeAccountMentions (src/lib/apify.ts) can read the posts
 * that tag an account. On the others it answered [] after a scrape_jobs row
 * had been created: 156 empty TikTok and 65 empty YouTube "cron-mentions" jobs
 * in the first half of Nov 2026. Those targets are skipped here with the
 * reason 'unsupported' and no job.
 */
const MENTIONS_SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(['INSTAGRAM'])

/**
 * creator_discovered → every member of the campaign team (creator + assigned
 * PMs, active staff only), skipping the members already notified about this
 * creator in the last 7 days (dedup is per user). Never throws.
 */
async function notifyCreatorDiscovered(campaignId: string, influencerId: string, message: string): Promise<void> {
  try {
    const team = await campaignTeamUserIds(campaignId)
    if (team.length === 0) return
    const alreadyNotified = new Set(
      (await prisma.notification.findMany({
        where: {
          userId: { in: team },
          type: 'creator_discovered',
          createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          metadata: { path: ['influencerId'], equals: influencerId },
        },
        select: { userId: true },
      })).map(n => n.userId)
    )
    const recipients = team.filter(userId => !alreadyNotified.has(userId))
    if (recipients.length === 0) return
    await prisma.notification.createMany({
      data: recipients.map(userId => ({
        userId,
        type: 'creator_discovered',
        title: 'Nuevo creador descubierto',
        message,
        link: `/campaigns/${campaignId}`,
        metadata: { influencerId, campaignId },
      })),
    })
  } catch { /* skip */ }
}

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export interface CronTrackingResults {
  campaignsProcessed: number
  /** Campaigns not read, each with its reason: 'ended' (end date + grace behind us), 'future', 'empty' window */
  campaignsSkipped: SkippedCampaign[]
  totalPostsFound: number
  staleJobsFailed: number
  /** Authors who are NOT creators of the campaign, left out by its country filter (discovery only) */
  countrySkipped: number
  /** Always 0: a creator of the campaign (a member, or a profile of a member's person) is never filtered by country */
  countrySkippedMembers: number
  /** Brand accounts whose mentions cannot be read on that network: no scrape job, reason 'unsupported' */
  unsupportedMentions: Array<{ campaignId: string; name: string; platform: string; accounts: string[] }>
  /** A BRAND account registered as a profile of a creator: its posts are never credited to her (reason 'brand_account') */
  brandAuthorsSkipped: Array<{ campaignId: string; name: string; author: string; member: string; posts: number }>
  errors: string[]
}

/**
 * Progress the HTTP handler can read after the run, even when it threw: the
 * 24 h stamp is only written when the loop finished or at least one scrape
 * job completed (a redeploy mid-run must NOT cost a whole day of tracking).
 */
export interface CronTrackingProgress {
  finished: boolean
  processed: number
}

export interface CronTrackingOptions {
  progress?: CronTrackingProgress
  /** Called at every campaign and after every scrape, so the in-flight lock does not look dead during a long run (renewCronLock) */
  heartbeat?: () => Promise<unknown>
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

const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000 // 3 hours: a COMPLETED job this recent is not repeated
const RETRY_BACKOFF_MS = 6 * 60 * 60 * 1000 // 6 hours: a FAILED/RUNNING job this recent is not retried every tick
const STALE_RUNNING_MS = 24 * 60 * 60 * 1000 // 24 hours: a job still RUNNING after this is dead (killed run)

/**
 * Check if a scrape job for the same campaign+target was already run recently.
 * Returns true if a COMPLETED job exists within the dedup window (3 h) OR a
 * FAILED/RUNNING job was started within the retry back-off (6 h): a target
 * that just failed (Apify down, bad hashtag) must not be retried on every tick.
 */
async function wasRecentlyScraped(campaignId: string, jobType: string, target: string, platform: Platform): Promise<boolean> {
  const completedCutoff = new Date(Date.now() - DEDUP_WINDOW_MS)
  const retryCutoff = new Date(Date.now() - RETRY_BACKOFF_MS)
  const recentJob = await prisma.scrapeJob.findFirst({
    where: {
      campaignId,
      jobType,
      targetUsername: target,
      platform,
      OR: [
        { status: 'COMPLETED', completedAt: { gte: completedCutoff } },
        { status: { in: ['FAILED', 'RUNNING'] }, createdAt: { gte: retryCutoff } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  })
  if (recentJob) {
    const when = (recentJob.completedAt ?? recentJob.startedAt ?? recentJob.createdAt).toISOString()
    console.log(`[Cron/Track] Skipping ${jobType} for "${target}"@${platform} in campaign ${campaignId} — ${recentJob.status} job at ${when}`)
    return true
  }
  return false
}

/** Jobs left RUNNING for more than 24 h belong to a killed run: close them as FAILED ('stale'). */
async function failStaleRunningJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS)
  try {
    const res = await prisma.scrapeJob.updateMany({
      where: {
        status: 'RUNNING',
        OR: [
          { startedAt: { lt: cutoff } },
          { startedAt: null, createdAt: { lt: cutoff } },
        ],
      },
      data: { status: 'FAILED', errorMessage: 'stale', completedAt: new Date() },
    })
    if (res.count > 0) console.log(`[Cron/Track] Swept ${res.count} stale RUNNING scrape jobs (> 24 h) → FAILED`)
    return res.count
  } catch (err) {
    console.warn('[Cron/Track] Stale job sweep failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

/** Never leave a job RUNNING: a thrown scrape is recorded as FAILED with its message. */
async function failJob(jobId: string | null, err: unknown): Promise<void> {
  if (!jobId) return
  const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 1000)
  await prisma.scrapeJob
    .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage, completedAt: new Date() } })
    .catch(() => {})
}

/**
 * A campaign is only tracked while its window can hold content: a window
 * entirely in the future (startDate after today), empty (endDate before
 * startDate) or ended more than CAMPAIGN_ENDED_GRACE_DAYS ago (rule 2 rejects
 * everything published after the end) cannot match any post — every scrape
 * for it is a wasted run. Returns why it is not tracked, or null. A campaign
 * without an end date (Social Listening) is tracked for as long as it is ACTIVE.
 */
function campaignWindowSkipReason(campaign: { startDate: Date; endDate: Date | null }, now: Date): SkippedCampaign['reason'] | null {
  const start = new Date(campaign.startDate).getTime()
  if (Number.isFinite(start) && start > now.getTime()) return 'future'
  if (campaign.endDate) {
    const end = new Date(campaign.endDate).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) return 'empty'
  }
  if (campaignEndedForCrons(campaign, now)) return 'ended'
  return null
}

/**
 * Core tracking logic extracted for reuse by both the HTTP endpoint and
 * the instrumentation auto-tracker.
 *
 * Hashtag + @mention tracking only. Stories are the job of /api/cron/stories,
 * which applies the soft budget and the eligibility rule (dates, type, length
 * cap: storiesCampaignSkipReason in campaign-capture.ts) — the
 * per-campaign stories loop that used to live here bypassed all three
 * (7 actor starts, 1,12 $ a day; removed 2026-09-14).
 */
export async function runCronTracking(options: CronTrackingOptions = {}): Promise<CronTrackingResults> {
  if (!isApifyConfigured()) {
    throw new Error('Apify not configured')
  }
  const progress: CronTrackingProgress = options.progress ?? { finished: false, processed: 0 }
  /** Sign of life for the in-flight lock; never stops the run */
  const beat = async () => {
    if (!options.heartbeat) return
    try {
      await options.heartbeat()
    } catch {
      // the heartbeat is a courtesy to the next caller, never a reason to stop
    }
  }

  console.log('[Cron/Track] Starting cron tracking run at', new Date().toISOString())

  const results: CronTrackingResults = {
    campaignsProcessed: 0,
    campaignsSkipped: [],
    totalPostsFound: 0,
    staleJobsFailed: 0,
    countrySkipped: 0,
    countrySkippedMembers: 0,
    unsupportedMentions: [],
    brandAuthorsSkipped: [],
    errors: [],
  }

  results.staleJobsFailed = await failStaleRunningJobs()

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

  // Helper: process scraped results for a campaign
  async function processResults(
    scrapedResults: HashtagResult[],
    campaign: typeof campaigns[0],
    platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
    source: string
  ): Promise<number> {
    let postsFound = 0
    if (scrapedResults.length === 0) return 0

    // Who the campaign's creators are, read now (a run lasts minutes): a member
    // row, or a profile of a member's person (src/lib/campaign-roster.ts), so a
    // creator's TikTok that is not itself a member still credits her row.
    const roster: Roster = await loadCampaignRoster(campaign.id)
    // The brand's accounts (its targets and its connected Instagram): a brand
    // account registered as a profile of a creator, by hand or by old data,
    // must never credit her with the brand's own posts. «Añadir publicación por
    // URL» and «Registrar Story» refuse exactly that; here the roster decided
    // alone until 18 Nov 2026.
    const brandAccounts = (await loadCampaignBrandAccounts([campaign])).get(campaign.id) ?? { targets: [], own: [] }

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
        // Durable copy of the profile picture while the CDN URL is fresh (fire-and-forget)
        afterInfluencerUpsert(influencer.id, result.authorAvatarUrl)

        // Is the author a creator of this campaign? Decided BEFORE the country
        // filter (16 Nov 2026): that filter exists to leave out foreign authors
        // found by hashtag, never a creator the PM added herself. Until now
        // @elemor_encasa (AR) and @paula_silvagni_ (BR), members of a Spanish
        // campaign, were skipped 156 times with "campaign requires ES" and their
        // tagged posts never entered by this path.
        const credit = roster.creditFor(platform, result.authorUsername)

        if (credit) {
          if (!credit.self && (isBrandAccount(brandAccounts.targets, result.authorUsername) || isBrandAccount(brandAccounts.own, result.authorUsername))) {
            // A brand account linked as a profile of a creator: the brand's posts
            // are not hers. Named in the log and in the summary (never silent);
            // nothing stored, nobody announced. The brand's own row, when the
            // brand was added as a creator (credit.self), keeps its posts.
            console.log(`[Cron/Track] @${result.authorUsername} is a brand account of "${campaign.name}" but is registered as a profile of @${credit.member.username}: its ${result.posts.length} posts are not credited to her (reason: brand_account)`)
            results.brandAuthorsSkipped.push({ campaignId: campaign.id, name: campaign.name, author: result.authorUsername, member: credit.member.username, posts: result.posts.length })
            continue
          }
          // Creator IS of this campaign — store ONLY posts that pass the campaign
          // rules: dated inside [startDate, endDate] AND referencing a target
          // account/hashtag (undated posts are never captured). Credited to her
          // member row; a linked profile is recorded as the publisher.
          for (const post of result.posts) {
            if (!post.externalId) continue
            if (!mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post))) continue
            const stored = await upsertCampaignPost(campaign.id, credit.member.influencerId, platform, post, {
              publishedByInfluencerId: credit.self ? null : influencer.id,
            })
            if (stored) postsFound++
          }
          continue
        }

        // Country filtering (discovery of authors who are not creators of the campaign)
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
            console.log(`[Cron/Track] Country filter: skipping @${result.authorUsername} (country=${influencerCountry}, not a creator of the campaign) — campaign requires ${campaign.country}`)
            results.countrySkipped++
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
              console.log(`[Cron/Track] Country filter: skipping @${result.authorUsername} — non-latin script detected in caption`)
              results.countrySkipped++
              continue // Skip non-latin-script content
            }

            // For Spanish campaigns, allow latin-script content through (could be Spanish)
            // For all other countries, skip unknown-country content
            if (campaign.country !== 'ES') {
              console.log(`[Cron/Track] Country filter: skipping @${result.authorUsername} — no country detected, strict mode for ${campaign.country}`)
              results.countrySkipped++
              continue // Strict: skip content with no country detected
            }
          }
        }

        // Not a creator of the campaign — DO NOT auto-add: the user must
        // explicitly add creators. Send the discovery notification and SKIP
        // Media creation. Recipients: the campaign team (creator + assigned PMs),
        // deduped 7 days PER USER — a PM given access later still receives it.
        // (Another profile of a creator who IS in the campaign was credited
        // above through the roster: it is never announced as a new creator.)
        if (influencer.followers >= 1000) {
          await notifyCreatorDiscovered(
            campaign.id,
            influencer.id,
            `🔍 @${influencer.username} (${formatFollowers(influencer.followers)}) descubierto via ${source} en ${campaign.name}`
          )
        }
      } catch { /* skip */ }
    }
    return postsFound
  }

  const now = new Date()
  for (const campaign of campaigns) {
    await beat()
    const skipReason = campaignWindowSkipReason(campaign, now)
    if (skipReason) {
      const window = `${campaign.startDate.toISOString().slice(0, 10)} → ${campaign.endDate?.toISOString().slice(0, 10) ?? 'open'}`
      console.log(skipReason === 'ended'
        ? `[Cron/Track] Campaign "${campaign.name}" ended more than ${CAMPAIGN_ENDED_GRACE_DAYS} days ago (${window}) — its hashtags and accounts are not read any more (reason: ended)`
        : `[Cron/Track] Campaign "${campaign.name}" window is in the future or empty (${window}) — skipping (reason: ${skipReason})`)
      results.campaignsSkipped.push({ id: campaign.id, name: campaign.name, reason: skipReason })
      continue
    }
    try {
      // ===== 1. HASHTAG TRACKING =====
      // One scrape per TOKEN: a field typed as "#vileda #viledaturbo" is two hashtags.
      for (const hashtag of normalizeTargets(campaign.targetHashtags)) {
        for (const platform of campaign.platforms) {
          let jobId: string | null = null
          try {
            // Idempotency: skip if already scraped within the dedup window
            if (await wasRecentlyScraped(campaign.id, 'cron-hashtag', hashtag, platform)) continue

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
            jobId = job.id

            const hashtagResults = (platform === 'YOUTUBE' && isYouTubeApiConfigured())
              ? await getYouTubeHashtagResults(hashtag)
              : await scrapeHashtag(hashtag, platform, 30)

            const postsFound = await processResults(hashtagResults, campaign, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', `#${hashtag}`)

            await prisma.scrapeJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETED', itemsFound: postsFound, completedAt: new Date() },
            })
            results.totalPostsFound += postsFound
            progress.processed++
            await beat()
          } catch (err) {
            await failJob(jobId, err)
            results.errors.push(`${campaign.name}: ${hashtag}@${platform} - ${err instanceof Error ? err.message : 'Error'}`)
          }
        }
      }

      // ===== 2. ACCOUNT MENTIONS TRACKING (tagged posts) =====
      const mentionAccounts = normalizeTargets(campaign.targetAccounts)
      for (const platform of campaign.platforms) {
        if (mentionAccounts.length === 0 || MENTIONS_SUPPORTED_PLATFORMS.has(platform)) continue
        // Named, not silent: these accounts are not read on this network and no job is created
        console.log(`[Cron/Track] Campaign "${campaign.name}": mentions of ${mentionAccounts.map(a => `@${a}`).join(', ')} on ${platform} are not supported — skipped (reason: unsupported)`)
        results.unsupportedMentions.push({ campaignId: campaign.id, name: campaign.name, platform, accounts: mentionAccounts })
      }
      for (const account of mentionAccounts) {
        for (const platform of campaign.platforms) {
          if (!MENTIONS_SUPPORTED_PLATFORMS.has(platform)) continue
          let jobId: string | null = null
          try {
            // Idempotency: skip if already scraped within the dedup window
            if (await wasRecentlyScraped(campaign.id, 'cron-mentions', account, platform)) continue

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
            jobId = job.id

            const mentionResults = await scrapeAccountMentions(account, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', 50)
            const postsFound = await processResults(mentionResults, campaign, platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', `@${account}`)

            await prisma.scrapeJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETED', itemsFound: postsFound, completedAt: new Date() },
            })
            results.totalPostsFound += postsFound
            progress.processed++
          } catch (err) {
            await failJob(jobId, err)
            results.errors.push(`${campaign.name}: @${account}@${platform} - ${err instanceof Error ? err.message : 'Error'}`)
          }
        }
      }

      results.campaignsProcessed++
    } catch (err) {
      results.errors.push(`Campaign ${campaign.name}: ${err instanceof Error ? err.message : 'Error'}`)
    }
  }
  progress.finished = true

  console.log(`[Cron/Track] Run complete: ${results.campaignsProcessed} campaigns (${results.campaignsSkipped.length} skipped: ${results.campaignsSkipped.map(c => `"${c.name}" ${c.reason}`).join(', ') || 'none'}), ${results.totalPostsFound} posts, ${results.countrySkipped} foreign authors left out by country (${results.countrySkippedMembers} creators of the campaigns), ${results.unsupportedMentions.length} unsupported mention targets, ${results.brandAuthorsSkipped.length} brand accounts not credited to a creator, ${results.errors.length} errors`)
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

    const force = request.nextUrl.searchParams.get('force') === '1'
    // Every hashtag scrape charges an Apify run start: once a day is enough for posts (they do not expire)
    const gate = await cronGate('track', 24, force)
    if (!gate.allowed) return NextResponse.json(cronSkipped('track', gate))

    // CORE budget reserve (same rule as /api/cron/stories): post capture runs
    // until 95 % of the Apify plan; a pause is always visible (ADMIN alert once a day).
    const budget = await isApifyOverCoreReserve()
    if (budget.over && !force) {
      console.log(`[Cron/Track] Skipped: Apify usage ${budget.usd} $ ≥ core reserve ${budget.coreLimit} $ (${budget.usedPct} % of the plan; cycle ends ${budget.cycleEndsAt ?? 'unknown'})`)
      await notifyApifyBudgetPauseOnce('track', { usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt })
      return NextResponse.json({ skipped: 'apify_budget', cron: 'track', usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt })
    }
    // Rejected token: every scrape would fail and be reported as "0 posts".
    // Not run, not stamped, ADMINs told; the next tick retries.
    if ((await checkApifyAuth(true)) === 'rejected') {
      console.error('[Cron/Track] NOT RUN: Apify rejects the token (401). Replace APIFY_API_KEY; the next tick retries.')
      await notifyApifyTokenRejectedOnce()
      return NextResponse.json({ error: 'Apify rejects the token', skipped: 'apify_token', cron: 'track' }, { status: 503 })
    }

    // One run at a time, whoever calls (internal scheduler, external curl, a retried GET)
    const lock: CronLock | null = await acquireCronLock('track')
    if (!lock) {
      const since = await cronLockHeldSince('track')
      console.log(`[Cron/Track] Skipped: a run is in flight since ${since ?? 'unknown'}`)
      return NextResponse.json(cronInFlight('track', since))
    }

    // The 24 h stamp is written AFTER the work (see finally): stamping first
    // meant a redeploy mid-run skipped the rest until the next day.
    const progress: CronTrackingProgress = { finished: false, processed: 0 }
    try {
      // The heartbeat keeps the lock alive during a run longer than its TTL
      const results = await runCronTracking({ progress, heartbeat: () => renewCronLock(lock) })

      return NextResponse.json({
        message: 'Cron tracking completed',
        results,
        timestamp: new Date().toISOString(),
      })
    } finally {
      // Not stamped when the token was rejected mid-run (the pre-flight could
      // not tell, e.g. it timed out): every scrape came back empty and a
      // stamp would close the gate for 24 h behind a run that read nothing
      const tokenRejected = (await checkApifyAuth()) === 'rejected'
      if (!tokenRejected && (progress.finished || progress.processed > 0)) await markCronRun('track')
      await releaseCronLock(lock)
    }
  } catch (error) {
    console.error('Cron track error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
