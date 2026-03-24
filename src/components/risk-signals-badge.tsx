'use client'

import { useState } from 'react'
import { AlertTriangle, ShieldAlert, ShieldCheck, ChevronDown, ChevronUp, AlertCircle, Info, XCircle } from 'lucide-react'
import { useI18n } from '@/i18n/context'

/**
 * Risk Signals™ Badge — Shows risk level and expandable signal details.
 * Renders as a compact badge (low/medium/high) that expands to show alerts.
 */

interface RiskSignalsBadgeProps {
  // Pass pre-calculated data OR let the component fetch
  influencerData?: {
    followers: number
    engagementRate: number
    avgLikes: number
    avgComments: number
    avgViews: number
    platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
    previousFollowers?: number | null
    previousEngagementRate?: number | null
    agreedFee?: number | null
    campaignPaymentType?: string | null
    mediaHasDisclosure?: boolean | null
    deletedPostsCount?: number
    totalPostsTracked?: number
    totalCampaigns?: number
    completedCampaigns?: number
  }
  size?: 'sm' | 'md'
}

interface RiskResult {
  overallRisk: 'low' | 'medium' | 'high'
  riskScore: number
  signals: Array<{
    id: string
    category: string
    level: 'critical' | 'warning' | 'info'
    title: string
    description: string
    metric?: string
    actionable: string
  }>
  criticalCount: number
  warningCount: number
  infoCount: number
}

const RISK_STYLES = {
  low: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', icon: ShieldCheck, label: 'Low Risk', labelEs: 'Riesgo Bajo' },
  medium: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', icon: AlertTriangle, label: 'Medium Risk', labelEs: 'Riesgo Medio' },
  high: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', icon: ShieldAlert, label: 'High Risk', labelEs: 'Riesgo Alto' },
}

const LEVEL_STYLES = {
  critical: { bg: 'bg-red-50 dark:bg-red-900/10', border: 'border-red-200 dark:border-red-800', text: 'text-red-700 dark:text-red-300', icon: XCircle },
  warning: { bg: 'bg-amber-50 dark:bg-amber-900/10', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300', icon: AlertCircle },
  info: { bg: 'bg-blue-50 dark:bg-blue-900/10', border: 'border-blue-200 dark:border-blue-800', text: 'text-blue-700 dark:text-blue-300', icon: Info },
}

export function RiskSignalsBadge({ influencerData, size = 'sm' }: RiskSignalsBadgeProps) {
  const { locale } = useI18n()
  const [result, setResult] = useState<RiskResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [fetched, setFetched] = useState(false)

  async function fetchRisks() {
    if (fetched && result) {
      setExpanded(!expanded)
      return
    }
    if (!influencerData) return
    setLoading(true)
    try {
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'risk-signals', data: influencerData }),
      })
      if (res.ok) {
        const data = await res.json()
        setResult(data)
        setFetched(true)
        setExpanded(true)
      }
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }

  if (!influencerData) return null

  const riskStyle = result ? RISK_STYLES[result.overallRisk] : null
  const RiskIcon = riskStyle?.icon || ShieldCheck

  return (
    <div className="relative">
      <button
        onClick={fetchRisks}
        disabled={loading}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-all ${
          result
            ? `${riskStyle?.bg} ${riskStyle?.text}`
            : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
        }`}
        title={locale === 'es' ? 'Risk Signals™ — Verificar factores de riesgo' : 'Risk Signals™ — Check risk factors'}
      >
        {loading ? (
          <span className="animate-pulse">...</span>
        ) : result ? (
          <>
            <RiskIcon className="h-3 w-3" />
            {size !== 'sm' && <span>{locale === 'es' ? riskStyle?.labelEs : riskStyle?.label}</span>}
            {result.signals.length > 0 && (
              <span className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white dark:bg-gray-900 text-[8px] font-bold">
                {result.signals.length}
              </span>
            )}
            {expanded ? <ChevronUp className="h-2.5 w-2.5" /> : <ChevronDown className="h-2.5 w-2.5" />}
          </>
        ) : (
          <>
            <ShieldCheck className="h-3 w-3" />
            {size !== 'sm' && <span>{locale === 'es' ? 'Verificar Riesgo' : 'Check Risk'}</span>}
          </>
        )}
      </button>

      {/* Expanded signals panel */}
      {expanded && result && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RiskIcon className={`h-4 w-4 ${riskStyle?.text}`} />
              <span className={`text-sm font-bold ${riskStyle?.text}`}>{locale === 'es' ? riskStyle?.labelEs : riskStyle?.label}</span>
              <span className="text-[10px] text-gray-400">{locale === 'es' ? 'Puntuación' : 'Score'}: {result.riskScore}/100</span>
            </div>
            <button onClick={() => setExpanded(false)} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
          </div>

          {result.signals.length === 0 ? (
            <div className="text-center py-3">
              <ShieldCheck className="mx-auto h-8 w-8 text-emerald-400" />
              <p className="mt-2 text-xs text-gray-500">{locale === 'es' ? 'No se detectaron señales de riesgo. Este creador parece seguro.' : 'No risk signals detected. This creator looks safe.'}</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {result.signals.map((signal) => {
                const levelStyle = LEVEL_STYLES[signal.level]
                const LevelIcon = levelStyle.icon
                return (
                  <div key={signal.id} className={`rounded-lg border ${levelStyle.border} ${levelStyle.bg} p-2.5`}>
                    <div className="flex items-start gap-2">
                      <LevelIcon className={`h-3.5 w-3.5 mt-0.5 flex-shrink-0 ${levelStyle.text}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className={`text-xs font-semibold ${levelStyle.text}`}>{signal.title}</p>
                          {signal.metric && (
                            <span className={`text-[10px] font-mono ${levelStyle.text}`}>{signal.metric}</span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-0.5">{signal.description}</p>
                        <p className="text-[10px] text-gray-500 dark:text-gray-500 mt-1 italic">{signal.actionable}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-2">
            <div className="flex gap-3 text-[10px]">
              {result.criticalCount > 0 && <span className="text-red-600">⬤ {result.criticalCount} critical</span>}
              {result.warningCount > 0 && <span className="text-amber-600">⬤ {result.warningCount} warning</span>}
              {result.infoCount > 0 && <span className="text-blue-600">⬤ {result.infoCount} info</span>}
            </div>
            <p className="text-[9px] text-gray-400">Risk Signals™</p>
          </div>
        </div>
      )}
    </div>
  )
}
