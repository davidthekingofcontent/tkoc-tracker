/**
 * Storage and protocol core of the OAuth 2.1 server that protects the MCP
 * connector for Claude. The route handlers stay thin: they parse the request,
 * call ONE function of this file and turn its result (or its OAuthError) into
 * a response.
 *
 *   POST /api/oauth/register      registerClient(body, clientIp(headers))
 *   GET  /oauth/authorize         checkAdminSession(cookie) + validateAuthorizeRequest(searchParams)
 *                                 + signConsentToken (./crypto) for the form
 *   POST /api/oauth/authorize     checkAdminSession(cookie) + verifyConsentToken (./crypto)
 *                                 + createGrantAndCode(fields) + buildAuthorizeRedirect(...)
 *   POST /api/oauth/token         handleTokenRequest(form)   (exchangeCode / refresh)
 *   POST /api/oauth/revoke        revokeToken(form)
 *   POST /api/mcp                 authenticateBearer(header) + allowRequest(grant.id); each tool
 *                                 call then spends allowCall(grant.id) (src/lib/mcp/server.ts)
 *   GET/DELETE /api/oauth/grants  listGrants() / revokeGrant(id, reason)
 *
 * Rules that hold everywhere in this file:
 *  - deny by default: every check that does not pass ends the request;
 *  - a code or a token is never stored, logged or compared in clear: only its
 *    SHA-256 reaches the database, and lookups go through that hash;
 *  - only an ACTIVE ADMIN can own a working grant. The role is re-read from
 *    the database on every use: a demoted or deactivated administrator loses
 *    access at once, and the grant is revoked so it cannot come back by itself;
 *  - URLs come from ./config, never from the request.
 */
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth'
import { canProceed } from '@/lib/rate-limiter'
import type { Prisma } from '@/generated/prisma/client'
import {
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  CALL_RATE_LIMIT,
  CLAUDE_CALLBACKS,
  CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT,
  CLIENT_NAME_MAX_CHARS,
  CODE_TTL_MS,
  ISSUER,
  LAST_USED_WRITE_INTERVAL_MS,
  MAX_CLIENTS,
  MAX_REDIRECT_URIS,
  MCP_GRANT_SCOPE,
  MCP_RESOURCE,
  MCP_SCOPE,
  MCP_SCOPES,
  REFRESH_REUSE_LEEWAY_MS,
  REFRESH_TOKEN_TTL_MS,
  REGISTRATION_RATE_LIMIT,
  REQUEST_RATE_LIMIT,
  STATE_MAX_CHARS,
  UNUSED_CLIENT_MAX_AGE_MS,
  WWW_AUTHENTICATE_BEARER,
  isAllowedRedirectUri,
  isClaudeEgressAddress,
  redirectUriMatches,
} from './config'
import { isValidCodeChallenge, looksLikeSecret, randomSecret, sha256Hex, verifyPkceS256 } from './crypto'

// ============ Errors ============

/**
 * Error codes of RFC 6749 (§4.1.2.1 and §5.2), plus `invalid_target`
 * (RFC 8707) and the two of dynamic registration (RFC 7591 §3.2.2).
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'invalid_target'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'

/**
 * Every protocol failure of this file. `code` is the OAuth error code,
 * `status` the HTTP status the route must answer with (400 unless stated),
 * `body` the JSON of RFC 6749 §5.2. The description never contains a secret.
 */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode
  readonly description: string
  readonly status: number

  constructor(code: OAuthErrorCode, description: string, status = 400) {
    super(`${code}: ${description}`)
    this.name = 'OAuthError'
    this.code = code
    this.description = description
    this.status = status
  }

  /** `{ error, error_description }`, ready for NextResponse.json(body, { status }). */
  get body(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description }
  }
}

/** Type guard for a catch block. */
export function isOAuthError(e: unknown): e is OAuthError {
  return e instanceof OAuthError
}

// ============ Request parameters ============

/** Where the parameters of a request come from: a query string, a form body or a plain object (Next `searchParams`). */
export type ParamSource = URLSearchParams | FormData | Record<string, unknown>

const INVALID = Symbol('invalid parameter')

/**
 * One parameter: its value, null when absent or empty (RFC 6749 §3.1: an
 * empty parameter is an omitted one), INVALID when repeated or not a string.
 */
function readParam(src: ParamSource, name: string): string | null | typeof INVALID {
  let values: unknown[]
  if (src instanceof URLSearchParams) {
    values = src.getAll(name)
  } else if (typeof FormData !== 'undefined' && src instanceof FormData) {
    values = src.getAll(name)
  } else {
    const v = Object.prototype.hasOwnProperty.call(src, name) ? (src as Record<string, unknown>)[name] : undefined
    values = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]
  }
  if (values.length === 0) return null
  if (values.length > 1) return INVALID
  const v = values[0]
  if (typeof v !== 'string') return INVALID
  return v.length === 0 ? null : v
}

/** A parameter of the token or revocation endpoint: string or null; repeated → invalid_request. */
function formParam(src: ParamSource, name: string): string | null {
  const v = readParam(src, name)
  if (v === INVALID) throw new OAuthError('invalid_request', `${name} must appear once, as text`)
  return v
}

function requiredFormParam(src: ParamSource, name: string): string {
  const v = formParam(src, name)
  if (v === null) throw new OAuthError('invalid_request', `${name} is required`)
  return v
}

/**
 * `scope` absent, or a space-separated list in which every item is one of our
 * scopes (tkoc.read, tkoc.write). A new grant gets what the consent screen
 * showed: MCP_GRANT_SCOPE (one consent, both) for the screen of today, which
 * always signs it, and read only for any other consent (consentedScope). A
 * renewal keeps the grant's own.
 */
