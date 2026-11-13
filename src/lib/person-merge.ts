/**
 * MERGING TWO PROFILES THAT ARE THE SAME CREATOR (13 Nov 2026).
 *
 * A creator is a Person with several profiles (src/lib/person-profiles.ts) and
 * ONE member row per campaign (src/lib/campaign-roster.ts). Records created by
 * hand before that model existed can still count one person twice: two member
 * rows of one campaign for her Instagram and her TikTok, or a member row for a
 * WRONG handle (her TikTok handle saved as an Instagram profile) next to the
 * row of her real account. This module finds those pairs, shows what merging
 * them would do, does it only when an ADMIN confirms it, and undoes it.
 *
 * It generalises the fold of the «tiktok_link:» twins (src/lib/person-fold.ts)
 * and is built on its helpers (row snapshots as the database stores them,
 * writing a row back from such a snapshot, the client report's hidden list,
 * who reads a folded TikTok account).
 *
 * The two modes, for the profile that does not stay («the other»):
 *   link   → it is another real account of hers: it joins the kept person and
 *            keeps being read where it still is a member;
 *   absorb → a wrong or old handle: it leaves every campaign (its memberships
 *            fold into hers or MOVE to the kept profile with their pieces) and
 *            it leaves the person, so nothing reads it any more.
 *
 * Per campaign of the other profile:
 *   - the kept person (any profile of hers) is a member too → FOLD: the other
 *     row's fields are merged into the person's row (a value on one side only
 *     is kept; real differences are conflicts the ADMIN resolves), its pieces
 *     and notes move there, and the other row is deleted;
 *   - only the other is a member → link: unchanged; absorb: MOVE (the row is
 *     re-anchored to the kept profile, with its pieces and notes).
 * Pieces keep who published them (Media.publishedByInfluencerId). The same
 * post filed under both rows of one campaign keeps the richer row; the other
 * is detached (campaignId null), never deleted.
 *
 * Places keyed by (campaign, influencer id), searched in the schema and the
 * code on 13 Nov 2026, and what a merge does with each:
 *   - campaign_influencers (campaignId, influencerId) ... folded / moved here
 *   - media (campaignId, influencerId) .................. re-pointed here
 *   - campaign_notes (campaignId, influencerId) ......... re-pointed here
 *   - Setting campaign_report_<campaignId>: hiddenInfluencerIds is the only
 *     per-creator key (hiddenMediaIds and highlightedComments[].mediaId are per
 *     piece and pieces keep their ids): re-keyed here; a detached duplicate
 *     named in it is a warning
 *   - Setting ad_permissions_<campaignId>_<influencerId>: re-keyed here
 *   - stories view rates (src/lib/emv-server.ts) follow the publisher and are
 *     computed on every read: nothing stored
 *   - notification metadata { influencerId, campaignId }: de-duplication of old
 *     notices only, nothing to re-point
 * Keyed by the profile alone, they STAY on their profile and the preview says
 * so: contacts, list items, creator-pool rows (creator_platform_profiles),
 * social tokens, Meta story mentions (matchedCreatorId), avatars.
 *
 * Every write is one transaction with row locks and a lock timeout, refused
 * when the preview it was confirmed on is stale (fingerprint), and logged in
 * ONE PersonLog row 'merge' with every row exactly as it was: undoMerge() puts
 * everything back, and refuses (unless forced) when something it touched has
 * changed since. No Influencer row is ever deleted; the only rows deleted are
 * the folded membership rows, whole in the log.
 */
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import type { Platform } from '@/generated/prisma/client'
import { mediaPostKey } from '@/lib/campaign-capture'
import { buildRoster, type Roster } from '@/lib/campaign-roster'
import { memberCost } from '@/lib/metrics'
import {
  IDENTITY_TX_OPTIONS,
  NETWORK_LABEL,
  SHIPPING_TEXT_FIELDS,
  asJsonObject,
  describeProfileLabel,
  filled,
  foldedTikTokReadWarning,
  hasShippingData,
  insertRowAsItWas,
  isSameId,
  positive,
  rawHiddenList,
  storableColumns,
  tableColumns,
  writeRowColumns,
  type IdentityDb,
} from '@/lib/person-fold'
import { normalizeHandle, personKeyOf, type Actor } from '@/lib/person-profiles'
import { reportConfigKey } from '@/lib/report-config'

type Row = Record<string, unknown>
type Db = IdentityDb

const describe = describeProfileLabel
const net = (platform: string) => NETWORK_LABEL[platform] ?? platform
const quoted = (name: string) => `«${name}»`

// ===========================================================================
// Errors
// ===========================================================================

export type MergeErrorCode = 'invalid' | 'forbidden' | 'not_found' | 'stale' | 'needs_choice' | 'busy' | 'changed_since' | 'cannot_undo'

const ERROR_STATUS: Record<MergeErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  stale: 409,
  needs_choice: 409,
  busy: 409,
  changed_since: 409,
  cannot_undo: 409,
}

export class MergeError extends Error {
  code: MergeErrorCode
  /** HTTP status the route answers with */
  status: number
  /** needs_choice: { missingChoices }; changed_since / cannot_undo: { differences } */
  details: Record<string, unknown> | null

  constructor(code: MergeErrorCode, message: string, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'MergeError'
    this.code = code
    this.status = ERROR_STATUS[code]
    this.details = details
  }
}

const STALE_TEXT = 'Las fichas han cambiado desde que se preparó la fusión. Vuelve a revisarla antes de fusionar.'
const BUSY_TEXT = 'Otra operación está usando estas fichas ahora mismo. Vuelve a intentarlo en unos segundos.'

/** A lock that could not be taken in time, a deadlock or a row taken meanwhile: a clean 409, never a 500. */
function translateDbError(err: unknown): unknown {
  if (err instanceof MergeError) return err
  const parts: string[] = []
  let cursor: unknown = err
  for (let depth = 0; cursor && depth < 4; depth++) {
    const e = cursor as { message?: unknown; code?: unknown; meta?: unknown; cause?: unknown }
    parts.push(String(e.message ?? ''), String(e.code ?? ''))
    try { parts.push(JSON.stringify(e.meta ?? null)) } catch { /* unserialisable meta */ }
    cursor = e.cause
  }
  const text = parts.join(' ')
  if (/55P03|lock timeout|lock_not_available|40P01|deadlock|P2028|Transaction already closed|expired transaction/i.test(text)) return new MergeError('busy', BUSY_TEXT)
  if (/P2002|23505|unique constraint/i.test(text)) return new MergeError('stale', STALE_TEXT)
  return err
}

/** How long a merge or an undo waits for a row somebody else holds. */
const LOCK_TIMEOUT_MS = 8_000

/** Every write of this module is an ADMIN's (the route checks the session; this checks the actor it is given). */
async function assertAdminActor(actor: Actor): Promise<void> {
  const refuse = () => new MergeError('forbidden', 'Solo un administrador puede fusionar fichas de creadoras.')
  if (!actor?.id) throw refuse()
  const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { role: true, isActive: true } })
  if (!user || user.role !== 'ADMIN' || user.isActive === false) throw refuse()
}

// ===========================================================================
// Pure helpers: links, handles, names
// ===========================================================================

/** A profile named in a website or bio link (handle normalised). */
export interface ProfileLink {
  platform: Platform
  handle: string
}

const INSTAGRAM_PATHS = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'developer', 'legal', 'web', 's', 'share'])

/**
 * The profiles a website or bio links to: tiktok.com/@X, instagram.com/X
 * (instagr.am/X) and youtube.com/@X. Never an e-mail, a phone or a name. Pure.
 */
export function extractProfileLinks(...texts: Array<string | null | undefined>): ProfileLink[] {
  const out = new Map<string, ProfileLink>()
  const add = (platform: Platform, raw: string) => {
    const handle = normalizeHandle(raw).replace(/\.+$/, '')
    if (handle.length < 2) return
    out.set(`${platform}|${handle}`, { platform, handle })
  }
  for (const value of texts) {
    if (!value) continue
    const text = String(value)
    for (const m of text.matchAll(/tiktok\.com\/@([A-Za-z0-9._]+)/gi)) add('TIKTOK', m[1])
    for (const m of text.matchAll(/(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]+)/gi)) {
      if (!INSTAGRAM_PATHS.has(m[1].toLowerCase())) add('INSTAGRAM', m[1])
    }
    for (const m of text.matchAll(/youtube\.com\/@([A-Za-z0-9._-]+)/gi)) add('YOUTUBE', m[1])
  }
  return Array.from(out.values())
}

/** How a link is written in the texts: "tiktok.com/@x". */
export function linkText(link: ProfileLink): string {
  if (link.platform === 'TIKTOK') return `tiktok.com/@${link.handle}`
  if (link.platform === 'YOUTUBE') return `youtube.com/@${link.handle}`
  return `instagram.com/${link.handle}`
}

/** Levenshtein distance when it is at most `max`, else null (stops early). Pure. */
export function editDistanceWithin(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return null
    prev = cur
  }
  return prev[b.length] <= max ? prev[b.length] : null
}

export const NEAR_HANDLE_MIN_LENGTH = 5
export const NEAR_HANDLE_MAX_EDITS = 3

/**
 * Two different handles that are nearly the same: one contains the other, or
 * at most 3 edits apart, both at least 5 characters long. Equal handles are
 * not «near» (they are the same handle). Pure.
 */
export function handlesAreNear(a: string, b: string): boolean {
  const x = normalizeHandle(a)
  const y = normalizeHandle(b)
  if (!x || !y || x === y) return false
  if (Math.min(x.length, y.length) < NEAR_HANDLE_MIN_LENGTH) return false
  if (x.includes(y) || y.includes(x)) return true
  return editDistanceWithin(x, y, NEAR_HANDLE_MAX_EDITS) !== null
}

/** A handle without case, dots or underscores: 'Ale.Ficticia' and 'ale_ficticia' give the same. Pure. */
export function looseHandle(handle: string): string {
  return normalizeHandle(handle).replace(/[._]/g, '')
}

/** A display name for comparisons (no accents, symbols or case), or null when too short to mean anything. Pure. */
export function normalizeDisplayName(name: string | null | undefined): string | null {
  if (!name) return null
  const key = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return key.length >= 5 ? key : null
}

/** Stable JSON (keys sorted) for comparisons and fingerprints. Pure. */
function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** A blank string counts as no value. */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null)
const sameValue = (a: unknown, b: unknown) => canonical(blankToNull(a)) === canonical(blankToNull(b))

