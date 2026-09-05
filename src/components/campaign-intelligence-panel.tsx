'use client'

import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  analyzeCampaign,
  getSignalConfig,
  CAMPAIGN_OBJECTIVES,
  type CampaignObjective,
  type RawInfluencerData,
  type Signal,
} from '@/lib/campaign-intelligence'
import { calculateCampaignEMV } from '@/lib/emv'
import type { PerInfluencerMetrics } from '@/lib/metrics'
import { formatEur, formatNumber, formatPercent, formatRatio, type EurLocale } from '@/lib/utils'
import { useIntelligenceText } from '@/components/creator-score-badge'

/**
 * Campaign Intelligence panel (Aprender tab).
 *
 * Figures: each creator is scored from the campaign overview's PerInfluencerMetrics
 * (`perInfluencer` prop — views, audience, interacciones, ER, CPM, cost, EMV over
 * ALL media with the brand's rates), so this table can never disagree with the
 * Resumen / Elegir cards on the same page. The paginated `media` slice is only a
 * fallback for creators the overview does not carry (or when it is null).
 *
 * Formatting: every figure goes through src/lib/utils with the UI locale
 * (formatEur / formatPercent / formatRatio / formatNumber). Recommendation texts
 * come as keys resolved in translations.*.intelligence; the engine's Spanish
 * string is the fallback.
 */

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
  /** Fallback only: the media slice the page holds (used when a creator has no overview row). */
  media: Array<{
    likes?: number | null
    comments?: number | null
    shares?: number | null
    saves?: number | null
    views?: number | null
    reach?: number | null
    impressions?: number | null
    mediaType?: string | null
    postedAt?: string | Date | null
    influencer?: {
      id: string
      username: string
      platform: string
      followers?: number | null
    }
  }>
  overview: {
    emvExtended: number
    totalCost: number
  }
  /**
   * Per-creator figures from the single campaign overview (GET /api/campaigns/[id]).
   * Authoritative for everything the engine scores: views, audience (the CPM/ER
   * base), interacciones, ER, CPM, cost and EMV. Null while the overview loads.
   */
  perInfluencer?: PerInfluencerMetrics[] | null
  locale: EurLocale
  /**
   * When provided (ADMIN/EMPLOYEE), the "objective not set" state turns the
   * objective chips into buttons that persist the choice. BRAND users never
   * get this prop, so for them the chips stay read-only.
   */
  onSetObjective?: (value: string) => Promise<void>
}

// ============ HELPERS ============

function t(locale: string, es: string, en: string): string {
  return locale === 'es' ? es : en
}

