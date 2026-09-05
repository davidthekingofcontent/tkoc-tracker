'use client'

import { useState, useEffect } from 'react'
import { Repeat, TrendingUp, TrendingDown, Minus, Loader2, RefreshCw } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Avatar } from '@/components/ui/avatar'
import { formatRatio } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'
import { useI18n } from '@/i18n/context'

/**
 * Repeat Radar™ Widget — Dashboard widget showing which influencers are worth repeating.
 * Fetches data from /api/intelligence (type: repeat-radar) and shows top results.
 *
 * The key metric is the Ratio EMV (EMV ÷ fees, shown as "×2,4"). It is never labelled
 * "ROI": the EMV is an equivalence estimate, not revenue (decision 9B).
 */

interface RepeatResult {
  influencerId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  verdict: 'repeat' | 'consider' | 'skip'
  signal: 'green' | 'yellow' | 'red'
  score: number
  reason: string
  reasonKey?: string
  totalCampaigns: number
  totalSpent: number
  totalEMV: number
  /** Ratio EMV = EMV ÷ spent. The API field keeps its historical name. */
  roiRatio: number
  avgCPM: number
  deliveryRate: number
  totalMedia: number
}

const VERDICT_STYLES = {
  repeat: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  consider: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  skip: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500' },
}

const PLATFORM_ICONS: Record<string, string> = {
  INSTAGRAM: '📸',
  TIKTOK: '🎵',
  YOUTUBE: '▶️',
}

/**
 * Localised one-liners for the reasons produced by src/lib/repeat-radar.ts, keyed by
 * reasonKey. Falls back to the English `reason` string the API sends when a key is unknown.
 * `{ratio}` is replaced with the formatted Ratio EMV.
 */
const REASON_TEXT: Record<string, { es: string; en: string }> = {
  repeat_unreliable: {
    es: 'Entrega poco fiable: no publicó el contenido en la mayoría de campañas.',
    en: 'Unreliable delivery — failed to deliver content in most campaigns.',
  },
  repeat_low_roi: {
    es: 'Ratio EMV muy bajo: el EMV generado no justifica el fee.',
    en: 'Very low EMV ratio — the EMV generated does not justify the fee.',
  },
  repeat_excellent: {
    es: 'Rendimiento excelente. Ratio EMV {ratio} con engagement fuerte. Repetir sin duda.',
    en: 'Excellent performer. EMV ratio {ratio} with strong engagement. Definitely repeat.',
  },
  repeat_strong: {
    es: 'Buen rendimiento en todas las campañas. Fiable y buena relación valor/coste.',
    en: 'Strong performance across campaigns. Reliable and good value.',
  },
  repeat_consider_fee: {
    es: 'Engagement correcto pero CPM alto. Repetir solo con un fee menor.',
    en: 'Decent engagement but CPM is high. Repeat only at a lower fee.',
  },
  repeat_consider_early: {
    es: 'Solo una campaña: pronto para juzgar. Repetir para tener más datos.',
    en: 'Only one campaign — too early to judge. Consider repeating to gather more data.',
  },
  repeat_consider_average: {
    es: 'Rendimiento medio. Merece repetir si se negocia el fee a la baja.',
    en: 'Average performance. Worth repeating if fee can be negotiated down.',
  },
  repeat_skip: {
    es: 'Rendimiento por debajo de la media y/o mal valor. Explorar alternativas.',
    en: 'Below-average performance and/or poor value. Explore alternatives.',
  },
  repeat_no_history: {
    es: 'Sin historial de campañas: no se puede evaluar. Considerar para una primera colaboración.',
    en: 'No campaign history — cannot evaluate. Consider for a first collaboration.',
  },
}

