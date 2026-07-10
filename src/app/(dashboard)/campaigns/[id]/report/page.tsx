'use client'

import { useParams } from 'next/navigation'
import { CampaignReport } from '@/components/campaign-report'

export default function CampaignReportPage() {
  const params = useParams()
  const campaignId = params.id as string

  return (
    <CampaignReport
      campaignId={campaignId}
      apiBase="/api/campaigns"
      backHref={`/campaigns/${campaignId}`}
    />
  )
}