/** row_to_json gives timestamps without zone ("2026-10-01T00:00:00"): stored in UTC. */
function tsOf(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v !== 'string' || !v) return Number.NaN
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`)
}

/** Now, written the way row_to_json writes a timestamp without zone. */
function nowAsStored(): string {
  return new Date().toISOString().replace('Z', '')
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ===========================================================================
// Pure: merging two membership rows of one campaign
// ===========================================================================

export type MergeMode = 'link' | 'absorb'
export const MERGE_MODES: readonly MergeMode[] = ['link', 'absorb']

/** keep = the surviving row's value, other = the folded row's value, add = both added (money and deliverables). */
export type MergeChoice = 'keep' | 'other' | 'add'
export const MERGE_CHOICES: readonly MergeChoice[] = ['keep', 'other', 'add']

/** Choices per campaign id, then per field group. */
export type MergeChoices = Record<string, Partial<Record<string, MergeChoice>>>

export type MergeFieldKind = 'money' | 'count' | 'status' | 'shipping' | 'notes' | 'boolean' | 'survivor' | 'earliest'

interface FieldGroupSpec {
  group: string
  label: string
  kind: MergeFieldKind
  columns: readonly string[]
}

/** Every column of campaign_influencers except ids, campaign and updatedAt, in groups. Columns added later fall into a 'survivor' group of their own. */
export const MEMBERSHIP_FIELD_GROUPS: readonly FieldGroupSpec[] = [
  { group: 'agreedFee', label: 'Honorario acordado', kind: 'money', columns: ['agreedFee'] },
  { group: 'cost', label: 'Coste', kind: 'money', columns: ['cost'] },
  { group: 'commission', label: 'Comisión', kind: 'money', columns: ['commission'] },
  { group: 'askingFee', label: 'Honorario pedido', kind: 'money', columns: ['askingFee'] },
  { group: 'deliverablesPlanned', label: 'Entregables comprometidos', kind: 'count', columns: ['deliverablesPlanned'] },
  { group: 'status', label: 'Estado', kind: 'status', columns: ['status'] },
  { group: 'shipping', label: 'Datos de envío', kind: 'shipping', columns: [...SHIPPING_TEXT_FIELDS, 'shippingQty'] },
  { group: 'notes', label: 'Notas', kind: 'notes', columns: ['notes'] },
  { group: 'contentDelivered', label: 'Contenido UGC entregado', kind: 'boolean', columns: ['contentDelivered'] },
  { group: 'whitelisting', label: 'Whitelisting', kind: 'boolean', columns: ['whitelisting'] },
  { group: 'urgent', label: 'Urgente', kind: 'boolean', columns: ['urgent'] },
  { group: 'crossposting', label: 'Crossposting', kind: 'boolean', columns: ['crossposting'] },
  { group: 'dealClosedAt', label: 'Fecha de cierre del acuerdo', kind: 'survivor', columns: ['dealClosedAt'] },
  { group: 'baseline', label: 'Línea base', kind: 'survivor', columns: ['baselineSnapshot', 'baselineAt'] },
  { group: 'tracked', label: 'Enlace con seguimiento y clics', kind: 'survivor', columns: ['trackedLink', 'trackedClicks'] },
  { group: 'portfolioUrl', label: 'Portfolio UGC', kind: 'survivor', columns: ['portfolioUrl'] },
  { group: 'negotiatedFormat', label: 'Formato negociado', kind: 'survivor', columns: ['negotiatedFormat'] },
  { group: 'exclusivityDays', label: 'Días de exclusividad', kind: 'survivor', columns: ['exclusivityDays'] },
  { group: 'rightsDays', label: 'Días de derechos de uso', kind: 'survivor', columns: ['rightsDays'] },
  { group: 'source', label: 'Origen de la ficha', kind: 'survivor', columns: ['source'] },
  { group: 'createdAt', label: 'Fecha de alta y quién la añadió', kind: 'earliest', columns: ['createdAt', 'addedById', 'addedByName'] },
]

const NOT_MERGED_COLUMNS = new Set(['id', 'campaignId', 'influencerId', 'updatedAt'])

/** InfluencerStatus in pipeline order: the most advanced wins by default. */
export const STATUS_ORDER = ['PROSPECT', 'OUTREACH', 'NEGOTIATING', 'AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] as const

export interface MergeFieldOutcome {
  group: string
  label: string
  kind: MergeFieldKind
  /** The surviving row's value (an object of columns for a multi-column group) */
  survivorValue: unknown
  /** The folded row's value */
  otherValue: unknown
  /**
   * from_other: only the other row had it, it is kept; joined: notes, both
   * kept; earliest: the other row is older, its date and author are kept;
   * conflict: different values on both rows
   */
  resolution: 'from_other' | 'joined' | 'earliest' | 'conflict'
  conflict: boolean
  /** The choices offered when it is a conflict */
  options: MergeChoice[]
  /** What happens with no choice; null = the ADMIN must choose (apply refuses until then) */
  default: MergeChoice | null
  /** The choice in force (given, else the default) */
  chosen: MergeChoice | null
  needsChoice: boolean
  /** The value after the merge; null while it needs a choice */
  result: unknown
}

export interface MembershipMerge {
  /** The surviving row with the merged values (row_to_json shape) */
  merged: Row
  /** Columns of the surviving row that change */
  changedColumns: string[]
  /** Every field group whose value differs between the rows */
  fields: MergeFieldOutcome[]
  /** Groups that need a choice and have none */
  missing: string[]
  /** Choices given that are not one of the options */
  invalid: string[]
}

function groupValue(row: Row, columns: readonly string[]): unknown {
  return columns.length === 1 ? row[columns[0]] ?? null : Object.fromEntries(columns.map(c => [c, row[c] ?? null]))
}

function presentFor(kind: MergeFieldKind, row: Row, columns: readonly string[]): boolean {
  switch (kind) {
    case 'money': return columns.some(c => positive(row[c]))
    case 'count': return columns.some(c => row[c] !== null && row[c] !== undefined)
    case 'shipping': return hasShippingData(row)
    case 'notes': return columns.some(c => filled(row[c]))
    default: return columns.some(c => blankToNull(row[c]) !== null)
  }
}

/**
 * The fields of two membership rows of one campaign merged into the surviving
 * row (the rules the owner approved on 12 Nov 2026). Pure.
 *   - a value on one side only is kept; equal values are kept;
 *   - money (agreedFee, cost, commission, askingFee) and deliverables in
 *     conflict: keep / other / add, NO default;
 *   - status: the most advanced by default;
 *   - the shipping block is one choice: keep / other, no default when both
 *     have data;
 *   - notes: joined;
 *   - booleans: true wins;
 *   - deal date, baseline, tracked link, portfolio, format, exclusivity,
 *     rights, origin: the survivor's by default;
 *   - createdAt and addedBy*: the earliest row's.
 */
export function mergeMembershipRows(survivor: Row, other: Row, choices: Partial<Record<string, MergeChoice>> = {}): MembershipMerge {
  const merged: Row = { ...survivor }
  const fields: MergeFieldOutcome[] = []
  const missing: string[] = []
  const invalid: string[] = []

  const covered = new Set(MEMBERSHIP_FIELD_GROUPS.flatMap(g => g.columns))
  const extra: FieldGroupSpec[] = Array.from(new Set([...Object.keys(survivor), ...Object.keys(other)]))
    .filter(c => !covered.has(c) && !NOT_MERGED_COLUMNS.has(c))
    .sort()
    .map(c => ({ group: c, label: c, kind: 'survivor' as const, columns: [c] }))

  for (const spec of [...MEMBERSHIP_FIELD_GROUPS, ...extra]) {
    const { group, label, kind, columns } = spec
    const sv = groupValue(survivor, columns)
    const ov = groupValue(other, columns)
    const takeOther = () => { for (const c of columns) merged[c] = other[c] ?? null }
    const outcome = (resolution: MergeFieldOutcome['resolution'], extraFields: Partial<MergeFieldOutcome> = {}): MergeFieldOutcome => ({
      group, label, kind, survivorValue: sv, otherValue: ov, resolution,
      conflict: resolution === 'conflict', options: [], default: null, chosen: null, needsChoice: false, result: null,
      ...extraFields,
    })

    if (kind === 'earliest') {
      const so = tsOf(survivor.createdAt)
      const oo = tsOf(other.createdAt)
      if (Number.isFinite(oo) && (!Number.isFinite(so) || oo < so) && !sameValue(sv, ov)) {
        takeOther()
        fields.push(outcome('earliest', { result: groupValue(merged, columns) }))
      }
      continue
    }

    if (kind === 'boolean') {
      const s = survivor[columns[0]] === true
      const o = other[columns[0]] === true
      if (s === o) continue
      const def: MergeChoice = s ? 'keep' : 'other'
      const given = choices[group]
      if (given !== undefined && given !== 'keep' && given !== 'other') invalid.push(group)
      const chosen: MergeChoice = given === 'keep' || given === 'other' ? given : def
      if (chosen === 'other') takeOther()
      fields.push(outcome('conflict', { options: ['keep', 'other'], default: def, chosen, result: groupValue(merged, columns) }))
      continue
    }

    if (kind === 'status') {
      if (sameValue(sv, ov)) continue
      const rank = (v: unknown) => STATUS_ORDER.indexOf(String(v) as (typeof STATUS_ORDER)[number])
      const def: MergeChoice = rank(ov) > rank(sv) ? 'other' : 'keep'
      const given = choices[group]
      if (given !== undefined && given !== 'keep' && given !== 'other') invalid.push(group)
      const chosen: MergeChoice = given === 'keep' || given === 'other' ? given : def
      if (chosen === 'other') takeOther()
      fields.push(outcome('conflict', { options: ['keep', 'other'], default: def, chosen, result: groupValue(merged, columns) }))
      continue
    }

    const sp = presentFor(kind, survivor, columns)
    const op = presentFor(kind, other, columns)
    if (!op) continue
    if (!sp) {
      takeOther()
      fields.push(outcome('from_other', { result: groupValue(merged, columns) }))
      continue
    }
    const equal = kind === 'notes'
      ? String(survivor.notes ?? '').trim() === String(other.notes ?? '').trim()
      : columns.every(c => sameValue(survivor[c], other[c]))
    if (equal) continue

    if (kind === 'notes') {
      merged.notes = `${String(survivor.notes).trim()}\n\n${String(other.notes).trim()}`
      fields.push(outcome('joined', { result: merged.notes }))
      continue
    }

    const options: MergeChoice[] = kind === 'money' || kind === 'count' ? ['keep', 'other', 'add'] : ['keep', 'other']
    const def: MergeChoice | null = kind === 'survivor' ? 'keep' : null
    const given = choices[group]
    if (given !== undefined && !options.includes(given)) invalid.push(group)
    const chosen: MergeChoice | null = given !== undefined && options.includes(given) ? given : def
    if (chosen === 'other') takeOther()
    if (chosen === 'add') {
      for (const c of columns) {
        const sum = (Number(survivor[c]) || 0) + (Number(other[c]) || 0)
        merged[c] = kind === 'money' ? round2(sum) : sum
      }
    }
    if (chosen === null) missing.push(group)
    fields.push(outcome('conflict', { options, default: def, chosen, needsChoice: chosen === null, result: chosen === null ? null : groupValue(merged, columns) }))
  }

  const changedColumns = Object.keys(merged).filter(c => !NOT_MERGED_COLUMNS.has(c) && canonical(merged[c] ?? null) !== canonical(survivor[c] ?? null))
  return { merged, changedColumns, fields, missing, invalid }
}

// ===========================================================================
// Candidates (read-only)
// ===========================================================================

export type MergeEvidenceCode = 'same_campaign' | 'links_to_other' | 'case_only' | 'same_handle_cross_network' | 'near_handle'
export type MergeStrength = 'double_count' | 'strong' | 'review'

export const MERGE_STRENGTH: Readonly<Record<MergeEvidenceCode, MergeStrength>> = {
  same_campaign: 'double_count',
  links_to_other: 'strong',
  case_only: 'strong',
  same_handle_cross_network: 'review',
  near_handle: 'review',
}
const STRENGTH_RANK: Record<MergeStrength, number> = { double_count: 0, strong: 1, review: 2 }

export interface MergeEvidence {
  code: MergeEvidenceCode
  /** One Spanish sentence naming the handles */
  text: string
}

export interface MergeProfileCampaign {
  id: string
  name: string
  campaignStatus: string
  /** ISO */
  startDate: string
  membershipStatus: string
  /** Pieces of that campaign credited to this profile */
  pieces: number
  hasFee: boolean
}

export interface MergeProfileSummary {
  id: string
  username: string
  platform: Platform
  followers: number
  displayName: string | null
  personId: string | null
  /** The other profiles of her person */
  otherProfiles: Array<{ id: string; username: string; platform: Platform; followers: number }>
  /** The campaigns this profile is a member of */
  campaigns: MergeProfileCampaign[]
  /** Campaign pieces credited to this profile */
  pieces: number
  /** Campaign pieces this profile published itself (credited to it or to another profile of hers) */
  ownPieces: number
}

export interface MergeSuggestion {
  keepId: string
  otherId: string
  mode: MergeMode
  /** Why, in Spanish */
  reason: string
}

export interface MergeCandidate {
  /** "<id>|<id>", the two ids sorted */
  key: string
  /** The strongest evidence */
  kind: MergeEvidenceCode
  strength: MergeStrength
  /** [the profile suggested to stay, the other one] */
  profiles: [MergeProfileSummary, MergeProfileSummary]
  evidence: MergeEvidence[]
  /** Campaigns where both persons are members: «creadoras antes → después» */
  sharedCampaigns: Array<{ id: string; name: string; membersBefore: number; membersAfter: number }>
  suggestion: MergeSuggestion
  /** ISO start of the most recent campaign of either person, or null */
  latestCampaignAt: string | null
}

interface UProfile {
  id: string
  username: string
  platform: Platform
  followers: number
  displayName: string | null
  personId: string | null
  createdAt: Date
  /** null = never read: its followers are unknown, not 0 */
  lastScraped: Date | null
  norm: string
  loose: string
  links: ProfileLink[]
  nameKey: string | null
}

interface UMembership {
  id: string
  campaignId: string
  influencerId: string
  status: string
  hasFee: boolean
  createdAt: Date
}

interface UCampaign {
  id: string
  name: string
  status: string
  startDate: Date
}

interface Universe {
  profiles: Map<string, UProfile>
  memberships: UMembership[]
  campaigns: Map<string, UCampaign>
  /** Members of a campaign or publishers of campaign pieces */
  relevant: Set<string>
  dismissed: Set<string>
  /** Profiles absorbed by a merge in force (a wrong or old handle): not proposed again while they are no campaign's member */
  absorbed: Set<string>
  /** Members per campaign (all of them, for «antes → después») */
  membersPerCampaign: Map<string, number>
}

/** The campaigns of each person (a person is one creator: the memberships of all her profiles). */
function campaignsByPerson(u: Pick<Universe, 'memberships' | 'profiles'>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const m of u.memberships) {
    const p = u.profiles.get(m.influencerId)
    const key = p ? personKeyOf(p) : `inf:${m.influencerId}`
    const set = out.get(key) ?? new Set<string>()
    set.add(m.campaignId)
    out.set(key, set)
  }
  return out
}

/** Profiles absorbed by a merge that is in force. */
async function loadAbsorbedProfiles(db: Db = prisma): Promise<Set<string>> {
  const logs = await db.personLog.findMany({ where: { action: 'merge', undoneAt: null }, select: { after: true } })
  const out = new Set<string>()
  for (const l of logs) {
    const after = (l.after ?? {}) as { mode?: unknown; otherId?: unknown }
    if (after.mode === 'absorb' && typeof after.otherId === 'string') out.add(after.otherId)
  }
  return out
}

const PROFILE_SELECT = { id: true, username: true, platform: true, followers: true, displayName: true, personId: true, website: true, bio: true, createdAt: true, lastScraped: true } as const

function toUProfile(p: { id: string; username: string; platform: Platform; followers: number; displayName: string | null; personId: string | null; website: string | null; bio: string | null; createdAt: Date; lastScraped: Date | null }): UProfile {
  return {
    id: p.id,
    username: p.username,
    platform: p.platform,
    followers: p.followers,
    displayName: p.displayName,
    personId: p.personId,
    createdAt: p.createdAt,
    lastScraped: p.lastScraped,
    norm: normalizeHandle(p.username),
    loose: looseHandle(p.username),
    links: extractProfileLinks(p.website, p.bio),
    nameKey: normalizeDisplayName(p.displayName),
  }
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** The live dismissals: pairs the ADMIN said are not the same person. */
async function loadDismissedPairs(db: Db = prisma): Promise<Set<string>> {
  const logs = await db.personLog.findMany({ where: { action: 'dismiss_candidate', undoneAt: null }, select: { after: true } })
  const out = new Set<string>()
  for (const l of logs) {
    const pair = (l.after as { pair?: unknown } | null)?.pair
    if (Array.isArray(pair) && pair.length === 2 && pair.every(x => typeof x === 'string')) out.add(pairKey(pair[0], pair[1]))
  }
  return out
}

/** Everything the finder compares. With `campaignId` (count only): just the persons of that campaign's members. */
async function loadUniverse(onlyCampaignId?: string): Promise<Universe> {
  let influencers: Array<Parameters<typeof toUProfile>[0]>
  let memberships: Array<{ id: string; campaignId: string; influencerId: string; status: string; agreedFee: number | null; cost: number | null; createdAt: Date }>
  let relevantIds: string[]
  const membershipSelect = { id: true, campaignId: true, influencerId: true, status: true, agreedFee: true, cost: true, createdAt: true } as const

  if (onlyCampaignId) {
    const members = await prisma.campaignInfluencer.findMany({ where: { campaignId: onlyCampaignId }, select: { influencerId: true, influencer: { select: { personId: true } } } })
    const memberIds = members.map(m => m.influencerId)
    const personIds = Array.from(new Set(members.map(m => m.influencer.personId).filter((x): x is string => !!x)))
    influencers = memberIds.length === 0 ? [] : await prisma.influencer.findMany({
      where: { OR: [{ id: { in: memberIds } }, ...(personIds.length ? [{ personId: { in: personIds } }] : [])] },
      select: PROFILE_SELECT,
    })
    memberships = influencers.length === 0 ? [] : await prisma.campaignInfluencer.findMany({ where: { influencerId: { in: influencers.map(i => i.id) } }, select: membershipSelect })
    relevantIds = memberIds
  } else {
    const [inf, mem, rel] = await Promise.all([
      prisma.influencer.findMany({ select: PROFILE_SELECT }),
      prisma.campaignInfluencer.findMany({ select: membershipSelect }),
      prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT "influencerId" AS id FROM media WHERE "campaignId" IS NOT NULL
        UNION
        SELECT DISTINCT "publishedByInfluencerId" AS id FROM media WHERE "campaignId" IS NOT NULL AND "publishedByInfluencerId" IS NOT NULL`,
    ])
    influencers = inf
    memberships = mem
    relevantIds = rel.map(r => r.id)
  }

  const campaignIds = Array.from(new Set(memberships.map(m => m.campaignId)))
  const [campaignRows, counts, dismissed, absorbed] = await Promise.all([
    campaignIds.length === 0 ? [] : prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, status: true, startDate: true } }),
    campaignIds.length === 0 ? [] : prisma.campaignInfluencer.groupBy({ by: ['campaignId'], where: { campaignId: { in: campaignIds } }, _count: { _all: true } }),
    loadDismissedPairs(),
    loadAbsorbedProfiles(),
  ])

  const relevant = new Set(relevantIds)
  for (const m of memberships) relevant.add(m.influencerId)
  return {
    profiles: new Map(influencers.map(i => [i.id, toUProfile(i)])),
    memberships: memberships.map(m => ({ id: m.id, campaignId: m.campaignId, influencerId: m.influencerId, status: m.status, hasFee: memberCost(m) > 0, createdAt: m.createdAt })),
    campaigns: new Map(campaignRows.map(c => [c.id, c])),
    relevant,
    dismissed,
    absorbed,
    membersPerCampaign: new Map(counts.map(c => [c.campaignId, c._count._all])),
  }
}

interface PairFacts {
  a: UProfile
  b: UProfile
  sameHandle: boolean
  caseVariant: boolean
  links: Array<{ fromId: string; link: ProfileLink }>
  coincidences: Array<{ kind: 'name' | 'third_link'; text: string }>
}

interface RawPair {
  key: string
  a: UProfile
  b: UProfile
  kind: MergeEvidenceCode
  evidence: MergeEvidence[]
  shared: string[]
  latest: number | null
}

