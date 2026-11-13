/**
 * The write tools of the MCP connector for CAMPAIGNS:
 *
 *   create_campaign                none
 *   update_campaign                none
 *   set_campaign_status            none, bulk (more than 5 campaigns: two-step token)
 *   set_campaign_tracking_targets  none
 *   set_campaign_goals             none
 *   record_business_results        none
 *   delete_campaign                destructive (approved by the administrator in the platform)
 *   revalidate_campaign_media      destructive
 *   set_campaign_access            none (grant), destructive (revoke)
 *
 * Every CHANGE goes through the platform's own route (ctx.platform*), as the
 * administrator who authorised the grant, so the route's validation, the
 * freeze of the targets and its audit log, the notifications and every other
 * rule apply exactly as in the UI. What those routes do not check (a brand
 * that exists, platforms without repetition, a campaign that would be left
 * with no objective, no numeric target or no tracking rule, a reason for a
 * change of frozen targets) is checked here first.
 *
 * Reads that only feed a preview or a before/after (current values, counts,
 * the pieces a revalidation would take out) go straight to the database,
 * read-only and field by field: the platform's GET of a campaign loads every
 * member and the whole overview, and has no counts of brief files, notes or
 * stories. Nothing here writes to the database directly.
 *
 * Answers carry field names as keys (before.targetCpmMax, after.clientReportedRevenue)
 * so the output filter of write-tool.ts removes money figures unless the call
 * asked for includeEconomics.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import { campaignHasTargets, normalizeTargets, revalidationVerdict } from '@/lib/campaign-capture'
import { normalizeKeywords } from '@/lib/campaign-targets'
import { APP_URL } from '@/lib/mcp/config'
import { isEconomicsKey } from '@/lib/mcp/output-filter'
import { describePlatformFailure } from '@/lib/mcp/platform-client'
import { defineWriteTool, type WriteContext, type WritePlan, type WriteTool } from '@/lib/mcp/write-tool'
import { brandNameFromSetting } from '@/lib/mcp/tools/brands'
import { PLATFORMS, ToolError, dayInput, idInput, isoDay, parseDay, shortText, shortTexts } from '@/lib/mcp/tools/shared'
import { BRAND_NOT_FOUND, brandIdInput, findBrand } from './brands'

// ============ Vocabulary ============

export const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export const CAMPAIGN_TYPES = ['INFLUENCER_TRACKING', 'UGC', 'SOCIAL_LISTENING'] as const
/** The values of CAMPAIGN_OBJECTIVES (src/lib/campaign-intelligence.ts); a test keeps them equal. */
export const OBJECTIVES = ['awareness', 'engagement', 'traffic', 'conversion', 'content'] as const
export const PAYMENT_TYPES = ['PAID', 'GIFTED'] as const
const TARGET_KEYS = ['targetViews', 'targetReach', 'targetEngagement', 'targetER', 'targetCpmMax'] as const
type TargetKey = (typeof TARGET_KEYS)[number]

const STATUS_ES: Record<string, string> = { ACTIVE: 'activa', PAUSED: 'pausada', ARCHIVED: 'archivada' }
const statusEs = (s: string) => STATUS_ES[s] ?? s

export const CAMPAIGN_NOT_FOUND = 'No existe ninguna campaña con ese id. Usa list_campaigns para obtener el id de la campaña.'

/** Link to the campaign screen of the platform. Built from APP_URL, never from a request. */
export const campaignLink = (id: string) => `${APP_URL}/campaigns/${encodeURIComponent(id)}`

/** A campaign name as it may travel in a preview or an answer: «name». */
export const quoted = (name: unknown) => `«${shortText(name, 120) ?? 'sin nombre'}»`

// ============ Inputs ============

export const campaignIdInput = idInput('The campaign id, as returned by list_campaigns.')

const MIN_YEAR = 2020
const MAX_YEAR = 2100

/** A campaign day: YYYY-MM-DD, a real date, year 2020 to 2100 (the platform refuses other years). */
const campaignDay = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date written as YYYY-MM-DD')
    .refine(v => parseDay(v) !== null, 'is not a real date')
    .refine(v => Number(v.slice(0, 4)) >= MIN_YEAR && Number(v.slice(0, 4)) <= MAX_YEAR, `year must be between ${MIN_YEAR} and ${MAX_YEAR}`)
    .describe(what)

const countryInput = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code in capitals, such as ES')
const nameInput = z.string().trim().min(1).max(120)
const platformsInput = z
  .array(z.enum(PLATFORMS))
  .min(1)
  .max(3)
  .refine(v => new Set(v).size === v.length, 'must not repeat a platform')
const accountsInput = z.array(z.string().trim().min(1).max(100)).max(20)
const hashtagsInput = z.array(z.string().trim().min(1).max(100)).max(20)
const keywordsInput = z.array(z.string().trim().min(4).max(60)).max(10)
const positiveInt = z.number().int().positive().max(1_000_000_000_000)
const positiveNumber = z.number().positive().max(1_000_000_000)
const briefInput = z.string().max(20_000)

const TARGET_DESCRIPTIONS: Record<TargetKey, string> = {
  targetViews: 'Target views, an integer greater than 0.',
  targetReach: 'Target reach, an integer greater than 0.',
  targetEngagement: 'Target interactions, an integer greater than 0.',
  targetER: 'Target engagement rate in percent, a number greater than 0.',
  targetCpmMax: 'Maximum CPM in EUR, a number greater than 0 (internal money figure).',
}

const refuse = (confirmation: 'none' | 'bulk' | 'destructive', message: string): WritePlan => ({ confirmation, refuse: message })

// ============ Reading the current state (read-only) ============

const STATE_SELECT = {
  id: true,
  name: true,
  status: true,
  type: true,
  isPinned: true,
  startDate: true,
  endDate: true,
  platforms: true,
  country: true,
  paymentType: true,
  briefText: true,
  targetAccounts: true,
  targetHashtags: true,
  targetKeywords: true,
  objective: true,
  targetViews: true,
  targetReach: true,
  targetEngagement: true,
  targetER: true,
  targetCpmMax: true,
  targetsFrozenAt: true,
  promoCode: true,
  codeRedemptions: true,
  clientReportedSales: true,
  clientReportedLeads: true,
  clientReportedRevenue: true,
  businessResultsSource: true,
  businessResultsReportedAt: true,
  businessResultsNotes: true,
  userId: true,
} satisfies Prisma.CampaignSelect

export type CampaignState = Prisma.CampaignGetPayload<{ select: typeof STATE_SELECT }>

/** The campaign as it is stored now. ToolError when it does not exist. */
export async function loadCampaignState(id: string): Promise<CampaignState> {
  const row = await prisma.campaign.findUnique({ where: { id }, select: STATE_SELECT })
  if (!row) throw new ToolError(CAMPAIGN_NOT_FOUND)
  return row
}

/** id and name of a campaign, or ToolError. */
export async function loadCampaignHead(id: string): Promise<{ id: string; name: string; status: string; type: string }> {
  const row = await prisma.campaign.findUnique({ where: { id }, select: { id: true, name: true, status: true, type: true } })
  if (!row) throw new ToolError(CAMPAIGN_NOT_FOUND)
  return row
}

