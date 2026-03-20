'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatNumber } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import {
  ArrowLeft,
  BarChart3,
  Plus,
  X,
  Loader2,
  TrendingUp,
  Users,
  Eye,
  Heart,
  DollarSign,
  Zap,
} from 'lucide-react'

interface Campaign {
  id: string
  name: string
  type: string
  status: string
  _count: { influencers: number; media: number }
}

interface ComparisonData {
  id: string
  name: string
  type: string
  status: string
  paymentType: string
  startDate: string | null
  endDate: string | null
  country: string | null
  influencerCount: number
  mediaCount: number
  totalReach: number
  totalImpressions: number
  totalEngagements: number
  engagementRate: number
  totalViews: number
  totalCost: number
  emvExtended: number
  roi: number | null
  platformBreakdown: Record<string, number>
  tierBreakdown: Record<string, number>
}

export default function CompareCampaignsPage() {
  const { locale } = useI18n()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [comparisonData, setComparisonData] = useState<ComparisonData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(true)

  useEffect(() => {
    fetch('/api/campaigns')
      .then(r => r.json())
      .then(d => setCampaigns(d.campaigns || []))
      .finally(() => setIsLoadingCampaigns(false))
  }, [])

  const loadComparison = useCallback(async () => {
    if (selectedIds.length < 2) return
    setIsLoading(true)
    try {
      const res = await fetch(`/api/campaigns/compare?ids=${selectedIds.join(',')}`)
      if (res.ok) {
        const data = await res.json()
        setComparisonData(data.campaigns || [])
      }
    } catch { /* ignore */ }
    setIsLoading(false)
  }, [selectedIds])

  const addCampaign = (id: string) => {
    if (selectedIds.length >= 3 || selectedIds.includes(id)) return
    setSelectedIds(prev => [...prev, id])
  }

  const removeCampaign = (id: string) => {
    setSelectedIds(prev => prev.filter(i => i !== id))
    setComparisonData(prev => prev.filter(c => c.id !== id))
  }

  const metrics = [
    { key: 'influencerCount', label: locale === 'es' ? 'Influencers' : 'Influencers', icon: Users, format: (v: number) => v.toString() },
    { key: 'mediaCount', label: locale === 'es' ? 'Publicaciones' : 'Posts', icon: BarChart3, format: (v: number) => v.toString() },
    { key: 'totalReach', label: locale === 'es' ? 'Alcance Total' : 'Total Reach', icon: Eye, format: formatNumber },
    { key: 'totalEngagements', label: locale === 'es' ? 'Engagements' : 'Engagements', icon: Heart, format: formatNumber },
    { key: 'engagementRate', label: locale === 'es' ? 'Tasa Engagement' : 'Engagement Rate', icon: TrendingUp, format: (v: number) => `${v.toFixed(2)}%` },
    { key: 'totalViews', label: locale === 'es' ? 'Vistas Totales' : 'Total Views', icon: Eye, format: formatNumber },
    { key: 'totalCost', label: locale === 'es' ? 'Coste Total' : 'Total Cost', icon: DollarSign, format: (v: number) => `€${v.toLocaleString()}` },
    { key: 'emvExtended', label: 'EMV', icon: Zap, format: (v: number) => `€${v.toLocaleString()}` },
    { key: 'roi', label: 'ROI', icon: TrendingUp, format: (v: number | null) => v !== null ? `${v.toFixed(1)}x` : '—' },
  ]

  const tierLabels: Record<string, string> = {
    nano: 'Nano (<10K)',
    micro: 'Micro (10-100K)',
    mid: 'Mid (100-500K)',
    macro: 'Macro (500K-1M)',
    mega: 'Mega (>1M)',
  }

  const colors = ['bg-purple-600', 'bg-cyan-500', 'bg-amber-500']
  const lightColors = ['bg-purple-50 border-purple-200 text-purple-700', 'bg-cyan-50 border-cyan-200 text-cyan-700', 'bg-amber-50 border-amber-200 text-amber-700']

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/campaigns">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
            {locale === 'es' ? 'Volver' : 'Back'}
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {locale === 'es' ? 'Comparar Campañas' : 'Compare Campaigns'}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {locale === 'es' ? 'Selecciona 2 o 3 campañas para comparar métricas lado a lado' : 'Select 2 or 3 campaigns to compare metrics side by side'}
          </p>
        </div>
      </div>

      {/* Campaign Selector */}
      <Card variant="elevated">
        <CardContent>
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            {locale === 'es' ? 'Campañas seleccionadas' : 'Selected Campaigns'} ({selectedIds.length}/3)
          </h3>
          <div className="flex flex-wrap gap-2 mb-4">
            {selectedIds.map((id, i) => {
              const c = campaigns.find(c => c.id === id)
              return (
                <span key={id} className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium ${lightColors[i]}`}>
                  <span className={`h-2 w-2 rounded-full ${colors[i]}`} />
                  {c?.name || id}
                  <button onClick={() => removeCampaign(id)} className="hover:opacity-70">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            })}
            {selectedIds.length < 3 && (
              <select
                onChange={(e) => { addCampaign(e.target.value); e.target.value = '' }}
                defaultValue=""
                className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-500 outline-none focus:border-purple-500"
              >
                <option value="" disabled>{locale === 'es' ? '+ Añadir campaña...' : '+ Add campaign...'}</option>
                {campaigns
                  .filter(c => !selectedIds.includes(c.id))
                  .map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c._count.influencers} inf.)</option>
                  ))}
              </select>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={loadComparison}
            disabled={selectedIds.length < 2 || isLoading}
          >
            {isLoading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> {locale === 'es' ? 'Comparando...' : 'Comparing...'}</>
            ) : (
              <><BarChart3 className="h-4 w-4" /> {locale === 'es' ? 'Comparar' : 'Compare'}</>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Comparison Results */}
      {comparisonData.length >= 2 && (
        <div className="space-y-6">
          {/* Metrics Table */}
          <Card variant="elevated">
            <CardContent>
              <h3 className="mb-4 text-base font-semibold text-gray-900">
                {locale === 'es' ? 'Métricas Comparadas' : 'Compared Metrics'}
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="pb-3 text-left text-xs font-medium uppercase tracking-wider text-gray-400 w-48">
                        {locale === 'es' ? 'Métrica' : 'Metric'}
                      </th>
                      {comparisonData.map((c, i) => (
                        <th key={c.id} className="pb-3 text-center text-xs font-medium uppercase tracking-wider text-gray-400">
                          <div className="flex items-center justify-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${colors[i]}`} />
                            <span className="truncate max-w-[150px]">{c.name}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(({ key, label, icon: Icon, format }) => {
                      const values = comparisonData.map(c => (c as unknown as Record<string, number>)[key])
                      const maxVal = Math.max(...values.filter(v => v !== null && v !== undefined))
                      return (
                        <tr key={key} className="border-b border-gray-100 last:border-0">
                          <td className="py-3 text-sm text-gray-600">
                            <div className="flex items-center gap-2">
                              <Icon className="h-4 w-4 text-gray-400" />
                              {label}
                            </div>
                          </td>
                          {comparisonData.map((c, i) => {
                            const val = (c as unknown as Record<string, number>)[key]
                            const isMax = val === maxVal && val > 0 && key !== 'totalCost'
                            const isMinCost = key === 'totalCost' && val > 0 && val === Math.min(...values.filter(v => v > 0))
                            return (
                              <td key={c.id} className="py-3 text-center">
                                <span className={`text-sm font-bold ${
                                  isMax || isMinCost ? 'text-green-600' : 'text-gray-900'
                                }`}>
                                  {format(val)}
                                  {(isMax || isMinCost) && ' ★'}
                                </span>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Visual Bars */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Reach Comparison */}
            <Card variant="elevated">
              <CardContent>
                <h4 className="mb-4 text-sm font-semibold text-gray-700">
                  {locale === 'es' ? 'Alcance' : 'Reach'}
                </h4>
                <div className="space-y-3">
                  {comparisonData.map((c, i) => {
                    const maxReach = Math.max(...comparisonData.map(d => d.totalReach))
                    const pct = maxReach > 0 ? (c.totalReach / maxReach) * 100 : 0
                    return (
                      <div key={c.id}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-600 truncate max-w-[150px]">{c.name}</span>
                          <span className="text-xs font-bold text-gray-900">{formatNumber(c.totalReach)}</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-100">
                          <div className={`h-3 rounded-full ${colors[i]} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* ROI Comparison */}
            <Card variant="elevated">
              <CardContent>
                <h4 className="mb-4 text-sm font-semibold text-gray-700">ROI (EMV / Cost)</h4>
                <div className="space-y-3">
                  {comparisonData.map((c, i) => {
                    const maxRoi = Math.max(...comparisonData.map(d => d.roi || 0))
                    const pct = maxRoi > 0 && c.roi ? (c.roi / maxRoi) * 100 : 0
                    return (
                      <div key={c.id}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-600 truncate max-w-[150px]">{c.name}</span>
                          <span className="text-xs font-bold text-gray-900">
                            {c.roi !== null ? `${c.roi.toFixed(1)}x` : '—'}
                          </span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-100">
                          <div className={`h-3 rounded-full ${colors[i]} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Tier Breakdown */}
            <Card variant="elevated">
              <CardContent>
                <h4 className="mb-4 text-sm font-semibold text-gray-700">
                  {locale === 'es' ? 'Tiers de Influencers' : 'Influencer Tiers'}
                </h4>
                <div className="space-y-2">
                  {Object.entries(tierLabels).map(([tier, label]) => (
                    <div key={tier} className="flex items-center gap-3">
                      <span className="w-32 text-xs text-gray-500">{label}</span>
                      {comparisonData.map((c, i) => (
                        <span key={c.id} className={`rounded-full px-2 py-0.5 text-xs font-medium ${lightColors[i]} border`}>
                          {c.tierBreakdown?.[tier] || 0}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Engagement Rate */}
            <Card variant="elevated">
              <CardContent>
                <h4 className="mb-4 text-sm font-semibold text-gray-700">
                  {locale === 'es' ? 'Engagement Rate' : 'Engagement Rate'}
                </h4>
                <div className="space-y-3">
                  {comparisonData.map((c, i) => {
                    const maxEng = Math.max(...comparisonData.map(d => d.engagementRate))
                    const pct = maxEng > 0 ? (c.engagementRate / maxEng) * 100 : 0
                    return (
                      <div key={c.id}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-600 truncate max-w-[150px]">{c.name}</span>
                          <span className="text-xs font-bold text-gray-900">{c.engagementRate.toFixed(2)}%</span>
                        </div>
                        <div className="h-3 w-full rounded-full bg-gray-100">
                          <div className={`h-3 rounded-full ${colors[i]} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Empty state */}
      {comparisonData.length === 0 && !isLoading && (
        <div className="py-16 text-center">
          <BarChart3 className="mx-auto h-12 w-12 text-gray-300" />
          <h3 className="mt-4 text-lg font-semibold text-gray-700">
            {locale === 'es' ? 'Selecciona campañas para comparar' : 'Select campaigns to compare'}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
            {locale === 'es'
              ? 'Elige 2 o 3 campañas del selector de arriba y pulsa "Comparar" para ver las métricas lado a lado.'
              : 'Choose 2 or 3 campaigns from the selector above and click "Compare" to see metrics side by side.'}
          </p>
        </div>
      )}
    </div>
  )
}
