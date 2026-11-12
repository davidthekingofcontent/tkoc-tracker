import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions and consent tokens, no
// address in the environment (every URL is built from the production one) and
// no Apify token. The consent page is a server component: its two server-only
// inputs are replaced by a browser of this test (a cookie jar) and by a
// redirect that can be caught. Everything else is the real code.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY

  /** What redirect() of next/navigation does in a server component: it never returns. */
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

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { middleware } from '@/middleware'
import { safeNextPath } from '@/app/(auth)/login/safe-next'
import AuthorizePage from '@/app/oauth/authorize/page'
import * as loginRoute from '@/app/api/auth/login/route'
import * as mcpRoute from '@/app/api/mcp/route'
import * as protectedResourceRoute from '@/app/.well-known/oauth-protected-resource/route'
import * as protectedResourcePathRoute from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import * as authorizationServerRoute from '@/app/.well-known/oauth-authorization-server/route'
import * as registerRoute from '@/app/api/oauth/register/route'
import * as decisionRoute from '@/app/api/oauth/authorize/route'
import * as tokenRoute from '@/app/api/oauth/token/route'
import * as grantsRoute from '@/app/api/oauth/grants/route'

/**
 * The WHOLE path a Claude client walks to connect to TKOC Intelligence, in
 * the order it walks it, with nothing but what each step hands to the next:
 *
 *   POST /api/mcp without a token → 401 and the header → the document the
 *   header names → the authorization server's document → registration → the
 *   authorization URL with PKCE → the administrator's browser (login, consent
 *   screen, «Permitir») → the code → tokens → initialize → tools/list → a tool
 *   call → renewal → another tool call.
 *
 * There is no server here. `site` stands in for it: every request goes
 * through the real middleware and then to the real route handler of its path
 * (the table below is the route list of `next build`). The client of this test
 * knows ONE thing beforehand, the address a person types in Claude. Every
 * other URL it uses is read from an answer.
 *
 * The other db tests look at each rule on its own (who may approve, what a
 * wrong verifier does, reuse of a refresh token, revocation). This one fails
 * when the pieces do not fit together.
 */

/** The only thing the person gives Claude. */
const TYPED_IN_CLAUDE = 'https://intelligence.thekingofcontent.agency/api/mcp'
const SITE = new URL(TYPED_IN_CLAUDE).origin
/** Where Claude's servers receive the answer of the authorization. */
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

// ---------- the site: real middleware, then the real handler of the path ----------

type Handler = (request: NextRequest) => Response | Promise<Response>
/** Method and path → handler. The same pairs `next build` lists for the connector. */
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
  'GET /api/oauth/grants': request => grantsRoute.GET(request),
  'POST /api/auth/login': request => loginRoute.POST(request),
}

const passedMiddleware = (res: Response) => res.headers.get('x-middleware-next') === '1'

/** One HTTP request to the platform. A URL of any other site is a bug of the flow and fails the test. */
async function site(method: string, url: string | URL, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const target = new URL(url)
  expect(target.origin, `the flow left the platform: ${target.href}`).toBe(SITE)
  const request = () => new NextRequest(target, { method, headers: init.headers, body: init.body })
  const gate = middleware(request())
  if (!passedMiddleware(gate)) return gate
  const handler = ROUTES[`${method} ${target.pathname}`]
  expect(handler, `no route for ${method} ${target.pathname}`).toBeTypeOf('function')
  return handler(request())
}

const getJson = async (url: string | URL) => {
  const res = await site('GET', url)
  expect(res.status, String(url)).toBe(200)
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  return (await res.json()) as Record<string, unknown>
}

// ---------- the administrator's browser ----------

type PageResult = { kind: 'redirect'; by: 'middleware' | 'page'; location: string } | { kind: 'page'; html: string; headers: Headers }

/**
 * A navigation to a page of the platform. The middleware decides first; the
 * page is only rendered when it lets the request through, with the cookie the
 * browser sent and the query as the App Router hands it to a page.
 */
