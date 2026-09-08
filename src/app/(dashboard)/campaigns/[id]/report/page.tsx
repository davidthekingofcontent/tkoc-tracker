'use client'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { CampaignReport } from '@/components/campaign-report'

// `?print=1` is the server-side PDF renderer: no top bar, print layout forced,
// and the component flags <html data-report-ready="1"> once data and images
// have settled. useSearchParams needs a Suspense boundary in the App Router.
function CampaignReportInner() {
  const params = useParams()
  const searchParams = useSearchParams()
  const campaignId = params.id as string
  const printMode = searchParams.get('print') === '1'

  return (
    <CampaignReport
      campaignId={campaignId}
      apiBase="/api/campaigns"
      backHref={`/campaigns/${campaignId}`}
      printMode={printMode}
    />
  )
}

export default function CampaignReportPage() {
  return (
    <Suspense fallback={null}>
      <CampaignReportInner />
    </Suspense>
  )
}
