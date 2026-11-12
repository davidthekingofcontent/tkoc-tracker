import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, and no address in the
// environment so every URL is built from the default one.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import {
  CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT,
  MAX_CLIENTS,
  MCP_RESOURCE,
  REFRESH_REUSE_LEEWAY_MS,
  STATE_MAX_CHARS,
  WWW_AUTHENTICATE_BEARER,
} from '@/lib/mcp/config'
import { pkceChallengeS256, randomSecret, sha256Hex } from '@/lib/mcp/crypto'
import {
  type OAuthError,
  type TokenResponse,
  allowCall,
  authenticateBearer,
  checkAdminSession,
  createGrantAndCode,
  exchangeCode,
  handleTokenRequest,
  isOAuthError,
  listGrants,
  refresh,
  registerClient,
  revokeGrant,
  revokeToken,
  sweepExpired,
  validateAuthorizeRequest,
} from '@/lib/mcp/oauth'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const ISS = 'https://intelligence.thekingofcontent.agency'
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

const userIds: string[] = []
let ipCounter = 0
/** A fresh address per registration, so the per-address rate limit never interferes. */
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}-${randomUUID().slice(0, 8)}`

async function makeUser(role: 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR', name = `Test ${role}`) {
  const user = await prisma.user.create({
    data: { email: `${role.toLowerCase()}-${randomUUID()}@test.invalid`, password: 'not-a-real-hash', name, role },
  })
  userIds.push(user.id)
  return user
}

/** The OAuthError a call rejects with, or a failure of the test. */
async function oauthError(run: () => Promise<unknown>): Promise<OAuthError> {
  try {
    await run()
  } catch (e) {
    if (isOAuthError(e)) return e
    throw e
  }
  throw new Error('expected an OAuthError, nothing was thrown')
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields)

/** Registers a client and gets an authorization code for it, as the consent decision would. */
async function approve(adminId: string, redirectUri = CLAUDE_AI, registered = redirectUri) {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [registered] }, nextIp())
  const verifier = randomSecret()
  const { grantId, code } = await createGrantAndCode({
    userId: adminId,
    clientId: client.client_id,
    redirectUri,
    codeChallenge: pkceChallengeS256(verifier),
  })
  return { clientId: client.client_id, grantId, code, verifier, redirectUri }
}

/** The whole way to a working connection: register, approve, exchange the code. */
async function connect(adminId: string) {
  const a = await approve(adminId)
  const tokens = await exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: a.redirectUri }))
  return { ...a, tokens }
}

const bearer = (tokens: TokenResponse) => authenticateBearer(`Bearer ${tokens.access_token}`)
const grantRow = (id: string) => prisma.mcpGrant.findUniqueOrThrow({ where: { id } })

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

describe('additive SQL against a real database', () => {
  it('creates exactly the tables prisma expects, and the rollback removes them', async () => {
    const statements = (file: string) =>
      fs
        .readFileSync(path.join(root, 'prisma', 'additive', file), 'utf8')
        .replace(/--[^\n]*/g, ' ')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
    const columnsOf = `
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1::text AND table_name LIKE 'mcp\\_%'
      ORDER BY table_name, ordinal_position`
    const indexesOf = `
      SELECT tablename, indexname, replace(indexdef, $1::text || '.', '') AS indexdef
      FROM pg_indexes WHERE schemaname = $1::text AND tablename LIKE 'mcp\\_%'
      ORDER BY indexname`
    class Rollback extends Error {}

    let compared = false
    await prisma
      .$transaction(
        async tx => {
          // The hand-applied script runs in a scratch schema; `public` holds what `prisma db push` built
          await tx.$executeRawUnsafe('CREATE SCHEMA mcp_sql_check')
          await tx.$executeRawUnsafe('SET LOCAL search_path TO mcp_sql_check')
          for (const s of statements('2026-11-12-mcp.sql')) await tx.$executeRawUnsafe(s)

          const fromSql = await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'mcp_sql_check')
          const fromPrisma = await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'public')
          expect(fromSql.length).toBe(43)
          expect(fromSql).toEqual(fromPrisma)
          const idxSql = await tx.$queryRawUnsafe<Record<string, unknown>[]>(indexesOf, 'mcp_sql_check')
          const idxPrisma = await tx.$queryRawUnsafe<Record<string, unknown>[]>(indexesOf, 'public')
          expect(idxSql.length).toBe(11)
          expect(idxSql).toEqual(idxPrisma)

          for (const s of statements('2026-11-12-mcp.down.sql')) await tx.$executeRawUnsafe(s)
          const left = await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'mcp_sql_check')
          expect(left).toEqual([])
          // The rollback touched the scratch schema only
          expect((await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'public')).length).toBe(43)
          compared = true
          throw new Rollback()
        },
        { timeout: 20_000 },
      )
      .catch(e => {
        if (!(e instanceof Rollback)) throw e
      })
    expect(compared).toBe(true)
    // Nothing of the scratch schema is left behind
    const schemas = await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'mcp_sql_check'`)
    expect(schemas).toEqual([])
  })
})

