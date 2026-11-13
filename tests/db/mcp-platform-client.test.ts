import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, a port the client must
// use, no public address and no Apify token, so nothing here reaches a network.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-platform-client'
  process.env.PORT = '3999'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
})

// The platform's Apify helper: the budget the status route reports is set by each test
const apify = vi.hoisted(() => ({ exhausted: false, usedPct: 42 as number | null, optionalBlocked: false, coreBlocked: false }))
vi.mock('@/lib/apify', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return {
    ...actual,
    isApifyExhausted: () => apify.exhausted,
    getApifyResumeDate: () => (apify.exhausted ? '2026-12-01T00:00:00.000Z' : null),
    getApifyBudget: async () => ({
      usd: null, limit: null, cycleEndsAt: '2026-12-01T00:00:00.000Z', softLimit: null, coreLimit: null,
      optionalBlocked: apify.optionalBlocked, coreBlocked: apify.coreBlocked, usedPct: apify.usedPct,
    }),
  }
})

import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import {
  PLATFORM_FORBIDDEN_PREFIXES,
  PLATFORM_JWT_TTL_SECONDS,
  PLATFORM_ROUTES,
  PlatformRequestError,
  callPlatform,
  describePlatformFailure,
  platformBaseUrl,
  resolvePlatformPath,
  setPlatformTransport,
  type PlatformMethod,
  type PlatformRefusal,
  type PlatformRequest,
} from '@/lib/mcp/platform-client'
import { createPlatformRouter, exportedMethods, listRouteFiles } from '../helpers/platform-router'

const ctx = { userId: 'user-not-in-db', grantId: 'grant-x' }

async function refusal(req: PlatformRequest): Promise<PlatformRefusal> {
  try {
    await callPlatform(ctx, req)
  } catch (e) {
    if (e instanceof PlatformRequestError) return e.reason
    throw e
  }
  throw new Error(`not refused: ${req.method} ${req.path}`)
}

afterEach(() => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
})

