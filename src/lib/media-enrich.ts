/**
 * MEDIA ENRICH — real views for the reels the Meta API cannot see.
 *
 * Why: a creator's reel that tags the brand reaches us through the brand's
 * Meta connection (source 'meta_api'), but Meta does not expose view counts of
 * OTHER accounts' media, so those rows are materialized with views = 0. The
 * public post page does show the play count, so we fetch it once through the
 * Apify batch post fetcher and store it. Real views are the third rung of the
 * audience ladder (reach → impressions → views, decision 5) and the only real
 * audience most reels will ever have — without them the reel falls back to an
 * estimate and leaves the ER/CPM base (decision 4A).
 *
 * Rules
 *  - Never lower a stored value: views/likes/comments are updated only when the
 *    fetched figure is higher than what we hold.
 *  - Bounded: `limit` rows per run (default 25) and a wall-clock budget
 *    (`timeBudgetMs`, default 240 s). Rows are fetched in batches of
 *    POSTS_BATCH_MAX (50) permalinks = ONE Apify run per batch (two when the
 *    first actor finishes with nothing). A run cannot be aborted mid-flight,
 *    so the budget's deadline is passed to scrapePostsBatch, which clips each
 *    run's wait to it and starts no run without POSTS_BATCH_MIN_RUN_MS left;
 *    a batch is started only while at least ENRICH_BATCH_RESERVE_MS remain.
 *    A run that outlives its wait is PARTIAL: the rows it did not answer come
 *    back `unresolved` and are neither counted nor logged as attempted (same
 *    for a transient actor failure), so they retry next run. Stops as soon as
 *    the Apify circuit breaker is open (isApifyExhausted()).
 *  - Idempotent and thrifty: a row that was tried recently (ATTEMPTS.retryAfterMs, 7 days) is
 *    skipped, so reels whose view count Instagram hides do not burn credits on
 *    every sync. Attempts live in Setting 'media_enrich_attempts' (JSON map
 *    mediaId → ISO date, pruned; see attempt-log.ts).
 *
 * Cost (Apify): actors bill per RUN START, not per post — apify~instagram-scraper
 * 0,099 $ per start, apify~instagram-post-scraper per result (list price
 * ≈ 0,002 $). The old one-run-per-row loop cost ≈ 0,8 $ for 105 posts (measured
 * 2026-09-14). scrapePostsBatch sends up to 50 permalinks per run; the
 * per-post figure of the batched path is NOT measured yet (until 2026-09-14 the
 * post-scraper was called with a wrong input field and every batch paid the
 * 0,099 $ fallback start instead) — re-measure before quoting it.
 *
 * REFRESH of maturing views (refreshMaturingViews, doc item 4 "Vistas de reels",
 * 2026-10-08). The figure captured on discovery is a day-old play count; a reel
 * keeps collecting plays for weeks, so the public figure is RE-READ twice per
 * video: once when the post is ≥ 7 days old and once when it is ≥ 14 days old
 * (REFRESH_STAGES_DAYS). Rules:
 *  - Scope: Instagram REEL/VIDEO/SHORT rows attached to a campaign, with a
 *    permalink, not deleted and WITHOUT PM-registered statistics
 *    (insightsSource IS NULL — "Registrar estadísticas" is final and is never
 *    overwritten; the update itself is also conditioned on insightsSource IS
 *    NULL so a registration that lands mid-run wins).
 *  - "Last read" marker: Setting 'media_views_read' (mediaId → ISO of the last
 *    public read by EITHER path, success or definitive "not public"), plus the
 *    enrich attempt log for the transition. It is NOT Media.updatedAt: meta-sync
 *    re-upserts every Meta-attributed reel on each sync (measured 2026-10-08:
 *    146 of 147 had updatedAt < 2 days old), so updatedAt says nothing about
 *    views. Rows with no marker: an Apify-captured (or manual, added by URL)
 *    row's own capture read the public figure, so its immutable discoveredAt
 *    is its last read — NOT updatedAt, which every non-read write bumps too
 *    (ad-disclosure pass, isDeleted toggles, the PM's content tags) and would
 *    silently cancel a refresh; a Meta-attributed row was never read by
 *    Apify, so it is due (one catch-up read, then marked).
 *  - Stage due: 14 when age ≥ 14 d and lastRead < postedAt + 14 d; else 7 when
 *    age ≥ 7 d and lastRead < postedAt + 7 d. A row that missed stage 7 gets a
 *    single read at stage 14. After stage 14 a row is never read again.
 *  - Writes: views = max(stored, fetched) (public plays only grow; a lower or
 *    hidden figure never lowers what we hold); likes/comments = fetched when
 *    > 0 (the current public count, which can legitimately be lower);
 *    thumbnail refreshed only when the row still has no durable MediaThumb.
 *    Nothing is written when nothing changed (the marker alone records the read).
 *  - Thrift: a row read in the last 24 h by either path is skipped
 *    (VIEWS_READ.retryAfterMs); a refreshed row is also stamped in the enrich
 *    attempt log, so the missing/stale path leaves it alone for 7 days. Same
 *    batch machinery, limit (default 60) and time budget as the first fetch;
 *    rows a run could not answer stay unmarked and retry next run. Markers are
 *    saved after EACH batch of 50 (not once at the end of the run): a redeploy
 *    or OOM between two batches keeps the first batch's reads and never pays
 *    them again.
 *  - Cost (server log only, never in the UI): 0,0023 $ per post read,
 *    ≤ 0,14 $ per run at the 60-row cap; a normal day is a handful of rows.
 */

