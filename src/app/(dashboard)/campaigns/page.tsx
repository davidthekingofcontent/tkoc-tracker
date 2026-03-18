'use client'

import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
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
import { Megaphone, Users, FileText, Camera, Plus, Search, Loader2 } from 'lucide-react'

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

export default function CampaignsPage() {
  const { t } = useI18n()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')

  useEffect(() => {
    async function fetchCampaigns() {
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
    }
    fetchCampaigns()
  }, [])

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
                </TableRow>
              ))}
              {filteredCampaigns.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12">
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
