/**
 * Admin: real views for Meta-attributed reels (see src/lib/media-enrich.ts).
 *
 * GET  → backlog: how many meta_api reels/videos still have views = 0 (with a
 *        permalink, i.e. enrichable) and how many can never be enriched (no
 *        permalink), plus the Apify circuit-breaker state. `?campaignId=` scopes it.
 * POST { campaignId?, limit?, force? } → runs enrichMetaReelViews and returns
 *        the summary. Each fetched row costs an Apify run (≈ 0,002 $).
 *
 * ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getApifyResumeDate, isApifyExhausted } from '@/lib/apify'
import { countPendingMetaReelViews, enrichMetaReelViews } from '@/lib/media-enrich'

// Up to 100 rows × ~10–30 s each: allow a long request (Vercel-style hint; harmless elsewhere).
export const maxDuration = 300

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  const campaignId = optionalId(request.nextUrl.searchParams.get('campaignId'))
  const backlog = await countPendingMetaReelViews(campaignId)
  return NextResponse.json({
    campaignId: campaignId ?? null,
    pending: backlog.pending,
    withoutPermalink: backlog.withoutPermalink,
    apifyExhausted: isApifyExhausted(),
    apifyResumeAt: getApifyResumeDate(),
    estimatedCostUsd: Math.round(backlog.pending * 0.002 * 1000) / 1000,
    timestamp: new Date().toISOString(),
  })
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  let body: { campaignId?: unknown; limit?: unknown; force?: unknown } = {}
  try {
    body = (await request.json().catch(() => ({}))) as typeof body
  } catch { /* no body */ }

  const campaignId = optionalId(body.campaignId)
  const limitRaw = typeof body.limit === 'number' ? body.limit : parseInt(String(body.limit ?? ''), 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 100) : 25
  const force = body.force === true

  if (isApifyExhausted()) {
    return NextResponse.json(
      { error: 'Apify monthly limit exhausted', apifyResumeAt: getApifyResumeDate() },
      { status: 503 }
    )
  }

  try {
    const summary = await enrichMetaReelViews({ campaignId, limit, force })
    return NextResponse.json({ campaignId: campaignId ?? null, limit, force, ...summary })
  } catch (error) {
    console.error('[admin/enrich-views] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
