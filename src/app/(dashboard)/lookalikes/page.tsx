'use client'

import { useState } from 'react'
import { UserCheck, Search, Instagram, ExternalLink } from 'lucide-react'
import { useI18n } from '@/i18n/context'

interface LookalikeResult {
  username: string
  displayName: string
  platform: string
  followers: number
  engagementRate: number
  matchScore: number
  bio: string
  profileUrl: string
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

export default function LookalikesPage() {
  const { t } = useI18n()
  const [handle, setHandle] = useState('')
  const [platform, setPlatform] = useState('INSTAGRAM')
  const [results, setResults] = useState<LookalikeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)

  const handleSearch = async () => {
    if (!handle.trim()) return
    setSearching(true)
    setSearched(false)

    try {
      const res = await fetch(`/api/influencers/lookalikes?handle=${encodeURIComponent(handle.replace('@', ''))}&platform=${platform}`)
      if (res.ok) {
        const data = await res.json()
        setResults(data.lookalikes || [])
      } else {
        setResults([])
      }
    } catch {
      setResults([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.lookalikes.title}</h1>
        <p className="mt-1 text-sm text-gray-500">{t.lookalikes.subtitle}</p>
      </div>

      {/* Search Box */}
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex gap-3">
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200"
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
              className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200"
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

      {/* Results */}
      {!searched && !searching && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-16">
          <UserCheck className="h-12 w-12 text-gray-300 mb-4" />
          <p className="text-sm text-gray-500 text-center max-w-md">
            {t.lookalikes.enterCreator}
          </p>
        </div>
      )}

      {searching && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-purple-200 border-t-purple-600" />
        </div>
      )}

      {searched && results.length === 0 && !searching && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white py-16">
          <p className="text-sm text-gray-500">{t.lookalikes.noResults}</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900">
            {t.lookalikes.similarTo} @{handle.replace('@', '')}
          </h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {results.map((result, i) => (
              <div
                key={i}
                className="rounded-xl border border-gray-200 bg-white p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-100 text-purple-700 font-semibold text-sm">
                      {result.displayName?.[0] || result.username[0]}
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">@{result.username}</p>
                      <p className="text-xs text-gray-500">{result.displayName}</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                    {t.lookalikes.matchScore}: {result.matchScore}%
                  </span>
                </div>
                <p className="mt-3 text-xs text-gray-500 line-clamp-2">{result.bio}</p>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1 text-gray-600">
                      <PlatformIcon platform={result.platform} />
                      {formatNumber(result.followers)}
                    </span>
                    <span className="text-purple-600 font-medium">
                      {result.engagementRate}%
                    </span>
                  </div>
                  {result.profileUrl && (
                    <a
                      href={result.profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-400 hover:text-purple-600 transition-colors"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