describe('client registration', () => {
  it('registers a public client and answers per RFC 7591', async () => {
    const before = Math.floor(Date.now() / 1000)
    const client = await registerClient(
      { client_name: 'Claude', redirect_uris: [CLAUDE_AI], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      '203.0.113.7',
    )
    expect(client).toEqual({
      client_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_id_issued_at: expect.any(Number),
      client_name: 'Claude',
      redirect_uris: [CLAUDE_AI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'tkoc.read',
    })
    expect(client.client_id_issued_at).toBeGreaterThanOrEqual(before - 1)
    expect(client).not.toHaveProperty('client_secret')
    const row = await prisma.mcpClient.findUniqueOrThrow({ where: { clientId: client.client_id } })
    expect(row).toMatchObject({ name: 'Claude', redirectUris: [CLAUDE_AI], createdFromIp: '203.0.113.7', lastUsedAt: null })
  })

  it('stores nothing when the request is refused', async () => {
    expect((await oauthError(() => registerClient({ redirect_uris: ['https://evil.example/cb'] }, nextIp()))).code).toBe('invalid_redirect_uri')
    expect((await oauthError(() => registerClient({ redirect_uris: [CLAUDE_AI], token_endpoint_auth_method: 'client_secret_post' }, nextIp()))).code).toBe('invalid_client_metadata')
    expect(await prisma.mcpClient.count()).toBe(0)
  })

  it('allows 10 registrations per hour per address, then answers 429', async () => {
    const ip = `203.0.113.99-${randomUUID()}`
    for (let i = 0; i < 10; i++) await registerClient({ redirect_uris: [CLAUDE_AI] }, ip)
    const e = await oauthError(() => registerClient({ redirect_uris: [CLAUDE_AI] }, ip))
    expect(e.code).toBe('temporarily_unavailable')
    expect(e.status).toBe(429)
    // Refused requests count too, and another address is not affected
    expect((await oauthError(() => registerClient({ redirect_uris: ['https://evil.example/cb'] }, ip))).status).toBe(429)
    await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    expect(await prisma.mcpClient.count()).toBe(11)
  })

  it('does not let one Claude account use up the registrations of claude.ai: Anthropic\'s range shares a larger allowance', async () => {
    // Every claude.ai and desktop user registers from Anthropic's egress range (160.79.104.0/21)
    const egress = ['160.79.104.10', '160.79.105.200', '160.79.111.254', '::ffff:160.79.108.7']
    for (let i = 0; i < 25; i++) await registerClient({ redirect_uris: [CLAUDE_AI] }, egress[i % egress.length])
    // The owner's own Connect, from the same addresses, still works
    const owner = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, '160.79.104.10')
    expect(owner.client_id).toEqual(expect.any(String))
    expect(await prisma.mcpClient.count()).toBe(26)

    // One allowance for the whole range, so it still has a ceiling
    for (let i = 26; i < CLAUDE_EGRESS_REGISTRATION_RATE_LIMIT.max; i++) {
      await registerClient({ redirect_uris: [CLAUDE_AI] }, egress[i % egress.length])
    }
    const e = await oauthError(() => registerClient({ redirect_uris: [CLAUDE_AI] }, '160.79.110.1'))
    expect(e).toMatchObject({ code: 'temporarily_unavailable', status: 429 })
    // The table never grew past its own bound meanwhile
    expect(await prisma.mcpClient.count()).toBe(MAX_CLIENTS)

    // Next to the range, an address is an address: 10 per hour
    const neighbour = `160.79.112.${1 + (ipCounter++ % 250)}`
    for (let i = 0; i < 10; i++) await registerClient({ redirect_uris: [CLAUDE_AI] }, neighbour)
    expect((await oauthError(() => registerClient({ redirect_uris: [CLAUDE_AI] }, neighbour))).status).toBe(429)
  }, 120_000)

  it('ignores the scope a client asks for at registration and registers it for tkoc.read', async () => {
    for (const scope of ['tkoc.read offline_access', 'tkoc.write', 'openid profile', '']) {
      const client = await registerClient({ redirect_uris: [CLAUDE_AI], scope }, nextIp())
      expect(client.scope, scope).toBe('tkoc.read')
    }
    // Asking for more than tkoc.read is still refused where it would be granted
    const client = await registerClient({ redirect_uris: [CLAUDE_AI], scope: 'tkoc.read tkoc.write' }, nextIp())
    const asked = await validateAuthorizeRequest({
      response_type: 'code', client_id: client.client_id, redirect_uri: CLAUDE_AI,
      code_challenge: pkceChallengeS256(randomSecret()), code_challenge_method: 'S256', scope: 'tkoc.read tkoc.write',
    })
    expect(asked).toMatchObject({ ok: false, redirect: true, error: 'invalid_scope' })
  })

  it('deletes clients older than 30 days that never obtained a grant, and keeps the others', async () => {
    const admin = await makeUser('ADMIN')
    const old = new Date(Date.now() - 31 * DAY)
    await prisma.mcpClient.createMany({
      data: [
        { clientId: 'old-never-granted', name: 'a', redirectUris: [CLAUDE_AI], createdAt: old },
        { clientId: 'old-with-live-grant', name: 'b', redirectUris: [CLAUDE_AI], createdAt: old },
        { clientId: 'old-with-revoked-grant', name: 'c', redirectUris: [CLAUDE_AI], createdAt: old },
        { clientId: 'recent-never-granted', name: 'd', redirectUris: [CLAUDE_AI], createdAt: new Date(Date.now() - 29 * DAY) },
      ],
    })
    await prisma.mcpGrant.createMany({
      data: [
        { id: 'g-live', clientId: 'old-with-live-grant', userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE },
        { id: 'g-dead', clientId: 'old-with-revoked-grant', userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE, revokedAt: new Date(), revokedReason: 'test' },
      ],
    })
    await prisma.mcpToken.create({ data: { grantId: 'g-live', kind: 'refresh', tokenHash: sha256Hex(randomSecret()), expiresAt: new Date(Date.now() + DAY) } })

    const created = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const left = (await prisma.mcpClient.findMany({ select: { clientId: true } })).map(c => c.clientId).sort()
    expect(left).toEqual([created.client_id, 'old-with-live-grant', 'old-with-revoked-grant', 'recent-never-granted'].sort())
  })

  it('never holds more than 200 clients: the oldest unused go first, a client in use never', async () => {
    const admin = await makeUser('ADMIN')
    const base = Date.now() - 10 * DAY
    await prisma.mcpClient.createMany({
      data: Array.from({ length: MAX_CLIENTS }, (_, i) => ({
        clientId: `bulk-${String(i).padStart(3, '0')}`,
        name: `bulk ${i}`,
        redirectUris: [CLAUDE_AI],
        createdAt: new Date(base + i * 1000),
        // bulk-001 was used once: it is evicted after every never-used client
        lastUsedAt: i === 1 ? new Date(base + DAY) : null,
      })),
    })
    // The very oldest one is in use
    await prisma.mcpGrant.create({ data: { id: 'g-bulk-0', clientId: 'bulk-000', userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE } })
    await prisma.mcpToken.create({ data: { grantId: 'g-bulk-0', kind: 'refresh', tokenHash: sha256Hex(randomSecret()), expiresAt: new Date(Date.now() + DAY) } })

    const first = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    expect(await prisma.mcpClient.count()).toBe(MAX_CLIENTS)
    const gone = async (id: string) => (await prisma.mcpClient.count({ where: { clientId: id } })) === 0
    expect(await gone('bulk-000')).toBe(false)
    expect(await gone('bulk-001')).toBe(false)
    expect(await gone('bulk-002')).toBe(true)
    expect(await gone('bulk-003')).toBe(false)
    expect(await gone(first.client_id)).toBe(false)

    await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    expect(await prisma.mcpClient.count()).toBe(MAX_CLIENTS)
    expect(await gone('bulk-003')).toBe(true)
    expect(await gone('bulk-000')).toBe(false)
  })

  it('refuses a new client when all 200 are in use', async () => {
    const admin = await makeUser('ADMIN')
    const ids = Array.from({ length: MAX_CLIENTS }, (_, i) => `busy-${i}`)
    await prisma.mcpClient.createMany({ data: ids.map(clientId => ({ clientId, name: clientId, redirectUris: [CLAUDE_AI] })) })
    await prisma.mcpGrant.createMany({ data: ids.map(clientId => ({ id: `g-${clientId}`, clientId, userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE })) })
    await prisma.mcpToken.createMany({
      data: ids.map(clientId => ({ grantId: `g-${clientId}`, kind: 'refresh', tokenHash: sha256Hex(randomSecret()), expiresAt: new Date(Date.now() + DAY) })),
    })
    const e = await oauthError(() => registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp()))
    expect(e.code).toBe('temporarily_unavailable')
    expect(e.status).toBe(503)
    expect(await prisma.mcpClient.count()).toBe(MAX_CLIENTS)
  })
})

