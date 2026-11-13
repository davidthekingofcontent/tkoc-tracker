/**
 * The platform client of the MCP connector's write layer: how a write tool
 * changes anything. It never touches the database itself. It calls the
 * platform's OWN API routes, over HTTP to this same server, as the
 * administrator who authorised the grant, so every existing guard,
 * validation, notification and rule applies exactly as in the UI.
 *
 *   callPlatform(ctx, { method, path, query?, body? }) → { status, ok, json | text, ... }
 *
 * Who: `Authorization: Bearer <platform JWT>` minted here for ctx.userId with
 * role ADMIN, signed with JWT_SECRET and valid 3 minutes. The route's own
 * getSession re-reads the user: a demoted or deactivated administrator gets a
 * 401 from the route, whatever this client signed.
 *
 * Where: `http://127.0.0.1:${PORT || 3000}` + a path that must be a KNOWN
 * route of the platform (PLATFORM_ROUTES, method by method). Never a URL from
 * the request or from the model. Refused before anything is sent:
 *  - anything that is not `/api/<segment>/...` with segments made of letters,
 *    digits, `_` and `-` (1 to 64 characters): so no absolute URL, no `//`,
 *    no `..` or `.`, no `%` (encoded slashes and dots), no backslash, no
 *    query string or fragment inside the path, no trailing slash;
 *  - the routes out of reach for good (PLATFORM_FORBIDDEN_PREFIXES): auth,
 *    users and roles, invitations of staff, secrets and integrations, crons,
 *    seeds, the connector's own OAuth and MCP routes, and the public
 *    endpoints of other people;
 *  - a method the route does not have in the table;
 *  - query keys that would carry a credential (secret, token, apiKey,
 *    password, key; except `key` with a benchmark table name on
 *    DELETE /api/settings/benchmarks, QUERY_KEY_EXCEPTIONS) and query values
 *    that are not scalars;
 *  - a body on a GET, a body that is not JSON, larger than 256 KB or deeper
 *    than 12 levels.
 *
 * Answers: JSON only is parsed (anything else comes back as text), at most
 * 4 MB is read, redirects are NEVER followed (a 3xx is returned as a failure
 * with `problem: 'redirect'`), and after 200 seconds the call is abandoned
 * with `problem: 'timeout'` (the result of the write is then UNKNOWN).
 *
 * The transport is injectable (setPlatformTransport) so the tests route each
 * call to the real route handler in-process, with no network
 * (tests/helpers/platform-router.ts).
 */
import jwt from 'jsonwebtoken'
import { ToolError } from './tools/shared'

// ============ The route table ============

export type PlatformMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export const PLATFORM_METHODS: readonly PlatformMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export interface PlatformRoute {
  /** As in src/app/api: static segments and `[param]` segments. */
  pattern: string
  methods: readonly PlatformMethod[]
}

/**
 * Every route the connector may EVER call, method by method: the routes of
 * src/app/api in this working copy (12 Nov 2026) minus those out of reach for
 * good, minus the ones that do not answer JSON (PDF, CSV, images, multipart
 * upload) and minus the writes that were excluded on purpose (the paid
 * comment scrape, the unvalidated notify-post e-mail, invented ad-usage
 * consents, AI-credit endpoints, duplicates). Default deny: a route added to
 * the platform later is unreachable until somebody adds it here
 * (tests/db/mcp-platform-client.test.ts fails until it is classified).
 *
 * This is the outer fence. Each tool narrows it further: a curated tool calls
 * its own few routes, and the generic tool applies its own allow list.
 */
