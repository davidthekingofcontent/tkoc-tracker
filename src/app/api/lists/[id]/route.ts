import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { ensureContact } from '@/lib/contacts'

/** Longest list name (POST /api/lists uses the same ceiling). */
const LIST_NAME_MAX_CHARS = 200

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

    // An influencer saved to a list becomes a Contact of the list owner
    // (and of the acting admin when they manage someone else's list).
    await ensureContact(influencerId, list.userId)
    if (session.id !== list.userId) {
      await ensureContact(influencerId, session.id)
    }

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

    // A field that came in with a wrong value is a 400, never ignored in silence,
    // and a body that changes nothing is a 400 too (it used to answer 200)
    if (body.isPinned !== undefined && typeof body.isPinned !== 'boolean') {
      return NextResponse.json({ error: 'isPinned debe ser true o false.' }, { status: 400 })
    }
    if (body.isArchived !== undefined && typeof body.isArchived !== 'boolean') {
      return NextResponse.json({ error: 'isArchived debe ser true o false.' }, { status: 400 })
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > LIST_NAME_MAX_CHARS)) {
      return NextResponse.json({ error: `El nombre de la lista debe tener entre 1 y ${LIST_NAME_MAX_CHARS} caracteres.` }, { status: 400 })
    }

    const data: Record<string, unknown> = {}
    if (typeof body.isPinned === 'boolean') data.isPinned = body.isPinned
    if (typeof body.isArchived === 'boolean') data.isArchived = body.isArchived
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No hay nada que cambiar: manda name, isPinned o isArchived.' }, { status: 400 })
    }

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

    // If itemId is provided in the URL search params, remove just that item.
    // A request that carries itemId NEVER deletes the whole list: an empty
    // itemId used to fall through to the list deletion below (12 Nov 2026).
    const { searchParams } = new URL(request.url)
    if (searchParams.has('itemId')) {
      const itemId = searchParams.get('itemId')?.trim() || ''
      if (!itemId) {
        return NextResponse.json({ error: 'Falta el itemId del elemento que quieres quitar. La lista no se ha borrado.' }, { status: 400 })
      }
      // deleteMany: an unknown item is a 404, not a 500
      const removed = await prisma.listItem.deleteMany({
        where: { id: itemId, listId: id },
      })
      if (removed.count === 0) {
        return NextResponse.json({ error: 'Ese elemento no está en esta lista.' }, { status: 404 })
      }
      return NextResponse.json({ message: 'Item removed from list' })
    }

    // Otherwise delete the entire list (the /lists page deletes a list this way)
    await prisma.list.delete({
      where: { id },
    })

    return NextResponse.json({ message: 'List deleted' })
  } catch (error) {
    console.error('Delete list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
