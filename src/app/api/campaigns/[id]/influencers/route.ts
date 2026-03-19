import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

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

    const { id } = await params
    const body = await request.json()
    const { influencerId, cost, notes } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
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
        ...(notes !== undefined && { notes }),
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

    await prisma.campaignInfluencer.delete({
      where: { id: existing.id },
    })

    return NextResponse.json({ message: 'Influencer removed from campaign' })
  } catch (error) {
    console.error('Remove influencer from campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
