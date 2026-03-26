'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Plus,
  Download,
  Trash2,
  Users,
  Eye,
  Mail,
  Instagram,
  Youtube,
  Loader2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatNumber } from '@/lib/utils'
import { useI18n } from '@/i18n/context'

interface ListInfluencer {
  id: string
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
    engagementRate: number | null
    avgLikes: number | null
    avgComments: number | null
    avgViews: number | null
    email: string | null
    country: string | null
    city: string | null
  }
}

interface ListData {
  id: string
  name: string
  isPinned: boolean
  isArchived: boolean
  items: ListInfluencer[]
  _count: { items: number }
}

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'INSTAGRAM': return <Instagram className="h-3.5 w-3.5" />
    case 'YOUTUBE': return <Youtube className="h-3.5 w-3.5" />
    case 'TIKTOK': return <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V9.05a8.27 8.27 0 004.76 1.5V7.12a4.83 4.83 0 01-1-.43z"/></svg>
    default: return null
  }
}

const platformBadge = (platform: string) => {
  switch (platform) {
    case 'INSTAGRAM': return 'instagram' as const
    case 'YOUTUBE': return 'youtube' as const
    case 'TIKTOK': return 'tiktok' as const
    default: return 'default' as const
  }
}

function getNestedValue(obj: ListInfluencer, field: string): number {
  switch (field) {
    case 'followers': return obj.influencer.followers || 0
    case 'engagementRate': return obj.influencer.engagementRate || 0
    case 'avgLikes': return obj.influencer.avgLikes || 0
    case 'avgComments': return obj.influencer.avgComments || 0
    case 'avgViews': return obj.influencer.avgViews || 0
    default: return 0
  }
}

