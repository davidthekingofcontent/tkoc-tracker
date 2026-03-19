'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import {
  Search,
  Instagram,
  Youtube,
  RefreshCw,
  ListPlus,
  ExternalLink,
  Loader2,
  Heart,
  MessageCircle,
  Eye,
  Users,
  BarChart3,
  CheckCircle,
  AlertCircle,
  Link2,
  Mail,
  X,
  Play,
  Lightbulb,
  UserSearch,
  TrendingUp,
  TrendingDown,
  Minus,
  Calendar,
  Clock,
  Hash,
  Star,
  ArrowLeft,
  Sparkles,
  Target,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { StatCard } from '@/components/ui/stat-card'
import { Avatar } from '@/components/ui/avatar'
import { formatNumber } from '@/lib/utils'
import { AddToModal } from '@/components/add-to-modal'
import { calculateCPM, type CPMResult, type Platform as CPMPlatform } from '@/lib/cpm-calculator'

interface AnalyzedProfile {
  id: string
  username: string
  platform: string
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  followers: number
  following: number
  postsCount: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  isVerified: boolean
  email: string | null
  website: string | null
  country: string | null
  city: string | null
  lastScraped: string | null
  media: MediaItem[]
  _count: { campaigns: number; media: number }
}

interface MediaItem {
  id: string
  mediaType: string
  caption: string | null
  thumbnailUrl: string | null
  mediaUrl: string | null
  permalink: string | null
  likes: number
  comments: number
  views: number
  shares: number
  postedAt: string | null
}

interface RecentAnalysis {
  id: string
  username: string
  platform: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  lastScraped: string | null
}

// Insights types
interface InsightsData {
  contentBreakdown: {
    type: string
    count: number
    avgLikes: number
    avgComments: number
    avgViews: number
    avgEngagement: number
  }[]
  topPosts: {
    id: string
    caption: string | null
    thumbnailUrl: string | null
    mediaUrl: string | null
    permalink: string | null
    mediaType: string
    likes: number
    comments: number
    views: number
    engagementRate: number
    postedAt: string | null
  }[]
  topHashtags: {
    tag: string
    count: number
    avgLikes: number
    avgEngagement: number
  }[]
  postingFrequency: {
    postsPerWeek: number
    avgDaysBetweenPosts: number
    mostActiveDay: string | null
  }
  engagementAnalysis: {
    likeToFollowerRatio: number
    commentToLikeRatio: number
    viewToFollowerRatio: number
    estimatedReach: number
    engagementTrend: 'rising' | 'stable' | 'declining'
  }
  bestContentType: string | null
  bestPostingTime: string | null
  audienceQuality: 'high' | 'medium' | 'low'
}

// Lookalikes types
interface LookalikeEntry {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  matchScore: number
}

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform.toLowerCase()) {
    case 'instagram':
      return <Instagram className="h-4 w-4 text-pink-400" />
    case 'youtube':
      return <Youtube className="h-4 w-4 text-red-400" />
    case 'tiktok':
      return <svg className="h-4 w-4 text-cyan-400" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>
    default:
      return null
  }
}

const TikTokIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>
)

const platformButtons = [
  { id: 'INSTAGRAM', label: 'Instagram', icon: Instagram, color: 'text-pink-400' },
  { id: 'TIKTOK', label: 'TikTok', icon: TikTokIcon, color: 'text-cyan-400' },
  { id: 'YOUTUBE', label: 'YouTube', icon: Youtube, color: 'text-red-400' },
]

function getProfileUrl(username: string, platform: string) {
  switch (platform.toUpperCase()) {
    case 'TIKTOK': return `https://tiktok.com/@${username}`
    case 'YOUTUBE': return `https://youtube.com/@${username}`
    default: return `https://instagram.com/${username}`
  }
}

type ViewMode = 'profile' | 'insights' | 'lookalikes'