describe('what the platform client refuses before sending anything', () => {
  const spy = vi.fn(async () => Response.json({ ok: true }))
  const watch = () => {
    spy.mockClear()
    setPlatformTransport(spy)
  }

  it('path tricks: traversal, encoded slashes, absolute URLs, a query inside the path, backslashes', async () => {
    watch()
    const cases: [string, PlatformRefusal][] = [
      ['/api/campaigns/../team', 'traversal'],
      ['/api/campaigns/..', 'traversal'],
      ['/api/campaigns/./abc', 'traversal'],
      ['/api/../api/team', 'traversal'],
      ['/api/campaigns/abc..def', 'traversal'],
      ['/api/campaigns/abc%2F..%2Fteam', 'encoded'],
      ['/api/campaigns%2fabc', 'encoded'],
      ['/api/campaigns/%2e%2e', 'encoded'],
      ['/api/team%2Fusers', 'encoded'],
      ['/api/campaigns/abc%00', 'encoded'],
      ['http://evil.example/api/campaigns', 'absolute_url'],
      ['https://127.0.0.1:3000/api/campaigns', 'absolute_url'],
      ['HTTP://evil.example/api/campaigns', 'absolute_url'],
      ['javascript:alert(1)', 'absolute_url'],
      ['/api/proxy?url=http://evil.example', 'absolute_url'],
      ['//evil.example/api/campaigns', 'double_slash'],
      ['/api//campaigns', 'double_slash'],
      ['/api/campaigns?status=ACTIVE', 'query_in_path'],
      ['/api/campaigns/abc?x=1', 'query_in_path'],
      ['/api/campaigns#frag', 'query_in_path'],
      ['/api/campaigns\\..\\team', 'bad_characters'],
      ['/api/campaigns/', 'bad_characters'],
      ['/api/campaigns/abc def', 'bad_characters'],
      ['/api/campaigns/a.b', 'bad_characters'],
      ['/api/campaigns/' + 'x'.repeat(65), 'bad_characters'],
      ['/api/campaigns/ña', 'bad_characters'],
      ['api/campaigns', 'not_a_path'],
      ['/dashboard', 'not_a_path'],
      ['/mcp/confirmar/abc', 'not_a_path'],
      ['', 'not_a_path'],
      ['/api/' + 'a/'.repeat(300) + 'a', 'not_a_path'],
    ]
    for (const [path, reason] of cases) expect(await refusal({ method: 'GET', path }), path).toBe(reason)
    expect(spy).not.toHaveBeenCalled()
  })

  it('the parts of the platform out of reach for good, whatever method', async () => {
    watch()
    const forbidden = [
      '/api/team', '/api/team/users/abc', '/api/team/invite', '/api/auth/me', '/api/auth/password', '/api/auth/meta/callback',
      '/api/settings/integrations', '/api/settings/integrations/test', '/api/oauth/grants', '/api/oauth/grants/abc', '/api/oauth/token',
      '/api/mcp', '/api/mcp/actions/abc', '/api/cron/track', '/api/cron/stories', '/api/seed', '/api/discovery/seed', '/api/invite/tok123',
      '/api/influencers/invite/accept', '/api/influencers/invite/validate', '/api/admin/meta-subscribe', '/api/brand-connect/invite',
      '/api/ai/chat', '/api/proxy/image', '/api/data-deletion', '/api/live-capture/collect', '/api/live-capture/widget-config',
      '/api/meta/webhooks/instagram', '/api/admin/cleanup-auto-added', '/api/dashboard/creator',
      // Merging creators' records (and undoing a merge): an ADMIN in the platform only
      '/api/admin/person-merge',
    ]
    for (const path of forbidden) {
      for (const method of ['GET', 'POST', 'DELETE'] as PlatformMethod[]) {
        expect(await refusal({ method, path, ...(method === 'GET' ? {} : { body: {} }) }), `${method} ${path}`).toBe('forbidden')
      }
    }
    // Segment-aware: a longer name is not under the prefix (and is unknown here)
    expect(await refusal({ method: 'GET', path: '/api/teams' })).toBe('unknown_route')
    expect(await refusal({ method: 'GET', path: '/api/seeds' })).toBe('unknown_route')
    expect(spy).not.toHaveBeenCalled()
  })

  it('unknown routes, routes that do not answer JSON, and methods a route does not have', async () => {
    watch()
    for (const path of ['/api/nope', '/api/campaigns/abc/unknown', '/api/campaigns/abc/report/pdf', '/api/campaigns/abc/shipping', '/api/media/abc/thumb', '/api/influencers/abc/avatar', '/api/campaigns/abc/brief-files/file1', '/api/portal/campaigns/abc/report/pdf']) {
      expect(await refusal({ method: 'GET', path }), path).toBe('unknown_route')
    }
    const wrong: [PlatformMethod, string][] = [
      ['GET', '/api/campaigns/abc/track'],
      ['DELETE', '/api/campaigns'],
      ['POST', '/api/campaigns/abc/comments'],
      ['POST', '/api/campaigns/abc/notify-post'.replace('notify-post', 'export')],
      ['DELETE', '/api/meta/connections/abc'],
      ['POST', '/api/creators/ad-permissions'],
      ['DELETE', '/api/creators/ad-permissions'],
      ['POST', '/api/campaigns/abc/brief-files'],
      ['PUT', '/api/influencers/abc'],
    ]
    for (const [method, path] of wrong) expect(await refusal({ method, path, body: method === 'GET' ? undefined : {} }), `${method} ${path}`).toBe('method_not_allowed')
    expect(await refusal({ method: 'POST', path: '/api/campaigns/abc/notify-post' })).toBe('unknown_route')
    for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'get']) {
      expect(await refusal({ method: method as PlatformMethod, path: '/api/campaigns' }), method).toBe('method_not_allowed')
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('queries that carry credentials or are not scalars, and bodies that are not acceptable', async () => {
    watch()
    const queries: unknown[] = [{ token: 'x' }, { apiKey: 'x' }, { api_key: 'x' }, { secret: 'x' }, { password: 'x' }, { key: 'x' }, { 'a b': 1 }, { a: { b: 1 } }, { a: [1] }, { a: NaN }, { a: 'x'.repeat(1001) }, 'status=ACTIVE', ['a']]
    for (const query of queries) {
      expect(await refusal({ method: 'GET', path: '/api/campaigns', query: query as Record<string, string> }), JSON.stringify(query)).toBe('bad_query')
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let deep: unknown = 1
    for (let i = 0; i < 20; i++) deep = { d: deep }
    const bodies: [PlatformMethod, unknown][] = [
      ['GET', { a: 1 }],
      ['POST', cyclic],
      ['POST', { big: BigInt(1) }],
      ['POST', { text: 'x'.repeat(300 * 1024) }],
      ['POST', deep],
    ]
    for (const [method, body] of bodies) expect(await refusal({ method, path: '/api/campaigns', body })).toBe('bad_body')
    expect(spy).not.toHaveBeenCalled()
  })

  it('lets `key` through only on DELETE /api/settings/benchmarks, and only with a benchmark table name', async () => {
    watch()
    // Every other value of `key` there, `key` on any other route, and the other credential names stay refused
    for (const query of [{ key: 'apify_api_key' }, { key: 'x' }, { key: 'benchmark_fee_ranges; drop' }, { key: 'BENCHMARK_FEE_RANGES' }, { Key: 'benchmark_fee_ranges' }, { token: 'benchmark_fee_ranges' }]) {
      expect(await refusal({ method: 'DELETE', path: '/api/settings/benchmarks', query }), JSON.stringify(query)).toBe('bad_query')
    }
    for (const path of ['/api/campaigns', '/api/settings', '/api/settings/benchmarks']) {
      expect(await refusal({ method: 'GET', path, query: { key: 'benchmark_fee_ranges' } }), path).toBe('bad_query')
    }
    expect(await refusal({ method: 'PUT', path: '/api/settings/benchmarks', query: { key: 'benchmark_fee_ranges' }, body: {} })).toBe('bad_query')
    expect(spy).not.toHaveBeenCalled()
    // The table name and `all` are sent as they are
    for (const key of ['benchmark_fee_ranges', 'all']) {
      const res = await callPlatform({ userId: 'u1', grantId: 'g1' }, { method: 'DELETE', path: '/api/settings/benchmarks', query: { key, brandId: 'brand_1_a' } })
      expect(res.status, key).toBe(200)
    }
    expect(spy).toHaveBeenCalledTimes(2)
    const sent = (spy.mock.calls as unknown as [Request][]).map(([r]) => new URL(r.url).search)
    expect(sent).toEqual(['?key=benchmark_fee_ranges&brandId=brand_1_a', '?key=all&brandId=brand_1_a'])
  })

  it('matches static segments before ids, and gives the route pattern and its ids', () => {
    expect(resolvePlatformPath('/api/campaigns/compare')).toMatchObject({ pattern: '/api/campaigns/compare', params: {} })
    expect(resolvePlatformPath('/api/campaigns/ck123_A-b')).toMatchObject({ pattern: '/api/campaigns/[id]', params: { id: 'ck123_A-b' } })
    expect(resolvePlatformPath('/api/influencers/invite').pattern).toBe('/api/influencers/invite')
    expect(resolvePlatformPath('/api/influencers/analyze').pattern).toBe('/api/influencers/analyze')
    expect(resolvePlatformPath('/api/client-contacts/matches').pattern).toBe('/api/client-contacts/matches')
    expect(resolvePlatformPath('/api/campaigns/c1/media/m1')).toMatchObject({ pattern: '/api/campaigns/[id]/media/[mediaId]', params: { id: 'c1', mediaId: 'm1' } })
    expect(resolvePlatformPath('/api/campaigns/c1/media/manual').pattern).toBe('/api/campaigns/[id]/media/manual')
  })
})

describe('how the platform client sends and reads', () => {
  it('sends a 3-minute platform JWT for the administrator to 127.0.0.1 and this PORT, with redirects off and no cookie', async () => {
    const seen: Request[] = []
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => {
      seen.push(req)
      return Response.json({ status: 'ok' })
    }))
    setPlatformTransport(null) // the real transport: fetch
    const res = await callPlatform({ userId: 'admin-1', grantId: 'grant-1' }, { method: 'GET', path: '/api/health', query: { verbose: true, n: 2, skip: undefined } })
    expect(res).toEqual({ route: '/api/health', status: 200, ok: true, json: { status: 'ok' }, text: null, problem: null })
    expect(seen).toHaveLength(1)
    const req = seen[0]
    expect(req.url).toBe('http://127.0.0.1:3999/api/health?verbose=true&n=2')
    expect(req.method).toBe('GET')
    expect(req.redirect).toBe('manual')
    expect(req.headers.get('cookie')).toBe(null)
    expect(req.headers.get('content-type')).toBe(null)
    const auth = req.headers.get('authorization') ?? ''
    expect(auth).toMatch(/^Bearer /)
    const claims = jwt.verify(auth.slice(7), process.env.JWT_SECRET as string) as Record<string, unknown>
    expect(claims).toMatchObject({ userId: 'admin-1', role: 'ADMIN', mcpGrantId: 'grant-1' })
    expect((claims.exp as number) - (claims.iat as number)).toBe(PLATFORM_JWT_TTL_SECONDS)
    expect(PLATFORM_JWT_TTL_SECONDS).toBe(180)
  })

  it('takes the port from PORT only when it is a port', () => {
    const saved = process.env.PORT
    try {
      for (const [value, url] of [['8080', 'http://127.0.0.1:8080'], ['', 'http://127.0.0.1:3000'], ['80; evil', 'http://127.0.0.1:3000'], ['99999', 'http://127.0.0.1:3000'], ['evil.example', 'http://127.0.0.1:3000']] as const) {
        process.env.PORT = value
        expect(platformBaseUrl(), value).toBe(url)
      }
    } finally {
      process.env.PORT = saved
    }
  })

  it('NEVER follows a redirect: the 3xx comes back as a failure and nothing else is requested', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const transport = vi.fn(async (req: Request) => {
        expect(req.redirect).toBe('manual')
        return new Response(null, { status, headers: { location: 'https://evil.example/steal' } })
      })
      setPlatformTransport(transport)
      const res = await callPlatform(ctx, { method: 'POST', path: '/api/campaigns', body: { name: 'x' } })
      expect(res).toEqual({ route: '/api/campaigns', status, ok: false, json: null, text: null, problem: 'redirect' })
      expect(transport).toHaveBeenCalledTimes(1)
      expect(describePlatformFailure(res)).toContain('redirección')
    }
    // The real transport too: fetch is asked not to follow
    const fetchSpy = vi.fn(async (req: Request) => {
      expect(req.redirect).toBe('manual')
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    })
    vi.stubGlobal('fetch', fetchSpy)
    setPlatformTransport(null)
    expect((await callPlatform(ctx, { method: 'GET', path: '/api/health' })).problem).toBe('redirect')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('gives up after the timeout: the result is unknown, and it says so', async () => {
    let signal: AbortSignal | null = null
    setPlatformTransport(req => {
      signal = req.signal
      return new Promise<Response>(() => {})
    })
    const res = await callPlatform(ctx, { method: 'POST', path: '/api/campaigns/abc/track', timeoutMs: 50 })
    expect(res).toEqual({ route: '/api/campaigns/[id]/track', status: 0, ok: false, json: null, text: null, problem: 'timeout' })
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(describePlatformFailure(res)).toContain('Resultado desconocido')
  })

  it('reports a connection failure, an answer too large and an answer that is not JSON', async () => {
    setPlatformTransport(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect((await callPlatform(ctx, { method: 'GET', path: '/api/health' })).problem).toBe('network')

    setPlatformTransport(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }))
    expect((await callPlatform(ctx, { method: 'GET', path: '/api/health' })).problem).toBe('too_large')

    setPlatformTransport(async () => new Response('plain words', { status: 200, headers: { 'content-type': 'text/plain' } }))
    expect(await callPlatform(ctx, { method: 'GET', path: '/api/health' })).toEqual({ route: '/api/health', status: 200, ok: true, json: null, text: 'plain words', problem: null })

    setPlatformTransport(async () => Response.json({ error: 'El nombre de la campaña es obligatorio' }, { status: 400 }))
    const bad = await callPlatform(ctx, { method: 'POST', path: '/api/campaigns', body: {} })
    expect(bad).toMatchObject({ status: 400, ok: false, problem: null })
    expect(describePlatformFailure(bad)).toBe('La plataforma ha respondido 400: El nombre de la campaña es obligatorio')

    setPlatformTransport(async () => new Response('<html>stack trace at /app/x.js</html>', { status: 500, headers: { 'content-type': 'text/html' } }))
    const crashed = describePlatformFailure(await callPlatform(ctx, { method: 'GET', path: '/api/health' }))
    expect(crashed).not.toContain('stack')
    expect(crashed).toContain('500')
  })
})