export function RepeatRadarWidget() {
  const { locale } = useI18n()
  const es = locale === 'es'
  const [results, setResults] = useState<RepeatResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    fetchRadar()
  }, [])

  async function fetchRadar() {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'repeat-radar', data: {} }),
      })
      if (res.ok) {
        const data = await res.json()
        setResults(data.results || [])
      } else {
        setError(true)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const verdictLabel: Record<RepeatResult['verdict'], string> = {
    repeat: es ? 'Repetir' : 'Repeat',
    consider: es ? 'Valorar' : 'Consider',
    skip: es ? 'Descartar' : 'Skip',
  }

  function reasonFor(r: RepeatResult): string {
    const text = r.reasonKey ? REASON_TEXT[r.reasonKey]?.[locale] : undefined
    return (text ?? r.reason).replace('{ratio}', formatRatio(r.roiRatio, { locale }))
  }

  // Show top 6 (mix of repeat and skip to be useful)
  const topResults = results.slice(0, 6)
  const repeatCount = results.filter(r => r.verdict === 'repeat').length
  const skipCount = results.filter(r => r.verdict === 'skip').length

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <Repeat className="h-4 w-4 text-purple-600" />
            Repeat Radar™
          </CardTitle>
          {!loading && (
            <button onClick={fetchRadar} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" aria-label={es ? 'Actualizar' : 'Refresh'}>
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {!loading && results.length > 0 && (
          <div className="flex gap-3 mt-1">
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">{repeatCount} {es ? 'repetir' : 'repeat'}</span>
            <span className="text-[10px] text-red-500 font-medium">{skipCount} {es ? 'descartar' : 'skip'}</span>
            <span className="text-[10px] text-gray-400">{results.length} {es ? 'en total' : 'total'}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
            <span className="ml-2 text-xs text-gray-500">{es ? 'Analizando creadores…' : 'Analyzing creators…'}</span>
          </div>
        ) : error ? (
          <div className="text-center py-6">
            <p className="text-xs text-gray-400">{es ? 'No se pudo cargar Repeat Radar' : 'Could not load Repeat Radar'}</p>
            <button onClick={fetchRadar} className="mt-2 text-xs text-purple-600 hover:underline">{es ? 'Reintentar' : 'Retry'}</button>
          </div>
        ) : topResults.length === 0 ? (
          <div className="text-center py-6">
            <Repeat className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="mt-2 text-xs text-gray-400">
              {es
                ? 'Aún no hay historial de campañas. Los datos aparecerán cuando los creadores completen campañas.'
                : 'No campaign history yet. Data will appear once influencers have completed campaigns.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {topResults.map((r) => {
              const style = VERDICT_STYLES[r.verdict]
              return (
                <div key={r.influencerId} className="flex items-center gap-3 rounded-lg border border-gray-100 dark:border-gray-800 p-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  {/* Avatar + info */}
                  <Avatar
                    name={r.displayName || r.username}
                    size="sm"
                    src={r.avatarUrl ? proxyImg(r.avatarUrl) : undefined}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-gray-900 dark:text-white truncate">@{r.username}</span>
                      <span className="text-[10px]">{PLATFORM_ICONS[r.platform] || '📱'}</span>
                    </div>
                    <p className="text-[10px] text-gray-400 truncate">{reasonFor(r)}</p>
                  </div>

                  {/* Key metric: Ratio EMV (EMV ÷ fees), shown as a multiple */}
                  <div className="text-right flex-shrink-0" title={es ? 'Ratio EMV: EMV generado ÷ fees pagados' : 'EMV ratio: EMV generated ÷ fees paid'}>
                    <div className="flex items-center justify-end gap-1">
                      {r.roiRatio >= 1.5 ? (
                        <TrendingUp className="h-3 w-3 text-emerald-500" />
                      ) : r.roiRatio < 0.8 ? (
                        <TrendingDown className="h-3 w-3 text-red-500" />
                      ) : (
                        <Minus className="h-3 w-3 text-gray-400" />
                      )}
                      <span className="text-xs font-bold tabular-nums text-gray-700 dark:text-gray-200">{formatRatio(r.roiRatio, { locale })}</span>
                    </div>
                    <span className="block text-[9px] uppercase tracking-wide text-gray-400">{es ? 'Ratio EMV' : 'EMV ratio'}</span>
                    <span className="block text-[9px] text-gray-400">{r.totalCampaigns} {es ? 'camp.' : 'camp.'}</span>
                  </div>

                  {/* Verdict badge */}
                  <span className={`flex-shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${style.bg} ${style.text}`}>
                    {verdictLabel[r.verdict]}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