const DASH = '—'

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
  perInfluencer,
  locale,
  onSetObjective,
}: CampaignIntelligencePanelProps) {
  const text = useIntelligenceText()
  const perInfluencerById = useMemo(() => new Map((perInfluencer ?? []).map(p => [p.influencerId, p])), [perInfluencer])
  // Which objective chip is being persisted right now (empty state only)
  const [settingObjective, setSettingObjective] = useState<string | null>(null)

  // Money with two decimals (CPM / CPE / fees) in the UI locale
  const eur = (value: number) => formatEur(value, { locale, maxFractionDigits: 2 })

  // Compute intelligence data
  const intelligence = useMemo(() => {
    if (!campaign.objective) return null

    const objective = campaign.objective as CampaignObjective

    // Fallback path only: the media slice grouped by creator (used for members
    // the overview has no row for — typically while it is still loading)
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
    const rawInfluencers: RawInfluencerData[] = influencers.map((ci) => {
      const inf = ci.influencer
      const authoritative = perInfluencerById.get(inf.id)

      if (authoritative) {
        // The overview's figures, verbatim (decisions 3A / 4C / 5 / 6 already applied)
        return {
          username: inf.username,
          platform: inf.platform,
          influencerId: inf.id,
          fee: authoritative.cost,
          emv: authoritative.emvExtended,
          totals: {
            views: authoritative.views,
            audience: authoritative.audience.total,
            engagements: authoritative.engagements,
            pieces: authoritative.media,
            fee: authoritative.cost,
            emv: authoritative.emvExtended,
            er: authoritative.er.value,
            cpm: authoritative.cpm,
          },
        }
      }

      // Fallback (no overview row for this creator): the page's media slice with
      // default EMV rates. Only shown until the overview arrives.
      const influencerMedia = mediaByInfluencer.get(inf.id) || []
      const emvResult = calculateCampaignEMV(influencerMedia.map(m => ({
        platform: inf.platform,
        impressions: m.impressions || 0,
        reach: m.reach || 0,
        views: m.views || 0,
        likes: m.likes || 0,
        comments: m.comments || 0,
        shares: m.shares || 0,
        saves: m.saves || 0,
        mediaType: m.mediaType ?? null,
        postedAt: m.postedAt ?? null,
        influencerId: inf.id,
        followers: inf.followers,
      })))
      // Cost rule (decision 6): fee acordado, si no coste
      const fee = (ci.agreedFee && ci.agreedFee > 0) ? ci.agreedFee : (ci.cost ?? 0)

      return {
        username: inf.username,
        platform: inf.platform,
        influencerId: inf.id,
        fee,
        emv: emvResult.extended,
        media: influencerMedia.map((m) => ({
          likes: m.likes || 0,
          comments: m.comments || 0,
          shares: m.shares || 0,
          saves: m.saves || 0,
          views: m.views || 0,
          reach: m.reach || 0,
          impressions: m.impressions || 0,
          mediaType: m.mediaType ?? null,
        })),
      }
    })

    return analyzeCampaign({ objective, influencers: rawInfluencers })
  }, [campaign.objective, influencers, media, perInfluencerById])

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
            'Establece un objetivo para esta campaña para activar el análisis inteligente. El sistema evaluará el rendimiento de cada influencer según el objetivo elegido.',
            'Set an objective for this campaign to activate intelligent analysis. The system will evaluate each influencer\'s performance based on the chosen objective.'
          )}
          {onSetObjective && (
            <>
              {' '}
              <span className="font-medium text-gray-700 dark:text-gray-200">
                {t(locale, 'Elige uno para activarlo ahora:', 'Pick one to activate it now:')}
              </span>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2 justify-center">
          {CAMPAIGN_OBJECTIVES.map((obj) =>
            onSetObjective ? (
              // Editors: one click persists the objective (PUT) and the page refetches.
              <button
                key={obj.value}
                type="button"
                disabled={settingObjective !== null}
                onClick={async () => {
                  setSettingObjective(obj.value)
                  try {
                    await onSetObjective(obj.value)
                  } finally {
                    setSettingObjective(null)
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-200 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:text-purple-700 dark:hover:text-purple-300 disabled:opacity-60 disabled:cursor-wait transition-colors"
              >
                {settingObjective === obj.value ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span>{obj.icon}</span>
                )}
                {locale === 'es' ? obj.labelEs : obj.labelEn}
              </button>
            ) : (
              <span
                key={obj.value}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-sm text-gray-600 dark:text-gray-300"
              >
                <span>{obj.icon}</span>
                {locale === 'es' ? obj.labelEs : obj.labelEn}
              </span>
            )
          )}
        </div>
      </div>
    )
  }

  if (!intelligence) return null

  const overallConfig = getSignalConfig(intelligence.overallSignal)
  const objectiveInfo = CAMPAIGN_OBJECTIVES.find((o) => o.value === intelligence.objective)
  const overallText = text(intelligence.overallRecommendationKey, undefined, intelligence.overallRecommendation)

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className={`flex flex-wrap items-center gap-4 p-4 rounded-xl border ${overallConfig.border} ${overallConfig.bg} dark:bg-opacity-20`}>
        <SignalDot signal={intelligence.overallSignal} size="lg" />
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-gray-900 dark:text-white">
            {intelligence.overallSignal === 'gray' ? (
              <span className="text-gray-400">{DASH}</span>
            ) : (
              <>
                {intelligence.overallScore}
                <span className="text-sm font-normal text-gray-500 dark:text-gray-400">/100</span>
              </>
            )}
          </span>
        </div>
        {objectiveInfo && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-sm font-medium text-purple-700 dark:text-purple-300">
            <span>{objectiveInfo.icon}</span>
            {locale === 'es' ? objectiveInfo.labelEs : objectiveInfo.labelEn}
          </span>
        )}
        <p className={`text-sm font-medium ${overallConfig.color} flex-1 min-w-[200px]`}>
          {overallText}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label={t(locale, 'Inversión total', 'Total Investment')}
          value={eur(intelligence.totalInvestment)}
          icon="💶"
        />
        <SummaryCard
          label={t(locale, 'EMV total', 'Total EMV')}
          value={eur(intelligence.totalEMV)}
          icon="📈"
        />
        <SummaryCard
          label={t(locale, 'Ratio EMV', 'EMV Ratio')}
          value={intelligence.emvRatio !== null ? formatRatio(intelligence.emvRatio, { locale }) : DASH}
          icon="⚡"
          highlight={intelligence.emvRatio !== null && intelligence.emvRatio >= 2}
        />
        <SummaryCard
          label={t(locale, 'Puntuación general', 'Overall Score')}
          value={intelligence.overallSignal === 'gray' ? DASH : `${intelligence.overallScore}/100`}
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
                    {t(locale, 'Ratio EMV', 'EMV Ratio')}
                  </th>
                  <th className="text-right px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    Score
                  </th>
                  <th className="text-left px-3 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {t(locale, 'Recomendación', 'Recommendation')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {intelligence.influencers.map((inf) => {
                  const signalConfig = getSignalConfig(inf.signal)
                  const recommendation = text(inf.recommendationKey, undefined, inf.recommendation)
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
                        {inf.fee > 0 ? eur(inf.fee) : DASH}
                      </td>
                      {/* Views */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.totalViews > 0 ? formatNumber(inf.totalViews, { locale }) : DASH}
                      </td>
                      {/* CPM */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.cpm !== null ? eur(inf.cpm) : DASH}
                      </td>
                      {/* CPE */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.cpe !== null ? eur(inf.cpe) : DASH}
                      </td>
                      {/* Engagement Rate */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {formatPercent(inf.engagementRate, { locale })}
                      </td>
                      {/* Ratio EMV */}
                      <td className="px-3 py-3 text-right text-gray-700 dark:text-gray-300 whitespace-nowrap">
                        {inf.emvCostRatio !== null ? formatRatio(inf.emvCostRatio, { locale }) : DASH}
                      </td>
                      {/* Score — unscored creators (gray signal) show a dash, not a misleading number */}
                      <td className="px-3 py-3 text-right font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                        {inf.signal === 'gray' ? (
                          <span className="text-gray-400 font-normal">{DASH}</span>
                        ) : (
                          <>
                            {inf.score}
                            <span className="text-xs font-normal text-gray-400">/100</span>
                          </>
                        )}
                      </td>
                      {/* Recommendation (translations.*.intelligence, Spanish fallback) */}
                      <td className="px-3 py-3 max-w-[220px]">
                        <span
                          className={`inline-block px-2 py-1 rounded-md text-xs font-medium truncate max-w-full ${signalConfig.bg} ${signalConfig.color} dark:bg-opacity-30`}
                          title={recommendation}
                        >
                          {recommendation}
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
            'No hay influencers en esta campaña todavía.',
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
