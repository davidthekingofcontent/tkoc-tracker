'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  Instagram,
  ExternalLink,
  MapPin,
  Tag,
  Eye,
  Heart,
  MessageCircle,
  Share2,
  Bookmark,
  Loader2,
  ArrowLeft,
  ShieldCheck,
  TrendingUp,
  Globe,
  Clock,
  Hash as HashIcon,
  Building2,
  Users,
  ChevronRight,
  ListPlus,
  Mail,
  Link as LinkIcon,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'

// ============ TYPES ============

interface PlatformProfile {
  id: string
  platform: string
  username: string
  followers: number
  following: number
  postsCount: number
  engagementRate: number
  avgViews: number
  avgLikes: number
  avgComments: number
  medianViews: number | null
  bio: string | null
  avatarUrl: string | null
  isVerified: boolean
  lastScraped: string | null
  dataSource: string
}

interface CreatorPost {
  id: string
  platform: string
  mediaType: string
  caption: string | null
  likes: number
  comments: number
  views: number
  shares: number
  saves: number
  permalink: string | null
  thumbnailUrl: string | null
  postedAt: string | null
  hashtags: string[]
  isBrandCollab: boolean
  detectedBrand: string | null
}

interface BrandMention {
  brandName: string
  platform: string
  mentionType: string
  confidence: number
  detectedAt: string
}

interface GeoSignal {
  signalType: string
  value: string
  confidence: number
  source: string
}

interface CategorySignal {
  category: string
  confidence: number
  source: string
}

interface SpainFitBreakdown {
  score: number
  signal: string
  explanation: string
  components: Record<string, { score: number; detail: string; isInferred: boolean }>
  confidence: number
  isInferred: boolean
  calculatedAt: string
}

interface ScoreRecord {
  scoreType: string
  score: number
  signal: string
  explanation: string
  confidence: number
  calculatedAt: string
}

interface Snapshot {
  platform: string
  followers: number
  engagementRate: number | null
  avgViews: number | null
  capturedAt: string
}

interface CreatorData {
  id: string
  displayName: string | null
  primaryPlatform: string
  spainFitScore: number | null
  spainFitLevel: string | null
  categories: string[]
  primaryCategory: string | null
  primaryLanguage: string | null
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  geoConfidence: string
  contactEmail: string | null
  websiteUrl: string | null
  performanceScore: number | null
  riskLevel: string | null
  dataQualityScore: number | null
  creatorType: string | null
  isVerifiedCreator: boolean
  lastEnriched: string | null
  createdAt: string
  platformProfiles: PlatformProfile[]
  posts: CreatorPost[]
  brandMentions: BrandMention[]
  geoSignals: GeoSignal[]
  categorySignals: CategorySignal[]
  spainFitBreakdown: SpainFitBreakdown | null
  scoreRecords: ScoreRecord[]
  snapshots: Snapshot[]
}

// ============ HELPER COMPONENTS ============

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform.toUpperCase()) {
    case 'INSTAGRAM': return <Instagram className="h-5 w-5 text-pink-400" />
    case 'TIKTOK': return <span className="text-sm font-bold text-cyan-400">TT</span>
    case 'YOUTUBE': return <span className="text-sm font-bold text-red-400">YT</span>
    default: return null
  }
}

function getProfileUrl(username: string, platform: string) {
  switch (platform.toUpperCase()) {
    case 'TIKTOK': return `https://tiktok.com/@${username}`
    case 'YOUTUBE': return `https://youtube.com/@${username}`
    default: return `https://instagram.com/${username}`
  }
}