/** Pairs that may be one person, with their evidence. Pure over the loaded universe. */
function computePairs(u: Universe): RawPair[] {
  const profiles = Array.from(u.profiles.values())
  const facts = new Map<string, PairFacts>()
  const factOf = (a: UProfile, b: UProfile): PairFacts | null => {
    if (a.id === b.id) return null
    const key = pairKey(a.id, b.id)
    let f = facts.get(key)
    if (!f) {
      const [x, y] = a.id < b.id ? [a, b] : [b, a]
      f = { a: x, b: y, sameHandle: false, caseVariant: false, links: [], coincidences: [] }
      facts.set(key, f)
    }
    return f
  }
  const pairsOf = <T>(list: T[], max = 40): Array<[T, T]> => {
    if (list.length < 2 || list.length > max) return []
    const out: Array<[T, T]> = []
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]])
    return out
  }
  const bucket = <K>(map: Map<K, UProfile[]>, key: K, p: UProfile) => {
    const list = map.get(key)
    if (list) list.push(p)
    else map.set(key, [p])
  }

  // Same handle on different networks; case, dot and underscore variants on one network
  const byNorm = new Map<string, UProfile[]>()
  const byLoose = new Map<string, UProfile[]>()
  for (const p of profiles) {
    if (!p.norm) continue
    bucket(byNorm, p.norm, p)
    if (p.loose.length >= 3) bucket(byLoose, `${p.platform}|${p.loose}`, p)
  }
  for (const list of byNorm.values()) {
    for (const [a, b] of pairsOf(list)) if (a.platform !== b.platform) factOf(a, b)!.sameHandle = true
  }
  for (const list of byLoose.values()) {
    for (const [a, b] of pairsOf(list)) if (a.username !== b.username) factOf(a, b)!.caseVariant = true
  }

  // A website or bio links the other's handle
  for (const p of profiles) {
    for (const link of p.links) {
      for (const t of byNorm.get(link.handle) ?? []) {
        if (t.id === p.id) continue
        factOf(p, t)!.links.push({ fromId: p.id, link })
      }
    }
  }

  // Members of one campaign with near handles
  const membersOf = new Map<string, UProfile[]>()
  for (const m of u.memberships) {
    const p = u.profiles.get(m.influencerId)
    if (p) bucket(membersOf, m.campaignId, p)
  }
  const nearInCampaign = new Set<string>()
  for (const list of membersOf.values()) {
    for (const [a, b] of pairsOf(list, 400)) if (handlesAreNear(a.username, b.username)) { factOf(a, b); nearInCampaign.add(pairKey(a.id, b.id)) }
  }

  // Two profiles of ONE person that are both members of one campaign: the
  // campaign counts her twice (a merge that joins persons can leave this
  // behind, and so can rows added by hand), whatever their handles look like
  const ownCampaigns = new Map<string, Set<string>>()
  for (const m of u.memberships) {
    const set = ownCampaigns.get(m.influencerId) ?? new Set<string>()
    set.add(m.campaignId)
    ownCampaigns.set(m.influencerId, set)
  }
  for (const list of membersOf.values()) {
    const byPerson = new Map<string, UProfile[]>()
    for (const p of list) if (p.personId) bucket(byPerson, p.personId, p)
    for (const group of byPerson.values()) for (const [a, b] of pairsOf(group, 400)) factOf(a, b)
  }

  // A second coincidence for near handles of one network: the same display name, or a link to the same third account
  const coincidence = new Map<string, UProfile[]>()
  for (const p of profiles) {
    if (!u.relevant.has(p.id)) continue
    if (p.nameKey) bucket(coincidence, `${p.platform}|name|${p.nameKey}`, p)
    for (const l of p.links) bucket(coincidence, `${p.platform}|link|${l.platform}|${l.handle}`, p)
  }
  for (const [key, list] of coincidence) {
    for (const [a, b] of pairsOf(list)) {
      if (!handlesAreNear(a.username, b.username)) continue
      if (key.includes('|name|')) {
        factOf(a, b)!.coincidences.push({ kind: 'name', text: `y el mismo nombre (${quoted(a.displayName ?? '')})` })
      } else {
        const [, , platform, handle] = key.split('|')
        if (handle === a.norm || handle === b.norm) continue
        factOf(a, b)!.coincidences.push({ kind: 'third_link', text: `y las dos enlazan ${linkText({ platform: platform as Platform, handle })}` })
      }
    }
  }

  const campaignsOfPerson = campaignsByPerson(u)

  const out: RawPair[] = []
  for (const [key, f] of facts) {
    const { a, b } = f
    // Two profiles already of one person are proposed only when both are
    // members of one campaign (a certain double count); otherwise there is
    // nothing to merge
    const samePerson = !!a.personId && a.personId === b.personId
    const ownA = ownCampaigns.get(a.id)
    const coMembers = ownA ? Array.from(ownCampaigns.get(b.id) ?? []).filter(c => ownA.has(c)) : []
    if (samePerson && coMembers.length === 0) continue
    if (u.dismissed.has(key)) continue
    // A profile absorbed by a merge in force is not proposed again while it is
    // nobody's member; added again to a campaign it counts again, so it shows
    if ((u.absorbed.has(a.id) && !ownCampaigns.has(a.id)) || (u.absorbed.has(b.id) && !ownCampaigns.has(b.id))) continue
    if (!u.relevant.has(a.id) && !u.relevant.has(b.id)) continue

    const ca = campaignsOfPerson.get(personKeyOf(a)) ?? new Set<string>()
    const cb = campaignsOfPerson.get(personKeyOf(b)) ?? new Set<string>()
    const shared = samePerson ? coMembers : Array.from(ca).filter(c => cb.has(c))
    const near = nearInCampaign.has(key) || handlesAreNear(a.username, b.username)
    const sameNetwork = a.platform === b.platform
    // A link to the same handle on ANOTHER network than the profile's own is
    // not a link to that profile: it is only the same handle on two networks
    const linksTo = (l: { fromId: string; link: ProfileLink }) => l.link.platform === (l.fromId === a.id ? b : a).platform
    const exactLinks = f.links.filter(linksTo)
    const crossLinks = f.links.length - exactLinks.length
    const matches = f.sameHandle || f.caseVariant || f.links.length > 0 || near

    let kind: MergeEvidenceCode | null = null
    if (samePerson) kind = 'same_campaign'
    else if (shared.length > 0 && matches) kind = 'same_campaign'
    else if (exactLinks.length > 0) kind = 'links_to_other'
    else if (f.caseVariant) kind = 'case_only'
    else if (f.sameHandle || crossLinks > 0) kind = 'same_handle_cross_network'
    else if (sameNetwork && near && f.coincidences.length > 0 && u.relevant.has(a.id) && u.relevant.has(b.id)) kind = 'near_handle'
    if (!kind) continue

    const A = describe(a)
    const B = describe(b)
    const evidence: MergeEvidence[] = []
    if (kind === 'same_campaign') {
      const names = shared.map(id => quoted(u.campaigns.get(id)?.name ?? id)).join(', ')
      evidence.push({
        code: 'same_campaign',
        text: samePerson
          ? `${A} y ${B} ya son perfiles de la misma persona y las dos son miembros de ${names}: la campaña cuenta a la misma creadora dos veces.`
          : `${A} y ${B} están las dos en ${names}: la campaña cuenta a la misma creadora dos veces.`,
      })
    }
    for (const l of f.links) {
      const { fromId, link } = l
      const from = fromId === a.id ? a : b
      const to = fromId === a.id ? b : a
      evidence.push({
        code: linksTo(l) ? 'links_to_other' : 'same_handle_cross_network',
        text: link.platform === to.platform
          ? `${describe(from)} enlaza ${linkText(link)} en su web o bio, que es ${describe(to)}.`
          : `${describe(from)} enlaza ${linkText(link)} en su web o bio, y @${to.username} está registrado como perfil de ${net(to.platform)}, no de ${net(link.platform)}.`,
      })
    }
    if (f.caseVariant) evidence.push({ code: 'case_only', text: `${A} y ${B} solo se diferencian en mayúsculas, puntos o guiones bajos.` })
    if (f.sameHandle) evidence.push({ code: 'same_handle_cross_network', text: `${A} y ${B} tienen el mismo usuario en dos redes.` })
    if (near && !f.caseVariant && !f.sameHandle && (kind === 'same_campaign' || kind === 'near_handle')) {
      const coinc = kind === 'near_handle' ? f.coincidences.map(c => c.text) : []
      evidence.push({ code: 'near_handle', text: `${A} y ${B} tienen usuarios casi iguales${coinc.length ? ` ${Array.from(new Set(coinc)).join(' ')}` : ''}.` })
    }

    const starts = [...ca, ...cb].map(id => u.campaigns.get(id)?.startDate.getTime()).filter((t): t is number => typeof t === 'number')
    out.push({ key, a, b, kind, evidence, shared, latest: starts.length ? Math.max(...starts) : null })
  }
  return out
}

function sortCandidates<T extends { kind: MergeEvidenceCode; key: string; latest: number | null }>(list: T[]): T[] {
  return list.sort((x, y) =>
    Number(y.kind === 'same_campaign') - Number(x.kind === 'same_campaign') ||
    STRENGTH_RANK[MERGE_STRENGTH[x.kind]] - STRENGTH_RANK[MERGE_STRENGTH[y.kind]] ||
    (y.latest ?? -Infinity) - (x.latest ?? -Infinity) ||
    x.key.localeCompare(y.key)
  )
}

interface ProfileStats {
  campaigns: MergeProfileCampaign[]
  pieces: number
  ownPieces: number
  /** A social account connection (token) hangs from this profile */
  hasToken: boolean
}

/** At most this many followers (once read) and nothing of her own: a wrong or abandoned handle. */
export const WRONG_HANDLE_MAX_FOLLOWERS = 5
/** Above this many followers a profile is a real account: never suggested to be absorbed. */
export const REAL_ACCOUNT_MIN_FOLLOWERS = 100

/**
 * Why a profile looks like a wrong or old handle next to the other one (empty
 * = it does not). Never a profile with pieces of its own, a connected account
 * or a real audience: absorbing it would stop reading a real account. A
 * profile never read (lastScraped null) has UNKNOWN followers, not 0. The link
 * rule is the pattern of a TikTok handle saved on the kept profile's own
 * network (the other profile links tiktok.com/@X and @X is stored as a profile
 * of the network the kept profile is on); a link to the same handle on a third
 * network says nothing about this profile.
 */
function wrongHandleReasons(p: UProfile & ProfileStats, other: UProfile): string[] {
  if (p.ownPieces > 0 || p.hasToken || p.followers > REAL_ACCOUNT_MIN_FOLLOWERS) return []
  const reasons: string[] = []
  const followersKnown = p.followers > 0 || p.lastScraped !== null
  if (followersKnown && p.followers <= WRONG_HANDLE_MAX_FOLLOWERS) reasons.push(`${describe(p)} tiene ${p.followers} seguidores y ninguna publicación propia`)
  const link = p.platform === other.platform ? other.links.find(l => l.handle === p.norm && l.platform !== p.platform) : undefined
  if (link) reasons.push(`${describe(other)} enlaza ${linkText(link)}: es su cuenta de ${net(link.platform)}, guardada como ${net(p.platform)}`)
  return reasons
}

/** Which profile stays and what the other one is. Pure. */
function suggestMerge(a: UProfile & ProfileStats, b: UProfile & ProfileStats): MergeSuggestion {
  const wa = wrongHandleReasons(a, b)
  const wb = wrongHandleReasons(b, a)
  const ranked = [a, b].sort((x, y) =>
    y.campaigns.length - x.campaigns.length ||
    y.ownPieces - x.ownPieces ||
    y.pieces - x.pieces ||
    y.followers - x.followers ||
    x.createdAt.getTime() - y.createdAt.getTime() ||
    x.id.localeCompare(y.id)
  )
  if (wa.length > 0 && wb.length === 0) return { keepId: b.id, otherId: a.id, mode: 'absorb', reason: `${wa.join('; ')}: parece un usuario equivocado o antiguo.` }
  if (wb.length > 0 && wa.length === 0) return { keepId: a.id, otherId: b.id, mode: 'absorb', reason: `${wb.join('; ')}: parece un usuario equivocado o antiguo.` }
  const [keep, other] = ranked
  if (wa.length > 0 && wb.length > 0) {
    return { keepId: keep.id, otherId: other.id, mode: 'absorb', reason: `Las dos parecen usuarios equivocados; se queda ${describe(keep)}, con más campañas o publicaciones.` }
  }
  return {
    keepId: keep.id,
    otherId: other.id,
    mode: 'link',
    reason: keep.platform !== other.platform
      ? `Las dos son cuentas reales, en ${net(keep.platform)} y en ${net(other.platform)}: se unen como perfiles de la misma persona y se queda ${describe(keep)}, con más campañas o publicaciones.`
      : `Las dos parecen cuentas reales: se unen como perfiles de la misma persona y se queda ${describe(keep)}, con más campañas o publicaciones.`,
  }
}

/**
 * Pairs of profiles that may be the same person (READ ONLY), strongest first:
 * `same_campaign` (both persons are members of one campaign and the handles
 * match, are linked or are near: the campaign counts her twice today), then
 * by strength, then by the most recent campaign. Never on e-mail, phone or
 * name alone; never two profiles that already are one person, unless both are
 * members of one campaign (she is counted twice there: `same_campaign`, so
 * the ADMIN can fold them); never a pair the ADMIN dismissed. With
 * `campaignId`: only pairs where at least one of the two persons is a member
 * of that campaign.
 */
export async function findMergeCandidates(args: { campaignId?: string } = {}): Promise<MergeCandidate[]> {
  const u = await loadUniverse()
  let pairs = computePairs(u)

  const campaignsOfPerson = campaignsByPerson(u)
  if (args.campaignId) {
    const cid = args.campaignId
    pairs = pairs.filter(p => campaignsOfPerson.get(personKeyOf(p.a))?.has(cid) || campaignsOfPerson.get(personKeyOf(p.b))?.has(cid))
  }
  if (pairs.length === 0) return []

  // Pieces of the profiles in the list, read once
  const ids = Array.from(new Set(pairs.flatMap(p => [p.a.id, p.b.id])))
  const [perCampaign, ownCredited, ownPublished, tokens] = await Promise.all([
    prisma.media.groupBy({ by: ['campaignId', 'influencerId'], where: { influencerId: { in: ids }, campaignId: { not: null } }, _count: { _all: true } }),
    prisma.media.groupBy({ by: ['influencerId'], where: { influencerId: { in: ids }, campaignId: { not: null }, publishedByInfluencerId: null }, _count: { _all: true } }),
    prisma.media.groupBy({ by: ['publishedByInfluencerId'], where: { publishedByInfluencerId: { in: ids }, campaignId: { not: null } }, _count: { _all: true } }),
    prisma.socialToken.findMany({ where: { influencerId: { in: ids } }, select: { influencerId: true } }),
  ])
  const withToken = new Set(tokens.map(t => t.influencerId).filter((x): x is string => !!x))
  const piecesAt = new Map(perCampaign.map(r => [`${r.campaignId}|${r.influencerId}`, r._count._all]))
  const own = new Map<string, number>()
  for (const r of ownCredited) own.set(r.influencerId, (own.get(r.influencerId) ?? 0) + r._count._all)
  for (const r of ownPublished) if (r.publishedByInfluencerId) own.set(r.publishedByInfluencerId, (own.get(r.publishedByInfluencerId) ?? 0) + r._count._all)

  const profilesOfPerson = new Map<string, UProfile[]>()
  for (const p of u.profiles.values()) {
    if (!p.personId) continue
    const list = profilesOfPerson.get(p.personId) ?? []
    list.push(p)
    profilesOfPerson.set(p.personId, list)
  }
  const membershipsOf = new Map<string, UMembership[]>()
  for (const m of u.memberships) {
    const list = membershipsOf.get(m.influencerId) ?? []
    list.push(m)
    membershipsOf.set(m.influencerId, list)
  }

  const stats = (p: UProfile): UProfile & ProfileStats => {
    const campaigns = (membershipsOf.get(p.id) ?? [])
      .map(m => {
        const c = u.campaigns.get(m.campaignId)
        return {
          id: m.campaignId,
          name: c?.name ?? m.campaignId,
          campaignStatus: c?.status ?? 'ACTIVE',
          startDate: (c?.startDate ?? new Date(0)).toISOString(),
          membershipStatus: m.status,
          pieces: piecesAt.get(`${m.campaignId}|${p.id}`) ?? 0,
          hasFee: m.hasFee,
        }
      })
      .sort((x, y) => y.startDate.localeCompare(x.startDate) || x.id.localeCompare(y.id))
    return { ...p, campaigns, pieces: campaigns.reduce((s, c) => s + c.pieces, 0), ownPieces: own.get(p.id) ?? 0, hasToken: withToken.has(p.id) }
  }
  const summary = (p: UProfile & ProfileStats): MergeProfileSummary => ({
    id: p.id,
    username: p.username,
    platform: p.platform,
    followers: p.followers,
    displayName: p.displayName,
    personId: p.personId,
    otherProfiles: (p.personId ? profilesOfPerson.get(p.personId) ?? [] : [])
      .filter(o => o.id !== p.id)
      .map(o => ({ id: o.id, username: o.username, platform: o.platform, followers: o.followers })),
    campaigns: p.campaigns,
    pieces: p.pieces,
    ownPieces: p.ownPieces,
  })

  const toCandidate = (pair: RawPair): MergeCandidate => {
    const a = stats(pair.a)
    const b = stats(pair.b)
    const suggestion = suggestMerge(a, b)
    const [keep, other] = suggestion.keepId === a.id ? [a, b] : [b, a]
    // The suggested merge folds a campaign only where the other PROFILE itself
    // is a member (buildPlan); where only another profile of her person is,
    // the campaign keeps its count
    const otherIsMember = new Set((membershipsOf.get(other.id) ?? []).map(m => m.campaignId))
    return {
      key: pair.key,
      kind: pair.kind,
      strength: MERGE_STRENGTH[pair.kind],
      profiles: [summary(keep), summary(other)],
      evidence: pair.evidence,
      sharedCampaigns: pair.shared
        .map(id => {
          const before = u.membersPerCampaign.get(id) ?? 0
          return { id, name: u.campaigns.get(id)?.name ?? id, membersBefore: before, membersAfter: otherIsMember.has(id) ? Math.max(0, before - 1) : before }
        })
        .sort((x, y) => (u.campaigns.get(y.id)?.startDate.getTime() ?? 0) - (u.campaigns.get(x.id)?.startDate.getTime() ?? 0)),
      suggestion,
      latestCampaignAt: pair.latest === null ? null : new Date(pair.latest).toISOString(),
    }
  }
  return sortCandidates(pairs).map(toCandidate)
}

