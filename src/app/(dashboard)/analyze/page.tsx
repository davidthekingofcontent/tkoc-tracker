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
  Link2,
  Mail,
  X,
  Play,
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
  avatarUrl: string | null
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
  const [successMsg, setSuccessMsg] = useState('')
  const [activeTab, setActiveTab] = useState('recent')

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

  function handleRemoveFromList(id: string) {
    setRecentSearches((prev) => prev.filter((item) => item.id !== id))
  }

  const commentLikeRatio = profile && profile.avgLikes > 0
    ? `1:${Math.round(profile.avgLikes / Math.max(profile.avgComments, 1))}`
    : null

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
            {selectedPlatform === 'TIKTOK' && <Twitter className="h-4 w-4 text-cyan-400" />}
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

        <Button size="lg" onClick={handleAnalyze} disabled={analyzing || !query.trim()} className="min-w-[180px]">
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

      {/* Profile Detail View */}
      {profile && !analyzing && (
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

                <div className="mt-5">
                  <Button variant="primary" className="w-full bg-emerald-500 hover:bg-emerald-600">
                    <ListPlus className="h-4 w-4" />
                    {t.analyze.addToList}
                  </Button>
                </div>
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
                      className="group relative aspect-square bg-gray-100 rounded-lg overflow-hidden"
                    >
                      {media.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={media.thumbnailUrl}
                          alt={media.caption || ''}
                          className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <span className="text-xs text-gray-400">{media.mediaType}</span>
                        </div>
                      )}
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
                              size="sm"
                              className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
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
                                size="sm"
                                className="bg-emerald-500 hover:bg-emerald-600 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
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
      {profile && !analyzing && (
        <div className="flex justify-center">
          <button
            onClick={() => { setProfile(null); setActiveTab('recent') }}
            className="text-sm text-gray-500 hover:text-purple-600 transition-colors inline-flex items-center gap-1"
          >
            ← {t.analyze.recentSearches}
          </button>
        </div>
      )}
    </div>
  )
}
