'use client'

import { useState } from 'react'
import { useI18n } from '@/i18n/context'
import {
  Search,
  Instagram,
  Youtube,
  Twitter,
  RefreshCw,
  ListPlus,
  ExternalLink,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatNumber } from '@/lib/utils'

interface RecentSearch {
  id: string
  username: string
  platform: 'instagram' | 'tiktok' | 'youtube'
  followers: number
  engagementRate: number
  medianLikes: number
  medianComments: number
  medianViews: number
  email: string
}

const MOCK_RECENT: RecentSearch[] = [
  {
    id: '1',
    username: '@katyperry',
    platform: 'instagram',
    followers: 206_000_000,
    engagementRate: 0.8,
    medianLikes: 1_200_000,
    medianComments: 15_000,
    medianViews: 5_400_000,
    email: 'mgmt@katyperry.com',
  },
  {
    id: '2',
    username: '@ibaborja',
    platform: 'instagram',
    followers: 1_800_000,
    engagementRate: 3.2,
    medianLikes: 45_000,
    medianComments: 890,
    medianViews: 320_000,
    email: 'iba@agency.es',
  },
  {
    id: '3',
    username: '@auronplay',
    platform: 'youtube',
    followers: 29_400_000,
    engagementRate: 5.1,
    medianLikes: 820_000,
    medianComments: 42_000,
    medianViews: 8_500_000,
    email: '',
  },
  {
    id: '4',
    username: '@dulceida',
    platform: 'instagram',
    followers: 3_100_000,
    engagementRate: 1.9,
    medianLikes: 38_000,
    medianComments: 320,
    medianViews: 180_000,
    email: 'management@dulceida.com',
  },
  {
    id: '5',
    username: '@marina_rivers',
    platform: 'tiktok',
    followers: 8_200_000,
    engagementRate: 7.4,
    medianLikes: 420_000,
    medianComments: 8_500,
    medianViews: 2_100_000,
    email: 'marina@influenceragency.es',
  },
  {
    id: '6',
    username: '@lfrfranco',
    platform: 'tiktok',
    followers: 2_400_000,
    engagementRate: 6.8,
    medianLikes: 125_000,
    medianComments: 3_200,
    medianViews: 850_000,
    email: 'luis.franco@mgmt.com',
  },
  {
    id: '7',
    username: '@miare_s',
    platform: 'youtube',
    followers: 4_600_000,
    engagementRate: 4.2,
    medianLikes: 180_000,
    medianComments: 9_800,
    medianViews: 1_800_000,
    email: 'miare@agency.com',
  },
  {
    id: '8',
    username: '@nil_ojeda',
    platform: 'instagram',
    followers: 5_500_000,
    engagementRate: 2.6,
    medianLikes: 95_000,
    medianComments: 2_100,
    medianViews: 620_000,
    email: 'nil@management.es',
  },
]

const PlatformIcon = ({ platform }: { platform: string }) => {
  switch (platform) {
    case 'instagram':
      return <Instagram className="h-4 w-4 text-pink-400" />
    case 'youtube':
      return <Youtube className="h-4 w-4 text-red-400" />
    case 'tiktok':
      return <Twitter className="h-4 w-4 text-cyan-400" />
    default:
      return null
  }
}

const platformButtons = [
  { id: 'instagram', label: 'Instagram', icon: Instagram, color: 'text-pink-400' },
  { id: 'tiktok', label: 'TikTok', icon: Twitter, color: 'text-cyan-400' },
  { id: 'youtube', label: 'YouTube', icon: Youtube, color: 'text-red-400' },
]

export default function AnalyzePage() {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState('instagram')

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.analyze.title}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t.analyze.subtitle}
        </p>
      </div>

      {/* Big Search Bar */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          {platformButtons.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPlatform(p.id)}
              className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                selectedPlatform === p.id
                  ? 'border-purple-300 bg-purple-50 text-purple-600'
                  : 'border-gray-200 bg-gray-50 text-gray-500 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              <p.icon className={`h-4 w-4 ${selectedPlatform === p.id ? 'text-purple-600' : p.color}`} />
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-gray-400">
              <Search className="h-5 w-5" />
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.analyze.inputPlaceholder}
              className="block w-full rounded-lg border border-gray-200 bg-gray-50 py-3.5 pl-12 pr-4 text-base text-gray-900 placeholder-gray-400 transition-colors focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </div>
          <Button size="lg">
            <Search className="h-4 w-4" />
            {t.analyze.analyze}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="recent">
        <TabsList>
          <TabsTrigger value="recent">{t.analyze.recentSearches}</TabsTrigger>
          <TabsTrigger value="insights">{t.analyze.insights}</TabsTrigger>
        </TabsList>

        <TabsContent value="recent">
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>{t.analyze.username}</TableHead>
                  <TableHead>{t.campaigns.followers}</TableHead>
                  <TableHead>{t.campaigns.engagement}</TableHead>
                  <TableHead>{t.analyze.medianLikes}</TableHead>
                  <TableHead>{t.analyze.medianComments}</TableHead>
                  <TableHead>{t.analyze.medianViews}</TableHead>
                  <TableHead>{t.common.email}</TableHead>
                  <TableHead className="text-right">{t.common.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {MOCK_RECENT.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <PlatformIcon platform={item.platform} />
                    </TableCell>
                    <TableCell>
                      <button className="font-medium text-gray-900 hover:text-purple-600 transition-colors inline-flex items-center gap-1.5">
                        {item.username}
                        <ExternalLink className="h-3 w-3 text-gray-400" />
                      </button>
                    </TableCell>
                    <TableCell>{formatNumber(item.followers)}</TableCell>
                    <TableCell>
                      <span
                        className={
                          item.engagementRate >= 5
                            ? 'text-emerald-500'
                            : item.engagementRate >= 3
                              ? 'text-purple-600'
                              : 'text-gray-600'
                        }
                      >
                        {item.engagementRate}%
                      </span>
                    </TableCell>
                    <TableCell>{formatNumber(item.medianLikes)}</TableCell>
                    <TableCell>{formatNumber(item.medianComments)}</TableCell>
                    <TableCell>{formatNumber(item.medianViews)}</TableCell>
                    <TableCell>
                      <span className="text-xs text-gray-500">
                        {item.email || '—'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                          title={t.analyze.addToList}
                        >
                          <ListPlus className="h-4 w-4" />
                        </button>
                        <button
                          className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-900"
                          title={t.analyze.refreshData}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="insights">
          <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm py-20">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
              <Search className="h-6 w-6" />
            </div>
            <p className="mt-4 text-sm text-gray-500">
              {t.analyze.insightsEmpty}
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