/** How many `same_campaign` candidates (profiles counted twice) a campaign has: the banner of the campaign page. Light: reads only that campaign's persons. */
export async function countSameCampaignCandidates(campaignId: string): Promise<number> {
  const u = await loadUniverse(campaignId)
  return computePairs(u).filter(p => p.kind === 'same_campaign' && p.shared.includes(campaignId)).length
}

// ===========================================================================
// The plan of a merge (read-only; shared by preview and apply)
// ===========================================================================

export interface MergeProfileBrief {
  id: string
  username: string
  platform: Platform
  followers: number
  personId: string | null
}

export interface MergeCampaignEffect {
  campaignId: string
  campaignName: string
  campaignStatus: string
  /** fold: the other row joins the person's row; move: the row passes to the kept profile; unchanged: nothing happens here */
  action: 'fold' | 'move' | 'unchanged'
  /** The other profile's membership row in this campaign */
  otherMembershipId: string
  /** fold: the row that stays (it may be another profile of the kept person) */
  survivor: { membershipId: string; influencerId: string; username: string; platform: Platform } | null
  /** Who the pieces are credited to afterwards (fold: the survivor; move: the kept profile) */
  target: { influencerId: string; username: string; platform: Platform } | null
  membersBefore: number
  membersAfter: number
  piecesBefore: number
  /** Equal to piecesBefore, minus the duplicates detached */
  piecesAfter: number
  movedPieces: number
  movedNotes: number
  /** Views, likes, comments, shares, saves and engagements do not change */
  viewsAndEngagements: 'unchanged'
  /** ADMIN screen only */
  costBefore: number
  /** null while a money conflict has no choice */
  costAfter: number | null
  /** Every field that differs between the two rows (fold only) */
  fields: MergeFieldOutcome[]
  /** The fields in conflict (subset of fields) */
  conflicts: MergeFieldOutcome[]
  /** The same post filed under both rows: the richer row stays, the other is detached */
  duplicates: Array<{ keepMediaId: string; detachMediaId: string; platform: string; permalink: string | null }>
  warnings: string[]
}

export interface MergePreview {
  keep: MergeProfileBrief
  other: MergeProfileBrief
  mode: MergeMode
  person: {
    /** The kept person before (null = the kept profile has none) */
    keptPersonId: string | null
    /** A Person row is created (link of two profiles without one) */
    createsPerson: boolean
    /** Profiles that become profiles of the kept person */
    joining: MergeProfileBrief[]
    /** absorb: the other profile ends with no person */
    otherLeavesPerson: boolean
    otherPersonId: string | null
  }
  campaigns: MergeCampaignEffect[]
  warnings: string[]
  missingChoices: Array<{ campaignId: string; group: string; label: string }>
  /** Nothing would change (already one person, no campaign to fold or move) */
  nothingToDo: boolean
  canApply: boolean
  /** Of every row read: apply refuses when it no longer matches */
  fingerprint: string
  /** The one-line summary the log will carry */
  summary: string
}

interface MediaSnap {
  id: string
  campaignId: string | null
  influencerId: string
  publishedByInfluencerId: string | null
  externalId: string | null
  platform: string
  permalink: string | null
  updatedAt: string
  views: number
  likes: number
  comments: number
  shares: number
  saves: number
  reach: number
  impressions: number
  insightsSource: string | null
  thumbnailUrl: string | null
}

interface SettingWrite {
  key: string
  before: string | null
  /** The row's id before (an undo puts a re-keyed row back with its own id) */
  beforeId: string | null
  after: string | null
}

interface ReportHiddenChange {
  key: string
  removed: string[]
  added: string[]
}

interface PlanCampaign {
  effect: MergeCampaignEffect
  otherRow: Row
  survivorRow: Row | null
  merge: MembershipMerge | null
  targetId: string | null
  movePieces: MediaSnap[]
  detach: MediaSnap[]
  notes: Array<{ id: string; influencerId: string }>
  settings: SettingWrite[]
  reportHidden: ReportHiddenChange | null
}

interface ProfileRow {
  id: string
  username: string
  platform: Platform
  personId: string | null
  followers: number
  displayName: string | null
}

interface Plan {
  input: { keepId: string; otherId: string; mode: MergeMode; choices: MergeChoices }
  keep: ProfileRow
  other: ProfileRow
  person: {
    keptPersonId: string | null
    targetPersonId: string | null
    createsPerson: boolean
    joining: ProfileRow[]
    otherLeavesPerson: boolean
    otherPersonId: string | null
    /** Every profile whose personId the merge writes: before → after (after null = cleared; '<new>' = the person it creates) */
    writes: Array<{ id: string; before: string | null; after: string | null | '<new>' }>
  }
  campaigns: PlanCampaign[]
  warnings: string[]
  missing: Array<{ campaignId: string; group: string; label: string }>
  invalid: Array<{ campaignId: string; group: string }>
  nothingToDo: boolean
  fingerprint: string
  summary: string
}

const NEW_PERSON = '<new>' as const

function validateInput(input: unknown): { keepId: string; otherId: string; mode: MergeMode; choices: MergeChoices } {
  const i = (input ?? {}) as { keepId?: unknown; otherId?: unknown; mode?: unknown; choices?: unknown }
  const keepId = typeof i.keepId === 'string' ? i.keepId.trim() : ''
  const otherId = typeof i.otherId === 'string' ? i.otherId.trim() : ''
  if (!keepId || !otherId) throw new MergeError('invalid', 'Indica qué perfil se queda (keepId) y cuál se fusiona (otherId).')
  if (keepId === otherId) throw new MergeError('invalid', 'Un perfil no se puede fusionar consigo mismo.')
  if (i.mode !== 'link' && i.mode !== 'absorb') throw new MergeError('invalid', 'El modo tiene que ser «link» (otro perfil suyo) o «absorb» (un usuario equivocado o antiguo).')
  const choices: MergeChoices = {}
  if (i.choices !== undefined && i.choices !== null) {
    if (typeof i.choices !== 'object' || Array.isArray(i.choices)) throw new MergeError('invalid', 'Las elecciones tienen que ir por campaña y por campo.')
    for (const [campaignId, perField] of Object.entries(i.choices as Record<string, unknown>)) {
      if (!perField || typeof perField !== 'object' || Array.isArray(perField)) throw new MergeError('invalid', 'Las elecciones tienen que ir por campaña y por campo.')
      const clean: Partial<Record<string, MergeChoice>> = {}
      for (const [group, choice] of Object.entries(perField as Record<string, unknown>)) {
        if (choice === null || choice === undefined) continue
        if (typeof choice !== 'string' || !(MERGE_CHOICES as readonly string[]).includes(choice)) {
          throw new MergeError('invalid', `La elección de «${group}» tiene que ser keep, other o add.`)
        }
        clean[group] = choice as MergeChoice
      }
      choices[campaignId] = clean
    }
  }
  return { keepId, otherId, mode: i.mode, choices }
}

function richness(m: MediaSnap): number[] {
  return [
    m.insightsSource ? 1 : 0,
    (m.views || 0) + (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0) + (m.reach || 0) + (m.impressions || 0),
    m.thumbnailUrl ? 1 : 0,
  ]
}
function richer(a: MediaSnap, b: MediaSnap): boolean {
  const x = richness(a)
  const y = richness(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
/** The keys a post is known by: the shared helper of the capture (shortcode, else externalId) and its externalId. */
function postKeys(m: MediaSnap): string[] {
  const keys = [mediaPostKey(m)]
  if (m.externalId) keys.push(`${m.platform}|ext:${m.externalId}`)
  return keys.filter(k => !k.startsWith('id|'))
}

async function readProfiles(db: Db, ids: string[]): Promise<ProfileRow[]> {
  if (ids.length === 0) return []
  return db.influencer.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, platform: true, personId: true, followers: true, displayName: true }, orderBy: { id: 'asc' } })
}

