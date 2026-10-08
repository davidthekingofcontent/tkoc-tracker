'use client'

import { useEffect, useState } from 'react'
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import { AlertCircle, ArrowRightLeft, Copy, Loader2 } from 'lucide-react'

/**
 * "Mover a otra campaña" (Elegir, item 8): moves or copies the selected members of
 * the current campaign to another one through POST /api/campaigns/[id]/influencers/move.
 *
 * Target list: GET /api/campaigns (non-archived, not social listening), minus the current
 * campaign; the campaigns of the same brand come first. The server re-checks the target
 * (400 on archived / social listening) and the message lands in the inline error below. Captured content never travels: in 'move'
 * mode the server keeps the source row of any creator with media and reports it.
 */
export interface MoveCreatorsResult {
  moved: number
  copied: number
  skippedExisting: string[]
  keptBecauseMedia: string[]
  notMembers: number
  target: { id: string; name: string }
  mode: 'move' | 'copy'
}

interface MoveCreatorsModalProps {
  open: boolean
  onClose: () => void
  sourceCampaignId: string
  /** Brand of the current campaign (Setting campaign_brand_{id}); null when none. */
  sourceBrandId: string | null
  /** Influencer ids (Influencer.id, not CampaignInfluencer.id) selected in the Elegir list. */
  influencerIds: string[]
  onDone: (result: MoveCreatorsResult) => void
}

interface TargetCampaign {
  id: string
  name: string
  status: string
  type?: string
  brandId: string | null
  brandName: string | null
}

export function MoveCreatorsModal({ open, onClose, sourceCampaignId, sourceBrandId, influencerIds, onDone }: MoveCreatorsModalProps) {
  const { t } = useI18n()
  const [campaigns, setCampaigns] = useState<TargetCampaign[]>([])
  const [loading, setLoading] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [mode, setMode] = useState<'move' | 'copy'>('move')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setTargetId('')
    setMode('move')
    setLoading(true)
    fetch('/api/campaigns')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled) return
        const rows: TargetCampaign[] = (data?.campaigns || [])
          // Same gate as the server: never an archived campaign nor a social-listening one (no memberships there)
          .filter((c: TargetCampaign) => c.id !== sourceCampaignId && c.status !== 'ARCHIVED' && c.type !== 'SOCIAL_LISTENING')
          .map((c: TargetCampaign) => ({ id: c.id, name: c.name, status: c.status, type: c.type, brandId: c.brandId ?? null, brandName: c.brandName ?? null }))
        setCampaigns(rows)
      })
      .catch(() => { if (!cancelled) setCampaigns([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, sourceCampaignId])

  const byName = (a: TargetCampaign, b: TargetCampaign) => a.name.localeCompare(b.name, 'es')
  const sameBrand = sourceBrandId ? campaigns.filter(c => c.brandId === sourceBrandId).sort(byName) : []
  const others = campaigns.filter(c => !sourceBrandId || c.brandId !== sourceBrandId).sort(byName)
  const count = influencerIds.length
  const selectedLabel = t.campaignDetail.moveSelectedCount.replace('{n}', String(count))

  async function handleSubmit() {
    if (!targetId || count === 0 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/campaigns/${sourceCampaignId}/influencers/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerIds, targetCampaignId: targetId, mode }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || t.campaignDetail.moveError)
        return
      }
      onDone({
        moved: Number(data.moved) || 0,
        copied: Number(data.copied) || 0,
        skippedExisting: Array.isArray(data.skippedExisting) ? data.skippedExisting : [],
        keptBecauseMedia: Array.isArray(data.keptBecauseMedia) ? data.keptBecauseMedia : [],
        notMembers: Number(data.notMembers) || 0,
        target: data.target && typeof data.target.name === 'string'
          ? { id: String(data.target.id), name: data.target.name }
          : { id: targetId, name: campaigns.find(c => c.id === targetId)?.name || '' },
        mode,
      })
    } catch {
      setError(t.campaignDetail.moveError)
    } finally {
      setSubmitting(false)
    }
  }

  const renderOption = (c: TargetCampaign) => (
    <option key={c.id} value={c.id}>
      {c.name}{c.brandName && !sourceBrandId ? ` · ${c.brandName}` : ''}
    </option>
  )

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader onClose={onClose}>
        <span className="inline-flex items-center gap-2">
          <ArrowRightLeft className="h-5 w-5 text-purple-600" />
          {t.campaignDetail.moveModalTitle}
        </span>
      </ModalHeader>
      <ModalBody className="space-y-4">
        <p className="text-sm text-gray-600">{selectedLabel}</p>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700" htmlFor="move-target-campaign">
            {t.campaignDetail.moveTargetLabel}
          </label>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin text-purple-600" />
              {t.common.loading}
            </div>
          ) : campaigns.length === 0 ? (
            <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-500">{t.campaignDetail.moveNoTargets}</p>
          ) : (
            <select
              id="move-target-campaign"
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
            >
              <option value="">{t.campaignDetail.moveTargetPlaceholder}</option>
              {sameBrand.length > 0 ? (
                <>
                  <optgroup label={t.campaignDetail.moveSameBrandGroup}>{sameBrand.map(renderOption)}</optgroup>
                  {others.length > 0 && <optgroup label={t.campaignDetail.moveOtherGroup}>{others.map(renderOption)}</optgroup>}
                </>
              ) : (
                others.map(renderOption)
              )}
            </select>
          )}
        </div>

        <fieldset>
          <legend className="mb-1.5 block text-sm font-medium text-gray-700">{t.campaignDetail.moveModeLabel}</legend>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="move-mode"
                value="move"
                checked={mode === 'move'}
                onChange={() => setMode('move')}
                className="mt-0.5 h-4 w-4 border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span>{t.campaignDetail.moveModeMove}</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="move-mode"
                value="copy"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
                className="mt-0.5 h-4 w-4 border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span>{t.campaignDetail.moveModeCopy}</span>
            </label>
          </div>
        </fieldset>

        <p className="rounded-lg bg-purple-50 px-3 py-2 text-xs leading-relaxed text-purple-800">
          {t.campaignDetail.moveNote}
        </p>

        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
            {error}
          </p>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          {t.common.cancel}
        </Button>
        <Button onClick={handleSubmit} disabled={submitting || !targetId || count === 0}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === 'move' ? (
            <ArrowRightLeft className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {mode === 'move' ? t.campaignDetail.moveConfirmMove : t.campaignDetail.moveConfirmCopy}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