function SpainFitLargeBadge({ level, score }: { level: string | null; score: number | null }) {
  if (!level || level === 'unknown') return null

  const config: Record<string, { emoji: string; labelEs: string; labelEn: string; bgClass: string; textClass: string }> = {
    confirmed: { emoji: '\uD83C\uDDEA\uD83C\uDDF8', labelEs: 'Espana confirmado', labelEn: 'Spain confirmed', bgClass: 'bg-green-100 dark:bg-green-900/30', textClass: 'text-green-800 dark:text-green-400' },
    probable: { emoji: '\uD83D\uDFE1', labelEs: 'Espana probable', labelEn: 'Spain probable', bgClass: 'bg-yellow-100 dark:bg-yellow-900/30', textClass: 'text-yellow-800 dark:text-yellow-400' },
    partial: { emoji: '\uD83D\uDFE0', labelEs: 'Espana parcial', labelEn: 'Spain partial', bgClass: 'bg-orange-100 dark:bg-orange-900/30', textClass: 'text-orange-800 dark:text-orange-400' },
    hispanic_global: { emoji: '\uD83C\uDF0E', labelEs: 'Hispano global', labelEn: 'Hispanic global', bgClass: 'bg-blue-100 dark:bg-blue-900/30', textClass: 'text-blue-800 dark:text-blue-400' },
    latam: { emoji: '\uD83C\uDF0E', labelEs: 'LATAM', labelEn: 'LATAM', bgClass: 'bg-purple-100 dark:bg-purple-900/30', textClass: 'text-purple-800 dark:text-purple-300' },
  }

  const c = config[level]
  if (!c) return null

  return (
    <div className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 ${c.bgClass}`}>
      <span className="text-2xl">{c.emoji}</span>
      <div>
        <p className={`text-sm font-bold ${c.textClass}`}>{c.labelEs}</p>
        {score != null && <p className={`text-xs ${c.textClass} opacity-75`}>Score: {Math.round(score)}/100</p>}
      </div>
    </div>
  )
}

function SignalColor({ signal }: { signal: string }) {
  const colors: Record<string, string> = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    gray: 'bg-gray-400',
  }
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${colors[signal] || colors.gray}`} />
}