async function buildPlan(db: Db, input: ReturnType<typeof validateInput>): Promise<Plan> {
  const { keepId, otherId, mode, choices } = input
  const [keep, other] = await Promise.all([readProfiles(db, [keepId]).then(r => r[0]), readProfiles(db, [otherId]).then(r => r[0])])
  if (!keep || !other) throw new MergeError('not_found', 'No encuentro uno de los dos perfiles.')

  // ----- Persons
  const personIds = Array.from(new Set([keep.personId, other.personId].filter((x): x is string => !!x)))
  const personProfiles = personIds.length === 0
    ? []
    : await db.influencer.findMany({ where: { personId: { in: personIds } }, select: { id: true, username: true, platform: true, personId: true, followers: true, displayName: true }, orderBy: { id: 'asc' } })
  const ofKept = keep.personId ? personProfiles.filter(p => p.personId === keep.personId) : [keep]
  const ofOtherRest = other.personId && other.personId !== keep.personId ? personProfiles.filter(p => p.personId === other.personId && p.id !== other.id) : []
  const alreadyOnePerson = !!other.personId && other.personId === keep.personId
  const joining = [...ofOtherRest, ...(mode === 'link' && !alreadyOnePerson ? [other] : [])]

  let targetPersonId: string | null = keep.personId
  let createsPerson = false
  if (!targetPersonId && joining.length > 0) {
    if (other.personId && ofOtherRest.length > 0) targetPersonId = other.personId
    else if (mode === 'link' && other.personId) targetPersonId = other.personId
    else createsPerson = true
  }
  const target = createsPerson ? NEW_PERSON : targetPersonId
  const writes: Plan['person']['writes'] = []
  if (target && keep.personId !== target) writes.push({ id: keep.id, before: keep.personId, after: target })
  for (const p of joining) if (p.personId !== target) writes.push({ id: p.id, before: p.personId, after: target })
  if (mode === 'absorb' && other.personId) writes.push({ id: other.id, before: other.personId, after: null })

  // The kept person after the union, the other profile apart
  const kept = new Map<string, ProfileRow>()
  for (const p of [keep, ...ofKept, ...ofOtherRest]) if (p.id !== other.id) kept.set(p.id, p)
  if (keep.personId && keep.personId === other.personId) for (const p of personProfiles) if (p.personId === keep.personId && p.id !== other.id) kept.set(p.id, p)
  const keptIds = Array.from(kept.keys()).sort()

  // ----- The other profile's memberships and the kept person's in those campaigns
  const otherRows = (await db.$queryRaw<Array<{ row: unknown }>>`
    SELECT row_to_json(ci.*) AS row FROM campaign_influencers ci WHERE ci."influencerId" = ${other.id} ORDER BY ci."campaignId", ci.id`).map(r => asJsonObject<Row>(r.row))
  const campaignIds = otherRows.map(r => String(r.campaignId))
  const keptRows = campaignIds.length === 0 || keptIds.length === 0 ? [] : (await db.$queryRaw<Array<{ row: unknown }>>`
    SELECT row_to_json(ci.*) AS row FROM campaign_influencers ci
    WHERE ci."campaignId" IN (${Prisma.join(campaignIds)}) AND ci."influencerId" IN (${Prisma.join(keptIds)})
    ORDER BY ci.id`).map(r => asJsonObject<Row>(r.row))

  // Profiles that JOIN the kept person (the other's other profiles) and are
  // members of a campaign where the kept person is a member too: after the
  // union that campaign has two rows of one person. This merge does not fold
  // them (it folds the other profile's rows only): the preview says so, and
  // the finder then proposes that pair as «cuenta doble».
  const joiningIds = ofOtherRest.map(p => p.id)
  const keptOwnIds = Array.from(new Set([keep.id, ...ofKept.map(p => p.id)])).filter(id => id !== other.id)
  const joiningRows = joiningIds.length === 0 ? [] : await db.campaignInfluencer.findMany({
    where: { influencerId: { in: joiningIds } },
    select: { campaignId: true, influencerId: true, campaign: { select: { name: true } } },
    orderBy: [{ campaignId: 'asc' }, { influencerId: 'asc' }],
  })
  const keptBesideJoining = joiningRows.length === 0 ? [] : await db.campaignInfluencer.findMany({
    where: { campaignId: { in: joiningRows.map(r => r.campaignId) }, influencerId: { in: keptOwnIds } },
    select: { campaignId: true, influencerId: true },
    orderBy: [{ campaignId: 'asc' }, { influencerId: 'asc' }],
  })

  const [campaigns, allMembers, pieceCounts, mediaRows, noteRows, contacts, listItems, poolRows, tokens, publishedElsewhere] = await Promise.all([
    campaignIds.length === 0 ? [] : db.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true, status: true, platforms: true } }),
    campaignIds.length === 0 ? [] : db.campaignInfluencer.findMany({ where: { campaignId: { in: campaignIds } }, select: { campaignId: true, influencerId: true, agreedFee: true, cost: true } }),
    campaignIds.length === 0 ? [] : db.media.groupBy({ by: ['campaignId'], where: { campaignId: { in: campaignIds } }, _count: { _all: true } }),
    campaignIds.length === 0 ? [] : db.$queryRaw<Array<{ row: unknown }>>`
      SELECT json_build_object(
        'id', id, 'campaignId', "campaignId", 'influencerId', "influencerId", 'publishedByInfluencerId', "publishedByInfluencerId",
        'externalId', "externalId", 'platform', platform, 'permalink', permalink, 'updatedAt', "updatedAt",
        'views', views, 'likes', likes, 'comments', comments, 'shares', shares, 'saves', saves, 'reach', reach, 'impressions', impressions,
        'insightsSource', "insightsSource", 'thumbnailUrl', "thumbnailUrl") AS row
      FROM media WHERE "campaignId" IN (${Prisma.join(campaignIds)}) AND "influencerId" IN (${Prisma.join([other.id, ...keptIds])})
      ORDER BY id`,
    campaignIds.length === 0 ? [] : db.campaignNote.findMany({ where: { campaignId: { in: campaignIds }, influencerId: other.id }, select: { id: true, campaignId: true, influencerId: true }, orderBy: { id: 'asc' } }),
    db.contact.count({ where: { influencerId: other.id } }),
    db.listItem.count({ where: { influencerId: other.id } }),
    db.creatorPlatformProfile.count({ where: { influencerId: other.id } }),
    db.socialToken.count({ where: { influencerId: other.id } }),
    mode === 'absorb' ? db.media.count({ where: { publishedByInfluencerId: other.id, influencerId: { not: other.id }, campaignId: { not: null } } }) : Promise.resolve(0),
  ])
  const media = mediaRows.map(r => asJsonObject<MediaSnap>(r.row))
  const campaignById = new Map(campaigns.map(c => [c.id, c]))
  const piecesIn = new Map(pieceCounts.map(c => [String(c.campaignId), c._count._all]))

  // Settings keyed by (campaign, influencer): the client report and ad permissions
  const settingKeys = new Set<string>()
  for (const cid of campaignIds) {
    settingKeys.add(reportConfigKey(cid))
    for (const id of [other.id, ...keptIds]) settingKeys.add(`ad_permissions_${cid}_${id}`)
  }
  const settingRows = settingKeys.size === 0 ? [] : await db.setting.findMany({ where: { key: { in: Array.from(settingKeys) } }, select: { id: true, key: true, value: true }, orderBy: { key: 'asc' } })
  const settingValue = new Map(settingRows.map(s => [s.key, s.value]))
  const settingId = (key: string) => settingRows.find(s => s.key === key)?.id ?? null

  const fingerprint = createHash('sha256').update(canonical({
    keepId, otherId, mode,
    profiles: [keep, other, ...personProfiles].map(p => ({ id: p.id, personId: p.personId })).sort((x, y) => x.id.localeCompare(y.id)),
    memberships: [...otherRows, ...keptRows].sort((x, y) => String(x.id).localeCompare(String(y.id))),
    media: media.map(m => ({ id: m.id, campaignId: m.campaignId, influencerId: m.influencerId, publishedByInfluencerId: m.publishedByInfluencerId, externalId: m.externalId, platform: m.platform, permalink: m.permalink })),
    notes: noteRows,
    settings: settingRows,
  })).digest('hex')

  // ----- Per campaign
  const planCampaigns: PlanCampaign[] = []
  const missing: Plan['missing'] = []
  const invalid: Plan['invalid'] = []
  for (const otherRow of otherRows) {
    const campaignId = String(otherRow.campaignId)
    const campaign = campaignById.get(campaignId)
    const campaignName = campaign?.name ?? campaignId
    const warnings: string[] = []
    const candidates = keptRows.filter(r => String(r.campaignId) === campaignId)
    const survivorRow = candidates.find(r => r.influencerId === keep.id) ??
      [...candidates].sort((x, y) =>
        Number(memberCost(y as { agreedFee?: number | null; cost?: number | null }) > 0) - Number(memberCost(x as { agreedFee?: number | null; cost?: number | null }) > 0) ||
        tsOf(x.createdAt) - tsOf(y.createdAt) ||
        String(x.id).localeCompare(String(y.id)))[0] ?? null
    const action: MergeCampaignEffect['action'] = survivorRow ? 'fold' : mode === 'absorb' ? 'move' : 'unchanged'
    const survivorProfile = survivorRow ? kept.get(String(survivorRow.influencerId)) ?? null : null
    const targetId = action === 'fold' ? String(survivorRow!.influencerId) : action === 'move' ? keep.id : null
    const targetProfile = targetId ? (targetId === keep.id ? keep : kept.get(targetId) ?? null) : null

    const merge = survivorRow ? mergeMembershipRows(survivorRow, otherRow, choices[campaignId] ?? {}) : null
    if (merge) {
      for (const g of merge.missing) missing.push({ campaignId, group: g, label: merge.fields.find(f => f.group === g)?.label ?? g })
      for (const g of merge.invalid) invalid.push({ campaignId, group: g })
    }

    // Pieces of the other profile in this campaign, and the same post under both rows
    const otherMedia = media.filter(m => m.campaignId === campaignId && m.influencerId === other.id)
    const duplicates: MergeCampaignEffect['duplicates'] = []
    const detach: MediaSnap[] = []
    if (action === 'fold') {
      const survivorMedia = media.filter(m => m.campaignId === campaignId && m.influencerId === targetId)
      const byKey = new Map<string, MediaSnap>()
      for (const m of survivorMedia) for (const k of postKeys(m)) if (!byKey.has(k)) byKey.set(k, m)
      const taken = new Set<string>()
      for (const m of otherMedia) {
        const twin = postKeys(m).map(k => byKey.get(k)).find(x => x && !taken.has(x.id))
        if (!twin) continue
        taken.add(twin.id)
        const keepOther = richer(m, twin)
        const [kept_, detached] = keepOther ? [m, twin] : [twin, m]
        detach.push(detached)
        duplicates.push({ keepMediaId: kept_.id, detachMediaId: detached.id, platform: detached.platform, permalink: detached.permalink })
      }
    }
    const detachIds = new Set(detach.map(d => d.id))
    const movePieces = action === 'unchanged' ? [] : otherMedia.filter(m => !detachIds.has(m.id))
    const notes = action === 'unchanged' ? [] : noteRows.filter(n => n.campaignId === campaignId).map(n => ({ id: n.id, influencerId: n.influencerId }))

    // Settings of this campaign
    const settings: SettingWrite[] = []
    let reportHidden: ReportHiddenChange | null = null
    if (action !== 'unchanged' && targetId) {
      const rKey = reportConfigKey(campaignId)
      const raw = settingValue.get(rKey)
      if (raw !== undefined) {
        let config: unknown = null
        try { config = JSON.parse(raw) } catch { /* unreadable */ }
        const hidden = rawHiddenList(config)
        if (config === null) {
          warnings.push(`No se puede leer la configuración del informe del cliente de ${quoted(campaignName)}: no se toca; revisa a mano si ocultaba a ${describe(other)}.`)
        } else if (hidden) {
          const otherHidden = hidden.some(e => isSameId(e, other.id))
          const targetHidden = hidden.some(e => isSameId(e, targetId))
          if (otherHidden) {
            const next = hidden.filter(e => !isSameId(e, other.id))
            const added: string[] = []
            if (action === 'move' && !targetHidden) { next.push(targetId); added.push(targetId) }
            const after = JSON.stringify({ ...(config as Record<string, unknown>), hiddenInfluencerIds: next })
            settings.push({ key: rKey, before: raw, beforeId: settingId(rKey), after })
            reportHidden = { key: rKey, removed: [other.id], added }
          }
          if (action === 'fold' && targetProfile && otherHidden !== targetHidden) {
            warnings.push(otherHidden
              ? `En el informe del cliente de ${quoted(campaignName)} ${describe(other)} está oculta y ${describe(targetProfile)} no: sus publicaciones pasarán a verse en el informe.`
              : `En el informe del cliente de ${quoted(campaignName)} ${describe(targetProfile)} está oculta y ${describe(other)} no: sus publicaciones dejarán de verse en el informe.`)
          }
          if (action === 'move' && otherHidden) warnings.push(`En el informe del cliente de ${quoted(campaignName)} ${describe(other)} estaba oculta: queda oculta ${describe(keep)} en su lugar.`)
        }
        // A detached duplicate named in the report
        if (config && typeof config === 'object' && detach.length > 0) {
          const c = config as { hiddenMediaIds?: unknown; highlightedComments?: unknown }
          const hiddenMedia = Array.isArray(c.hiddenMediaIds) ? c.hiddenMediaIds : []
          const comments = Array.isArray(c.highlightedComments) ? c.highlightedComments as Array<{ mediaId?: unknown }> : []
          for (const d of detach) {
            if (hiddenMedia.some(e => isSameId(e, d.id))) warnings.push(`La publicación duplicada que se aparta en ${quoted(campaignName)} estaba oculta a mano en el informe del cliente: revisa que siga oculta la que se queda.`)
            if (comments.some(x => isSameId(x?.mediaId, d.id))) warnings.push(`Un comentario destacado del informe de ${quoted(campaignName)} apunta a la publicación duplicada que se aparta: cámbialo a la que se queda.`)
          }
        }
      }
      // Ad permissions of the other profile move with it
      const fromKey = `ad_permissions_${campaignId}_${other.id}`
      const toKey = `ad_permissions_${campaignId}_${targetId}`
      const fromRaw = settingValue.get(fromKey)
      if (fromRaw !== undefined) {
        const toRaw = settingValue.get(toKey)
        let from: unknown = null
        let to: unknown = []
        try { from = JSON.parse(fromRaw) } catch { /* unreadable */ }
        try { to = toRaw === undefined ? [] : JSON.parse(toRaw) } catch { to = null }
        if (Array.isArray(from) && Array.isArray(to)) {
          const moved = from.map(p => (p && typeof p === 'object' && (p as { creatorId?: unknown }).creatorId === other.id ? { ...(p as object), creatorId: targetId } : p))
          settings.push({ key: toKey, before: toRaw ?? null, beforeId: settingId(toKey), after: JSON.stringify([...to, ...moved]) })
          settings.push({ key: fromKey, before: fromRaw, beforeId: settingId(fromKey), after: null })
          if (from.length > 0) warnings.push(`Los permisos de anuncios de ${describe(other)} en ${quoted(campaignName)} pasan a ${describe(targetProfile ?? keep)}.`)
        } else {
          warnings.push(`Los permisos de anuncios de ${describe(other)} en ${quoted(campaignName)} no se pueden leer: se quedan con su usuario.`)
        }
      }
    }

    // Who reads the other account afterwards (never a silent pause of the capture)
    if (action === 'fold' && mode === 'link' && campaign) {
      const status = merge ? String(merge.merged.status) : String(survivorRow!.status)
      const readWarning = other.platform === 'TIKTOK'
        ? foldedTikTokReadWarning({ campaignStatus: campaign.status, campaignPlatforms: campaign.platforms, folded: other, survivor: { username: survivorProfile?.username ?? keep.username, platform: survivorProfile?.platform ?? keep.platform, status } })
        : campaign.status === 'ACTIVE'
          ? `después de fusionarla nadie lee ${describe(other)} en esta campaña: solo se leen las cuentas de las fichas; sus publicaciones nuevas se añaden con «Añadir publicación por URL»`
          : null
      if (readWarning) warnings.push(`${quoted(campaignName)}: ${readWarning}.`)
    }
    if (action === 'fold' && survivorProfile && survivorProfile.id !== keep.id) {
      warnings.push(`En ${quoted(campaignName)} la ficha que se queda es la de ${describe(survivorProfile)}, otro perfil de la misma persona.`)
    }
    const otherMembersOfPerson = candidates.filter(r => r !== survivorRow)
    if (action === 'fold' && otherMembersOfPerson.length > 0) {
      const names = otherMembersOfPerson.map(r => kept.get(String(r.influencerId))).filter((p): p is ProfileRow => !!p).map(describe)
      warnings.push(`En ${quoted(campaignName)} ${names.join(', ')} también ${names.length === 1 ? 'es miembro' : 'son miembros'} y es de la misma persona: sigue contando aparte; revísala por separado.`)
    }
    if (action === 'unchanged') {
      warnings.push(`${describe(other)} sigue siendo miembro de ${quoted(campaignName)}: la persona cuenta en esa campaña a través de este perfil.`)
    }

    // Counts and cost
    const members = allMembers.filter(m => m.campaignId === campaignId)
    const costBefore = round2(members.reduce((s, m) => s + memberCost(m), 0))
    let costAfter: number | null = costBefore
    if (action === 'fold' && merge) {
      costAfter = merge.missing.some(g => ['agreedFee', 'cost'].includes(g))
        ? null
        : round2(costBefore - memberCost(otherRow as { agreedFee?: number | null; cost?: number | null }) - memberCost(survivorRow as { agreedFee?: number | null; cost?: number | null }) + memberCost(merge.merged as { agreedFee?: number | null; cost?: number | null }))
    }
    const piecesBefore = piecesIn.get(campaignId) ?? 0

    planCampaigns.push({
      effect: {
        campaignId,
        campaignName,
        campaignStatus: campaign?.status ?? 'ACTIVE',
        action,
        otherMembershipId: String(otherRow.id),
        survivor: survivorRow && survivorProfile
          ? { membershipId: String(survivorRow.id), influencerId: survivorProfile.id, username: survivorProfile.username, platform: survivorProfile.platform }
          : null,
        target: targetProfile ? { influencerId: targetProfile.id, username: targetProfile.username, platform: targetProfile.platform } : null,
        membersBefore: members.length,
        membersAfter: action === 'fold' ? members.length - 1 : members.length,
        piecesBefore,
        piecesAfter: piecesBefore - detach.length,
        movedPieces: movePieces.length,
        movedNotes: notes.length,
        viewsAndEngagements: 'unchanged',
        costBefore,
        costAfter,
        fields: merge?.fields ?? [],
        conflicts: merge?.fields.filter(f => f.conflict) ?? [],
        duplicates,
        warnings,
      },
      otherRow,
      survivorRow,
      merge,
      targetId,
      movePieces,
      detach,
      notes,
      settings,
      reportHidden,
    })
  }

  // ----- Warnings of the whole merge
  const warnings: string[] = []
  if (mode === 'absorb') {
    warnings.push(`${describe(other)} deja de rastrearse: sale de todas sus campañas${other.personId ? ' y deja de ser perfil de la persona' : ''}. Sus publicaciones se quedan, acreditadas a la ficha que se queda.`)
    if (publishedElsewhere > 0) warnings.push(`${publishedElsewhere} ${publishedElsewhere === 1 ? 'publicación que publicó' : 'publicaciones que publicó'} ${describe(other)} y ${publishedElsewhere === 1 ? 'cuenta' : 'cuentan'} para otra ficha se ${publishedElsewhere === 1 ? 'queda' : 'quedan'} como está${publishedElsewhere === 1 ? '' : 'n'}.`)
  }
  const stays: string[] = []
  if (contacts > 0) stays.push(`${contacts} ${contacts === 1 ? 'contacto' : 'contactos'}`)
  if (listItems > 0) stays.push(`${listItems} ${listItems === 1 ? 'lista' : 'listas'}`)
  if (poolRows > 0) stays.push(`su ficha en la base de creadoras`)
  if (tokens > 0) stays.push(`${tokens} ${tokens === 1 ? 'conexión de cuenta' : 'conexiones de cuenta'}`)
  if (stays.length > 0) warnings.push(`Se quedan en ${describe(other)}, sin moverse: ${stays.join(', ')}.`)
  if (ofOtherRest.length > 0) warnings.push(`También pasan a ser perfiles de la persona que se queda: ${ofOtherRest.map(describe).join(', ')}.`)
  const profileById = new Map(personProfiles.map(p => [p.id, p]))
  profileById.set(keep.id, keep)
  for (const r of joiningRows) {
    const beside = keptBesideJoining.filter(k => k.campaignId === r.campaignId).map(k => profileById.get(k.influencerId)).filter((p): p is ProfileRow => !!p)
    const joiner = profileById.get(r.influencerId)
    if (beside.length === 0 || !joiner) continue
    warnings.push(
      `En ${quoted(r.campaign.name)} ${describe(joiner)} y ${beside.map(describe).join(', ')} son miembros y pasan a ser perfiles de la misma persona: esta fusión no las une y la campaña la sigue contando dos veces. Después aparecerán en «Fichas duplicadas» como cuenta doble para fusionarlas.`
    )
  }

  const nothingToDo = writes.length === 0 && !createsPerson && planCampaigns.every(c => c.effect.action === 'unchanged')

  // ----- The summary the log carries
  const parts = planCampaigns
    .filter(c => c.effect.action !== 'unchanged')
    .map(c => c.effect.action === 'fold'
      ? `${quoted(c.effect.campaignName)} ${c.effect.membersBefore} → ${c.effect.membersAfter} creadoras`
      : `${quoted(c.effect.campaignName)}: su ficha pasa a @${keep.username}`)
  const summary = `${describe(other)} ${mode === 'absorb' ? 'fusionada en' : 'unida como perfil de'} ${describe(keep)}: ${parts.length ? parts.join('; ') : 'sin campañas que cambien'}`

  return {
    input,
    keep,
    other,
    person: {
      keptPersonId: keep.personId,
      targetPersonId,
      createsPerson,
      joining,
      otherLeavesPerson: mode === 'absorb' && !!other.personId,
      otherPersonId: other.personId,
      writes,
    },
    campaigns: planCampaigns,
    warnings,
    missing,
    invalid,
    nothingToDo,
    fingerprint,
    summary,
  }
}

