/**
 * Durable thumbnails (media_thumbs).
 *
 * Instagram/TikTok CDN URLs stored in Media.thumbnailUrl expire after a few
 * days (403), which is why report and portal thumbnails went blank. We copy
 * the image once, while the URL is fresh (right after a capture, a Meta sync
 * or an Apify fetch), and serve it from /api/media/[id]/thumb for ever.
 *
 * Best effort by design: a failed copy never fails a capture or a sync.
 *
 * Expired URLs (no copy, CDN answers 403) have a free recovery path: the
 * public embed page of the post (instagram.com/p/<code>/embed/) still exposes
 * the cover image, so a headless Chromium (the one that already prints the
 * PDFs) renders it and we copy the image it shows. Zero Apify cost.
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { prisma } from '@/lib/db'
import { acquireChromiumSlot, LAUNCH_ARGS, releaseChromiumSlot, resolveChromiumExecutable } from '@/lib/report-pdf'
import { attemptedRecently, loadAttempts, recentlyAttemptedIds, saveAttempts, type AttemptLogSpec } from '@/lib/attempt-log'

const MAX_BYTES = 800_000
const FETCH_TIMEOUT_MS = 10_000
const ALLOWED_HOSTS = [
  'cdninstagram.com', 'fbcdn.net', 'instagram.com',
  'googleusercontent.com', 'ggpht.com', 'ytimg.com',
  'tiktokcdn.com', 'tiktokcdn-us.com', 'muscdn.com', 'pbs.twimg.com',
]

export function isAllowedThumbHost(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a))
  } catch { return false }
}

export interface FetchedImage { data: Uint8Array<ArrayBuffer>; contentType: string }

/**
 * Fetch an image with a timeout, size cap and content-type check. null on any
 * failure. `referer` overrides the default (the image host itself); the
 * Instagram CDN wants https://www.instagram.com/ for embed-page images.
 */
export async function fetchImage(url: string, options: { referer?: string } = {}): Promise<FetchedImage | null> {
  if (!isAllowedThumbHost(url)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: options.referer || `https://${new URL(url).hostname}/`,
      },
    })
    if (!res.ok) return null
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (!contentType.startsWith('image/')) return null
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_BYTES) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_BYTES) return null
    return { data: buf, contentType }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type CacheThumbResult = 'cached' | 'kept' | 'no_url' | 'fetch_failed'

/**
 * Copy the thumbnail of one publication. Keeps an existing copy unless the
 * source URL changed (fresh scrape) and `refresh` is set, or `force`.
 */
export async function cacheMediaThumb(
  mediaId: string,
  options: { force?: boolean; refresh?: boolean } = {}
): Promise<CacheThumbResult> {
  const row = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { thumbnailUrl: true, mediaUrl: true, thumb: { select: { sourceUrl: true } } },
  })
  if (!row) return 'no_url'
  const url = row.thumbnailUrl || row.mediaUrl
  if (!url) return 'no_url'
  if (row.thumb && !options.force && !(options.refresh && row.thumb.sourceUrl !== url)) return 'kept'
  const img = await fetchImage(url)
  if (!img) return 'fetch_failed'
  await prisma.mediaThumb.upsert({
    where: { mediaId },
    create: { mediaId, data: img.data, contentType: img.contentType, bytes: img.data.length, sourceUrl: url },
    update: { data: img.data, contentType: img.contentType, bytes: img.data.length, sourceUrl: url },
  })
  return 'cached'
}

export interface BackfillSummary { scanned: number; cached: number; failed: number; kept: number; stop: 'done' | 'limit' | 'time' }

/**
 * Copy the thumbnails that are still missing (or whose source URL changed),
 * newest first, within a row limit and a wall-clock budget. Safe to call
 * after every capture/sync.
 */
