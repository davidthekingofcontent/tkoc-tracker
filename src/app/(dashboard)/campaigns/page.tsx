'use client'

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatNumber, formatDate } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import { Megaphone, Users, FileText, Camera, Plus, Search, Loader2, MoreVertical, Pause, Play, Archive, Trash2, Building2 } from 'lucide-react'
import { useRole } from '@/hooks/use-role'

interface Campaign {
  id: string
  name: string
  status: string
  type: string
  isPinned: boolean
  platforms: string[]
  targetAccounts: string[]
  targetHashtags: string[]
  createdAt: string
  brandId?: string | null
  brandName?: string | null
  _count: {
    influencers: number
    media: number
  }
}

function CampaignActionMenu({
  campaign,
  onAction,
  lang,
}: {
  campaign: Campaign
  onAction: (action: string, id: string) => void
  lang: string
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const labels = {
    edit: lang === 'es' ? 'Editar' : 'Edit',
    pause: lang === 'es' ? 'Pausar' : 'Pause',
    activate: lang === 'es' ? 'Activar' : 'Activate',
    archive: lang === 'es' ? 'Archivar' : 'Archive',
    delete: lang === 'es' ? 'Eliminar' : 'Delete',
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(!open)
        }}
        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 py-1 shadow-lg">
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
              onAction('edit', campaign.id)
            }}
          >
            <FileText className="h-4 w-4" />
            {labels.edit}
          </button>
          {campaign.status === 'ACTIVE' ? (
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                onAction('pause', campaign.id)
              }}
            >
              <Pause className="h-4 w-4" />
              {labels.pause}
            </button>
          ) : campaign.status !== 'ARCHIVED' ? (
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                onAction('activate', campaign.id)
              }}
            >
              <Play className="h-4 w-4" />
              {labels.activate}
            </button>
          ) : null}
          {campaign.status !== 'ARCHIVED' && (
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                onAction('archive', campaign.id)
              }}
            >
              <Archive className="h-4 w-4" />
              {labels.archive}
            </button>
          )}
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
              onAction('delete', campaign.id)
            }}
          >
            <Trash2 className="h-4 w-4" />
            {labels.delete}
          </button>
        </div>
      )}
    </div>
  )
}