describe('authorization request', () => {
  const challenge = pkceChallengeS256(randomSecret())
  const query = (clientId: string, over: Record<string, string | string[] | undefined> = {}) => ({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_AI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...over,
  })

  it('accepts a correct request, with resource and scope absent or exact', async () => {
    const client = await registerClient({ client_name: '<b>Claude</b>', redirect_uris: [CLAUDE_AI] }, nextIp())
    const expected = {
      ok: true,
      request: { clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: challenge, state: 'xyz', resource: MCP_RESOURCE, scope: 'tkoc.read' },
      client: { clientId: client.client_id, name: '<b>Claude</b>', redirectKind: 'claude' },
    }
    expect(await validateAuthorizeRequest(query(client.client_id))).toEqual(expected)
    expect(await validateAuthorizeRequest(query(client.client_id, { resource: MCP_RESOURCE, scope: 'tkoc.read' }))).toEqual(expected)
    // The same from a query string, as the page receives it
    const qs = new URLSearchParams(query(client.client_id) as Record<string, string>)
    expect(await validateAuthorizeRequest(qs)).toEqual(expected)
    const noState = await validateAuthorizeRequest(query(client.client_id, { state: undefined }))
    expect(noState.ok && noState.request.state).toBe(null)
  })

  it('shows an error page and never redirects when the client or the redirect URI is wrong', async () => {
    const client = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const cases: Record<string, string | string[] | undefined>[] = [
      query(randomSecret()),
      query('not-a-client-id'),
      query(client.client_id, { client_id: undefined }),
      query(client.client_id, { client_id: [client.client_id, client.client_id] }),
      query(client.client_id, { redirect_uri: undefined }),
      query(client.client_id, { redirect_uri: 'https://evil.example/callback' }),
      query(client.client_id, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }),
      query(client.client_id, { redirect_uri: 'https://claude.ai.evil.com/api/mcp/auth_callback' }),
      query(client.client_id, { redirect_uri: `${CLAUDE_AI}@evil.com` }),
      query(client.client_id, { redirect_uri: `${CLAUDE_AI}#x` }),
      query(client.client_id, { redirect_uri: 'http://localhost:3118/callback' }),
      query(client.client_id, { redirect_uri: [CLAUDE_AI, 'https://evil.example/callback'] }),
      // Even when everything else is also wrong, nothing is sent to the bad address
      query(client.client_id, { redirect_uri: 'https://evil.example/callback', response_type: 'token', code_challenge: undefined }),
    ]
    for (const c of cases) {
      const v = await validateAuthorizeRequest(c)
      expect(v.ok).toBe(false)
      expect(v.ok === false && v.redirect, JSON.stringify(c)).toBe(false)
      expect(v).not.toHaveProperty('redirectTo')
      expect(JSON.stringify(v)).not.toContain('evil')
    }
  })

  it('sends every other error back to the client with error, state and iss', async () => {
    const client = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const cases: [Record<string, string | string[] | undefined>, string][] = [
      [query(client.client_id, { response_type: undefined }), 'invalid_request'],
      [query(client.client_id, { response_type: 'token' }), 'unsupported_response_type'],
      [query(client.client_id, { response_type: 'code id_token' }), 'unsupported_response_type'],
      [query(client.client_id, { code_challenge: undefined }), 'invalid_request'],
      [query(client.client_id, { code_challenge: 'too-short' }), 'invalid_request'],
      [query(client.client_id, { code_challenge_method: undefined }), 'invalid_request'],
      [query(client.client_id, { code_challenge_method: 'plain' }), 'invalid_request'],
      [query(client.client_id, { resource: 'https://other.example/api/mcp' }), 'invalid_target'],
      [query(client.client_id, { resource: `${MCP_RESOURCE}/` }), 'invalid_target'],
      [query(client.client_id, { resource: [MCP_RESOURCE, MCP_RESOURCE] }), 'invalid_target'],
      [query(client.client_id, { scope: 'tkoc.write' }), 'invalid_scope'],
      [query(client.client_id, { scope: 'tkoc.read tkoc.write' }), 'invalid_scope'],
      [query(client.client_id, { scope: 'openid' }), 'invalid_scope'],
    ]
    for (const [c, error] of cases) {
      const v = await validateAuthorizeRequest(c)
      expect(v).toMatchObject({ ok: false, redirect: true, error })
      if (v.ok || !v.redirect) throw new Error('unreachable')
      const url = new URL(v.redirectTo)
      expect(url.origin + url.pathname).toBe(CLAUDE_AI)
      expect(url.searchParams.get('error')).toBe(error)
      expect(url.searchParams.get('state')).toBe('xyz')
      expect(url.searchParams.get('iss')).toBe(ISS)
      expect(url.searchParams.has('code')).toBe(false)
    }
    // A state that is too long, repeated or not printable ASCII is refused and never echoed
    expect((await validateAuthorizeRequest(query(client.client_id, { state: 'x'.repeat(STATE_MAX_CHARS) }))).ok).toBe(true)
    for (const state of ['x'.repeat(STATE_MAX_CHARS + 1), ['a', 'b'], 'line\nbreak', `caf${String.fromCharCode(0xe9)}`, `nul${String.fromCharCode(0)}`]) {
      const v = await validateAuthorizeRequest(query(client.client_id, { state }))
      expect(v).toMatchObject({ ok: false, redirect: true, error: 'invalid_request' })
      expect(v.ok === false && v.redirect && new URL(v.redirectTo).searchParams.has('state')).toBe(false)
    }
  })

  it('a loopback client may come back on any port, but only on its own host and path', async () => {
    const client = await registerClient({ client_name: 'Claude Code', redirect_uris: ['http://localhost:3118/callback'] }, nextIp())
    const ok = await validateAuthorizeRequest(query(client.client_id, { redirect_uri: 'http://localhost:51234/callback' }))
    expect(ok).toMatchObject({ ok: true, request: { redirectUri: 'http://localhost:51234/callback' }, client: { redirectKind: 'loopback' } })
    for (const bad of ['http://127.0.0.1:3118/callback', 'http://localhost:3118/other', 'http://localhost.evil.com:3118/callback', 'http://localhost@evil.com/callback', CLAUDE_AI]) {
      expect(await validateAuthorizeRequest(query(client.client_id, { redirect_uri: bad }))).toMatchObject({ ok: false, redirect: false })
    }
  })
})

