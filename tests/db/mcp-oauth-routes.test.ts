import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions and consent tokens, and no
// address in the environment so every URL is built from the default one.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { createHmac, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { MCP_RESOURCE, REFRESH_REUSE_LEEWAY_MS, WWW_AUTHENTICATE_BEARER } from '@/lib/mcp/config'
import { type ConsentFields, pkceChallengeS256, randomSecret, sha256Hex, signConsentToken } from '@/lib/mcp/crypto'
import { authenticateBearer, validateAuthorizeRequest } from '@/lib/mcp/oauth'
import { MCP_TOOLS } from '@/lib/mcp/tools'
import { CONSENT_FORM_ACTION, CONSENT_TOKEN_FIELD, DECISION_ALLOW, DECISION_DENY, DECISION_FIELD } from '@/components/mcp/consent-form'
import * as protectedResourceRoute from '@/app/.well-known/oauth-protected-resource/route'
import * as protectedResourcePathRoute from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import * as authorizationServerRoute from '@/app/.well-known/oauth-authorization-server/route'
import * as registerRoute from '@/app/api/oauth/register/route'
import * as decisionRoute from '@/app/api/oauth/authorize/route'
import * as tokenRoute from '@/app/api/oauth/token/route'
import * as revokeRoute from '@/app/api/oauth/revoke/route'
import * as grantsRoute from '@/app/api/oauth/grants/route'
import * as grantRoute from '@/app/api/oauth/grants/[id]/route'
import { middleware } from '@/middleware'
import { safeNextPath } from '@/app/(auth)/login/safe-next'

/**
 * The OAuth HTTP surface of the MCP connector, with the route handlers called
 * directly (no server). Sessions are REAL ones: a JWT signed like the login
 * does, sent in the `token` cookie, checked by the handlers against the
 * throwaway database. Nothing about the session is mocked.
 */

const ISS = 'https://intelligence.thekingofcontent.agency'
const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
// Every request arrives addressed to a host that is not ours: nothing in any
// answer may ever be built from it
const HOSTILE = 'https://evil.example'
const MINUTE = 60 * 1000
const NO_STORE = 'no-store'

type Role = 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR'
interface TestUser {
  id: string
  email: string
  name: string
  role: string
}
interface Tokens {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

const userIds: string[] = []
let ipCounter = 0
/** A fresh address per registration, so the per-address rate limit never interferes. */
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}-${randomUUID().slice(0, 8)}`

async function makeUser(role: Role, name = `Test ${role}`): Promise<TestUser> {
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${randomUUID()}@test.invalid`, password: 'not-a-real-hash', name, role },
  })
  userIds.push(user.id)
  return user
}

/** The cookie a browser sends after logging in as this user. */
const sessionCookie = (user: { id: string; role: string }) => `token=${generateToken(user.id, user.role)}`

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`${HOSTILE}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', origin: HOSTILE, ...init.headers },
    body: init.body,
  })
}

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const formPost = (path: string, fields: Record<string, string> | string, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: typeof fields === 'string' ? fields : new URLSearchParams(fields).toString(),
  })

const register = (body: unknown, headers: Record<string, string> = {}) =>
  registerRoute.POST(jsonPost('/api/oauth/register', body, { 'x-real-ip': nextIp(), ...headers }))

async function registered(body: Record<string, unknown> = { client_name: 'Claude', redirect_uris: [CLAUDE_AI] }) {
  const res = await register(body)
  expect(res.status).toBe(201)
  return (await res.json()) as { client_id: string; client_name: string; redirect_uris: string[] }
}

/**
 * What the consent page does when an administrator opens the authorization
 * URL: validate the request and sign a consent token for that person.
 */
async function consentFor(userId: string, clientId: string, over: Record<string, string | undefined> = {}) {
  const verifier = randomSecret()
  const validation = await validateAuthorizeRequest({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_AI,
    code_challenge: pkceChallengeS256(verifier),
    code_challenge_method: 'S256',
    state: 'state-123',
    resource: MCP_RESOURCE,
    ...over,
  })
  if (!validation.ok) throw new Error(`the authorization request was refused: ${validation.error}`)
  return { consent: signConsentToken({ userId, ...validation.request }), verifier, fields: { userId, ...validation.request } }
}

/** The browser posting the consent form. `cookie` null: nobody is signed in. */
const decide = (cookie: string | null, fields: Record<string, string> | string, headers: Record<string, string> = {}) =>
  decisionRoute.POST(formPost(CONSENT_FORM_ACTION, fields, { ...(cookie ? { cookie } : {}), ...headers }))

const allow = (consent: string) => ({ [CONSENT_TOKEN_FIELD]: consent, [DECISION_FIELD]: DECISION_ALLOW })
const deny = (consent: string) => ({ [CONSENT_TOKEN_FIELD]: consent, [DECISION_FIELD]: DECISION_DENY })

const token = (fields: Record<string, string> | string, headers: Record<string, string> = {}) =>
  tokenRoute.POST(formPost('/api/oauth/token', fields, headers))

const revoke = (fields: Record<string, string> | string) => revokeRoute.POST(formPost('/api/oauth/revoke', fields))

/** register → consent → «Permitir» → the code that came back in the redirect. */
async function approved(admin: TestUser) {
  const client = await registered()
  const { consent, verifier } = await consentFor(admin.id, client.client_id)
  const res = await decide(sessionCookie(admin), allow(consent))
  expect(res.status).toBe(303)
  const code = new URL(res.headers.get('location') as string).searchParams.get('code') as string
  const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { clientId: client.client_id } })
  return { clientId: client.client_id, grantId: grant.id, code, verifier }
}

/** The whole way to a working connection, through the routes only. */
async function connected(admin: TestUser) {
  const a = await approved(admin)
  const res = await token({ grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: CLAUDE_AI })
  expect(res.status).toBe(200)
  return { ...a, tokens: (await res.json()) as Tokens }
}

const bearer = (accessToken: string) => authenticateBearer(`Bearer ${accessToken}`)
const grantRow = (id: string) => prisma.mcpGrant.findUniqueOrThrow({ where: { id } })
/** As if that refresh token had been exchanged longer ago than the leeway: it comes back late. */
const exchangedLongAgo = (refreshToken: string) =>
  prisma.mcpToken.update({
    where: { tokenHash: sha256Hex(refreshToken) },
    data: { rotatedAt: new Date(Date.now() - REFRESH_REUSE_LEEWAY_MS - 1000) },
  })
const isJson = (res: Response) => expect(res.headers.get('content-type')).toMatch(/^application\/json/)

/** An error page of ours: HTML, never cached, never framed, and it sends the browser nowhere. */
async function expectErrorPage(res: Response, status: number, sentence: string) {
  expect(res.status).toBe(status)
  expect(res.headers.get('location')).toBe(null)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe(NO_STORE)
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  const html = await res.text()
  expect(html).toContain(sentence)
  return html
}

async function nothingGranted() {
  expect(await prisma.mcpGrant.count()).toBe(0)
  expect(await prisma.mcpAuthCode.count()).toBe(0)
  expect(await prisma.mcpToken.count()).toBe(0)
}

async function wipe() {
  await prisma.mcpCallLog.deleteMany()
  await prisma.mcpToken.deleteMany()
  await prisma.mcpAuthCode.deleteMany()
  await prisma.mcpGrant.deleteMany()
  await prisma.mcpClient.deleteMany()
}

beforeEach(wipe)

afterAll(async () => {
  await wipe()
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

// Sentences of the error page of the decision (src/app/api/oauth/authorize/route.ts)
const SESSION_EXPIRED = 'Tu sesión ha caducado. Inicia sesión en la plataforma y vuelve a conectar desde Claude.'
const ADMIN_ONLY = 'Solo un administrador puede conectar Claude con la plataforma.'
const SCREEN_EXPIRED = 'Esta pantalla ha caducado. Vuelve a Claude y conecta de nuevo.'
const INVALID = 'La solicitud no es válida. Vuelve a Claude y conecta de nuevo.'

describe('route files', () => {
  it('export only their own method, on the Node runtime and never prerendered', () => {
    // A method that is not exported is answered 405 by Next itself
    const routes: [Record<string, unknown>, string][] = [
      [protectedResourceRoute, 'GET'],
      [protectedResourcePathRoute, 'GET'],
      [authorizationServerRoute, 'GET'],
      [registerRoute, 'POST'],
      [decisionRoute, 'POST'],
      [tokenRoute, 'POST'],
      [revokeRoute, 'POST'],
      [grantsRoute, 'GET'],
      [grantRoute, 'DELETE'],
    ]
    for (const [mod, method] of routes) {
      expect(Object.keys(mod).sort()).toEqual([method, 'dynamic', 'runtime'].sort())
      expect(mod.runtime).toBe('nodejs')
      expect(mod.dynamic).toBe('force-dynamic')
    }
  })
})

describe('discovery documents', () => {
  it('protected resource metadata (RFC 9728) is the same exact document at both paths', async () => {
    for (const route of [protectedResourceRoute, protectedResourcePathRoute]) {
      const res = route.GET()
      expect(res.status).toBe(200)
      isJson(res)
      expect(await res.json()).toEqual({
        resource: `${ISS}/api/mcp`,
        authorization_servers: [ISS],
        scopes_supported: ['tkoc.read', 'tkoc.write'],
        bearer_methods_supported: ['header'],
        resource_name: 'TKOC Intelligence',
      })
    }
    // The document the 401 of /api/mcp points to is the one served here
    expect(WWW_AUTHENTICATE_BEARER).toBe(`Bearer resource_metadata="${ISS}/.well-known/oauth-protected-resource"`)
  })

  it('authorization server metadata (RFC 8414) names exactly the routes that exist', async () => {
    const res = authorizationServerRoute.GET()
    expect(res.status).toBe(200)
    isJson(res)
    expect(await res.json()).toEqual({
      issuer: ISS,
      authorization_endpoint: `${ISS}/oauth/authorize`,
      token_endpoint: `${ISS}/api/oauth/token`,
      registration_endpoint: `${ISS}/api/oauth/register`,
      revocation_endpoint: `${ISS}/api/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['tkoc.read', 'tkoc.write'],
      authorization_response_iss_parameter_supported: true,
    })
  })

  it('cannot be bent by the request: the handlers do not even receive one', () => {
    // No parameter at all: there is no Host, X-Forwarded-Host or Origin to read
    expect(protectedResourceRoute.GET.length).toBe(0)
    expect(protectedResourcePathRoute.GET.length).toBe(0)
    expect(authorizationServerRoute.GET.length).toBe(0)
  })
})