export async function backfillMediaThumbs(options: { campaignId?: string; limit?: number; timeBudgetMs?: number; refresh?: boolean } = {}): Promise<BackfillSummary> {
  const limit = Math.min(Math.max(Math.round(options.limit ?? 40), 1), 500)
  const budget = Math.max(1_000, options.timeBudgetMs ?? 60_000)
  const started = Date.now()
  const summary: BackfillSummary = { scanned: 0, cached: 0, failed: 0, kept: 0, stop: 'done' }
  const rows = await prisma.media.findMany({
    where: {
      ...(options.campaignId ? { campaignId: options.campaignId } : { campaignId: { not: null } }),
      OR: [{ thumbnailUrl: { not: null } }, { mediaUrl: { not: null } }],
      ...(options.refresh ? {} : { thumb: null }),
    },
    select: { id: true },
    orderBy: { postedAt: 'desc' },
    take: limit + 1,
  })
  if (rows.length > limit) summary.stop = 'limit'
  for (const row of rows.slice(0, limit)) {
    if (Date.now() - started > budget) { summary.stop = 'time'; break }
    summary.scanned++
    try {
      const r = await cacheMediaThumb(row.id, { refresh: options.refresh })
      if (r === 'cached') summary.cached++
      else if (r === 'kept') summary.kept++
      else summary.failed++
    } catch (err) {
      summary.failed++
      console.error(`[thumb-cache] ${row.id}:`, err instanceof Error ? err.message : err)
    }
  }
  if (summary.scanned > 0) console.log(`[thumb-cache] backfill${options.campaignId ? ' ' + options.campaignId : ''}: ${summary.cached} cached, ${summary.kept} kept, ${summary.failed} failed (${summary.stop})`)
  return summary
}

/**
 * Backlog: media rows with a URL but no durable copy yet. `recoverableViaEmbed`
 * is the subset of `missing` the embed path can still rescue (live Instagram
 * post with a permalink, not tried in the last EMBED_ATTEMPTS.retryAfterMs).
 */
export async function countMissingThumbs(campaignId?: string): Promise<{ missing: number; cached: number; recoverableViaEmbed: number }> {
  const where = { ...(campaignId ? { campaignId } : { campaignId: { not: null } }), OR: [{ thumbnailUrl: { not: null } }, { mediaUrl: { not: null } }] }
  const attempts = await loadAttempts(EMBED_ATTEMPTS)
  const [missing, cached, recoverableViaEmbed] = await Promise.all([
    prisma.media.count({ where: { ...where, thumb: null } }),
    prisma.media.count({ where: { ...where, thumb: { isNot: null } } }),
    prisma.media.count({ where: { ...embedRecoveryWhere(campaignId), OR: where.OR, id: { notIn: recentlyAttemptedIds(EMBED_ATTEMPTS, attempts) } } }),
  ])
  return { missing, cached, recoverableViaEmbed }
}


// ============ Free recovery of expired thumbnails via the Instagram embed page ============

const EMBED_NAV_TIMEOUT_MS = 15_000
const EMBED_PAUSE_BETWEEN_POSTS_MS = 1_000
const EMBED_MIN_GAP_MS = 2_000
const EMBED_REFERER = 'https://www.instagram.com/'
/**
 * The embed page is third-party content rendered without the Chromium sandbox
 * (LAUNCH_ARGS), so it gets no scripts and only its document and images:
 * the cover <img class="EmbeddedMediaImage"> is in the static HTML. Flip to
 * true only if a live check shows the embed needs scripts to show the image.
 */
const EMBED_ALLOW_SCRIPTS = false

/**
 * Attempt memory: a row whose embed showed no image (removed/private post,
 * unsupported permalink) is not tried again for 7 days, by the admin batch or
 * by the thumbnail route — otherwise it is re-rendered on every run / page
 * view and, newest first, starves the rows behind it.
 */
const EMBED_ATTEMPTS: AttemptLogSpec = {
  key: 'thumb_embed_attempts',
  retryAfterMs: 7 * 24 * 60 * 60 * 1000,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  max: 5000,
}
/** In-process twin of the attempt log for the once-path: no DB read per page view of a dead thumbnail. */
const onceFailedAt = new Map<string, number>()
const ONCE_FAILED_MAX = 2_000

