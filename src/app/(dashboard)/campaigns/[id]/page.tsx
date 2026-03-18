'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Avatar } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { formatNumber, formatCurrency } from '@/lib/utils'
import { useI18n } from '@/i18n/context'
import {
  ArrowLeft,
  Users,
  Image,
  Eye,
  BarChart3,
  Heart,
  TrendingUp,
  Loader2,
  Instagram,
  Youtube,
  Twitter,
  Download,
} from 'lucide-react'

interface CampaignInfluencer {
  id: string
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
    engagementRate: number | null
    avgLikes: number | null
    avgComments: number | null
    avgViews: number | null
  }
}

interface CampaignMedia {
  id: string
  mediaType: string
  likes: number | null
  comments: number | null
  shares: number | null
  views: number | null
  reach: number | null
  postedAt: string | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
  }
}

interface CampaignData {
  id: string
  name: string
  type: string
  status: string
  platforms: string[]
  targetAccounts: string[]
  targetHashtags: string[]
  influencers: CampaignInfluencer[]
  media: CampaignMedia[]
}

interface Overview {
  totalReach: number
  totalImpressions: number
  totalEngagements: number
  engagementRate: number
  mediaValue: number
  totalViews: number
  profilesPosted: number
  totalMedia: number
}

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-3.5 w-3.5" />
    case 'YOUTUBE': return <Youtube className="h-3.5 w-3.5" />
    case 'TIKTOK': return <Twitter className="h-3.5 w-3.5" />
    default: return null
  }
}

const platformBadge = (platform: string) => {
  switch (platform) {
    case 'INSTAGRAM': return 'instagram' as const
    case 'YOUTUBE': return 'youtube' as const
    case 'TIKTOK': return 'tiktok' as const
    default: return 'default' as const
  }
}

