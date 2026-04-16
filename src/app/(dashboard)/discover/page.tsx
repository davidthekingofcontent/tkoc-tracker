'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Search,
  RotateCcw,
  Compass,
  Instagram,
  ExternalLink,
  ListPlus,
  Loader2,
  CheckCircle2,
  X,
  Hash,
  AtSign,
  Eye,
  Heart,
  Database,
  Radio,
  MapPin,
  Tag,
  ChevronDown,
  ClipboardList,
} from 'lucide-react'
import { Select } from '@/components/ui/select'
import { Avatar } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'
import Link from 'next/link'

// ============ TYPES ============

interface DiscoverResult {
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  platform: string
  source: 'apify' | 'database'
  enriched?: boolean
  bio?: string | null
  country?: string | null
  city?: string | null
}

interface DbCreatorResult {
  id: string
  displayName: string | null
  primaryPlatform: string
  spainFitScore: number | null
  spainFitLevel: string | null
  categories: string[]
  categorySignals: Array<{ category: string; confidence: number }>
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  performanceScore: number | null
  username: string
  platform: string
  followers: number
  engagementRate: number
  avgViews: number
  avgLikes: number
  avatarUrl: string | null
  platformProfiles: Array<{
    id: string
    platform: string
    username: string
    followers: number
    engagementRate: number
    avgViews: number
    avgLikes: number
    avatarUrl: string | null
    bio: string | null
    isVerified: boolean
  }>
}

interface ListItem {
  id: string
  name: string
}

interface FilterOptions {
  categories: Record<string, Array<{ slug: string; nameEs: string; nameEn: string }>>
  cities: string[]
  provinces: string[]
  spainFitLevels: Array<{ level: string | null; count: number }>
}

type SearchMode = 'username' | 'category'

// ============ HELPER COMPONENTS ============

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform.toUpperCase()) {
    case 'INSTAGRAM': return <Instagram className="h-4 w-4 text-pink-400" />
    case 'TIKTOK': return <span className="text-xs font-bold text-cyan-400">TT</span>
    case 'YOUTUBE': return <span className="text-xs font-bold text-red-400">YT</span>
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

function ErBadge({ rate }: { rate: number }) {
  const color = rate >= 5
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
    : rate >= 3
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>
      {rate > 0 ? `${rate.toFixed(1)}%` : '--'}
    </span>
  )
}

