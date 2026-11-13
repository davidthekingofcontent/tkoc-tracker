/**
 * What the screen «Fichas duplicadas» (/creators/duplicadas) and the notice of
 * the campaign page expect from /api/admin/person-merge, in one place. Plain
 * module (no React, no 'use client'): the contract between the screen and the
 * route, testable without a browser. The route itself (ADMIN only, checked on
 * the server) is src/app/api/admin/person-merge/route.ts; the shapes are the
 * ones of src/lib/person-merge.ts, imported as TYPES only (that module imports
 * Prisma and must never be bundled into the browser).
 *
 *   GET  ?campaignId=                 200 { campaign, candidates, history }; 404 unknown campaign
 *   GET  ?campaignId=&countOnly=1     200 { count }
 *   POST { action: 'preview', … }     200 { preview }
 *   POST { action: 'apply', … }       200 { result }
 *   POST { action: 'undo', … }        200 { undone }
 *   POST { action: 'dismiss', … }     200 { dismissed }
 *   Errors: { error (Spanish), code, missingChoices? | differences? + differencesHash? }
 *
 * Every answer is read defensively. "No answer" (the connection dropped, or a
 * gateway answered instead of the server) is kept apart from a refusal: after
 * an apply or an undo without an answer nobody knows whether it happened, so
 * the screen says so instead of guessing.
 */
import type { Locale, TranslationKeys } from '@/i18n/translations'
import type {
  MergeApplyResult,
  MergeCandidate,
  MergeChoice,
  MergeChoices,
  MergeDifference,
  MergeFieldOutcome,
  MergeHistoryEntry,
  MergeMode,
  MergePreview,
  UndoMergeResult,
} from '@/lib/person-merge'
import { formatDate, formatEur, formatInt } from '@/lib/utils'

export const MERGE_ENDPOINT = '/api/admin/person-merge'
/** The screen (ADMIN only). `?campaign=<id>` filters it to one campaign. */
export const MERGE_SCREEN_PATH = '/creators/duplicadas'

export type MergeTexts = TranslationKeys['personMerge']

type Fetch = typeof fetch

/** The screen, optionally filtered to one campaign. */
export function mergeScreenHref(campaignId?: string | null): string {
  return campaignId ? `${MERGE_SCREEN_PATH}?campaign=${encodeURIComponent(campaignId)}` : MERGE_SCREEN_PATH
}

/**
 * The profile page of a record: its account on its network. There is no page
 * of an Influencer record inside the platform (/creators/[id] is a creator of
 * the discovery base, another id space), and the network is where the ADMIN
 * sees whether a handle is a real account or a wrong one.
 */
export function profileHref(p: { username: string; platform: string }): string {
  const handle = encodeURIComponent(String(p.username ?? '').trim().replace(/^@+/, ''))
  switch (String(p.platform ?? '').toUpperCase()) {
    case 'TIKTOK':
      return `https://www.tiktok.com/@${handle}`
    case 'YOUTUBE':
      return `https://www.youtube.com/@${handle}`
    default:
      return `https://www.instagram.com/${handle}/`
  }
}

/** Fills every `{placeholder}`; the replacement is a function, so `$&` in a handle stays literal. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole)
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

// ===========================================================================
// Loading the screen and the notice
// ===========================================================================

export interface MergeScreenData {
  /** The campaign of the filter, or null without one */
  campaign: { id: string; name: string } | null
  candidates: MergeCandidate[]
  history: MergeHistoryEntry[]
}

export type LoadOutcome =
  | { ok: true; data: MergeScreenData }
  /** status null = no answer; error = the server's own sentence when it sent one */
  | { ok: false; status: number | null; error: string | null }

/** The candidates (of one campaign, or all) and the last 50 merges and dismissals. */
export async function loadMergeScreen(campaignId: string | null, fetchImpl: Fetch = fetch): Promise<LoadOutcome> {
  const url = campaignId ? `${MERGE_ENDPOINT}?campaignId=${encodeURIComponent(campaignId)}` : MERGE_ENDPOINT
  let res: Response
  try {
    res = await fetchImpl(url, { cache: 'no-store' })
  } catch {
    return { ok: false, status: null, error: null }
  }
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) return { ok: false, status: res.status, error: isRecord(data) ? text(data.error) : null }
  if (!isRecord(data) || !Array.isArray(data.candidates) || !Array.isArray(data.history)) {
    return { ok: false, status: res.status, error: null }
  }
  const campaign = isRecord(data.campaign) && text(data.campaign.id) && typeof data.campaign.name === 'string'
    ? { id: String(data.campaign.id), name: String(data.campaign.name) }
    : null
  return {
    ok: true,
    data: {
      campaign,
      candidates: (data.candidates as unknown[]).filter(isCandidate),
      history: (data.history as unknown[]).filter((h): h is MergeHistoryEntry => isRecord(h) && !!text(h.logId) && typeof h.summary === 'string'),
    },
  }
}