const brief = (p: ProfileRow): MergeProfileBrief => ({ id: p.id, username: p.username, platform: p.platform, followers: p.followers, personId: p.personId })

function previewOf(plan: Plan): MergePreview {
  return {
    keep: brief(plan.keep),
    other: brief(plan.other),
    mode: plan.input.mode,
    person: {
      keptPersonId: plan.person.keptPersonId,
      createsPerson: plan.person.createsPerson,
      joining: plan.person.joining.map(brief),
      otherLeavesPerson: plan.person.otherLeavesPerson,
      otherPersonId: plan.person.otherPersonId,
    },
    campaigns: plan.campaigns.map(c => c.effect),
    warnings: plan.warnings,
    missingChoices: plan.missing,
    nothingToDo: plan.nothingToDo,
    canApply: plan.missing.length === 0 && plan.invalid.length === 0 && !plan.nothingToDo,
    fingerprint: plan.fingerprint,
    summary: plan.summary,
  }
}

/** What merging would do, campaign by campaign (READ ONLY). */
export async function previewMerge(input: { keepId: string; otherId: string; mode: MergeMode; choices?: MergeChoices }): Promise<MergePreview> {
  const plan = await buildPlan(prisma, validateInput(input))
  if (plan.invalid.length > 0) throw new MergeError('invalid', `Elección no válida para: ${plan.invalid.map(i => i.group).join(', ')}.`)
  return previewOf(plan)
}

// ===========================================================================
// Apply
// ===========================================================================

export interface MergeApplyResult {
  logId: string
  summary: string
  keepId: string
  otherId: string
  mode: MergeMode
  /** The kept person after the merge (null when none was needed) */
  personId: string | null
  campaigns: Array<{
    campaignId: string
    campaignName: string
    action: MergeCampaignEffect['action']
    membersBefore: number
    membersAfter: number
    piecesBefore: number
    piecesAfter: number
    costBefore: number
    costAfter: number | null
  }>
  warnings: string[]
}

interface MergeLogBefore {
  version: 1
  mode: MergeMode
  keepId: string
  otherId: string
  /** personId before of every profile the merge wrote */
  profiles: Array<{ id: string; personId: string | null }>
  /** Every membership row the merge wrote or deleted, all columns as they were */
  memberships: Row[]
  media: Array<{ id: string; campaignId: string | null; influencerId: string; publishedByInfluencerId: string | null; updatedAt: string }>
  notes: Array<{ id: string; influencerId: string }>
  /** value null = the setting did not exist; id = its row id, to put a re-keyed row back as it was */
  settings: Array<{ key: string; value: string | null; id?: string | null }>
}

interface MergeLogAfter {
  version: 1
  mode: MergeMode
  keepId: string
  otherId: string
  pair: [string, string]
  personId: string | null
  createdPersonId: string | null
  profiles: Array<{ id: string; personId: string | null }>
  /** row null = deleted by the merge */
  memberships: Array<{ id: string; row: Row | null }>
  media: Array<{ id: string; campaignId: string | null; influencerId: string; publishedByInfluencerId: string | null }>
  notes: Array<{ id: string; influencerId: string }>
  settings: Array<{ key: string; value: string | null }>
  reportHidden: ReportHiddenChange[]
  campaigns: Array<MergeApplyResult['campaigns'][number] & { otherMembershipId: string; survivorMembershipId: string | null; targetInfluencerId: string | null }>
  fingerprint: string
}

/** Lock what a merge of the pair touches, always in the same order: profiles, memberships, settings, pieces, notes. */
async function lockForMerge(tx: Prisma.TransactionClient, keepId: string, otherId: string): Promise<void> {
  const pair = [keepId, otherId].sort()
  const rows = await tx.$queryRaw<Array<{ id: string; personId: string | null }>>`
    SELECT id, "personId" FROM influencers WHERE id IN (${Prisma.join(pair)}) ORDER BY id FOR UPDATE`
  const personIds = Array.from(new Set(rows.map(r => r.personId).filter((x): x is string => !!x)))
  const profileIds = new Set(pair)
  if (personIds.length > 0) {
    const more = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM influencers WHERE "personId" IN (${Prisma.join(personIds)}) ORDER BY id FOR UPDATE`
    for (const r of more) profileIds.add(r.id)
  }
  const ids = Array.from(profileIds).sort()
  const memberships = await tx.$queryRaw<Array<{ campaignId: string; influencerId: string }>>`
    SELECT "campaignId", "influencerId" FROM campaign_influencers WHERE "influencerId" IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
  const campaignIds = Array.from(new Set(memberships.filter(m => m.influencerId === otherId).map(m => m.campaignId))).sort()
  if (campaignIds.length === 0) return
  const keys = campaignIds.flatMap(c => [reportConfigKey(c), ...ids.map(i => `ad_permissions_${c}_${i}`)])
  await tx.$queryRaw`SELECT id FROM settings WHERE key IN (${Prisma.join(keys)}) ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM media WHERE "campaignId" IN (${Prisma.join(campaignIds)}) AND "influencerId" IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
  await tx.$queryRaw`SELECT id FROM campaign_notes WHERE "campaignId" IN (${Prisma.join(campaignIds)}) AND "influencerId" = ${otherId} ORDER BY id FOR UPDATE`
}

async function setPersonIds(tx: Prisma.TransactionClient, writes: Array<{ id: string; personId: string | null }>): Promise<void> {
  // Raw on purpose: an identity write leaves the profile's updatedAt alone, so an undo is exact
  for (const w of writes) await tx.$executeRaw`UPDATE influencers SET "personId" = ${w.personId} WHERE id = ${w.id}`
}

/** Write a setting: null removes it; a row that does not exist is created (with `id` when given, the id it had). */
async function writeSetting(tx: Prisma.TransactionClient, key: string, value: string | null, id: string | null = null): Promise<void> {
  if (value === null) {
    await tx.setting.deleteMany({ where: { key } })
    return
  }
  const updated = await tx.setting.updateMany({ where: { key }, data: { value } })
  if (updated.count === 0) await tx.setting.create({ data: { ...(id ? { id } : {}), key, value } })
}

/**
 * Merge `otherId` into `keepId` as previewed. ADMIN only (the route checks the
 * role). One transaction with the rows locked (lock timeout: a clean 409);
 * refused with 409 when the rows changed since the preview (fingerprint) or a
 * conflict without default has no choice. Logged in ONE PersonLog 'merge'.
 */
export async function applyMerge(
  input: { keepId: string; otherId: string; mode: MergeMode; choices?: MergeChoices; fingerprint: string },
  actor: Actor
): Promise<MergeApplyResult> {
  const args = validateInput(input)
  const fingerprint = typeof input?.fingerprint === 'string' ? input.fingerprint.trim() : ''
  if (!fingerprint) throw new MergeError('invalid', 'Falta la huella de la vista previa (fingerprint): revisa la fusión antes de aplicarla.')
  await assertAdminActor(actor)

  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      await lockForMerge(tx, args.keepId, args.otherId)
      const plan = await buildPlan(tx, args)
      if (plan.fingerprint !== fingerprint) throw new MergeError('stale', STALE_TEXT)
      if (plan.invalid.length > 0) throw new MergeError('invalid', `Elección no válida para: ${plan.invalid.map(i => i.group).join(', ')}.`)
      if (plan.missing.length > 0) {
        throw new MergeError('needs_choice', `Falta elegir qué valor se queda en: ${plan.missing.map(m => `${m.label} (${quoted(plan.campaigns.find(c => c.effect.campaignId === m.campaignId)?.effect.campaignName ?? m.campaignId)})`).join(', ')}.`, { missingChoices: plan.missing })
      }
      if (plan.nothingToDo) throw new MergeError('invalid', 'Esta fusión no cambia nada: los dos perfiles ya son de la misma persona y no comparten campañas.')
      return executePlan(tx, plan, actor)
    }, IDENTITY_TX_OPTIONS)
  } catch (err) {
    throw translateDbError(err)
  }
}

async function executePlan(tx: Prisma.TransactionClient, plan: Plan, actor: Actor): Promise<MergeApplyResult> {
  const { keep, other } = plan
  const otherId = other.id
  const now = nowAsStored()

  // 1. One person
  let createdPersonId: string | null = null
  if (plan.person.createsPerson) {
    const person = await tx.person.create({
      data: { displayName: keep.displayName?.trim() || keep.username, createdById: actor?.id ?? null, createdByName: actor?.name ?? null },
      select: { id: true },
    })
    createdPersonId = person.id
  }
  const personWrites = plan.person.writes.map(w => ({ id: w.id, before: w.before, after: w.after === NEW_PERSON ? createdPersonId : w.after }))
  await setPersonIds(tx, personWrites.map(w => ({ id: w.id, personId: w.after })))
  const personId = createdPersonId ?? plan.person.targetPersonId ?? keep.personId ?? null

  // 2. Campaign by campaign
  const before: MergeLogBefore = {
    version: 1,
    mode: plan.input.mode,
    keepId: keep.id,
    otherId,
    profiles: personWrites.map(w => ({ id: w.id, personId: w.before })),
    memberships: [],
    media: [],
    notes: [],
    settings: [],
  }
  const touchedMemberships: string[] = []
  const deletedMemberships = new Set<string>()
  const touchedMedia: string[] = []
  const reportHidden: ReportHiddenChange[] = []
  const seenSettings = new Set<string>()

  for (const c of plan.campaigns) {
    const { effect } = c
    if (effect.action === 'unchanged' || !c.targetId) continue
    const campaignId = effect.campaignId
    const target = c.targetId
    const stale = () => new MergeError('stale', STALE_TEXT)

    if (effect.action === 'fold' && c.survivorRow && c.merge) {
      before.memberships.push(c.survivorRow, c.otherRow)
      touchedMemberships.push(String(c.survivorRow.id))
      if (c.merge.changedColumns.length > 0) {
        const written = await writeRowColumns(tx, 'campaign_influencers', String(c.survivorRow.id), { ...c.merge.merged, updatedAt: now }, [...c.merge.changedColumns, 'updatedAt'])
        if (written !== 1) throw stale()
      }
    } else if (effect.action === 'move') {
      before.memberships.push(c.otherRow)
      const moved = await tx.campaignInfluencer.updateMany({ where: { id: String(c.otherRow.id), campaignId, influencerId: otherId }, data: { influencerId: keep.id } })
      if (moved.count !== 1) throw stale()
    }
    touchedMemberships.push(String(c.otherRow.id))

    // Pieces: credited to the surviving member, keeping who published them
    for (const m of [...c.movePieces, ...c.detach]) {
      before.media.push({ id: m.id, campaignId: m.campaignId, influencerId: m.influencerId, publishedByInfluencerId: m.publishedByInfluencerId, updatedAt: m.updatedAt })
      touchedMedia.push(m.id)
    }
    const ownPieces = c.movePieces.filter(m => !m.publishedByInfluencerId).map(m => m.id)
    const selfPieces = c.movePieces.filter(m => m.publishedByInfluencerId === target).map(m => m.id)
    const otherPieces = c.movePieces.filter(m => m.publishedByInfluencerId && m.publishedByInfluencerId !== target).map(m => m.id)
    let moved = 0
    if (ownPieces.length > 0) moved += (await tx.media.updateMany({ where: { id: { in: ownPieces }, campaignId, influencerId: otherId }, data: { influencerId: target, publishedByInfluencerId: otherId } })).count
    if (selfPieces.length > 0) moved += (await tx.media.updateMany({ where: { id: { in: selfPieces }, campaignId, influencerId: otherId }, data: { influencerId: target, publishedByInfluencerId: null } })).count
    if (otherPieces.length > 0) moved += (await tx.media.updateMany({ where: { id: { in: otherPieces }, campaignId, influencerId: otherId }, data: { influencerId: target } })).count
    if (moved !== c.movePieces.length) throw stale()
    if (c.detach.length > 0) {
      const detached = await tx.media.updateMany({ where: { id: { in: c.detach.map(d => d.id) }, campaignId }, data: { campaignId: null } })
      if (detached.count !== c.detach.length) throw stale()
    }

    // Notes
    if (c.notes.length > 0) {
      before.notes.push(...c.notes)
      const n = await tx.campaignNote.updateMany({ where: { id: { in: c.notes.map(x => x.id) }, campaignId, influencerId: otherId }, data: { influencerId: target } })
      if (n.count !== c.notes.length) throw stale()
    }

    // Settings keyed by (campaign, influencer)
    for (const s of c.settings) {
      if (!seenSettings.has(s.key)) {
        before.settings.push({ key: s.key, value: s.before, id: s.beforeId })
        seenSettings.add(s.key)
      }
      await writeSetting(tx, s.key, s.after)
    }
    if (c.reportHidden) reportHidden.push(c.reportHidden)

    // The folded row goes; nothing of the campaign may stay filed under the other profile
    if (effect.action === 'fold') {
      const deleted = await tx.campaignInfluencer.deleteMany({ where: { id: String(c.otherRow.id), campaignId, influencerId: otherId } })
      if (deleted.count !== 1) throw stale()
      deletedMemberships.add(String(c.otherRow.id))
    }
    const left = await tx.media.count({ where: { campaignId, influencerId: otherId } })
    if (left > 0) throw new MergeError('stale', `Han entrado publicaciones nuevas de ${describe(other)} mientras se fusionaba. Vuelve a revisar la fusión.`)
  }

  // 3. The rows as the merge left them (what undo compares against)
  const keptMembershipIds = touchedMemberships.filter(id => !deletedMemberships.has(id))
  const afterRows = keptMembershipIds.length === 0 ? [] : (await tx.$queryRaw<Array<{ row: unknown }>>`
    SELECT row_to_json(ci.*) AS row FROM campaign_influencers ci WHERE ci.id IN (${Prisma.join(keptMembershipIds)})`).map(r => asJsonObject<Row>(r.row))
  const afterById = new Map(afterRows.map(r => [String(r.id), r]))
  const afterMedia = touchedMedia.length === 0 ? [] : await tx.media.findMany({ where: { id: { in: touchedMedia } }, select: { id: true, campaignId: true, influencerId: true, publishedByInfluencerId: true }, orderBy: { id: 'asc' } })
  const afterNotes = before.notes.length === 0 ? [] : await tx.campaignNote.findMany({ where: { id: { in: before.notes.map(n => n.id) } }, select: { id: true, influencerId: true }, orderBy: { id: 'asc' } })
  const afterSettings = before.settings.length === 0 ? [] : await tx.setting.findMany({ where: { key: { in: before.settings.map(s => s.key) } }, select: { key: true, value: true } })
  const afterSettingByKey = new Map(afterSettings.map(s => [s.key, s.value]))

  const campaigns: MergeLogAfter['campaigns'] = plan.campaigns.map(c => ({
    campaignId: c.effect.campaignId,
    campaignName: c.effect.campaignName,
    action: c.effect.action,
    membersBefore: c.effect.membersBefore,
    membersAfter: c.effect.membersAfter,
    piecesBefore: c.effect.piecesBefore,
    piecesAfter: c.effect.piecesAfter,
    costBefore: c.effect.costBefore,
    costAfter: c.effect.costAfter,
    otherMembershipId: c.effect.otherMembershipId,
    survivorMembershipId: c.effect.survivor?.membershipId ?? null,
    targetInfluencerId: c.targetId,
  }))
  const after: MergeLogAfter = {
    version: 1,
    mode: plan.input.mode,
    keepId: keep.id,
    otherId,
    pair: [keep.id, otherId].sort() as [string, string],
    personId,
    createdPersonId,
    profiles: personWrites.map(w => ({ id: w.id, personId: w.after })),
    memberships: Array.from(new Set(touchedMemberships)).map(id => ({ id, row: deletedMemberships.has(id) ? null : afterById.get(id) ?? null })),
    media: afterMedia,
    notes: afterNotes,
    settings: before.settings.map(s => ({ key: s.key, value: afterSettingByKey.get(s.key) ?? null })),
    reportHidden,
    campaigns,
    fingerprint: plan.fingerprint,
  }
  // De-duplicate the membership snapshots (a survivor is listed once)
  const seenRows = new Set<string>()
  before.memberships = before.memberships.filter(r => (seenRows.has(String(r.id)) ? false : (seenRows.add(String(r.id)), true)))

  const log = await tx.personLog.create({
    data: {
      action: 'merge',
      personId,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      evidence: 'pm_manual',
      summary: plan.summary,
      before: before as unknown as Prisma.InputJsonValue,
      after: after as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  return {
    logId: log.id,
    summary: plan.summary,
    keepId: keep.id,
    otherId,
    mode: plan.input.mode,
    personId,
    campaigns: campaigns.map(c => ({
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      action: c.action,
      membersBefore: c.membersBefore,
      membersAfter: c.membersAfter,
      piecesBefore: c.piecesBefore,
      piecesAfter: c.piecesAfter,
      costBefore: c.costBefore,
      costAfter: c.costAfter,
    })),
    warnings: [...plan.warnings, ...plan.campaigns.flatMap(c => c.effect.warnings)],
  }
}

// ===========================================================================
// Undo
// ===========================================================================

export interface MergeDifference {
  kind: 'membership' | 'piece' | 'note' | 'setting' | 'profile' | 'person'
  id: string
  /** In Spanish, what changed since the merge */
  text: string
  /** Even a forced undo cannot proceed (something now occupies the restored place) */
  blocking: boolean
}

export interface UndoMergeResult {
  undoLogId: string
  /** The log undone (a merge or a dismissal) */
  mergeLogId: string
  kind: 'merge' | 'dismiss_candidate'
  /** It was already undone: nothing changed now */
  alreadyUndone: boolean
  restored: { memberships: number; pieces: number; notes: number; settings: number; profiles: number }
  /** force: what was overwritten (changed since the merge) */
  overwritten: MergeDifference[]
  /** What could not be put back (and why) */
  notRestored: string[]
}

const FIELD_LABEL = new Map<string, string>(MEMBERSHIP_FIELD_GROUPS.flatMap(g => g.columns.map(c => [c, g.label] as [string, string])))

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return 'otro valor'
  return String(v)
}

const ZERO = { memberships: 0, pieces: 0, notes: 0, settings: 0, profiles: 0 }

/**
 * What a forced undo is allowed to overwrite: the differences the ADMIN was
 * shown. The 409 changed_since carries this hash; `force` is accepted only
 * with the same hash, so anything that changed after the list was shown is
 * shown (and asked about) again instead of being overwritten unseen.
 */
export function differencesHash(differences: readonly MergeDifference[]): string {
  const items = differences.map(d => canonical({ kind: d.kind, id: d.id, text: d.text, blocking: d.blocking })).sort()
  return createHash('sha256').update(items.join('\n')).digest('hex')
}

/** The roster of a campaign read inside a transaction (src/lib/campaign-roster.ts decides; this only reads). */
async function rosterIn(db: Db, campaignId: string): Promise<Roster> {
  const memberships = await db.campaignInfluencer.findMany({
    where: { campaignId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { createdAt: true, agreedFee: true, cost: true, influencer: { select: { id: true, username: true, platform: true, personId: true, followers: true } } },
  })
  const members = memberships.map(ci => ({
    influencerId: ci.influencer.id,
    username: ci.influencer.username,
    platform: ci.influencer.platform,
    personId: ci.influencer.personId,
    followers: ci.influencer.followers,
    createdAt: ci.createdAt,
    hasFee: memberCost(ci) > 0,
  }))
  const personIds = Array.from(new Set(members.map(m => m.personId).filter((x): x is string => !!x)))
  const others = personIds.length === 0 ? [] : await db.influencer.findMany({
    where: { personId: { in: personIds }, id: { notIn: members.map(m => m.influencerId) } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, username: true, platform: true, personId: true, followers: true },
  })
  return buildRoster(members, others.map(p => ({ influencerId: p.id, username: p.username, platform: p.platform, personId: p.personId, followers: p.followers })))
}

/**
 * Undo a merge (or a dismissal) from its log. One transaction. Everything the
 * merge wrote goes back: membership rows with their ids and every column,
 * pieces, notes, settings, personIds, and the person it created. When
 * something it touched changed since (a fee edited on the surviving row, a
 * piece removed or added for the restored profile, a note, a setting, a
 * profile linked elsewhere) it refuses with the differences (MergeError
 * 'changed_since', details.differences and details.differencesHash) unless
 * `force` comes with that same `differencesHash`: a forced undo overwrites
 * exactly what the ADMIN was shown, and anything that changed after the list
 * was shown is refused again with the new list. It then reports what was
 * overwritten. Pieces captured after the merge that the restored profile
 * published go back to its own row, and a piece the merge's union of persons
 * credited across them is credited again as the roster says after the undo.
 * Idempotent: a second undo changes nothing and says so.
 */
export async function undoMerge(logId: string, actor: Actor, options: { force?: boolean; differencesHash?: string } = {}): Promise<UndoMergeResult> {
  const id = typeof logId === 'string' ? logId.trim() : ''
  if (!id) throw new MergeError('invalid', 'Indica qué fusión quieres deshacer.')
  await assertAdminActor(actor)
  try {
    return await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM person_logs WHERE id = ${id} FOR UPDATE`
      if (locked.length === 0) throw new MergeError('not_found', 'No encuentro esa fusión.')
      const log = await tx.personLog.findUnique({ where: { id } })
      if (!log || (log.action !== 'merge' && log.action !== 'dismiss_candidate')) throw new MergeError('not_found', 'No encuentro esa fusión.')
      const kind = log.action as 'merge' | 'dismiss_candidate'

      if (log.undoneAt) {
        const undo = await tx.personLog.findFirst({ where: { action: 'undo', undoOfId: log.id }, orderBy: { createdAt: 'desc' }, select: { id: true } })
        return { undoLogId: undo?.id ?? '', mergeLogId: log.id, kind, alreadyUndone: true, restored: { ...ZERO }, overwritten: [], notRestored: [] }
      }

      if (kind === 'dismiss_candidate') return undoDismissal(tx, log, actor)
      return undoMergeLog(tx, log, actor, options.force === true ? (typeof options.differencesHash === 'string' ? options.differencesHash : '') : null)
    }, IDENTITY_TX_OPTIONS)
  } catch (err) {
    throw translateDbError(err)
  }
}

