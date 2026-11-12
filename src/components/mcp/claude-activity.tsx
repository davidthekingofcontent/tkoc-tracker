'use client'

/**
 * «Actividad de Claude», inside the card «Conexiones con Claude» of Ajustes
 * (ADMIN only). Loads GET /api/oauth/activity on its own (see ./activity-api.ts):
 *   - at the top, the actions waiting for a confirmation. The viewer's own
 *     pending ones carry «Confirmar», a plain link to /mcp/confirmar/<id>,
 *     where the decision is taken (nothing is decided from this card). The
 *     others say whose they are: only that administrator may confirm;
 *   - then the last 50 calls of every connection: tool, result, when, who.
 *
 * SECURITY: user names and previews are rendered as React text nodes only
 * (escaped). The only link is the confirmation path, checked by toActivity.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { EurLocale } from '@/lib/utils'
import { loadActivity, type Activity, type ActivityCall, type CallResult, type PendingActionRow } from './activity-api'
import { formatDateTime, formatTimeOfDay } from './format'
import { fillText } from './write-texts'

export type ActivityLoadState = 'loading' | 'ready' | 'error'

const RESULT_TONE: Record<CallResult, string> = {
  read: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  preview: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  approval: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  refused: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  failed: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  limited: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  invalid: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  running: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  unfinished: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
}

const TAG = 'inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-400'
const TOOL = 'break-all font-mono text-xs text-gray-900 dark:text-gray-100'

/** Self-contained: loads the activity and refreshes it on demand. */
export function ClaudeActivity() {
  const [state, setState] = useState<ActivityLoadState>('loading')
  const [activity, setActivity] = useState<Activity | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // A refresh that failed while a list was on screen: the list stays, with a warning that it may be old
  const [stale, setStale] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void loadActivity().then(data => {
      if (!alive.current) return
      if (data) setActivity(data)
      setState(data ? 'ready' : 'error')
    })
    return () => {
      alive.current = false
    }
  }, [])

  async function refresh() {
    const hadList = activity !== null
    setRefreshing(true)
    if (!hadList) setState('loading')
    const data = await loadActivity()
    if (!alive.current) return
    if (data) {
      setActivity(data)
      setState('ready')
      setStale(false)
    } else if (hadList) {
      setStale(true)
    } else {
      setState('error')
    }
    setRefreshing(false)
  }

  return <ActivityView state={state} activity={activity} refreshing={refreshing} stale={stale} onRefresh={refresh} />
}

export interface ActivityViewProps {
  state: ActivityLoadState
  activity: Activity | null
  refreshing?: boolean
  /** The last refresh failed: what is shown may be old. */
  stale?: boolean
  onRefresh?: () => void
}

/** What the activity looks like for a given state. No data loading here. */
export function ActivityView({ state, activity, refreshing = false, stale = false, onRefresh }: ActivityViewProps) {
  const { t, locale } = useI18n()
  const a = t.mcp.activity

  return (
    <section aria-labelledby="mcp-activity-title" className="mt-8">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 id="mcp-activity-title" className="text-lg font-semibold text-gray-900 dark:text-white">
          {a.title}
        </h3>
        {onRefresh && state !== 'loading' && (
          <Button size="sm" variant="secondary" onClick={onRefresh} loading={refreshing}>
            {!refreshing && <RefreshCw className="h-3.5 w-3.5" />}
            {a.refresh}
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">{a.intro}</p>

      <Card variant="elevated">
        <CardContent>
          {state === 'loading' ? (
            <div className="flex items-center justify-center py-8" role="status" aria-label={a.loading}>
              <Loader2 className="h-5 w-5 animate-spin text-purple-600" />
            </div>
          ) : state === 'error' || !activity ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-600 dark:text-red-400">{a.loadError}</p>
              {onRefresh && (
                <Button size="sm" variant="secondary" onClick={onRefresh}>
                  {a.retry}
                </Button>
              )}
            </div>
          ) : (
            <>
              {stale && (
                <p role="status" className="mb-4 rounded-lg bg-red-50 px-4 py-2 text-sm font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                  {a.loadError}
                </p>
              )}
              {activity.pending.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{a.pendingTitle}</h4>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{a.pendingHint}</p>
                  <ul className="mt-3 space-y-3">
                    {activity.pending.map(row => (
                      <PendingItem key={row.id} row={row} locale={locale} />
                    ))}
                  </ul>
                </div>
              )}

              <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{a.recentTitle}</h4>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{a.recentHint}</p>
              {activity.calls.length === 0 ? (
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">{a.empty}</p>
              ) : (
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
                  {activity.calls.map(call => (
                    <CallItem key={call.id} call={call} locale={locale} />
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function PendingItem({ row, locale }: { row: PendingActionRow; locale: EurLocale }) {
  const { t } = useI18n()
  const a = t.mcp.activity
  const owner = row.ownerName ?? a.someoneElse
  const waitingForMe = row.mine && row.status === 'pending'

  return (
    <li
      className={
        waitingForMe
          ? 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-900/20'
          : 'rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700'
      }
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <code className={TOOL}>{row.tool}</code>
            <span className={TAG}>{a.classes[row.confirmation]}</span>
          </p>
          {row.preview && <p className="mt-1.5 break-words text-sm text-gray-700 dark:text-gray-300">{row.preview}</p>}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {fillText(a.expires, { time: formatTimeOfDay(row.expiresAt, locale) })}
          </p>
          {row.mine && row.status === 'approved' && (
            <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">{a.approved}</p>
          )}
          {!row.mine && (
            <p className="mt-1 break-words text-xs text-gray-600 dark:text-gray-400">{fillText(a.ownerOnly, { owner })}</p>
          )}
        </div>
        {waitingForMe && row.approvePath && (
          <div className="shrink-0">
            <Button as="a" href={row.approvePath} size="sm" variant="primary">
              {a.confirm}
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

function CallItem({ call, locale }: { call: ActivityCall; locale: EurLocale }) {
  const { t } = useI18n()
  const a = t.mcp.activity
  const who = call.userName ?? a.unknownUser

  return (
    <li className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className={TOOL}>{call.tool}</code>
        {call.confirmation && call.confirmation !== 'none' && <span className={TAG}>{a.classes[call.confirmation]}</span>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${RESULT_TONE[call.result]}`}>
          {a.results[call.result]}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {fillText(a.byWhom, { time: formatDateTime(call.at, locale), name: who })}
        </span>
      </div>
    </li>
  )
}