export const PLATFORM_ROUTES: readonly PlatformRoute[] = [
  { pattern: '/api/admin/backfill-categories', methods: ['POST'] },
  { pattern: '/api/admin/backfill-contact-addresses', methods: ['POST'] },
  { pattern: '/api/admin/backfill-contacts', methods: ['POST'] },
  { pattern: '/api/admin/backfill-gender', methods: ['POST'] },
  { pattern: '/api/admin/benchmarks/recompute', methods: ['GET', 'POST'] },
  { pattern: '/api/admin/cache-avatars', methods: ['GET', 'POST'] },
  { pattern: '/api/admin/cache-thumbs', methods: ['GET', 'POST'] },
  { pattern: '/api/admin/enrich-views', methods: ['GET', 'POST'] },
  { pattern: '/api/admin/fanout-media', methods: ['POST'] },
  { pattern: '/api/admin/meta-status', methods: ['GET'] },
  { pattern: '/api/admin/sync-creator-pool', methods: ['POST'] },
  { pattern: '/api/apify-status', methods: ['GET'] },
  { pattern: '/api/brands', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  { pattern: '/api/calendar', methods: ['GET'] },
  { pattern: '/api/campaigns', methods: ['GET', 'POST'] },
  { pattern: '/api/campaigns/compare', methods: ['GET'] },
  { pattern: '/api/campaigns/[id]', methods: ['GET', 'PUT', 'DELETE'] },
  { pattern: '/api/campaigns/[id]/assignments', methods: ['GET', 'POST', 'DELETE'] },
  { pattern: '/api/campaigns/[id]/brief-files', methods: ['GET', 'DELETE'] },
  { pattern: '/api/campaigns/[id]/comments', methods: ['GET'] },
  { pattern: '/api/campaigns/[id]/compliance', methods: ['GET'] },
  { pattern: '/api/campaigns/[id]/duplicates', methods: ['GET'] },
  { pattern: '/api/campaigns/[id]/export', methods: ['GET'] },
  { pattern: '/api/campaigns/[id]/influencers', methods: ['POST', 'PATCH', 'DELETE'] },
  { pattern: '/api/campaigns/[id]/influencers/bulk', methods: ['POST'] },
  { pattern: '/api/campaigns/[id]/influencers/move', methods: ['POST'] },
  { pattern: '/api/campaigns/[id]/media/manual', methods: ['POST'] },
  { pattern: '/api/campaigns/[id]/media/[mediaId]', methods: ['PATCH'] },
  { pattern: '/api/campaigns/[id]/notes', methods: ['GET', 'POST'] },
  { pattern: '/api/campaigns/[id]/report-config', methods: ['GET', 'PUT', 'POST'] },
  { pattern: '/api/campaigns/[id]/revalidate-media', methods: ['POST'] },
  { pattern: '/api/campaigns/[id]/stories', methods: ['GET', 'POST'] },
  { pattern: '/api/campaigns/[id]/track', methods: ['POST'] },
  { pattern: '/api/client-contacts', methods: ['GET', 'POST'] },
  { pattern: '/api/client-contacts/import', methods: ['POST'] },
  { pattern: '/api/client-contacts/matches', methods: ['GET'] },
  { pattern: '/api/client-contacts/matches/[id]', methods: ['PATCH'] },
  { pattern: '/api/client-contacts/matches/[id]/warm-score', methods: ['GET', 'POST'] },
  { pattern: '/api/competitors', methods: ['GET', 'POST'] },
  { pattern: '/api/competitors/compare', methods: ['GET'] },
  { pattern: '/api/competitors/[id]', methods: ['GET', 'POST', 'DELETE'] },
  { pattern: '/api/contacts', methods: ['GET', 'POST', 'PATCH'] },
  { pattern: '/api/contacts/address', methods: ['GET'] },
  { pattern: '/api/creators/ad-permissions', methods: ['GET'] },
  { pattern: '/api/creators/lookalikes', methods: ['POST'] },
  { pattern: '/api/dashboard', methods: ['GET'] },
  { pattern: '/api/dashboard/brands', methods: ['GET'] },
  { pattern: '/api/discovery/batch', methods: ['POST'] },
  { pattern: '/api/discovery/creators/[id]', methods: ['GET'] },
  { pattern: '/api/discovery/search', methods: ['GET', 'POST'] },
  { pattern: '/api/hashtags/trending', methods: ['GET'] },
  { pattern: '/api/health', methods: ['GET'] },
  { pattern: '/api/influencers', methods: ['GET', 'POST'] },
  { pattern: '/api/influencers/analyze', methods: ['POST'] },
  { pattern: '/api/influencers/discover', methods: ['POST'] },
  { pattern: '/api/influencers/invite', methods: ['GET', 'POST'] },
  { pattern: '/api/influencers/[id]', methods: ['GET', 'PATCH'] },
  { pattern: '/api/influencers/[id]/gender', methods: ['PATCH'] },
  { pattern: '/api/influencers/[id]/history', methods: ['GET'] },
  { pattern: '/api/influencers/[id]/insights', methods: ['GET'] },
  { pattern: '/api/influencers/[id]/lookalikes', methods: ['GET'] },
  { pattern: '/api/influencers/[id]/optimal-times', methods: ['GET'] },
  { pattern: '/api/intelligence', methods: ['POST'] },
  { pattern: '/api/knowledge-base', methods: ['GET'] },
  { pattern: '/api/lists', methods: ['GET', 'POST'] },
  { pattern: '/api/lists/[id]', methods: ['GET', 'POST', 'PUT', 'DELETE'] },
  { pattern: '/api/live-capture/enrich', methods: ['POST'] },
  { pattern: '/api/live-capture/stats', methods: ['GET'] },
  { pattern: '/api/live-capture/widgets', methods: ['GET', 'POST'] },
  { pattern: '/api/live-capture/widgets/[id]', methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: '/api/meta/connections', methods: ['GET'] },
  { pattern: '/api/meta/connections/[id]', methods: ['GET'] },
  { pattern: '/api/meta/sync/[connectionId]', methods: ['POST'] },
  { pattern: '/api/notifications', methods: ['GET', 'PATCH'] },
  { pattern: '/api/pipeline', methods: ['GET'] },
  { pattern: '/api/pipeline/[id]', methods: ['PATCH'] },
  { pattern: '/api/portal/campaigns/[id]', methods: ['GET'] },
  { pattern: '/api/portal/campaigns/[id]/report-config', methods: ['GET'] },
  { pattern: '/api/portal/overview', methods: ['GET'] },
  { pattern: '/api/pricing/analyze', methods: ['POST'] },
  { pattern: '/api/reports/scheduled', methods: ['POST'] },
  { pattern: '/api/settings', methods: ['GET'] },
  { pattern: '/api/settings/benchmarks', methods: ['GET', 'PUT', 'DELETE'] },
  { pattern: '/api/templates', methods: ['GET', 'POST'] },
  { pattern: '/api/templates/[id]', methods: ['DELETE'] },
]

/**
 * Out of reach for good, whatever any table says (checked BEFORE the route
 * table, segment by segment). Claude reads text written by third parties
 * (captions, bios); an instruction planted there must never be able to
 * create an administrator, leak a key or extend its own authorisation.
 */
export const PLATFORM_FORBIDDEN_PREFIXES: readonly string[] = [
  '/api/auth', // passwords, sessions, Meta and YouTube connection flows
  '/api/team', // users, roles, staff invitations, brand-user assignments
  '/api/invite', // account creation of an invited person (the token is their credential)
  '/api/influencers/invite/accept',
  '/api/influencers/invite/validate',
  '/api/settings/integrations', // Apify and YouTube keys in clear, provider credentials
  '/api/admin/meta-subscribe', // webhook subscriptions with page tokens
  '/api/meta/webhooks',
  '/api/brand-connect', // non-revocable connection links
  '/api/cron', // scheduler-only, behind the cron secret
  '/api/seed',
  '/api/discovery/seed',
  '/api/oauth', // the connector's own authorisations
  '/api/mcp', // the connector's own transport and its pending-action decisions
  '/api/data-deletion', // public RGPD and Meta endpoint
  '/api/live-capture/collect', // public widget endpoints on client websites
  '/api/live-capture/widget-config',
  '/api/admin/cleanup-auto-added', // disabled on purpose
  '/api/admin/person-merge', // merging and un-merging creators' records: an ADMIN in the platform only, never through the connector
  '/api/dashboard/creator', // creator-only view
  '/api/proxy', // binary image relays
  '/api/ai', // a second assistant that spends AI credit
]

// ============ Limits ============

/** Lifetime of the platform JWT minted for one call. */
export const PLATFORM_JWT_TTL_SECONDS = 180
/** A call is abandoned after this long (a tool call times out at 240 s in Claude). */
export const PLATFORM_TIMEOUT_MS = 200_000
export const PLATFORM_MAX_BODY_BYTES = 256 * 1024
export const PLATFORM_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_PATH_CHARS = 512
const MAX_BODY_DEPTH = 12
const MAX_QUERY_KEYS = 30
const MAX_QUERY_VALUE_CHARS = 1000
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/
const QUERY_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,40}$/
const FORBIDDEN_QUERY_KEYS = new Set(['secret', 'token', 'apikey', 'password', 'key', 'accesstoken', 'refreshtoken'])