/** The brand name of a campaign, or null. Only the name of the brand document is read. */
export async function campaignBrandName(campaignId: string): Promise<string | null> {
  const link = await prisma.setting.findUnique({ where: { key: `campaign_brand_${campaignId}` }, select: { value: true } })
  if (!link?.value) return null
  const brand = await prisma.setting.findUnique({ where: { key: link.value }, select: { value: true } })
  return brandNameFromSetting(brand?.value)
}

const DATE_FIELDS = new Set(['startDate', 'endDate', 'businessResultsReportedAt'])

/** A stored or returned value as it is shown in a before/after. */
function shown(field: string, value: unknown): string | number | boolean | string[] | null {
  if (value === null || value === undefined) return null
  if (DATE_FIELDS.has(field)) return isoDay(value as Date | string)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return shortTexts(value, 50, 100)
  if (field === 'briefText' && typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} caracteres en total)` : value
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return null
}

/** Equal for a before/after: same day, same list (platforms in any order), same scalar (empty text is null). */
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (DATE_FIELDS.has(field)) return shown(field, a) === shown(field, b)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    const norm = (v: unknown[]) => v.map(String)
    return field === 'platforms'
      ? JSON.stringify(norm(a).sort()) === JSON.stringify(norm(b).sort())
      : JSON.stringify(norm(a)) === JSON.stringify(norm(b))
  }
  const plain = (v: unknown) => (v === undefined || v === '' ? null : v)
  return plain(a) === plain(b)
}

/** The `campaign` of a PUT /api/campaigns/[id] answer, as a record. */
async function putCampaign(ctx: WriteContext, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await ctx.platformJson<{ campaign?: Record<string, unknown> }>({ method: 'PUT', path: `/api/campaigns/${id}`, body })
  if (!res.campaign || typeof res.campaign !== 'object') throw new ToolError('La plataforma no ha devuelto la campaña. Comprueba el resultado con get_campaign.')
  return res.campaign
}

/**
 * before / after keyed by field, for the fields of `changed`. A money field
 * (maximum CPM, revenue) is left out unless the call asked for
 * includeEconomics, and named in `moneyHidden` instead: the output filter
 * would remove it anyway, but its generic note says "call again", and calling
 * a write tool again is not a read.
 */
function beforeAfter(fields: readonly string[], before: Record<string, unknown>, after: Record<string, unknown>, includeEconomics: boolean) {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  const moneyHidden: string[] = []
  for (const f of fields) {
    if (!includeEconomics && isEconomicsKey(f)) {
      moneyHidden.push(f)
      continue
    }
    b[f] = shown(f, before[f])
    a[f] = shown(f, after[f])
  }
  return { before: b, after: a, moneyHidden }
}

/** The note of an answer that saved a money field without showing it. */
const moneyHiddenNote = (fields: string[]) =>
  `Guardado: ${fields.join(', ')}. Es una cifra económica interna: su valor solo se muestra cuando la herramienta se llama con includeEconomics: true. No hace falta repetir la llamada.`

/** The fields of `args` that were given (not undefined), among `keys`. */
function givenKeys<K extends string>(args: Record<string, unknown>, keys: readonly K[]): K[] {
  return keys.filter(k => args[k] !== undefined)
}

// ============ create_campaign ============

const CREATED_NOTICE =
  'Campaña creada y ACTIVA. La captura automática (hashtags, menciones y perfiles confirmados) empieza en el próximo ciclo y consume Apify; si aún no debe rastrearse, páusala.'

/** A campaign with the same name created by the same administrator within this time is taken for a retry. */
const REPEAT_CREATE_WINDOW_MS = 10 * 60_000

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export const createCampaign = defineWriteTool({
  name: 'create_campaign',
  title: 'Crear campaña',
  description:
    'Creates a campaign owned by the authorising admin (who also becomes its first team member). It is always born ACTIVE: the platform accepts no draft or paused creation, ' +
    'so from the next capture cycle the crons scrape its hashtags, brand mentions and confirmed creators and spend Apify (pause it with set_campaign_status if it must not be tracked yet). ' +
    'Use it when the person asks to open or set up a campaign. Resolve the brand first: the brand can only be attached here, never later; create it with create_brand if it does not exist. ' +
    'The connector checks that brandId is a real brand and that platforms do not repeat before calling. Unless type is SOCIAL_LISTENING, objective and at least one numeric target are required. ' +
    'Does NOT add creators, upload brief files, launch tracking, set a status other than ACTIVE or give access to other team members. ' +
    'A second campaign with the same name within 10 minutes is refused as a probable retry. ' +
    'Platform refusals (generic hashtags, weak product keywords, creators typed as brand accounts, invalid dates) come back as a Spanish message to relay as is.',
  input: {
    name: nameInput.describe('Campaign name, 1 to 120 characters.'),
    type: z.enum(CAMPAIGN_TYPES).optional().describe('INFLUENCER_TRACKING (default), UGC or SOCIAL_LISTENING.'),
    brandId: brandIdInput.optional(),
    platforms: platformsInput.optional().describe('1 to 3 distinct networks among INSTAGRAM, TIKTOK and YOUTUBE. Default [INSTAGRAM].'),
    startDate: campaignDay('First day, YYYY-MM-DD. Default today.').optional(),
    endDate: campaignDay('Last day, YYYY-MM-DD, not before startDate. Once set it can be moved but never cleared.').optional(),
    country: countryInput.optional().describe('ISO 3166-1 alpha-2 code in capitals, such as ES.'),
    paymentType: z.enum(PAYMENT_TYPES).optional().describe('PAID (default) or GIFTED. Always PAID for UGC.'),
    objective: z.enum(OBJECTIVES).optional().describe('Required unless type is SOCIAL_LISTENING.'),
    targetViews: positiveInt.optional().describe(TARGET_DESCRIPTIONS.targetViews),
    targetReach: positiveInt.optional().describe(TARGET_DESCRIPTIONS.targetReach),
    targetEngagement: positiveInt.optional().describe(TARGET_DESCRIPTIONS.targetEngagement),
    targetER: positiveNumber.optional().describe(TARGET_DESCRIPTIONS.targetER),
    targetCpmMax: positiveNumber.optional().describe(TARGET_DESCRIPTIONS.targetCpmMax),
    targetAccounts: accountsInput.optional().describe("At most 20 of the BRAND's own accounts ('@' optional). Never the creators' handles."),
    targetHashtags: hashtagsInput.optional().describe("At most 20 brand hashtags ('#' optional); each must carry the brand name."),
    targetKeywords: keywordsInput.optional().describe('At most 10 product names, 4 to 60 characters each, such as "Flection System".'),
    briefText: briefInput.optional().describe('Brief text, at most 20,000 characters.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false },
  summarize: a => ({
    type: a.type ?? 'INFLUENCER_TRACKING',
    brandId: a.brandId,
    platforms: a.platforms?.join(','),
    objective: a.objective,
    startDate: a.startDate,
    endDate: a.endDate,
    accounts: a.targetAccounts?.length,
    hashtags: a.targetHashtags?.length,
    keywords: a.targetKeywords?.length,
  }),
  async plan(a, ctx) {
    const type = a.type ?? 'INFLUENCER_TRACKING'
    const start = a.startDate ?? todayUtc()
    if (a.endDate && a.endDate < start) {
      return refuse('none', `La fecha de fin (${a.endDate}) no puede ser anterior a la de inicio (${start}).`)
    }
    if (type !== 'SOCIAL_LISTENING') {
      if (!a.objective) {
        return refuse('none', 'Falta el objetivo de la campaña (objective: awareness, engagement, traffic, conversion o content). Pregúntaselo a la persona.')
      }
      if (!TARGET_KEYS.some(k => a[k] !== undefined)) {
        return refuse('none', 'Falta al menos una meta numérica mayor que 0: targetViews, targetReach, targetEngagement, targetER (%) o targetCpmMax (EUR). Pregúntasela a la persona.')
      }
    }
    if (a.brandId && !(await findBrand(ctx, a.brandId))) return refuse('none', BRAND_NOT_FOUND)
    // A retry after an answer that never arrived must not create the campaign twice
    const recent = await prisma.campaign.findFirst({
      where: { userId: ctx.user.id, name: { equals: a.name, mode: 'insensitive' }, createdAt: { gte: new Date(Date.now() - REPEAT_CREATE_WINDOW_MS) } },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    if (recent) {
      const minutes = Math.max(0, Math.round((Date.now() - recent.createdAt.getTime()) / 60_000))
      return refuse(
        'none',
        `Hace ${minutes} min ya se creó una campaña con ese nombre (id ${recent.id}). No se ha creado otra: si la llamada anterior pareció fallar, compruébala con get_campaign. Si de verdad hace falta una segunda campaña, ponle otro nombre.`,
      )
    }
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const body: Record<string, unknown> = { name: a.name }
    for (const key of [
      'type', 'brandId', 'platforms', 'startDate', 'endDate', 'country', 'paymentType', 'objective',
      ...TARGET_KEYS, 'targetAccounts', 'targetHashtags', 'targetKeywords', 'briefText',
    ] as const) {
      if (a[key] !== undefined) body[key] = a[key]
    }
    const res = await ctx.platformJson<{ campaign?: Record<string, unknown> }>({ method: 'POST', path: '/api/campaigns', body })
    const c = res.campaign ?? {}
    const id = typeof c.id === 'string' ? c.id : null
    if (!id) throw new ToolError('La plataforma no ha devuelto el id de la campaña. Comprueba con list_campaigns si se ha creado antes de repetir.')
    const brand = a.brandId ? await campaignBrandName(id) : null
    // The maximum CPM is money: only with includeEconomics (see beforeAfter)
    const targets: Record<string, unknown> = {}
    for (const k of TARGET_KEYS) if (ctx.includeEconomics || !isEconomicsKey(k)) targets[k] = shown(k, c[k])
    return {
      campaign: {
        id,
        name: shortText(c.name, 120),
        status: shown('status', c.status),
        type: shown('type', c.type),
        brandId: a.brandId ?? null,
        brand: brand ? shortText(brand, 120) : null,
        platforms: shown('platforms', c.platforms),
        startDate: shown('startDate', c.startDate),
        endDate: shown('endDate', c.endDate),
        country: shown('country', c.country),
        paymentType: shown('paymentType', c.paymentType),
        objective: shown('objective', c.objective),
        ...targets,
        tracking: {
          accounts: shown('targetAccounts', c.targetAccounts),
          hashtags: shown('targetHashtags', c.targetHashtags),
          productKeywords: shown('targetKeywords', c.targetKeywords),
        },
        link: campaignLink(id),
      },
      notice: CREATED_NOTICE,
    }
  },
})

// ============ update_campaign ============

const UPDATE_FIELDS = ['name', 'startDate', 'endDate', 'platforms', 'country', 'paymentType', 'briefText', 'isPinned'] as const

export const updateCampaign = defineWriteTool({
  name: 'update_campaign',
  title: 'Editar datos de la campaña',
  description:
    "Edits the general settings of one campaign: name, dates, platforms, country, payment type, brief text and pin. Use it for 'renombra', 'amplía hasta el día X', 'añade TikTok', 'fíjala arriba'. " +
    'Send only what changes; platforms REPLACES the stored list. The answer lists every changed field as before and after. ' +
    'Does NOT change status (set_campaign_status), tracking rules (set_campaign_tracking_targets), objective or numeric targets (set_campaign_goals) or business results (record_business_results). ' +
    'It cannot change the type, the brand or the owner (the platform has no way), cannot clear an end date once set, and does not re-check content already captured after a date change ' +
    '(revalidate_campaign_media does, with approval). Changing dates or platforms changes what the capture crons scrape from then on.',
  input: {
    campaignId: campaignIdInput,
    name: nameInput.optional().describe('New name, 1 to 120 characters.'),
    startDate: campaignDay('New first day, YYYY-MM-DD.').optional(),
    endDate: campaignDay('New last day, YYYY-MM-DD, not before the start. It cannot be cleared.').optional(),
    platforms: platformsInput.optional().describe('The complete new list of networks (replaces the stored one): 1 to 3 distinct among INSTAGRAM, TIKTOK and YOUTUBE.'),
    country: countryInput.nullable().optional().describe('ISO 3166-1 alpha-2 code in capitals, or null to clear it.'),
    paymentType: z.enum(PAYMENT_TYPES).optional().describe('PAID or GIFTED.'),
    briefText: briefInput.nullable().optional().describe('New brief text (at most 20,000 characters), or null to clear it.'),
    isPinned: z.boolean().optional().describe('true pins the campaign at the top of the list.'),
  },
  confirmations: ['none'],
  // It overwrites stored values (and platforms REPLACES the list): not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({ campaignId: a.campaignId, fields: givenKeys(a, UPDATE_FIELDS).join(',') }),
  async plan(a) {
    if (givenKeys(a, UPDATE_FIELDS).length === 0) {
      return refuse('none', `Indica al menos un campo que cambiar: ${UPDATE_FIELDS.join(', ')}.`)
    }
    const state = await loadCampaignState(a.campaignId)
    const start = a.startDate ?? isoDay(state.startDate)
    const end = a.endDate ?? isoDay(state.endDate)
    if (start && end && end < start) {
      return refuse('none', `La fecha de fin (${end}) no puede ser anterior a la de inicio (${start}).`)
    }
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const state = await loadCampaignState(a.campaignId)
    const current = state as unknown as Record<string, unknown>
    const body: Record<string, unknown> = {}
    for (const field of givenKeys(a, UPDATE_FIELDS)) {
      const wanted = a[field] ?? null
      if (!sameValue(field, current[field], wanted)) body[field] = wanted
    }
    const changed = Object.keys(body)
    if (changed.length === 0) {
      return { campaign: { id: state.id, name: shortText(state.name, 120) }, changed: [], message: 'No había nada que cambiar: la campaña ya tenía esos valores.' }
    }
    const after = await putCampaign(ctx, state.id, body)
    const notes: string[] = []
    if (changed.some(f => f === 'startDate' || f === 'endDate' || f === 'platforms')) {
      notes.push(
        'Desde ahora la captura automática usa las fechas y redes nuevas. Los contenidos ya capturados no se revisan: si hay que sacar los que ya no encajan, usa revalidate_campaign_media.',
      )
    }
    const { before, after: afterShown } = beforeAfter(changed, current, after, ctx.includeEconomics)
    return {
      campaign: { id: state.id, name: shortText(after.name, 120), link: campaignLink(state.id) },
      changed,
      before,
      after: afterShown,
      ...(notes.length ? { notes } : {}),
    }
  },
})

// ============ set_campaign_status ============

const BULK_STATUS_THRESHOLD = 5

function statusEffect(status: string): string {
  return status === 'ACTIVE'
    ? 'La captura automática se reanuda y consume Apify.'
    : 'La captura automática se detiene; no se borra nada y se puede revertir.'
}

export const setCampaignStatus = defineWriteTool({
  name: 'set_campaign_status',
  title: 'Activar, pausar o archivar campañas',
  description:
    'Sets one or several campaigns (at most 20) to ACTIVE, PAUSED or ARCHIVED. PAUSED and ARCHIVED stop the capture crons for the campaign; ACTIVE resumes them and their Apify spend; ' +
    "ARCHIVED also hides the campaign from the default list and is the reversible alternative to deleting. Use for 'pausa', 'archiva', 'reactiva'. " +
    'Up to 5 campaigns it runs at once and reports before and after per campaign; with more than 5 it first returns a preview to confirm. ' +
    'Does NOT delete anything and does not launch a tracking run.',
  input: {
    campaignIds: z
      .array(campaignIdInput)
      .min(1)
      .max(20)
      .refine(v => new Set(v).size === v.length, 'must not repeat a campaign')
      .describe('1 to 20 distinct campaign ids.'),
    status: z.enum(CAMPAIGN_STATUSES).describe('ACTIVE, PAUSED or ARCHIVED.'),
  },
  confirmations: ['none', 'bulk'],
  // It overwrites the stored status (archiving included): not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({ status: a.status, campaigns: a.campaignIds.length, first: a.campaignIds[0] }),
  async plan(a) {
    const rows = await prisma.campaign.findMany({ where: { id: { in: a.campaignIds } }, select: { id: true, name: true, status: true } })
    const byId = new Map(rows.map(r => [r.id, r]))
    const missing = a.campaignIds.filter(id => !byId.has(id))
    const cls = a.campaignIds.length > BULK_STATUS_THRESHOLD ? 'bulk' : 'none'
    if (missing.length > 0) {
      return refuse(cls, `Estas campañas no existen: ${missing.slice(0, 10).join(', ')}. No se ha cambiado ninguna. Usa list_campaigns para obtener los ids.`)
    }
    if (cls === 'none') return { confirmation: 'none' }
    const ordered = a.campaignIds.map(id => byId.get(id)!)
    const list = ordered.map(r => `${quoted(r.name)} (${statusEs(r.status)})`).join(', ')
    return {
      confirmation: 'bulk',
      preview: `Vas a poner ${ordered.length} campañas en estado ${statusEs(a.status)}: ${list}. ${statusEffect(a.status)} ¿Confirmas?`,
      fingerprint: JSON.stringify(ordered.map(r => [r.id, r.status])),
    }
  },
  async execute(a, ctx) {
    const rows = await prisma.campaign.findMany({ where: { id: { in: a.campaignIds } }, select: { id: true, name: true, status: true } })
    const byId = new Map(rows.map(r => [r.id, r]))
    const results: { id: string; name: string | null; before: string | null; after: string | null; result: string; error?: string }[] = []
    for (const id of a.campaignIds) {
      const row = byId.get(id)
      if (!row) {
        results.push({ id, name: null, before: null, after: null, result: 'no existe' })
        continue
      }
      if (row.status === a.status) {
        results.push({ id, name: shortText(row.name, 120), before: row.status, after: row.status, result: 'ya estaba' })
        continue
      }
      const res = await ctx.platform({ method: 'PUT', path: `/api/campaigns/${id}`, body: { status: a.status } })
      const returned = (res.json as { campaign?: { status?: unknown } } | null)?.campaign?.status
      if (res.ok && typeof returned === 'string') {
        results.push({ id, name: shortText(row.name, 120), before: row.status, after: returned, result: returned === a.status ? 'cambiada' : 'sin cambio' })
      } else {
        results.push({ id, name: shortText(row.name, 120), before: row.status, after: null, result: 'error', error: describePlatformFailure(res) })
      }
    }
    const changed = results.filter(r => r.result === 'cambiada').length
    const failed = results.filter(r => r.result === 'error' || r.result === 'no existe').length
    if (changed === 0 && failed > 0 && failed === results.filter(r => r.result !== 'ya estaba').length) {
      const first = results.find(r => r.error)?.error
      throw new ToolError(`No se ha podido cambiar ninguna campaña.${first ? ` ${first}` : ''}`)
    }
    return {
      status: a.status,
      changed,
      failed,
      results,
      notice: changed > 0 ? statusEffect(a.status) : 'No había nada que cambiar.',
    }
  },
})

// ============ set_campaign_tracking_targets ============

const TRACKING_FIELDS = ['targetAccounts', 'targetHashtags', 'targetKeywords'] as const
const TRACKING_NOTICE = 'Los contenidos ya capturados no cambian hasta que se rastree o se revalide la campaña.'

function trackingLists(row: { targetAccounts: readonly string[]; targetHashtags: readonly string[]; targetKeywords: readonly string[] }) {
  return {
    accounts: shortTexts(row.targetAccounts),
    hashtags: shortTexts(row.targetHashtags),
    productKeywords: shortTexts(row.targetKeywords),
  }
}

export const setCampaignTrackingTargets = defineWriteTool({
  name: 'set_campaign_tracking_targets',
  title: 'Configurar qué se rastrea (cuentas, hashtags, palabras clave)',
  description:
    "Replaces the tracking rules of a campaign: the brand's own accounts, the brand hashtags and the product keywords. They decide which publications of the campaign's creators count as campaign content. " +
    'Use it when content is missing because a hashtag or product name is not configured, or to correct the brand accounts. ' +
    'Each list sent REPLACES the stored one, so read the current lists first (get_campaign returns them) and send the complete list. A list left out is kept. ' +
    "The platform refuses creators' handles as brand accounts, generic hashtags and weak keywords with a Spanish explanation to relay. " +
    'Does NOT scrape and does NOT remove content captured under the old rules. To remove what no longer qualifies use revalidate_campaign_media (approved in the platform). ' +
    'launch_campaign_tracking captures with the new rules, but it ENDS with that same revalidation, so it is refused while that revalidation would take pieces out (revalidate first) and for a campaign without rules. ' +
    'A campaign left with no accounts, hashtags or keywords stops being captured and a later revalidation would remove every scraped piece, so that state needs allowNoTargets: true.',
  input: {
    campaignId: campaignIdInput,
    targetAccounts: accountsInput.nullable().optional().describe("Complete list of the brand's own accounts (at most 20, '@' optional). null or [] empties it."),
    targetHashtags: hashtagsInput.nullable().optional().describe("Complete list of brand hashtags (at most 20, '#' optional). null or [] empties it."),
    targetKeywords: keywordsInput.nullable().optional().describe('Complete list of product names (at most 10, 4 to 60 characters each). null or [] empties it.'),
    allowNoTargets: z.boolean().optional().describe('Must be true to save a state where the three lists are empty. Default false.'),
  },
  confirmations: ['none'],
  // Each list REPLACES the stored one: not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({
    campaignId: a.campaignId,
    accounts: a.targetAccounts === undefined ? undefined : (a.targetAccounts ?? []).length,
    hashtags: a.targetHashtags === undefined ? undefined : (a.targetHashtags ?? []).length,
    keywords: a.targetKeywords === undefined ? undefined : (a.targetKeywords ?? []).length,
    allowNoTargets: a.allowNoTargets,
  }),
  async plan(a) {
    if (givenKeys(a, TRACKING_FIELDS).length === 0) {
      return refuse('none', 'Indica al menos una lista: targetAccounts, targetHashtags o targetKeywords.')
    }
    const state = await loadCampaignState(a.campaignId)
    const next = {
      targetAccounts: a.targetAccounts !== undefined ? normalizeTargets(a.targetAccounts ?? []) : state.targetAccounts,
      targetHashtags: a.targetHashtags !== undefined ? normalizeTargets(a.targetHashtags ?? []) : state.targetHashtags,
      targetKeywords: a.targetKeywords !== undefined ? normalizeKeywords(a.targetKeywords ?? []) : state.targetKeywords,
    }
    if (!campaignHasTargets(next) && a.allowNoTargets !== true) {
      return refuse(
        'none',
        'Así la campaña se quedaría sin cuentas de marca, hashtags ni palabras clave: deja de capturarse contenido nuevo y una revalidación sacaría todas las piezas que no se añadieron a mano. ' +
          'Si la persona lo quiere de verdad, vuelve a llamar con allowNoTargets: true.',
      )
    }
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const state = await loadCampaignState(a.campaignId)
    const body: Record<string, unknown> = {}
    for (const field of givenKeys(a, TRACKING_FIELDS)) body[field] = a[field] ?? []
    const after = await putCampaign(ctx, state.id, body)
    const afterLists = {
      targetAccounts: Array.isArray(after.targetAccounts) ? (after.targetAccounts as string[]) : state.targetAccounts,
      targetHashtags: Array.isArray(after.targetHashtags) ? (after.targetHashtags as string[]) : state.targetHashtags,
      targetKeywords: Array.isArray(after.targetKeywords) ? (after.targetKeywords as string[]) : state.targetKeywords,
    }
    return {
      campaign: { id: state.id, name: shortText(state.name, 120) },
      before: trackingLists(state),
      after: trackingLists(afterLists),
      notice: TRACKING_NOTICE,
    }
  },
})

// ============ set_campaign_goals ============

export const setCampaignGoals = defineWriteTool({
  name: 'set_campaign_goals',
  title: 'Fijar objetivo y metas numéricas',
  description:
    'Sets the campaign objective and its numeric targets (views, reach, interactions, ER %, maximum CPM). ' +
    'Once the targets are frozen (the campaign was active with a target), every change of a numeric target is appended to a permanent audit log with the admin and the reason; ' +
    "that log cannot be edited or removed, so targetsChangeReason is required then: ask the person for the reason, never invent it. Use for 'sube el objetivo de vistas a 500.000'. " +
    'A campaign that is not Social Listening must keep an objective and at least one numeric target. null clears a target. ' +
    'The maximum CPM is a money figure: it only appears in the answer with includeEconomics: true. Does NOT touch dates, status or tracking rules.',
  input: {
    campaignId: campaignIdInput,
    objective: z.enum(OBJECTIVES).nullable().optional().describe('awareness, engagement, traffic, conversion or content. null only for a SOCIAL_LISTENING campaign.'),
    targetViews: positiveInt.nullable().optional().describe(`${TARGET_DESCRIPTIONS.targetViews} null clears it.`),
    targetReach: positiveInt.nullable().optional().describe(`${TARGET_DESCRIPTIONS.targetReach} null clears it.`),
    targetEngagement: positiveInt.nullable().optional().describe(`${TARGET_DESCRIPTIONS.targetEngagement} null clears it.`),
    targetER: positiveNumber.nullable().optional().describe(`${TARGET_DESCRIPTIONS.targetER} null clears it.`),
    targetCpmMax: positiveNumber.nullable().optional().describe(`${TARGET_DESCRIPTIONS.targetCpmMax} null clears it.`),
    targetsChangeReason: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .optional()
      .describe('Why the targets change, in the words of the person (3 to 300 characters). Required when the targets are already frozen and a numeric target changes. Stored for good.'),
  },
  confirmations: ['none'],
  // A target can be overwritten or cleared (null): not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({
    campaignId: a.campaignId,
    objective: a.objective === undefined ? undefined : (a.objective ?? 'clear'),
    targets: givenKeys(a, TARGET_KEYS).join(','),
    reason: a.targetsChangeReason !== undefined,
  }),
  async plan(a) {
    const targets = givenKeys(a, TARGET_KEYS)
    if (a.objective === undefined && targets.length === 0) {
      return refuse('none', `Indica el objetivo o al menos una meta: objective, ${TARGET_KEYS.join(', ')}.`)
    }
    const state = await loadCampaignState(a.campaignId)
    const listening = state.type === 'SOCIAL_LISTENING'
    if (a.objective === null && !listening) {
      return refuse('none', 'Una campaña que no es de Social Listening debe tener objetivo: no se puede quitar, solo cambiar por otro.')
    }
    const changedTargets = targets.filter(k => (a[k] ?? null) !== state[k])
    if (!listening && changedTargets.length > 0) {
      const merged = TARGET_KEYS.map(k => (a[k] !== undefined ? a[k] ?? null : state[k]))
      if (merged.every(v => v === null)) {
        return refuse('none', 'La campaña debe conservar al menos una meta numérica (vistas, alcance, interacciones, ER o CPM máximo). No se ha cambiado nada.')
      }
    }
    if (state.targetsFrozenAt && changedTargets.length > 0 && !a.targetsChangeReason) {
      return refuse(
        'none',
        `Las metas están congeladas desde el ${isoDay(state.targetsFrozenAt)}: cada cambio queda anotado para siempre en el historial de objetivos con su motivo. ` +
          'Pregunta a la persona el motivo y vuelve a llamar con targetsChangeReason (3 a 300 caracteres).',
      )
    }
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const state = await loadCampaignState(a.campaignId)
    const current = state as unknown as Record<string, unknown>
    const body: Record<string, unknown> = {}
    if (a.objective !== undefined && (a.objective ?? null) !== state.objective) body.objective = a.objective
    const changedTargets = givenKeys(a, TARGET_KEYS).filter(k => (a[k] ?? null) !== state[k])
    for (const k of changedTargets) body[k] = a[k] ?? null
    const logged = !!state.targetsFrozenAt && changedTargets.length > 0
    if (logged) body.targetsChangeReason = a.targetsChangeReason
    const changed = Object.keys(body).filter(k => k !== 'targetsChangeReason')
    if (changed.length === 0) {
      return { campaign: { id: state.id, name: shortText(state.name, 120) }, changed: [], message: 'No había nada que cambiar: la campaña ya tenía esos valores.' }
    }
    const after = await putCampaign(ctx, state.id, body)
    const notes: string[] = []
    if (logged) notes.push(`El cambio queda anotado de forma permanente en el historial de objetivos con el motivo: ${a.targetsChangeReason}.`)
    else if (!state.targetsFrozenAt && after.targetsFrozenAt) {
      notes.push('Las metas han quedado congeladas: a partir de ahora cada cambio de una meta queda anotado en el historial con su motivo.')
    }
    const shownChange = beforeAfter(changed, current, after, ctx.includeEconomics)
    if (shownChange.moneyHidden.length) notes.push(moneyHiddenNote(shownChange.moneyHidden))
    return {
      campaign: { id: state.id, name: shortText(state.name, 120) },
      changed,
      before: shownChange.before,
      after: shownChange.after,
      ...(notes.length ? { notes } : {}),
    }
  },
})

// ============ record_business_results ============

const BUSINESS_FIELDS = [
  'promoCode',
  'codeRedemptions',
  'clientReportedSales',
  'clientReportedLeads',
  'clientReportedRevenue',
  'businessResultsSource',
  'businessResultsReportedAt',
  'businessResultsNotes',
] as const
/** Short names of BUSINESS_FIELDS for the call log, whose values are cut at 80 characters. */
const BUSINESS_LOG_NAMES: Record<(typeof BUSINESS_FIELDS)[number], string> = {
  promoCode: 'code',
  codeRedemptions: 'redemptions',
  clientReportedSales: 'sales',
  clientReportedLeads: 'leads',
  clientReportedRevenue: 'revenue',
  businessResultsSource: 'source',
  businessResultsReportedAt: 'reportedAt',
  businessResultsNotes: 'notes',
}
const nonNegativeInt = z.number().int().min(0).max(1_000_000_000_000)

export const recordBusinessResults = defineWriteTool({
  name: 'record_business_results',
  title: 'Anotar resultados de negocio del cliente',
  description:
    'Records the business results the client reported for a campaign: promo code and redemptions, sales, leads, revenue, their source, the date they were reported and notes. ' +
    'They appear in the business section of the client report and portal. Use only with figures the person supplies; never estimate or derive them. null clears a field; fields left out are kept. ' +
    'Revenue is a money figure: it only appears in the answer with includeEconomics: true. Does NOT compute anything and does not mark the report as sent.',
  input: {
    campaignId: campaignIdInput,
    promoCode: z.string().trim().max(100).nullable().optional().describe('Promo code, at most 100 characters, or null.'),
    codeRedemptions: nonNegativeInt.nullable().optional().describe('Redemptions of the code, an integer >= 0, or null.'),
    clientReportedSales: nonNegativeInt.nullable().optional().describe('Sales reported by the client, an integer >= 0, or null.'),
    clientReportedLeads: nonNegativeInt.nullable().optional().describe('Leads reported by the client, an integer >= 0, or null.'),
    clientReportedRevenue: z.number().min(0).max(1_000_000_000_000).nullable().optional().describe('Revenue reported by the client in EUR, >= 0, or null.'),
    businessResultsSource: z.string().trim().max(200).nullable().optional().describe('Where the figures come from (e.g. "Informe Shopify del cliente"), at most 200 characters, or null.'),
    businessResultsReportedAt: dayInput('Day the client reported them, YYYY-MM-DD.').nullable().optional(),
    businessResultsNotes: z.string().trim().max(2000).nullable().optional().describe('Notes, at most 2,000 characters, or null.'),
  },
  confirmations: ['none'],
  // A figure can be overwritten or cleared (null): not an additive update
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({ campaignId: a.campaignId, fields: givenKeys(a, BUSINESS_FIELDS).map(f => BUSINESS_LOG_NAMES[f]).join(',') }),
  async plan(a) {
    if (givenKeys(a, BUSINESS_FIELDS).length === 0) {
      return refuse('none', `Indica al menos un dato: ${BUSINESS_FIELDS.join(', ')}.`)
    }
    await loadCampaignHead(a.campaignId)
    return { confirmation: 'none' }
  },
  async execute(a, ctx) {
    const state = await loadCampaignState(a.campaignId)
    const fields = givenKeys(a, BUSINESS_FIELDS)
    const body: Record<string, unknown> = {}
    for (const f of fields) body[f] = a[f] ?? null
    const after = await putCampaign(ctx, state.id, body)
    const { before, after: saved, moneyHidden } = beforeAfter(fields, state as unknown as Record<string, unknown>, after, ctx.includeEconomics)
    return {
      campaign: { id: state.id, name: shortText(state.name, 120) },
      saved,
      before,
      ...(moneyHidden.length ? { notes: [moneyHiddenNote(moneyHidden)] } : {}),
      notice: 'Visibles en el apartado de negocio del informe y del portal del cliente.',
    }
  },
})

// ============ delete_campaign ============

export const deleteCampaign = defineWriteTool({
  name: 'delete_campaign',
  title: 'Borrar campaña definitivamente',
  description:
    "Permanently deletes one campaign with all its creators' memberships (fees, deal terms, shipping data), every captured publication and story with its metrics, comments, brief files, internal notes and team assignments. " +
    'Irreversible, no backup. Use only when the person explicitly asks to delete; always offer archiving first (set_campaign_status ARCHIVED hides it without losing data). One campaign per call.',
  input: { campaignId: campaignIdInput },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, idempotentHint: false },
  summarize: a => ({ campaignId: a.campaignId }),
  async plan(a) {
    const head = await prisma.campaign.findUnique({
      where: { id: a.campaignId },
      select: { id: true, name: true, status: true, startDate: true, endDate: true },
    })
    if (!head) return refuse('destructive', CAMPAIGN_NOT_FOUND)
    const id = head.id
    const [brand, creators, pieces, stories, briefFiles, notes, team] = await Promise.all([
      campaignBrandName(id),
      prisma.campaignInfluencer.count({ where: { campaignId: id } }),
      prisma.media.count({ where: { campaignId: id, mediaType: { not: 'STORY' } } }),
      prisma.media.count({ where: { campaignId: id, mediaType: 'STORY' } }),
      prisma.briefFile.count({ where: { campaignId: id } }),
      prisma.campaignNote.count({ where: { campaignId: id } }),
      prisma.campaignAssignment.count({ where: { campaignId: id } }),
    ])
    const window = `del ${isoDay(head.startDate) ?? '?'} al ${isoDay(head.endDate) ?? 'sin fecha de fin'}`
    const preview =
      `Vas a BORRAR DEFINITIVAMENTE la campaña ${quoted(head.name)} (${brand ? `marca ${shortText(brand, 80)}` : 'sin marca'}, ${statusEs(head.status)}, ${window}). ` +
      `Se eliminan: ${creators} creadoras con sus fees, condiciones y direcciones de envío; ${pieces} publicaciones y ${stories} stories con sus métricas y comentarios; ` +
      `${briefFiles} archivos de brief; ${notes} notas internas y el equipo asignado (${team} ${team === 1 ? 'persona' : 'personas'}). ` +
      'No se puede deshacer y no hay copia. Alternativa sin pérdida: archivarla. ¿Confirmas el borrado?'
    return { confirmation: 'destructive', preview }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    await ctx.platformJson({ method: 'DELETE', path: `/api/campaigns/${head.id}` })
    return { deleted: true, campaign: { id: head.id, name: shortText(head.name, 120) }, message: `Campaña ${quoted(head.name)} borrada definitivamente.` }
  },
})

// ============ revalidate_campaign_media ============

interface RevalidationProjection {
  total: number
  manual: number
  leave: number
  detach: number
  remove: number
  examples: string[]
  hasTargets: boolean
}

/**
 * What POST /api/campaigns/[id]/revalidate-media WOULD take out now, with the
 * same rule function (src/lib/campaign-capture.ts revalidationVerdict):
 * not a member or outside the dates → out (hand-added pieces too, except a
 * late piece added by hand up to 30 days after the end); scraped pieces that
 * do not reference a brand target → out. A piece that goes is deleted when
 * another copy of the post exists, otherwise detached.
 */
export async function projectRevalidation(campaignId: string): Promise<RevalidationProjection & { name: string; window: string; members: number; targets: { accounts: string[]; hashtags: string[]; productKeywords: string[] } }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      name: true,
      type: true,
      targetAccounts: true,
      targetHashtags: true,
      targetKeywords: true,
      startDate: true,
      endDate: true,
      influencers: { select: { influencerId: true } },
    },
  })
  if (!campaign) throw new ToolError(CAMPAIGN_NOT_FOUND)
  const members = new Set(campaign.influencers.map(i => i.influencerId))
  const rows = await prisma.media.findMany({
    where: { campaignId },
    select: {
      id: true,
      influencerId: true,
      externalId: true,
      platform: true,
      mediaType: true,
      caption: true,
      hashtags: true,
      mentions: true,
      postedAt: true,
      source: true,
      influencer: { select: { username: true } },
    },
  })
  let manual = 0
  const out: { row: (typeof rows)[number]; why: string }[] = []
  // The platform's own verdict per row (src/lib/campaign-capture.ts): a hand-added
  // late piece («fuera de plazo», up to 30 days after the end) stays, like the platform keeps it
  const WHY = { out_member: 'ya no es creadora de la campaña', out_dates: 'fuera de fechas', out_brand: 'no menciona la marca' } as const
  for (const row of rows) {
    const verdict = revalidationVerdict(campaign, members, row)
    if (verdict === 'keep_manual' || verdict === 'keep_late_manual') manual++
    else if (verdict !== 'keep_rules') out.push({ row, why: WHY[verdict] })
  }

  // Which of the leaving pieces have another copy of the same post (deleted) and which are the only one (detached)
  const keys = Array.from(new Set(out.filter(o => o.row.externalId).map(o => `${o.row.platform}|${o.row.externalId}`)))
  const copies = new Map<string, Set<string>>()
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200).map(k => {
      const [platform, externalId] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]
      return { platform: platform as (typeof rows)[number]['platform'], externalId }
    })
    const found = await prisma.media.findMany({ where: { OR: chunk }, select: { id: true, platform: true, externalId: true } })
    for (const f of found) {
      const key = `${f.platform}|${f.externalId}`
      if (!copies.has(key)) copies.set(key, new Set())
      copies.get(key)!.add(f.id)
    }
  }
  let remove = 0
  let detach = 0
  for (const { row } of out) {
    const set = row.externalId ? copies.get(`${row.platform}|${row.externalId}`) : undefined
    const others = set ? [...set].filter(id => id !== row.id) : []
    if (others.length > 0) {
      remove++
      set!.delete(row.id) // as the platform does it, one row after the other
    } else {
      detach++
    }
  }

  const examples = out.slice(0, 8).map(({ row, why }) => {
    const who = row.influencer?.username ? `@${shortText(row.influencer.username, 60)}` : 'creadora sin usuario'
    return `${row.mediaType} de ${who} (${isoDay(row.postedAt) ?? 'sin fecha'}, ${why})`
  })
  return {
    name: campaign.name,
    window: `del ${isoDay(campaign.startDate) ?? '?'} al ${isoDay(campaign.endDate) ?? 'sin fecha de fin'}`,
    members: members.size,
    targets: trackingLists(campaign),
    total: rows.length,
    manual,
    leave: out.length,
    detach,
    remove,
    examples,
    hasTargets: campaignHasTargets(campaign),
  }
}

/**
 * The state a revalidation preview describes: the rules (targets, dates,
 * members) and what would leave. When any of it changes after the
 * administrator approved, the run is refused (src/lib/mcp/write-tool.ts):
 * a date or a target changed in between must never take out more than the
 * preview said.
 */
export function revalidationFingerprint(p: Awaited<ReturnType<typeof projectRevalidation>>): string {
  return JSON.stringify({ targets: p.targets, window: p.window, members: p.members, leave: p.leave, detach: p.detach, remove: p.remove, hasTargets: p.hasTargets })
}

/** A list of rules for a preview: at most 10, each cut at 40 characters, so the preview stays short. */
const listOrNone = (values: string[]) =>
  values.length ? `${values.slice(0, 10).map(v => v.slice(0, 40)).join(', ')}${values.length > 10 ? ` y ${values.length - 10} más` : ''}` : 'ninguna'

export const revalidateCampaignMedia = defineWriteTool({
  name: 'revalidate_campaign_media',
  title: 'Revalidar los contenidos de la campaña',
  description:
    'Re-checks every captured piece of a campaign against its current rules (the creator is a member, the date is inside the campaign, the piece references the brand unless it was added by hand) ' +
    'and takes out those that fail: detached when it is the only copy of the post, deleted when another copy exists elsewhere. Hand-added pieces are also removed when their creator is no longer a member or their date is outside the campaign, except a late piece added by hand up to 30 days after the end, which stays. ' +
    'Use after changing dates or tracking rules, or when the person asks to clean the campaign. The preview says how many pieces would leave with the data of that moment; ' +
    'the real result is computed when it runs. Does NOT scrape and does not touch other campaigns.',
  input: { campaignId: campaignIdInput },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, idempotentHint: false },
  summarize: a => ({ campaignId: a.campaignId }),
  async plan(a) {
    const exists = await prisma.campaign.findUnique({ where: { id: a.campaignId }, select: { id: true } })
    if (!exists) return refuse('destructive', CAMPAIGN_NOT_FOUND)
    const p = await projectRevalidation(a.campaignId)
    const parts = [
      `Vas a revalidar los ${p.total} contenidos de ${quoted(p.name)} con las reglas actuales: cuentas ${listOrNone(p.targets.accounts)}; hashtags ${listOrNone(p.targets.hashtags)}; palabras clave ${listOrNone(p.targets.productKeywords)}; fechas ${p.window}; ${p.members} creadoras.`,
      'Los que no cumplan salen de la campaña (se desvinculan, o se borran si existe otra copia) y cambian los totales, el informe y el portal del cliente.',
      p.leave === 0
        ? 'Con los datos de ahora no saldría ninguno.'
        : `Con los datos de ahora saldrían ${p.leave}: ${p.detach} se desvincularían y ${p.remove} se borrarían porque hay otra copia. Por ejemplo: ${p.examples.join('; ')}.`,
      'El resultado real se calcula al ejecutarlo, con las reglas y los datos de ese momento.',
      p.hasTargets ? '' : 'ATENCIÓN: la campaña no tiene cuentas, hashtags ni palabras clave; saldrán todas las piezas que no se añadieron a mano.',
      'Las borradas no se recuperan; las desvinculadas se pueden volver a añadir por URL. ¿Confirmas?',
    ]
    return { confirmation: 'destructive', preview: parts.filter(Boolean).join(' '), fingerprint: revalidationFingerprint(p) }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    const res = await ctx.platformJson<{ kept?: unknown; detached?: unknown; targetsConfigured?: unknown }>({
      method: 'POST',
      path: `/api/campaigns/${head.id}/revalidate-media`,
    })
    const kept = typeof res.kept === 'number' ? res.kept : null
    const removed = typeof res.detached === 'number' ? res.detached : null
    return {
      campaign: { id: head.id, name: shortText(head.name, 120) },
      kept,
      removed,
      targetsConfigured: res.targetsConfigured === true,
      message:
        removed === 0
          ? 'Revalidación hecha: todos los contenidos cumplen las reglas; no ha salido ninguno.'
          : `Revalidación hecha: se quedan ${kept ?? '?'} y han salido ${removed ?? '?'} (desvinculados, o borrados si había otra copia). Los totales, el informe y el portal ya reflejan el cambio.`,
    }
  },
})

// ============ set_campaign_access ============

interface StaffPerson {
  id: string
  name: string
  role: string
}

interface CampaignTeam {
  ownerId: string | null
  members: (StaffPerson & { isOwner: boolean; assigned: boolean })[]
  staff: StaffPerson[]
}

/** GET /api/campaigns/[id]/assignments, names and roles only (the route also returns e-mails: never copied). */
async function loadTeam(ctx: WriteContext, campaignId: string): Promise<CampaignTeam> {
  const data = await ctx.platformJson<{ ownerId?: unknown; members?: unknown; staff?: unknown }>({ method: 'GET', path: `/api/campaigns/${campaignId}/assignments` })
  const person = (raw: unknown): StaffPerson | null => {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string') return null
    return { id: r.id, name: shortText(r.name, 80) ?? '(sin nombre)', role: typeof r.role === 'string' ? r.role : '' }
  }
  const members: CampaignTeam['members'] = []
  for (const raw of Array.isArray(data.members) ? data.members : []) {
    const p = person(raw)
    if (!p) continue
    const r = raw as Record<string, unknown>
    members.push({ ...p, isOwner: r.isOwner === true, assigned: typeof r.assignmentId === 'string' })
  }
  const staff = (Array.isArray(data.staff) ? data.staff : []).map(person).filter((p): p is StaffPerson => !!p)
  return { ownerId: typeof data.ownerId === 'string' ? data.ownerId : null, members, staff }
}

function staffList(staff: StaffPerson[]): string {
  const shown = staff.slice(0, 30).map(s => `${s.name} (${s.id})`).join(', ')
  return staff.length > 30 ? `${shown} y ${staff.length - 30} más` : shown
}

export const setCampaignAccess = defineWriteTool({
  name: 'set_campaign_access',
  title: 'Dar o quitar acceso a la campaña',
  description:
    'Gives a staff member access to a campaign (adds them to its team) or removes it. Granting makes the campaign appear in that person list and subscribes them to its in-app notifications; ' +
    "they get one in-app notification and no e-mail. Granting runs at once ('acceso dado' or 'ya lo tenía'); revoking needs the administrator's approval in the platform. " +
    "Use for 'dale acceso a Laura'. userId must be an active ADMIN or EMPLOYEE; the staff ids are in GET /api/campaigns/<id>/assignments (platform_request), and an id that is not staff is refused with the list of staff names and ids. " +
    'The person who created the campaign always keeps access. ' +
    'Does NOT create users, change roles, invite anyone or change brand-level assignments.',
  input: {
    campaignId: campaignIdInput,
    userId: idInput('The id of a staff member (an active ADMIN or EMPLOYEE).'),
    action: z.enum(['grant', 'revoke']).describe('grant gives access; revoke removes it.'),
  },
  confirmations: ['none', 'destructive'],
  annotations: { destructiveHint: true, idempotentHint: true },
  summarize: a => ({ campaignId: a.campaignId, userId: a.userId, action: a.action }),
  async plan(a, ctx) {
    const cls = a.action === 'revoke' ? 'destructive' : 'none'
    const exists = await prisma.campaign.findUnique({ where: { id: a.campaignId }, select: { id: true, name: true } })
    if (!exists) return refuse(cls, CAMPAIGN_NOT_FOUND)
    const team = await loadTeam(ctx, a.campaignId)
    if (a.action === 'grant') {
      if (!team.staff.some(s => s.id === a.userId)) {
        return refuse('none', `Ese id no es de nadie del equipo interno activo (ADMIN o EMPLOYEE). Personas a las que se puede dar acceso: ${staffList(team.staff)}.`)
      }
      return { confirmation: 'none' }
    }
    const m = team.members.find(x => x.id === a.userId)
    if (!m) {
      return refuse('destructive', `Esa persona no está en el equipo de ${quoted(exists.name)}: no hay acceso que quitar. Equipo actual: ${staffList(team.members) || 'nadie'}.`)
    }
    if (m.isOwner || team.ownerId === a.userId) {
      return refuse('destructive', `${m.name} creó ${quoted(exists.name)}: conserva el acceso y los avisos siempre, no se le puede quitar.`)
    }
    return {
      confirmation: 'destructive',
      preview: `Vas a quitar a ${m.name} del equipo de ${quoted(exists.name)}: dejará de verla en su lista y de recibir sus avisos. Se puede volver a dar. ¿Confirmas?`,
    }
  },
  async execute(a, ctx) {
    const head = await loadCampaignHead(a.campaignId)
    const team = await loadTeam(ctx, head.id)
    const person = team.staff.find(s => s.id === a.userId) ?? team.members.find(s => s.id === a.userId) ?? null
    const who = person ? { id: person.id, name: person.name } : { id: a.userId, name: null }
    if (a.action === 'grant') {
      const res = await ctx.platformJson<{ created?: unknown }>({ method: 'POST', path: `/api/campaigns/${head.id}/assignments`, body: { userId: a.userId } })
      const created = res.created === true
      return {
        campaign: { id: head.id, name: shortText(head.name, 120) },
        person: who,
        result: created ? 'acceso dado' : 'ya lo tenía',
        notified: created && a.userId !== ctx.user.id ? 'Recibe un aviso en la plataforma (sin correo).' : null,
      }
    }
    const res = await ctx.platformJson<{ removed?: unknown }>({ method: 'DELETE', path: `/api/campaigns/${head.id}/assignments`, query: { userId: a.userId } })
    const removed = typeof res.removed === 'number' ? res.removed : 0
    return {
      campaign: { id: head.id, name: shortText(head.name, 120) },
      person: who,
      result: removed > 0 ? 'acceso quitado' : 'no tenía acceso asignado',
    }
  },
})

// ============ Registration ============

/** The campaign write tools, in the order Claude lists them. */
export const CAMPAIGN_WRITE_TOOLS: readonly WriteTool[] = [
  createCampaign,
  updateCampaign,
  setCampaignStatus,
  setCampaignTrackingTargets,
  setCampaignGoals,
  recordBusinessResults,
  deleteCampaign,
  revalidateCampaignMedia,
  setCampaignAccess,
]

/** Hands every campaign write tool to `register` (server.ts registers each with writeToolConfig and tool.call). */
export function registerCampaignWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of CAMPAIGN_WRITE_TOOLS) register(tool)
}
