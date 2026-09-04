'use client'

import { useState } from 'react'
import { TrendingUp, TrendingDown, DollarSign, Target, ChevronDown, ChevronUp, MessageSquare } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import type { AppliedModifier, DealTerms } from '@/lib/benchmarks'

/**
 * Deal Advisor™ Panel — Shows pricing intelligence when viewing/editing an influencer fee.
 * Renders inline: verdict badge, market range bar, narrative, and negotiation tip.
 */

interface DealAdvisorPanelProps {
  username: string
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  avgViews: number
  avgLikes: number
  avgComments: number
  engagementRate: number
  fee: number // current asked/agreed fee
  compact?: boolean // for inline use in tables
  /** Negotiation format (REEL, POST, STORY, VIDEO, INTEGRATION, DEDICATED, SHORT). */
  format?: string
  /** ISO-3166 alpha-2 of the campaign/creator → market multiplier. */
  country?: string | null
  /** Commercial terms → modifiers on p50 (rights, whitelisting, exclusivity…). */
  terms?: DealTerms
  /** Brand whose benchmark overrides should be used. */
  brandId?: string | null
}

interface DealResult {
  verdict: string
  verdictSignal: 'green' | 'yellow' | 'red'
  verdictLabel: string
  askedFee: number
  recommendedFeeMin: number
  recommendedFeeMax: number
  marketRangeMin: number
  marketRangeMax: number
  savingsOrOvercost: number
  savingsPercent: number
  cpmReal: number
  cpmBenchmark: number | null
  cpmSignal: string
  tier: string
  narrative: string
  negotiationTip: string
  // Benchmark context (optional: older responses may not carry them)
  format?: string
  marketMultiplier?: number
  appliedModifiers?: AppliedModifier[]
  referenceFee?: number
  percentileLabel?: string
  percentileLabels?: { p25: string; p50: string; p75: string; p90: string }
}

const VERDICT_STYLES: Record<string, { bg: string; text: string; icon: string }> = {
  excellent_deal: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', icon: '🟢' },
  fair_deal: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-300', icon: '🔵' },
  slightly_above: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', icon: '🟡' },
  overpriced: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-300', icon: '🟠' },
  way_overpriced: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', icon: '🔴' },
}

