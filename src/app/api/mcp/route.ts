/**
 * /api/mcp — the MCP endpoint of TKOC Intelligence for Claude (Streamable
 * HTTP, stateless, JSON answers). This is the URL a person types in Claude.
 *
 *   POST    a JSON-RPC message (initialize, tools/list, tools/call, …)
 *   GET     405, `Allow: POST`  (no server-to-client stream is offered)
 *   DELETE  405, `Allow: POST`  (there is no session to end)
 *
 * Every POST, in this order:
 *   1. authenticateBearer (src/lib/mcp/oauth.ts): the access token in the
 *      `Authorization` header must exist, be alive, belong to a grant that is
 *      not revoked and whose administrator is still an active ADMIN. Anything
 *      else is a 401 with
 *      `WWW-Authenticate: Bearer resource_metadata="<APP_URL>/.well-known/oauth-protected-resource"`,
 *      which is how Claude finds where to sign in.
 *   2. The grant must carry the read scope (403 otherwise).
 *   3. allowRequest: 600 HTTP requests per 10 minutes per grant, of any kind,
 *      then 429. Only a client that misbehaves reaches it.
 *   4. A fresh McpServer and a fresh transport for this request only
 *      (src/lib/mcp/server.ts). Nothing is kept between requests. There,
 *      every tool call spends one of the grant's 120 tool calls per 10
 *      minutes; over that, the call is answered with a tool error the model
 *      can read, and initialize, tools/list and ping keep working.
 *
 * SECURITY
 *  - The token is the only credential. No cookie and no session is read, so a
 *    web page in a browser cannot ride on somebody's login (no CSRF surface),
 *    and no CORS header is sent: browsers are not clients of this endpoint.
 *  - A token in the URL is never looked at. Nothing of the request is logged:
 *    not the header, not the body, not the answer.
 *  - The body is not read here: the transport reads it once, with a size cap.
 *  - Who is calling is decided in step 1 and handed to the server. No message
 *    can change it.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { MCP_SCOPE, PROTECTED_RESOURCE_METADATA_URL } from '@/lib/mcp/config'
import { allowRequest, authenticateBearer } from '@/lib/mcp/oauth'
import { createMcpServer } from '@/lib/mcp/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A JSON-RPC message of this server is a few hundred bytes. The transport answers 413 above this. */
const MAX_BODY_BYTES = 256 * 1024
/** Seconds a client is told to wait after a 429. */
const RETRY_AFTER_SECONDS = 60

const NO_STORE = { 'Cache-Control': 'no-store' } as const

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

function methodNotAllowed(): Response {
  return json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This endpoint only accepts POST.' }, id: null },
    405,
    { Allow: 'POST' },
  )
}

export async function GET(): Promise<Response> {
  return methodNotAllowed()
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed()
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await authenticateBearer(request.headers.get('authorization'))
    if (!auth.ok) {
      return json(auth.body, auth.status, { 'WWW-Authenticate': auth.wwwAuthenticate })
    }
    if (!auth.grant.scope.split(' ').includes(MCP_SCOPE)) {
      return json({ error: 'insufficient_scope', error_description: `This connection lacks the ${MCP_SCOPE} scope` }, 403, {
        'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${MCP_SCOPE}", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
      })
    }
    if (!allowRequest(auth.grant.id)) {
      return json({ error: 'rate_limited', error_description: 'Too many requests for this connection. Try again in a few minutes.' }, 429, {
        'Retry-After': String(RETRY_AFTER_SECONDS),
      })
    }

    const scope = createMcpServer({ grantId: auth.grant.id, userId: auth.user.id })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no Mcp-Session-Id
      enableJsonResponse: true, // one JSON answer, no event stream
      maxRequestBodySize: MAX_BODY_BYTES,
    })
    // Before connect: the SDK chains a callback that is already set
    transport.onmessage = scope.observe
    try {
      await scope.server.connect(transport)
      const response = await transport.handleRequest(request)
      await scope.settle()
      response.headers.set('Cache-Control', 'no-store')
      return response
    } finally {
      await scope.server.close().catch(() => {})
    }
  } catch (err) {
    // Never a 401 here: a failure of ours must not make Claude drop a valid connection
    console.error('[MCP] request failed:', err instanceof Error ? err.message.slice(0, 500) : 'unknown error')
    return json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }, 500)
  }
}