/**
 * Query keys that look like a credential but are a plain name on ONE method of
 * ONE route (`METHOD /pattern`), with the only values it may receive.
 * DELETE /api/settings/benchmarks takes the benchmark table to delete in `key`
 * (benchmark_fee_ranges, ..., or all). Exact key name, exact method and
 * pattern, value checked: nothing else is let through.
 */
export const QUERY_KEY_EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'DELETE /api/settings/benchmarks': { key: /^(?:all|benchmark_[a-z_]{1,40})$/ },
}

/** The query keys of QUERY_KEY_EXCEPTIONS for one method and route pattern. */
export function queryKeyExceptions(method: PlatformMethod, pattern: string): Readonly<Record<string, RegExp>> {
  const id = `${method} ${pattern}`
  return Object.prototype.hasOwnProperty.call(QUERY_KEY_EXCEPTIONS, id) ? QUERY_KEY_EXCEPTIONS[id] : {}
}

// ============ Errors ============

export type PlatformRefusal =
  | 'not_a_path'
  | 'absolute_url'
  | 'traversal'
  | 'double_slash'
  | 'encoded'
  | 'query_in_path'
  | 'bad_characters'
  | 'forbidden'
  | 'unknown_route'
  | 'method_not_allowed'
  | 'bad_query'
  | 'bad_body'
  | 'no_secret'