/** A candidate the screen can draw: a key and two profiles with ids. */
function isCandidate(c: unknown): c is MergeCandidate {
  if (!isRecord(c) || !text(c.key) || !Array.isArray(c.profiles) || c.profiles.length !== 2) return false
  return c.profiles.every(p => isRecord(p) && !!text(p.id) && typeof p.username === 'string')
}

/** «Cuenta doble» candidates of one campaign (the notice of the campaign page); null when unknown (not an ADMIN, no answer). */
export async function loadDuplicateCount(campaignId: string, fetchImpl: Fetch = fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(`${MERGE_ENDPOINT}?campaignId=${encodeURIComponent(campaignId)}&countOnly=1`, { cache: 'no-store' })
    if (!res.ok) return null
    const data: unknown = await res.json()
    return isRecord(data) && typeof data.count === 'number' && Number.isFinite(data.count) && data.count >= 0 ? data.count : null
  } catch {
    return null
  }
}

// ===========================================================================
// Actions
// ===========================================================================

export type ActionOutcome<T> =
  | { ok: true; data: T }
  /** The server answered and refused (or failed and said nothing changed): its own sentence */
  | {
      ok: false
      kind: 'refused'
      status: number
      code: string | null
      error: string | null
      missingChoices: Array<{ campaignId: string; group: string; label: string }>
      differences: MergeDifference[]
      /** changed_since: what a forced undo must send back (it overwrites only these differences) */
      differencesHash: string | null
    }
  /** No answer from the server: it may or may not have happened */
  | { ok: false; kind: 'no_answer' }

