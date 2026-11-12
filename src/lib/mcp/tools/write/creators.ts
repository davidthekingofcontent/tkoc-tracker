/**
 * Write tools of the MCP connector for CREATORS: membership of a campaign
 * (add, stage, deal, shipping, remove, move, notes), the creator record
 * (analyse, import, paid search, edit, create by hand), the admin's Contact
 * address and the e-mail invitation to connect.
 *
 * Every tool is built with defineWriteTool (../../write-tool.ts): the call
 * log, the grant and role check, the confirmations and the output filter are
 * applied there. Here each tool only decides the class of a call (plan) and
 * calls the platform's own routes as the authorising admin (execute). Every
 * body below was checked against the route in this working copy.
 *
 * Reads for previews go through the platform too (GET /api/campaigns/[id],
 * /api/lists/..., /api/influencers/invite). Where the platform has no exact
 * read, the tool reads the database directly and READS ONLY: the case
 * insensitive lookup of a creator by handle (the routes search with
 * `contains` and paginate, which can miss an exact match and lead to a paid
 * duplicate) and the creator pool check of an import.
 *
 * The first part of this file holds the helpers the other files of this
 * folder share (publications.ts, lists.ts, tracking.ts).
 *
 * Not here on purpose: link_creator_profile (it depends on a model that lives
 * on another branch).
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { escapeForInsensitiveEquals } from '@/lib/auth'
import { parseCreatorHandle } from '@/lib/handles'
import { countExecutedSince } from '../../confirm'
import { describePlatformFailure, type PlatformRequest, type PlatformResponse } from '../../platform-client'
import { defineWriteTool, type ApifyStatus, type WriteContext, type WriteTool } from '../../write-tool'
import { ToolError, idInput, shortText } from '../shared'

// =====================================================================
// Shared helpers of the write tools (also used by the other files here)
// =====================================================================

export const CREATOR_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const
export type CreatorPlatform = (typeof CREATOR_PLATFORMS)[number]
export const PLATFORM_NAME: Record<CreatorPlatform, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

export const PIPELINE_STATUSES = ['PROSPECT', 'OUTREACH', 'NEGOTIATING', 'AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] as const
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number]
/** The names of the stages in the platform's own screens. */
export const STATUS_LABEL: Record<PipelineStatus, string> = {
  PROSPECT: 'Prospecto',
  OUTREACH: 'Contacto',
  NEGOTIATING: 'Negociando',
  AGREED: 'Acordado',
  CONTRACTED: 'Contratado',
  SHIPPING: 'Envío',
  POSTED: 'Publicado',
  COMPLETED: 'Completado',
}
/** A real change INTO one of these stages fires a paid capture in PATCH /api/campaigns/[id]/influencers. */
export const CAPTURE_STATUSES: ReadonlySet<PipelineStatus> = new Set<PipelineStatus>(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'])

/** Long synchronous loops of one tool stop starting new platform calls after this (a tool call times out at 240 s in Claude). */
export const WRITE_TIME_BUDGET_MS = 150_000

export type Json = Record<string, unknown>
export const asObject = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const asStrings = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === 'string')

export function asPlatform(v: unknown): CreatorPlatform {
  return v === 'TIKTOK' || v === 'YOUTUBE' ? v : 'INSTAGRAM'
}

