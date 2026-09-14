/**
 * GET /api/influencers/[id]/avatar — the creator's profile picture, served
 * from the durable copy (influencer_avatars). Without a copy it fetches the
 * stored CDN URL once, stores it and serves it; if that URL has expired →
 * 404 (the Avatar component falls back to initials). A dead URL is tried
 * once per hour, not on every render: the 404 carries a 1 h public cache
 * and the process remembers the failed id for the same hour (no DB round
 * trips, no upstream fetch meanwhile). A fresh scrape stores a new copy via
 * afterInfluencerUpsert, which the DB lookup sees before the memo.
 * Influencer ids are unguessable cuids and the pictures are public profile
 * photos, so the route needs no session — same policy as /api/media/[id]/thumb.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cacheInfluencerAvatar } from '@/lib/thumb-cache'

export const dynamic = 'force-dynamic'

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400' }
const NEGATIVE_TTL_MS = 60 * 60 * 1000
const NEGATIVE_HEADERS = { 'Cache-Control': `public, max-age=${NEGATIVE_TTL_MS / 1000}` }
const FAILED_MAX_ENTRIES = 5000

// id → time of the last failed fetch (per process; bounded, oldest evicted).
const failedRecently = new Map<string, number>()

function rememberFailure(id: string): void {
  if (failedRecently.size >= FAILED_MAX_ENTRIES) {
    const oldest = failedRecently.keys().next().value
    if (oldest !== undefined) failedRecently.delete(oldest)
  }
  failedRecently.set(id, Date.now())
}

function failedWithinTtl(id: string): boolean {
  const at = failedRecently.get(id)
  if (at === undefined) return false
  if (Date.now() - at < NEGATIVE_TTL_MS) return true
  failedRecently.delete(id)
  return false
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return new NextResponse('Not found', { status: 404 })
  let avatar = await prisma.influencerAvatar.findUnique({ where: { influencerId: id }, select: { data: true, contentType: true } })
  if (!avatar && !failedWithinTtl(id)) {
    try {
      const r = await cacheInfluencerAvatar(id)
      if (r === 'cached') avatar = await prisma.influencerAvatar.findUnique({ where: { influencerId: id }, select: { data: true, contentType: true } })
      else rememberFailure(id)
    } catch (err) {
      rememberFailure(id)
      console.error(`[influencer-avatar] ${id}:`, err instanceof Error ? err.message : err)
    }
  }
  if (!avatar) return new NextResponse('Not found', { status: 404, headers: NEGATIVE_HEADERS })
  return new NextResponse(Buffer.from(avatar.data), { status: 200, headers: { 'Content-Type': avatar.contentType, ...CACHE_HEADERS } })
}
