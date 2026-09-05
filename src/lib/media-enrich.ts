/**
 * MEDIA ENRICH — real views for the reels the Meta API cannot see.
 *
 * Why: a creator's reel that tags the brand reaches us through the brand's
 * Meta connection (source 'meta_api'), but Meta does not expose view counts of
 * OTHER accounts' media, so those rows are materialized with views = 0. The
 * public post page does show the play count, so we fetch it once through the
 * Apify single-post helper and store it. Real views are the third rung of the
 * audience ladder (reach → impressions → views, decision 5) and the only real
 * audience most reels will ever have — without them the reel falls back to an
 * estimate and leaves the ER/CPM base (decision 4A).
 *
 * Rules
 *  - Never lower a stored value: views/likes/comments are updated only when the
 *    fetched figure is higher than what we hold.
 *  - Bounded: `limit` rows per run (default 25) and a wall-clock budget
 *    (`timeBudgetMs`, default 240 s). One row is one Apify run that cannot be
 *    aborted mid-flight and can take from ~10 s to several minutes
 *    (waitForFinish + polling + fallback actor), so the budget is checked
 *    before EACH row and a row is started only while at least
 *    ENRICH_ROW_RESERVE_MS (45 s) remain. Stops as soon as the Apify circuit
 *    breaker is open (isApifyExhausted()).
 *  - Idempotent and thrifty: a row that was tried recently (RETRY_AFTER_MS) is
 *    skipped, so reels whose view count Instagram hides do not burn credits on
 *    every sync. Attempts live in Setting 'media_enrich_attempts' (JSON map
 *    mediaId → ISO date, pruned).
 *
 * Cost (Apify, Sept 2026): apify~instagram-post-scraper ≈ 0,002 $ per post
 * (one actor run per row). scrapeSinglePost falls back to
 * apify~instagram-scraper when the first actor returns nothing, so a removed
 * or private post can cost two runs (≈ 0,004 $). 25 rows ≈ 0,05–0,10 $.
 * Wall time ≈ 10–30 s per row (actor start + run), hence the time budget.
 */

import { prisma } from '@/lib/db'
import { isApifyExhausted, scrapeSinglePost } from '@/lib/apify'
import { MediaType, Platform, type Prisma } from '@/generated/prisma/client'

// ============ TYPES ============

export interface EnrichOptions {
  /** Restrict to one campaign's rows. */
  campaignId?: string
  /** Max rows fetched from Apify in this run (1–100, default 25). */
  limit?: number
  /**
   * Wall-clock budget (default 240 s). Checked before EACH row: a row is started
   * only while at least ENRICH_ROW_RESERVE_MS remain, because a single Apify run
   * cannot be cut short once started.
   */
  timeBudgetMs?: number
  /** Retry rows attempted recently (ignores RETRY_AFTER_MS). */
  force?: boolean
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
  /** Rows left out because they were attempted within RETRY_AFTER_MS. */
  skippedRecentAttempt: number
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

/** Rows still waiting for real views (with a permalink) and the unenrichable ones (without). */
export async function countPendingMetaReelViews(campaignId?: string): Promise<{ pending: number; withoutPermalink: number }> {
  const sel: Selection = { source: 'meta_api', mediaTypes: [MediaType.REEL, MediaType.VIDEO], campaignId }
  const [pending, withoutPermalink] = await Promise.all([
    prisma.media.count({ where: pendingWhere(sel, true) }),
    prisma.media.count({ where: pendingWhere(sel, false) }),
  ])
  return { pending, withoutPermalink }
}

// ============ ATTEMPT LOG (Setting) ============

const ATTEMPTS_KEY = 'media_enrich_attempts'
/** A row tried in the last 7 days is not retried (unless force). */
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000
/** Entries older than this are pruned when saving. */
const ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ATTEMPTS_MAX = 5000

type AttemptMap = Record<string, string>

async function loadAttempts(): Promise<AttemptMap> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: ATTEMPTS_KEY } })
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AttemptMap) : {}
  } catch {
    return {}
  }
}

async function saveAttempts(map: AttemptMap): Promise<void> {
  const cutoff = Date.now() - ATTEMPT_TTL_MS
  const entries = Object.entries(map)
    .filter(([, iso]) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= cutoff })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, ATTEMPTS_MAX)
  const value = JSON.stringify(Object.fromEntries(entries))
  try {
    await prisma.setting.upsert({ where: { key: ATTEMPTS_KEY }, update: { value }, create: { key: ATTEMPTS_KEY, value } })
  } catch (err) {
    console.error('[media-enrich] could not save attempt log:', err instanceof Error ? err.message : err)
  }
}

