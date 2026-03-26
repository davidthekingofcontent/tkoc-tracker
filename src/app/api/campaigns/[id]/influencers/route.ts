import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus } from '@/generated/prisma/client'
import { notifyAllTeam } from '@/lib/notifications'

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
      data: { campaignId: id, influencerId },
      include: { influencer: true },
    })

    // Notify team
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { name: true } })
    notifyAllTeam({
      type: 'influencer_added',
      title: 'Influencer añadido',
      message: `@${item.influencer.username} añadido a la campaña "${campaign?.name || 'Campaña'}"`,
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
    } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    if (status && !Object.values(InfluencerStatus).includes(status as InfluencerStatus)) {
      return NextResponse.json({ error: 'Invalid status value' }, { status: 400 })
    }

    const existing = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId: id, influencerId } },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Influencer not in this campaign' }, { status: 404 })
    }

    const updated = await prisma.campaignInfluencer.update({
      where: { id: existing.id },
      data: {
        ...(cost !== undefined && { cost: parseFloat(cost) || 0 }),
        ...(agreedFee !== undefined && { agreedFee: parseFloat(agreedFee) || 0 }),
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
