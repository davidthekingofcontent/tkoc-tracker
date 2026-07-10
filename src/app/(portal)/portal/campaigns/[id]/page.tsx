'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { formatNumber, cn } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'
import {
  Loader2,
  ArrowLeft,
  FileText,
  Calendar,
  Users,
  Image as ImageIcon,
  Heart,
  MessageCircle,
  Eye,
  ExternalLink,
  ShieldCheck,
  Instagram,
  Youtube,
  Music2,
  Globe,
  CheckCircle2,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Brand portal — campaign detail (read-only, client-facing).
// Data: GET /api/portal/campaigns/[id]?mediaLimit&mediaOffset (parallel task;
// parsed defensively). NO economic data exists in this response by design —
// never render fee/budget UI here.
// ---------------------------------------------------------------------------

interface PortalInfluencer {
  id?: string
  username?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  platform?: string | null
  followers?: number | null
  engagementRate?: number | null
}

interface PortalMember {
  status?: string | null
  contentDelivered?: boolean | null
  influencer?: PortalInfluencer | null
}

interface PortalMedia {
  id: string
  mediaType?: string | null
  caption?: string | null
  thumbnailUrl?: string | null
  permalink?: string | null
  likes?: number | null
  comments?: number | null
  views?: number | null
  reach?: number | null
  source?: string | null
  postedAt?: string | null
  influencer?: {
    username?: string | null
    avatarUrl?: string | null
  } | null
}

interface PortalCampaignDetail {
  id?: string
  name?: string
  status?: string
  startDate?: string | null
  endDate?: string | null
  platforms?: string[]
  influencers?: PortalMember[]
  media?: PortalMedia[]
}

const MEDIA_PAGE = 100

// --- Client-friendly Spanish mapping for ALL InfluencerStatus enum values
// (prisma: PROSPECT, OUTREACH, NEGOTIATING, AGREED, CONTRACTED, SHIPPING,
// POSTED, COMPLETED) plus defensive aliases the API might normalize to.
function influencerStatusChip(status?: string | null): { label: string; className: string } {
  const gray = 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:border-gray-600'
  const blue = 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800'
  const yellow = 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800'
  const purple = 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-800'
  const cyan = 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-400 dark:border-cyan-800'
  const emerald = 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800'
  const green = 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800'
  const red = 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800'

  switch ((status || '').toUpperCase()) {
    case 'PROSPECT': return { label: 'Propuesto', className: gray }
    case 'OUTREACH':
    case 'INVITED':
    case 'CONTACTED': return { label: 'Contactado', className: blue }
    case 'NEGOTIATING': return { label: 'En conversación', className: yellow }
    case 'AGREED':
    case 'ACCEPTED':
    case 'CONFIRMED':
    case 'CONTRACTED': return { label: 'Confirmado', className: purple }
    case 'SHIPPING': return { label: 'Producto enviado', className: cyan }
    case 'DELIVERED': return { label: 'Contenido entregado', className: emerald }
    case 'POSTED':
    case 'PUBLISHED': return { label: 'Publicado', className: green }
    case 'COMPLETED': return { label: 'Completado', className: green }
    case 'REJECTED':
    case 'DECLINED': return { label: 'Descartado', className: red }
    default: return { label: status || '—', className: gray }
  }
}

function campaignStatusInfo(status?: string): { variant: 'active' | 'paused' | 'archived' | 'default'; label: string } {
  switch (status) {
    case 'ACTIVE': return { variant: 'active', label: 'Activa' }
    case 'PAUSED': return { variant: 'paused', label: 'Pausada' }
    case 'COMPLETED': return { variant: 'archived', label: 'Completada' }
    case 'DRAFT': return { variant: 'default', label: 'En preparación' }
    case 'ARCHIVED': return { variant: 'archived', label: 'Archivada' }
    default: return { variant: 'default', label: status || '—' }
  }
}

function mediaTypeLabel(type?: string | null): string {
  switch ((type || '').toUpperCase()) {
    case 'REEL': return 'Reel'
    case 'VIDEO': return 'Vídeo'
    case 'IMAGE':
    case 'PHOTO': return 'Imagen'
    case 'CAROUSEL':
    case 'SIDECAR': return 'Carrusel'
    case 'STORY': return 'Story'
    default: return type || 'Contenido'
  }
}

function formatDate(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('es-ES')
}

function PlatformIcon({ platform }: { platform?: string | null }) {
  switch ((platform || '').toUpperCase()) {
    case 'INSTAGRAM':
      return <Instagram className="h-4 w-4 text-pink-600 dark:text-pink-400" aria-label="Instagram" />
    case 'TIKTOK':
      return <Music2 className="h-4 w-4 text-cyan-600 dark:text-cyan-400" aria-label="TikTok" />
    case 'YOUTUBE':
      return <Youtube className="h-4 w-4 text-red-600 dark:text-red-400" aria-label="YouTube" />
    default:
      return <Globe className="h-4 w-4 text-gray-400" aria-label={platform || 'Plataforma'} />
  }
}

function MediaCardThumb({ src, alt }: { src?: string | null; alt: string }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
  if (!url || error) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-t-xl bg-gray-100 dark:bg-gray-800">
        <ImageIcon className="h-8 w-8 text-gray-300 dark:text-gray-600" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="aspect-square w-full rounded-t-xl object-cover"
      onError={() => setError(true)}
    />
  )
}

