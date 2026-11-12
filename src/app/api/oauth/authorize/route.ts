/**
 * POST /api/oauth/authorize
 *
 * The decision of the consent screen (GET /oauth/authorize): «Permitir» or
 * «Cancelar». It is a plain browser form post, so the answer is always a
 * redirect or a small page, never JSON.
 *
 * Form fields (application/x-www-form-urlencoded). Their names and values are
 * the contract in src/components/mcp/consent-form.ts, shared with the screen:
 *   consent_token   the token the consent page signed (signConsentToken)
 *   decision        `allow` («Permitir»); anything else, or nothing, is a refusal
 *
 * Both of these are required, and neither is enough alone:
 *  1. the session of an active ADMIN, read from the `token` cookie and
 *     re-read from the database (checkAdminSession);
 *  2. the consent token: HMAC-signed, 10 minutes, bound to that very
 *     administrator and to the exact request shown on the screen (client,
 *     redirect URI, PKCE challenge, state, resource, scope). It is the CSRF
 *     protection: only a page we rendered for this person can hold one.
 * Nothing else in the form is trusted: where the browser is sent and what is
 * granted come from the signed token only.
 *
 *   303  allow → redirect_uri?code=...&state=...&iss=...   (grant and code created)
 *   303  anything else → redirect_uri?error=access_denied&state=...&iss=...
 *   400  bad form, bad or expired consent token, client no longer valid
 *   401  no session
 *   403  not an administrator, a token signed for somebody else, or a post
 *        that the browser says does not come from our own page
 * On every error NOTHING is redirected: the browser stays on a page of ours.
 */
import { NextRequest, NextResponse } from 'next/server'
import { CONSENT_TOKEN_FIELD, DECISION_ALLOW, DECISION_FIELD } from '@/components/mcp/consent-form'
import { isAllowedRedirectUri } from '@/lib/mcp/config'
import { verifyConsentToken } from '@/lib/mcp/crypto'
import { buildAuthorizeRedirect, checkAdminSession, createGrantAndCode, isOAuthError } from '@/lib/mcp/oauth'
import { readFormBody } from '../_lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// What the administrator reads when the decision cannot be carried out.
// Fixed sentences: nothing that came with the request is ever printed.
const TEXT = {
  title: 'No se ha podido conectar Claude',
  session: 'Tu sesión ha caducado. Inicia sesión en la plataforma y vuelve a conectar desde Claude.',
  adminOnly: 'Solo un administrador puede conectar Claude con la plataforma.',
  expired: 'Esta pantalla ha caducado. Vuelve a Claude y conecta de nuevo.',
  invalid: 'La solicitud no es válida. Vuelve a Claude y conecta de nuevo.',
  server: 'Algo ha fallado. Inténtalo de nuevo en unos minutos.',
} as const

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** A small page of ours with one sentence. Never cached, never framed, no script. */
function errorPage(status: number, message: string): NextResponse {
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>TKOC Intelligence</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9fafb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
main{max-width:26rem;margin:1rem;padding:2rem;background:#fff;border:1px solid #e5e7eb;border-radius:1rem}
h1{margin:0 0 .75rem;font-size:1.25rem;color:#9333ea}
p{margin:0;font-size:.95rem;line-height:1.5;color:#4b5563}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(TEXT.title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`
  return new NextResponse(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/** Back to the client (303: the browser must follow with a GET). The URL may carry the code: never cached. */
function backToClient(url: string): NextResponse {
  const response = NextResponse.redirect(url, 303)
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

/** A form field that must appear exactly once. */
function once(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name)
  return values.length === 1 && values[0].length > 0 ? values[0] : null
}

export async function POST(request: NextRequest) {
  try {
    // Browsers say where a request was made from. The consent form always
    // posts to its own origin: anything else was not sent by our page.
    // (Absent in non-browser callers and old browsers: the checks below decide.)
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite !== null && fetchSite !== 'same-origin') return errorPage(403, TEXT.invalid)

    let form: URLSearchParams
    try {
      form = await readFormBody(request)
    } catch (e) {
      if (isOAuthError(e)) return errorPage(e.status, TEXT.invalid)
      throw e
    }

    // 1. The session: an active ADMIN, according to the database
    const session = await checkAdminSession(request.cookies.get('token')?.value)
    if (session.status === 'anonymous') return errorPage(401, TEXT.session)
    if (session.status === 'forbidden') return errorPage(403, TEXT.adminOnly)

    // 2. The consent token: ours, not expired, and signed for this administrator
    const consent = verifyConsentToken(once(form, CONSENT_TOKEN_FIELD))
    if (!consent.ok) return errorPage(400, consent.reason === 'expired' ? TEXT.expired : TEXT.invalid)
    if (consent.fields.userId !== session.user.id) return errorPage(403, TEXT.invalid)

    const { clientId, redirectUri, codeChallenge, state, resource, scope } = consent.fields

    // Only one exact value means «Permitir». «Cancelar», a missing field, a
    // repeated one or any other value is a refusal: nothing is created
    if (once(form, DECISION_FIELD) !== DECISION_ALLOW) {
      // Second look at the address before sending anybody there: one of
      // Claude's callbacks or a loopback URL, whatever the token says
      if (!isAllowedRedirectUri(redirectUri)) return errorPage(400, TEXT.invalid)
      return backToClient(buildAuthorizeRedirect(redirectUri, { error: 'access_denied', state }))
    }

    // «Permitir». createGrantAndCode checks everything again against the
    // database: the administrator, the client and its redirect URI
    const { code } = await createGrantAndCode({ userId: session.user.id, clientId, redirectUri, codeChallenge, resource, scope })
    return backToClient(buildAuthorizeRedirect(redirectUri, { code, state }))
  } catch (e) {
    if (isOAuthError(e)) {
      // The administrator stopped being one, or the client is gone: stay here
      return e.code === 'access_denied' ? errorPage(403, TEXT.adminOnly) : errorPage(400, TEXT.invalid)
    }
    console.error('[oauth/authorize] unexpected error:', e)
    return errorPage(500, TEXT.server)
  }
}