/**
 * A request refused before anything was sent. It is a ToolError: its message
 * may be shown to the model as it is (it never contains a secret).
 */
export class PlatformRequestError extends ToolError {
  readonly reason: PlatformRefusal
  constructor(reason: PlatformRefusal, message: string) {
    super(message)
    this.name = 'PlatformRequestError'
    this.reason = reason
  }
}

// ============ Paths ============

export interface RouteMatch {
  /** The pattern of PLATFORM_ROUTES that matched, e.g. `/api/campaigns/[id]`. */
  pattern: string
  /** The values of its `[param]` segments. */
  params: Record<string, string>
  methods: readonly PlatformMethod[]
}

/** True when `path` is `prefix` or lies below it (segment-aware: `/api/seeds` is not under `/api/seed`). */
function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/')
}

/** Matches a path against one pattern: static segments exactly, `[param]` segments as ids. */
function matchPattern(pattern: string, segments: readonly string[]): Record<string, string> | null {
  const parts = pattern.split('/').slice(1)
  if (parts.length !== segments.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const dyn = /^\[([A-Za-z]+)\]$/.exec(p)
    if (dyn) params[dyn[1]] = segments[i]
    else if (p !== segments[i]) return null
  }
  return params
}

/**
 * Validates the shape of a path and finds its route. Throws
 * PlatformRequestError for anything that is not exactly a known route of the
 * table. When several patterns match, the one with more static segments wins
 * (`/api/campaigns/compare` before `/api/campaigns/[id]`).
 */
