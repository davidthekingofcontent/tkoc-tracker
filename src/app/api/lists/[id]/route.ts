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

    const list = await prisma.list.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            influencer: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { items: true } },
      },
    })

    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    if (list.userId !== session.id && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    return NextResponse.json({ list })
  } catch (error) {
    console.error('Get list error:', error)
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

    const { id } = await params
    const body = await request.json()
    const { influencerId } = body

    if (!influencerId) {
      return NextResponse.json({ error: 'influencerId is required' }, { status: 400 })
    }

    const list = await prisma.list.findUnique({ where: { id } })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    if (list.userId !== session.id && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Check influencer exists
    const influencer = await prisma.influencer.findUnique({ where: { id: influencerId } })
    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Check for duplicate
    const existing = await prisma.listItem.findUnique({
      where: { listId_influencerId: { listId: id, influencerId } },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'Influencer is already in this list' },
        { status: 409 }
      )
    }

    const item = await prisma.listItem.create({
      data: { listId: id, influencerId },
      include: { influencer: true },
    })

    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    console.error('Add to list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
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

    const list = await prisma.list.findUnique({ where: { id } })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    if (list.userId !== session.id && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const data: Record<string, unknown> = {}
    if (typeof body.isPinned === 'boolean') data.isPinned = body.isPinned
    if (typeof body.isArchived === 'boolean') data.isArchived = body.isArchived
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()

    const updated = await prisma.list.update({
      where: { id },
      data,
    })

    return NextResponse.json({ list: updated })
  } catch (error) {
    console.error('Update list error:', error)
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

    const { id } = await params

    const list = await prisma.list.findUnique({ where: { id } })
    if (!list) {
      return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }

    if (list.userId !== session.id && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // If itemId is provided in the URL search params, remove just that item
    const { searchParams } = new URL(request.url)
    const itemId = searchParams.get('itemId')

    if (itemId) {
      await prisma.listItem.delete({
        where: { id: itemId, listId: id },
      })
      return NextResponse.json({ message: 'Item removed from list' })
    }

    // Otherwise delete the entire list
    await prisma.list.delete({
      where: { id },
    })

    return NextResponse.json({ message: 'List deleted' })
  } catch (error) {
    console.error('Delete list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
