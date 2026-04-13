import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const widgets = await prisma.liveCaptureWidget.findMany({
      where: { userId: session.id },
      include: {
        _count: {
          select: { captures: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ widgets })
  } catch (error) {
    console.error('List live capture widgets error:', error)
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
    const {
      name,
      brandName,
      brandLogo,
      primaryColor,
      incentiveText,
      headlineText,
      subtitleText,
      triggerType,
      triggerDelay,
      triggerScroll,
      showOnMobile,
      allowedDomains,
    } = body

    const widget = await prisma.liveCaptureWidget.create({
      data: {
        userId: session.id,
        name: name || 'Default Widget',
        brandName: brandName || null,
        brandLogo: brandLogo || null,
        primaryColor: primaryColor || '#7c3aed',
        incentiveText: incentiveText || null,
        headlineText: headlineText || 'Share your social media',
        subtitleText: subtitleText || 'Connect with us and get exclusive offers',
        triggerType: triggerType || 'exit_intent',
        triggerDelay: triggerDelay ?? 5,
        triggerScroll: triggerScroll ?? 50,
        showOnMobile: showOnMobile ?? true,
        allowedDomains: allowedDomains || [],
      },
    })

    return NextResponse.json({ widget }, { status: 201 })
  } catch (error) {
    console.error('Create live capture widget error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
