/**
 * The write tools of the MCP connector for the CLIENT REPORT of a campaign:
 *
 *   set_report_visibility   none, bulk (more than 5 publications or creators change: two-step token)
 *   edit_report_content     none
 *   mark_report_sent        none
 *
 * All three go through the platform's own route /api/campaigns/[id]/report-config,
 * as the administrator who authorised the grant. That route stores ONE
 * configuration per campaign and REPLACES every array it receives, so these
 * tools always read the stored configuration first (GET through the
 * platform), merge the change and send the complete arrays. What the route
 * does not check is checked here: that a hidden publication or creator
 * belongs to the campaign, that a highlighted comment linked to a publication
 * links to one of this campaign, that the hidden lists stay within the 200
 * ids the route keeps (it drops the rest in silence), and that a "sent" entry
 * (which can never be removed) is not recorded twice by a retry.
 *
 * Whatever is saved here is what the client sees at once in the portal and
 * the PDF. Nothing here sends anything to the client.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import {
  DELIVERY_ROW_KEYS,
  REPORT_COLUMN_IDS,
  REPORT_COMMENT_SENTIMENTS,
  REPORT_LIST_MAX,
  REPORT_SECTION_IDS,
  type DeliveryOverride,
  type ReportConfig,
  type ReportDeliveryConfig,
} from '@/lib/report-config'
import { defineWriteTool, type WriteContext, type WritePlan, type WriteTool } from '@/lib/mcp/write-tool'
import { ToolError, idInput, isoDay, shortText } from '@/lib/mcp/tools/shared'
import { CAMPAIGN_NOT_FOUND, campaignIdInput, loadCampaignHead, quoted } from './campaigns'

const refuse = (confirmation: 'none' | 'bulk' | 'client', message: string): WritePlan => ({ confirmation, refuse: message })

// ============ The stored configuration ============

/** GET /api/campaigns/[id]/report-config as the administrator (the full staff configuration). */
async function readConfig(ctx: WriteContext, campaignId: string): Promise<ReportConfig> {
  const data = await ctx.platformJson<{ config?: ReportConfig }>({ method: 'GET', path: `/api/campaigns/${campaignId}/report-config` })
  const c = data.config
  if (!c || typeof c !== 'object') throw new ToolError('La plataforma no ha devuelto la configuración del informe. No se ha cambiado nada.')
  return {
    ...c,
    hiddenSections: Array.isArray(c.hiddenSections) ? c.hiddenSections : [],
    hiddenColumns: Array.isArray(c.hiddenColumns) ? c.hiddenColumns : [],
    hiddenMediaIds: Array.isArray(c.hiddenMediaIds) ? c.hiddenMediaIds : [],
    hiddenInfluencerIds: Array.isArray(c.hiddenInfluencerIds) ? c.hiddenInfluencerIds : [],
    highlightedComments: Array.isArray(c.highlightedComments) ? c.highlightedComments : [],
    delivery: c.delivery && typeof c.delivery === 'object' ? c.delivery : { overrides: {}, extraRows: [] },
    sentVersions: Array.isArray(c.sentVersions) ? c.sentVersions : [],
  }
}

/** PUT /api/campaigns/[id]/report-config with a patch; returns the configuration as saved. */
async function saveConfig(ctx: WriteContext, campaignId: string, patch: Record<string, unknown>): Promise<ReportConfig> {
  const data = await ctx.platformJson<{ config?: ReportConfig }>({ method: 'PUT', path: `/api/campaigns/${campaignId}/report-config`, body: patch })
  if (!data.config) throw new ToolError('La plataforma no ha devuelto la configuración guardada. Comprueba el informe antes de repetir.')
  return data.config
}

const unique = <T>(values: readonly T[]): T[] => Array.from(new Set(values))

// ============ set_report_visibility ============

const idList = (what: string) => z.array(idInput(what)).max(REPORT_LIST_MAX)
const BULK_VISIBILITY_THRESHOLD = 5
const VISIBILITY_NOTICE =
  'El cliente lo ve de inmediato en su portal y en el PDF, y sus totales cambian; la vista de agencia no cambia. Es reversible con esta misma herramienta.'

interface VisibilityArgs {
  campaignId: string
  hideMediaIds?: string[]
  showMediaIds?: string[]
  hideInfluencerIds?: string[]
  showInfluencerIds?: string[]
  hideSections?: string[]
  showSections?: string[]
  hideColumns?: string[]
  showColumns?: string[]
}