/**
 * In-process mutex: one headless Chromium for thumbnails at a time, 2 s apart.
 * Check-and-set must be synchronous (no await between them); see tryTakeEmbedLock().
 */
let embedRecoveryActive = false
let lastEmbedRecoveryEndedAt = 0

/** Take the embed mutex if free (and, for `respectGap`, if the last one ended ≥ 2 s ago). Synchronous on purpose. */
function tryTakeEmbedLock(respectGap: boolean): boolean {
  if (embedRecoveryActive) return false
  if (respectGap && Date.now() - lastEmbedRecoveryEndedAt < EMBED_MIN_GAP_MS) return false
  embedRecoveryActive = true
  return true
}

function releaseEmbedLock(): void {
  embedRecoveryActive = false
  lastEmbedRecoveryEndedAt = Date.now()
}

/** Rows the embed path can rescue: live Instagram post, in a campaign, with a permalink, no durable copy. */
function embedRecoveryWhere(campaignId?: string) {
  return {
    platform: 'INSTAGRAM' as const,
    isDeleted: false,
    permalink: { not: null },
    thumb: null,
    ...(campaignId ? { campaignId } : { campaignId: { not: null } }),
  }
}

/**
 * The public embed URL of a post: https://www.instagram.com/<p|reel|tv>/<code>/embed/.
 * Accepts the permalink variants Meta and Apify store (username prefix,
 * "reels", query strings). null when it is not an Instagram post URL.
 */
export function instagramEmbedUrl(permalink: string): string | null {
  try {
    const u = new URL(permalink)
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/(?:[A-Za-z0-9_.]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/)
    if (!m) return null
    const kind = m[1] === 'reels' ? 'reel' : m[1]
    return `https://www.instagram.com/${kind}/${m[2]}/embed/`
  } catch {
    return null
  }
}

function chromiumExecutableOrNull(): string | null {
  try { return resolveChromiumExecutable() } catch { return null }
}

/** Whether a headless Chromium is available for the embed recovery on this host. */
export function isEmbedRecoveryAvailable(): boolean {
  return chromiumExecutableOrNull() !== null
}

/**
 * Launch the embed browser inside the shared Chromium slot (report-pdf's
 * semaphore: PDF renders + this one never exceed MAX_CONCURRENT_RENDERS).
 * The returned `close` releases the slot; call it in a finally.
 */
async function launchEmbedBrowser(executablePath: string): Promise<{ browser: Browser; close: () => Promise<void> }> {
  await acquireChromiumSlot()
  let browser: Browser
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [...LAUNCH_ARGS, '--blink-settings=imagesEnabled=true'],
    })
  } catch (err) {
    releaseChromiumSlot()
    throw err
  }
  return {
    browser,
    close: async () => {
      try { await browser.close() } catch { /* already gone */ }
      releaseChromiumSlot()
    },
  }
}

/** A page hardened for third-party content: no scripts, only the document and its images. */
async function newEmbedPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage()
  await page.setViewport({ width: 800, height: 900, deviceScaleFactor: 1 })
  if (!EMBED_ALLOW_SCRIPTS) {
    await page.setJavaScriptEnabled(false)
    await page.setRequestInterception(true)
    page.on('request', req => {
      const type = req.resourceType()
      if (type === 'document' || type === 'image') void req.continue()
      else void req.abort()
    })
  }
  return page
}

/** Render the embed page and return the URL of the post image it shows (null if none). */
async function readEmbedImageUrl(page: Page, embedUrl: string): Promise<string | null> {
  try {
    await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: EMBED_NAV_TIMEOUT_MS })
  } catch (err) {
    // A navigation timeout after the DOM is there is not fatal: read what loaded.
    if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
  }
  await page.waitForSelector('img.EmbeddedMediaImage', { timeout: 2_000 }).catch(() => {})
  const src = await page.evaluate(() => {
    const srcOf = (img: HTMLImageElement) => img.currentSrc || img.src || ''
    const primary = document.querySelector<HTMLImageElement>('img.EmbeddedMediaImage')
    if (primary && srcOf(primary)) return srcOf(primary)
    const fallback = Array.from(document.querySelectorAll<HTMLImageElement>('img'))
      .find(img => /cdninstagram/i.test(srcOf(img)) && img.naturalWidth >= 100)
    return fallback ? srcOf(fallback) : null
  })
  return typeof src === 'string' && /^https:\/\//.test(src) ? src : null
}

