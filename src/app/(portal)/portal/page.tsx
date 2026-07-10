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
// Data: GET /api/portal/overview (built by a parallel task; parsed defensively).
// NO economic data exists in this response by design.
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
    media?: number
  }
  metrics?: {
    likes?: number
    comments?: number
    views?: number
    interactions?: number
  }
}

interface PortalOverview {
  brandName?: string
  brandLogo?: string | null
  campaigns?: PortalCampaign[]
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
  const [overview, setOverview] = useState<PortalOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/overview')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!cancelled && data) setOverview(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500 dark:text-gray-400">Cargando tu portal...</span>
      </div>
    )
  }

  const campaigns = overview?.campaigns || []

  return (
    <div className="space-y-6">
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
            // Interactions shown to the brand = likes + comments (views has
            // its own tile, so we don't reuse metrics.interactions which
            // also includes views).
            const interactions =
              (campaign.metrics?.likes || 0) + (campaign.metrics?.comments || 0)
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
                  <MiniStat icon={Heart} label="Interacciones" value={formatNumber(interactions)} />
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
