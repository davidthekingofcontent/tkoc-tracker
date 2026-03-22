'use client'

import { useState, useEffect } from 'react'
import { Repeat, TrendingUp, TrendingDown, Minus, Loader2, RefreshCw, ExternalLink } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Avatar } from '@/components/ui/avatar'
import { formatNumber } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'

/**
 * Repeat Radar™ Widget — Dashboard widget showing which influencers are worth repeating.
 * Fetches data from /api/intelligence (type: repeat-radar) and shows top results.
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
  totalCampaigns: number
  totalSpent: number
  totalEMV: number
  roiRatio: number
  avgCPM: number
  deliveryRate: number
  totalMedia: number
}

const VERDICT_STYLES = {
  repeat: { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300', label: 'Repeat', dot: 'bg-emerald-500' },
  consider: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-300', label: 'Consider', dot: 'bg-amber-500' },
  skip: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-300', label: 'Skip', dot: 'bg-red-500' },
}

const PLATFORM_ICONS: Record<string, string> = {
  INSTAGRAM: '📸',
  TIKTOK: '🎵',
  YOUTUBE: '▶️',
}

export function RepeatRadarWidget() {
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
            <button onClick={fetchRadar} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {!loading && results.length > 0 && (
          <div className="flex gap-3 mt-1">
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">{repeatCount} repeat</span>
            <span className="text-[10px] text-red-500 font-medium">{skipCount} skip</span>
            <span className="text-[10px] text-gray-400">{results.length} total</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
            <span className="ml-2 text-xs text-gray-500">Analyzing creators...</span>
          </div>
        ) : error ? (
          <div className="text-center py-6">
            <p className="text-xs text-gray-400">Could not load Repeat Radar</p>
            <button onClick={fetchRadar} className="mt-2 text-xs text-purple-600 hover:underline">Retry</button>
          </div>
        ) : topResults.length === 0 ? (
          <div className="text-center py-6">
            <Repeat className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="mt-2 text-xs text-gray-400">No campaign history yet. Data will appear once influencers have completed campaigns.</p>
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
                    <p className="text-[10px] text-gray-400 truncate">{r.reason}</p>
                  </div>

                  {/* Key metric */}
                  <div className="text-right flex-shrink-0">
                    <div className="flex items-center gap-1">
                      {r.roiRatio >= 1.5 ? (
                        <TrendingUp className="h-3 w-3 text-emerald-500" />
                      ) : r.roiRatio < 0.8 ? (
                        <TrendingDown className="h-3 w-3 text-red-500" />
                      ) : (
                        <Minus className="h-3 w-3 text-gray-400" />
                      )}
                      <span className="text-xs font-bold text-gray-700 dark:text-gray-200">{r.roiRatio}x</span>
                    </div>
                    <span className="text-[9px] text-gray-400">{r.totalCampaigns} camp.</span>
                  </div>

                  {/* Verdict badge */}
                  <span className={`flex-shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${style.bg} ${style.text}`}>
                    {style.label}
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
