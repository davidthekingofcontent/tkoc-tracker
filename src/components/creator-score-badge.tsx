'use client'

import { useCallback, useMemo, useState } from 'react'
import { useI18n } from '@/i18n/context'
import { formatEur, formatPercent, type EurLocale } from '@/lib/utils'

/**
 * Creator Score™ Badge — Circular badge showing 0-100 score with color.
 * Expandable on click to show component breakdown.
 *
 * Texts: src/lib/creator-score.ts emits an i18n key plus the raw numbers for the
 * summary and each component; this component fills the template for the UI
 * locale (translations.*.intelligence) and falls back to the English string the
 * lib sends when a key has no translation.
 */

// ============ TEXT RESOLUTION (shared with risk-signals-badge) ============

/** Raw values a template interpolates (numbers are formatted here, per locale). */
export type TextParams = Record<string, number | string>

/** Decimals a value actually carries, capped at 2 — 42 → "42 %", 3.2 → "3,2 %", 0.15 → "0,15 %". */
function decimalsOf(value: number): number {
  if (Number.isInteger(value)) return 0
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9 ? 1 : 2
}

/**
 * Fills a translation template with locale-aware values.
 *   {name}        number in the locale's digits ("12.345" / "12,345")
 *   {name:pct}    percentage already in percent units, unit included ("42 %" / "42%")
 *   {name:eur}    euros ("45,5 €" / "€45.5")
 *   {name:label}  a code looked up in `labels` (creator tier → its localized word)
 * A placeholder without a param is left as written so a gap is visible, never silent.
 */
export function interpolate(
  template: string,
  params: TextParams,
  opts: { locale: EurLocale; labels?: Record<string, string> }
): string {
  const tag = opts.locale === 'es' ? 'es-ES' : 'en-GB'
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (match: string, name: string, fmt?: string) => {
    if (!(name in params)) return match
    const value = params[name]
    if (fmt === 'label') return opts.labels?.[String(value)] ?? String(value)
    if (typeof value !== 'number') return value
    if (fmt === 'pct') return formatPercent(value, { locale: opts.locale, digits: decimalsOf(value) })
    if (fmt === 'eur') return formatEur(value, { locale: opts.locale, maxFractionDigits: 2 })
    return value.toLocaleString(tag, { maximumFractionDigits: 2 })
  })
}

const TIER_CODES = ['nano', 'micro', 'mid', 'macro', 'mega'] as const

/**
 * Resolver for the Intelligence texts: (key, params, englishFallback) → text in
 * the UI locale. No key, or a key without translation → the English fallback.
 */
export function useIntelligenceText() {
  const { t, locale } = useI18n()
  const dict = t.intelligence as unknown as Record<string, string | undefined>
  const labels = useMemo(() => {
    const out: Record<string, string> = {}
    for (const code of TIER_CODES) out[code] = dict[`tier_${code}`] ?? code
    return out
  }, [dict])
  return useCallback(
    (key: string | undefined, params: TextParams | undefined, fallback: string): string => {
      const template = key ? dict[key] : undefined
      return template ? interpolate(template, params ?? {}, { locale, labels }) : fallback
    },
    [dict, locale, labels]
  )
}

// ============ BADGE ============

/** One component of the score as the lib returns it (detailKey/detailParams localize `detail`). */
interface ScoreComponentView {
  score: number
  /** English fallback */
  detail: string
  detailKey?: string
  detailParams?: TextParams
}

interface CreatorScoreBadgeProps {
  score: number | null   // null = not yet calculated
  grade?: string         // A+, A, B, C, D, F
  signal?: 'green' | 'yellow' | 'red'
  /** English fallback of the one-line verdict */
  summary?: string
  /** i18n key + params of the verdict (CreatorScoreResult.summaryKey / summaryParams) */
  summaryKey?: string
  summaryParams?: TextParams
  components?: {
    engagementQuality: ScoreComponentView
    valueEfficiency: ScoreComponentView
    consistency: ScoreComponentView
    trackRecord: ScoreComponentView
    audienceQuality: ScoreComponentView
  }
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
  expandable?: boolean
}

