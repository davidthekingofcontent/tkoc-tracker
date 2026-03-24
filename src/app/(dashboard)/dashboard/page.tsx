"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { cn, formatNumber } from "@/lib/utils"
import { useI18n } from '@/i18n/context'
import { Avatar } from '@/components/ui/avatar'
import { useRole } from '@/hooks/use-role'
import { CreatorScoreBadge } from '@/components/creator-score-badge'
import { getQuickBenchmark } from '@/lib/market-benchmark-client'
import { calculateCreatorScore } from '@/lib/creator-score'
import {
  Megaphone,
  UserSearch,
  Users,
  ListChecks,
  TrendingUp,
  Eye,
  BarChart3,
  Activity,
  ArrowUpRight,
  DollarSign,
  Heart,
  MessageCircle,
  Play,
  Image,
  Instagram,
  Youtube,
  Loader2,
  Zap,
  Target,
  Settings,
  BookOpen,
  Package,
  CheckCircle2,
  Truck,
  Clock,
  Sparkles,
  Star,
  Link2,
  ExternalLink,
  User,
} from "lucide-react"
import { RepeatRadarWidget } from '@/components/dashboard/repeat-radar-widget'
import { CampaignWizard } from '@/components/campaign-wizard'

// ============ SHARED TYPES ============

interface DashboardStats {
  activeCampaigns: number
  totalCampaigns: number
  totalInfluencers: number
  totalReach: number
  avgEngagementRate: number
  totalInvestment: number
  totalEMV: { basic: number; extended: number }
  totalMediaPosts: number
  totalViews: number
  totalLikes: number
  totalComments: number
}

interface RecentCampaign {
  id: string
  name: string
  status: string
  type: string
  objective: string | null
  _count: { influencers: number; media: number }
}

interface TopInfluencer {
  username: string
  platform: string
  followers: number
  engagementRate: number | null
  avatarUrl: string | null
  totalLikes: number
  totalComments: number
  totalViews: number
}

interface RecentMediaItem {
  influencerUsername: string
  platform: string
  likes: number
  comments: number
  views: number
  postedAt: string | null
  campaignName: string
  permalink: string | null
}

interface PlatformBreakdown {
  platform: string
  influencers: number
  media: number
}

interface CampaignsByStatus {
  active: number
  paused: number
  archived: number
}

// ============ CREATOR DASHBOARD TYPES ============

interface CreatorProfile {
  id: string | null
  username: string | null
  platform: string | null
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  postsCount: number
  standardFee: number | null
  country: string | null
  city: string | null
  isLinked: boolean
}

interface CreatorCampaign {
  id: string
  name: string
  brandName: string | null
  campaignStatus: string
  influencerStatus: string
  agreedFee: number | null
  contentDelivered: boolean
  hasShipping: boolean
  shippingProduct: string | null
  shippingCity: string | null
  shippingCountry: string | null
}

interface ShippingItem {
  campaignName: string
  product: string | null
  status: string
  city: string | null
  country: string | null
}

interface CreatorScoreInput {
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  postsCount: number
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  standardFee: number | null
  totalCampaigns: number
  completedCampaigns: number
}

interface CreatorDashboardData {
  user: { name: string; email: string; avatar: string | null }
  profile: CreatorProfile
  campaigns: CreatorCampaign[]
  shippingItems: ShippingItem[]
  scoreInput: CreatorScoreInput | null
}

// ============ SHARED HELPERS ============

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `€${(n / 1_000).toFixed(1)}K`
  return `€${n.toFixed(0)}`
}

function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const p = platform.toUpperCase()
  if (p === 'INSTAGRAM') return <Instagram className={className} />
  if (p === 'YOUTUBE') return <Youtube className={className} />
  // TikTok - use a simple icon
  return <Play className={className} />
}

function platformColor(platform: string): string {
  const p = platform.toUpperCase()
  if (p === 'INSTAGRAM') return 'text-pink-500'
  if (p === 'YOUTUBE') return 'text-red-500'
  return 'text-gray-800'
}

// ============ MAIN EXPORT ============

export default function DashboardPage() {
  const { role } = useRole()
  const isCreator = role === 'CREATOR'

  if (isCreator) {
    return <CreatorDashboard />
  }

  return <AdminDashboard />
}

// ============ CREATOR DASHBOARD ============

