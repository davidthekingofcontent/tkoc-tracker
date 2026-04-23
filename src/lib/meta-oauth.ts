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
  /** Flow kind: 'brand' or 'creator'. */
  kind: 'brand' | 'creator'
  /** For brand flow, the logged-in user id. */
  userId?: string
  /** For creator flow, the invitation token that links to a CreatorProfile. */
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
 * Derive BASE URL from env or request origin.
 */
export function getBaseUrl(request: Request): string {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_APP_URL
  if (envBase) {
    return envBase.startsWith('http') ? envBase : `https://${envBase}`
  }
  // Derive from request origin (Host + proto)
  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

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