async function browserOpens(url: string | URL, cookie: string | null): Promise<PageResult> {
  const target = new URL(url)
  expect(target.origin, `the browser was sent outside the platform: ${target.href}`).toBe(SITE)
  expect(target.pathname).toBe('/oauth/authorize')
  const gate = middleware(new NextRequest(target, { headers: cookie ? { cookie } : {} }))
  if (!passedMiddleware(gate)) {
    expect(gate.status).toBe(307)
    return { kind: 'redirect', by: 'middleware', location: gate.headers.get('location') as string }
  }
  const searchParams: Record<string, string | string[]> = {}
  for (const name of new Set(target.searchParams.keys())) {
    const values = target.searchParams.getAll(name)
    searchParams[name] = values.length === 1 ? values[0] : values
  }
  h.pageCookie.token = cookie ? /(?:^|;\s*)token=([^;]+)/.exec(cookie)?.[1] : undefined
  try {
    const element = await AuthorizePage({ searchParams: Promise.resolve(searchParams) })
    return { kind: 'page', html: renderToStaticMarkup(element), headers: gate.headers }
  } catch (e) {
    if (e instanceof h.Redirected) return { kind: 'redirect', by: 'page', location: e.url }
    throw e
  } finally {
    h.pageCookie.token = undefined
  }
}

const decodeEntities = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const attribute = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? decodeEntities(m[1]) : null
}

/** The one form of the consent screen, read as a browser reads it. */
function consentForm(html: string) {
  const forms: string[] = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? []
  expect(forms).toHaveLength(1)
  const formHtml = forms[0] ?? ''
  const open = /<form\b[^>]*>/.exec(formHtml)?.[0] ?? ''
  const fields = (formHtml.match(/<input\b[^>]*>/g) ?? []).map(tag => ({ name: attribute(tag, 'name'), value: attribute(tag, 'value'), type: attribute(tag, 'type') }))
  const buttons = [...formHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
    label: decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim(),
    name: attribute(m[1], 'name'),
    value: attribute(m[1], 'value'),
    type: attribute(m[1], 'type'),
  }))
  return { method: attribute(open, 'method'), action: attribute(open, 'action'), fields, buttons }
}

// ---------- small helpers of a client ----------

const base64url = (bytes: Buffer) => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

interface Tokens {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}
interface RpcAnswer {
  jsonrpc: string
  id: number
  result?: Record<string, unknown>
  error?: unknown
}
interface ToolResult {
  isError?: boolean
  content: { type: string; text: string }[]
}

let rpcId = 0
/** One JSON-RPC message to the address typed in Claude, the way a Streamable HTTP client sends it. */
function mcp(accessToken: string | null, message: Record<string, unknown>, protocolVersion?: string) {
  return site('POST', TYPED_IN_CLAUDE, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  })
}
const rpc = (method: string, params?: unknown) => ({ id: ++rpcId, method, ...(params === undefined ? {} : { params }) })
const INITIALIZE = { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } }

// ---------- invented data ----------

const PASSWORD = `clave-inventada-${randomUUID()}`
/** Values that exist in the fixtures and must never travel: contact data always, money unless asked for. */
const NEVER = { email: `creadora-e2e-${randomUUID()}@correo-inventado.test`, phone: '+34600123999', notes: 'NOTA-E2E-NO-DEBE-SALIR', caption: 'CAPTION-E2E-NO-DEBE-SALIR' }
const MONEY = { fee: 4321.98, budget: 54321.76 }

const made = { userIds: [] as string[], campaignId: '', influencerId: '', clientIds: [] as string[], grantIds: [] as string[] }
let admin: { id: string; email: string; name: string }

beforeAll(async () => {
  // Any attempt to reach the network fails the step that made it
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))

  const tag = randomUUID().slice(0, 8)
  admin = await prisma.user.create({
    data: { email: `admin-e2e-${tag}@correo-inventado.test`, password: await hashPassword(PASSWORD), name: 'Administradora de Prueba', role: 'ADMIN' },
    select: { id: true, email: true, name: true },
  })
  made.userIds.push(admin.id)

  const campaign = await prisma.campaign.create({
    data: {
      name: `Campaña E2E ${tag}`,
      status: 'ACTIVE',
      type: 'INFLUENCER_TRACKING',
      platforms: ['INSTAGRAM'],
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T00:00:00.000Z'),
      budget: MONEY.budget,
      targetAccounts: ['marcae2e'],
      userId: admin.id,
    },
  })
  made.campaignId = campaign.id
  const creator = await prisma.influencer.create({
    data: { username: `creadora_e2e_${tag}`, platform: 'INSTAGRAM', displayName: 'Creadora de Prueba', followers: 12000, email: NEVER.email, phone: NEVER.phone },
  })
  made.influencerId = creator.id
  await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: creator.id, status: 'POSTED', agreedFee: MONEY.fee, notes: NEVER.notes },
  })
  await prisma.media.create({
    data: {
      campaignId: campaign.id, influencerId: creator.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `39${Date.now()}`,
      permalink: `https://www.instagram.com/reel/DE2e${tag}/`, caption: `${NEVER.caption} con @marcae2e`, mentions: ['marcae2e'], hashtags: [],
      likes: 120, comments: 8, shares: 2, saves: 5, views: 3400, postedAt: new Date('2026-10-06T10:00:00.000Z'), source: 'apify',
    },
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.mcpCallLog.deleteMany({ where: { grantId: { in: made.grantIds } } })
  await prisma.mcpToken.deleteMany({ where: { grantId: { in: made.grantIds } } })
  await prisma.mcpAuthCode.deleteMany({ where: { clientId: { in: made.clientIds } } })
  await prisma.mcpGrant.deleteMany({ where: { clientId: { in: made.clientIds } } })
  await prisma.mcpClient.deleteMany({ where: { clientId: { in: made.clientIds } } })
  if (made.campaignId) await prisma.campaign.deleteMany({ where: { id: made.campaignId } }) // membership and media go with it
  if (made.influencerId) await prisma.influencer.deleteMany({ where: { id: made.influencerId } })
  await prisma.user.deleteMany({ where: { id: { in: made.userIds } } })
})

