import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { resolveBrandScope } from '@/lib/brand-scope'
import { renderReportPdf, ReportPdfAbortedError, ReportPdfBusyError } from '@/lib/report-pdf'
import { slugify } from '@/lib/utils'

// GET /api/portal/campaigns/[id]/report/pdf — client PDF of the campaign report.
// Headless Chromium renders /portal/campaigns/[id]/report?print=1 as the caller
// (their own auth cookie is replayed): the page only ever fetches the portal
// API, so the PDF carries the brand projection (no fees, cost, CPM, Ratio EMV).
// Authorization mirrors GET /api/portal/campaigns/[id]: BRAND or ADMIN; a
// BRAND user only inside their resolved scope (out of scope → 404, no leaks).
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function tokenFrom(request: NextRequest): string | undefined {
  const authHeader = request.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return request.cookies.get('token')?.value
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
    if (session.role !== 'BRAND' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    if (session.role !== 'ADMIN') {
      const scope = await resolveBrandScope(session.id)
      if (!scope.campaignIds.includes(id)) {
        return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
      }
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, name: true },
    })
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const cookieToken = tokenFrom(request)
    if (!cookieToken) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const pdf = await renderReportPdf({
      path: `/portal/campaigns/${id}/report`,
      cookieToken,
      cookieName: 'token',
      signal: request.signal,
    })

    const filename = `informe-${slugify(campaign.name) || campaign.id}.pdf`
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': String(pdf.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    if (error instanceof ReportPdfAbortedError) {
      return new Response(null, { status: 499 })
    }
    if (error instanceof ReportPdfBusyError) {
      console.warn('Portal report PDF busy:', error.message)
      return NextResponse.json(
        { error: 'Report PDF renderer busy, try again shortly' },
        { status: 503, headers: { 'Retry-After': '30' } }
      )
    }
    // The detail (Chromium path, internal URL, timeouts) stays in the server log — never sent to a client.
    console.error('Portal report PDF error:', error instanceof Error ? error.message : error, error)
    return NextResponse.json({ error: 'Report PDF failed' }, { status: 500 })
  }
}
