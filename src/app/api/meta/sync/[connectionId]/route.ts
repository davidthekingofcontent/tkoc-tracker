/**
 * Meta Connection — manual sync
 * POST /api/meta/sync/[connectionId]
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { syncMetaConnection } from '@/lib/meta-sync'
import { materializeMetaContent, listCampaignsForMaterialize } from '@/lib/meta-materialize'

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

  // Manual sync is interactive: keep the tagged-media pagination bounded so the
  // request returns in a reasonable time. The 4h cron goes deeper.
  const result = await syncMetaConnection(connectionId, { tagsMaxItems: 15, tagsTimeBudgetMs: 75_000 })
  if (!result.success) {
    return NextResponse.json({ ...result }, { status: 500 })
  }

  // Same as the cron: push freshly-synced Meta content into every ACTIVE
  // campaign of the connection owner, so a manual "Sincronizar" is enough for
  // tagged posts to show up in campaigns without waiting for the next cron.
  let materialized = { created: 0, updated: 0, campaigns: 0 }
  if (connection.userId) {
    const campaignIds = await listCampaignsForMaterialize([connection.userId])
    for (const campaignId of campaignIds) {
      try {
        const m = await materializeMetaContent(campaignId)
        materialized = {
          created: materialized.created + m.created,
          updated: materialized.updated + m.updated,
          campaigns: materialized.campaigns + 1,
        }
      } catch (err) {
        console.error(`[Meta/Sync] materialize failed for campaign ${campaignId}:`, err instanceof Error ? err.message : err)
      }
    }
  }
  return NextResponse.json({ ...result, materialized })
}
