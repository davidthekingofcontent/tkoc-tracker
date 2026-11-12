/**
 * FOLDING A «TWIN» MEMBERSHIP INTO THE CREATOR'S OWN ROW (Nov 2026).
 *
 * Until 12 Nov 2026, adding a TikTok link of a creator registered with
 * Instagram (or the daily TikTok pass finding her video) created a SECOND
 * member of the campaign for her TikTok account, recorded as
 * CampaignInfluencer.source = 'tiktok_link:<id of the Instagram influencer>'.
 * The campaign then counted her twice everywhere. Since the person-and-profiles
 * model (src/lib/person-profiles.ts) a creator is ONE member row and the pieces
 * of her other profiles are credited to that row (Media.influencerId = the
 * member, Media.publishedByInfluencerId = the profile that published). No twin
 * is created any more; this module converts the ones that exist.
 *
 * A fold:
 *   1. links the two profiles as one person (linkProfile, evidence
 *      'autolink_video'; its own transaction and its own log row);
 *   2. in ONE transaction, with the twin's membership row locked:
 *      - every Media row of THAT campaign filed under the twin is credited to
 *        the original member, keeping who published it (publishedByInfluencerId
 *        = the twin's profile, or the publisher it already had);
 *      - the campaign notes written on the twin move to the original;
 *      - the twin's membership row is deleted;
 *      - a PersonLog row 'fold_membership' keeps the WHOLE deleted row (every
 *        column, as the database stores it) and the previous values of every
 *        moved row.
 *   The original's row (fee, status, shipping, deal) is never written.
 *
 * Nothing is lost: undoFold() puts the membership row back column for column,
 * and the pieces and notes where they were. The two profiles stay linked.
 *
 * A twin that carries anything of its own that removing it would lose (money,
 * notes, shipping, deliverables, tracked link, baseline, deal terms, UGC
 * delivery, a client-report visibility different from the original's, ad
 * permissions) is NEVER folded: it is reported with the reason, for a person
 * to decide.
 *
 * Places keyed by (campaign, influencer id), checked in the code on 12 Nov 2026:
 *   - Media (campaignId, influencerId) ............. re-pointed here
 *   - CampaignNote (campaignId, influencerId) ....... re-pointed here
 *   - Setting campaign_report_<campaignId>, hiddenInfluencerIds: a blocker when
 *     the twin and the original are not hidden alike (folding would show or hide
 *     pieces in the client report). Both hidden: the twin's id leaves the list
 *     (its pieces stay hidden under the original; a stale id would count one
 *     hidden creator twice in the agency's note under the report, and no screen
 *     could un-hide it), and the previous value is logged for undo
 *   - Setting ad_permissions_<campaignId>_<influencerId>: a blocker when the
 *     twin has any (the original may have her own; they are not merged)
 *   - story view rates (src/lib/emv-server.ts) are computed on every read from
 *     Media and follow publishedByInfluencerId: nothing stored to re-point
 *   - notification metadata { influencerId, campaignId } only de-duplicates old
 *     notices: nothing to re-point
 */
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { describeMainProfileOfPerson, linkProfile, PersonLinkError, type Actor } from '@/lib/person-profiles'
import { normalizeReportConfig, reportConfigKey } from '@/lib/report-config'

/**
 * LEGACY CampaignInfluencer.source of a twin. Same value as
 * TIKTOK_LINK_SOURCE_PREFIX in src/lib/tiktok-autolink.ts (kept here so this
 * module does not load the scraper).
 */
export const TWIN_SOURCE_PREFIX = 'tiktok_link:'