function isAcceptableScope(scope: string | null): boolean {
  if (scope === null) return true
  const items = scope.split(' ').filter(Boolean)
  return items.length > 0 && items.every(s => MCP_SCOPES.includes(s))
}

const SCOPE_ERROR = `The scopes are ${MCP_SCOPES.join(' and ')}`

/**
 * The scope a grant gets from the scope its consent carried: exactly what the
 * administrator saw. The consent screen of the write layer signs
 * MCP_GRANT_SCOPE and describes both; a consent token signed by the read-only
 * screen of before (scope tkoc.read, still valid for 10 minutes across a
 * deploy) only ever gets tkoc.read. No scope at all (a direct call, never the
 * consent route) gets MCP_GRANT_SCOPE.
 */
export function consentedScope(scope: string | null | undefined): string {
  if (scope == null || scope === MCP_GRANT_SCOPE) return MCP_GRANT_SCOPE
  return MCP_SCOPE
}

// ============ The administrator ============

type AdminState =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: 'user_missing' | 'user_inactive' | 'user_not_admin' }

/** Re-reads the user from the database: only an active ADMIN passes. */
async function adminState(userId: string): Promise<AdminState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, isActive: true },
  })
  if (!user) return { ok: false, reason: 'user_missing' }
  if (!user.isActive) return { ok: false, reason: 'user_inactive' }
  if (user.role !== 'ADMIN') return { ok: false, reason: 'user_not_admin' }
  return { ok: true, id: user.id, name: user.name }
}

/** Result of checkAdminSession. */
export type SessionCheck =
  /** Signed in, active and ADMIN in the database: may see the consent screen and decide. */
  | { status: 'admin'; user: { id: string; name: string } }
  /** Signed in and active, but not an administrator (EMPLOYEE, BRAND, CREATOR). */
  | { status: 'forbidden'; role: string }
  /** No session: no cookie, bad signature, expired, deactivated account or stale role claim. */
  | { status: 'anonymous' }

/**
 * Who is behind a session JWT (the value of the `token` cookie). For the
 * consent page (a server component, which has no NextRequest) and for the
 * decision route. The claim alone is never enough: the user is re-read from
 * the database, must be active, and the role of the token must still be the
 * role in the database (same rule as getSession in src/lib/auth.ts).
 */
export async function checkAdminSession(sessionToken: string | null | undefined): Promise<SessionCheck> {
  if (!sessionToken) return { status: 'anonymous' }
  let payload: { userId: string; role: string }
  try {
    payload = verifyToken(sessionToken)
  } catch {
    return { status: 'anonymous' }
  }
  if (typeof payload.userId !== 'string' || !payload.userId) return { status: 'anonymous' }
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, name: true, role: true, isActive: true },
  })
  if (!user || !user.isActive || user.role !== payload.role) return { status: 'anonymous' }
  if (user.role !== 'ADMIN') return { status: 'forbidden', role: user.role }
  return { status: 'admin', user: { id: user.id, name: user.name } }
}

// ============ Dynamic client registration (RFC 7591) ============

/** What we keep of a registration request. */
export interface ClientRegistration {
  name: string
  redirectUris: string[]
}

/** The JSON a successful registration answers with (HTTP 201). */
export interface RegisteredClient {
  client_id: string
  client_id_issued_at: number
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  scope: string
}

const GRANT_TYPES = ['authorization_code', 'refresh_token']
const RESPONSE_TYPES = ['code']
/** Name of a client that registers without one. Shown on the consent screen and in Ajustes. */
const DEFAULT_CLIENT_NAME = 'Cliente MCP'

function isSubset(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && allowed.includes(v))
}

/**
 * Validates the JSON body of a registration (pure, no database). Public
 * clients only; `grant_types` ⊆ {authorization_code, refresh_token};
 * `response_types` ⊆ {code}; every redirect URI is one of Claude's two
 * callbacks or a loopback URL. A requested `scope` is ignored (the client is
 * always registered for MCP_GRANT_SCOPE). Throws OAuthError `invalid_redirect_uri`
 * or `invalid_client_metadata`. The name is plain text: escape it when shown.
 */
