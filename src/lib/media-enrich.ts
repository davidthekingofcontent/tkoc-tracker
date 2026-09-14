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
      `stoppedBy=${summary.stoppedBy} in ${summary.durationMs} ms`)
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

  const touched: AttemptMap = {}
  let stop: EnrichStop = stoppedByLimit ? 'limit' : 'done'
  const deadlineAt = startedAt + budgetMs

  for (let i = 0; i < queue.length; i += POSTS_BATCH_MAX) {
    if (isApifyExhausted()) { stop = 'apify_exhausted'; break }
    // Before EACH batch: a run cannot be aborted, so only start it with a useful window left.
    if (remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }

    const batch = queue.slice(i, i + POSTS_BATCH_MAX)
    const attemptedAt = new Date().toISOString()

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

    if (trippedMidBatch) { stop = 'apify_exhausted'; break }
    // Rows the batch could not answer for lack of time: nothing more fits in this run.
    if (fetched.unresolved.size > 0 && remainingMs() < ENRICH_BATCH_RESERVE_MS) { stop = 'time'; break }
  }

  if (Object.keys(touched).length > 0) await saveAttempts(ATTEMPTS, { ...attempts, ...touched })
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
