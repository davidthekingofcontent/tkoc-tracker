import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const lists = await prisma.list.findMany({
      where: {
        userId: session.id,
      },
      include: {
        items: {
          include: {
            influencer: {
              select: { followers: true },
            },
          },
        },
        _count: {
          select: { items: true },
        },
      },
      orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
    })

    // Compute total reach per list
    const result = lists.map((list) => {
      const totalReach = list.items.reduce(
        (sum, item) => sum + (item.influencer.followers || 0),
        0
      )
      const { items: _items, ...rest } = list
      return { ...rest, totalReach }
    })

    return NextResponse.json({ lists: result })
  } catch (error) {
    console.error('List lists error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { name } = body

    if (!name) {
      return NextResponse.json({ error: 'List name is required' }, { status: 400 })
    }

    const list = await prisma.list.create({
      data: {
        name,
        userId: session.id,
      },
      include: {
        _count: { select: { items: true } },
      },
    })

    return NextResponse.json({ list }, { status: 201 })
  } catch (error) {
    console.error('Create list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