export default function CampaignDetailPage() {
  const params = useParams()
  const { t } = useI18n()
  const campaignId = params.id as string
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchCampaign() {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}`)
        if (res.ok) {
          const data = await res.json()
          setCampaign(data.campaign)
          setOverview(data.overview)
        }
      } catch (err) {
        console.error('Error fetching campaign:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchCampaign()
  }, [campaignId])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500">{t.common.loading}</span>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500">{t.common.noResults}</p>
        <Link href="/campaigns" className="mt-4 text-purple-600 hover:underline">
          {t.common.back}
        </Link>
      </div>
    )
  }

  const influencers = campaign.influencers || []
  const media = campaign.media || []

  // Compute stats from influencer data when no media exists yet
  const totalReach = overview?.totalReach || influencers.reduce((s, ci) => s + (ci.influencer.followers || 0), 0)
  const totalEngagements = overview?.totalEngagements || 0
  const totalMedia = overview?.totalMedia || 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/campaigns">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              {t.common.back}
            </Button>
          </Link>
          <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{campaign.name}</h1>
            <Badge variant={campaign.status === 'ACTIVE' ? 'active' : campaign.status === 'PAUSED' ? 'paused' : 'archived'}>
              {campaign.status === 'ACTIVE' ? t.common.active : campaign.status === 'PAUSED' ? t.common.paused : t.common.archived}
            </Badge>
          </div>
          <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
            <span>{campaign.type === 'INFLUENCER_TRACKING' ? t.campaigns.influencerTracking : t.campaigns.socialListening}</span>
            <span>&middot;</span>
            <span>{campaign.platforms.map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(', ')}</span>
          </div>
        </div>
        </div>
        <a href={`/api/campaigns/${campaign.id}/export?format=csv`} download>
          <Button variant="secondary" size="sm">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </a>
      </div>

      {/* Tracking info */}
      {(campaign.targetAccounts.length > 0 || campaign.targetHashtags.length > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-4">
            {campaign.targetAccounts.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingAccounts}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {campaign.targetAccounts.map(a => (
                    <Badge key={a} variant="default">{a}</Badge>
                  ))}
                </div>
              </div>
            )}
            {campaign.targetHashtags.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingHashtags}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {campaign.targetHashtags.map(h => (
                    <Badge key={h} variant="default">{h}</Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue="report">
        <TabsList>
          <TabsTrigger value="report">{t.campaigns.report}</TabsTrigger>
          <TabsTrigger value="media">{t.campaigns.mediaTab} ({totalMedia})</TabsTrigger>
          <TabsTrigger value="influencers">{t.campaigns.influencersTab} ({influencers.length})</TabsTrigger>
        </TabsList>

        {/* Report Tab */}
        <TabsContent value="report">
          <div className="space-y-6">
            <div>
              <h2 className="mb-4 text-lg font-semibold text-gray-900">{t.campaignDetail.overview}</h2>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard
                  icon={<Users className="h-5 w-5" />}
                  label={t.dashboard.influencers}
                  value={influencers.length}
                  accent
                />
                <StatCard
                  icon={<Image className="h-5 w-5" />}
                  label={t.dashboard.media}
                  value={totalMedia}
                />
                <StatCard
                  icon={<Eye className="h-5 w-5" />}
                  label={t.dashboard.totalReach}
                  value={formatNumber(totalReach)}
                />
                <StatCard
                  icon={<Heart className="h-5 w-5" />}
                  label={t.campaigns.engagement}
                  value={formatNumber(totalEngagements)}
                />
              </div>
            </div>

            {/* Influencer Overview Table */}
            <Card variant="elevated">
              <CardHeader>
                <CardTitle>{t.dashboard.influencers}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.dashboard.influencers}</TableHead>
                      <TableHead>{t.campaigns.platform}</TableHead>
                      <TableHead>{t.campaigns.followers}</TableHead>
                      <TableHead>{t.campaigns.engagement}</TableHead>
                      <TableHead>{t.campaignDetail.avgLikes}</TableHead>
                      <TableHead>{t.campaignDetail.avgComments}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {influencers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-12 text-center text-gray-500">
                          {t.common.noResults}
                        </TableCell>
                      </TableRow>
                    ) : (
                      influencers.map((ci) => (
                        <TableRow key={ci.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Avatar name={ci.influencer.displayName || ci.influencer.username} size="sm" />
                              <div>
                                <p className="font-medium text-gray-900">
                                  {ci.influencer.displayName || ci.influencer.username}
                                </p>
                                <p className="text-xs text-gray-500">@{ci.influencer.username}</p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={platformBadge(ci.influencer.platform)}>
                              <PlatformIcon platform={ci.influencer.platform} />
                              {ci.influencer.platform.charAt(0) + ci.influencer.platform.slice(1).toLowerCase()}
                            </Badge>
                          </TableCell>
                          <TableCell>{formatNumber(ci.influencer.followers)}</TableCell>
                          <TableCell>
                            <span className="text-purple-600">
                              {ci.influencer.engagementRate || 0}%
                            </span>
                          </TableCell>
                          <TableCell>{formatNumber(ci.influencer.avgLikes || 0)}</TableCell>
                          <TableCell>{formatNumber(ci.influencer.avgComments || 0)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Media Tab */}
        <TabsContent value="media">
          {media.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <Image className="mx-auto h-12 w-12 text-gray-300" />
              <p className="mt-4 text-gray-500">{t.common.noResults}</p>
              <p className="mt-1 text-sm text-gray-400">
                {t.campaignDetail.mediaEmptyDesc}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {media.map((m) => (
                <div
                  key={m.id}
                  className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
                >
                  <div className="relative flex h-48 items-center justify-center bg-gray-100">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <Image className="h-8 w-8" />
                      <span className="text-xs">{m.mediaType}</span>
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="flex items-center gap-2">
                      <Avatar name={m.influencer.displayName || m.influencer.username} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">
                          {m.influencer.displayName || m.influencer.username}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Heart className="h-3 w-3" />
                        {formatNumber(m.likes || 0)}
                      </span>
                      <span className="flex items-center gap-1">
                        <BarChart3 className="h-3 w-3" />
                        {formatNumber(m.comments || 0)}
                      </span>
                      <span className="flex items-center gap-1">
                        <TrendingUp className="h-3 w-3" />
                        {formatNumber(m.shares || 0)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Influencers Tab */}
        <TabsContent value="influencers">
          <Card variant="elevated">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.dashboard.influencers}</TableHead>
                    <TableHead>{t.campaigns.platform}</TableHead>
                    <TableHead>{t.campaigns.followers}</TableHead>
                    <TableHead>{t.campaigns.engagement}</TableHead>
                    <TableHead>{t.campaignDetail.avgLikes}</TableHead>
                    <TableHead>{t.campaignDetail.avgComments}</TableHead>
                    <TableHead>{t.campaignDetail.avgViews}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {influencers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-12 text-center text-gray-500">
                        {t.common.noResults}
                      </TableCell>
                    </TableRow>
                  ) : (
                    influencers.map((ci) => (
                      <TableRow key={ci.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar name={ci.influencer.displayName || ci.influencer.username} size="sm" />
                            <div>
                              <p className="font-medium text-gray-900">
                                {ci.influencer.displayName || ci.influencer.username}
                              </p>
                              <p className="text-xs text-gray-500">@{ci.influencer.username}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={platformBadge(ci.influencer.platform)}>
                            <PlatformIcon platform={ci.influencer.platform} />
                            {ci.influencer.platform.charAt(0) + ci.influencer.platform.slice(1).toLowerCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatNumber(ci.influencer.followers)}</TableCell>
                        <TableCell>
                          <span className="text-purple-600">{ci.influencer.engagementRate || 0}%</span>
                        </TableCell>
                        <TableCell>{formatNumber(ci.influencer.avgLikes || 0)}</TableCell>
                        <TableCell>{formatNumber(ci.influencer.avgComments || 0)}</TableCell>
                        <TableCell>{formatNumber(ci.influencer.avgViews || 0)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