describe('the route table', () => {
  const files = listRouteFiles()
  const onDisk = new Map(files.map(f => [f.pattern, exportedMethods(f.file)]))
  const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')

  /**
   * Routes and methods that exist, are not out of reach for good, and are
   * still NOT in PLATFORM_ROUTES, each for a reason. A route added to the
   * platform fails the last test until somebody puts it here or in the table.
   */
  const NOT_IN_TABLE: Record<string, string[]> = {
    '/api/campaigns/[id]/brief-files': ['POST'], // multipart upload, not JSON
    '/api/campaigns/[id]/brief-files/[fileId]': ['GET'], // the file itself
    '/api/campaigns/[id]/comments': ['POST'], // paid, unbounded scrape filed under the wrong piece
    '/api/campaigns/[id]/export': ['POST'], // duplicate of the GET
    '/api/campaigns/[id]/media/[mediaId]/insights': ['POST'], // AI credit
    '/api/campaigns/[id]/notify-post': ['POST'], // e-mails the team an unvalidated link
    '/api/campaigns/[id]/report/pdf': ['GET'], // PDF
    '/api/campaigns/[id]/shipping': ['GET'], // CSV with postal addresses
    '/api/creators/ad-permissions': ['POST', 'DELETE'], // consent records nobody granted
    '/api/influencers/[id]/avatar': ['GET'], // image
    '/api/media/[id]/thumb': ['GET'], // image
    '/api/meta/connections/[id]': ['DELETE'], // revokes a client's connection at Meta
    '/api/portal/campaigns/[id]/report/pdf': ['GET'], // PDF
    // Data repair run by an administrator by hand (folding duplicated members and undoing it): never through the connector
    '/api/admin/fold-twins': ['GET', 'POST'],
    // Identity changes (one creator, several profiles): a curated tool with approval in the platform comes in a later delivery
    '/api/influencers/[id]/unlink-profile': ['POST'],
  }

  it('every entry is a real route of this working copy, with that method', () => {
    for (const route of PLATFORM_ROUTES) {
      expect(onDisk.has(route.pattern), route.pattern).toBe(true)
      for (const m of route.methods) expect(onDisk.get(route.pattern), `${m} ${route.pattern}`).toContain(m)
    }
    expect(new Set(PLATFORM_ROUTES.map(r => r.pattern)).size).toBe(PLATFORM_ROUTES.length)
  })

  it('no entry is under a prefix out of reach for good', () => {
    for (const route of PLATFORM_ROUTES) {
      for (const prefix of PLATFORM_FORBIDDEN_PREFIXES) expect(isUnder(route.pattern, prefix), `${route.pattern} under ${prefix}`).toBe(false)
    }
  })

  it('every method of every route on disk is classified: in the table, out of reach, or excluded on purpose', () => {
    const unclassified: string[] = []
    for (const [pattern, methods] of onDisk) {
      if (PLATFORM_FORBIDDEN_PREFIXES.some(p => isUnder(pattern, p))) continue
      const inTable = PLATFORM_ROUTES.find(r => r.pattern === pattern)?.methods ?? []
      for (const m of methods) {
        if ((inTable as string[]).includes(m) || NOT_IN_TABLE[pattern]?.includes(m)) continue
        unclassified.push(`${m} ${pattern}`)
      }
    }
    expect(unclassified).toEqual([])
  })
})

