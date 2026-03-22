'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, TrendingUp, TrendingDown, RefreshCw, Zap, Target, AlertTriangle, BookOpen, ChevronRight, Repeat, XCircle } from 'lucide-react'

/**
 * Campaign Playbook™ Panel — Post-campaign intelligence.
 * Shows actionable insights about what to do NEXT.
 */

interface PlaybookData {
  campaignGrade: string
  roiRatio: number
  roiVerdict: string
  insights: Array<{
    type: 'success' | 'warning' | 'action' | 'insight' | 'info'
    icon: string
    text: string
  }>
  topPerformer: { username: string; reason: string } | null
  worstPerformer: { username: string; reason: string } | null
  repeatList: string[]
  skipList: string[]
  bestFormat: { format: string; reason: string } | null
  worstFormat: { format: string; reason: string } | null
  budgetAdvice: string
  nextCampaignRec: string
}

interface CampaignPlaybookPanelProps {
  campaignId: string
}

const GRADE_COLORS: Record<string, string> = {
  'A+': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  'A': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  'B+': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'B': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  'C': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  'D': 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  'F': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
}

const INSIGHT_STYLES: Record<string, { bg: string; border: string }> = {
  success: { bg: 'bg-emerald-50 dark:bg-emerald-900/10', border: 'border-emerald-200 dark:border-emerald-800' },
  warning: { bg: 'bg-amber-50 dark:bg-amber-900/10', border: 'border-amber-200 dark:border-amber-800' },
  action: { bg: 'bg-blue-50 dark:bg-blue-900/10', border: 'border-blue-200 dark:border-blue-800' },
  insight: { bg: 'bg-purple-50 dark:bg-purple-900/10', border: 'border-purple-200 dark:border-purple-800' },
  info: { bg: 'bg-gray-50 dark:bg-gray-800', border: 'border-gray-200 dark:border-gray-700' },
}

export function CampaignPlaybookPanel({ campaignId }: CampaignPlaybookPanelProps) {
  const [data, setData] = useState<PlaybookData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchPlaybook()
  }, [campaignId])

  async function fetchPlaybook() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'playbook', data: { campaignId } }),
      })
      if (!res.ok) throw new Error('Failed to generate playbook')
      const result = await res.json()
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error generating playbook')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
        <span className="ml-3 text-sm text-gray-500">Generating playbook...</span>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-12 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-gray-300" />
        <p className="mt-3 text-sm text-gray-500">{error || 'No data available'}</p>
        <button onClick={fetchPlaybook} className="mt-3 text-sm text-purple-600 hover:underline">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header: Grade + ROI */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className={`flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-black ${GRADE_COLORS[data.campaignGrade] || GRADE_COLORS['C']}`}>
            {data.campaignGrade}
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">Campaign Grade</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{data.roiVerdict} ({data.roiRatio}x ROI)</p>
          </div>
        </div>
      </div>

      {/* Key Insights */}
      {data.insights.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Zap className="h-4 w-4 text-purple-600" />
            Key Insights
          </h3>
          {data.insights.map((insight, i) => {
            const style = INSIGHT_STYLES[insight.type] || INSIGHT_STYLES.info
            return (
              <div key={i} className={`rounded-lg border ${style.border} ${style.bg} p-3`}>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  <span className="mr-2">{insight.icon}</span>
                  {insight.text}
                </p>
              </div>
            )
          })}
        </div>
      )}

      {/* Creators: Repeat vs Skip */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Repeat */}
        <Card variant="elevated">
          <CardContent>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-3">
              <Repeat className="h-4 w-4 text-emerald-600" />
              Repeat
            </h4>
            {data.repeatList.length > 0 ? (
              <div className="space-y-2">
                {data.repeatList.map(username => (
                  <div key={username} className="flex items-center gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">@{username}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">No standout performers to highlight</p>
            )}
            {data.topPerformer && (
              <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-2">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-semibold text-emerald-600">⭐ MVP:</span> @{data.topPerformer.username}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5">{data.topPerformer.reason}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Skip */}
        <Card variant="elevated">
          <CardContent>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-3">
              <XCircle className="h-4 w-4 text-red-500" />
              Skip Next Time
            </h4>
            {data.skipList.length > 0 ? (
              <div className="space-y-2">
                {data.skipList.map(username => (
                  <div key={username} className="flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    <span className="text-sm font-medium text-red-800 dark:text-red-300">@{username}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">No underperformers to flag</p>
            )}
            {data.worstPerformer && (
              <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-2">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  <span className="font-semibold text-red-500">⚠️ Lowest:</span> @{data.worstPerformer.username}
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5">{data.worstPerformer.reason}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Format Analysis */}
      {data.bestFormat && (
        <Card variant="elevated">
          <CardContent>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-3">
              <Target className="h-4 w-4 text-blue-600" />
              Format Performance
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3">
                <p className="text-xs font-semibold text-blue-700 dark:text-blue-300">🏆 Best: {data.bestFormat.format}</p>
                <p className="text-[11px] text-blue-600 dark:text-blue-400 mt-1">{data.bestFormat.reason}</p>
              </div>
              {data.worstFormat && (
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
                  <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">📉 Weakest: {data.worstFormat.format}</p>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{data.worstFormat.reason}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Budget & Next Campaign */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card variant="elevated">
          <CardContent>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-2">
              <TrendingUp className="h-4 w-4 text-purple-600" />
              Budget Advice
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{data.budgetAdvice}</p>
          </CardContent>
        </Card>

        <Card variant="elevated">
          <CardContent>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-2">
              <ChevronRight className="h-4 w-4 text-purple-600" />
              Next Campaign
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{data.nextCampaignRec}</p>
          </CardContent>
        </Card>
      </div>

      <div className="text-center">
        <p className="text-[10px] text-gray-400">Generated by TKOC Intelligence · Campaign Playbook™</p>
      </div>
    </div>
  )
}
