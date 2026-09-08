'use client'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { CampaignReport } from '@/components/campaign-report'

// Brand portal report — same shared report component as the agency dashboard,
// but fed from the portal API (which strips ALL economic data) and in portal
// mode (client-friendly empty states, no agency links, no CPM/fee columns).
// `?print=1` is the server-side PDF renderer (see the agency page).
function PortalCampaignReportInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const campaignId = params.id as string
  const printMode = searchParams.get('print') === '1'

  return (
    <CampaignReport
      campaignId={campaignId}
      apiBase="/api/portal/campaigns"
      backHref={`/portal/campaigns/${campaignId}`}
      isPortal
      printMode={printMode}
    />
  )
}

export default function PortalCampaignReportPage() {
  return (
    <Suspense fallback={null}>
      <PortalCampaignReportInner />
    </Suspense>
  )
}