async function undoDismissal(
  tx: Prisma.TransactionClient,
  log: { id: string; after: unknown; personId: string | null },
  actor: Actor
): Promise<UndoMergeResult> {
  const pair = (log.after as { pair?: unknown } | null)?.pair
  // Every live dismissal of the pair: the pair is proposed again
  const live = await tx.personLog.findMany({ where: { action: 'dismiss_candidate', undoneAt: null }, select: { id: true, after: true } })
  const same = live.filter(l => {
    const p = (l.after as { pair?: unknown } | null)?.pair
    return l.id === log.id || (Array.isArray(pair) && Array.isArray(p) && canonical(p) === canonical(pair))
  })
  await tx.personLog.updateMany({ where: { id: { in: same.map(l => l.id) } }, data: { undoneAt: new Date(), undoneById: actor?.id ?? null } })
  const undo = await tx.personLog.create({
    data: {
      action: 'undo',
      personId: log.personId,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      summary: 'Se vuelve a proponer la pareja como posible ficha duplicada.',
      undoOfId: log.id,
      before: (log.after ?? {}) as Prisma.InputJsonValue,
      after: { pair: Array.isArray(pair) ? pair : null, undoneLogIds: same.map(l => l.id) },
    },
    select: { id: true },
  })
  return { undoLogId: undo.id, mergeLogId: log.id, kind: 'dismiss_candidate', alreadyUndone: false, restored: { ...ZERO }, overwritten: [], notRestored: [] }
}