async function postAction<T>(body: Record<string, unknown>, key: string, fetchImpl: Fetch): Promise<ActionOutcome<T>> {
  let res: Response
  try {
    res = await fetchImpl(MERGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    return { ok: false, kind: 'no_answer' }
  }
  const data: unknown = await res.json().catch(() => null)
  if (res.ok) {
    // A 200 without the expected object is not a confirmation of anything
    return isRecord(data) && isRecord(data[key]) ? { ok: true, data: data[key] as T } : { ok: false, kind: 'no_answer' }
  }
  // A gateway (502-504 during a deploy) or anything that is not the route's JSON: nothing is known
  if (!isRecord(data) || (res.status >= 502 && res.status <= 504)) return { ok: false, kind: 'no_answer' }
  return {
    ok: false,
    kind: 'refused',
    status: res.status,
    code: text(data.code),
    error: text(data.error),
    missingChoices: Array.isArray(data.missingChoices)
      ? (data.missingChoices as unknown[]).filter((m): m is { campaignId: string; group: string; label: string } =>
          isRecord(m) && typeof m.campaignId === 'string' && typeof m.group === 'string' && typeof m.label === 'string')
      : [],
    differences: Array.isArray(data.differences)
      ? (data.differences as unknown[]).filter((d): d is MergeDifference => isRecord(d) && typeof d.text === 'string')
      : [],
    differencesHash: text(data.differencesHash),
  }
}

export interface MergeSelection {
  keepId: string
  otherId: string
  mode: MergeMode
}

/** What merging would do (changes nothing). */
export function requestPreview(input: MergeSelection & { choices: MergeChoices }, fetchImpl: Fetch = fetch) {
  return postAction<MergePreview>({ action: 'preview', ...input }, 'preview', fetchImpl)
}

/** Apply exactly what the preview showed: its fingerprint goes back unchanged. */
export function requestApply(input: MergeSelection & { choices: MergeChoices; fingerprint: string }, fetchImpl: Fetch = fetch) {
  return postAction<MergeApplyResult>({ action: 'apply', ...input }, 'result', fetchImpl)
}

/**
 * Undo a merge or a dismissal. `force` only after the ADMIN saw the
 * differences and asked again: it carries the hash of the list shown, so the
 * server overwrites exactly that list (anything newer is asked about again).
 */
export function requestUndo(logId: string, force: { differencesHash: string } | null, fetchImpl: Fetch = fetch) {
  return postAction<UndoMergeResult>(
    force ? { action: 'undo', logId, force: true, differencesHash: force.differencesHash } : { action: 'undo', logId },
    'undone',
    fetchImpl
  )
}

/** «No es la misma persona»: the pair is not proposed again (undoable from the history). */
export function requestDismiss(aId: string, bId: string, fetchImpl: Fetch = fetch) {
  return postAction<{ logId: string; alreadyDismissed: boolean }>({ action: 'dismiss', aId, bId }, 'dismissed', fetchImpl)
}

// ===========================================================================
// Pure decisions of the screen
// ===========================================================================

/** The review starts with the suggestion: which record stays and what the other one is. */
export function initialSelection(c: MergeCandidate): MergeSelection {
  const ids = c.profiles.map(p => p.id)
  const keepId = ids.includes(c.suggestion?.keepId) ? c.suggestion.keepId : ids[0]
  return { keepId, otherId: otherOf(c, keepId), mode: modeFor(c, keepId) }
}

/**
 * What the other record is when `keepId` stays: the suggested mode only when
 * that is the suggested record; otherwise «link», the mode that stops reading
 * nothing (absorbing the record the finder thinks is the real account would
 * fold her rows into the wrong handle and stop reading her).
 */
export function modeFor(c: MergeCandidate, keepId: string): MergeMode {
  return keepId === c.suggestion?.keepId && c.suggestion?.mode === 'absorb' ? 'absorb' : 'link'
}

/** The suggestion applies to what is selected: its record stays (the «sugerida» tags). */
export function isSuggestedKeep(c: MergeCandidate, keepId: string): boolean {
  return !!c.suggestion && keepId === c.suggestion.keepId
}

/** The profile of the pair that is not `keepId`. */
export function otherOf(c: MergeCandidate, keepId: string): string {
  return c.profiles[0].id === keepId ? c.profiles[1].id : c.profiles[0].id
}

/** The choices with one more (immutable). */
export function withChoice(choices: MergeChoices, campaignId: string, group: string, choice: MergeChoice): MergeChoices {
  return { ...choices, [campaignId]: { ...(choices[campaignId] ?? {}), [group]: choice } }
}

/**
 * After a refused apply (stale data, a choice missing) the review is computed
 * again with the data of now. A choice survives only where the field it was
 * made for is still the same: the same row stays and both values are what the
 * ADMIN saw. Any other choice is dropped, so a money field whose values
 * changed asks again instead of applying a decision made on other figures.
 * `fresh` is the new preview (its values do not depend on the choices).
 */
export function keepUnchangedChoices(choices: MergeChoices, seen: MergePreview | null, fresh: MergePreview): MergeChoices {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const out: MergeChoices = {}
  for (const [campaignId, perField] of Object.entries(choices)) {
    const before = seen?.campaigns.find(c => c.campaignId === campaignId)
    const now = fresh.campaigns.find(c => c.campaignId === campaignId)
    if (!before || !now || before.survivor?.membershipId !== now.survivor?.membershipId || before.otherMembershipId !== now.otherMembershipId) continue
    for (const [group, choice] of Object.entries(perField ?? {})) {
      if (!choice) continue
      const was = before.fields.find(f => f.group === group)
      const is = now.fields.find(f => f.group === group)
      if (!was || !is || !same(was.survivorValue, is.survivorValue) || !same(was.otherValue, is.otherValue)) continue
      out[campaignId] = { ...(out[campaignId] ?? {}), [group]: choice }
    }
  }
  return out
}

/** The option in force for a field: what the ADMIN picked here, else what the server applies (its default). */
export function chosenFor(choices: MergeChoices, campaignId: string, field: Pick<MergeFieldOutcome, 'group' | 'chosen'>): MergeChoice | null {
  return choices[campaignId]?.[field.group] ?? field.chosen ?? null
}

/**
 * «Fusionar» is offered only on a fresh preview of exactly what is selected,
 * that the server says can be applied (no choice missing, something to do).
 */
export function canMerge(preview: MergePreview | null, selection: MergeSelection, loading: boolean): boolean {
  if (!preview || loading) return false
  if (preview.keep?.id !== selection.keepId || preview.other?.id !== selection.otherId || preview.mode !== selection.mode) return false
  return preview.canApply === true && preview.nothingToDo !== true && typeof preview.fingerprint === 'string' && preview.fingerprint.length > 0
}

// ===========================================================================
// How values are written
// ===========================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function clip(value: string, max = 140): string {
  const s = value.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function scalarText(value: unknown, texts: MergeTexts, locale: Locale): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value ? texts.yes : texts.no
  if (typeof value === 'number') return Number.isFinite(value) ? formatInt(value, { locale }) : null
  if (typeof value === 'string') return ISO_DATE.test(value) ? formatDate(value, { locale }) : clip(value)
  return null
}

