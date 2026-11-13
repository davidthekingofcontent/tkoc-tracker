'use client'

/**
 * Campaign page, ADMIN only: «Hay N posibles fichas duplicadas en esta
 * campaña. Revisarlas», linking to «Fichas duplicadas» filtered to the
 * campaign. N = the «cuenta doble» candidates of the campaign (two members
 * that may be the same creator). Nothing is shown to anyone else, nor while
 * the count is unknown or zero; the route answers 403 to anyone but an ADMIN.
 */
import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/context'
import { loadDuplicateCount } from './merge-api'
import { DuplicatesNoticeView } from './merge-views'

export function DuplicatesNotice({ campaignId, isAdmin }: { campaignId: string; isAdmin: boolean }) {
  const { t } = useI18n()
  const [count, setCount] = useState<{ campaignId: string; n: number } | null>(null)

  useEffect(() => {
    if (!isAdmin || !campaignId) return
    let cancelled = false
    void loadDuplicateCount(campaignId).then(n => {
      if (!cancelled && n !== null) setCount({ campaignId, n })
    })
    return () => {
      cancelled = true
    }
  }, [isAdmin, campaignId])

  // A count of another campaign (the page moved on) is never shown here
  if (!isAdmin || !count || count.campaignId !== campaignId) return null
  return <DuplicatesNoticeView count={count.n} campaignId={campaignId} texts={t.personMerge} />
}
