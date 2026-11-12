import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { notifyCampaignTeam } from '@/lib/notifications'

/** Longest note. */
const NOTE_MAX_CHARS = 5000

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Internal PM notes: staff only (never BRAND clients or CREATOR accounts)
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const influencerId = request.nextUrl.searchParams.get('influencerId')

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId query param is required' }, { status: 400 })
    }

    const notes = await prisma.campaignNote.findMany({
      where: {
        campaignId: id,
        influencerId,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ notes })
  } catch (error) {
    console.error('Get campaign notes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
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
    const { influencerId, text } = body

    if (!influencerId || typeof influencerId !== 'string') {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 })
    }
    if (text.trim().length > NOTE_MAX_CHARS) {
      return NextResponse.json({ error: `La nota no puede pasar de ${NOTE_MAX_CHARS} caracteres.` }, { status: 400 })
    }

    // A note must land where someone can see it: on a real campaign and a
    // creator of that campaign (a wrong id used to create a note nobody
    // could ever see or delete, 12 Nov 2026)
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { name: true } })
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }
    const member = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId: id, influencerId } },
      select: { id: true },
    })
    if (!member) {
      return NextResponse.json({ error: 'Esta creadora no está en la campaña: la nota no se ha guardado.' }, { status: 400 })
    }

    const note = await prisma.campaignNote.create({
      data: {
        campaignId: id,
        influencerId,
        userId: session.id,
        userName: session.name,
        text: text.trim(),
      },
    })

    // Notify the campaign team (creator + assigned PMs), not the whole agency
    notifyCampaignTeam(
      id,
      {
        type: 'note_added',
        title: 'Nota nueva',
        message: campaign.name
          ? `${session.name} ha añadido una nota en la campaña "${campaign.name}"`
          : `${session.name} ha añadido una nota en la campaña`,
        link: `/campaigns/${id}`,
      },
      session.id
    ).catch(() => {})

    return NextResponse.json({ note }, { status: 201 })
  } catch (error) {
    console.error('Create campaign note error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
