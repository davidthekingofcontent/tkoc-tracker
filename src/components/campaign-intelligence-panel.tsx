'use client'

import { useMemo } from 'react'
import {
  analyzeCampaign,
  getSignalConfig,
  formatCurrency,
  formatKPI,
  CAMPAIGN_OBJECTIVES,
  type CampaignObjective,
  type Signal,
} from '@/lib/campaign-intelligence'
import { calculateEMV } from '@/lib/emv'

// ============ TYPES ============

interface CampaignIntelligencePanelProps {
  campaign: {
    id: string
    objective: string | null
    type: string
  }
  influencers: Array<{
    id: string
    agreedFee: number | null
    cost: number | null
    influencer: {
      id: string
      username: string
      platform: string
      followers: number
      engagementRate: number | null
      avgViews: number | null
    }
  }>
  media: Array<{
    likes?: number | null
    comments?: number | null
    shares?: number | null
    saves?: number | null
    views?: number | null
    reach?: number | null
    impressions?: number | null
    influencer?: {
      id: string
      username: string
      platform: string
    }
  }>
  overview: {
    emvExtended: number
    totalCost: number
  }
  locale: string
}

// ============ HELPERS ============

function t(locale: string, es: string, en: string): string {
  return locale === 'es' ? es : en
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014'
  return value.toLocaleString('es-ES')
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014'
  return `${value.toFixed(2)}%`
}

function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined) return '\u2014'
  return `${value.toFixed(1)}x`
}

function SignalDot({ signal, size = 'md' }: { signal: Signal; size?: 'sm' | 'md' | 'lg' }) {
  const config = getSignalConfig(signal)
  const sizeClasses = {
    sm: 'w-2.5 h-2.5',
    md: 'w-3.5 h-3.5',
    lg: 'w-5 h-5',
  }
  return (
    <span
      className={`inline-block rounded-full ${config.dot} ${sizeClasses[size]} flex-shrink-0`}
      aria-label={signal}
    />
  )
}

function PlatformBadge({ platform }: { platform: string }) {
  const label = platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase()
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
      {label}
    </span>
  )
}

// ============ COMPONENT ============