export default function CampaignsPage() {
  const { t, locale } = useI18n()
  const router = useRouter()
  const { canEdit } = useRole()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [groupByBrand, setGroupByBrand] = useState(false)

  const fetchCampaigns = useCallback(async () => {
    try {
      const res = await fetch('/api/campaigns')
      if (res.ok) {
        const data = await res.json()
        setCampaigns(data.campaigns || [])
      }
    } catch (err) {
      console.error('Error fetching campaigns:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCampaigns()
  }, [fetchCampaigns])

  const handleAction = useCallback(async (action: string, campaignId: string) => {
    switch (action) {
      case 'edit':
        router.push(`/campaigns/${campaignId}`)
        break
      case 'pause':
        await fetch(`/api/campaigns/${campaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'PAUSED' }),
        })
        fetchCampaigns()
        break
      case 'activate':
        await fetch(`/api/campaigns/${campaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ACTIVE' }),
        })
        fetchCampaigns()
        break
      case 'archive':
        await fetch(`/api/campaigns/${campaignId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'ARCHIVED' }),
        })
        fetchCampaigns()
        break
      case 'delete': {
        const confirmMsg = locale === 'es'
          ? '⚠️ BORRADO PERMANENTE\n\nEsto eliminará la campaña y TODOS sus datos:\n- Media rastreada\n- Influencers asignados\n- Brief y archivos\n- Notas y comentarios\n\n¿Estás seguro? Esta acción NO se puede deshacer.'
          : '⚠️ PERMANENT DELETE\n\nThis will delete the campaign and ALL its data:\n- Tracked media\n- Assigned influencers\n- Brief and files\n- Notes and comments\n\nAre you sure? This action CANNOT be undone.'
        if (confirm(confirmMsg)) {
          await fetch(`/api/campaigns/${campaignId}`, { method: 'DELETE' })
          fetchCampaigns()
        }
        break
      }
    }
  }, [router, fetchCampaigns, locale])

  const filteredCampaigns = useMemo(() => {
    return campaigns.filter((campaign) => {
      const matchesSearch = campaign.name.toLowerCase().includes(search.toLowerCase())
      if (activeFilter === 'all') return matchesSearch
      if (activeFilter === 'SOCIAL_LISTENING') return matchesSearch && campaign.type === 'SOCIAL_LISTENING'
      if (activeFilter === 'INFLUENCER_TRACKING') return matchesSearch && campaign.type === 'INFLUENCER_TRACKING'
      if (activeFilter === 'UGC') return matchesSearch && campaign.type === 'UGC'
      return matchesSearch && campaign.status === activeFilter.toUpperCase()
    })
  }, [campaigns, search, activeFilter])

  const groupedCampaigns = useMemo(() => {
    if (!groupByBrand) return null
    const groups: Record<string, { brandName: string; campaigns: Campaign[] }> = {}
    const noBrand: Campaign[] = []
    for (const c of filteredCampaigns) {
      if (c.brandName) {
        if (!groups[c.brandName]) {
          groups[c.brandName] = { brandName: c.brandName, campaigns: [] }
        }
        groups[c.brandName].campaigns.push(c)
      } else {
        noBrand.push(c)
      }
    }
    const sorted = Object.values(groups).sort((a, b) => a.brandName.localeCompare(b.brandName))
    if (noBrand.length > 0) {
      sorted.push({ brandName: locale === 'es' ? 'Sin marca' : 'No brand', campaigns: noBrand })
    }
    return sorted
  }, [filteredCampaigns, groupByBrand, locale])

  const stats = useMemo(() => {
    const active = campaigns.filter((c) => c.status === 'ACTIVE').length
    const profiles = campaigns.reduce((sum, c) => sum + (c._count?.influencers || 0), 0)
    const media = campaigns.reduce((sum, c) => sum + (c._count?.media || 0), 0)
    return { active, profiles, media, total: campaigns.length }
  }, [campaigns])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.campaigns.title}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t.campaigns.subtitle}
          </p>
        </div>
        {canEdit && (
          <Link href="/campaigns/new">
            <Button>
              <Plus className="h-4 w-4" />
              {t.campaigns.newCampaign}
            </Button>
          </Link>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<Megaphone className="h-5 w-5" />}
          label={t.campaigns.activeCampaigns}
          value={stats.active}
          accent
        />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={t.campaigns.profilesTracked}
          value={formatNumber(stats.profiles)}
        />
        <StatCard
          icon={<FileText className="h-5 w-5" />}
          label={t.campaigns.totalCampaigns}
          value={stats.total}
        />
        <StatCard
          icon={<Camera className="h-5 w-5" />}
          label={t.campaigns.mediaFound}
          value={formatNumber(stats.media)}
        />
      </div>

      {/* Filter Tabs + Search */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Tabs defaultValue="all" onValueChange={setActiveFilter}>
          <TabsList>
            <TabsTrigger value="all">{t.campaigns.all}</TabsTrigger>
            <TabsTrigger value="SOCIAL_LISTENING">{t.campaigns.socialListening}</TabsTrigger>
            <TabsTrigger value="INFLUENCER_TRACKING">{t.campaigns.influencerTracking}</TabsTrigger>
            <TabsTrigger value="UGC">UGC</TabsTrigger>
            <TabsTrigger value="ACTIVE">{t.common.active}</TabsTrigger>
            <TabsTrigger value="PAUSED">{t.common.paused}</TabsTrigger>
            <TabsTrigger value="ARCHIVED">{t.common.archived}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByBrand(!groupByBrand)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
              groupByBrand
                ? 'border-purple-300 bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700'
                : 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            <Building2 className="h-3.5 w-3.5" />
            {locale === 'es' ? 'Agrupar por Marca' : 'Group by Brand'}
          </button>
          <div className="w-full sm:w-72">
            <Input
              placeholder={t.campaigns.searchCampaigns}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              icon={<Search className="h-4 w-4" />}
            />
          </div>
        </div>
      </div>

      {/* Campaign Table */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
            <span className="ml-2 text-gray-500">{t.campaigns.loadingCampaigns}</span>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.campaigns.campaignNameCol}</TableHead>
                <TableHead>{t.campaigns.profiles}</TableHead>
                <TableHead>{t.campaigns.dateCreated}</TableHead>
                <TableHead>{t.campaigns.targets}</TableHead>
                <TableHead>{t.campaigns.type}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupByBrand && groupedCampaigns ? (
                <>
                  {groupedCampaigns.map((group) => (
                    <React.Fragment key={group.brandName}>
                      {/* Brand group header */}
                      <TableRow>
                        <TableCell colSpan={7} className="bg-gray-50 dark:bg-gray-700/50 py-2">
                          <div className="flex items-center gap-2">
                            <Building2 className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {group.brandName}
                            </span>
                            <span className="text-xs text-gray-400 dark:text-gray-500">
                              ({group.campaigns.length} {locale === 'es' ? 'campañas' : 'campaigns'})
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {group.campaigns.map((campaign) => (
                        <TableRow key={campaign.id}>
                          <TableCell>
                            <Link
                              href={`/campaigns/${campaign.id}`}
                              className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600 dark:hover:text-purple-400 transition-colors pl-6"
                            >
                              {campaign.isPinned ? '\uD83D\uDCCC ' : ''}{campaign.name}
                            </Link>
                          </TableCell>
                          <TableCell>{campaign._count?.influencers || 0} {t.dashboard.influencers}</TableCell>
                          <TableCell>{formatDate(campaign.createdAt)}</TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {campaign.targetHashtags.slice(0, 2).map((tag) => (
                                <Badge key={tag} variant="default">{tag}</Badge>
                              ))}
                              {campaign.targetHashtags.length > 2 && (
                                <Badge variant="default">+{campaign.targetHashtags.length - 2}</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              campaign.type === 'SOCIAL_LISTENING'
                                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                                : campaign.type === 'UGC'
                                  ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800'
                                  : 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                            }`}>
                              {campaign.type === 'UGC' ? 'UGC' : campaign.type === 'SOCIAL_LISTENING' ? t.campaigns.socialListening : t.campaigns.influencerTracking}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge variant={campaign.status.toLowerCase() as 'active' | 'paused' | 'archived'}>
                              {campaign.status === 'ACTIVE' ? t.common.active : campaign.status === 'PAUSED' ? t.common.paused : t.common.archived}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {canEdit && (
                              <CampaignActionMenu
                                campaign={campaign}
                                onAction={handleAction}
                                lang={locale}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </React.Fragment>
                  ))}
                </>
              ) : (
                <>
                  {filteredCampaigns.map((campaign) => (
                    <TableRow key={campaign.id}>
                      <TableCell>
                        <Link
                          href={`/campaigns/${campaign.id}`}
                          className="font-medium text-gray-900 dark:text-gray-100 hover:text-purple-600 dark:hover:text-purple-400 transition-colors"
                        >
                          {campaign.isPinned ? '\uD83D\uDCCC ' : ''}{campaign.name}
                        </Link>
                      </TableCell>
                      <TableCell>{campaign._count?.influencers || 0} {t.dashboard.influencers}</TableCell>
                      <TableCell>{formatDate(campaign.createdAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {campaign.targetHashtags.slice(0, 2).map((tag) => (
                            <Badge key={tag} variant="default">{tag}</Badge>
                          ))}
                          {campaign.targetHashtags.length > 2 && (
                            <Badge variant="default">+{campaign.targetHashtags.length - 2}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          campaign.type === 'SOCIAL_LISTENING'
                            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800'
                            : campaign.type === 'UGC'
                              ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800'
                              : 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                        }`}>
                          {campaign.type === 'UGC' ? 'UGC' : campaign.type === 'SOCIAL_LISTENING' ? t.campaigns.socialListening : t.campaigns.influencerTracking}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={campaign.status.toLowerCase() as 'active' | 'paused' | 'archived'}>
                          {campaign.status === 'ACTIVE' ? t.common.active : campaign.status === 'PAUSED' ? t.common.paused : t.common.archived}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {canEdit && (
                          <CampaignActionMenu
                            campaign={campaign}
                            onAction={handleAction}
                            lang={locale}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              )}
              {filteredCampaigns.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12">
                    <p className="text-gray-500">
                      {campaigns.length === 0 ? t.campaigns.noCampaignsDesc : t.campaigns.noCampaigns}
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
