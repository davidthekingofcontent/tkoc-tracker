/**
 * Configuration of the MCP connector for Claude: the canonical URLs, the
 * lifetimes, the limits and the rules for redirect URIs.
 *
 * SECURITY: nothing in this file is ever derived from a request. The public
 * address of the platform comes from the environment (or the production
 * default), never from Host, X-Forwarded-Host or Origin: a forged header must
 * not be able to change where a browser is sent or which issuer we claim to be.
 *
 * Pure module: no database, no network, safe to import anywhere (edge included).
 */

const PRODUCTION_URL = 'https://intelligence.thekingofcontent.agency'

/**
 * Canonical base URL from a raw environment value: no trailing slash, http(s)
 * only, no credentials, query or fragment. Anything unusable falls back to the
 * production address (exported for tests; use APP_URL everywhere else).
 */
export function resolveAppUrl(raw: string | undefined | null): string {
  const value = (raw || '').trim()
  if (!value) return PRODUCTION_URL
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return PRODUCTION_URL
    if (u.username || u.password || u.search || u.hash) return PRODUCTION_URL
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return PRODUCTION_URL
  }
}

/**
 * Public base URL of the platform as the connector announces it, without
 * trailing slash. Never from a request.
 *
 * It has its own variable, NEXT_PUBLIC_MCP_BASE_URL, and is NOT read from
 * NEXT_PUBLIC_APP_URL. Claude refuses to connect unless the `resource` of
 * /.well-known/oauth-protected-resource is, to the letter, the address the
 * person typed, and the guide (docs/conector-claude.md) tells them to type
 * the production address. Production answers on two domains (the custom one
 * and the Railway one, see src/lib/meta-oauth.ts), and NEXT_PUBLIC_APP_URL is
 * used by other features: whatever it holds must not be able to move the
 * resource away from the address in the guide. Leave the variable unset in
 * production; set it only for another environment (staging, a local test),
 * whose own address then has to be typed in Claude. NEXT_PUBLIC_ so that the
 * server and the browser bundle (the card in Ajustes) read the same value.
 */
export const APP_URL = resolveAppUrl(process.env.NEXT_PUBLIC_MCP_BASE_URL)

/** The URL the user types in Claude. Tokens are bound to it (RFC 8707). */
export const MCP_RESOURCE = `${APP_URL}/api/mcp`

/** OAuth issuer identifier (RFC 8414). Sent back as `iss` in every authorization response. */
export const ISSUER = APP_URL

/**
 * The read scope. Every grant carries it, and /api/mcp refuses a token
 * without it. Kept under its first name: it was the only scope until the
 * write layer (12 Nov 2026).
 */
export const MCP_SCOPE = 'tkoc.read'

/**
 * The write scope (12 Nov 2026): the tools that change the platform. A grant
 * approved before it existed keeps working read-only; its write tools answer
 * that the connection must be made again.
 */
export const MCP_WRITE_SCOPE = 'tkoc.write'

/** Every scope this server knows, in the order they are announced. */
export const MCP_SCOPES: readonly string[] = [MCP_SCOPE, MCP_WRITE_SCOPE]

/**
 * What every new authorisation grants: both scopes, one consent. The client
 * may ask for any of the known scopes (or none); the consent screen signs
 * this, and the grant gets exactly what the consent carried
 * (consentedScope in ./oauth.ts: a consent of the read-only screen of
 * before stays read only).
 */
export const MCP_GRANT_SCOPE = `${MCP_SCOPE} ${MCP_WRITE_SCOPE}`

/** True when a grant's space-separated `scope` contains `scope` as a whole item. */
export function grantHasScope(grantScope: string | null | undefined, scope: string): boolean {
  return typeof grantScope === 'string' && grantScope.split(' ').includes(scope)
}

// ---- Endpoints (absolute, built from APP_URL) ----

export const AUTHORIZATION_ENDPOINT = `${APP_URL}/oauth/authorize`
export const TOKEN_ENDPOINT = `${APP_URL}/api/oauth/token`
export const REGISTRATION_ENDPOINT = `${APP_URL}/api/oauth/register`
export const REVOCATION_ENDPOINT = `${APP_URL}/api/oauth/revoke`
/** RFC 9728 metadata of the MCP endpoint. Also served at `.../oauth-protected-resource/api/mcp`. */
export const PROTECTED_RESOURCE_METADATA_URL = `${APP_URL}/.well-known/oauth-protected-resource`
/** RFC 8414 metadata of the authorization server. */
export const AUTHORIZATION_SERVER_METADATA_URL = `${APP_URL}/.well-known/oauth-authorization-server`

