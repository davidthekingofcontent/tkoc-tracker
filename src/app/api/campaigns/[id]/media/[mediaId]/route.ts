import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// PATCH /api/campaigns/[id]/media/[mediaId]
// Two things the PM records on ONE piece of content, both optional in the body:
//
// 1. Content tags (decision 15A): the angle of the piece, the hook of its first
//    seconds and the product benefit it pushes. An empty field is stored as null
//    and therefore never shown.
// 2. Real insights (decision 2026-09-05, point 3): `insights` carries the figures
//    the creator shared (screenshot read by AI and confirmed by the PM, or typed
//    by hand). Stored on the Media columns as REAL data with provenance
//    (insightsSource / insightsCapturedAt / insightsBy) so the overview counts
//    them as real audience (reach → impressions → views) — never as an estimate.
//    Public figures already captured (likes, comments, views) are never lowered
//    unless the body says `insights.overwrite: true`.
//
// Only ADMIN / EMPLOYEE write; the media row must belong to the campaign.

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

// ---- Insights ----

const INSIGHT_FIELDS = ['reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'saves'] as const
type InsightField = (typeof INSIGHT_FIELDS)[number]

/** Fields whose stored value is public data (Apify / Meta) and must not go down silently. */
const PROTECTED_PUBLIC_FIELDS: ReadonlySet<InsightField> = new Set<InsightField>(['likes', 'comments', 'views'])

const INSIGHT_SOURCES = new Set(['creator_screenshot', 'manual'])

/** Upper bound that still fits an Int column and rules out nonsense. */
const MAX_COUNT = 2_000_000_000

/**
 * Non-negative integer from a number or a plain numeric string; null when the
 * key is absent/null (= untouched); undefined when present but invalid.
 */
function parseCount(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) n = Number(value)
  else return undefined
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) return undefined
  return n
}

interface ParsedInsights {
  values: Partial<Record<InsightField, number>>
  source: 'creator_screenshot' | 'manual'
  overwrite: boolean
}

/** Validates body.insights; returns an error message when it is malformed. */
function parseInsights(raw: unknown): { insights: ParsedInsights } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'insights must be an object' }
  }
  const obj = raw as Record<string, unknown>
  const source = typeof obj.source === 'string' ? obj.source : ''
  if (!INSIGHT_SOURCES.has(source)) {
    return { error: "insights.source must be 'creator_screenshot' or 'manual'" }
  }
  const values: Partial<Record<InsightField, number>> = {}
  for (const field of INSIGHT_FIELDS) {
    const v = parseCount(obj[field])
    if (v === undefined) {
      return { error: `insights.${field} must be a whole number of 0 or more` }
    }
    if (v !== null) values[field] = v
  }
  if (Object.keys(values).length === 0) {
    return { error: 'insights must carry at least one figure' }
  }
  return {
    insights: {
      values,
      source: source as ParsedInsights['source'],
      overwrite: obj.overwrite === true,
    },
  }
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
    const data: {
      contentAngle?: string | null
      hook?: string | null
      productBenefit?: string | null
      reach?: number
      impressions?: number
      views?: number
      likes?: number
      comments?: number
      shares?: number
      saves?: number
      insightsSource?: string
      insightsCapturedAt?: Date
      insightsBy?: string
    } = {}

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

    let insights: ParsedInsights | null = null
    if (body.insights !== undefined) {
      const parsed = parseInsights(body.insights)
      if ('error' in parsed) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      insights = parsed.insights
    }

    if (Object.keys(data).length === 0 && !insights) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // The row must be this campaign's — never edit another campaign's content through this URL.
    const existing = await prisma.media.findFirst({
      where: { id: mediaId, campaignId: id },
      select: { id: true, likes: true, comments: true, views: true },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Media not found in this campaign' }, { status: 404 })
    }

    // ---- Apply the insights: only the fields provided; protected public figures never go down ----
    const keptHigherPublic: InsightField[] = []
    if (insights) {
      for (const field of INSIGHT_FIELDS) {
        const value = insights.values[field]
        if (value === undefined) continue
        if (PROTECTED_PUBLIC_FIELDS.has(field) && !insights.overwrite && value < (existing[field as 'likes' | 'comments' | 'views'] || 0)) {
          keptHigherPublic.push(field)
          continue
        }
        data[field] = value
      }
      data.insightsSource = insights.source
      data.insightsCapturedAt = new Date()
      data.insightsBy = session.email || session.id
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

    return NextResponse.json({ media, keptHigherPublic })
  } catch (error) {
    console.error('Update media error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
