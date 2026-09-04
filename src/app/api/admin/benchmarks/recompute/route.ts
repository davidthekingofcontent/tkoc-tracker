/**
 * Admin: internal benchmarks (the agency's own negotiations as a benchmark).
 *
 * POST — ADMIN only. Recomputes the own percentiles per platform × tier × format
 *        from every CampaignInfluencer with an agreedFee, writes Settings
 *        benchmark_internal_stats / benchmark_internal_meta and drops the caches.
 *        Returns the summary + cells.
 * GET  — ADMIN or EMPLOYEE. Returns the stored meta + cells (null meta when the
 *        job has never run).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { recomputeInternalBenchmarks, loadInternalBenchmarks } from '@/lib/benchmarks-internal'

const STAFF_ROLES = new Set(['ADMIN', 'EMPLOYEE'])

export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (!STAFF_ROLES.has(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { meta, cells } = await loadInternalBenchmarks()
  return NextResponse.json({ meta, cells })
}

export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const startedAt = Date.now()
    const result = await recomputeInternalBenchmarks()
    return NextResponse.json({
      success: true,
      computedAt: result.computedAt,
      deals: result.deals,
      cellCount: result.cells.length,
      negotiationDiscount: result.negotiationDiscount,
      meta: result.meta,
      cells: result.cells,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (err) {
    console.error('[admin/benchmarks/recompute] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No se han podido recalcular los benchmarks internos' }, { status: 500 })
  }
}
