import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { resolveBrandScope } from '@/lib/brand-scope'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import {
  deliveryComputedState,
  deliveryNeedsComputedState,
  loadReportConfig,
  saveReportConfig,
  markReportSent,
  validateReportConfigPatch,
  reportConfigForBrand,
  defaultReportDelivery,
  type ReportConfigPatch,
} from '@/lib/report-config'

/**
 * Editable campaign report configuration (decision 16A).
 *
 * GET  — staff (ADMIN / EMPLOYEE) get the full config; the campaign's own
 *        BRAND user gets the brand projection (no audit trail). Out-of-scope
 *        brands get a 404 (not 403) so campaign ids never leak.
 * PUT  — ADMIN / EMPLOYEE only.
 *        { title?, subtitle?, intro?, conclusions?, hiddenSections?,
 *          hiddenColumns?, hiddenMediaIds?, hiddenInfluencerIds?,
 *          highlightedComments?, delivery? }
 *        saves a partial patch (strings ≤ 2000 chars, arrays ≤ 200 strings,
 *        ≤ 12 highlighted comments of ≤ 300 chars; delivery = the PM's
 *        "Prometido vs entregado" edits { overrides, extraRows } — replaced
 *        as a whole, `null` resets every row to Automático), or
 *        { markSent: true, note? } appends a sentVersions entry.
 * POST — ADMIN / EMPLOYEE only. { note? } — same as PUT { markSent: true }.
 *
 * BRAND users can never write: every mutating verb returns 403 for them.
 */

const STAFF_ROLES = ['ADMIN', 'EMPLOYEE']

function actorLabel(session: { name: string; email: string }): string {
  return session.name?.trim() || session.email
}

async function campaignExists(id: string): Promise<boolean> {
  const row = await prisma.campaign.findUnique({ where: { id }, select: { id: true } })
  return !!row
}

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

    if (session.role === 'BRAND') {
      // Same authorization as GET /api/portal/campaigns/[id]
      const scope = await resolveBrandScope(session.id)
      if (!scope.campaignIds.includes(id)) {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
      }
      const config = await loadReportConfig(id)
      // Same projection as GET /api/portal/campaigns/[id]/report-config: an
      // Automático override travels only when the SYSTEM state of its row is ok.
      const overview = deliveryNeedsComputedState(config.delivery)
        ? await computeCampaignOverview(id, {
            exclude: { mediaIds: config.hiddenMediaIds, influencerIds: config.hiddenInfluencerIds },
          })
        : null
      return NextResponse.json({ config: reportConfigForBrand(config, deliveryComputedState(overview?.delivery)) })
    }

    if (!STAFF_ROLES.includes(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!(await campaignExists(id))) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const config = await loadReportConfig(id)
    return NextResponse.json({ config })
  } catch (error) {
    console.error('Get report config error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!STAFF_ROLES.includes(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    if (!(await campaignExists(id))) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
    }
    const b = body as Record<string, unknown>

    // Variant 1: { markSent: true, note? } — record a sent version
    if (b.markSent === true) {
      if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') {
        return NextResponse.json({ error: 'note must be a string' }, { status: 400 })
      }
      if (typeof b.note === 'string' && b.note.length > 2000) {
        return NextResponse.json({ error: 'note must be at most 2000 characters' }, { status: 400 })
      }
      const config = await markReportSent(id, actorLabel(session), typeof b.note === 'string' ? b.note : undefined)
      return NextResponse.json({ config })
    }

    // Variant 2: partial config patch
    const validationError = validateReportConfigPatch(b)
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const patch: ReportConfigPatch = {}
    for (const k of ['title', 'subtitle', 'intro', 'conclusions'] as const) {
      if (b[k] !== undefined) patch[k] = b[k] === null ? '' : (b[k] as string)
    }
    for (const k of ['hiddenSections', 'hiddenColumns', 'hiddenMediaIds', 'hiddenInfluencerIds'] as const) {
      if (b[k] !== undefined) patch[k] = b[k] as string[]
    }
    // "Qué dijo la audiencia": validated above (≤ 12 items, text ≤ 300 chars);
    // normalizeReportConfig trims, caps and de-duplicates ids on save.
    if (b.highlightedComments !== undefined) {
      patch.highlightedComments = (b.highlightedComments === null ? [] : b.highlightedComments) as ReportConfigPatch['highlightedComments']
    }
    // "Prometido vs entregado": validated above (known row keys, integer counts
    // 0–1,000,000, ≤ 4 extra rows); null resets to Automático. normalizeReportConfig
    // trims, caps and de-duplicates ids on save.
    if (b.delivery !== undefined) {
      patch.delivery = (b.delivery === null ? defaultReportDelivery() : b.delivery) as ReportConfigPatch['delivery']
    }

    const config = await saveReportConfig(id, patch, actorLabel(session))
    return NextResponse.json({ config })
  } catch (error) {
    console.error('Update report config error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST = "mark as sent" shortcut ({ note? }). Kept alongside PUT { markSent }
// so a plain form post can record a version without knowing the patch shape.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (!STAFF_ROLES.includes(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    if (!(await campaignExists(id))) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    let note: string | undefined
    try {
      const body = (await request.json()) as { note?: unknown } | null
      if (body && typeof body === 'object' && body.note !== undefined && body.note !== null) {
        if (typeof body.note !== 'string') {
          return NextResponse.json({ error: 'note must be a string' }, { status: 400 })
        }
        if (body.note.length > 2000) {
          return NextResponse.json({ error: 'note must be at most 2000 characters' }, { status: 400 })
        }
        note = body.note
      }
    } catch {
      /* empty body is fine */
    }

    const config = await markReportSent(id, actorLabel(session), note)
    return NextResponse.json({ config })
  } catch (error) {
    console.error('Mark report sent error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
