/**
 * POST /api/mcp/actions/[id]
 *
 * The decision of the confirmation page of a pending action of Claude
 * (GET /mcp/confirmar/[id]): «Confirmar» or «Cancelar». A plain browser form
 * post, so the answer is always a redirect back to that page (which shows the
 * new state) or a small page of ours with one sentence, never JSON.
 *
 * Form fields (application/x-www-form-urlencoded), as in
 * src/components/mcp/action-form.ts:
 *   action_token     the token the page signed (signDecisionToken)
 *   decision         `confirm` or `cancel`; anything else changes nothing
 *   action_password  `confirm` only: the administrator's own password
 *
 * Required, and none enough alone:
 *  1. a browser post from our own origin (Sec-Fetch-Site, when present);
 *  2. the session of an active ADMIN, read from the `token` cookie ONLY (never
 *     an Authorization header) and re-read from the database;
 *  3. the decision token: HMAC-signed, 10 minutes, bound to that very
 *     administrator and to this action id. It is the CSRF protection;
 *  4. to confirm, the administrator's password, checked against the
 *     database (5 wrong ones per 15 minutes, then a pause). Claude can drive
 *     the owner's signed-in browser (Claude in Chrome) and press a button, but
 *     it does not know the password: the confirmation stays outside the model;
 *  5. decidePendingAction re-checks everything against the database: the
 *     decider must be the administrator who authorised the grant that asked
 *     for the action, the action must be pending and not expired, and to
 *     confirm, the grant must still be live.
 *
 * Confirming does NOT run the action: Claude runs it on its next call, once,
 * with the stored arguments (src/lib/mcp/write-tool.ts).
 *
 *   303  → /mcp/confirmar/[id]   (decided, or the page explains why not)
 *   303  → /mcp/confirmar/[id]?error=password   (no password or a wrong one: nothing decided)
 *   400  bad form, bad or expired token, unknown decision
 *   401  no session
 *   403  not an administrator, a token signed for somebody else, a cross-site post
 *   404  not an action id
 *   429  too many wrong passwords
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  ACTION_CANCEL,
  ACTION_CONFIRM,
  ACTION_DECISION_FIELD,
  ACTION_ERROR_PASSWORD,
  ACTION_PASSWORD_FIELD,
  ACTION_TOKEN_FIELD,
  actionPagePath,
} from '@/components/mcp/action-form'
import { verifyPassword } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { decidePendingAction, isActionId, verifyDecisionToken } from '@/lib/mcp/confirm'
import { checkAdminSession, isOAuthError } from '@/lib/mcp/oauth'
import { canProceed, getRemaining } from '@/lib/rate-limiter'
import { readFormBody } from '@/app/api/oauth/_lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Fixed sentences: nothing that came with the request is ever printed
const TEXT = {
  title: 'No se ha podido registrar tu decisión',
  session: 'Tu sesión ha caducado. Inicia sesión y vuelve a abrir el enlace de la acción.',
  adminOnly: 'Solo un administrador puede confirmar acciones de Claude.',
  expired: 'Esta pantalla ha caducado. Vuelve a abrir el enlace de la acción.',
  invalid: 'La solicitud no es válida. Vuelve a abrir el enlace de la acción.',
  notFound: 'Esta acción no existe o el enlace está incompleto. No se ha hecho nada.',
  tooManyPasswords: 'Demasiadas contraseñas incorrectas. Espera unos minutos y vuelve a abrir el enlace de la acción. No se ha confirmado nada.',
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

/** Back to the confirmation page, same site (relative Location: never built from the Host header). */
function backToPage(id: string, error?: typeof ACTION_ERROR_PASSWORD): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: actionPagePath(id, error), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}

/** Wrong passwords of one administrator on these forms: at most 5 per 15 minutes. */
const PASSWORD_FAILURES = { max: 5, windowMs: 15 * 60_000 } as const
const passwordFailuresKey = (userId: string) => `mcp-action-password:${userId}`

/** The administrator's own password, against the hash in the database. Never logged, never echoed. */
async function passwordMatches(userId: string, password: string | null): Promise<boolean> {
  if (!password || password.length > 200) return false
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } })
  if (!user?.password) return false
  try {
    return await verifyPassword(password, user.password)
  } catch {
    return false
  }
}

/** A form field that must appear exactly once. */
function once(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name)
  return values.length === 1 && values[0].length > 0 ? values[0] : null
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // The page always posts to its own origin
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite !== null && fetchSite !== 'same-origin') return errorPage(403, TEXT.invalid)

    const { id } = await params
    if (!isActionId(id)) return errorPage(404, TEXT.notFound)

    let form: URLSearchParams
    try {
      form = await readFormBody(request)
    } catch (e) {
      if (isOAuthError(e)) return errorPage(e.status, TEXT.invalid)
      throw e
    }

    // 1. The session: an active ADMIN according to the database, from the cookie only
    const session = await checkAdminSession(request.cookies.get('token')?.value)
    if (session.status === 'anonymous') return errorPage(401, TEXT.session)
    if (session.status === 'forbidden') return errorPage(403, TEXT.adminOnly)

    // 2. The token: ours, not expired, for this administrator and this action
    const check = verifyDecisionToken(once(form, ACTION_TOKEN_FIELD), id, session.user.id)
    if (!check.ok) {
      if (check.reason === 'expired') return errorPage(400, TEXT.expired)
      return errorPage(check.reason === 'mismatch' ? 403 : 400, TEXT.invalid)
    }

    // 3. Exactly one of the two buttons. Anything else changes nothing
    const raw = once(form, ACTION_DECISION_FIELD)
    const decision = raw === ACTION_CONFIRM ? 'approve' : raw === ACTION_CANCEL ? 'deny' : null
    if (!decision) return errorPage(400, TEXT.invalid)

    // 4. «Confirmar» needs the administrator's own password: a browser driven by
    //    Claude can press the button, but it does not know the password
    if (decision === 'approve') {
      const key = passwordFailuresKey(session.user.id)
      if (getRemaining(key, PASSWORD_FAILURES.max, PASSWORD_FAILURES.windowMs) <= 0) return errorPage(429, TEXT.tooManyPasswords)
      if (!(await passwordMatches(session.user.id, once(form, ACTION_PASSWORD_FIELD)))) {
        canProceed(key, PASSWORD_FAILURES.max, PASSWORD_FAILURES.windowMs) // one failure more
        return backToPage(id, ACTION_ERROR_PASSWORD)
      }
    }

    // 5. Everything again against the database; the page shows the outcome
    const result = await decidePendingAction({ id, deciderId: session.user.id, decision })
    if (!result.ok && result.reason === 'not_admin') return errorPage(403, TEXT.adminOnly)
    return backToPage(id)
  } catch (e) {
    console.error('[mcp/actions] unexpected error:', e instanceof Error ? e.message.slice(0, 300) : 'unknown error')
    return errorPage(500, TEXT.server)
  }
}
