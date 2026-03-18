'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import {
  Search,
  Instagram,
  Youtube,
  Twitter,
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  lastScraped: string | null
}

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform.toLowerCase()) {
    case 'instagram':
      return <Instagram className="h-4 w-4 text-pink-400" />
    case 'youtube':
      return <Youtube className="h-4 w-4 text-red-400" />
    case 'tiktok':
      return <Twitter className="h-4 w-4 text-cyan-400" />
    default:
      return null
  }
}

const platformButtons = [
  { id: 'INSTAGRAM', label: 'Instagram', icon: Instagram, color: 'text-pink-400' },
  { id: 'TIKTOK', label: 'TikTok', icon: Twitter, color: 'text-cyan-400' },
  { id: 'YOUTUBE', label: 'YouTube', icon: Youtube, color: 'text-red-400' },
]

function getProfileUrl(username: string, platform: string) {
  switch (platform.toUpperCase()) {
    case 'TIKTOK': return `https://tiktok.com/@${username}`
    case 'YOUTUBE': return `https://youtube.com/@${username}`
    default: return `https://instagram.com/${username}`
  }
}

export default function AnalyzePage() {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState('INSTAGRAM')
  const [analyzing, setAnalyzing] = useState(false)
  const [profile, setProfile] = useState<AnalyzedProfile | null>(null)
  const [recentSearches, setRecentSearches] = useState<RecentAnalysis[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [activeTab, setActiveTab] = useState('recent')

  // Load recently analyzed profiles from DB
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
    setMessage('')
    setProfile(null)

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
      setMessage(data.message || '')
      setActiveTab('profile')

      // Refresh recent searches
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
    setMessage('')

    try {
      const res = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, platform }),
      })

      const data = await res.json()

      if (res.ok) {
        setProfile(data.influencer)
        setMessage(data.message || '')
        setActiveTab('profile')
        fetchRecentSearches()
      }
    } catch {
      // ignore
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.analyze.title}</h1>
        <p className="mt-1 text-sm text-gray-500">{t.analyze.subtitle}</p>
      </div>

      {/* Search Bar */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          {platformButtons.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPlatform(p.id)}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                selectedPlatform === p.id
                  ? 'border-purple-300 bg-purple-50 text-purple-600'
                  : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              <p.icon className={`h-4 w-4 ${selectedPlatform === p.id ? 'text-purple-600' : p.color}`} />
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-gray-400">
              <Search className="h-5 w-5" />
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
              placeholder={t.analyze.inputPlaceholder}
              className="block w-full rounded-lg border border-gray-200 bg-gray-50 py-3.5 pl-12 pr-4 text-base text-gray-900 placeholder-gray-400 transition-colors focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
              disabled={analyzing}
            />
          </div>
          <Button size="lg" onClick={handleAnalyze} disabled={analyzing || !query.trim()}>
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
          </Button>
        </div>

        {error && (
          <div className="mt-3 flex items-center gap-2 text-sm text-red-500">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        {message && !error && (
          <div className="mt-3 flex items-center gap-2 text-sm text-emerald-600">
            <CheckCircle className="h-4 w-4" />
            {message}
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="recent" value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="recent">{t.analyze.recentSearches}</TabsTrigger>
          {profile && <TabsTrigger value="profile">@{profile.username}</TabsTrigger>}
        </TabsList>

        {/* Recent Searches Tab */}
        <TabsContent value="recent">
          {recentSearches.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                <Search className="h-6 w-6" />
              </div>
              <p className="mt-4 text-sm text-gray-500">
                {t.analyze.insightsEmpty}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>{t.analyze.username}</TableHead>
                    <TableHead>{t.campaigns.followers}</TableHead>
                    <TableHead>{t.campaigns.engagement}</TableHead>
                    <TableHead>{t.analyze.medianLikes}</TableHead>
                    <TableHead>{t.analyze.medianComments}</TableHead>
                    <TableHead>{t.analyze.medianViews}</TableHead>
                    <TableHead>{t.common.email}</TableHead>
                    <TableHead className="text-right">{t.common.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentSearches.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <PlatformIcon platform={item.platform} />
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => handleReAnalyze(item.username, item.platform)}
                          className="font-medium text-gray-900 hover:text-purple-600 transition-colors inline-flex items-center gap-1.5"
                        >
                          @{item.username}
                          <ExternalLink className="h-3 w-3 text-gray-400" />
                        </button>
                      </TableCell>
                      <TableCell>{formatNumber(item.followers)}</TableCell>
                      <TableCell>
                        <span
                          className={
                            item.engagementRate >= 5
                              ? 'text-emerald-500'
                              : item.engagementRate >= 3
                                ? 'text-purple-600'
                                : 'text-gray-600'
                          }
                        >
                          {item.engagementRate}%
                        </span>
                      </TableCell>
                      <TableCell>{formatNumber(item.avgLikes)}</TableCell>
                      <TableCell>{formatNumber(item.avgComments)}</TableCell>
                      <TableCell>{formatNumber(item.avgViews)}</TableCell>
                      <TableCell>
                        <span className="text-xs text-gray-500">
                          {item.email || '—'}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                            title={t.analyze.addToList}
                          >
                            <ListPlus className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleReAnalyze(item.username, item.platform)}
                            className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                            title={t.analyze.refreshData}
                          >
                            <RefreshCw className="h-4 w-4" />
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

        {/* Profile Detail Tab */}
        {profile && (
          <TabsContent value="profile">
            <div className="space-y-6">
              {/* Profile Header Card */}
              <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
                <div className="flex items-start gap-5">
                  <Avatar
                    name={profile.displayName || profile.username}
                    size="lg"
                    src={profile.avatarUrl || undefined}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                      <h2 className="text-xl font-bold text-gray-900">
                        {profile.displayName || profile.username}
                      </h2>
                      {profile.isVerified && (
                        <CheckCircle className="h-5 w-5 text-blue-500" />
                      )}
                      <Badge variant={
                        profile.platform === 'INSTAGRAM' ? 'instagram' as 'active' :
                        profile.platform === 'TIKTOK' ? 'tiktok' as 'active' : 'youtube' as 'active'
                      }>
                        <PlatformIcon platform={profile.platform} />
                        {profile.platform.charAt(0) + profile.platform.slice(1).toLowerCase()}
                      </Badge>
                    </div>
                    <a
                      href={getProfileUrl(profile.username, profile.platform)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-purple-600 hover:underline inline-flex items-center gap-1 mt-0.5"
                    >
                      @{profile.username}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {profile.bio && (
                      <p className="mt-2 text-sm text-gray-600 max-w-2xl">{profile.bio}</p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
                      {profile.email && <span>📧 {profile.email}</span>}
                      {profile.website && (
                        <a href={profile.website} target="_blank" rel="noopener noreferrer" className="hover:text-purple-600">
                          🔗 {profile.website}
                        </a>
                      )}
                      {(profile.country || profile.city) && (
                        <span>📍 {[profile.city, profile.country].filter(Boolean).join(', ')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
              </div>

              {/* Additional Stats */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
                <StatCard
                  icon={<BarChart3 className="h-5 w-5" />}
                  label="Posts"
                  value={formatNumber(profile.postsCount)}
                />
                <StatCard
                  icon={<BarChart3 className="h-5 w-5" />}
                  label="Media"
                  value={profile._count.media}
                />
              </div>

              {/* Recent Posts */}
              {profile.media && profile.media.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    {t.campaigns.mediaTab} ({profile.media.length})
                  </h3>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                    {profile.media.map((media) => (
                      <div key={media.id} className="rounded-xl border border-gray-200 bg-white overflow-hidden hover:shadow-md transition-shadow">
                        {media.permalink ? (
                          <a href={media.permalink} target="_blank" rel="noopener noreferrer">
                            <div className="relative h-40 bg-gray-100 flex items-center justify-center">
                              {media.thumbnailUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={media.thumbnailUrl}
                                  alt={media.caption || ''}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <span className="text-xs text-gray-400">{media.mediaType}</span>
                              )}
                            </div>
                          </a>
                        ) : (
                          <div className="relative h-40 bg-gray-100 flex items-center justify-center">
                            <span className="text-xs text-gray-400">{media.mediaType}</span>
                          </div>
                        )}
                        <div className="p-3">
                          {media.caption && (
                            <p className="text-xs text-gray-600 line-clamp-2 mb-2">{media.caption}</p>
                          )}
                          <div className="flex items-center gap-3 text-xs text-gray-500">
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
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
