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

// ---------------------------------------------------------------------------
// Ids the report understands
// ---------------------------------------------------------------------------

/** Sections of the report that can be hidden from the client. */
export const REPORT_SECTION_IDS = [
  'summary',
  'timeline',
  /** Body: "Contenidos destacados" (the 6 pieces with most real audience). */
  'content',
  'creators',
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
  'creators.er',
  'creators.cpm',
  'creators.posts',
  'summary.reach',
  'summary.views',
  'summary.engagement',
  'summary.er',
  /** The separate, informative "Audiencia estimada" line (decision 4A). */
  'summary.audience_estimated',
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
  >
>

/** Limits enforced by the API (and re-checked here so nothing bypasses them). */
export const REPORT_TEXT_MAX = 2000
export const REPORT_LIST_MAX = 200
/** Ids are cuids (25 chars); allow slack for usernames used as fallback keys. */
export const REPORT_ID_MAX = 200

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  hiddenSections: [],
  hiddenColumns: [],
  hiddenMediaIds: [],
  hiddenInfluencerIds: [],
  sentVersions: [],
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
  return null
}

/**
 * Portal projection: the brand only needs what changes the rendering. The
 * audit trail (who sent what, when, who edited) is agency-internal.
 */
export function reportConfigForBrand(cfg: ReportConfig): Omit<ReportConfig, 'sentVersions' | 'updatedAt' | 'updatedBy'> {
  const { sentVersions: _sent, updatedAt: _at, updatedBy: _by, ...rest } = cfg
  void _sent; void _at; void _by
  return rest
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
  if (!row?.value) return { ...DEFAULT_REPORT_CONFIG }
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
    return { ...DEFAULT_REPORT_CONFIG }
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
  for (const k of ['hiddenSections', 'hiddenColumns', 'hiddenMediaIds', 'hiddenInfluencerIds'] as const) {
    if (has(k)) merged[k] = patch[k]
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
