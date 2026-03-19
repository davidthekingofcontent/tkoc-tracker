import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const influencer = await prisma.influencer.findUnique({
      where: { id },
      include: {
        _count: { select: { campaigns: true, media: true } },
      },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    return NextResponse.json({ influencer })
  } catch (error) {
    console.error('Get influencer error:', error)
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
    const { standardFee, email, phone, website } = body

    const existing = await prisma.influencer.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    const influencer = await prisma.influencer.update({
      where: { id },
      data: {
        ...(standardFee !== undefined && { standardFee: parseFloat(standardFee) || null }),
        ...(email !== undefined && { email }),
        ...(phone !== undefined && { phone }),
        ...(website !== undefined && { website }),
      },
    })

    return NextResponse.json({ influencer })
  } catch (error) {
    console.error('Update influencer error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
