/**
 * Cron: Meta Sync — run syncMetaConnection for up to 20 active connections.
 * Auth via x-cron-secret header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncMetaConnection } from '@/lib/meta-sync'
import { materializeMetaContent, listCampaignsForMaterialize } from '@/lib/meta-materialize'

const MAX_PER_RUN = 20
/**
 * The instrumentation self-fetch that triggers this route (Node fetch / undici)
 * gives up on headers after 300s and would report a false "cron failed". Tagged
 * media crawls are slow (~10s per 3 items), so the run is time-boxed: whatever
 * does not fit is picked up next run (connections are ordered by lastUsedAt).
 */
const RUN_BUDGET_MS = 240_000
const MIN_PER_CONNECTION_MS = 60_000

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const tokens = await prisma.socialToken.findMany({
    where: { platform: 'INSTAGRAM', isValid: true },
    orderBy: { lastUsedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_PER_RUN,
    select: { id: true, userId: true },
  })

  const startedAt = Date.now()
  const results: Array<{ id: string; ok: boolean; error?: string; warning?: string; tagsCrawlComplete?: boolean }> = []
  const skipped: string[] = []
  const syncedUserIds = new Set<string>()
  for (const t of tokens) {
    const remaining = RUN_BUDGET_MS - (Date.now() - startedAt)
    if (remaining < MIN_PER_CONNECTION_MS) {
      skipped.push(t.id)
      continue
    }
    try {
      const r = await syncMetaConnection(t.id, {
        tagsMaxItems: 45,
        // leave ~45s for profile/media/insights/stories calls
        tagsTimeBudgetMs: Math.max(20_000, Math.min(150_000, remaining - 45_000)),
      })
      results.push({ id: t.id, ok: r.success, error: r.error, warning: r.warning, tagsCrawlComplete: r.tagsCrawlComplete })
      if (r.success && t.userId) syncedUserIds.add(t.userId)
    } catch (err) {
      results.push({ id: t.id, ok: false, error: err instanceof Error ? err.message : 'unknown' })
    }
  }
  if (skipped.length > 0) {
    console.warn(`[Cron/MetaSync] run budget reached — ${skipped.length} connection(s) deferred to the next run`)
  }

  // Materialize freshly-synced Meta content into every ACTIVE campaign of the
  // agency (PMs create the monthly campaigns; the brand connection belongs to
  // the owner), so it flows into campaign metrics without manual tracking.
  let materialized = { created: 0, updated: 0 }
  if (syncedUserIds.size > 0) {
    const campaignIds = await listCampaignsForMaterialize()
    for (const campaignId of campaignIds) {
      try {
        const m = await materializeMetaContent(campaignId)
        materialized = { created: materialized.created + m.created, updated: materialized.updated + m.updated }
      } catch (err) {
        console.error(`[Cron/MetaSync] materialize failed for campaign ${campaignId}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  return NextResponse.json({
    total: tokens.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    skipped: skipped.length,
    elapsedMs: Date.now() - startedAt,
    materialized,
    results,
  })
}
