/**
 * Meta Connection — detail + delete (soft or hard).
 * GET    /api/meta/connections/[id]
 * DELETE /api/meta/connections/[id]?hard=true
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/encryption'
import { deauthorize } from '@/lib/meta-api'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await context.params
  const token = await prisma.socialToken.findUnique({
    where: { id },
    select: {
      id: true,
      platform: true,
      tokenType: true,
      userId: true,
      creatorProfileId: true,
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
      },
      media: {
        orderBy: { postedAt: 'desc' },
        take: 20,
      },
    },
  })
  if (!token) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
  }

  const isAdmin = session.role === 'ADMIN'
  if (!isAdmin && token.userId && token.userId !== session.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  return NextResponse.json({
    connection: {
      id: token.id,
      platform: token.platform,
      tokenType: token.tokenType,
      platformUserId: token.platformUserId,
      platformPageId: token.platformPageId,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
      isValid: token.isValid,
      lastUsedAt: token.lastUsedAt,
      lastError: token.lastError,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
      latestSnapshot: token.accountSnapshots[0] ?? null,
      recentMedia: token.media,
    },
  })
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await context.params
  const hard = request.nextUrl.searchParams.get('hard') === 'true'

  const token = await prisma.socialToken.findUnique({
    where: { id },
  })
  if (!token) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
  }

  const isAdmin = session.role === 'ADMIN'
  if (!isAdmin && token.userId && token.userId !== session.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Attempt to revoke with Meta (best effort).
  try {
    const plaintext = decrypt(token.accessToken)
    await deauthorize(plaintext)
  } catch (err) {
    console.error('[Meta connections DELETE] deauthorize failed', err instanceof Error ? err.message : err)
  }

  if (hard) {
    await prisma.socialToken.delete({ where: { id } })
    return NextResponse.json({ success: true, hardDeleted: true })
  }

  await prisma.socialToken.update({
    where: { id },
    data: {
      isValid: false,
      lastError: 'Disconnected by user',
    },
  })
  return NextResponse.json({ success: true, hardDeleted: false })
}
