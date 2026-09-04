/**
 * Cron: Internal benchmarks — recompute the agency's own negotiation
 * percentiles (platform × tier × format) so they blend into the seed.
 * Scheduled monthly from src/instrumentation.ts; also runs ~40 min after
 * every deploy (initial delay). Idempotent and cheap: one read of the deals
 * with an agreedFee plus their delivered media, two Setting upserts.
 * Auth via x-cron-secret header (same pattern as /api/cron/meta-sync).
 */

import { NextRequest, NextResponse } from 'next/server'
import { recomputeInternalBenchmarks } from '@/lib/benchmarks-internal'

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const startedAt = Date.now()
  try {
    const result = await recomputeInternalBenchmarks()
    return NextResponse.json({
      success: true,
      computedAt: result.computedAt,
      deals: result.deals,
      cells: result.cells.length,
      negotiationDiscount: result.negotiationDiscount,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (err) {
    console.error('[Cron/Benchmarks] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'unknown', elapsedMs: Date.now() - startedAt },
      { status: 500 }
    )
  }
}
