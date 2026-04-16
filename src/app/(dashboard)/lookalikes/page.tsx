'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  UserCheck,
  Search,
  Instagram,
  ExternalLink,
  ListPlus,
  X,
  CheckCircle2,
  Loader2,
  MapPin,
  Users,
  TrendingUp,
} from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { Avatar } from '@/components/ui/avatar'
import { proxyImg } from '@/lib/proxy-image'
import { formatNumber } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceCreator {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
}

interface LookalikeResult {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  matchScore: number
  matchReasons: string[]
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
  source: 'creator_profile' | 'influencer' | 'apify'
  profileUrl: string
}

interface ListItem {
  id: string
  name: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProfileUrl(username: string, platform: string): string {
  switch (platform.toUpperCase()) {
    case 'TIKTOK':
      return `https://tiktok.com/@${username}`
    case 'YOUTUBE':
      return `https://youtube.com/@${username}`
    default:
      return `https://instagram.com/${username}`
  }
}

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform.toUpperCase()) {
    case 'INSTAGRAM':
      return <Instagram className="h-4 w-4" />
    case 'TIKTOK':
      return <span className="text-xs font-bold">TT</span>
    case 'YOUTUBE':
      return <span className="text-xs font-bold">YT</span>
    default:
      return null
  }
}

function ScoreBadge({ score }: { score: number }) {
  let colorClass = 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
  if (score >= 85) {
    colorClass = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
  } else if (score >= 60) {
    colorClass = 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
  }

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${colorClass}`}>
      {score}%
    </span>
  )
}

function SpainFitBadge({ level }: { level: string | null }) {
  if (!level || level === 'unknown') return null

  const config: Record<string, { emoji: string; labelEs: string; className: string }> = {
    confirmed: {
      emoji: '\uD83C\uDDEA\uD83C\uDDF8',
      labelEs: 'Confirmado',
      className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    },
    probable: {
      emoji: '\uD83D\uDFE1',
      labelEs: 'Probable',
      className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
    },
    partial: {
      emoji: '\uD83D\uDFE0',
      labelEs: 'Parcial',
      className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    },
    hispanic_global: {
      emoji: '\uD83C\uDF0E',
      labelEs: 'Hispano global',
      className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    },
    latam: {
      emoji: '\uD83C\uDF0E',
      labelEs: 'LATAM',
      className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    },
  }

  const c = config[level]
  if (!c) return null

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.className}`}>
      {c.emoji} {c.labelEs}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function LookalikesPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-purple-500" /></div>}>
      <LookalikesContent />
    </Suspense>
  )
}