interface VisibilityDelta {
  hideMedia: string[]
  showMedia: string[]
  hideCreators: string[]
  showCreators: string[]
  hideSections: string[]
  showSections: string[]
  hideColumns: string[]
  showColumns: string[]
  /** Ids that are neither of this campaign nor currently hidden. */
  unknownMedia: string[]
  unknownCreators: string[]
  next: { hiddenMediaIds: string[]; hiddenInfluencerIds: string[]; hiddenSections: string[]; hiddenColumns: string[] }
}

/** What would change from the stored configuration, and the complete lists to save. */
async function visibilityDelta(a: VisibilityArgs, config: ReportConfig): Promise<VisibilityDelta> {
  const hideMediaIds = unique(a.hideMediaIds ?? [])
  const showMediaIds = unique(a.showMediaIds ?? [])
  const hideInfluencerIds = unique(a.hideInfluencerIds ?? [])
  const showInfluencerIds = unique(a.showInfluencerIds ?? [])

  const mediaAsked = unique([...hideMediaIds, ...showMediaIds])
  const creatorsAsked = unique([...hideInfluencerIds, ...showInfluencerIds])
  const [ownMedia, members, creatorsWithMedia] = await Promise.all([
    mediaAsked.length
      ? prisma.media.findMany({ where: { campaignId: a.campaignId, id: { in: mediaAsked } }, select: { id: true } })
      : Promise.resolve([] as { id: string }[]),
    creatorsAsked.length
      ? prisma.campaignInfluencer.findMany({ where: { campaignId: a.campaignId, influencerId: { in: creatorsAsked } }, select: { influencerId: true } })
      : Promise.resolve([] as { influencerId: string }[]),
    creatorsAsked.length
      ? prisma.media.findMany({ where: { campaignId: a.campaignId, influencerId: { in: creatorsAsked } }, select: { influencerId: true }, distinct: ['influencerId'] })
      : Promise.resolve([] as { influencerId: string }[]),
  ])
  const mediaOfCampaign = new Set(ownMedia.map(m => m.id))
  const creatorsOfCampaign = new Set([...members.map(m => m.influencerId), ...creatorsWithMedia.map(m => m.influencerId)])
  const hiddenMedia = new Set(config.hiddenMediaIds)
  const hiddenCreators = new Set(config.hiddenInfluencerIds)

  // To hide: it must belong to the campaign. To show: it must be hidden now (or belong, then it is already visible).
  const unknownMedia = [
    ...hideMediaIds.filter(id => !mediaOfCampaign.has(id)),
    ...showMediaIds.filter(id => !mediaOfCampaign.has(id) && !hiddenMedia.has(id)),
  ]
  const unknownCreators = [
    ...hideInfluencerIds.filter(id => !creatorsOfCampaign.has(id)),
    ...showInfluencerIds.filter(id => !creatorsOfCampaign.has(id) && !hiddenCreators.has(id)),
  ]

  const hideMedia = hideMediaIds.filter(id => mediaOfCampaign.has(id) && !hiddenMedia.has(id))
  const showMedia = showMediaIds.filter(id => hiddenMedia.has(id))
  const hideCreators = hideInfluencerIds.filter(id => creatorsOfCampaign.has(id) && !hiddenCreators.has(id))
  const showCreators = showInfluencerIds.filter(id => hiddenCreators.has(id))
  const hideSections = unique(a.hideSections ?? []).filter(s => !config.hiddenSections.includes(s))
  const showSections = unique(a.showSections ?? []).filter(s => config.hiddenSections.includes(s))
  const hideColumns = unique(a.hideColumns ?? []).filter(c => !config.hiddenColumns.includes(c))
  const showColumns = unique(a.showColumns ?? []).filter(c => config.hiddenColumns.includes(c))

  const apply = (current: string[], add: string[], remove: string[]) => [...current.filter(x => !remove.includes(x)), ...add]
  return {
    hideMedia, showMedia, hideCreators, showCreators, hideSections, showSections, hideColumns, showColumns,
    unknownMedia, unknownCreators,
    next: {
      hiddenMediaIds: apply(config.hiddenMediaIds, hideMedia, showMedia),
      hiddenInfluencerIds: apply(config.hiddenInfluencerIds, hideCreators, showCreators),
      hiddenSections: apply(config.hiddenSections, hideSections, showSections),
      hiddenColumns: apply(config.hiddenColumns, hideColumns, showColumns),
    },
  }
}

