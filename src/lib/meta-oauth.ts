/**
 * Meta OAuth Helpers
 * — Signed state cookies (HMAC-SHA256) so we can validate CSRF state and
 *   associate OAuth callbacks with the originating user/invitation.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

const STATE_COOKIE_MAX_AGE_SECONDS = 60 * 15 // 15 minutes

export type MetaStatePayload = {
  /** Random nonce, included in URL state param. */
  nonce: string
  /** Flow kind: 'brand', 'creator' or 'brand_connect' (session-less brand landing). */
  kind: 'brand' | 'creator' | 'brand_connect'
  /** For brand flow, the logged-in user id. */
  userId?: string
  /** For creator flow, the invitation token that links to a CreatorProfile.
   *  For brand_connect flow, the signed invite JWT. */
  invitationToken?: string
  /** Redirect URI used when starting OAuth (must match exactly on callback). */
  redirectUri: string
  /** Issued-at (seconds). */
  iat: number
}

function getSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET not set — required for Meta OAuth state signing')
  return s
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad
  return Buffer.from(b64, 'base64')
}

function sign(payload: string): string {
  return base64urlEncode(createHmac('sha256', getSecret()).update(payload).digest())
}

/**
 * Encode a Meta state payload into a signed cookie value.
 * Format: base64url(json).signature
 */
export function encodeMetaState(data: Omit<MetaStatePayload, 'iat' | 'nonce'> & { nonce?: string }): {
  cookieValue: string
  nonce: string
} {
  const nonce = data.nonce ?? base64urlEncode(randomBytes(16))
  const payload: MetaStatePayload = {
    nonce,
    kind: data.kind,
    userId: data.userId,
    invitationToken: data.invitationToken,
    redirectUri: data.redirectUri,
    iat: Math.floor(Date.now() / 1000),
  }
  const encoded = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = sign(encoded)
  return { cookieValue: `${encoded}.${sig}`, nonce }
}

/**
 * Decode and verify signature + freshness.
 * Returns null on any tampering / expiry.
 */
export function decodeMetaState(cookieValue: string | undefined): MetaStatePayload | null {
  if (!cookieValue) return null
  const dot = cookieValue.indexOf('.')
  if (dot === -1) return null
  const encoded = cookieValue.slice(0, dot)
  const providedSig = cookieValue.slice(dot + 1)

  const expectedSig = sign(encoded)
  try {
    const a = Buffer.from(providedSig)
    const b = Buffer.from(expectedSig)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  } catch {
    return null
  }

  let payload: MetaStatePayload
  try {
    payload = JSON.parse(base64urlDecode(encoded).toString('utf8'))
  } catch {
    return null
  }

  const now = Math.floor(Date.now() / 1000)
  if (!payload.iat || now - payload.iat > STATE_COOKIE_MAX_AGE_SECONDS) return null
  return payload
}

export const META_STATE_COOKIE = 'meta_oauth_state'
export const META_STATE_COOKIE_MAX_AGE = STATE_COOKIE_MAX_AGE_SECONDS

/**
 * Derive the BASE URL from the ACTUAL request origin, falling back to env.
 *
 * Precedence:
 *  1. Request origin: x-forwarded-proto + x-forwarded-host (Railway proxy),
 *     falling back to the Host header. When forwarded-proto is missing we
 *     assume https unless the host is localhost.
 *  2. Env (NEXT_PUBLIC_BASE_URL / NEXT_PUBLIC_APP_URL) when no request is
 *     available.
 *
 * Rationale: production serves on TWO domains (custom + railway). The OAuth
 * state/session cookies live on whichever domain the user is browsing, so
 * redirect_uri MUST be built from that same domain — otherwise Facebook
 * returns the browser to a domain where the cookies don't exist and the
 * callback silently fails. Deriving from each request keeps the redirect_uri
 * built at start identical to the one at token exchange (both requests hit
 * the same domain), which Meta requires to match exactly.
 */
export function getBaseUrl(request?: Request): string {
  if (request) {
    // Proxies may send comma-separated lists — take the first (client-most) value.
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    const host = forwardedHost || request.headers.get('host')?.trim()
    if (host) {
      const isLocalhost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const proto = forwardedProto || (isLocalhost ? 'http' : 'https')
      return `${proto}://${host}`
    }
    // No forwarded/Host headers at all — derive from the request URL itself.
    try {
      const url = new URL(request.url)
      return `${url.protocol}//${url.host}`
    } catch {
      // fall through to env
    }
  }
  const envBase = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (envBase) {
    return envBase.startsWith('http') ? envBase : `https://${envBase}`
  }
  return 'http://localhost:3000'
}

/**
 * Permissions requested for a BRAND connection (the brand's own IG Business
 * account). Single source of truth for the two brand flows (authenticated and
 * session-less brand-connect) and for the scopes recorded on the SocialToken.
 *
 * `instagram_manage_comments` is what unlocks GET /{ig-user-id}/tags — the
 * edge that returns creators' posts tagging the brand. Without it Meta answers
 * "(#10) Application does not have permission" and no tagged content can be
 * attributed to campaigns.
 */
export const META_BRAND_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'instagram_manage_comments',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
]

/**
 * Build the Facebook OAuth dialog URL.
 */
export function buildAuthorizeUrl(opts: {
  appId: string
  redirectUri: string
  state: string
  scopes: string[]
}): string {
  const u = new URL('https://www.facebook.com/v19.0/dialog/oauth')
  u.searchParams.set('client_id', opts.appId)
  u.searchParams.set('redirect_uri', opts.redirectUri)
  u.searchParams.set('state', opts.state)
  u.searchParams.set('scope', opts.scopes.join(','))
  u.searchParams.set('response_type', 'code')
  return u.toString()
}
