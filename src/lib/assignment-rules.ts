/**
 * ASSIGNMENT RULES — which campaign a publication counts in, and when a piece
 * published AFTER the end of a campaign still counts in it ("fuera de plazo").
 *
 * Pure: no database, no network (it is imported by the capture, the manual
 * routes, the overview and their tests). Dates are compared in UTC: campaign
 * dates are stored as midnight of a calendar day (timestamp without time zone,
 * read as UTC), and the window ends at the START of the day after endDate.
 *
 * The late rule (owner, 12-13 Nov 2026), for the manual paths only («Añadir
 * publicación por URL» and «Registrar Story»):
 *   - a post dated BEFORE the start never counts (as always);
 *   - a post dated after the end counts in the campaign, marked late, when
 *       the campaign is a collaboration (not SOCIAL_LISTENING, which keeps
 *       the strict window), it is ACTIVE, the post is at most
 *       LATE_ACCEPT_MAX_DAYS days late and the creator still owes a piece
 *       (pendingOf);
 *   - a late piece counts in ONE campaign only: it is refused where the same
 *     post already has a row in another campaign, and the automatic capture
 *     never files a post a second time in another campaign while a late
 *     piece of it counts there (lateCopyElsewhere: a hand-added row up to
 *     LATE_ACCEPT_MAX_DAYS late, the one revalidation keeps);
 *   - «fuera de plazo» is TEAM ONLY: it never reaches the client (portal,
 *     client report, PDF, exports).
 * Days late are whole days since the end, counted from 1: in a campaign that
 * ends on 31 Oct, a post of 1 Nov 00:00 UTC is 1 day late, one of 5 Nov is 5.
 */

const DAY_MS = 86_400_000

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Longest a piece may be late and still count in the campaign (days after the end). Env override LATE_ACCEPT_MAX_DAYS. */
export const LATE_ACCEPT_MAX_DAYS = positiveIntFromEnv(process.env.LATE_ACCEPT_MAX_DAYS, 30)

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Exclusive upper bound of the campaign window: the start of the UTC day
 * AFTER endDate. The campaign forms send a date-only value that is stored as
 * midnight UTC, so a plain `posted > endDate` would reject (and detach)
 * everything published during the campaign's last day. The ONE source of
 * truth (src/lib/campaign-capture.ts re-exports it).
 */
export function campaignWindowEndExclusive(endDate: Date | string | null | undefined): Date | null {
  const end = toDate(endDate)
  if (!end) return null
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1))
}

/**
 * Days late of a piece: null when it is inside the window (or before it, or
 * undated) or the campaign has no end date; otherwise whole days since the
 * end, counted from 1 (1 Nov 00:00 → 1, 5 Nov 10:00 → 5, 30 Nov 23:59 → 30,
 * 1 Dec 00:00 → 31 for a campaign ending 31 Oct).
 */
export function lateDaysOf(postedAt: Date | string | null | undefined, endDate: Date | string | null | undefined): number | null {
  const posted = toDate(postedAt)
  const endExclusive = campaignWindowEndExclusive(endDate)
  if (!posted || !endExclusive) return null
  const t = posted.getTime() - endExclusive.getTime()
  if (t < 0) return null
  return Math.floor(t / DAY_MS) + 1
}

/** Statuses in which a creator can still owe a piece. COMPLETED owes nothing; before AGREED nothing was agreed. */
export const OWING_STATUSES = ['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED'] as const

export interface PendingInput {
  status: string
  /** Committed pieces. null or 0 = no number: she owes ONE piece (0 is the "no plan" of the overview too) */
  deliverablesPlanned: number | null | undefined
  /** Pieces of the campaign credited to her (Media rows of that campaign with her as member; a story slide is a piece) */
  delivered: number
}

export interface Pending {
  owes: boolean
  /** defined = a number of pieces was committed; implicit = no number, one piece; none = her status owes nothing */
  kind: 'defined' | 'implicit' | 'none'
  remaining: number
}

/** What a creator still owes in a campaign («le falta entregar»). */
export function pendingOf({ status, deliverablesPlanned, delivered }: PendingInput): Pending {
  if (!(OWING_STATUSES as readonly string[]).includes(status)) return { owes: false, kind: 'none', remaining: 0 }
  const done = Math.max(0, Math.floor(Number(delivered) || 0))
  const planned = typeof deliverablesPlanned === 'number' && Number.isFinite(deliverablesPlanned) ? Math.floor(deliverablesPlanned) : 0
  if (planned > 0) {
    const remaining = Math.max(0, planned - done)
    return { owes: remaining > 0, kind: 'defined', remaining }
  }
  const remaining = done === 0 ? 1 : 0
  return { owes: remaining > 0, kind: 'implicit', remaining }
}

// ---------------------------------------------------------------------------
// The decision of the manual paths
// ---------------------------------------------------------------------------

export type LateRefusalCode =
  | 'before_start'
  | 'undated'
  | 'not_collaboration'
  | 'campaign_not_active'
  | 'no_end_date'
  | 'nothing_pending'
  | 'too_late'

