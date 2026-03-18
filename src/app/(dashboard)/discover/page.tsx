'use client'

import { useState } from 'react'
import { Search, RotateCcw, Compass, Instagram, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/i18n/context'

interface DiscoveredInfluencer {
  id: string
  username: string
  displayName: string | null
  platform: string
  followers: number
  engagementRate: number
  bio: string | null
  country: string | null
  city: string | null
  email: string | null
  avatarUrl: string | null
  _count: { campaigns: number; media: number }
}

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num.toString()
}

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform.toUpperCase()) {
    case 'INSTAGRAM': return <Instagram className="h-4 w-4" />
    case 'TIKTOK': return <span className="text-xs font-bold">TT</span>
    case 'YOUTUBE': return <span className="text-xs font-bold">YT</span>
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

export default function DiscoverPage() {
  const { t } = useI18n()
  const [filters, setFilters] = useState({
    platform: '',
    search: '',
    followersMin: '',
    followersMax: '',
    location: '',
    engagement: '',
    gender: '',
    language: '',
    bioKeyword: '',
  })
  const [results, setResults] = useState<DiscoveredInfluencer[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [total, setTotal] = useState(0)

  const updateFilter = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }

  const resetFilters = () => {
    setFilters({
      platform: '',
      search: '',
      followersMin: '',
      followersMax: '',
      location: '',
      engagement: '',
      gender: '',
      language: '',
      bioKeyword: '',
    })
    setHasSearched(false)
    setResults([])
  }

  const handleSearch = async () => {
    setSearching(true)
    setHasSearched(true)

    try {
      const params = new URLSearchParams()
      if (filters.search) params.set('search', filters.search)
      if (filters.platform) params.set('platform', filters.platform.toUpperCase())
      params.set('limit', '50')

      const res = await fetch(`/api/influencers?${params.toString()}`)
      if (res.ok) {
        const data = await res.json()
        let filtered = data.influencers || []

        // Client-side filtering for fields the API doesn't support yet
        if (filters.engagement) {
          const minEng = parseFloat(filters.engagement)
          filtered = filtered.filter((i: DiscoveredInfluencer) => (i.engagementRate || 0) >= minEng)
        }
        if (filters.location) {
          const loc = filters.location.toLowerCase()
          filtered = filtered.filter((i: DiscoveredInfluencer) =>
            (i.country || '').toLowerCase().includes(loc) ||
            (i.city || '').toLowerCase().includes(loc)
          )
        }
        if (filters.bioKeyword) {
          const kw = filters.bioKeyword.toLowerCase()
          filtered = filtered.filter((i: DiscoveredInfluencer) =>
            (i.bio || '').toLowerCase().includes(kw)
          )
        }

        setResults(filtered)
        setTotal(filtered.length)
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.discover.title}</h1>
        <p className="mt-1 text-sm text-gray-500">{t.discover.subtitle}</p>
      </div>

      {/* Main Layout */}
      <div className="flex gap-6">
        {/* Left Sidebar Filters */}
        <div className="w-80 shrink-0 space-y-5 rounded-xl border border-gray-200 bg-white shadow-sm p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
              {t.discover.filters}
            </h2>
            <button
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-900 transition-colors"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>

          <Select
            label={t.campaigns.platform}
            value={filters.platform}
            onChange={(e) => updateFilter('platform', e.target.value)}
            placeholder={t.campaigns.all}
            options={[
              { value: 'instagram', label: 'Instagram' },
              { value: 'tiktok', label: 'TikTok' },
              { value: 'youtube', label: 'YouTube' },
            ]}
          />

          <Input
            label={t.discover.category}
            placeholder={t.discover.searchPlaceholder}
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              {t.campaigns.followers}
            </label>
            <div className="flex items-center gap-2">
              <Input
                placeholder={t.discover.minFollowers}
                type="number"
                value={filters.followersMin}
                onChange={(e) => updateFilter('followersMin', e.target.value)}
              />
              <span className="text-gray-400">-</span>
              <Input
                placeholder={t.discover.maxFollowers}
                type="number"
                value={filters.followersMax}
                onChange={(e) => updateFilter('followersMax', e.target.value)}
              />
            </div>
          </div>

          <Input
            label={t.discover.location}
            placeholder="Madrid, España..."
            value={filters.location}
            onChange={(e) => updateFilter('location', e.target.value)}
          />

          <Select
            label={`${t.campaigns.engagement} %`}
            value={filters.engagement}
            onChange={(e) => updateFilter('engagement', e.target.value)}
            placeholder={t.campaigns.all}
            options={[
              { value: '1', label: '> 1%' },
              { value: '3', label: '> 3%' },
              { value: '5', label: '> 5%' },
              { value: '8', label: '> 8%' },
              { value: '10', label: '> 10%' },
            ]}
          />

          <Input
            label="Keyword in Bio"
            placeholder="vegan, photographer..."
            value={filters.bioKeyword}
            onChange={(e) => updateFilter('bioKeyword', e.target.value)}
          />

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 border-t border-gray-200 pt-5">
            <Button onClick={handleSearch} disabled={searching} className="w-full">
              <Search className="h-4 w-4" />
              {searching ? t.common.loading : t.common.search}
            </Button>
            <Button variant="ghost" onClick={resetFilters} className="w-full">
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1">
          {searching && (
            <div className="flex items-center justify-center py-32">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-purple-200 border-t-purple-600" />
            </div>
          )}

          {!hasSearched && !searching && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                <Compass className="h-7 w-7" />
              </div>
              <p className="mt-5 text-base font-medium text-gray-500">
                {t.discover.subtitle}
              </p>
            </div>
          )}

          {hasSearched && !searching && results.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <p className="text-sm text-gray-500">{t.common.noResults}</p>
            </div>
          )}

          {hasSearched && !searching && results.length > 0 && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                {total} {t.common.noResults !== t.common.noResults ? '' : 'resultados'}
              </p>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {results.map((inf) => (
                  <div
                    key={inf.id}
                    className="rounded-xl border border-gray-200 bg-white p-5 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-100 text-purple-700 font-semibold text-sm">
                          {(inf.displayName || inf.username)[0]?.toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">@{inf.username}</p>
                          <p className="text-xs text-gray-500">{inf.displayName}</p>
                        </div>
                      </div>
                      <a
                        href={getProfileUrl(inf.username, inf.platform)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-purple-600 transition-colors"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>

                    {inf.bio && (
                      <p className="mt-3 text-xs text-gray-500 line-clamp-2">{inf.bio}</p>
                    )}

                    <div className="mt-3 flex items-center gap-3 text-sm">
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                        <PlatformIcon platform={inf.platform} />
                        {inf.platform.charAt(0) + inf.platform.slice(1).toLowerCase()}
                      </span>
                      <span className="text-gray-600">{formatNumber(inf.followers)}</span>
                      <span className="text-purple-600 font-medium">{inf.engagementRate || 0}%</span>
                    </div>

                    {(inf.country || inf.city) && (
                      <p className="mt-2 text-xs text-gray-400">
                        📍 {[inf.city, inf.country].filter(Boolean).join(', ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
