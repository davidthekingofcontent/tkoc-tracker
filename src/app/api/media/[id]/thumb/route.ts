/**
 * GET /api/media/[id]/thumb — the publication's thumbnail, served from the
 * durable copy (media_thumbs). Without a copy it fetches the CDN URL once,
 * stores it and serves it; if the CDN URL has expired it tries the free
 * embed-page recovery for this one post (bounded: one Chromium at a time,
 * inside the PDF renderer's slot, 2 s apart, at most 12 s of wait, and never
 * again for 7 days once the embed showed no image) and otherwise → 404 (the
 * UI shows a placeholder). Media ids are unguessable cuids and the images are public
 * post covers, so the route needs no session (like /api/proxy/image).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cacheMediaThumb, recoverThumbViaEmbedOnce } from '@/lib/thumb-cache'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400' }
const EMBED_MAX_WAIT_MS = 12_000

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return new NextResponse('Not found', { status: 404 })
  let thumb = await prisma.mediaThumb.findUnique({ where: { mediaId: id }, select: { data: true, contentType: true } })
  if (!thumb) {
    try {
      let r: string = await cacheMediaThumb(id)
      // Stored URL dead (or absent): one bounded attempt through the embed page.
      if (r !== 'cached') r = await recoverThumbViaEmbedOnce(id, { maxWaitMs: EMBED_MAX_WAIT_MS })
      if (r === 'cached' || r === 'recovered') thumb = await prisma.mediaThumb.findUnique({ where: { mediaId: id }, select: { data: true, contentType: true } })
    } catch (err) {
      console.error(`[media-thumb] ${id}:`, err instanceof Error ? err.message : err)
    }
  }
  if (!thumb) return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  return new NextResponse(Buffer.from(thumb.data), { status: 200, headers: { 'Content-Type': thumb.contentType, ...CACHE_HEADERS } })
}