function LookalikesContent() {
  const { t } = useI18n()
  const searchParams = useSearchParams()

  const [handle, setHandle] = useState('')
  const [platform, setPlatform] = useState('INSTAGRAM')
  const [source, setSource] = useState<SourceCreator | null>(null)
  const [results, setResults] = useState<LookalikeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Add-to-list modal state
  const [lists, setLists] = useState<ListItem[]>([])
  const [addToListModal, setAddToListModal] = useState<{ username: string; platform: string } | null>(null)
  const [addingToList, setAddingToList] = useState(false)
  const [addToListResult, setAddToListResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Load lists on mount
  useEffect(() => {
    fetch('/api/lists')
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        if (Array.isArray(data)) setLists(data)
        else if (data?.lists) setLists(data.lists)
      })
      .catch(() => {})
  }, [])

  const doSearch = useCallback(async (searchHandle: string, searchPlatform: string) => {
    if (!searchHandle.trim()) return
    setSearching(true)
    setSearched(false)
    setErrorMsg(null)
    setSource(null)
    setResults([])

    try {
      const res = await fetch('/api/creators/lookalikes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          handle: searchHandle.replace(/^@/, '').trim(),
          platform: searchPlatform.toUpperCase(),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setSource(data.source || null)
        setResults(data.lookalikes || [])
      } else {
        setErrorMsg(t.lookalikes.errorSearch)
        setResults([])
      }
    } catch {
      setErrorMsg(t.lookalikes.errorSearch)
      setResults([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }, [t])

  // Auto-search from URL params on mount
  useEffect(() => {
    const urlHandle = searchParams.get('handle')
    const urlPlatform = searchParams.get('platform') || 'INSTAGRAM'
    if (urlHandle) {
      setHandle(urlHandle)
      setPlatform(urlPlatform.toUpperCase())
      doSearch(urlHandle, urlPlatform)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => doSearch(handle, platform)

  const handleAddToList = async (listId: string) => {
    if (!addToListModal) return
    setAddingToList(true)
    setAddToListResult(null)
    try {
      const analyzeRes = await fetch('/api/influencers/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: addToListModal.username,
          platform: addToListModal.platform.toUpperCase(),
        }),
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
        setTimeout(() => {
          setAddToListModal(null)
          setAddToListResult(null)
        }, 1500)
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t.lookalikes.title}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t.lookalikes.subtitle}
        </p>
      </div>

      {/* Search Section */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
        <div className="flex gap-3">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:focus:ring-purple-800"
          >
            <option value="INSTAGRAM">Instagram</option>
            <option value="TIKTOK">TikTok</option>
            <option value="YOUTUBE">YouTube</option>
          </select>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={t.lookalikes.inputPlaceholder}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 py-2 pl-10 pr-4 text-sm text-gray-900 dark:text-gray-100 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200 dark:focus:ring-purple-800"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={searching || !handle.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            <UserCheck className="h-4 w-4" />
            {searching ? t.lookalikes.finding : t.lookalikes.find}
          </button>
        </div>
      </div>

      {/* Error state */}
      {errorMsg && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
          {errorMsg}
        </div>
      )}

      {/* Empty state — before searching */}
      {!searched && !searching && !errorMsg && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 py-16">
          <UserCheck className="h-12 w-12 text-gray-300 dark:text-gray-600 mb-4" />
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-md">
            {t.lookalikes.enterCreator}
          </p>
        </div>
      )}

      {/* Loading state */}
      {searching && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-purple-200 border-t-purple-600" />
        </div>
      )}

      {/* No results */}
      {searched && !searching && !source && !errorMsg && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-16">
          <p className="text-sm text-gray-500 dark:text-gray-400">{t.lookalikes.noResults}</p>
        </div>
      )}

      {/* Source card + Results */}
      {source && !searching && (
        <>
          {/* Source Creator Card */}
          <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-400 mb-3">
              {t.lookalikes.sourceCreator}
            </p>
            <div className="flex items-center gap-4">
              <Avatar
                src={proxyImg(source.avatarUrl)}
                name={source.displayName || source.username}
                size="lg"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                    @{source.username}
                  </p>
                  <PlatformIcon platform={source.platform} />
                </div>
                {source.displayName && source.displayName !== source.username && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
                    {source.displayName}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  <span className="flex items-center gap-1 text-gray-600 dark:text-gray-300">
                    <Users className="h-3.5 w-3.5" />
                    {formatNumber(source.followers)}
                  </span>
                  {source.engagementRate > 0 && (
                    <span className="flex items-center gap-1 text-purple-600 dark:text-purple-400 font-medium">
                      <TrendingUp className="h-3.5 w-3.5" />
                      {source.engagementRate.toFixed(2)}%
                    </span>
                  )}
                  {source.geoCity && (
                    <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
                      <MapPin className="h-3.5 w-3.5" />
                      {source.geoCity}
                    </span>
                  )}
                  <SpainFitBadge level={source.spainFitLevel} />
                </div>
                {source.categories.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {source.categories.slice(0, 5).map((cat) => (
                      <span
                        key={cat}
                        className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300"
                      >
                        {cat}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Results header */}
          {results.length > 0 && (
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t.lookalikes.results} ({results.length})
              </h2>
            </div>
          )}

          {/* Results grid */}
          {results.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {results.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 hover:shadow-md hover:border-purple-300 dark:hover:border-purple-600 transition-all"
                >
                  {/* Top: avatar + name + score */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar
                        src={proxyImg(item.avatarUrl)}
                        name={item.displayName || item.username}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-gray-900 dark:text-gray-100 truncate">
                            @{item.username}
                          </p>
                          <PlatformIcon platform={item.platform} />
                        </div>
                        {item.displayName && item.displayName !== item.username && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                            {item.displayName}
                          </p>
                        )}
                      </div>
                    </div>
                    <ScoreBadge score={item.matchScore} />
                  </div>

                  {/* Match reasons */}
                  {item.matchReasons.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {item.matchReasons.map((reason, ri) => (
                        <span
                          key={ri}
                          className="inline-flex items-center rounded-full bg-purple-50 dark:bg-purple-900/30 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:text-purple-300"
                        >
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Metrics row */}
                  <div className="mt-3 flex items-center gap-3 text-sm">
                    <span className="flex items-center gap-1 text-gray-600 dark:text-gray-300">
                      <Users className="h-3.5 w-3.5" />
                      {formatNumber(item.followers)}
                    </span>
                    {item.engagementRate > 0 && (
                      <span className="text-purple-600 dark:text-purple-400 font-medium">
                        {item.engagementRate.toFixed(2)}%
                      </span>
                    )}
                    {item.geoCity && (
                      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400 text-xs">
                        <MapPin className="h-3 w-3" />
                        {item.geoCity}
                      </span>
                    )}
                  </div>

                  {/* Categories + Spain Fit */}
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {item.categories.slice(0, 3).map((cat) => (
                      <span
                        key={cat}
                        className="inline-flex items-center rounded-md bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300"
                      >
                        {cat}
                      </span>
                    ))}
                    <SpainFitBadge level={item.spainFitLevel} />
                  </div>

                  {/* Action buttons */}
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() =>
                        setAddToListModal({ username: item.username, platform: item.platform })
                      }
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-purple-300 dark:border-purple-600 px-3 py-1.5 text-xs font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors"
                    >
                      <ListPlus className="h-3.5 w-3.5" />
                      {t.lookalikes.addToList}
                    </button>
                    <a
                      href={item.profileUrl || getProfileUrl(item.username, item.platform)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t.lookalikes.viewProfile}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            searched &&
            !searching && (
              <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-16">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t.lookalikes.noResults}
                </p>
              </div>
            )
          )}
        </>
      )}

      {/* Add to List Modal */}
      {addToListModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t.discover.addTo} @{addToListModal.username}
              </h3>
              <button
                onClick={() => {
                  setAddToListModal(null)
                  setAddToListResult(null)
                }}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {addToListResult && (
              <div
                className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${
                  addToListResult.type === 'success'
                    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                }`}
              >
                {addToListResult.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                {addToListResult.message}
              </div>
            )}
            {lists.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">{t.lists.noLists}</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {lists.map((list) => (
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