describe('who may approve', () => {
  it('recognises an administrator session and nothing else', async () => {
    const admin = await makeUser('ADMIN', 'Ada Admin')
    const employee = await makeUser('EMPLOYEE')
    const brand = await makeUser('BRAND')
    expect(await checkAdminSession(generateToken(admin.id, 'ADMIN'))).toEqual({ status: 'admin', user: { id: admin.id, name: 'Ada Admin' } })
    expect(await checkAdminSession(generateToken(employee.id, 'EMPLOYEE'))).toEqual({ status: 'forbidden', role: 'EMPLOYEE' })
    expect(await checkAdminSession(generateToken(brand.id, 'BRAND'))).toEqual({ status: 'forbidden', role: 'BRAND' })
    for (const none of [undefined, null, '', 'garbage', `${generateToken(admin.id, 'ADMIN')}x`, generateToken('no-such-user', 'ADMIN')]) {
      expect(await checkAdminSession(none)).toEqual({ status: 'anonymous' })
    }
  })

  it('does not trust the role claim of the token: the database decides', async () => {
    const employee = await makeUser('EMPLOYEE')
    // A token that claims ADMIN for someone who is not
    expect(await checkAdminSession(generateToken(employee.id, 'ADMIN'))).toEqual({ status: 'anonymous' })
    const admin = await makeUser('ADMIN')
    const session = generateToken(admin.id, 'ADMIN')
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'EMPLOYEE' } })
    expect(await checkAdminSession(session)).toEqual({ status: 'anonymous' })
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN', isActive: false } })
    expect(await checkAdminSession(session)).toEqual({ status: 'anonymous' })
  })

  it('only an active ADMIN gets a grant and a code', async () => {
    const client = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const input = { clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) }
    const inactive = await makeUser('ADMIN')
    await prisma.user.update({ where: { id: inactive.id }, data: { isActive: false } })
    for (const user of [await makeUser('EMPLOYEE'), await makeUser('BRAND'), await makeUser('CREATOR'), inactive, { id: 'no-such-user' }]) {
      const e = await oauthError(() => createGrantAndCode({ ...input, userId: user.id }))
      expect(e.code).toBe('access_denied')
      expect(e.status).toBe(403)
    }
    expect(await prisma.mcpGrant.count()).toBe(0)
    expect(await prisma.mcpAuthCode.count()).toBe(0)
  })

  it('checks the request again before creating anything', async () => {
    const admin = await makeUser('ADMIN')
    const client = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const good = { userId: admin.id, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) }
    expect((await oauthError(() => createGrantAndCode({ ...good, clientId: randomSecret() }))).code).toBe('invalid_client')
    expect((await oauthError(() => createGrantAndCode({ ...good, redirectUri: 'https://evil.example/cb' }))).code).toBe('invalid_request')
    expect((await oauthError(() => createGrantAndCode({ ...good, codeChallenge: 'plain-text' }))).code).toBe('invalid_request')
    expect((await oauthError(() => createGrantAndCode({ ...good, resource: 'https://other.example/api/mcp' }))).code).toBe('invalid_target')
    expect((await oauthError(() => createGrantAndCode({ ...good, scope: 'tkoc.write' }))).code).toBe('invalid_scope')
    expect(await prisma.mcpGrant.count()).toBe(0)

    const { grantId, code, expiresAt } = await createGrantAndCode({ ...good, resource: MCP_RESOURCE, scope: 'tkoc.read' })
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(4 * MINUTE)
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE)
    expect(await grantRow(grantId)).toMatchObject({ clientId: client.client_id, userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE, revokedAt: null, lastUsedAt: null })
  })
})

