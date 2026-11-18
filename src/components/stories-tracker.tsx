'use client'

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Eye, MessageCircle, Radio, Clock, Plus, X, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { formatNumber } from '@/lib/utils'
import { avatarSrcOf, mediaThumbUrl } from '@/lib/proxy-image'
import { Avatar } from '@/components/ui/avatar'
import { useI18n } from '@/i18n/context'

/** Apify budget pause reported by GET /api/apify-status (every field optional, best-effort hint) */
interface BudgetPause {
  cycleEndsAt: string | null
}

/** "25/09" — the day (Europe/Madrid) the Apify cycle resets: cycleEndsAt + 1 ms; null when unknown */
function formatResumeDate(cycleEndsAt: string | null, locale: string): string | null {
  if (!cycleEndsAt) return null
  const end = new Date(cycleEndsAt)
  if (Number.isNaN(end.getTime())) return null
  return new Date(end.getTime() + 1).toLocaleDateString(locale === 'es' ? 'es-ES' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Madrid',
  })
}

interface StoryData {
  id: string
  permalink: string | null
  thumbnailUrl: string | null
  views: number
  reach: number
  impressions: number
  comments: number
  postedAt: string | null
  /** Still live on Instagram (first 24 h) */
  isActive: boolean
  expiresAt: string | null
  /** Whole days since it was published; what the card says once it is no longer live */
  daysSincePosted: number | null
  influencer: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
  }
}

/**
 * What the automatic scan does with this campaign (GET …/stories → scan):
 * why it is not read today, how many creators it would read, and the last run.
 */
interface ScanInfo {
  /** 'inactive' = the campaign is paused or archived: no cron reads it, whatever its dates say */
  reason: 'window' | 'listening' | 'no_targets' | 'too_long' | 'inactive' | null
  /** With an end date, 'too_long' means "shorten the campaign"; without one, "set an end date" */
  hasEndDate: boolean
  confirmedCreators: number
  instagramCreators: number
  scannedCreators: number | null
  lastRunAt: string | null
  lastResultForCampaign: { at: string | null; scanned: boolean; creators: number | null; newStories: number | null; reason: string | null } | null
  maxCampaignDays: number
}

/** "{n}" placeholders of a translated text */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}

/** "16/11, 12:04" (Europe/Madrid) of an ISO instant; '' when it cannot be read */
function formatScanDate(iso: string | null, locale: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale === 'es' ? 'es-ES' : 'en-GB', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Madrid',
  })
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

const EMPTY_ADD_FORM = {
  influencerId: '',
  views: '',
  reach: '',
  replies: '',
  permalink: '',
  postedAt: '',
}