export function DealAdvisorPanel({ username, platform, followers, avgViews, avgLikes, avgComments, engagementRate, fee, compact = false, format, country, terms, brandId }: DealAdvisorPanelProps) {
  const { locale } = useI18n()
  const [result, setResult] = useState<DealResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [fetched, setFetched] = useState(false)

  async function fetchAdvice() {
    if (fetched && result) {
      setExpanded(!expanded)
      return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'deal-advisor',
          data: {
            username, platform, followers, avgViews, avgLikes, avgComments, engagementRate, askedFee: fee,
            format: format || undefined,
            country: country || undefined,
            terms: terms || undefined,
            brandId: brandId || undefined,
            locale,
          },
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setResult(data)
        setFetched(true)
        setExpanded(true)
      }
    } catch {
      // silent fail
    } finally {
      setLoading(false)
    }
  }

  if (fee <= 0 || avgViews <= 0) return null

  const style = result ? (VERDICT_STYLES[result.verdict] || VERDICT_STYLES.fair_deal) : null

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <button
          onClick={fetchAdvice}
          disabled={loading}
          className="text-[10px] text-purple-600 dark:text-purple-400 hover:underline font-medium"
          title="Deal Advisor™ — Analyze this fee"
        >
          {loading ? '...' : result ? `${style?.icon} ${result.verdictLabel}` : (locale === 'es' ? '💡 Analizar' : '💡 Analyze')}
        </button>
        {expanded && result && (
          <div className="absolute z-50 mt-1 right-0 top-full w-80 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-xl">
            <DealContent result={result} onClose={() => setExpanded(false)} locale={locale} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-2">
      <button
        onClick={fetchAdvice}
        disabled={loading}
        className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
          result ? `${style?.bg} ${style?.text}` : 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/40'
        }`}
      >
        {loading ? (
          <span className="animate-pulse">{locale === 'es' ? 'Analizando oferta...' : 'Analyzing deal...'}</span>
        ) : result ? (
          <>
            <span>{style?.icon}</span>
            <span>{result.verdictLabel}</span>
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </>
        ) : (
          <>
            <DollarSign className="h-3 w-3" />
            <span>Deal Advisor™</span>
          </>
        )}
      </button>

      {expanded && result && (
        <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-sm">
          <DealContent result={result} onClose={() => setExpanded(false)} locale={locale} />
        </div>
      )}
    </div>
  )
}

function DealContent({ result, onClose, locale = 'es' }: { result: DealResult; onClose: () => void; locale?: string }) {
  const style = VERDICT_STYLES[result.verdict] || VERDICT_STYLES.fair_deal
  const es = locale === 'es'
  const modifiers = result.appliedModifiers || []
  const fmtPct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(Math.round(p * 100))} %`

  // Market range bar positioning
  const rangeMin = result.recommendedFeeMin
  const rangeMax = Math.max(result.recommendedFeeMax, result.askedFee * 1.2)
  const barTotal = rangeMax - rangeMin * 0.5
  const feePosition = Math.max(0, Math.min(100, ((result.askedFee - rangeMin * 0.5) / barTotal) * 100))
  const greenStart = Math.max(0, ((result.recommendedFeeMin - rangeMin * 0.5) / barTotal) * 100)
  const greenEnd = Math.min(100, ((result.recommendedFeeMax - rangeMin * 0.5) / barTotal) * 100)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${style.text}`}>{style.icon} {result.verdictLabel}</span>
          <span className="text-[10px] text-gray-400">{result.tier}{result.format ? ` · ${result.format}` : ''}</span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
      </div>

      {/* Market Range Bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-gray-400">
          <span>€{result.recommendedFeeMin.toLocaleString()}</span>
          <span>€{result.recommendedFeeMax.toLocaleString()}</span>
        </div>
        <div className="relative h-3 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
          {/* Green zone */}
          <div
            className="absolute top-0 h-full bg-emerald-200 dark:bg-emerald-800/40 rounded-full"
            style={{ left: `${greenStart}%`, width: `${greenEnd - greenStart}%` }}
          />
          {/* Fee marker */}
          <div
            className={`absolute top-0 h-full w-0.5 ${result.verdictSignal === 'green' ? 'bg-emerald-600' : result.verdictSignal === 'yellow' ? 'bg-amber-500' : 'bg-red-500'}`}
            style={{ left: `${feePosition}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-gray-400">{es ? 'Rango recomendado' : 'Recommended range'}</span>
          <span className={`font-semibold ${style.text}`}>Fee: €{result.askedFee.toLocaleString()}</span>
        </div>
      </div>

      {/* Reference fee (p50 after market + modifiers) and itemized modifiers */}
      {(typeof result.referenceFee === 'number' || modifiers.length > 0) && (
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-2.5 py-2 text-[11px] space-y-1">
          {typeof result.referenceFee === 'number' && (
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-gray-400">
                {result.percentileLabels?.p50 || (es ? 'Precio de mercado' : 'Market price')}
                {modifiers.length > 0 ? (es ? ' (con modificadores)' : ' (with modifiers)') : ''}
              </span>
              <span className="font-semibold text-gray-700 dark:text-gray-200">€{result.referenceFee.toLocaleString()}</span>
            </div>
          )}
          {modifiers.length > 0 && (
            <ul className="space-y-0.5">
              {modifiers.map(m => (
                <li key={m.key} className="flex justify-between text-gray-500 dark:text-gray-400">
                  <span>{m.label}</span>
                  <span className={m.pct >= 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>{fmtPct(m.pct)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Key metrics */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
          <p className="text-[10px] text-gray-400">CPM Real</p>
          <p className="text-sm font-bold text-gray-700 dark:text-gray-200">€{result.cpmReal.toFixed(0)}</p>
        </div>
        <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
          <p className="text-[10px] text-gray-400">CPM Benchmark</p>
          <p className="text-sm font-bold text-gray-700 dark:text-gray-200">€{result.cpmBenchmark?.toFixed(0) || '—'}</p>
        </div>
        <div className={`rounded-lg p-2 ${result.savingsOrOvercost >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
          <p className="text-[10px] text-gray-400">{result.savingsOrOvercost >= 0 ? (es ? 'Ahorro' : 'Savings') : (es ? 'Sobrecoste' : 'Overcost')}</p>
          <p className={`text-sm font-bold ${result.savingsOrOvercost >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
            {result.savingsOrOvercost >= 0 ? '+' : ''}€{result.savingsOrOvercost.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Narrative */}
      <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{result.narrative}</p>

      {/* Negotiation tip */}
      <div className="rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 p-2.5">
        <div className="flex items-start gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-purple-700 dark:text-purple-300 leading-relaxed">{result.negotiationTip}</p>
        </div>
      </div>

      <p className="text-[9px] text-gray-400 text-center">Powered by TKOC Intelligence · Deal Advisor™</p>
    </div>
  )
}
