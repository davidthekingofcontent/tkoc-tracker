/**
 * Editable campaign report (David 2026-09-05, decision 16A + "hide data").
 *
 * The PM can retitle the report, add an intro and conclusions, hide whole
 * sections, individual columns, specific media rows and creators from the
 * client-facing report, and record every time the report was sent. All of
 * that lives in ONE Setting row per campaign:
 *
 *   Setting key = `campaign_report_{campaignId}`, value = JSON ReportConfig
 *
 * Product principle: a datum that is not filled in is not shown anywhere —
 * every field here is optional and the defaults render exactly the report
 * we had before this feature existed.
 *
 * Server-only module (imports Prisma). Client components must import ONLY
 * types from here (`import type { ReportConfig } ...`).
 */

import { prisma } from '@/lib/db'
import type { DeliveryChecklist } from '@/lib/metrics'

// ---------------------------------------------------------------------------
// Ids the report understands
// ---------------------------------------------------------------------------

/** Sections of the report that can be hidden from the client. */
export const REPORT_SECTION_IDS = [
  'summary',
  /** Body: "Contenidos destacados" (the 6 pieces with most real audience). */
  'content',
  'creators',
  /** "Qué dijo la audiencia": highlighted comments chosen by the PM (+ real sentiment share when ≥ 20 analysed). */
  'sentiment',
  'quality',
  'business',
  /** "Aprendizajes y próximos pasos" (learnings built server-side). */
  'learnings',
  /** Editable "Decisiones acordadas" text (rendered inside learnings when present). */
  'conclusions',
  /** Final "Anexo · Todos los contenidos" (one compact line per piece). */
  'annex',
] as const
export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number]

/** Table columns / summary cards that can be hidden from the client. */
export const REPORT_COLUMN_IDS = [
  'content.views',
  'content.reach',
  'content.source',
  'creators.followers',
  /** "Vistas" per creator (overview.perInfluencer[].views), right before Interacciones. */
  'creators.views',
  'creators.er',
  'creators.cpm',
  'creators.posts',
  'summary.reach',
  'summary.views',
  'summary.engagement',
  'summary.er',
] as const
export type ReportColumnId = (typeof REPORT_COLUMN_IDS)[number]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportSentVersion {
  /** 1, 2, 3… incremented on every "Marcar como enviado" */
  version: number
  /** ISO timestamp */
  sentAt: string
  /** Who marked it as sent (name or email of the staff user) */
  sentBy: string
  note?: string
}

/** Tone of a highlighted comment, chosen by the PM. */
export const REPORT_COMMENT_SENTIMENTS = ['positive', 'neutral', 'negative'] as const
export type ReportCommentSentiment = (typeof REPORT_COMMENT_SENTIMENTS)[number]

/**
 * A comment the PM quotes in the "Qué dijo la audiencia" section. Captured
 * comments (Comment rows) are empty in production, so the section is fed by
 * hand: the PM pastes the text and the author handle and sets the tone.
 */
export interface HighlightedComment {
  id: string
  text: string
  author: string
  sentiment: ReportCommentSentiment
  /** Optional link to the publication the comment belongs to. */
  mediaId?: string | null
}

// --- "Prometido vs entregado" (David 2026-09-08: the PM must be able to complete it) ---

/** The four rows the system computes from overview.delivery. */
export const DELIVERY_ROW_KEYS = ['creators', 'pieces', 'dates', 'disclosure'] as const
export type DeliveryRowKey = (typeof DELIVERY_ROW_KEYS)[number]

/**
 * Manual override of ONE computed row. A field left null/undefined keeps the
 * computed value; a set field replaces it (planned/delivered → the numbers,
 * ok → Cumplido / En revisión, note → the row's sub-line).
 */
export interface DeliveryOverride {
  planned?: number | null
  delivered?: number | null
  ok?: boolean | null
  note?: string | null
}