describe('the whole flow', () => {
  it('register, approve, token, call, refresh, and reuse of the old refresh token ends everything', async () => {
    const admin = await makeUser('ADMIN', 'Ada Admin')
    const c = await connect(admin.id)

    expect(c.tokens).toEqual({
      access_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: 'tkoc.read',
    })
    expect(c.tokens.access_token).not.toBe(c.tokens.refresh_token)

    const first = await bearer(c.tokens)
    expect(first).toEqual({
      ok: true,
      user: { id: admin.id, name: 'Ada Admin', role: 'ADMIN' },
      grant: { id: c.grantId, clientId: c.clientId, userId: admin.id, scope: 'tkoc.read', resource: MCP_RESOURCE },
      expiresAt: expect.any(Date),
    })
    // No contact data travels with the identity
    expect(JSON.stringify(first)).not.toContain(admin.email)
    // A refresh token is not an access token
    expect(await authenticateBearer(`Bearer ${c.tokens.refresh_token}`)).toMatchObject({ ok: false, reason: 'unknown', status: 401 })

    // Rotation: new pair, the old refresh token is marked, the old access token lives until it expires
    const second = await handleTokenRequest(form({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    expect(second.refresh_token).not.toBe(c.tokens.refresh_token)
    expect(second.access_token).not.toBe(c.tokens.access_token)
    expect(second).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'tkoc.read' })
    expect((await bearer(second)).ok).toBe(true)
    expect((await bearer(c.tokens)).ok).toBe(true)
    const oldRefresh = await prisma.mcpToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(c.tokens.refresh_token) } })
    expect(oldRefresh.rotatedAt).toBeInstanceOf(Date)

    // The new refresh token rotates again
    const third = await refresh(form({ refresh_token: second.refresh_token, client_id: c.clientId, resource: MCP_RESOURCE, scope: 'tkoc.read' }))
    expect((await bearer(third)).ok).toBe(true)

    // The first refresh token shows up again although the client already used its successor: the whole
    // grant is revoked, inside the leeway too (it is not the echo of its own exchange)
    const e = await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))
    expect(e.code).toBe('invalid_grant')
    expect(e.status).toBe(400)
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'refresh_reuse' })
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)
    for (const t of [c.tokens, second, third]) {
      const r = await bearer(t)
      expect(r).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
      expect(r.ok === false && r.wwwAuthenticate).toBe(`Bearer resource_metadata="${ISS}/.well-known/oauth-protected-resource"`)
    }
    // And the newest refresh token is dead too
    expect((await oauthError(() => refresh(form({ refresh_token: third.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
  })

  it('never stores a code or a token in clear', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    const codeRow = await prisma.mcpAuthCode.findFirstOrThrow({ where: { grantId: a.grantId } })
    expect(codeRow.codeHash).toBe(sha256Hex(a.code))
    const tokens = await exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: a.verifier }))
    const second = await refresh(form({ refresh_token: tokens.refresh_token, client_id: a.clientId }))

    const secrets = [a.code, a.verifier, tokens.access_token, tokens.refresh_token, second.access_token, second.refresh_token]
    const everything = JSON.stringify({
      clients: await prisma.mcpClient.findMany(),
      grants: await prisma.mcpGrant.findMany(),
      codes: await prisma.mcpAuthCode.findMany(),
      tokens: await prisma.mcpToken.findMany(),
    })
    for (const s of secrets) expect(everything).not.toContain(s)
    const rows = await prisma.mcpToken.findMany({ where: { grantId: a.grantId } })
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.map(r => r.tokenHash).sort()).toEqual([tokens.access_token, tokens.refresh_token, second.access_token, second.refresh_token].map(sha256Hex).sort())
  })
})

describe('authorization code', () => {
  it('works once: a second use is refused and revokes what the first one obtained', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    const request = () => exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: a.redirectUri }))
    const tokens = await request()
    expect((await bearer(tokens)).ok).toBe(true)

    const e = await oauthError(request)
    expect(e.code).toBe('invalid_grant')
    expect(await grantRow(a.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'code_reuse' })
    expect((await bearer(tokens)).ok).toBe(false)
    expect((await oauthError(() => refresh(form({ refresh_token: tokens.refresh_token, client_id: a.clientId })))).code).toBe('invalid_grant')
    // A third try finds nothing at all
    expect((await oauthError(request)).code).toBe('invalid_grant')
  })

  it('two simultaneous exchanges of one code never both keep a working token', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    const request = () => exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: a.verifier }))
    const results = await Promise.allSettled([request(), request()])
    const won = results.filter((r): r is PromiseFulfilledResult<TokenResponse> => r.status === 'fulfilled')
    expect(won.length).toBeLessThanOrEqual(1)
    expect(results.filter(r => r.status === 'rejected').every(r => isOAuthError((r as PromiseRejectedResult).reason))).toBe(true)
    expect((await grantRow(a.grantId)).revokedReason).toBe('code_reuse')
    for (const w of won) expect((await bearer(w.value)).ok).toBe(false)
    expect(await prisma.mcpToken.count({ where: { grantId: a.grantId } })).toBe(0)
  })

  it('a wrong code_verifier is invalid_grant, and does not burn the code', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    const attempt = (verifier: string) => exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: verifier }))
    for (const wrong of [randomSecret(), `${a.verifier}x`, 'short', pkceChallengeS256(a.verifier)]) {
      const e = await oauthError(() => attempt(wrong))
      expect(e.code).toBe('invalid_grant')
      expect(e.status).toBe(400)
    }
    expect((await oauthError(() => exchangeCode(form({ code: a.code, client_id: a.clientId })))).code).toBe('invalid_request')
    expect(await prisma.mcpToken.count()).toBe(0)
    expect((await grantRow(a.grantId)).revokedAt).toBe(null)
    // The legitimate client still gets its tokens
    expect((await bearer(await attempt(a.verifier))).ok).toBe(true)
  })

  it('is bound to its client, its redirect URI and its resource', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    const other = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const good = { code: a.code, client_id: a.clientId, code_verifier: a.verifier, redirect_uri: a.redirectUri }

    expect((await oauthError(() => exchangeCode(form({ ...good, client_id: other.client_id })))).code).toBe('invalid_grant')
    expect((await oauthError(() => exchangeCode(form({ ...good, client_id: randomSecret() })))).code).toBe('invalid_client')
    expect((await oauthError(() => exchangeCode(form({ ...good, client_id: 'nope' })))).code).toBe('invalid_client')
    expect((await oauthError(() => exchangeCode(form({ code: a.code, code_verifier: a.verifier })))).code).toBe('invalid_request')
    expect((await oauthError(() => exchangeCode(form({ ...good, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })))).code).toBe('invalid_grant')
    expect((await oauthError(() => exchangeCode(form({ ...good, redirect_uri: `${a.redirectUri}/` })))).code).toBe('invalid_grant')
    expect((await oauthError(() => exchangeCode(form({ ...good, resource: 'https://other.example/api/mcp' })))).code).toBe('invalid_target')
    expect((await oauthError(() => exchangeCode(form({ ...good, code: randomSecret() })))).code).toBe('invalid_grant')
    expect((await oauthError(() => exchangeCode(form({ ...good, code: 'not-a-code' })))).code).toBe('invalid_grant')
    expect((await oauthError(() => exchangeCode(new URLSearchParams(`code=${a.code}&code=${a.code}&client_id=${a.clientId}&code_verifier=${a.verifier}`)))).code).toBe('invalid_request')
    expect(await prisma.mcpToken.count()).toBe(0)

    // None of those attempts spent the code
    const tokens = await handleTokenRequest(form({ grant_type: 'authorization_code', ...good, resource: MCP_RESOURCE }))
    expect((await bearer(tokens)).ok).toBe(true)
  })

  it('a loopback client must present the very redirect URI it was sent to', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id, 'http://localhost:51234/callback', 'http://localhost:3118/callback')
    const good = { code: a.code, client_id: a.clientId, code_verifier: a.verifier }
    expect((await oauthError(() => exchangeCode(form({ ...good, redirect_uri: 'http://localhost:3118/callback' })))).code).toBe('invalid_grant')
    expect((await bearer(await exchangeCode(form({ ...good, redirect_uri: 'http://localhost:51234/callback' })))).ok).toBe(true)
  })

  it('expires after 5 minutes', async () => {
    const admin = await makeUser('ADMIN')
    const a = await approve(admin.id)
    await prisma.mcpAuthCode.updateMany({ where: { grantId: a.grantId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const e = await oauthError(() => exchangeCode(form({ code: a.code, client_id: a.clientId, code_verifier: a.verifier })))
    expect(e.code).toBe('invalid_grant')
    expect(await prisma.mcpToken.count()).toBe(0)
  })

  it('is worthless once the grant is revoked or its administrator is not one any more', async () => {
    const admin = await makeUser('ADMIN')
    const revoked = await approve(admin.id)
    expect(await revokeGrant(revoked.grantId, `admin:${admin.id}`)).toBe(true)
    expect((await oauthError(() => exchangeCode(form({ code: revoked.code, client_id: revoked.clientId, code_verifier: revoked.verifier })))).code).toBe('invalid_grant')

    const demoted = await approve(admin.id)
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'EMPLOYEE' } })
    expect((await oauthError(() => exchangeCode(form({ code: demoted.code, client_id: demoted.clientId, code_verifier: demoted.verifier })))).code).toBe('invalid_grant')
    expect(await grantRow(demoted.grantId)).toMatchObject({ revokedReason: 'user_not_admin' })
    expect(await prisma.mcpToken.count()).toBe(0)
  })
})

