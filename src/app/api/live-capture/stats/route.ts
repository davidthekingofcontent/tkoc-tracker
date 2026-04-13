import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Get all user's widgets
    const widgets = await prisma.liveCaptureWidget.findMany({
      where: { userId: session.id },
      select: {
        id: true,
        name: true,
        impressions: true,
        submissions: true,
        isActive: true,
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const widgetIds = widgets.map((w: any) => w.id)

    // Total captures
    const totalCaptures = await prisma.liveCapture.count({
      where: { widgetId: { in: widgetIds } },
    })

    // Processed captures
    const processedCaptures = await prisma.liveCapture.count({
      where: { widgetId: { in: widgetIds }, isProcessed: true },
    })

    // Matched captures (those with a matchedContactId)
    const matchedCaptures = await prisma.liveCapture.count({
      where: {
        widgetId: { in: widgetIds },
        matchedContactId: { not: null },
      },
    })

    // Captures by date (last 30 days)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const recentCaptures = await prisma.liveCapture.findMany({
      where: {
        widgetId: { in: widgetIds },
        createdAt: { gte: thirtyDaysAgo },
      },
      select: {
        createdAt: true,
        isProcessed: true,
        matchedContactId: true,
      },
      orderBy: { createdAt: 'asc' },
    })

    // Group by date
    const byDate: Record<
      string,
      { captures: number; processed: number; matched: number }
    > = {}
    for (const capture of recentCaptures) {
      const dateKey = capture.createdAt.toISOString().split('T')[0]
      if (!byDate[dateKey]) {
        byDate[dateKey] = { captures: 0, processed: 0, matched: 0 }
      }
      byDate[dateKey].captures++
      if (capture.isProcessed) byDate[dateKey].processed++
      if (capture.matchedContactId) byDate[dateKey].matched++
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalImpressions = widgets.reduce((sum: number, w: any) => sum + w.impressions, 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalSubmissions = widgets.reduce((sum: number, w: any) => sum + w.submissions, 0)
    const conversionRate =
      totalImpressions > 0
        ? Math.round((totalSubmissions / totalImpressions) * 10000) / 100
        : 0

    return NextResponse.json({
      stats: {
        totalCaptures,
        processedCaptures,
        matchedCaptures,
        totalImpressions,
        totalSubmissions,
        conversionRate,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        activeWidgets: widgets.filter((w: any) => w.isActive).length,
        totalWidgets: widgets.length,
        byDate,
      },
    })
  } catch (error) {
    console.error('Live capture stats error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
