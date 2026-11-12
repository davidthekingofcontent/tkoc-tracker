/**
 * GET /oauth/authorize: the consent page of the MCP connector for Claude.
 *
 * SERVER component. Everything that decides anything happens here, on the
 * server, in this order (deny by default):
 *
 *  1. Session. The `token` cookie is verified and the user is re-read from the
 *     database (checkAdminSession: signature, active account, role of the
 *     token still the role in the database). No valid session: to /login,
 *     which comes back here. A valid session that is not ADMIN never sees the
 *     request: an EMPLOYEE gets the refusal, BRAND and CREATOR go to their own
 *     home (the middleware already keeps them out; this is the second lock).
 *  2. Request. validateAuthorizeRequest checks the client and its redirect
 *     URI first. While either is wrong we show an error page and redirect
 *     NOWHERE. Any other problem goes back to the client's own, already
 *     validated, redirect URI as `?error=...&state=...&iss=...`.
 *  3. Consent. The form carries a token signed for THIS administrator and
 *     THIS exact request (10 minutes). POST /api/oauth/authorize verifies it
 *     together with the session, so the decision cannot be forged from
 *     another site. Nothing is granted by rendering this page.
 *
 * No URL here is ever built from the request's Host header.
 */
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { translations } from '@/i18n/translations'
import { signConsentToken } from '@/lib/mcp/crypto'
import { checkAdminSession, validateAuthorizeRequest } from '@/lib/mcp/oauth'
import { ConsentNotice, ConsentScreen } from '@/components/mcp/consent-screen'

// Reads the session cookie and the database on every request: never prerendered, never cached
export const dynamic = 'force-dynamic'
// jsonwebtoken, node:crypto and Prisma need the Node runtime
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: translations.es.mcp.consent.pageTitle,
  robots: { index: false, follow: false },
  // The query of this page (state, code challenge) is not sent to other sites as a referrer
  referrer: 'same-origin',
}

type SearchParams = Record<string, string | string[] | undefined>

/**
 * The query exactly as it arrived, repeated parameters included, so that
 * validateAuthorizeRequest can refuse a duplicated parameter and /login can
 * send the administrator back to the very same request.
 */
function toQuery(params: SearchParams): URLSearchParams {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string') query.append(name, value)
    else if (Array.isArray(value)) for (const item of value) query.append(name, String(item))
  }
  return query
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = toQuery(await searchParams)

  // ---- 1. Who is asking: an active ADMIN, checked against the database ----
  const session = await checkAdminSession((await cookies()).get('token')?.value)

  if (session.status === 'anonymous') {
    // Always this very path: /login only honours a `next` that starts with /oauth/authorize
    const queryString = query.toString()
    const self = queryString ? `/oauth/authorize?${queryString}` : '/oauth/authorize'
    redirect(`/login?next=${encodeURIComponent(self)}`)
  }

  if (session.status === 'forbidden') {
    if (session.role === 'BRAND') redirect('/portal')
    if (session.role === 'CREATOR') redirect('/dashboard')
    return <ConsentNotice kind="forbidden" />
  }

  // ---- 2. What is being asked ----
  const validation = await validateAuthorizeRequest(query)

  if (!validation.ok) {
    // Only a redirect URI that validateAuthorizeRequest vouched for is ever followed
    if (validation.redirect) redirect(validation.redirectTo)
    return <ConsentNotice kind="invalid" code={validation.error} />
  }

  // ---- 3. The consent screen, bound to this administrator and this request ----
  const consentToken = signConsentToken({ userId: session.user.id, ...validation.request })

  return (
    <ConsentScreen
      clientName={validation.client.name}
      redirectKind={validation.client.redirectKind}
      redirectHost={new URL(validation.request.redirectUri).host}
      adminName={session.user.name}
      consentToken={consentToken}
    />
  )
}