import { prisma } from '@/lib/db'
import { isApifyExhausted, POSTS_BATCH_MAX, POSTS_BATCH_MIN_RUN_MS, scrapePostsBatch, type PostsBatchResult } from '@/lib/apify'
import { MediaType, Platform, Prisma } from '@/generated/prisma/client'
import { attemptedRecently, loadAttempts, saveAttempts, type AttemptLogSpec, type AttemptMap } from '@/lib/attempt-log'

// ============ TYPES ============

export interface EnrichOptions {
  /** Restrict to one campaign's rows. */
  campaignId?: string
  /** Max rows fetched from Apify in this run (1–100, default 25). */
  limit?: number
  /**
   * Wall-clock budget (default 240 s). Checked before EACH batch: a batch is
   * started only while at least ENRICH_BATCH_RESERVE_MS remain, and every
   * Apify run inside it is clipped to the budget's deadline (a run cannot be
   * cut short once started; one that outlives the wait leaves its rows unresolved).
   */
  timeBudgetMs?: number
  /** Retry rows attempted recently (ignores the 7-day attempt window). */
  force?: boolean
  /** Refresh: re-read EVERY eligible video row (age ≥ 1 day) regardless of the 7/14-day stages — one-off
   *  catch-up after a metric-mapping change (e.g. videoViewCount → videoPlayCount, Oct 2026). Admin only. */
  all?: boolean
  /**
   * Also re-fetch rows whose stored views are below their likes (a partial or
   * stale platform figure that metrics.ts treats as "sin dato real"), whatever
   * their source. Default true.
   */
  includeStale?: boolean
}

export type EnrichStop = 'done' | 'limit' | 'time' | 'apify_exhausted' | 'apify_not_configured'

export interface EnrichSummary {
  /** Rows selected for this run (after the recent-attempt filter). */
  scanned: number
  /** Rows that received a higher views/likes/comments figure. */
  updated: number
  /** Rows whose public post could not be fetched (removed, private, actor error). */
  failed: number
  /** Fetched fine but nothing higher than what we hold (Instagram hides the count, or unchanged). */
  unchanged: number
  /** Pending rows that can never be enriched: no permalink. */
  skippedNoPermalink: number
  /** Rows left out because they were attempted within the 7-day attempt window. */
  skippedRecentAttempt: number
  /**
   * Rows selected but left without an answer: the actor failed, the run
   * outlived its wait, the breaker tripped or no time was left. Not counted as
   * scanned/failed and NOT logged as attempted — they retry next run.
   */
  unresolved: number
  /** Matching rows still pending AFTER this run (for the admin backlog). */
  pendingAfter: number
  stoppedBy: EnrichStop
  durationMs: number
}

