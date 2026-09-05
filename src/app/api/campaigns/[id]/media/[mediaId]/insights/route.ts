import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { extractInsightsFromImage, type ExtractInsightsErrorCode } from '@/lib/insights-extract'

// POST /api/campaigns/[id]/media/[mediaId]/insights
// "Registrar estadísticas" step 1 (decision 2026-09-05, point 3): the PM
// uploads the creator's insights screenshot, Claude reads the figures and this
// endpoint returns them as a PROPOSAL. Nothing is stored here — the PM reviews
// the numbers and saves through PATCH /api/campaigns/[id]/media/[mediaId]
// (body.insights), which records the provenance.
// Body: { imageBase64: string (data-URL prefix tolerated), mimeType: 'image/jpeg' | 'image/png' | 'image/webp' }
// ADMIN / EMPLOYEE only; the media row must belong to the campaign.

// Vision calls can take a while; make sure the route isn't cut short.
export const runtime = 'nodejs'
export const maxDuration = 60

const STATUS_BY_CODE: Record<ExtractInsightsErrorCode, number> = {
  not_configured: 503,
  invalid_image: 400,
  too_large: 413,
  refusal: 422,
  unparseable: 422,
  rate_limit: 429,
  api: 502,
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mediaId: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated', code: 'unauthenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 })
    }

    const { id, mediaId } = await params

    let body: { imageBase64?: unknown; mimeType?: unknown; locale?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body', code: 'bad_body' }, { status: 400 })
    }
    if (typeof body.imageBase64 !== 'string' || !body.imageBase64.trim()) {
      return NextResponse.json({ error: 'imageBase64 (string) is required', code: 'bad_body' }, { status: 400 })
    }
    if (typeof body.mimeType !== 'string') {
      return NextResponse.json({ error: 'mimeType (image/jpeg | image/png | image/webp) is required', code: 'bad_body' }, { status: 400 })
    }

    // The row must be this campaign's — never read a screenshot against another campaign's content.
    const media = await prisma.media.findFirst({
      where: { id: mediaId, campaignId: id },
      select: { id: true, mediaType: true, platform: true },
    })
    if (!media) {
      return NextResponse.json({ error: 'Media not found in this campaign', code: 'not_found' }, { status: 404 })
    }

    const result = await extractInsightsFromImage({
      imageBase64: body.imageBase64,
      mimeType: body.mimeType,
      mediaType: media.mediaType,
      platform: media.platform,
      locale: body.locale === 'en' ? 'en' : 'es',
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code }, { status: STATUS_BY_CODE[result.code] ?? 502 })
    }

    // A proposal, not a record: the PM confirms (and can edit) before PATCH stores it.
    return NextResponse.json({ proposal: result.data, model: result.model, mediaType: media.mediaType })
  } catch (error) {
    console.error('Extract media insights error:', error)
    return NextResponse.json({ error: 'Internal server error', code: 'internal' }, { status: 500 })
  }
}