export function resolvePlatformPath(path: unknown): RouteMatch {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARS) {
    throw new PlatformRequestError('not_a_path', 'The path must be a platform route such as /api/campaigns/<id>.')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.includes('://')) {
    throw new PlatformRequestError('absolute_url', 'Absolute URLs are refused: give only the path of a platform route, starting with /api/.')
  }
  if (path.startsWith('//')) {
    throw new PlatformRequestError('double_slash', 'A path starting with // is refused.')
  }
  if (path.includes('\\')) throw new PlatformRequestError('bad_characters', 'Backslashes are refused in the path.')
  if (path.includes('%')) {
    throw new PlatformRequestError('encoded', 'Encoded characters (%2F, %2E and the like) are refused in the path.')
  }
  if (path.includes('?') || path.includes('#')) {
    throw new PlatformRequestError('query_in_path', 'The path must not carry a query string or a fragment: pass the parameters in `query`.')
  }
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || path.includes('..')) {
    throw new PlatformRequestError('traversal', 'Dot segments (. and ..) are refused in the path.')
  }
  if (path.includes('//')) throw new PlatformRequestError('double_slash', 'Empty segments (//) are refused in the path.')
  if (!path.startsWith('/api/')) {
    throw new PlatformRequestError('not_a_path', 'Only platform API routes can be called: the path must start with /api/.')
  }
  const segments = path.split('/').slice(1)
  if (!segments.every(s => SEGMENT_RE.test(s))) {
    throw new PlatformRequestError('bad_characters', 'Each segment of the path must be 1 to 64 letters, digits, _ or -.')
  }
  if (PLATFORM_FORBIDDEN_PREFIXES.some(p => isUnder(path, p))) {
    throw new PlatformRequestError('forbidden', 'This part of the platform is out of reach of the connector (users, roles, keys, integrations, its own authorisations, crons and seeds).')
  }

  let best: RouteMatch | null = null
  let bestStatic = -1
  for (const route of PLATFORM_ROUTES) {
    const params = matchPattern(route.pattern, segments)
    if (!params) continue
    const staticCount = route.pattern.split('/').filter(p => p && !p.startsWith('[')).length
    if (staticCount > bestStatic) {
      best = { pattern: route.pattern, params, methods: route.methods }
      bestStatic = staticCount
    }
  }
  if (!best) throw new PlatformRequestError('unknown_route', 'Unknown platform route.')
  return best
}

// ============ Query and body ============

type QueryValue = string | number | boolean | null | undefined

function buildQuery(query: unknown, exceptions: Readonly<Record<string, RegExp>>): string {
  if (query === undefined || query === null) return ''
  if (typeof query !== 'object' || Array.isArray(query)) {
    throw new PlatformRequestError('bad_query', 'The query must be an object of names and scalar values.')
  }
  const entries = Object.entries(query as Record<string, unknown>)
  if (entries.length > MAX_QUERY_KEYS) throw new PlatformRequestError('bad_query', `At most ${MAX_QUERY_KEYS} query parameters.`)
  const params = new URLSearchParams()
  for (const [key, raw] of entries) {
    if (!QUERY_KEY_RE.test(key)) throw new PlatformRequestError('bad_query', 'Query parameter names are letters, digits, _, . or -.')
    if (FORBIDDEN_QUERY_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ''))) {
      const allowed = Object.prototype.hasOwnProperty.call(exceptions, key) ? exceptions[key] : undefined
      if (!allowed || typeof raw !== 'string' || !allowed.test(raw)) {
        throw new PlatformRequestError('bad_query', 'Query parameters that carry credentials (secret, token, apiKey, password, key) are refused.')
      }
    }
    const value = raw as QueryValue
    if (value === undefined || value === null) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new PlatformRequestError('bad_query', 'Query numbers must be finite.')
      params.append(key, String(value))
    } else if (typeof value === 'boolean') {
      params.append(key, value ? 'true' : 'false')
    } else if (typeof value === 'string') {
      if (value.length > MAX_QUERY_VALUE_CHARS) throw new PlatformRequestError('bad_query', `Query values are limited to ${MAX_QUERY_VALUE_CHARS} characters.`)
      params.append(key, value)
    } else {
      throw new PlatformRequestError('bad_query', 'Query values must be text, numbers or booleans.')
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_BODY_DEPTH) return depth
  if (Array.isArray(value)) return value.reduce<number>((max, v) => Math.max(max, depthOf(v, depth + 1)), depth + 1)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>((max, v) => Math.max(max, depthOf(v, depth + 1)), depth + 1)
  }
  return depth
}

