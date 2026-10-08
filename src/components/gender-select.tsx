'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { isValidGender, type Gender } from '@/lib/gender'

/**
 * Compact gender control for a creator (Instagram/TikTok/Apify never provide it:
 * a PM sets it here → genderSource 'manual', or the offline backfill inferred it
 * from the public name → 'inferred', shown as "(estimado)").
 *
 * PATCH /api/influencers/[id]/gender { gender: 'F' | 'M' | 'X' | null } → { id, gender, genderSource }.
 * Values contract: src/lib/gender.ts. Read-only mode renders the label only (nothing when there is no data).
 */
interface GenderSelectProps {
  influencerId: string
  gender: string | null | undefined
  genderSource: string | null | undefined
  readOnly?: boolean
  /** Called with the server-confirmed values after a successful save. */
  onChange?: (next: { gender: Gender | null; genderSource: 'manual' | 'inferred' | null }) => void
  className?: string
}

export function GenderSelect({ influencerId, gender, genderSource, readOnly = false, onChange, className }: GenderSelectProps) {
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current: Gender | '' = isValidGender(gender) ? gender : ''
  const isInferred = current !== '' && genderSource === 'inferred'
  const labels: Record<Gender | '', string> = {
    '': t.campaignDetail.genderNone,
    F: t.campaignDetail.genderF,
    M: t.campaignDetail.genderM,
    X: t.campaignDetail.genderX,
  }

  async function save(value: Gender | null) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/influencers/${influencerId}/gender`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gender: value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || t.campaignDetail.genderSaveError)
        return
      }
      onChange?.({
        gender: isValidGender(data?.gender) ? data.gender : null,
        genderSource: data?.genderSource === 'manual' || data?.genderSource === 'inferred' ? data.genderSource : null,
      })
    } catch {
      setError(t.campaignDetail.genderSaveError)
    } finally {
      setSaving(false)
    }
  }

  if (readOnly) {
    if (current === '') return null
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 ${className ?? ''}`}>
        <span className="text-gray-400 dark:text-gray-500">{t.campaignDetail.genderLabel}:</span>
        <span className="text-gray-700 dark:text-gray-200">{labels[current]}</span>
        {isInferred && <span className="text-gray-400 dark:text-gray-500">{t.campaignDetail.genderInferred}</span>}
      </span>
    )
  }

  const provenanceHint = current === ''
    ? undefined
    : isInferred
      ? t.campaignDetail.genderInferredHint
      : t.campaignDetail.genderManualHint

  return (
    <span className={`inline-flex flex-wrap items-center gap-1 text-xs ${className ?? ''}`}>
      <label className="inline-flex items-center gap-1">
        <span className="text-gray-400 dark:text-gray-500">{t.campaignDetail.genderLabel}</span>
        <select
          value={current}
          disabled={saving}
          onChange={e => save(e.target.value === '' ? null : (e.target.value as Gender))}
          title={provenanceHint}
          aria-label={t.campaignDetail.genderLabel}
          className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-200 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 disabled:opacity-60"
        >
          <option value="">{labels['']}</option>
          <option value="F">{labels.F}</option>
          <option value="M">{labels.M}</option>
          <option value="X">{labels.X}</option>
        </select>
      </label>
      {saving && <Loader2 className="h-3 w-3 animate-spin text-purple-500" />}
      {!saving && isInferred && (
        <span className="text-gray-400 dark:text-gray-500" title={t.campaignDetail.genderInferredHint}>
          {t.campaignDetail.genderInferred}
        </span>
      )}
      {error && <span className="text-red-600 dark:text-red-400" role="alert">{error}</span>}
    </span>
  )
}
