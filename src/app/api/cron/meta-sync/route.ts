/**
 * Cron: Meta Sync — run syncMetaConnection for up to 20 active connections.
 * Auth via x-cron-secret header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncMetaConnection } from '@/lib/meta-sync'

const MAX_PER_RUN = 20

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
    select: { id: true },
  })

  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const t of tokens) {
    try {
      const r = await syncMetaConnection(t.id)
      results.push({ id: t.id, ok: r.success, error: r.error })
    } catch (err) {
      results.push({ id: t.id, ok: false, error: err instanceof Error ? err.message : 'unknown' })
    }
  }

  return NextResponse.json({
    total: tokens.length,
    succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  })
}