/** Exact value of the WWW-Authenticate header of every 401 of /api/mcp. */
export const WWW_AUTHENTICATE_BEARER = `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`

// ---- Lifetimes ----

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Authorization code: 5 minutes, single use. */
export const CODE_TTL_MS = 5 * MINUTE
/** Access token: 1 hour. */
export const ACCESS_TOKEN_TTL_MS = HOUR
/** `expires_in` of the token response, in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_MS / SECOND
/** Refresh token: 60 days from the moment it is issued (each rotation issues a new one). */
export const REFRESH_TOKEN_TTL_MS = 60 * DAY
/** Signed consent token of the «Permitir» / «Cancelar» form: 10 minutes. */
export const CONSENT_TOKEN_TTL_MS = 10 * MINUTE
/** `lastUsedAt` of a grant is written at most this often. */
export const LAST_USED_WRITE_INTERVAL_MS = MINUTE
/**
 * How long after its exchange a refresh token may be presented once more
 * without revoking the grant: a retry after a lost answer, or two renewals
 * that overlapped. Only while the client has not used its new refresh token
 * yet; after that, or after this minute, a reuse revokes the grant.
 */
export const REFRESH_REUSE_LEEWAY_MS = MINUTE

// ---- Limits ----

/** Client registration: 10 per hour per address (outside Anthropic's egress range). */
export const REGISTRATION_RATE_LIMIT = { max: 10, windowMs: HOUR } as const
/**
 * Client registration from Anthropic's egress range (CLAUDE_EGRESS_IPV4):
 * ONE allowance shared by the whole range, much larger. Every claude.ai and
 * desktop user in the world registers from those few addresses, so 10 per
 * hour per address would let anyone with a Claude account block the owner by
 * clicking Connect ten times. The table itself stays bounded by MAX_CLIENTS
 * (a client with a live grant is never evicted); this ceiling only stops a
 * runaway loop, and nobody clicks Connect 300 times an hour by hand.
 */
export const CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT = { max: 300, windowMs: HOUR } as const
/**
 * Tool calls (`tools/call`) of one grant: 120 per 10 minutes. Over it, the
 * call is answered with a tool error the model can read (no HTTP error), so
 * the connection itself keeps working.
 */
export const CALL_RATE_LIMIT = { max: 120, windowMs: 10 * MINUTE } as const
/**
 * HTTP requests to /api/mcp of one grant, of any kind (initialize,
 * tools/list, ping, tool calls): 600 per 10 minutes, then 429. Only a client
 * that misbehaves gets here: a session costs three requests before its first
 * tool call, and the tool calls have their own, smaller allowance.
 */
export const REQUEST_RATE_LIMIT = { max: 600, windowMs: 10 * MINUTE } as const
/** Never more registered clients than this (the oldest unused ones go first). */
export const MAX_CLIENTS = 200
/** A client that never obtained a grant is deleted after 30 days. */
export const UNUSED_CLIENT_MAX_AGE_MS = 30 * DAY
/** Longest client name accepted at registration. */
export const CLIENT_NAME_MAX_CHARS = 100
/** Most redirect URIs one client may register. */
export const MAX_REDIRECT_URIS = 10
/** Longest redirect URI accepted. */
export const REDIRECT_URI_MAX_CHARS = 512
/** Longest `state` accepted at the authorization endpoint (it travels inside the consent token). */
export const STATE_MAX_CHARS = 2048
/** `argsSummary` of the call log. */
export const ARGS_SUMMARY_MAX_CHARS = 300
/** Every list a tool returns: default and maximum number of rows. */
export const LIST_DEFAULT_LIMIT = 50
export const LIST_MAX_LIMIT = 200

// ---- Anthropic's egress range ----

/**
 * The addresses claude.ai and the desktop app call connectors from
 * (Anthropic's published egress range). Claude Code calls from the user's own
 * machine instead. Only used to pick the registration allowance: being in the
 * range opens nothing else.
 */