/** A promise the PM adds by hand (e.g. "Exclusividad" · "12 meses" · Cumplido). */
export interface DeliveryExtraRow {
  id: string
  label: string
  /** Free short text such as "12 meses" or "Sí". */
  value?: string | null
  ok: boolean
}

export interface ReportDeliveryConfig {
  overrides: Partial<Record<DeliveryRowKey, DeliveryOverride>>
  extraRows: DeliveryExtraRow[]
}

export interface ReportConfig {
  /** Overrides the campaign name on the cover and the running header */
  title?: string
  /** Overrides "Informe de resultados" on the cover / header */
  subtitle?: string
  /** Free text rendered under the "Resumen ejecutivo" heading */
  intro?: string
  /** Free text rendered as the final "Conclusiones y próximos pasos" section */
  conclusions?: string
  hiddenSections: string[]
  hiddenColumns: string[]
  hiddenMediaIds: string[]
  hiddenInfluencerIds: string[]
  /** "Qué dijo la audiencia": up to REPORT_HIGHLIGHTED_MAX quoted comments. */
  highlightedComments: HighlightedComment[]
  /**
   * "Prometido vs entregado" edits by the PM. Always present after
   * normalisation (configs saved before this field load with the default).
   * The client (portal, print, PDF) only ever sees rows with ok === true.
   */
  delivery: ReportDeliveryConfig
  sentVersions: ReportSentVersion[]
  updatedAt?: string
  updatedBy?: string
}

/** The fields a PUT may change (everything except the audit trail). */
export type ReportConfigPatch = Partial<
  Pick<
    ReportConfig,
    | 'title'
    | 'subtitle'
    | 'intro'
    | 'conclusions'
    | 'hiddenSections'
    | 'hiddenColumns'
    | 'hiddenMediaIds'
    | 'hiddenInfluencerIds'
    | 'highlightedComments'
    | 'delivery'
  >
>

/** Limits enforced by the API (and re-checked here so nothing bypasses them). */
export const REPORT_TEXT_MAX = 2000
export const REPORT_LIST_MAX = 200
/** Ids are cuids (25 chars); allow slack for usernames used as fallback keys. */
export const REPORT_ID_MAX = 200
/** Highlighted comments: at most 12, text ≤ 300 chars, author ≤ 80 chars. */
export const REPORT_HIGHLIGHTED_MAX = 12
export const REPORT_COMMENT_TEXT_MAX = 300
export const REPORT_COMMENT_AUTHOR_MAX = 80
/** "Prometido vs entregado": ≤ 4 extra rows; label ≤ 80, value ≤ 40, note ≤ 120 chars; counts 0–1,000,000. */
export const REPORT_DELIVERY_EXTRA_MAX = 4
export const REPORT_DELIVERY_LABEL_MAX = 80
export const REPORT_DELIVERY_VALUE_MAX = 40
export const REPORT_DELIVERY_NOTE_MAX = 120
export const REPORT_DELIVERY_COUNT_MAX = 1_000_000

/** Fresh default delivery config (a new object every time: it is mutated by spreads). */
export function defaultReportDelivery(): ReportDeliveryConfig {
  return { overrides: {}, extraRows: [] }
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  hiddenSections: [],
  hiddenColumns: [],
  hiddenMediaIds: [],
  hiddenInfluencerIds: [],
  highlightedComments: [],
  delivery: { overrides: {}, extraRows: [] },
  sentVersions: [],
}

/** A fresh copy of the defaults (no shared nested objects). */
function freshDefaultReportConfig(): ReportConfig {
  return { ...DEFAULT_REPORT_CONFIG, delivery: defaultReportDelivery() }
}

export function reportConfigKey(campaignId: string): string {
  return `campaign_report_${campaignId}`
}

// ---------------------------------------------------------------------------
// Normalisation helpers (pure)
// ---------------------------------------------------------------------------

function cleanText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  return s.length > REPORT_TEXT_MAX ? s.slice(0, REPORT_TEXT_MAX) : s
}

