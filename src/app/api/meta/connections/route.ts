/**
 * Meta Connections — list current user's Meta/IG Business connections.
 * GET /api/meta/connections
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tokens = await prisma.socialToken.findMany({
    where: {
      platform: 'INSTAGRAM',
      userId: session.id,
      tokenType: 'brand',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      platform: true,
      tokenType: true,
      platformUserId: true,
      platformPageId: true,
      scopes: true,
      expiresAt: true,
      isValid: true,
      lastUsedAt: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
      accountSnapshots: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
        select: {
          igUsername: true,
          igName: true,
          igProfilePicUrl: true,
          followersCount: true,
          followsCount: true,
          mediaCount: true,
          capturedAt: true,
        },
      },
    },
  })

  const now = Date.now()
  const connections = tokens.map(t => {
    const snap = t.accountSnapshots[0] ?? null
    let status: 'connected' | 'expired' | 'error' | 'disconnected' = 'connected'
    if (!t.isValid) status = 'disconnected'
    else if (t.lastError) status = 'error'
    else if (t.expiresAt && t.expiresAt.getTime() < now) status = 'expired'

    return {
      id: t.id,
      platform: t.platform,
      tokenType: t.tokenType,
      platformUserId: t.platformUserId,
      platformPageId: t.platformPageId,
      scopes: t.scopes,
      expiresAt: t.expiresAt,
      isValid: t.isValid,
      lastUsedAt: t.lastUsedAt,
      lastError: t.lastError,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      status,
      account: snap,
    }
  })

  return NextResponse.json({ connections })
}