/** Readable labels of publications and creators, for previews and answers. */
async function labels(mediaIds: string[], creatorIds: string[]): Promise<{ media: Map<string, string>; creators: Map<string, string> }> {
  const [media, creators] = await Promise.all([
    mediaIds.length
      ? prisma.media.findMany({
          where: { id: { in: mediaIds } },
          select: { id: true, mediaType: true, postedAt: true, influencer: { select: { username: true } } },
        })
      : Promise.resolve([]),
    creatorIds.length ? prisma.influencer.findMany({ where: { id: { in: creatorIds } }, select: { id: true, username: true } }) : Promise.resolve([]),
  ])
  const m = new Map<string, string>()
  for (const row of media) {
    const who = row.influencer?.username ? `@${shortText(row.influencer.username, 60)}` : 'creadora sin usuario'
    m.set(row.id, `${row.mediaType} de ${who} (${isoDay(row.postedAt) ?? 'sin fecha'})`)
  }
  const c = new Map<string, string>()
  for (const row of creators) c.set(row.id, `@${shortText(row.username, 60) ?? row.id}`)
  return { media: m, creators: c }
}

function labelList(ids: string[], map: Map<string, string>, fallback: string, max = 15): string {
  const shown = ids.slice(0, max).map(id => map.get(id) ?? `${fallback} ${id}`)
  return ids.length > max ? `${shown.join(', ')} y ${ids.length - max} más` : shown.join(', ')
}

function overLimit(d: VisibilityDelta): string | null {
  if (d.next.hiddenMediaIds.length > REPORT_LIST_MAX) {
    return `El informe admite como mucho ${REPORT_LIST_MAX} publicaciones ocultas y quedarían ${d.next.hiddenMediaIds.length}. Muestra antes alguna o oculta a la creadora entera.`
  }
  if (d.next.hiddenInfluencerIds.length > REPORT_LIST_MAX) {
    return `El informe admite como mucho ${REPORT_LIST_MAX} creadoras ocultas y quedarían ${d.next.hiddenInfluencerIds.length}.`
  }
  return null
}

function unknownIdsMessage(d: VisibilityDelta): string | null {
  if (d.unknownMedia.length === 0 && d.unknownCreators.length === 0) return null
  const parts: string[] = []
  if (d.unknownMedia.length) parts.push(`publicaciones que no son de esta campaña: ${d.unknownMedia.slice(0, 10).join(', ')}`)
  if (d.unknownCreators.length) parts.push(`creadoras que no son de esta campaña: ${d.unknownCreators.slice(0, 10).join(', ')}`)
  return `No se ha cambiado nada. Hay ${parts.join('; ')}. Usa list_campaign_media y list_campaign_creators para obtener los ids.`
}

