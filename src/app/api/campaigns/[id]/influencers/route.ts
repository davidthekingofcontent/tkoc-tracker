import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus } from '@/generated/prisma/client'
import { notifyAllTeam } from '@/lib/notifications'
import { ensureContact } from '@/lib/contacts'
import { captureMemberContent } from '@/lib/campaign-capture'

/** Statuses from which a creator is confirmed (or later) — content capture
 *  is triggered automatically when a member reaches one of them. */
const CAPTURE_TRIGGER_STATUSES = new Set<InfluencerStatus>([
  InfluencerStatus.AGREED,
  InfluencerStatus.CONTRACTED,
  InfluencerStatus.SHIPPING,
  InfluencerStatus.POSTED,
  InfluencerStatus.COMPLETED,
])

/** Fire-and-forget precise capture for one member. Never throws, never awaited. */
function triggerMemberCapture(campaignId: string, influencerId: string, reason: string): void {
  captureMemberContent(campaignId, influencerId)
    .then(r => console.log(`[Campaign/Influencers] Capture (${reason}) for ${influencerId} in ${campaignId}: ${r.captured} captured, ${r.skipped} skipped`))
    .catch(err => console.error(`[Campaign/Influencers] Capture (${reason}) failed:`, err instanceof Error ? err.message : err))
}

/** Negotiation formats accepted for CampaignInfluencer.negotiatedFormat (see FeeFormat in '@/lib/benchmarks'). */
const DEAL_FORMATS = new Set(['POST', 'REEL', 'STORY', 'VIDEO', 'INTEGRATION', 'DEDICATED', 'SHORT'])

/** Optional day count: null/'' clears; 0 → null; integers only (-1 allowed when `allowPerpetual`). undefined = invalid. */
function parseDays(v: unknown, allowPerpetual = false): number | null | undefined {
  if (v === null || v === '') return null
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  if (!Number.isInteger(n)) return undefined
  if (n === 0) return null
  if (n < 0) return allowPerpetual && n === -1 ? -1 : undefined
  return n
}

