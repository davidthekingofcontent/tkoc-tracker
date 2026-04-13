import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function corsHeaders(origin: string | null, allowedDomains: string[]) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }

  if (origin && allowedDomains.length > 0) {
    try {
      const originHost = new URL(origin).hostname
      const isAllowed = allowedDomains.some(
        (d) => originHost === d || originHost.endsWith('.' + d)
      )
      if (isAllowed) {
        headers['Access-Control-Allow-Origin'] = origin
      }
    } catch {
      // invalid origin
    }
  } else if (allowedDomains.length === 0) {
    headers['Access-Control-Allow-Origin'] = origin || '*'
  }

  return headers
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin')
  const apiKey = new URL(request.url).searchParams.get('apiKey')

  let allowedDomains: string[] = []
  if (apiKey) {
    const widget = await prisma.liveCaptureWidget.findUnique({
      where: { apiKey },
      select: { allowedDomains: true },
    })
    if (widget) allowedDomains = widget.allowedDomains
  }

  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin, allowedDomains),
  })
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin')

  try {
    const { searchParams } = new URL(request.url)
    const apiKey = searchParams.get('apiKey')

    if (!apiKey) {
      return NextResponse.json(
        { error: 'apiKey is required' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
      )
    }

    const widget = await prisma.liveCaptureWidget.findUnique({
      where: { apiKey },
      select: {
        brandName: true,
        brandLogo: true,
        primaryColor: true,
        incentiveText: true,
        headlineText: true,
        subtitleText: true,
        triggerType: true,
        triggerDelay: true,
        triggerScroll: true,
        showOnMobile: true,
        isActive: true,
        allowedDomains: true,
      },
    })

    if (!widget || !widget.isActive) {
      return NextResponse.json(
        { error: 'Widget not found or inactive' },
        { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }
      )
    }

    const headers = corsHeaders(origin, widget.allowedDomains)

    // Increment impressions
    await prisma.liveCaptureWidget.update({
      where: { apiKey },
      data: { impressions: { increment: 1 } },
    })

    // Return public config (no sensitive data)
    const { allowedDomains: _domains, ...publicConfig } = widget

    return NextResponse.json({ config: publicConfig }, { headers })
  } catch (error) {
    console.error('Widget config error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
    )
  }
}