function SpainFitBadge({ level, score }: { level: string | null; score: number | null }) {
  if (!level || level === 'unknown') return null

  const config: Record<string, { emoji: string; label: string; labelEs: string; className: string }> = {
    confirmed: {
      emoji: '\uD83C\uDDEA\uD83C\uDDF8',
      label: 'Spain confirmed',
      labelEs: 'Espana confirmado',
      className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    },
    probable: {
      emoji: '\uD83D\uDFE1',
      label: 'Spain probable',
      labelEs: 'Espana probable',
      className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    },
    partial: {
      emoji: '\uD83D\uDFE0',
      label: 'Spain partial',
      labelEs: 'Espana parcial',
      className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    },
    hispanic_global: {
      emoji: '\uD83C\uDF0E',
      label: 'Hispanic global',
      labelEs: 'Hispano global',
      className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    },
    latam: {
      emoji: '\uD83C\uDF0E',
      label: 'LATAM',
      labelEs: 'LATAM',
      className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    },
  }

  const c = config[level]
  if (!c) return null

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.className}`}>
      {c.emoji} {score != null ? `${Math.round(score)}` : ''} {c.labelEs}
    </span>
  )
}

function CategoryTag({ slug, isEs }: { slug: string; isEs: boolean }) {
  // Format slug to display name
  const name = slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase())

  return (
    <span className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
      {isEs ? name : name}
    </span>
  )
}

// ============ MAIN PAGE ============

export default function DiscoverPage() {
  const { t, locale } = useI18n()
  const isEs = locale === 'es'

  const [activeTab, setActiveTab] = useState('database')

  // ============ DATABASE TAB STATE ============
  const [dbQuery, setDbQuery] = useState('')
  const [dbPlatform, setDbPlatform] = useState('all')
  const [dbSpainFitLevel, setDbSpainFitLevel] = useState('all')
  const [dbCategory, setDbCategory] = useState('')
  const [dbFollowersMin, setDbFollowersMin] = useState('')
  const [dbFollowersMax, setDbFollowersMax] = useState('')
  const [dbCity, setDbCity] = useState('')
  const [dbSortBy, setDbSortBy] = useState('followers')
  const [dbSortDir, setDbSortDir] = useState<'asc' | 'desc'>('desc')
  const [dbResults, setDbResults] = useState<DbCreatorResult[]>([])
  const [dbTotal, setDbTotal] = useState(0)
  const [dbOffset, setDbOffset] = useState(0)
  const [dbSearching, setDbSearching] = useState(false)
  const [dbHasSearched, setDbHasSearched] = useState(false)
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null)

  // ============ BULK PASTE STATE ============
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkPlatform, setBulkPlatform] = useState('INSTAGRAM')
  const [bulkProcessing, setBulkProcessing] = useState(false)
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 })
  const [bulkResult, setBulkResult] = useState<{ found: number; scraped: number; errors: number } | null>(null)

  const bulkHandles = useMemo(() => {
    return bulkText.split(/[\n,;]+/).map(h => h.trim()).filter(h => h.length > 0)
  }, [bulkText])

  // ============ LIVE SEARCH TAB STATE ============
  const [searchMode, setSearchMode] = useState<SearchMode>('category')
  const [platform, setPlatform] = useState('instagram')
  const [searchInput, setSearchInput] = useState('')
  const [followersMin, setFollowersMin] = useState('')
  const [followersMax, setFollowersMax] = useState('')
  const [locationFilter, setLocationFilter] = useState('')
  const [engagementFilter, setEngagementFilter] = useState('')
  const [bioKeywordFilter, setBioKeywordFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(50)
  const [results, setResults] = useState<DiscoverResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [total, setTotal] = useState(0)
  const [source, setSource] = useState<'apify' | 'database'>('database')
  const [sortField, setSortField] = useState<string>('followers')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // ============ SHARED STATE ============
  const [lists, setLists] = useState<ListItem[]>([])
  const [addToListModal, setAddToListModal] = useState<{ username: string; platform: string } | null>(null)
  const [addingToList, setAddingToList] = useState(false)
  const [addToListResult, setAddToListResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Load lists and filter options
  useEffect(() => {
    fetch('/api/lists').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.lists) setLists(data.lists)
    }).catch(() => {})

    fetch('/api/discovery/search').then(r => r.ok ? r.json() : null).then(data => {
      if (data) setFilterOptions(data)
    }).catch(() => {})
  }, [])

  // ============ DATABASE SEARCH ============
  const handleDbSearch = useCallback(async (newOffset = 0) => {
    setDbSearching(true)
    setDbHasSearched(true)
    if (newOffset === 0) {
      setDbResults([])
    }

    try {
      const body: Record<string, unknown> = {
        offset: newOffset,
        limit: 50,
        sortBy: dbSortBy,
        sortDir: dbSortDir,
      }

      if (dbQuery.trim()) body.query = dbQuery.trim()
      if (dbPlatform !== 'all') body.platform = dbPlatform
      if (dbSpainFitLevel !== 'all') body.spainFitLevel = dbSpainFitLevel
      if (dbCategory) body.category = dbCategory
      if (dbFollowersMin) body.minFollowers = parseInt(dbFollowersMin, 10)
      if (dbFollowersMax) body.maxFollowers = parseInt(dbFollowersMax, 10)
      if (dbCity.trim()) body.city = dbCity.trim()

      const res = await fetch('/api/discovery/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        const data = await res.json()
        if (newOffset === 0) {
          setDbResults(data.results || [])
        } else {
          setDbResults(prev => [...prev, ...(data.results || [])])
        }
        setDbTotal(data.total || 0)
        setDbOffset(newOffset)
      }
    } catch {
      // Error handled by empty results
    } finally {
      setDbSearching(false)
    }
  }, [dbQuery, dbPlatform, dbSpainFitLevel, dbCategory, dbFollowersMin, dbFollowersMax, dbCity, dbSortBy, dbSortDir])

  const handleDbLoadMore = () => {
    handleDbSearch(dbOffset + 50)
  }

  const handleBulkProcess = useCallback(async () => {
    if (bulkHandles.length === 0) return
    setBulkProcessing(true)
    setBulkResult(null)
    setBulkProgress({ current: 0, total: bulkHandles.length })

    try {
      const res = await fetch('/api/discovery/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handles: bulkHandles, platform: bulkPlatform }),
      })

      if (res.ok) {
        const data = await res.json()
        setBulkResult({ found: data.found, scraped: data.scraped, errors: data.errors })
        setBulkProgress({ current: data.total, total: data.total })

        // If there are successful results, load them into the database results
        const creatorIds = (data.results || [])
          .filter((r: { creatorId?: string }) => r.creatorId)
          .map((r: { creatorId: string }) => r.creatorId)

        if (creatorIds.length > 0) {
          // Trigger a search to show processed creators
          handleDbSearch(0)
        }
      }
    } catch {
      setBulkResult({ found: 0, scraped: 0, errors: bulkHandles.length })
    } finally {
      setBulkProcessing(false)
    }
  }, [bulkHandles, bulkPlatform, handleDbSearch])

  const resetDbFilters = () => {
    setDbQuery('')
    setDbPlatform('all')
    setDbSpainFitLevel('all')
    setDbCategory('')
    setDbFollowersMin('')
    setDbFollowersMax('')
    setDbCity('')
    setDbSortBy('followers')
    setDbSortDir('desc')
    setDbHasSearched(false)
    setDbResults([])
    setDbTotal(0)
    setDbOffset(0)
  }

  // ============ LIVE SEARCH (Apify) ============
  const sortedResults = useMemo(() => {
    const getValue = (item: DiscoverResult, field: string): number => {
      switch (field) {
        case 'followers': return item.followers || 0
        case 'engagementRate': return item.engagementRate || 0
        case 'avgLikes': return item.avgLikes || 0
        case 'avgComments': return item.avgComments || 0
        case 'avgViews': return item.avgViews || 0
        default: return 0
      }
    }
    return [...results].sort((a, b) => {
      const aVal = getValue(a, sortField)
      const bVal = getValue(b, sortField)
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal
    })
  }, [results, sortField, sortDir])

  const filteredResults = useMemo(() => {
    let filtered = sortedResults
    const minF = followersMin ? parseInt(followersMin, 10) : 0
    const maxF = followersMax ? parseInt(followersMax, 10) : 0
    if (minF > 0) filtered = filtered.filter(r => r.followers >= minF || r.followers === 0)
    if (maxF > 0) filtered = filtered.filter(r => r.followers <= maxF || r.followers === 0)
    if (engagementFilter) {
      const minEng = parseFloat(engagementFilter)
      filtered = filtered.filter(r => r.engagementRate >= minEng || r.engagementRate === 0)
    }
    if (locationFilter.trim()) {
      const loc = locationFilter.trim().toLowerCase()
      const locationAliases: Record<string, string[]> = {
        'spain': ['espana', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'malaga', 'bilbao', 'es'],
        'espana': ['espana', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'malaga', 'bilbao', 'es'],
        'mexico': ['mexico', 'cdmx', 'mx', 'guadalajara', 'monterrey'],
        'argentina': ['argentina', 'buenos aires', 'ar'],
        'colombia': ['colombia', 'bogota', 'medellin', 'co'],
      }
      const searchTerms = locationAliases[loc] || [loc]
      filtered = filtered.filter(r => {
        const country = (r.country || '').toLowerCase()
        const city = (r.city || '').toLowerCase()
        const bio = (r.bio || '').toLowerCase()
        const hasLocationData = country || city || bio
        if (!hasLocationData) return true
        return searchTerms.some(term =>
          country.includes(term) || city.includes(term) || bio.includes(term)
        )
      })
    }
    return filtered
  }, [sortedResults, followersMin, followersMax, engagementFilter, locationFilter])

  const paginatedResults = useMemo(() => {
    return filteredResults.slice(0, visibleCount)
  }, [filteredResults, visibleCount])
  const hasMore = filteredResults.length > visibleCount

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const resetFilters = () => {
    setSearchInput('')
    setFollowersMin('')
    setFollowersMax('')
    setLocationFilter('')
    setEngagementFilter('')
    setBioKeywordFilter('')
    setPlatform('instagram')
    setHasSearched(false)
    setResults([])
    setVisibleCount(50)
  }

  const handleAddToList = async (listId: string) => {
    if (!addToListModal) return
    setAddingToList(true)
    setAddToListResult(null)
    try {
      const analyzeRes = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: addToListModal.username, platform: addToListModal.platform.toUpperCase() }),
      })
      const analyzeData = await analyzeRes.json()
      const influencerId = analyzeData.influencer?.id || analyzeData.id
      if (!influencerId) {
        setAddToListResult({ type: 'error', message: 'Could not find influencer' })
        return
      }
      const addRes = await fetch(`/api/lists/${listId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ influencerId }),
      })
      if (addRes.ok) {
        setAddToListResult({ type: 'success', message: t.campaignDetail.addedSuccess })
        setTimeout(() => { setAddToListModal(null); setAddToListResult(null) }, 1500)
      } else if (addRes.status === 409) {
        setAddToListResult({ type: 'error', message: t.campaignDetail.alreadyAdded })
      } else {
        setAddToListResult({ type: 'error', message: 'Failed to add' })
      }
    } catch {
      setAddToListResult({ type: 'error', message: 'Network error' })
    } finally {
      setAddingToList(false)
    }
  }

  const handleSearch = async () => {
    if (!searchInput.trim()) return
    setSearching(true)
    setHasSearched(true)
    setResults([])
    setVisibleCount(50)

    try {
      const res = await fetch('/api/influencers/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchInput,
          platform: platform || 'instagram',
          mode: searchMode,
          minFollowers: followersMin ? parseInt(followersMin, 10) : undefined,
          maxFollowers: followersMax ? parseInt(followersMax, 10) : undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const items: DiscoverResult[] = data.results || []
        setResults(items)
        setTotal(items.length)
        setSource(data.source || 'database')
      } else {
        setResults([])
        setTotal(0)
      }
    } catch {
      setResults([])
      setTotal(0)
    } finally {
      setSearching(false)
    }
  }

  // ============ RENDER ============

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.discover.title}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-300">{t.discover.subtitle}</p>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="database" value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="border-b border-gray-200 dark:border-gray-700">
          <TabsTrigger value="database" className="dark:text-gray-300 dark:data-[state=active]:text-purple-400">
            <Database className="h-4 w-4 mr-1.5" />
            {isEs ? 'Base de datos' : 'Database'}
          </TabsTrigger>
          <TabsTrigger value="live" className="dark:text-gray-300 dark:data-[state=active]:text-purple-400">
            <Radio className="h-4 w-4 mr-1.5" />
            {isEs ? 'Buscar en vivo' : 'Live Search'}
          </TabsTrigger>
        </TabsList>

        {/* ============ DATABASE TAB ============ */}
        <TabsContent value="database">
          {/* Bulk Paste Panel */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setBulkOpen(!bulkOpen)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-purple-300 dark:hover:border-purple-700 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all"
            >
              <ClipboardList className="h-4 w-4 text-purple-500" />
              {isEs ? 'Pegar lista de handles' : 'Paste handle list'}
              <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${bulkOpen ? 'rotate-180' : ''}`} />
            </button>

            {bulkOpen && (
              <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
                <div className="flex gap-4">
                  <div className="flex-1">
                    <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                      {isEs ? 'Handles' : 'Handles'}
                    </label>
                    <textarea
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      rows={5}
                      placeholder={isEs
                        ? 'Pega aqui los @handles separados por saltos de linea o comas\n@usuario1\n@usuario2\nhttps://instagram.com/usuario3'
                        : 'Paste @handles separated by line breaks or commas\n@user1\n@user2\nhttps://instagram.com/user3'}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 transition-colors font-mono"
                    />
                    <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                      {bulkHandles.length > 0
                        ? (isEs ? `${bulkHandles.length} handles detectados` : `${bulkHandles.length} handles detected`)
                        : (isEs ? '0 handles detectados' : '0 handles detected')}
                    </p>
                  </div>
                  <div className="w-48 shrink-0 space-y-3">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                        {isEs ? 'Plataforma' : 'Platform'}
                      </label>
                      <select
                        value={bulkPlatform}
                        onChange={(e) => setBulkPlatform(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                      >
                        <option value="INSTAGRAM">Instagram</option>
                        <option value="TIKTOK">TikTok</option>
                        <option value="YOUTUBE">YouTube</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={handleBulkProcess}
                      disabled={bulkProcessing || bulkHandles.length === 0}
                      className="w-full flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/25 hover:bg-purple-700 active:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      {bulkProcessing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {isEs ? 'Procesando...' : 'Processing...'}
                        </>
                      ) : (
                        <>
                          <Search className="h-4 w-4" />
                          {isEs ? 'Procesar todos' : 'Process all'}
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                {bulkProcessing && bulkProgress.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        {isEs
                          ? `Procesando ${bulkProgress.current}/${bulkProgress.total}...`
                          : `Processing ${bulkProgress.current}/${bulkProgress.total}...`}
                      </span>
                      <span>{Math.round((bulkProgress.current / bulkProgress.total) * 100)}%</span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-purple-500 transition-all duration-300"
                        style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Results summary */}
                {bulkResult && !bulkProcessing && (
                  <div className="flex items-center gap-4 rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {isEs
                          ? `${bulkResult.found} encontrados, ${bulkResult.scraped} scrapeados, ${bulkResult.errors} errores`
                          : `${bulkResult.found} found, ${bulkResult.scraped} scraped, ${bulkResult.errors} errors`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => { handleDbSearch(0); setBulkOpen(false) }}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 transition-colors"
                    >
                      <Database className="h-3.5 w-3.5" />
                      {isEs ? 'Ver resultados' : 'View results'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-6">
            {/* Filters Sidebar */}
            <div className="w-80 shrink-0 space-y-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-300">
                  {t.discover.filters}
                </h2>
                <button onClick={resetDbFilters} className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                  <RotateCcw className="h-3 w-3" />
                  {t.discover.reset}
                </button>
              </div>

              {/* Text Search */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {isEs ? 'Buscar' : 'Search'}
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    <Search className="h-4 w-4 text-gray-400" />
                  </div>
                  <input
                    type="text"
                    value={dbQuery}
                    onChange={(e) => setDbQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleDbSearch(0)}
                    placeholder={isEs ? 'Nombre, @usuario, bio...' : 'Name, @username, bio...'}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 pl-9 pr-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 transition-colors"
                  />
                </div>
              </div>

              {/* Platform */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t.campaigns.platform}
                </label>
                <select
                  value={dbPlatform}
                  onChange={(e) => setDbPlatform(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  <option value="all">{isEs ? 'Todas' : 'All'}</option>
                  <option value="INSTAGRAM">Instagram</option>
                  <option value="TIKTOK">TikTok</option>
                  <option value="YOUTUBE">YouTube</option>
                </select>
              </div>

              {/* Spain Fit Level */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Spain Fit
                </label>
                <select
                  value={dbSpainFitLevel}
                  onChange={(e) => setDbSpainFitLevel(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  <option value="all">{isEs ? 'Todos' : 'All'}</option>
                  <option value="confirmed">{'\uD83C\uDDEA\uD83C\uDDF8'} {isEs ? 'Espana confirmado' : 'Spain confirmed'}</option>
                  <option value="probable">{'\uD83D\uDFE1'} {isEs ? 'Espana probable' : 'Spain probable'}</option>
                  <option value="partial">{'\uD83D\uDFE0'} {isEs ? 'Espana parcial' : 'Spain partial'}</option>
                  <option value="hispanic_global">{'\uD83C\uDF0E'} {isEs ? 'Hispano global' : 'Hispanic global'}</option>
                </select>
              </div>

              {/* Category */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  <Tag className="h-3.5 w-3.5 inline mr-1" />
                  {isEs ? 'Categoria' : 'Category'}
                </label>
                <select
                  value={dbCategory}
                  onChange={(e) => setDbCategory(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  <option value="">{isEs ? 'Todas las categorias' : 'All categories'}</option>
                  {filterOptions?.categories && Object.entries(filterOptions.categories).map(([parent, cats]) => (
                    <optgroup key={parent} label={parent.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}>
                      {cats.map(cat => (
                        <option key={cat.slug} value={cat.slug}>
                          {isEs ? cat.nameEs : cat.nameEn}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {/* Followers Range */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t.campaigns.followers}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    placeholder={t.discover.minFollowers}
                    value={dbFollowersMin}
                    onChange={(e) => setDbFollowersMin(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                  <span className="text-gray-400 shrink-0">-</span>
                  <input
                    type="number"
                    placeholder={t.discover.maxFollowers}
                    value={dbFollowersMax}
                    onChange={(e) => setDbFollowersMax(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
              </div>

              {/* City / Province */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  <MapPin className="h-3.5 w-3.5 inline mr-1" />
                  {isEs ? 'Ciudad / Provincia' : 'City / Province'}
                </label>
                <input
                  type="text"
                  value={dbCity}
                  onChange={(e) => setDbCity(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleDbSearch(0)}
                  placeholder={isEs ? 'Madrid, Barcelona...' : 'Madrid, Barcelona...'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  list="city-suggestions"
                />
                {filterOptions?.cities && filterOptions.cities.length > 0 && (
                  <datalist id="city-suggestions">
                    {filterOptions.cities.map(c => (
                      <option key={c} value={c!} />
                    ))}
                  </datalist>
                )}
              </div>

              {/* Sort */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {isEs ? 'Ordenar por' : 'Sort by'}
                </label>
                <div className="flex gap-2">
                  <select
                    value={dbSortBy}
                    onChange={(e) => setDbSortBy(e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  >
                    <option value="followers">{isEs ? 'Seguidores' : 'Followers'}</option>
                    <option value="engagementRate">{isEs ? 'Engagement' : 'Engagement'}</option>
                    <option value="spainFitScore">Spain Fit</option>
                    <option value="performanceScore">{isEs ? 'Rendimiento' : 'Performance'}</option>
                  </select>
                  <button
                    onClick={() => setDbSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                    className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
                  >
                    {dbSortDir === 'asc' ? '\u2191' : '\u2193'}
                  </button>
                </div>
              </div>

              {/* Search Button */}
              <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-600 pt-4">
                <button
                  type="button"
                  onClick={() => handleDbSearch(0)}
                  disabled={dbSearching}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/25 hover:bg-purple-700 active:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {dbSearching ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      {isEs ? 'Buscando...' : 'Searching...'}
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5" />
                      {t.common.search}
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Results Area */}
            <div className="flex-1 min-w-0">
              {/* Loading */}
              {dbSearching && dbResults.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-24">
                  <Loader2 className="h-12 w-12 animate-spin text-purple-500 mb-4" />
                  <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                    {isEs ? 'Buscando en base de datos...' : 'Searching database...'}
                  </p>
                </div>
              )}

              {/* Empty before search */}
              {!dbHasSearched && !dbSearching && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-32">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-400">
                    <Database className="h-7 w-7" />
                  </div>
                  <p className="mt-5 text-base font-medium text-gray-500 dark:text-gray-400">
                    {isEs ? 'Busca creadores en tu base de datos' : 'Search creators in your database'}
                  </p>
                  <p className="mt-2 text-sm text-gray-400 dark:text-gray-500 max-w-md text-center">
                    {isEs
                      ? 'Filtra por Spain Fit, categoria, seguidores, ubicacion y mas. Haz clic en "Buscar" para ver todos los creadores.'
                      : 'Filter by Spain Fit, category, followers, location and more. Click "Search" to see all creators.'}
                  </p>
                </div>
              )}

              {/* No results */}
              {dbHasSearched && !dbSearching && dbResults.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-20 px-8">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-500 mb-4">
                    <Search className="h-7 w-7" />
                  </div>
                  <p className="text-base font-semibold text-gray-700 dark:text-gray-200">{t.common.noResults}</p>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 text-center max-w-md">
                    {isEs
                      ? 'No se encontraron creadores. Prueba a cambiar los filtros, hacer una busqueda en vivo, o seed the database.'
                      : 'No creators found. Try changing filters, doing a live search, or seeding the database.'}
                  </p>
                </div>
              )}

              {/* Results */}
              {dbResults.length > 0 && (
                <div className="space-y-4">
                  {/* Results header */}
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {isEs
                        ? `Mostrando ${dbResults.length} de ${dbTotal}`
                        : `Showing ${dbResults.length} of ${dbTotal}`}
                    </p>
                    <span className="inline-flex items-center rounded-full bg-purple-50 dark:bg-purple-900/30 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                      <Database className="h-3 w-3 mr-1" />
                      {isEs ? 'Base de datos' : 'Database'}
                    </span>
                  </div>

                  {/* Card Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {dbResults.map((item) => (
                      <div
                        key={item.id}
                        className="group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm hover:shadow-md hover:border-purple-300 dark:hover:border-purple-700 transition-all p-5"
                      >
                        {/* Card Header */}
                        <div className="flex items-start gap-3 mb-3">
                          <Avatar
                            name={item.displayName || item.username}
                            size="lg"
                            src={item.avatarUrl ? proxyImg(item.avatarUrl) : undefined}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                                @{item.username}
                              </span>
                              <PlatformIcon platform={item.platform} />
                            </div>
                            {item.displayName && item.displayName !== item.username && (
                              <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{item.displayName}</p>
                            )}
                            <SpainFitBadge level={item.spainFitLevel} score={item.spainFitScore} />
                          </div>
                        </div>

                        {/* Categories */}
                        {item.categories.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-3">
                            {item.categories.slice(0, 3).map((cat) => (
                              <CategoryTag key={cat} slug={cat} isEs={isEs} />
                            ))}
                          </div>
                        )}

                        {/* Stats */}
                        <div className="grid grid-cols-2 gap-3 mb-3">
                          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                            <p className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t.campaigns.followers}</p>
                            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                              {item.followers > 0 ? formatNumber(item.followers) : '--'}
                            </p>
                          </div>
                          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                            <p className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">{t.discover.engRate}</p>
                            <div className="mt-1"><ErBadge rate={item.engagementRate} /></div>
                          </div>
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <Eye className="h-3.5 w-3.5 text-blue-400" />
                            <div>
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                                {item.avgViews > 0 ? formatNumber(item.avgViews) : '--'}
                              </p>
                              <p className="text-[10px] text-gray-400">{isEs ? 'Vistas med.' : 'Avg views'}</p>
                            </div>
                          </div>
                          {item.geoCity && (
                            <div className="flex items-center gap-2 px-3 py-1.5">
                              <MapPin className="h-3.5 w-3.5 text-green-400" />
                              <div>
                                <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate">
                                  {item.geoCity}
                                </p>
                                {item.geoProvince && (
                                  <p className="text-[10px] text-gray-400 truncate">{item.geoProvince}</p>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                          <button
                            type="button"
                            onClick={() => setAddToListModal({ username: item.username, platform: item.platform })}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700 transition-colors"
                          >
                            <ListPlus className="h-3.5 w-3.5" />
                            {t.discover.addTo}
                          </button>
                          <Link
                            href={`/creators/${item.id}`}
                            className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            {isEs ? 'Ver perfil' : 'View'}
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Load More */}
                  {dbResults.length < dbTotal && (
                    <div className="flex justify-center pt-4">
                      <button
                        type="button"
                        onClick={handleDbLoadMore}
                        disabled={dbSearching}
                        className="flex items-center gap-2 rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-800 px-8 py-3 text-sm font-semibold text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all disabled:opacity-50"
                      >
                        {dbSearching ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                        {isEs
                          ? `Cargar mas (${dbTotal - dbResults.length} restantes)`
                          : `Load more (${dbTotal - dbResults.length} remaining)`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ============ LIVE SEARCH TAB ============ */}
        <TabsContent value="live">
          <div className="flex gap-6">
            {/* Left Sidebar Filters */}
            <div className="w-80 shrink-0 space-y-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-300">
                  {t.discover.filters}
                </h2>
                <button onClick={resetFilters} className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors">
                  <RotateCcw className="h-3 w-3" />
                  {t.discover.reset}
                </button>
              </div>

              {/* Search Mode Tabs */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {isEs ? 'Modo de busqueda' : 'Search mode'}
                </label>
                <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setSearchMode('username')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition-all ${
                      searchMode === 'username'
                        ? 'bg-purple-600 text-white'
                        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    <AtSign className="h-3.5 w-3.5" />
                    {isEs ? 'Por @usuario' : 'By @username'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchMode('category')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition-all ${
                      searchMode === 'category'
                        ? 'bg-purple-600 text-white'
                        : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    <Hash className="h-3.5 w-3.5" />
                    {isEs ? 'Por categoria' : 'By category'}
                  </button>
                </div>
              </div>

              {/* Platform */}
              <Select
                label={t.campaigns.platform}
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                placeholder={t.campaigns.all}
                options={[
                  { value: 'instagram', label: 'Instagram' },
                  { value: 'tiktok', label: 'TikTok' },
                  { value: 'youtube', label: 'YouTube' },
                ]}
              />

              {/* Search Input */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {searchMode === 'username'
                    ? (isEs ? 'Usuario o URL' : 'Username or URL')
                    : t.discover.category
                  }
                </label>
                <div className="relative">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                    {searchMode === 'username' ? (
                      <AtSign className="h-4 w-4 text-gray-400" />
                    ) : (
                      <Hash className="h-4 w-4 text-gray-400" />
                    )}
                  </div>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder={
                      searchMode === 'username'
                        ? (isEs ? '@usuario o URL de perfil' : '@username or profile URL')
                        : (isEs ? 'moda, fitness, belleza...' : 'fashion, fitness, beauty...')
                    }
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 pl-9 pr-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 transition-colors"
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                  {searchMode === 'username'
                    ? (isEs ? 'Resultado inmediato (~10s)' : 'Instant result (~10s)')
                    : (isEs ? 'Busca creadores por hashtag (~1-2 min)' : 'Finds creators by hashtag (~1-2 min)')
                  }
                </p>
              </div>

              {/* Followers Range */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{t.campaigns.followers}</label>
                <div className="flex items-center gap-2">
                  <input type="number" placeholder={t.discover.minFollowers} value={followersMin} onChange={(e) => setFollowersMin(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500" />
                  <span className="text-gray-400 shrink-0">-</span>
                  <input type="number" placeholder={t.discover.maxFollowers} value={followersMax} onChange={(e) => setFollowersMax(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500" />
                </div>
              </div>

              {/* Location */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{isEs ? 'Pais / Ubicacion' : 'Country / Location'}</label>
                <input type="text" placeholder={isEs ? 'Espana, Madrid...' : 'Spain, Madrid...'} value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500" />
              </div>

              {/* Engagement */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">{isEs ? 'Engagement minimo' : 'Min. Engagement'}</label>
                <select value={engagementFilter} onChange={(e) => setEngagementFilter(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500">
                  <option value="">{isEs ? 'Sin filtro' : 'No filter'}</option>
                  <option value="1">&gt; 1%</option>
                  <option value="2">&gt; 2%</option>
                  <option value="3">&gt; 3%</option>
                  <option value="5">&gt; 5%</option>
                  <option value="8">&gt; 8%</option>
                  <option value="10">&gt; 10%</option>
                </select>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-600 pt-5">
                <button type="button" onClick={handleSearch} disabled={searching || !searchInput.trim()}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/25 hover:bg-purple-700 active:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                  {searching ? (
                    <><Loader2 className="h-5 w-5 animate-spin" />{isEs ? 'Buscando...' : 'Searching...'}</>
                  ) : (
                    <><Search className="h-5 w-5" />{t.common.search}</>
                  )}
                </button>
                <button type="button" onClick={resetFilters}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-6 py-3 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all">
                  <RotateCcw className="h-4 w-4" />{t.discover.reset}
                </button>
              </div>
            </div>

            {/* Right Content Area */}
            <div className="flex-1 min-w-0">
              {/* Loading */}
              {searching && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-24">
                  <Loader2 className="h-12 w-12 animate-spin text-purple-500 mb-4" />
                  <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                    {searchMode === 'username'
                      ? (isEs ? `Buscando @${searchInput.replace(/^@/, '')}...` : `Looking up @${searchInput.replace(/^@/, '')}...`)
                      : (isEs ? `Buscando creadores de "${searchInput}"...` : `Searching "${searchInput}" creators...`)
                    }
                  </p>
                  <p className="text-sm text-gray-400 mt-2 max-w-sm text-center">
                    {searchMode === 'username'
                      ? (isEs ? 'Esto tarda unos 10 segundos.' : 'This takes about 10 seconds.')
                      : (isEs ? 'Esto puede tardar 1-2 minutos.' : 'This may take 1-2 minutes.')}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              )}

              {/* Empty before search */}
              {!hasSearched && !searching && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-32">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-400">
                    <Compass className="h-7 w-7" />
                  </div>
                  <p className="mt-5 text-base font-medium text-gray-500 dark:text-gray-400">
                    {isEs ? 'Busqueda en vivo con Apify' : 'Live search with Apify'}
                  </p>
                  <p className="mt-2 text-sm text-gray-400 dark:text-gray-500 max-w-md text-center">
                    {isEs
                      ? 'Busca por @usuario para resultado inmediato, o por categoria para descubrir creadores.'
                      : 'Search by @username for instant results, or by category to discover creators.'}
                  </p>
                </div>
              )}

              {/* No results */}
              {hasSearched && !searching && results.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-20 px-8">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-500 mb-4">
                    <Search className="h-7 w-7" />
                  </div>
                  <p className="text-base font-semibold text-gray-700 dark:text-gray-200">{t.common.noResults}</p>
                </div>
              )}

              {/* Results Cards */}
              {hasSearched && !searching && filteredResults.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {paginatedResults.length} / {filteredResults.length} {t.listDetail.results}
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="inline-flex items-center rounded-full bg-purple-50 dark:bg-purple-900/30 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                        {source === 'apify' ? t.discover.externalSearch : t.discover.internalDatabase}
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">{isEs ? 'Ordenar:' : 'Sort:'}</span>
                        {(['followers', 'engagementRate', 'avgLikes'] as const).map(field => (
                          <button key={field} onClick={() => toggleSort(field)}
                            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                              sortField === field
                                ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                                : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                            }`}>
                            {field === 'followers' ? (isEs ? 'Seg.' : 'Fol.') : field === 'engagementRate' ? 'ER%' : 'Likes'}
                            {sortField === field && <span className="ml-0.5">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {paginatedResults.map((item) => (
                      <div key={`${item.platform}-${item.username}`}
                        className="group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm hover:shadow-md hover:border-purple-300 dark:hover:border-purple-700 transition-all p-5">
                        <div className="flex items-start gap-3 mb-4">
                          <Avatar name={item.displayName || item.username} size="lg" src={item.avatarUrl ? proxyImg(item.avatarUrl) : undefined} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">@{item.username}</span>
                              <PlatformIcon platform={item.platform} />
                            </div>
                            {item.displayName && item.displayName !== item.username && (
                              <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{item.displayName}</p>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mb-4">
                          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{t.campaigns.followers}</p>
                            <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{item.followers > 0 ? formatNumber(item.followers) : '--'}</p>
                          </div>
                          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{t.discover.engRate}</p>
                            <div className="mt-1"><ErBadge rate={item.engagementRate} /></div>
                          </div>
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <Heart className="h-3.5 w-3.5 text-pink-400" />
                            <div>
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{item.avgLikes > 0 ? formatNumber(item.avgLikes) : '--'}</p>
                              <p className="text-[10px] text-gray-400">{isEs ? 'Likes med.' : 'Avg likes'}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 px-3 py-1.5">
                            <Eye className="h-3.5 w-3.5 text-blue-400" />
                            <div>
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{item.avgViews > 0 ? formatNumber(item.avgViews) : '--'}</p>
                              <p className="text-[10px] text-gray-400">{isEs ? 'Vistas med.' : 'Avg views'}</p>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                          <button type="button" onClick={() => setAddToListModal({ username: item.username, platform: item.platform })}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700 transition-colors">
                            <ListPlus className="h-3.5 w-3.5" />{t.discover.addTo}
                          </button>
                          <a href={getProfileUrl(item.username, item.platform)} target="_blank" rel="noopener noreferrer"
                            className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                            <ExternalLink className="h-3.5 w-3.5" />{isEs ? 'Ver perfil' : 'View'}
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>

                  {hasMore && (
                    <div className="flex justify-center pt-4">
                      <button type="button" onClick={() => setVisibleCount(prev => prev + 50)}
                        className="flex items-center gap-2 rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-800 px-8 py-3 text-sm font-semibold text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all">
                        {isEs ? `Cargar mas (${filteredResults.length - visibleCount} restantes)` : `Load more (${filteredResults.length - visibleCount} remaining)`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Add to List Modal (shared) */}
      {addToListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t.discover.addTo} @{addToListModal.username}
              </h3>
              <button onClick={() => { setAddToListModal(null); setAddToListResult(null) }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X className="h-5 w-5" />
              </button>
            </div>
            {addToListResult && (
              <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                addToListResult.type === 'success' ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              }`}>
                {addToListResult.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
                {addToListResult.message}
              </div>
            )}
            {lists.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">{t.lists.noLists}</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {lists.map(list => (
                  <button key={list.id} onClick={() => handleAddToList(list.id)} disabled={addingToList}
                    className="w-full flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 transition-colors hover:border-purple-300 dark:hover:border-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/30 hover:text-purple-700 dark:hover:text-purple-300 disabled:opacity-50">
                    <ListPlus className="h-4 w-4 shrink-0" />{list.name}
                    {addingToList && <Loader2 className="ml-auto h-4 w-4 animate-spin" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