describe('POST /api/oauth/register', () => {
  it('registers a public client: 201, RFC 7591 body, never cached', async () => {
    const res = await register(
      { client_name: 'Claude', redirect_uris: [CLAUDE_AI], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      { 'x-real-ip': '203.0.113.7' },
    )
    expect(res.status).toBe(201)
    isJson(res)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const body = await res.json()
    expect(body).toEqual({
      client_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_id_issued_at: expect.any(Number),
      client_name: 'Claude',
      redirect_uris: [CLAUDE_AI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'tkoc.read tkoc.write',
    })
    expect(body).not.toHaveProperty('client_secret')
    const row = await prisma.mcpClient.findUniqueOrThrow({ where: { clientId: body.client_id } })
    expect(row).toMatchObject({ name: 'Claude', redirectUris: [CLAUDE_AI], createdFromIp: '203.0.113.7' })
  })

  it('refuses with the RFC error body and stores nothing', async () => {
    const cases: [unknown, number, string][] = [
      [{ redirect_uris: ['https://evil.example/cb'] }, 400, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://claude.ai.evil.com/api/mcp/auth_callback'] }, 400, 'invalid_redirect_uri'],
      [{ redirect_uris: [`${CLAUDE_AI}@evil.com`] }, 400, 'invalid_redirect_uri'],
      [{ client_name: 'x' }, 400, 'invalid_redirect_uri'],
      [{ redirect_uris: [CLAUDE_AI], token_endpoint_auth_method: 'client_secret_post' }, 400, 'invalid_client_metadata'],
      [{ redirect_uris: [CLAUDE_AI], grant_types: ['client_credentials'] }, 400, 'invalid_client_metadata'],
      [{ redirect_uris: [CLAUDE_AI], response_types: ['token'] }, 400, 'invalid_client_metadata'],
      ['{ this is not json', 400, 'invalid_client_metadata'],
      ['[]', 400, 'invalid_client_metadata'],
      ['', 400, 'invalid_client_metadata'],
    ]
    for (const [body, status, error] of cases) {
      const res = await register(body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      isJson(res)
      expect(res.headers.get('cache-control')).toBe(NO_STORE)
      const json = await res.json()
      expect(json).toEqual({ error, error_description: expect.any(String) })
      expect(JSON.stringify(json)).not.toContain('evil')
    }
    expect(await prisma.mcpClient.count()).toBe(0)
  })

  it('reads only a JSON body of reasonable size', async () => {
    const good = JSON.stringify({ redirect_uris: [CLAUDE_AI] })
    const asForm = await registerRoute.POST(formPost('/api/oauth/register', good, { 'x-real-ip': nextIp() }))
    expect(asForm.status).toBe(415)
    expect((await asForm.json()).error).toBe('invalid_client_metadata')
    const noType = await registerRoute.POST(request('/api/oauth/register', { method: 'POST', body: good, headers: { 'x-real-ip': nextIp(), 'content-type': 'text/plain' } }))
    expect(noType.status).toBe(415)

    const huge = JSON.stringify({ redirect_uris: [CLAUDE_AI], client_name: 'x'.repeat(17 * 1024) })
    const tooBig = await register(huge)
    expect(tooBig.status).toBe(413)
    expect((await tooBig.json()).error).toBe('invalid_client_metadata')
    expect(await prisma.mcpClient.count()).toBe(0)

    // The usual header of a JSON request is accepted
    const withCharset = await register(good, { 'content-type': 'application/json; charset=utf-8' })
    expect(withCharset.status).toBe(201)
  })

  it('allows 10 registrations per hour per address, then 429; a body that is not JSON counts too', async () => {
    const ip = `203.0.113.99-${randomUUID()}`
    for (let i = 0; i < 9; i++) expect((await register({ redirect_uris: [CLAUDE_AI] }, { 'x-real-ip': ip })).status).toBe(201)
    expect((await register('not json', { 'x-real-ip': ip })).status).toBe(400)
    const over = await register({ redirect_uris: [CLAUDE_AI] }, { 'x-real-ip': ip })
    expect(over.status).toBe(429)
    expect(await over.json()).toEqual({ error: 'temporarily_unavailable', error_description: expect.any(String) })
    // Another address is not affected
    expect((await register({ redirect_uris: [CLAUDE_AI] })).status).toBe(201)
    expect(await prisma.mcpClient.count()).toBe(10)
  })

  it('Anthropic\'s egress range is not capped at 10 per address: claude.ai registers every user from there', async () => {
    for (let i = 0; i < 15; i++) {
      expect((await register({ redirect_uris: [CLAUDE_AI] }, { 'x-real-ip': '160.79.104.33' })).status).toBe(201)
    }
    // Behind the proxy too: the address it appended is the one that counts
    const viaProxy = await registerRoute.POST(
      jsonPost('/api/oauth/register', { redirect_uris: [CLAUDE_AI] }, { 'x-forwarded-for': '10.0.0.1, 160.79.104.33' }),
    )
    expect(viaProxy.status).toBe(201)
    // Claiming the range as a forged first hop does not move a caller into it
    const outside = `203.0.113.77-${randomUUID().slice(0, 8)}`
    for (let i = 0; i < 10; i++) {
      const res = await registerRoute.POST(
        jsonPost('/api/oauth/register', { redirect_uris: [CLAUDE_AI] }, { 'x-forwarded-for': `160.79.104.33, ${outside}` }),
      )
      expect(res.status).toBe(201)
    }
    const forged = await registerRoute.POST(
      jsonPost('/api/oauth/register', { redirect_uris: [CLAUDE_AI] }, { 'x-forwarded-for': `160.79.104.33, ${outside}` }),
    )
    expect(forged.status).toBe(429)
  })

  it('accepts a registration that asks for a scope of its own, and answers tkoc.read tkoc.write', async () => {
    const res = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_AI], scope: 'tkoc.read offline_access' })
    expect(res.status).toBe(201)
    expect((await res.json()).scope).toBe('tkoc.read tkoc.write')
  })

  it('counts by the address the proxy saw, not by what the caller claims', async () => {
    const real = `203.0.113.50-${randomUUID()}`
    const viaProxy = (spoofed: string) =>
      registerRoute.POST(jsonPost('/api/oauth/register', { redirect_uris: [CLAUDE_AI] }, { 'x-forwarded-for': `${spoofed}, ${real}` }))
    for (let i = 0; i < 10; i++) expect((await viaProxy(`10.0.0.${i}`)).status).toBe(201)
    // A new invented first hop does not open a new allowance
    expect((await viaProxy('10.9.9.9')).status).toBe(429)
  })
})

describe('POST /api/oauth/authorize (the decision)', () => {
  it('«Permitir»: 303 back to the client with code, state and iss, and the grant exists', async () => {
    const admin = await makeUser('ADMIN', 'Ada Admin')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)

    const res = await decide(sessionCookie(admin), allow(consent))
    expect(res.status).toBe(303)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe(CLAUDE_AI)
    expect([...location.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state'])
    expect(location.searchParams.get('state')).toBe('state-123')
    // The issuer is ours, whatever host the request named
    expect(location.searchParams.get('iss')).toBe(ISS)
    expect(location.toString()).not.toContain('evil')
    const code = location.searchParams.get('code') as string
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const grants = await prisma.mcpGrant.findMany()
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ clientId: client.client_id, userId: admin.id, scope: 'tkoc.read tkoc.write', resource: MCP_RESOURCE, revokedAt: null })
    const codes = await prisma.mcpAuthCode.findMany()
    expect(codes).toHaveLength(1)
    // Only the hash of the code is stored
    expect(codes[0]).toMatchObject({ codeHash: sha256Hex(code), grantId: grants[0].id, redirectUri: CLAUDE_AI, usedAt: null })
    expect(JSON.stringify(codes)).not.toContain(code)
    expect(codes[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE)
  })

  it('«Cancelar», or anything that is not exactly «Permitir»: back with access_denied, nothing created', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)
    const refusals: (Record<string, string> | string)[] = [
      deny(consent),
      { [CONSENT_TOKEN_FIELD]: consent },
      { [CONSENT_TOKEN_FIELD]: consent, [DECISION_FIELD]: 'ALLOW' },
      { [CONSENT_TOKEN_FIELD]: consent, [DECISION_FIELD]: 'allow ' },
      { [CONSENT_TOKEN_FIELD]: consent, [DECISION_FIELD]: 'yes' },
      // «Permitir» and «Cancelar» at once is not «Permitir»
      `${CONSENT_TOKEN_FIELD}=${consent}&${DECISION_FIELD}=allow&${DECISION_FIELD}=deny`,
      `${CONSENT_TOKEN_FIELD}=${consent}&${DECISION_FIELD}=allow&${DECISION_FIELD}=allow`,
    ]
    for (const fields of refusals) {
      const res = await decide(sessionCookie(admin), fields)
      expect(res.status, JSON.stringify(fields)).toBe(303)
      const location = new URL(res.headers.get('location') as string)
      expect(location.origin + location.pathname).toBe(CLAUDE_AI)
      expect([...location.searchParams.keys()].sort()).toEqual(['error', 'iss', 'state'])
      expect(location.searchParams.get('error')).toBe('access_denied')
      expect(location.searchParams.get('state')).toBe('state-123')
      expect(location.searchParams.get('iss')).toBe(ISS)
    }
    await nothingGranted()
  })

  it('a request without state gets none back', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id, { state: undefined })
    const res = await decide(sessionCookie(admin), allow(consent))
    const location = new URL(res.headers.get('location') as string)
    expect([...location.searchParams.keys()].sort()).toEqual(['code', 'iss'])
  })

  it('a local client (Claude Code) is sent back to the loopback address it came from', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered({ client_name: 'Claude Code', redirect_uris: ['http://localhost:3118/callback'] })
    const { consent } = await consentFor(admin.id, client.client_id, { redirect_uri: 'http://localhost:51234/callback' })
    const res = await decide(sessionCookie(admin), allow(consent))
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe('http://localhost:51234/callback')
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(location.searchParams.get('iss')).toBe(ISS)
  })

  it('without a session nothing happens: 401, no redirect', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)
    const stale = generateToken('no-such-user', 'ADMIN')
    for (const cookie of [null, 'token=', 'token=garbage', `token=${generateToken(admin.id, 'ADMIN')}x`, `token=${stale}`, `other=${generateToken(admin.id, 'ADMIN')}`]) {
      await expectErrorPage(await decide(cookie, allow(consent)), 401, SESSION_EXPIRED)
    }
    // The session travels in the cookie, as a browser sends it: a header is not a session here
    await expectErrorPage(await decide(null, allow(consent), { authorization: `Bearer ${generateToken(admin.id, 'ADMIN')}` }), 401, SESSION_EXPIRED)
    await nothingGranted()
  })

  it('an EMPLOYEE, a BRAND or a CREATOR cannot approve, with any consent token', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const forAdmin = await consentFor(admin.id, client.client_id)
    for (const role of ['EMPLOYEE', 'BRAND', 'CREATOR'] as const) {
      const user = await makeUser(role)
      // A token that an administrator's screen produced
      await expectErrorPage(await decide(sessionCookie(user), allow(forAdmin.consent)), 403, ADMIN_ONLY)
      // Even a token signed for that very person (which no screen ever produces)
      const forSelf = await consentFor(user.id, client.client_id)
      await expectErrorPage(await decide(sessionCookie(user), allow(forSelf.consent)), 403, ADMIN_ONLY)
      // Not even to cancel: they have no business here
      await expectErrorPage(await decide(sessionCookie(user), deny(forAdmin.consent)), 403, ADMIN_ONLY)
    }
    await nothingGranted()
  })

  it('the role is the one in the database, not the one in the cookie', async () => {
    const client = await registered()
    // A cookie that claims ADMIN for someone who is not
    const employee = await makeUser('EMPLOYEE')
    const forged = `token=${generateToken(employee.id, 'ADMIN')}`
    await expectErrorPage(await decide(forged, allow((await consentFor(employee.id, client.client_id)).consent)), 401, SESSION_EXPIRED)

    // An administrator who stopped being one between the screen and the click
    const demoted = await makeUser('ADMIN')
    const cookie = sessionCookie(demoted)
    const { consent } = await consentFor(demoted.id, client.client_id)
    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'EMPLOYEE' } })
    await expectErrorPage(await decide(cookie, allow(consent)), 401, SESSION_EXPIRED)

    const deactivated = await makeUser('ADMIN')
    const second = await consentFor(deactivated.id, client.client_id)
    await prisma.user.update({ where: { id: deactivated.id }, data: { isActive: false } })
    await expectErrorPage(await decide(sessionCookie(deactivated), allow(second.consent)), 401, SESSION_EXPIRED)
    await nothingGranted()
  })

  it('the session alone is not enough: a valid consent token is required (CSRF)', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent, fields } = await consentFor(admin.id, client.client_id)
    const cookie = sessionCookie(admin)

    const [version, payload, signature] = consent.split('.')
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), ru: 'https://evil.example/cb' }), 'utf8').toString('base64url')
    // Signed with the session secret itself instead of the key derived for consent tokens
    const wrongKey = createHmac('sha256', process.env.JWT_SECRET as string).update(`${version}.${payload}`).digest('base64url')

    const bad: (Record<string, string> | string)[] = [
      { [DECISION_FIELD]: DECISION_ALLOW },
      { [CONSENT_TOKEN_FIELD]: '', [DECISION_FIELD]: DECISION_ALLOW },
      allow('garbage'),
      allow(`${version}.${tampered}.${signature}`),
      allow(`${version}.${payload}.${wrongKey}`),
      allow(`${version}.${payload}`),
      // A session token is not a consent token
      allow(generateToken(admin.id, 'ADMIN')),
      // The same field twice: which one would count?
      `${CONSENT_TOKEN_FIELD}=${consent}&${CONSENT_TOKEN_FIELD}=${consent}&${DECISION_FIELD}=allow`,
    ]
    for (const form of bad) {
      const html = await expectErrorPage(await decide(cookie, form), 400, INVALID)
      expect(html).not.toContain('evil')
    }

    // Ten minutes and no more
    const old = signConsentToken(fields, Date.now() - 10 * MINUTE - 1000)
    await expectErrorPage(await decide(cookie, allow(old)), 400, SCREEN_EXPIRED)
    await expectErrorPage(await decide(cookie, deny(old)), 400, SCREEN_EXPIRED)
    await nothingGranted()

    // And it still works for the token that is fine
    expect((await decide(cookie, allow(signConsentToken(fields, Date.now() - 9 * MINUTE)))).status).toBe(303)
  })

  it('a consent token belongs to the administrator who saw the screen', async () => {
    const ada = await makeUser('ADMIN', 'Ada')
    const bob = await makeUser('ADMIN', 'Bob')
    const client = await registered()
    const forAda = await consentFor(ada.id, client.client_id)
    await expectErrorPage(await decide(sessionCookie(bob), allow(forAda.consent)), 403, INVALID)
    await expectErrorPage(await decide(sessionCookie(bob), deny(forAda.consent)), 403, INVALID)
    await nothingGranted()
    expect((await decide(sessionCookie(ada), allow(forAda.consent))).status).toBe(303)
    expect((await prisma.mcpGrant.findFirstOrThrow()).userId).toBe(ada.id)
  })

  it('only the signed token decides what is granted and where the browser goes', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)
    // Extra fields in the form are not even looked at
    const res = await decide(sessionCookie(admin), {
      ...allow(consent),
      redirect_uri: 'https://evil.example/cb',
      client_id: randomSecret(),
      state: 'forged',
      scope: 'tkoc.admin',
      resource: 'https://evil.example/api/mcp',
      user_id: 'someone-else',
    })
    expect(res.status).toBe(303)
    const location = new URL(res.headers.get('location') as string)
    expect(location.origin + location.pathname).toBe(CLAUDE_AI)
    expect(location.searchParams.get('state')).toBe('state-123')
    expect(await prisma.mcpGrant.findFirstOrThrow()).toMatchObject({ clientId: client.client_id, userId: admin.id, scope: 'tkoc.read tkoc.write', resource: MCP_RESOURCE })
  })

  it('a consent signed by the read-only screen of before (across a deploy) only ever grants reading', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { fields } = await consentFor(admin.id, client.client_id)
    // What the consent screen of the read layer signed: scope tkoc.read, valid 10 minutes
    const res = await decide(sessionCookie(admin), allow(signConsentToken({ ...fields, scope: 'tkoc.read' })))
    expect(res.status).toBe(303)
    const grant = await prisma.mcpGrant.findFirstOrThrow({ where: { clientId: client.client_id } })
    expect(grant.scope).toBe('tkoc.read')
    expect(await prisma.mcpAuthCode.findFirstOrThrow({ where: { grantId: grant.id } })).toMatchObject({ scope: 'tkoc.read' })
  })

  it('never redirects to an address that is not a valid redirect URI of the client', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { fields } = await consentFor(admin.id, client.client_id)
    const cookie = sessionCookie(admin)
    // Tokens that a faulty screen could have signed. The route looks again
    const elsewhere: ConsentFields[] = [
      { ...fields, redirectUri: 'https://evil.example/cb' },
      { ...fields, redirectUri: 'https://claude.ai.evil.com/api/mcp/auth_callback' },
      { ...fields, redirectUri: `${CLAUDE_AI}@evil.com` },
    ]
    for (const f of elsewhere) {
      for (const form of [allow(signConsentToken(f)), deny(signConsentToken(f))]) {
        const html = await expectErrorPage(await decide(cookie, form), 400, INVALID)
        expect(html).not.toContain('evil')
      }
    }
    // A redirect URI that is acceptable in general but is not this client's: «Permitir» stays put
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, redirectUri: 'https://claude.com/api/mcp/auth_callback' }))), 400, INVALID)
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, redirectUri: 'http://localhost:9999/cb' }))), 400, INVALID)
    await nothingGranted()
  })

  it('refuses a client that disappeared, another resource and another scope', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { fields } = await consentFor(admin.id, client.client_id)
    const cookie = sessionCookie(admin)
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, resource: 'https://other.example/api/mcp' }))), 400, INVALID)
    // tkoc.read and tkoc.write are both ours since the write layer; a scope we do not have is refused
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, scope: 'tkoc.admin' }))), 400, INVALID)
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, scope: 'tkoc.read tkoc.admin' }))), 400, INVALID)
    await expectErrorPage(await decide(cookie, allow(signConsentToken({ ...fields, codeChallenge: 'plain-text' }))), 400, INVALID)
    await prisma.mcpClient.deleteMany({ where: { clientId: client.client_id } })
    await expectErrorPage(await decide(cookie, allow(signConsentToken(fields))), 400, INVALID)
    await nothingGranted()
  })

  it('refuses a post that the browser says comes from another site', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)
    const cookie = sessionCookie(admin)
    for (const site of ['cross-site', 'same-site', 'none']) {
      await expectErrorPage(await decide(cookie, allow(consent), { 'sec-fetch-site': site }), 403, INVALID)
    }
    await nothingGranted()
    expect((await decide(cookie, allow(consent), { 'sec-fetch-site': 'same-origin' })).status).toBe(303)
  })

  it('reads only a form body, of reasonable size, and nothing from the URL', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const { consent } = await consentFor(admin.id, client.client_id)
    const cookie = sessionCookie(admin)

    const asJson = await decisionRoute.POST(jsonPost(CONSENT_FORM_ACTION, allow(consent), { cookie }))
    await expectErrorPage(asJson, 400, INVALID)
    // The right fields under another content type are not read either
    for (const type of ['text/plain', 'multipart/form-data; boundary=x']) {
      await expectErrorPage(await decide(cookie, allow(consent), { 'content-type': type }), 400, INVALID)
    }
    const inUrl = await decisionRoute.POST(
      request(`${CONSENT_FORM_ACTION}?${new URLSearchParams(allow(consent))}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '' }),
    )
    await expectErrorPage(inUrl, 400, INVALID)
    const tooBig = await decide(cookie, { ...allow(consent), padding: 'x'.repeat(17 * 1024) })
    await expectErrorPage(tooBig, 413, INVALID)
    await nothingGranted()
  })

  it('its error page never prints anything that came with the request', async () => {
    const admin = await makeUser('ADMIN')
    const marker = '<script>alert(1)</script>'
    const html = await expectErrorPage(
      await decide(sessionCookie(admin), { [CONSENT_TOKEN_FIELD]: marker, [DECISION_FIELD]: marker, extra: marker }),
      400,
      INVALID,
    )
    expect(html).not.toContain('script')
    expect(html).not.toContain('alert')
    expect(html).toContain('<h1>No se ha podido conectar Claude</h1>')
  })
})

describe('POST /api/oauth/token', () => {
  it('the whole flow: register, approve, token, refresh, and reuse of the old refresh token ends everything', async () => {
    const admin = await makeUser('ADMIN', 'Ada Admin')
    const a = await approved(admin)

    const first = await token({ grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: CLAUDE_AI, resource: MCP_RESOURCE })
    expect(first.status).toBe(200)
    isJson(first)
    expect(first.headers.get('cache-control')).toBe(NO_STORE)
    expect(first.headers.get('pragma')).toBe('no-cache')
    const tokens = (await first.json()) as Tokens
    expect(tokens).toEqual({
      access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: 'tkoc.read tkoc.write',
    })

    // The access token opens /api/mcp for that administrator
    expect(await bearer(tokens.access_token)).toMatchObject({
      ok: true,
      user: { id: admin.id, name: 'Ada Admin', role: 'ADMIN' },
      grant: { id: a.grantId, clientId: a.clientId, resource: MCP_RESOURCE },
    })

    // Rotation
    const second = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: a.clientId })
    expect(second.status).toBe(200)
    expect(second.headers.get('cache-control')).toBe(NO_STORE)
    const rotated = (await second.json()) as Tokens
    expect(rotated).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'tkoc.read tkoc.write' })
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    expect(rotated.access_token).not.toBe(tokens.access_token)
    expect((await bearer(rotated.access_token)).ok).toBe(true)

    // The old refresh token comes back after the leeway: invalid_grant, and the whole grant is gone
    await exchangedLongAgo(tokens.refresh_token)
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: a.clientId })
    expect(reuse.status).toBe(400)
    isJson(reuse)
    expect(reuse.headers.get('cache-control')).toBe(NO_STORE)
    expect(await reuse.json()).toEqual({ error: 'invalid_grant', error_description: expect.any(String) })
    expect(await grantRow(a.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'refresh_reuse' })

    // 401 with the WWW-Authenticate header afterwards, for every token of that grant
    for (const t of [tokens.access_token, rotated.access_token]) {
      const r = await bearer(t)
      expect(r).toMatchObject({ ok: false, status: 401 })
      expect(r.ok === false && r.wwwAuthenticate).toBe(`Bearer resource_metadata="${ISS}/.well-known/oauth-protected-resource"`)
    }
    const dead = await token({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token, client_id: a.clientId })
    expect(dead.status).toBe(400)
    expect((await dead.json()).error).toBe('invalid_grant')
  })

  it('a renewal retried within the minute (its answer was lost) gets a working pair, and the connection survives', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connected(admin)
    const renew = () => token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })
    expect((await renew()).status).toBe(200) // lost on the way back
    const retry = await renew()
    expect(retry.status).toBe(200)
    expect(retry.headers.get('cache-control')).toBe(NO_STORE)
    const pair = (await retry.json()) as Tokens
    expect((await bearer(pair.access_token)).ok).toBe(true)
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    const next = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, client_id: c.clientId })
    expect(next.status).toBe(200)
  })

  it('a code is single-use: the second exchange is refused and takes the first tokens with it', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approved(admin)
    const exchange = () => token({ grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier })
    const first = await exchange()
    expect(first.status).toBe(200)
    const tokens = (await first.json()) as Tokens
    expect((await bearer(tokens.access_token)).ok).toBe(true)

    const second = await exchange()
    expect(second.status).toBe(400)
    expect(await second.json()).toEqual({ error: 'invalid_grant', error_description: expect.any(String) })
    expect((await grantRow(a.grantId)).revokedReason).toBe('code_reuse')
    expect(await bearer(tokens.access_token)).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
  })

  it('a wrong code_verifier is invalid_grant, a missing one invalid_request, and the right one still works', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approved(admin)
    const base = { grant_type: 'authorization_code', code: a.code, client_id: a.clientId }
    for (const wrong of [randomSecret(), `${a.verifier}x`, 'short', pkceChallengeS256(a.verifier)]) {
      const res = await token({ ...base, code_verifier: wrong })
      expect(res.status).toBe(400)
      expect(res.headers.get('cache-control')).toBe(NO_STORE)
      expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: expect.any(String) })
    }
    const missing = await token(base)
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('invalid_request')
    expect(await prisma.mcpToken.count()).toBe(0)

    const good = await token({ ...base, code_verifier: a.verifier })
    expect(good.status).toBe(200)
  })

  it('answers every protocol error as RFC 6749 JSON with status 400', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approved(admin)
    const other = await registered()
    const good = { grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: CLAUDE_AI }
    const cases: [Record<string, string> | string, string][] = [
      [{ ...good, grant_type: '' }, 'invalid_request'],
      [{ code: a.code, client_id: a.clientId, code_verifier: a.verifier }, 'invalid_request'],
      [{ ...good, grant_type: 'client_credentials' }, 'unsupported_grant_type'],
      [{ ...good, grant_type: 'password' }, 'unsupported_grant_type'],
      [{ ...good, client_id: randomSecret() }, 'invalid_client'],
      [{ ...good, client_id: 'nope' }, 'invalid_client'],
      [{ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier }, 'invalid_request'],
      [{ ...good, client_id: other.client_id }, 'invalid_grant'],
      [{ ...good, code: randomSecret() }, 'invalid_grant'],
      [{ ...good, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'invalid_grant'],
      [{ ...good, redirect_uri: 'https://evil.example/cb' }, 'invalid_grant'],
      [{ ...good, resource: 'https://other.example/api/mcp' }, 'invalid_target'],
      [`grant_type=authorization_code&code=${a.code}&code=${a.code}&client_id=${a.clientId}&code_verifier=${a.verifier}`, 'invalid_request'],
      [{ grant_type: 'refresh_token', client_id: a.clientId }, 'invalid_request'],
      [{ grant_type: 'refresh_token', refresh_token: randomSecret(), client_id: a.clientId }, 'invalid_grant'],
      // An authorization code is not a refresh token
      [{ grant_type: 'refresh_token', refresh_token: a.code, client_id: a.clientId }, 'invalid_grant'],
    ]
    for (const [fields, error] of cases) {
      const res = await token(fields)
      expect(res.status, JSON.stringify(fields)).toBe(400)
      isJson(res)
      expect(res.headers.get('cache-control')).toBe(NO_STORE)
      const json = await res.json()
      expect(json, JSON.stringify(fields)).toEqual({ error, error_description: expect.any(String) })
      // The answer never repeats a secret it was sent
      expect(JSON.stringify(json)).not.toContain(a.code)
      expect(JSON.stringify(json)).not.toContain(a.verifier)
    }
    expect(await prisma.mcpToken.count()).toBe(0)
    // None of those attempts spent the code
    expect((await token(good)).status).toBe(200)
  })

  it('takes its parameters from a form body only, never from the URL', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approved(admin)
    const good = { grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier }

    const asJson = await tokenRoute.POST(jsonPost('/api/oauth/token', good))
    expect(asJson.status).toBe(400)
    expect((await asJson.json()).error).toBe('invalid_request')
    // The right fields under another content type are not read either
    for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/json']) {
      const res = await token(good, { 'content-type': type })
      expect(res.status, type).toBe(400)
      expect((await res.json()).error).toBe('invalid_request')
    }

    const inUrl = await tokenRoute.POST(
      request(`/api/oauth/token?${new URLSearchParams(good)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }),
    )
    expect(inUrl.status).toBe(400)
    expect((await inUrl.json()).error).toBe('invalid_request')
    // Even next to a correct body: a secret in a URL is refused, not tolerated
    const both = await tokenRoute.POST(formPost(`/api/oauth/token?code=${a.code}`, good))
    expect(both.status).toBe(400)
    expect((await both.json()).error).toBe('invalid_request')

    const tooBig = await token({ ...good, padding: 'x'.repeat(17 * 1024) })
    expect(tooBig.status).toBe(413)
    expect((await tooBig.json()).error).toBe('invalid_request')
    expect(tooBig.headers.get('cache-control')).toBe(NO_STORE)

    expect(await prisma.mcpToken.count()).toBe(0)
    // The usual header of a form, charset included, is accepted
    expect((await token(good, { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' })).status).toBe(200)
  })

  it('a session of the platform is no credential here', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registered()
    const cookie = sessionCookie(admin)
    const res = await token({ grant_type: 'authorization_code', code: randomSecret(), client_id: client.client_id, code_verifier: randomSecret() }, { cookie })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    const viaRefresh = await token({ grant_type: 'refresh_token', refresh_token: generateToken(admin.id, 'ADMIN'), client_id: client.client_id }, { cookie })
    expect(viaRefresh.status).toBe(400)
    expect((await viaRefresh.json()).error).toBe('invalid_grant')
  })

  it('an administrator demoted or deactivated after authorising gets no new token', async () => {
    const demoted = await makeUser('ADMIN')
    const c = await connected(demoted)
    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'EMPLOYEE' } })
    const res = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_grant')
    expect(await bearer(c.tokens.access_token)).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
    expect((await grantRow(c.grantId)).revokedAt).toBeInstanceOf(Date)

    // Approved, then deactivated before Claude came for its tokens
    const deactivated = await makeUser('ADMIN')
    const a = await approved(deactivated)
    await prisma.user.update({ where: { id: deactivated.id }, data: { isActive: false } })
    const exchange = await token({ grant_type: 'authorization_code', code: a.code, client_id: a.clientId, code_verifier: a.verifier })
    expect(exchange.status).toBe(400)
    expect((await exchange.json()).error).toBe('invalid_grant')
    expect(await prisma.mcpToken.count()).toBe(0)
  })
})