/** Array of trimmed, de-duplicated, non-empty strings, capped in size. */
function cleanStringList(v: unknown, allowed?: readonly string[]): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (!s || s.length > REPORT_ID_MAX || seen.has(s)) continue
    if (allowed && !allowed.includes(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= REPORT_LIST_MAX) break
  }
  return out
}

/**
 * Highlighted comments: trimmed, capped (12 × 300 chars), tone restricted to
 * the three known values, ids de-duplicated (a missing id gets a stable one
 * derived from its position so the client can key and edit the row).
 */
function cleanHighlightedComments(v: unknown): HighlightedComment[] {
  if (!Array.isArray(v)) return []
  const out: HighlightedComment[] = []
  const seen = new Set<string>()
  v.forEach((item, index) => {
    if (out.length >= REPORT_HIGHLIGHTED_MAX) return
    if (!item || typeof item !== 'object') return
    const r = item as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.trim().slice(0, REPORT_COMMENT_TEXT_MAX) : ''
    if (!text) return
    const authorRaw = typeof r.author === 'string' ? r.author.trim().replace(/^@+/, '') : ''
    const author = authorRaw.slice(0, REPORT_COMMENT_AUTHOR_MAX)
    const sentiment: ReportCommentSentiment =
      typeof r.sentiment === 'string' && (REPORT_COMMENT_SENTIMENTS as readonly string[]).includes(r.sentiment)
        ? (r.sentiment as ReportCommentSentiment)
        : 'neutral'
    let id = typeof r.id === 'string' && r.id.trim() && r.id.length <= REPORT_ID_MAX ? r.id.trim() : `c${index + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    const entry: HighlightedComment = { id, text, author, sentiment }
    if (typeof r.mediaId === 'string' && r.mediaId.trim() && r.mediaId.length <= REPORT_ID_MAX) entry.mediaId = r.mediaId.trim()
    out.push(entry)
  })
  return out
}

/** Integer 0–REPORT_DELIVERY_COUNT_MAX or undefined (strings, NaN, negatives, huge values are dropped). */
function cleanCount(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.trunc(v)
  if (n < 0 || n > REPORT_DELIVERY_COUNT_MAX) return undefined
  return n
}

/** Trimmed string capped at `max`, or undefined when empty / not a string. */
function cleanShortText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, max) : undefined
}

/**
 * "Prometido vs entregado" edits. Unknown row keys are dropped; an override
 * with nothing set is dropped too (it is the same as "Automático"); counts
 * are integers 0–1,000,000; ok is boolean|null for overrides and boolean for
 * extra rows; extra rows are capped at 4 with non-empty de-duplicated ids and
 * a non-empty label. Never throws: any hostile shape becomes the default.
 */
function cleanDelivery(v: unknown): ReportDeliveryConfig {
  const out = defaultReportDelivery()
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const d = v as Record<string, unknown>

  const overridesRaw = d.overrides
  if (overridesRaw && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw)) {
    const o = overridesRaw as Record<string, unknown>
    for (const key of DELIVERY_ROW_KEYS) {
      const item = o[key]
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const r = item as Record<string, unknown>
      const entry: DeliveryOverride = {}
      const planned = cleanCount(r.planned)
      const delivered = cleanCount(r.delivered)
      const note = cleanShortText(r.note, REPORT_DELIVERY_NOTE_MAX)
      if (planned !== undefined) entry.planned = planned
      if (delivered !== undefined) entry.delivered = delivered
      if (typeof r.ok === 'boolean') entry.ok = r.ok
      if (note) entry.note = note
      if (Object.keys(entry).length > 0) out.overrides[key] = entry
    }
  }

  const rowsRaw = d.extraRows
  if (Array.isArray(rowsRaw)) {
    const seen = new Set<string>()
    rowsRaw.forEach((item, index) => {
      if (out.extraRows.length >= REPORT_DELIVERY_EXTRA_MAX) return
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      const r = item as Record<string, unknown>
      const label = cleanShortText(r.label, REPORT_DELIVERY_LABEL_MAX)
      if (!label) return
      let id = typeof r.id === 'string' && r.id.trim() && r.id.length <= REPORT_ID_MAX ? r.id.trim() : `d${index + 1}`
      while (seen.has(id)) id = `${id}_`
      seen.add(id)
      const row: DeliveryExtraRow = { id, label, ok: r.ok === true }
      const value = cleanShortText(r.value, REPORT_DELIVERY_VALUE_MAX)
      if (value) row.value = value
      out.extraRows.push(row)
    })
  }
  return out
}

function cleanSentVersions(v: unknown): ReportSentVersion[] {
  if (!Array.isArray(v)) return []
  const out: ReportSentVersion[] = []
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const version = Number(r.version)
    if (!Number.isInteger(version) || version <= 0) continue
    if (typeof r.sentAt !== 'string' || typeof r.sentBy !== 'string') continue
    const entry: ReportSentVersion = { version, sentAt: r.sentAt, sentBy: r.sentBy }
    const note = cleanText(r.note)
    if (note) entry.note = note
    out.push(entry)
  }
  return out.sort((a, b) => a.version - b.version)
}

/**
 * Coerce anything (a parsed Setting value, a request body…) into a valid
 * ReportConfig. Unknown section/column ids are dropped; media/creator ids
 * are free strings because they reference rows of other tables.
 */
export function normalizeReportConfig(raw: unknown): ReportConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cfg: ReportConfig = {
    hiddenSections: cleanStringList(r.hiddenSections, REPORT_SECTION_IDS),
    hiddenColumns: cleanStringList(r.hiddenColumns, REPORT_COLUMN_IDS),
    hiddenMediaIds: cleanStringList(r.hiddenMediaIds),
    hiddenInfluencerIds: cleanStringList(r.hiddenInfluencerIds),
    highlightedComments: cleanHighlightedComments(r.highlightedComments),
    // Backwards compatible: configs saved before "delivery" existed load with the default.
    delivery: cleanDelivery(r.delivery),
    sentVersions: cleanSentVersions(r.sentVersions),
  }
  const title = cleanText(r.title)
  const subtitle = cleanText(r.subtitle)
  const intro = cleanText(r.intro)
  const conclusions = cleanText(r.conclusions)
  if (title) cfg.title = title
  if (subtitle) cfg.subtitle = subtitle
  if (intro) cfg.intro = intro
  if (conclusions) cfg.conclusions = conclusions
  if (typeof r.updatedAt === 'string') cfg.updatedAt = r.updatedAt
  if (typeof r.updatedBy === 'string') cfg.updatedBy = r.updatedBy
  return cfg
}

/**
 * Validate a PUT body. Returns an error message (for a 400) or null when
 * the body is acceptable. Only checks the fields that are present.
 */
export function validateReportConfigPatch(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object'
  }
  const b = body as Record<string, unknown>
  for (const field of ['title', 'subtitle', 'intro', 'conclusions'] as const) {
    if (b[field] === undefined || b[field] === null) continue
    if (typeof b[field] !== 'string') return `${field} must be a string`
    if ((b[field] as string).length > REPORT_TEXT_MAX) {
      return `${field} must be at most ${REPORT_TEXT_MAX} characters`
    }
  }
  for (const field of ['hiddenSections', 'hiddenColumns', 'hiddenMediaIds', 'hiddenInfluencerIds'] as const) {
    if (b[field] === undefined) continue
    if (!Array.isArray(b[field])) return `${field} must be an array of strings`
    const arr = b[field] as unknown[]
    if (arr.length > REPORT_LIST_MAX) return `${field} must have at most ${REPORT_LIST_MAX} items`
    if (arr.some(x => typeof x !== 'string' || x.length > REPORT_ID_MAX)) {
      return `${field} must contain only strings of at most ${REPORT_ID_MAX} characters`
    }
  }
  // null clears the section (the route maps it to []), like null on a text field.
  if (b.highlightedComments !== undefined && b.highlightedComments !== null) {
    if (!Array.isArray(b.highlightedComments)) return 'highlightedComments must be an array'
    const arr = b.highlightedComments as unknown[]
    if (arr.length > REPORT_HIGHLIGHTED_MAX) return `highlightedComments must have at most ${REPORT_HIGHLIGHTED_MAX} items`
    for (const item of arr) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'highlightedComments must contain objects'
      const r = item as Record<string, unknown>
      if (typeof r.text !== 'string') return 'highlightedComments[].text must be a string'
      if (r.text.trim().length > REPORT_COMMENT_TEXT_MAX) return `highlightedComments[].text must be at most ${REPORT_COMMENT_TEXT_MAX} characters`
      if (r.author !== undefined && r.author !== null && typeof r.author !== 'string') return 'highlightedComments[].author must be a string'
      if (typeof r.author === 'string' && r.author.trim().length > REPORT_COMMENT_AUTHOR_MAX) return `highlightedComments[].author must be at most ${REPORT_COMMENT_AUTHOR_MAX} characters`
      if (r.sentiment !== undefined && !(REPORT_COMMENT_SENTIMENTS as readonly string[]).includes(String(r.sentiment))) {
        return 'highlightedComments[].sentiment must be positive, neutral or negative'
      }
      if (r.id !== undefined && r.id !== null && (typeof r.id !== 'string' || r.id.length > REPORT_ID_MAX)) return 'highlightedComments[].id must be a short string'
      if (r.mediaId !== undefined && r.mediaId !== null && (typeof r.mediaId !== 'string' || r.mediaId.length > REPORT_ID_MAX)) return 'highlightedComments[].mediaId must be a short string'
    }
  }
  // "Prometido vs entregado": null resets to Automático everywhere (the route maps it to the default).
  if (b.delivery !== undefined && b.delivery !== null) {
    const err = validateDeliveryPatch(b.delivery)
    if (err) return err
  }
  return null
}

function isCountOrNull(v: unknown): boolean {
  if (v === undefined || v === null) return true
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= REPORT_DELIVERY_COUNT_MAX
}

/** Strict shape check of a `delivery` patch (returns a 400 message or null). */
function validateDeliveryPatch(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'delivery must be an object'
  const d = v as Record<string, unknown>
  if (d.overrides !== undefined && d.overrides !== null) {
    if (typeof d.overrides !== 'object' || Array.isArray(d.overrides)) return 'delivery.overrides must be an object'
    const o = d.overrides as Record<string, unknown>
    for (const key of Object.keys(o)) {
      if (!(DELIVERY_ROW_KEYS as readonly string[]).includes(key)) return `delivery.overrides.${key} is not a known row`
      const item = o[key]
      if (item === undefined || item === null) continue
      if (typeof item !== 'object' || Array.isArray(item)) return `delivery.overrides.${key} must be an object`
      const r = item as Record<string, unknown>
      if (!isCountOrNull(r.planned)) return `delivery.overrides.${key}.planned must be an integer between 0 and ${REPORT_DELIVERY_COUNT_MAX}`
      if (!isCountOrNull(r.delivered)) return `delivery.overrides.${key}.delivered must be an integer between 0 and ${REPORT_DELIVERY_COUNT_MAX}`
      if (r.ok !== undefined && r.ok !== null && typeof r.ok !== 'boolean') return `delivery.overrides.${key}.ok must be a boolean`
      if (r.note !== undefined && r.note !== null) {
        if (typeof r.note !== 'string') return `delivery.overrides.${key}.note must be a string`
        if (r.note.trim().length > REPORT_DELIVERY_NOTE_MAX) return `delivery.overrides.${key}.note must be at most ${REPORT_DELIVERY_NOTE_MAX} characters`
      }
    }
  }
  if (d.extraRows !== undefined && d.extraRows !== null) {
    if (!Array.isArray(d.extraRows)) return 'delivery.extraRows must be an array'
    if (d.extraRows.length > REPORT_DELIVERY_EXTRA_MAX) return `delivery.extraRows must have at most ${REPORT_DELIVERY_EXTRA_MAX} items`
    for (const item of d.extraRows as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'delivery.extraRows must contain objects'
      const r = item as Record<string, unknown>
      if (typeof r.label !== 'string') return 'delivery.extraRows[].label must be a string'
      if (r.label.trim().length > REPORT_DELIVERY_LABEL_MAX) return `delivery.extraRows[].label must be at most ${REPORT_DELIVERY_LABEL_MAX} characters`
      if (r.value !== undefined && r.value !== null) {
        if (typeof r.value !== 'string') return 'delivery.extraRows[].value must be a string'
        if (r.value.trim().length > REPORT_DELIVERY_VALUE_MAX) return `delivery.extraRows[].value must be at most ${REPORT_DELIVERY_VALUE_MAX} characters`
      }
      if (r.ok !== undefined && r.ok !== null && typeof r.ok !== 'boolean') return 'delivery.extraRows[].ok must be a boolean'
      if (r.id !== undefined && r.id !== null && (typeof r.id !== 'string' || r.id.length > REPORT_ID_MAX)) return 'delivery.extraRows[].id must be a short string'
    }
  }
  return null
}

/**
 * Portal projection: the brand only needs what changes the rendering. The
 * audit trail (who sent what, when, who edited) is agency-internal.
 */
export function reportConfigForBrand(
  cfg: ReportConfig,
  computedOk: DeliveryComputedState = {}
): Omit<ReportConfig, 'sentVersions' | 'updatedAt' | 'updatedBy'> {
  const { sentVersions: _sent, updatedAt: _at, updatedBy: _by, ...rest } = cfg
  void _sent; void _at; void _by
  return { ...rest, delivery: deliveryForBrand(cfg.delivery, computedOk) }
}

/** System state (ok) of the four computed rows, from overview.delivery. */
export type DeliveryComputedState = Partial<Record<DeliveryRowKey, boolean>>

/** The ok flags of overview.delivery as a DeliveryComputedState ({} when there is no overview). */
export function deliveryComputedState(delivery: DeliveryChecklist | null | undefined): DeliveryComputedState {
  if (!delivery) return {}
  return {
    creators: delivery.creators.ok,
    pieces: delivery.pieces.ok,
    dates: delivery.dates.ok,
    disclosure: delivery.disclosure.ok,
  }
}

/** True when an override left in Automático (ok null) carries figures or a note, i.e. the projection needs the system state. */
export function deliveryNeedsComputedState(delivery: ReportDeliveryConfig | undefined): boolean {
  if (!delivery) return false
  return DELIVERY_ROW_KEYS.some(key => {
    const ov = delivery.overrides[key]
    return ov !== undefined && ov.ok == null
  })
}

/**
 * The client only ever sees checklist rows with ok === true (the report hides
 * the rest). Defense in depth: extra rows that are not ok never travel, and an
 * override the PM marked "En revisión" travels as { ok: false } only — its
 * numbers and note are agency-internal until the promise is met. An override
 * left in Automático (ok null) is shown or hidden by the SYSTEM state of its
 * row, so its figures and note travel only when that state is ok; when it is
 * not ok — or unknown to the caller — nothing travels (the row renders from
 * the computed values, and a computed not-ok row is hidden anyway).
 */
function deliveryForBrand(
  delivery: ReportDeliveryConfig | undefined,
  computedOk: DeliveryComputedState
): ReportDeliveryConfig {
  const src = delivery ?? defaultReportDelivery()
  const out = defaultReportDelivery()
  for (const key of DELIVERY_ROW_KEYS) {
    const ov = src.overrides[key]
    if (!ov) continue
    if (ov.ok === true) out.overrides[key] = { ...ov }
    else if (ov.ok === false) out.overrides[key] = { ok: false }
    else if (computedOk[key] === true) out.overrides[key] = { ...ov }
  }
  out.extraRows = src.extraRows.filter(row => row.ok === true).map(row => ({ ...row }))
  return out
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Strict load: defaults ONLY when nothing was ever saved; a read or parse
 * failure is rethrown. Every read-modify-write path (saveReportConfig,
 * markReportSent) must use this one — a transient DB error or a corrupted
 * row must fail the write, never be mistaken for "no config yet" and get
 * overwritten with defaults + the patch (which would also wipe the
 * sentVersions audit trail and un-hide every row the PM had hidden).
 */
export async function loadReportConfigStrict(campaignId: string): Promise<ReportConfig> {
  const row = await prisma.setting.findUnique({ where: { key: reportConfigKey(campaignId) } })
  if (!row?.value) return freshDefaultReportConfig()
  return normalizeReportConfig(JSON.parse(row.value))
}

/**
 * Lenient load for READ paths only (GET routes, the report view): defaults
 * on any failure so a broken row never blocks rendering the report. Never
 * throws. Never use it before a persist() — see loadReportConfigStrict.
 */
export async function loadReportConfig(campaignId: string): Promise<ReportConfig> {
  try {
    return await loadReportConfigStrict(campaignId)
  } catch (err) {
    console.error('[report-config] load failed, using defaults:', err instanceof Error ? err.message : err)
    return freshDefaultReportConfig()
  }
}

async function persist(campaignId: string, cfg: ReportConfig): Promise<void> {
  const key = reportConfigKey(campaignId)
  const value = JSON.stringify(cfg)
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

/**
 * Merge a patch into the stored config and save it. A field present in the
 * patch replaces the stored one; an empty string clears a text field. Fields
 * absent from the patch are left untouched, so partial saves are safe.
 */
export async function saveReportConfig(
  campaignId: string,
  patch: ReportConfigPatch,
  by: string
): Promise<ReportConfig> {
  // Strict: a failed read must fail the save, not reset the stored config.
  const current = await loadReportConfigStrict(campaignId)
  const has = (k: keyof ReportConfigPatch) => Object.prototype.hasOwnProperty.call(patch, k)

  const merged: Record<string, unknown> = { ...current }
  for (const k of ['title', 'subtitle', 'intro', 'conclusions'] as const) {
    if (has(k)) merged[k] = patch[k] // normalize() drops empty strings
  }
  for (const k of ['hiddenSections', 'hiddenColumns', 'hiddenMediaIds', 'hiddenInfluencerIds', 'highlightedComments', 'delivery'] as const) {
    if (has(k)) merged[k] = patch[k] // delivery: the patch replaces the whole block (normalize() cleans it)
  }
  merged.updatedAt = new Date().toISOString()
  merged.updatedBy = by

  const next = normalizeReportConfig(merged)
  await persist(campaignId, next)
  return next
}

/** Append a "sent" entry with the next version number. */
export async function markReportSent(
  campaignId: string,
  by: string,
  note?: string
): Promise<ReportConfig> {
  // Strict: a failed read must fail the write, not restart the audit trail at v1.
  const current = await loadReportConfigStrict(campaignId)
  const lastVersion = current.sentVersions.reduce((max, v) => Math.max(max, v.version), 0)
  const entry: ReportSentVersion = {
    version: lastVersion + 1,
    sentAt: new Date().toISOString(),
    sentBy: by,
  }
  const cleanNote = cleanText(note)
  if (cleanNote) entry.note = cleanNote
  const next: ReportConfig = { ...current, sentVersions: [...current.sentVersions, entry] }
  await persist(campaignId, next)
  return next
}