/** Optional non-negative money amount: null/'' clears; undefined = invalid. */
function parseMoney(v: unknown): number | null | undefined {
  if (v === null || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()
    const { influencerId } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    const campaign = await prisma.campaign.findUnique({ where: { id } })
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const influencer = await prisma.influencer.findUnique({ where: { id: influencerId } })
    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Check for duplicate
    const existing = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId: id, influencerId } },
    })

    if (existing) {
      return NextResponse.json({ error: 'Influencer is already in this campaign' }, { status: 409 })
    }

    const item = await prisma.campaignInfluencer.create({
      data: { campaignId: id, influencerId, source: 'manual' },
      include: { influencer: true },
    })

    // CRM: make sure the creator exists as a contact for this user (status 'new')
    try {
      await ensureContact(influencerId, session.id)
    } catch (err) {
      console.error('[Campaign/Influencers] ensureContact failed:', err instanceof Error ? err.message : err)
    }

    // Precise capture: scrape the new member's recent content and keep only what
    // passes the campaign rules. Fire-and-forget — the add must not wait for Apify.
    triggerMemberCapture(id, influencerId, 'added')

    // Notify team
    notifyAllTeam({
      type: 'influencer_added',
      title: 'Influencer añadido',
      message: `@${item.influencer.username} añadido a la campaña "${campaign.name}"`,
      link: `/campaigns/${id}`,
    }, session.id).catch(() => {})

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    console.error('Add influencer to campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()
    const {
      influencerId, cost, agreedFee, notes, status, portfolioUrl, contentDelivered,
      shippingName, shippingAddress1, shippingAddress2, shippingCity,
      shippingPostCode, shippingCountry, shippingPhone, shippingEmail,
      shippingProduct, shippingQty, shippingComments,
      // Deal terms (commercial modifiers evaluated against the benchmarks)
      askingFee, negotiatedFormat, rightsDays, exclusivityDays, whitelisting, urgent, crossposting,
    } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    if (status && !Object.values(InfluencerStatus).includes(status as InfluencerStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
    }

    // ---- Deal terms validation ----
    let format: string | null | undefined
    if (negotiatedFormat !== undefined) {
      if (negotiatedFormat === null || negotiatedFormat === '') {
        format = null
      } else {
        const f = String(negotiatedFormat).toUpperCase()
        if (!DEAL_FORMATS.has(f)) {
          return NextResponse.json({ error: `Invalid negotiatedFormat. Allowed: ${[...DEAL_FORMATS].join(', ')}` }, { status: 400 })
        }
        format = f
      }
    }
    const rights = rightsDays !== undefined ? parseDays(rightsDays, true) : undefined
    if (rightsDays !== undefined && rights === undefined) {
      return NextResponse.json({ error: 'rightsDays must be an integer number of days (30/90/180) or -1 for perpetual' }, { status: 400 })
    }
    const excl = exclusivityDays !== undefined ? parseDays(exclusivityDays) : undefined
    if (exclusivityDays !== undefined && excl === undefined) {
      return NextResponse.json({ error: 'exclusivityDays must be a positive integer number of days (30/90/365)' }, { status: 400 })
    }
    const asking = askingFee !== undefined ? parseMoney(askingFee) : undefined
    if (askingFee !== undefined && asking === undefined) {
      return NextResponse.json({ error: 'askingFee must be a non-negative number' }, { status: 400 })
    }

    const existing = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId: id, influencerId } },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Influencer not in this campaign' }, { status: 404 })
    }

    // The deal closes the first time agreedFee goes from empty/0 to > 0 (never re-stamped).
    const newAgreedFee = agreedFee !== undefined ? (parseFloat(agreedFee) || 0) : undefined
    const closesDeal =
      newAgreedFee !== undefined &&
      newAgreedFee > 0 &&
      !(existing.agreedFee && existing.agreedFee > 0) &&
      !existing.dealClosedAt

    const updated = await prisma.campaignInfluencer.update({
      where: { id: existing.id },
      data: {
        ...(cost !== undefined && { cost: parseFloat(cost) || 0 }),
        ...(newAgreedFee !== undefined && { agreedFee: newAgreedFee }),
        ...(closesDeal && { dealClosedAt: new Date() }),
        // Deal terms
        ...(asking !== undefined && { askingFee: asking }),
        ...(format !== undefined && { negotiatedFormat: format }),
        ...(rights !== undefined && { rightsDays: rights }),
        ...(excl !== undefined && { exclusivityDays: excl }),
        ...(whitelisting !== undefined && { whitelisting: !!whitelisting }),
        ...(urgent !== undefined && { urgent: !!urgent }),
        ...(crossposting !== undefined && { crossposting: !!crossposting }),
        ...(notes !== undefined && { notes }),
        ...(status !== undefined && { status: status as InfluencerStatus }),
        ...(portfolioUrl !== undefined && { portfolioUrl: portfolioUrl || null }),
        ...(contentDelivered !== undefined && { contentDelivered: !!contentDelivered }),
        ...(shippingName !== undefined && { shippingName: shippingName || null }),
        ...(shippingAddress1 !== undefined && { shippingAddress1: shippingAddress1 || null }),
        ...(shippingAddress2 !== undefined && { shippingAddress2: shippingAddress2 || null }),
        ...(shippingCity !== undefined && { shippingCity: shippingCity || null }),
        ...(shippingPostCode !== undefined && { shippingPostCode: shippingPostCode || null }),
        ...(shippingCountry !== undefined && { shippingCountry: shippingCountry || null }),
        ...(shippingPhone !== undefined && { shippingPhone: shippingPhone || null }),
        ...(shippingEmail !== undefined && { shippingEmail: shippingEmail || null }),
        ...(shippingProduct !== undefined && { shippingProduct: shippingProduct || null }),
        ...(shippingQty !== undefined && { shippingQty: shippingQty ? parseInt(shippingQty) : null }),
        ...(shippingComments !== undefined && { shippingComments: shippingComments || null }),
      },
      include: { influencer: true },
    })

    // Confirmed-or-later status → capture the member's content (fire-and-forget).
    // Only on an actual transition, so re-saving the same status doesn't re-scrape.
    if (
      status !== undefined &&
      CAPTURE_TRIGGER_STATUSES.has(status as InfluencerStatus) &&
      existing.status !== status
    ) {
      triggerMemberCapture(id, influencerId, `status→${status}`)
    }

    return NextResponse.json({ item: updated })
  } catch (error) {
    console.error('Update campaign influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()
    const { influencerId } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    const existing = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId: id, influencerId } },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Influencer not in this campaign' }, { status: 404 })
    }

    // Delete associated media records for this influencer in this campaign
    await prisma.media.deleteMany({
      where: { campaignId: id, influencerId },
    })

    await prisma.campaignInfluencer.delete({
      where: { id: existing.id },
    })

    return NextResponse.json({ message: 'Influencer removed from campaign' })
  } catch (error) {
    console.error('Remove influencer from campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
