import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import. NEXT_PUBLIC_APP_URL holds the OTHER address production
// answers on (the Railway domain, src/app/api/data-deletion/route.ts): it must
// not be able to move the address the connector announces, and the SDK client
// below refuses to connect if it did. The consent page is a server component:
// its two server-only inputs are replaced by a cookie jar and by a redirect
// that can be caught, as in mcp-e2e.test.ts. Everything else is the real code.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-not-used-anywhere-else'
  process.env.NEXT_PUBLIC_APP_URL = 'https://tkoc-tracker-production.up.railway.app'
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY

  class Redirected extends Error {
    readonly url: string
    constructor(url: string) {
      super(`redirect to ${url}`)
      this.url = url
    }
  }
  return { Redirected, pageCookie: { token: undefined as string | undefined } }
})

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'token' && h.pageCookie.token !== undefined ? { name, value: h.pageCookie.token } : undefined),
  }),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new h.Redirected(url)
  },
}))

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  UnauthorizedError,
  discoverAuthorizationServerMetadata,
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { middleware } from '@/middleware'
import AuthorizePage from '@/app/oauth/authorize/page'
import * as loginRoute from '@/app/api/auth/login/route'
import * as mcpRoute from '@/app/api/mcp/route'
import * as protectedResourceRoute from '@/app/.well-known/oauth-protected-resource/route'
import * as protectedResourcePathRoute from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import * as authorizationServerRoute from '@/app/.well-known/oauth-authorization-server/route'
import * as registerRoute from '@/app/api/oauth/register/route'
import * as decisionRoute from '@/app/api/oauth/authorize/route'
import * as tokenRoute from '@/app/api/oauth/token/route'
import { WRITE_TOOLS } from '@/lib/mcp/tools/write'

/**
 * The connection made by the MCP SDK's OWN client, the code Claude Code runs:
 * Client + StreamableHTTPClientTransport + auth(), with their own schemas for
 * every document and answer, their own check that the announced resource is
 * the address that was typed (checkResourceAllowed), their own choice of scope
 * and their own renewal on a 401. mcp-e2e.test.ts walks the same path with a
 * hand-written client; this one fails when the SDK and the server disagree.
 *
 * The only thing replaced is the network: the transport's `fetch` hands every
 * request to the real middleware and then to the real route handler of its
 * path. The person's part (login, consent screen, «Permitir») is done by the
 * test, as a browser would.
 */

const TYPED_IN_CLAUDE = 'https://intelligence.thekingofcontent.agency/api/mcp'
const SITE = new URL(TYPED_IN_CLAUDE).origin
/** Where Claude Code listens for the answer of the authorization (a loopback port it picked). */
const LOOPBACK = 'http://localhost:51987/callback'

// ---------- the site: real middleware, then the real handler of the path ----------

type Handler = (request: NextRequest) => Response | Promise<Response>
const ROUTES: Record<string, Handler> = {
  'POST /api/mcp': request => mcpRoute.POST(request),
  'GET /api/mcp': () => mcpRoute.GET(),
  'DELETE /api/mcp': () => mcpRoute.DELETE(),
  'GET /.well-known/oauth-protected-resource': () => protectedResourceRoute.GET(),
  'GET /.well-known/oauth-protected-resource/api/mcp': () => protectedResourcePathRoute.GET(),
  'GET /.well-known/oauth-authorization-server': () => authorizationServerRoute.GET(),
  'POST /api/oauth/register': request => registerRoute.POST(request),
  'POST /api/oauth/authorize': request => decisionRoute.POST(request),
  'POST /api/oauth/token': request => tokenRoute.POST(request),
  'POST /api/auth/login': request => loginRoute.POST(request),
}

/** Every request that reached the site, as `METHOD path`. */
const seen: string[] = []

async function site(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const target = new URL(url)
  if (target.origin !== SITE) throw new Error(`the client left the platform: ${target.href}`)
  seen.push(`${method} ${target.pathname}`)
  const request = () => new NextRequest(target, { method, headers: init.headers, body: init.body })
  const gate = middleware(request())
  if (gate.headers.get('x-middleware-next') !== '1') return gate
  const handler = ROUTES[`${method} ${target.pathname}`]
  // A path the platform does not serve answers as Next would
  if (!handler) return new Response('Not Found', { status: 404 })
  return handler(request())
}

/** What the SDK gets as `fetch`: the same Request it built, delivered to `site`. */
const siteFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const req = new Request(input, init)
  const headers: Record<string, string> = {}
  req.headers.forEach((value, name) => {
    headers[name] = value
  })
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()
  return site(req.method, req.url, { headers, body: body || undefined })
}

// ---------- what Claude Code keeps between requests ----------

/** An OAuthClientProvider that keeps everything in memory and hands the authorization URL to the test. */
class TestProvider implements OAuthClientProvider {
  client?: OAuthClientInformationMixed
  saved?: OAuthTokens
  verifier = ''
  authorizationUrl?: URL
  readonly fixedState = `state-${randomUUID()}`

