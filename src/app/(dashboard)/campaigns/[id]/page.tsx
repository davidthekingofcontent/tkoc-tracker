'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
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
import { formatNumber } from '@/lib/utils'
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
  Download,
  Radar,
  CheckCircle2,
  AlertCircle,
  X,
  ChevronUp,
  ChevronDown,
  Plus,
  UserPlus,
  Clock,
  Film,
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
  caption: string | null
  thumbnailUrl: string | null
  permalink: string | null
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
  startDate: string | null
  endDate: string | null
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

interface TimelinePoint {
  date: string
  posts: number
  likes: number
  comments: number
  views: number
  reach: number
  engagements: number
}

// Dynamic import for Recharts (client-side only)
const RechartsArea = dynamic(
  () => import('recharts').then(mod => {
    const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = mod
    return function ChartWrapper({ data, title, dataKeys }: {
      data: TimelinePoint[]
      title: string
      dataKeys: { key: string; color: string; name: string }[]
    }) {
      return (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-700">{title}</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <defs>
                {dataKeys.map(dk => (
                  <linearGradient key={dk.key} id={`grad_${dk.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={dk.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={dk.color} stopOpacity={0} />
                  </linearGradient>
                ))}
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
              <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={(v: number) => {
                if (v >= 1000000) return `${(v/1000000).toFixed(1)}M`
                if (v >= 1000) return `${(v/1000).toFixed(1)}K`
                return v.toString()
              }} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,.1)',
                  fontSize: '12px',
                }}
                labelFormatter={(v) => new Date(String(v)).toLocaleDateString()}
                formatter={(value) => {
                  const num = Number(value)
                  if (num >= 1000000) return [`${(num/1000000).toFixed(1)}M`, '']
                  if (num >= 1000) return [`${(num/1000).toFixed(1)}K`, '']
                  return [num.toString(), '']
                }}
              />
              <Legend wrapperStyle={{ fontSize: '11px' }} />
              {dataKeys.map(dk => (
                <Area
                  key={dk.key}
                  type="monotone"
                  dataKey={dk.key}
                  name={dk.name}
                  stroke={dk.color}
                  strokeWidth={2}
                  fill={`url(#grad_${dk.key})`}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )
    }
  }),
  { ssr: false, loading: () => <div className="h-[300px] rounded-xl border border-gray-200 bg-white animate-pulse" /> }
)

type SortField = 'followers' | 'engagement'
type SortDirection = 'asc' | 'desc'

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-3.5 w-3.5" />
    case 'YOUTUBE': return <Youtube className="h-3.5 w-3.5" />
    case 'TIKTOK': return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>
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

function SortIndicator({ field, sortField, sortDirection }: { field: SortField; sortField: SortField | null; sortDirection: SortDirection }) {
  if (sortField !== field) {
    return <ChevronDown className="ml-1 inline h-3 w-3 text-gray-300" />
  }
  return sortDirection === 'asc'
    ? <ChevronUp className="ml-1 inline h-3 w-3 text-purple-600" />
    : <ChevronDown className="ml-1 inline h-3 w-3 text-purple-600" />
}

function sortInfluencers(
  influencers: CampaignInfluencer[],
  sortField: SortField | null,
  sortDirection: SortDirection
): CampaignInfluencer[] {
  if (!sortField) return influencers
  return [...influencers].sort((a, b) => {
    let aVal: number
    let bVal: number
    if (sortField === 'followers') {
      aVal = a.influencer?.followers || 0
      bVal = b.influencer?.followers || 0
    } else {
      aVal = a.influencer?.engagementRate || 0
      bVal = b.influencer?.engagementRate || 0
    }
    return sortDirection === 'asc' ? aVal - bVal : bVal - aVal
  })
}

export default function CampaignDetailPage() {
  const params = useParams()
  const { t } = useI18n()
  const campaignId = params.id as string
  const [campaign, setCampaign] = useState<CampaignData | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [timeline, setTimeline] = useState<TimelinePoint[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isTracking, setIsTracking] = useState(false)
  const [trackingResult, setTrackingResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Sort state
  const [reportSortField, setReportSortField] = useState<SortField | null>(null)
  const [reportSortDirection, setReportSortDirection] = useState<SortDirection>('desc')
  const [influencerSortField, setInfluencerSortField] = useState<SortField | null>(null)
  const [influencerSortDirection, setInfluencerSortDirection] = useState<SortDirection>('desc')

  // Add influencer state
  const [addInfluencerUsername, setAddInfluencerUsername] = useState('')
  const [isAddingInfluencer, setIsAddingInfluencer] = useState(false)
  const [addInfluencerResult, setAddInfluencerResult] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // Load more media state
  const [mediaOffset, setMediaOffset] = useState(0)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [hasMoreMedia, setHasMoreMedia] = useState(false)

  // Media sort state
  const [mediaSortBy, setMediaSortBy] = useState<'recent' | 'likes' | 'comments' | 'views'>('recent')

  async function fetchCampaign() {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`)
      if (res.ok) {
        const data = await res.json()
        setCampaign(data.campaign)
        setOverview(data.overview)
        setTimeline(data.timeline || [])
        // If exactly 20 media items, there may be more
        const mediaCount = data.campaign?.media?.length || 0
        setMediaOffset(mediaCount)
        setHasMoreMedia(mediaCount >= 50)
      }
    } catch (err) {
      console.error('Error fetching campaign:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchCampaign()
  }, [campaignId])

  async function handleTrackNow() {
    setIsTracking(true)
    setTrackingResult(null)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/track`, {
        method: 'POST',
      })
      const data = await res.json()

      if (res.ok) {
        const storiesMsg = data.results.storiesCaptured > 0 ? `, ${data.results.storiesCaptured} stories` : ''
        setTrackingResult({
          type: 'success',
          message: `${data.results.postsFound} ${t.campaignDetail.postsFound}, ${data.results.influencersFound} ${t.campaignDetail.influencersFound}${storiesMsg}`,
        })
        await fetchCampaign()
      } else {
        setTrackingResult({
          type: 'error',
          message: data.error || 'Tracking failed',
        })
      }
    } catch {
      setTrackingResult({
        type: 'error',
        message: 'Network error',
      })
    } finally {
      setIsTracking(false)
    }
  }

  async function handleAddInfluencer() {
    const username = addInfluencerUsername.trim().replace(/^@/, '')
    if (!username) return

    setIsAddingInfluencer(true)
    setAddInfluencerResult(null)

    try {
      // Step 1: Analyze/scrape the influencer
      const platform = (campaign?.platforms && campaign.platforms.length > 0) ? campaign.platforms[0] : 'INSTAGRAM'
      const analyzeRes = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, platform }),
      })
      const analyzeData = await analyzeRes.json()

      if (!analyzeRes.ok) {
        setAddInfluencerResult({
          type: 'error',
          message: analyzeData.error || 'Failed to find influencer',
        })
        return
      }

      const influencerId = analyzeData.influencer?.id || analyzeData.id
      if (!influencerId) {
        setAddInfluencerResult({
          type: 'error',
          message: 'Could not resolve influencer ID',
        })
        return
      }

      // Step 2: Add to campaign
      const addRes = await fetch(`/api/campaigns/${campaignId}/influencers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId }),
      })
      const addData = await addRes.json()

      if (addRes.ok) {
        setAddInfluencerResult({
          type: 'success',
          message: t.campaignDetail.addedSuccess,
        })
        setAddInfluencerUsername('')
        await fetchCampaign()
      } else if (addRes.status === 409) {
        setAddInfluencerResult({
          type: 'error',
          message: t.campaignDetail.alreadyAdded,
        })
      } else {
        setAddInfluencerResult({
          type: 'error',
          message: addData.error || 'Failed to add influencer',
        })
      }
    } catch {
      setAddInfluencerResult({
        type: 'error',
        message: 'Network error',
      })
    } finally {
      setIsAddingInfluencer(false)
    }
  }

  async function handleLoadMoreMedia() {
    if (!campaign) return
    setIsLoadingMore(true)
    try {
      const newOffset = mediaOffset
      const res = await fetch(`/api/campaigns/${campaignId}?mediaOffset=${newOffset}&mediaLimit=50`)
      if (res.ok) {
        const data = await res.json()
        const newMedia: CampaignMedia[] = data.campaign?.media || []
        if (newMedia.length > 0) {
          setCampaign(prev => {
            if (!prev) return prev
            return {
              ...prev,
              media: [...prev.media, ...newMedia],
            }
          })
          setMediaOffset(newOffset + newMedia.length)
          setHasMoreMedia(newMedia.length >= 50)
        } else {
          setHasMoreMedia(false)
        }
      }
    } catch (err) {
      console.error('Error loading more media:', err)
    } finally {
      setIsLoadingMore(false)
    }
  }

  function toggleReportSort(field: SortField) {
    if (reportSortField === field) {
      setReportSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setReportSortField(field)
      setReportSortDirection('desc')
    }
  }

  function toggleInfluencerSort(field: SortField) {
    if (influencerSortField === field) {
      setInfluencerSortDirection(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setInfluencerSortField(field)
      setInfluencerSortDirection('desc')
    }
  }

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
  const platforms = campaign.platforms || []
  const targetAccounts = campaign.targetAccounts || []
  const targetHashtags = campaign.targetHashtags || []

  const stories = media.filter(m => m.mediaType === 'STORY')
  const nonStoryMedia = media.filter(m => m.mediaType !== 'STORY')

  const totalReach = overview?.totalReach || influencers.reduce((s, ci) => s + (ci.influencer?.followers || 0), 0)
  const totalEngagements = overview?.totalEngagements || 0
  const totalMedia = overview?.totalMedia || media.length
  const isActive = campaign.status === 'ACTIVE'
  const isEmpty = media.length === 0 && influencers.length === 0

  const sortedReportInfluencers = useMemo(
    () => sortInfluencers(influencers, reportSortField, reportSortDirection),
    [influencers, reportSortField, reportSortDirection]
  )

  const sortedInfluencers = useMemo(
    () => sortInfluencers(influencers, influencerSortField, influencerSortDirection),
    [influencers, influencerSortField, influencerSortDirection]
  )

  const sortedMedia = useMemo(() => {
    if (mediaSortBy === 'recent') return nonStoryMedia
    return [...nonStoryMedia].sort((a, b) => {
      if (mediaSortBy === 'likes') return (b.likes || 0) - (a.likes || 0)
      if (mediaSortBy === 'comments') return (b.comments || 0) - (a.comments || 0)
      if (mediaSortBy === 'views') return (b.views || 0) - (a.views || 0)
      return 0
    })
  }, [nonStoryMedia, mediaSortBy])

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
              {campaign.type === 'SOCIAL_LISTENING' && (
                <>
                  <span>&middot;</span>
                  <span className="inline-flex items-center gap-1 text-green-600 font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                    {t.campaigns.alwaysOn || 'Always On'}
                  </span>
                </>
              )}
              {campaign.type === 'INFLUENCER_TRACKING' && (campaign.startDate || campaign.endDate) && (
                <>
                  <span>&middot;</span>
                  <span>
                    {campaign.startDate && new Date(campaign.startDate).toLocaleDateString()}
                    {campaign.startDate && campaign.endDate && ' - '}
                    {campaign.endDate && new Date(campaign.endDate).toLocaleDateString()}
                  </span>
                </>
              )}
              {platforms.length > 0 && (
                <>
                  <span>&middot;</span>
                  <span>{platforms.map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(', ')}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isActive && (
            <Button
              variant="primary"
              size="lg"
              onClick={handleTrackNow}
              disabled={isTracking}
            >
              {isTracking ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t.campaignDetail.tracking}
                </>
              ) : (
                <>
                  <Radar className="h-5 w-5" />
                  {t.campaignDetail.trackNow}
                </>
              )}
            </Button>
          )}
          <div className="flex items-center gap-2">
            <a href={`/api/campaigns/${campaign.id}/export?format=pdf`} download>
              <Button variant="primary" size="sm">
                <Download className="h-4 w-4" />
                {t.campaignDetail.exportPDF || 'Export PDF'}
              </Button>
            </a>
            <a href={`/api/campaigns/${campaign.id}/export?format=csv`} download>
              <Button variant="secondary" size="sm">
                <Download className="h-4 w-4" />
                {t.campaignDetail.exportCSV || 'Export CSV'}
              </Button>
            </a>
          </div>
        </div>
      </div>

      {/* Tracking status banner */}
      {isTracking && (
        <div className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3">
          <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
          <div>
            <p className="text-sm font-medium text-purple-800">{t.campaignDetail.tracking}</p>
            <p className="text-xs text-purple-600">{t.campaignDetail.trackingDesc}</p>
          </div>
        </div>
      )}

      {/* Tracking result */}
      {trackingResult && !isTracking && (
        <div className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
          trackingResult.type === 'success'
            ? 'border-green-200 bg-green-50'
            : 'border-red-200 bg-red-50'
        }`}>
          <div className="flex items-center gap-3">
            {trackingResult.type === 'success' ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600" />
            )}
            <div>
              <p className={`text-sm font-medium ${
                trackingResult.type === 'success' ? 'text-green-800' : 'text-red-800'
              }`}>
                {trackingResult.type === 'success' ? t.campaignDetail.trackingComplete : 'Error'}
              </p>
              <p className={`text-xs ${
                trackingResult.type === 'success' ? 'text-green-600' : 'text-red-600'
              }`}>
                {trackingResult.message}
              </p>
            </div>
          </div>
          <button onClick={() => setTrackingResult(null)} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Tracking info */}
      {(targetAccounts.length > 0 || targetHashtags.length > 0) && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-4">
            {targetAccounts.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingAccounts}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {targetAccounts.map(a => (
                    <Badge key={a} variant="default">{a}</Badge>
                  ))}
                </div>
              </div>
            )}
            {targetHashtags.length > 0 && (
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase">{t.campaigns.trackingHashtags}</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {targetHashtags.map(h => (
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
          <TabsTrigger value="media">{t.campaigns.mediaTab} ({nonStoryMedia.length})</TabsTrigger>
          <TabsTrigger value="stories">
            <Film className="h-3.5 w-3.5" />
            {t.campaignDetail.storiesTab || 'Stories'} ({stories.length})
          </TabsTrigger>
          <TabsTrigger value="influencers">{t.campaigns.influencersTab} ({influencers.length})</TabsTrigger>
        </TabsList>

        {/* Report Tab */}
        <TabsContent value="report">
          {isEmpty ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <BarChart3 className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.mediaEmptyDesc}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Overview Stats */}
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

              {/* Additional metrics row */}
              {overview && (overview.totalViews > 0 || overview.engagementRate > 0 || overview.mediaValue > 0) && (
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatCard
                    icon={<Eye className="h-5 w-5" />}
                    label={t.campaignDetail.totalViews}
                    value={formatNumber(overview.totalViews)}
                  />
                  <StatCard
                    icon={<BarChart3 className="h-5 w-5" />}
                    label={t.campaignDetail.engagementRate}
                    value={`${overview.engagementRate}%`}
                  />
                  <StatCard
                    icon={<TrendingUp className="h-5 w-5" />}
                    label={t.campaignDetail.impressions}
                    value={formatNumber(overview.totalImpressions)}
                  />
                  {overview.mediaValue > 0 ? (
                    <StatCard
                      icon={<TrendingUp className="h-5 w-5" />}
                      label={t.campaignDetail.mediaValue}
                      value={`$${formatNumber(Math.round(overview.mediaValue))}`}
                      accent
                    />
                  ) : (
                    <StatCard
                      icon={<Users className="h-5 w-5" />}
                      label={t.campaignDetail.profilesPosted}
                      value={overview.profilesPosted}
                    />
                  )}
                </div>
              )}

              {/* Growth Charts */}
              {timeline.length > 1 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold text-gray-900">{t.campaignDetail.growthCharts || 'Growth Over Time'}</h2>
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.engagementOverTime || 'Engagement Over Time'}
                      dataKeys={[
                        { key: 'likes', color: '#ec4899', name: 'Likes' },
                        { key: 'comments', color: '#8b5cf6', name: 'Comments' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.viewsOverTime || 'Views Over Time'}
                      dataKeys={[
                        { key: 'views', color: '#06b6d4', name: 'Views' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.postsOverTime || 'Posts Over Time'}
                      dataKeys={[
                        { key: 'posts', color: '#7c3aed', name: 'Posts' },
                      ]}
                    />
                    <RechartsArea
                      data={timeline}
                      title={t.campaignDetail.reachOverTime || 'Reach Over Time'}
                      dataKeys={[
                        { key: 'reach', color: '#10b981', name: 'Reach' },
                        { key: 'engagements', color: '#f59e0b', name: 'Engagements' },
                      ]}
                    />
                  </div>
                </div>
              )}

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
                        <TableHead>
                          <button
                            onClick={() => toggleReportSort('followers')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.followers}
                            <SortIndicator field="followers" sortField={reportSortField} sortDirection={reportSortDirection} />
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            onClick={() => toggleReportSort('engagement')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.engagement}
                            <SortIndicator field="engagement" sortField={reportSortField} sortDirection={reportSortDirection} />
                          </button>
                        </TableHead>
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
                        sortedReportInfluencers.filter(ci => ci.influencer).map((ci) => (
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
          )}
        </TabsContent>

        {/* Media Tab */}
        <TabsContent value="media">
          {media.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <Image className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.mediaEmptyDesc}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Sort Controls */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{totalMedia} {t.dashboard.media}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{t.campaignDetail.sortBy}:</span>
                  {([
                    { key: 'recent', label: t.campaignDetail.mostRecent },
                    { key: 'likes', label: t.campaignDetail.mostLiked },
                    { key: 'comments', label: t.campaignDetail.mostCommented },
                    { key: 'views', label: t.campaignDetail.mostViewed },
                  ] as const).map(opt => (
                    <button
                      key={opt.key}
                      onClick={() => setMediaSortBy(opt.key)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        mediaSortBy === opt.key
                          ? 'bg-purple-100 text-purple-700'
                          : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {sortedMedia.map((m) => (
                  <a
                    key={m.id}
                    href={m.permalink || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="relative flex h-48 items-center justify-center bg-gray-100">
                      {m.thumbnailUrl ? (
                        <img
                          src={m.thumbnailUrl}
                          alt={m.caption || 'Media'}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-gray-400">
                          <Image className="h-8 w-8" />
                          <span className="text-xs">{m.mediaType}</span>
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center gap-4 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                        <span className="flex items-center gap-1 text-sm font-semibold text-white">
                          <Heart className="h-4 w-4" />
                          {formatNumber(m.likes || 0)}
                        </span>
                        <span className="flex items-center gap-1 text-sm font-semibold text-white">
                          <BarChart3 className="h-4 w-4" />
                          {formatNumber(m.comments || 0)}
                        </span>
                        {(m.views || 0) > 0 && (
                          <span className="flex items-center gap-1 text-sm font-semibold text-white">
                            <Eye className="h-4 w-4" />
                            {formatNumber(m.views || 0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="flex items-center gap-2">
                        <Avatar name={m.influencer?.displayName || m.influencer?.username || '?'} size="sm" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">
                            {m.influencer?.displayName || m.influencer?.username || 'Unknown'}
                          </p>
                          <p className="truncate text-xs text-gray-500">
                            @{m.influencer?.username || 'unknown'}
                            {m.postedAt && ` · ${new Date(m.postedAt).toLocaleDateString()}`}
                          </p>
                        </div>
                      </div>
                      {m.caption && (
                        <p className="mt-2 line-clamp-2 text-xs text-gray-500">{m.caption}</p>
                      )}
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
                  </a>
                ))}
              </div>

              {/* Load More button */}
              {hasMoreMedia && (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={handleLoadMoreMedia}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.common.loading}
                      </>
                    ) : (
                      t.campaignDetail.loadMore
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* Stories Tab */}
        <TabsContent value="stories">
          {stories.length === 0 ? (
            <div className="rounded-xl border border-gray-200 bg-white py-16 text-center shadow-sm">
              <Film className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.campaignDetail.stories || 'Stories'}</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                {t.campaignDetail.storiesEmpty}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                {isActive && (
                  <Button
                    variant="primary"
                    size="md"
                    onClick={handleTrackNow}
                    disabled={isTracking}
                  >
                    {isTracking ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t.campaignDetail.tracking}
                      </>
                    ) : (
                      <>
                        <Radar className="h-4 w-4" />
                        {t.campaignDetail.trackNow}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">{stories.length} {t.campaignDetail.stories || 'Stories'}</p>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                  <Clock className="h-3 w-3" />
                  {t.campaignDetail.storiesEmpty ? 'Stories expire after 24h' : 'Las stories expiran tras 24h'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {stories.map((story) => {
                  const postedDate = story.postedAt ? new Date(story.postedAt) : null
                  const isExpired = postedDate ? (Date.now() - postedDate.getTime()) > 24 * 60 * 60 * 1000 : true

                  return (
                    <div
                      key={story.id}
                      className="group relative overflow-hidden rounded-xl border-2 border-transparent bg-white shadow-sm transition-all hover:border-purple-300 hover:shadow-md"
                    >
                      {/* Story gradient ring */}
                      <div className={`absolute inset-0 rounded-xl ${isExpired ? 'bg-gray-100' : 'bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400'} p-[2px]`}>
                        <div className="h-full w-full rounded-[10px] bg-white" />
                      </div>

                      <div className="relative">
                        {/* Thumbnail */}
                        <div className="relative aspect-[9/16] overflow-hidden rounded-t-xl bg-gray-100">
                          {story.thumbnailUrl ? (
                            <img
                              src={story.thumbnailUrl}
                              alt="Story"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-gray-400">
                              <Film className="h-10 w-10" />
                            </div>
                          )}

                          {/* Views overlay */}
                          {(story.views || 0) > 0 && (
                            <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
                              <Eye className="h-3 w-3" />
                              {formatNumber(story.views || 0)}
                            </div>
                          )}

                          {/* Expired badge */}
                          {isExpired && (
                            <div className="absolute top-2 right-2 rounded-full bg-gray-900/70 px-2 py-0.5 text-[10px] font-medium text-white">
                              {t.campaignDetail.storyExpired || 'Expired'}
                            </div>
                          )}
                        </div>

                        {/* Creator info */}
                        <div className="p-3">
                          <div className="flex items-center gap-2">
                            <Avatar name={story.influencer?.displayName || story.influencer?.username || '?'} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-xs font-medium text-gray-900">
                                @{story.influencer?.username || 'unknown'}
                              </p>
                              {postedDate && (
                                <p className="text-[10px] text-gray-400">
                                  {postedDate.toLocaleDateString()} {postedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Influencers Tab */}
        <TabsContent value="influencers">
          <div className="space-y-4">
            {/* Add Influencer Section */}
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <UserPlus className="h-4 w-4 text-purple-600" />
                <h3 className="text-sm font-semibold text-gray-900">{t.campaigns.addInfluencers}</h3>
              </div>
              <p className="mb-3 text-xs text-gray-500">{t.campaigns.addInfluencersDesc}</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={addInfluencerUsername}
                  onChange={(e) => setAddInfluencerUsername(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddInfluencer()}
                  placeholder={t.campaigns.influencerPlaceholder}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none placeholder:text-gray-400 focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddInfluencer}
                  disabled={isAddingInfluencer || !addInfluencerUsername.trim()}
                >
                  {isAddingInfluencer ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t.common.loading}
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      {t.common.add}
                    </>
                  )}
                </Button>
              </div>
              {addInfluencerResult && (
                <div className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  addInfluencerResult.type === 'success'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700'
                }`}>
                  {addInfluencerResult.type === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-red-600" />
                  )}
                  {addInfluencerResult.message}
                  <button
                    onClick={() => setAddInfluencerResult(null)}
                    className="ml-auto text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Influencers Table */}
            <Card variant="elevated">
              <CardContent>
                {influencers.length === 0 ? (
                  <div className="py-16 text-center">
                    <Users className="mx-auto h-12 w-12 text-gray-300" />
                    <h3 className="mt-4 text-lg font-semibold text-gray-700">{t.common.noResults}</h3>
                    <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
                      {t.campaigns.addInfluencersDesc}
                    </p>
                    <div className="mt-6 flex items-center justify-center gap-3">
                      {isActive && (
                        <Button
                          variant="primary"
                          size="md"
                          onClick={handleTrackNow}
                          disabled={isTracking}
                        >
                          {isTracking ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {t.campaignDetail.tracking}
                            </>
                          ) : (
                            <>
                              <Radar className="h-4 w-4" />
                              {t.campaignDetail.trackNow}
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t.dashboard.influencers}</TableHead>
                        <TableHead>{t.campaigns.platform}</TableHead>
                        <TableHead>
                          <button
                            onClick={() => toggleInfluencerSort('followers')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.followers}
                            <SortIndicator field="followers" sortField={influencerSortField} sortDirection={influencerSortDirection} />
                          </button>
                        </TableHead>
                        <TableHead>
                          <button
                            onClick={() => toggleInfluencerSort('engagement')}
                            className="inline-flex items-center font-medium hover:text-purple-600"
                          >
                            {t.campaigns.engagement}
                            <SortIndicator field="engagement" sortField={influencerSortField} sortDirection={influencerSortDirection} />
                          </button>
                        </TableHead>
                        <TableHead>{t.campaignDetail.avgLikes}</TableHead>
                        <TableHead>{t.campaignDetail.avgComments}</TableHead>
                        <TableHead>{t.campaignDetail.avgViews}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedInfluencers.filter(ci => ci.influencer).map((ci) => (
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
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
