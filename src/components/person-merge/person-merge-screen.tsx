'use client'

/**
 * «Fichas duplicadas» (/creators/duplicadas): the merge tool of the owner's
 * brief (13 Nov 2026). ADMIN only: the page checks the session on the server
 * (src/app/(dashboard)/creators/duplicadas/page.tsx) and the route checks it
 * again on every call (src/app/api/admin/person-merge/route.ts).
 *
 *  - the candidates (optionally of one campaign: ?campaign=<id>), each with
 *    «Revisar y fusionar» and «No es la misma persona»;
 *  - the review: which record stays, what the other one is, the conflicts
 *    with their choices, the effects per campaign and the warnings; it is
 *    recomputed by the server (preview, read only) on every change;
 *  - «Fusionar» opens an in-page confirmation; «Sí, fusionar» applies with
 *    the fingerprint of the preview on screen, so a stale preview is refused
 *    (409) and recomputed instead of applied;
 *  - the history at the bottom, with «Deshacer»: when things changed since,
 *    the server lists them and the ADMIN is asked again before forcing; the
 *    forced undo carries the hash of the list shown, so the server overwrites
 *    exactly that (anything newer is listed and asked about again).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { GitMerge, Loader2, RefreshCw, X } from 'lucide-react'
import { useI18n } from '@/i18n/context'
import { Button } from '@/components/ui/button'
import type { MergeApplyResult, MergeCandidate, MergeChoice, MergeChoices, MergeMode, MergePreview } from '@/lib/person-merge'
import {
  canMerge,
  fill,
  initialSelection,
  keepUnchangedChoices,
  loadMergeScreen,
  mergeScreenHref,
  modeFor,
  otherOf,
  requestApply,
  requestDismiss,
  requestPreview,
  requestUndo,
  withChoice,
  type LoadOutcome,
  type MergeScreenData,
  type MergeSelection,
} from './merge-api'
import { CandidateCard, HistoryList, MergeResultPanel, ReviewPanel, type ReviewStep, type UndoView } from './merge-views'

interface ReviewState extends MergeSelection {
  key: string
  candidate: MergeCandidate
  choices: MergeChoices
  preview: MergePreview | null
  loading: boolean
  error: string | null
  notice: string | null
  step: ReviewStep
}

type LoadState = 'loading' | 'ready' | 'error'

export function PersonMergeScreen({ campaignId }: { campaignId: string | null }) {
  const { t, locale } = useI18n()
  const texts = t.personMerge

  const [state, setState] = useState<LoadState>('loading')
  const [data, setData] = useState<MergeScreenData | null>(null)
  // The last load failed: the server's sentence, or '' for ours (texts.loadError)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [review, setReview] = useState<ReviewState | null>(null)
  const [lastResult, setLastResult] = useState<MergeApplyResult | null>(null)
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [cardError, setCardError] = useState<{ key: string; text: string } | null>(null)
  const [undo, setUndo] = useState<Record<string, UndoView>>({})

  const alive = useRef(true)
  // Only the answer to the LAST preview asked is used
  const previewSeq = useRef(0)
  // One write at a time from this screen (merge, dismiss, undo)
  const writing = useRef(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const applyLoad = useCallback((out: LoadOutcome) => {
    if (out.ok) {
      setData(out.data)
      setState('ready')
      setLoadError(null)
      return
    }
    // A failed refresh keeps the list on screen (with a warning); a failed first load says why
    setLoadError(out.error ?? '')
    setState(prev => (prev === 'ready' ? 'ready' : 'error'))
  }, [])

  // First load. The page mounts this screen once per campaign filter (key)
  useEffect(() => {
    let cancelled = false
    void loadMergeScreen(campaignId).then(out => {
      if (!cancelled) applyLoad(out)
    })
    return () => {
      cancelled = true
    }
  }, [campaignId, applyLoad])

  async function reload() {
    setRefreshing(true)
    const out = await loadMergeScreen(campaignId)
    if (!alive.current) return
    setRefreshing(false)
    applyLoad(out)
  }

  /** «Actualizar»: the history is read again, and the undo questions and refusals on screen are of before */
  function refreshAll() {
    setUndo(u => {
      const next: Record<string, UndoView> = {}
      for (const [id, view] of Object.entries(u)) if (view.status === 'sending' || view.status === 'done') next[id] = view
      return next
    })
    void reload()
  }

  function startWrite(): boolean {
    if (writing.current) return false
    writing.current = true
    setBusy(true)
    return true
  }
  function endWrite() {
    writing.current = false
    setBusy(false)
  }

  // ---------------------------------------------------------------- preview

  async function runPreview(next: MergeSelection & { choices: MergeChoices }, notice: string | null = null) {
    const seq = ++previewSeq.current
    setReview(r => (r ? { ...r, ...next, loading: true, error: null, notice } : r))
    const out = await requestPreview(next)
    if (!alive.current || seq !== previewSeq.current) return
    setReview(r => {
      if (!r) return r
      if (out.ok) return { ...r, preview: out.data, loading: false }
      return {
        ...r,
        loading: false,
        preview: null,
        error: out.kind === 'refused' && out.error ? out.error : texts.previewError,
      }
    })
  }

  function openReview(candidate: MergeCandidate) {
    if (busy) return
    const selection = initialSelection(candidate)
    setCardError(null)
    setLastResult(null)
    setReview({ key: candidate.key, candidate, ...selection, choices: {}, preview: null, loading: true, error: null, notice: null, step: 'review' })
    void runPreview({ ...selection, choices: {} })
  }

  function closeReview() {
    if (review?.step === 'applying') return
    previewSeq.current++
    setReview(null)
  }

  function changeKeep(keepId: string) {
    if (!review || review.step !== 'review' || keepId === review.keepId) return
    // Which row survives may change with it: the choices start again. The mode
    // goes back to the suggested one for the suggested record, and to «link»
    // (nothing stops being read) for the other one: never «absorb» carried over
    // to the record the finder thinks is the real account
    void runPreview({ keepId, otherId: otherOf(review.candidate, keepId), mode: modeFor(review.candidate, keepId), choices: {} })
  }

  function changeMode(mode: MergeMode) {
    if (!review || review.step !== 'review' || mode === review.mode) return
    void runPreview({ keepId: review.keepId, otherId: review.otherId, mode, choices: review.choices })
  }

  function changeChoice(campaignId: string, group: string, choice: MergeChoice) {
    if (!review || review.step !== 'review') return
    // Shown at once (runPreview stores the choices), confirmed by the server's new preview
    const choices = withChoice(review.choices, campaignId, group, choice)
    void runPreview({ keepId: review.keepId, otherId: review.otherId, mode: review.mode, choices })
  }

  // ------------------------------------------------------------------ merge

  function askConfirm() {
    if (!review || !canMerge(review.preview, review, review.loading)) return
    setReview({ ...review, step: 'confirm', error: null, notice: null })
  }

  async function confirmMerge() {
    const r = review
    if (!r || r.step !== 'confirm' || !r.preview || !canMerge(r.preview, r, r.loading)) return
    if (!startWrite()) return
    setReview({ ...r, step: 'applying', error: null })
    const out = await requestApply({ keepId: r.keepId, otherId: r.otherId, mode: r.mode, choices: r.choices, fingerprint: r.preview.fingerprint })
    endWrite()
    if (!alive.current) return
    if (out.ok) {
      setLastResult(out.data)
      setReview(null)
      void reload()
      return
    }
    if (out.kind === 'no_answer') {
      // Nobody knows whether it was applied: the list and the history say it
      setReview(null)
      setFlash({ tone: 'warn', text: texts.applyNoAnswer })
      void reload()
      return
    }
    if (out.code === 'stale' || out.code === 'needs_choice') {
      // Recomputed with the data of now: the ADMIN reviews it again before
      // merging, and a choice made on values that changed is asked again
      setReview(cur => (cur ? { ...cur, step: 'review', loading: true } : cur))
      const selection = { keepId: r.keepId, otherId: r.otherId, mode: r.mode }
      const now = await requestPreview({ ...selection, choices: {} })
      if (!alive.current) return
      const choices = now.ok ? keepUnchangedChoices(r.choices, r.preview, now.data) : {}
      void runPreview({ ...selection, choices }, out.error ?? texts.recalculated)
      return
    }
    setReview(cur => (cur ? { ...cur, step: 'review', error: out.error ?? texts.applyError } : cur))
  }

  // ---------------------------------------------------------------- dismiss

  async function dismiss(candidate: MergeCandidate) {
    if (!startWrite()) return
    setDismissing(candidate.key)
    setCardError(null)
    const out = await requestDismiss(candidate.profiles[0].id, candidate.profiles[1].id)
    endWrite()
    if (!alive.current) return
    setDismissing(null)
    if (out.ok) {
      if (review?.key === candidate.key) setReview(null)
      setFlash({ tone: 'ok', text: texts.dismissed })
      void reload()
      return
    }
    setCardError({ key: candidate.key, text: out.kind === 'refused' && out.error ? out.error : texts.dismissError })
    if (out.kind === 'no_answer') void reload()
  }

  // ------------------------------------------------------------------- undo

  async function runUndo(logId: string, force: boolean) {
    // Forcing overwrites exactly the list on screen: its hash goes with it
    const shown = undo[logId]?.differencesHash ?? null
    if (force && !shown) return
    if (!startWrite()) return
    setUndo(u => ({ ...u, [logId]: { ...(u[logId] ?? {}), status: 'sending', forcing: force } }))
    const out = await requestUndo(logId, force && shown ? { differencesHash: shown } : null)
    endWrite()
    if (!alive.current) return
    if (out.ok) {
      setUndo(u => ({ ...u, [logId]: { status: 'done', result: out.data } }))
      void reload()
      return
    }
    if (out.kind === 'no_answer') {
      setUndo(u => ({ ...u, [logId]: { status: 'error', message: texts.undoNoAnswer } }))
      void reload()
      return
    }
    if (out.code === 'changed_since') {
      // Asked (again, when something changed after the list was shown) with the list of now
      setUndo(u => ({ ...u, [logId]: { status: 'ask_force', message: out.error, differences: out.differences, differencesHash: out.differencesHash, changedAgain: force } }))
      return
    }
    if (out.code === 'cannot_undo') {
      setUndo(u => ({ ...u, [logId]: { status: 'blocked', message: out.error, differences: out.differences } }))
      return
    }
    setUndo(u => ({ ...u, [logId]: { status: 'error', message: out.error ?? texts.undoError } }))
  }

  function cancelUndo(logId: string) {
    setUndo(u => {
      const next = { ...u }
      delete next[logId]
      return next
    })
  }

  // ----------------------------------------------------------------- render

  const candidates = data?.candidates ?? []
  const campaign = data?.campaign ?? null

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <GitMerge className="h-5 w-5 text-purple-600 dark:text-purple-400" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{texts.title}</h1>
            <span className="rounded-full border border-gray-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">{texts.adminOnly}</span>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">{texts.intro}</p>
          {campaign && (
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-gray-900 dark:text-gray-100">{fill(texts.campaignFilter, { name: campaign.name })}</span>
              <Link href={mergeScreenHref(null)} className="text-purple-700 hover:underline dark:text-purple-300">{texts.allCampaigns}</Link>
            </p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={refreshAll} disabled={refreshing || state === 'loading' || review?.step === 'applying'}>
          <RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" />
          {texts.refresh}
        </Button>
      </header>

      {flash && (
        <div
          role="status"
          className={flash.tone === 'ok'
            ? 'flex items-start justify-between gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300'
            : 'flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200'}
        >
          <span>{flash.text}</span>
          <button type="button" onClick={() => setFlash(null)} aria-label={texts.close} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {lastResult && <MergeResultPanel result={lastResult} texts={texts} locale={locale} onClose={() => setLastResult(null)} />}

      {state === 'loading' && (
        <p className="flex items-center gap-2 py-10 text-sm text-gray-500 dark:text-gray-400" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {texts.loading}
        </p>
      )}

      {state === 'error' && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          <p>{loadError || texts.loadError}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setState('loading'); void reload() }}>{texts.retry}</Button>
            {campaignId && <Button as="a" href={mergeScreenHref(null)} size="sm" variant="ghost">{texts.allCampaigns}</Button>}
          </div>
        </div>
      )}

      {state === 'ready' && data && (
        <>
          {loadError !== null && (
            <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{loadError || texts.loadError}</p>
          )}

          <section aria-label={texts.title} className="space-y-4">
            {candidates.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {campaignId ? texts.emptyCampaign : texts.emptyAll}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {candidates.length === 1 ? texts.countOne : fill(texts.countMany, { n: candidates.length })}
                </p>
                {candidates.map(c => {
                  const open = review?.key === c.key ? review : null
                  return (
                    <CandidateCard
                      key={c.key}
                      candidate={c}
                      texts={texts}
                      locale={locale}
                      reviewing={!!open}
                      dismissing={dismissing === c.key}
                      busy={busy}
                      error={cardError?.key === c.key ? cardError.text : null}
                      onReview={() => openReview(c)}
                      onDismiss={() => void dismiss(c)}
                    >
                      {open && (
                        <ReviewPanel
                          candidate={c}
                          selection={{ keepId: open.keepId, otherId: open.otherId, mode: open.mode }}
                          choices={open.choices}
                          preview={open.preview}
                          loading={open.loading}
                          error={open.error}
                          notice={open.notice}
                          step={open.step}
                          texts={texts}
                          locale={locale}
                          onKeep={changeKeep}
                          onMode={changeMode}
                          onChoice={changeChoice}
                          onMerge={askConfirm}
                          onConfirm={() => void confirmMerge()}
                          onBack={() => setReview(r => (r && r.step === 'confirm' ? { ...r, step: 'review' } : r))}
                          onCancel={closeReview}
                        />
                      )}
                    </CandidateCard>
                  )
                })}
              </>
            )}
          </section>

          <section aria-labelledby="merge-history" className="space-y-3 pt-2">
            <h2 id="merge-history" className="text-lg font-semibold text-gray-900 dark:text-gray-100">{texts.historyTitle}</h2>
            <HistoryList
              entries={data.history}
              undo={undo}
              busy={busy}
              texts={texts}
              locale={locale}
              onUndo={(id) => void runUndo(id, false)}
              onForce={(id) => void runUndo(id, true)}
              onCancelUndo={cancelUndo}
            />
          </section>
        </>
      )}
    </div>
  )
}
