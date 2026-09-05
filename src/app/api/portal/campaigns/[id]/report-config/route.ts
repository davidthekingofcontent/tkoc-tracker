import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { resolveBrandScope } from '@/lib/brand-scope'
import { loadReportConfig, reportConfigForBrand } from '@/lib/report-config'

// GET /api/portal/campaigns/[id]/report-config
// Brand-facing, READ-ONLY view of the report configuration the agency saved
// for this campaign (title/subtitle/intro/conclusions overrides plus what to
// hide). Same authorization as GET /api/portal/campaigns/[id]: BRAND users
// only inside their resolved scope (404 outside it, never 403, to avoid
// existence leaks); ADMIN bypasses the scope for portal testing. The audit
// trail (sentVersions / updatedBy) is stripped — it is agency-internal.
// There is deliberately no PUT/POST/DELETE here: brands never write.
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

    const config = await loadReportConfig(id)
    return NextResponse.json({ config: reportConfigForBrand(config) })
  } catch (error) {
    console.error('Portal report config error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
