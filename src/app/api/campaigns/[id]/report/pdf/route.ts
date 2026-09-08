import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { renderReportPdf, ReportPdfAbortedError, ReportPdfBusyError } from '@/lib/report-pdf'
import { slugify } from '@/lib/utils'

// GET /api/campaigns/[id]/report/pdf — agency PDF of the campaign report.
// Headless Chromium renders /campaigns/[id]/report?print=1 as the caller
// (their own auth cookie is replayed), so the PDF shows exactly what the PM
// sees when printing. Staff only (ADMIN / EMPLOYEE, like the report config):
// the agency page carries fees, cost, CPM and Ratio EMV, so neither a BRAND
// nor a CREATOR session may render it. Brands get their PDF from
// /api/portal/campaigns/[id]/report/pdf.
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const STAFF_ROLES = ['ADMIN', 'EMPLOYEE']

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
    if (!STAFF_ROLES.includes(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
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
      path: `/campaigns/${id}/report`,
      cookieToken,
      cookieName: 'token',
      signal: request.signal,
      locale: request.nextUrl.searchParams.get('locale') === 'en' ? 'en' : 'es',
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
      console.warn('Report PDF busy:', error.message)
      return NextResponse.json(
        { error: 'Report PDF renderer busy, try again shortly' },
        { status: 503, headers: { 'Retry-After': '30' } }
      )
    }
    // The detail (Chromium path, internal URL, timeouts) stays in the server log.
    console.error('Report PDF error:', error instanceof Error ? error.message : error, error)
    return NextResponse.json({ error: 'Report PDF failed' }, { status: 500 })
  }
}
