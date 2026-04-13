import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

function corsHeaders(origin: string | null, allowedDomains: string[]) {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Max-Age': '86400',
  }

  if (origin && allowedDomains.length > 0) {
    try {
      const originHost = new URL(origin).hostname
      const isAllowed = allowedDomains.some(
        (d: string) => originHost === d || originHost.endsWith('.' + d)
      )
      if (isAllowed) {
        headers['Access-Control-Allow-Origin'] = origin
      }
    } catch {
      // invalid origin URL
    }
  } else if (allowedDomains.length === 0) {
    // No domain restrictions — allow all
    headers['Access-Control-Allow-Origin'] = origin || '*'
  }

  return headers
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin')
  // For preflight, try to find widget by api key in query or header
  const apiKey =
    request.headers.get('x-api-key') ||
    new URL(request.url).searchParams.get('apiKey')

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

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin')

  try {
    const body = await request.json()
    const apiKey = body.apiKey || request.headers.get('x-api-key')

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key is required' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }
      )
    }

    // Find widget
    const widget = await prisma.liveCaptureWidget.findUnique({
      where: { apiKey },
      select: {
        id: true,
        userId: true,
        isActive: true,
        allowedDomains: true,
      },
    })

    if (!widget || !widget.isActive) {
      return NextResponse.json(
        { error: 'Invalid or inactive widget' },
        { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }
      )
    }

    const headers = corsHeaders(origin, widget.allowedDomains)

    // Check origin domain if allowedDomains is set
    if (widget.allowedDomains.length > 0 && origin) {
      try {
        const originHost = new URL(origin).hostname
        const isAllowed = widget.allowedDomains.some(
          (d: string) => originHost === d || originHost.endsWith('.' + d)
        )
        if (!isAllowed) {
          return NextResponse.json(
            { error: 'Origin not allowed' },
            { status: 403, headers }
          )
        }
      } catch {
        return NextResponse.json(
          { error: 'Invalid origin' },
          { status: 403, headers }
        )
      }
    }

    const {
      instagramHandle,
      tiktokHandle,
      youtubeHandle,
      email,
      name,
      pageUrl,
      referrer,
    } = body

    // At least one handle or email is required
    if (!instagramHandle && !tiktokHandle && !youtubeHandle && !email) {
      return NextResponse.json(
        { error: 'At least one social handle or email is required' },
        { status: 400, headers }
      )
    }

    // Clean handles (remove @ prefix if present)
    const cleanHandle = (h: string | null | undefined) =>
      h ? h.replace(/^@/, '').trim().toLowerCase() : null

    const cleanIg = cleanHandle(instagramHandle)
    const cleanTt = cleanHandle(tiktokHandle)
    const cleanYt = cleanHandle(youtubeHandle)

    // Save capture
    const capture = await prisma.liveCapture.create({
      data: {
        widgetId: widget.id,
        instagramHandle: cleanIg,
        tiktokHandle: cleanTt,
        youtubeHandle: cleanYt,
        email: email?.trim().toLowerCase() || null,
        name: name?.trim() || null,
        pageUrl: pageUrl || null,
        referrer: referrer || null,
        userAgent: request.headers.get('user-agent') || null,
      },
    })

    // Increment submissions count
    await prisma.liveCaptureWidget.update({
      where: { id: widget.id },
      data: { submissions: { increment: 1 } },
    })

    // Auto-process: try to match handles against existing CreatorPlatformProfile
    let matchedContactId: string | null = null
    try {
      const handleConditions = []
      if (cleanIg) {
        handleConditions.push({
          platform: 'INSTAGRAM' as const,
          username: cleanIg,
        })
      }
      if (cleanTt) {
        handleConditions.push({
          platform: 'TIKTOK' as const,
          username: cleanTt,
        })
      }
      if (cleanYt) {
        handleConditions.push({
          platform: 'YOUTUBE' as const,
          username: cleanYt,
        })
      }

      if (handleConditions.length > 0) {
        const matchedProfile = await prisma.creatorPlatformProfile.findFirst({
          where: {
            OR: handleConditions,
          },
          select: {
            creatorId: true,
            platform: true,
            username: true,
          },
        })

        if (matchedProfile) {
          // Auto-create ClientContact
          const socialHandles: Record<string, string> = {}
          if (cleanIg) socialHandles.instagram = cleanIg
          if (cleanTt) socialHandles.tiktok = cleanTt
          if (cleanYt) socialHandles.youtube = cleanYt

          const contact = await prisma.clientContact.create({
            data: {
              userId: widget.userId,
              source: 'API',
              contactName: name?.trim() || cleanIg || cleanTt || cleanYt || 'Unknown',
              contactEmail: email?.trim().toLowerCase() || null,
              socialHandles,
              tags: ['live_capture'],
            },
          })

          matchedContactId = contact.id

          // Auto-create ClientCreatorMatch
          await prisma.clientCreatorMatch.create({
            data: {
              userId: widget.userId,
              clientContactId: contact.id,
              creatorProfileId: matchedProfile.creatorId,
              confidenceScore: 95,
              confidenceLevel: 'EXACT',
              matchSignals: ['live_capture_handle_match'],
              matchStatus: 'AUTO_DETECTED',
            },
          })

          // Mark capture as processed
          await prisma.liveCapture.update({
            where: { id: capture.id },
            data: {
              isProcessed: true,
              matchedContactId: contact.id,
            },
          })
        }
      }
    } catch (matchError) {
      console.error('Auto-match error (non-fatal):', matchError)
    }

    return NextResponse.json(
      {
        success: true,
        captureId: capture.id,
        matched: !!matchedContactId,
      },
      { headers }
    )
  } catch (error) {
    console.error('Live capture collect error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
    )
  }
}