describe('refresh token', () => {
  it('is bound to its client, its scope and its resource', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const other = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const good = { refresh_token: c.tokens.refresh_token, client_id: c.clientId }

    expect((await oauthError(() => refresh(form({ ...good, client_id: other.client_id })))).code).toBe('invalid_grant')
    expect((await oauthError(() => refresh(form({ ...good, client_id: randomSecret() })))).code).toBe('invalid_client')
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token })))).code).toBe('invalid_request')
    expect((await oauthError(() => refresh(form({ client_id: c.clientId })))).code).toBe('invalid_request')
    expect((await oauthError(() => refresh(form({ ...good, scope: 'tkoc.read tkoc.write' })))).code).toBe('invalid_scope')
    expect((await oauthError(() => refresh(form({ ...good, resource: 'https://other.example/api/mcp' })))).code).toBe('invalid_target')
    expect((await oauthError(() => refresh(form({ ...good, refresh_token: randomSecret() })))).code).toBe('invalid_grant')
    // An access token is not a refresh token
    expect((await oauthError(() => refresh(form({ ...good, refresh_token: c.tokens.access_token })))).code).toBe('invalid_grant')

    // None of that revoked or rotated anything
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    expect((await bearer(await refresh(form(good)))).ok).toBe(true)
  })

  it('expires after 60 days, and an expired one is simply invalid_grant', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const row = await prisma.mcpToken.findUniqueOrThrow({ where: { tokenHash: sha256Hex(c.tokens.refresh_token) } })
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(60 * DAY - MINUTE)
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * DAY)
    await prisma.mcpToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
  })

  /** Moves the exchange of a refresh token back in time, as if it happened `ms` ago. */
  const exchangedAgo = (refreshToken: string, ms: number) =>
    prisma.mcpToken.update({ where: { tokenHash: sha256Hex(refreshToken) }, data: { rotatedAt: new Date(Date.now() - ms) } })

  it('two simultaneous refreshes with one token: both get a working pair, and the grant survives', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const request = () => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    const results = await Promise.allSettled([request(), request()])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const [a, b] = results.map(r => (r as PromiseFulfilledResult<TokenResponse>).value)
    expect(a.refresh_token).not.toBe(b.refresh_token)
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    // Whichever answer the client keeps, it works
    expect((await bearer(a)).ok).toBe(true)
    expect((await bearer(b)).ok).toBe(true)

    // The client goes on with one of them; the twin it dropped is retired by that renewal
    const next = await refresh(form({ refresh_token: b.refresh_token, client_id: c.clientId }))
    expect((await bearer(next)).ok).toBe(true)
    // So the dropped twin coming back is a stolen token: the grant is revoked
    expect((await oauthError(() => refresh(form({ refresh_token: a.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'refresh_reuse' })
    expect((await bearer(next)).ok).toBe(false)
  })

  it('a retry of a renewal whose answer was lost gets a fresh pair, and nothing is revoked', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const renew = () => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    await renew() // the answer never reaches the client
    const retried = await renew()
    expect((await bearer(retried)).ok).toBe(true)
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    // And the client goes on as usual
    const later = await refresh(form({ refresh_token: retried.refresh_token, client_id: c.clientId }))
    expect((await bearer(later)).ok).toBe(true)
  })

  it('an exchanged refresh token presented after the leeway revokes the grant', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const second = await refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    await exchangedAgo(c.tokens.refresh_token, REFRESH_REUSE_LEEWAY_MS + 1000)
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'refresh_reuse' })
    expect((await bearer(second)).ok).toBe(false)
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)
  })

  it('within the leeway, an exchanged refresh token from another client is not an echo: the grant is revoked', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const other = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    const second = await refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: other.client_id })))).code).toBe('invalid_grant')
    expect((await grantRow(c.grantId)).revokedReason).toBe('refresh_reuse')
    expect((await bearer(second)).ok).toBe(false)
  })

  it('two simultaneous refreshes after the leeway: nobody keeps a working token', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    await refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    await exchangedAgo(c.tokens.refresh_token, REFRESH_REUSE_LEEWAY_MS + 1000)
    const request = () => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    const results = await Promise.allSettled([request(), request()])
    expect(results.every(r => r.status === 'rejected' && isOAuthError(r.reason) && r.reason.code === 'invalid_grant')).toBe(true)
    expect((await grantRow(c.grantId)).revokedReason).toBe('refresh_reuse')
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)
  })

  it('rotation clears the dead tokens of its grant', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    await prisma.mcpToken.updateMany({ where: { grantId: c.grantId, kind: 'access' }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId }))
    const kinds = (await prisma.mcpToken.findMany({ where: { grantId: c.grantId } })).map(t => `${t.kind}${t.rotatedAt ? ':rotated' : ''}`).sort()
    expect(kinds).toEqual(['access', 'refresh', 'refresh:rotated'])
    expect((await prisma.mcpClient.findUniqueOrThrow({ where: { clientId: c.clientId } })).lastUsedAt).toBeInstanceOf(Date)
  })
})

