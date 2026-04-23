/**
 * Cron: Meta Token Refresh — refresh long-lived tokens expiring within 7 days.
 * Auth via x-cron-secret header.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/encryption'
import { refreshLongLivedToken } from '@/lib/meta-api'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const cutoff = new Date(Date.now() + SEVEN_DAYS_MS)
  const tokens = await prisma.socialToken.findMany({
    where: {
      platform: 'INSTAGRAM',
      isValid: true,
      expiresAt: { lt: cutoff },
      refreshToken: { not: null },
    },
    select: { id: true, refreshToken: true },
  })

  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const t of tokens) {
    try {
      if (!t.refreshToken) {
        results.push({ id: t.id, ok: false, error: 'no refresh token' })
        continue
      }
      const userToken = decrypt(t.refreshToken)
      const refreshed = await refreshLongLivedToken(userToken)
      await prisma.socialToken.update({
        where: { id: t.id },
        data: {
          refreshToken: encrypt(refreshed.access_token),
          expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
          lastError: null,
        },
      })
      results.push({ id: t.id, ok: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      await prisma.socialToken.update({
        where: { id: t.id },
        data: { isValid: false, lastError: `token_refresh_failed: ${msg.slice(0, 200)}` },
      })
      results.push({ id: t.id, ok: false, error: msg })
    }
  }

  return NextResponse.json({
    total: tokens.length,
    refreshed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results,
  })
}