export const setReportVisibility = defineWriteTool({
  name: 'set_report_visibility',
  title: 'Ocultar o mostrar piezas, creadoras, secciones y columnas del informe',
  description:
    'Hides or shows publications, creators, sections and columns in the CLIENT report of a campaign. Hidden pieces and creators leave the figures and lists the client sees ' +
    "(portal, printed report and client PDF) at once; the agency view keeps them. Use for 'oculta este reel del informe', 'que el cliente no vea a @x', 'quita la columna de CPM'. " +
    'Publication ids are the id of list_campaign_media and creator ids the creatorId of list_campaign_creators. The connector reads the stored configuration, applies only the changes asked and saves the complete lists, ' +
    'and checks that every id belongs to the campaign. With more than 5 publications or creators changing it first returns a preview to confirm. ' +
    'Does NOT delete anything and does not notify the client.',
  input: {
    campaignId: campaignIdInput,
    hideMediaIds: idList('Publication id of this campaign to hide.').optional().describe('Publications to hide from the client report (ids from list_campaign_media), at most 200.'),
    showMediaIds: idList('Publication id to show again.').optional().describe('Hidden publications to show again, at most 200.'),
    hideInfluencerIds: idList('Creator id of this campaign to hide.').optional().describe('Creators to hide with all their pieces (creatorId from list_campaign_creators), at most 200.'),
    showInfluencerIds: idList('Creator id to show again.').optional().describe('Hidden creators to show again, at most 200.'),
    hideSections: z.array(z.enum(REPORT_SECTION_IDS)).max(REPORT_SECTION_IDS.length).optional().describe(`Sections to hide: ${REPORT_SECTION_IDS.join(', ')}.`),
    showSections: z.array(z.enum(REPORT_SECTION_IDS)).max(REPORT_SECTION_IDS.length).optional().describe('Hidden sections to show again.'),
    hideColumns: z.array(z.enum(REPORT_COLUMN_IDS)).max(REPORT_COLUMN_IDS.length).optional().describe(`Columns or summary cards to hide: ${REPORT_COLUMN_IDS.join(', ')}.`),
    showColumns: z.array(z.enum(REPORT_COLUMN_IDS)).max(REPORT_COLUMN_IDS.length).optional().describe('Hidden columns to show again.'),
  },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: false, idempotentHint: true },
  summarize: a => ({
    campaignId: a.campaignId,
    hideMedia: a.hideMediaIds?.length,
    showMedia: a.showMediaIds?.length,
    hideCreators: a.hideInfluencerIds?.length,
    showCreators: a.showInfluencerIds?.length,
    hideSections: a.hideSections?.join(','),
    showSections: a.showSections?.join(','),
    hideColumns: a.hideColumns?.join(','),
    showColumns: a.showColumns?.join(','),
  }),
  async plan(a, ctx) {
    const lists = [a.hideMediaIds, a.showMediaIds, a.hideInfluencerIds, a.showInfluencerIds, a.hideSections, a.showSections, a.hideColumns, a.showColumns]
    if (!lists.some(l => l && l.length > 0)) {
      return refuse('none', 'Indica qué ocultar o mostrar: hideMediaIds, showMediaIds, hideInfluencerIds, showInfluencerIds, hideSections, showSections, hideColumns o showColumns.')
    }
    const both = (x: readonly string[] = [], y: readonly string[] = []) => x.filter(v => y.includes(v))
    const conflicts = [
      ...both(a.hideMediaIds, a.showMediaIds),
      ...both(a.hideInfluencerIds, a.showInfluencerIds),
      ...both(a.hideSections, a.showSections),
      ...both(a.hideColumns, a.showColumns),
    ]
    if (conflicts.length) return refuse('none', `Estos ids están a la vez para ocultar y para mostrar: ${unique(conflicts).slice(0, 10).join(', ')}. Decide una de las dos.`)

    const head = await prisma.campaign.findUnique({ where: { id: a.campaignId }, select: { id: true, name: true } })
    if (!head) return refuse('none', CAMPAIGN_NOT_FOUND)
    const config = await readConfig(ctx, head.id)
    const d = await visibilityDelta(a, config)
    const unknown = unknownIdsMessage(d)
    if (unknown) return refuse('none', unknown)
    const limit = overLimit(d)
    if (limit) return refuse('none', limit)

    const changing = d.hideMedia.length + d.showMedia.length + d.hideCreators.length + d.showCreators.length
    if (changing <= BULK_VISIBILITY_THRESHOLD) return { confirmation: 'none' }

    const l = await labels([...d.hideMedia, ...d.showMedia], [...d.hideCreators, ...d.showCreators])
    const lines: string[] = []
    if (d.hideMedia.length || d.hideCreators.length) {
      const what = [
        d.hideMedia.length ? `${d.hideMedia.length} publicaciones (${labelList(d.hideMedia, l.media, 'publicación')})` : '',
        d.hideCreators.length ? `${d.hideCreators.length} creadoras con todas sus piezas (${labelList(d.hideCreators, l.creators, 'creadora')})` : '',
      ].filter(Boolean)
      lines.push(`Vas a OCULTAR en el informe de cliente de ${quoted(head.name)}: ${what.join(' y ')}.`)
    }
    if (d.showMedia.length || d.showCreators.length) {
      const what = [
        d.showMedia.length ? `${d.showMedia.length} publicaciones (${labelList(d.showMedia, l.media, 'publicación')})` : '',
        d.showCreators.length ? `${d.showCreators.length} creadoras (${labelList(d.showCreators, l.creators, 'creadora')})` : '',
      ].filter(Boolean)
      lines.push(`Vas a MOSTRAR de nuevo en el informe de cliente de ${quoted(head.name)}: ${what.join(' y ')}.`)
    }
    lines.push(`${VISIBILITY_NOTICE} ¿Confirmas?`)
    return {
      confirmation: 'bulk',
      preview: lines.join(' '),
      fingerprint: JSON.stringify({ m: config.hiddenMediaIds, i: config.hiddenInfluencerIds }),
    }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    const config = await readConfig(ctx, head.id)
    const d = await visibilityDelta(a, config)
    const unknown = unknownIdsMessage(d)
    if (unknown) throw new ToolError(unknown)
    const limit = overLimit(d)
    if (limit) throw new ToolError(limit)

    const patch: Record<string, unknown> = {}
    if (d.hideMedia.length || d.showMedia.length) patch.hiddenMediaIds = d.next.hiddenMediaIds
    if (d.hideCreators.length || d.showCreators.length) patch.hiddenInfluencerIds = d.next.hiddenInfluencerIds
    if (d.hideSections.length || d.showSections.length) patch.hiddenSections = d.next.hiddenSections
    if (d.hideColumns.length || d.showColumns.length) patch.hiddenColumns = d.next.hiddenColumns
    if (Object.keys(patch).length === 0) {
      return { campaign: { id: head.id, name: shortText(head.name, 120) }, changed: false, message: 'No había nada que cambiar: el informe ya estaba así.' }
    }
    const saved = await saveConfig(ctx, head.id, patch)
    const l = await labels([...d.hideMedia, ...d.showMedia], [...d.hideCreators, ...d.showCreators])
    const named = (ids: string[], map: Map<string, string>) => ids.map(id => ({ id, label: map.get(id) ?? null }))
    return {
      campaign: { id: head.id, name: shortText(head.name, 120) },
      changed: true,
      hidden: {
        publications: named(d.hideMedia, l.media),
        creators: named(d.hideCreators, l.creators),
        sections: d.hideSections,
        columns: d.hideColumns,
      },
      shown: {
        publications: named(d.showMedia, l.media),
        creators: named(d.showCreators, l.creators),
        sections: d.showSections,
        columns: d.showColumns,
      },
      nowHiddenInReport: {
        publications: Array.isArray(saved.hiddenMediaIds) ? saved.hiddenMediaIds.length : null,
        creators: Array.isArray(saved.hiddenInfluencerIds) ? saved.hiddenInfluencerIds.length : null,
        sections: saved.hiddenSections ?? [],
        columns: saved.hiddenColumns ?? [],
      },
      notice: VISIBILITY_NOTICE,
    }
  },
})