export default function AnalyzePage() {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [hypotheticalFee, setHypotheticalFee] = useState<string>('')
  const [selectedPlatform, setSelectedPlatform] = useState('INSTAGRAM')
  const [analyzing, setAnalyzing] = useState(false)
  const [profile, setProfile] = useState<AnalyzedProfile | null>(null)
  const [recentSearches, setRecentSearches] = useState<RecentAnalysis[]>([])
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [activeTab, setActiveTab] = useState('recent')
  const [addToModal, setAddToModal] = useState<{
    open: boolean
    influencerId: string
    influencerName: string
  }>({ open: false, influencerId: '', influencerName: '' })

  // Insights & Lookalikes state
  const [viewMode, setViewMode] = useState<ViewMode>('profile')
  const [insights, setInsights] = useState<InsightsData | null>(null)
  const [lookalikes, setLookalikes] = useState<LookalikeEntry[]>([])
  const [loadingInsights, setLoadingInsights] = useState(false)
  const [loadingLookalikes, setLoadingLookalikes] = useState(false)

  useEffect(() => {
    fetchRecentSearches()
  }, [])

  async function fetchRecentSearches() {
    try {
      const res = await fetch('/api/influencers?limit=20&sort=lastScraped')
      if (res.ok) {
        const data = await res.json()
        setRecentSearches(
          (data.influencers || [])
            .filter((i: RecentAnalysis) => i.lastScraped || i.followers > 0)
            .map((i: RecentAnalysis) => ({
              id: i.id,
              username: i.username,
              platform: i.platform,
              displayName: i.displayName,
              avatarUrl: i.avatarUrl,
              followers: i.followers,
              engagementRate: i.engagementRate,
              avgLikes: i.avgLikes,
              avgComments: i.avgComments,
              avgViews: i.avgViews,
              email: i.email,
              lastScraped: i.lastScraped,
            }))
        )
      }
    } catch {
      // ignore
    }
  }

  async function handleAnalyze() {
    if (!query.trim()) return

    setAnalyzing(true)
    setError('')
    setSuccessMsg('')
    setProfile(null)
    setViewMode('profile')
    setInsights(null)
    setLookalikes([])
    setHypotheticalFee('')

    try {
      const res = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: query.trim(),
          platform: selectedPlatform,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Error analyzing profile')
        return
      }

      setProfile(data.influencer)
      if (data.source === 'apify') {
        setSuccessMsg(t.analyze.profileAnalyzed || 'Profile analyzed successfully')
      }
      setActiveTab('profile')
      fetchRecentSearches()
    } catch {
      setError('Error connecting to server')
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleReAnalyze(username: string, platform: string) {
    setQuery(username)
    setSelectedPlatform(platform)
    setAnalyzing(true)
    setError('')
    setSuccessMsg('')
    setViewMode('profile')
    setInsights(null)
    setLookalikes([])
    setHypotheticalFee('')

    try {
      const res = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, platform }),
      })

      const data = await res.json()

      if (res.ok) {
        setProfile(data.influencer)
        if (data.source === 'apify') {
          setSuccessMsg(t.analyze.profileAnalyzed || 'Profile analyzed successfully')
        }
        setActiveTab('profile')
        fetchRecentSearches()
      }
    } catch {
      // ignore
    } finally {
      setAnalyzing(false)
    }
  }

  async function handleGetInsights() {
    if (!profile) return
    setLoadingInsights(true)
    setError('')

    try {
      const res = await fetch(`/api/influencers/${profile.id}/insights`)
      if (res.ok) {
        const data = await res.json()
        setInsights(data)
        setViewMode('insights')
      } else {
        const data = await res.json()
        setError(data.error || 'Error getting insights')
      }
    } catch {
      setError('Error connecting to server')
    } finally {
      setLoadingInsights(false)
    }
  }

  async function handleFindLookalikes() {
    if (!profile) return
    setLoadingLookalikes(true)
    setError('')

    try {
      const res = await fetch(`/api/influencers/${profile.id}/lookalikes`)
      if (res.ok) {
        const data = await res.json()
        setLookalikes(data.lookalikes || [])
        setViewMode('lookalikes')
      } else {
        const data = await res.json()
        setError(data.error || 'Error finding lookalikes')
      }
    } catch {
      setError('Error connecting to server')
    } finally {
      setLoadingLookalikes(false)
    }
  }

  function handleRemoveFromList(id: string) {
    setRecentSearches((prev) => prev.filter((item) => item.id !== id))
  }

  const commentLikeRatio = profile && profile.avgLikes > 0
    ? `1:${Math.round(profile.avgLikes / Math.max(profile.avgComments, 1))}`
    : null

  const trendIcon = (trend: string) => {
    switch (trend) {
      case 'rising': return <TrendingUp className="h-4 w-4 text-emerald-500" />
      case 'declining': return <TrendingDown className="h-4 w-4 text-red-500" />
      default: return <Minus className="h-4 w-4 text-gray-400" />
    }
  }

  const trendLabel = (trend: string) => {
    switch (trend) {
      case 'rising': return t.analyze.rising
      case 'declining': return t.analyze.declining
      default: return t.analyze.stable
    }
  }

  const qualityColor = (q: string) => {
    switch (q) {
      case 'high': return 'text-emerald-600 bg-emerald-50'
      case 'medium': return 'text-amber-600 bg-amber-50'
      default: return 'text-red-600 bg-red-50'
    }
  }

  const qualityLabel = (q: string) => {
    switch (q) {
      case 'high': return t.analyze.high
      case 'medium': return t.analyze.medium
      default: return t.analyze.low
    }
  }

  const cpmResult = profile ? calculateCPM({
    fee: hypotheticalFee ? parseFloat(hypotheticalFee) : null,
    avgViews: profile.avgViews || 0,
    platform: (profile.platform || 'INSTAGRAM') as CPMPlatform,
    followers: profile.followers || 0,
  }, locale as 'en' | 'es') : null

  const trafficColors: Record<string, string> = {
    green: 'bg-green-100 text-green-800 border-green-300',
    yellow: 'bg-amber-100 text-amber-800 border-amber-300',
    red: 'bg-red-100 text-red-800 border-red-300',
    gray: 'bg-gray-100 text-gray-600 border-gray-300',
  }
  const trafficDot: Record<string, string> = {
    green: 'bg-green-500',
    yellow: 'bg-amber-500',
    red: 'bg-red-500',
    gray: 'bg-gray-400',
  }

  return (
    <div className="space-y-6">
      {/* Search Bar */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <select
            value={selectedPlatform}
            onChange={(e) => setSelectedPlatform(e.target.value)}
            className="appearance-none rounded-lg border border-gray-200 bg-white py-3.5 pl-10 pr-8 text-sm font-medium text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
          >
            {platformButtons.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
            {selectedPlatform === 'INSTAGRAM' && <Instagram className="h-4 w-4 text-pink-400" />}
            {selectedPlatform === 'TIKTOK' && <svg className="h-4 w-4 text-cyan-400" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>}
            {selectedPlatform === 'YOUTUBE' && <Youtube className="h-4 w-4 text-red-400" />}
          </div>
        </div>

        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-gray-400">
            <span className="text-lg font-medium">@</span>
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
            placeholder={t.analyze.inputPlaceholder}
            className="block w-full rounded-lg border border-gray-200 bg-white py-3.5 pl-10 pr-4 text-base text-gray-900 placeholder-gray-400 transition-colors focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            disabled={analyzing}
          />
        </div>

        <button
          onClick={handleAnalyze}
          disabled={analyzing || !query.trim()}
          className="inline-flex min-w-[180px] items-center justify-center gap-2.5 rounded-lg bg-purple-600 px-6 py-3.5 text-base font-medium text-white shadow-md transition-colors hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500/50 disabled:opacity-50 disabled:pointer-events-none"
        >
          {analyzing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.analyze.analyzing}
            </>
          ) : (
            <>
              <Search className="h-4 w-4" />
              {t.analyze.analyze}
            </>
          )}
        </button>
      </div>

      {/* Error / Success */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 rounded-lg px-4 py-3">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {successMsg && !error && (
        <div className="flex items-center gap-2 text-sm text-emerald-600 bg-emerald-50 rounded-lg px-4 py-3">
          <CheckCircle className="h-4 w-4 flex-shrink-0" />
          {successMsg}
        </div>
      )}

      {/* Loading state */}
      {analyzing && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-16">
          <Loader2 className="h-10 w-10 animate-spin text-purple-500 mb-4" />
          <p className="text-sm font-medium text-gray-700">{t.analyze.analyzing}...</p>
          <p className="text-xs text-gray-400 mt-1">{t.analyze.analyzingDesc || 'This may take a few seconds'}</p>
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* PROFILE VIEW */}
      {/* ═══════════════════════════════════════════ */}
      {profile && !analyzing && viewMode === 'profile' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* Left panel */}
            <div className="lg:col-span-2 space-y-6">
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={profile.displayName || profile.username}
                      size="lg"
                      src={profile.avatarUrl || undefined}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-lg font-bold text-gray-900">
                          {profile.displayName || profile.username}
                        </h2>
                        {profile.isVerified && (
                          <CheckCircle className="h-4 w-4 text-blue-500" />
                        )}
                      </div>
                      <a
                        href={getProfileUrl(profile.username, profile.platform)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-gray-500 hover:text-purple-600 inline-flex items-center gap-1"
                      >
                        <PlatformIcon platform={profile.platform} />
                        @{profile.username}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleReAnalyze(profile.username, profile.platform)}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                      title={t.analyze.refreshData}
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {profile.bio && (
                  <div className="mb-4">
                    <p className="text-xs font-medium text-gray-400 uppercase mb-1">Bio</p>
                    <p className="text-sm text-gray-700 leading-relaxed">{profile.bio}</p>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="text-center">
                    <p className="text-xs text-gray-400 mb-0.5">Engagement</p>
                    <p className="text-2xl font-bold text-gray-900">{profile.engagementRate}<span className="text-base text-gray-400">%</span></p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400 mb-0.5">{t.campaigns.followers}</p>
                    <p className="text-2xl font-bold text-gray-900">{formatNumber(profile.followers)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400 mb-0.5">Posts</p>
                    <p className="text-2xl font-bold text-gray-900">{formatNumber(profile.postsCount)}</p>
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-4 mb-4">
                  <p className="text-xs font-medium text-gray-400 uppercase mb-3">{t.analyze.mediansPerPost || 'Medians Per Post'}</p>
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-1.5 text-sm text-gray-700">
                      <Heart className="h-4 w-4 text-red-400" />
                      <span className="font-semibold">{formatNumber(profile.avgLikes)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-gray-700">
                      <MessageCircle className="h-4 w-4 text-blue-400" />
                      <span className="font-semibold">{formatNumber(profile.avgComments)}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-gray-700">
                      <Play className="h-4 w-4 text-purple-400" />
                      <span className="font-semibold">{formatNumber(profile.avgViews)}</span>
                    </div>
                  </div>
                </div>

                {commentLikeRatio && (
                  <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
                    <Users className="h-4 w-4" />
                    <span>{commentLikeRatio} Comment:Like Ratio</span>
                  </div>
                )}

                <div className="space-y-2 border-t border-gray-100 pt-4">
                  {profile.website && (
                    <a
                      href={profile.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-purple-600 hover:text-purple-700 truncate"
                    >
                      <Link2 className="h-4 w-4 flex-shrink-0" />
                      <span className="truncate">{profile.website}</span>
                    </a>
                  )}
                  {profile.email ? (
                    <a
                      href={`mailto:${profile.email}`}
                      className="flex items-center gap-2 text-sm text-gray-700 hover:text-purple-600"
                    >
                      <Mail className="h-4 w-4 flex-shrink-0 text-gray-400" />
                      {profile.email}
                    </a>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-gray-400">
                      <Mail className="h-4 w-4 flex-shrink-0" />
                      Not Provided
                    </div>
                  )}
                  {(profile.country || profile.city) && (
                    <div className="flex items-center gap-2 text-sm text-gray-700">
                      <span className="text-gray-400">📍</span>
                      {[profile.city, profile.country].filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>

                {/* Action buttons: Add to list, Get Insights, Find Lookalikes */}
                <div className="mt-5 space-y-2">
                  <button
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                    onClick={() => setAddToModal({
                      open: true,
                      influencerId: profile.id,
                      influencerName: profile.displayName || profile.username,
                    })}
                  >
                    <ListPlus className="h-4 w-4" />
                    {t.analyze.addToList}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleGetInsights}
                      disabled={loadingInsights}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 shadow-sm transition-colors hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400/50 disabled:opacity-50"
                    >
                      {loadingInsights ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Lightbulb className="h-4 w-4" />
                      )}
                      {loadingInsights ? '...' : t.analyze.getInsights}
                    </button>

                    <button
                      onClick={handleFindLookalikes}
                      disabled={loadingLookalikes}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border-2 border-cyan-400 bg-cyan-50 px-4 py-2.5 text-sm font-medium text-cyan-700 shadow-sm transition-colors hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 disabled:opacity-50"
                    >
                      {loadingLookalikes ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <UserSearch className="h-4 w-4" />
                      )}
                      {loadingLookalikes ? '...' : t.analyze.findLookalikes}
                    </button>
                  </div>
                </div>

                {/* Rate Card */}
                {cpmResult && (
                  <div className="mt-5 border-t border-gray-100 pt-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Target className="h-4 w-4 text-purple-500" />
                      <h3 className="text-sm font-semibold text-gray-900">{t.analyze.rateCard}</h3>
                      <span className="text-xs text-gray-400">{t.analyze.rateCardDesc}</span>
                    </div>

                    {/* Fee input */}
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-gray-500 mb-1">{t.analyze.enterFee}</label>
                      <input
                        type="number"
                        value={hypotheticalFee}
                        onChange={(e) => setHypotheticalFee(e.target.value)}
                        placeholder="0"
                        className="block w-full rounded-lg border border-gray-200 bg-white py-2 px-3 text-sm text-gray-900 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
                      />
                    </div>

                    {/* Traffic light indicator */}
                    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 mb-3 ${trafficColors[cpmResult.trafficLight]}`}>
                      <div className={`h-3 w-3 rounded-full flex-shrink-0 ${trafficDot[cpmResult.trafficLight]}`} />
                      <span className="text-sm font-semibold">{cpmResult.recommendation}</span>
                    </div>

                    {/* Metrics grid */}
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">CPM Real</p>
                        <p className="text-sm font-bold text-gray-900">
                          {cpmResult.cpmReal !== null ? `€${cpmResult.cpmReal}` : '—'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">CPM Target</p>
                        <p className="text-sm font-bold text-gray-900">
                          {cpmResult.cpmTarget !== null ? `€${cpmResult.cpmTarget}` : '—'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">Fee Rec.</p>
                        <p className="text-sm font-bold text-gray-900">
                          {cpmResult.feeRecommended !== null ? `€${cpmResult.feeRecommended.toLocaleString()}` : '—'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">Fee Max</p>
                        <p className="text-sm font-bold text-gray-900">
                          {cpmResult.feeMax !== null ? `€${cpmResult.feeMax.toLocaleString()}` : '—'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">Tier</p>
                        <p className="text-sm font-bold text-gray-900">{cpmResult.tier}</p>
                      </div>
                      <div className="rounded-lg bg-gray-50 p-2.5">
                        <p className="text-[10px] text-gray-400 uppercase font-medium">Difference</p>
                        <p className={`text-sm font-bold ${cpmResult.savingsOrOvercost !== null ? (cpmResult.savingsOrOvercost > 0 ? 'text-red-600' : 'text-green-600') : 'text-gray-900'}`}>
                          {cpmResult.savingsOrOvercost !== null
                            ? `${cpmResult.savingsOrOvercost > 0 ? '+' : ''}€${cpmResult.savingsOrOvercost.toLocaleString()}`
                            : '—'}
                        </p>
                      </div>
                    </div>

                    {/* Recommendation detail */}
                    <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${trafficColors[cpmResult.trafficLight]}`}>
                      {cpmResult.recommendationDetail}
                    </div>
                  </div>
                )}
              </div>

              {/* Stat Cards */}
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  icon={<Users className="h-5 w-5" />}
                  label={t.campaigns.followers}
                  value={formatNumber(profile.followers)}
                  accent
                />
                <StatCard
                  icon={<BarChart3 className="h-5 w-5" />}
                  label={t.campaigns.engagement}
                  value={`${profile.engagementRate}%`}
                />
                <StatCard
                  icon={<Heart className="h-5 w-5" />}
                  label={t.analyze.medianLikes}
                  value={formatNumber(profile.avgLikes)}
                />
                <StatCard
                  icon={<Eye className="h-5 w-5" />}
                  label={t.analyze.medianViews}
                  value={formatNumber(profile.avgViews)}
                />
                <StatCard
                  icon={<MessageCircle className="h-5 w-5" />}
                  label={t.analyze.medianComments}
                  value={formatNumber(profile.avgComments)}
                />
                <StatCard
                  icon={<BarChart3 className="h-5 w-5" />}
                  label="Following"
                  value={formatNumber(profile.following)}
                />
              </div>
            </div>

            {/* Right panel — Media grid */}
            <div className="lg:col-span-3">
              {profile.media && profile.media.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {profile.media.map((media) => (
                    <a
                      key={media.id}
                      href={media.permalink || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gradient-to-br from-gray-50 to-gray-100"
                    >
                      {(media.thumbnailUrl || media.mediaUrl) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={(media.thumbnailUrl || media.mediaUrl) as string}
                          alt={media.caption || ''}
                          className="absolute inset-0 h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      {/* Fallback content — always rendered behind the image */}
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/80 text-gray-400 shadow-sm">
                          {media.mediaType === 'REEL' || media.mediaType === 'VIDEO' ? (
                            <Play className="h-5 w-5" />
                          ) : media.mediaType === 'CAROUSEL' ? (
                            <BarChart3 className="h-5 w-5" />
                          ) : (
                            <Heart className="h-5 w-5" />
                          )}
                        </div>
                        <span className="text-[10px] font-medium text-gray-400 uppercase">{media.mediaType}</span>
                        <div className="flex items-center gap-2 text-[10px] text-gray-500">
                          <span>❤ {formatNumber(media.likes)}</span>
                          <span>💬 {formatNumber(media.comments)}</span>
                        </div>
                      </div>
                      {/* Hover overlay with metrics */}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2.5 pt-6">
                        <div className="flex items-center gap-3 text-xs text-white">
                          <span className="flex items-center gap-1">
                            <Heart className="h-3 w-3" />
                            {formatNumber(media.likes)}
                          </span>
                          <span className="flex items-center gap-1">
                            <MessageCircle className="h-3 w-3" />
                            {formatNumber(media.comments)}
                          </span>
                          {media.views > 0 && (
                            <span className="flex items-center gap-1">
                              <Eye className="h-3 w-3" />
                              {formatNumber(media.views)}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* External link icon on hover */}
                      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-white">
                          <ExternalLink className="h-3 w-3" />
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20 h-full">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                    <Eye className="h-6 w-6" />
                  </div>
                  <p className="mt-4 text-sm text-gray-500">No media found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* INSIGHTS VIEW */}
      {/* ═══════════════════════════════════════════ */}
      {profile && !analyzing && viewMode === 'insights' && insights && (
        <div className="space-y-6">
          {/* Back button */}
          <button
            onClick={() => setViewMode('profile')}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-purple-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {t.analyze.backToProfile}
          </button>

          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
              <Lightbulb className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{t.analyze.getInsights}</h2>
              <p className="text-sm text-gray-500">@{profile.username}</p>
            </div>
          </div>

          {/* Summary cards row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <span className="text-xs text-gray-400 font-medium">{t.analyze.bestContentType}</span>
              </div>
              <p className="text-lg font-bold text-gray-900">{insights.bestContentType || '—'}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="h-4 w-4 text-blue-500" />
                <span className="text-xs text-gray-400 font-medium">{t.analyze.bestPostingTime}</span>
              </div>
              <p className="text-lg font-bold text-gray-900">{insights.bestPostingTime || '—'}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="h-4 w-4 text-emerald-500" />
                <span className="text-xs text-gray-400 font-medium">{t.analyze.audienceQuality}</span>
              </div>
              <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-bold ${qualityColor(insights.audienceQuality)}`}>
                {qualityLabel(insights.audienceQuality)}
              </span>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                {trendIcon(insights.engagementAnalysis.engagementTrend)}
                <span className="text-xs text-gray-400 font-medium">{t.analyze.engagementTrend}</span>
              </div>
              <p className="text-lg font-bold text-gray-900">{trendLabel(insights.engagementAnalysis.engagementTrend)}</p>
              {/* Mini sparkline */}
              {profile && profile.media && profile.media.length > 2 && (() => {
                const engagements = [...profile.media]
                  .sort((a, b) => new Date(a.postedAt || 0).getTime() - new Date(b.postedAt || 0).getTime())
                  .slice(-10)
                  .map(m => ((m.likes + m.comments) / Math.max(profile.followers, 1)) * 100)
                const max = Math.max(...engagements, 0.01)
                const min = Math.min(...engagements, 0)
                const range = max - min || 1
                const w = 100 / engagements.length
                const points = engagements.map((v, i) => `${i * w + w/2},${100 - ((v - min) / range) * 80 - 10}`).join(' ')
                const trendColor = insights.engagementAnalysis.engagementTrend === 'rising' ? '#10b981' : insights.engagementAnalysis.engagementTrend === 'declining' ? '#ef4444' : '#8b5cf6'
                return (
                  <svg viewBox="0 0 100 100" className="mt-2 h-10 w-full" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={trendColor} stopOpacity="0.3" />
                        <stop offset="100%" stopColor={trendColor} stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <polygon
                      points={`${w/2},100 ${points} ${(engagements.length - 1) * w + w/2},100`}
                      fill="url(#sparkGrad)"
                    />
                    <polyline
                      points={points}
                      fill="none"
                      stroke={trendColor}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )
              })()}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Content Breakdown */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-purple-500" />
                {t.analyze.contentBreakdown}
              </h3>
              {insights.contentBreakdown.length > 0 ? (
                <div className="space-y-3">
                  {insights.contentBreakdown.map((item) => {
                    const maxCount = Math.max(...insights.contentBreakdown.map(c => c.count))
                    const pct = maxCount > 0 ? (item.count / maxCount) * 100 : 0
                    return (
                      <div key={item.type}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-gray-700">{item.type}</span>
                          <span className="text-xs text-gray-400">{item.count} posts &middot; {item.avgEngagement}% {t.analyze.avgEng}</span>
                        </div>
                        <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-purple-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex items-center gap-4 mt-1 text-xs text-gray-400">
                          <span><Heart className="inline h-3 w-3 mr-0.5" />{formatNumber(item.avgLikes)}</span>
                          <span><MessageCircle className="inline h-3 w-3 mr-0.5" />{formatNumber(item.avgComments)}</span>
                          <span><Eye className="inline h-3 w-3 mr-0.5" />{formatNumber(item.avgViews)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-400">{t.analyze.noInsightsData}</p>
              )}
            </div>

            {/* Engagement Analysis */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Target className="h-4 w-4 text-emerald-500" />
                {t.analyze.engagementAnalysis}
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{t.analyze.likeToFollowerRatio}</span>
                  <span className="text-sm font-semibold text-gray-900">{(insights.engagementAnalysis.likeToFollowerRatio * 100).toFixed(2)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{t.analyze.commentToLikeRatio}</span>
                  <span className="text-sm font-semibold text-gray-900">{(insights.engagementAnalysis.commentToLikeRatio * 100).toFixed(2)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-600">{t.analyze.viewToFollowerRatio}</span>
                  <span className="text-sm font-semibold text-gray-900">{(insights.engagementAnalysis.viewToFollowerRatio * 100).toFixed(2)}%</span>
                </div>
                <div className="border-t border-gray-100 pt-3 flex items-center justify-between">
                  <span className="text-sm text-gray-600">{t.analyze.estimatedReach}</span>
                  <span className="text-sm font-bold text-purple-600">{formatNumber(insights.engagementAnalysis.estimatedReach)}</span>
                </div>
              </div>
            </div>

            {/* Posting Frequency */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-500" />
                {t.analyze.postingFrequency}
              </h3>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-gray-900">{insights.postingFrequency.postsPerWeek}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{t.analyze.postsPerWeek}</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{insights.postingFrequency.avgDaysBetweenPosts}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{t.analyze.avgDaysBetween}</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{insights.postingFrequency.mostActiveDay || '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{t.analyze.mostActiveDay}</p>
                </div>
              </div>
            </div>

            {/* Top Hashtags */}
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Hash className="h-4 w-4 text-pink-500" />
                {t.analyze.topHashtags}
              </h3>
              {insights.topHashtags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {insights.topHashtags.map((ht) => (
                    <span
                      key={ht.tag}
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 transition-colors"
                    >
                      {ht.tag}
                      <span className="text-gray-400">{ht.count} {t.analyze.uses}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No hashtags found</p>
              )}
            </div>
          </div>

          {/* Top Performing Posts */}
          {insights.topPosts.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-500" />
                {t.analyze.topPerformingPosts}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {insights.topPosts.map((post, idx) => (
                  <a
                    key={post.id}
                    href={post.permalink || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative rounded-lg border border-gray-100 overflow-hidden hover:border-purple-300 transition-colors"
                  >
                    <div className="relative aspect-square bg-gradient-to-br from-purple-50 via-gray-50 to-indigo-50">
                      {(post.thumbnailUrl || post.mediaUrl) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={(post.thumbnailUrl || post.mediaUrl) as string}
                          alt=""
                          className="absolute inset-0 z-[1] h-full w-full object-cover group-hover:scale-105 transition-transform"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      {/* Fallback — always visible behind img */}
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-purple-400 shadow-md border border-purple-100">
                          {post.mediaType === 'REEL' || post.mediaType === 'VIDEO' ? <Play className="h-7 w-7" /> : <Heart className="h-7 w-7" />}
                        </div>
                        <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">{post.mediaType}</span>
                        <div className="flex items-center gap-3 text-xs font-medium text-gray-600">
                          <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5 text-red-400" />{formatNumber(post.likes)}</span>
                          <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5 text-blue-400" />{formatNumber(post.comments)}</span>
                        </div>
                        <span className="text-lg font-bold text-purple-600">{post.engagementRate}% eng</span>
                      </div>
                      <div className="absolute top-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-white shadow-md">
                        #{idx + 1}
                      </div>
                      {/* View on IG icon */}
                      <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-600 text-white shadow">
                          <ExternalLink className="h-3 w-3" />
                        </div>
                      </div>
                    </div>
                    <div className="p-3">
                      <div className="flex items-center gap-3 text-xs text-gray-500 mb-1">
                        <span className="flex items-center gap-1"><Heart className="h-3 w-3 text-red-400" />{formatNumber(post.likes)}</span>
                        <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3 text-blue-400" />{formatNumber(post.comments)}</span>
                        {post.views > 0 && <span className="flex items-center gap-1"><Eye className="h-3 w-3 text-purple-400" />{formatNumber(post.views)}</span>}
                      </div>
                      <p className="text-xs font-semibold text-emerald-600">{post.engagementRate}% eng.</p>
                      {post.caption && (
                        <p className="text-xs text-gray-400 mt-1 line-clamp-2">{post.caption}</p>
                      )}
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════ */}
      {/* LOOKALIKES VIEW */}
      {/* ═══════════════════════════════════════════ */}
      {profile && !analyzing && viewMode === 'lookalikes' && (
        <div className="space-y-6">
          {/* Back button */}
          <button
            onClick={() => setViewMode('profile')}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-purple-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {t.analyze.backToProfile}
          </button>

          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100">
              <UserSearch className="h-5 w-5 text-cyan-600" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{t.analyze.similarProfiles}</h2>
              <p className="text-sm text-gray-500">{t.lookalikes.similarTo} @{profile.username} &middot; {formatNumber(profile.followers)} {t.campaigns.followers.toLowerCase()}</p>
            </div>
          </div>

          {lookalikes.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                <UserSearch className="h-6 w-6" />
              </div>
              <p className="mt-4 text-sm text-gray-500 max-w-md text-center">{t.analyze.noLookalikes}</p>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.analyze.username}</TableHead>
                    <TableHead>{t.campaigns.followers}</TableHead>
                    <TableHead>Eng. Rate</TableHead>
                    <TableHead>Mdn. Likes</TableHead>
                    <TableHead>Mdn. Views</TableHead>
                    <TableHead>{t.common.email}</TableHead>
                    <TableHead>{t.analyze.matchScore}</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lookalikes.map((item) => (
                    <TableRow key={item.id} className="group">
                      <TableCell>
                        <button
                          onClick={() => handleReAnalyze(item.username, item.platform)}
                          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                        >
                          <Avatar
                            name={item.displayName || item.username}
                            size="sm"
                            src={item.avatarUrl || undefined}
                          />
                          <div className="text-left">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-gray-900">{item.username}</span>
                              <PlatformIcon platform={item.platform} />
                            </div>
                            {item.displayName && item.displayName !== item.username && (
                              <span className="text-xs text-gray-400">{item.displayName}</span>
                            )}
                          </div>
                        </button>
                      </TableCell>
                      <TableCell className="font-medium">{formatNumber(item.followers)}</TableCell>
                      <TableCell>
                        <span className={
                          item.engagementRate >= 5
                            ? 'text-emerald-500 font-medium'
                            : item.engagementRate >= 3
                              ? 'text-purple-600 font-medium'
                              : 'text-gray-600'
                        }>
                          {item.engagementRate}%
                        </span>
                      </TableCell>
                      <TableCell>{formatNumber(item.avgLikes)}</TableCell>
                      <TableCell>{formatNumber(item.avgViews)}</TableCell>
                      <TableCell>
                        <span className="text-xs text-gray-500 max-w-[180px] truncate block">
                          {item.email || 'Not Provided'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-16 rounded-full bg-gray-100 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                item.matchScore >= 70
                                  ? 'bg-emerald-500'
                                  : item.matchScore >= 40
                                    ? 'bg-amber-400'
                                    : 'bg-gray-400'
                              }`}
                              style={{ width: `${item.matchScore}%` }}
                            />
                          </div>
                          <span className="text-xs font-semibold text-gray-700">{item.matchScore}%</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="primary"
                            size="sm"
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => setAddToModal({
                              open: true,
                              influencerId: item.id,
                              influencerName: item.displayName || item.username,
                            })}
                          >
                            <ListPlus className="h-3 w-3" />
                            Add to...
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Tabs: Recent Searches / Insights */}
      {!profile && !analyzing && (
        <Tabs defaultValue="recent" value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="recent">{t.analyze.recentSearches}</TabsTrigger>
            <TabsTrigger value="insights">{t.analyze.insights}</TabsTrigger>
          </TabsList>

          <TabsContent value="recent">
            {recentSearches.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                  <Search className="h-6 w-6" />
                </div>
                <p className="mt-4 text-sm text-gray-500">{t.analyze.insightsEmpty}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.analyze.username}</TableHead>
                      <TableHead>{t.campaigns.followers}</TableHead>
                      <TableHead>Eng. Rate</TableHead>
                      <TableHead>Mdn. Likes</TableHead>
                      <TableHead>Mdn. Comments</TableHead>
                      <TableHead>Mdn. Views</TableHead>
                      <TableHead>{t.common.email}</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentSearches.map((item) => (
                      <TableRow key={item.id} className="group">
                        <TableCell>
                          <button
                            onClick={() => handleReAnalyze(item.username, item.platform)}
                            className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                          >
                            <Avatar
                              name={item.displayName || item.username}
                              size="sm"
                              src={item.avatarUrl || undefined}
                            />
                            <div className="text-left">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-gray-900">{item.username}</span>
                                <PlatformIcon platform={item.platform} />
                              </div>
                              {item.displayName && item.displayName !== item.username && (
                                <span className="text-xs text-gray-400">{item.displayName}</span>
                              )}
                            </div>
                          </button>
                        </TableCell>
                        <TableCell className="font-medium">{formatNumber(item.followers)}</TableCell>
                        <TableCell>
                          <span className={
                            item.engagementRate >= 5
                              ? 'text-emerald-500 font-medium'
                              : item.engagementRate >= 3
                                ? 'text-purple-600 font-medium'
                                : 'text-gray-600'
                          }>
                            {item.engagementRate}%
                          </span>
                        </TableCell>
                        <TableCell>{formatNumber(item.avgLikes)}</TableCell>
                        <TableCell>{formatNumber(item.avgComments)}</TableCell>
                        <TableCell>{formatNumber(item.avgViews)}</TableCell>
                        <TableCell>
                          <span className="text-xs text-gray-500 max-w-[180px] truncate block">
                            {item.email || 'Not Provided'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="primary"
                              size="sm"
                              className="opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={() => setAddToModal({
                                open: true,
                                influencerId: item.id,
                                influencerName: item.displayName || item.username,
                              })}
                            >
                              <ListPlus className="h-3 w-3" />
                              Add to...
                            </Button>
                            <button
                              onClick={() => handleReAnalyze(item.username, item.platform)}
                              className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                              title={t.analyze.refreshData}
                            >
                              <RefreshCw className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleRemoveFromList(item.id)}
                              className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-500"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="insights">
            {recentSearches.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                  <BarChart3 className="h-6 w-6" />
                </div>
                <p className="mt-4 text-sm text-gray-500">{t.analyze.insightsEmpty}</p>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.analyze.username}</TableHead>
                      <TableHead>{t.campaigns.followers}</TableHead>
                      <TableHead>Eng. Rate</TableHead>
                      <TableHead>Mdn. Likes</TableHead>
                      <TableHead>Mdn. Comments</TableHead>
                      <TableHead>Mdn. Views</TableHead>
                      <TableHead>{t.common.email}</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentSearches
                      .filter((item) => item.followers > 0)
                      .sort((a, b) => b.engagementRate - a.engagementRate)
                      .map((item) => (
                        <TableRow key={item.id} className="group">
                          <TableCell>
                            <button
                              onClick={() => handleReAnalyze(item.username, item.platform)}
                              className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                            >
                              <Avatar
                                name={item.displayName || item.username}
                                size="sm"
                                src={item.avatarUrl || undefined}
                              />
                              <div className="text-left">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium text-gray-900">{item.username}</span>
                                  <PlatformIcon platform={item.platform} />
                                </div>
                              </div>
                            </button>
                          </TableCell>
                          <TableCell className="font-medium">{formatNumber(item.followers)}</TableCell>
                          <TableCell>
                            <span className={
                              item.engagementRate >= 5
                                ? 'text-emerald-500 font-medium'
                                : item.engagementRate >= 3
                                  ? 'text-purple-600 font-medium'
                                  : 'text-gray-600'
                            }>
                              {item.engagementRate}%
                            </span>
                          </TableCell>
                          <TableCell>{formatNumber(item.avgLikes)}</TableCell>
                          <TableCell>{formatNumber(item.avgComments)}</TableCell>
                          <TableCell>{formatNumber(item.avgViews)}</TableCell>
                          <TableCell>
                            <span className="text-xs text-gray-500 max-w-[180px] truncate block">
                              {item.email || 'Not Provided'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="primary"
                                size="sm"
                                className="opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => setAddToModal({
                                  open: true,
                                  influencerId: item.id,
                                  influencerName: item.displayName || item.username,
                                })}
                              >
                                <ListPlus className="h-3 w-3" />
                                Add to...
                              </Button>
                              <button
                                onClick={() => handleReAnalyze(item.username, item.platform)}
                                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                              >
                                <RefreshCw className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleRemoveFromList(item.id)}
                                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-red-500"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Back to searches */}
      {profile && !analyzing && viewMode === 'profile' && (
        <div className="flex justify-center">
          <button
            onClick={() => { setProfile(null); setActiveTab('recent'); setViewMode('profile') }}
            className="text-sm text-gray-500 hover:text-purple-600 transition-colors inline-flex items-center gap-1"
          >
            ← {t.analyze.recentSearches}
          </button>
        </div>
      )}

      {/* Add to Campaign/List Modal */}
      <AddToModal
        open={addToModal.open}
        onClose={() => setAddToModal({ open: false, influencerId: '', influencerName: '' })}
        influencerId={addToModal.influencerId}
        influencerName={addToModal.influencerName}
      />
    </div>
  )
}