describe('POST /api/oauth/revoke', () => {
  it('either token ends the connection: 200 with an empty body', async () => {
    const admin = await makeUser('ADMIN')
    const byRefresh = await connected(admin)
    const res = await revoke({ token: byRefresh.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: byRefresh.clientId })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    expect(await grantRow(byRefresh.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'client_revoked' })
    expect(await bearer(byRefresh.tokens.access_token)).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })

    const byAccess = await connected(admin)
    expect((await revoke({ token: byAccess.tokens.access_token })).status).toBe(200)
    expect((await grantRow(byAccess.grantId)).revokedReason).toBe('client_revoked')
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: byAccess.tokens.refresh_token, client_id: byAccess.clientId })
    expect((await refresh.json()).error).toBe('invalid_grant')
  })

  it('an unknown token is not an error, a missing one is, and another client revokes nothing', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connected(admin)
    const other = await registered()

    const harmless: Record<string, string>[] = [{ token: randomSecret() }, { token: 'garbage', token_type_hint: 'whatever' }, { token: c.tokens.refresh_token, client_id: other.client_id }]
    for (const fields of harmless) {
      const res = await revoke(fields)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('')
    }
    const malformed: (Record<string, string> | string)[] = [{}, { token_type_hint: 'access_token' }, `token=${c.tokens.access_token}&token=${c.tokens.access_token}`]
    for (const fields of malformed) {
      const res = await revoke(fields)
      expect(res.status).toBe(400)
      isJson(res)
      expect(await res.json()).toEqual({ error: 'invalid_request', error_description: expect.any(String) })
    }
    // A token in the URL is refused and revokes nothing
    const inUrl = await revokeRoute.POST(
      request(`/api/oauth/revoke?token=${c.tokens.access_token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' }),
    )
    expect(inUrl.status).toBe(400)
    const asJson = await revokeRoute.POST(jsonPost('/api/oauth/revoke', { token: c.tokens.access_token }))
    expect(asJson.status).toBe(400)
    const asText = await revokeRoute.POST(formPost('/api/oauth/revoke', { token: c.tokens.access_token }, { 'content-type': 'text/plain' }))
    expect(asText.status).toBe(400)

    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    expect((await bearer(c.tokens.access_token)).ok).toBe(true)
  })
})

describe('connections for the administrator (/api/oauth/grants)', () => {
  const list = (cookie: string | null) => grantsRoute.GET(request('/api/oauth/grants', { headers: cookie ? { cookie } : {} }))
  const remove = (cookie: string | null, id: string) =>
    grantRoute.DELETE(request(`/api/oauth/grants/${id}`, { method: 'DELETE', headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ id }) })

  it('lists the live connections of every administrator, without secrets or e-mails', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const bob = await makeUser('ADMIN', 'Bob Admin')
    const first = await connected(ada)
    await prisma.mcpGrant.update({ where: { id: first.grantId }, data: { createdAt: new Date(Date.now() - 24 * 60 * MINUTE) } })
    const second = await connected(bob)
    const revoked = await connected(ada)
    await revoke({ token: revoked.tokens.refresh_token })
    await bearer(second.tokens.access_token)

    // Bob sees Ada's connection too
    const res = await list(sessionCookie(bob))
    expect(res.status).toBe(200)
    isJson(res)
    expect(res.headers.get('cache-control')).toBe(NO_STORE)
    const body = await res.json()
    expect(body).toEqual({
      grants: [
        { id: second.grantId, clientId: second.clientId, clientName: 'Claude', userId: bob.id, userName: 'Bob Admin', scope: 'tkoc.read tkoc.write', createdAt: expect.any(String), lastUsedAt: expect.any(String) },
        { id: first.grantId, clientId: first.clientId, clientName: 'Claude', userId: ada.id, userName: 'Ada Admin', scope: 'tkoc.read tkoc.write', createdAt: expect.any(String), lastUsedAt: null },
      ],
    })
    for (const g of body.grants) expect(new Date(g.createdAt).toISOString()).toBe(g.createdAt)
    const text = JSON.stringify(body)
    for (const secret of [first.tokens.access_token, first.tokens.refresh_token, second.tokens.access_token, sha256Hex(second.tokens.access_token), ada.email, bob.email, 'tokenHash', 'email', 'password']) {
      expect(text).not.toContain(secret)
    }
  })

  it('is for administrators only', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connected(admin)

    for (const res of [await list(null), await list('token=garbage'), await remove(null, c.grantId), await remove('token=garbage', c.grantId)]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    }
    for (const role of ['EMPLOYEE', 'BRAND', 'CREATOR'] as const) {
      const cookie = sessionCookie(await makeUser(role))
      for (const res of [await list(cookie), await remove(cookie, c.grantId)]) {
        expect(res.status).toBe(403)
        const json = await res.json()
        expect(json).toEqual({ error: 'Forbidden' })
        expect(JSON.stringify(json)).not.toContain(c.grantId)
      }
    }
    // A cookie that claims ADMIN for an employee, and an administrator who was demoted
    const employee = await makeUser('EMPLOYEE')
    expect((await remove(`token=${generateToken(employee.id, 'ADMIN')}`, c.grantId)).status).toBe(401)
    const demoted = await makeUser('ADMIN')
    const stale = sessionCookie(demoted)
    await prisma.user.update({ where: { id: demoted.id }, data: { role: 'EMPLOYEE' } })
    expect((await list(stale)).status).toBe(401)
    expect((await remove(stale, c.grantId)).status).toBe(401)
    // An access token of the connector is not a session of the platform
    const viaMcpToken = await grantsRoute.GET(request('/api/oauth/grants', { headers: { authorization: `Bearer ${c.tokens.access_token}` } }))
    expect(viaMcpToken.status).toBe(401)

    // After all of that the connection is untouched
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    expect((await bearer(c.tokens.access_token)).ok).toBe(true)
  })

  it('«Revocar» cuts access at once, also for the connection of another administrator', async () => {
    const ada = await makeUser('ADMIN')
    const bob = await makeUser('ADMIN')
    const c = await connected(ada)
    const untouched = await connected(ada)
    expect((await bearer(c.tokens.access_token)).ok).toBe(true)

    const res = await remove(sessionCookie(bob), c.grantId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: `admin:${bob.id}` })
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)

    // 401 with the header on the next call, and no way back through the refresh token
    const after = await bearer(c.tokens.access_token)
    expect(after).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })
    expect(refresh.status).toBe(400)
    expect((await refresh.json()).error).toBe('invalid_grant')

    // It is no longer listed; the other connection is not affected
    const listed = (await (await list(sessionCookie(ada))).json()).grants.map((g: { id: string }) => g.id)
    expect(listed).toEqual([untouched.grantId])
    expect((await bearer(untouched.tokens.access_token)).ok).toBe(true)

    // Twice, or an id that never existed: 404 and nothing changes
    for (const id of [c.grantId, 'no-such-grant', 'x'.repeat(65)]) {
      const again = await remove(sessionCookie(bob), id)
      expect(again.status).toBe(404)
      expect(await again.json()).toEqual({ error: 'Not found' })
    }
    expect((await grantRow(c.grantId)).revokedReason).toBe(`admin:${bob.id}`)
  })
})

describe('end to end: Claude connects through the routes and calls /api/mcp', () => {
  it('401, discovery, register, «Permitir», token, initialize, tools/list, a tool call, refresh, reuse of the old refresh token, 401', async () => {
    // The MCP endpoint is another module: imported here so that a problem there fails this test only
    const mcp = await import('@/app/api/mcp/route')
    let id = 0
    const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) })
    const call = (accessToken: string | null, body: unknown) =>
      mcp.POST(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      )
    const initialize = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'routes-test', version: '1.0.0' } })

    // 1. Nobody has signed in: 401, and the header says where the discovery document is
    const first = await call(null, initialize())
    expect(first.status).toBe(401)
    const header = first.headers.get('www-authenticate') as string
    expect(header).toBe(WWW_AUTHENTICATE_BEARER)
    const metadataUrl = new URL((/resource_metadata="([^"]+)"/.exec(header) as RegExpExecArray)[1])

    // 2. Discovery, the way Claude walks it: each document names the next step, and every step is a route that exists
    expect(metadataUrl.origin).toBe(ISS)
    expect(metadataUrl.pathname).toBe('/.well-known/oauth-protected-resource')
    const resource = await protectedResourceRoute.GET().json()
    expect(resource.resource).toBe(MCP_RESOURCE)
    const server = await authorizationServerRoute.GET().json()
    expect(server.issuer).toBe(resource.authorization_servers[0])
    expect(new URL(server.registration_endpoint).pathname).toBe('/api/oauth/register')
    expect(new URL(server.authorization_endpoint).pathname).toBe('/oauth/authorize')
    expect(new URL(server.token_endpoint).pathname).toBe('/api/oauth/token')

    // 3. Registration, 4. the administrator says «Permitir», 5. the code becomes tokens
    const admin = await makeUser('ADMIN', 'Ada Admin')
    const c = await connected(admin)

    // 6. The connection works
    const hello = await call(c.tokens.access_token, initialize())
    expect(hello.status).toBe(200)
    expect((await hello.json()).result.serverInfo).toMatchObject({ name: expect.any(String) })

    const listed = await call(c.tokens.access_token, rpc('tools/list'))
    expect(listed.status).toBe(200)
    const tools = (await listed.json()).result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]
    expect(tools.map(t => t.name)).toContain('list_campaigns')
    // The eight read tools say they only read; the write tools (tkoc.write) say they do not
    const readNames = new Set(MCP_TOOLS.map(t => t.name))
    expect(tools.filter(t => readNames.has(t.name))).toHaveLength(8)
    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(readNames.has(tool.name))

    const called = await call(c.tokens.access_token, rpc('tools/call', { name: 'list_campaigns', arguments: {} }))
    expect(called.status).toBe(200)
    const result = (await called.json()).result as { isError?: boolean; content: { type: string; text: string }[] }
    expect(result.isError ?? false).toBe(false)
    expect(result.content[0].type).toBe('text')
    expect(() => JSON.parse(result.content[0].text)).not.toThrow()

    // 7. Renewal: a new pair, and the new access token works
    const renewed = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })
    expect(renewed.status).toBe(200)
    const rotated = (await renewed.json()) as Tokens
    expect((await call(rotated.access_token, rpc('tools/list'))).status).toBe(200)

    // 8. The old refresh token shows up again, later: the whole authorisation is revoked
    await exchangedLongAgo(c.tokens.refresh_token)
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId })
    expect(reuse.status).toBe(400)
    expect((await reuse.json()).error).toBe('invalid_grant')
    expect((await grantRow(c.grantId)).revokedReason).toBe('refresh_reuse')

    // 9. 401 with the WWW-Authenticate header afterwards, for every token it ever had
    for (const accessToken of [c.tokens.access_token, rotated.access_token]) {
      const after = await call(accessToken, rpc('tools/list'))
      expect(after.status).toBe(401)
      expect(after.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ISS}/.well-known/oauth-protected-resource"`)
    }
  })

  it('«Revocar» in Ajustes and the removal of the connector in Claude both end with a 401 on /api/mcp', async () => {
    const mcp = await import('@/app/api/mcp/route')
    const ping = (accessToken: string) =>
      mcp.POST(
        new Request(MCP_RESOURCE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        }),
      )
    const admin = await makeUser('ADMIN')

    const fromAjustes = await connected(admin)
    expect((await ping(fromAjustes.tokens.access_token)).status).toBe(200)
    const removed = await grantRoute.DELETE(
      request(`/api/oauth/grants/${fromAjustes.grantId}`, { method: 'DELETE', headers: { cookie: sessionCookie(admin) } }),
      { params: Promise.resolve({ id: fromAjustes.grantId }) },
    )
    expect(removed.status).toBe(200)
    const afterAjustes = await ping(fromAjustes.tokens.access_token)
    expect(afterAjustes.status).toBe(401)
    expect(afterAjustes.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)

    const fromClaude = await connected(admin)
    expect((await ping(fromClaude.tokens.access_token)).status).toBe(200)
    expect((await revoke({ token: fromClaude.tokens.refresh_token, client_id: fromClaude.clientId })).status).toBe(200)
    const afterClaude = await ping(fromClaude.tokens.access_token)
    expect(afterClaude.status).toBe(401)
    expect(afterClaude.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
  })
})

