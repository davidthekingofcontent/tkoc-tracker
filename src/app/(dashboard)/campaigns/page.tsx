'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
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
import { Megaphone, Users, FileText, Camera, Plus, Search, Loader2, MoreVertical, Pause, Play, Archive, Trash2 } from 'lucide-react'

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
        className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
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
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
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
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
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
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
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
          <div className="my-1 border-t border-gray-100" />
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')

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
          ? 'Estas seguro de que quieres eliminar esta campana?'
          : 'Are you sure you want to delete this campaign?'
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
      return matchesSearch && campaign.status === activeFilter.toUpperCase()
    })
  }, [campaigns, search, activeFilter])

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
          <h1 className="text-2xl font-bold text-gray-900">{t.campaigns.title}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t.campaigns.subtitle}
          </p>
        </div>
        <Link href="/campaigns/new">
          <Button>
            <Plus className="h-4 w-4" />
            {t.campaigns.newCampaign}
          </Button>
        </Link>
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
            <TabsTrigger value="ACTIVE">{t.common.active}</TabsTrigger>
            <TabsTrigger value="PAUSED">{t.common.paused}</TabsTrigger>
            <TabsTrigger value="ARCHIVED">{t.common.archived}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="w-full sm:w-72">
          <Input
            placeholder={t.campaigns.searchCampaigns}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search className="h-4 w-4" />}
          />
        </div>
      </div>

      {/* Campaign Table */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
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
              {filteredCampaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell>
                    <Link
                      href={`/campaigns/${campaign.id}`}
                      className="font-medium text-gray-900 hover:text-purple-600 transition-colors"
                    >
                      {campaign.isPinned ? '📌 ' : ''}{campaign.name}
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
                    <span className="text-sm text-gray-500">
                      {campaign.type === 'SOCIAL_LISTENING' ? t.campaigns.socialListening : t.campaigns.influencerTracking}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={campaign.status.toLowerCase() as 'active' | 'paused' | 'archived'}>
                      {campaign.status === 'ACTIVE' ? t.common.active : campaign.status === 'PAUSED' ? t.common.paused : t.common.archived}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <CampaignActionMenu
                      campaign={campaign}
                      onAction={handleAction}
                      lang={locale}
                    />
                  </TableCell>
                </TableRow>
              ))}
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
