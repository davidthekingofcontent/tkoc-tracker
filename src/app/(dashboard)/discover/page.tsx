'use client'

import { useState, useEffect, useMemo } from 'react'
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
} from 'lucide-react'
import { Select } from '@/components/ui/select'
import { Avatar } from '@/components/ui/avatar'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'

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

interface ListItem {
  id: string
  name: string
}

type SearchMode = 'username' | 'category'

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

export default function DiscoverPage() {
  const { t, locale } = useI18n()

  // Search state
  const [searchMode, setSearchMode] = useState<SearchMode>('category')
  const [platform, setPlatform] = useState('instagram')
  const [searchInput, setSearchInput] = useState('')
  const [followersMin, setFollowersMin] = useState('')
  const [followersMax, setFollowersMax] = useState('')
  const [locationFilter, setLocationFilter] = useState('')
  const [engagementFilter, setEngagementFilter] = useState('')
  const [bioKeywordFilter, setBioKeywordFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(50)

  // Results state
  const [results, setResults] = useState<DiscoverResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [total, setTotal] = useState(0)
  const [source, setSource] = useState<'apify' | 'database'>('database')

  // Sort state
  const [sortField, setSortField] = useState<string>('followers')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Add to list state
  const [lists, setLists] = useState<ListItem[]>([])
  const [addToListModal, setAddToListModal] = useState<{ username: string; platform: string } | null>(null)
  const [addingToList, setAddingToList] = useState(false)
  const [addToListResult, setAddToListResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    fetch('/api/lists').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.lists) setLists(data.lists)
    }).catch(() => {})
  }, [])

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

  // Apply ALL client-side filters
  const filteredResults = useMemo(() => {
    let filtered = sortedResults
    const minF = followersMin ? parseInt(followersMin, 10) : 0
    const maxF = followersMax ? parseInt(followersMax, 10) : 0
    if (minF > 0) filtered = filtered.filter(r => r.followers >= minF || r.followers === 0)
    if (maxF > 0) filtered = filtered.filter(r => r.followers <= maxF || r.followers === 0)
    // Engagement filter (only on enriched profiles that have ER data)
    if (engagementFilter) {
      const minEng = parseFloat(engagementFilter)
      filtered = filtered.filter(r => r.engagementRate >= minEng || r.engagementRate === 0)
    }
    // Location filter (checks country, city, displayName, and bio)
    if (locationFilter.trim()) {
      const loc = locationFilter.trim().toLowerCase()
      // Build a list of location synonyms to check (e.g. "España" also matches "Spain", "Madrid", etc.)
      const locationAliases: Record<string, string[]> = {
        'spain': ['españa', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'malaga', 'málaga', 'bilbao', 'es'],
        'españa': ['españa', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'seville', 'malaga', 'málaga', 'bilbao', 'es'],
        'mexico': ['mexico', 'méxico', 'cdmx', 'mx', 'guadalajara', 'monterrey'],
        'méxico': ['mexico', 'méxico', 'cdmx', 'mx', 'guadalajara', 'monterrey'],
        'argentina': ['argentina', 'buenos aires', 'ar'],
        'colombia': ['colombia', 'bogota', 'bogotá', 'medellín', 'medellin', 'co'],
        'uk': ['uk', 'united kingdom', 'london', 'england', 'gb'],
        'united kingdom': ['uk', 'united kingdom', 'london', 'england', 'gb'],
        'usa': ['usa', 'united states', 'us', 'new york', 'los angeles', 'la', 'miami'],
        'united states': ['usa', 'united states', 'us', 'new york', 'los angeles', 'la', 'miami'],
        'france': ['france', 'francia', 'paris', 'fr'],
        'francia': ['france', 'francia', 'paris', 'fr'],
        'italy': ['italy', 'italia', 'milan', 'rome', 'roma', 'it'],
        'italia': ['italy', 'italia', 'milan', 'rome', 'roma', 'it'],
        'germany': ['germany', 'alemania', 'berlin', 'münchen', 'munich', 'de'],
        'alemania': ['germany', 'alemania', 'berlin', 'münchen', 'munich', 'de'],
        'brazil': ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio', 'br'],
        'brasil': ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio', 'br'],
        'portugal': ['portugal', 'lisboa', 'lisbon', 'porto', 'pt'],
        'chile': ['chile', 'santiago', 'cl'],
      }
      const searchTerms = locationAliases[loc] || [loc]
      filtered = filtered.filter(r => {
        const country = (r.country || '').toLowerCase()
        const city = (r.city || '').toLowerCase()
        const name = (r.displayName || '').toLowerCase()
        const bio = (r.bio || '').toLowerCase()
        // If the result has no location data at all, keep it (don't exclude unknowns)
        const hasLocationData = country || city || bio
        if (!hasLocationData) return true
        // Check if any search term matches country, city, displayName, or bio
        return searchTerms.some(term =>
          country.includes(term) || city.includes(term) || name.includes(term) || bio.includes(term)
        )
      })
    }
    return filtered
  }, [sortedResults, followersMin, followersMax, engagementFilter, locationFilter])

  // Paginated results (50 per page)
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

  const isEs = locale === 'es'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.discover.title}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-300">{t.discover.subtitle}</p>
      </div>

      {/* Main Layout */}
      <div className="flex gap-6">
        {/* Left Sidebar Filters */}
        <div className="w-80 shrink-0 space-y-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-300">
              {t.discover.filters}
            </h2>
            <button
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            >
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
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t.campaigns.followers}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                placeholder={t.discover.minFollowers}
                value={followersMin}
                onChange={(e) => setFollowersMin(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <span className="text-gray-400 shrink-0">-</span>
              <input
                type="number"
                placeholder={t.discover.maxFollowers}
                value={followersMax}
                onChange={(e) => setFollowersMax(e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
          </div>

          {/* Country */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {isEs ? 'País / Ubicación' : 'Country / Location'}
            </label>
            <input
              type="text"
              placeholder={isEs ? 'España, Madrid...' : 'Spain, Madrid...'}
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">{isEs ? 'Filtra por bio/ubicación después de buscar' : 'Filters bio/location after search'}</p>
          </div>

          {/* Engagement % */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {isEs ? 'Engagement mínimo' : 'Min. Engagement'}
            </label>
            <select
              value={engagementFilter}
              onChange={(e) => setEngagementFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              <option value="">{isEs ? 'Sin filtro' : 'No filter'}</option>
              <option value="1">&gt; 1%</option>
              <option value="2">&gt; 2%</option>
              <option value="3">&gt; 3%</option>
              <option value="5">&gt; 5%</option>
              <option value="8">&gt; 8%</option>
              <option value="10">&gt; 10%</option>
            </select>
            <p className="mt-1 text-[10px] text-gray-400">{isEs ? 'Solo perfiles con ER enriquecido' : 'Only enriched profiles with ER data'}</p>
          </div>

          {/* Bio keyword */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {isEs ? 'Palabra clave en bio' : 'Bio keyword'}
            </label>
            <input
              type="text"
              placeholder={isEs ? 'fitness, moda, cocina...' : 'fitness, fashion, cooking...'}
              value={bioKeywordFilter}
              onChange={(e) => setBioKeywordFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 border-t border-gray-200 dark:border-gray-600 pt-5">
            <button
              type="button"
              onClick={handleSearch}
              disabled={searching || !searchInput.trim()}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-purple-500/25 hover:bg-purple-700 active:bg-purple-800 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-all"
            >
              {searching ? (
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
            <button
              type="button"
              onClick={resetFilters}
              className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-6 py-3 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
            >
              <RotateCcw className="h-4 w-4" />
              {t.discover.reset}
            </button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 min-w-0">
          {/* Loading state */}
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
                  : (isEs
                      ? 'Esto puede tardar 1-2 minutos. Buscando hashtags, encontrando creadores y enriqueciendo perfiles.'
                      : 'This may take 1-2 minutes. Searching hashtags, finding creators, and enriching profiles.')
                }
              </p>
              <div className="mt-4 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="h-2 w-2 rounded-full bg-purple-500 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          {/* Empty state before search */}
          {!hasSearched && !searching && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-32">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-400">
                <Compass className="h-7 w-7" />
              </div>
              <p className="mt-5 text-base font-medium text-gray-500 dark:text-gray-400">
                {t.discover.subtitle}
              </p>
              <div className="mt-4 max-w-md text-center space-y-2">
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  {isEs
                    ? 'Busca por @usuario para resultado inmediato, o por categoria para descubrir creadores.'
                    : 'Search by @username for instant results, or by category to discover creators.'}
                </p>
              </div>
            </div>
          )}

          {/* No results state */}
          {hasSearched && !searching && results.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm py-20 px-8">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-500 mb-4">
                <Search className="h-7 w-7" />
              </div>
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">{t.common.noResults}</p>
              <div className="mt-4 max-w-md text-center space-y-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {isEs
                    ? 'No se encontraron resultados. Prueba con:'
                    : 'No results found. Try:'}
                </p>
                <ul className="text-sm text-gray-500 dark:text-gray-400 text-left list-disc pl-5 space-y-1">
                  {searchMode === 'category' ? (
                    <>
                      <li>{isEs ? 'Usar una palabra clave diferente (ej: "fitness", "cocina", "viajes")' : 'Use a different keyword (e.g. "fitness", "cooking", "travel")'}</li>
                      <li>{isEs ? 'Probar en ingles (ej: "fashion" en vez de "moda")' : 'Try in English (e.g. "fashion" instead of local terms)'}</li>
                      <li>{isEs ? 'Cambiar a modo @usuario si conoces el handle' : 'Switch to @username mode if you know the handle'}</li>
                    </>
                  ) : (
                    <>
                      <li>{isEs ? 'Verificar que el @username es correcto' : 'Verify the @username is correct'}</li>
                      <li>{isEs ? 'Probar sin el @ (solo el nombre de usuario)' : 'Try without @ (just the username)'}</li>
                      <li>{isEs ? 'Pegar la URL completa del perfil' : 'Paste the full profile URL'}</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* Results Cards */}
          {hasSearched && !searching && filteredResults.length > 0 && (
            <div className="space-y-4">
              {/* Results header */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {paginatedResults.length} / {filteredResults.length} {t.listDetail.results}
                </p>
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-purple-50 dark:bg-purple-900/30 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                    {source === 'apify' ? t.discover.externalSearch : t.discover.internalDatabase}
                  </span>
                  {/* Sort controls */}
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-400">{isEs ? 'Ordenar:' : 'Sort:'}</span>
                    {(['followers', 'engagementRate', 'avgLikes'] as const).map(field => (
                      <button
                        key={field}
                        onClick={() => toggleSort(field)}
                        className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                          sortField === field
                            ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300'
                            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                        }`}
                      >
                        {field === 'followers'
                          ? (isEs ? 'Seg.' : 'Fol.')
                          : field === 'engagementRate'
                            ? 'ER%'
                            : (isEs ? 'Likes' : 'Likes')
                        }
                        {sortField === field && (
                          <span className="ml-0.5">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Card Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {paginatedResults.map((item) => (
                  <div
                    key={`${item.platform}-${item.username}`}
                    className="group rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm hover:shadow-md hover:border-purple-300 dark:hover:border-purple-700 transition-all p-5"
                  >
                    {/* Card Header: Avatar + Name */}
                    <div className="flex items-start gap-3 mb-4">
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
                        {item.enriched === false && (
                          <span className="inline-flex items-center mt-1 rounded-full bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            {isEs ? 'Datos parciales' : 'Partial data'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stats Grid */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      {/* Followers */}
                      <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                        <p className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                          {t.campaigns.followers}
                        </p>
                        <p className="text-lg font-bold text-gray-900 dark:text-gray-100">
                          {item.followers > 0 ? formatNumber(item.followers) : '--'}
                        </p>
                      </div>
                      {/* ER */}
                      <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
                        <p className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                          {t.discover.engRate}
                        </p>
                        <div className="mt-1">
                          <ErBadge rate={item.engagementRate} />
                        </div>
                      </div>
                      {/* Avg Likes */}
                      <div className="flex items-center gap-2 px-3 py-1.5">
                        <Heart className="h-3.5 w-3.5 text-pink-400" />
                        <div>
                          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                            {item.avgLikes > 0 ? formatNumber(item.avgLikes) : '--'}
                          </p>
                          <p className="text-[10px] text-gray-400">{isEs ? 'Likes med.' : 'Avg likes'}</p>
                        </div>
                      </div>
                      {/* Avg Views */}
                      <div className="flex items-center gap-2 px-3 py-1.5">
                        <Eye className="h-3.5 w-3.5 text-blue-400" />
                        <div>
                          <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                            {item.avgViews > 0 ? formatNumber(item.avgViews) : '--'}
                          </p>
                          <p className="text-[10px] text-gray-400">{isEs ? 'Vistas med.' : 'Avg views'}</p>
                        </div>
                      </div>
                    </div>

                    {/* Card Actions */}
                    <div className="flex items-center gap-2 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <button
                        type="button"
                        onClick={() => setAddToListModal({ username: item.username, platform: item.platform })}
                        className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700 transition-colors"
                      >
                        <ListPlus className="h-3.5 w-3.5" />
                        {t.discover.addTo}
                      </button>
                      <a
                        href={getProfileUrl(item.username, item.platform)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {isEs ? 'Ver perfil' : 'View'}
                      </a>
                    </div>
                  </div>
                ))}
              </div>

              {/* Load More Button */}
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <button
                    type="button"
                    onClick={() => setVisibleCount(prev => prev + 50)}
                    className="flex items-center gap-2 rounded-xl border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-gray-800 px-8 py-3 text-sm font-semibold text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all"
                  >
                    {isEs ? `Cargar más (${filteredResults.length - visibleCount} restantes)` : `Load more (${filteredResults.length - visibleCount} remaining)`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Add to List Modal */}
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
                  <button
                    key={list.id}
                    onClick={() => handleAddToList(list.id)}
                    disabled={addingToList}
                    className="w-full flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 transition-colors hover:border-purple-300 dark:hover:border-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/30 hover:text-purple-700 dark:hover:text-purple-300 disabled:opacity-50"
                  >
                    <ListPlus className="h-4 w-4 shrink-0" />
                    {list.name}
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