describe('middleware', () => {
  const visit =(path: string, headers: Record<string, string> = {}) => middleware(new NextRequest(`https://app.example${path}`, { headers }))
  const passes = (res: Response) => res.headers.get('x-middleware-next') === '1'
  const cookieOf = (role: string) => `token=${generateToken(`user-${role}`, role)}`
  const AUTHORIZE = `/oauth/authorize?response_type=code&client_id=${'c'.repeat(43)}&redirect_uri=${encodeURIComponent(CLAUDE_AI)}&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256&state=a%20b%26c&resource=${encodeURIComponent(MCP_RESOURCE)}`

  it('lets everybody read the discovery documents', () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server']) {
      const visitors: Record<string, string>[] = [{}, { cookie: cookieOf('ADMIN') }, { cookie: cookieOf('BRAND') }, { cookie: cookieOf('CREATOR') }]
      for (const headers of visitors) {
        const res = visit(path, headers)
        expect(passes(res), `${path} ${JSON.stringify(headers)}`).toBe(true)
        expect(res.headers.get('location')).toBe(null)
      }
    }
  })

  it('sends a visitor without a session cookie from /oauth/authorize to the login, and back to the very same request', () => {
    const withoutCookie: Record<string, string>[] = [{}, { cookie: 'other=1' }, { authorization: `Bearer ${generateToken('user-ADMIN', 'ADMIN')}` }]
    for (const headers of withoutCookie) {
      const res = visit(AUTHORIZE, headers)
      expect(res.status).toBe(307)
      const location = new URL(res.headers.get('location') as string)
      expect(location.origin).toBe('https://app.example')
      expect(location.pathname).toBe('/login')
      expect([...location.searchParams.keys()]).toEqual(['next'])
      expect(location.searchParams.get('next')).toBe(AUTHORIZE)
      // And the login page accepts exactly that value
      expect(safeNextPath(location.searchParams.get('next'))).toBe(AUTHORIZE)
    }
    const bare = visit('/oauth/authorize')
    expect(new URL(bare.headers.get('location') as string).searchParams.get('next')).toBe('/oauth/authorize')
  })

  it('lets a staff session through to the consent screen, which can never be framed', () => {
    for (const role of ['ADMIN', 'EMPLOYEE']) {
      const res = visit(AUTHORIZE, { cookie: cookieOf(role) })
      expect(passes(res)).toBe(true)
      expect(res.headers.get('location')).toBe(null)
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    }
  })

  it('never lets a BRAND or a CREATOR reach /oauth/authorize: each goes to their own home', () => {
    const home = (res: Response) => {
      expect(res.status).toBe(307)
      expect(passes(res)).toBe(false)
      const location = new URL(res.headers.get('location') as string)
      expect(location.search).toBe('')
      return location.pathname
    }
    for (const path of [AUTHORIZE, '/oauth/authorize', '/oauth/authorize/']) {
      expect(home(visit(path, { cookie: cookieOf('BRAND') }))).toBe('/portal')
      expect(home(visit(path, { cookie: cookieOf('CREATOR') }))).toBe('/dashboard')
      // Also when the confined token hides in the header next to somebody else's cookie
      expect(home(visit(path, { cookie: cookieOf('ADMIN'), authorization: `Bearer ${generateToken('user-BRAND', 'BRAND')}` }))).toBe('/portal')
      expect(home(visit(path, { cookie: cookieOf('ADMIN'), authorization: `Bearer ${generateToken('user-CREATOR', 'CREATOR')}` }))).toBe('/dashboard')
    }
  })

  it('confines BRAND and CREATOR away from the OAuth and MCP endpoints too', async () => {
    for (const role of ['BRAND', 'CREATOR']) {
      for (const path of ['/api/oauth/grants', '/api/oauth/grants/abc', '/api/oauth/authorize', '/api/oauth/register', '/api/oauth/token', '/api/oauth/revoke', '/api/mcp']) {
        const res = visit(path, { cookie: cookieOf(role) })
        expect(res.status, `${role} ${path}`).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden' })
      }
    }
  })

  it('keeps the rules that were already there', async () => {
    // A page without a session: to the login, with no `next`
    for (const path of ['/dashboard', '/settings', '/campaigns/abc', '/oauth', '/oauth/authorized', '/oauth/authorize/x']) {
      const res = visit(path)
      expect(res.status, path).toBe(307)
      const location = new URL(res.headers.get('location') as string)
      expect(location.pathname + location.search, path).toBe('/login')
    }
    // Public pages and every API route (each API route checks its own session)
    for (const path of ['/login', '/privacy', '/terms/es', '/invite/abc', '/creators/register', '/brand-connect/x', '/api/campaigns', '/api/auth/login', '/api/oauth/token', '/api/oauth/register', '/api/mcp', '/capture.js', '/images/logo.png', '/robots.txt']) {
      expect(passes(visit(path)), path).toBe(true)
    }
    // An access token of the connector is opaque to the edge: the route decides
    expect(passes(visit('/api/mcp', { authorization: `Bearer ${randomSecret()}` }))).toBe(true)
    // A staff session moves freely
    for (const path of ['/dashboard', '/settings', '/api/campaigns']) {
      expect(passes(visit(path, { cookie: cookieOf('ADMIN') }))).toBe(true)
      expect(passes(visit(path, { cookie: cookieOf('EMPLOYEE') }))).toBe(true)
    }
    // BRAND: the portal and its small API whitelist, nothing else
    expect(passes(visit('/portal', { cookie: cookieOf('BRAND') }))).toBe(true)
    expect(passes(visit('/api/portal/campaigns', { cookie: cookieOf('BRAND') }))).toBe(true)
    expect(visit('/api/campaigns', { cookie: cookieOf('BRAND') }).status).toBe(403)
    expect(new URL(visit('/dashboard', { cookie: cookieOf('BRAND') }).headers.get('location') as string).pathname).toBe('/portal')
    // CREATOR: the dashboard and its small API whitelist, nothing else
    expect(passes(visit('/dashboard', { cookie: cookieOf('CREATOR') }))).toBe(true)
    expect(passes(visit('/api/dashboard/creator', { cookie: cookieOf('CREATOR') }))).toBe(true)
    expect(visit('/api/campaigns', { cookie: cookieOf('CREATOR') }).status).toBe(403)
    expect(new URL(visit('/settings', { cookie: cookieOf('CREATOR') }).headers.get('location') as string).pathname).toBe('/dashboard')
  })
})