/** One post: embed page → image URL → download → media_thumbs. true when stored. */
async function recoverRowViaEmbed(page: Page, row: { id: string; permalink: string | null }): Promise<boolean> {
  const embedUrl = row.permalink ? instagramEmbedUrl(row.permalink) : null
  if (!embedUrl) return false
  const imageUrl = await readEmbedImageUrl(page, embedUrl)
  if (!imageUrl) return false
  const img = await fetchImage(imageUrl, { referer: EMBED_REFERER })
  if (!img) return false
  // media_thumbs has no "origin" column: the CDN URL taken from the embed is
  // the sourceUrl, which is enough for `refresh` comparisons and for audits.
  await prisma.mediaThumb.upsert({
    where: { mediaId: row.id },
    create: { mediaId: row.id, data: img.data, contentType: img.contentType, bytes: img.data.length, sourceUrl: imageUrl },
    update: { data: img.data, contentType: img.contentType, bytes: img.data.length, sourceUrl: imageUrl },
  })
  return true
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ============ EXISTENCE CHECK (deleted posts) ============

export type PostExistence = 'exists' | 'missing' | 'unknown'

const NOT_AVAILABLE_MARKERS = [
  "page isn't available", 'page is not available', 'no está disponible', 'no esta disponible',
  'esta página no está disponible', 'link you followed may be broken', 'enlace que has seguido',
  'sorry, this page', 'lo sentimos, esta página',
]

/**
 * Does the post still exist? Rendered through the public embed page (the only
 * signal Instagram gives a server without login): the cover image present →
 * exists; a 404 or an explicit "not available" page → missing; anything else
 * (timeouts, login walls, empty shells) → unknown, never "deleted".
 * 2026-09-12 lesson: a HEAD request that gets redirected to /accounts/login
 * is NOT a deleted post — that heuristic marked 74 live posts as deleted.
 */
export async function checkInstagramPostsExist(
  permalinks: string[],
  options: { timeBudgetMs?: number } = {}
): Promise<Map<string, PostExistence>> {
  const out = new Map<string, PostExistence>()
  const executablePath = resolveChromiumExecutable()
  if (!executablePath) { for (const p of permalinks) out.set(p, 'unknown'); return out }
  const started = Date.now()
  const budget = Math.max(10_000, options.timeBudgetMs ?? 240_000)
  const { browser, close } = await launchEmbedBrowser(executablePath)
  try {
    const page = await newEmbedPage(browser)
    for (const permalink of permalinks) {
      if (Date.now() - started > budget) { out.set(permalink, 'unknown'); continue }
      const embedUrl = instagramEmbedUrl(permalink)
      if (!embedUrl) { out.set(permalink, 'unknown'); continue }
      try {
        let status: number | null = null
        try {
          const res = await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: EMBED_NAV_TIMEOUT_MS })
          status = res ? res.status() : null
        } catch (err) {
          if (!(err instanceof Error) || !/timeout/i.test(err.message)) throw err
        }
        if (status === 404) { out.set(permalink, 'missing'); continue }
        await page.waitForSelector('img.EmbeddedMediaImage', { timeout: 2_000 }).catch(() => {})
        const probe = await page.evaluate(() => {
          const img = document.querySelector<HTMLImageElement>('img.EmbeddedMediaImage')
          const anyCdn = Array.from(document.querySelectorAll<HTMLImageElement>('img')).some(i => /cdninstagram/i.test(i.currentSrc || i.src || '') && i.naturalWidth >= 100)
          return { hasImage: !!(img && (img.currentSrc || img.src)) || anyCdn, text: (document.body?.innerText || '').slice(0, 4000).toLowerCase() }
        })
        if (probe.hasImage) out.set(permalink, 'exists')
        else if (status === 200 && NOT_AVAILABLE_MARKERS.some(m => probe.text.includes(m))) out.set(permalink, 'missing')
        else out.set(permalink, 'unknown')
      } catch (err) {
        console.warn('[post-exists]', permalink, err instanceof Error ? err.message : err)
        out.set(permalink, 'unknown')
      }
      await sleep(EMBED_PAUSE_BETWEEN_POSTS_MS)
    }
  } finally {
    await close()
  }
  return out
}