  get redirectUrl() {
    return LOOPBACK
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Claude Code',
      redirect_uris: [LOOPBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  state() {
    return this.fixedState
  }
  clientInformation() {
    return this.client
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.client = info
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

const newTransport = (provider: TestProvider) =>
  new StreamableHTTPClientTransport(new URL(TYPED_IN_CLAUDE), { authProvider: provider, fetch: siteFetch })
const newClient = () => new Client({ name: 'claude-code', version: '2.0.0' })

// ---------- the administrator's browser ----------

const decodeEntities = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const attribute = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? decodeEntities(m[1]) : null
}

/** Opens the authorization URL signed in, presses «Permitir» and returns where the browser is sent. */
async function approveInBrowser(authorizationUrl: URL, cookie: string): Promise<URL> {
  expect(authorizationUrl.origin).toBe(SITE)
  const gate = middleware(new NextRequest(authorizationUrl, { headers: { cookie } }))
  expect(gate.headers.get('x-middleware-next')).toBe('1')
  const searchParams: Record<string, string | string[]> = {}
  for (const name of new Set(authorizationUrl.searchParams.keys())) {
    const values = authorizationUrl.searchParams.getAll(name)
    searchParams[name] = values.length === 1 ? values[0] : values
  }
  h.pageCookie.token = /(?:^|;\s*)token=([^;]+)/.exec(cookie)?.[1]
  let html: string
  try {
    html = renderToStaticMarkup(await AuthorizePage({ searchParams: Promise.resolve(searchParams) }))
  } finally {
    h.pageCookie.token = undefined
  }
  const form = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [])[0] ?? ''
  expect(form, 'the consent screen has its form').not.toBe('')
  const action = attribute(/<form\b[^>]*>/.exec(form)?.[0] ?? '', 'action') as string
  const fields: Record<string, string> = {}
  for (const tag of form.match(/<input\b[^>]*>/g) ?? []) fields[attribute(tag, 'name') as string] = attribute(tag, 'value') as string
  const permitir = [...form.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(m => decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim() === 'Permitir')
  expect(permitir).toBeDefined()
  fields[attribute(permitir![1], 'name') as string] = attribute(permitir![1], 'value') as string

  const decision = await site('POST', new URL(action, SITE).href, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: SITE, 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams(fields).toString(),
  })
  expect(decision.status).toBe(303)
  return new URL(decision.headers.get('location') as string)
}

// ---------- invented data ----------

const PASSWORD = `clave-inventada-${randomUUID()}`
const made = { userIds: [] as string[], campaignId: '' }
let admin: { id: string; email: string }

beforeAll(async () => {
  // Nothing may reach the network: the SDK only gets `siteFetch`
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  const tag = randomUUID().slice(0, 8)
  admin = await prisma.user.create({
    data: { email: `admin-sdk-${tag}@correo-inventado.test`, password: await hashPassword(PASSWORD), name: 'Administradora SDK', role: 'ADMIN' },
    select: { id: true, email: true },
  })
  made.userIds.push(admin.id)
  const campaign = await prisma.campaign.create({
    data: { name: `Campaña SDK ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], userId: admin.id },
  })
  made.campaignId = campaign.id
})

afterAll(async () => {
  vi.unstubAllGlobals()
  const grants = await prisma.mcpGrant.findMany({ where: { userId: { in: made.userIds } }, select: { id: true, clientId: true } })
  const grantIds = grants.map(g => g.id)
  await prisma.mcpCallLog.deleteMany({ where: { grantId: { in: grantIds } } })
  await prisma.mcpToken.deleteMany({ where: { grantId: { in: grantIds } } })
  await prisma.mcpAuthCode.deleteMany({ where: { userId: { in: made.userIds } } })
  await prisma.mcpGrant.deleteMany({ where: { id: { in: grantIds } } })
  await prisma.mcpClient.deleteMany({ where: { clientId: { in: grants.map(g => g.clientId) } } })
  await prisma.mcpClient.deleteMany({ where: { redirectUris: { has: LOOPBACK } } })
  if (made.campaignId) await prisma.campaign.deleteMany({ where: { id: made.campaignId } })
  await prisma.user.deleteMany({ where: { id: { in: made.userIds } } })
})

const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { type: string; text: string }[])[0].text
const expireAccessTokens = (grantId: string) =>
  prisma.mcpToken.updateMany({ where: { grantId, kind: 'access' }, data: { expiresAt: new Date(Date.now() - 1000) } })

describe('the MCP SDK client (what Claude Code runs) against the real routes', () => {
  it('connects, reads, renews on a 401, and two renewals at once with one refresh token keep the connection', async () => {
    const provider = new TestProvider()

    // ===== 1. The first connection: 401, discovery, registration, and the browser is needed =====
    const first = newTransport(provider)
    await expect(newClient().connect(first)).rejects.toBeInstanceOf(UnauthorizedError)
    // The SDK accepted every document: it registered and built the authorization URL
    expect(provider.client?.client_id).toEqual(expect.any(String))
    const authorizationUrl = provider.authorizationUrl as URL
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${SITE}/oauth/authorize`)
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: provider.client?.client_id,
      redirect_uri: LOOPBACK,
      code_challenge_method: 'S256',
      state: provider.fixedState,
      // The SDK asks for every scope the metadata announces
      scope: 'tkoc.read tkoc.write',
      // checkResourceAllowed passed: the resource announced is the address typed, to the letter
      resource: TYPED_IN_CLAUDE,
    })
    expect(seen).toEqual(expect.arrayContaining([
      'POST /api/mcp',
      'GET /.well-known/oauth-protected-resource',
      'GET /.well-known/oauth-authorization-server',
      'POST /api/oauth/register',
    ]))

    // ===== 2. The administrator signs in and presses «Permitir» =====
    const login = await site('POST', `${SITE}/api/auth/login`, {
      headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.9-${randomUUID().slice(0, 8)}` },
      body: JSON.stringify({ email: admin.email, password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const callback = await approveInBrowser(authorizationUrl, cookie)
    expect(callback.origin + callback.pathname).toBe(LOOPBACK)
    expect(callback.searchParams.get('state')).toBe(provider.fixedState)
    expect(callback.searchParams.get('iss')).toBe(SITE)

    // ===== 3. Claude Code receives the code and the SDK exchanges it =====
    await first.finishAuth(callback.searchParams.get('code') as string)
    expect(provider.saved).toMatchObject({ token_type: expect.stringMatching(/^bearer$/i), scope: 'tkoc.read tkoc.write', refresh_token: expect.any(String) })
    const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { userId: admin.id, revokedAt: null } })
    expect(grant.resource).toBe(TYPED_IN_CLAUDE)

    // ===== 4. Connected: initialize, tools/list, a tool call =====
    const client = newClient()
    await client.connect(newTransport(provider))
    expect(client.getServerVersion()).toMatchObject({ name: 'tkoc-intelligence' })
    const { tools } = await client.listTools()
    // The SDK client accepts every tool the server announces: the eight read tools, then the write tools
    expect(tools.map(t => t.name)).toEqual([
      'list_campaigns', 'get_campaign', 'list_campaign_creators', 'list_campaign_media',
      'find_creator', 'get_creator', 'capture_status', 'explain_missing_post',
      ...WRITE_TOOLS.map(t => t.name),
    ])
    const listed = await client.callTool({ name: 'list_campaigns', arguments: { status: 'ACTIVE', limit: 200 } })
    expect(listed.isError ?? false).toBe(false)
    expect((JSON.parse(textOf(listed)) as { campaigns: { items: { id: string }[] } }).campaigns.items.map(c => c.id)).toContain(made.campaignId)

    // ===== 5. The access token expires: the SDK renews on the 401 by itself =====
    const firstRefresh = provider.saved?.refresh_token
    await expireAccessTokens(grant.id)
    const afterRenewal = await client.callTool({ name: 'get_campaign', arguments: { campaignId: made.campaignId } })
    expect(afterRenewal.isError ?? false).toBe(false)
    expect(provider.saved?.refresh_token).not.toBe(firstRefresh)

    // ===== 6. Two renewals at once with the same refresh token (two conversations hit the expiry together) =====
    const metadata = await discoverAuthorizationServerMetadata(SITE, { fetchFn: siteFetch })
    const shared = provider.saved?.refresh_token as string
    const renew = () =>
      refreshAuthorization(SITE, {
        metadata,
        clientInformation: provider.client as OAuthClientInformationMixed,
        refreshToken: shared,
        resource: new URL(TYPED_IN_CLAUDE),
        fetchFn: siteFetch,
      })
    const both = await Promise.allSettled([renew(), renew()])
    expect(both.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt).toBe(null)
    // The client keeps whichever answer arrived last (stamped as the SDK stamps what it stores), and goes on with it
    provider.saveTokens({ ...(both[1] as PromiseFulfilledResult<OAuthTokens>).value, issuer: provider.saved?.issuer })
    await expireAccessTokens(grant.id)
    const afterBoth = await client.callTool({ name: 'capture_status', arguments: {} })
    expect(afterBoth.isError ?? false).toBe(false)

    // ===== 7. And a second client of the same connection, both renewing on their own 401 at once =====
    const other = newClient()
    await other.connect(newTransport(provider))
    await expireAccessTokens(grant.id)
    const together = await Promise.all([
      client.callTool({ name: 'list_campaigns', arguments: { limit: 1 } }),
      other.callTool({ name: 'list_campaigns', arguments: { limit: 1 } }),
    ])
    for (const result of together) expect(result.isError ?? false).toBe(false)
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt).toBe(null)
    expect((await client.callTool({ name: 'list_campaigns', arguments: { limit: 1 } })).isError ?? false).toBe(false)

    await client.close()
    await other.close()
    // Every request went to the platform through siteFetch, none to the network
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