describe('login: where `next` may lead', () => {
  it('only to the consent screen of this site, with its query', () => {
    expect(safeNextPath('/oauth/authorize')).toBe('/oauth/authorize')
    expect(safeNextPath('/oauth/authorize?response_type=code&state=a%20b')).toBe('/oauth/authorize?response_type=code&state=a%20b')
    const full = `/oauth/authorize?response_type=code&client_id=${'c'.repeat(43)}&redirect_uri=${encodeURIComponent(CLAUDE_AI)}&state=${'s'.repeat(2048)}`
    expect(safeNextPath(full)).toBe(full)
    // A redirect URI inside the query is data, not a destination
    expect(safeNextPath('/oauth/authorize?redirect_uri=https://evil.example/cb')).toBe('/oauth/authorize?redirect_uri=https://evil.example/cb')
    // A fragment is dropped
    expect(safeNextPath('/oauth/authorize?a=1#/dashboard')).toBe('/oauth/authorize?a=1')
  })

  it('ignores everything else', () => {
    const ignored: (string | null | undefined)[] = [
      null,
      undefined,
      '',
      '/',
      '/dashboard',
      '/settings',
      '/login?next=/oauth/authorize',
      '/oauth',
      '/oauth/authorize/',
      '/oauth/authorize/x',
      '/oauth/authorize/../dashboard',
      '/oauth/authorized',
      '/oauth/authorize.evil.example',
      '/oauth/authorize@evil.example',
      '/oauth/authorize#x',
      '/OAuth/Authorize',
      'oauth/authorize',
      ' /oauth/authorize',
      '/oauth/authorize ',
      '/oauth/authorize?a=1 ',
      '/oauth/authorize?a=\n',
      '/oauth/authorize?a=\t1',
      '/oauth/authorize?a=\\evil.example',
      '/oauth/authorize\\@evil.example',
      '//evil.example/oauth/authorize',
      '/\\evil.example/oauth/authorize',
      'https://evil.example/oauth/authorize',
      'http://localhost/oauth/authorize',
      `${ISS}/oauth/authorize`,
      'javascript:alert(1)',
      'data:text/html,x',
      `/oauth/authorize?${'x'.repeat(8192)}`,
    ]
    for (const next of ignored) expect(safeNextPath(next), JSON.stringify(next)).toBe(null)
  })
})
