/**
 * Admin: durable thumbnails (see src/lib/thumb-cache.ts).
 * GET  → backlog (media with a URL but no copy). `?campaignId=` scopes it.
 * POST { campaignId?, limit?, refresh? } → copies up to `limit` thumbnails now.
 * ADMIN only. No Apify cost: plain image downloads.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { backfillMediaThumbs, countMissingThumbs } from '@/lib/thumb-cache'

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
  return NextResponse.json({ campaignId: campaignId ?? null, ...(await countMissingThumbs(campaignId)) })
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  let body: { campaignId?: unknown; limit?: unknown; refresh?: unknown } = {}
  try { body = (await request.json().catch(() => ({}))) as typeof body } catch { /* no body */ }
  const campaignId = optionalId(body.campaignId)
  const limitRaw = typeof body.limit === 'number' ? body.limit : parseInt(String(body.limit ?? ''), 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 500) : 100
  const summary = await backfillMediaThumbs({ campaignId, limit, refresh: body.refresh === true, timeBudgetMs: 240_000 })
  return NextResponse.json({ campaignId: campaignId ?? null, limit, ...summary })
}
