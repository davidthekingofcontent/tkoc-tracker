'use client'

import { useState } from 'react'
import { History, Loader2, Star, TrendingUp, Shield, Zap, Award } from 'lucide-react'
import { Modal, ModalHeader, ModalBody } from '@/components/ui/modal'
import { formatEur, formatRatio, type EurLocale } from '@/lib/utils'
import { translations } from '@/i18n/translations'

/**
 * «Historial» of a creator in the Choose tab: her campaigns (every linked
 * profile of the person added up), fee, status, EMV and a score, read from
 * GET /api/influencers/[id]/history.
 *
 * It used to open as an absolutely-positioned panel (384 px wide, anchored to
 * the right edge of a button that sits on the LEFT of the card), so the main
 * column's overflow-x-hidden cut off its left half, the one with the campaign
 * names, and on a phone it fell off the screen (review of 16 Nov 2026, point
 * 3). Like «Notas» (becb120) it is now a centered Modal: nothing clips it, it
 * works on mobile, and the list scrolls inside (about 70vh). Statuses and
 * campaign types are translated, each campaign shows its month, the newest
 * campaign comes first and the campaign the PM is looking at is marked.
 */

export interface PriceEntry {
  campaignId: string
  campaignName: string
  campaignType: string
  /** The profile of the person that holds this membership (Instagram, TikTok...). */
  profile?: { id: string; username: string; platform: string }
  agreedFee: number | null
  cost: number | null
  status: string
  startDate: string | null
  endDate: string | null
  mediaValue: number
  /** EMV of this creator in the campaign (same value as mediaValue, new name). */
  emvExtended?: number
  /** EMV ÷ coste of this creator in the campaign; null without cost. */
  ratioEmv?: number | null
}

export interface Score {
  total: number
  engagement: number
  reliability: number
  /** Published campaigns among the agreed ones (AGREED or later); prospects are not counted. */
  reliabilityBasis?: { delivered: number; closed: number }
  roi: number
  /** Same score as roi under its real name (decision 9B: never call EMV-based figures ROI). */
  ratioEmv?: number
  consistency: number
}

interface InfluencerHistoryProps {
  influencerId: string
  influencerName: string
  locale: EurLocale
  /** The campaign the PM is looking at: its row is marked «Esta campaña». */
  campaignId?: string
}

const STATUS_KEY: Record<string, 'prospect' | 'outreach' | 'negotiating' | 'agreed' | 'contracted' | 'shipping' | 'posted' | 'completed'> = {
  PROSPECT: 'prospect',
  OUTREACH: 'outreach',
  NEGOTIATING: 'negotiating',
  AGREED: 'agreed',
  CONTRACTED: 'contracted',
  SHIPPING: 'shipping',
  POSTED: 'posted',
  COMPLETED: 'completed',
}

/** The pipeline status as the PM reads it («Completado», «Envío»); an unknown value stays as it came. */
export function pipelineStatusLabel(status: string, locale: EurLocale): string {
  const key = STATUS_KEY[status]
  return key ? translations[locale].pipeline[key] : status
}

/** The campaign type as the PM reads it; UGC is UGC in both languages. */
export function campaignTypeLabel(type: string, locale: EurLocale): string {
  const t = translations[locale].campaigns
  if (type === 'INFLUENCER_TRACKING') return t.influencerTracking
  if (type === 'SOCIAL_LISTENING') return t.socialListening
  if (type === 'UGC') return 'UGC'
  return type
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function monthParts(d: Date, locale: EurLocale): { month: string; year: string } {
  const parts = new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', {
    timeZone: 'Europe/Madrid',
    month: 'long',
    year: 'numeric',
  }).formatToParts(d)
  return {
    month: parts.find(p => p.type === 'month')?.value ?? '',
    year: parts.find(p => p.type === 'year')?.value ?? '',
  }
}

/**
 * «mes AAAA» of a campaign from its dates, in Europe/Madrid: «octubre 2026»;
 * a campaign spanning months reads «octubre a diciembre 2026» (or with both
 * years when they differ). null when the campaign has no dates at all.
 */
