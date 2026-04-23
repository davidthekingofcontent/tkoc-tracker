/**
 * Meta Connection — manual sync
 * POST /api/meta/sync/[connectionId]
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { syncMetaConnection } from '@/lib/meta-sync'

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { connectionId } = await context.params

  const connection = await prisma.socialToken.findUnique({
    where: { id: connectionId },
    select: { id: true, userId: true, creatorProfileId: true },
  })
  if (!connection) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
  }
  // Only owners can sync their own brand connection.
  if (connection.userId && connection.userId !== session.id && session.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const result = await syncMetaConnection(connectionId)
  if (!result.success) {
    return NextResponse.json({ ...result }, { status: 500 })
  }
  return NextResponse.json(result)
}
