'use client'

import { useState, useEffect } from 'react'
import {
  Search,
  Plus,
  MoreHorizontal,
  Instagram,
  Youtube,
  Loader2,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { formatNumber, formatDate } from '@/lib/utils'
import { useI18n } from '@/i18n/context'

interface ContactData {
  id: string
  status: string
  notes: string | null
  createdAt: string
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    platform: string
    followers: number
    engagementRate: number | null
    email: string | null
    phone: string | null
  }
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

export default function ContactsPage() {
  const { t } = useI18n()
  const [contacts, setContacts] = useState<ContactData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function fetchContacts() {
      try {
        const res = await fetch('/api/contacts')
        if (res.ok) {
          const data = await res.json()
          setContacts(data.contacts || [])
        }
      } catch (err) {
        console.error('Error fetching contacts:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchContacts()
  }, [])

  const filtered = contacts.filter(
    (c) =>
      (c.influencer.displayName || '').toLowerCase().includes(search.toLowerCase()) ||
      c.influencer.username.toLowerCase().includes(search.toLowerCase()) ||
      (c.influencer.email || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t.contacts.title}</h1>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={t.contacts.totalContacts}
          value={contacts.length}
          accent
        />
        <StatCard
          icon={<Instagram className="h-5 w-5" />}
          label={t.contacts.withEmail}
          value={contacts.filter(c => c.influencer.email).length}
        />
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label={t.dashboard.totalReach}
          value={formatNumber(contacts.reduce((s, c) => s + (c.influencer.followers || 0), 0))}
        />
      </div>

      {/* Search */}
      <Input
        placeholder={t.contacts.searchPlaceholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        icon={<Search className="h-4 w-4" />}
      />

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 rounded-xl border border-gray-200 bg-white">
          <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
          <span className="ml-2 text-gray-500">{t.common.loading}</span>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.contacts.title}</TableHead>
                <TableHead>{t.campaigns.platform}</TableHead>
                <TableHead>{t.campaigns.followers}</TableHead>
                <TableHead>{t.campaigns.engagement}</TableHead>
                <TableHead>{t.common.email}</TableHead>
                <TableHead>{t.contacts.phone}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.contacts.added}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center text-gray-500">
                    {contacts.length === 0
                      ? t.contacts.noContactsDesc
                      : t.common.noResults}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((contact) => (
                  <TableRow key={contact.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar name={contact.influencer.displayName || contact.influencer.username} size="sm" src={contact.influencer.avatarUrl || undefined} />
                        <div>
                          <p className="font-medium text-gray-900">@{contact.influencer.username}</p>
                          <p className="text-xs text-gray-500">{contact.influencer.displayName}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={platformBadge(contact.influencer.platform)}>
                        <PlatformIcon platform={contact.influencer.platform} />
                        {contact.influencer.platform.charAt(0) + contact.influencer.platform.slice(1).toLowerCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatNumber(contact.influencer.followers)}</TableCell>
                    <TableCell>
                      <span className="text-purple-600">{contact.influencer.engagementRate || 0}%</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-gray-400">{contact.influencer.email || '—'}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-gray-400">{contact.influencer.phone || '—'}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={contact.status === 'new' ? 'default' : contact.status === 'contacted' ? 'active' : 'paused'}>
                        {contact.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDate(contact.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