// ============ edit_report_content ============

const TEXT_FIELDS = ['title', 'subtitle', 'intro', 'conclusions'] as const
const CONTENT_FIELDS = [...TEXT_FIELDS, 'highlightedComments', 'delivery'] as const
const CONTENT_NOTICE = 'Visible ya para el cliente en el portal y en el PDF.'

const reportText = (what: string) => z.string().trim().max(2000).nullable().optional().describe(`${what} At most 2,000 characters; null or an empty text clears it.`)

const highlightedCommentInput = z.object({
  text: z.string().trim().min(1).max(300).describe('The comment exactly as written by the audience, 1 to 300 characters.'),
  author: z.string().trim().max(80).optional().describe('Handle of who wrote it, at most 80 characters.'),
  sentiment: z.enum(REPORT_COMMENT_SENTIMENTS).optional().describe('positive, neutral (default) or negative.'),
  mediaId: idInput('Id of the publication of this campaign the comment belongs to.').optional(),
  id: z.string().trim().min(1).max(200).optional().describe('Keep the id of an existing comment when editing it.'),
})

const deliveryCount = z.number().int().min(0).max(1_000_000).nullable().optional()
const deliveryOverrideInput = z
  .object({
    planned: deliveryCount.describe('Promised figure, an integer 0 to 1,000,000; null keeps the computed one.'),
    delivered: deliveryCount.describe('Delivered figure, an integer 0 to 1,000,000; null keeps the computed one.'),
    ok: z.boolean().nullable().optional().describe('true = Cumplido, false = En revisión, null = automatic.'),
    note: z.string().trim().max(120).nullable().optional().describe('Sub-line of the row, at most 120 characters.'),
  })
  .nullable()
  .optional()