export default function PortalCampaignPage() {
  const params = useParams()
  const campaignId = params.id as string

  const [campaign, setCampaign] = useState<PortalCampaignDetail | null>(null)
  const [media, setMedia] = useState<PortalMedia[]>([])
  const [hasMoreMedia, setHasMoreMedia] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const fetchPage = useCallback(async (offset: number): Promise<{ campaign: PortalCampaignDetail | null; media: PortalMedia[] }> => {
    const res = await fetch(`/api/portal/campaigns/${campaignId}?mediaLimit=${MEDIA_PAGE}&mediaOffset=${offset}`)
    if (!res.ok) return { campaign: null, media: [] }
    const data = await res.json()
    return {
      campaign: data?.campaign || null,
      media: data?.campaign?.media || [],
    }
  }, [campaignId])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const page = await fetchPage(0)
        if (cancelled) return
        setCampaign(page.campaign)
        setMedia(page.media)
        setHasMoreMedia(page.media.length >= MEDIA_PAGE)
      } catch (err) {
        console.error('Error fetching portal campaign:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [fetchPage])

  const loadMore = async () => {
    setIsLoadingMore(true)
    try {
      const page = await fetchPage(media.length)
      setMedia(prev => prev.concat(page.media))
      setHasMoreMedia(page.media.length >= MEDIA_PAGE)
    } catch (err) {
      console.error('Error fetching more portal media:', err)
    } finally {
      setIsLoadingMore(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500 dark:text-gray-400">Cargando campaña...</span>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500 dark:text-gray-400">No se encontró la campaña</p>
        <Link href="/portal" className="mt-4 inline-block text-purple-600 hover:underline dark:text-purple-400">
          Volver al portal
        </Link>
      </div>
    )
  }

  const status = campaignStatusInfo(campaign.status)
  const dateRange = [formatDate(campaign.startDate), formatDate(campaign.endDate)]
    .filter(Boolean)
    .join(' — ')
  const team = (campaign.influencers || []).filter(m => m?.influencer)

  return (
    <div className="space-y-8">
      {/* a. Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/portal"
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-400"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Volver al portal
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {campaign.name || 'Campaña'}
            </h1>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          {(dateRange || (campaign.platforms?.length || 0) > 0) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              {dateRange && (
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {dateRange}
                </span>
              )}
              {(campaign.platforms?.length || 0) > 0 && (
                <>
                  {dateRange && <span>&middot;</span>}
                  <span>
                    {(campaign.platforms || [])
                      .map(p => p.charAt(0) + p.slice(1).toLowerCase())
                      .join(', ')}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <Link href={`/portal/campaigns/${campaignId}/report`}>
          <Button variant="primary" size="sm">
            <FileText className="h-4 w-4" />
            Ver informe completo
          </Button>
        </Link>
      </div>

      {/* b. Equipo de creadores */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <Users className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          Equipo de creadores
        </h2>
        {team.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
            <Users className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Aún no hay creadores asignados a esta campaña.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-4 py-3">Creador</th>
                    <th className="px-4 py-3">Plataforma</th>
                    <th className="px-4 py-3 text-right">Seguidores</th>
                    <th className="px-4 py-3 text-right">ER</th>
                    <th className="px-4 py-3">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((member, idx) => {
                    const inf = member.influencer as PortalInfluencer
                    const chip = influencerStatusChip(member.status)
                    return (
                      <tr
                        key={inf.id || inf.username || idx}
                        className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Avatar
                              src={inf.avatarUrl}
                              name={inf.displayName || inf.username || '?'}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <p className="truncate font-medium text-gray-900 dark:text-gray-100">
                                @{inf.username || '—'}
                              </p>
                              {inf.displayName && (
                                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                                  {inf.displayName}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                            <PlatformIcon platform={inf.platform} />
                            <span className="text-xs">
                              {inf.platform
                                ? inf.platform.charAt(0) + inf.platform.slice(1).toLowerCase()
                                : '—'}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {typeof inf.followers === 'number' ? formatNumber(inf.followers) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
                          {typeof inf.engagementRate === 'number' && inf.engagementRate > 0
                            ? `${inf.engagementRate.toFixed(2)}%`
                            : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className={cn(
                                'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                                chip.className
                              )}
                            >
                              {chip.label}
                            </span>
                            {member.contentDelivered && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400"
                                title="Contenido entregado"
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Contenido entregado
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* c. Contenido capturado */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <ImageIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          Contenido capturado
        </h2>
        {media.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white py-12 text-center dark:border-gray-700 dark:bg-gray-900">
            <ImageIcon className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Aún no hay contenido publicado. En cuanto los creadores publiquen, aparecerá aquí.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {media.map(m => (
                <div
                  key={m.id}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900"
                >
                  <div className="relative">
                    <MediaCardThumb src={m.thumbnailUrl} alt={m.caption || 'Contenido'} />
                    <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
                      {mediaTypeLabel(m.mediaType)}
                    </span>
                    {m.source === 'meta_api' && (
                      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:border-green-800 dark:bg-green-900/80 dark:text-green-400">
                        <ShieldCheck className="h-3 w-3" />
                        Datos verificados
                      </span>
                    )}
                  </div>
                  <div className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar
                          src={m.influencer?.avatarUrl}
                          name={m.influencer?.username || '?'}
                          size="sm"
                          className="h-6 w-6 text-[10px]"
                        />
                        <span className="truncate text-xs font-medium text-purple-600 dark:text-purple-400">
                          @{m.influencer?.username || 'desconocido'}
                        </span>
                      </div>
                      {m.permalink && (
                        <a
                          href={m.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 text-gray-400 transition-colors hover:text-purple-600 dark:hover:text-purple-400"
                          title="Ver publicación"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                    {m.caption && (
                      <p className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{m.caption}</p>
                    )}
                    <div className="flex items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
                      <span className="inline-flex items-center gap-1">
                        <Heart className="h-3 w-3" />
                        {formatNumber(m.likes || 0)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <MessageCircle className="h-3 w-3" />
                        {formatNumber(m.comments || 0)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3 w-3" />
                        {m.views ? formatNumber(m.views) : '—'}
                      </span>
                    </div>
                    {m.postedAt && (
                      <p className="text-[10px] text-gray-400 dark:text-gray-500">{formatDate(m.postedAt)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {hasMoreMedia && (
              <div className="mt-4 text-center">
                <Button variant="secondary" size="sm" onClick={loadMore} loading={isLoadingMore}>
                  Cargar más contenido
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