export default function ListDetailPage() {
  const params = useParams()
  const { t } = useI18n()
  const listId = params.id as string
  const [list, setList] = useState<ListData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [sortField, setSortField] = useState<string>('followers')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [listSearch, setListSearch] = useState('')
  const [listPlatformFilter, setListPlatformFilter] = useState('all')

  function toggleSort(field: string) {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function SortHeader({ label, field }: { label: string; field: string }) {
    return (
      <button
        onClick={() => toggleSort(field)}
        className="flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        {label}
        {sortField === field && (
          <span className="text-purple-600">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </button>
    )
  }

  async function fetchList() {
    try {
      const res = await fetch(`/api/lists/${listId}`)
      if (res.ok) {
        const data = await res.json()
        setList(data.list)
      }
    } catch (err) {
      console.error('Error fetching list:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchList()
  }, [listId])

  const handleRemove = async (itemId: string) => {
    // Optimistic update
    const previousList = list
    if (list) {
      setList({
        ...list,
        items: list.items.filter((i) => i.id !== itemId),
        _count: { items: list._count.items - 1 },
      })
    }

    try {
      const res = await fetch(`/api/lists/${listId}?itemId=${itemId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        // Revert on failure
        setList(previousList)
        console.error('Failed to remove item from list')
      }
    } catch (err) {
      // Revert on error
      setList(previousList)
      console.error('Error removing item from list:', err)
    }
  }

  const items = list?.items || []
  const combinedReach = items.reduce((sum, i) => sum + (i.influencer.followers || 0), 0)
  const withEmail = items.filter((i) => i.influencer.email).length

  const sortedItems = useMemo(() => {
    if (!items.length) return []
    let filtered = items
    // Search filter
    if (listSearch.trim()) {
      const q = listSearch.toLowerCase()
      filtered = filtered.filter(i =>
        i.influencer.username.toLowerCase().includes(q) ||
        (i.influencer.displayName || '').toLowerCase().includes(q) ||
        (i.influencer.country || '').toLowerCase().includes(q) ||
        (i.influencer.city || '').toLowerCase().includes(q)
      )
    }
    // Platform filter
    if (listPlatformFilter !== 'all') {
      filtered = filtered.filter(i => i.influencer.platform === listPlatformFilter)
    }
    return [...filtered].sort((a, b) => {
      const aVal = getNestedValue(a, sortField)
      const bVal = getNestedValue(b, sortField)
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal
    })
  }, [items, sortField, sortDir, listSearch, listPlatformFilter])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500">{t.common.loading}</span>
      </div>
    )
  }

  if (!list) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500">{t.listDetail?.listNotFound || 'List not found'}</p>
        <Link href="/lists" className="mt-4 text-purple-600 hover:underline">
          {t.common.back}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/lists"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t.common.back}
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{list.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {items.length} influencers &middot; {formatNumber(combinedReach)} {t.listDetail.combinedReach}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
            <Upload className="h-4 w-4" />
            {t.listDetail?.import || 'Import CSV'}
            <input
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const text = await file.text()
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
                const usernames = lines.map(l => l.split(',')[0].trim().replace(/^@/, '').replace(/"/g, '')).filter(Boolean)
                if (usernames.length === 0) return
                let added = 0
                for (const username of usernames) {
                  try {
                    const analyzeRes = await fetch('/api/influencers/analyze', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username, platform: 'INSTAGRAM' }),
                    })
                    if (analyzeRes.ok) {
                      const analyzeData = await analyzeRes.json()
                      const influencerId = analyzeData.influencer?.id
                      if (influencerId) {
                        await fetch(`/api/lists/${listId}`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ influencerId }),
                        })
                        added++
                      }
                    }
                  } catch { /* skip failed */ }
                }
                if (added > 0) fetchList()
                e.target.value = ''
              }}
            />
          </label>
          <Button variant="secondary" onClick={() => {}}>
            <Download className="h-4 w-4" />
            {t.listDetail?.export || 'Export'}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={t.lists.creators}
          value={items.length}
          accent
        />
        <StatCard
          icon={<Mail className="h-5 w-5" />}
          label={t.lists.withEmail}
          value={withEmail}
        />
      </div>

      {/* Search & Filter Bar */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder={t.common.search || 'Search by name, username, location...'}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
            />
          </div>
          <select
            value={listPlatformFilter}
            onChange={(e) => setListPlatformFilter(e.target.value)}
            className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 outline-none focus:border-purple-500"
          >
            <option value="all">{t.campaignDetail?.allPlatforms || 'All Platforms'}</option>
            <option value="INSTAGRAM">Instagram</option>
            <option value="TIKTOK">TikTok</option>
            <option value="YOUTUBE">YouTube</option>
          </select>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {sortedItems.length} / {items.length} {t.lists.creators}
          </p>
          {(listSearch || listPlatformFilter !== 'all') && (
            <button
              onClick={() => { setListSearch(''); setListPlatformFilter('all') }}
              className="text-xs text-purple-600 dark:text-purple-400 hover:underline font-medium"
            >
              {t.common.clearFilters || 'Clear filters'}
            </button>
          )}
        </div>
      </div>

      {/* Influencers Table */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.campaigns.platform}</TableHead>
              <TableHead><SortHeader label={t.campaigns.followers} field="followers" /></TableHead>
              <TableHead><SortHeader label={t.campaigns.engagement} field="engagementRate" /></TableHead>
              <TableHead><SortHeader label={t.listDetail.avgLikes} field="avgLikes" /></TableHead>
              <TableHead>{t.listDetail.location}</TableHead>
              <TableHead>{t.common.email}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-gray-500">
                  {t.common.noResults}
                </TableCell>
              </TableRow>
            ) : (
              sortedItems.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={item.influencer.displayName || item.influencer.username} size="sm" src={item.influencer.avatarUrl || undefined} />
                      <div>
                        <p className="font-medium text-gray-900 dark:text-gray-100">
                          @{item.influencer.username}
                        </p>
                        <p className="text-xs text-gray-500">
                          {item.influencer.displayName}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={platformBadge(item.influencer.platform)}>
                      <PlatformIcon platform={item.influencer.platform} />
                      {item.influencer.platform.charAt(0) + item.influencer.platform.slice(1).toLowerCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatNumber(item.influencer.followers)}</TableCell>
                  <TableCell>
                    <span className="text-purple-600">{item.influencer.engagementRate || 0}%</span>
                  </TableCell>
                  <TableCell>{formatNumber(item.influencer.avgLikes || 0)}</TableCell>
                  <TableCell>
                    <span className="text-xs text-gray-500">
                      {[item.influencer.city, item.influencer.country].filter(Boolean).join(', ') || '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-gray-400">
                      {item.influencer.email || '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      onClick={() => handleRemove(item.id)}
                      className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                      title={t.lists.removeFromList}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
