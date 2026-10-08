/**
 * Staff (ADMIN/EMPLOYEE): move or copy creators from this campaign to another.
 *
 * POST /api/campaigns/[id]/influencers/move
 *   body { influencerIds: string[], targetCampaignId: string, mode: 'move' | 'copy' }
 *
 *   - Creates a CampaignInfluencer row in the target for every selected member
 *     of the source campaign, with status PROSPECT and the deal/commitment/notes
 *     fields copied (agreedFee, cost, commission, notes, portfolioUrl, asking
 *     fee, negotiated format, rights, exclusivity, whitelisting, urgent,
 *     crossposting, deliverablesPlanned and the recipient's shipping contact).
 *     dealClosedAt travels too: copied as is, or stamped 'now' when the source
 *     row had agreedFee > 0 without a stamp (the destination can never re-stamp
 *     it because the fee is already > 0 there).
 *     Never the captured media, the tracked link/clicks, the baseline or the
 *     shipping product of the source campaign.
 *   - 'move': the source row is deleted ONLY when the creator has no media
 *     captured in the source campaign; otherwise it is kept (and reported in
 *     keptBecauseMedia) so the captured content stays attributed to a member.
 *     When the source row is deleted, the creator's CampaignNote thread
 *     (campaign_notes keyed by campaignId+influencerId) is re-keyed to the
 *     target so it stays reachable from her card. In 'copy' mode, and for the
 *     rows kept because of media, the thread stays in the source.
 *   - Creators already in the target are skipped and reported (skippedExisting).
 *   - The target campaign team is notified ('influencer_added').
 *
 *   Response { moved, copied, skippedExisting, keptBecauseMedia, notMembers, target }
 *     moved            number    created in target AND removed from the source (move only)
 *     copied           number    created in target, kept in the source (copy mode; in move
 *                                mode the ones with captured content)
 *     skippedExisting  string[]  usernames already in the target (nothing done)
 *     keptBecauseMedia string[]  usernames kept in the source because they have media
 *     notMembers       number    ids that were not members of the source (ignored)
 *     target           { id, name }
 *
 *   400 when ids are empty / target = source / invalid mode / target ARCHIVED /
 *   target of type SOCIAL_LISTENING (no memberships there); 404 when the
 *   source or the target campaign does not exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus, CampaignType, InfluencerStatus, type Prisma } from '@/generated/prisma/client'
import { notifyCampaignTeam } from '@/lib/notifications'

const STAFF_ROLES = new Set(['ADMIN', 'EMPLOYEE'])
const MAX_IDS = 500

type MoveMode = 'move' | 'copy'

function parseIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const ids = Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(x => x.trim())))
  return ids.length > 0 && ids.length <= MAX_IDS ? ids : null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    if (!STAFF_ROLES.has(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { id: sourceId } = await params

    let body: { influencerIds?: unknown; targetCampaignId?: unknown; mode?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Cuerpo JSON no válido' }, { status: 400 })
    }

    const influencerIds = parseIds(body.influencerIds)
    if (!influencerIds) {
      return NextResponse.json({ error: `Indica al menos una creadora (máximo ${MAX_IDS})` }, { status: 400 })
    }
    const targetId = typeof body.targetCampaignId === 'string' ? body.targetCampaignId.trim() : ''
    if (!targetId) {
      return NextResponse.json({ error: 'Indica la campaña de destino' }, { status: 400 })
    }
    if (targetId === sourceId) {
      return NextResponse.json({ error: 'La campaña de destino debe ser distinta de la actual' }, { status: 400 })
    }
    const mode: MoveMode | null = body.mode === 'move' || body.mode === 'copy' ? body.mode : null
    if (!mode) {
      return NextResponse.json({ error: "El modo debe ser 'move' o 'copy'" }, { status: 400 })
    }

    const [source, target] = await Promise.all([
      prisma.campaign.findUnique({ where: { id: sourceId }, select: { id: true, name: true } }),
      prisma.campaign.findUnique({ where: { id: targetId }, select: { id: true, name: true, status: true, type: true } }),
    ])
    if (!source) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    if (!target) return NextResponse.json({ error: 'La campaña de destino no existe' }, { status: 404 })
    // The modal hides these, but a stale list / second tab / direct POST must not land creators where nobody works.
    if (target.status === CampaignStatus.ARCHIVED) {
      return NextResponse.json({ error: 'La campaña de destino está archivada; desarchívala antes de mover creadoras' }, { status: 400 })
    }
    if (target.type === CampaignType.SOCIAL_LISTENING) {
      return NextResponse.json({ error: 'La campaña de destino es de escucha social y no tiene creadoras' }, { status: 400 })
    }

    // Source rows for the requested ids; ids that are not members are ignored (reported as notMembers).
    const sourceRows = await prisma.campaignInfluencer.findMany({
      where: { campaignId: sourceId, influencerId: { in: influencerIds } },
      include: { influencer: { select: { id: true, username: true } } },
    })
    const notMembers = influencerIds.length - sourceRows.length

    // Already in the target → skipped, never touched (not even in move mode).
    const existingTarget = await prisma.campaignInfluencer.findMany({
      where: { campaignId: targetId, influencerId: { in: sourceRows.map(r => r.influencerId) } },
      select: { influencerId: true },
    })
    const existingIds = new Set(existingTarget.map(r => r.influencerId))
    const skippedExisting = sourceRows.filter(r => existingIds.has(r.influencerId)).map(r => r.influencer.username)
    const toTransfer = sourceRows.filter(r => !existingIds.has(r.influencerId))

    // Captured content in the source campaign decides whether a 'move' may delete the source row.
    let withMedia = new Set<string>()
    if (mode === 'move' && toTransfer.length > 0) {
      const grouped = await prisma.media.groupBy({
        by: ['influencerId'],
        where: { campaignId: sourceId, influencerId: { in: toTransfer.map(r => r.influencerId) } },
        _count: { _all: true },
      })
      withMedia = new Set(grouped.filter(g => g._count._all > 0).map(g => g.influencerId))
    }

    const createData: Prisma.CampaignInfluencerCreateManyInput[] = toTransfer.map(r => ({
      campaignId: targetId,
      influencerId: r.influencerId,
      status: InfluencerStatus.PROSPECT,
      source: 'manual',
      // Deal terms and notes travel with the creator
      cost: r.cost,
      agreedFee: r.agreedFee,
      // Deal date: copied; stamped now when the fee was set without a stamp (the target can never re-stamp it)
      dealClosedAt: r.agreedFee != null && r.agreedFee > 0 ? (r.dealClosedAt ?? new Date()) : null,
      commission: r.commission,
      notes: r.notes,
      portfolioUrl: r.portfolioUrl,
      askingFee: r.askingFee,
      negotiatedFormat: r.negotiatedFormat,
      rightsDays: r.rightsDays,
      exclusivityDays: r.exclusivityDays,
      whitelisting: r.whitelisting,
      urgent: r.urgent,
      crossposting: r.crossposting,
      deliverablesPlanned: r.deliverablesPlanned,
      // Recipient contact (the creator's own details), never the product of the source campaign
      shippingName: r.shippingName,
      shippingAddress1: r.shippingAddress1,
      shippingAddress2: r.shippingAddress2,
      shippingCity: r.shippingCity,
      shippingPostCode: r.shippingPostCode,
      shippingCountry: r.shippingCountry,
      shippingPhone: r.shippingPhone,
      shippingEmail: r.shippingEmail,
    }))

    const deletableIds = mode === 'move'
      ? toTransfer.filter(r => !withMedia.has(r.influencerId)).map(r => r.influencerId)
      : []
    const keptBecauseMedia = mode === 'move'
      ? toTransfer.filter(r => withMedia.has(r.influencerId)).map(r => r.influencer.username)
      : []

    if (createData.length > 0) {
      await prisma.$transaction(async tx => {
        await tx.campaignInfluencer.createMany({ data: createData, skipDuplicates: true })
        if (deletableIds.length > 0) {
          await tx.campaignInfluencer.deleteMany({
            where: { campaignId: sourceId, influencerId: { in: deletableIds } },
          })
          // The notes thread follows the membership; otherwise no card would list it anywhere.
          await tx.campaignNote.updateMany({
            where: { campaignId: sourceId, influencerId: { in: deletableIds } },
            data: { campaignId: targetId },
          })
        }
      })
    }

    const moved = deletableIds.length
    const copied = createData.length - moved

    if (createData.length > 0) {
      const n = createData.length
      notifyCampaignTeam(targetId, {
        type: 'influencer_added',
        title: 'Creadoras trasladadas',
        message: `${n} ${n === 1 ? 'creadora trasladada' : 'creadoras trasladadas'} desde "${source.name}"`,
        link: `/campaigns/${targetId}`,
      }, session.id).catch(() => {})
    }

    return NextResponse.json({
      moved,
      copied,
      skippedExisting,
      keptBecauseMedia,
      notMembers,
      target: { id: target.id, name: target.name },
    })
  } catch (error) {
    console.error('[Campaign/Influencers/Move] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
