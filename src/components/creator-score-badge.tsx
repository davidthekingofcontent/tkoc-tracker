'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'

/**
 * Creator Score™ Badge — Circular badge showing 0-100 score with color.
 * Expandable on click to show component breakdown.
 */

interface CreatorScoreBadgeProps {
  score: number | null   // null = not yet calculated
  grade?: string         // A+, A, B, C, D, F
  signal?: 'green' | 'yellow' | 'red'
  summary?: string
  components?: {
    engagementQuality: { score: number; detail: string }
    valueEfficiency: { score: number; detail: string }
    consistency: { score: number; detail: string }
    trackRecord: { score: number; detail: string }
    audienceQuality: { score: number; detail: string }
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
  components,
  size = 'md',
  showLabel = true,
  expandable = true,
}: CreatorScoreBadgeProps) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()

  if (score === null) {
    return (
      <div className="flex items-center gap-1.5">
        <div className={`${SIZE_MAP[size].circle} flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800`}>
          <span className={`${SIZE_MAP[size].font} font-bold text-gray-400`}>—</span>
        </div>
        {showLabel && <span className={`${SIZE_MAP[size].label} text-gray-400`}>Score</span>}
      </div>
    )
  }

  const colors = SIGNAL_COLORS[signal]

  return (
    <div className="relative">
      <button
        onClick={() => expandable && setExpanded(!expanded)}
        className={`flex items-center gap-1.5 ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        title={summary || `Creator Score: ${score}`}
      >
        <div className={`${SIZE_MAP[size].circle} flex items-center justify-center rounded-full ${colors.bg} ring-2 ${colors.ring} transition-transform ${expanded ? 'scale-110' : ''}`}>
          <span className={`${SIZE_MAP[size].font} font-bold ${colors.text}`}>{score}</span>
        </div>
        {showLabel && (
          <div className="flex flex-col">
            <span className={`${SIZE_MAP[size].label} font-semibold ${colors.text}`}>{grade || ''}</span>
            {size !== 'sm' && <span className="text-[10px] text-gray-400">Score</span>}
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

          {summary && (
            <p className="mb-3 text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{summary}</p>
          )}

          <div className="space-y-2.5">
            <ScoreBar label={t.intelligence?.engagement || 'Engagement'} score={components.engagementQuality.score} weight={30} detail={components.engagementQuality.detail} />
            <ScoreBar label={t.intelligence?.value || 'Value'} score={components.valueEfficiency.score} weight={25} detail={components.valueEfficiency.detail} />
            <ScoreBar label={t.intelligence?.consistency || 'Consistency'} score={components.consistency.score} weight={20} detail={components.consistency.detail} />
            <ScoreBar label={t.intelligence?.trackRecord || 'Track Record'} score={components.trackRecord.score} weight={15} detail={components.trackRecord.detail} />
            <ScoreBar label={t.intelligence?.audience || 'Audience'} score={components.audienceQuality.score} weight={10} detail={components.audienceQuality.detail} />
          </div>

          <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-2">
            <p className="text-[10px] text-gray-400 text-center">Powered by TKOC Intelligence</p>
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