function attemptedRecently(map: AttemptMap, mediaId: string): boolean {
  const iso = map[mediaId]
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.now() - t < RETRY_AFTER_MS
}

// ============ TIME BUDGET ============

/**
 * Time a single row needs before it is started: one Apify run (actor start +
 * run, usually 10–30 s, sometimes far more). No row is started once less than
 * this remains of the budget — callers with little slack (meta-sync at the end
 * of a cron sync) skip the enrichment altogether below this.
 */
export const ENRICH_ROW_RESERVE_MS = 45_000
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
    skippedNoPermalink: 0, skippedRecentAttempt: 0, pendingAfter: 0,
    stoppedBy: 'done', durationMs: 0,
  }
  const finish = async (stoppedBy: EnrichStop): Promise<EnrichSummary> => {
    summary.stoppedBy = stoppedBy
    summary.durationMs = Date.now() - startedAt
    summary.pendingAfter = await prisma.media.count({ where: pendingWhere(sel, true) }).catch(() => 0)
    console.log(`[media-enrich] ${sel.source} ${sel.mediaTypes.join('/')}${sel.campaignId ? ` campaign=${sel.campaignId}` : ''}: ` +
      `scanned=${summary.scanned} updated=${summary.updated} unchanged=${summary.unchanged} failed=${summary.failed} ` +
      `noPermalink=${summary.skippedNoPermalink} recent=${summary.skippedRecentAttempt} pendingAfter=${summary.pendingAfter} ` +
      `stoppedBy=${summary.stoppedBy} in ${summary.durationMs} ms`)
    return summary
  }

  summary.skippedNoPermalink = await prisma.media.count({ where: pendingWhere(sel, false) })

  if (isApifyExhausted()) return finish('apify_exhausted')

  // Over-fetch so recently-attempted rows do not eat the whole batch, then trim.
  const attempts = options.force ? {} : await loadAttempts()
  const candidates = await prisma.media.findMany({
    where: pendingWhere(sel, true),
    orderBy: { postedAt: 'desc' },
    take: options.force ? limit : limit * 4,
    select: {
      id: true, permalink: true, views: true, likes: true, comments: true, campaignId: true,
      influencer: { select: { username: true } },
    },
  })
  const rows: typeof candidates = []
  for (const c of candidates) {
    if (rows.length >= limit) break
    if (attemptedRecently(attempts, c.id)) { summary.skippedRecentAttempt++; continue }
    rows.push(c)
  }
  // Candidates beyond the limit that were not inspected do not count as skipped.
  const stoppedByLimit = candidates.length > rows.length + summary.skippedRecentAttempt

  const touched: AttemptMap = {}
  let stop: EnrichStop = stoppedByLimit ? 'limit' : 'done'

  for (const row of rows) {
    if (isApifyExhausted()) { stop = 'apify_exhausted'; break }
    // Before EACH row: the fetch below cannot be aborted, so only start it with a full reserve left.
    if (remainingMs() < ENRICH_ROW_RESERVE_MS) { stop = 'time'; break }
    if (!row.permalink) { summary.skippedNoPermalink++; continue } // defensive: filtered by the query

    summary.scanned++
    touched[row.id] = new Date().toISOString()
    const tag = `@${row.influencer?.username ?? '?'} ${row.permalink}`

    let post: Awaited<ReturnType<typeof scrapeSinglePost>> = null
    try {
      post = await scrapeSinglePost(row.permalink)
    } catch (err) {
      console.error(`[media-enrich] ${row.id} ${tag}: fetch threw`, err instanceof Error ? err.message : err)
    }
    if (!post) {
      summary.failed++
      console.warn(`[media-enrich] ${row.id} ${tag}: public post not fetched (removed, private or actor error)`)
      // A null caused by the breaker tripping mid-run is not this row's fault: let it retry.
      if (isApifyExhausted()) { delete touched[row.id]; stop = 'apify_exhausted'; break }
      continue
    }

    // Never lower a stored value.
    const data: Prisma.MediaUpdateInput = {}
    if (post.views > row.views) data.views = post.views
    if (post.likes > row.likes) data.likes = post.likes
    if (post.comments > row.comments) data.comments = post.comments
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

  if (Object.keys(touched).length > 0) await saveAttempts({ ...attempts, ...touched })
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