/** `forcedHash`: null = not forced; else the differencesHash the ADMIN confirmed ('' = none given). */
async function undoMergeLog(
  tx: Prisma.TransactionClient,
  log: { id: string; before: unknown; after: unknown; personId: string | null; summary: string },
  actor: Actor,
  forcedHash: string | null
): Promise<UndoMergeResult> {
  const before = asJsonObject<MergeLogBefore>(log.before)
  const after = asJsonObject<MergeLogAfter>(log.after)
  if (before?.version !== 1 || after?.version !== 1 || !Array.isArray(before.memberships) || !Array.isArray(after.memberships)) {
    throw new MergeError('cannot_undo', 'Esa fusión no guarda lo necesario para deshacerla.')
  }
  const otherId = after.otherId
  const beforeById = new Map(before.memberships.map(r => [String(r.id), r]))
  const campaignName = new Map(after.campaigns.map(c => [c.campaignId, c.campaignName]))
  const profileIds = Array.from(new Set([after.keepId, otherId, ...after.profiles.map(p => p.id)])).sort()

  // Locks: profiles, memberships, settings, pieces, notes (the order of a merge)
  await tx.$queryRaw`SELECT id FROM influencers WHERE id IN (${Prisma.join(profileIds)}) ORDER BY id FOR UPDATE`
  const campaignIds = Array.from(new Set(after.campaigns.filter(c => c.action !== 'unchanged').map(c => c.campaignId))).sort()
  const membershipIds = Array.from(beforeById.keys()).sort()
  if (membershipIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM campaign_influencers WHERE id IN (${Prisma.join(membershipIds)}) OR ("campaignId" IN (${Prisma.join(campaignIds.length ? campaignIds : ['-'])}) AND "influencerId" = ${otherId}) ORDER BY id FOR UPDATE`
  }
  if (after.settings.length > 0) await tx.$queryRaw`SELECT id FROM settings WHERE key IN (${Prisma.join(after.settings.map(s => s.key))}) ORDER BY id FOR UPDATE`
  if (before.media.length > 0) await tx.$queryRaw`SELECT id FROM media WHERE id IN (${Prisma.join(before.media.map(m => m.id))}) ORDER BY id FOR UPDATE`
  // Pieces credited from one profile to another where a profile whose person
  // the undo changes is either side (see «Credited ACROSS» below)
  const splitIds = Array.from(new Set([...before.profiles.map(p => p.id), otherId])).sort()
  const splitLocked = (await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM media
    WHERE "campaignId" IS NOT NULL AND "publishedByInfluencerId" IS NOT NULL AND "publishedByInfluencerId" <> "influencerId"
      AND ("publishedByInfluencerId" IN (${Prisma.join(splitIds)}) OR "influencerId" IN (${Prisma.join(splitIds)}))
    ORDER BY id FOR UPDATE`).map(r => r.id)
  if (before.notes.length > 0) await tx.$queryRaw`SELECT id FROM campaign_notes WHERE id IN (${Prisma.join(before.notes.map(n => n.id))}) ORDER BY id FOR UPDATE`

  const profileNames = new Map((await tx.influencer.findMany({ where: { id: { in: profileIds } }, select: { id: true, username: true, platform: true } })).map(p => [p.id, describe(p)]))
  const otherName = profileNames.get(otherId) ?? `@${otherId}`
  const differences: MergeDifference[] = []
  const diff = (d: MergeDifference) => differences.push(d)

  // ----- Memberships
  const currentRows = membershipIds.length === 0 ? [] : (await tx.$queryRaw<Array<{ row: unknown }>>`
    SELECT row_to_json(ci.*) AS row FROM campaign_influencers ci WHERE ci.id IN (${Prisma.join(membershipIds)})`).map(r => asJsonObject<Row>(r.row))
  const currentById = new Map(currentRows.map(r => [String(r.id), r]))
  for (const m of after.memberships) {
    const was = beforeById.get(m.id)
    if (!was) continue
    const cid = String(was.campaignId)
    const cname = quoted(campaignName.get(cid) ?? cid)
    const current = currentById.get(m.id)
    const who = profileNames.get(String(m.row?.influencerId ?? was.influencerId)) ?? `@${String(was.influencerId)}`
    // The place the row goes back to: (campaign, its influencer before)
    const occupant = await tx.campaignInfluencer.findFirst({ where: { campaignId: cid, influencerId: String(was.influencerId), id: { not: m.id } }, select: { id: true } })
    if (occupant) {
      diff({ kind: 'membership', id: m.id, blocking: true, text: `${profileNames.get(String(was.influencerId)) ?? String(was.influencerId)} vuelve a ser miembro de ${cname} desde la fusión: quítala de la campaña antes de deshacer.` })
      continue
    }
    if (m.row === null) {
      if (current) diff({ kind: 'membership', id: m.id, blocking: true, text: `La ficha de ${otherName} en ${cname} ya existe otra vez.` })
      continue
    }
    if (!current) {
      diff({ kind: 'membership', id: m.id, blocking: false, text: `La ficha de ${who} en ${cname} se ha quitado de la campaña desde la fusión.` })
      continue
    }
    const changed = Object.keys({ ...m.row, ...current }).filter(k => k !== 'updatedAt' && !sameValue(current[k], m.row![k]))
    if (changed.length > 0) {
      diff({
        kind: 'membership', id: m.id, blocking: false,
        text: `La ficha de ${who} en ${cname} ha cambiado desde la fusión: ${changed.map(k => `${FIELD_LABEL.get(k) ?? k} ${fmt(m.row![k])} → ${fmt(current[k])}`).join('; ')}.`,
      })
    }
  }

  // ----- Pieces
  const afterMedia = new Map(after.media.map(m => [m.id, m]))
  const currentMedia = before.media.length === 0 ? [] : await tx.media.findMany({ where: { id: { in: before.media.map(m => m.id) } }, select: { id: true, campaignId: true, influencerId: true, publishedByInfluencerId: true, externalId: true, platform: true } })
  const currentMediaById = new Map(currentMedia.map(m => [m.id, m]))
  for (const m of before.media) {
    const a = afterMedia.get(m.id)
    const cur = currentMediaById.get(m.id)
    const cname = quoted(campaignName.get(String(m.campaignId)) ?? String(m.campaignId))
    if (!cur) { diff({ kind: 'piece', id: m.id, blocking: false, text: `Una publicación de ${cname} que movió la fusión ya no existe.` }); continue }
    if (a && (cur.campaignId !== a.campaignId || cur.influencerId !== a.influencerId || cur.publishedByInfluencerId !== a.publishedByInfluencerId)) {
      diff({ kind: 'piece', id: m.id, blocking: false, text: `Una publicación de ${cname} que movió la fusión se ha movido desde entonces.` })
    }
  }
  // Credited ACROSS the union of persons the undo splits: a piece of any
  // campaign, captured after the merge, credited to a member because its
  // publisher was a profile of her person only through the merge (her TikTok
  // that joined the kept person, filed under the kept profile). After the
  // undo that publisher is not of that member's person any more: the piece is
  // credited again as the roster says once everything is back.
  const personAfterUndo = new Map(before.profiles.map(p => [p.id, p.personId] as [string, string | null]))
  const restoredMedia = new Set(before.media.map(m => m.id))
  // A piece of the restored profile filed under the survivor of a fold goes back to her own row (below)
  const foldTargets = new Set(after.campaigns.filter(c => c.action === 'fold' && c.targetInfluencerId).map(c => `${c.campaignId}|${c.targetInfluencerId}`))
  const splitCandidates = splitLocked.filter(id => !restoredMedia.has(id))
  const splitRows = (splitCandidates.length === 0 ? [] : await tx.media.findMany({
    where: { id: { in: splitCandidates } },
    select: { id: true, campaignId: true, influencerId: true, publishedByInfluencerId: true },
    orderBy: { id: 'asc' },
  })).filter(m => !(m.publishedByInfluencerId === otherId && foldTargets.has(`${m.campaignId}|${m.influencerId}`)))
  const recredit: Array<{ id: string; campaignId: string; campaignName: string; publisherId: string; influencerId: string }> = []
  if (splitRows.length > 0) {
    const involved = Array.from(new Set(splitRows.flatMap(m => [m.influencerId, m.publishedByInfluencerId as string])))
    const people = await tx.influencer.findMany({ where: { id: { in: involved } }, select: { id: true, username: true, platform: true, personId: true } })
    const personNow = new Map(people.map(p => [p.id, p.personId]))
    const nameOf = new Map(people.map(p => [p.id, describe(p)]))
    const personAfter = (id: string) => (personAfterUndo.has(id) ? personAfterUndo.get(id) ?? null : personNow.get(id) ?? null)
    const together = (a: string, b: string, personOf: (id: string) => string | null) => a === b || (!!personOf(a) && personOf(a) === personOf(b))
    const names = new Map((await tx.campaign.findMany({ where: { id: { in: Array.from(new Set(splitRows.map(m => m.campaignId as string))) } }, select: { id: true, name: true } })).map(c => [c.id, c.name]))
    for (const m of splitRows) {
      const publisherId = m.publishedByInfluencerId as string
      const now = together(publisherId, m.influencerId, id => personNow.get(id) ?? null)
      if (!now || together(publisherId, m.influencerId, personAfter)) continue
      const cname = names.get(m.campaignId as string) ?? String(m.campaignId)
      recredit.push({ id: m.id, campaignId: m.campaignId as string, campaignName: cname, publisherId, influencerId: m.influencerId })
      diff({
        kind: 'piece', id: m.id, blocking: false,
        text: `Desde la fusión ha entrado en ${quoted(cname)} una publicación de ${nameOf.get(publisherId) ?? publisherId} que cuenta para ${nameOf.get(m.influencerId) ?? m.influencerId} por la fusión: al deshacerla pasa a la ficha que le corresponda en la campaña.`,
      })
    }
  }
  const recreditIds = new Set(recredit.map(r => r.id))

  // Captured after the merge: what the restored profile published goes back to
  // its own row; in a MOVED campaign, anything else credited to the kept profile
  // (not a member there before the merge, nor after the undo) stays where it is
  const added: Array<{ id: string; campaignId: string; toOther: boolean }> = []
  for (const c of after.campaigns) {
    if (c.action === 'unchanged' || !c.targetInfluencerId) continue
    const rows = await tx.media.findMany({
      where: {
        campaignId: c.campaignId,
        influencerId: c.targetInfluencerId,
        id: { notIn: before.media.map(m => m.id) },
        // In a fold the survivor's own pieces are hers: only the restored profile's count
        ...(c.action === 'fold' ? { publishedByInfluencerId: otherId } : {}),
      },
      select: { id: true, publishedByInfluencerId: true },
      orderBy: { id: 'asc' },
    })
    for (const r of rows) {
      // Credited again by the roster (above): not listed twice
      if (recreditIds.has(r.id)) continue
      const toOther = r.publishedByInfluencerId === otherId
      added.push({ id: r.id, campaignId: c.campaignId, toOther })
      diff({
        kind: 'piece', id: r.id, blocking: false,
        text: toOther
          ? `Desde la fusión ha entrado en ${quoted(c.campaignName)} una publicación de ${otherName}: vuelve a su ficha.`
          : `Desde la fusión ha entrado en ${quoted(c.campaignName)} una publicación de ${profileNames.get(c.targetInfluencerId) ?? c.targetInfluencerId}, que deja de ser miembro: se queda donde está.`,
      })
    }
  }

  // ----- Notes, settings, profiles, the person created
  const currentNotes = before.notes.length === 0 ? [] : await tx.campaignNote.findMany({ where: { id: { in: before.notes.map(n => n.id) } }, select: { id: true, influencerId: true } })
  const currentNoteById = new Map(currentNotes.map(n => [n.id, n]))
  for (const n of after.notes) {
    const cur = currentNoteById.get(n.id)
    if (!cur) diff({ kind: 'note', id: n.id, blocking: false, text: 'Una nota que movió la fusión se ha borrado desde entonces.' })
    else if (cur.influencerId !== n.influencerId) diff({ kind: 'note', id: n.id, blocking: false, text: 'Una nota que movió la fusión se ha movido desde entonces.' })
  }
  const currentSettings = after.settings.length === 0 ? [] : await tx.setting.findMany({ where: { key: { in: after.settings.map(s => s.key) } }, select: { key: true, value: true } })
  const currentSettingByKey = new Map(currentSettings.map(s => [s.key, s.value]))
  const changedSettings = new Set<string>()
  for (const s of after.settings) {
    if ((currentSettingByKey.get(s.key) ?? null) !== s.value) {
      changedSettings.add(s.key)
      diff({ kind: 'setting', id: s.key, blocking: false, text: s.key.startsWith('campaign_report_') ? 'La configuración del informe del cliente ha cambiado desde la fusión.' : 'Los permisos de anuncios han cambiado desde la fusión.' })
    }
  }
  const currentProfiles = await tx.influencer.findMany({ where: { id: { in: after.profiles.map(p => p.id) } }, select: { id: true, personId: true } })
  const currentPersonOf = new Map(currentProfiles.map(p => [p.id, p.personId]))
  for (const p of after.profiles) {
    if (!currentPersonOf.has(p.id)) continue
    if ((currentPersonOf.get(p.id) ?? null) !== p.personId) diff({ kind: 'profile', id: p.id, blocking: false, text: `${profileNames.get(p.id) ?? p.id} ha cambiado de persona desde la fusión.` })
  }
  const restoredProfileIds = new Set(before.profiles.map(p => p.id))
  let keepCreatedPerson = false
  if (after.createdPersonId) {
    const others = await tx.influencer.findMany({ where: { personId: after.createdPersonId, id: { notIn: Array.from(restoredProfileIds) } }, select: { id: true, username: true, platform: true } })
    if (others.length > 0) {
      keepCreatedPerson = true
      diff({ kind: 'person', id: after.createdPersonId, blocking: false, text: `Desde la fusión ${others.map(describe).join(', ')} también ${others.length === 1 ? 'es perfil' : 'son perfiles'} de la persona que creó: la persona se queda.` })
    }
  }

  const blocking = differences.filter(d => d.blocking)
  if (blocking.length > 0) throw new MergeError('cannot_undo', `No se puede deshacer: ${blocking.map(d => d.text).join(' ')}`, { differences })
  const hash = differencesHash(differences)
  if (differences.length > 0 && forcedHash !== hash) {
    throw new MergeError(
      'changed_since',
      forcedHash === null
        ? 'Algo de lo que tocó la fusión ha cambiado desde entonces. Revisa los cambios y confirma para deshacerla igualmente.'
        : 'Desde que revisaste los cambios ha cambiado algo más. Revisa la lista de ahora y confirma otra vez para deshacerla igualmente.',
      { differences, differencesHash: hash }
    )
  }

  // ----- Restore
  const restored = { ...ZERO }
  const notRestored: string[] = []
  const columns = await tableColumns(tx, 'campaign_influencers')
  for (const m of after.memberships) {
    const was = beforeById.get(m.id)
    if (!was) continue
    const keepCols = storableColumns(was, columns)
    if (currentById.has(m.id)) {
      await writeRowColumns(tx, 'campaign_influencers', m.id, was, keepCols.filter(c => c !== 'id'))
    } else {
      await insertRowAsItWas(tx, 'campaign_influencers', was, keepCols)
    }
    restored.memberships++
  }

  for (const m of before.media) {
    const cur = currentMediaById.get(m.id)
    if (!cur) { notRestored.push(`La publicación ${m.id} ya no existe.`); continue }
    if (m.campaignId && cur.campaignId !== m.campaignId && cur.externalId) {
      const taken = await tx.media.findFirst({ where: { externalId: cur.externalId, platform: cur.platform, campaignId: m.campaignId, id: { not: m.id } }, select: { id: true } })
      if (taken) { notRestored.push(`La publicación ${m.id} no vuelve a ${quoted(campaignName.get(m.campaignId) ?? m.campaignId)}: la campaña ya tiene otra fila de esa publicación.`); continue }
    }
    restored.pieces += await tx.$executeRaw`
      UPDATE media AS t
      SET "campaignId" = r."campaignId", "influencerId" = r."influencerId", "publishedByInfluencerId" = r."publishedByInfluencerId", "updatedAt" = r."updatedAt"
      FROM json_populate_record(NULL::media, ${JSON.stringify(m)}::json) AS r
      WHERE t.id = r.id`
  }
  for (const a of added) {
    if (!a.toOther) { notRestored.push(`La publicación ${a.id} de ${quoted(campaignName.get(a.campaignId) ?? a.campaignId)} se queda donde está.`); continue }
    restored.pieces += (await tx.media.updateMany({ where: { id: a.id, campaignId: a.campaignId, publishedByInfluencerId: otherId }, data: { influencerId: otherId, publishedByInfluencerId: null } })).count
  }

  for (const n of before.notes) {
    restored.notes += (await tx.campaignNote.updateMany({ where: { id: n.id }, data: { influencerId: n.influencerId } })).count
  }

  for (const s of before.settings) {
    const changed = changedSettings.has(s.key)
    const ops = after.reportHidden.find(r => r.key === s.key)
    if (changed && ops) {
      // Edited since: only the ids the merge moved go back, the rest of the PM's edits stay
      const raw = currentSettingByKey.get(s.key)
      let config: unknown = null
      try { config = raw === undefined ? null : JSON.parse(raw) } catch { /* unreadable */ }
      const hidden = rawHiddenList(config)
      if (!hidden) { notRestored.push(`La configuración del informe ${s.key} no se puede leer: no se toca.`); continue }
      const next = hidden.filter(e => !ops.added.some(x => isSameId(e, x)))
      for (const r of ops.removed) if (!next.some(e => isSameId(e, r))) next.push(r)
      await writeSetting(tx, s.key, JSON.stringify({ ...(config as Record<string, unknown>), hiddenInfluencerIds: next }), s.id ?? null)
    } else {
      await writeSetting(tx, s.key, s.value, s.id ?? null)
    }
    restored.settings++
  }

  await setPersonIds(tx, before.profiles)
  restored.profiles = before.profiles.length

  // Pieces credited across the split persons: the roster of their campaign, now
  // that memberships and persons are back, says who they count for
  const rosters = new Map<string, Roster>()
  for (const r of recredit) {
    let roster = rosters.get(r.campaignId)
    if (!roster) {
      roster = await rosterIn(tx, r.campaignId)
      rosters.set(r.campaignId, roster)
    }
    const credit = roster.creditForInfluencer(r.publisherId)
    if (!credit) {
      notRestored.push(`La publicación ${r.id} de ${quoted(r.campaignName)} ya no es de ninguna creadora de la campaña: se queda donde está; revísala.`)
      continue
    }
    restored.pieces += (await tx.media.updateMany({
      where: { id: r.id, campaignId: r.campaignId, influencerId: r.influencerId, publishedByInfluencerId: r.publisherId },
      data: { influencerId: credit.member.influencerId, publishedByInfluencerId: credit.self ? null : r.publisherId },
    })).count
  }
  if (after.createdPersonId && !keepCreatedPerson) {
    const still = await tx.influencer.count({ where: { personId: after.createdPersonId } })
    if (still === 0) await tx.person.deleteMany({ where: { id: after.createdPersonId } })
  }

  await tx.personLog.update({ where: { id: log.id }, data: { undoneAt: new Date(), undoneById: actor?.id ?? null } })
  const undo = await tx.personLog.create({
    data: {
      action: 'undo',
      personId: log.personId,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      summary: `Se deshace la fusión: ${log.summary}${differences.length > 0 ? ` (forzado: ${differences.length} ${differences.length === 1 ? 'cambio sobrescrito' : 'cambios sobrescritos'})` : ''}`,
      undoOfId: log.id,
      before: (log.after ?? {}) as Prisma.InputJsonValue,
      after: { restored, overwritten: differences, notRestored } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  })
  return { undoLogId: undo.id, mergeLogId: log.id, kind: 'merge', alreadyUndone: false, restored, overwritten: differences, notRestored }
}

// ===========================================================================
// Dismiss, history
// ===========================================================================

/** «No es la misma persona»: the pair is no longer proposed (undoing this log proposes it again). Idempotent. */
export async function dismissCandidate(aId: string, bId: string, actor: Actor): Promise<{ logId: string; alreadyDismissed: boolean }> {
  const a = typeof aId === 'string' ? aId.trim() : ''
  const b = typeof bId === 'string' ? bId.trim() : ''
  if (!a || !b) throw new MergeError('invalid', 'Indica los dos perfiles.')
  if (a === b) throw new MergeError('invalid', 'Un perfil no se puede descartar consigo mismo.')
  await assertAdminActor(actor)
  const pair = [a, b].sort() as [string, string]
  const profiles = await prisma.influencer.findMany({ where: { id: { in: pair } }, select: { id: true, username: true, platform: true }, orderBy: { id: 'asc' } })
  if (profiles.length !== 2) throw new MergeError('not_found', 'No encuentro uno de los dos perfiles.')
  const live = await prisma.personLog.findMany({ where: { action: 'dismiss_candidate', undoneAt: null }, select: { id: true, after: true } })
  const existing = live.find(l => canonical((l.after as { pair?: unknown } | null)?.pair ?? null) === canonical(pair))
  if (existing) return { logId: existing.id, alreadyDismissed: true }
  const log = await prisma.personLog.create({
    data: {
      action: 'dismiss_candidate',
      personId: null,
      actorId: actor?.id ?? null,
      actorName: actor?.name ?? null,
      summary: `${describe(profiles[0])} y ${describe(profiles[1])} no son la misma persona: no se vuelven a proponer para fusionar.`,
      before: {},
      after: { pair, profiles: profiles.map(p => ({ id: p.id, username: p.username, platform: p.platform })) },
    },
    select: { id: true },
  })
  return { logId: log.id, alreadyDismissed: false }
}

export interface MergeHistoryEntry {
  logId: string
  action: 'merge' | 'dismiss_candidate'
  summary: string
  actorName: string | null
  /** ISO */
  createdAt: string
  undoneAt: string | null
  undoneByName: string | null
  undoable: boolean
  /** The two profile ids, sorted */
  pair: [string, string] | null
  mode: MergeMode | null
}

/** The last merges and dismissals (newest first), with who, when and whether they can be undone. */
export async function listMergeHistory(limit = 50): Promise<MergeHistoryEntry[]> {
  const logs = await prisma.personLog.findMany({
    where: { action: { in: ['merge', 'dismiss_candidate'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.max(1, Math.min(200, limit)),
    select: { id: true, action: true, summary: true, actorName: true, createdAt: true, undoneAt: true, after: true },
  })
  const undos = logs.length === 0 ? [] : await prisma.personLog.findMany({ where: { action: 'undo', undoOfId: { in: logs.map(l => l.id) } }, select: { undoOfId: true, actorName: true, createdAt: true }, orderBy: { createdAt: 'desc' } })
  const undoneBy = new Map<string, string | null>()
  for (const u of undos) if (u.undoOfId && !undoneBy.has(u.undoOfId)) undoneBy.set(u.undoOfId, u.actorName)
  return logs.map(l => {
    const after = (l.after ?? {}) as { pair?: unknown; mode?: unknown }
    const pair = Array.isArray(after.pair) && after.pair.length === 2 ? (after.pair as [string, string]) : null
    return {
      logId: l.id,
      action: l.action as 'merge' | 'dismiss_candidate',
      summary: l.summary,
      actorName: l.actorName,
      createdAt: l.createdAt.toISOString(),
      undoneAt: l.undoneAt ? l.undoneAt.toISOString() : null,
      undoneByName: l.undoneAt ? undoneBy.get(l.id) ?? null : null,
      undoable: !l.undoneAt,
      pair,
      mode: after.mode === 'link' || after.mode === 'absorb' ? after.mode : null,
    }
  })
}
