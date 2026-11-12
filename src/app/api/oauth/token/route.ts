/**
 * POST /api/oauth/token
 *
 * Token endpoint of the MCP connector for Claude (OAuth 2.1, public clients).
 * Body: application/x-www-form-urlencoded with `grant_type=authorization_code`
 * (code, client_id, code_verifier; redirect_uri and resource when sent must
 * match) or `grant_type=refresh_token` (refresh_token, client_id). Every rule
 * (single-use code, PKCE S256, rotation, reuse revokes the grant) is in
 * handleTokenRequest, src/lib/mcp/oauth.ts.
 *
 *   200  { access_token, token_type: 'Bearer', expires_in, refresh_token, scope }
 *   400  { error, error_description } per RFC 6749 §5.2: invalid_request,
 *        invalid_client, invalid_grant, unsupported_grant_type (also
 *        invalid_target and invalid_scope)
 *   413  body over 16 KiB
 * Every answer carries `Cache-Control: no-store`.
 *
 * SECURITY: no session and no cookie is read here: the code or the refresh
 * token is the credential. Parameters in the URL are refused (a secret must
 * never sit in a query string). Nothing of the request is logged.
 *
 * No rate limit per address on purpose: the calls of claude.ai come from
 * Anthropic's shared range, so anyone with a Claude account could use up the
 * allowance of that address and block the renewals of the real connection.
 * The secrets are 256 random bits; guessing is not a risk.
 */
import { NextRequest } from 'next/server'
import { handleTokenRequest } from '@/lib/mcp/oauth'
import { jsonNoStore, oauthErrorResponse, readFormBody } from '../_lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const form = await readFormBody(request)
    return jsonNoStore(await handleTokenRequest(form))
  } catch (e) {
    return oauthErrorResponse(e, 'oauth/token')
  }
}
