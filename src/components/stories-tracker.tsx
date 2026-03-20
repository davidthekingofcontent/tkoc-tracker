'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Eye, MessageCircle, Radio, Clock, Plus, X } from 'lucide-react'
import { formatNumber } from '@/lib/utils'

interface StoryData {
  id: string
  permalink: string | null
  thumbnailUrl: string | null
  views: number
  reach: number
  impressions: number
  comments: number
  postedAt: string | null
  isActive: boolean
  expiresAt: string | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
  }
}

interface InfluencerGroup {
  influencer: StoryData['influencer']
  stories: StoryData[]
  totalViews: number
  totalReach: number
}

interface Stats {
  total: number
  active: number
  expired: number
  totalReach: number
  totalImpressions: number
  totalViews: number
  totalReplies: number
}

interface StoriesTrackerProps {
  campaignId: string
  locale: string
  influencers: Array<{ id: string; username: string }>
}

export function StoriesTracker({ campaignId, locale, influencers }: StoriesTrackerProps) {
  const [stories, setStories] = useState<StoryData[]>([])
  const [byInfluencer, setByInfluencer] = useState<InfluencerGroup[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({
    influencerId: '',
    views: '',
    reach: '',
    replies: '',
    permalink: '',
  })
  const [isAdding, setIsAdding] = useState(false)

  const fetchStories = useCallback(async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/stories`)
      if (res.ok) {
        const data = await res.json()
        setStories(data.stories || [])
        setByInfluencer(data.byInfluencer || [])
        setStats(data.stats || null)
      }
    } catch { /* ignore */ }
    setIsLoading(false)
  }, [campaignId])

  useEffect(() => {
    fetchStories()
  }, [fetchStories])

  async function handleAddStory() {
    if (!addForm.influencerId) return
    setIsAdding(true)
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          influencerId: addForm.influencerId,
          views: parseInt(addForm.views) || 0,
          reach: parseInt(addForm.reach) || 0,
          replies: parseInt(addForm.replies) || 0,
          permalink: addForm.permalink || null,
        }),
      })
      if (res.ok) {
        setShowAddForm(false)
        setAddForm({ influencerId: '', views: '', reach: '', replies: '', permalink: '' })
        await fetchStories()
      }
    } catch { /* ignore */ }
    setIsAdding(false)
  }

  function timeRemaining(expiresAt: string | null) {
    if (!expiresAt) return ''
    const diff = new Date(expiresAt).getTime() - Date.now()
    if (diff <= 0) return locale === 'es' ? 'Expirada' : 'Expired'
    const hours = Math.floor(diff / 3600000)
    const mins = Math.floor((diff % 3600000) / 60000)
    return `${hours}h ${mins}m`
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Radio className="h-3.5 w-3.5 text-green-500" />
              {locale === 'es' ? 'Activas' : 'Active'}
            </div>
            <p className="mt-1 text-2xl font-bold text-green-600">{stats.active}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Eye className="h-3.5 w-3.5 text-blue-500" />
              {locale === 'es' ? 'Vistas' : 'Views'}
            </div>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalViews)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Eye className="h-3.5 w-3.5 text-purple-500" />
              {locale === 'es' ? 'Alcance' : 'Reach'}
            </div>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalReach)}</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700">
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <MessageCircle className="h-3.5 w-3.5 text-amber-500" />
              {locale === 'es' ? 'Respuestas' : 'Replies'}
            </div>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{formatNumber(stats.totalReplies)}</p>
          </div>
        </div>
      )}

      {/* Add Story Button */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {locale === 'es' ? 'Stories por Influencer' : 'Stories by Influencer'}
        </h3>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 transition-colors"
        >
          {showAddForm ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {showAddForm
            ? (locale === 'es' ? 'Cancelar' : 'Cancel')
            : (locale === 'es' ? 'Registrar Story' : 'Log Story')}
        </button>
      </div>

      {/* Add Story Form */}
      {showAddForm && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4 dark:bg-purple-900/20 dark:border-purple-800">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">
                {locale === 'es' ? 'Influencer' : 'Influencer'}
              </label>
              <select
                value={addForm.influencerId}
                onChange={(e) => setAddForm({ ...addForm, influencerId: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
              >
                <option value="">{locale === 'es' ? 'Seleccionar...' : 'Select...'}</option>
                {influencers.map((inf) => (
                  <option key={inf.id} value={inf.id}>{inf.username}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Views</label>
              <input
                type="number"
                value={addForm.views}
                onChange={(e) => setAddForm({ ...addForm, views: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Reach</label>
              <input
                type="number"
                value={addForm.reach}
                onChange={(e) => setAddForm({ ...addForm, reach: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">
                {locale === 'es' ? 'Respuestas' : 'Replies'}
              </label>
              <input
                type="number"
                value={addForm.replies}
                onChange={(e) => setAddForm({ ...addForm, replies: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="0"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">
                {locale === 'es' ? 'Enlace (opcional)' : 'Link (optional)'}
              </label>
              <input
                type="url"
                value={addForm.permalink}
                onChange={(e) => setAddForm({ ...addForm, permalink: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="https://instagram.com/stories/..."
              />
            </div>
          </div>
          <button
            onClick={handleAddStory}
            disabled={!addForm.influencerId || isAdding}
            className="mt-3 rounded-lg bg-purple-600 px-4 py-2 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {isAdding ? <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> : null}
            {locale === 'es' ? 'Guardar Story' : 'Save Story'}
          </button>
        </div>
      )}

      {/* Stories by Influencer */}
      {byInfluencer.length === 0 ? (
        <div className="py-12 text-center">
          <Radio className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-400">
            {locale === 'es' ? 'No hay stories registradas todavía' : 'No stories tracked yet'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {locale === 'es'
              ? 'Registra stories manualmente o configura el scraping automático'
              : 'Log stories manually or set up automatic scraping'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {byInfluencer.map((group) => (
            <div
              key={group.influencer.id}
              className="rounded-xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700"
            >
              {/* Influencer Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  {group.influencer.avatarUrl ? (
                    <img
                      src={`/api/proxy/image?url=${encodeURIComponent(group.influencer.avatarUrl)}`}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-100 text-xs font-bold text-purple-600">
                      {group.influencer.username.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      @{group.influencer.username}
                    </p>
                    <p className="text-[10px] text-gray-400">
                      {group.stories.length} {group.stories.length === 1 ? 'story' : 'stories'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>
                    <Eye className="inline h-3 w-3 mr-0.5" />
                    {formatNumber(group.totalViews)}
                  </span>
                  <span>
                    <Radio className="inline h-3 w-3 mr-0.5 text-purple-500" />
                    {formatNumber(group.totalReach)}
                  </span>
                </div>
              </div>

              {/* Stories Timeline */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {group.stories.map((story) => (
                  <div
                    key={story.id}
                    className={`shrink-0 rounded-lg border p-2.5 w-28 ${
                      story.isActive
                        ? 'border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800'
                        : 'border-gray-200 bg-gray-50 dark:bg-gray-800 dark:border-gray-700'
                    }`}
                  >
                    {story.thumbnailUrl ? (
                      <img
                        src={story.thumbnailUrl}
                        alt=""
                        className="mb-1.5 h-16 w-full rounded object-cover"
                      />
                    ) : (
                      <div className={`mb-1.5 flex h-16 w-full items-center justify-center rounded ${
                        story.isActive ? 'bg-green-100' : 'bg-gray-100 dark:bg-gray-700'
                      }`}>
                        <Radio className={`h-5 w-5 ${story.isActive ? 'text-green-500' : 'text-gray-400'}`} />
                      </div>
                    )}
                    <p className="text-[10px] font-bold text-gray-900 dark:text-gray-100">
                      {formatNumber(story.views)} views
                    </p>
                    <div className="mt-0.5 flex items-center gap-1 text-[9px] text-gray-400">
                      <Clock className="h-2.5 w-2.5" />
                      {story.isActive ? (
                        <span className="text-green-600">{timeRemaining(story.expiresAt)}</span>
                      ) : (
                        <span>{locale === 'es' ? 'Expirada' : 'Expired'}</span>
                      )}
                    </div>
                    {story.permalink && (
                      <a
                        href={story.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 block text-[9px] text-purple-600 hover:underline truncate"
                      >
                        {locale === 'es' ? 'Ver story' : 'View story'}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
