/**
 * Durable thumbnails (media_thumbs).
 *
 * Instagram/TikTok CDN URLs stored in Media.thumbnailUrl expire after a few
 * days (403), which is why report and portal thumbnails went blank. We copy
 * the image once, while the URL is fresh (right after a capture, a Meta sync
 * or an Apify fetch), and serve it from /api/media/[id]/thumb for ever.
 *
 * Best effort by design: a failed copy never fails a capture or a sync.
 */

import { prisma } from '@/lib/db'

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

/** Fetch an image with a timeout, size cap and content-type check. null on any failure. */
export async function fetchImage(url: string): Promise<FetchedImage | null> {
  if (!isAllowedThumbHost(url)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: `https://${new URL(url).hostname}/`,
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

/** Backlog: media rows with a URL but no durable copy yet. */
export async function countMissingThumbs(campaignId?: string): Promise<{ missing: number; cached: number }> {
  const where = { ...(campaignId ? { campaignId } : { campaignId: { not: null } }), OR: [{ thumbnailUrl: { not: null } }, { mediaUrl: { not: null } }] }
  const [missing, cached] = await Promise.all([
    prisma.media.count({ where: { ...where, thumb: null } }),
    prisma.media.count({ where: { ...where, thumb: { isNot: null } } }),
  ])
  return { missing, cached }
}
