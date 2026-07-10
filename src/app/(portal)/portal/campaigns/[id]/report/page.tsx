'use client'

import { useParams } from 'next/navigation'
import { CampaignReport } from '@/components/campaign-report'

// Brand portal report — same shared report component as the agency dashboard,
// but fed from the portal API (which strips ALL economic data) and in portal
// mode (client-friendly empty states, no agency links, no CPM/fee columns).
export default function PortalCampaignReportPage() {
  const params = useParams()
  const campaignId = params.id as string

  return (
    <CampaignReport
      campaignId={campaignId}
      apiBase="/api/portal/campaigns"
      backHref={`/portal/campaigns/${campaignId}`}
      isPortal
    />
  )
}