export function historyMonthLabel(entry: { startDate: string | Date | null; endDate: string | Date | null }, locale: EurLocale): string | null {
  const start = toDate(entry.startDate)
  const end = toDate(entry.endDate)
  const from = start ?? end
  if (!from) return null
  const a = monthParts(from, locale)
  if (!start || !end) return `${a.month} ${a.year}`
  const b = monthParts(end, locale)
  if (a.month === b.month && a.year === b.year) return `${a.month} ${a.year}`
  const joiner = locale === 'es' ? ' a ' : ' to '
  if (a.year === b.year) return `${a.month}${joiner}${b.month} ${a.year}`
  return `${a.month} ${a.year}${joiner}${b.month} ${b.year}`
}

const scoreColor = (val: number) => {
  if (val >= 75) return 'text-green-600 dark:text-green-400'
  if (val >= 50) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

const scoreBg = (val: number) => {
  if (val >= 75) return 'bg-green-50 border-green-200 dark:bg-green-900/30 dark:border-green-800'
  if (val >= 50) return 'bg-amber-50 border-amber-200 dark:bg-amber-900/30 dark:border-amber-800'
  return 'bg-red-50 border-red-200 dark:bg-red-900/30 dark:border-red-800'
}

const statusColor = (status: string) => {
  if (status === 'COMPLETED') return 'text-green-600 dark:text-green-400'
  if (status === 'POSTED') return 'text-cyan-600 dark:text-cyan-400'
  return 'text-gray-500 dark:text-gray-400'
}

export interface InfluencerHistoryPanelProps {
  priceHistory: PriceEntry[]
  score: Score | null
  locale: EurLocale
  campaignId?: string
  isLoading?: boolean
  error?: string | null
}

/** The content of the modal: score card and the list of campaigns. Pure, so it can be rendered on the server in tests. */
export function InfluencerHistoryPanel({ priceHistory, score, locale, campaignId, isLoading, error }: InfluencerHistoryPanelProps) {
  const t = translations[locale].influencerHistory

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    )
  }

  const basis = score?.reliabilityBasis
  const basisText = basis
    ? basis.closed > 0
      ? t.reliabilityBasis.replace('{delivered}', String(basis.delivered)).replace('{closed}', String(basis.closed))
      : t.reliabilityNoBasis
    : null

  return (
    <>
      {error && (
        <p className="px-5 py-3 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* Score card */}
      {score && (
        <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div className="mb-3 flex items-center gap-3">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 ${scoreBg(score.total)}`}>
              <span className={`text-lg font-bold ${scoreColor(score.total)}`}>{score.total}</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                <Award className="mr-1 inline h-3 w-3" />
                {t.overallScore}
              </p>
              <p className="text-[10px] text-gray-400 dark:text-gray-500">
                {score.total >= 75 ? t.excellent : score.total >= 50 ? t.good : t.needsImprovement}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: t.engagement, value: score.engagement, icon: TrendingUp },
              { label: t.reliability, value: score.reliability, icon: Shield },
              { label: t.ratioEmv, value: score.ratioEmv ?? score.roi, icon: Zap },
              { label: t.consistency, value: score.consistency, icon: Star },
            ].map(({ label, value, icon: Icon }) => (
              <div key={label} className="text-center">
                <Icon className={`mx-auto mb-0.5 h-3 w-3 ${scoreColor(value)}`} />
                <p className={`text-sm font-bold ${scoreColor(value)}`}>{value}</p>
                <p className="text-[9px] text-gray-400 dark:text-gray-500">{label}</p>
              </div>
            ))}
          </div>
          {basisText && (
            <p className="mt-2 text-[10px] text-gray-400 dark:text-gray-500">
              <Shield className="mr-1 inline h-3 w-3" />
              {t.reliability}: {basisText}
            </p>
          )}
        </div>
      )}

      {/* Campaigns, newest first (ordered by the server by start date) */}
      {priceHistory.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400 dark:text-gray-500">{t.noHistory}</p>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {priceHistory.map((entry) => {
            const isCurrent = !!campaignId && entry.campaignId === campaignId
            const fee = entry.agreedFee || entry.cost
            const month = historyMonthLabel(entry, locale)
            return (
              <div
                key={entry.campaignId}
                className={`px-5 py-2.5 ${isCurrent ? 'bg-purple-50/60 dark:bg-purple-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span className="break-words text-xs font-medium text-gray-900 dark:text-gray-100">
                      {entry.campaignName}
                    </span>
                    {isCurrent && (
                      <span
                        data-current-campaign="true"
                        className="ml-2 inline-block rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-purple-700 dark:bg-purple-900/50 dark:text-purple-200"
                      >
                        {t.thisCampaign}
                      </span>
                    )}
                  </div>
                  <span className={`shrink-0 text-xs font-bold ${fee ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 dark:text-gray-500'}`}>
                    {fee ? formatEur(fee, { locale }) : '—'}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-400 dark:text-gray-500">
                  <span className="font-medium text-gray-500 dark:text-gray-400">{month ?? t.noDates}</span>
                  <span>&middot;</span>
                  <span>{campaignTypeLabel(entry.campaignType, locale)}</span>
                  <span>&middot;</span>
                  <span className={statusColor(entry.status)}>{pipelineStatusLabel(entry.status, locale)}</span>
                  {entry.profile && entry.profile.platform !== 'INSTAGRAM' && (
                    <>
                      <span>&middot;</span>
                      <span>@{entry.profile.username} ({entry.profile.platform === 'TIKTOK' ? 'TikTok' : entry.profile.platform === 'YOUTUBE' ? 'YouTube' : entry.profile.platform})</span>
                    </>
                  )}
                  {entry.mediaValue > 0 && (
                    <>
                      <span>&middot;</span>
                      <span className="text-green-600 dark:text-green-400">
                        {t.emv}: {formatEur(Math.round(entry.emvExtended ?? entry.mediaValue), { compact: true, locale })}
                        {typeof entry.ratioEmv === 'number' && entry.ratioEmv > 0 && (
                          <span className="ml-1 text-gray-400 dark:text-gray-500">· {t.ratioEmv} {formatRatio(entry.ratioEmv, { locale })}</span>
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

export function InfluencerHistoryButton({ influencerId, influencerName, locale, campaignId }: InfluencerHistoryProps) {
  const t = translations[locale].influencerHistory
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [priceHistory, setPriceHistory] = useState<PriceEntry[]>([])
  const [score, setScore] = useState<Score | null>(null)

  async function openHistory() {
    setIsOpen(true)
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/influencers/${influencerId}/history`)
      if (res.ok) {
        const data = await res.json()
        setPriceHistory(Array.isArray(data.priceHistory) ? data.priceHistory : [])
        setScore(data.score || null)
      } else {
        setError(t.loadError)
      }
    } catch {
      setError(t.loadError)
    }
    setIsLoading(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={openHistory}
        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-all ${
          isOpen
            ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200'
            : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200'
        }`}
        title={t.buttonTitle}
      >
        <History className="h-3 w-3" />
        {t.button}
      </button>

      <Modal open={isOpen} onClose={() => setIsOpen(false)} className="mx-4 max-w-xl dark:border-gray-700 dark:bg-gray-900">
        <ModalHeader onClose={() => setIsOpen(false)} className="px-5 py-3 dark:border-gray-700">
          <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{influencerName}</span>
          <span className="block text-[10px] font-normal text-gray-400 dark:text-gray-500">{t.title}</span>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] overflow-y-auto p-0">
          <InfluencerHistoryPanel
            priceHistory={priceHistory}
            score={score}
            locale={locale}
            campaignId={campaignId}
            isLoading={isLoading}
            error={error}
          />
        </ModalBody>
      </Modal>
    </>
  )
}