/** Statuses of a confirmed member (STORY_SCAN_STATUSES in src/lib/campaign-capture.ts): the daily TikTok pass only reads the linked profiles of these. */
const CONFIRMED_STATUSES = new Set(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'])

/** The influencer id a twin membership was created from, or null when the source is not a twin's. */
export function twinOriginalId(source: string | null | undefined): string | null {
  return typeof source === 'string' && source.startsWith(TWIN_SOURCE_PREFIX) ? source.slice(TWIN_SOURCE_PREFIX.length).trim() || null : null
}

export type FoldBlockerCode =
  | 'original_missing'
  | 'not_a_twin'
  | 'original_is_twin'
  | 'other_person'
  | 'fee'
  | 'notes'
  | 'shipping'
  | 'deliverables'
  | 'tracked_link'
  | 'baseline'
  | 'deal_terms'
  | 'ugc'
  | 'report_hidden'
  | 'report_original_hidden'
  | 'report_unreadable'
  | 'ad_permissions'

/** Why a twin cannot be folded automatically. */
export interface FoldBlocker {
  code: FoldBlockerCode
  reason: string
}

export interface TwinMembership {
  membershipId: string
  campaignId: string
  campaignName: string
  campaignStatus: string
  /** Members of the campaign today, twins included. */
  campaignMembers: number
  twin: { influencerId: string; username: string; platform: string; status: string; personId: string | null }
  original: { influencerId: string; username: string; platform: string; status: string; membershipId: string; personId: string | null } | null
  /** Pieces of this campaign filed under the twin (they move to the original). */
  pieces: number
  /** Campaign notes written on the twin (they move to the original). */
  notes: number
  /** Why it cannot be folded automatically; empty = it can. */
  blockers: FoldBlocker[]
  /** Things to know that do not stop the fold. */
  warnings: string[]
}

export class FoldError extends Error {
  code: 'not_found' | 'not_a_twin' | 'blocked' | 'person_conflict' | 'already_folded' | 'already_undone' | 'changed'
  blockers: FoldBlocker[]

  constructor(code: FoldError['code'], message: string, blockers: FoldBlocker[] = []) {
    super(message)
    this.name = 'FoldError'
    this.code = code
    this.blockers = blockers
  }
}

export interface FoldResult {
  logId: string
  campaignId: string
  campaignName: string
  membershipId: string
  twin: { influencerId: string; username: string; platform: string }
  original: { influencerId: string; username: string; platform: string; membershipId: string }
  personId: string
  /** false when the two profiles already were one person */
  linkedNow: boolean
  movedPieces: number
  movedNotes: number
  /** The twin was hidden in the client report (with the original): its id left the hidden list, the original's stays */
  reportUnhidden: boolean
  /** The listing's warnings about this twin (who reads the account after the fold): the report of a POST says them too */
  warnings: string[]
}

export interface UndoFoldResult {
  undoLogId: string
  foldLogId: string
  campaignId: string
  membershipId: string
  restoredPieces: number
  restoredNotes: number
  /** Pieces of the fold that are no longer credited to the original (deleted or moved since): left as they are */
  piecesNotRestored: number
  notesNotRestored: number
  /** The twin is hidden in the client report again, as it was before the fold */
  reportRestored: boolean
}

// ---------------------------------------------------------------------------
// What a twin carries of its own
// ---------------------------------------------------------------------------

const NETWORK_LABEL: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

const BLOCKER_TEXT: Record<FoldBlockerCode, string> = {
  original_missing: 'la creadora original ya no es miembro de esta campaña',
  not_a_twin: 'su origen apunta a ella misma',
  original_is_twin: 'la creadora original también es un segundo miembro creado al enlazar un TikTok',
  other_person: 'este perfil ya es de otra persona',
  fee: 'tiene honorario, coste o comisión propios',
  notes: 'tiene notas propias en su ficha',
  shipping: 'tiene datos de envío propios',
  deliverables: 'tiene entregables comprometidos propios',
  tracked_link: 'tiene enlace con seguimiento o clics propios',
  baseline: 'tiene línea base propia',
  deal_terms: 'tiene condiciones del acuerdo propias',
  ugc: 'tiene portfolio o entrega UGC propios',
  report_hidden: 'está oculta en el informe del cliente y la creadora original no',
  report_original_hidden: 'la creadora original está oculta en el informe del cliente y este perfil no',
  report_unreadable: 'no se puede leer la configuración del informe del cliente',
  ad_permissions: 'tiene permisos de anuncios propios',
}

function blocker(code: FoldBlockerCode, reason: string = BLOCKER_TEXT[code]): FoldBlocker {
  return { code, reason }
}

/** The columns of a membership row that matter here, as Prisma or the database (row_to_json) gives them. */
type MembershipFields = Record<string, unknown>

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== ''
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

/** What on the twin's own row would be lost by deleting it. Pure. */
export function rowBlockers(row: MembershipFields): FoldBlocker[] {
  const out: FoldBlocker[] = []
  if (positive(row.agreedFee) || positive(row.cost) || positive(row.commission) || positive(row.askingFee)) out.push(blocker('fee'))
  if (filled(row.notes)) out.push(blocker('notes'))
  const shipping = ['shippingName', 'shippingAddress1', 'shippingAddress2', 'shippingCity', 'shippingPostCode', 'shippingCountry', 'shippingPhone', 'shippingEmail', 'shippingProduct', 'shippingComments']
  if (shipping.some(k => filled(row[k])) || (row.shippingQty !== null && row.shippingQty !== undefined && row.shippingQty !== 1)) out.push(blocker('shipping'))
  if (row.deliverablesPlanned !== null && row.deliverablesPlanned !== undefined) out.push(blocker('deliverables'))
  if (filled(row.trackedLink) || positive(row.trackedClicks)) out.push(blocker('tracked_link'))
  if ((row.baselineSnapshot !== null && row.baselineSnapshot !== undefined) || (row.baselineAt !== null && row.baselineAt !== undefined)) out.push(blocker('baseline'))
  if (
    filled(row.negotiatedFormat) || (row.rightsDays !== null && row.rightsDays !== undefined) ||
    (row.exclusivityDays !== null && row.exclusivityDays !== undefined) || row.whitelisting === true ||
    row.urgent === true || row.crossposting === true || (row.dealClosedAt !== null && row.dealClosedAt !== undefined)
  ) out.push(blocker('deal_terms'))
  if (filled(row.portfolioUrl) || row.contentDelivered === true) out.push(blocker('ugc'))
  return out
}

type Db = Prisma.TransactionClient | typeof prisma

/** Client-report visibility and ad permissions: the places outside the membership row keyed by (campaign, influencer). */
async function keyedBlockers(db: Db, campaignId: string, twinId: string, originalId: string): Promise<FoldBlocker[]> {
  const out: FoldBlocker[] = []
  const [report, permissions] = await Promise.all([
    db.setting.findUnique({ where: { key: reportConfigKey(campaignId) }, select: { value: true } }),
    db.setting.findUnique({ where: { key: `ad_permissions_${campaignId}_${twinId}` }, select: { value: true } }),
  ])
  if (report?.value) {
    let hidden: string[] | null = null
    try {
      hidden = normalizeReportConfig(JSON.parse(report.value)).hiddenInfluencerIds
    } catch {
      out.push(blocker('report_unreadable'))
    }
    if (hidden) {
      const twinHidden = hidden.includes(twinId)
      const originalHidden = hidden.includes(originalId)
      if (twinHidden && !originalHidden) out.push(blocker('report_hidden'))
      if (originalHidden && !twinHidden) out.push(blocker('report_original_hidden'))
    }
  }
  if (permissions) {
    let empty = false
    try {
      const parsed = JSON.parse(permissions.value) as unknown
      empty = Array.isArray(parsed) && parsed.length === 0
    } catch { /* unreadable: treated as having permissions */ }
    if (!empty) out.push(blocker('ad_permissions'))
  }
  return out
}

function describe(p: { username: string; platform: string }): string {
  return `@${p.username} (${NETWORK_LABEL[p.platform] ?? p.platform})`
}

// ---------------------------------------------------------------------------
// Listing (read-only)
// ---------------------------------------------------------------------------

/** Every twin membership (optionally of one campaign), with what folding it would do. Changes nothing. */
export async function listTwinMemberships(campaignId?: string): Promise<TwinMembership[]> {
  // Prisma's startsWith is a LIKE, where the "_" of the prefix is a wildcard: the rows are filtered again in code.
  const rows = await prisma.campaignInfluencer.findMany({
    where: { source: { startsWith: TWIN_SOURCE_PREFIX }, ...(campaignId ? { campaignId } : {}) },
    include: {
      influencer: { select: { id: true, username: true, platform: true, personId: true } },
      campaign: { select: { id: true, name: true, status: true, platforms: true, _count: { select: { influencers: true } } } },
    },
    orderBy: [{ campaignId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  const out: TwinMembership[] = []
  for (const t of rows) {
    const originalId = twinOriginalId(t.source)
    if (!originalId) continue
    const blockers: FoldBlocker[] = []
    const warnings: string[] = []

    const originalRow = originalId === t.influencerId
      ? null
      : await prisma.campaignInfluencer.findUnique({
          where: { campaignId_influencerId: { campaignId: t.campaignId, influencerId: originalId } },
          select: { id: true, status: true, source: true, influencer: { select: { id: true, username: true, platform: true, personId: true } } },
        })
    if (originalId === t.influencerId) blockers.push(blocker('not_a_twin'))
    else if (!originalRow) blockers.push(blocker('original_missing'))
    else if (twinOriginalId(originalRow.source)) blockers.push(blocker('original_is_twin'))

    if (originalRow && t.influencer.personId && t.influencer.personId !== originalRow.influencer.personId) {
      const owner = await describeMainProfileOfPerson(t.influencer.personId, t.influencerId).catch(() => null)
      blockers.push(blocker('other_person', owner ? `este perfil ya es de otra persona: ${owner}` : BLOCKER_TEXT.other_person))
    }
    blockers.push(...rowBlockers(t))
    if (originalRow) blockers.push(...(await keyedBlockers(prisma, t.campaignId, t.influencerId, originalId)))

    // While it is a member, check-posts reads the twin's account (Acordado or
    // later) in every active campaign. Once folded, only the daily TikTok pass
    // reads it, and only for a confirmed original in a campaign that includes
    // TikTok: say so before, never a silent pause of the capture.
    if (originalRow && t.campaign.status === 'ACTIVE' && t.influencer.platform === 'TIKTOK') {
      if (!t.campaign.platforms.includes('TIKTOK')) {
        warnings.push(`después de fusionarla nadie lee ${describe(t.influencer)}: la campaña no incluye TikTok en sus plataformas (Aprender → "Editar Campaña" → "Plataformas")`)
      } else if (!CONFIRMED_STATUSES.has(originalRow.status)) {
        warnings.push(`${describe(originalRow.influencer)} no está confirmada en la campaña: mientras no lo esté, el pase diario de TikTok no leerá ${describe(t.influencer)}`)
      }
    }

    const [pieces, notes] = await Promise.all([
      prisma.media.count({ where: { campaignId: t.campaignId, influencerId: t.influencerId } }),
      prisma.campaignNote.count({ where: { campaignId: t.campaignId, influencerId: t.influencerId } }),
    ])
    out.push({
      membershipId: t.id,
      campaignId: t.campaignId,
      campaignName: t.campaign.name,
      campaignStatus: t.campaign.status,
      campaignMembers: t.campaign._count.influencers,
      twin: { influencerId: t.influencer.id, username: t.influencer.username, platform: t.influencer.platform, status: t.status, personId: t.influencer.personId },
      original: originalRow
        ? {
            influencerId: originalRow.influencer.id,
            username: originalRow.influencer.username,
            platform: originalRow.influencer.platform,
            status: originalRow.status,
            membershipId: originalRow.id,
            personId: originalRow.influencer.personId,
          }
        : null,
      pieces,
      notes,
      blockers,
      warnings,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

/** pg returns json columns parsed; a string is parsed here so either way gives an object. */
function asObject<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

interface MediaSnapshot { id: string; influencerId: string; publishedByInfluencerId: string | null; updatedAt: string }
interface NoteSnapshot { id: string; influencerId: string }

/** What a fold_membership log keeps in `before` (version 1). */
interface FoldBefore {
  version: 1
  /** The deleted membership row, every column as row_to_json gives it */
  membership: Record<string, unknown>
  original: { membershipId: string; influencerId: string }
  media: MediaSnapshot[]
  notes: NoteSnapshot[]
  /**
   * The client-report configuration when the fold took the twin's id out of
   * its hidden list: `value` before, `folded` as the fold left it. Absent when
   * the fold did not write it (and in logs written before 12 Nov 2026, 15:00).
   */
  report?: { key: string; value: string; folded: string } | null
}

/** The hidden-creators list of a report configuration as stored (raw JSON), or null when it is not a list. */
function rawHiddenList(config: unknown): unknown[] | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const list = (config as Record<string, unknown>).hiddenInfluencerIds
  return Array.isArray(list) ? list : null
}
const isId = (entry: unknown, id: string) => typeof entry === 'string' && entry.trim() === id

/** Interactive transactions: room for lock waits, never forever. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const

/**
 * Fold ONE twin membership into its original member. Throws FoldError when it
 * must not be done automatically (blocked, or no longer a twin). Two folds of
 * the same twin at once: one wins, the other gets FoldError 'already_folded'.
 */
export async function foldTwinMembership(membershipId: string, actor: Actor): Promise<FoldResult> {
  const current = await prisma.campaignInfluencer.findUnique({ where: { id: membershipId }, select: { id: true, campaignId: true, source: true } })
  if (!current) throw new FoldError('already_folded', 'Ese miembro ya no está en la campaña: ya se fusionó o se quitó.')
  if (!twinOriginalId(current.source)) throw new FoldError('not_a_twin', 'Ese miembro no es un segundo perfil creado al enlazar un TikTok.')

  const candidate = (await listTwinMemberships(current.campaignId)).find(c => c.membershipId === membershipId)
  if (!candidate) throw new FoldError('already_folded', 'Ese miembro ya no está en la campaña: ya se fusionó o se quitó.')
  const twinLabel = describe(candidate.twin)
  if (candidate.blockers.length > 0 || !candidate.original) {
    throw new FoldError('blocked', `${twinLabel} no se puede fusionar sola: ${candidate.blockers.map(b => b.reason).join('; ')}.`, candidate.blockers)
  }
  const original = candidate.original
  const originalLabel = describe(original)

  // One person, two profiles (its own transaction and its own log row; idempotent)
  let personId: string
  let linkedNow: boolean
  try {
    const linked = await linkProfile({
      memberInfluencerId: original.influencerId,
      profileInfluencerId: candidate.twin.influencerId,
      actor,
      evidence: 'autolink_video',
      summary: `${twinLabel} pasa a ser perfil de ${originalLabel}: era un segundo miembro de la campaña "${candidate.campaignName}" creado al enlazar su TikTok`,
    })
    personId = linked.personId
    linkedNow = !linked.alreadyLinked
  } catch (err) {
    if (err instanceof PersonLinkError) throw new FoldError('person_conflict', `${twinLabel} no se puede fusionar: ${err.message}`)
    throw err
  }

  return prisma.$transaction(async tx => {
    // The twin's row, locked: a second fold of the same twin waits here and then finds nothing
    const locked = await tx.$queryRaw<Array<{ row: unknown }>>`
      SELECT row_to_json(ci.*) AS row FROM campaign_influencers ci WHERE ci.id = ${membershipId} FOR UPDATE`
    if (locked.length === 0) throw new FoldError('already_folded', 'Ese miembro ya no está en la campaña: ya se fusionó o se quitó.')
    const row = asObject<Record<string, unknown>>(locked[0].row)
    const campaignId = String(row.campaignId)
    const twinId = String(row.influencerId)
    if (twinOriginalId(row.source as string | null) !== original.influencerId || twinId !== candidate.twin.influencerId || campaignId !== candidate.campaignId) {
      throw new FoldError('changed', `${twinLabel} ha cambiado mientras se fusionaba. Vuelve a intentarlo.`)
    }
    const originalRow = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM campaign_influencers WHERE "campaignId" = ${campaignId} AND "influencerId" = ${original.influencerId} FOR UPDATE`
    if (originalRow.length === 0) throw new FoldError('blocked', `${twinLabel} no se puede fusionar sola: ${BLOCKER_TEXT.original_missing}.`, [blocker('original_missing')])

    // The client-report configuration, locked too: read for the blockers and written below with the same value
    const reportKey = reportConfigKey(campaignId)
    const reportRow = await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM settings WHERE key = ${reportKey} FOR UPDATE`

    // Checked again under the lock: the row or the report may have been edited since the listing
    const late = [...rowBlockers(row), ...(await keyedBlockers(tx, campaignId, twinId, original.influencerId))]
    if (late.length > 0) throw new FoldError('blocked', `${twinLabel} no se puede fusionar sola: ${late.map(b => b.reason).join('; ')}.`, late)

    // Hidden in the client report (both of them: anything else is a blocker): her pieces stay
    // hidden under the original, and the twin's id leaves the list, which counts hidden creators
    let report: FoldBefore['report'] = null
    if (reportRow.length > 0) {
      const config = JSON.parse(reportRow[0].value) as Record<string, unknown>
      const hidden = rawHiddenList(config)
      if (hidden && hidden.some(entry => isId(entry, twinId))) {
        const folded = JSON.stringify({ ...config, hiddenInfluencerIds: hidden.filter(entry => !isId(entry, twinId)) })
        await tx.setting.update({ where: { key: reportKey }, data: { value: folded } })
        report = { key: reportKey, value: reportRow[0].value, folded }
      }
    }

    const mediaRows = await tx.$queryRaw<Array<{ row: unknown }>>`
      SELECT json_build_object('id', id, 'influencerId', "influencerId", 'publishedByInfluencerId', "publishedByInfluencerId", 'updatedAt', "updatedAt") AS row
      FROM media WHERE "campaignId" = ${campaignId} AND "influencerId" = ${twinId} ORDER BY id FOR UPDATE`
    const media = mediaRows.map(r => asObject<MediaSnapshot>(r.row))
    const noteRows = await tx.$queryRaw<Array<{ row: unknown }>>`
      SELECT json_build_object('id', id, 'influencerId', "influencerId") AS row
      FROM campaign_notes WHERE "campaignId" = ${campaignId} AND "influencerId" = ${twinId} ORDER BY id FOR UPDATE`
    const notes = noteRows.map(r => asObject<NoteSnapshot>(r.row))

    // The pieces are credited to the original member and keep who published them
    const ownPieces = media.filter(m => !m.publishedByInfluencerId).map(m => m.id)
    const otherPieces = media.filter(m => !!m.publishedByInfluencerId).map(m => m.id)
    if (ownPieces.length > 0) {
      await tx.media.updateMany({ where: { id: { in: ownPieces }, campaignId, influencerId: twinId }, data: { influencerId: original.influencerId, publishedByInfluencerId: twinId } })
    }
    if (otherPieces.length > 0) {
      await tx.media.updateMany({ where: { id: { in: otherPieces }, campaignId, influencerId: twinId }, data: { influencerId: original.influencerId } })
    }
    if (notes.length > 0) {
      await tx.campaignNote.updateMany({ where: { id: { in: notes.map(n => n.id) }, campaignId, influencerId: twinId }, data: { influencerId: original.influencerId } })
    }
    const deleted = await tx.campaignInfluencer.deleteMany({ where: { id: membershipId, campaignId, influencerId: twinId } })
    if (deleted.count !== 1) throw new FoldError('changed', `${twinLabel} ha cambiado mientras se fusionaba. Vuelve a intentarlo.`)

    // Nothing of the campaign may stay filed under a profile that is no longer a member
    const left = await tx.media.count({ where: { campaignId, influencerId: twinId } })
    if (left > 0) throw new FoldError('changed', `Han entrado publicaciones nuevas de ${twinLabel} mientras se fusionaba. Vuelve a intentarlo.`)

    const before: FoldBefore = {
      version: 1,
      membership: row,
      original: { membershipId: originalRow[0].id, influencerId: original.influencerId },
      media,
      notes,
      report,
    }
    const log = await tx.personLog.create({
      data: {
        action: 'fold_membership',
        personId,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        evidence: 'autolink_video',
        summary: `Campaña "${candidate.campaignName}": el segundo miembro ${twinLabel} se fusiona en ${originalLabel}; ${media.length} publicaciones y ${notes.length} notas pasan a su fila. Su honorario, estado y envío no cambian.`,
        before: before as unknown as Prisma.InputJsonValue,
        after: {
          campaignId,
          membershipId,
          originalMembershipId: originalRow[0].id,
          originalInfluencerId: original.influencerId,
          twinInfluencerId: twinId,
          movedPieces: media.length,
          movedNotes: notes.length,
          linkedNow,
          reportUnhidden: report !== null,
        },
      },
      select: { id: true },
    })

    return {
      logId: log.id,
      campaignId,
      campaignName: candidate.campaignName,
      membershipId,
      twin: { influencerId: twinId, username: candidate.twin.username, platform: candidate.twin.platform },
      original: { influencerId: original.influencerId, username: original.username, platform: original.platform, membershipId: originalRow[0].id },
      personId,
      linkedNow,
      movedPieces: media.length,
      movedNotes: notes.length,
      reportUnhidden: report !== null,
      warnings: candidate.warnings,
    }
  }, TX_OPTIONS)
}

export interface FoldTwinsReport {
  folded: FoldResult[]
  /** Not folded on purpose (blockers, or no longer a twin): nothing of theirs changed */
  skipped: Array<{ membershipId: string; campaignId: string; campaignName: string; twin: string; original: string | null; reason: string; blockers: FoldBlocker[] }>
  /** An unexpected error: nothing of that twin changed (its transaction was rolled back) */
  failed: Array<{ membershipId: string; campaignId: string; campaignName: string; twin: string; error: string }>
}

/**
 * Fold every twin without blockers (of one campaign, or only the memberships
 * named). Safe to run twice: a second run finds nothing to fold. One twin's
 * refusal or failure never stops the others.
 */
export async function foldTwins(args: { campaignId?: string; membershipIds?: string[]; actor: Actor }): Promise<FoldTwinsReport> {
  const only = args.membershipIds ? new Set(args.membershipIds) : null
  const twins = (await listTwinMemberships(args.campaignId)).filter(t => !only || only.has(t.membershipId))
  const report: FoldTwinsReport = { folded: [], skipped: [], failed: [] }
  for (const t of twins) {
    const base = { membershipId: t.membershipId, campaignId: t.campaignId, campaignName: t.campaignName, twin: t.twin.username }
    if (t.blockers.length > 0) {
      report.skipped.push({ ...base, original: t.original?.username ?? null, reason: t.blockers.map(b => b.reason).join('; '), blockers: t.blockers })
      continue
    }
    try {
      report.folded.push(await foldTwinMembership(t.membershipId, args.actor))
    } catch (err) {
      if (err instanceof FoldError) {
        report.skipped.push({ ...base, original: t.original?.username ?? null, reason: err.message, blockers: err.blockers })
      } else {
        report.failed.push({ ...base, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Put a folded twin back exactly as it was: the membership row (every column,
 * its id and timestamps included), the pieces (credited member, publisher and
 * updatedAt), the notes and, when the fold took it out, the twin's id in the
 * client report's hidden list. Pieces or notes changed since the fold are left
 * as they are and counted. The two profiles stay linked as one person.
 */
export async function undoFold(logId: string, actor: Actor): Promise<UndoFoldResult> {
  return prisma.$transaction(async tx => {
    // Locked: two undos of the same fold at once, one wins
    const lockedLog = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM person_logs WHERE id = ${logId} FOR UPDATE`
    if (lockedLog.length === 0) throw new FoldError('not_found', 'No encuentro esa fusión.')
    const log = await tx.personLog.findUnique({ where: { id: logId } })
    if (!log || log.action !== 'fold_membership') throw new FoldError('not_found', 'No encuentro esa fusión.')
    if (log.undoneAt) throw new FoldError('already_undone', 'Esa fusión ya se deshizo.')

    const before = asObject<FoldBefore>(log.before)
    const membership = before?.membership
    if (!membership || before.version !== 1 || !Array.isArray(before.media) || !Array.isArray(before.notes) || !before.original?.influencerId) {
      throw new FoldError('not_found', 'Esa fusión no guarda lo necesario para deshacerla.')
    }
    const membershipId = String(membership.id)
    const campaignId = String(membership.campaignId)
    const twinId = String(membership.influencerId)
    const originalId = before.original.influencerId

    const taken = await tx.campaignInfluencer.findFirst({
      where: { OR: [{ id: membershipId }, { campaignId, influencerId: twinId }] },
      select: { id: true },
    })
    if (taken) throw new FoldError('blocked', 'Ese perfil vuelve a ser miembro de la campaña: no hay nada que deshacer.')

    // The row exactly as it was: every stored column that still exists in the table
    const columns = new Set(
      (await tx.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'campaign_influencers'`)
        .map(c => c.column_name)
    )
    const keep = Object.keys(membership).filter(k => columns.has(k) && IDENTIFIER.test(k))
    if (!keep.includes('id') || !keep.includes('campaignId') || !keep.includes('influencerId')) {
      throw new FoldError('not_found', 'Esa fusión no guarda lo necesario para deshacerla.')
    }
    const list = Prisma.raw(keep.map(k => `"${k}"`).join(', '))
    await tx.$executeRaw`
      INSERT INTO campaign_influencers (${list})
      SELECT ${list} FROM json_populate_record(NULL::campaign_influencers, ${JSON.stringify(membership)}::json)`

    // Pieces and notes still credited to the original go back to the twin, as they were
    const restoredPieces = before.media.length === 0 ? 0 : await tx.$executeRaw`
      UPDATE media AS m
      SET "influencerId" = r."influencerId", "publishedByInfluencerId" = r."publishedByInfluencerId", "updatedAt" = r."updatedAt"
      FROM json_populate_recordset(NULL::media, ${JSON.stringify(before.media)}::json) AS r
      WHERE m.id = r.id AND m."campaignId" = ${campaignId} AND m."influencerId" = ${originalId}`
    const restoredNotes = before.notes.length === 0 ? 0 : await tx.$executeRaw`
      UPDATE campaign_notes AS n
      SET "influencerId" = r."influencerId"
      FROM json_populate_recordset(NULL::campaign_notes, ${JSON.stringify(before.notes)}::json) AS r
      WHERE n.id = r.id AND n."campaignId" = ${campaignId} AND n."influencerId" = ${originalId}`

    // The twin hidden in the client report again. Untouched since the fold: the
    // configuration exactly as it was. Edited since: only the twin's id goes
    // back, and only while the original is still hidden (they were hidden
    // alike, and her pieces must not show or hide on their own).
    let reportRestored = false
    if (before.report?.key) {
      const current = await tx.$queryRaw<Array<{ value: string }>>`SELECT value FROM settings WHERE key = ${before.report.key} FOR UPDATE`
      if (current.length > 0) {
        let value: string | null = null
        if (current[0].value === before.report.folded) {
          value = before.report.value
        } else {
          let config: unknown = null
          try { config = JSON.parse(current[0].value) } catch { /* unreadable: left as it is */ }
          const hidden = rawHiddenList(config)
          if (hidden && hidden.some(entry => isId(entry, originalId)) && !hidden.some(entry => isId(entry, twinId))) {
            value = JSON.stringify({ ...(config as Record<string, unknown>), hiddenInfluencerIds: [...hidden, twinId] })
          }
        }
        if (value !== null) {
          await tx.setting.update({ where: { key: before.report.key }, data: { value } })
          reportRestored = true
        }
      }
    }

    await tx.personLog.update({ where: { id: log.id }, data: { undoneAt: new Date(), undoneById: actor?.id ?? null } })
    const undo = await tx.personLog.create({
      data: {
        action: 'undo',
        personId: log.personId,
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        summary: `Se deshace la fusión ${log.id}: vuelve el segundo miembro con ${restoredPieces} publicaciones y ${restoredNotes} notas. Los dos perfiles siguen siendo de la misma persona.`,
        undoOfId: log.id,
        before: (log.after ?? {}) as Prisma.InputJsonValue,
        after: {
          campaignId,
          membershipId,
          restoredPieces,
          restoredNotes,
          piecesNotRestored: before.media.length - restoredPieces,
          notesNotRestored: before.notes.length - restoredNotes,
          reportRestored,
        },
      },
      select: { id: true },
    })
    return {
      undoLogId: undo.id,
      foldLogId: log.id,
      campaignId,
      membershipId,
      restoredPieces,
      restoredNotes,
      piecesNotRestored: before.media.length - restoredPieces,
      notesNotRestored: before.notes.length - restoredNotes,
      reportRestored,
    }
  }, TX_OPTIONS)
}

/** The folds that are in force (not undone), newest first, optionally of one campaign. Read-only. */
export async function listLiveFolds(campaignId?: string): Promise<Array<{ logId: string; campaignId: string; membershipId: string; createdAt: Date; summary: string }>> {
  const logs = await prisma.personLog.findMany({
    where: { action: 'fold_membership', undoneAt: null, ...(campaignId ? { after: { path: ['campaignId'], equals: campaignId } } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, after: true, createdAt: true, summary: true },
  })
  return logs.map(l => {
    const after = (l.after ?? {}) as { campaignId?: string; membershipId?: string }
    return { logId: l.id, campaignId: String(after.campaignId ?? ''), membershipId: String(after.membershipId ?? ''), createdAt: l.createdAt, summary: l.summary }
  })
}