const SIGNAL_COLORS = {
  green: { bg: 'bg-emerald-50 dark:bg-emerald-900/20', ring: 'ring-emerald-400', text: 'text-emerald-700 dark:text-emerald-300', bar: 'bg-emerald-500' },
  yellow: { bg: 'bg-amber-50 dark:bg-amber-900/20', ring: 'ring-amber-400', text: 'text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
  red: { bg: 'bg-red-50 dark:bg-red-900/20', ring: 'ring-red-400', text: 'text-red-700 dark:text-red-300', bar: 'bg-red-500' },
}

const SIZE_MAP = {
  sm: { circle: 'h-8 w-8', font: 'text-xs', label: 'text-[10px]' },
  md: { circle: 'h-11 w-11', font: 'text-sm', label: 'text-xs' },
  lg: { circle: 'h-14 w-14', font: 'text-lg', label: 'text-xs' },
}

export function CreatorScoreBadge({
  score,
  grade,
  signal = 'yellow',
  summary,
  summaryKey,
  summaryParams,
  components,
  size = 'md',
  showLabel = true,
  expandable = true,
}: CreatorScoreBadgeProps) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  const text = useIntelligenceText()
  const scoreLabel = t.intelligence.creator_score_label

  if (score === null) {
    return (
      <div className="flex items-center gap-1.5">
        <div className={`${SIZE_MAP[size].circle} flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800`}>
          <span className={`${SIZE_MAP[size].font} font-bold text-gray-400`}>—</span>
        </div>
        {showLabel && <span className={`${SIZE_MAP[size].label} text-gray-400`}>{scoreLabel}</span>}
      </div>
    )
  }

  const colors = SIGNAL_COLORS[signal]
  const summaryText = text(summaryKey, summaryParams, summary ?? '')
  const detailOf = (c: ScoreComponentView) => text(c.detailKey, c.detailParams, c.detail)

  return (
    <div className="relative">
      <button
        onClick={() => expandable && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        title={summaryText || `${t.intelligence.creatorScore}: ${score}`}
      >
        <div className={`${SIZE_MAP[size].circle} flex items-center justify-center rounded-full ${colors.bg} ring-2 ${colors.ring} transition-transform ${expanded ? 'scale-110' : ''}`}>
          <span className={`${SIZE_MAP[size].font} font-bold ${colors.text}`}>{score}</span>
        </div>
        {showLabel && (
          <div className="flex flex-col">
            <span className={`${SIZE_MAP[size].label} font-semibold ${colors.text}`}>{grade || ''}</span>
            {size !== 'sm' && <span className="text-[10px] text-gray-400">{scoreLabel}</span>}
          </div>
        )}
      </button>

      {/* Expanded breakdown */}
      {expanded && components && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`h-8 w-8 flex items-center justify-center rounded-full ${colors.bg} ring-2 ${colors.ring}`}>
                <span className={`text-sm font-bold ${colors.text}`}>{score}</span>
              </div>
              <div>
                <span className={`text-sm font-bold ${colors.text}`}>Creator Score™</span>
                <span className="ml-1.5 text-xs text-gray-400">{grade}</span>
              </div>
            </div>
            <button onClick={() => setExpanded(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
          </div>

          {summaryText && (
            <p className="mb-3 text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{summaryText}</p>
          )}

          <div className="space-y-2.5">
            <ScoreBar label={t.intelligence.engagement} score={components.engagementQuality.score} weight={30} detail={detailOf(components.engagementQuality)} />
            <ScoreBar label={t.intelligence.value} score={components.valueEfficiency.score} weight={25} detail={detailOf(components.valueEfficiency)} />
            <ScoreBar label={t.intelligence.consistency} score={components.consistency.score} weight={20} detail={detailOf(components.consistency)} />
            <ScoreBar label={t.intelligence.trackRecord} score={components.trackRecord.score} weight={15} detail={detailOf(components.trackRecord)} />
            <ScoreBar label={t.intelligence.audience} score={components.audienceQuality.score} weight={10} detail={detailOf(components.audienceQuality)} />
          </div>

          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-2">
            <p className="text-[10px] text-gray-400 text-center">{t.intelligence.creator_score_powered_by}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function ScoreBar({ label, score, weight, detail }: { label: string; score: number; weight: number; detail: string }) {
  const barColor = score >= 70 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : 'bg-red-500'

  return (
    <div title={detail}>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] text-gray-600 dark:text-gray-400">{label} <span className="text-gray-300 dark:text-gray-600">({weight}%)</span></span>
        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">{score}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-800">
        <div className={`h-1.5 rounded-full ${barColor} transition-all`} style={{ width: `${score}%` }} />
      </div>
    </div>
  )
}
