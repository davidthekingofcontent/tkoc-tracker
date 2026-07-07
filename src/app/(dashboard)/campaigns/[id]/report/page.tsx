'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { formatNumber } from '@/lib/utils'
import { estimateReach } from '@/lib/reach-estimate'
import { proxyImg } from '@/lib/proxy-image'
import {
  ArrowLeft,
  Printer,
  Loader2,
  ExternalLink,
  Users,
  Image as ImageIcon,
  Eye,
  Heart,
  TrendingUp,
  BarChart3,
  Search,
  ShieldCheck,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types — defensive: a concurrent task is extending /api/campaigns/[id], so
// every field is treated as potentially missing.
// ---------------------------------------------------------------------------

interface ReportInfluencer {
  id?: string
  username?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  platform?: string | null
  followers?: number | null
  engagementRate?: number | null
}

interface ReportMember {
  status?: string | null
  agreedFee?: number | null
  cost?: number | null
  influencer?: ReportInfluencer | null
}

interface ReportMedia {
  id: string
  mediaType?: string | null
  caption?: string | null
  thumbnailUrl?: string | null
  permalink?: string | null
  likes?: number | null
  comments?: number | null
  views?: number | null
  shares?: number | null
  saves?: number | null
  reach?: number | null
  impressions?: number | null
  source?: string | null
  postedAt?: string | null
  influencer?: {
    username?: string | null
    avatarUrl?: string | null
  } | null
}

interface ReportCampaign {
  id?: string
  name?: string
  status?: string
  startDate?: string | null
  endDate?: string | null
  platforms?: string[]
  influencers?: ReportMember[]
  media?: ReportMedia[]
}

interface TimelinePoint {
  date: string
  posts: number
  engagement: number
}

// ---------------------------------------------------------------------------
// Recharts (client-side only, same dynamic-import pattern as the detail page)
// ---------------------------------------------------------------------------

const ReportAreaChart = dynamic(
  () => import('recharts').then(mod => {
    const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = mod
    return function ChartWrapper({ data }: { data: TimelinePoint[] }) {
      return (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <defs>
              <linearGradient id="grad_report_engagement" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="grad_report_posts" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              tickFormatter={(v: string) => {
                const d = new Date(v)
                return `${d.getDate()}/${d.getMonth() + 1}`
              }}
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: '#9ca3af' }}
              tickFormatter={(v: number) => {
                if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`
                if (v >= 1000) return `${(v / 1000).toFixed(1)}K`
                return v.toString()
              }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 10, fill: '#9ca3af' }}
            />
            <Tooltip
              contentStyle={{
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                boxShadow: '0 4px 6px -1px rgba(0,0,0,.1)',
                fontSize: '12px',
              }}
              labelFormatter={(v) => new Date(String(v)).toLocaleDateString('es-ES')}
            />
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="engagement"
              name="Engagement"
              stroke="#7c3aed"
              strokeWidth={2}
              fill="url(#grad_report_engagement)"
            />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="posts"
              name="Publicaciones"
              stroke="#a78bfa"
              strokeWidth={2}
              fill="url(#grad_report_posts)"
            />
          </AreaChart>
        </ResponsiveContainer>
      )
    }
  }),
  {
    ssr: false,
    loading: () => <div className="h-[260px] animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />,
  }
)

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source?: string | null }) {
  if (source === 'meta_api') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400">
        <ShieldCheck className="h-3 w-3" />
        Meta
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
      Público
    </span>
  )
}

function MediaThumb({ src, alt }: { src?: string | null; alt: string }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
  if (!url || error) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
        <ImageIcon className="h-5 w-5 text-gray-400" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="h-12 w-12 shrink-0 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="print-card rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Icon className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  )
}

function mediaTypeLabel(type?: string | null): string {
  switch ((type || '').toUpperCase()) {
    case 'REEL': return 'Reel'
    case 'VIDEO': return 'Vídeo'
    case 'IMAGE': return 'Imagen'
    case 'PHOTO': return 'Imagen'
    case 'CAROUSEL':
    case 'SIDECAR': return 'Carrusel'
    case 'STORY': return 'Story'
    default: return type || '—'
  }
}

function statusInfo(status?: string): { variant: 'active' | 'paused' | 'archived' | 'default'; label: string } {
  switch (status) {
    case 'ACTIVE': return { variant: 'active', label: 'Activa' }
    case 'PAUSED': return { variant: 'paused', label: 'Pausada' }
    case 'COMPLETED': return { variant: 'archived', label: 'Completada' }
    case 'DRAFT': return { variant: 'default', label: 'Borrador' }
    case 'ARCHIVED': return { variant: 'archived', label: 'Archivada' }
    default: return { variant: 'default', label: status || '—' }
  }
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('es-ES')
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CampaignReportPage() {
  const params = useParams()
  const campaignId = params.id as string
  const [campaign, setCampaign] = useState<ReportCampaign | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function fetchCampaign() {
      try {
        // A report must aggregate the FULL campaign, not one page — the API
        // caps mediaLimit at 100, so paginate until exhausted (safety cap 20
        // pages = 2000 posts).
        const PAGE = 100
        const MAX_PAGES = 20
        let base: ReportCampaign | null = null
        let allMedia: NonNullable<ReportCampaign['media']> = []

        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetch(`/api/campaigns/${campaignId}?mediaLimit=${PAGE}&mediaOffset=${page * PAGE}`)
          if (!res.ok) break
          const data = await res.json()
          if (!data.campaign) break
          if (page === 0) base = data.campaign
          const pageMedia = data.campaign.media || []
          allMedia = allMedia.concat(pageMedia)
          if (pageMedia.length < PAGE) break
        }

        if (!cancelled && base) setCampaign({ ...base, media: allMedia })
      } catch (err) {
        console.error('Error fetching campaign report data:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    fetchCampaign()
    return () => { cancelled = true }
  }, [campaignId])

  const report = useMemo(() => {
    const members = campaign?.influencers || []
    const media = campaign?.media || []

    // Lookup: username -> roster member (for followers / ER when estimating reach)
    const memberByUsername = new Map<string, ReportMember>()
    for (const ci of members) {
      const u = ci?.influencer?.username?.toLowerCase()
      if (u && !memberByUsername.has(u)) memberByUsername.set(u, ci)
    }

    const engagementOf = (m: ReportMedia) =>
      (m.likes || 0) + (m.comments || 0) + (m.saves || 0) + (m.shares || 0)

    const reachOf = (m: ReportMedia): { value: number; estimated: boolean } => {
      // Real reach only when it comes from the Meta API
      if (m.source === 'meta_api' && typeof m.reach === 'number' && m.reach > 0) {
        return { value: m.reach, estimated: false }
      }
      const member = m.influencer?.username
        ? memberByUsername.get(m.influencer.username.toLowerCase())
        : undefined
      const inf = member?.influencer
      if (!inf) return { value: 0, estimated: true }
      return {
        value: estimateReach(inf.followers || 0, inf.engagementRate || 0),
        estimated: true,
      }
    }

    const items = media.map(m => ({ media: m, engagement: engagementOf(m), reach: reachOf(m) }))

    // --- Executive summary ---
    const posterUsernames = new Set(
      media.map(m => m.influencer?.username?.toLowerCase()).filter(Boolean) as string[]
    )
    const totalViews = media.reduce((s, m) => s + (m.views || 0), 0)
    const totalEngagement = items.reduce((s, x) => s + x.engagement, 0)
    const realReach = items.reduce((s, x) => s + (x.reach.estimated ? 0 : x.reach.value), 0)
    const estimatedReach = items.reduce((s, x) => s + (x.reach.estimated ? x.reach.value : 0), 0)
    const totalReach = realReach + estimatedReach

    let avgER: number | null = null
    if (totalReach > 0) {
      avgER = (totalEngagement / totalReach) * 100
    } else {
      const ers = members
        .map(ci => ci.influencer?.engagementRate)
        .filter((v): v is number => typeof v === 'number' && v > 0)
      if (ers.length > 0) avgER = ers.reduce((s, v) => s + v, 0) / ers.length
    }

    // --- Timeline: posts + engagement per day ---
    const byDay = new Map<string, { posts: number; engagement: number }>()
    for (const x of items) {
      if (!x.media.postedAt) continue
      const d = new Date(x.media.postedAt)
      if (isNaN(d.getTime())) continue
      const key = d.toISOString().slice(0, 10)
      const entry = byDay.get(key) || { posts: 0, engagement: 0 }
      entry.posts += 1
      entry.engagement += x.engagement
      byDay.set(key, entry)
    }
    const timeline: TimelinePoint[] = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => ({ date, posts: v.posts, engagement: v.engagement }))

    // --- Content table: sorted by engagement DESC ---
    const sortedItems = [...items].sort((a, b) => b.engagement - a.engagement)

    // --- Per-creator performance ---
    const creators = members
      .filter(ci => ci.influencer)
      .map(ci => {
        const inf = ci.influencer as ReportInfluencer
        const uname = inf.username?.toLowerCase()
        const own = uname
          ? items.filter(x => x.media.influencer?.username?.toLowerCase() === uname)
          : []
        const posts = own.length
        const engagement = own.reduce((s, x) => s + x.engagement, 0)
        const reachTotal = own.reduce((s, x) => s + x.reach.value, 0)
        const reachEstimated = own.some(x => x.reach.estimated && x.reach.value > 0)
        const er = reachTotal > 0
          ? (engagement / reachTotal) * 100
          : (typeof inf.engagementRate === 'number' ? inf.engagementRate : null)
        const fee = typeof ci.agreedFee === 'number' && ci.agreedFee > 0 ? ci.agreedFee : null
        const cpm = fee !== null && reachTotal > 0 ? fee / (reachTotal / 1000) : null
        return { member: ci, inf, posts, engagement, reachTotal, reachEstimated, er, fee, cpm }
      })
      .sort((a, b) => b.engagement - a.engagement)

    // --- Data quality ---
    const metaCount = media.filter(m => m.source === 'meta_api').length
    const publicCount = media.length - metaCount
    const metaPct = media.length > 0 ? Math.round((metaCount / media.length) * 100) : 0

    return {
      mediaCount: media.length,
      activeCreators: posterUsernames.size,
      totalViews,
      totalEngagement,
      totalReach,
      realReach,
      estimatedReach,
      avgER,
      timeline,
      sortedItems,
      creators,
      metaCount,
      publicCount,
      metaPct,
    }
  }, [campaign])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500 dark:text-gray-400">Cargando informe...</span>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500 dark:text-gray-400">No se encontró la campaña</p>
        <Link href="/campaigns" className="mt-4 inline-block text-purple-600 hover:underline dark:text-purple-400">
          Volver a campañas
        </Link>
      </div>
    )
  }

  const status = statusInfo(campaign.status)
  const dateRange = [formatDate(campaign.startDate), formatDate(campaign.endDate)]
    .filter(Boolean)
    .join(' — ')
  const hasMedia = report.mediaCount > 0
  const estimatedPct = report.totalReach > 0
    ? Math.round((report.estimatedReach / report.totalReach) * 100)
    : 0

  return (
    <div id="campaign-report" className="space-y-6">
      {/* Print styles: hide app chrome, white background, avoid card splits */}
      <style>{`
        @media print {
          aside, header, .fixed, .no-print { display: none !important; }
          div.ml-\\[260px\\] { margin-left: 0 !important; }
          main { padding: 0 !important; overflow: visible !important; }
          html, body { background: #ffffff !important; }
          #campaign-report *:not(.print-keep) {
            background-color: transparent !important;
            color: #111827 !important;
            border-color: #e5e7eb !important;
            box-shadow: none !important;
          }
          .print-keep { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .print-card { break-inside: avoid; page-break-inside: avoid; }
          @page { margin: 12mm; }
        }
      `}</style>

      {/* 1. Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {campaign.name || 'Campaña'}
            </h1>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-purple-600 dark:text-purple-400">Informe de rendimiento</span>
            {dateRange && (
              <>
                <span>&middot;</span>
                <span>{dateRange}</span>
              </>
            )}
            {(campaign.platforms?.length || 0) > 0 && (
              <>
                <span>&middot;</span>
                <span>{(campaign.platforms || []).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(', ')}</span>
              </>
            )}
            <span>&middot;</span>
            <span>Generado el {new Date().toLocaleDateString('es-ES')}</span>
          </div>
        </div>
        <div className="no-print flex items-center gap-3 print:hidden">
          <Link href={`/campaigns/${campaignId}`}>
            <Button variant="secondary" size="sm">
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Button>
          </Link>
          <Button variant="primary" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Exportar PDF
          </Button>
        </div>
      </div>

      {!hasMedia ? (
        <div className="print-card rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-900">
          <Search className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" />
          <p className="mt-4 font-medium text-gray-900 dark:text-gray-100">
            Aún no hay contenido capturado
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Usa &laquo;Rastrear Ahora&raquo; en la página de la campaña para capturar publicaciones.
          </p>
          <Link
            href={`/campaigns/${campaignId}`}
            className="mt-4 inline-block text-sm font-medium text-purple-600 hover:underline dark:text-purple-400"
          >
            Ir a la campaña
          </Link>
        </div>
      ) : (
        <>
          {/* 2. Executive summary */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Resumen ejecutivo
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard icon={Users} label="Influencers activados" value={formatNumber(report.activeCreators)} />
              <StatCard icon={ImageIcon} label="Posts capturados" value={formatNumber(report.mediaCount)} />
              <StatCard icon={Eye} label="Vistas totales" value={formatNumber(report.totalViews)} />
              <StatCard
                icon={Heart}
                label="Engagement total"
                value={formatNumber(report.totalEngagement)}
                sub="likes + comentarios + saves + shares"
              />
              <StatCard
                icon={TrendingUp}
                label="ER medio"
                value={report.avgER !== null ? `${report.avgER.toFixed(2)}%` : '—'}
              />
              <StatCard
                icon={BarChart3}
                label="Alcance total"
                value={report.totalReach > 0 ? formatNumber(report.totalReach) : '—'}
                sub={estimatedPct > 0 ? `${estimatedPct}% estimado` : 'datos reales de Meta'}
              />
            </div>
          </section>

          {/* 3. Timeline */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Evolución diaria
            </h2>
            <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <h3 className="mb-4 text-sm font-semibold text-gray-700 dark:text-gray-300">
                Publicaciones y engagement por día
              </h3>
              {report.timeline.length > 0 ? (
                <ReportAreaChart data={report.timeline} />
              ) : (
                <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
                  Sin fechas de publicación disponibles
                </p>
              )}
            </div>
          </section>

          {/* 4. Content table */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Tabla de contenidos
            </h2>
            <div className="print-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                      <th className="px-4 py-3">Contenido</th>
                      <th className="px-4 py-3">Tipo</th>
                      <th className="px-4 py-3 text-right">Likes</th>
                      <th className="px-4 py-3 text-right">Comentarios</th>
                      <th className="px-4 py-3 text-right">Vistas</th>
                      <th className="px-4 py-3 text-right">Alcance</th>
                      <th className="px-4 py-3">Fuente</th>
                      <th className="no-print px-4 py-3 print:hidden">Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sortedItems.map(({ media: m, reach }) => (
                      <tr
                        key={m.id}
                        className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <MediaThumb src={m.thumbnailUrl} alt={m.caption || 'Contenido'} />
                            <div className="min-w-0 max-w-xs">
                              <p className="line-clamp-2 text-xs text-gray-700 dark:text-gray-300">
                                {m.caption || 'Sin descripción'}
                              </p>
                              <p className="mt-0.5 text-xs font-medium text-purple-600 dark:text-purple-400">
                                @{m.influencer?.username || 'desconocido'}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="default">{mediaTypeLabel(m.mediaType)}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {formatNumber(m.likes || 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {formatNumber(m.comments || 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {m.views ? formatNumber(m.views) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {reach.value > 0
                            ? `${reach.estimated ? '~' : ''}${formatNumber(reach.value)}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <SourceBadge source={m.source} />
                        </td>
                        <td className="no-print px-4 py-3 print:hidden">
                          {m.permalink ? (
                            <a
                              href={m.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex text-gray-400 transition-colors hover:text-purple-600 dark:hover:text-purple-400"
                              title="Ver publicación"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
              ~ = alcance estimado a partir de seguidores y ER (contenido sin datos de la API de Meta).
            </p>
          </section>

          {/* 5. Per-creator performance */}
          {report.creators.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Rendimiento por creador
              </h2>
              <div className="print-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        <th className="px-4 py-3">Creador</th>
                        <th className="px-4 py-3">Plataforma</th>
                        <th className="px-4 py-3 text-right">Posts</th>
                        <th className="px-4 py-3 text-right">Engagement</th>
                        <th className="px-4 py-3 text-right">ER</th>
                        <th className="px-4 py-3 text-right">Seguidores</th>
                        <th className="px-4 py-3 text-right">CPM est.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.creators.map((c, idx) => (
                        <tr
                          key={c.inf.id || c.inf.username || idx}
                          className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <Avatar
                                src={c.inf.avatarUrl}
                                name={c.inf.displayName || c.inf.username || '?'}
                                size="sm"
                              />
                              <div>
                                <p className="font-medium text-gray-900 dark:text-gray-100">
                                  @{c.inf.username || '—'}
                                </p>
                                {c.inf.displayName && (
                                  <p className="text-xs text-gray-500 dark:text-gray-400">{c.inf.displayName}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              variant={
                                c.inf.platform === 'INSTAGRAM' ? 'instagram'
                                  : c.inf.platform === 'TIKTOK' ? 'tiktok'
                                  : c.inf.platform === 'YOUTUBE' ? 'youtube'
                                  : 'default'
                              }
                            >
                              {c.inf.platform ? c.inf.platform.charAt(0) + c.inf.platform.slice(1).toLowerCase() : '—'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">{c.posts}</td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                            {formatNumber(c.engagement)}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                            {c.er !== null ? `${c.er.toFixed(2)}%` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                            {formatNumber(c.inf.followers || 0)}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                            {c.cpm !== null ? (
                              <span title={c.reachEstimated ? 'Basado en alcance estimado' : 'Basado en alcance real'}>
                                {c.cpm.toFixed(2)} €{c.reachEstimated ? ' *' : ''}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
                CPM est. = tarifa acordada / (alcance total / 1000). * indica alcance estimado.
              </p>
            </section>
          )}

          {/* 6. Data quality */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Calidad de datos
            </h2>
            <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
              <div className="mb-2 flex items-center justify-between text-xs font-medium">
                <span className="text-green-700 dark:text-green-400">
                  Meta API (real): {report.metaCount} ({report.metaPct}%)
                </span>
                <span className="text-gray-500 dark:text-gray-400">
                  Datos públicos: {report.publicCount} ({100 - report.metaPct}%)
                </span>
              </div>
              <div className="flex h-4 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                {report.metaPct > 0 && (
                  <div
                    className="print-keep h-full bg-green-500"
                    style={{ width: `${report.metaPct}%` }}
                  />
                )}
                <div
                  className="print-keep h-full bg-gray-400 dark:bg-gray-500"
                  style={{ width: `${100 - report.metaPct}%` }}
                />
              </div>
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
                El {report.metaPct}% del contenido incluye métricas reales verificadas vía Meta API; el{' '}
                {100 - report.metaPct}% restante proviene de datos públicos, por lo que su alcance se
                muestra como valor estimado.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
