/**
 * platform_request: the guarded GENERIC tool of the connector's write layer.
 * A last resort for what no curated tool covers. It calls one platform route,
 * as the administrator who authorised the grant, through the platform client
 * (../../platform-client.ts) and the write helper (../../write-tool.ts), so
 * the call log, the access checks, the confirmations and the output filter are
 * the same as for every other write tool.
 *
 * What it may call is an ALLOW TABLE (ALLOW_RULES below), method by method
 * and route pattern by route pattern: the `genericRequest` section of the
 * write-layer proposal (12 Nov 2026). Everything else is refused before any
 * request is sent, with the reason:
 *  - the parts of the platform out of reach for good (users and roles, keys
 *    and integrations, the connector's own authorisations, crons, seeds...),
 *    with the proposal's reason for each (DENY_RULES);
 *  - every write that has a curated tool, with the name of that tool
 *    (CURATED_WRITES), so its validation and its confirmation cannot be
 *    bypassed;
 *  - anything else: default deny, with the list of what exists.
 *
 * Confirmation of a call (the class is decided here, enforced by write-tool):
 *  - destructive: every DELETE (pending action approved in the platform);
 *  - outbound: a change of a live-capture widget, which the visitors of the
 *    client's website see at once (pending action approved in the platform);
 *  - money: the paid Apify reads (two-step token, after /api/apify-status);
 *  - bulk: changes of many records at once (two-step token);
 *  - none: reads and the small writes the proposal lists.
 * Every confirmable route has a preview written here in plain Spanish from
 * GETs of the platform; a confirmable route without a preview is refused.
 *
 * Limits: JSON bodies of at most 64 KB, 8 levels and 200 elements per array;
 * forced values (search and cache limits, JSON export, no scheduled e-mail);
 * 60 seconds per call, 200 for the long synchronous jobs; answers of at most
 * 30,000 characters, arrays cut to 50 with `_truncated`, strings to 1,000
 * characters, images and snapshots dropped, an optional `select` of dot paths.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prisma } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import { APP_URL } from '../../config'
import { argsDigest, type ConfirmationClass } from '../../confirm'
import { ECONOMICS_NOTE_AFTER_WRITE, filterOutput, trimOutput } from '../../output-filter'
import {
  PLATFORM_TIMEOUT_MS,
  PlatformRequestError,
  queryKeyExceptions,
  describePlatformFailure,
  resolvePlatformPath,
  type PlatformMethod,
} from '../../platform-client'
import { defineWriteTool, registerWriteTool, type WriteContext, type WriteTool, type WriteToolWiring } from '../../write-tool'
import { isBrandId } from '../brands'
import { ToolError, cleanHandle, shortText } from '../shared'

// ============ Limits ============

export const PLATFORM_REQUEST_NAME = 'platform_request'
export const GENERIC_METHODS: readonly PlatformMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
/** Serialised body. */
export const GENERIC_MAX_BODY_BYTES = 64 * 1024
/** Levels of nesting of a body. */
export const GENERIC_MAX_BODY_DEPTH = 8
/** Elements of any array of a body. */
export const GENERIC_MAX_ARRAY_ITEMS = 200
/** Normal calls. */
export const GENERIC_TIMEOUT_MS = 60_000
/** Long synchronous jobs (the proposal says 300 s; the platform client stops at 200 s, under Claude's 240 s). */
export const GENERIC_LONG_TIMEOUT_MS = PLATFORM_TIMEOUT_MS
/** Whole answer, in characters of JSON. */
export const GENERIC_OUTPUT_MAX_CHARS = 30_000
/** Arrays of an answer. */
export const GENERIC_OUTPUT_MAX_ARRAY = 50
/** Strings of an answer. */
export const GENERIC_OUTPUT_MAX_STRING = 1_000
/** Page of the knowledge base. */
export const KNOWLEDGE_PAGE_CHARS = 20_000
/** Dropped from every answer: images, snapshots and browser data the model does not need. */
export const GENERIC_DROP_KEYS: readonly string[] = ['avatarUrl', 'thumbnailUrl', 'mediaUrl', 'brandLogo', 'baselineSnapshot', 'userAgent']

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SELECT_RE = /^[A-Za-z0-9_$-]{1,64}(?:\.[A-Za-z0-9_$-]{1,64}){0,7}$/
const CREDENTIAL_QUERY_KEYS = new Set(['secret', 'token', 'apikey', 'password', 'key', 'accesstoken', 'refreshtoken'])
const SOCIAL_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const

// ============ The request ============

type Scalar = string | number | boolean | null

/** A request of the model, once its route is known. */
export interface GenericRequest {
  method: PlatformMethod
  /** As given: `/api/campaigns/ck123`. */
  path: string
  /** The route pattern: `/api/campaigns/[id]`. */
  pattern: string
  /** Its `[param]` values. */
  params: Record<string, string>
  query: Record<string, Scalar>
  /** undefined when there is none. */
  body: unknown
}

type GenericClass = ConfirmationClass

interface Preview {
  /** Plain Spanish: what will happen, to which records, what it costs or why it cannot be undone. */
  text: string
  /** The state the preview describes (counts, current values): a change makes the token stale. */
  fingerprint?: string
}

/** One method of one route the generic tool may call. */
interface AllowRule {
  method: PlatformMethod
  pattern: string
  /** Every class classify() may return (`none` when absent). */
  classes?: readonly GenericClass[]
  /** The class of this request. Default `none`. */
  classify?(req: GenericRequest): GenericClass
  /** money only: `core` survives the optional budget gate. */
  spend?: 'core' | 'optional'
  /** A sentence to refuse this request, or null. */
  refuse?(req: GenericRequest): string | null
  /** Values forced before sending. Returns the request to send and a note per change. */
  force?(req: GenericRequest): { req: GenericRequest; notes: string[] }
  /** The preview of a confirmable request (reads only). */
  preview?(req: GenericRequest, ctx: WriteContext): Promise<Preview>
  /** Runs right before the call when it executes; its fields go into the answer (e.g. the value to restore). */
  before?(req: GenericRequest, ctx: WriteContext): Promise<Record<string, unknown>>
  /** A sentence added to every successful answer. */
  warning?: string
  /** One of the long synchronous jobs: 200 s instead of 60 s. */
  long?: boolean
  /** Strings of the answer up to this long survive. */
  maxStringChars?: number
  /** Turns the platform's JSON into the answer's data (e.g. a page of the knowledge base). */
  transform?(json: unknown, original: GenericRequest): unknown
  /** For the list of what exists. */
  note?: string
  /** A POST that only reads or computes: with class `none` it spends the read allowance (every GET does). */
  readOnly?: boolean
}

// ============ Small helpers ============

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function bodyObject(req: GenericRequest): Record<string, unknown> {
  return isPlainObject(req.body) ? req.body : {}
}

/** A copy of the request with a new body or query. */
function withBody(req: GenericRequest, body: unknown): GenericRequest {
  return { ...req, body }
}

function withQuery(req: GenericRequest, query: Record<string, Scalar>): GenericRequest {
  return { ...req, query }
}

/** A name read from the platform, safe to put in a preview. */
function label(value: unknown, fallback = 'sin nombre'): string {
  return shortText(value, 120) ?? fallback
}

function nonNegativeInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** A positive limit as the admin routes parse it (parseInt), or null. */
function parsedLimit(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
}

/** The body's `limit` capped at `max` (and set to `fallback` when absent). */
function capBodyLimit(max: number, fallback?: number) {
  return (req: GenericRequest): { req: GenericRequest; notes: string[] } => {
    const body = bodyObject(req)
    const given = parsedLimit(body.limit)
    if (given !== null && given <= max) return { req: withBody(req, { ...body, limit: given }), notes: [] }
    if (given === null && fallback === undefined) return { req, notes: [] }
    const limit = given === null ? (fallback as number) : max
    const notes = given !== null ? [`limit se ha reducido a ${max}, el máximo de esta ruta desde Claude.`] : []
    return { req: withBody(req, { ...body, limit }), notes }
  }
}

function platformName(value: unknown): string {
  return value === 'INSTAGRAM' ? 'Instagram' : value === 'TIKTOK' ? 'TikTok' : value === 'YOUTUBE' ? 'YouTube' : 'plataforma desconocida'
}

/** «Esto consume Apify (uso actual del plan: 42 %).» Never an amount of money. */
async function apifyLine(ctx: WriteContext): Promise<string> {
  const status = await ctx.apifyStatus()
  return status.usedPct !== null ? `Esto consume Apify (uso actual del plan: ${status.usedPct} %).` : 'Esto consume Apify.'
}

const ASK = '¿Confirmas?'

// ============ Benchmarks (Ajustes) ============

