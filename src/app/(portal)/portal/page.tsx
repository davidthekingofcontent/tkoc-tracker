'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { formatNumber } from '@/lib/utils'
import {
  Loader2,
  Megaphone,
  Users,
  Image as ImageIcon,
  Heart,
  Eye,
  Calendar,
  ChevronRight,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Brand portal home — read-only dashboard for a client (BRAND) user.
// Data: GET /api/portal/overview, whose figures come from the SAME server
// computation as the portal campaign page and the report
// (computeCampaignOverview, with the media/creators the agency hid from this
// client already excluded). Nothing is re-derived here: "Interacciones" is
// metrics.engagements (likes + comentarios + shares + saves), never a local
// sum. NO economic data exists in this response by design (no cost, no ratio).
//
// Agency preview: an ADMIN/EMPLOYEE opening /portal has no brand of their own,
// so the page shows a brand selector (GET /api/brands) and asks the overview
// for that brand with ?brandId= (the API accepts it for the agency). BRAND
// users never see the selector — their scope is resolved server-side.
// ---------------------------------------------------------------------------

interface PortalCampaign {
  id: string
  name?: string
  status?: string
  startDate?: string | null
  endDate?: string | null
  platforms?: string[]
  counts?: {
    influencers?: number
    creatorsActive?: number
    media?: number
    mediaDeleted?: number
  } | null
  metrics?: {
    likes?: number
    comments?: number
    shares?: number
    saves?: number
    views?: number
    /** Interacciones = likes + comentarios + shares + saves (from the overview). */
    engagements?: number
    /** @deprecated alias of engagements kept by the API */
    interactions?: number
    /** Audiencia real only — estimates never reach the client. */
    audience?: {
      real?: number
      realPieces?: number
    }
    /** Tasa de engagement sobre vistas (4B); null when the real sample is insufficient. */
    engagementRate?: number | null
    engagementRateReason?: 'no_real_base' | 'insufficient_sample' | 'implausible' | null
  } | null
}

interface PortalOverview {
  brandName?: string
  brandLogo?: string | null
  campaigns?: PortalCampaign[]
}

interface BrandOption {
  id: string
  name: string
}

// Only ADMIN: /api/portal/overview answers 403 to any other agency role and honours ?brandId= for ADMIN alone
const AGENCY_ROLES = ['ADMIN']

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

function formatDate(value?: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('es-ES')
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg bg-gray-50 p-2.5 dark:bg-gray-800/60">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400">
        <Icon className="h-3 w-3 text-purple-600 dark:text-purple-400" />
        {label}
      </div>
      <p className="mt-1 text-sm font-bold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  )
}

export default function PortalHomePage() {
  // null until /api/auth/me answers; agency users get the brand selector
  const [isAgency, setIsAgency] = useState<boolean | null>(null)
  const [brands, setBrands] = useState<BrandOption[] | null>(null)
  const [selectedBrandId, setSelectedBrandId] = useState('')
  // The overview loaded for a given request key ('own' for BRAND users, the
  // brandId for the agency preview). Loading is derived: the key we want is
  // not the key we have.
  const [result, setResult] = useState<{ key: string; overview: PortalOverview | null; error: string | null } | null>(null)

  // 1) Who is looking? BRAND → own scope; ADMIN/EMPLOYEE → brand selector.
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then(res => (res.ok ? res.json() : null))
      .then(async (data: { user?: { role?: string } } | null) => {
        if (cancelled) return
        const agency = AGENCY_ROLES.includes(data?.user?.role || '')
        setIsAgency(agency)
        if (!agency) return
        let list: BrandOption[] = []
        try {
          const res = await fetch('/api/brands')
          const body = res.ok ? await res.json() : null
          list = Array.isArray(body?.brands)
            ? body.brands.map((b: { id: string; name: string }) => ({ id: b.id, name: b.name }))
            : []
        } catch {
          list = []
        }
        if (cancelled) return
        setBrands(list)
        if (list.length > 0) setSelectedBrandId(list[0].id)
      })
      .catch(() => {
        if (!cancelled) setIsAgency(false)
      })
    return () => { cancelled = true }
  }, [])

  const requestKey: string | null =
    isAgency === null ? null : isAgency ? (selectedBrandId || null) : 'own'

  // 2) Overview — for the agency it waits for a brand and passes ?brandId=.
  useEffect(() => {
    if (!requestKey) return
    let cancelled = false
    const url = requestKey === 'own'
      ? '/api/portal/overview'
      : `/api/portal/overview?brandId=${encodeURIComponent(requestKey)}`
    fetch(url)
      .then(async res => {
        if (res.ok) {
          const data = (await res.json()) as PortalOverview
          return { overview: data, error: null }
        }
        const body = await res.json().catch(() => null)
        const error = requestKey === 'own'
          ? null
          : body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`
        return { overview: null, error }
      })
      .catch(() => ({ overview: null, error: null }))
      .then(({ overview, error }) => {
        if (!cancelled) setResult({ key: requestKey, overview, error })
      })
    return () => { cancelled = true }
  }, [requestKey])

  const agencyWithoutBrands = isAgency === true && brands !== null && brands.length === 0
  const isLoading = !agencyWithoutBrands && (requestKey === null || result?.key !== requestKey)
  const overview = result?.key === requestKey ? result.overview : null
  const previewError = result?.key === requestKey ? result.error : null

  const brandSelector = isAgency ? (
    <div className="flex flex-col gap-2 rounded-xl border border-dashed border-purple-300 bg-purple-50/60 p-4 dark:border-purple-800 dark:bg-purple-900/10 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-purple-900 dark:text-purple-200">Vista previa del portal de cliente</p>
        <p className="text-xs text-purple-700/80 dark:text-purple-300/80">
          Estás viendo el portal como lo ve la marca seleccionada.
        </p>
      </div>
      {brands && brands.length > 0 ? (
        <select
          value={selectedBrandId}
          onChange={e => setSelectedBrandId(e.target.value)}
          aria-label="Marca"
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          {brands.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      ) : (
        <span className="text-sm text-gray-500 dark:text-gray-400">No hay marcas disponibles.</span>
      )}
    </div>
  ) : null

  if (isLoading) {
    return (
      <div className="space-y-6">
        {brandSelector}
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
          <span className="ml-3 text-gray-500 dark:text-gray-400">Cargando tu portal...</span>
        </div>
      </div>
    )
  }

  const campaigns = overview?.campaigns || []

  return (
    <div className="space-y-6">
      {brandSelector}

      {previewError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          No se pudo cargar la vista previa: {previewError}
        </div>
      )}

      {/* Welcome header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {overview?.brandName ? `Hola, ${overview.brandName}` : 'Bienvenido a tu portal'}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Aquí puedes seguir en tiempo real el estado de tus campañas de influencer marketing.
        </p>
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-900">
          <Megaphone className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" />
          <p className="mt-4 font-medium text-gray-900 dark:text-gray-100">
            Tu agencia aún no te ha asignado campañas
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            En cuanto haya una campaña activa para tu marca, aparecerá aquí.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map(campaign => {
            const status = campaignStatusInfo(campaign.status)
            const dateRange = [formatDate(campaign.startDate), formatDate(campaign.endDate)]
              .filter(Boolean)
              .join(' — ')
            // Interacciones come straight from the overview (decision 3A); the
            // legacy `interactions` alias carries the same value.
            const engagements =
              campaign.metrics?.engagements ?? campaign.metrics?.interactions ?? 0
            return (
              <Link
                key={campaign.id}
                href={`/portal/campaigns/${campaign.id}`}
                className="group rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition-all hover:border-purple-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-900 dark:hover:border-purple-700"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold text-gray-900 group-hover:text-purple-700 dark:text-gray-100 dark:group-hover:text-purple-300">
                      {campaign.name || 'Campaña'}
                    </h2>
                    {dateRange && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                        <Calendar className="h-3 w-3 shrink-0" />
                        {dateRange}
                      </p>
                    )}
                  </div>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </div>

                {(campaign.platforms?.length || 0) > 0 && (
                  <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                    {(campaign.platforms || [])
                      .map(p => p.charAt(0) + p.slice(1).toLowerCase())
                      .join(' · ')}
                  </p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <MiniStat icon={Users} label="Creadores" value={formatNumber(campaign.counts?.influencers || 0)} />
                  <MiniStat icon={ImageIcon} label="Contenidos" value={formatNumber(campaign.counts?.media || 0)} />
                  <MiniStat icon={Heart} label="Interacciones" value={formatNumber(engagements)} />
                  <MiniStat icon={Eye} label="Vistas" value={formatNumber(campaign.metrics?.views || 0)} />
                </div>

                <div className="mt-4 flex items-center justify-end text-xs font-medium text-purple-600 dark:text-purple-400">
                  Ver campaña
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