/** ok: lateDays null = inside the window (nothing special), a number = accepted late. */
export type LateDecision =
  | { ok: true; lateDays: number | null }
  | { ok: false; code: LateRefusalCode; message: string; lateDays?: number }

export interface LateCampaign {
  type: string
  status: string
  startDate: Date | string
  endDate: Date | string | null
  name: string
}

export interface LateMember {
  status: string
  deliverablesPlanned: number | null | undefined
  delivered: number
  /** Her handle, without @ */
  handle: string
}

/** What is being added: the wording of the answers ("El contenido…" / "La story…"). */
export type LateSubject = 'post' | 'story'

export interface LateWording {
  subject?: LateSubject
  /** Appended after the date in the out-of-window answers, e.g. " (según el enlace)" */
  dateNote?: string
}

export const STATUS_LABEL_ES: Record<string, string> = {
  PROSPECT: 'Prospecto',
  OUTREACH: 'Contacto',
  NEGOTIATING: 'Negociando',
  AGREED: 'Acordado',
  CONTRACTED: 'Contratado',
  SHIPPING: 'Envío',
  POSTED: 'Publicado',
  COMPLETED: 'Completado',
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** "2026-10-01 – 2026-10-31" (or "– sin fecha de fin"): the window as the refusals have always written it. */
export function campaignWindowLabel(campaign: { startDate: Date | string; endDate: Date | string | null }): string {
  const start = toDate(campaign.startDate)
  const end = toDate(campaign.endDate)
  return `${start ? isoDay(start) : '?'} – ${end ? isoDay(end) : 'sin fecha de fin'}`
}

/** The refusal of a date outside the window, word for word as before the late rule. */
export function outsideWindowMessage(campaign: { startDate: Date | string; endDate: Date | string | null }, postedAt: Date, wording: LateWording = {}): string {
  const who = wording.subject === 'story' ? 'La story' : 'El contenido'
  return `${who} se publicó el ${isoDay(postedAt)}${wording.dateNote ?? ''}, fuera del periodo de la campaña (${campaignWindowLabel(campaign)}).`
}

function refuse(code: LateRefusalCode, message: string, lateDays?: number): LateDecision {
  return lateDays === undefined ? { ok: false, code, message } : { ok: false, code, message, lateDays }
}

/**
 * The part of the decision that depends on the campaign and the date only
 * (the creator may not be known yet: «¿De quién es esta publicación?» comes
 * after it). Inside the window → ok, lateDays null.
 */
export function decideLateWindow(args: { campaign: LateCampaign; postedAt: Date | string | null | undefined }, wording: LateWording = {}): LateDecision {
  const { campaign } = args
  const posted = toDate(args.postedAt)
  const what = wording.subject === 'story' ? 'una story' : 'una publicación'
  if (!posted) {
    return refuse('undated', wording.subject === 'story'
      ? 'No se pudo leer la fecha de la story: indica su fecha de publicación.'
      : 'No se pudo determinar la fecha de publicación del contenido. Indica la fecha de publicación para añadirlo.')
  }
  const start = toDate(campaign.startDate)
  if (start && posted < start) return refuse('before_start', outsideWindowMessage(campaign, posted, wording))
  const endExclusive = campaignWindowEndExclusive(campaign.endDate)
  if (endExclusive && posted < endExclusive) return { ok: true, lateDays: null }
  if (!endExclusive) {
    // Without an end date the window never closes: nothing is ever late. Only
    // reachable with an end date that cannot be read.
    if (!campaign.endDate) return { ok: true, lateDays: null }
    return refuse('no_end_date', `«${campaign.name}» no tiene una fecha de fin válida: no se puede contar ${what} fuera de plazo.`)
  }
  const lateDays = lateDaysOf(posted, campaign.endDate) as number
  if (campaign.type === 'SOCIAL_LISTENING') {
    return refuse(
      'not_collaboration',
      `${outsideWindowMessage(campaign, posted, wording)} En una campaña de escucha social solo cuenta lo publicado dentro de sus fechas.`,
      lateDays,
    )
  }
  if (campaign.status !== 'ACTIVE') {
    const state = campaign.status === 'PAUSED' ? 'está en pausa' : campaign.status === 'ARCHIVED' ? 'está archivada' : 'no está activa'
    return refuse(
      'campaign_not_active',
      `«${campaign.name}» ${state}: ${what} de después del fin solo cuenta fuera de plazo en una campaña activa. Si aún debe contar, actívala y vuelve a añadirla.`,
      lateDays,
    )
  }
  if (lateDays > LATE_ACCEPT_MAX_DAYS) {
    const who = wording.subject === 'story' ? 'La story se publicó' : 'Se publicó'
    return refuse(
      'too_late',
      `${who} ${lateDays} días después del fin de la campaña; el máximo para contarla fuera de plazo son ${LATE_ACCEPT_MAX_DAYS}.`,
      lateDays,
    )
  }
  return { ok: true, lateDays }
}

/** The refusal when the creator owes nothing, saying how to fix it. */
export function nothingPendingMessage(member: LateMember, pending: Pending): string {
  const handle = `@${String(member.handle || '').replace(/^@+/, '')}`
  if (pending.kind === 'none') {
    const label = STATUS_LABEL_ES[member.status] ?? member.status
    return `${handle} está en ${label}: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.`
  }
  if (pending.kind === 'defined') {
    return `${handle} ya ha entregado ${member.delivered} de ${member.deliverablesPlanned}: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.`
  }
  const pieces = member.delivered === 1 ? 'una publicación' : `${member.delivered} publicaciones`
  return `${handle} ya tiene ${pieces} en esta campaña y no tiene un número de entregables: no le queda nada por entregar. Si le falta otra, pon sus entregables.`
}

/**
 * Whether a piece added by hand counts in the campaign: inside the window as
 * always; after it only as a late piece (decideLateWindow) of a creator who
 * still owes one. ok + lateDays null = inside the window.
 */
export function decideManualLate(
  args: { campaign: LateCampaign; member: LateMember; postedAt: Date | string | null | undefined },
  wording: LateWording = {},
): LateDecision {
  const window = decideLateWindow(args, wording)
  if (!window.ok || window.lateDays === null) return window
  const pending = pendingOf(args.member)
  if (!pending.owes) return refuse('nothing_pending', nothingPendingMessage(args.member, pending), window.lateDays)
  return window
}

// ---------------------------------------------------------------------------
// Exclusivity of a late piece
// ---------------------------------------------------------------------------

export interface PostCopy {
  campaignId: string | null
  postedAt: Date | string | null
  /** The end date of the campaign the copy is in */
  campaignEndDate: Date | string | null
  /** The type of the campaign the copy is in (Social Listening keeps no late piece) */
  campaignType?: string | null
  /** How the row was added (isHandAddedRow) */
  source: string | null
  mediaType: string
  externalId: string | null
}

/**
 * The copy of a post that counts LATE in another campaign, or null: a piece
 * a PM added there «fuera de plazo», i.e. the row revalidation keeps
 * (keepsLateHandAddedRow: hand-added, at most LATE_ACCEPT_MAX_DAYS after that
 * campaign's end, not Social Listening). The automatic capture never files
 * the post in `campaignId` while one exists: a late piece counts in one
 * campaign only. A scraped or Meta row left after its window (its campaign's
 * end date was moved earlier) is not a late piece: revalidation detaches it,
 * and it never keeps the post out of the campaign where it belongs.
 */
export function lateCopyElsewhere<T extends PostCopy>(copies: readonly T[], campaignId: string): T | null {
  for (const copy of copies) {
    if (!copy.campaignId || copy.campaignId === campaignId) continue
    if (keepsLateHandAddedRow({ endDate: copy.campaignEndDate, type: copy.campaignType ?? null }, copy)) return copy
  }
  return null
}

/**
 * The answer when a piece cannot count here because it counts in another
 * campaign: a late add whose post already has a row elsewhere, or (lateThere)
 * an add whose post already counts LATE elsewhere.
 */
export function countedElsewhereMessage(campaignName: string, wording: LateWording & { lateThere?: boolean } = {}): string {
  const where = wording.lateThere ? `fuera de plazo en «${campaignName}»` : `en «${campaignName}»`
  return wording.subject === 'story'
    ? `Esta story ya cuenta ${where}. Una story fuera de plazo solo cuenta en una campaña.`
    : `Esta publicación ya cuenta ${where}. Una publicación fuera de plazo solo cuenta en una campaña.`
}

// ---------------------------------------------------------------------------
// Revalidation
// ---------------------------------------------------------------------------

/**
 * A row a PM added by hand: source 'manual', or a story added before `source`
 * existed (schema default 'apify' but no externalId; every scraped or Meta
 * row has one).
 */
export function isHandAddedRow(row: { source: string | null; mediaType: string; externalId: string | null }): boolean {
  return row.source === 'manual' || (row.mediaType === 'STORY' && !row.externalId)
}

/**
 * Revalidation keeps a hand-added row dated after the window while it is at
 * most LATE_ACCEPT_MAX_DAYS late (whether she still owes is NOT re-checked:
 * the late piece is exactly what completed her). Scraped rows after the
 * window, rows before the start and undated rows are not kept by this rule. A
 * Social Listening campaign keeps its strict window.
 */
export function keepsLateHandAddedRow(
  campaign: { endDate: Date | string | null; type?: string | null },
  row: { source: string | null; mediaType: string; externalId: string | null; postedAt: Date | string | null },
): boolean {
  if (campaign.type === 'SOCIAL_LISTENING') return false
  if (!isHandAddedRow(row)) return false
  const late = lateDaysOf(row.postedAt, campaign.endDate)
  return late !== null && late <= LATE_ACCEPT_MAX_DAYS
}