export function asStatus(v: unknown): PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(v as string) ? (v as PipelineStatus) : 'PROSPECT'
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** `@a, @b, @c y 4 más`, or `ninguna`. */
export function listText(items: readonly string[], max = 20, empty = 'ninguna'): string {
  if (items.length === 0) return empty
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} y ${items.length - max} más` : shown
}

/** A handle as it travels in a preview: `@user`, cleaned of control characters. */
export function at(username: unknown): string {
  return `@${shortText(username, 60) ?? '?'}`
}

/** A name typed by people on the platform (a campaign, a list), quoted for a preview. */
export function named(value: unknown, fallback = 'sin nombre'): string {
  return `«${shortText(value, 120) ?? fallback}»`
}

/** `uso actual del plan: 42 %`: a percentage, never an amount. */
export function usageText(status: ApifyStatus): string {
  return status.usedPct === null ? 'uso actual del plan: desconocido' : `uso actual del plan: ${status.usedPct} %`
}

/** Text a model typed, echoed back in a refusal: short and clean. */
export function echo(value: unknown, max = 60): string {
  return `"${shortText(value, max) ?? ''}"`
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const PHONE_RE = /^[0-9+()\s-]{6,40}$/

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const httpUrlInput = (max: number, what: string) =>
  z.string().trim().min(1).max(max).refine(isHttpUrl, 'must be an absolute http(s) URL').describe(what)

export const emailInput = (what: string) => z.string().trim().max(200).regex(EMAIL_RE, 'must be an e-mail address').describe(what)

/** 6-40 characters of digits, spaces, + ( ) -, with at least 6 digits (as PATCH /api/influencers/[id] checks). */
export const phoneInput = (what: string) =>
  z
    .string()
    .trim()
    .regex(PHONE_RE, 'must be 6-40 digits, spaces, + ( ) or -')
    .refine(v => (v.match(/\d/g)?.length ?? 0) >= 6, 'must carry at least 6 digits')
    .describe(what)

/** An ISO 8601 date or instant, as the routes parse it with new Date(). */
export const isoDateInput = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/, 'must be an ISO 8601 date or date-time')
    .refine(v => !Number.isNaN(new Date(v).getTime()), 'is not a real date')
    .describe(what)

export const countInput = (what: string) => z.number().int().min(0).max(2_000_000_000).describe(what)

/** Stops a loop of platform calls before Claude's own tool timeout. */
export function timeBudget(ms: number = WRITE_TIME_BUDGET_MS) {
  const end = Date.now() + ms
  return {
    left: () => end - Date.now(),
    /** The timeout of the next call: at most `cap`, never past the budget. */
    timeout: (cap: number) => Math.max(1_000, Math.min(cap, end - Date.now())),
  }
}

export type CallOutcome =
  | { ok: true; status: number; json: Json }
  | { ok: false; status: number; timeout: boolean; message: string; json: Json }

/** One platform call that never throws for a refusal of the route: the outcome is kept per item. */
export async function attempt(ctx: WriteContext, req: PlatformRequest): Promise<CallOutcome> {
  const res: PlatformResponse = await ctx.platform(req)
  if (res.ok) return { ok: true, status: res.status, json: asObject(res.json) }
  return { ok: false, status: res.status, timeout: res.problem === 'timeout', message: describePlatformFailure(res), json: asObject(res.json) }
}

export const UNKNOWN_AFTER_TIMEOUT =
  'Resultado desconocido: la plataforma no respondió a tiempo y puede seguir trabajando. No lo repitas; compruébalo con una lectura en unos minutos.'
export const NOT_ATTEMPTED = 'No se ha intentado: se acabó el tiempo de esta llamada. Vuelve a llamar solo con lo que falta.'
export const SKIPPED_AFTER_TIMEOUT = 'No se ha intentado: la anterior no respondió a tiempo.'

// ============ Campaigns as the write tools read them ============

export interface Pieces {
  media: number
  posts: number
  stories: number
}

export interface CampaignMember {
  /** CampaignInfluencer id (the Kanban route takes it). */
  membershipId: string
  influencerId: string
  username: string
  platform: CreatorPlatform
  status: PipelineStatus
  /** Every column of the membership, as GET /api/campaigns/[id] returns it (deal, shipping...). Internal: never returned as is. */
  row: Json
  pieces: Pieces
}

export interface CampaignSnapshot {
  id: string
  name: string
  status: string
  type: string
  platforms: string[]
  startDate: string | null
  endDate: string | null
  targetAccounts: string[]
  targetHashtags: string[]
  targetKeywords: string[]
  /** Accounts, hashtags or product keywords: without them nothing is captured (and nothing is spent on capture). */
  hasTargets: boolean
  members: CampaignMember[]
  byInfluencer: Map<string, CampaignMember>
}

const stripSigil = (v: string) => v.trim().replace(/^[@#]+/, '').trim()

/** GET /api/campaigns/[id] (one media row only): the campaign, its members and their pieces. */
export async function readCampaign(ctx: WriteContext, campaignId: string): Promise<CampaignSnapshot> {
  const data = asObject(await ctx.platformJson({ method: 'GET', path: `/api/campaigns/${campaignId}`, query: { mediaLimit: 1 } }))
  const c = asObject(data.campaign)
  const id = asString(c.id)
  if (!id) throw new ToolError('No se ha podido leer la campaña.')
  const pieces = new Map<string, Pieces>()
  for (const raw of asArray(asObject(data.overview).perInfluencer)) {
    const p = asObject(raw)
    const influencerId = asString(p.influencerId)
    if (influencerId) pieces.set(influencerId, { media: asNumber(p.media) ?? 0, posts: asNumber(p.posts) ?? 0, stories: asNumber(p.stories) ?? 0 })
  }
  const members: CampaignMember[] = []
  for (const raw of asArray(c.influencers)) {
    const row = asObject(raw)
    const inf = asObject(row.influencer)
    const influencerId = asString(row.influencerId)
    const membershipId = asString(row.id)
    if (!influencerId || !membershipId) continue
    members.push({
      membershipId,
      influencerId,
      username: asString(inf.username) ?? '?',
      platform: asPlatform(inf.platform),
      status: asStatus(row.status),
      row,
      pieces: pieces.get(influencerId) ?? { media: 0, posts: 0, stories: 0 },
    })
  }
  const targetAccounts = asStrings(c.targetAccounts)
  const targetHashtags = asStrings(c.targetHashtags)
  const targetKeywords = asStrings(c.targetKeywords)
  return {
    id,
    name: asString(c.name) ?? '',
    status: asString(c.status) ?? '',
    type: asString(c.type) ?? '',
    platforms: asStrings(c.platforms),
    startDate: asString(c.startDate),
    endDate: asString(c.endDate),
    targetAccounts,
    targetHashtags,
    targetKeywords,
    hasTargets: [...targetAccounts, ...targetHashtags, ...targetKeywords].some(v => stripSigil(v).length > 0),
    members,
    byInfluencer: new Map(members.map(m => [m.influencerId, m])),
  }
}

/** The members for these ids, in order and without repeats. Refuses when one is not a member. */
export function requireMembers(snapshot: CampaignSnapshot, ids: readonly string[]): CampaignMember[] {
  const unique = [...new Set(ids)]
  const missing = unique.filter(id => !snapshot.byInfluencer.has(id))
  if (missing.length > 0) {
    throw new ToolError(
      `No ${missing.length === 1 ? 'es integrante' : 'son integrantes'} de ${named(snapshot.name)}: ${listText(missing, 10)}. No se ha hecho nada. Usa list_campaign_creators para ver sus integrantes y sus ids.`,
    )
  }
  return unique.map(id => snapshot.byInfluencer.get(id) as CampaignMember)
}

// ============ Creators by handle ============

export interface ParsedHandle {
  username: string
  platform: CreatorPlatform
}

/**
 * `@user`, `user` or a profile URL of instagram.com, tiktok.com or youtube.com
 * (src/lib/handles.ts). Instagram and TikTok handles are lower-cased (the
 * routes look creators up case-sensitively). Null for a post URL, a URL of
 * another site or anything that is not a handle.
 */
export function normalizeHandle(raw: string, fallback: CreatorPlatform): ParsedHandle | null {
  const text = raw.trim()
  const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(text) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(text)
  const parsed = parseCreatorHandle(text)
  if (looksLikeUrl && !parsed.platform) return null
  const platform = parsed.platform ?? fallback
  const username = parsed.username
  if (!username || !/^[A-Za-z0-9._-]{1,60}$/.test(username)) return null
  return { username: platform === 'YOUTUBE' ? username : username.toLowerCase(), platform }
}

export interface StoredCreator {
  id: string
  username: string
  platform: CreatorPlatform
  followers: number
  engagementRate: number
  lastScraped: Date | null
}

/** The creators stored with this handle on this network, compared without case. Reads only. */
export async function findCreatorsByHandle(username: string, platform: CreatorPlatform): Promise<StoredCreator[]> {
  const rows = await prisma.influencer.findMany({
    where: { platform, username: { equals: escapeForInsensitiveEquals(username), mode: 'insensitive' } },
    orderBy: [{ followers: 'desc' }, { id: 'asc' }],
    take: 10,
    select: { id: true, username: true, platform: true, followers: true, engagementRate: true, lastScraped: true },
  })
  const wanted = username.toLowerCase()
  return rows
    .filter(r => r.username.toLowerCase() === wanted)
    .map(r => ({ ...r, platform: asPlatform(r.platform) }))
    .sort((a, b) => Number(b.username === username) - Number(a.username === username))
}

/** Compact public profile of a creator as a route returned it. Contact fields only with includeContact. */
export function compactCreator(raw: unknown, includeContact: boolean): Json {
  const c = asObject(raw)
  const count = asObject(c._count)
  return {
    influencerId: asString(c.id),
    username: asString(c.username),
    platform: asString(c.platform),
    displayName: shortText(c.displayName, 120),
    followers: asNumber(c.followers),
    following: asNumber(c.following),
    postsCount: asNumber(c.postsCount),
    engagementRate: asNumber(c.engagementRate),
    avgLikes: asNumber(c.avgLikes),
    avgComments: asNumber(c.avgComments),
    avgViews: asNumber(c.avgViews),
    country: shortText(c.country, 10),
    language: shortText(c.language, 10),
    isVerified: c.isVerified === true,
    lastScraped: asString(c.lastScraped),
    campaigns: asNumber(count.campaigns),
    publicationsStored: asNumber(count.media),
    ...(includeContact
      ? { email: asString(c.email), phone: asString(c.phone), website: asString(c.website), city: asString(c.city) }
      : {}),
  }
}

// =====================================================================
// add_creators_to_campaign
// =====================================================================

const MAX_ADD = 20
const ADD_TIMEOUT_MS = 180_000
/** A platform call of add_creators_to_campaign is only started with at least this much of the budget left. */
const ADD_MIN_LEFT_MS = 15_000

interface AddPlan {
  snapshot: CampaignSnapshot
  /** Handles for the bulk route, per network: the stored username for known creators, the lower-cased one for new ones. */
  byPlatform: Map<CreatorPlatform, string[]>
  /** Existing creators given by id, added one by one. */
  byId: { id: string; username: string; platform: CreatorPlatform }[]
  known: string[]
  unknown: string[]
  alreadyMembers: string[]
}

const addPlans = new WeakMap<WriteContext, AddPlan>()

async function resolveAdd(
  args: { campaignId: string; handles?: string[]; platform?: CreatorPlatform; influencerIds?: string[] },
  ctx: WriteContext,
): Promise<AddPlan> {
  const handles = args.handles ?? []
  const ids = [...new Set(args.influencerIds ?? [])]
  if (handles.length + ids.length === 0) {
    throw new ToolError('Indica al menos una creadora: handles (@usuario o URL de perfil) o influencerIds. No se ha hecho nada.')
  }
  if (handles.length + ids.length > MAX_ADD) throw new ToolError(`Como mucho ${MAX_ADD} creadoras por llamada. No se ha hecho nada.`)

  const parsed: ParsedHandle[] = []
  const invalid: string[] = []
  for (const raw of handles) {
    const p = normalizeHandle(raw, args.platform ?? 'INSTAGRAM')
    if (p) parsed.push(p)
    else invalid.push(echo(raw))
  }
  if (invalid.length > 0) {
    throw new ToolError(
      `No son perfiles válidos: ${listText(invalid, 5)}. Usa @usuario o la URL del perfil en instagram.com, tiktok.com o youtube.com (no la de una publicación). No se ha hecho nada.`,
    )
  }

  const snapshot = await readCampaign(ctx, args.campaignId)
  if (snapshot.status === 'ARCHIVED') throw new ToolError(`${named(snapshot.name)} está archivada: desarchívala antes de añadir creadoras. No se ha hecho nada.`)
  if (snapshot.type === 'SOCIAL_LISTENING') throw new ToolError(`${named(snapshot.name)} es de escucha social y no tiene creadoras. No se ha hecho nada.`)

  const plan: AddPlan = { snapshot, byPlatform: new Map(), byId: [], known: [], unknown: [], alreadyMembers: [] }
  const taken = new Set<string>()
  const send = (platform: CreatorPlatform, username: string) => plan.byPlatform.set(platform, [...(plan.byPlatform.get(platform) ?? []), username])

  for (const p of parsed) {
    const label = `${at(p.username)} (${PLATFORM_NAME[p.platform]})`
    const [stored] = await findCreatorsByHandle(p.username, p.platform)
    if (stored) {
      if (taken.has(stored.id)) continue
      taken.add(stored.id)
      if (snapshot.byInfluencer.has(stored.id)) plan.alreadyMembers.push(label)
      else {
        plan.known.push(label)
        send(p.platform, stored.username)
      }
    } else {
      const key = `${p.platform}:${p.username.toLowerCase()}`
      if (taken.has(key)) continue
      taken.add(key)
      plan.unknown.push(label)
      send(p.platform, p.username)
    }
  }

  if (ids.length > 0) {
    const rows = await prisma.influencer.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, platform: true } })
    const found = new Map(rows.map(r => [r.id, r]))
    const missing = ids.filter(id => !found.has(id))
    if (missing.length > 0) throw new ToolError(`No existe ninguna creadora con estos ids: ${listText(missing, 10)}. No se ha hecho nada.`)
    for (const id of ids) {
      const r = found.get(id)!
      if (taken.has(id)) continue
      taken.add(id)
      const label = `${at(r.username)} (${PLATFORM_NAME[asPlatform(r.platform)]})`
      if (snapshot.byInfluencer.has(id)) plan.alreadyMembers.push(label)
      else {
        plan.known.push(label)
        plan.byId.push({ id, username: r.username, platform: asPlatform(r.platform) })
      }
    }
  }
  return plan
}

export const addCreatorsToCampaign = defineWriteTool({
  name: 'add_creators_to_campaign',
  title: 'Añadir creadoras a la campaña',
  description:
    'Adds creators to a campaign as Prospecto, by @handle or profile URL (creators not yet in the database are looked up in Apify and created) and/or by existing creator id. ' +
    'Spends Apify: one profile read per handle not in the database, then one capture read per new member and batched Instagram stories reads (only when the campaign has brand accounts, hashtags or product keywords). ' +
    'It runs synchronously, so at most 20 creators per call; never retry after a timeout, read the member list (list_campaign_creators) instead. ' +
    'The campaign team gets an in-app notification; a new member\'s handle listed among the campaign\'s brand accounts is removed from them by the platform. ' +
    'Instagram and TikTok handles are compared without case, so an existing creator is never created twice. ' +
    'It does NOT set fee or stage (new members are not tracked daily until confirmed with set_creator_status) and does not link two accounts of the same person.',
  input: {
    campaignId: idInput('The campaign id (list_campaigns).'),
    handles: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(MAX_ADD)
      .optional()
      .describe("Each '@user', 'user' or a profile URL of instagram.com, tiktok.com or youtube.com (not a post URL)."),
    platform: z.enum(CREATOR_PLATFORMS).optional().describe('Network of the handles given without a URL. Default INSTAGRAM.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(MAX_ADD).optional().describe('Existing creators, by id (find_creator).'),
  },
  confirmations: ['none', 'bulk', 'money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId, handles: a.handles?.length, influencerIds: a.influencerIds?.length, platform: a.platform }),
  async plan(args, ctx) {
    const p = await resolveAdd(args, ctx)
    addPlans.set(ctx, p)
    const s = p.snapshot
    const newMembers = p.known.length + p.unknown.length
    if (newMembers === 0) return { confirmation: 'none' }
    const captures = s.hasTargets ? newMembers : 0
    // Apify only matters when something could be read: an unknown handle or a capture
    const apify = p.unknown.length > 0 || captures > 0 ? await ctx.apifyStatus() : null
    if (apify && !apify.available && p.unknown.length > 0) {
      return {
        confirmation: 'none',
        refuse: `Apify no está disponible ahora, así que no se pueden buscar las creadoras que no están en la base de datos: ${listText(p.unknown)}. Quítalas y vuelve a llamar para añadir las demás. No se ha hecho nada.`,
      }
    }
    // Looking up and creating a creator who is not in the database is a creator import: optional
    // spend, paused by the optional budget gate like import_creators_to_database and analyze_creator_profile
    if (apify?.available && apify.optionalBlocked && p.unknown.length > 0) {
      return {
        confirmation: 'none',
        refuse: `El gasto opcional de Apify está en pausa${apify.usedPct !== null ? ` (${apify.usedPct} % del plan usado)` : ''}: no se buscan creadoras nuevas hasta el próximo ciclo. No están en la base de datos: ${listText(p.unknown)}. Quítalas y vuelve a llamar para añadir las demás. No se ha hecho nada.`,
      }
    }
    // The state the preview describes, the targets and Apify included (a free preview never redeems a paid run)
    const fingerprint = JSON.stringify({
      known: [...p.known].sort(),
      unknown: [...p.unknown].sort(),
      already: [...p.alreadyMembers].sort(),
      members: s.members.length,
      hasTargets: s.hasTargets,
      apifyAvailable: apify ? apify.available : null,
    })
    const head = `Vas a añadir ${plural(newMembers, 'creadora', 'creadoras')} a ${named(s.name)} como Prospecto: ${listText([...p.known, ...p.unknown])}.`
    const skipped = p.alreadyMembers.length > 0 ? ` Ya en la campaña, se omiten: ${listText(p.alreadyMembers)}.` : ''
    if (apify?.available) {
      const preview =
        `${head} Ya están en la base de datos: ${listText(p.known)}. ` +
        `Nuevas, hay que buscarlas en Apify: ${p.unknown.length > 0 ? `${listText(p.unknown)} (una lectura de perfil cada una)` : 'ninguna'}.${skipped} ` +
        (captures > 0
          ? 'Después se lanza una lectura de captura por cada nueva integrante y la lectura de stories de Instagram. '
          : 'La campaña no tiene cuentas, hashtags ni palabras clave de marca: no se captura su contenido. ') +
        `Gasto: hasta ${plural(p.unknown.length + captures, 'lectura de perfil', 'lecturas de perfil')} de Apify (${usageText(apify)}). ` +
        'El equipo de la campaña recibe un aviso en la plataforma. ¿Confirmas?'
      // Known creators: their capture is core spend. Unknown ones: a creator import, optional spend
      return { confirmation: 'money', spend: p.unknown.length > 0 ? 'optional' : 'core', preview, fingerprint }
    }
    if (newMembers > 5) {
      const why = apify ? 'Apify no está disponible ahora' : 'la campaña no tiene cuentas, hashtags ni palabras clave de marca'
      return {
        confirmation: 'bulk',
        fingerprint,
        preview: `${head}${skipped} No se gasta Apify: ${why}, así que no se captura su contenido. El equipo de la campaña recibe un aviso en la plataforma. ¿Confirmas?`,
      }
    }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const p = addPlans.get(ctx) ?? (await resolveAdd(args, ctx))
    const s = p.snapshot
    // One budget for the whole call: each network is one synchronous bulk call, and a slow one that
    // still succeeds must not leave the next with a fresh timeout past Claude's own 240 s
    const budget = timeBudget()
    const creators: Json[] = []
    let unknownResult = false
    for (const [platform, usernames] of p.byPlatform) {
      if (unknownResult || budget.left() < ADD_MIN_LEFT_MS) {
        const reason = unknownResult ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED
        for (const u of usernames) creators.push({ handle: at(u), platform, result: 'not_attempted', reason })
        continue
      }
      const out = await attempt(ctx, {
        method: 'POST',
        path: `/api/campaigns/${s.id}/influencers/bulk`,
        body: { handles: usernames, platform },
        timeoutMs: budget.timeout(ADD_TIMEOUT_MS),
      })
      if (!out.ok) {
        unknownResult = out.timeout
        for (const u of usernames) creators.push({ handle: at(u), platform, result: out.timeout ? 'unknown' : 'error', reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message })
        continue
      }
      const rows = await prisma.influencer.findMany({ where: { platform, username: { in: usernames } }, select: { id: true, username: true } })
      const idOf = new Map(rows.map(r => [r.username, r.id]))
      for (const raw of asArray(out.json.results)) {
        const r = asObject(raw)
        const username = asString(r.username) ?? ''
        creators.push({
          handle: at(username),
          platform,
          influencerId: idOf.get(username) ?? null,
          result: asString(r.status),
          ...(asString(r.error) ? { reason: shortText(r.error, 200) } : {}),
        })
      }
    }
    for (const c of p.byId) {
      if (unknownResult || budget.left() < ADD_MIN_LEFT_MS) {
        const reason = unknownResult ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED
        creators.push({ handle: at(c.username), platform: c.platform, influencerId: c.id, result: 'not_attempted', reason })
        continue
      }
      const out = await attempt(ctx, {
        method: 'POST',
        path: `/api/campaigns/${s.id}/influencers`,
        body: { influencerId: c.id },
        timeoutMs: budget.timeout(30_000),
      })
      if (!out.ok) unknownResult = out.timeout
      creators.push({
        handle: at(c.username),
        platform: c.platform,
        influencerId: c.id,
        result: out.ok ? 'added' : out.status === 409 ? 'already_member' : out.timeout ? 'unknown' : 'error',
        ...(!out.ok && out.status !== 409 ? { reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message } : {}),
      })
    }
    const added = creators.filter(c => c.result === 'added' || c.result === 'created_and_added').length
    return {
      campaign: { id: s.id, name: shortText(s.name, 120) },
      added,
      skippedAlreadyMembers: p.alreadyMembers,
      creators,
      ...(unknownResult ? { warning: UNKNOWN_AFTER_TIMEOUT } : {}),
      ...(creators.some(c => c.reason === NOT_ATTEMPTED) ? { notAttempted: NOT_ATTEMPTED } : {}),
      next:
        added > 0
          ? 'New members are in Prospecto: confirm them with set_creator_status when they agree (their daily capture starts then). Their ids are above and in list_campaign_creators.'
          : undefined,
    }
  },
})

// =====================================================================
// set_creator_status
// =====================================================================

interface StatusPlan {
  snapshot: CampaignSnapshot
  members: CampaignMember[]
  changes: CampaignMember[]
  /** A capture is fired by the platform AND it can spend (targets and Apify live). */
  spends: boolean
}
const statusPlans = new WeakMap<WriteContext, StatusPlan>()

export const setCreatorStatus = defineWriteTool({
  name: 'set_creator_status',
  title: 'Cambiar el estado de creadoras en el pipeline',
  description:
    'Moves one or several creators of a campaign to a pipeline stage (Prospecto, Contacto, Negociando, Acordado, Contratado, Envío, Publicado, Completado). ' +
    'Default path (the creator panel): a real change INTO Acordado, Contratado, Envío, Publicado or Completado launches one paid Apify profile read per creator that captures her content and freezes her baseline, also when she comes from another of those stages, so it needs confirmation. ' +
    'With skipCapture true it uses the Kanban path: stage only, free, no capture and no baseline now (the daily crons read confirmed creators later). ' +
    "Use for 'pasa a @x a Contratado'. Any stage can be set from any other; Publicado and Completado count as delivered in the creator's reliability score. Creators already in that stage are left alone. " +
    'It does NOT send anything to the creator and does not change fee or shipping.',
  input: {
    campaignId: idInput('The campaign id.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(50).describe('Members of the campaign (list_campaign_creators).'),
    status: z.enum(PIPELINE_STATUSES).describe('The new stage.'),
    skipCapture: z.boolean().optional().describe('true: only the stage changes, no paid capture now. Default false.'),
  },
  confirmations: ['none', 'bulk', 'money'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId, creators: a.influencerIds.length, status: a.status, skipCapture: a.skipCapture }),
  async plan(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    const members = requireMembers(snapshot, args.influencerIds)
    const changes = members.filter(m => m.status !== args.status)
    const fires = !args.skipCapture && CAPTURE_STATUSES.has(args.status) ? changes.length : 0
    const apify = fires > 0 && snapshot.hasTargets ? await ctx.apifyStatus() : null
    const spends = !!apify && apify.available
    statusPlans.set(ctx, { snapshot, members, changes, spends })
    if (changes.length === 0) return { confirmation: 'none' }

    const label = STATUS_LABEL[args.status]
    const lines = changes.map(m => `${at(m.username)}: ${STATUS_LABEL[m.status]} → ${label}`)
    const same = members.filter(m => m.status === args.status).map(m => at(m.username))
    // Targets and spend are part of the state: a free preview (no targets, Apify down) never redeems a paid run
    const fingerprint = JSON.stringify({ members: members.map(m => [m.influencerId, m.status]), hasTargets: snapshot.hasTargets, spends })
    const tail =
      (same.length > 0 ? ` Ya están en ${label}, sin cambio: ${listText(same)}.` : '') + ' No se envía nada a las creadoras. ¿Confirmas?'
    const head = `Vas a pasar a ${plural(changes.length, 'creadora', 'creadoras')} de ${named(snapshot.name)} a ${label}: ${listText(lines, 25)}.`
    if (spends && apify?.coreBlocked) {
      return {
        confirmation: 'money',
        refuse: `El presupuesto de captura de Apify está bloqueado${apify.usedPct !== null ? ` (${apify.usedPct} % del plan usado)` : ''} y este cambio lanzaría lecturas de pago. Si solo hay que mover la columna, vuelve a llamar con skipCapture: true. No se ha hecho nada.`,
      }
    }
    if (spends && apify) {
      return {
        confirmation: 'money',
        spend: 'core',
        fingerprint,
        preview: `${head} ${plural(fires, 'de ellas lanza', 'de ellas lanzan')} una lectura de perfil en Apify para capturar su contenido y fijar su baseline (${usageText(apify)}).${tail}`,
      }
    }
    if (changes.length > 5) {
      const note = args.skipCapture
        ? ' Sin captura: solo cambia la columna.'
        : fires > 0
          ? snapshot.hasTargets
            ? ' Apify no está disponible ahora: no se captura nada.'
            : ' La campaña no tiene cuentas, hashtags ni palabras clave de marca: no se captura nada.'
          : ''
      return { confirmation: 'bulk', fingerprint, preview: `${head}${note}${tail}` }
    }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const p = statusPlans.get(ctx)!
    const label = STATUS_LABEL[args.status]
    const budget = timeBudget()
    const changed: Json[] = []
    const failed: Json[] = []
    let stop = false
    for (const m of p.changes) {
      if (stop || budget.left() < 5_000) {
        failed.push({ handle: at(m.username), influencerId: m.influencerId, reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const out = args.skipCapture
        ? await attempt(ctx, { method: 'PATCH', path: `/api/pipeline/${m.membershipId}`, body: { status: args.status }, timeoutMs: budget.timeout(60_000) })
        : await attempt(ctx, {
            method: 'PATCH',
            path: `/api/campaigns/${p.snapshot.id}/influencers`,
            body: { influencerId: m.influencerId, status: args.status },
            timeoutMs: budget.timeout(60_000),
          })
      if (out.ok) {
        changed.push({
          handle: at(m.username),
          influencerId: m.influencerId,
          change: `${STATUS_LABEL[m.status]} → ${label}`,
          captureLaunched: !args.skipCapture && CAPTURE_STATUSES.has(args.status) && p.spends,
        })
      } else {
        if (out.timeout) stop = true
        failed.push({ handle: at(m.username), influencerId: m.influencerId, reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message })
      }
    }
    return {
      campaign: { id: p.snapshot.id, name: shortText(p.snapshot.name, 120) },
      status: label,
      changed,
      unchanged: p.members.filter(m => m.status === args.status).map(m => at(m.username)),
      ...(failed.length > 0 ? { failed } : {}),
      nothingSentToCreators: true,
    }
  },
})

// =====================================================================
// update_creator_deal
// =====================================================================

const DEAL_FORMATS = ['POST', 'REEL', 'STORY', 'VIDEO', 'INTEGRATION', 'DEDICATED', 'SHORT'] as const
const BASELINE_FORMATS = ['POST', 'REEL', 'VIDEO', 'SHORT', 'INTEGRATION', 'DEDICATED'] as const
const moneyInput = (what: string) => z.number().min(0).max(10_000_000).describe(what)

const DEAL_FIELDS = [
  'agreedFee', 'cost', 'askingFee', 'negotiatedFormat', 'rightsDays', 'exclusivityDays', 'whitelisting', 'urgent',
  'crossposting', 'contentDelivered', 'deliverablesPlanned', 'trackedLink', 'trackedClicks', 'portfolioUrl', 'notes', 'baselineManual',
] as const
type DealField = (typeof DEAL_FIELDS)[number]
const SINGLE_CREATOR_FIELDS: readonly DealField[] = ['trackedLink', 'trackedClicks', 'portfolioUrl', 'notes', 'baselineManual']
const MONEY_FIELDS: ReadonlySet<DealField> = new Set<DealField>(['agreedFee', 'cost', 'askingFee'])
const DEAL_LABEL: Record<DealField, string> = {
  agreedFee: 'fee acordado',
  cost: 'coste',
  askingFee: 'fee solicitado',
  negotiatedFormat: 'formato',
  rightsDays: 'derechos de uso',
  exclusivityDays: 'exclusividad',
  whitelisting: 'whitelisting',
  urgent: 'urgente',
  crossposting: 'crossposting',
  contentDelivered: 'contenido entregado',
  deliverablesPlanned: 'entregables',
  trackedLink: 'enlace con seguimiento',
  trackedClicks: 'clics del enlace',
  portfolioUrl: 'portfolio',
  notes: 'notas de la ficha',
  baselineManual: 'baseline manual',
}

function dealValueText(field: DealField, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'vacío'
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return `${v} €`
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (field === 'rightsDays' && v === -1) return 'perpetuos'
  if ((field === 'rightsDays' || field === 'exclusivityDays') && typeof v === 'number') return `${v} días`
  if (field === 'baselineManual') return 'baseline manual'
  return shortText(String(v), 60) ?? ''
}

function baselineSummary(v: unknown): Json | null {
  const b = asObject(v)
  if (Object.keys(b).length === 0) return null
  return { source: asString(b.source), format: asString(b.format), medianViews: asNumber(b.medianViews), medianEngagement: asNumber(b.medianEngagement), n: asNumber(b.n) }
}

/** The stored value of a deal field of a membership, comparable with what the route stores. */
function storedDeal(m: CampaignMember, field: DealField): unknown {
  if (field === 'baselineManual') return baselineSummary(m.row.baselineSnapshot)
  return m.row[field] ?? null
}

interface DealPlan {
  snapshot: CampaignSnapshot
  members: CampaignMember[]
  fields: DealField[]
}
const dealPlans = new WeakMap<WriteContext, DealPlan>()

export const updateCreatorDeal = defineWriteTool({
  name: 'update_creator_deal',
  title: 'Editar fee, condiciones y entregables de creadoras',
  description:
    'Sets the commercial terms of one or several creators inside a campaign: agreed fee, cost, asking fee, negotiated format, usage rights, exclusivity, whitelisting, urgency, cross-posting, planned deliverables, delivered flag, ' +
    "and for ONE creator only: tracked link and clicks, portfolio link, the membership's free-text notes field (replaced) and a manual baseline. " +
    "The same values are applied to every creator listed. Use for 'pon 300 € de fee a @x', 'son 3 entregables'. Amounts are EUR. " +
    'The first time agreedFee becomes greater than 0 the deal date is stamped for good. Previous values are not kept anywhere: the answer shows each change as before and after ' +
    '(money values only with includeEconomics: true; pass it on this call when the person may want the old fee back, since calling again would only see the new one). ' +
    'It does NOT change the stage or the shipping data and does not add a note to the thread (add_creator_note).',
  input: {
    campaignId: idInput('The campaign id.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(50).describe('Members of the campaign.'),
    agreedFee: moneyInput('Agreed fee in EUR, >= 0.').optional(),
    cost: moneyInput('Cost in EUR, >= 0.').optional(),
    askingFee: moneyInput('Fee the creator asked for, EUR. null clears.').nullable().optional(),
    negotiatedFormat: z.enum(DEAL_FORMATS).nullable().optional().describe('Negotiated format. null clears.'),
    rightsDays: z
      .union([z.number().int().min(1).max(36_500), z.literal(-1)])
      .nullable()
      .optional()
      .describe('Usage rights in days (30, 90, 180...) or -1 for perpetual. null clears.'),
    exclusivityDays: z.number().int().min(1).max(36_500).nullable().optional().describe('Category exclusivity in days. null clears.'),
    whitelisting: z.boolean().optional().describe('Whitelisting / Spark Ads.'),
    urgent: z.boolean().optional().describe('Delivery in less than 7 days.'),
    crossposting: z.boolean().optional().describe('Same content on a second network.'),
    contentDelivered: z.boolean().optional().describe('UGC content delivered.'),
    deliverablesPlanned: z.number().int().min(0).max(1000).nullable().optional().describe('Deliverables promised. null clears.'),
    trackedLink: httpUrlInput(500, 'Tracked (UTM) link, absolute http(s) URL. Only with exactly one creator. null clears.').nullable().optional(),
    trackedClicks: countInput('Clicks on the tracked link. Only with exactly one creator. null clears.').nullable().optional(),
    portfolioUrl: httpUrlInput(500, 'Portfolio link. Only with exactly one creator. null clears.').nullable().optional(),
    notes: z.string().max(5000).optional().describe("Replaces the membership's notes field. Only with exactly one creator. For a dated note use add_creator_note."),
    baselineManual: z
      .object({
        format: z.enum(BASELINE_FORMATS),
        medianViews: z.number().min(0).max(2_000_000_000),
        medianEngagement: z.number().min(0).max(2_000_000_000),
        n: z.number().int().min(1).max(50).optional(),
      })
      .nullable()
      .optional()
      .describe("The creator's usual medians typed from her statistics. null clears a manual baseline. Only with exactly one creator."),
  },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({
    campaignId: a.campaignId,
    creators: a.influencerIds.length,
    fields: DEAL_FIELDS.filter(f => a[f] !== undefined).join(','),
  }),
  async plan(args, ctx) {
    const fields = DEAL_FIELDS.filter(f => args[f] !== undefined)
    if (fields.length === 0) {
      throw new ToolError('Indica al menos un dato del acuerdo que cambiar (fee, coste, formato, derechos, entregables...). No se ha hecho nada.')
    }
    const ids = [...new Set(args.influencerIds)]
    const single = fields.filter(f => SINGLE_CREATOR_FIELDS.includes(f))
    if (ids.length > 1 && single.length > 0) {
      throw new ToolError(`${listText(single.map(f => DEAL_LABEL[f]))} solo se pueden cambiar con una creadora por llamada. No se ha hecho nada.`)
    }
    const snapshot = await readCampaign(ctx, args.campaignId)
    const members = requireMembers(snapshot, ids)
    dealPlans.set(ctx, { snapshot, members, fields })
    if (members.length <= 5) return { confirmation: 'none' }

    const values = fields.map(f => `${DEAL_LABEL[f]}: ${dealValueText(f, args[f])}`)
    const overwrites: string[] = []
    for (const m of members) {
      for (const f of fields) {
        const before = storedDeal(m, f)
        const empty = before === null || before === '' || (MONEY_FIELDS.has(f) && before === 0)
        if (empty || JSON.stringify(before) === JSON.stringify(args[f])) continue
        const shownBefore = MONEY_FIELDS.has(f) && !ctx.includeEconomics ? '(tenía un valor)' : dealValueText(f, before)
        overwrites.push(`${at(m.username)}: ${DEAL_LABEL[f]} ${shownBefore} → ${dealValueText(f, args[f])}`)
      }
    }
    const stamps =
      typeof args.agreedFee === 'number' && args.agreedFee > 0
        ? members.filter(m => !(asNumber(m.row.agreedFee) && (asNumber(m.row.agreedFee) as number) > 0) && !m.row.dealClosedAt).length
        : 0
    return {
      confirmation: 'bulk',
      fingerprint: JSON.stringify(members.map(m => [m.influencerId, fields.map(f => storedDeal(m, f))])),
      preview:
        `Vas a aplicar a ${plural(members.length, 'creadora', 'creadoras')} de ${named(snapshot.name)}: ${values.join(', ')}. ` +
        `Valores que se sobrescriben: ${listText(overwrites, 25)}.` +
        (stamps > 0 ? ` A ${stamps} se les fija hoy la fecha de cierre del acuerdo, que después no se puede cambiar.` : '') +
        ' ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const p = dealPlans.get(ctx)!
    const body: Json = {}
    for (const f of p.fields) body[f] = args[f]
    const budget = timeBudget()
    const updated: Json[] = []
    const failed: Json[] = []
    let stop = false
    for (const m of p.members) {
      if (stop || budget.left() < 5_000) {
        failed.push({ handle: at(m.username), influencerId: m.influencerId, reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const out = await attempt(ctx, {
        method: 'PATCH',
        path: `/api/campaigns/${p.snapshot.id}/influencers`,
        body: { influencerId: m.influencerId, ...body },
        timeoutMs: budget.timeout(60_000),
      })
      if (!out.ok) {
        failed.push({ handle: at(m.username), influencerId: m.influencerId, reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message })
        if (out.timeout) stop = true
        continue
      }
      const item = asObject(out.json.item)
      const changes: Json = {}
      for (const f of p.fields) {
        const after = f === 'baselineManual' ? baselineSummary(item.baselineSnapshot) : (item[f] ?? null)
        changes[f] = { before: storedDeal(m, f), after }
      }
      const stamped = !m.row.dealClosedAt && !!item.dealClosedAt
      updated.push({ handle: at(m.username), influencerId: m.influencerId, changes, ...(stamped ? { dealDateStampedToday: true } : {}) })
    }
    return {
      campaign: { id: p.snapshot.id, name: shortText(p.snapshot.name, 120) },
      updated,
      ...(failed.length > 0 ? { failed } : {}),
      note: 'Previous values are not stored anywhere else: keep the before values above if the person may want them back.',
    }
  },
})

// =====================================================================
// set_creator_shipping
// =====================================================================

const SHIPPING_ADDRESS_FIELDS = [
  'shippingName', 'shippingAddress1', 'shippingAddress2', 'shippingCity', 'shippingPostCode', 'shippingCountry', 'shippingPhone', 'shippingEmail',
] as const
const SHIPPING_FIELDS = [...SHIPPING_ADDRESS_FIELDS, 'shippingProduct', 'shippingQty', 'shippingComments'] as const
type ShippingField = (typeof SHIPPING_FIELDS)[number]

const nullableText = (max: number, what: string) => z.string().trim().max(max).nullable().optional().describe(what)

export const setCreatorShipping = defineWriteTool({
  name: 'set_creator_shipping',
  title: 'Guardar datos de envío de una creadora',
  description:
    'Stores the product-shipping data of one creator in a campaign: recipient and address, product, quantity and comments. ' +
    'Either pass the address fields or set useSavedAddress to copy the address already saved in Contacts (copied on the server; it is not shown unless includeContact is true). ' +
    "When a street is sent and something changed, that address also replaces the one saved on the admin's Contact for that creator. " +
    'Send every line of the new address (recipient, street, floor, city, post code, country, phone, e-mail): a line left out keeps its current value (the one of this campaign or, when it has none, the one saved in Contacts) and the answer names those lines in keptFromCurrent; null clears a line. ' +
    "Use for 'apunta la dirección de envío de @x'. It does NOT move the creator to Envío (set_creator_status; the fulfilment sheet only lists creators in that stage) and does not notify the creator or any carrier. " +
    'The answer says which fields were saved; their values only with includeContact: true (pass it on this call when the person may want to see them).',
  input: {
    campaignId: idInput('The campaign id.'),
    influencerId: idInput('The creator, a member of the campaign.'),
    useSavedAddress: z.boolean().optional().describe('true: copy the address saved in Contacts. Do not send address fields with it.'),
    shippingName: nullableText(200, 'Recipient name.'),
    shippingAddress1: nullableText(200, 'Street and number.'),
    shippingAddress2: nullableText(200, 'Floor, door...'),
    shippingCity: nullableText(120, 'City.'),
    shippingPostCode: nullableText(20, 'Post code.'),
    shippingCountry: nullableText(80, 'Country.'),
    shippingPhone: phoneInput('Phone for the carrier.').nullable().optional(),
    shippingEmail: emailInput('E-mail for the carrier.').nullable().optional(),
    shippingProduct: nullableText(300, 'Product or SKU.'),
    shippingQty: z.number().int().min(1).max(999).nullable().optional().describe('Quantity.'),
    shippingComments: nullableText(500, 'Comments for the shipment.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({
    campaignId: a.campaignId,
    influencerId: a.influencerId,
    useSavedAddress: a.useSavedAddress,
    fields: SHIPPING_FIELDS.filter(f => a[f] !== undefined).length,
  }),
  async plan(args) {
    const sent = SHIPPING_FIELDS.filter(f => args[f] !== undefined)
    if (args.useSavedAddress && sent.some(f => (SHIPPING_ADDRESS_FIELDS as readonly string[]).includes(f))) {
      throw new ToolError('Usa useSavedAddress o los campos de dirección, no las dos cosas. No se ha hecho nada.')
    }
    if (!args.useSavedAddress && sent.length === 0) throw new ToolError('Indica algún dato de envío o useSavedAddress. No se ha hecho nada.')
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    const [member] = requireMembers(snapshot, [args.influencerId])
    const body: Partial<Record<ShippingField, unknown>> = {}
    for (const f of SHIPPING_FIELDS) if (args[f] !== undefined) body[f] = args[f]
    const given = Object.keys(body)
    /** Address lines the caller left out, sent with their current value (as the platform's form does). */
    const keptFromCurrent: string[] = []
    if (!args.useSavedAddress && SHIPPING_ADDRESS_FIELDS.some(f => args[f] !== undefined)) {
      // The route replaces the WHOLE address saved on the Contact with what it receives: a partial
      // address would null the missing lines there. The form always sends the complete address,
      // starting from this campaign's values or, when it has none, from the address in Contacts.
      let current: Partial<Record<(typeof SHIPPING_ADDRESS_FIELDS)[number], string | null>> = {}
      if (asString(member.row.shippingAddress1)?.trim()) {
        for (const f of SHIPPING_ADDRESS_FIELDS) current[f] = asString(member.row[f])
      } else {
        const saved = asObject(asObject(await ctx.platformJson({ method: 'GET', path: '/api/contacts/address', query: { influencerId: args.influencerId } })).address)
        if (asString(saved.address1)?.trim()) {
          current = {
            shippingName: asString(saved.name),
            shippingAddress1: asString(saved.address1),
            shippingAddress2: asString(saved.address2),
            shippingCity: asString(saved.city),
            shippingPostCode: asString(saved.postCode),
            shippingCountry: asString(saved.country),
            shippingPhone: asString(saved.phone),
            shippingEmail: asString(saved.email),
          }
        }
      }
      for (const f of SHIPPING_ADDRESS_FIELDS) {
        if (body[f] !== undefined) continue
        const value = current[f]
        if (typeof value === 'string' && value.trim()) {
          body[f] = value
          keptFromCurrent.push(f)
        }
      }
    }
    if (args.useSavedAddress) {
      const saved = asObject(await ctx.platformJson({ method: 'GET', path: '/api/contacts/address', query: { influencerId: args.influencerId } }))
      const a = asObject(saved.address)
      if (!asString(a.address1)) throw new ToolError('No hay ninguna dirección guardada en Contactos para esta creadora. No se ha hecho nada.')
      Object.assign(body, {
        shippingName: asString(a.name),
        shippingAddress1: asString(a.address1),
        shippingAddress2: asString(a.address2),
        shippingCity: asString(a.city),
        shippingPostCode: asString(a.postCode),
        shippingCountry: asString(a.country),
        shippingPhone: asString(a.phone),
        shippingEmail: asString(a.email),
      })
    }
    // What PATCH does with the Contact: a non-empty street AND some address field that changed
    const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const street = body.shippingAddress1
    const addressChanged =
      typeof street === 'string' &&
      street.trim().length > 0 &&
      SHIPPING_ADDRESS_FIELDS.some(f => body[f] !== undefined && norm(body[f]) !== norm(member.row[f]))

    const out = asObject(
      await ctx.platformJson({ method: 'PATCH', path: `/api/campaigns/${snapshot.id}/influencers`, body: { influencerId: args.influencerId, ...body } }),
    )
    const item = asObject(out.item)
    const shownFields = args.useSavedAddress ? Object.keys(body) : given
    const saved: Json = {}
    for (const f of shownFields) saved[f] = item[f] ?? null
    return {
      campaign: { id: snapshot.id, name: shortText(snapshot.name, 120) },
      creator: at(member.username),
      fieldsSaved: shownFields,
      values: saved,
      ...(keptFromCurrent.length > 0 ? { keptFromCurrent } : {}),
      copiedFromContacts: args.useSavedAddress === true,
      // (a key ending in "address" would itself be removed by the output filter)
      ...(addressChanged ? { savedInContacts: 'Esta dirección pasa a ser la guardada en Contactos para próximas campañas.' } : {}),
      stage: STATUS_LABEL[member.status],
      reminder: member.status === 'SHIPPING' ? undefined : 'The fulfilment sheet only lists creators in Envío: use set_creator_status if she should be shipped now.',
    }
  },
})

// =====================================================================
// remove_creator_from_campaign
// =====================================================================

export const removeCreatorFromCampaign = defineWriteTool({
  name: 'remove_creator_from_campaign',
  title: 'Quitar una creadora de la campaña',
  description:
    'Removes ONE creator from a campaign and hard-deletes all her captured publications and stories in it, together with her deal data (fee, terms, baseline, tracked link, shipping). ' +
    'Her note thread stays in the database but can no longer be reached. The creator record and the Contact are kept. Irreversible. ' +
    'Use only on an explicit request: to place her elsewhere use move_creators_between_campaigns, and if the aim is that the client does not see her use the report visibility tool. ' +
    'The administrator must approve it in the platform before it runs.',
  input: {
    campaignId: idInput('The campaign id.'),
    influencerId: idInput('The creator to remove, a member of the campaign.'),
  },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true, openWorldHint: false },
  summarize: a => ({ campaignId: a.campaignId, influencerId: a.influencerId }),
  async plan(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    const [m] = requireMembers(snapshot, [args.influencerId])
    const fee = asNumber(m.row.agreedFee)
    const feeText = fee && fee > 0 ? (ctx.includeEconomics ? `fee de ${fee} €` : 'fee acordado') : 'fee'
    return {
      confirmation: 'destructive',
      preview:
        `Vas a quitar a ${at(m.username)} de ${named(snapshot.name)}. ` +
        `Se BORRAN sus ${plural(m.pieces.posts, 'publicación', 'publicaciones')} y ${plural(m.pieces.stories, 'story capturada', 'stories capturadas')} en esta campaña, con sus métricas, ` +
        `y sus datos de acuerdo: ${feeText}, condiciones, baseline, enlace con seguimiento y dirección de envío. ` +
        'Sus notas internas quedan inaccesibles. Cambian los totales, el informe y el portal del cliente. No se puede deshacer. ' +
        'Alternativas: moverla a otra campaña u ocultarla del informe. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    const [m] = requireMembers(snapshot, [args.influencerId])
    await ctx.platformJson({ method: 'DELETE', path: `/api/campaigns/${snapshot.id}/influencers`, body: { influencerId: args.influencerId } })
    return {
      removed: true,
      campaign: { id: snapshot.id, name: shortText(snapshot.name, 120) },
      creator: at(m.username),
      deleted: { publications: m.pieces.posts, stories: m.pieces.stories },
    }
  },
})

// =====================================================================
// move_creators_between_campaigns
// =====================================================================

interface MovePlan {
  source: CampaignSnapshot
  target: CampaignSnapshot
  members: CampaignMember[]
  notMembers: string[]
  inTarget: CampaignMember[]
  transfer: CampaignMember[]
}

async function resolveMove(
  args: { sourceCampaignId: string; targetCampaignId: string; influencerIds: string[]; mode: 'copy' | 'move' },
  ctx: WriteContext,
): Promise<MovePlan> {
  if (args.sourceCampaignId === args.targetCampaignId) throw new ToolError('La campaña de destino debe ser distinta de la de origen. No se ha hecho nada.')
  const source = await readCampaign(ctx, args.sourceCampaignId)
  const target = await readCampaign(ctx, args.targetCampaignId)
  if (target.status === 'ARCHIVED') throw new ToolError(`${named(target.name)} está archivada: desarchívala antes de pasarle creadoras. No se ha hecho nada.`)
  if (target.type === 'SOCIAL_LISTENING') throw new ToolError(`${named(target.name)} es de escucha social y no tiene creadoras. No se ha hecho nada.`)
  const ids = [...new Set(args.influencerIds)]
  const notMembers = ids.filter(id => !source.byInfluencer.has(id))
  const members = ids.filter(id => source.byInfluencer.has(id)).map(id => source.byInfluencer.get(id) as CampaignMember)
  if (members.length === 0) throw new ToolError(`Ninguna de esas creadoras está en ${named(source.name)}. No se ha hecho nada.`)
  const inTarget = members.filter(m => target.byInfluencer.has(m.influencerId))
  const transfer = members.filter(m => !target.byInfluencer.has(m.influencerId))
  return { source, target, members, notMembers, inTarget, transfer }
}

export const moveCreatorsBetweenCampaigns = defineWriteTool({
  name: 'move_creators_between_campaigns',
  title: 'Mover o copiar creadoras a otra campaña',
  description:
    'Copies or moves selected creators from one campaign to another, carrying fee, cost, deal terms, the notes field, portfolio link and shipping recipient; they always arrive as Prospecto. ' +
    "mode 'copy' leaves the source untouched. mode 'move' deletes the source membership of the creators that have NO captured content (their stage, tracked link and clicks, baseline and shipping product in the source are lost and their note thread moves to the target); creators with captured content stay in the source as well. " +
    "Nothing is scraped; the target team gets an in-app notification. The target must not be archived or Social Listening. It does NOT move publications or stories. " +
    "'move' always needs the administrator's approval in the platform; 'copy' of more than 5 creators needs a confirmation in the chat.",
  input: {
    sourceCampaignId: idInput('The campaign they are in now.'),
    targetCampaignId: idInput('The campaign they go to, different from the source.'),
    influencerIds: z.array(idInput('Creator id')).min(1).max(100).describe('Members of the source campaign.'),
    mode: z.enum(['copy', 'move']).describe("'copy' keeps them in the source; 'move' takes out of the source those without captured content."),
  },
  confirmations: ['none', 'bulk', 'destructive'],
  annotations: { destructiveHint: true, openWorldHint: false },
  summarize: a => ({ sourceCampaignId: a.sourceCampaignId, targetCampaignId: a.targetCampaignId, creators: a.influencerIds.length, mode: a.mode }),
  async plan(args, ctx) {
    const p = await resolveMove(args, ctx)
    // Nothing would be created nor removed: every creator is already in the target
    if (p.transfer.length === 0) return { confirmation: 'none' }
    if (args.mode === 'copy' && p.transfer.length <= 5) return { confirmation: 'none' }
    const handles = p.transfer.map(m => at(m.username))
    const removable = p.transfer.filter(m => m.pieces.media === 0)
    const staying = p.transfer.filter(m => m.pieces.media > 0)
    const verb = args.mode === 'move' ? 'mover' : 'copiar'
    const preview =
      `Vas a ${verb} ${plural(p.transfer.length, 'creadora', 'creadoras')} de ${named(p.source.name)} a ${named(p.target.name)}: ${listText(handles, 25)}. ` +
      'Llegan como Prospecto con su fee, condiciones, notas y destinatario de envío. ' +
      (args.mode === 'move'
        ? `De ${named(p.source.name)} se ELIMINA la ficha de las ${removable.length} que no tienen contenido capturado: allí se pierden su estado, enlace con seguimiento, baseline y producto de envío; sus notas pasan a ${named(p.target.name)}. ` +
          `Las ${staying.length} que tienen contenido capturado se quedan también en ${named(p.source.name)}. `
        : '') +
      (p.inTarget.length > 0 ? `Ya están en el destino y se omiten: ${listText(p.inTarget.map(m => at(m.username)))}. ` : '') +
      (p.notMembers.length > 0 ? `No están en la campaña de origen y se ignoran: ${listText(p.notMembers, 10)}. ` : '') +
      'No se rastrea nada. ¿Confirmas?'
    return {
      confirmation: args.mode === 'move' ? 'destructive' : 'bulk',
      preview,
      fingerprint: JSON.stringify({ transfer: p.transfer.map(m => [m.influencerId, m.pieces.media]), inTarget: p.inTarget.length }),
    }
  },
  async execute(args, ctx) {
    const p = await resolveMove(args, ctx)
    const out = asObject(
      await ctx.platformJson({
        method: 'POST',
        path: `/api/campaigns/${p.source.id}/influencers/move`,
        body: { influencerIds: p.members.map(m => m.influencerId), targetCampaignId: p.target.id, mode: args.mode },
      }),
    )
    return {
      mode: args.mode,
      source: { id: p.source.id, name: shortText(p.source.name, 120) },
      target: { id: p.target.id, name: shortText(p.target.name, 120) },
      movedAndRemovedFromSource: asNumber(out.moved) ?? 0,
      copiedKeptInSource: asNumber(out.copied) ?? 0,
      skippedAlreadyInTarget: asStrings(out.skippedExisting).map(at),
      keptInSourceBecauseOfContent: asStrings(out.keptBecauseMedia).map(at),
      notMembersOfSource: asNumber(out.notMembers) ?? 0,
      arriveAs: 'Prospecto',
    }
  },
})

// =====================================================================
// add_creator_note
// =====================================================================

const NOTE_SUFFIX = ' (vía Claude)'

export const addCreatorNote = defineWriteTool({
  name: 'add_creator_note',
  title: 'Añadir nota interna sobre una creadora',
  description:
    "Adds an internal note to the thread the team keeps about one creator in one campaign, signed with the authorising admin's name; the campaign team gets an in-app notification. " +
    "Use for 'apunta que @x pidió 400 €'. The creator must be a member of the campaign; '(vía Claude)' is appended to the text. " +
    'Notes are never shown to clients or creators and cannot be edited or deleted afterwards, so record only what the person asked to record, in their words. It does NOT message the creator.',
  input: {
    campaignId: idInput('The campaign id.'),
    influencerId: idInput('The creator, a member of the campaign.'),
    text: z.string().trim().min(1).max(2000).describe('The note, as the person asked to record it.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  summarize: a => ({ campaignId: a.campaignId, influencerId: a.influencerId, chars: a.text.length }),
  async plan(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    requireMembers(snapshot, [args.influencerId])
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const snapshot = await readCampaign(ctx, args.campaignId)
    const [m] = requireMembers(snapshot, [args.influencerId])
    const text = `${args.text.trim()}${NOTE_SUFFIX}`
    const out = asObject(await ctx.platformJson({ method: 'POST', path: `/api/campaigns/${snapshot.id}/notes`, body: { influencerId: args.influencerId, text } }))
    const note = asObject(out.note)
    return {
      saved: true,
      noteId: asString(note.id),
      campaign: { id: snapshot.id, name: shortText(snapshot.name, 120) },
      creator: at(m.username),
      text: asString(note.text) ?? text,
      notice: `Queda firmada por ${ctx.user.name} y no se puede editar ni borrar.`,
    }
  },
})

// =====================================================================
// analyze_creator_profile
// =====================================================================

const DAY_MS = 24 * 60 * 60_000

interface AnalyzePlan {
  handle: ParsedHandle
  existing: StoredCreator | null
}
const analyzePlans = new WeakMap<WriteContext, AnalyzePlan>()

function resolveProfileHandle(raw: string, platform: CreatorPlatform): ParsedHandle {
  const p = normalizeHandle(raw, platform)
  if (!p) throw new ToolError(`${echo(raw)} no es un perfil válido: usa el usuario sin @ o la URL del perfil. No se ha hecho nada.`)
  if (p.platform !== platform) {
    throw new ToolError(`La URL es de ${PLATFORM_NAME[p.platform]} pero has indicado ${PLATFORM_NAME[platform]}. No se ha hecho nada.`)
  }
  return p
}

export const analyzeCreatorProfile = defineWriteTool({
  name: 'analyze_creator_profile',
  title: 'Analizar el perfil de una creadora',
  description:
    "Runs 'Analizar perfil' for one creator: reads fresh profile data in Apify when the stored data is missing or older than 24 hours, saves the creator and her recent posts and adds her to the admin's Contacts. " +
    'It is the way to bring a creator into the database with real data and obtain her creator id. Data fresher than 24 hours is returned free and without confirmation. ' +
    'Side effect: refreshed like, comment and view counts are written on every stored copy of her posts, including copies attached to campaigns. ' +
    'The handle is compared without case, so an existing creator is never duplicated. It does NOT add her to any campaign or list.',
  input: {
    username: z.string().trim().min(1).max(200).describe("Handle without '@' or the profile URL."),
    platform: z.enum(CREATOR_PLATFORMS).describe('Network of the profile.'),
  },
  confirmations: ['none', 'money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => {
    const p = normalizeHandle(a.username, a.platform)
    return { handle: p ? `@${p.username}` : '(not a handle)', platform: a.platform }
  },
  async plan(args, ctx) {
    const handle = resolveProfileHandle(args.username, args.platform)
    const [existing = null] = await findCreatorsByHandle(handle.username, handle.platform)
    analyzePlans.set(ctx, { handle, existing })
    const fresh =
      !!existing?.lastScraped &&
      Date.now() - existing.lastScraped.getTime() < DAY_MS &&
      !(existing.followers === 0 && existing.engagementRate === 0)
    if (fresh) return { confirmation: 'none' }
    const apify = await ctx.apifyStatus()
    return {
      confirmation: 'money',
      spend: 'optional',
      fingerprint: JSON.stringify({ id: existing?.id ?? null, lastScraped: existing?.lastScraped?.toISOString() ?? null }),
      preview:
        `Vas a analizar el perfil ${at(existing?.username ?? handle.username)} (${PLATFORM_NAME[handle.platform]}): una lectura de perfil en Apify (${usageText(apify)}), entre 30 segundos y 2 minutos. ` +
        'Se guardan su ficha y sus publicaciones recientes, se añade a tus Contactos y, si alguna de sus publicaciones ya está en campañas, se actualizan sus cifras. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const p = analyzePlans.get(ctx)!
    const out = await attempt(ctx, {
      method: 'POST',
      path: '/api/influencers/analyze',
      body: { username: p.existing?.username ?? p.handle.username, platform: p.handle.platform },
      timeoutMs: 180_000,
    })
    if (!out.ok) throw new ToolError(out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message)
    const source = asString(out.json.source)
    return {
      creator: compactCreator(out.json.influencer, ctx.includeContact),
      source,
      freshFromApify: source === 'apify',
      recentPostsStored: asArray(asObject(out.json.influencer).media).length,
      ...(out.json.apifyExhausted === true ? { apifyExhausted: true, apifyResumesAt: asString(out.json.resumesAt) } : {}),
      addedToContactsOf: ctx.user.name,
    }
  },
})

// =====================================================================
// import_creators_to_database
// =====================================================================

interface ImportPlan {
  handles: ParsedHandle[]
  known: string[]
  unknown: string[]
}
const importPlans = new WeakMap<WriteContext, ImportPlan>()

async function resolveImport(args: { handles: string[]; platform: CreatorPlatform }): Promise<ImportPlan> {
  const handles: ParsedHandle[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of args.handles) {
    const p = normalizeHandle(raw, args.platform)
    if (!p || p.platform !== args.platform) {
      invalid.push(echo(raw))
      continue
    }
    const key = p.username.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    handles.push(p)
  }
  if (invalid.length > 0) {
    throw new ToolError(
      `No son perfiles válidos de ${PLATFORM_NAME[args.platform]}: ${listText(invalid, 5)}. Una red por llamada; usa @usuario o la URL del perfil. No se ha hecho nada.`,
    )
  }
  const pool = await prisma.creatorPlatformProfile.findMany({
    where: { platform: args.platform, OR: handles.map(h => ({ username: { equals: escapeForInsensitiveEquals(h.username), mode: 'insensitive' as const } })) },
    select: { username: true },
  })
  const inPool = new Set(pool.map(r => r.username.toLowerCase()))
  return {
    handles,
    known: handles.filter(h => inPool.has(h.username.toLowerCase())).map(h => at(h.username)),
    unknown: handles.filter(h => !inPool.has(h.username.toLowerCase())).map(h => at(h.username)),
  }
}

export const importCreatorsToDatabase = defineWriteTool({
  name: 'import_creators_to_database',
  title: 'Importar creadoras a la base de datos',
  description:
    'Turns a list of handles (for example creators found in a creator search that have no creator id yet) into creator records usable in lists and campaigns: a handle already in the creator pool is registered free; each unknown one costs one Apify profile read. ' +
    'Every creator also becomes a Contact of the admin. Synchronous, three at a time: 20 per call at most and one network per call. Results come back matched by handle, each with its creator id (influencerId). ' +
    'Use before add_creators_to_list. Never retry after a timeout. It does NOT add anyone to a campaign or list.',
  input: {
    handles: z.array(z.string().trim().min(1).max(200)).min(1).max(20).describe("'@user', 'user' or the profile URL, all of the same network."),
    platform: z.enum(CREATOR_PLATFORMS).describe('Network of every handle.'),
  },
  confirmations: ['none', 'money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ handles: a.handles.length, platform: a.platform }),
  async plan(args, ctx) {
    const p = await resolveImport(args)
    importPlans.set(ctx, p)
    if (p.unknown.length === 0) return { confirmation: 'none' }
    const apify = await ctx.apifyStatus()
    return {
      confirmation: 'money',
      spend: 'optional',
      fingerprint: JSON.stringify({ known: p.known, unknown: p.unknown }),
      preview:
        `Vas a importar ${plural(p.handles.length, 'creadora', 'creadoras')} de ${PLATFORM_NAME[args.platform]} a la base de datos y a tus Contactos: ${listText(p.handles.map(h => at(h.username)))}. ` +
        `Ya están en la base de creadoras y no cuestan: ${listText(p.known)}. ` +
        `Desconocidas, una lectura de perfil en Apify cada una: ${listText(p.unknown)} (${p.unknown.length} como máximo; ${usageText(apify)}). ` +
        'Puede tardar varios minutos. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const p = importPlans.get(ctx) ?? (await resolveImport(args))
    const out = await attempt(ctx, {
      method: 'POST',
      path: '/api/discovery/batch',
      body: { handles: p.handles.map(h => h.username), platform: args.platform },
      timeoutMs: 180_000,
    })
    if (!out.ok) throw new ToolError(out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message)
    const creators = asArray(out.json.results).map(raw => {
      const r = asObject(raw)
      return {
        handle: at(asString(r.username) ?? asString(r.handle) ?? '?'),
        result: asString(r.status),
        influencerId: asString(r.influencerId),
        creatorProfileId: asString(r.creatorId),
        followers: asNumber(r.followers),
        ...(asString(r.error) ? { reason: shortText(r.error, 200) } : {}),
      }
    })
    return {
      platform: args.platform,
      imported: creators.filter(c => c.influencerId).length,
      creators,
      ...(out.json.apifyExhausted === true ? { apifyExhausted: true, apifyResumesAt: asString(out.json.resumesAt) } : {}),
      addedToContactsOf: ctx.user.name,
    }
  },
})

// =====================================================================
// run_paid_creator_search
// =====================================================================

type SearchPlan =
  | { kind: 'free'; response: Json; reason: string | null }
  | { kind: 'paid'; hashtag: string; limit: number; response: Json }
const searchPlans = new WeakMap<WriteContext, SearchPlan>()

const SEARCH_UNAVAILABLE: Record<string, string> = {
  no_hashtag: 'No hay un hashtag para esa búsqueda: prueba con otra categoría o palabra clave.',
  not_configured: 'Apify no está configurado.',
  exhausted: 'Apify ha alcanzado el límite mensual.',
  soft_limit: 'El gasto opcional de Apify está en pausa hasta el próximo ciclo.',
  cached: 'Esta búsqueda ya se hizo en los últimos 7 días: se sirve gratis.',
}

function compactSearchResults(response: Json, max = 100): Json {
  const all = asArray(response.results)
  return {
    total: all.length,
    returned: Math.min(all.length, max),
    results: all.slice(0, max).map(raw => {
      const r = asObject(raw)
      return {
        influencerId: asString(r.influencerId),
        username: asString(r.username),
        platform: asString(r.platform),
        displayName: shortText(r.displayName, 80),
        followers: asNumber(r.followers),
        engagementRate: asNumber(r.engagementRate),
        avgViews: asNumber(r.avgViews),
        country: shortText(r.country, 10),
        gender: asString(r.gender),
        categories: asStrings(r.categories).slice(0, 5),
        source: asString(r.source),
      }
    }),
  }
}

export const runPaidCreatorSearch = defineWriteTool({
  name: 'run_paid_creator_search',
  title: 'Ampliar la búsqueda de creadoras con Apify (de pago)',
  description:
    "Expands a creator search by category with the paid hashtag search of the Discover page. First call: runs the free search (own database and 7-day cache). " +
    'When a cached run exists, or a paid run cannot be offered, it answers with the free results at once and no confirmation. Otherwise it answers with an offer (hashtag, posts to read, profiles to analyse, plan usage) and a confirmToken; ' +
    'the second call with that token runs the paid search exactly as offered and keeps the result for 7 days. Use only when the free results are not enough and the person accepts the spend. ' +
    'Always sent as a category search, so a single word is never treated as a username. Refused when the optional Apify budget is paused. ' +
    'Results without influencerId must go through import_creators_to_database before lists or campaigns. It does NOT create contacts and does not add anyone to a list or campaign.',
  input: {
    query: z.string().trim().min(2).max(80).describe("Category or keyword, e.g. 'limpieza hogar'."),
    platform: z.enum(CREATOR_PLATFORMS).describe('Network to search.'),
    minFollowers: z.number().int().min(0).max(1_000_000_000).optional().describe('Minimum followers.'),
    maxFollowers: z.number().int().min(0).max(1_000_000_000).optional().describe('Maximum followers, >= minFollowers.'),
    minEngagement: z.number().gt(0).max(100).optional().describe('Minimum engagement rate, in percent.'),
    gender: z.enum(['F', 'M', 'X', 'none']).optional().describe("F mujer, M hombre, X otro, 'none' sin dato."),
  },
  confirmations: ['none', 'money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ queryChars: a.query.length, platform: a.platform, minFollowers: a.minFollowers, maxFollowers: a.maxFollowers, gender: a.gender }),
  async plan(args, ctx) {
    if (args.minFollowers !== undefined && args.maxFollowers !== undefined && args.maxFollowers < args.minFollowers) {
      throw new ToolError('maxFollowers debe ser mayor o igual que minFollowers. No se ha hecho nada.')
    }
    const body = {
      query: args.query,
      platform: args.platform,
      mode: 'category',
      ...(args.minFollowers !== undefined ? { minFollowers: args.minFollowers } : {}),
      ...(args.maxFollowers !== undefined ? { maxFollowers: args.maxFollowers } : {}),
      ...(args.minEngagement !== undefined ? { minEngagement: args.minEngagement } : {}),
      ...(args.gender !== undefined ? { gender: args.gender } : {}),
    }
    const free = asObject(await ctx.platformJson({ method: 'POST', path: '/api/influencers/discover', body }))
    const hashtag = asString(free.hashtag)
    const limit = asNumber(free.apifyLimit)
    if (free.cached === true || free.apifyAvailable !== true || !hashtag || limit === null) {
      const reason = free.cached === true ? 'cached' : asString(free.apifyUnavailableReason)
      searchPlans.set(ctx, { kind: 'free', response: free, reason: reason ? (SEARCH_UNAVAILABLE[reason] ?? reason) : null })
      return { confirmation: 'none' }
    }
    searchPlans.set(ctx, { kind: 'paid', hashtag, limit, response: free })
    const apify = await ctx.apifyStatus()
    const firstFree = asArray(free.results)
      .slice(0, 8)
      .map(r => at(asObject(r).username))
    return {
      confirmation: 'money',
      spend: 'optional',
      fingerprint: JSON.stringify({ hashtag, limit, platform: args.platform, enrichLimit: asNumber(free.enrichLimit) }),
      preview:
        `Búsqueda de pago en ${PLATFORM_NAME[args.platform]} del hashtag #${shortText(hashtag, 60)} para «${shortText(args.query, 80)}»: ` +
        `se leen hasta ${limit} publicaciones y se analizan hasta ${asNumber(free.enrichLimit) ?? 0} perfiles nuevos (${usageText(apify)}). ` +
        `En tu base ya hay ${asNumber(free.dbCount) ?? 0} resultados gratis${firstFree.length > 0 ? ` (por ejemplo ${firstFree.join(', ')})` : ''}. ` +
        'El resultado se guarda 7 días: repetir esta búsqueda en ese plazo no cuesta. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const p = searchPlans.get(ctx)!
    if (p.kind === 'free') {
      return {
        paid: false,
        query: shortText(args.query, 80),
        platform: args.platform,
        hashtag: asString(p.response.hashtag),
        ...(p.reason ? { whyNoPaidSearch: p.reason } : {}),
        ...compactSearchResults(p.response),
      }
    }
    const out = await attempt(ctx, {
      method: 'POST',
      path: '/api/influencers/discover',
      body: {
        query: args.query,
        platform: args.platform,
        mode: 'category',
        ...(args.minFollowers !== undefined ? { minFollowers: args.minFollowers } : {}),
        ...(args.maxFollowers !== undefined ? { maxFollowers: args.maxFollowers } : {}),
        ...(args.minEngagement !== undefined ? { minEngagement: args.minEngagement } : {}),
        ...(args.gender !== undefined ? { gender: args.gender } : {}),
        confirmPaid: true,
        confirmed: { hashtag: p.hashtag, platform: args.platform, limit: p.limit },
      },
      timeoutMs: 190_000,
    })
    if (!out.ok) {
      const code = asString(out.json.error)
      if (out.timeout) throw new ToolError(UNKNOWN_AFTER_TIMEOUT)
      if (code === 'apify_soft_limit') throw new ToolError(SEARCH_UNAVAILABLE.soft_limit)
      if (code === 'apify_exhausted') throw new ToolError(SEARCH_UNAVAILABLE.exhausted)
      if (code === 'confirm_mismatch') throw new ToolError('La búsqueda cambió desde la oferta. No se ha gastado nada: vuelve a llamar sin confirmToken para ver la oferta actual.')
      throw new ToolError(out.message)
    }
    return {
      paid: true,
      query: shortText(args.query, 80),
      platform: args.platform,
      hashtag: p.hashtag,
      newFromApify: asNumber(out.json.apifyCount),
      ...(out.json.cacheWriteFailed === true ? { warning: 'La búsqueda se pagó pero no se pudo guardar: repetirla volverá a costar.' } : {}),
      ...compactSearchResults(out.json),
    }
  },
})