/** Mirrors src/app/api/settings/benchmarks/route.ts: which tables exist and which may be per brand. */
const BENCHMARK_BRAND_SCOPED = ['benchmark_fee_ranges', 'benchmark_cpm_rates', 'benchmark_emv_rates', 'benchmark_modifiers'] as const
const BENCHMARK_GLOBAL_ONLY = ['benchmark_markets', 'benchmark_meta'] as const
const BENCHMARK_KEYS: readonly string[] = [...BENCHMARK_BRAND_SCOPED, ...BENCHMARK_GLOBAL_ONLY]
const BENCHMARK_LABELS: Record<string, string> = {
  benchmark_fee_ranges: 'rangos de fee',
  benchmark_cpm_rates: 'umbrales de CPM',
  benchmark_emv_rates: 'tarifas de EMV',
  benchmark_modifiers: 'modificadores de fee',
  benchmark_markets: 'mercados',
  benchmark_meta: 'metadatos de los benchmarks',
}

const isBrandScopedBenchmark = (key: string) => (BENCHMARK_BRAND_SCOPED as readonly string[]).includes(key)

/** The settings rows a PUT would write, as the route computes it. */
function benchmarkPutKeys(body: Record<string, unknown>): string[] {
  const key = body.key as string
  const brandId = typeof body.brandId === 'string' && body.brandId ? body.brandId : null
  return [brandId && isBrandScopedBenchmark(key) ? `${key}_${brandId}` : key]
}

/** The settings rows a DELETE would remove, as the route computes it. */
function benchmarkDeleteKeys(query: Record<string, Scalar>): string[] {
  const key = String(query.key)
  const brandId = typeof query.brandId === 'string' && query.brandId ? query.brandId : null
  if (key === 'all') return BENCHMARK_BRAND_SCOPED.map(k => `${k}_${brandId}`)
  return [brandId ? `${key}_${brandId}` : key]
}

/**
 * The values stored now under those keys, to return them so they can be
 * restored. Only `benchmark_*` keys built from the fixed list and a checked
 * brand id ever reach this query.
 */
async function storedBenchmarks(keys: string[]): Promise<Record<string, unknown>> {
  const safe = keys.filter(k => BENCHMARK_KEYS.some(base => k === base || (k.startsWith(`${base}_`) && isBrandId(k.slice(base.length + 1)))))
  const rows = safe.length > 0 ? await prisma.setting.findMany({ where: { key: { in: safe } }, select: { key: true, value: true } }) : []
  const out: Record<string, unknown> = {}
  for (const k of safe) out[k] = null
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value) as unknown
    } catch {
      out[row.key] = row.value
    }
  }
  return out
}

async function brandLabel(ctx: WriteContext, brandId: string): Promise<string> {
  const data = await ctx.platformJson<{ brands?: { id?: unknown; name?: unknown }[] }>({ method: 'GET', path: '/api/brands', timeoutMs: GENERIC_TIMEOUT_MS })
  const brand = (data.brands ?? []).find(b => b.id === brandId)
  if (!brand) throw new ToolError('No hay ninguna marca con ese brandId. No se ha hecho nada.')
  return label(brand.name)
}

/**
 * DELETE /api/settings/benchmarks takes the table in the query parameter
 * `key`. The platform client lets that one parameter through for that one
 * route, and only with a benchmark table name or `all`
 * (QUERY_KEY_EXCEPTIONS of ../../platform-client.ts); the rule below checks
 * the exact table before anything is prepared. Kept as a switch: set it to
 * true to refuse the DELETE again without touching the rule.
 */
export const BENCHMARK_DELETE_BLOCKED = false

const BENCHMARK_EFFECT =
  'Cambia a la vez el consejo de fees, los semáforos de CPM y el EMV de las campañas, los informes y el portal del cliente afectados. Recuerda mantener coherentes Metodología, Ajustes y la base de conocimiento.'
const BENCHMARK_RESTORE =
  'El valor guardado ahora se devuelve en la respuesta para poder restaurarlo: en la llamada que lo ejecuta pide includeEconomics: true, o esas cifras se quitan de la respuesta.'

// ============ Live-capture widgets ============

/** What PATCH /api/live-capture/widgets/[id] changes (its allowedFields), with the name the preview uses. */
const WIDGET_FIELDS: Record<string, string> = {
  name: 'nombre interno',
  brandName: 'marca',
  brandLogo: 'logo (dirección de la imagen que cargan los visitantes)',
  primaryColor: 'color',
  incentiveText: 'texto del incentivo',
  headlineText: 'titular',
  subtitleText: 'subtítulo',
  triggerType: 'cuándo aparece',
  triggerDelay: 'segundos de espera',
  triggerScroll: 'porcentaje de scroll',
  showOnMobile: 'se muestra en móvil',
  allowedDomains: 'dominios donde funciona',
  isActive: 'activo',
}

/** A widget value as the preview shows it, before and after. */
function widgetValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'vacío'
  if (typeof v === 'boolean') return v ? 'sí' : 'no'
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.length ? v.map(x => label(x, '?')).slice(0, 20).join(', ') : 'ninguno'
  return `«${shortText(v, 200) ?? '?'}»`
}

const widgetFieldsOf = (req: GenericRequest) => Object.keys(WIDGET_FIELDS).filter(f => bodyObject(req)[f] !== undefined)

// ============ The allow table ============

const read = (pattern: string, extra: Partial<AllowRule> = {}): AllowRule => ({ method: 'GET', pattern, ...extra })

/**
 * Everything platform_request may call. Each entry must also be in
 * PLATFORM_ROUTES (the outer fence) with that method: the unit test checks it.
 */
