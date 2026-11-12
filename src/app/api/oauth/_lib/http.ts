/**
 * HTTP plumbing shared by the OAuth route handlers of the MCP connector for
 * Claude: reading a request body with a size cap and answering in the formats
 * the RFCs ask for. No OAuth logic here: that lives in src/lib/mcp/oauth.ts.
 *
 * The folder starts with an underscore, so the App Router never serves it.
 *
 * SECURITY: nothing in this file logs, stores or echoes a request body. It may
 * carry an authorization code, a code verifier or a token.
 */
import { NextResponse } from 'next/server'
import { OAuthError, isOAuthError } from '@/lib/mcp/oauth'

/**
 * Largest body any OAuth endpoint reads. The biggest legitimate one is the
 * consent form (a signed token of at most 8192 characters).
 */
export const MAX_BODY_BYTES = 16 * 1024

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const

/** Media type of the request body, lower case and without parameters ('' when absent). */
export function mediaType(request: Request): string {
  return (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
}

/**
 * The request body as text, or null when it is larger than `maxBytes`.
 * It stops reading at the cap: an oversized body is never held in memory.
 */
export async function readBodyText(request: Request, maxBytes: number = MAX_BODY_BYTES): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) return null
  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The `application/x-www-form-urlencoded` body of a POST (token, revocation
 * and the consent decision). Throws OAuthError `invalid_request` when:
 *  - the URL carries parameters: a code or a token must never travel in a
 *    query string, where proxies, logs and browser history keep it (400);
 *  - the body has another content type (400);
 *  - the body is over the cap (413).
 * Repeated parameters are kept as they came: oauth.ts refuses them.
 */
export async function readFormBody(request: Request): Promise<URLSearchParams> {
  if (new URL(request.url).search) {
    throw new OAuthError('invalid_request', 'Parameters must be sent in the request body, never in the URL')
  }
  if (mediaType(request) !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded')
  }
  const text = await readBodyText(request)
  if (text === null) throw new OAuthError('invalid_request', 'The request body is too large', 413)
  return new URLSearchParams(text)
}

/** A JSON answer that must never be cached (RFC 6749 §5.1: `Cache-Control: no-store`, `Pragma: no-cache`). */
export function jsonNoStore(body: unknown, status: number = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/** An empty answer that must never be cached (RFC 7009 §2.2: the revocation answers 200 with no content). */
export function emptyNoStore(status: number = 200): NextResponse {
  return new NextResponse(null, { status, headers: NO_STORE })
}

/**
 * Turns what a handler caught into its answer: an OAuthError becomes the JSON
 * of RFC 6749 §5.2 with its own status; anything else is logged (the error
 * only, never the request) and answered as `server_error`, 500.
 */
export function oauthErrorResponse(e: unknown, where: string): NextResponse {
  if (isOAuthError(e)) return jsonNoStore(e.body, e.status)
  console.error(`[${where}] unexpected error:`, e)
  return jsonNoStore({ error: 'server_error', error_description: 'Internal error' }, 500)
}