export const CLAUDE_EGRESS_IPV4 = { base: '160.79.104.0', prefixBits: 21 } as const

/** A dotted IPv4 address as a 32-bit number, or null when it is not exactly one. */
function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

/**
 * True when `address` (as clientIp of src/lib/rate-limiter.ts returns it) is
 * inside CLAUDE_EGRESS_IPV4. Accepts the IPv4-mapped IPv6 form
 * (`::ffff:160.79.104.10`). Anything else, malformed text included, is false.
 */
export function isClaudeEgressAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false
  const plain = address.trim().replace(/^::ffff:/i, '')
  const ip = ipv4ToNumber(plain)
  const base = ipv4ToNumber(CLAUDE_EGRESS_IPV4.base)
  if (ip === null || base === null) return false
  const size = 2 ** (32 - CLAUDE_EGRESS_IPV4.prefixBits)
  return ip >= base && ip < base + size
}

// ---- Redirect URIs ----

/** Claude's hosted callbacks. Compared as exact strings, never parsed or normalised. */
export const CLAUDE_CALLBACKS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]

/**
 * Loopback redirect (Claude Code and other local clients, RFC 8252):
 * `http://localhost[:port][/path][?query]` or the same with `127.0.0.1`.
 * The authority is matched literally, so nothing can hide in it: no userinfo
 * (`localhost@evil.com`), no longer host (`localhost.evil.com`), no other
 * spelling of the address (`127.1`, `[::1]`, upper case), no fragment.
 */
const LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?(\/[A-Za-z0-9\-._~%!$&'()*+,;=:/]*)?(\?[A-Za-z0-9\-._~%!$&'()*+,;=:/?]*)?$/

interface Loopback {
  hostname: string
  pathname: string
  search: string
}

/** Parsed loopback redirect URI, or null when it is not an acceptable one. */
function parseLoopback(uri: string): Loopback | null {
  if (typeof uri !== 'string' || uri.length > REDIRECT_URI_MAX_CHARS) return null
  const m = LOOPBACK_RE.exec(uri)
  if (!m) return null
  if (m[2] !== undefined) {
    const port = Number(m[2])
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  }
  // Second opinion from the URL parser: it must see the very same host
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' || u.hostname !== m[1] || u.username || u.password || u.hash) return null
  return { hostname: u.hostname, pathname: u.pathname, search: u.search }
}

/** True for `http://localhost[:port]/...` and `http://127.0.0.1[:port]/...` only. */
export function isLoopbackRedirectUri(uri: string): boolean {
  return parseLoopback(uri) !== null
}

/**
 * Registration rule: a redirect URI is accepted only if it is EXACTLY one of
 * Claude's two callbacks or a loopback URL. Everything else is refused.
 */
export function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false
  return CLAUDE_CALLBACKS.includes(uri) || isLoopbackRedirectUri(uri)
}

/**
 * Authorization rule: does the presented redirect URI match one the client
 * registered? Claude's callbacks: exact string. Loopback: same scheme, host,
 * path and query, any port (the local client picks a free port each time).
 */
export function redirectUriMatches(registered: readonly string[], presented: unknown): presented is string {
  if (typeof presented !== 'string') return false
  if (CLAUDE_CALLBACKS.includes(presented)) return registered.includes(presented)
  const p = parseLoopback(presented)
  if (!p) return false
  return registered.some(r => {
    const q = parseLoopback(r)
    return q !== null && q.hostname === p.hostname && q.pathname === p.pathname && q.search === p.search
  })
}

// ---- Metadata documents ----

/**
 * RFC 9728 Protected Resource Metadata, served as JSON at
 * `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`.
 * `resource` must equal exactly the URL the user typed in Claude.
 */
export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'TKOC Intelligence',
  }
}

/**
 * RFC 8414 Authorization Server Metadata, served as JSON at
 * `/.well-known/oauth-authorization-server`. Dynamic registration only: it
 * deliberately does NOT advertise `client_id_metadata_document_supported`.
 */
export function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    registration_endpoint: REGISTRATION_ENDPOINT,
    revocation_endpoint: REVOCATION_ENDPOINT,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
  }
}