export const ALLOW_RULES: readonly AllowRule[] = [
  // ---- Campaigns: reads; the only write is deleting a brief file ----
  read('/api/campaigns', { note: 'query: status, type, pinned, search' }),
  read('/api/campaigns/compare'),
  read('/api/campaigns/[id]'),
  read('/api/campaigns/[id]/assignments'),
  read('/api/campaigns/[id]/brief-files'),
  read('/api/campaigns/[id]/comments'),
  read('/api/campaigns/[id]/compliance'),
  read('/api/campaigns/[id]/duplicates'),
  read('/api/campaigns/[id]/export', {
    note: 'always format=json',
    force: req => {
      const notes = req.query.format !== undefined && req.query.format !== 'json' ? ['format se ha fijado en json: desde Claude la exportación solo se lee como JSON.'] : []
      return { req: withQuery(req, { ...req.query, format: 'json' }), notes }
    },
  }),
  read('/api/campaigns/[id]/report-config'),
  read('/api/campaigns/[id]/stories'),
  {
    method: 'DELETE',
    pattern: '/api/campaigns/[id]/brief-files',
    classes: ['destructive'],
    classify: () => 'destructive',
    note: 'body { fileId }',
    refuse: req => {
      const fileId = bodyObject(req).fileId
      return typeof fileId === 'string' && ID_RE.test(fileId)
        ? null
        : 'Para borrar un archivo del brief manda body { fileId } con el id del archivo (GET /api/campaigns/<id>/brief-files lo da).'
    },
    preview: async (req, ctx) => {
      const id = req.params.id
      const fileId = bodyObject(req).fileId
      const [campaign, files] = await Promise.all([
        ctx.platformJson<{ campaign?: { name?: unknown } }>({ method: 'GET', path: `/api/campaigns/${id}`, timeoutMs: GENERIC_TIMEOUT_MS }),
        ctx.platformJson<{ files?: { id?: unknown; fileName?: unknown }[] }>({ method: 'GET', path: `/api/campaigns/${id}/brief-files`, timeoutMs: GENERIC_TIMEOUT_MS }),
      ])
      const file = (files.files ?? []).find(f => f.id === fileId)
      if (!file) throw new ToolError('Ese archivo no está en el brief de esta campaña. No se ha hecho nada.')
      return {
        text: `Vas a borrar el archivo «${label(file.fileName)}» del brief de la campaña «${label(campaign.campaign?.name)}». No se puede deshacer: para recuperarlo habría que volver a subirlo desde la plataforma. ${ASK}`,
      }
    },
  },

  // ---- Pipeline ----
  read('/api/pipeline', { note: 'pass campaignId whenever possible; shipping data only with includeContact' }),

  // ---- Creators ----
  read('/api/influencers', { note: 'query: search, platform...' }),
  read('/api/influencers/[id]'),
  read('/api/influencers/[id]/history'),
  read('/api/influencers/[id]/insights'),
  read('/api/influencers/[id]/lookalikes'),
  read('/api/influencers/[id]/optimal-times'),
  read('/api/influencers/invite'),
  {
    method: 'POST',
    pattern: '/api/influencers/discover',
    note: "free search only: body.mode 'category', no confirmPaid",
    readOnly: true,
    refuse: req => {
      const body = bodyObject(req)
      if (body.mode !== 'category') {
        return "platform_request solo hace la búsqueda gratuita por categoría: manda body.mode exactamente 'category'. Sin mode (o con 'username') una palabra suelta se convierte en una lectura de pago de un perfil: para eso usa analyze_creator_profile, que además guarda los datos."
      }
      if (body.confirmPaid !== undefined && body.confirmPaid !== false) {
        return 'La búsqueda de pago por categoría tiene su herramienta propia: usa run_paid_creator_search.'
      }
      if (body.confirmed !== undefined) return 'confirmed solo sirve para la búsqueda de pago: usa run_paid_creator_search.'
      return null
    },
  },

  // ---- Lists, contacts, brands: reads ----
  read('/api/lists'),
  read('/api/lists/[id]'),
  read('/api/contacts', { note: 'contact data only with includeContact' }),
  read('/api/contacts/address', { note: 'contact data only with includeContact' }),
  read('/api/brands'),

  // ---- Templates ----
  read('/api/templates'),
  { method: 'POST', pattern: '/api/templates' },
  {
    method: 'DELETE',
    pattern: '/api/templates/[id]',
    classes: ['destructive'],
    classify: () => 'destructive',
    preview: async (req, ctx) => {
      const data = await ctx.platformJson<{ templates?: { id?: unknown; name?: unknown; userId?: unknown }[] }>({ method: 'GET', path: '/api/templates', timeoutMs: GENERIC_TIMEOUT_MS })
      const template = (data.templates ?? []).find(t => t.id === req.params.id)
      if (!template) throw new ToolError('No hay ninguna plantilla con ese id. No se ha hecho nada.')
      const owner = template.userId === ctx.user.id ? 'creada por ti' : 'creada por otra persona del equipo'
      return { text: `Vas a borrar la plantilla de campaña «${label(template.name)}» (${owner}). No se puede deshacer. ${ASK}` }
    },
  },

  // ---- Notifications of the administrator ----
  read('/api/notifications'),
  {
    method: 'PATCH',
    pattern: '/api/notifications',
    note: 'mark as read: { ids } (up to 5 without confirmation) or { markAll: true }; only when the person asked',
    classes: ['none', 'bulk'],
    classify: req => {
      const body = bodyObject(req)
      return body.markAll === true || (Array.isArray(body.ids) && body.ids.length > 5) ? 'bulk' : 'none'
    },
    refuse: req => {
      const body = bodyObject(req)
      if (body.markAll === true) return null
      if (body.markAll !== undefined && body.markAll !== false) return 'markAll debe ser true o no ir.'
      if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every(id => typeof id === 'string' && ID_RE.test(id))) {
        return 'Manda { ids: [...] } con los ids de las notificaciones, o { markAll: true }.'
      }
      return null
    },
    preview: async (req, ctx) => {
      const body = bodyObject(req)
      if (body.markAll === true) {
        const data = await ctx.platformJson<{ unreadCount?: unknown }>({ method: 'GET', path: '/api/notifications', query: { unread: true, limit: 1 }, timeoutMs: GENERIC_TIMEOUT_MS })
        const n = nonNegativeInt(data.unreadCount) ?? 0
        return { text: `Vas a marcar como leídas tus ${n} notificaciones sin leer. ${ASK}`, fingerprint: `unread:${n}` }
      }
      const n = Array.isArray(body.ids) ? body.ids.length : 0
      return { text: `Vas a marcar como leídas ${n} notificaciones. ${ASK}` }
    },
  },

  // ---- Calendar and dashboards ----
  read('/api/calendar'),
  read('/api/dashboard'),
  read('/api/dashboard/brands'),

  // ---- Discovery (pool of creators): reads ----
  read('/api/discovery/creators/[id]'),
  read('/api/discovery/search'),
  {
    method: 'POST',
    pattern: '/api/discovery/search',
    note: 'a read; limit at most 100',
    readOnly: true,
    force: capBodyLimit(100),
  },

  // ---- Lookalikes and ad permissions ----
  {
    method: 'POST',
    pattern: '/api/creators/lookalikes',
    note: 'free with creatorId only; with handle it may read one profile from Apify (confirmation)',
    long: true,
    readOnly: true,
    classes: ['none', 'money'],
    spend: 'optional',
    classify: req => {
      const handle = bodyObject(req).handle
      return typeof handle === 'string' && handle.trim() ? 'money' : 'none'
    },
    refuse: req => {
      const body = bodyObject(req)
      const hasHandle = typeof body.handle === 'string' && body.handle.trim().length > 0
      const hasCreator = typeof body.creatorId === 'string' && ID_RE.test(body.creatorId)
      return hasHandle || hasCreator ? null : 'Manda body { creatorId } (gratis) o { handle, platform } (puede leer un perfil con Apify).'
    },
    preview: async (req, ctx) => {
      const body = bodyObject(req)
      const handle = cleanHandle(body.handle) ?? label(body.handle)
      const platform = typeof body.platform === 'string' ? ` en ${platformName(body.platform.toUpperCase())}` : ''
      return {
        text: `Vas a buscar creadoras parecidas a @${handle}${platform}. Si @${handle} no está ya en la base de datos, se hace 1 lectura de perfil con Apify. ${await apifyLine(ctx)} ${ASK}`,
      }
    },
  },
  read('/api/creators/ad-permissions'),

  // ---- Pure calculations (reads) ----
  read('/api/hashtags/trending'),
  { method: 'POST', pattern: '/api/intelligence', note: 'a calculation, writes nothing', readOnly: true },
  { method: 'POST', pattern: '/api/pricing/analyze', note: 'a calculation, writes nothing', readOnly: true },
  {
    method: 'POST',
    pattern: '/api/reports/scheduled',
    note: 'a read: email and frequency are removed, nothing is scheduled',
    readOnly: true,
    force: req => {
      const body = { ...bodyObject(req) }
      const notes = body.email !== undefined || body.frequency !== undefined ? ['email y frequency se han quitado: desde Claude no se programa ningún envío.'] : []
      delete body.email
      delete body.frequency
      return { req: withBody(req, body), notes }
    },
  },

  // ---- Client portal (as the admin sees it) ----
  read('/api/portal/overview', {
    note: 'brandId required',
    refuse: req => (typeof req.query.brandId === 'string' && isBrandId(req.query.brandId) ? null : 'Pasa query.brandId con el id de la marca (GET /api/brands lo da).'),
  }),
  read('/api/portal/campaigns/[id]'),
  read('/api/portal/campaigns/[id]/report-config'),

  // ---- Knowledge base, in pages ----
  read('/api/knowledge-base', {
    note: `pages of ${KNOWLEDGE_PAGE_CHARS} characters: query.offset`,
    maxStringChars: KNOWLEDGE_PAGE_CHARS,
    refuse: req => (req.query.offset === undefined || nonNegativeInt(req.query.offset) !== null ? null : 'query.offset debe ser un número entero mayor o igual que 0.'),
    // The route takes no parameter: the offset is the connector's own
    force: req => ({ req: withQuery(req, {}), notes: [] }),
    transform: (json, original) => {
      const content = isPlainObject(json) && typeof json.content === 'string' ? json.content : ''
      const offset = Math.min(nonNegativeInt(original.query.offset) ?? 0, content.length)
      const end = Math.min(content.length, offset + KNOWLEDGE_PAGE_CHARS)
      return { content: content.slice(offset, end), offset, totalChars: content.length, nextOffset: end < content.length ? end : null }
    },
  }),

  // ---- Competitors ----
  read('/api/competitors'),
  read('/api/competitors/compare'),
  read('/api/competitors/[id]'),
  {
    method: 'POST',
    pattern: '/api/competitors',
    note: 'adds an account: one Apify profile read (confirmation)',
    long: true,
    classes: ['money'],
    classify: () => 'money',
    spend: 'optional',
    refuse: req => {
      const body = bodyObject(req)
      if (typeof body.username !== 'string' || !cleanHandle(body.username)) return 'Manda body { username, platform } con el usuario de la cuenta (sin URL).'
      if (!(SOCIAL_PLATFORMS as readonly unknown[]).includes(body.platform)) return 'platform debe ser INSTAGRAM, TIKTOK o YOUTUBE.'
      return null
    },
    preview: async (req, ctx) => {
      const body = bodyObject(req)
      return {
        text: `Vas a añadir @${cleanHandle(body.username)} (${platformName(body.platform)}) como cuenta competidora: 1 lectura de perfil con Apify. ${await apifyLine(ctx)} ${ASK}`,
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/competitors/[id]',
    note: "body { action: 'refresh' }: one Apify profile read (confirmation)",
    long: true,
    classes: ['money'],
    classify: () => 'money',
    spend: 'optional',
    refuse: req => (bodyObject(req).action === 'refresh' ? null : "La única acción es body { action: 'refresh' }."),
    preview: async (req, ctx) => {
      const data = await ctx.platformJson<{ competitors?: { id?: unknown; username?: unknown; platform?: unknown }[] }>({ method: 'GET', path: '/api/competitors', timeoutMs: GENERIC_TIMEOUT_MS })
      const c = (data.competitors ?? []).find(x => x.id === req.params.id)
      if (!c) throw new ToolError('No hay ninguna cuenta competidora con ese id. No se ha hecho nada.')
      return {
        text: `Vas a actualizar la cuenta competidora @${label(c.username)} (${platformName(c.platform)}): 1 lectura de perfil con Apify. ${await apifyLine(ctx)} ${ASK}`,
      }
    },
  },
  {
    method: 'DELETE',
    pattern: '/api/competitors/[id]',
    classes: ['destructive'],
    classify: () => 'destructive',
    preview: async (req, ctx) => {
      const data = await ctx.platformJson<{ competitors?: { id?: unknown; username?: unknown; platform?: unknown; _count?: { posts?: unknown } }[] }>({ method: 'GET', path: '/api/competitors', timeoutMs: GENERIC_TIMEOUT_MS })
      const c = (data.competitors ?? []).find(x => x.id === req.params.id)
      if (!c) throw new ToolError('No hay ninguna cuenta competidora con ese id. No se ha hecho nada.')
      const posts = nonNegativeInt(c._count?.posts) ?? 0
      return {
        text: `Vas a borrar la cuenta competidora @${label(c.username)} (${platformName(c.platform)}) y sus ${posts} publicaciones guardadas. No se puede deshacer, y volver a añadirla costará una nueva lectura de Apify. ${ASK}`,
      }
    },
  },

  // ---- Client contacts ----
  read('/api/client-contacts'),
  { method: 'POST', pattern: '/api/client-contacts' },
  {
    method: 'POST',
    pattern: '/api/client-contacts/import',
    note: 'up to 200 contacts; more than 5 need confirmation',
    classes: ['none', 'bulk'],
    classify: req => {
      const contacts = bodyObject(req).contacts
      return Array.isArray(contacts) && contacts.length > 5 ? 'bulk' : 'none'
    },
    refuse: req => {
      const contacts = bodyObject(req).contacts
      if (!Array.isArray(contacts) || contacts.length === 0) return 'Manda body { contacts: [...] } con al menos un contacto.'
      return null
    },
    preview: async req => {
      const n = (bodyObject(req).contacts as unknown[]).length
      return {
        text: `Vas a importar ${n} contactos de cliente a tu usuario. No se eliminan duplicados, y no hay forma de deshacerlo ni de borrarlos desde la plataforma. ${ASK}`,
      }
    },
  },
  read('/api/client-contacts/matches'),
  { method: 'PATCH', pattern: '/api/client-contacts/matches/[id]' },
  read('/api/client-contacts/matches/[id]/warm-score'),
  { method: 'POST', pattern: '/api/client-contacts/matches/[id]/warm-score' },

  // ---- Live capture widgets ----
  read('/api/live-capture/stats'),
  read('/api/live-capture/widgets'),
  read('/api/live-capture/widgets/[id]'),
  {
    method: 'POST',
    pattern: '/api/live-capture/widgets',
    warning: 'El cambio ya está activo en la web del cliente donde esté instalado el widget.',
  },
  {
    // The form on the client's website: whatever changes here, its visitors see (and their browsers
    // load) at once. Approved in the platform, like an e-mail to a person, with the before and after.
    method: 'PATCH',
    pattern: '/api/live-capture/widgets/[id]',
    note: "what the visitors of the client's website see: approval in the platform",
    classes: ['outbound'],
    classify: () => 'outbound',
    refuse: req => (widgetFieldsOf(req).length > 0 ? null : `Manda en body al menos uno de estos campos: ${Object.keys(WIDGET_FIELDS).join(', ')}.`),
    preview: async (req, ctx) => {
      const data = await ctx.platformJson<{ widget?: Record<string, unknown> }>({ method: 'GET', path: `/api/live-capture/widgets/${req.params.id}`, timeoutMs: GENERIC_TIMEOUT_MS })
      const widget = data.widget
      if (!widget) throw new ToolError('No hay ningún widget tuyo con ese id. No se ha hecho nada.')
      const body = bodyObject(req)
      const fields = widgetFieldsOf(req)
      const changes = fields.map(f => `${WIDGET_FIELDS[f]}: ${widgetValue(widget[f])} → ${widgetValue(body[f])}`)
      return {
        text:
          `Vas a cambiar el widget de captación «${label(widget.name)}», que funciona en la web del cliente: ${changes.join('; ')}. ` +
          `Lo ven al momento todas las personas que visiten esa web. ${ASK}`,
        fingerprint: JSON.stringify(fields.map(f => widget[f] ?? null)),
      }
    },
    warning: 'El cambio ya está activo en la web del cliente donde esté instalado el widget.',
  },
  {
    method: 'DELETE',
    pattern: '/api/live-capture/widgets/[id]',
    classes: ['destructive'],
    classify: () => 'destructive',
    preview: async (req, ctx) => {
      const data = await ctx.platformJson<{ widget?: { name?: unknown; _count?: { captures?: unknown } } }>({ method: 'GET', path: `/api/live-capture/widgets/${req.params.id}`, timeoutMs: GENERIC_TIMEOUT_MS })
      const captures = nonNegativeInt(data.widget?._count?.captures) ?? 0
      return {
        text: `Vas a borrar el widget «${label(data.widget?.name)}» y sus ${captures} capturas. El formulario dejará de funcionar en la web del cliente. No se puede deshacer. ${ASK}`,
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/live-capture/enrich',
    note: 'up to 10 Apify profile reads (confirmation)',
    long: true,
    classes: ['money'],
    classify: () => 'money',
    spend: 'optional',
    refuse: req => {
      const captureId = bodyObject(req).captureId
      return captureId === undefined || (typeof captureId === 'string' && ID_RE.test(captureId)) ? null : 'captureId debe ser el id de una captura.'
    },
    preview: async (req, ctx) => {
      const one = typeof bodyObject(req).captureId === 'string'
      const what = one ? 'la captura indicada: 1 lectura de perfil' : 'hasta 10 capturas pendientes de los widgets de todos los usuarios: hasta 10 lecturas de perfil'
      return {
        text: `Vas a procesar ${what} con Apify, y se crean contactos de cliente y coincidencias con creadoras. ${await apifyLine(ctx)} ${ASK}`,
      }
    },
  },

  // ---- Status ----
  read('/api/apify-status'),
  read('/api/health'),

  // ---- Settings: never the integrations ----
  read('/api/settings'),
  read('/api/settings/benchmarks', {
    refuse: req => (req.query.brandId === undefined || (typeof req.query.brandId === 'string' && isBrandId(req.query.brandId)) ? null : 'brandId no es el id de una marca.'),
  }),
  {
    method: 'PUT',
    pattern: '/api/settings/benchmarks',
    note: 'replaces a whole table (confirmation); the previous value is returned',
    classes: ['bulk'],
    classify: () => 'bulk',
    refuse: req => {
      const body = bodyObject(req)
      if (typeof body.key !== 'string' || !BENCHMARK_KEYS.includes(body.key)) return `key debe ser una de: ${BENCHMARK_KEYS.join(', ')}.`
      if (body.value === undefined) return 'Falta value: la tabla completa que se guarda.'
      if (body.brandId !== undefined && !(typeof body.brandId === 'string' && isBrandId(body.brandId))) return 'brandId no es el id de una marca.'
      return null
    },
    preview: async (req, ctx) => {
      const body = bodyObject(req)
      const key = body.key as string
      const scoped = typeof body.brandId === 'string' && isBrandScopedBenchmark(key)
      const where = scoped ? `de la marca «${await brandLabel(ctx, body.brandId as string)}»` : 'de TODA la agencia'
      const current = await storedBenchmarks(benchmarkPutKeys(body))
      const exists = Object.values(current).some(v => v !== null)
      return {
        text: `Vas a sustituir la tabla de ${BENCHMARK_LABELS[key]} ${where}${exists ? '' : ' (ahora no hay ninguna guardada)'}. ${BENCHMARK_EFFECT} ${BENCHMARK_RESTORE} ${ASK}`,
        fingerprint: argsDigest(current),
      }
    },
    before: async req => ({ previous: await storedBenchmarks(benchmarkPutKeys(bodyObject(req))) }),
  },
  {
    method: 'DELETE',
    pattern: '/api/settings/benchmarks',
    note: 'query key[, brandId]; the previous value is returned',
    classes: ['destructive'],
    classify: () => 'destructive',
    refuse: req => {
      if (BENCHMARK_DELETE_BLOCKED) {
        return 'Borrar una tabla de benchmarks todavía no se puede hacer desde Claude: la ruta recibe el nombre de la tabla en el parámetro key, que el conector nunca envía. Hazlo desde Ajustes, en Benchmarks.'
      }
      const { key, brandId } = req.query
      if (brandId !== undefined && !(typeof brandId === 'string' && isBrandId(brandId))) return 'brandId no es el id de una marca.'
      if (key === 'all') return brandId === undefined ? 'key=all solo vale con brandId: borra las tablas propias de una marca.' : null
      if (typeof key !== 'string' || !BENCHMARK_KEYS.includes(key)) return `query.key debe ser all o una de: ${BENCHMARK_KEYS.join(', ')}.`
      if (brandId !== undefined && !isBrandScopedBenchmark(key)) return `${key} es solo de la agencia: no tiene versión por marca.`
      return null
    },
    preview: async (req, ctx) => {
      const key = String(req.query.key)
      const brandId = typeof req.query.brandId === 'string' ? req.query.brandId : null
      const current = await storedBenchmarks(benchmarkDeleteKeys(req.query))
      const stored = Object.values(current).filter(v => v !== null).length
      if (stored === 0) throw new ToolError('No hay ninguna tabla guardada con esa clave: no hay nada que borrar. No se ha hecho nada.')
      const what =
        key === 'all'
          ? `todas las tablas de benchmarks propias de la marca «${await brandLabel(ctx, brandId as string)}» (${stored} guardadas): la marca volverá a usar las de la agencia`
          : brandId
            ? `la tabla de ${BENCHMARK_LABELS[key]} propia de la marca «${await brandLabel(ctx, brandId)}»: la marca volverá a usar la de la agencia`
            : `la tabla de ${BENCHMARK_LABELS[key]} de TODA la agencia: volverá a los valores por defecto`
      return { text: `Vas a borrar ${what}. ${BENCHMARK_EFFECT} ${BENCHMARK_RESTORE} ${ASK}` }
    },
    before: async req => ({ previous: await storedBenchmarks(benchmarkDeleteKeys(req.query)) }),
  },

  // ---- Admin jobs ----
  {
    method: 'POST',
    pattern: '/api/admin/backfill-categories',
    note: 'query dryRun=true runs without writing; without it, confirmation',
    long: true,
    classes: ['none', 'bulk'],
    classify: req => (req.query.dryRun === true || req.query.dryRun === 'true' ? 'none' : 'bulk'),
    preview: async (_req, ctx) => {
      const dry = await ctx.platformJson<{ processed?: unknown; categorized?: unknown }>({ method: 'POST', path: '/api/admin/backfill-categories', query: { dryRun: true }, timeoutMs: GENERIC_LONG_TIMEOUT_MS })
      const processed = nonNegativeInt(dry.processed) ?? 0
      const categorized = nonNegativeInt(dry.categorized) ?? 0
      if (categorized === 0) throw new ToolError(`La prueba sin cambios no encuentra ninguna creadora que categorizar (revisadas: ${processed}). No se ha hecho nada.`)
      return {
        text: `Vas a guardar categorías para ${categorized} de las ${processed} creadoras del pool que no tenían ninguna (como mucho 100 por llamada), según su bio y sus publicaciones. ${ASK}`,
        fingerprint: `${processed}:${categorized}`,
      }
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/backfill-contact-addresses',
    long: true,
    classes: ['bulk'],
    classify: () => 'bulk',
    preview: async () => ({
      text: `Vas a copiar la dirección de envío más reciente de cada creadora al contacto del dueño de su campaña, solo donde ese contacto no tiene dirección. No sobrescribe ninguna dirección. ${ASK}`,
    }),
  },
  {
    method: 'POST',
    pattern: '/api/admin/backfill-contacts',
    long: true,
    classes: ['bulk'],
    classify: () => 'bulk',
    preview: async () => ({
      text: `Vas a crear un contacto (estado «nuevo») en tu usuario para cada creadora de tus campañas y listas que todavía no lo tenga. ${ASK}`,
    }),
  },
  {
    method: 'POST',
    pattern: '/api/admin/backfill-gender',
    note: 'limit at most 5000',
    long: true,
    classes: ['bulk'],
    classify: () => 'bulk',
    force: capBodyLimit(5000, 5000),
    preview: async req => ({
      text: `Vas a rellenar el género de hasta ${parsedLimit(bodyObject(req).limit) ?? 5000} creadoras que no lo tienen, deducido de su nombre público (sin Apify), y copiarlo a sus perfiles del pool. ${ASK}`,
    }),
  },
  read('/api/admin/benchmarks/recompute'),
  { method: 'POST', pattern: '/api/admin/benchmarks/recompute', long: true, note: 'recomputes the own benchmarks from the agreed fees' },
  read('/api/admin/cache-avatars'),
  { method: 'POST', pattern: '/api/admin/cache-avatars', long: true, note: 'limit at most 100; no Apify', force: capBodyLimit(100, 100) },
  read('/api/admin/cache-thumbs'),
  { method: 'POST', pattern: '/api/admin/cache-thumbs', long: true, note: 'limit at most 100; no Apify', force: capBodyLimit(100) },
  read('/api/admin/enrich-views', { note: 'backlog of views to read' }),
  {
    method: 'POST',
    pattern: '/api/admin/enrich-views',
    note: 'reads real views with Apify: limit at most 50, all refused (confirmation)',
    long: true,
    classes: ['money'],
    classify: () => 'money',
    spend: 'core',
    refuse: req => (bodyObject(req).all === undefined || bodyObject(req).all === false ? null : 'all no se acepta desde Claude: usa limit (como mucho 50).'),
    force: req => capBodyLimit(50, bodyObject(req).mode === 'refresh' ? 50 : 25)(req),
    preview: async (req, ctx) => {
      const body = bodyObject(req)
      const campaignId = typeof body.campaignId === 'string' && ID_RE.test(body.campaignId) ? body.campaignId : undefined
      const backlog = await ctx.platformJson<{ pending?: unknown; refreshDue?: { due?: unknown } }>({ method: 'GET', path: '/api/admin/enrich-views', query: { campaignId }, timeoutMs: GENERIC_TIMEOUT_MS })
      const pending = nonNegativeInt(backlog.pending) ?? 0
      const due = nonNegativeInt(backlog.refreshDue?.due) ?? 0
      const limit = parsedLimit(body.limit) ?? 25
      const refresh = body.mode === 'refresh'
      const scope = campaignId ? 'de esta campaña' : 'de todas las campañas'
      const what = refresh
        ? `volver a leer las vistas públicas de hasta ${limit} vídeos ${scope} que cumplen 7 o 14 días (pendientes ahora: ${due})`
        : `leer las vistas reales de hasta ${limit} reels y vídeos ${scope} que llegaron por Meta sin vistas (pendientes ahora: ${pending})`
      return { text: `Vas a ${what}, con Apify. ${await apifyLine(ctx)} ${ASK}`, fingerprint: `${pending}:${due}` }
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/fanout-media',
    note: 'body.dryRun true runs without writing; without it, confirmation',
    long: true,
    classes: ['none', 'bulk'],
    classify: req => (bodyObject(req).dryRun === true ? 'none' : 'bulk'),
    preview: async (_req, ctx) => {
      const dry = await ctx.platformJson<{ candidates?: unknown; byCampaign?: Record<string, unknown> }>({ method: 'POST', path: '/api/admin/fanout-media', body: { dryRun: true }, timeoutMs: GENERIC_LONG_TIMEOUT_MS })
      const candidates = nonNegativeInt(dry.candidates) ?? 0
      if (candidates === 0) throw new ToolError('La prueba sin cambios no encuentra ninguna publicación que copiar. No se ha hecho nada.')
      const per = Object.entries(dry.byCampaign ?? {})
        .slice(0, 10)
        .map(([name, n]) => `«${label(name)}»: ${nonNegativeInt(n) ?? 0}`)
        .join('; ')
      return {
        text: `Vas a copiar ${candidates} publicaciones a otras campañas activas en las que también cumplen las reglas (${per}). ${ASK}`,
        fingerprint: `${candidates}`,
      }
    },
  },
  read('/api/admin/meta-status', { note: 'booleans only' }),
  {
    method: 'POST',
    pattern: '/api/admin/sync-creator-pool',
    long: true,
    classes: ['bulk'],
    classify: () => 'bulk',
    preview: async req => {
      const body = bodyObject(req)
      const limit = Math.min(parsedLimit(body.limit) ?? 2000, 5000)
      const extra = body.reclassifyRealCreators === true ? ' y volver a clasificar las del pool que no están vinculadas' : ''
      return { text: `Vas a sincronizar el pool de creadoras desde la tabla de creadoras (hasta ${limit}, sin Apify)${extra}. ${ASK}` }
    },
  },

  // ---- Instagram connections: reads ----
  read('/api/meta/connections', { note: 'no token is ever returned' }),
  read('/api/meta/connections/[id]'),
]

// ============ What is refused, with the reason ============

/** Writes owned by a curated tool: refused here with the name of the tool. */
export const CURATED_WRITES: readonly { method: PlatformMethod; pattern: string; tools: readonly string[] }[] = [
  { method: 'POST', pattern: '/api/campaigns', tools: ['create_campaign'] },
  { method: 'PUT', pattern: '/api/campaigns/[id]', tools: ['update_campaign', 'set_campaign_status', 'set_campaign_tracking_targets', 'set_campaign_goals', 'record_business_results'] },
  { method: 'DELETE', pattern: '/api/campaigns/[id]', tools: ['delete_campaign'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/assignments', tools: ['set_campaign_access'] },
  { method: 'DELETE', pattern: '/api/campaigns/[id]/assignments', tools: ['set_campaign_access'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/influencers', tools: ['add_creators_to_campaign'] },
  { method: 'PATCH', pattern: '/api/campaigns/[id]/influencers', tools: ['update_creator_deal', 'set_creator_status', 'set_creator_shipping'] },
  { method: 'DELETE', pattern: '/api/campaigns/[id]/influencers', tools: ['remove_creator_from_campaign'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/influencers/bulk', tools: ['add_creators_to_campaign', 'link_creator_profile'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/influencers/move', tools: ['move_creators_between_campaigns'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/media/manual', tools: ['add_publications_by_url'] },
  { method: 'PATCH', pattern: '/api/campaigns/[id]/media/[mediaId]', tools: ['correct_publication_metrics', 'tag_publications'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/notes', tools: ['add_creator_note'] },
  { method: 'PUT', pattern: '/api/campaigns/[id]/report-config', tools: ['set_report_visibility', 'edit_report_content'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/report-config', tools: ['mark_report_sent'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/revalidate-media', tools: ['revalidate_campaign_media'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/stories', tools: ['register_stories'] },
  { method: 'POST', pattern: '/api/campaigns/[id]/track', tools: ['launch_campaign_tracking'] },
  { method: 'PATCH', pattern: '/api/pipeline/[id]', tools: ['set_creator_status'] },
  { method: 'POST', pattern: '/api/influencers', tools: ['create_creator_manually'] },
  { method: 'PATCH', pattern: '/api/influencers/[id]', tools: ['update_creator_profile'] },
  { method: 'PATCH', pattern: '/api/influencers/[id]/gender', tools: ['update_creator_profile'] },
  { method: 'POST', pattern: '/api/influencers/analyze', tools: ['analyze_creator_profile'] },
  { method: 'POST', pattern: '/api/influencers/invite', tools: ['invite_creator_to_connect'] },
  { method: 'POST', pattern: '/api/discovery/batch', tools: ['import_creators_to_database'] },
  { method: 'POST', pattern: '/api/lists', tools: ['create_list'] },
  { method: 'POST', pattern: '/api/lists/[id]', tools: ['add_creators_to_list'] },
  { method: 'PUT', pattern: '/api/lists/[id]', tools: ['update_list'] },
  { method: 'DELETE', pattern: '/api/lists/[id]', tools: ['remove_creators_from_list', 'delete_list'] },
  { method: 'POST', pattern: '/api/contacts', tools: ['save_contact_address'] },
  { method: 'PATCH', pattern: '/api/contacts', tools: ['save_contact_address'] },
  { method: 'POST', pattern: '/api/brands', tools: ['create_brand'] },
  { method: 'PATCH', pattern: '/api/brands', tools: ['update_brand'] },
  { method: 'DELETE', pattern: '/api/brands', tools: ['delete_brand'] },
  { method: 'POST', pattern: '/api/meta/sync/[connectionId]', tools: ['sync_instagram_connection'] },
]

interface DenyRule {
  /** `/api/x/[id]/y`: matches that exact shape; with `under`, also everything below it. */
  pattern: string
  under?: boolean
  /** Methods it applies to; every method when absent. */
  methods?: readonly PlatformMethod[]
  reason(params: Record<string, string>): string
}

const deny = (pattern: string, reason: string | ((p: Record<string, string>) => string), extra: Partial<DenyRule> = {}): DenyRule => ({
  pattern,
  reason: typeof reason === 'string' ? () => reason : reason,
  ...extra,
})

const R = {
  auth: 'Contraseñas, sesiones y los flujos que crean las conexiones de Meta y YouTube están fuera del alcance de Claude: el conector entra con su propia autorización y nunca maneja credenciales.',
  invite: 'Son los pasos de la persona invitada en su navegador, que crean una cuenta con contraseña: el enlace es su credencial y Claude nunca lo usa.',
  team: 'Usuarios, roles, invitaciones del equipo y accesos de clientes están fuera del alcance de Claude para siempre. Quién tiene acceso a una campaña se lee con GET /api/campaigns/<id>/assignments.',
  integrations: 'Las claves de Apify y YouTube y las integraciones están fuera del alcance de Claude: esa ruta devuelve claves en claro y guarda secretos.',
  meta: 'La gestión de las conexiones de Meta (suscripciones, webhooks, enlaces de conexión y revocaciones) está fuera del alcance de Claude.',
  cron: 'Las tareas programadas solo las lanza el programador con su secreto, y varias gastan Apify en todas las campañas.',
  seed: 'Las rutas de carga inicial están fuera del alcance de Claude: la de discovery deja cientos de lecturas de Apify en cola sin forma de cancelarlas.',
  deletion: 'Es el punto público de borrado de datos (RGPD y Meta): las peticiones de borrado de datos personales las tramitan los administradores a mano.',
  widgetPublic: 'Son los puntos públicos del widget en la web del cliente: llamarlos inventaría capturas e impresiones.',
  ai: 'Gasta crédito de IA y no aporta nada que Claude no pueda hacer por sí mismo.',
  comments: 'La descarga de comentarios es de pago, sin límite, y guarda todos los comentarios bajo la primera publicación: está fuera hasta que se corrija.',
  notifyPost: 'Envía un correo a todo el equipo con un enlace sin validar: está fuera hasta que se corrija.',
  adPermissions: 'Crearía registros de permiso de uso que ninguna creadora ha dado: solo se pueden leer.',
  cleanup: 'Esa ruta está desactivada a propósito.',
  creatorDashboard: 'Es la vista de una creadora: para un administrador siempre responde 403.',
  multipart: 'Subir archivos al brief es multipart y no se puede expresar en JSON: súbelo desde la plataforma.',
  exportPost: 'Es un duplicado de GET /api/campaigns/<id>/export (con format=json).',
  own: 'Claude no puede ver, ampliar ni revocar sus propias autorizaciones.',
  notes: 'Las notas internas no se devuelven por la herramienta genérica.',
  image: 'Es una imagen para el navegador: Claude no recibe archivos. Ábrela en la plataforma.',
} as const

/** Specific reasons for what platform_request refuses, from the proposal's deny list. */
export const DENY_RULES: readonly DenyRule[] = [
  deny('/api/auth', R.auth, { under: true }),
  deny('/api/invite', R.invite, { under: true }),
  deny('/api/influencers/invite/accept', R.invite, { under: true }),
  deny('/api/influencers/invite/validate', R.invite, { under: true }),
  deny('/api/team', R.team, { under: true }),
  deny('/api/settings/integrations', R.integrations, { under: true }),
  deny('/api/admin/meta-subscribe', R.meta, { under: true }),
  deny('/api/meta/webhooks', R.meta, { under: true }),
  deny('/api/meta/connections/[id]', R.meta, { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] }),
  deny('/api/brand-connect', R.meta, { under: true }),
  deny('/api/cron', R.cron, { under: true }),
  deny('/api/seed', R.seed, { under: true }),
  deny('/api/discovery/seed', R.seed, { under: true }),
  deny('/api/data-deletion', R.deletion, { under: true }),
  deny('/api/live-capture/collect', R.widgetPublic, { under: true }),
  deny('/api/live-capture/widget-config', R.widgetPublic, { under: true }),
  deny('/api/ai', R.ai, { under: true }),
  deny('/api/campaigns/[id]/media/[mediaId]/insights', R.ai),
  deny('/api/campaigns/[id]/comments', R.comments, { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] }),
  deny('/api/campaigns/[id]/notify-post', R.notifyPost),
  deny('/api/creators/ad-permissions', R.adPermissions, { methods: ['POST', 'PUT', 'PATCH', 'DELETE'] }),
  deny('/api/admin/cleanup-auto-added', R.cleanup, { under: true }),
  deny('/api/dashboard/creator', R.creatorDashboard, { under: true }),
  deny('/api/campaigns/[id]/brief-files', R.multipart, { methods: ['POST'] }),
  deny('/api/campaigns/[id]/export', R.exportPost, { methods: ['POST'] }),
  deny('/api/campaigns/[id]/notes', R.notes, { methods: ['GET'] }),
  deny('/api/oauth', R.own, { under: true }),
  deny('/api/mcp', R.own, { under: true }),
  // Files and images: the link to the screen instead
  deny('/api/campaigns/[id]/report/pdf', p => `El informe en PDF es un archivo: Claude no recibe archivos. Ábrelo en la plataforma: ${APP_URL}/campaigns/${p.id}/report`),
  deny('/api/portal/campaigns/[id]/report/pdf', p => `El informe en PDF es un archivo: Claude no recibe archivos. Ábrelo en la plataforma: ${APP_URL}/portal/campaigns/${p.id}/report`),
  deny('/api/campaigns/[id]/brief-files/[fileId]', p => `El archivo del brief no se puede leer desde Claude. Ábrelo en la plataforma: ${APP_URL}/campaigns/${p.id}`),
  deny('/api/campaigns/[id]/shipping', p => `La hoja de envíos es un CSV con direcciones. Los datos de envío se leen en JSON con GET /api/pipeline?campaignId=${p.id} e includeContact: true.`),
  deny('/api/proxy', R.image, { under: true }),
  deny('/api/media/[id]/thumb', R.image),
  deny('/api/influencers/[id]/avatar', R.image),
]

// ============ Matching ============

function matchShape(pattern: string, segments: readonly string[], under: boolean): Record<string, string> | null {
  const parts = pattern.split('/').slice(1)
  if (under ? segments.length < parts.length : segments.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const dyn = /^\[([A-Za-z]+)\]$/.exec(parts[i])
    if (dyn) params[dyn[1]] = segments[i]
    else if (parts[i] !== segments[i]) return null
  }
  return params
}

/** The specific reason a request is refused, or null when no deny rule applies. */
export function denyReason(method: PlatformMethod, path: string): string | null {
  const segments = path.split('/').slice(1)
  for (const rule of DENY_RULES) {
    if (rule.methods && !rule.methods.includes(method)) continue
    const params = matchShape(rule.pattern, segments, rule.under === true)
    if (params) return rule.reason(params)
  }
  return null
}

/** The curated tools that own this write, or null. */
export function curatedOwner(method: PlatformMethod, pattern: string): readonly string[] | null {
  return CURATED_WRITES.find(w => w.method === method && w.pattern === pattern)?.tools ?? null
}

function findRule(method: PlatformMethod, pattern: string): AllowRule | undefined {
  return ALLOW_RULES.find(r => r.method === method && r.pattern === pattern)
}

/** «GET /api/campaigns · GET, POST /api/competitors · ...»: what platform_request can call. */
export function allowedSummary(): string {
  const byPattern = new Map<string, PlatformMethod[]>()
  for (const r of ALLOW_RULES) byPattern.set(r.pattern, [...(byPattern.get(r.pattern) ?? []), r.method])
  return [...byPattern.entries()].map(([pattern, methods]) => `${methods.join(', ')} ${pattern}`).join(' · ')
}

function notAllowed(method: PlatformMethod, shown: string, pattern: string | null): ToolError {
  const here = pattern ? ALLOW_RULES.filter(r => r.pattern === pattern).map(r => r.method) : []
  const onThisRoute = here.length > 0 ? ` En esa ruta solo acepta: ${here.join(', ')}.` : ''
  return new ToolError(
    `platform_request no puede hacer ${method} ${shown}.${onThisRoute} Lo que puede llamar: ${allowedSummary()}. Antes de usarla, mira si hay una herramienta propia para lo que quieres hacer.`,
  )
}

// ============ Body limits ============

/** Throws ToolError when a body breaks the limits. */
export function checkBodyLimits(body: unknown): void {
  if (body === undefined) return
  let text: string | undefined
  try {
    text = JSON.stringify(body)
  } catch {
    throw new ToolError('El body debe ser JSON.')
  }
  if (typeof text !== 'string') throw new ToolError('El body debe ser JSON.')
  if (Buffer.byteLength(text, 'utf8') > GENERIC_MAX_BODY_BYTES) throw new ToolError(`El body no puede pasar de ${GENERIC_MAX_BODY_BYTES / 1024} KB.`)
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== 'object') return
    if (depth >= GENERIC_MAX_BODY_DEPTH) throw new ToolError(`El body no puede tener más de ${GENERIC_MAX_BODY_DEPTH} niveles.`)
    if (Array.isArray(v)) {
      if (v.length > GENERIC_MAX_ARRAY_ITEMS) throw new ToolError(`Ninguna lista del body puede tener más de ${GENERIC_MAX_ARRAY_ITEMS} elementos.`)
      for (const item of v) walk(item, depth + 1)
      return
    }
    for (const child of Object.values(v as Record<string, unknown>)) walk(child, depth + 1)
  }
  walk(body, 0)
}

// ============ Preparing a request ============

const queryValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])

/** The tool's own input (write-tool adds confirmToken, actionId, includeContact, includeEconomics). */
export const PLATFORM_REQUEST_INPUT = {
  method: z.string().min(1).max(10).describe('GET, POST, PUT, PATCH or DELETE.'),
  path: z
    .string()
    .min(1)
    .max(512)
    .describe('The platform route with its ids filled in and NO query string, e.g. /api/campaigns/ck123/stories. Only routes of the allow list.'),
  query: z.record(z.string(), queryValue).optional().describe('Query parameters as scalars, e.g. { "campaignId": "ck123" }. Keys that carry credentials are refused.'),
  body: z.unknown().optional().describe('JSON body for POST, PUT, PATCH and the few DELETEs that take one. At most 64 KB, 8 levels, 200 elements per list.'),
  select: z
    .array(z.string().max(200))
    .max(30)
    .optional()
    .describe('Optional dot paths to keep from the answer, e.g. ["campaign.name", "campaign.influencers.status"]. Arrays are walked through.'),
}

export type PlatformRequestArgs = z.infer<z.ZodObject<typeof PLATFORM_REQUEST_INPUT>>

export interface PreparedRequest {
  rule: AllowRule
  /** As the model asked. */
  original: GenericRequest
  /** What is sent, after the forced values. */
  send: GenericRequest
  /** A note per forced value. */
  forced: string[]
  confirmation: GenericClass
  timeoutMs: number
  select: string[]
}

/**
 * Validates a request of the model against the allow table and returns what
 * will be sent and its confirmation class. Pure (no I/O). Throws ToolError
 * (with the reason) for anything platform_request does not do.
 */
export function prepareGenericRequest(args: PlatformRequestArgs): PreparedRequest {
  const method = args.method as PlatformMethod
  if (!GENERIC_METHODS.includes(method)) {
    throw new ToolError(`Método no permitido. platform_request acepta ${GENERIC_METHODS.join(', ')}.`)
  }

  let pattern: string
  let params: Record<string, string>
  try {
    const match = resolvePlatformPath(args.path)
    pattern = match.pattern
    params = match.params
  } catch (err) {
    if (err instanceof PlatformRequestError && (err.reason === 'forbidden' || err.reason === 'unknown_route')) {
      const reason = denyReason(method, args.path)
      if (reason) throw new ToolError(reason)
      throw notAllowed(method, args.path, null)
    }
    throw err
  }

  const rule = findRule(method, pattern)
  if (!rule) {
    const owner = curatedOwner(method, pattern)
    if (owner) {
      throw new ToolError(
        `Este cambio tiene su herramienta propia: usa ${owner.join(' o ')}. platform_request no hace escrituras que tienen herramienta, para que no se salten sus comprobaciones ni su confirmación.`,
      )
    }
    const reason = denyReason(method, args.path)
    if (reason) throw new ToolError(reason)
    throw notAllowed(method, pattern, pattern)
  }

  const query: Record<string, Scalar> = { ...(args.query ?? {}) }
  if (method === 'GET' && args.body !== undefined) throw new ToolError('Un GET no lleva body: pasa los parámetros en query.')
  checkBodyLimits(args.body)

  const select = args.select ?? []
  const badSelect = select.find(s => !SELECT_RE.test(s))
  if (badSelect !== undefined) throw new ToolError('Cada ruta de select son nombres separados por puntos, como campaign.name.')

  const original: GenericRequest = { method, path: args.path, pattern, params, query, body: args.body }
  const refusal = rule.refuse?.(original) ?? null
  if (refusal) throw new ToolError(refusal)
  // Same rule as the platform client, checked before any preview reads anything
  const exceptions = queryKeyExceptions(method, pattern)
  for (const [key, value] of Object.entries(query)) {
    const allowed = Object.prototype.hasOwnProperty.call(exceptions, key) ? exceptions[key] : undefined
    if (allowed && typeof value === 'string' && allowed.test(value)) continue
    if (CREDENTIAL_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) {
      throw new ToolError('Los parámetros que llevan credenciales (secret, token, apiKey, password, key) no se aceptan.')
    }
  }
  const forced = rule.force ? rule.force(original) : { req: original, notes: [] }
  checkBodyLimits(forced.req.body)
  const confirmation = rule.classify ? rule.classify(forced.req) : 'none'
  if (confirmation !== 'none' && !rule.preview) {
    // A confirmable route without a preview is refused (never confirmed blind)
    throw new ToolError('Esta llamada necesita confirmación y no tiene vista previa preparada, así que no se hace.')
  }
  return {
    rule,
    original,
    send: forced.req,
    forced: forced.notes,
    confirmation,
    timeoutMs: rule.long ? GENERIC_LONG_TIMEOUT_MS : GENERIC_TIMEOUT_MS,
    select,
  }
}

// ============ Shaping the answer ============

/** Keeps only the dot paths of `paths` (arrays are walked through). */
export function selectPaths(value: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return value
  const split = paths.map(p => p.split('.'))
  const walk = (v: unknown, rest: string[][]): unknown => {
    if (Array.isArray(v)) return v.map(item => walk(item, rest))
    if (!isPlainObject(v)) return v
    const out: Record<string, unknown> = {}
    const byKey = new Map<string, string[][]>()
    for (const p of rest) byKey.set(p[0], [...(byKey.get(p[0]) ?? []), p.slice(1)])
    for (const [key, tails] of byKey) {
      if (!Object.prototype.hasOwnProperty.call(v, key)) continue
      out[key] = tails.some(t => t.length === 0) ? v[key] : walk(v[key], tails)
    }
    return out
  }
  return walk(value, split)
}

const ECONOMICS_REMOVED_NOTE =
  'Money figures (fees, costs, CPM, EMV, budgets, prices) were removed. Call again with includeEconomics: true only if the person asks for them.'

export interface ShapeOptions {
  includeContact: boolean
  includeEconomics: boolean
  select?: readonly string[]
  maxStringChars?: number
  /** The call changed something: the notes never say "call again" (it would change it again). */
  afterWrite?: boolean
}

/**
 * The answer of platform_request: the deny-by-key filter of the write layer
 * (secrets always, contact data and money unless asked, images and snapshots
 * dropped), then `select`, then the generic limits (arrays of 50 with
 * `_truncated`, strings of 1,000, at most 30,000 characters). The write
 * helper filters it again on its way out: what is removed here stays removed.
 */
export function shapeGenericAnswer(fields: Record<string, unknown>, options: ShapeOptions): Record<string, unknown> {
  const filtered = filterOutput(fields, {
    includeContact: options.includeContact,
    includeEconomics: options.includeEconomics,
    dropKeys: GENERIC_DROP_KEYS,
  })
  const value = isPlainObject(filtered.value) ? { ...filtered.value } : { data: filtered.value }
  if (options.select && options.select.length > 0 && 'data' in value) value.data = selectPaths(value.data, options.select)
  const trimmed = trimOutput(value, {
    maxChars: GENERIC_OUTPUT_MAX_CHARS,
    maxArrayItems: GENERIC_OUTPUT_MAX_ARRAY,
    maxStringChars: options.maxStringChars ?? GENERIC_OUTPUT_MAX_STRING,
  })
  const out: Record<string, unknown> = isPlainObject(trimmed.value) ? { ...trimmed.value } : { data: trimmed.value }
  const notes: string[] = []
  if (trimmed.report.arrays.length > 0) {
    out._truncated = trimmed.report.arrays.slice(0, 20).map(c => ({ path: c.path, total: c.total, returned: c.returned }))
    notes.push('Some lists were cut (see _truncated): page or filter with the query parameters of the route, or use select, to see the rest.')
  }
  if (trimmed.report.stringsCut > 0) notes.push(`${trimmed.report.stringsCut} long texts were shortened.`)
  if (trimmed.report.partial) notes.push('The answer was too large: only its beginning is returned, as text. Use select or filters.')
  if (filtered.report.economicsRemoved) notes.push(options.afterWrite ? ECONOMICS_NOTE_AFTER_WRITE : ECONOMICS_REMOVED_NOTE)
  if (notes.length > 0) out._notes = notes
  return out
}

// ============ The tool ============

const DESCRIPTION = [
  'LAST RESORT: calls one route of the TKOC Intelligence platform directly, as the administrator who connected Claude. Use a curated tool first whenever one exists; this tool refuses every write that has its own tool and tells you which one.',
  'It only calls the routes of its allow list (reads of campaigns, pipeline, creators, lists, contacts, brands, templates, notifications, calendar, dashboards, the creator pool, competitors, client contacts, live-capture widgets, benchmarks, Apify status, the knowledge base and some admin jobs). Users, roles, keys, integrations, crons, seeds and the connector\'s own authorisations are out of reach for good. Unknown routes or methods are refused with the list of what exists.',
  'Pass `path` without query string (ids filled in) and the parameters in `query`. Bodies are JSON only (64 KB, 8 levels, 200 elements per list). Some values are forced (search and cache limits, JSON export, no scheduled e-mail).',
  'Every DELETE, and every change of a live-capture widget (visitors of the client website see it), waits for the person\'s approval in the platform; paid Apify reads and changes of many records at once need a confirmation in the chat. Mark notifications as read only when the person asked.',
  'Answers: compact JSON of at most 30,000 characters, lists cut to 50 items (see _truncated), long texts cut; use `select` to keep only some fields. The knowledge base comes in pages of 20,000 characters (query.offset).',
].join(' ')

/** The in-app notice of a confirmed run (proposal: each confirmed execution notifies the authorising admin). Never fails the call. */
async function notifyConfirmedExecution(ctx: WriteContext, prepared: PreparedRequest, status: number): Promise<void> {
  await createNotification({
    userId: ctx.user.id,
    type: 'mcp_action',
    title: 'Claude ha hecho un cambio que confirmaste',
    message: `Con tu confirmación, Claude ha ejecutado ${prepared.send.method} ${prepared.send.pattern} (respuesta ${status}).`,
    link: '/settings',
  })
}

/** The guarded generic tool, built with the write helper. */
export const platformRequestTool: WriteTool = defineWriteTool({
  name: PLATFORM_REQUEST_NAME,
  title: 'Llamada directa a la plataforma (último recurso)',
  description: DESCRIPTION,
  input: PLATFORM_REQUEST_INPUT,
  confirmations: ['none', 'bulk', 'money', 'destructive', 'outbound'],
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  summarize: a => {
    let route = '(invalid path)'
    let ids: string | undefined
    try {
      const match = resolvePlatformPath(a.path)
      route = match.pattern
      ids = Object.values(match.params).join(',') || undefined
    } catch (err) {
      if (err instanceof PlatformRequestError && (err.reason === 'forbidden' || err.reason === 'unknown_route')) route = a.path
    }
    const queryKeys = Object.keys(a.query ?? {}).filter(k => /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/.test(k))
    let hash: string | undefined
    try {
      hash = argsDigest(a).slice(0, 12)
    } catch {
      hash = undefined
    }
    const body = a.body === undefined ? 'none' : Array.isArray(a.body) ? `array:${a.body.length}` : isPlainObject(a.body) ? `object:${Object.keys(a.body).length}` : typeof a.body
    return {
      method: GENERIC_METHODS.includes(a.method as PlatformMethod) ? a.method : '(invalid)',
      route,
      ids,
      query: queryKeys.slice(0, 10).join(',') || undefined,
      body,
      args: hash,
    }
  },
  plan: async (a, ctx) => {
    const prepared = prepareGenericRequest(a)
    // Reads spend the read allowance (60 per minute), not the writes' (20 per minute, 300 per day)
    if (prepared.confirmation === 'none') return { confirmation: 'none', readOnly: prepared.send.method === 'GET' || prepared.rule.readOnly === true }
    // prepareGenericRequest already refuses a confirmable route without a preview: never confirmed blind
    if (!prepared.rule.preview) throw new ToolError('Esta llamada necesita confirmación y no tiene vista previa preparada, así que no se hace.')
    const preview = await prepared.rule.preview(prepared.send, ctx)
    return {
      confirmation: prepared.confirmation,
      preview: preview.text,
      ...(preview.fingerprint !== undefined ? { fingerprint: preview.fingerprint } : {}),
      ...(prepared.confirmation === 'money' ? { spend: prepared.rule.spend ?? 'optional' } : {}),
    }
  },
  execute: async (a, ctx) => {
    const prepared = prepareGenericRequest(a)
    const { rule, send } = prepared
    const extra = rule.before ? await rule.before(send, ctx) : {}
    const res = await ctx.platform({
      method: send.method,
      path: send.path,
      query: send.query,
      ...(send.body !== undefined ? { body: send.body } : {}),
      timeoutMs: prepared.timeoutMs,
    })
    if (!res.ok) throw new ToolError(describePlatformFailure(res))
    if (prepared.confirmation !== 'none') await notifyConfirmedExecution(ctx, prepared, res.status)

    const data = res.json === null ? null : rule.transform ? rule.transform(res.json, prepared.original) : res.json
    const answer = shapeGenericAnswer(
      { data, ...extra },
      {
        includeContact: ctx.includeContact,
        includeEconomics: ctx.includeEconomics,
        select: prepared.select,
        maxStringChars: rule.maxStringChars,
        afterWrite: send.method !== 'GET' && rule.readOnly !== true,
      },
    )
    return {
      status: res.status,
      route: `${send.method} ${send.pattern}`,
      ...(res.json === null ? { note: 'La plataforma ha respondido sin JSON: no se devuelve el contenido.' } : {}),
      ...(prepared.forced.length > 0 ? { forced: prepared.forced } : {}),
      ...(rule.warning ? { warning: rule.warning } : {}),
      ...answer,
    }
  },
})

// ============ Registration ============

export type { WriteToolWiring } from '../../write-tool'

/**
 * Registers platform_request on a server, wired as the write helper's
 * CONTRACT says. The write helper writes the call log line itself: the server
 * must not write a second one for this tool.
 */
export function registerPlatformRequest(server: Pick<McpServer, 'registerTool'>, wiring: WriteToolWiring): void {
  registerWriteTool(server, wiring, platformRequestTool)
}
