/**
 * Admin: durable thumbnails (see src/lib/thumb-cache.ts).
 * GET  → backlog (media with a URL but no copy, and how many of those the
 *        embed path can still rescue). `?campaignId=` scopes it.
 * POST { campaignId?, limit?, refresh? } → copies up to `limit` thumbnails now
 *        from their stored CDN URL (plain downloads).
 * POST { mode: 'embed', campaignId?, limit? } → recovers expired ones through
 *        the public Instagram embed page in a headless Chromium; rows whose
 *        embed shows no image are skipped for 7 days (returned as failedIds).
 * ADMIN only. No Apify cost in either mode.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { backfillMediaThumbs, countMissingThumbs, isEmbedRecoveryAvailable, recoverThumbsViaEmbed } from '@/lib/thumb-cache'

export const maxDuration = 300

const TIME_BUDGET_MS = 240_000

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseLimit(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), 500) : fallback
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  const campaignId = optionalId(request.nextUrl.searchParams.get('campaignId'))
  return NextResponse.json({
    campaignId: campaignId ?? null,
    ...(await countMissingThumbs(campaignId)),
    embedRecoveryAvailable: isEmbedRecoveryAvailable(),
  })
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  let body: { mode?: unknown; campaignId?: unknown; limit?: unknown; refresh?: unknown } = {}
  try { body = (await request.json().catch(() => ({}))) as typeof body } catch { /* no body */ }
  const campaignId = optionalId(body.campaignId)

  if (body.mode === 'embed') {
    const limit = parseLimit(body.limit, 40)
    const summary = await recoverThumbsViaEmbed({ campaignId, limit, timeBudgetMs: TIME_BUDGET_MS })
    return NextResponse.json({ mode: 'embed', campaignId: campaignId ?? null, limit, ...summary })
  }

  const limit = parseLimit(body.limit, 100)
  const summary = await backfillMediaThumbs({ campaignId, limit, refresh: body.refresh === true, timeBudgetMs: TIME_BUDGET_MS })
  return NextResponse.json({ mode: 'direct', campaignId: campaignId ?? null, limit, ...summary })
}
