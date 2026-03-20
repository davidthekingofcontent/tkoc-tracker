'use client'

import { useState } from 'react'
import { History, Loader2, X, Star, TrendingUp, Shield, Zap, Award } from 'lucide-react'
import { formatNumber } from '@/lib/utils'

interface PriceEntry {
  campaignId: string
  campaignName: string
  campaignType: string
  agreedFee: number | null
  cost: number | null
  status: string
  startDate: string | null
  endDate: string | null
  mediaValue: number
}

interface Score {
  total: number
  engagement: number
  reliability: number
  roi: number
  consistency: number
}

interface InfluencerHistoryProps {
  influencerId: string
  influencerName: string
  locale: string
}

export function InfluencerHistoryButton({ influencerId, influencerName, locale }: InfluencerHistoryProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [priceHistory, setPriceHistory] = useState<PriceEntry[]>([])
  const [score, setScore] = useState<Score | null>(null)

  async function loadHistory() {
    if (isOpen) {
      setIsOpen(false)
      return
    }
    setIsOpen(true)
    setIsLoading(true)
    try {
      const res = await fetch(`/api/influencers/${influencerId}/history`)
      if (res.ok) {
        const data = await res.json()
        setPriceHistory(data.priceHistory || [])
        setScore(data.score || null)
      }
    } catch { /* ignore */ }
    setIsLoading(false)
  }

  const scoreColor = (val: number) => {
    if (val >= 75) return 'text-green-600'
    if (val >= 50) return 'text-amber-600'
    return 'text-red-600'
  }

  const scoreBg = (val: number) => {
    if (val >= 75) return 'bg-green-50 border-green-200'
    if (val >= 50) return 'bg-amber-50 border-amber-200'
    return 'bg-red-50 border-red-200'
  }

  return (
    <div className="relative">
      <button
        onClick={loadHistory}
        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-all ${
          isOpen
            ? 'border-amber-300 bg-amber-50 text-amber-700'
            : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-700'
        }`}
        title={locale === 'es' ? 'Historial y puntuación' : 'History & score'}
      >
        <History className="h-3 w-3" />
        {locale === 'es' ? 'Historial' : 'History'}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-8 z-30 w-96 rounded-xl border border-gray-200 bg-white shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <span className="text-sm font-semibold text-gray-900">
                {influencerName}
              </span>
              <p className="text-[10px] text-gray-400">
                {locale === 'es' ? 'Historial de campañas y puntuación' : 'Campaign history & score'}
              </p>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-gray-600">
              <X className="h-4 w-4" />
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          ) : (
            <>
              {/* Score Card */}
              {score && (
                <div className="px-4 py-3 border-b border-gray-100">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`flex h-12 w-12 items-center justify-center rounded-xl border-2 ${scoreBg(score.total)}`}>
                      <span className={`text-lg font-bold ${scoreColor(score.total)}`}>{score.total}</span>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-700">
                        <Award className="inline h-3 w-3 mr-1" />
                        {locale === 'es' ? 'Puntuación Global' : 'Overall Score'}
                      </p>
                      <p className="text-[10px] text-gray-400">
                        {score.total >= 75 ? (locale === 'es' ? 'Excelente' : 'Excellent') :
                         score.total >= 50 ? (locale === 'es' ? 'Bueno' : 'Good') :
                         (locale === 'es' ? 'Mejorable' : 'Needs improvement')}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: 'Engagement', value: score.engagement, icon: TrendingUp },
                      { label: locale === 'es' ? 'Fiabilidad' : 'Reliability', value: score.reliability, icon: Shield },
                      { label: 'ROI', value: score.roi, icon: Zap },
                      { label: locale === 'es' ? 'Consistencia' : 'Consistency', value: score.consistency, icon: Star },
                    ].map(({ label, value, icon: Icon }) => (
                      <div key={label} className="text-center">
                        <Icon className={`mx-auto h-3 w-3 mb-0.5 ${scoreColor(value)}`} />
                        <p className={`text-sm font-bold ${scoreColor(value)}`}>{value}</p>
                        <p className="text-[9px] text-gray-400">{label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Price History */}
              <div className="max-h-60 overflow-y-auto">
                {priceHistory.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-400">
                    {locale === 'es' ? 'Sin historial de campañas' : 'No campaign history'}
                  </p>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {priceHistory.map((entry) => (
                      <div key={entry.campaignId} className="px-4 py-2.5 hover:bg-gray-50">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-gray-900 truncate max-w-[180px]">
                            {entry.campaignName}
                          </span>
                          <span className={`text-xs font-bold ${
                            (entry.agreedFee || entry.cost) ? 'text-gray-900' : 'text-gray-400'
                          }`}>
                            {(entry.agreedFee || entry.cost) ? `€${(entry.agreedFee || entry.cost)!.toLocaleString()}` : '—'}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-400">
                          <span className="uppercase">{entry.campaignType}</span>
                          <span>&middot;</span>
                          <span className={
                            entry.status === 'COMPLETED' ? 'text-green-500' :
                            entry.status === 'POSTED' ? 'text-cyan-500' :
                            'text-gray-400'
                          }>{entry.status}</span>
                          {entry.mediaValue > 0 && (
                            <>
                              <span>&middot;</span>
                              <span className="text-green-500">EMV: €{formatNumber(Math.round(entry.mediaValue))}</span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