/** «Calle Falsa 1, Madrid, 28001»: the filled values of a group of columns. */
function columnsText(value: Record<string, unknown>, texts: MergeTexts, locale: Locale): string {
  const parts = Object.values(value).map(v => scalarText(v, texts, locale)).filter((v): v is string => !!v)
  return parts.length > 0 ? parts.join(', ') : '—'
}

/** A value of a field of the membership row, as the ADMIN reads it. '—' when empty. */
export function fieldValueText(field: Pick<MergeFieldOutcome, 'group' | 'kind'>, value: unknown, texts: MergeTexts, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  switch (field.kind) {
    case 'money':
      return typeof value === 'number' ? formatEur(value, { locale, maxFractionDigits: 2 }) : '—'
    case 'count':
      return typeof value === 'number' ? formatInt(value, { locale }) : '—'
    case 'boolean':
      return value === true ? texts.yes : texts.no
    case 'status':
      return (texts.status as Record<string, string>)[String(value)] ?? String(value)
    case 'notes':
      return clip(String(value))
    default:
      break
  }
  if (isRecord(value)) {
    if (field.group === 'createdAt') {
      const date = typeof value.createdAt === 'string' ? formatDate(value.createdAt, { locale }) : '—'
      return text(value.addedByName) ? `${date} · ${String(value.addedByName)}` : date
    }
    if (field.group === 'baseline') {
      if (typeof value.baselineAt === 'string') return fill(texts.valueSince, { date: formatDate(value.baselineAt, { locale }) })
      return value.baselineSnapshot ? texts.valueSet : '—'
    }
    if (field.group === 'tracked') {
      const parts = [
        text(value.trackedLink),
        typeof value.trackedClicks === 'number' ? fill(texts.valueClicks, { n: formatInt(value.trackedClicks, { locale }) }) : null,
      ].filter((v): v is string => !!v)
      return parts.length > 0 ? parts.join(' · ') : '—'
    }
    return columnsText(value, texts, locale)
  }
  return scalarText(value, texts, locale) ?? '—'
}

/** The value of «Sumarlos» (money and deliverables): both sides added up. */
export function addedValue(field: Pick<MergeFieldOutcome, 'survivorValue' | 'otherValue' | 'kind'>): number {
  const sum = (Number(field.survivorValue) || 0) + (Number(field.otherValue) || 0)
  return field.kind === 'money' ? Math.round(sum * 100) / 100 : sum
}

/** «12.700 seguidores» / «1 seguidor». */
export function followersText(n: number, texts: MergeTexts, locale: Locale): string {
  return n === 1 ? texts.followersOne : fill(texts.followers, { n: formatInt(n, { locale }) })
}

/** «3 publicaciones» / «1 publicación». */
export function piecesText(n: number, texts: MergeTexts, locale: Locale): string {
  return n === 1 ? texts.piecesOne : fill(texts.pieces, { n: formatInt(n, { locale }) })
}

const NETWORK: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

/** «Instagram» for INSTAGRAM; the raw value for anything unknown. */
export function networkName(platform: string | null | undefined): string {
  return NETWORK[String(platform ?? '').toUpperCase()] ?? String(platform ?? '')
}

/** «@vane (TikTok)» */
export function profileLabel(p: { username: string; platform: string }): string {
  return `@${p.username} (${networkName(p.platform)})`
}

/** Money of the effects table: «3.600 €». */
export function moneyText(value: number | null | undefined, locale: Locale): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatEur(value, { locale, maxFractionDigits: 2 }) : '—'
}
