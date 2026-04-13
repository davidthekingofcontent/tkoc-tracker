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

    const widget = await prisma.liveCaptureWidget.findFirst({
      where: { id, userId: session.id },
      include: {
        _count: {
          select: { captures: true },
        },
      },
    })

    if (!widget) {
      return NextResponse.json({ error: 'Widget not found' }, { status: 404 })
    }

    return NextResponse.json({ widget })
  } catch (error) {
    console.error('Get live capture widget error:', error)
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

    // Verify ownership
    const existing = await prisma.liveCaptureWidget.findFirst({
      where: { id, userId: session.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Widget not found' }, { status: 404 })
    }

    // Only allow updating specific fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {}
    const allowedFields = [
      'name', 'brandName', 'brandLogo', 'primaryColor', 'incentiveText',
      'headlineText', 'subtitleText', 'triggerType', 'triggerDelay',
      'triggerScroll', 'showOnMobile', 'allowedDomains', 'isActive',
    ]

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updateData[field] = body[field]
      }
    }

    const widget = await prisma.liveCaptureWidget.update({
      where: { id },
      data: updateData,
    })

    return NextResponse.json({ widget })
  } catch (error) {
    console.error('Update live capture widget error:', error)
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

    // Verify ownership
    const existing = await prisma.liveCaptureWidget.findFirst({
      where: { id, userId: session.id },
    })

    if (!existing) {
      return NextResponse.json({ error: 'Widget not found' }, { status: 404 })
    }

    await prisma.liveCaptureWidget.delete({
      where: { id },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete live capture widget error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
