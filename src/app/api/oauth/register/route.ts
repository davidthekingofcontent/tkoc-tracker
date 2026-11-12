/**
 * POST /api/oauth/register
 *
 * Dynamic client registration (RFC 7591) of the MCP connector for Claude.
 * Public endpoint: Claude registers itself before sending the user to the
 * consent screen. Public clients only, and only Claude's two callbacks or a
 * loopback URL as redirect URI. All of that is decided by registerClient in
 * src/lib/mcp/oauth.ts; this handler only reads the body and answers.
 *
 *   201  the registered client (RFC 7591 §3.2.1), never cached
 *   400  invalid_redirect_uri / invalid_client_metadata
 *   413  body over 16 KiB
 *   415  body that is not application/json
 *   429  more than 10 registrations per hour from one address (Anthropic's
 *        egress range, from which claude.ai registers, shares one allowance
 *        of 300 per hour: see CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT)
 *   503  the table is full of clients that are in use
 *
 * The rate limit lives inside registerClient (the route must not limit
 * again). A body that is not valid JSON is still handed to it, as null, so
 * the attempt counts against the limit before it is refused.
 */
import { NextRequest } from 'next/server'
import { clientIp } from '@/lib/rate-limiter'
import { OAuthError, registerClient } from '@/lib/mcp/oauth'
import { jsonNoStore, mediaType, oauthErrorResponse, readBodyText } from '../_lib/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    if (mediaType(request) !== 'application/json') {
      throw new OAuthError('invalid_client_metadata', 'The body must be application/json', 415)
    }
    const text = await readBodyText(request)
    if (text === null) throw new OAuthError('invalid_client_metadata', 'The request body is too large', 413)

    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON: registerClient counts the attempt and refuses it (400)
    }
    const client = await registerClient(body, clientIp(request.headers))
    return jsonNoStore(client, 201)
  } catch (e) {
    return oauthErrorResponse(e, 'oauth/register')
  }
}
