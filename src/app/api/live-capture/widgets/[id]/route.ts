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
        captures: {
          orderBy: { createdAt: 'desc' },
          take: 200,
        },
      },
    })

    if (!widget) {
      return NextResponse.json({ error: 'Widget not found' }, { status: 404 })
    }

    // Enrich captures that have a matchedContactId with creator data
    const matchedContactIds = widget.captures
      .map(c => c.matchedContactId)
      .filter((id): id is string => id !== null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let enrichmentMap: Record<string, any> = {}

    if (matchedContactIds.length > 0) {
      // Find matches for these contacts
      const matches = await prisma.clientCreatorMatch.findMany({
        where: {
          clientContactId: { in: matchedContactIds },
          userId: session.id,
        },
        include: {
          creatorProfile: {
            include: {
              platformProfiles: {
                take: 1,
                orderBy: { followers: 'desc' },
                select: {
                  platform: true,
                  followers: true,
                  engagementRate: true,
                },
              },
            },
          },
          warmScore: {
            select: {
              opportunityGrade: true,
              opportunityScore: true,
            },
          },
        },
      })

      for (const match of matches) {
        const pp = match.creatorProfile.platformProfiles[0]
        enrichmentMap[match.clientContactId] = {
          followers: pp?.followers ?? null,
          engagementRate: pp?.engagementRate ?? null,
          platform: pp?.platform ?? null,
          warmGrade: match.warmScore?.opportunityGrade ?? null,
          warmScore: match.warmScore?.opportunityScore ?? null,
        }
      }
    }

    // Attach enrichment data to captures
    const capturesWithEnrichment = widget.captures.map(capture => ({
      ...capture,
      enrichedData: capture.matchedContactId
        ? enrichmentMap[capture.matchedContactId] || null
        : null,
    }))

    return NextResponse.json({
      widget: {
        ...widget,
        captures: capturesWithEnrichment,
      },
    })
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