export function StoriesTracker({ campaignId, locale, influencers }: StoriesTrackerProps) {
  const { t } = useI18n()
  const [stories, setStories] = useState<StoryData[]>([])
  const [byInfluencer, setByInfluencer] = useState<InfluencerGroup[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  // Why the automatic scan does or does not read this campaign (null until loaded, or for an unknown campaign)
  const [scan, setScan] = useState<ScanInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM)
  const [isAdding, setIsAdding] = useState(false)
  // API errors from "Registrar Story" (they used to be swallowed); cleared on any change
  const [addError, setAddError] = useState<string | null>(null)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)
  // Automatic story scanning paused by the Apify budget (core reserve): null = running
  const [budgetPause, setBudgetPause] = useState<BudgetPause | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/apify-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== 'object') return
        const budget = (data as { budget?: { coreBlocked?: unknown; cycleEndsAt?: unknown } }).budget
        if (budget && budget.coreBlocked === true) {
          setBudgetPause({ cycleEndsAt: typeof budget.cycleEndsAt === 'string' ? budget.cycleEndsAt : null })
        }
      })
      .catch(() => { /* best-effort hint: the crons protect themselves */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!addSuccess) return
    const timer = setTimeout(() => setAddSuccess(null), 8000)
    return () => clearTimeout(timer)
  }, [addSuccess])

  function updateForm(patch: Partial<typeof EMPTY_ADD_FORM>) {
    setAddForm((f) => ({ ...f, ...patch }))
    setAddError(null)
  }
  // Story ids whose thumbnail failed to load → placeholder instead of a broken image
  const [brokenThumbs, setBrokenThumbs] = useState<Set<string>>(() => new Set())
  // Clock for the "time remaining" labels, refreshed with each stories load (Date.now() in render is impure)
  const [now, setNow] = useState(() => Date.now())

  // Promise chain (not async/await) so the state updates run in resolved callbacks — react-hooks/set-state-in-effect
  const fetchStories = useCallback(() =>
    fetch(`/api/campaigns/${campaignId}/stories`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        setStories(data.stories || [])
        setByInfluencer(data.byInfluencer || [])
        setStats(data.stats || null)
        setScan(data.scan && typeof data.scan === 'object' ? (data.scan as ScanInfo) : null)
        setNow(Date.now())
      })
      .catch(() => { /* ignore */ })
      .finally(() => setIsLoading(false)),
  [campaignId])

  useEffect(() => {
    fetchStories()
  }, [fetchStories])

  async function handleAddStory() {
    if (!addForm.influencerId) return
    setAddError(null)
    setAddSuccess(null)

    // datetime-local → ISO (the PM's local time); the API reads the date from the link when empty
    let postedAt: string | undefined
    if (addForm.postedAt) {
      const d = new Date(addForm.postedAt)
      if (Number.isNaN(d.getTime())) {
        setAddError(locale === 'es' ? 'La fecha de publicación no es válida' : 'The publication date is not valid')
        return
      }
      postedAt = d.toISOString()
    }

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
          permalink: addForm.permalink.trim() || null,
          ...(postedAt && { postedAt }),
        }),
      })
      const data: { error?: unknown; updated?: unknown } | null = await res.json().catch(() => null)
      if (!res.ok) {
        setAddError(
          (data && typeof data.error === 'string' && data.error) ||
            (locale === 'es' ? 'No se pudo registrar la story' : 'Could not log the story')
        )
        return
      }
      setShowAddForm(false)
      setAddForm(EMPTY_ADD_FORM)
      // `updated`: the link matched a story already in the campaign (cron or
      // "Añadir publicación por URL") and its metrics were refreshed, not duplicated
      setAddSuccess(
        data?.updated === true
          ? (locale === 'es'
              ? 'Esta story ya estaba registrada: se han actualizado sus datos.'
              : 'This story was already logged: its data has been updated.')
          : (locale === 'es'
              ? 'Story registrada. Recuerda: las vistas y el alcance solo los tiene la creadora.'
              : 'Story logged. Remember: only the creator has the views and reach.')
      )
      await fetchStories()
    } catch {
      setAddError(locale === 'es' ? 'Error de red' : 'Network error')
    } finally {
      setIsAdding(false)
    }
  }

  /** Time the story has left on Instagram ("3h 12m"); '' once it is no longer live */
  function timeRemaining(expiresAt: string | null) {
    if (!expiresAt) return ''
    const diff = new Date(expiresAt).getTime() - now
    if (diff <= 0) return ''
    const hours = Math.floor(diff / 3600000)
    const mins = Math.floor((diff % 3600000) / 60000)
    return `${hours}h ${mins}m`
  }

  /** What the card says about a story that is no longer live: it was published, N days ago (it never expires in the report) */
  function postedAgo(story: StoryData): string {
    const days = story.daysSincePosted
    if (days === null || days === undefined) return t.campaignDetail.storiesNoDate
    if (days === 0) return t.campaignDetail.storiesPostedToday
    if (days === 1) return t.campaignDetail.storiesPostedOneDayAgo
    return fill(t.campaignDetail.storiesPostedDaysAgo, { n: days })
  }

  // Amber note while the stories cron is paused by the Apify budget: says until when
  const resumeDate = budgetPause ? formatResumeDate(budgetPause.cycleEndsAt, locale) : null
  const budgetNotice = budgetPause ? (
    <div
      role="status"
      className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <p>
        {resumeDate
          ? t.campaignDetail.storiesPausedBudget.replace('{date}', resumeDate)
          : t.campaignDetail.storiesPausedBudgetNoDate}
      </p>
    </div>
  ) : null

  // SCAN NOTICE (16 Nov 2026). Persistent, in amber, with the one action that
  // fixes it: until now the tab said nothing and a campaign without brand
  // targets, without an end date, or with every creator still in Prospecto
  // looked like a scan that found no stories.
  const cd = t.campaignDetail
  const scanProblem: string | null = scan
    ? scan.reason === 'no_targets'
      ? cd.storiesScanNoTargets
      : scan.reason === 'too_long'
        ? fill(scan.hasEndDate ? cd.storiesScanTooLong : cd.storiesScanNoEndDate, { max: scan.maxCampaignDays })
        : scan.reason === 'inactive'
          ? cd.storiesScanInactive
        : scan.reason === 'listening'
          ? cd.storiesScanListening
          : scan.reason === 'window'
            ? cd.storiesScanWindow
            : scan.confirmedCreators === 0 && scan.instagramCreators > 0
              ? fill(cd.storiesScanNoConfirmed, { n: scan.instagramCreators })
              : null
    : null
  // The last run, for certainty: when it ran, and what it did with THIS campaign
  const lastRunText = scan
    ? scan.lastRunAt
      ? fill(cd.storiesScanLastRun, { date: formatScanDate(scan.lastRunAt, locale) })
      : cd.storiesScanNever
    : ''
  const lastResultText = scan?.lastResultForCampaign?.scanned
    ? fill(cd.storiesScanLastResult, {
        creators: scan.lastResultForCampaign.creators ?? 0,
        new: scan.lastResultForCampaign.newStories ?? 0,
      })
    : ''
  const scanNotice = scan ? (
    scanProblem ? (
      <div
        role="status"
        data-testid="stories-scan-notice"
        className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium">{scanProblem}</p>
          <p className="text-amber-700/80 dark:text-amber-300/80">{lastRunText}</p>
        </div>
      </div>
    ) : scan.confirmedCreators > 0 ? (
      <p data-testid="stories-scan-status" className="text-xs text-gray-500 dark:text-gray-400">
        {fill(cd.storiesScanOk, { n: scan.confirmedCreators })} {lastRunText} {lastResultText}
      </p>
    ) : null
  ) : null

  if (isLoading) {
    return (
      <div className="space-y-6">
        {budgetNotice}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {budgetNotice}
      {scanNotice}

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
          onClick={() => { setShowAddForm(!showAddForm); setAddError(null); setAddSuccess(null) }}
          className="flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700 transition-colors"
        >
          {showAddForm ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {showAddForm
            ? (locale === 'es' ? 'Cancelar' : 'Cancel')
            : (locale === 'es' ? 'Registrar Story' : 'Log Story')}
        </button>
      </div>

      {/* Confirmation after a successful "Registrar Story" */}
      {addSuccess && !showAddForm && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {addSuccess}
        </p>
      )}

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
                onChange={(e) => updateForm({ influencerId: e.target.value })}
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
                onChange={(e) => updateForm({ views: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="0"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">Reach</label>
              <input
                type="number"
                value={addForm.reach}
                onChange={(e) => updateForm({ reach: e.target.value })}
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
                onChange={(e) => updateForm({ replies: e.target.value })}
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
                onChange={(e) => updateForm({ permalink: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
                placeholder="https://www.instagram.com/stories/usuario/…"
              />
              <p className="mt-1 text-[10px] leading-snug text-gray-500">
                {locale === 'es'
                  ? 'Si pegas el enlace de la story, la fecha se lee del propio enlace y manda sobre la que teclees. Las vistas y el alcance solo los tiene la creadora: pídele la captura.'
                  : 'Paste the story link and the date is read from the link itself (it overrides the one you type). Only the creator has the views and reach: ask her for the screenshot.'}
              </p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="mb-1 block text-[10px] font-semibold uppercase text-gray-500">
                {locale === 'es' ? 'Fecha de publicación (si no hay enlace)' : 'Publication date (if there is no link)'}
              </label>
              <input
                type="datetime-local"
                value={addForm.postedAt}
                onChange={(e) => updateForm({ postedAt: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-purple-400"
              />
            </div>
          </div>
          {addError && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {addError}
            </p>
          )}
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
          <p className="mx-auto mt-1 max-w-md text-xs text-gray-400">
            {locale === 'es'
              ? 'Regístralas a mano ("Registrar Story") o pega el enlace en Media → "Añadir publicación por URL". Se escanean solas cada 12 h para creadoras en Acordado o superior.'
              : 'Log them by hand ("Log Story") or paste the link in Media → "Add post by URL". They are scanned automatically every 12 h for creators in Agreed or later.'}
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
                  <Avatar
                    src={avatarSrcOf(group.influencer)}
                    name={group.influencer.displayName || group.influencer.username}
                    size="sm"
                  />
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
                    // Live on Instagram: green. Afterwards a plain card, never grey: what expires
                    // is the story on Instagram, not its row in the report («Publicada hace N días»)
                    className={`shrink-0 rounded-lg border p-2.5 w-28 ${
                      story.isActive
                        ? 'border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800'
                        : 'border-purple-100 bg-white dark:bg-gray-900 dark:border-purple-900/40'
                    }`}
                  >
                    {story.thumbnailUrl && !brokenThumbs.has(story.id) ? (
                      <img
                        // Durable copy via /api/media/[id]/thumb — the raw cdninstagram URL expires and 403s
                        src={mediaThumbUrl({ id: story.id, thumbnailUrl: story.thumbnailUrl })}
                        alt=""
                        className="mb-1.5 h-16 w-full rounded object-cover"
                        onError={() => setBrokenThumbs(prev => new Set(prev).add(story.id))}
                      />
                    ) : (
                      <div className={`mb-1.5 flex h-16 w-full items-center justify-center rounded ${
                        story.isActive ? 'bg-green-100' : 'bg-purple-50 dark:bg-purple-900/20'
                      }`}>
                        <Radio className={`h-5 w-5 ${story.isActive ? 'text-green-500' : 'text-purple-400'}`} />
                      </div>
                    )}
                    <p className="text-[10px] font-bold text-gray-900 dark:text-gray-100">
                      {formatNumber(story.views)} views
                    </p>
                    <div className="mt-0.5 flex items-center gap-1 text-[9px] text-gray-500 dark:text-gray-400">
                      <Clock className="h-2.5 w-2.5" />
                      {story.isActive ? (
                        <span className="text-green-600">{cd.storiesActive} {timeRemaining(story.expiresAt)}</span>
                      ) : (
                        <span>{postedAgo(story)}</span>
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