// ============ SELECTION ============

interface Selection {
  source: 'meta_api' | 'apify'
  mediaTypes: MediaType[]
  campaignId?: string
}

function pendingWhere(sel: Selection, withPermalink: boolean): Prisma.MediaWhereInput {
  return {
    source: sel.source,
    platform: Platform.INSTAGRAM,
    mediaType: { in: sel.mediaTypes },
    views: 0,
    isDeleted: false,
    permalink: withPermalink ? { not: null } : null,
    ...(sel.campaignId ? { campaignId: sel.campaignId } : {}),
  }
}

/** Instagram reels/videos whose stored views are below their likes (partial/stale figure), newest first. */
async function staleViewIds(campaignId: string | undefined, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM media
    WHERE platform = 'INSTAGRAM' AND "mediaType" IN ('REEL', 'VIDEO') AND "isDeleted" = false
      AND permalink IS NOT NULL AND views > 0 AND views < likes
      ${campaignId ? Prisma.sql`AND "campaignId" = ${campaignId}` : Prisma.sql`AND "campaignId" IS NOT NULL`}
    ORDER BY "postedAt" DESC NULLS LAST
    LIMIT ${limit}`
  return rows.map(r => r.id)
}

/** Rows still waiting for real views (with a permalink), the unenrichable ones (without) and the stale ones (views < likes). */
export async function countPendingMetaReelViews(campaignId?: string): Promise<{ pending: number; withoutPermalink: number; stale: number }> {
  const sel: Selection = { source: 'meta_api', mediaTypes: [MediaType.REEL, MediaType.VIDEO], campaignId }
  const [pending, withoutPermalink, staleIds] = await Promise.all([
    prisma.media.count({ where: pendingWhere(sel, true) }),
    prisma.media.count({ where: pendingWhere(sel, false) }),
    staleViewIds(campaignId, 1000),
  ])
  return { pending, withoutPermalink, stale: staleIds.length }
}

// ============ ATTEMPT LOG (Setting) ============

/** A row tried in the last 7 days is not retried (unless force). Entries are pruned after 30 days. */
const ATTEMPTS: AttemptLogSpec = {
  key: 'media_enrich_attempts',
  retryAfterMs: 7 * 24 * 60 * 60 * 1000,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  max: 5000,
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When the public views of a video were last READ from Apify by either path
 * (a fetched post, or a definitive "removed/private" answer), mediaId → ISO.
 * Long memory on purpose: it decides the 7- and 14-day refreshes for the whole
 * life of the row, so it must outlive the 30-day attempt log above.
 * `retryAfterMs` is the cross-path guard: a row read in the last 24 h is not
 * paid for again by the refresh.
 */
const VIEWS_READ: AttemptLogSpec = {
  key: 'media_views_read',
  retryAfterMs: DAY_MS,
  ttlMs: 2 * 365 * DAY_MS,
  max: 20_000,
}

/** Price per result of apify~instagram-post-scraper. Server log only — never shown in the UI. */
const COST_PER_POST_USD = 0.0023

/**
 * Stamp the rows a BATCH answered (fetched or definitively not public) in both
 * logs, right after that batch's rows are written — not once at the end of the
 * run, so a process killed between two batches (Railway redeploy, OOM) keeps
 * the stamps of the batch already paid for. Each log is re-read right before
 * saving so two paths finishing at the same time (meta-sync enrichment,
 * check-posts refresh) do not drop each other's entries.
 */
async function recordReads(touched: AttemptMap): Promise<void> {
  if (Object.keys(touched).length === 0) return
  await saveAttempts(ATTEMPTS, { ...(await loadAttempts(ATTEMPTS)), ...touched })
  await saveAttempts(VIEWS_READ, { ...(await loadAttempts(VIEWS_READ)), ...touched })
}

// ============ TIME BUDGET ============

/**
 * Least time a BATCH needs before it is started: one Apify run (60 s
 * waitForFinish + a few polls, POSTS_BATCH_MIN_RUN_MS) plus a margin for the
 * DB work. It is a minimum useful window, not a worst case: the runs inside
 * the batch are clipped to the budget's deadline, so the batch never outlives
 * the budget. Callers with less slack than this (meta-sync at the end of a
 * cron sync) skip the enrichment altogether — the queries alone are wasted
 * otherwise.
 */
export const ENRICH_BATCH_RESERVE_MS = POSTS_BATCH_MIN_RUN_MS + 20_000
/** Budget when the caller passes none (admin endpoint): fits its 300 s maxDuration. */
const DEFAULT_TIME_BUDGET_MS = 240_000

// ============ CORE ============

async function enrichViews(sel: Selection, options: EnrichOptions): Promise<EnrichSummary> {
  const startedAt = Date.now()
  const limit = Math.min(Math.max(Math.round(options.limit ?? 25), 1), 100)
  const budgetMs = Math.max(0, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
  const remainingMs = () => budgetMs - (Date.now() - startedAt)
  const summary: EnrichSummary = {
    scanned: 0, updated: 0, failed: 0, unchanged: 0,
    skippedNoPermalink: 0, skippedRecentAttempt: 0, unresolved: 0, pendingAfter: 0,
    stoppedBy: 'done', durationMs: 0,
  }
  const finish = async (stoppedBy: EnrichStop): Promise<EnrichSummary> => {
    summary.stoppedBy = stoppedBy
    summary.durationMs = Date.now() - startedAt
    summary.pendingAfter = await prisma.media.count({ where: pendingWhere(sel, true) }).catch(() => 0)
    console.log(`[media-enrich] ${sel.source} ${sel.mediaTypes.join('/')}${sel.campaignId ? ` campaign=${sel.campaignId}` : ''}: ` +
      `scanned=${summary.scanned} updated=${summary.updated} unchanged=${summary.unchanged} failed=${summary.failed} ` +
      `noPermalink=${summary.skippedNoPermalink} recent=${summary.skippedRecentAttempt} unresolved=${summary.unresolved} pendingAfter=${summary.pendingAfter} ` +
      `stoppedBy=${summary.stoppedBy} in ${summary.durationMs} ms (≈ ${(summary.scanned * COST_PER_POST_USD).toFixed(3)} $ Apify)`)
    return summary
  }

  summary.skippedNoPermalink = await prisma.media.count({ where: pendingWhere(sel, false) })

  if (isApifyExhausted()) return finish('apify_exhausted')

  // Over-fetch so recently-attempted rows do not eat the whole batch, then trim.
  const attempts = options.force ? {} : await loadAttempts(ATTEMPTS)
  const candidates = await prisma.media.findMany({
    where: pendingWhere(sel, true),
    orderBy: { postedAt: 'desc' },
    take: options.force ? limit : limit * 4,
    select: {
      id: true, permalink: true, views: true, likes: true, comments: true, campaignId: true, thumbnailUrl: true,
      influencer: { select: { username: true } },
    },
  })
  if (options.includeStale !== false) {
    const staleIds = await staleViewIds(sel.campaignId, limit * 2)
    const known = new Set(candidates.map(c => c.id))
    const fresh = staleIds.filter(id => !known.has(id))
    if (fresh.length > 0) {
      const stale = await prisma.media.findMany({
        where: { id: { in: fresh } },
        select: {
          id: true, permalink: true, views: true, likes: true, comments: true, campaignId: true, thumbnailUrl: true,
          influencer: { select: { username: true } },
        },
      })
      candidates.push(...stale)
    }
  }
  const rows: typeof candidates = []
  for (const c of candidates) {
    if (rows.length >= limit) break
    if (attemptedRecently(ATTEMPTS, attempts, c.id)) { summary.skippedRecentAttempt++; continue }
    rows.push(c)
  }
  // Candidates beyond the limit that were not inspected do not count as skipped.
  const stoppedByLimit = candidates.length > rows.length + summary.skippedRecentAttempt

  // Defensive: the query already filters rows without a permalink.
  const queue: Array<typeof rows[number] & { permalink: string }> = []
  for (const row of rows) {
    if (!row.permalink) { summary.skippedNoPermalink++; continue }
    queue.push(row as typeof rows[number] & { permalink: string })
  }

  let stop: EnrichStop = stoppedByLimit ? 'limit' : 'done'
  const deadlineAt = startedAt + budgetMs

  for (let i = 0; i < queue.length; i += POSTS_BATCH_MAX) {
    if (isApifyExhausted()) { stop = 'apify_exhausted'; break }
    // Before EACH batch: a run cannot be aborted, so only start it with a useful window left.
    if (remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }

    const batch = queue.slice(i, i + POSTS_BATCH_MAX)
    const attemptedAt = new Date().toISOString()
    const touched: AttemptMap = {}

    // ONE Apify run for the whole batch (billed per result, not per run), clipped to the deadline.
    let fetched: PostsBatchResult = { posts: new Map(), unresolved: new Set(batch.map(r => r.permalink)) }
    try {
      fetched = await scrapePostsBatch(batch.map(r => r.permalink), { deadlineAt })
    } catch (err) {
      console.error(`[media-enrich] batch of ${batch.length} rows: fetch threw`, err instanceof Error ? err.message : err)
    }
    // Rows without an answer (actor failure, partial run, breaker tripped, no
    // time left) are not these rows' fault: left untouched (no attempt logged,
    // not counted as failed) so they retry next run.
    const trippedMidBatch = isApifyExhausted()

    for (const row of batch) {
      const post = fetched.posts.get(row.permalink) ?? null
      if (!post && (trippedMidBatch || fetched.unresolved.has(row.permalink))) { summary.unresolved++; continue }

      summary.scanned++
      touched[row.id] = attemptedAt
      const tag = `@${row.influencer?.username ?? '?'} ${row.permalink}`

      if (!post) {
        summary.failed++
        console.warn(`[media-enrich] ${row.id} ${tag}: public post not fetched (removed or private)`)
        continue
      }

      // Never lower a stored value. A fresh thumbnail URL is always welcome (the old one expires).
      const data: Prisma.MediaUpdateInput = {}
      if (post.views > row.views) data.views = post.views
      if (post.likes > row.likes) data.likes = post.likes
      if (post.comments > row.comments) data.comments = post.comments
      if (post.thumbnailUrl && post.thumbnailUrl !== row.thumbnailUrl) data.thumbnailUrl = post.thumbnailUrl
      if (data.thumbnailUrl) {
        try {
          await prisma.media.update({ where: { id: row.id }, data: { thumbnailUrl: post.thumbnailUrl } })
          const { cacheMediaThumb } = await import('@/lib/thumb-cache')
          await cacheMediaThumb(row.id, { refresh: true })
        } catch (err) {
          console.error(`[media-enrich] ${row.id} thumb cache failed`, err instanceof Error ? err.message : err)
        }
        delete data.thumbnailUrl
      }
      if (Object.keys(data).length === 0) {
        summary.unchanged++
        console.log(`[media-enrich] ${row.id} ${tag}: fetched but nothing higher (views ${post.views}, likes ${post.likes}, comments ${post.comments})`)
        continue
      }
      try {
        await prisma.media.update({ where: { id: row.id }, data })
        summary.updated++
        console.log(`[media-enrich] ${row.id} ${tag}: views ${row.views} → ${data.views ?? row.views}, likes ${row.likes} → ${data.likes ?? row.likes}, comments ${row.comments} → ${data.comments ?? row.comments}`)
      } catch (err) {
        summary.failed++
        console.error(`[media-enrich] ${row.id} ${tag}: update failed`, err instanceof Error ? err.message : err)
      }
    }

    // Both logs, per batch: the 7-day attempt window of this path and the long
    // "last read" marker of the refresh — saved now, so a kill before the next
    // batch does not re-pay these rows.
    await recordReads(touched)

    if (trippedMidBatch) { stop = 'apify_exhausted'; break }
    // Rows the batch could not answer for lack of time: nothing more fits in this run.
    if (fetched.unresolved.size > 0 && remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }
  }

  return finish(stop)
}

// ============ PUBLIC API ============

/**
 * Meta-attributed reels/videos with views = 0 → real public view count.
 * Default 25 rows, newest first. See the file header for cost and rules.
 */
export function enrichMetaReelViews(options: EnrichOptions = {}): Promise<EnrichSummary> {
  return enrichViews({ source: 'meta_api', mediaTypes: [MediaType.REEL, MediaType.VIDEO], campaignId: options.campaignId }, options)
}

/**
 * Rare case: Apify-captured reels that came back with views = 0 (feed scrape
 * without a play count). Same rules and cost as enrichMetaReelViews.
 */
export function enrichMissingViews(options: EnrichOptions = {}): Promise<EnrichSummary> {
  return enrichViews({ source: 'apify', mediaTypes: [MediaType.REEL], campaignId: options.campaignId }, options)
}

// ============ REFRESH (maturing views) ============

/** Days after publication at which the public figure of a video is re-read. */
export const REFRESH_STAGES_DAYS = [7, 14] as const
export type RefreshStage = typeof REFRESH_STAGES_DAYS[number]

const REFRESH_MEDIA_TYPES: MediaType[] = [MediaType.REEL, MediaType.VIDEO, MediaType.SHORT]

interface DueRow {
  id: string
  permalink: string
  views: number
  likes: number
  comments: number
  hasThumb: boolean
  username: string | null
  postedAt: Date
  /** Refresh due now: 7 (first) or 14 (second, or the single catch-up of a row that missed 7). */
  stage: RefreshStage
  lastReadAt: Date | null
}

/**
 * Video rows whose public views are due for a re-read, newest first (the rows
 * of running campaigns matter most when the cap bites; the backlog of older
 * rows follows). Selection rules in the file header (REFRESH).
 */
async function dueForRefresh(
  campaignId: string | undefined,
  logs?: { read: AttemptMap; attempts: AttemptMap },
  all = false
): Promise<DueRow[]> {
  const now = Date.now()
  const [read, attempts] = logs
    ? [logs.read, logs.attempts]
    : await Promise.all([loadAttempts(VIEWS_READ), loadAttempts(ATTEMPTS)])

  const candidates = await prisma.media.findMany({
    where: {
      platform: Platform.INSTAGRAM,
      mediaType: { in: REFRESH_MEDIA_TYPES },
      isDeleted: false,
      permalink: { not: null },
      insightsSource: null,
      campaignId: campaignId ?? { not: null },
      postedAt: { lte: new Date(now - (all ? 1 : REFRESH_STAGES_DAYS[0]) * DAY_MS) },
    },
    orderBy: { postedAt: 'desc' },
    take: 5000,
    select: {
      id: true, permalink: true, views: true, likes: true, comments: true, source: true,
      postedAt: true, discoveredAt: true,
      influencer: { select: { username: true } },
      thumb: { select: { mediaId: true } },
    },
  })

  const due: DueRow[] = []
  for (const c of candidates) {
    if (!c.permalink || !c.postedAt) continue
    const stamps = [read[c.id], attempts[c.id]]
      .map(iso => Date.parse(iso ?? ''))
      .filter(t => Number.isFinite(t))
    let lastReadAt: Date | null = stamps.length > 0 ? new Date(Math.max(...stamps)) : null
    // No marker yet: an Apify-captured (or manual, added by URL) row was read by
    // its own capture, and the immutable discoveredAt is that moment. Never
    // updatedAt: it is bumped by writes that read nothing (the ad-disclosure
    // pass, isDeleted toggles, the PM's content tags) and would mark a stage as
    // "already read" for ever. A Meta-attributed row was never read by Apify.
    if (!lastReadAt && c.source !== 'meta_api') lastReadAt = c.discoveredAt

    const posted = c.postedAt.getTime()
    let stage: RefreshStage | null = null
    for (const days of [...REFRESH_STAGES_DAYS].reverse()) {
      const stageAt = posted + days * DAY_MS
      if (now >= stageAt && (!lastReadAt || lastReadAt.getTime() < stageAt)) { stage = days; break }
    }
    if (all && !stage) stage = now >= posted + REFRESH_STAGES_DAYS[1] * DAY_MS ? REFRESH_STAGES_DAYS[1] : REFRESH_STAGES_DAYS[0]
    if (!stage) continue

    due.push({
      id: c.id, permalink: c.permalink, views: c.views, likes: c.likes, comments: c.comments,
      hasThumb: c.thumb !== null, username: c.influencer?.username ?? null,
      postedAt: c.postedAt, stage, lastReadAt,
    })
  }
  return due
}

/** How many video rows are due for a views refresh right now (admin backlog), per stage. */
export async function countMaturingViews(campaignId?: string): Promise<{ due: number; stage7: number; stage14: number }> {
  const due = await dueForRefresh(campaignId)
  return {
    due: due.length,
    stage7: due.filter(r => r.stage === 7).length,
    stage14: due.filter(r => r.stage === 14).length,
  }
}

/**
 * Re-read the public views of videos that are 7 and 14 days old (rules in the
 * file header, REFRESH). Default 60 rows per run, newest first, ONE Apify run
 * per 50 permalinks. `force` ignores the 24 h cross-path guard only — the
 * stage rules always apply. `includeStale` is not used here.
 */
export async function refreshMaturingViews(options: EnrichOptions = {}): Promise<EnrichSummary> {
  const startedAt = Date.now()
  const limit = Math.min(Math.max(Math.round(options.limit ?? 60), 1), 100)
  const budgetMs = Math.max(0, options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
  const remainingMs = () => budgetMs - (Date.now() - startedAt)
  const summary: EnrichSummary = {
    scanned: 0, updated: 0, failed: 0, unchanged: 0,
    skippedNoPermalink: 0, skippedRecentAttempt: 0, unresolved: 0, pendingAfter: 0,
    stoppedBy: 'done', durationMs: 0,
  }
  const scope = options.campaignId ? ` campaign=${options.campaignId}` : ''
  const finish = async (stoppedBy: EnrichStop): Promise<EnrichSummary> => {
    summary.stoppedBy = stoppedBy
    summary.durationMs = Date.now() - startedAt
    summary.pendingAfter = await dueForRefresh(options.campaignId).then(rows => rows.length).catch(() => 0)
    console.log(`[media-refresh]${scope}: scanned=${summary.scanned} updated=${summary.updated} unchanged=${summary.unchanged} failed=${summary.failed} ` +
      `recent=${summary.skippedRecentAttempt} unresolved=${summary.unresolved} pendingAfter=${summary.pendingAfter} ` +
      `stoppedBy=${summary.stoppedBy} in ${summary.durationMs} ms (≈ ${(summary.scanned * COST_PER_POST_USD).toFixed(3)} $ Apify)`)
    return summary
  }

  if (isApifyExhausted()) return finish('apify_exhausted')

  const [read, attempts] = await Promise.all([loadAttempts(VIEWS_READ), loadAttempts(ATTEMPTS)])
  const due = await dueForRefresh(options.campaignId, { read, attempts }, options.all === true)

  // Cross-path guard: a row read in the last 24 h by the refresh OR by the
  // missing/stale enrichment is not paid for again (unless force).
  const enrichRecent: AttemptLogSpec = { ...ATTEMPTS, retryAfterMs: VIEWS_READ.retryAfterMs }
  const queue: DueRow[] = []
  for (const row of due) {
    if (queue.length >= limit) break
    if (!options.force && (attemptedRecently(VIEWS_READ, read, row.id) || attemptedRecently(enrichRecent, attempts, row.id))) {
      summary.skippedRecentAttempt++
      continue
    }
    queue.push(row)
  }
  const stoppedByLimit = due.length > queue.length + summary.skippedRecentAttempt

  let stop: EnrichStop = stoppedByLimit ? 'limit' : 'done'
  const deadlineAt = startedAt + budgetMs

  for (let i = 0; i < queue.length; i += POSTS_BATCH_MAX) {
    if (isApifyExhausted()) { stop = 'apify_exhausted'; break }
    if (remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }

    const batch = queue.slice(i, i + POSTS_BATCH_MAX)
    const attemptedAt = new Date().toISOString()
    const touched: AttemptMap = {}

    let fetched: PostsBatchResult = { posts: new Map(), unresolved: new Set(batch.map(r => r.permalink)) }
    try {
      fetched = await scrapePostsBatch(batch.map(r => r.permalink), { deadlineAt })
    } catch (err) {
      console.error(`[media-refresh] batch of ${batch.length} rows: fetch threw`, err instanceof Error ? err.message : err)
    }
    const trippedMidBatch = isApifyExhausted()

    for (const row of batch) {
      const post = fetched.posts.get(row.permalink) ?? null
      // No answer (actor failure, partial run, breaker, no time): not marked, retries next run.
      if (!post && (trippedMidBatch || fetched.unresolved.has(row.permalink))) { summary.unresolved++; continue }

      summary.scanned++
      touched[row.id] = attemptedAt
      const tag = `@${row.username ?? '?'} ${row.permalink} (day ${row.stage})`

      if (!post) {
        summary.failed++
        console.warn(`[media-refresh] ${row.id} ${tag}: public post not fetched (removed or private)`)
        continue
      }

      const data: Prisma.MediaUpdateManyMutationInput = {}
      // Public plays only grow: a lower or hidden figure never lowers what we hold.
      if (post.views > row.views) data.views = post.views
      // Likes/comments: the current public count (legitimately lower sometimes); 0 = hidden, ignored.
      if (post.likes > 0 && post.likes !== row.likes) data.likes = post.likes
      if (post.comments > 0 && post.comments !== row.comments) data.comments = post.comments
      const metricsChanged = Object.keys(data).length > 0
      // Durable thumbnail still missing (the capture's CDN URL expired first): take the fresh one.
      const refreshThumb = !row.hasThumb && !!post.thumbnailUrl
      if (refreshThumb) data.thumbnailUrl = post.thumbnailUrl

      if (!metricsChanged && !refreshThumb) {
        summary.unchanged++
        console.log(`[media-refresh] ${row.id} ${tag}: fetched, nothing to change (views ${post.views}, likes ${post.likes}, comments ${post.comments})`)
        continue
      }
      try {
        // Conditioned on insightsSource IS NULL: statistics a PM registered mid-run always win.
        const res = await prisma.media.updateMany({ where: { id: row.id, insightsSource: null }, data })
        if (res.count === 0) {
          summary.unchanged++
          console.log(`[media-refresh] ${row.id} ${tag}: skipped, the PM registered real statistics meanwhile`)
          continue
        }
        if (refreshThumb) {
          try {
            const { cacheMediaThumb } = await import('@/lib/thumb-cache')
            await cacheMediaThumb(row.id, { refresh: true })
          } catch (err) {
            console.error(`[media-refresh] ${row.id} thumb cache failed`, err instanceof Error ? err.message : err)
          }
        }
        if (metricsChanged) {
          summary.updated++
          console.log(`[media-refresh] ${row.id} ${tag}: views ${row.views} → ${data.views ?? row.views}, likes ${row.likes} → ${data.likes ?? row.likes}, comments ${row.comments} → ${data.comments ?? row.comments}`)
        } else {
          summary.unchanged++
        }
      } catch (err) {
        summary.failed++
        console.error(`[media-refresh] ${row.id} ${tag}: update failed`, err instanceof Error ? err.message : err)
      }
    }

    // Stamp this batch's reads NOW (both logs): a redeploy or OOM before the
    // next batch must not make tomorrow's run pay these rows again.
    await recordReads(touched)

    if (trippedMidBatch) { stop = 'apify_exhausted'; break }
    if (fetched.unresolved.size > 0 && remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }
  }

  return finish(stop)
}
