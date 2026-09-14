/**
 * Admin: durable creator avatars (see src/lib/thumb-cache.ts).
 * GET  → backlog (influencers with an avatarUrl but no copy) and how many
 *        already have one.
 * POST { limit?, refresh? } → copies up to `limit` avatars now from their
 *        stored CDN URL, most recently scraped first (plain downloads). With
 *        `refresh` it also re-copies rows whose source URL changed.
 * ADMIN only. No Apify cost.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { backfillInfluencerAvatars, countMissingAvatars } from '@/lib/thumb-cache'

export const maxDuration = 300

const TIME_BUDGET_MS = 240_000

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

function parseLimit(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), 500) : fallback
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  return NextResponse.json(await countMissingAvatars())
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  let body: { limit?: unknown; refresh?: unknown } = {}
  try { body = (await request.json().catch(() => ({}))) as typeof body } catch { /* no body */ }
  const limit = parseLimit(body.limit, 100)
  const summary = await backfillInfluencerAvatars({ limit, refresh: body.refresh === true, timeBudgetMs: TIME_BUDGET_MS })
  return NextResponse.json({ limit, ...summary })
}