const deliveryInput = z
  .object({
    overrides: z
      .object({
        creators: deliveryOverrideInput,
        pieces: deliveryOverrideInput,
        dates: deliveryOverrideInput,
        disclosure: deliveryOverrideInput,
      })
      .optional()
      .describe('Manual values of the four computed rows. A row given REPLACES that row; null returns it to automatic; a row left out is kept.'),
    extraRows: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(80).describe('What was promised, 1 to 80 characters (e.g. "Exclusividad").'),
          value: z.string().trim().max(40).optional().describe('Short value, at most 40 characters (e.g. "12 meses").'),
          ok: z.boolean().optional().describe('true = Cumplido. The client only sees rows that are true.'),
          id: z.string().trim().min(1).max(200).optional().describe('Keep the id of an existing row when editing it.'),
        }),
      )
      .max(4)
      .optional()
      .describe('The complete list of extra promises (at most 4); it REPLACES the stored list. Left out, the stored rows are kept.'),
  })
  .nullable()
  .optional()

/** A delivery block as the route accepts it: an extra row without id gets one when it is saved. */
interface DeliveryPatch {
  overrides: ReportDeliveryConfig['overrides']
  extraRows: { label: string; ok: boolean; value?: string | null; id?: string }[]
}

/** The new delivery block: the stored one with the rows given replaced (null: back to automatic) and, when given, the new extra rows. */
function mergedDelivery(current: ReportDeliveryConfig, given: NonNullable<z.infer<typeof deliveryInput>>): DeliveryPatch {
  const overrides: ReportDeliveryConfig['overrides'] = { ...(current.overrides ?? {}) }
  for (const key of DELIVERY_ROW_KEYS) {
    const row = given.overrides?.[key]
    if (row === undefined) continue
    if (row === null) {
      delete overrides[key]
      continue
    }
    const clean: DeliveryOverride = {}
    if (row.planned !== undefined) clean.planned = row.planned
    if (row.delivered !== undefined) clean.delivered = row.delivered
    if (row.ok !== undefined) clean.ok = row.ok
    if (row.note !== undefined) clean.note = row.note
    overrides[key] = clean
  }
  const extraRows = given.extraRows
    ? given.extraRows.map(r => ({ label: r.label, ok: r.ok === true, ...(r.value !== undefined ? { value: r.value } : {}), ...(r.id !== undefined ? { id: r.id } : {}) }))
    : (current.extraRows ?? [])
  return { overrides, extraRows }
}

const CONTENT_LABEL: Record<(typeof CONTENT_FIELDS)[number], string> = {
  title: 'Título',
  subtitle: 'Subtítulo',
  intro: 'Introducción',
  conclusions: 'Conclusiones',
  highlightedComments: 'Comentarios destacados',
  delivery: '«Prometido vs entregado»',
}

/** One line of the preview: what is there now and what there will be. */
function describeContentChange(field: (typeof CONTENT_FIELDS)[number], now: unknown, next: unknown): string {
  const label = CONTENT_LABEL[field]
  const quote = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t ? `«${shortText(t, 300)}»` : '(vacío)'
  }
  if (field === 'highlightedComments') {
    const had = Array.isArray(now) ? now.length : 0
    if (next === null) return `${label}: se quitan los ${had}.`
    const list = Array.isArray(next) ? next : []
    const texts = list.slice(0, 3).map(c => quote((c as { text?: unknown }).text)).join(', ')
    return `${label}: ${had} ahora, quedarán ${list.length}${texts ? ` (${texts}${list.length > 3 ? '…' : ''})` : ''}.`
  }
  if (field === 'delivery') {
    if (next === null) return `${label}: todas las filas vuelven a lo automático.`
    const d = (next ?? {}) as { overrides?: Record<string, unknown>; extraRows?: unknown[] }
    const rows = Object.keys(d.overrides ?? {})
    const parts = [
      rows.length ? `cambian las filas ${rows.join(', ')}` : '',
      Array.isArray(d.extraRows) ? `las filas extra pasan a ser ${d.extraRows.length}` : '',
    ].filter(Boolean)
    return `${label}: ${parts.join('; ') || 'sin cambios en las filas'}.`
  }
  const nextText = next === null || next === '' ? '(vacío: vuelve al automático)' : quote(next)
  return `${label}: ${quote(now)} pasa a ${nextText}.`
}

/** One field of a configuration as an answer shows it. */
function contentOf(config: ReportConfig, field: (typeof CONTENT_FIELDS)[number]): unknown {
  if (field === 'highlightedComments') {
    return (config.highlightedComments ?? []).map(c => ({ id: c.id, text: c.text, author: c.author || null, sentiment: c.sentiment, mediaId: c.mediaId ?? null }))
  }
  if (field === 'delivery') return config.delivery ?? { overrides: {}, extraRows: [] }
  return config[field] ?? null
}