function serializeBody(method: PlatformMethod, body: unknown): string | null {
  if (body === undefined) return null
  if (method === 'GET') throw new PlatformRequestError('bad_body', 'A GET carries no body.')
  let text: string | undefined
  try {
    text = JSON.stringify(body)
  } catch {
    throw new PlatformRequestError('bad_body', 'The body must be JSON.')
  }
  if (typeof text !== 'string') throw new PlatformRequestError('bad_body', 'The body must be JSON.')
  if (Buffer.byteLength(text, 'utf8') > PLATFORM_MAX_BODY_BYTES) {
    throw new PlatformRequestError('bad_body', `The body is limited to ${PLATFORM_MAX_BODY_BYTES / 1024} KB.`)
  }
  if (depthOf(body) > MAX_BODY_DEPTH) throw new PlatformRequestError('bad_body', `The body is limited to ${MAX_BODY_DEPTH} levels of nesting.`)
  return text
}

// ============ Who and where ============

/** Who a platform call acts for: the administrator of the grant (already checked live by the caller). */
export interface PlatformContext {
  userId: string
  grantId: string
}

/**
 * A platform session JWT for this administrator, valid 3 minutes. Same shape
 * as the platform's own (src/lib/auth.ts generateToken: userId and role),
 * plus the grant it was minted for. The role claim is ADMIN: if the user is
 * no longer an ADMIN in the database, getSession refuses the token.
 */
export function mintPlatformToken(ctx: PlatformContext): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new PlatformRequestError('no_secret', 'The connector cannot sign its calls (JWT_SECRET is not set).')
  return jwt.sign({ userId: ctx.userId, role: 'ADMIN', mcpGrantId: ctx.grantId }, secret, { expiresIn: PLATFORM_JWT_TTL_SECONDS })
}

/** `http://127.0.0.1:<PORT>`: this same server. Never from a request. */
export function platformBaseUrl(): string {
  const raw = (process.env.PORT || '').trim()
  const port = /^\d{1,5}$/.test(raw) && Number(raw) > 0 && Number(raw) < 65536 ? Number(raw) : 3000
  return `http://127.0.0.1:${port}`
}

// ============ Transport ============

/** Sends one request and returns the answer as it came. Must not follow redirects. */
export type PlatformTransport = (request: Request) => Promise<Response>

const fetchTransport: PlatformTransport = request => fetch(request)
let transport: PlatformTransport = fetchTransport

/**
 * Replaces how requests are sent (tests: an in-process router to the real
 * route handlers). `null` restores the real HTTP transport.
 */
export function setPlatformTransport(fn: PlatformTransport | null): void {
  transport = fn ?? fetchTransport
}

// ============ The call ============

export interface PlatformRequest {
  method: PlatformMethod
  /** A path of PLATFORM_ROUTES with its ids filled in, without query: `/api/campaigns/abc123/influencers`. */
  path: string
  /** Scalar query parameters. */
  query?: Record<string, QueryValue>
  /** JSON body (not on GET). */
  body?: unknown
  /** Shorter timeout than PLATFORM_TIMEOUT_MS, in milliseconds. */
  timeoutMs?: number
}

export type PlatformProblem = 'timeout' | 'redirect' | 'too_large' | 'network'

export interface PlatformResponse {
  /** The pattern that matched, for logs and allow lists: `/api/campaigns/[id]`. */
  route: string
  /** HTTP status; 0 when no answer arrived (timeout, network). */
  status: number
  /** 2xx and no local problem. */
  ok: boolean
  /** The parsed body when it was JSON, else null. */
  json: unknown
  /** The body when it was not JSON (capped), else null. */
  text: string | null
  /** Something on our side: a timeout (result UNKNOWN), a redirect not followed, an answer too large, no connection. */
  problem: PlatformProblem | null
}

