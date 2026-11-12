/**
 * Cryptographic helpers of the MCP connector: random secrets, the hash under
 * which they are stored, constant-time comparison, PKCE (S256) and the signed
 * consent token of the «Permitir» / «Cancelar» form.
 *
 * Node's built-in crypto only. Nothing here logs or returns a secret other
 * than the one the caller asked to create.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { CONSENT_TOKEN_TTL_MS } from './config'

// ---- Secrets ----

/** 32 random bytes, base64url: 43 characters. Authorization codes, tokens and client ids. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

/** Shape check of a code or token before any database lookup (cheap rejection of garbage). */
export function looksLikeSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET_RE.test(value)
}

/** SHA-256 in hex: the ONLY form in which a code or a token reaches the database. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Constant-time equality of two strings. Both sides are hashed first, so
 * neither the position of the first difference nor the lengths leak.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

// ---- PKCE (RFC 7636), S256 only ----

const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

/** RFC 7636 §4.1: 43 to 128 characters of the unreserved set. */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === 'string' && CODE_VERIFIER_RE.test(verifier)
}

/** An S256 challenge is the base64url of a SHA-256: exactly 43 characters, no padding. */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && CODE_CHALLENGE_RE.test(challenge)
}

/** The S256 challenge of a verifier: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** True only when the verifier is well formed and its S256 equals the stored challenge (constant time). */
export function verifyPkceS256(verifier: unknown, challenge: unknown): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false
  return safeEqual(pkceChallengeS256(verifier), challenge)
}

// ---- Consent token ----

/** What the consent token binds. All of it is signed: none of it can be changed by the browser. */
export interface ConsentFields {
  /** The administrator who is looking at the consent screen. */
  userId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  /** `state` of the authorization request, or null when the client sent none. */
  state: string | null
  resource: string
  scope: string
}

export type ConsentCheck =
  | { ok: true; fields: ConsentFields; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

const CONSENT_VERSION = 'v1'
// Ample room for the longest accepted request (a 2048-character state and a
// 512-character redirect URI, in base64url)
const CONSENT_MAX_CHARS = 8192

/**
 * Key of the consent token: derived from JWT_SECRET with its own label, so a
 * consent token can never be mistaken for (or replayed as) a session token.
 */
function consentKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set: the consent token cannot be signed')
  return createHmac('sha256', secret).update('tkoc-mcp-consent-token-v1').digest()
}

function consentSignature(body: string): Buffer {
  return createHmac('sha256', consentKey()).update(body, 'utf8').digest()
}

/**
 * Signs the consent token the consent page puts in its form (HMAC-SHA256,
 * 10 minutes). It is the CSRF protection of the decision: only a page we
 * rendered for this administrator and this exact request can produce one.
 */
export function signConsentToken(fields: ConsentFields, nowMs: number = Date.now()): string {
  const payload = {
    uid: fields.userId,
    cid: fields.clientId,
    ru: fields.redirectUri,
    cc: fields.codeChallenge,
    st: fields.state,
    rs: fields.resource,
    sc: fields.scope,
    exp: nowMs + CONSENT_TOKEN_TTL_MS,
  }
  const body = `${CONSENT_VERSION}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  return `${body}.${consentSignature(body).toString('base64url')}`
}

/**
 * Verifies a consent token: signature first (constant time), then expiry.
 * On success it returns the signed fields; the caller must still check that
 * `fields.userId` is the administrator of the current session.
 */
export function verifyConsentToken(token: unknown, nowMs: number = Date.now()): ConsentCheck {
  if (typeof token !== 'string' || token.length === 0 || token.length > CONSENT_MAX_CHARS) {
    return { ok: false, reason: 'malformed' }
  }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== CONSENT_VERSION || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' }
  }
  const expected = consentSignature(`${parts[0]}.${parts[1]}`)
  const given = Buffer.from(parts[2], 'base64url')
  // The round trip rejects any other spelling of the same bytes (padding, stray characters)
  if (given.toString('base64url') !== parts[2]) return { ok: false, reason: 'malformed' }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' }
  }

  let p: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' }
    p = parsed as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  if (!str(p.uid) || !str(p.cid) || !str(p.ru) || !str(p.cc) || !str(p.rs) || !str(p.sc)) {
    return { ok: false, reason: 'malformed' }
  }
  if (p.st !== null && typeof p.st !== 'string') return { ok: false, reason: 'malformed' }
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, reason: 'malformed' }
  if (p.exp <= nowMs) return { ok: false, reason: 'expired' }

  return {
    ok: true,
    expiresAt: p.exp,
    fields: {
      userId: p.uid,
      clientId: p.cid,
      redirectUri: p.ru,
      codeChallenge: p.cc,
      state: p.st,
      resource: p.rs,
      scope: p.sc,
    },
  }
}
