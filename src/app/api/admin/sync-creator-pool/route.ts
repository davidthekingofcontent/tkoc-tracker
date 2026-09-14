/**
 * Admin: sync the creator pool from the legacy influencers table (see
 * src/lib/creator-pool.ts).
 * POST { limit?, reclassifyRealCreators? } → materializes every Influencer
 *        with real profile data into CreatorProfile + CreatorPlatformProfile
 *        (linked via influencerId) and classifies it. With
 *        `reclassifyRealCreators` it also re-runs the category detector on
 *        the real pool rows that have no influencer link.
 * ADMIN only. No Apify cost: it only moves data we already own.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { syncCreatorPool } from '@/lib/creator-pool'

export const maxDuration = 300

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 5000

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

function parseLimit(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_LIMIT) : fallback
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied
  let body: { limit?: unknown; reclassifyRealCreators?: unknown } = {}
  try { body = (await request.json().catch(() => ({}))) as typeof body } catch { /* no body */ }
  const limit = parseLimit(body.limit, DEFAULT_LIMIT)
  const summary = await syncCreatorPool({ limit, reclassifyRealCreators: body.reclassifyRealCreators === true })
  return NextResponse.json({ limit, ...summary })
}