async function readCapped(response: Response): Promise<string | null> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > PLATFORM_MAX_RESPONSE_BYTES) return null
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PLATFORM_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Calls one platform route as the grant's administrator. Throws
 * PlatformRequestError (nothing sent) when the request is not acceptable;
 * otherwise always resolves, also for 4xx/5xx, timeouts and redirects: look
 * at `ok`, `status` and `problem`. A redirect is never followed.
 */
export async function callPlatform(ctx: PlatformContext, req: PlatformRequest): Promise<PlatformResponse> {
  const method = req.method
  if (!PLATFORM_METHODS.includes(method)) {
    throw new PlatformRequestError('method_not_allowed', `Only ${PLATFORM_METHODS.join(', ')} are possible.`)
  }
  const match = resolvePlatformPath(req.path)
  if (!match.methods.includes(method)) {
    throw new PlatformRequestError('method_not_allowed', `${method} is not possible on ${match.pattern}. It accepts: ${match.methods.join(', ')}.`)
  }
  const search = buildQuery(req.query, queryKeyExceptions(method, match.pattern))
  const body = serializeBody(method, req.body)
  const token = mintPlatformToken(ctx)

  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': 'tkoc-mcp-connector/1.0',
  })
  if (body !== null) headers.set('content-type', 'application/json')

  const timeoutMs = Math.max(1, Math.min(PLATFORM_TIMEOUT_MS, req.timeoutMs ?? PLATFORM_TIMEOUT_MS))
  const controller = new AbortController()
  const request = new Request(`${platformBaseUrl()}${req.path}${search}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: controller.signal,
  })

  const base = { route: match.pattern }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    let response: Response | 'timeout'
    try {
      response = await Promise.race([transport(request), timedOut])
    } catch {
      return { ...base, status: 0, ok: false, json: null, text: null, problem: 'network' }
    }
    if (response === 'timeout') {
      controller.abort()
      return { ...base, status: 0, ok: false, json: null, text: null, problem: 'timeout' }
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      return { ...base, status: response.status, ok: false, json: null, text: null, problem: 'redirect' }
    }
    const raw = await Promise.race([readCapped(response), timedOut])
    if (raw === 'timeout') {
      controller.abort()
      return { ...base, status: response.status, ok: false, json: null, text: null, problem: 'timeout' }
    }
    if (raw === null) return { ...base, status: response.status, ok: false, json: null, text: null, problem: 'too_large' }
    const ok = response.status >= 200 && response.status < 300
    const isJson = /^application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') || '')
    if (isJson && raw.length > 0) {
      try {
        return { ...base, status: response.status, ok, json: JSON.parse(raw) as unknown, text: null, problem: null }
      } catch {
        // Declared JSON that is not: hand it back as text
      }
    }
    return { ...base, status: response.status, ok, json: null, text: raw, problem: null }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * One sentence about a call that did not work, for the model to relay: the
 * route's own error message (first 500 characters) or what happened on our
 * side. Never a stack trace, never a raw 5xx page.
 */
export function describePlatformFailure(res: PlatformResponse): string {
  if (res.problem === 'timeout') {
    return 'Resultado desconocido: la plataforma no respondió a tiempo. Comprueba el estado con una lectura antes de repetir.'
  }
  if (res.problem === 'redirect') return `La plataforma respondió con una redirección (${res.status}), que no se sigue. No se ha hecho nada más.`
  if (res.problem === 'too_large') return 'La respuesta de la plataforma era demasiado grande para leerla.'
  if (res.problem === 'network') return 'No se ha podido contactar con la plataforma. Inténtalo de nuevo en un momento.'
  if (res.status >= 500) return `La plataforma ha fallado (${res.status}). Inténtalo de nuevo en un momento.`
  const json = res.json as { error?: unknown; message?: unknown } | null
  const said = typeof json?.error === 'string' ? json.error : typeof json?.message === 'string' ? json.message : null
  const clean = said ? said.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  return clean ? `La plataforma ha respondido ${res.status}: ${clean}` : `La plataforma ha respondido ${res.status}.`
}