describe('end to end: a Claude client connects and reads, from the first 401 to a call after the renewal', () => {
  it('walks the whole path with only what each step hands to the next', async () => {
    // ===== 1. Claude calls the address the person typed. Nobody has signed in =====
    const first = await mcp(null, rpc('initialize', INITIALIZE))
    expect(first.status).toBe(401)
    const challenge = first.headers.get('www-authenticate') ?? ''
    expect(challenge).toMatch(/^Bearer /)
    const named = /resource_metadata="([^"]+)"/.exec(challenge)
    expect(named, 'the 401 must say where the metadata is').not.toBeNull()
    const resourceMetadataUrl = (named as RegExpExecArray)[1]

    // ===== 2. The protected-resource metadata the header names (RFC 9728) =====
    const resource = await getJson(resourceMetadataUrl)
    // Claude refuses the connection unless this is, to the letter, the address that was typed
    expect(resource.resource).toBe(TYPED_IN_CLAUDE)
    expect(resource.bearer_methods_supported).toEqual(['header'])
    const issuer = (resource.authorization_servers as string[])[0]
    expect(issuer).toBe(SITE)
    // The path-specific location some clients try first answers the very same document
    expect(await getJson(`${SITE}/.well-known/oauth-protected-resource${new URL(TYPED_IN_CLAUDE).pathname}`)).toEqual(resource)

    // ===== 3. The authorization server's metadata (RFC 8414), found from the issuer =====
    const server = await getJson(new URL('/.well-known/oauth-authorization-server', issuer))
    expect(server.issuer).toBe(issuer)
    expect(server.code_challenge_methods_supported).toEqual(['S256'])
    expect(server.token_endpoint_auth_methods_supported).toContain('none')
    expect(server.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']))
    expect(server.authorization_response_iss_parameter_supported).toBe(true)
    // Not advertised, so Claude registers itself dynamically
    expect(server).not.toHaveProperty('client_id_metadata_document_supported')
    const endpoints = {
      registration: server.registration_endpoint as string,
      authorization: server.authorization_endpoint as string,
      token: server.token_endpoint as string,
    }
    const scope = (resource.scopes_supported as string[]).join(' ')

    // ===== 4. Dynamic client registration (RFC 7591) =====
    const registration = await site('POST', endpoints.registration, {
      headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.7-${randomUUID().slice(0, 8)}` },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope,
      }),
    })
    expect(registration.status).toBe(201)
    const client = (await registration.json()) as { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string; client_secret?: string }
    made.clientIds.push(client.client_id)
    expect(client.redirect_uris).toEqual([CLAUDE_CALLBACK])
    expect(client.token_endpoint_auth_method).toBe('none')
    expect(client.client_secret).toBeUndefined()

    // ===== 5. The authorization URL, with PKCE (the challenge is computed here, not by our code) =====
    const codeVerifier = base64url(randomBytes(32))
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
    const state = base64url(randomBytes(16))
    const authorizeUrl = new URL(endpoints.authorization)
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope,
      resource: TYPED_IN_CLAUDE,
    })) authorizeUrl.searchParams.set(name, value)

    // ===== 6. The administrator's browser opens that URL =====
    // 6a. Without a session: to the login, which knows the way back
    const anonymous = await browserOpens(authorizeUrl, null)
    // The middleware answers: no code of the page runs for a visitor without a cookie
    expect(anonymous).toMatchObject({ kind: 'redirect', by: 'middleware' })
    const toLogin = new URL((anonymous as { location: string }).location, SITE)
    expect(toLogin.pathname).toBe('/login')
    const back = safeNextPath(toLogin.searchParams.get('next'))
    expect(back).toBe(authorizeUrl.pathname + authorizeUrl.search)

    // 6b. The real login: e-mail and password, and the cookie it sets
    const login = await site('POST', `${SITE}/api/auth/login`, {
      headers: { 'content-type': 'application/json', 'x-real-ip': `203.0.113.8-${randomUUID().slice(0, 8)}` },
      body: JSON.stringify({ email: admin.email, password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/^token=[^;]+;/)
    expect(setCookie.toLowerCase()).toContain('httponly')
    const cookie = setCookie.split(';')[0]

    // 6c. Back to the very same request, now signed in: the consent screen
    const screen = await browserOpens(new URL(back as string, SITE), cookie)
    expect(screen.kind).toBe('page')
    const { html, headers: pageHeaders } = screen as { html: string; headers: Headers }
    expect(pageHeaders.get('x-frame-options')).toBe('DENY')
    const text = decodeEntities(html.replace(/<[^>]*>/g, ' '))
    expect(text).toContain('Claude')
    expect(text).toContain(admin.name)
    expect(text).toContain('claude.ai')
    expect(text).toContain('Leer campañas, creadoras, publicaciones y el estado de la captura. No puede cambiar nada.')
    expect(text).toContain('No recibe correos, teléfonos, direcciones ni contraseñas.')
    const consent = consentForm(html)
    expect(consent.method).toBe('post')
    expect(consent.buttons.map(b => b.label)).toEqual(['Cancelar', 'Permitir'])
    // Rendering the screen grants nothing
    expect(await prisma.mcpGrant.count({ where: { clientId: client.client_id } })).toBe(0)

    // 6d. The person presses «Permitir»: the browser posts the form as it stands
    const permitir = consent.buttons.find(b => b.label === 'Permitir')
    expect(permitir?.type).toBe('submit')
    const posted: Record<string, string> = {}
    for (const field of consent.fields) posted[field.name as string] = field.value as string
    posted[permitir?.name as string] = permitir?.value as string
    const decision = await site('POST', new URL(consent.action as string, SITE), {
      headers: { ...FORM, cookie, origin: SITE, 'sec-fetch-site': 'same-origin' },
      body: form(posted),
    })
    expect(decision.status).toBe(303)
    const callback = new URL(decision.headers.get('location') as string)
    // The browser leaves the platform for Claude's callback and nowhere else
    expect(callback.origin + callback.pathname).toBe(CLAUDE_CALLBACK)
    expect([...callback.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state'])
    expect(callback.searchParams.get('state')).toBe(state)
    expect(callback.searchParams.get('iss')).toBe(issuer)
    const code = callback.searchParams.get('code') as string

    // ===== 7. Claude's servers exchange the code for tokens =====
    const exchange = await site('POST', endpoints.token, {
      headers: FORM,
      body: form({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: codeVerifier, redirect_uri: CLAUDE_CALLBACK, resource: TYPED_IN_CLAUDE }),
    })
    expect(exchange.status).toBe(200)
    expect(exchange.headers.get('cache-control')).toBe('no-store')
    const tokens = (await exchange.json()) as Tokens
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope })
    const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { clientId: client.client_id } })
    made.grantIds.push(grant.id)
    expect(grant).toMatchObject({ userId: admin.id, resource: TYPED_IN_CLAUDE, revokedAt: null })
    // Only hashes are stored
    const stored = await prisma.mcpToken.findMany({ where: { grantId: grant.id }, select: { kind: true, tokenHash: true } })
    expect(stored.map(t => `${t.kind}:${t.tokenHash}`).sort()).toEqual(
      [`access:${sha256Hex(tokens.access_token)}`, `refresh:${sha256Hex(tokens.refresh_token)}`].sort(),
    )

    // ===== 8. The same call as in step 1, now with the token: initialize =====
    const hello = await mcp(tokens.access_token, rpc('initialize', INITIALIZE))
    expect(hello.status).toBe(200)
    expect(hello.headers.get('mcp-session-id')).toBeNull() // stateless
    const initialized = ((await hello.json()) as RpcAnswer).result as { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown> }
    expect(initialized.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(initialized.serverInfo.name).toBe('tkoc-intelligence')
    expect(initialized.capabilities).toHaveProperty('tools')
    const version = initialized.protocolVersion
    const ready = await mcp(tokens.access_token, { method: 'notifications/initialized' }, version)
    expect(ready.status).toBe(202)

    // ===== 9. tools/list =====
    const listed = await mcp(tokens.access_token, rpc('tools/list'), version)
    expect(listed.status).toBe(200)
    const tools = (((await listed.json()) as RpcAnswer).result as { tools: { name: string; title?: string; inputSchema: { type: string }; annotations?: { readOnlyHint?: boolean } }[] }).tools
    expect(tools.map(t => t.name)).toEqual([
      'list_campaigns', 'get_campaign', 'list_campaign_creators', 'list_campaign_media',
      'find_creator', 'get_creator', 'capture_status', 'explain_missing_post',
    ])
    for (const tool of tools) {
      expect(tool.title, tool.name).toEqual(expect.any(String))
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true)
      expect(tool.inputSchema.type, tool.name).toBe('object')
    }

    // ===== 10. A tool call: the campaign of the fixtures is in the list =====
    const firstCall = await mcp(tokens.access_token, rpc('tools/call', { name: 'list_campaigns', arguments: { status: 'ACTIVE', limit: 200 } }), version)
    expect(firstCall.status).toBe(200)
    const campaigns = ((await firstCall.json()) as RpcAnswer).result as unknown as ToolResult
    expect(campaigns.isError ?? false).toBe(false)
    const listedCampaigns = JSON.parse(campaigns.content[0].text) as { campaigns: { items: { id: string; creators: number; pieces: number }[] } }
    expect(listedCampaigns.campaigns.items.find(c => c.id === made.campaignId)).toMatchObject({ creators: 1, pieces: 1 })

    // ===== 11. Renewal: a new pair of tokens =====
    const renewal = await site('POST', endpoints.token, {
      headers: FORM,
      body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id, resource: TYPED_IN_CLAUDE }),
    })
    expect(renewal.status).toBe(200)
    expect(renewal.headers.get('cache-control')).toBe('no-store')
    const renewed = (await renewal.json()) as Tokens
    expect(renewed).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope })
    expect(renewed.access_token).not.toBe(tokens.access_token)
    expect(renewed.refresh_token).not.toBe(tokens.refresh_token)

    // ===== 12. Another call, with the renewed token: the figures of that campaign =====
    const secondCall = await mcp(renewed.access_token, rpc('tools/call', { name: 'get_campaign', arguments: { campaignId: made.campaignId } }), version)
    expect(secondCall.status).toBe(200)
    const detail = ((await secondCall.json()) as RpcAnswer).result as unknown as ToolResult
    expect(detail.isError ?? false).toBe(false)
    const campaign = JSON.parse(detail.content[0].text) as {
      campaign: { id: string }
      brandTargets: { accounts: string[] }
      totals: { pieces: number; views: number; likes: number; creators: number }
      economicsIncluded: boolean
    }
    expect(campaign.campaign.id).toBe(made.campaignId)
    expect(campaign.brandTargets.accounts).toEqual(['marcae2e'])
    expect(campaign.totals).toMatchObject({ pieces: 1, views: 3400, likes: 120, creators: 1 })
    expect(campaign.economicsIncluded).toBe(false)
    // Nothing private and no money in anything the client received
    for (const answer of [campaigns.content[0].text, detail.content[0].text]) {
      for (const [what, value] of Object.entries(NEVER)) expect(answer, `leaked ${what}`).not.toContain(value)
      for (const [what, amount] of Object.entries(MONEY)) expect(answer, `leaked ${what}`).not.toContain(String(amount))
    }

    // ===== What the platform kept of all this =====
    // Each tool call is in the log, with its size and never its content
    const log = await prisma.mcpCallLog.findMany({ where: { grantId: grant.id }, orderBy: { createdAt: 'asc' } })
    expect(log.map(l => [l.tool, l.ok, l.userId])).toEqual([
      ['list_campaigns', true, admin.id],
      ['get_campaign', true, admin.id],
    ])
    expect(log[0].resultChars).toBe(campaigns.content[0].text.length)
    expect(log[1].resultChars).toBe(detail.content[0].text.length)
    expect(log[1].argsSummary).toContain(`campaignId=${made.campaignId}`)
    // And the administrator sees the connection in Ajustes, with names and no secret
    const card = await site('GET', `${SITE}/api/oauth/grants`, { headers: { cookie } })
    expect(card.status).toBe(200)
    const cardText = await card.text()
    const mine = (JSON.parse(cardText) as { grants: { id: string; clientName: string; userName: string; lastUsedAt: string | null }[] }).grants.filter(g => g.id === grant.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ clientName: 'Claude', userName: admin.name })
    expect(mine[0].lastUsedAt).toEqual(expect.any(String))
    for (const secret of [tokens.access_token, tokens.refresh_token, renewed.access_token, renewed.refresh_token, code, admin.email]) {
      expect(cardText).not.toContain(secret)
    }

    // The whole path, and not one request left the test
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})