function ConfidenceBadge({ confidence, isInferred }: { confidence: number; isInferred: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
      isInferred
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
        : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
    }`}>
      {isInferred ? 'Inferred' : 'Observed'} {Math.round(confidence * 100)}%
    </span>
  )
}

// ============ MAIN PAGE ============

export default function CreatorProfilePage() {
  const params = useParams()
  const id = params.id as string
  const { locale } = useI18n()
  const isEs = locale === 'es'

  const [creator, setCreator] = useState<CreatorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetch(`/api/discovery/creators/${id}`)
      .then(r => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Creator not found' : 'Failed to load')
        return r.json()
      })
      .then(data => {
        setCreator(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-12 w-12 animate-spin text-purple-500" />
      </div>
    )
  }

  if (error || !creator) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">{error || 'Creator not found'}</p>
        <Link href="/discover" className="mt-4 text-sm text-purple-600 hover:text-purple-700 flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> {isEs ? 'Volver a busqueda' : 'Back to search'}
        </Link>
      </div>
    )
  }

  const primaryProfile = creator.platformProfiles[0]

  return (
    <div className="space-y-8 max-w-6xl">
      {/* Back link */}
      <Link href="/discover" className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors">
        <ArrowLeft className="h-4 w-4" /> {isEs ? 'Volver a busqueda' : 'Back to search'}
      </Link>

      {/* ============ HEADER ============ */}
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-8">
        <div className="flex items-start gap-6">
          <Avatar
            name={creator.displayName || primaryProfile?.username || '?'}
            size="lg"
            className="!h-20 !w-20 !text-2xl"
            src={primaryProfile?.avatarUrl ? proxyImg(primaryProfile.avatarUrl) : undefined}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {creator.displayName || primaryProfile?.username}
              </h1>
              {creator.isVerifiedCreator && <ShieldCheck className="h-5 w-5 text-blue-500" />}
            </div>

            {/* Platform links */}
            <div className="flex flex-wrap items-center gap-3 mb-3">
              {creator.platformProfiles.map(pp => (
                <a
                  key={pp.id}
                  href={getProfileUrl(pp.username, pp.platform)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <PlatformIcon platform={pp.platform} />
                  @{pp.username}
                  {pp.isVerified && <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />}
                  <ExternalLink className="h-3 w-3 opacity-50" />
                </a>
              ))}
            </div>

            {/* Spain Fit Badge */}
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <SpainFitLargeBadge level={creator.spainFitLevel} score={creator.spainFitScore} />
              {creator.geoCity && (
                <span className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                  <MapPin className="h-4 w-4" />
                  {creator.geoCity}{creator.geoProvince ? `, ${creator.geoProvince}` : ''}
                </span>
              )}
              {creator.primaryLanguage && (
                <span className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                  <Globe className="h-4 w-4" />
                  {creator.primaryLanguage.toUpperCase()}
                </span>
              )}
            </div>

            {/* Categories */}
            {creator.categories.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {creator.categories.map(cat => (
                  <span key={cat} className="inline-flex items-center gap-1 rounded-md bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                    <Tag className="h-3 w-3" />
                    {cat.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                  </span>
                ))}
              </div>
            )}

            {/* Contact info */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
              {creator.contactEmail && (
                <span className="inline-flex items-center gap-1">
                  <Mail className="h-3.5 w-3.5" /> {creator.contactEmail}
                </span>
              )}
              {creator.websiteUrl && (
                <a href={creator.websiteUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-purple-600">
                  <LinkIcon className="h-3.5 w-3.5" /> {creator.websiteUrl}
                </a>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 shrink-0">
            <button className="flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 transition-colors">
              <ListPlus className="h-4 w-4" /> {isEs ? 'Anadir a lista' : 'Add to list'}
            </button>
            <button className="flex items-center gap-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
              <Users className="h-4 w-4" /> {isEs ? 'Anadir a campana' : 'Add to campaign'}
            </button>
          </div>
        </div>
      </div>

      {/* ============ SPAIN FIT BREAKDOWN ============ */}
      {creator.spainFitBreakdown && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-1">
            Spain Fit {isEs ? 'Desglose' : 'Breakdown'}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{creator.spainFitBreakdown.explanation}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(creator.spainFitBreakdown.components).map(([key, comp]) => {
              const labels: Record<string, { es: string; en: string; icon: React.ReactNode }> = {
                languageScore: { es: 'Idioma', en: 'Language', icon: <Globe className="h-4 w-4" /> },
                locationScore: { es: 'Ubicacion', en: 'Location', icon: <MapPin className="h-4 w-4" /> },
                timezoneScore: { es: 'Zona horaria', en: 'Timezone', icon: <Clock className="h-4 w-4" /> },
                hashtagsScore: { es: 'Hashtags', en: 'Hashtags', icon: <HashIcon className="h-4 w-4" /> },
                brandsScore: { es: 'Marcas', en: 'Brands', icon: <Building2 className="h-4 w-4" /> },
                audienceScore: { es: 'Audiencia', en: 'Audience', icon: <Users className="h-4 w-4" /> },
              }
              const label = labels[key] || { es: key, en: key, icon: null }

              return (
                <div key={key} className="rounded-xl border border-gray-100 dark:border-gray-700 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                      {label.icon}
                      {isEs ? label.es : label.en}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900 dark:text-gray-100">{Math.round(comp.score)}</span>
                      <ConfidenceBadge confidence={comp.score / 100} isInferred={comp.isInferred} />
                    </div>
                  </div>
                  {/* Score bar */}
                  <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-700 mb-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        comp.score >= 70 ? 'bg-green-500' : comp.score >= 40 ? 'bg-yellow-500' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                      style={{ width: `${Math.min(100, comp.score)}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{comp.detail}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ============ PERFORMANCE METRICS ============ */}
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
          {isEs ? 'Rendimiento' : 'Performance'}
        </h2>

        {creator.platformProfiles.map(pp => (
          <div key={pp.id} className="mb-6 last:mb-0">
            <div className="flex items-center gap-2 mb-3">
              <PlatformIcon platform={pp.platform} />
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">@{pp.username}</span>
              {pp.lastScraped && (
                <span className="text-[10px] text-gray-400">
                  {isEs ? 'Actualizado' : 'Updated'}: {new Date(pp.lastScraped).toLocaleDateString()}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">{isEs ? 'Seguidores' : 'Followers'}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(pp.followers)}</p>
              </div>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">ER%</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{pp.engagementRate.toFixed(1)}%</p>
              </div>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">{isEs ? 'Vistas med.' : 'Avg views'}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{pp.avgViews > 0 ? formatNumber(pp.avgViews) : '--'}</p>
              </div>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">{isEs ? 'Likes med.' : 'Avg likes'}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{pp.avgLikes > 0 ? formatNumber(pp.avgLikes) : '--'}</p>
              </div>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">{isEs ? 'Posts' : 'Posts'}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(pp.postsCount)}</p>
              </div>
              <div className="rounded-xl bg-gray-50 dark:bg-gray-700/50 p-4">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-1">{isEs ? 'Siguiendo' : 'Following'}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(pp.following)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ============ RECENT POSTS ============ */}
      {creator.posts.length > 0 && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEs ? 'Posts recientes' : 'Recent Posts'} ({creator.posts.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {creator.posts.slice(0, 12).map(post => (
              <div key={post.id} className="rounded-xl border border-gray-100 dark:border-gray-700 p-4 hover:border-purple-300 dark:hover:border-purple-700 transition-colors">
                {post.thumbnailUrl && (
                  <div className="mb-3 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-700 aspect-square">
                    <img
                      src={proxyImg(post.thumbnailUrl)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                )}
                {post.caption && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 line-clamp-2">{post.caption}</p>
                )}
                <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span className="inline-flex items-center gap-1"><Heart className="h-3 w-3 text-pink-400" />{formatNumber(post.likes)}</span>
                  <span className="inline-flex items-center gap-1"><MessageCircle className="h-3 w-3 text-blue-400" />{formatNumber(post.comments)}</span>
                  {post.views > 0 && <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3 text-green-400" />{formatNumber(post.views)}</span>}
                  {post.shares > 0 && <span className="inline-flex items-center gap-1"><Share2 className="h-3 w-3" />{formatNumber(post.shares)}</span>}
                  {post.saves > 0 && <span className="inline-flex items-center gap-1"><Bookmark className="h-3 w-3" />{formatNumber(post.saves)}</span>}
                </div>
                {post.isBrandCollab && post.detectedBrand && (
                  <span className="mt-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                    <Building2 className="h-3 w-3 mr-0.5" /> {post.detectedBrand}
                  </span>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-[10px] text-gray-400">
                    {post.mediaType} {post.postedAt ? `- ${new Date(post.postedAt).toLocaleDateString()}` : ''}
                  </span>
                  {post.permalink && (
                    <a href={post.permalink} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-purple-500">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ BRAND MENTIONS ============ */}
      {creator.brandMentions.length > 0 && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEs ? 'Menciones de marcas' : 'Brand Mentions'} ({creator.brandMentions.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {creator.brandMentions.map((bm, i) => (
              <div key={`${bm.brandName}-${i}`} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-600 px-3 py-2">
                <Building2 className="h-4 w-4 text-gray-400" />
                <div>
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">{bm.brandName}</span>
                  <span className="ml-1 text-[10px] text-gray-400">({bm.mentionType})</span>
                </div>
                <span className={`inline-block h-2 w-2 rounded-full ${bm.confidence >= 0.8 ? 'bg-green-500' : bm.confidence >= 0.5 ? 'bg-yellow-500' : 'bg-gray-400'}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ GEOGRAPHIC SIGNALS ============ */}
      {creator.geoSignals.length > 0 && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEs ? 'Senales geograficas' : 'Geographic Signals'}
          </h2>
          <div className="space-y-3">
            {creator.geoSignals.map((gs, i) => (
              <div key={`${gs.signalType}-${i}`} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
                <div className="flex items-center gap-3">
                  <MapPin className="h-4 w-4 text-gray-400" />
                  <div>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{gs.value}</span>
                    <span className="ml-2 text-xs text-gray-400">{gs.signalType.replace(/_/g, ' ')}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${gs.confidence >= 0.8 ? 'bg-green-500' : gs.confidence >= 0.5 ? 'bg-yellow-500' : 'bg-gray-400'}`} />
                  <span className="text-xs text-gray-400">{Math.round(gs.confidence * 100)}%</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${gs.source === 'profile_data' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                    {gs.source === 'profile_data' ? 'Observed' : 'Inferred'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ SCORE HISTORY ============ */}
      {creator.snapshots.length > 1 && (
        <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEs ? 'Historial de crecimiento' : 'Growth History'}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{isEs ? 'Fecha' : 'Date'}</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{isEs ? 'Plataforma' : 'Platform'}</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{isEs ? 'Seguidores' : 'Followers'}</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">ER%</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">{isEs ? 'Vistas' : 'Views'}</th>
                </tr>
              </thead>
              <tbody>
                {creator.snapshots.map((s, i) => (
                  <tr key={`${s.capturedAt}-${i}`} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 px-3 text-gray-700 dark:text-gray-300">{new Date(s.capturedAt).toLocaleDateString()}</td>
                    <td className="py-2 px-3 text-gray-500 dark:text-gray-400">{s.platform}</td>
                    <td className="py-2 px-3 text-right font-medium text-gray-900 dark:text-gray-100">{formatNumber(s.followers)}</td>
                    <td className="py-2 px-3 text-right text-gray-700 dark:text-gray-300">{s.engagementRate != null ? `${s.engagementRate.toFixed(1)}%` : '--'}</td>
                    <td className="py-2 px-3 text-right text-gray-700 dark:text-gray-300">{s.avgViews != null ? formatNumber(s.avgViews) : '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============ DATA CONFIDENCE ============ */}
      <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-6">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">
          {isEs ? 'Confianza de datos' : 'Data Confidence'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
            <span className="text-sm text-gray-700 dark:text-gray-300">{isEs ? 'Ubicacion' : 'Location'}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${
              creator.geoConfidence === 'observed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              creator.geoConfidence === 'inferred' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
              'bg-gray-100 text-gray-500 dark:bg-gray-600 dark:text-gray-400'
            }`}>
              {creator.geoConfidence === 'observed' ? (isEs ? 'Observado' : 'Observed') :
               creator.geoConfidence === 'inferred' ? (isEs ? 'Inferido' : 'Inferred') :
               (isEs ? 'Desconocido' : 'Unknown')}
            </span>
          </div>
          {creator.scoreRecords.map((sr, i) => (
            <div key={`${sr.scoreType}-${i}`} className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
              <div className="flex items-center gap-2">
                <SignalColor signal={sr.signal} />
                <span className="text-sm text-gray-700 dark:text-gray-300">{sr.scoreType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{Math.round(sr.score)}/100</span>
                <span className="text-[10px] text-gray-400">{Math.round(sr.confidence * 100)}%</span>
              </div>
            </div>
          ))}
          {primaryProfile && (
            <div className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
              <span className="text-sm text-gray-700 dark:text-gray-300">{isEs ? 'Fuente de datos' : 'Data source'}</span>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{primaryProfile.dataSource}</span>
            </div>
          )}
          {creator.lastEnriched && (
            <div className="flex items-center justify-between rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
              <span className="text-sm text-gray-700 dark:text-gray-300">{isEs ? 'Ultimo enriquecimiento' : 'Last enriched'}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{new Date(creator.lastEnriched).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
