import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// PATCH /api/campaigns/[id]/media/[mediaId]
// Content tags the PM puts on ONE piece of content (decision 15A): the angle
// of the piece, the hook of its first seconds and the product benefit it
// pushes. All optional — an empty field is stored as null and therefore never
// shown. Only ADMIN / EMPLOYEE write; the media row must belong to the campaign.

/** Suggested angles. Must stay in sync with CONTENT_ANGLES in the campaign detail page. */
const CONTENT_ANGLES = new Set([
  'problema_solucion',
  'tutorial',
  'unboxing',
  'testimonio',
  'humor',
  'comparativa',
  'dia_a_dia',
  'otro',
])

const SHORT_TEXT_MAX = 120

/** Optional short text: null/'' clears; undefined = invalid (not a string / too long). */
function parseShortText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= SHORT_TEXT_MAX ? trimmed : undefined
}

/** Optional angle from the suggested list: null/'' clears; undefined = invalid. */
function parseAngle(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  return CONTENT_ANGLES.has(v) ? v : undefined
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mediaId: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id, mediaId } = await params

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // ---- Validate only the keys that came in (absent = untouched) ----
    const data: { contentAngle?: string | null; hook?: string | null; productBenefit?: string | null } = {}
    if (body.contentAngle !== undefined) {
      const v = parseAngle(body.contentAngle)
      if (v === undefined) {
        return NextResponse.json({ error: `contentAngle must be one of: ${[...CONTENT_ANGLES].join(', ')}` }, { status: 400 })
      }
      data.contentAngle = v
    }
    if (body.hook !== undefined) {
      const v = parseShortText(body.hook)
      if (v === undefined) {
        return NextResponse.json({ error: `hook must be text of at most ${SHORT_TEXT_MAX} characters` }, { status: 400 })
      }
      data.hook = v
    }
    if (body.productBenefit !== undefined) {
      const v = parseShortText(body.productBenefit)
      if (v === undefined) {
        return NextResponse.json({ error: `productBenefit must be text of at most ${SHORT_TEXT_MAX} characters` }, { status: 400 })
      }
      data.productBenefit = v
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // The row must be this campaign's — never tag another campaign's content through this URL.
    const existing = await prisma.media.findFirst({
      where: { id: mediaId, campaignId: id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Media not found in this campaign' }, { status: 404 })
    }

    const media = await prisma.media.update({
      where: { id: existing.id },
      data,
      include: {
        influencer: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, platform: true },
        },
      },
    })

    return NextResponse.json({ media })
  } catch (error) {
    console.error('Update media tags error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
