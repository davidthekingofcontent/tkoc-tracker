'use client'

import { useState, useEffect } from 'react'
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
  Twitter,
  Loader2,
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
    case 'TIKTOK': return <Twitter className="h-3.5 w-3.5" />
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

export default function ListDetailPage() {
  const params = useParams()
  const listId = params.id as string
  const [list, setList] = useState<ListData | null>(null)
  const [isLoading, setIsLoading] = useState(true)

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
    // Remove from local state optimistically
    if (list) {
      setList({
        ...list,
        items: list.items.filter((i) => i.id !== itemId),
        _count: { items: list._count.items - 1 },
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500">Loading list...</span>
      </div>
    )
  }

  if (!list) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500">List not found</p>
        <Link href="/lists" className="mt-4 text-purple-600 hover:underline">
          Back to lists
        </Link>
      </div>
    )
  }

  const items = list.items || []
  const combinedReach = items.reduce((sum, i) => sum + (i.influencer.followers || 0), 0)
  const withEmail = items.filter((i) => i.influencer.email).length

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/lists"
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Lists
      </Link>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{list.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {items.length} influencers &middot; {formatNumber(combinedReach)} combined reach
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => {}}>
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Influencers"
          value={items.length}
          accent
        />
        <StatCard
          icon={<Eye className="h-5 w-5" />}
          label="Combined Reach"
          value={formatNumber(combinedReach)}
        />
        <StatCard
          icon={<Mail className="h-5 w-5" />}
          label="With Email"
          value={withEmail}
        />
      </div>

      {/* Influencers Table */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Influencer</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead>Followers</TableHead>
              <TableHead>Eng. Rate</TableHead>
              <TableHead>Avg Likes</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-gray-500">
                  No influencers in this list yet
                </TableCell>
              </TableRow>
            ) : (
              items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={item.influencer.displayName || item.influencer.username} size="sm" />
                      <div>
                        <p className="font-medium text-gray-900">
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
                      title="Remove from list"
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