// ============ Against the real route handlers, in-process ============

describe('calls through the in-process router to the real routes', () => {
  const tag = randomUUID().slice(0, 8)
  const fx = { admin: '', campaign: '', marta: '', luis: '' }
  const router = createPlatformRouter()

  beforeAll(async () => {
    const admin = await prisma.user.create({ data: { email: `pc-admin-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Cliente Plataforma', role: 'ADMIN' } })
    const campaign = await prisma.campaign.create({
      data: { name: `Campaña Cliente ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: admin.id },
    })
    const marta = await prisma.influencer.create({ data: { username: `marta_pc_${tag}`, platform: 'INSTAGRAM', followers: 1000 } })
    const luis = await prisma.influencer.create({ data: { username: `luis_pc_${tag}`, platform: 'INSTAGRAM', followers: 2000 } })
    await prisma.campaignInfluencer.createMany({
      data: [
        { campaignId: campaign.id, influencerId: marta.id, status: 'NEGOTIATING', agreedFee: 100 },
        { campaignId: campaign.id, influencerId: luis.id, status: 'NEGOTIATING' },
      ],
    })
    await prisma.media.create({ data: { campaignId: campaign.id, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `ext-pc-${tag}`, likes: 1, postedAt: new Date('2026-10-05T10:00:00.000Z'), source: 'manual' } })
    Object.assign(fx, { admin: admin.id, campaign: campaign.id, marta: marta.id, luis: luis.id })
    // Any attempt to reach the network fails the test that made it
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network access is not allowed in this test')
    }))
  })

  afterAll(async () => {
    await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
    await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
    await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
    await prisma.influencer.deleteMany({ where: { id: { in: [fx.marta, fx.luis] } } })
    await prisma.notification.deleteMany({ where: { userId: fx.admin } })
    await prisma.user.deleteMany({ where: { id: fx.admin } })
  })

  const as = () => ({ userId: fx.admin, grantId: 'grant-pc' })

  it('reads, changes and deletes exactly as the UI does, as the administrator', async () => {
    setPlatformTransport(router.transport)
    const read = await callPlatform(as(), { method: 'GET', path: `/api/campaigns/${fx.campaign}` })
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.json)).toContain(`Campaña Cliente ${tag}`)

    const patched = await callPlatform(as(), { method: 'PATCH', path: `/api/campaigns/${fx.campaign}/influencers`, body: { influencerId: fx.marta, agreedFee: 250 } })
    expect(patched.status).toBe(200)
    const row = await prisma.campaignInfluencer.findUniqueOrThrow({ where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.marta } } })
    expect(row.agreedFee).toBe(250)

    const removed = await callPlatform(as(), { method: 'DELETE', path: `/api/campaigns/${fx.campaign}/influencers`, body: { influencerId: fx.marta } })
    expect(removed.status).toBe(200)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.campaign, influencerId: fx.marta } })).toBe(0)
    expect(await prisma.media.count({ where: { campaignId: fx.campaign, influencerId: fx.marta } })).toBe(0)
    // Luis was never touched
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.campaign, influencerId: fx.luis } })).toBe(1)

    const status = await callPlatform(as(), { method: 'GET', path: '/api/apify-status' })
    expect(status.json).toMatchObject({ available: true, budget: { usedPct: 42, coreBlocked: false, optionalBlocked: false } })

    expect(router.calls.map(c => `${c.method} ${c.pattern} ${c.status}`)).toEqual([
      'GET /api/campaigns/[id] 200',
      'PATCH /api/campaigns/[id]/influencers 200',
      'DELETE /api/campaigns/[id]/influencers 200',
      'GET /api/apify-status 200',
    ])
  })

  it('the route itself refuses an administrator who was demoted or deactivated, whatever the client signed', async () => {
    setPlatformTransport(router.transport)
    await prisma.user.update({ where: { id: fx.admin }, data: { role: 'EMPLOYEE' } })
    try {
      expect((await callPlatform(as(), { method: 'GET', path: `/api/campaigns/${fx.campaign}` })).status).toBe(401)
    } finally {
      await prisma.user.update({ where: { id: fx.admin }, data: { role: 'ADMIN' } })
    }
    await prisma.user.update({ where: { id: fx.admin }, data: { isActive: false } })
    try {
      expect((await callPlatform(as(), { method: 'GET', path: `/api/campaigns/${fx.campaign}` })).status).toBe(401)
    } finally {
      await prisma.user.update({ where: { id: fx.admin }, data: { isActive: true } })
    }
    expect((await callPlatform({ userId: 'nobody', grantId: 'g' }, { method: 'GET', path: `/api/campaigns/${fx.campaign}` })).status).toBe(401)
    expect((await callPlatform(as(), { method: 'GET', path: `/api/campaigns/${fx.campaign}` })).status).toBe(200)
  })
})