export const editReportContent = defineWriteTool({
  name: 'edit_report_content',
  title: 'Editar textos, comentarios destacados y «Prometido vs entregado» del informe',
  description:
    "Edits the written parts of the CLIENT report of a campaign: title, subtitle, introduction, conclusions, the highlighted audience comments and the 'Prometido vs entregado' checklist. " +
    'What is saved here is what the client sees at once in the portal and the PDF, so write only text the person approved. ' +
    'Highlighted comments must be real comments supplied by the person or present among the campaign captured comments: never write or paraphrase them yourself. ' +
    'highlightedComments REPLACES the stored list as a whole (null clears it); the answer returns the previous list. ' +
    'delivery: each of the four rows given (creators, pieces, dates, disclosure) replaces that row and null returns it to automatic, rows left out are kept; extraRows, when given, replaces the extra rows; delivery: null returns everything to automatic. ' +
    'Fields left out are not touched. Does NOT send the report and does not hide content (set_report_visibility). ' +
    "ALWAYS asks first: the first call changes nothing and returns a preview with each text before and after; show it to the person and call again with the confirmToken only after their yes. If anyone edits those parts in between, the yes no longer applies and a new preview comes back.",
  input: {
    campaignId: campaignIdInput,
    title: reportText('Report title (replaces the campaign name on the cover).'),
    subtitle: reportText('Report subtitle.'),
    intro: reportText('Introduction under the executive summary.'),
    conclusions: reportText('Conclusions and next steps.'),
    highlightedComments: z
      .array(highlightedCommentInput)
      .max(12)
      .nullable()
      .optional()
      .describe('The complete list of highlighted audience comments (at most 12). Replaces the stored list; null clears it.'),
    delivery: deliveryInput.describe("Edits of the 'Prometido vs entregado' checklist; null returns every row to automatic."),
  },
  // 'client': the client sees these texts at once, so the person always says yes first (owner, 12 Nov 2026)
  confirmations: ['none', 'client'],
  // It overwrites texts and replaces the highlighted comments: not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({
    campaignId: a.campaignId,
    fields: CONTENT_FIELDS.filter(f => a[f] !== undefined).join(','),
    comments: a.highlightedComments === undefined ? undefined : (a.highlightedComments ?? []).length,
  }),
  async plan(a, ctx) {
    if (!CONTENT_FIELDS.some(f => a[f] !== undefined)) {
      return refuse('none', `Indica al menos un apartado: ${CONTENT_FIELDS.join(', ')}.`)
    }
    const head = await prisma.campaign.findUnique({ where: { id: a.campaignId }, select: { id: true, name: true } })
    if (!head) return refuse('none', CAMPAIGN_NOT_FOUND)
    const linked = unique((a.highlightedComments ?? []).map(c => c.mediaId).filter((v): v is string => !!v))
    if (linked.length) {
      const own = await prisma.media.findMany({ where: { campaignId: head.id, id: { in: linked } }, select: { id: true } })
      const ownIds = new Set(own.map(m => m.id))
      const foreign = linked.filter(id => !ownIds.has(id))
      if (foreign.length) {
        return refuse('none', `Estos comentarios enlazan publicaciones que no son de esta campaña: ${foreign.slice(0, 10).join(', ')}. No se ha cambiado nada.`)
      }
    }
    // What the client will see changes at once: always the person's yes first,
    // bound to what is stored NOW (an edit in between voids that yes)
    const before = await readConfig(ctx, head.id)
    const fields = CONTENT_FIELDS.filter(f => a[f] !== undefined)
    const lines = fields.map(f => describeContentChange(f, contentOf(before, f), a[f]))
    return {
      confirmation: 'client',
      fingerprint: JSON.stringify(fields.map(f => [f, contentOf(before, f)])),
      preview: `Vas a cambiar el informe de «${shortText(head.name, 120)}». ${lines.join(' ')} Lo verá el cliente al momento en el portal y en el PDF. ¿Confirmas?`,
    }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    const before = await readConfig(ctx, head.id)
    const fields = CONTENT_FIELDS.filter(f => a[f] !== undefined)
    const patch: Record<string, unknown> = {}
    for (const f of TEXT_FIELDS) if (a[f] !== undefined) patch[f] = a[f] === null || a[f] === '' ? null : a[f]
    if (a.highlightedComments !== undefined) {
      patch.highlightedComments =
        a.highlightedComments === null
          ? null
          : a.highlightedComments.map(c => ({
              text: c.text,
              ...(c.author !== undefined ? { author: c.author } : {}),
              ...(c.sentiment !== undefined ? { sentiment: c.sentiment } : {}),
              ...(c.mediaId !== undefined ? { mediaId: c.mediaId } : {}),
              ...(c.id !== undefined ? { id: c.id } : {}),
            }))
    }
    if (a.delivery !== undefined) patch.delivery = a.delivery === null ? null : mergedDelivery(before.delivery, a.delivery)
    const saved = await saveConfig(ctx, head.id, patch)
    const out = { before: {} as Record<string, unknown>, saved: {} as Record<string, unknown> }
    for (const f of fields) {
      out.before[f] = contentOf(before, f)
      out.saved[f] = contentOf(saved, f)
    }
    return {
      campaign: { id: head.id, name: shortText(head.name, 120) },
      changed: fields,
      saved: out.saved,
      before: out.before,
      notice: CONTENT_NOTICE,
    }
  },
})

