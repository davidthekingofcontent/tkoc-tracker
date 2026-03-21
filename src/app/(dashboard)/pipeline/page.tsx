'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { formatNumber } from '@/lib/utils'
import {
  Loader2,
  Users,
  ChevronDown,
  ArrowRight,
} from 'lucide-react'

interface PipelineItem {
  id: string
  status: string
  cost: number | null
  notes: string | null
  createdAt: string
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
    engagementRate: number
    avgViews: number
  }
  campaign: {
    id: string
    name: string
    status: string
  }
}

interface CampaignOption {
  id: string
  name: string
}

const STATUSES = ['PROSPECT', 'OUTREACH', 'NEGOTIATING', 'AGREED', 'CONTRACTED', 'POSTED', 'COMPLETED'] as const

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  PROSPECT: { bg: 'bg-gray-50 dark:bg-gray-800', border: 'border-gray-200 dark:border-gray-600', text: 'text-gray-700 dark:text-gray-300', dot: 'bg-gray-400' },
  OUTREACH: { bg: 'bg-blue-50 dark:bg-blue-900/30', border: 'border-blue-200 dark:border-blue-800', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  NEGOTIATING: { bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
  AGREED: { bg: 'bg-purple-50 dark:bg-purple-900/30', border: 'border-purple-200 dark:border-purple-800', text: 'text-purple-700 dark:text-purple-300', dot: 'bg-purple-500' },
  CONTRACTED: { bg: 'bg-indigo-50 dark:bg-indigo-900/30', border: 'border-indigo-200 dark:border-indigo-800', text: 'text-indigo-700 dark:text-indigo-300', dot: 'bg-indigo-500' },
  POSTED: { bg: 'bg-cyan-50 dark:bg-cyan-900/30', border: 'border-cyan-200 dark:border-cyan-800', text: 'text-cyan-700 dark:text-cyan-300', dot: 'bg-cyan-500' },
  COMPLETED: { bg: 'bg-green-50 dark:bg-green-900/30', border: 'border-green-200 dark:border-green-800', text: 'text-green-700 dark:text-green-300', dot: 'bg-green-500' },
}

export default function PipelinePage() {
  const { t, locale } = useI18n()
  const [items, setItems] = useState<PipelineItem[]>([])
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [showMoveMenu, setShowMoveMenu] = useState<string | null>(null)

  const statusLabels: Record<string, string> = {
    PROSPECT: t.pipeline?.prospect || 'Prospect',
    OUTREACH: t.pipeline?.outreach || 'Outreach',
    NEGOTIATING: t.pipeline?.negotiating || 'Negotiating',
    AGREED: t.pipeline?.agreed || 'Agreed',
    CONTRACTED: t.pipeline?.contracted || 'Contracted',
    SHIPPING: locale === 'es' ? 'Envío' : 'Shipping',
    POSTED: t.pipeline?.posted || 'Posted',
    COMPLETED: t.pipeline?.completed || 'Completed',
  }

  useEffect(() => {
    fetchPipeline()
    fetchCampaigns()
  }, [selectedCampaign])

  async function fetchPipeline() {
    setIsLoading(true)
    try {
      const url = selectedCampaign
        ? `/api/pipeline?campaignId=${selectedCampaign}`
        : '/api/pipeline'
      const res = await fetch(url)
      if (res.ok) {
        const data = await res.json()
        setItems(data.items || [])
      }
    } catch { /* ignore */ }
    setIsLoading(false)
  }

  async function fetchCampaigns() {
    try {
      const res = await fetch('/api/campaigns')
      if (res.ok) {
        const data = await res.json()
        setCampaigns((data.campaigns || []).map((c: CampaignOption) => ({ id: c.id, name: c.name })))
      }
    } catch { /* ignore */ }
  }

  async function moveItem(itemId: string, newStatus: string) {
    setMovingId(itemId)
    setShowMoveMenu(null)
    try {
      const res = await fetch(`/api/pipeline/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (res.ok) {
        setItems(prev => prev.map(item =>
          item.id === itemId ? { ...item, status: newStatus } : item
        ))
      }
    } catch { /* ignore */ }
    setMovingId(null)
  }

  const grouped = STATUSES.reduce((acc, status) => {
    acc[status] = items.filter(item => item.status === status)
    return acc
  }, {} as Record<string, PipelineItem[]>)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.pipeline?.title || 'Pipeline'}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t.pipeline?.subtitle || 'Track influencer journey from discovery to completion'}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">{t.pipeline?.totalInPipeline || 'Total'}: <strong className="text-purple-600 dark:text-purple-400">{items.length}</strong></span>
          <select
            value={selectedCampaign}
            onChange={(e) => setSelectedCampaign(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 bg-white dark:bg-gray-800"
          >
            <option value="">{t.pipeline?.allCampaigns || 'All campaigns'}</option>
            {campaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
          <span className="ml-3 text-gray-500">{t.common.loading}</span>
        </div>
      ) : (
        /* Kanban Board */
        <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: '60vh' }}>
          {STATUSES.map(status => {
            const colors = STATUS_COLORS[status]
            const statusItems = grouped[status] || []

            return (
              <div key={status} className="flex-shrink-0 w-[260px]">
                {/* Column Header */}
                <div className={`rounded-t-xl ${colors.bg} ${colors.border} border-b-2 px-4 py-3`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${colors.dot}`} />
                      <span className={`text-sm font-semibold ${colors.text}`}>
                        {statusLabels[status]}
                      </span>
                    </div>
                    <span className={`rounded-full ${colors.bg} px-2 py-0.5 text-xs font-bold ${colors.text}`}>
                      {statusItems.length}
                    </span>
                  </div>
                </div>

                {/* Column Body */}
                <div className="space-y-3 rounded-b-xl border border-t-0 border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 p-3 min-h-[200px]">
                  {statusItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center">
                      <Users className="h-6 w-6 text-gray-300 mb-2" />
                      <p className="text-xs text-gray-400">{t.pipeline?.noInfluencers || 'No influencers'}</p>
                    </div>
                  ) : (
                    statusItems.map(item => (
                      <div
                        key={item.id}
                        className="relative rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm hover:shadow-md transition-shadow"
                      >
                        {/* Loading overlay */}
                        {movingId === item.id && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/80 z-10">
                            <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                          </div>
                        )}

                        {/* Profile */}
                        <div className="flex items-center gap-3">
                          <Avatar name={item.influencer.displayName || item.influencer.username} size="sm" src={item.influencer.avatarUrl || undefined} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {item.influencer.displayName || item.influencer.username}
                            </p>
                            <p className="truncate text-xs text-gray-500 dark:text-gray-400">@{item.influencer.username}</p>
                          </div>
                        </div>

                        {/* Stats */}
                        <div className="mt-3 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                          <span>{formatNumber(item.influencer.followers)}</span>
                          <span className="text-purple-600 font-medium">{item.influencer.engagementRate}%</span>
                          {item.cost ? <span className="font-medium text-gray-900">{'\u20AC'}{item.cost}</span> : null}
                        </div>

                        {/* Campaign name */}
                        <p className="mt-2 truncate text-[10px] text-gray-400">{item.campaign.name}</p>

                        {/* Move button */}
                        <div className="relative mt-3">
                          <button
                            onClick={() => setShowMoveMenu(showMoveMenu === item.id ? null : item.id)}
                            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                          >
                            <ArrowRight className="h-3 w-3" />
                            {t.pipeline?.moveTo || 'Move to'}
                            <ChevronDown className="h-3 w-3" />
                          </button>

                          {/* Move menu dropdown */}
                          {showMoveMenu === item.id && (
                            <div className="absolute bottom-full left-0 mb-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg z-20">
                              {STATUSES.filter(s => s !== status).map(s => {
                                const sc = STATUS_COLORS[s]
                                return (
                                  <button
                                    key={s}
                                    onClick={() => moveItem(item.id, s)}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 first:rounded-t-lg last:rounded-b-lg"
                                  >
                                    <span className={`h-2 w-2 rounded-full ${sc.dot}`} />
                                    {statusLabels[s]}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