// =====================================================================
// update_creator_profile
// =====================================================================

const PROFILE_FIELDS = ['standardFee', 'email', 'phone', 'website', 'gender'] as const

export const updateCreatorProfile = defineWriteTool({
  name: 'update_creator_profile',
  title: 'Editar la ficha de una creadora',
  description:
    "Edits a creator's shared record: standard fee (EUR, greater than 0), contact e-mail, phone, website and gender (F mujer, M hombre, X otro). " +
    'The record is shared by every PM and used as the default in campaigns; there is no history, so the answer states each change as before and after ' +
    '(contact values only with includeContact: true, the fee only with includeEconomics: true: pass them on this call when the person may want the old value, since calling again would only see the new one). ' +
    'Name, bio, location and metrics come from scrapes and cannot be edited. null clears a field. It does NOT message the creator.',
  input: {
    influencerId: idInput('The creator id.'),
    standardFee: z.number().gt(0).max(10_000_000).nullable().optional().describe('Usual fee in EUR, > 0 (0 cannot be stored). null clears.'),
    email: emailInput('Contact e-mail. null clears.').nullable().optional(),
    phone: phoneInput('Phone. null clears.').nullable().optional(),
    website: httpUrlInput(300, 'Website, absolute http(s) URL. null clears.').nullable().optional(),
    gender: z.enum(['F', 'M', 'X']).nullable().optional().describe('F mujer, M hombre, X otro (pareja, familia, marca). null clears.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ influencerId: a.influencerId, fields: PROFILE_FIELDS.filter(f => a[f] !== undefined).join(',') }),
  async plan(args) {
    if (PROFILE_FIELDS.every(f => args[f] === undefined)) {
      throw new ToolError('Indica al menos un dato de la ficha que cambiar (standardFee, email, phone, website o gender). No se ha hecho nada.')
    }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const before = asObject(asObject(await ctx.platformJson({ method: 'GET', path: `/api/influencers/${args.influencerId}` })).influencer)
    const body: Json = {}
    for (const f of ['standardFee', 'email', 'phone', 'website'] as const) if (args[f] !== undefined) body[f] = args[f]
    let after: Json = before
    if (Object.keys(body).length > 0) {
      after = asObject(asObject(await ctx.platformJson({ method: 'PATCH', path: `/api/influencers/${args.influencerId}`, body })).influencer)
    }
    let gender: unknown = before.gender ?? null
    if (args.gender !== undefined) {
      gender = asObject(await ctx.platformJson({ method: 'PATCH', path: `/api/influencers/${args.influencerId}/gender`, body: { gender: args.gender } })).gender ?? null
    }
    const changes: Json = {}
    for (const f of PROFILE_FIELDS) {
      if (args[f] === undefined) continue
      const was = before[f] ?? null
      const now = f === 'gender' ? gender : (after[f] ?? null)
      // The website is contact data too (the output filter only knows e-mails, phones and addresses)
      changes[f] = f === 'website' && !ctx.includeContact ? { hadValue: !!was, hasValue: !!now } : { before: was, after: now }
    }
    return {
      creator: { influencerId: args.influencerId, handle: at(before.username), platform: asString(before.platform) },
      fieldsChanged: Object.keys(changes),
      changes,
      notice: 'La ficha es compartida: el cambio lo ven todas las PM.',
    }
  },
})

// =====================================================================
// create_creator_manually
// =====================================================================

export const createCreatorManually = defineWriteTool({
  name: 'create_creator_manually',
  title: 'Crear una creadora a mano (sin rastrear)',
  description:
    'Creates a creator record by hand, with zero metrics and no scraping. Use only when Apify must not be spent or is unavailable; otherwise prefer analyze_creator_profile, which brings real data. ' +
    "The '@' is stripped, Instagram and TikTok handles are lower-cased, and it is refused when a creator with the same handle exists under any casing (the answer gives her id). " +
    'It does NOT create a Contact and does not add her to a campaign or list.',
  input: {
    username: z
      .string()
      .trim()
      .min(1)
      .max(61)
      .regex(/^@?[A-Za-z0-9._-]{1,60}$/, "letters, digits, dot, underscore and hyphen; no URL")
      .describe("The handle, without '@' and without URL."),
    platform: z.enum(CREATOR_PLATFORMS).describe('Network.'),
    displayName: z.string().trim().min(1).max(120).optional().describe('Public name.'),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'ISO 3166 alpha-2 code')
      .transform(v => v.toUpperCase())
      .optional()
      .describe('Country, ISO alpha-2 (ES, MX...).'),
    city: z.string().trim().min(1).max(100).optional().describe('City.'),
    language: z.string().trim().min(2).max(10).optional().describe('Language code (es, en...).'),
    email: emailInput('Contact e-mail.').optional(),
    phone: phoneInput('Phone.').optional(),
    website: httpUrlInput(300, 'Website, absolute http(s) URL.').optional(),
    gender: z.enum(['F', 'M', 'X']).optional().describe('F mujer, M hombre, X otro.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  summarize: a => ({ handle: `@${a.username.replace(/^@/, '')}`, platform: a.platform }),
  async plan(args) {
    const username = args.username.replace(/^@/, '')
    const [existing] = await findCreatorsByHandle(username, args.platform)
    if (existing) {
      throw new ToolError(
        `Ya existe ${at(existing.username)} en ${PLATFORM_NAME[args.platform]} (id ${existing.id}). Usa ese id; no se ha creado nada.`,
      )
    }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const raw = args.username.replace(/^@/, '')
    const username = args.platform === 'YOUTUBE' ? raw : raw.toLowerCase()
    const body: Json = { username, platform: args.platform }
    for (const f of ['displayName', 'country', 'city', 'language', 'email', 'phone', 'website'] as const) if (args[f] !== undefined) body[f] = args[f]
    const created = asObject(asObject(await ctx.platformJson({ method: 'POST', path: '/api/influencers', body })).influencer)
    const id = asString(created.id)
    if (!id) throw new ToolError('La plataforma no ha devuelto la ficha creada.')
    let genderSaved = false
    if (args.gender !== undefined) {
      await ctx.platformJson({ method: 'PATCH', path: `/api/influencers/${id}/gender`, body: { gender: args.gender } })
      genderSaved = true
    }
    return {
      created: true,
      influencerId: id,
      handle: at(username),
      platform: args.platform,
      ...(genderSaved ? { gender: args.gender } : {}),
      notice: 'Ficha creada sin métricas. Para traer sus datos reales hay que analizar el perfil (consume Apify).',
    }
  },
})

// =====================================================================
// save_contact_address
// =====================================================================

const CONTACT_FIELDS = ['addressName', 'address1', 'address2', 'city', 'postCode', 'country', 'phone', 'email'] as const

export const saveContactAddress = defineWriteTool({
  name: 'save_contact_address',
  title: 'Guardar la dirección de una creadora en Contactos',
  description:
    "Saves or corrects the postal address (and the address phone and e-mail) kept on the admin's own Contact for a creator. It is the address every future shipping form pre-fills, agency-wide. " +
    'Creates the Contact when it does not exist yet (then address1 is required). Only the admin\'s own contacts are reachable. ' +
    "It does NOT clear an address (removing personal data is done by hand in the platform), cannot change the contact's status, notes or tags, and does not touch shipping data already stored in a campaign (set_creator_shipping). " +
    'The answer says which fields were saved; their values only with includeContact: true (pass it on this call when the person may want to see them).',
  input: {
    influencerId: idInput('The creator id.'),
    addressName: z.string().trim().min(1).max(200).optional().describe('Recipient name.'),
    address1: z.string().trim().min(1).max(200).optional().describe('Street and number. Required when the contact has no street yet.'),
    address2: z.string().trim().min(1).max(200).optional().describe('Floor, door...'),
    city: z.string().trim().min(1).max(200).optional().describe('City.'),
    postCode: z.string().trim().min(1).max(200).optional().describe('Post code.'),
    country: z.string().trim().min(1).max(200).optional().describe('Country.'),
    phone: z.string().trim().min(1).max(40).optional().describe('Phone of the address.'),
    email: emailInput('E-mail of the address.').optional(),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ influencerId: a.influencerId, fields: CONTACT_FIELDS.filter(f => a[f] !== undefined).length }),
  async plan(args) {
    if (CONTACT_FIELDS.every(f => args[f] === undefined)) throw new ToolError('Indica al menos un dato de la dirección. No se ha hecho nada.')
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const list = asArray(asObject(await ctx.platformJson({ method: 'GET', path: '/api/contacts' })).contacts)
    let contact = list.map(asObject).find(c => asString(c.influencerId) === args.influencerId) ?? null
    if (!(contact && asString(contact.address1)) && args.address1 === undefined) {
      throw new ToolError('Falta la calle (address1): esta creadora no tiene todavía una dirección guardada en tus Contactos. No se ha hecho nada.')
    }
    let created = false
    if (!contact) {
      contact = asObject(asObject(await ctx.platformJson({ method: 'POST', path: '/api/contacts', body: { influencerId: args.influencerId, status: 'new' } })).contact)
      created = true
    }
    const id = asString(contact.id)
    if (!id) throw new ToolError('La plataforma no ha devuelto el contacto.')
    const body: Json = { id }
    for (const f of CONTACT_FIELDS) if (args[f] !== undefined) body[f] = args[f]
    const saved = asObject(asObject(await ctx.platformJson({ method: 'PATCH', path: '/api/contacts', body })).contact)
    const values: Json = {}
    for (const f of CONTACT_FIELDS) if (args[f] !== undefined) values[f] = saved[f] ?? null
    return {
      contactId: id,
      contactCreated: created,
      creator: at(asObject(saved.influencer).username),
      fieldsSaved: Object.keys(values),
      values,
      notice: 'Es la dirección que se propondrá en los próximos envíos.',
    }
  },
})

// =====================================================================
// invite_creator_to_connect
// =====================================================================

export const inviteCreatorToConnect = defineWriteTool({
  name: 'invite_creator_to_connect',
  title: 'Invitar por correo a una creadora a conectar su cuenta',
  description:
    "E-mails ONE creator a 7-day invitation, in the authorising admin's name, to create her creator access and connect her Instagram account to TKOC Intelligence. " +
    'A real e-mail to a real person: one recipient per call, never in a loop, never to an address the person did not give for this purpose in this conversation; at most 5 invitations a day through this connection. ' +
    'Refused when a pending invitation exists for that address (it cannot be resent or cancelled until it expires). campaignId only prints the campaign name in the e-mail. ' +
    'The administrator must approve the sending in the platform. It does NOT invite staff or brand users and cannot change the e-mail text.',
  input: {
    email: emailInput('The creator\'s e-mail address, as the person gave it.').transform(v => v.toLowerCase()),
    campaignId: idInput('Optional: the campaign whose name appears in the e-mail.').optional(),
    locale: z.enum(['es', 'en']).optional().describe("Language of the e-mail. Default 'es'."),
  },
  confirmations: ['outbound'],
  annotations: { destructiveHint: false, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId, locale: a.locale }),
  async plan(args, ctx) {
    const pending = asArray(
      asObject(await ctx.platformJson({ method: 'GET', path: '/api/influencers/invite', query: { campaignId: args.campaignId ?? 'connector' } })).invitations,
    )
    const open = pending.map(asObject).find(i => (asString(i.email) ?? '').trim().toLowerCase() === args.email)
    if (open) {
      throw new ToolError(
        `Ya hay una invitación pendiente para ${args.email} (caduca el ${(asString(open.expiresAt) ?? '').slice(0, 10)}). No se puede reenviar ni cancelar hasta entonces. No se ha enviado nada.`,
      )
    }
    const campaign = args.campaignId ? await readCampaign(ctx, args.campaignId) : null
    const sent = await countExecutedSince({ grantId: ctx.grantId, confirmation: 'outbound', since: new Date(Date.now() - DAY_MS), tool: 'invite_creator_to_connect' })
    return {
      confirmation: 'outbound',
      preview:
        `Vas a ENVIAR UN CORREO a ${args.email}, en nombre de ${ctx.user.name}, invitándola a conectar su cuenta de Instagram con TKOC Intelligence` +
        `${campaign ? ` por la campaña ${named(campaign.name)}` : ''}, en ${args.locale === 'en' ? 'inglés' : 'español'}. ` +
        'El enlace caduca en 7 días y le permite crear su acceso de creadora. No se puede reenviar ni cancelar hasta que caduque. ' +
        `En las últimas 24 horas llevas ${sent} de 5 invitaciones por este conector. ¿Confirmas el envío a ${args.email}?`,
    }
  },
  async execute(args, ctx) {
    const out = asObject(
      await ctx.platformJson({
        method: 'POST',
        path: '/api/influencers/invite',
        body: { email: args.email, ...(args.campaignId ? { campaignId: args.campaignId } : {}), locale: args.locale ?? 'es' },
      }),
    )
    const inv = asObject(out.invitation)
    return {
      sent: true,
      invitationId: asString(inv.id),
      email: asString(inv.email),
      expiresAt: asString(inv.expiresAt),
      sentInNameOf: ctx.user.name,
    }
  },
})

// =====================================================================
// Registration
// =====================================================================

export const CREATOR_WRITE_TOOLS: readonly WriteTool[] = [
  addCreatorsToCampaign,
  setCreatorStatus,
  updateCreatorDeal,
  setCreatorShipping,
  removeCreatorFromCampaign,
  moveCreatorsBetweenCampaigns,
  addCreatorNote,
  analyzeCreatorProfile,
  importCreatorsToDatabase,
  runPaidCreatorSearch,
  updateCreatorProfile,
  createCreatorManually,
  saveContactAddress,
  inviteCreatorToConnect,
]

/** Hands every creator write tool to `register` (server.ts: server.registerTool with writeToolConfig). */
export function registerCreatorWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of CREATOR_WRITE_TOOLS) register(tool)
}