function CreatorDashboard() {
  const { t, locale } = useI18n()
  const [isLoading, setIsLoading] = useState(true)
  const [data, setData] = useState<CreatorDashboardData | null>(null)

  useEffect(() => {
    async function fetchCreatorData() {
      try {
        const res = await fetch('/api/dashboard/creator')
        if (res.ok) {
          const json = await res.json()
          setData(json)
        }
      } catch (err) {
        console.error('Error fetching creator dashboard:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchCreatorData()
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  const profile = data?.profile
  const campaigns = data?.campaigns || []
  const shippingItems = data?.shippingItems || []
  const scoreInput = data?.scoreInput

  // Calculate creator score if we have input data
  const scoreResult = scoreInput
    ? calculateCreatorScore({
        followers: scoreInput.followers,
        engagementRate: scoreInput.engagementRate,
        avgLikes: scoreInput.avgLikes,
        avgComments: scoreInput.avgComments,
        avgViews: scoreInput.avgViews,
        postsCount: scoreInput.postsCount,
        platform: scoreInput.platform,
        standardFee: scoreInput.standardFee,
        totalCampaigns: scoreInput.totalCampaigns,
        completedCampaigns: scoreInput.completedCampaigns,
      })
    : null

  // Calculate benchmark
  const benchmark = profile?.isLinked && profile.platform && profile.followers > 0
    ? getQuickBenchmark(profile.platform, profile.followers)
    : null

  const tierLabels: Record<string, string> = {
    NANO: 'Nano',
    MICRO: 'Micro',
    MID: 'Mid-Tier',
    MACRO: 'Macro',
    MEGA: 'Mega',
  }

  const greeting = (() => {
    const hour = new Date().getHours()
    if (hour < 12) return locale === 'es' ? 'Buenos dias' : 'Good morning'
    if (hour < 18) return locale === 'es' ? 'Buenas tardes' : 'Good afternoon'
    return locale === 'es' ? 'Buenas noches' : 'Good evening'
  })()

  const firstName = data?.user?.name?.split(' ')[0] || 'Creator'

  const statusLabel = (status: string) => {
    const labels: Record<string, Record<string, string>> = {
      es: {
        PROSPECT: 'Prospecto',
        OUTREACH: 'Contacto',
        NEGOTIATING: 'Negociando',
        AGREED: 'Acordado',
        CONTRACTED: 'Contratado',
        SHIPPING: 'Enviando',
        POSTED: 'Publicado',
        COMPLETED: 'Completado',
      },
      en: {
        PROSPECT: 'Prospect',
        OUTREACH: 'Outreach',
        NEGOTIATING: 'Negotiating',
        AGREED: 'Agreed',
        CONTRACTED: 'Contracted',
        SHIPPING: 'Shipping',
        POSTED: 'Posted',
        COMPLETED: 'Completed',
      },
    }
    return labels[locale]?.[status] || status
  }

  const statusColor = (status: string) => {
    if (status === 'COMPLETED' || status === 'POSTED') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    if (status === 'SHIPPING' || status === 'CONTRACTED' || status === 'AGREED') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    if (status === 'NEGOTIATING') return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
    return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
  }

  const shippingStatus = (influencerStatus: string) => {
    if (influencerStatus === 'COMPLETED' || influencerStatus === 'POSTED') return { label: locale === 'es' ? 'Entregado' : 'Delivered', icon: CheckCircle2, color: 'text-green-600' }
    if (influencerStatus === 'SHIPPING') return { label: locale === 'es' ? 'En camino' : 'Shipped', icon: Truck, color: 'text-blue-600' }
    return { label: locale === 'es' ? 'Pendiente' : 'Pending', icon: Clock, color: 'text-yellow-600' }
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* ===== HEADER ===== */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-blue-500 text-white text-xl font-bold shrink-0">
          {profile?.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            firstName[0]?.toUpperCase() || 'C'
          )}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {greeting}, <span className="text-purple-600">{firstName}</span>
          </h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            {locale === 'es'
              ? 'Tu perfil de creador en TKOC Intelligence'
              : 'Your creator profile on TKOC Intelligence'}
          </p>
        </div>
        {profile?.username && (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {profile.platform && <PlatformIcon platform={profile.platform} className={cn("h-4 w-4", platformColor(profile.platform))} />}
            <span>@{profile.username}</span>
            {profile.followers > 0 && (
              <span className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                {formatCompact(profile.followers)} followers
              </span>
            )}
          </div>
        )}
      </div>

      {/* ===== SECTION 1: MY PROFILE SCORE ===== */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Star className="h-5 w-5 text-purple-600" />
            {locale === 'es' ? 'Mi Creator Score' : 'My Creator Score'}
          </h2>
        </div>
        <div className="p-6">
          {scoreResult ? (
            <div className="flex flex-col items-center gap-4">
              <CreatorScoreBadge
                score={scoreResult.score}
                grade={scoreResult.grade}
                signal={scoreResult.signal}
                summary={scoreResult.summary}
                components={scoreResult.components}
                size="lg"
                expandable={false}
              />
              <p className="text-sm text-gray-600 dark:text-gray-400 text-center max-w-md">
                {scoreResult.summary}
              </p>

              {/* Component breakdown */}
              <div className="w-full max-w-lg mt-2 space-y-3">
                {[
                  { label: locale === 'es' ? 'Calidad de Engagement' : 'Engagement Quality', data: scoreResult.components.engagementQuality, weight: 30 },
                  { label: locale === 'es' ? 'Eficiencia de Valor' : 'Value Efficiency', data: scoreResult.components.valueEfficiency, weight: 25 },
                  { label: locale === 'es' ? 'Consistencia' : 'Consistency', data: scoreResult.components.consistency, weight: 20 },
                  { label: locale === 'es' ? 'Historial' : 'Track Record', data: scoreResult.components.trackRecord, weight: 15 },
                  { label: locale === 'es' ? 'Calidad de Audiencia' : 'Audience Quality', data: scoreResult.components.audienceQuality, weight: 10 },
                ].map((comp) => (
                  <div key={comp.label} title={comp.data.detail}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-600 dark:text-gray-400">
                        {comp.label} <span className="text-gray-300 dark:text-gray-600">({comp.weight}%)</span>
                      </span>
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{comp.data.score}</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className={cn(
                          "h-2 rounded-full transition-all",
                          comp.data.score >= 70 ? 'bg-emerald-500' : comp.data.score >= 40 ? 'bg-amber-500' : 'bg-red-500'
                        )}
                        style={{ width: `${comp.data.score}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-purple-50 dark:bg-purple-900/20">
                <Sparkles className="h-8 w-8 text-purple-400" />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {locale === 'es'
                  ? 'Conecta tus redes sociales para ver tu Creator Score'
                  : 'Connect your social accounts to see your Creator Score'}
              </p>
              <Link
                href="/settings"
                className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-purple-600 hover:text-purple-500"
              >
                {locale === 'es' ? 'Conectar cuentas' : 'Connect accounts'}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* ===== SECTION 2: MY VALUE ===== */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-purple-600" />
            {locale === 'es' ? 'Mi Valor de Mercado' : 'My Market Value'}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {locale === 'es' ? '¿Cuanto deberia cobrar?' : 'How much should I charge?'}
          </p>
        </div>
        <div className="p-6">
          {benchmark ? (
            <div className="space-y-4">
              {/* Tier badge */}
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-100 dark:bg-purple-900/30 px-3 py-1 text-sm font-semibold text-purple-700 dark:text-purple-300">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {tierLabels[benchmark.tier] || benchmark.tier}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {formatCompact(profile?.followers || 0)} followers
                </span>
              </div>

              {/* Fee range visualization */}
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-4">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                  {locale === 'es' ? 'Rango recomendado por contenido' : 'Recommended fee per content'}
                </p>
                <div className="flex items-end justify-between gap-2">
                  <div className="text-center flex-1">
                    <p className="text-lg font-bold text-gray-600 dark:text-gray-400">{formatCurrency(benchmark.feeMin)}</p>
                    <p className="text-[10px] text-gray-400 uppercase">Min</p>
                  </div>
                  <div className="text-center flex-1">
                    <p className="text-2xl font-bold text-purple-600">{formatCurrency(benchmark.feeTarget)}</p>
                    <p className="text-[10px] text-purple-500 uppercase font-medium">
                      {locale === 'es' ? 'Objetivo' : 'Target'}
                    </p>
                  </div>
                  <div className="text-center flex-1">
                    <p className="text-lg font-bold text-gray-600 dark:text-gray-400">{formatCurrency(benchmark.feeMax)}</p>
                    <p className="text-[10px] text-gray-400 uppercase">Max</p>
                  </div>
                  <div className="text-center flex-1">
                    <p className="text-lg font-bold text-gray-400 dark:text-gray-500">{formatCurrency(benchmark.feeCeiling)}</p>
                    <p className="text-[10px] text-gray-400 uppercase">
                      {locale === 'es' ? 'Techo' : 'Ceiling'}
                    </p>
                  </div>
                </div>
                {/* Visual bar */}
                <div className="mt-3 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-purple-400 via-purple-600 to-purple-800" style={{ width: '75%' }} />
                </div>
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400">
                {locale === 'es'
                  ? 'Basado en benchmarks de mercado para tu plataforma y tamano de audiencia. Los precios varian segun nicho y tipo de contenido.'
                  : 'Based on market benchmarks for your platform and audience size. Prices vary by niche and content type.'}
              </p>
            </div>
          ) : (
            <div className="text-center py-8">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-50 dark:bg-green-900/20">
                <DollarSign className="h-8 w-8 text-green-400" />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {locale === 'es'
                  ? 'Conecta tus cuentas para ver tu valor de mercado'
                  : 'Connect your accounts to see your market value'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ===== SECTION 3: MY CAMPAIGNS ===== */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
        <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-purple-600" />
            {locale === 'es' ? 'Mis Campanas' : 'My Campaigns'}
          </h2>
        </div>
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {campaigns.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-50 dark:bg-gray-800">
                <Megaphone className="h-8 w-8 text-gray-300 dark:text-gray-600" />
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {locale === 'es'
                  ? 'Todavia no has sido anadido a ninguna campana'
                  : "You haven't been added to any campaigns yet"}
              </p>
            </div>
          ) : (
            campaigns.map((campaign) => (
              <div
                key={campaign.id}
                className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30 shrink-0">
                  <Megaphone className="h-5 w-5 text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{campaign.name}</p>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                    {campaign.brandName && (
                      <span className="flex items-center gap-1">
                        <Building2Icon className="h-3 w-3" />
                        {campaign.brandName}
                      </span>
                    )}
                    {campaign.agreedFee != null && campaign.agreedFee > 0 && (
                      <span className="font-medium text-green-600 dark:text-green-400">
                        {formatCurrency(campaign.agreedFee)}
                      </span>
                    )}
                  </div>
                </div>
                <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", statusColor(campaign.influencerStatus))}>
                  {statusLabel(campaign.influencerStatus)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ===== SECTION 4: SHIPPING STATUS ===== */}
      {shippingItems.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
          <div className="border-b border-gray-200 dark:border-gray-700 px-6 py-4">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="h-5 w-5 text-purple-600" />
              {locale === 'es' ? 'Estado de Envios' : 'Shipping Status'}
            </h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {shippingItems.map((item, i) => {
              const shipStatus = shippingStatus(item.status)
              const ShipIcon = shipStatus.icon
              return (
                <div key={i} className="flex items-center gap-4 px-6 py-4">
                  <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg shrink-0",
                    item.status === 'COMPLETED' || item.status === 'POSTED' ? 'bg-green-50 dark:bg-green-900/20' :
                    item.status === 'SHIPPING' ? 'bg-blue-50 dark:bg-blue-900/20' :
                    'bg-yellow-50 dark:bg-yellow-900/20'
                  )}>
                    <ShipIcon className={cn("h-5 w-5", shipStatus.color)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{item.campaignName}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                      {item.product && <span>{item.product}</span>}
                      {item.city && <span>· {item.city}{item.country ? `, ${item.country}` : ''}</span>}
                    </div>
                  </div>
                  <span className={cn("text-sm font-medium", shipStatus.color)}>
                    {shipStatus.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ===== SECTION 5: QUICK ACTIONS ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: locale === 'es' ? 'Conectar Instagram' : 'Connect Instagram',
            icon: Instagram,
            href: '/settings',
            color: 'text-pink-500',
            bg: 'bg-pink-50 dark:bg-pink-900/20',
          },
          {
            label: locale === 'es' ? 'Conectar TikTok' : 'Connect TikTok',
            icon: Play,
            href: '/settings',
            color: 'text-gray-800 dark:text-gray-200',
            bg: 'bg-gray-100 dark:bg-gray-800',
          },
          {
            label: locale === 'es' ? 'Ver Metodologia' : 'View Methodology',
            icon: BookOpen,
            href: '/methodology',
            color: 'text-purple-600',
            bg: 'bg-purple-50 dark:bg-purple-900/20',
          },
          {
            label: locale === 'es' ? 'Mi Perfil' : 'My Profile',
            icon: User,
            href: '/settings',
            color: 'text-blue-600',
            bg: 'bg-blue-50 dark:bg-blue-900/20',
          },
        ].map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="flex flex-col items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-purple-300 hover:shadow-md transition-all text-center shadow-sm"
          >
            <div className={cn("rounded-lg p-2.5", action.bg)}>
              <action.icon className={cn("h-5 w-5", action.color)} />
            </div>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{action.label}</span>
          </Link>
        ))}
      </div>

      {/* ===== SECTION 6: TIPS FOR CREATORS ===== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Tip 1 */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gradient-to-br from-purple-50 to-white dark:from-purple-900/10 dark:to-gray-900 p-5 shadow-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30 mb-3">
            <TrendingUp className="h-5 w-5 text-purple-600" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1.5">
            {locale === 'es' ? 'Sube tu Creator Score' : 'Boost Your Creator Score'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            {locale === 'es'
              ? 'Publica con regularidad, mantén un engagement alto, y completa todas las campañas a tiempo para mejorar tu puntuación.'
              : 'Post consistently, maintain high engagement, and complete all campaigns on time to improve your score.'}
          </p>
        </div>

        {/* Tip 2 */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gradient-to-br from-blue-50 to-white dark:from-blue-900/10 dark:to-gray-900 p-5 shadow-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30 mb-3">
            <BarChart3 className="h-5 w-5 text-blue-600" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1.5">
            {locale === 'es' ? 'Tu valor de mercado' : 'Your Market Value'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            {locale === 'es'
              ? 'Los precios se basan en tu plataforma, audiencia y engagement. Visita la metodología para entender cómo se calculan.'
              : 'Pricing is based on your platform, audience, and engagement. Visit the methodology page to understand the calculations.'}
          </p>
          <Link href="/methodology" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-500">
            {locale === 'es' ? 'Ver metodologia' : 'View methodology'}
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        {/* Tip 3 */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gradient-to-br from-green-50 to-white dark:from-green-900/10 dark:to-gray-900 p-5 shadow-sm">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30 mb-3">
            <Link2 className="h-5 w-5 text-green-600" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1.5">
            {locale === 'es' ? 'Conecta tus cuentas' : 'Connect Your Accounts'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            {locale === 'es'
              ? 'Al conectar Instagram o TikTok, obtenemos datos reales de reach e impresiones para darte métricas más precisas.'
              : 'By connecting Instagram or TikTok, we get real reach and impression data to give you more accurate metrics.'}
          </p>
        </div>
      </div>

      {/* Powered by footer */}
      <div className="text-center pb-4">
        <p className="text-[11px] text-gray-400 dark:text-gray-600">
          Powered by TKOC Intelligence
        </p>
      </div>
    </div>
  )
}

// Small inline icon for Building2 (to avoid name conflicts)
function Building2Icon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
      <path d="M10 6h4" />
      <path d="M10 10h4" />
      <path d="M10 14h4" />
      <path d="M10 18h4" />
    </svg>
  )
}

// ============ ADMIN DASHBOARD (original) ============

function AdminDashboard() {
  const { t, locale } = useI18n()
  const [greeting, setGreeting] = useState("")
  const [userName, setUserName] = useState("there")
  const [isLoading, setIsLoading] = useState(true)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [recentCampaigns, setRecentCampaigns] = useState<RecentCampaign[]>([])
  const [topInfluencers, setTopInfluencers] = useState<TopInfluencer[]>([])
  const [recentActivity, setRecentActivity] = useState<RecentMediaItem[]>([])
  const [platformBreakdown, setPlatformBreakdown] = useState<PlatformBreakdown[]>([])
  const [campaignsByStatus, setCampaignsByStatus] = useState<CampaignsByStatus>({ active: 0, paused: 0, archived: 0 })
  const [showWizard, setShowWizard] = useState(false)

  const quickActions = [
    { title: t.dashboard.quickActions.createCampaign, description: t.dashboard.quickActions.createCampaignDesc, icon: Megaphone, href: "/campaigns/new" },
    { title: t.dashboard.quickActions.analyzeProfile, description: t.dashboard.quickActions.analyzeProfileDesc, icon: UserSearch, href: "/analyze" },
    { title: t.dashboard.quickActions.findCreators, description: t.dashboard.quickActions.findCreatorsDesc, icon: Users, href: "/discover" },
    { title: t.dashboard.quickActions.manageLists, description: t.dashboard.quickActions.manageListsDesc, icon: ListChecks, href: "/lists" },
  ]

  useEffect(() => {
    const hour = new Date().getHours()
    if (hour < 12) setGreeting(t.dashboard.greeting.morning)
    else if (hour < 18) setGreeting(t.dashboard.greeting.afternoon)
    else setGreeting(t.dashboard.greeting.evening)

    try {
      const userData = localStorage.getItem('user')
      if (userData) {
        const user = JSON.parse(userData)
        setUserName(user.name?.split(' ')[0] || 'there')
      }
    } catch {}

    async function fetchDashboard() {
      try {
        const res = await fetch('/api/dashboard')
        if (res.ok) {
          const data = await res.json()
          setStats(data.stats)
          setRecentCampaigns(data.recentCampaigns || [])
          setTopInfluencers(data.topInfluencers || [])
          setRecentActivity(data.recentActivity || [])
          setPlatformBreakdown(data.platformBreakdown || [])
          setCampaignsByStatus(data.campaignsByStatus || { active: 0, paused: 0, archived: 0 })
        }
      } catch (err) {
        console.error('Error fetching dashboard:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchDashboard()
  }, [t])

  const statusLabels: Record<string, string> = {
    ACTIVE: t.common.active,
    PAUSED: t.common.paused,
    ARCHIVED: t.common.archived,
  }

  const typeLabels: Record<string, string> = {
    SOCIAL_LISTENING: 'Social Listening',
    INFLUENCER_TRACKING: locale === 'es' ? 'Tracking' : 'Tracking',
    UGC: 'UGC',
  }

  const emvRatio = stats && stats.totalInvestment > 0 && stats.totalEMV?.extended > 0
    ? (stats.totalEMV.extended / stats.totalInvestment)
    : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Welcome + Quick Actions */}
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {greeting}, <span className="text-purple-600">{userName}</span>
          </h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{t.dashboard.subtitle}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowWizard(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-purple-600 to-blue-600 px-5 py-2 text-sm font-bold text-white hover:from-purple-700 hover:to-blue-700 transition-all shadow-md"
          >
            <Zap className="h-4 w-4" />
            {locale === 'es' ? 'Guiame' : 'Guide Me'}
          </button>
          {quickActions.slice(0, 2).map((a) => (
            <Link key={a.href} href={a.href}
              className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors shadow-sm">
              <a.icon className="h-4 w-4" />
              {a.title}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI Cards Row 1 — Main metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label={t.dashboard.activeCampaigns}
          value={stats?.activeCampaigns || 0}
          format="number"
          icon={<Megaphone className="h-5 w-5" />}
          iconBg="bg-purple-100 text-purple-600 dark:bg-purple-900/30"
          href="/campaigns"
        />
        <KPICard
          label={t.dashboard.totalInfluencers}
          value={stats?.totalInfluencers || 0}
          format="number"
          icon={<Users className="h-5 w-5" />}
          iconBg="bg-blue-100 text-blue-600 dark:bg-blue-900/30"
          href="/contacts"
        />
        <KPICard
          label={locale === 'es' ? 'Inversion total' : 'Total Investment'}
          value={stats?.totalInvestment || 0}
          format="currency"
          icon={<DollarSign className="h-5 w-5" />}
          iconBg="bg-green-100 text-green-600 dark:bg-green-900/30"
        />
        <KPICard
          label="EMV"
          value={stats?.totalEMV?.extended || 0}
          format="currency"
          icon={<Zap className="h-5 w-5" />}
          iconBg="bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30"
          subtitle={emvRatio ? `${emvRatio.toFixed(1)}x EMV Ratio` : undefined}
          subtitleColor={emvRatio && emvRatio >= 2 ? 'text-green-600' : emvRatio && emvRatio >= 1 ? 'text-yellow-600' : 'text-red-500'}
        />
      </div>

      {/* KPI Cards Row 2 — Performance metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          label={locale === 'es' ? 'Publicaciones' : 'Posts'}
          value={stats?.totalMediaPosts || 0}
          format="number"
          icon={<Image className="h-5 w-5" />}
          iconBg="bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30"
          small
        />
        <KPICard
          label={locale === 'es' ? 'Views totales' : 'Total Views'}
          value={stats?.totalViews || 0}
          format="compact"
          icon={<Eye className="h-5 w-5" />}
          iconBg="bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30"
          small
        />
        <KPICard
          label={locale === 'es' ? 'Likes totales' : 'Total Likes'}
          value={stats?.totalLikes || 0}
          format="compact"
          icon={<Heart className="h-5 w-5" />}
          iconBg="bg-pink-100 text-pink-600 dark:bg-pink-900/30"
          small
        />
        <KPICard
          label={locale === 'es' ? 'Comentarios' : 'Comments'}
          value={stats?.totalComments || 0}
          format="compact"
          icon={<MessageCircle className="h-5 w-5" />}
          iconBg="bg-orange-100 text-orange-600 dark:bg-orange-900/30"
          small
        />
      </div>

      {/* Two-column layout: Recent Campaigns + Top Influencers */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Recent Campaigns — 2/3 width */}
        <div className="lg:col-span-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Activity className="h-4 w-4 text-purple-600" />
              {t.dashboard.recentCampaigns}
            </h2>
            <Link href="/campaigns" className="text-xs text-purple-600 hover:text-purple-500">
              {t.common.viewAll} →
            </Link>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {recentCampaigns.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                {t.campaigns.noCampaignsStart}
              </div>
            ) : (
              recentCampaigns.map((campaign) => (
                <Link
                  key={campaign.id}
                  href={`/campaigns/${campaign.id}`}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-lg shrink-0",
                    campaign.status === 'ACTIVE' && "bg-purple-100 text-purple-600 dark:bg-purple-900/30",
                    campaign.status === 'PAUSED' && "bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30",
                    campaign.status === 'ARCHIVED' && "bg-gray-100 text-gray-500 dark:bg-gray-800",
                  )}>
                    <Megaphone className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{campaign.name}</p>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-gray-400">
                      <span className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px] font-medium">
                        {typeLabels[campaign.type] || campaign.type}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {campaign._count.influencers}
                      </span>
                      <span className="flex items-center gap-1">
                        <Image className="h-3 w-3" />
                        {campaign._count.media}
                      </span>
                      {campaign.objective && (
                        <span className="flex items-center gap-1">
                          <Target className="h-3 w-3" />
                          {campaign.objective}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    campaign.status === 'ACTIVE' && "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
                    campaign.status === 'PAUSED' && "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
                    campaign.status === 'ARCHIVED' && "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
                  )}>
                    {statusLabels[campaign.status] || campaign.status}
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-gray-300 shrink-0" />
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Top Influencers — 1/3 width */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-purple-600" />
              Top Influencers
            </h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {topInfluencers.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                {locale === 'es' ? 'Sin datos todavia' : 'No data yet'}
              </div>
            ) : (
              topInfluencers.map((inf, i) => (
                <div key={inf.username + inf.platform} className="flex items-center gap-3 px-5 py-3">
                  <span className="text-xs font-bold text-gray-300 w-4">{i + 1}</span>
                  <Avatar
                    src={inf.avatarUrl}
                    name={inf.username}
                    size="sm"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                      @{inf.username}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      <PlatformIcon platform={inf.platform} className={cn("h-3 w-3", platformColor(inf.platform))} />
                      <span>{formatCompact(inf.followers)}</span>
                      {inf.engagementRate && <span>· {inf.engagementRate.toFixed(1)}%</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold text-gray-900 dark:text-white">
                      {formatCompact(inf.totalLikes + inf.totalComments)}
                    </p>
                    <p className="text-[10px] text-gray-400">eng.</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Bottom row: Recent Activity + Platform Breakdown + Campaign Status */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Recent Activity — 2/3 */}
        <div className="lg:col-span-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
          <div className="border-b border-gray-200 dark:border-gray-700 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <Eye className="h-4 w-4 text-purple-600" />
              {locale === 'es' ? 'Actividad reciente' : 'Recent Activity'}
            </h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {recentActivity.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400">
                {locale === 'es' ? 'Sin publicaciones recientes' : 'No recent posts'}
              </div>
            ) : (
              recentActivity.map((item, i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                  <PlatformIcon platform={item.platform} className={cn("h-4 w-4 shrink-0", platformColor(item.platform))} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-white truncate">
                      <span className="font-medium">@{item.influencerUsername}</span>
                      <span className="text-gray-400"> · {item.campaignName}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 shrink-0">
                    {item.views > 0 && (
                      <span className="flex items-center gap-1">
                        <Eye className="h-3 w-3" />{formatCompact(item.views)}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Heart className="h-3 w-3" />{formatCompact(item.likes)}
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" />{formatCompact(item.comments)}
                    </span>
                  </div>
                  {item.permalink && (
                    <a href={item.permalink} target="_blank" rel="noopener noreferrer"
                      className="text-gray-300 hover:text-purple-500 shrink-0">
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Platform Breakdown + Campaign Status — 1/3 */}
        <div className="space-y-6">
          {/* Platform breakdown */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-purple-600" />
              {locale === 'es' ? 'Por plataforma' : 'By Platform'}
            </h2>
            <div className="space-y-3">
              {platformBreakdown.length === 0 ? (
                <p className="text-sm text-gray-400">{locale === 'es' ? 'Sin datos' : 'No data'}</p>
              ) : (
                platformBreakdown.map((pb) => {
                  const totalInf = platformBreakdown.reduce((s, p) => s + p.influencers, 0)
                  const pct = totalInf > 0 ? Math.round((pb.influencers / totalInf) * 100) : 0
                  return (
                    <div key={pb.platform}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                          <PlatformIcon platform={pb.platform} className={cn("h-4 w-4", platformColor(pb.platform))} />
                          {pb.platform.charAt(0) + pb.platform.slice(1).toLowerCase()}
                        </span>
                        <span className="text-xs text-gray-500">
                          {pb.influencers} {locale === 'es' ? 'creadores' : 'creators'} · {pb.media} posts
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            pb.platform === 'INSTAGRAM' ? 'bg-gradient-to-r from-pink-500 to-purple-500' :
                            pb.platform === 'YOUTUBE' ? 'bg-red-500' :
                            'bg-gray-800'
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Campaign status overview */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm p-5">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <Target className="h-4 w-4 text-purple-600" />
              {locale === 'es' ? 'Estado de campanas' : 'Campaign Status'}
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center p-3 rounded-lg bg-green-50 dark:bg-green-900/20">
                <p className="text-xl font-bold text-green-700 dark:text-green-400">{campaignsByStatus.active}</p>
                <p className="text-[10px] font-medium text-green-600 dark:text-green-500 uppercase">{t.common.active}</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20">
                <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400">{campaignsByStatus.paused}</p>
                <p className="text-[10px] font-medium text-yellow-600 dark:text-yellow-500 uppercase">{t.common.paused}</p>
              </div>
              <div className="text-center p-3 rounded-lg bg-gray-100 dark:bg-gray-800">
                <p className="text-xl font-bold text-gray-600 dark:text-gray-400">{campaignsByStatus.archived}</p>
                <p className="text-[10px] font-medium text-gray-500 uppercase">{locale === 'es' ? 'Archivadas' : 'Archived'}</p>
              </div>
            </div>
          </div>

          {/* Repeat Radar */}
          <RepeatRadarWidget />

          {/* Quick links */}
          <div className="grid grid-cols-2 gap-3">
            {quickActions.slice(2).map((a) => (
              <Link key={a.href} href={a.href}
                className="flex flex-col items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 hover:border-purple-300 hover:shadow-md transition-all text-center shadow-sm">
                <div className="rounded-lg bg-purple-50 dark:bg-purple-900/30 p-2 text-purple-600">
                  <a.icon className="h-4 w-4" />
                </div>
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{a.title}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Campaign Wizard */}
      <CampaignWizard isOpen={showWizard} onClose={() => setShowWizard(false)} />
    </div>
  )
}

// ============ KPI CARD COMPONENT ============

function KPICard({
  label,
  value,
  format,
  icon,
  iconBg,
  href,
  small,
  subtitle,
  subtitleColor,
}: {
  label: string
  value: number
  format: 'number' | 'percent' | 'currency' | 'compact'
  icon: React.ReactNode
  iconBg: string
  href?: string
  small?: boolean
  subtitle?: string
  subtitleColor?: string
}) {
  const formatted = format === 'percent' ? `${value}%`
    : format === 'currency' ? formatCurrency(value)
    : format === 'compact' ? formatCompact(value)
    : formatNumber(value)

  const card = (
    <div className={cn(
      "rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm transition-all",
      href && "hover:border-purple-300 hover:shadow-md cursor-pointer",
      small ? "p-4" : "p-5",
    )}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
        <div className={cn("rounded-lg p-1.5", iconBg)}>
          {icon}
        </div>
      </div>
      <p className={cn("font-bold text-gray-900 dark:text-white", small ? "mt-1 text-lg" : "mt-2 text-2xl")}>
        {formatted}
      </p>
      {subtitle && (
        <p className={cn("text-xs font-semibold mt-0.5", subtitleColor || 'text-gray-500')}>
          {subtitle}
        </p>
      )}
    </div>
  )

  if (href) {
    return <Link href={href}>{card}</Link>
  }
  return card
}