export interface EmbedRecoverySummary {
  scanned: number
  recovered: number
  failed: number
  /** Ids that failed this run (now in the attempt log for 7 days), so the operator can see what is stuck. */
  failedIds: string[]
  /** Rows left out because they were tried within the last 7 days. */
  skippedRecentAttempt: number
  stop: 'done' | 'limit' | 'time' | 'no_chromium' | 'busy'
}

/**
 * Recover expired thumbnails through the public embed page, newest first,
 * one page at a time with a short pause between posts, within a row limit
 * (default 40) and a wall-clock budget (default 240 s). One Chromium for the
 * whole batch, closed whatever happens. Rows that failed are logged and not
 * retried for 7 days. No Apify involved.
 */
export async function recoverThumbsViaEmbed(options: { campaignId?: string; limit?: number; timeBudgetMs?: number } = {}): Promise<EmbedRecoverySummary> {
  const limit = Math.min(Math.max(Math.round(options.limit ?? 40), 1), 500)
  const budget = Math.max(5_000, options.timeBudgetMs ?? 240_000)
  const started = Date.now()
  const summary: EmbedRecoverySummary = { scanned: 0, recovered: 0, failed: 0, failedIds: [], skippedRecentAttempt: 0, stop: 'done' }

  const executablePath = chromiumExecutableOrNull()
  if (!executablePath) { summary.stop = 'no_chromium'; return summary }
  // Lock BEFORE the query: check-and-set with an await in between let two admin calls both launch.
  if (!tryTakeEmbedLock(false)) { summary.stop = 'busy'; return summary }

  const touched: Record<string, string> = {}
  try {
    const attempts = await loadAttempts(EMBED_ATTEMPTS)
    const recentIds = recentlyAttemptedIds(EMBED_ATTEMPTS, attempts)
    const rows = await prisma.media.findMany({
      where: { ...embedRecoveryWhere(options.campaignId), ...(recentIds.length > 0 ? { id: { notIn: recentIds } } : {}) },
      select: { id: true, permalink: true },
      orderBy: { postedAt: 'desc' },
      take: limit + 1,
    })
    summary.skippedRecentAttempt = recentIds.length
    if (rows.length > limit) summary.stop = 'limit'
    const targets = rows.slice(0, limit)
    if (targets.length === 0) return summary

    let launched: Awaited<ReturnType<typeof launchEmbedBrowser>> | null = null
    try {
      launched = await launchEmbedBrowser(executablePath)
      const page = await newEmbedPage(launched.browser)
      for (let i = 0; i < targets.length; i++) {
        if (Date.now() - started > budget) { summary.stop = 'time'; break }
        if (i > 0) await sleep(EMBED_PAUSE_BETWEEN_POSTS_MS)
        const row = targets[i]
        summary.scanned++
        try {
          if (await recoverRowViaEmbed(page, row)) {
            summary.recovered++
          } else {
            // Rendered, no image (removed/private post): remembered for 7 days.
            summary.failed++
            summary.failedIds.push(row.id)
            touched[row.id] = new Date().toISOString()
          }
        } catch (err) {
          // Navigation/browser error: counted, but not remembered — it retries next run.
          summary.failed++
          summary.failedIds.push(row.id)
          console.error(`[thumb-cache] embed ${row.id}:`, err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      // Launch or page failure: whatever was not scanned counts as nothing; report it.
      console.error('[thumb-cache] embed recovery aborted:', err instanceof Error ? err.message : err)
    } finally {
      if (launched) await launched.close()
    }
    if (Object.keys(touched).length > 0) await saveAttempts(EMBED_ATTEMPTS, { ...attempts, ...touched })
  } finally {
    releaseEmbedLock()
  }
  console.log(`[thumb-cache] embed recovery${options.campaignId ? ' ' + options.campaignId : ''}: ${summary.recovered} recovered, ${summary.failed} failed of ${summary.scanned} (${summary.stop}; ${summary.skippedRecentAttempt} tried recently)`)
  return summary
}

export type EmbedRecoverOnceResult = 'recovered' | 'failed' | 'skipped' | 'attempted_recently' | 'timeout' | 'no_chromium'

/** Remember a once-path failure in memory (bounded) and in the shared attempt log. */
async function rememberOnceFailure(mediaId: string): Promise<void> {
  if (onceFailedAt.size >= ONCE_FAILED_MAX) {
    const oldest = onceFailedAt.keys().next().value
    if (oldest !== undefined) onceFailedAt.delete(oldest)
  }
  onceFailedAt.set(mediaId, Date.now())
  const attempts = await loadAttempts(EMBED_ATTEMPTS)
  await saveAttempts(EMBED_ATTEMPTS, { ...attempts, [mediaId]: new Date().toISOString() })
}

/**
 * On-demand recovery of ONE publication, for the thumbnail route: runs only
 * when no other embed recovery is running or ended in the last 2 s, never for
 * a row that failed in the last 7 days (in-process memo + attempt log), and
 * never makes the caller wait more than `maxWaitMs` (the copy, if it arrives
 * later, is stored anyway and served on the next request).
 */
export async function recoverThumbViaEmbedOnce(mediaId: string, options: { maxWaitMs?: number } = {}): Promise<EmbedRecoverOnceResult> {
  const maxWait = Math.max(1_000, options.maxWaitMs ?? 12_000)
  const memo = onceFailedAt.get(mediaId)
  if (memo !== undefined && Date.now() - memo < EMBED_ATTEMPTS.retryAfterMs) return 'attempted_recently'
  const executablePath = chromiumExecutableOrNull()
  if (!executablePath) return 'no_chromium'
  const row = await prisma.media.findFirst({
    where: { id: mediaId, ...embedRecoveryWhere() },
    select: { id: true, permalink: true },
  })
  if (!row) return 'failed'
  const attempts = await loadAttempts(EMBED_ATTEMPTS)
  if (attemptedRecently(EMBED_ATTEMPTS, attempts, mediaId)) {
    onceFailedAt.set(mediaId, Date.parse(attempts[mediaId]))
    return 'attempted_recently'
  }
  if (!tryTakeEmbedLock(true)) return 'skipped'

  const job: Promise<EmbedRecoverOnceResult> = (async () => {
    let launched: Awaited<ReturnType<typeof launchEmbedBrowser>> | null = null
    let result: EmbedRecoverOnceResult = 'failed'
    let rendered = false
    try {
      launched = await launchEmbedBrowser(executablePath)
      const page = await newEmbedPage(launched.browser)
      const ok = await recoverRowViaEmbed(page, row)
      rendered = true
      result = ok ? 'recovered' : 'failed'
    } catch (err) {
      console.error(`[thumb-cache] embed ${mediaId}:`, err instanceof Error ? err.message : err)
    } finally {
      if (launched) await launched.close()
      releaseEmbedLock()
    }
    // Rendered with no image (removed/private post): remembered for 7 days. A
    // launch/navigation error is not, so the next view can try again.
    if (result === 'failed' && rendered) await rememberOnceFailure(mediaId).catch(() => {})
    return result
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<EmbedRecoverOnceResult>(resolve => { timer = setTimeout(() => resolve('timeout'), maxWait) })
  try {
    return await Promise.race([job, deadline])
  } finally {
    clearTimeout(timer)
  }
}