export function parseClientRegistration(input: unknown): ClientRegistration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OAuthError('invalid_client_metadata', 'The body must be a JSON object')
  }
  const body = input as Record<string, unknown>
  const given = (key: string): unknown => (body[key] === null ? undefined : body[key])

  const uris = given('redirect_uris')
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required')
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect URIs`)
  }
  const redirectUris: string[] = []
  for (const uri of uris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new OAuthError('invalid_redirect_uri', 'Only the Claude callbacks and loopback URLs (localhost, 127.0.0.1) can be registered')
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri)
  }

  const method = given('token_endpoint_auth_method')
  if (method !== undefined && method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'Only public clients are accepted: token_endpoint_auth_method must be "none"')
  }
  const grantTypes = given('grant_types')
  if (grantTypes !== undefined && !isSubset(grantTypes, GRANT_TYPES)) {
    throw new OAuthError('invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token')
  }
  const responseTypes = given('response_types')
  if (responseTypes !== undefined && !isSubset(responseTypes, RESPONSE_TYPES)) {
    throw new OAuthError('invalid_client_metadata', 'response_types may only contain code')
  }
  // The scope a client asks for at registration grants nothing: every grant is
  // MCP_GRANT_SCOPE (createGrantAndCode), the answer says so, and the scope is
  // checked strictly where it matters, at /oauth/authorize and at renewal.
  // RFC 7591 §2 lets the server replace it, so an unknown or extra value
  // (offline_access, a scope of the client's own) must not stop Claude from
  // registering. Only a value that is not text is malformed metadata.
  const scope = given('scope')
  if (scope !== undefined && typeof scope !== 'string') {
    throw new OAuthError('invalid_client_metadata', 'scope must be text')
  }

  const rawName = given('client_name')
  if (rawName !== undefined && typeof rawName !== 'string') {
    throw new OAuthError('invalid_client_metadata', 'client_name must be text')
  }
  // Control characters and the bidirectional overrides that can disguise a
  // name on the consent screen are dropped; whitespace is collapsed
  const name = (rawName ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length > CLIENT_NAME_MAX_CHARS) {
    throw new OAuthError('invalid_client_metadata', `client_name is limited to ${CLIENT_NAME_MAX_CHARS} characters`)
  }

  return { name: name || DEFAULT_CLIENT_NAME, redirectUris }
}

/**
 * Housekeeping that runs on every registration: clients older than 30 days
 * that never obtained a grant are deleted, and room is made so the table
 * never holds more than MAX_CLIENTS (the oldest unused first; a client with a
 * live grant is never evicted).
 */
async function pruneClients(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - UNUSED_CLIENT_MAX_AGE_MS)
  const old = await prisma.mcpClient.findMany({ where: { createdAt: { lt: cutoff } }, select: { clientId: true } })
  if (old.length > 0) {
    const everGranted = await prisma.mcpGrant.findMany({
      where: { clientId: { in: old.map(c => c.clientId) } },
      select: { clientId: true },
      distinct: ['clientId'],
    })
    const keep = new Set(everGranted.map(g => g.clientId))
    await deleteClients(old.map(c => c.clientId).filter(id => !keep.has(id)))
  }

  const count = await prisma.mcpClient.count()
  if (count < MAX_CLIENTS) return
  const excess = count - MAX_CLIENTS + 1
  const [clients, live] = await Promise.all([
    prisma.mcpClient.findMany({ select: { clientId: true, createdAt: true, lastUsedAt: true } }),
    prisma.mcpGrant.findMany({ where: { revokedAt: null }, select: { clientId: true }, distinct: ['clientId'] }),
  ])
  const inUse = new Set(live.map(g => g.clientId))
  // Never used first (by age), then the least recently used
  const lastSeen = (c: { createdAt: Date; lastUsedAt: Date | null }) => (c.lastUsedAt ? c.lastUsedAt.getTime() : 0)
  const candidates = clients
    .filter(c => !inUse.has(c.clientId))
    .sort((a, b) => lastSeen(a) - lastSeen(b) || a.createdAt.getTime() - b.createdAt.getTime())
  if (candidates.length < excess) {
    throw new OAuthError('temporarily_unavailable', 'Too many registered clients. Try again later.', 503)
  }
  await deleteClients(candidates.slice(0, excess).map(c => c.clientId))
}

async function deleteClients(clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return
  await prisma.$transaction([
    prisma.mcpAuthCode.deleteMany({ where: { clientId: { in: clientIds } } }),
    prisma.mcpClient.deleteMany({ where: { clientId: { in: clientIds } } }),
  ])
}

/**
 * The registration allowance a caller spends: its own (10 per hour) for any
 * address, one shared and larger allowance for Anthropic's egress range, from
 * which every claude.ai and desktop user registers (see
 * CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT in ./config).
 */
function registrationAllowance(address: string): { key: string; max: number; windowMs: number } {
  if (isClaudeEgressAddress(address)) {
    return { key: 'mcp:register:claude-egress', ...CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT }
  }
  return { key: `mcp:register:${address}`, ...REGISTRATION_RATE_LIMIT }
}

/**
 * POST /api/oauth/register. `input` is the parsed JSON body, `ip` the caller's
 * address (`clientIp(request.headers)`). Rate limited HERE (10 per hour per
 * address; Anthropic's egress range shares one allowance of 300 per hour):
 * the route must not limit again. Returns the JSON to answer with status 201.
 * Throws OAuthError: `invalid_redirect_uri` / `invalid_client_metadata`
 * (400), `temporarily_unavailable` (429 over the rate limit, 503 when the
 * table is full of clients that are in use).
 */
export async function registerClient(input: unknown, ip: string): Promise<RegisteredClient> {
  const address = (typeof ip === 'string' && ip.trim() ? ip.trim() : 'unknown').slice(0, 64)
  const allowance = registrationAllowance(address)
  if (!canProceed(allowance.key, allowance.max, allowance.windowMs)) {
    throw new OAuthError('temporarily_unavailable', 'Too many registrations from this address. Try again later.', 429)
  }
  const registration = parseClientRegistration(input)
  const now = new Date()
  await sweepExpired(now)
  await pruneClients(now)

  const client = await prisma.mcpClient.create({
    data: {
      clientId: randomSecret(),
      name: registration.name,
      redirectUris: registration.redirectUris,
      createdFromIp: address,
    },
  })
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: [...GRANT_TYPES],
    response_types: [...RESPONSE_TYPES],
    scope: MCP_GRANT_SCOPE,
  }
}

// ============ Authorization request ============

/** A validated authorization request: exactly what the consent token must bind (plus the user id). */
export interface AuthorizeRequest {
  clientId: string
  redirectUri: string
  codeChallenge: string
  /** null when the client sent no `state`. */
  state: string | null
  resource: string
  scope: string
}

export type AuthorizeValidation =
  /** Valid: show the consent screen. `client.name` is untrusted text: escape it. */
  | { ok: true; request: AuthorizeRequest; client: { clientId: string; name: string; redirectKind: 'claude' | 'loopback' } }
  /** The client or its redirect URI is not valid: show an error page and do NOT redirect anywhere. */
  | { ok: false; redirect: false; error: OAuthErrorCode; description: string }
  /** Any other problem: send the browser to `redirectTo` (the client's redirect URI with error, state and iss). */
  | { ok: false; redirect: true; error: OAuthErrorCode; description: string; redirectTo: string }

/**
 * Builds the URL the browser is sent back to: the redirect URI plus either
 * `code` or `error` (and `error_description` when given), `state` when the
 * client sent one, and always `iss` (RFC 9207). Only call it with a redirect
 * URI that validateAuthorizeRequest or a consent token vouched for.
 */
export function buildAuthorizeRedirect(
  redirectUri: string,
  outcome:
    | { code: string; state?: string | null }
    | { error: OAuthErrorCode; errorDescription?: string; state?: string | null },
): string {
  const url = new URL(redirectUri)
  if ('code' in outcome) {
    url.searchParams.set('code', outcome.code)
  } else {
    url.searchParams.set('error', outcome.error)
    if (outcome.errorDescription) url.searchParams.set('error_description', outcome.errorDescription)
  }
  if (typeof outcome.state === 'string' && outcome.state.length > 0) url.searchParams.set('state', outcome.state)
  url.searchParams.set('iss', ISSUER)
  return url.toString()
}

/**
 * GET /oauth/authorize: validates the query. Order matters: the client and
 * its redirect URI are checked first, and while either is wrong nothing is
 * ever redirected. After that every error travels back to the client.
 * Requires `response_type=code`, PKCE with `code_challenge_method=S256`,
 * `resource` absent or equal to MCP_RESOURCE, `scope` absent or made of
 * known scopes (tkoc.read, tkoc.write). The request always asks for
 * MCP_GRANT_SCOPE: one consent, both scopes.
 * It does NOT look at the session: call checkAdminSession as well.
 */
export async function validateAuthorizeRequest(params: ParamSource): Promise<AuthorizeValidation> {
  const page = (error: OAuthErrorCode, description: string): AuthorizeValidation => ({ ok: false, redirect: false, error, description })

  const clientId = readParam(params, 'client_id')
  if (typeof clientId !== 'string') return page('invalid_request', 'client_id is missing or repeated')
  if (!looksLikeSecret(clientId)) return page('invalid_client', 'Unknown client')
  const client = await prisma.mcpClient.findUnique({ where: { clientId } })
  if (!client) return page('invalid_client', 'Unknown client')

  const redirectUri = readParam(params, 'redirect_uri')
  if (typeof redirectUri !== 'string') return page('invalid_request', 'redirect_uri is missing or repeated')
  if (!redirectUriMatches(client.redirectUris, redirectUri)) {
    return page('invalid_request', 'redirect_uri does not match a registered one')
  }

  // From here on the redirect URI is trusted: errors go back to the client
  // RFC 6749 appendix A.5: state is printable ASCII. Anything else is not echoed back
  const rawState = readParam(params, 'state')
  const state = typeof rawState === 'string' && rawState.length <= STATE_MAX_CHARS && /^[ -~]+$/.test(rawState) ? rawState : null
  const back = (error: OAuthErrorCode, description: string): AuthorizeValidation => ({
    ok: false,
    redirect: true,
    error,
    description,
    redirectTo: buildAuthorizeRedirect(redirectUri, { error, errorDescription: description, state }),
  })
  if (rawState !== null && state === null) return back('invalid_request', 'state is repeated, too long or not printable ASCII')

  const responseType = readParam(params, 'response_type')
  if (typeof responseType !== 'string') return back('invalid_request', 'response_type is missing or repeated')
  if (responseType !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported')

  const codeChallenge = readParam(params, 'code_challenge')
  if (typeof codeChallenge !== 'string' || !isValidCodeChallenge(codeChallenge)) {
    return back('invalid_request', 'code_challenge is required (PKCE, S256)')
  }
  if (readParam(params, 'code_challenge_method') !== 'S256') {
    return back('invalid_request', 'code_challenge_method must be S256')
  }

  const resource = readParam(params, 'resource')
  if (resource !== null && resource !== MCP_RESOURCE) return back('invalid_target', 'Unknown resource')

  const scope = readParam(params, 'scope')
  if (scope === INVALID || !isAcceptableScope(scope)) return back('invalid_scope', SCOPE_ERROR)

  return {
    ok: true,
    request: { clientId, redirectUri, codeChallenge, state, resource: MCP_RESOURCE, scope: MCP_GRANT_SCOPE },
    client: {
      clientId,
      name: client.name,
      redirectKind: CLAUDE_CALLBACKS.includes(redirectUri) ? 'claude' : 'loopback',
    },
  }
}

// ============ Grant and code ============

/** Input of createGrantAndCode: the fields of a verified consent token. */
export interface GrantInput {
  /** The administrator of the current session (and of the consent token). */
  userId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  resource?: string | null
  scope?: string | null
}

/**
 * «Permitir»: creates the grant and its single-use authorization code in one
 * transaction and returns the code in clear ONCE (redirect with
 * buildAuthorizeRedirect(redirectUri, { code, state })). Call it only after
 * verifyConsentToken succeeded and its userId is the session's administrator.
 * Everything is checked again here: the user must be an active ADMIN
 * (`access_denied`, status 403, otherwise), the client must exist
 * (`invalid_client`) and the redirect URI must be one of its own
 * (`invalid_request`).
 */
export async function createGrantAndCode(input: GrantInput): Promise<{ grantId: string; code: string; expiresAt: Date }> {
  const admin = await adminState(input.userId)
  if (!admin.ok) throw new OAuthError('access_denied', 'Only an administrator can authorise this connection', 403)

  const client = looksLikeSecret(input.clientId)
    ? await prisma.mcpClient.findUnique({ where: { clientId: input.clientId } })
    : null
  if (!client) throw new OAuthError('invalid_client', 'Unknown client')
  if (!redirectUriMatches(client.redirectUris, input.redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri does not match a registered one')
  }
  if (!isValidCodeChallenge(input.codeChallenge)) throw new OAuthError('invalid_request', 'code_challenge is required (PKCE, S256)')
  if (input.resource != null && input.resource !== MCP_RESOURCE) throw new OAuthError('invalid_target', 'Unknown resource')
  if (input.scope != null && !isAcceptableScope(input.scope)) throw new OAuthError('invalid_scope', SCOPE_ERROR)

  const code = randomSecret()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)
  // Exactly what the consent screen described: never write access on a read-only consent
  const scope = consentedScope(input.scope)
  const grantId = await prisma.$transaction(async tx => {
    const grant = await tx.mcpGrant.create({
      data: { clientId: client.clientId, userId: admin.id, scope, resource: MCP_RESOURCE },
    })
    await tx.mcpAuthCode.create({
      data: {
        codeHash: sha256Hex(code),
        clientId: client.clientId,
        userId: admin.id,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        resource: MCP_RESOURCE,
        scope,
        expiresAt,
        grantId: grant.id,
      },
    })
    return grant.id
  })
  return { grantId, code, expiresAt }
}

// ============ Token endpoint ============

/** The JSON of a successful token response. Answer it with `Cache-Control: no-store`. */
export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

const invalidGrant = (description: string) => new OAuthError('invalid_grant', description)

/** A registered client, or `invalid_client`. Public clients identify themselves with `client_id` in the body. */
async function requireClient(form: ParamSource): Promise<{ clientId: string }> {
  const clientId = requiredFormParam(form, 'client_id')
  const client = looksLikeSecret(clientId)
    ? await prisma.mcpClient.findUnique({ where: { clientId }, select: { clientId: true } })
    : null
  if (!client) throw new OAuthError('invalid_client', 'Unknown client')
  return client
}

/** A grant that can still issue tokens: it exists, is not revoked, is bound to this resource and its owner is an active ADMIN. */
async function requireLiveGrant(grantId: string | null): Promise<{ id: string; clientId: string; scope: string }> {
  const grant = grantId ? await prisma.mcpGrant.findUnique({ where: { id: grantId } }) : null
  if (!grant || grant.revokedAt) throw invalidGrant('The authorisation was revoked')
  if (grant.resource !== MCP_RESOURCE) throw invalidGrant('The authorisation belongs to another resource')
  const admin = await adminState(grant.userId)
  if (!admin.ok) {
    await revokeGrant(grant.id, admin.reason)
    throw invalidGrant('The authorisation is no longer valid')
  }
  return { id: grant.id, clientId: grant.clientId, scope: grant.scope }
}

async function issueTokens(tx: Prisma.TransactionClient, grantId: string, scope: string, nowMs: number): Promise<TokenResponse> {
  const accessToken = randomSecret()
  const refreshToken = randomSecret()
  await tx.mcpToken.createMany({
    data: [
      { grantId, kind: 'access', tokenHash: sha256Hex(accessToken), expiresAt: new Date(nowMs + ACCESS_TOKEN_TTL_MS) },
      { grantId, kind: 'refresh', tokenHash: sha256Hex(refreshToken), expiresAt: new Date(nowMs + REFRESH_TOKEN_TTL_MS) },
    ],
  })
  return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope }
}

async function touchClient(clientId: string, now: Date): Promise<void> {
  await prisma.mcpClient.updateMany({ where: { clientId }, data: { lastUsedAt: now } }).catch(() => {})
}

/**
 * `grant_type=authorization_code`. Form fields: `code`, `client_id`,
 * `code_verifier` (required), `redirect_uri` and `resource` (optional, but
 * they must match when present: OAuth 2.1 no longer sends redirect_uri here
 * and PKCE is what binds the code to the client that asked for it).
 * A code works once: presenting a used code again revokes its grant.
 * Throws OAuthError `invalid_request`, `invalid_client`, `invalid_grant`
 * or `invalid_target`, all with status 400.
 */
export async function exchangeCode(form: ParamSource): Promise<TokenResponse> {
  const code = requiredFormParam(form, 'code')
  const codeVerifier = requiredFormParam(form, 'code_verifier')
  const redirectUri = formParam(form, 'redirect_uri')
  const resource = formParam(form, 'resource')
  const client = await requireClient(form)

  const row = looksLikeSecret(code) ? await prisma.mcpAuthCode.findUnique({ where: { codeHash: sha256Hex(code) } }) : null
  if (!row || row.clientId !== client.clientId) throw invalidGrant('Unknown authorization code')
  if (row.usedAt) {
    // RFC 6749 §4.1.2: a code used twice takes down what was issued from it
    if (row.grantId) await revokeGrant(row.grantId, 'code_reuse')
    throw invalidGrant('The authorization code was already used')
  }
  const now = new Date()
  if (row.expiresAt.getTime() <= now.getTime()) throw invalidGrant('The authorization code expired')
  if (redirectUri !== null && redirectUri !== row.redirectUri) throw invalidGrant('redirect_uri does not match the authorization request')
  if (!verifyPkceS256(codeVerifier, row.codeChallenge)) throw invalidGrant('code_verifier does not match the code challenge')
  if (resource !== null && (resource !== row.resource || resource !== MCP_RESOURCE)) {
    throw new OAuthError('invalid_target', 'Unknown resource')
  }
  const grant = await requireLiveGrant(row.grantId)

  const tokens = await prisma.$transaction(async tx => {
    // Single use, atomically: of two simultaneous exchanges only one sees count 1
    const consumed = await tx.mcpAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } })
    if (consumed.count !== 1) return null
    return issueTokens(tx, grant.id, grant.scope, now.getTime())
  })
  if (!tokens) {
    await revokeGrant(grant.id, 'code_reuse')
    throw invalidGrant('The authorization code was already used')
  }
  await touchClient(client.clientId, now)
  return tokens
}

/** A refresh token that was exchanged at `rotatedAt`. */
interface ExchangedRefreshToken {
  id: string
  grantId: string
  rotatedAt: Date
}

/**
 * May a refresh token that was already exchanged be exchanged once more?
 * Only as the echo of its own exchange: the retry of a renewal whose answer
 * never arrived (a proxy reset, a client timeout), or a second renewal that
 * overlapped the first (two conversations, or parallel tool calls, that all
 * got a 401 when the access token expired). Claude answers an invalid_grant
 * by throwing its tokens away, so refusing those would disconnect the owner.
 *
 * That is: within REFRESH_REUSE_LEEWAY_MS of the exchange, AND while the
 * client has not used what it got. Once any refresh token of the grant was
 * exchanged after this one the client has moved on, and this one coming back
 * means somebody else holds it.
 */
async function isEchoOfExchange(
  db: Pick<Prisma.TransactionClient, 'mcpToken'>,
  token: ExchangedRefreshToken,
  now: Date,
): Promise<boolean> {
  if (now.getTime() - token.rotatedAt.getTime() >= REFRESH_REUSE_LEEWAY_MS) return false
  const exchangedSince = await db.mcpToken.count({
    where: { grantId: token.grantId, kind: 'refresh', id: { not: token.id }, rotatedAt: { gte: token.rotatedAt } },
  })
  return exchangedSince === 0
}

/**
 * `grant_type=refresh_token`. Form fields: `refresh_token`, `client_id`
 * (required), `scope` and `resource` (optional, must match).
 *
 * The grant's current refresh token is rotated: a new access + refresh pair,
 * the old one marked as exchanged. Every other live refresh token of the grant
 * is retired at the same moment (see below).
 *
 * An exchanged refresh token presented again:
 *  - as the echo of its own exchange (isEchoOfExchange: within a minute, the
 *    client has not used its new one yet, same client), gets a fresh pair of
 *    its own and revokes nothing. The pair of the first exchange stays valid
 *    too: which of the two answers the client kept is not known here. The one
 *    it does not use is retired at its next renewal;
 *  - in any other case (later, after the client moved on, from another
 *    client, or a retired one) revokes the whole grant: somebody else holds it.
 *
 * Revoked, expired or unknown → `invalid_grant`. The previous access token is
 * left to expire (it may be in flight).
 */
export async function refresh(form: ParamSource): Promise<TokenResponse> {
  const refreshToken = requiredFormParam(form, 'refresh_token')
  const resource = formParam(form, 'resource')
  const scope = formParam(form, 'scope')
  const client = await requireClient(form)

  const row = looksLikeSecret(refreshToken)
    ? await prisma.mcpToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) } })
    : null
  if (!row || row.kind !== 'refresh') throw invalidGrant('Unknown refresh token')
  const now = new Date()
  if (row.rotatedAt && !(await isEchoOfExchange(prisma, { id: row.id, grantId: row.grantId, rotatedAt: row.rotatedAt }, now))) {
    // Somebody holds an old refresh token: the family is compromised
    await revokeGrant(row.grantId, 'refresh_reuse')
    throw invalidGrant('The refresh token was already used')
  }
  if (row.expiresAt.getTime() <= now.getTime()) throw invalidGrant('The refresh token expired')
  const grant = await requireLiveGrant(row.grantId)
  if (grant.clientId !== client.clientId) {
    // An exchanged refresh token in the hands of another client is not an echo
    if (row.rotatedAt) await revokeGrant(grant.id, 'refresh_reuse')
    throw invalidGrant('The refresh token belongs to another client')
  }
  if (resource !== null && resource !== MCP_RESOURCE) throw new OAuthError('invalid_target', 'Unknown resource')
  // Any known scope may be named; the new pair always carries the grant's own
  // scope. A grant approved before tkoc.write existed stays read-only (the
  // answer's `scope` says so) instead of being cut off at renewal
  if (!isAcceptableScope(scope)) throw new OAuthError('invalid_scope', SCOPE_ERROR)

  const tokens = await prisma.$transaction(async tx => {
    const rotated = await tx.mcpToken.updateMany({ where: { id: row.id, rotatedAt: null }, data: { rotatedAt: now } })
    if (rotated.count === 1) {
      // The client renews with this token, so any other live refresh token of
      // the grant is a branch it left behind: the twin pair of an overlapping
      // or retried renewal. Retired as if exchanged a full leeway ago, so that
      // presenting it later is a reuse and revokes the grant.
      await tx.mcpToken.updateMany({
        where: { grantId: grant.id, kind: 'refresh', rotatedAt: null, id: { not: row.id } },
        data: { rotatedAt: new Date(now.getTime() - REFRESH_REUSE_LEEWAY_MS) },
      })
      return issueTokens(tx, grant.id, grant.scope, now.getTime())
    }
    // Another request exchanged it a moment ago (the two read it before either
    // wrote): the same rule as above decides, on the row as it is now
    const current = await tx.mcpToken.findUnique({ where: { id: row.id }, select: { id: true, grantId: true, rotatedAt: true } })
    if (!current?.rotatedAt) return null
    if (!(await isEchoOfExchange(tx, { id: current.id, grantId: current.grantId, rotatedAt: current.rotatedAt }, now))) return null
    return issueTokens(tx, grant.id, grant.scope, now.getTime())
  })
  if (!tokens) {
    await revokeGrant(grant.id, 'refresh_reuse')
    throw invalidGrant('The refresh token was already used')
  }
  // Keep the table small: this grant's dead tokens go now
  await prisma.mcpToken.deleteMany({ where: { grantId: grant.id, expiresAt: { lt: now } } }).catch(() => {})
  await touchClient(client.clientId, now)
  return tokens
}

/**
 * POST /api/oauth/token: reads `grant_type` and calls exchangeCode or refresh.
 * `form` is the application/x-www-form-urlencoded body (URLSearchParams or
 * FormData). Missing grant_type → `invalid_request`; any other value →
 * `unsupported_grant_type`. Answer errors with `error.body` and `error.status`.
 */
export async function handleTokenRequest(form: ParamSource): Promise<TokenResponse> {
  const grantType = requiredFormParam(form, 'grant_type')
  if (grantType === 'authorization_code') return exchangeCode(form)
  if (grantType === 'refresh_token') return refresh(form)
  throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported')
}

// ============ Revocation ============

/**
 * Revokes one grant: marks it (`revokedAt`, `revokedReason`) and deletes its
 * tokens and codes, so access ends at once. `reason` is a short internal
 * label (for example `admin:<userId>`), never shown to the client.
 * Returns true when a live grant was revoked, false when there was nothing to do.
 */
export async function revokeGrant(id: string, reason: string): Promise<boolean> {
  if (typeof id !== 'string' || !id) return false
  const now = new Date()
  const [marked] = await prisma.$transaction([
    prisma.mcpGrant.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: now, revokedReason: String(reason || 'revoked').slice(0, 120) },
    }),
    prisma.mcpToken.deleteMany({ where: { grantId: id } }),
    prisma.mcpAuthCode.deleteMany({ where: { grantId: id } }),
  ])
  return marked.count === 1
}

/**
 * POST /api/oauth/revoke (RFC 7009). Form fields: `token` (required),
 * `token_type_hint` (ignored), `client_id` (optional: when present it must be
 * the grant's client, otherwise nothing happens). Revoking either token ends
 * the whole grant. Unknown tokens are not an error: answer 200 with an empty
 * body in every case except a missing `token` (OAuthError `invalid_request`).
 */
export async function revokeToken(form: ParamSource): Promise<void> {
  const token = requiredFormParam(form, 'token')
  const clientId = formParam(form, 'client_id')
  if (!looksLikeSecret(token)) return
  const row = await prisma.mcpToken.findUnique({ where: { tokenHash: sha256Hex(token) } })
  if (!row) return
  if (clientId !== null) {
    const grant = await prisma.mcpGrant.findUnique({ where: { id: row.grantId }, select: { clientId: true } })
    if (!grant || grant.clientId !== clientId) return
  }
  await revokeGrant(row.grantId, 'client_revoked')
}

// ============ Bearer check of /api/mcp ============

export type BearerFailureReason =
  | 'missing' // no Authorization header, or not the Bearer scheme
  | 'malformed' // not one of our tokens by its shape
  | 'unknown' // no such access token (never issued, deleted, or a refresh token)
  | 'expired'
  | 'revoked' // the grant was revoked
  | 'wrong_resource' // issued for another resource
  | 'user_missing'
  | 'user_inactive'
  | 'user_not_admin'

export type BearerResult =
  | {
      ok: true
      /** The administrator the call acts for. No e-mail on purpose. */
      user: { id: string; name: string; role: 'ADMIN' }
      grant: { id: string; clientId: string; userId: string; scope: string; resource: string }
      /** When this access token stops working. */
      expiresAt: Date
    }
  | {
      ok: false
      reason: BearerFailureReason
      /** Always 401. */
      status: 401
      /** Small JSON body of the 401. */
      body: { error: 'unauthorized' | 'invalid_token'; error_description: string }
      /** Exact value of the WWW-Authenticate header of the 401. */
      wwwAuthenticate: string
    }

function bearerFailure(reason: BearerFailureReason): BearerResult {
  return {
    ok: false,
    reason,
    status: 401,
    body:
      reason === 'missing'
        ? { error: 'unauthorized', error_description: 'Sign in to use this connector' }
        : { error: 'invalid_token', error_description: 'The access token is not valid' },
    wwwAuthenticate: WWW_AUTHENTICATE_BEARER,
  }
}

/**
 * Checks the `Authorization` header of a call to /api/mcp. Success only when
 * the access token exists (hash lookup), has not expired, its grant is not
 * revoked and is bound to MCP_RESOURCE, and the grant's user still exists, is
 * active and is ADMIN. A user who is no longer an active administrator gets
 * the grant revoked on the spot. `lastUsedAt` is written at most once a
 * minute. Never throws for a bad token: every failure is a typed 401 with the
 * header to send. The route then applies allowRequest(grant.id).
 */
export async function authenticateBearer(headerValue: string | null | undefined): Promise<BearerResult> {
  const match = typeof headerValue === 'string' ? /^Bearer +(\S+)$/i.exec(headerValue.trim()) : null
  if (!match) return bearerFailure('missing')
  const token = match[1]
  if (!looksLikeSecret(token)) return bearerFailure('malformed')

  const row = await prisma.mcpToken.findUnique({ where: { tokenHash: sha256Hex(token) } })
  if (!row || row.kind !== 'access') return bearerFailure('unknown')
  const now = new Date()
  if (row.expiresAt.getTime() <= now.getTime()) return bearerFailure('expired')

  const grant = await prisma.mcpGrant.findUnique({ where: { id: row.grantId } })
  if (!grant || grant.revokedAt) return bearerFailure('revoked')
  if (grant.resource !== MCP_RESOURCE) return bearerFailure('wrong_resource')

  const admin = await adminState(grant.userId)
  if (!admin.ok) {
    await revokeGrant(grant.id, admin.reason)
    return bearerFailure(admin.reason)
  }

  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    await prisma.mcpGrant.updateMany({ where: { id: grant.id, revokedAt: null }, data: { lastUsedAt: now } }).catch(() => {})
  }
  return {
    ok: true,
    user: { id: admin.id, name: admin.name, role: 'ADMIN' },
    grant: { id: grant.id, clientId: grant.clientId, userId: grant.userId, scope: grant.scope, resource: grant.resource },
    expiresAt: row.expiresAt,
  }
}

/**
 * Tool calls of one grant: 120 per 10 minutes. Spent by every `tools/call`
 * (src/lib/mcp/server.ts), and by nothing else. Returns false when the call
 * must not run (it is answered with a tool error the model can read). Counts
 * the call when it returns true.
 */
export function allowCall(grantId: string): boolean {
  return canProceed(`mcp:call:${grantId}`, CALL_RATE_LIMIT.max, CALL_RATE_LIMIT.windowMs)
}

/**
 * HTTP requests to /api/mcp of one grant, of any kind: 600 per 10 minutes.
 * Returns false when the request must be answered with 429. Counts the
 * request when it returns true.
 */
export function allowRequest(grantId: string): boolean {
  return canProceed(`mcp:request:${grantId}`, REQUEST_RATE_LIMIT.max, REQUEST_RATE_LIMIT.windowMs)
}

// ============ Connections for the administrator ============

/** One row of the card «Conexiones con Claude». No token, no e-mail. */
export interface GrantSummary {
  id: string
  clientId: string
  /** Untrusted text typed by the client: escape it. null when the client row is gone. */
  clientName: string | null
  userId: string
  /** null when the user no longer exists. */
  userName: string | null
  scope: string
  createdAt: Date
  lastUsedAt: Date | null
}

/**
 * Deletes expired tokens and codes, and closes (reason `expired`) every grant
 * that has nothing alive left: no access token, no current refresh token and
 * no pending code (an approval the client never completed, or 60 days without
 * use). Runs on registration and before listing; safe to call at any time.
 */
export async function sweepExpired(now: Date = new Date()): Promise<void> {
  await prisma.$transaction([
    prisma.mcpToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.mcpAuthCode.deleteMany({ where: { expiresAt: { lt: now } } }),
  ])
  const open = await prisma.mcpGrant.findMany({ where: { revokedAt: null }, select: { id: true } })
  if (open.length === 0) return
  const ids = open.map(g => g.id)
  // Pending codes FIRST, tokens SECOND, one after the other. Exchanging a code
  // turns "pending code" into "tokens" in one transaction: read in this order,
  // a grant that is being connected right now is seen alive on one side or the
  // other. Read the other way round (or in parallel) it could be seen on neither.
  const codes = await prisma.mcpAuthCode.findMany({
    where: { grantId: { in: ids }, usedAt: null, expiresAt: { gte: now } },
    select: { grantId: true },
  })
  const tokens = await prisma.mcpToken.findMany({
    where: { grantId: { in: ids }, expiresAt: { gte: now }, OR: [{ kind: 'access' }, { kind: 'refresh', rotatedAt: null }] },
    select: { grantId: true },
    distinct: ['grantId'],
  })
  const alive = new Set<string>([...tokens.map(t => t.grantId), ...codes.map(c => c.grantId).filter((g): g is string => !!g)])
  for (const id of ids) {
    if (!alive.has(id)) await revokeGrant(id, 'expired')
  }
}

/**
 * GET /api/oauth/grants (the route checks the ADMIN session first): the
 * non-revoked grants of ALL administrators, newest first, with the client's
 * and the user's name. Dead grants are closed before listing (sweepExpired).
 */
export async function listGrants(): Promise<GrantSummary[]> {
  await sweepExpired()
  const grants = await prisma.mcpGrant.findMany({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' } })
  if (grants.length === 0) return []
  const [clients, users] = await Promise.all([
    prisma.mcpClient.findMany({
      where: { clientId: { in: [...new Set(grants.map(g => g.clientId))] } },
      select: { clientId: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: [...new Set(grants.map(g => g.userId))] } },
      select: { id: true, name: true },
    }),
  ])
  const clientName = new Map(clients.map(c => [c.clientId, c.name]))
  const userName = new Map(users.map(u => [u.id, u.name]))
  return grants.map(g => ({
    id: g.id,
    clientId: g.clientId,
    clientName: clientName.get(g.clientId) ?? null,
    userId: g.userId,
    userName: userName.get(g.userId) ?? null,
    scope: g.scope,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
  }))
}