// ============ mark_report_sent ============

/** A second entry within this time needs repeatSend: a retry after a timeout must not record a send twice. */
const REPEAT_WINDOW_MS = 10 * 60_000

export const markReportSent = defineWriteTool({
  name: 'mark_report_sent',
  title: 'Anotar que el informe se ha enviado',
  description:
    'Records that the report of a campaign was sent to the client: appends a numbered entry (who, when, optional note) to the sent-versions log. ' +
    'It sends NOTHING; it is bookkeeping. The log is append-only and an entry can never be removed, so use it only when the person states that the report has really been sent. ' +
    'If an entry was recorded in the last 10 minutes it refuses, unless repeatSend is true because the person confirms it was really sent again.',
  input: {
    campaignId: campaignIdInput,
    note: z.string().trim().max(2000).optional().describe('Optional note, at most 2,000 characters (e.g. who it was sent to, which version).'),
    repeatSend: z.boolean().optional().describe('true only when the person confirms the report was sent AGAIN within 10 minutes of the previous record.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false },
  summarize: a => ({ campaignId: a.campaignId, note: a.note !== undefined, repeatSend: a.repeatSend }),
  async plan(a, ctx) {
    const head = await prisma.campaign.findUnique({ where: { id: a.campaignId }, select: { id: true } })
    if (!head) return refuse('none', CAMPAIGN_NOT_FOUND)
    if (a.repeatSend !== true) {
      const config = await readConfig(ctx, head.id)
      const last = config.sentVersions.reduce<ReportConfig['sentVersions'][number] | null>((max, v) => (!max || v.version > max.version ? v : max), null)
      const at = last ? Date.parse(last.sentAt) : NaN
      if (last && Number.isFinite(at) && Date.now() - at < REPEAT_WINDOW_MS) {
        const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
        return refuse(
          'none',
          `Ya se anotó el envío n.º ${last.version} de este informe hace ${minutes} min. No se ha anotado otro. Si de verdad se ha vuelto a enviar, vuelve a llamar con repeatSend: true.`,
        )
      }
    }
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    const body: Record<string, unknown> = {}
    if (a.note) body.note = a.note
    const data = await ctx.platformJson<{ config?: ReportConfig }>({ method: 'POST', path: `/api/campaigns/${head.id}/report-config`, body })
    const versions = Array.isArray(data.config?.sentVersions) ? data.config.sentVersions : []
    const entry = versions.reduce<ReportConfig['sentVersions'][number] | null>((max, v) => (!max || v.version > max.version ? v : max), null)
    if (!entry) throw new ToolError('La plataforma no ha devuelto el registro del envío. Comprueba el informe antes de repetir.')
    return {
      campaign: { id: head.id, name: shortText(head.name, 120) },
      version: entry.version,
      sentAt: entry.sentAt,
      recordedBy: entry.sentBy,
      note: entry.note ?? null,
      message: `Anotado el envío n.º ${entry.version} del informe de ${quoted(head.name)}. Desde aquí no se ha enviado nada al cliente.`,
    }
  },
})

// ============ Registration ============

/** The report write tools, in the order Claude lists them. */
export const REPORT_WRITE_TOOLS: readonly WriteTool[] = [setReportVisibility, editReportContent, markReportSent]

/** Hands every report write tool to `register` (server.ts registers each with writeToolConfig and tool.call). */
export function registerReportWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of REPORT_WRITE_TOOLS) register(tool)
}
