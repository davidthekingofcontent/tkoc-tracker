'use client'

import { useState, useEffect } from 'react'
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Avatar } from '@/components/ui/avatar'
import { useI18n } from '@/i18n/context'
import { formatNumber } from '@/lib/utils'

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
}

interface ListItem {
  id: string
  name: string
}

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
  const [results, setResults] = useState<DiscoverResult[]>([])
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [total, setTotal] = useState(0)
  const [source, setSource] = useState<'apify' | 'database'>('database')
  const [lists, setLists] = useState<ListItem[]>([])
  const [addToListModal, setAddToListModal] = useState<{ username: string; platform: string } | null>(null)
  const [addingToList, setAddingToList] = useState(false)
  const [addToListResult, setAddToListResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  useEffect(() => {
    fetch('/api/lists').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.lists) setLists(data.lists)
    }).catch(() => {})
  }, [])

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

  const handleAddToList = async (listId: string) => {
    if (!addToListModal) return
    setAddingToList(true)
    setAddToListResult(null)
    try {
      // First analyze/upsert the influencer to get an ID
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
      // Add to list
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
    if (!filters.search.trim()) return

    setSearching(true)
    setHasSearched(true)

    try {
      const res = await fetch('/api/influencers/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: filters.search,
          platform: filters.platform || 'instagram',
          minFollowers: filters.followersMin ? parseInt(filters.followersMin, 10) : undefined,
          maxFollowers: filters.followersMax ? parseInt(filters.followersMax, 10) : undefined,
          bioKeyword: filters.bioKeyword || undefined,
          location: filters.location || undefined,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        let filtered: DiscoverResult[] = data.results || []

        // Client-side filtering for engagement minimum
        if (filters.engagement) {
          const minEng = parseFloat(filters.engagement)
          filtered = filtered.filter((i) => (i.engagementRate || 0) >= minEng)
        }

        setResults(filtered)
        setTotal(filtered.length)
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
              {t.discover.reset}
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
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
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
            placeholder={t.discover.locationPlaceholder}
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
            label={t.discover.bioKeyword}
            placeholder={t.discover.bioKeywordPlaceholder}
            value={filters.bioKeyword}
            onChange={(e) => updateFilter('bioKeyword', e.target.value)}
          />

          {/* Action Buttons */}
          <div className="flex flex-col gap-2 border-t border-gray-200 pt-5">
            <Button type="button" variant="primary" size="lg" onClick={handleSearch} disabled={searching || !filters.search.trim()} className="w-full">
              {searching ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t.common.loading}
                </>
              ) : (
                <>
                  <Search className="h-4 w-4" />
                  {t.common.search}
                </>
              )}
            </Button>
            <Button type="button" variant="secondary" size="md" onClick={resetFilters} className="w-full">
              <RotateCcw className="h-4 w-4" />
              {t.discover.reset}
            </Button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 min-w-0">
          {/* Loading spinner */}
          {searching && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <Loader2 className="h-10 w-10 animate-spin text-purple-500 mb-4" />
              <p className="text-sm font-medium text-gray-700">{t.common.loading}...</p>
              <p className="text-xs text-gray-400 mt-1">{t.discover.subtitle}</p>
            </div>
          )}

          {/* Empty state before search */}
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

          {/* No results state */}
          {hasSearched && !searching && results.length === 0 && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-32">
              <p className="text-sm text-gray-500">{t.common.noResults}</p>
            </div>
          )}

          {/* Results table */}
          {hasSearched && !searching && results.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500">
                  {total} {t.listDetail.results}
                </p>
                <span className="inline-flex items-center rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700">
                  {source === 'apify' ? t.discover.externalSearch : t.discover.internalDatabase}
                </span>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.analyze.username}</TableHead>
                      <TableHead>{t.campaigns.followers}</TableHead>
                      <TableHead>{t.discover.engRate}</TableHead>
                      <TableHead>{t.discover.mdnLikes}</TableHead>
                      <TableHead>{t.discover.mdnComments}</TableHead>
                      <TableHead>{t.discover.mdnViews}</TableHead>
                      <TableHead>{t.common.email}</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((item) => (
                      <TableRow key={`${item.platform}-${item.username}`} className="group">
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar
                              name={item.displayName || item.username}
                              size="sm"
                              src={item.avatarUrl || undefined}
                            />
                            <div>
                              <div className="flex items-center gap-1.5">
                                <a
                                  href={getProfileUrl(item.username, item.platform)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-gray-900 hover:text-purple-600 transition-colors inline-flex items-center gap-1"
                                >
                                  @{item.username}
                                  <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </a>
                                <PlatformIcon platform={item.platform} />
                              </div>
                              {item.displayName && item.displayName !== item.username && (
                                <span className="text-xs text-gray-400">{item.displayName}</span>
                              )}
                            </div>
                          </div>
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
                            {item.email || t.discover.notProvided}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end">
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => setAddToListModal({ username: item.username, platform: item.platform })}
                            >
                              <ListPlus className="h-3.5 w-3.5" />
                              {t.discover.addTo}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add to List Modal */}
      {addToListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">
                {t.discover.addTo} @{addToListModal.username}
              </h3>
              <button onClick={() => { setAddToListModal(null); setAddToListResult(null) }} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {addToListResult && (
              <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                addToListResult.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
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
                    className="w-full flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-3 text-left text-sm font-medium text-gray-700 transition-colors hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-50"
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