describe('bearer check', () => {
  it('an access token expires after one hour', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const ok = await bearer(c.tokens)
    if (!ok.ok) throw new Error('expected a valid token')
    expect(ok.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * MINUTE)
    expect(ok.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * MINUTE)
    await prisma.mcpToken.updateMany({ where: { grantId: c.grantId, kind: 'access' }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await bearer(c.tokens)).toMatchObject({ ok: false, reason: 'expired', status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
    // The refresh token still works: this is the normal renewal
    expect((await bearer(await refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).ok).toBe(true)
  })

  it('refuses unknown tokens and session tokens of the platform', async () => {
    const admin = await makeUser('ADMIN')
    await connect(admin.id)
    expect(await authenticateBearer(`Bearer ${randomSecret()}`)).toMatchObject({ ok: false, reason: 'unknown', status: 401 })
    // The JWT of a logged-in administrator is not an MCP token
    expect(await authenticateBearer(`Bearer ${generateToken(admin.id, 'ADMIN')}`)).toMatchObject({ ok: false, reason: 'malformed', status: 401 })
    expect(await authenticateBearer(null)).toMatchObject({ ok: false, reason: 'missing', status: 401, body: { error: 'unauthorized' } })
  })

  it('accepts the scheme in any case', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    expect((await authenticateBearer(`bearer ${c.tokens.access_token}`)).ok).toBe(true)
    expect((await authenticateBearer(`BEARER   ${c.tokens.access_token}  `)).ok).toBe(true)
  })

  it('an administrator who is demoted loses access at once, and does not get it back when promoted again', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    expect((await bearer(c.tokens)).ok).toBe(true)

    await prisma.user.update({ where: { id: admin.id }, data: { role: 'EMPLOYEE' } })
    expect(await bearer(c.tokens)).toMatchObject({ ok: false, reason: 'user_not_admin', status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'user_not_admin' })
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')

    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } })
    expect((await bearer(c.tokens)).ok).toBe(false)
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
  })

  it('an administrator who is deactivated or deleted loses access at once', async () => {
    const deactivated = await makeUser('ADMIN')
    const a = await connect(deactivated.id)
    await prisma.user.update({ where: { id: deactivated.id }, data: { isActive: false } })
    expect(await bearer(a.tokens)).toMatchObject({ ok: false, reason: 'user_inactive', status: 401 })
    expect((await grantRow(a.grantId)).revokedReason).toBe('user_inactive')

    const deleted = await makeUser('ADMIN')
    const b = await connect(deleted.id)
    await prisma.user.delete({ where: { id: deleted.id } })
    expect(await bearer(b.tokens)).toMatchObject({ ok: false, reason: 'user_missing', status: 401 })
    expect((await grantRow(b.grantId)).revokedReason).toBe('user_missing')
  })

  it('a demoted administrator cannot renew either: the refresh revokes the grant', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    await prisma.user.update({ where: { id: admin.id }, data: { isActive: false } })
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
    expect((await grantRow(c.grantId)).revokedReason).toBe('user_inactive')
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)
  })

  it('a token bound to another resource is refused', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    await prisma.mcpGrant.update({ where: { id: c.grantId }, data: { resource: 'https://old.example/api/mcp' } })
    expect(await bearer(c.tokens)).toMatchObject({ ok: false, reason: 'wrong_resource', status: 401 })
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')
  })

  it('writes lastUsedAt at most once a minute', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    expect((await grantRow(c.grantId)).lastUsedAt).toBe(null)
    await bearer(c.tokens)
    const first = (await grantRow(c.grantId)).lastUsedAt
    expect(first).toBeInstanceOf(Date)
    await bearer(c.tokens)
    await bearer(c.tokens)
    expect((await grantRow(c.grantId)).lastUsedAt).toEqual(first)

    const twoMinutesAgo = new Date(Date.now() - 2 * MINUTE)
    await prisma.mcpGrant.update({ where: { id: c.grantId }, data: { lastUsedAt: twoMinutesAgo } })
    await bearer(c.tokens)
    expect(((await grantRow(c.grantId)).lastUsedAt as Date).getTime()).toBeGreaterThan(twoMinutesAgo.getTime() + MINUTE)
  })

  it('limits a grant to 120 calls per 10 minutes, each grant on its own', () => {
    const grant = `grant-${randomUUID()}`
    for (let i = 0; i < 120; i++) expect(allowCall(grant)).toBe(true)
    expect(allowCall(grant)).toBe(false)
    expect(allowCall(grant)).toBe(false)
    expect(allowCall(`grant-${randomUUID()}`)).toBe(true)
  })
})