export function CampaignIntelligencePanel({
  campaign,
  influencers,
  media,
  overview,
  locale,
}: CampaignIntelligencePanelProps) {
  // Compute intelligence data
  const intelligence = useMemo(() => {
    if (!campaign.objective) return null

    const objective = campaign.objective as CampaignObjective

    // Group media by influencer
    const mediaByInfluencer = new Map<string, typeof media>()
    for (const m of media) {
      const id = m.influencer?.id
      if (!id) continue
      if (!mediaByInfluencer.has(id)) {
        mediaByInfluencer.set(id, [])
      }
      mediaByInfluencer.get(id)!.push(m)
    }

    // Build raw influencer data for the intelligence engine
    const rawInfluencers = influencers.map((ci) => {
      const inf = ci.influencer
      const influencerMedia = mediaByInfluencer.get(inf.id) || []

      // Calculate per-influencer EMV
      const emvResult = calculateEMV({
        platform: inf.platform,
        impressions: influencerMedia.reduce((s, m) => s + (m.impressions || 0), 0),
        reach: influencerMedia.reduce((s, m) => s + (m.reach || 0), 0),
        views: influencerMedia.reduce((s, m) => s + (m.views || 0), 0),
        clicks: 0,
        likes: influencerMedia.reduce((s, m) => s + (m.likes || 0), 0),
        comments: influencerMedia.reduce((s, m) => s + (m.comments || 0), 0),
        shares: influencerMedia.reduce((s, m) => s + (m.shares || 0), 0),
        saves: influencerMedia.reduce((s, m) => s + (m.saves || 0), 0),
      })

      const fee = ci.agreedFee ?? ci.cost ?? 0

      return {
        username: inf.username,
        platform: inf.platform,
        influencerId: inf.id,
        fee,
        media: influencerMedia.map((m) => ({
          likes: m.likes || 0,
          comments: m.comments || 0,
          shares: m.shares || 0,
          saves: m.saves || 0,
          views: m.views || 0,
          reach: m.reach || 0,
          impressions: m.impressions || 0,
          mediaType: 'post',
        })),
        emv: emvResult.extended,
      }
    })

    return analyzeCampaign({ objective, influencers: rawInfluencers })
  }, [campaign.objective, influencers, media])

  // No objective set
  if (!campaign.objective) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <div className="w-16 h-16 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center mb-4">
          <span className="text-3xl">🎯</span>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
          {t(locale, 'Objetivo no definido', 'Objective not set')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-md mb-6">
          {t(
            locale,
            'Establece un objetivo para esta campana para activar el analisis inteligente. El sistema evaluara el rendimiento de cada influencer segun el objetivo elegido.',
            'Set an objective for this campaign to activate intelligent analysis. The system will evaluate each influencer\'s performance based on the chosen objective.'
          )}
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          {CAMPAIGN_OBJECTIVES.map((obj) => (
            <span
              key={obj.value}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm text-gray-600 dark:text-gray-300"
            >
              <span>{obj.icon}</span>
              {locale === 'es' ? obj.labelEs : obj.labelEn}
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (!intelligence) return null

  const overallConfig = getSignalConfig(intelligence.overallSignal)
  const objectiveInfo = CAMPAIGN_OBJECTIVES.find((o) => o.value === intelligence.objective)

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className={`flex flex-wrap items-center gap-4 p-4 rounded-xl border ${overallConfig.border} ${overallConfig.bg} dark:bg-opacity-20`}>
        <SignalDot signal={intelligence.overallSignal} size="lg" />
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            {intelligence.overallScore}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400">/100</span>
          </span>
        </div>
        {objectiveInfo && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-sm font-medium text-purple-700 dark:text-purple-300">
            <span>{objectiveInfo.icon}</span>
            {locale === 'es' ? objectiveInfo.labelEs : objectiveInfo.labelEn}
          </span>
        )}
        <p className={`text-sm font-medium ${overallConfig.color} flex-1 min-w-[200px]`}>
          {intelligence.overallRecommendation}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label={t(locale, 'Inversion total', 'Total Investment')}
          value={formatCurrency(intelligence.totalInvestment)}
          icon="💶"
        />
        <SummaryCard
          label={t(locale, 'EMV total', 'Total EMV')}
          value={formatCurrency(intelligence.totalEMV)}
          icon="📈"
        />
        <SummaryCard
          label={t(locale, 'Ratio EMV/Coste', 'EMV/Cost Ratio')}
          value={formatRatio(intelligence.emvRatio)}
          icon="⚡"
          highlight={intelligence.emvRatio !== null && intelligence.emvRatio >= 2}
        />
        <SummaryCard
          label={t(locale, 'Puntuacion general', 'Overall Score')}
          value={`${intelligence.overallScore}/100`}
          icon="🎯"
          signal={intelligence.overallSignal}
        />
      </div>

      {/* Influencer performance table */}
      {intelligence.influencers.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t(locale, 'Influencer', 'Influencer')}
                  </th>
                  <th className="text-left px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t(locale, 'Plataforma', 'Platform')}
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    Fee
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    Views
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    CPM
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    CPE
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    Eng. Rate
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    EMV/Cost
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    Score
                  </th>
                  <th className="text-left px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t(locale, 'Recomendacion', 'Recommendation')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {intelligence.influencers.map((inf) => {
                  const signalConfig = getSignalConfig(inf.signal)
                  return (
                    <tr
                      key={inf.influencerId}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                    >
                      {/* Signal + Avatar + Username */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <SignalDot signal={inf.signal} size="sm" />
                          <div className="w-7 h-7 rounded-full bg-purple-200 dark:bg-purple-800 flex items-center justify-center text-xs font-bold text-purple-700 dark:text-purple-200 flex-shrink-0">
                            {inf.username.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-gray-900 dark:text-white truncate max-w-[140px]">
                            {inf.username}
                          </span>
                        </div>
                      </td>
                      {/* Platform */}
                      <td className="px-3 py-3">
                        <PlatformBadge platform={inf.platform} />
                      </td>
                      {/* Fee */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.fee > 0 ? formatCurrency(inf.fee) : '\u2014'}
                      </td>
                      {/* Views */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.totalViews > 0 ? formatNumber(inf.totalViews) : '\u2014'}
                      </td>
                      {/* CPM */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.cpm !== null ? formatCurrency(inf.cpm) : '\u2014'}
                      </td>
                      {/* CPE */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.cpe !== null ? formatCurrency(inf.cpe) : '\u2014'}
                      </td>
                      {/* Engagement Rate */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatPercent(inf.engagementRate)}
                      </td>
                      {/* EMV/Cost */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatRatio(inf.emvCostRatio)}
                      </td>
                      {/* Score */}
                      <td className="px-3 py-3 text-right font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                        {inf.score}
                        <span className="text-xs font-normal text-gray-400">/100</span>
                      </td>
                      {/* Recommendation */}
                      <td className="px-3 py-3 max-w-[220px]">
                        <span
                          className={`inline-block px-2 py-1 rounded-md text-xs font-medium truncate max-w-full ${signalConfig.bg} ${signalConfig.color} dark:bg-opacity-30`}
                          title={inf.recommendation}
                        >
                          {inf.recommendation}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty influencers state */}
      {intelligence.influencers.length === 0 && (
        <div className="text-center py-10 text-gray-500 dark:text-gray-400 text-sm">
          {t(
            locale,
            'No hay influencers en esta campana todavia.',
            'No influencers in this campaign yet.'
          )}
        </div>
      )}
    </div>
  )
}

// ============ SUB-COMPONENTS ============

function SummaryCard({
  label,
  value,
  icon,
  highlight,
  signal,
}: {
  label: string
  value: string
  icon: string
  highlight?: boolean
  signal?: Signal
}) {
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition-colors ${
        highlight
          ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          {label}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {signal && <SignalDot signal={signal} size="sm" />}
        <span className="text-xl font-bold text-gray-900 dark:text-white">{value}</span>
      </div>
    </div>
  )
}
