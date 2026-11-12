/**
 * POST /api/oauth/revoke
 *
 * Revocation by the client (RFC 7009): Claude calls it when the user removes
 * the connector. Body: application/x-www-form-urlencoded with `token` (an
 * access or a refresh token), optionally `token_type_hint` (ignored) and
 * `client_id` (when sent it must be the client the token was issued to).
 * Revoking either token ends the whole authorisation: revokeToken,
 * src/lib/mcp/oauth.ts.
 *
 *   200  empty body, also for a token that is unknown, expired or already
 *        revoked (RFC 7009 §2.2: the client cannot tell them apart)
 *   400  invalid_request when `token` is missing or repeated
 *   413  body over 16 KiB
 *
 * SECURITY: the token itself is the credential, so no session is read. It
 * never appears in a log or in the answer, and it is refused in the URL.
 */
import { NextRequest } from 'next/server'
import { revokeToken } from '@/lib/mcp/oauth'
import { emptyNoStore, oauthErrorResponse, readFormBody } from '../_lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const form = await readFormBody(request)
    await revokeToken(form)
    return emptyNoStore(200)
  } catch (e) {
    return oauthErrorResponse(e, 'oauth/revoke')
  }
}