describe('revocation', () => {
  it('from Ajustes: revoking a grant cuts access and deletes its tokens', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const untouched = await connect(admin.id)

    expect(await revokeGrant(c.grantId, `admin:${admin.id}`)).toBe(true)
    expect(await grantRow(c.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: `admin:${admin.id}` })
    expect(await prisma.mcpToken.count({ where: { grantId: c.grantId } })).toBe(0)
    expect(await bearer(c.tokens)).toMatchObject({ ok: false, status: 401, wwwAuthenticate: WWW_AUTHENTICATE_BEARER })
    expect((await oauthError(() => refresh(form({ refresh_token: c.tokens.refresh_token, client_id: c.clientId })))).code).toBe('invalid_grant')

    // Twice is harmless, an unknown id too, and the first reason stays
    expect(await revokeGrant(c.grantId, 'again')).toBe(false)
    expect(await revokeGrant('no-such-grant', 'x')).toBe(false)
    expect(await revokeGrant('', 'x')).toBe(false)
    expect((await grantRow(c.grantId)).revokedReason).toBe(`admin:${admin.id}`)
    // The other connection is not affected
    expect((await bearer(untouched.tokens)).ok).toBe(true)
  })

  it('by the client (RFC 7009): either token ends the grant, unknown tokens are not an error', async () => {
    const admin = await makeUser('ADMIN')
    const byRefresh = await connect(admin.id)
    await revokeToken(form({ token: byRefresh.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: byRefresh.clientId }))
    expect(await grantRow(byRefresh.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'client_revoked' })
    expect((await bearer(byRefresh.tokens)).ok).toBe(false)

    const byAccess = await connect(admin.id)
    await revokeToken(form({ token: byAccess.tokens.access_token }))
    expect((await grantRow(byAccess.grantId)).revokedReason).toBe('client_revoked')
    expect((await oauthError(() => refresh(form({ refresh_token: byAccess.tokens.refresh_token, client_id: byAccess.clientId })))).code).toBe('invalid_grant')

    await expect(revokeToken(form({ token: randomSecret() }))).resolves.toBeUndefined()
    await expect(revokeToken(form({ token: 'garbage', token_type_hint: 'whatever' }))).resolves.toBeUndefined()
    await expect(revokeToken(form({ token: byAccess.tokens.access_token }))).resolves.toBeUndefined()
    expect((await oauthError(() => revokeToken(form({})))).code).toBe('invalid_request')
  })

  it('another client cannot revoke a token that is not its own', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    const other = await registerClient({ redirect_uris: [CLAUDE_AI] }, nextIp())
    await revokeToken(form({ token: c.tokens.refresh_token, client_id: other.client_id }))
    expect((await grantRow(c.grantId)).revokedAt).toBe(null)
    expect((await bearer(c.tokens)).ok).toBe(true)
  })
})

describe('connections for the administrator', () => {
  it('lists the live grants of every administrator, newest first, without secrets or e-mails', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const bob = await makeUser('ADMIN', 'Bob Admin')
    const first = await connect(ada.id)
    await prisma.mcpGrant.update({ where: { id: first.grantId }, data: { createdAt: new Date(Date.now() - DAY) } })
    const second = await connect(bob.id)
    const revoked = await connect(ada.id)
    await revokeGrant(revoked.grantId, 'test')
    await bearer(second.tokens)

    const list = await listGrants()
    expect(list).toEqual([
      { id: second.grantId, clientId: second.clientId, clientName: 'Claude', userId: bob.id, userName: 'Bob Admin', scope: 'tkoc.read', createdAt: expect.any(Date), lastUsedAt: expect.any(Date) },
      { id: first.grantId, clientId: first.clientId, clientName: 'Claude', userId: ada.id, userName: 'Ada Admin', scope: 'tkoc.read', createdAt: expect.any(Date), lastUsedAt: null },
    ])
    const text = JSON.stringify(list)
    for (const secret of [first.tokens.access_token, second.tokens.refresh_token, ada.email, bob.email, 'tokenHash', 'email']) {
      expect(text).not.toContain(secret)
    }
  })

  it('closes the grants that have nothing alive left', async () => {
    const admin = await makeUser('ADMIN')
    // Approved, but the client never came for its tokens
    const abandoned = await approve(admin.id)
    await prisma.mcpAuthCode.updateMany({ where: { grantId: abandoned.grantId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    // Connected, then 60 days without use: every token expired
    const idle = await connect(admin.id)
    await prisma.mcpToken.updateMany({ where: { grantId: idle.grantId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    // Still pending, and still connected
    const pending = await approve(admin.id)
    const live = await connect(admin.id)
    // Only an expired access token, but the refresh token is good
    const renewable = await connect(admin.id)
    await prisma.mcpToken.updateMany({ where: { grantId: renewable.grantId, kind: 'access' }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const ids = (await listGrants()).map(g => g.id).sort()
    expect(ids).toEqual([pending.grantId, live.grantId, renewable.grantId].sort())
    expect(await grantRow(abandoned.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'expired' })
    expect(await grantRow(idle.grantId)).toMatchObject({ revokedAt: expect.any(Date), revokedReason: 'expired' })
    expect(await prisma.mcpToken.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0)
    expect(await prisma.mcpAuthCode.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0)

    // What survived still works
    expect((await bearer(live.tokens)).ok).toBe(true)
    expect((await bearer(await refresh(form({ refresh_token: renewable.tokens.refresh_token, client_id: renewable.clientId })))).ok).toBe(true)
    expect((await bearer(await exchangeCode(form({ code: pending.code, client_id: pending.clientId, code_verifier: pending.verifier })))).ok).toBe(true)
    await sweepExpired()
    expect((await listGrants()).map(g => g.id).sort()).toEqual(ids)
  })

  it('shows a grant whose client or user row is gone, so it can still be revoked', async () => {
    const admin = await makeUser('ADMIN')
    const c = await connect(admin.id)
    await prisma.mcpClient.deleteMany({ where: { clientId: c.clientId } })
    await prisma.user.delete({ where: { id: admin.id } })
    expect(await listGrants()).toMatchObject([{ id: c.grantId, clientName: null, userName: null }])
    expect(await revokeGrant(c.grantId, 'cleanup')).toBe(true)
    expect(await listGrants()).toEqual([])
  })
})
