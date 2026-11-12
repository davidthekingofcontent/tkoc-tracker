import { describe, expect, it, vi } from 'vitest'

// Before any import: a fixed signing secret, no address in the environment
// (every URL is built from the production default) and no database: what is
// tested here is pure (the allow table, the refusals, the forced values, the
// classes and the shape of the answer).
vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-platform-request'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { ToolError } from '@/lib/mcp/tools/shared'
import { PLATFORM_FORBIDDEN_PREFIXES, PLATFORM_ROUTES, PlatformRequestError } from '@/lib/mcp/platform-client'
import {
  ALLOW_RULES,
  BENCHMARK_DELETE_BLOCKED,
  CURATED_WRITES,
  DENY_RULES,
  GENERIC_LONG_TIMEOUT_MS,
  GENERIC_OUTPUT_MAX_CHARS,
  GENERIC_TIMEOUT_MS,
  PLATFORM_REQUEST_NAME,
  allowedSummary,
  denyReason,
  platformRequestTool,
  prepareGenericRequest,
  registerPlatformRequest,
  selectPaths,
  shapeGenericAnswer,
  type PlatformRequestArgs,
  type WriteToolWiring,
} from '@/lib/mcp/tools/write/platform-request'

const SITE = 'https://intelligence.thekingofcontent.agency'

/** The refusal of a request, or a failure of the test when it is accepted. */
function refusal(args: PlatformRequestArgs): string {
  try {
    prepareGenericRequest(args)
  } catch (err) {
    if (err instanceof ToolError) return err.message
    throw err
  }
  throw new Error(`not refused: ${args.method} ${args.path}`)
}

const fill = (pattern: string) => pattern.replace(/\[[A-Za-z]+\]/g, 'ck0123456789abcdef')
const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/')

describe('platform_request: paths and methods it refuses before anything is sent', () => {
  it('path tricks are refused by the platform client rules: traversal, encoded slashes, absolute URLs, a query inside the path, backslashes', () => {
    const cases: [string, string][] = [
      ['/api/campaigns/../team', 'traversal'],
      ['/api/campaigns/abc%2F..%2Fteam', 'encoded'],
      ['/api/team%2Fusers', 'encoded'],
      ['http://evil.example/api/campaigns', 'absolute_url'],
      ['//evil.example/api/campaigns', 'double_slash'],
      ['/api/campaigns?status=ACTIVE', 'query_in_path'],
      ['/api/campaigns\\..\\team', 'bad_characters'],
      ['/dashboard', 'not_a_path'],
    ]
    for (const [path, reason] of cases) {
      let caught: unknown = null
      try {
        prepareGenericRequest({ method: 'GET', path })
      } catch (err) {
        caught = err
      }
      expect(caught, path).toBeInstanceOf(PlatformRequestError)
      expect((caught as PlatformRequestError).reason, path).toBe(reason)
    }
  })

  it('the parts out of reach for good are refused with the reason of the proposal, for every method', () => {
    const expectations: [string, RegExp][] = [
      ['/api/team', /Usuarios, roles/],
      ['/api/team/users/abc', /Usuarios, roles/],
      ['/api/team/invite', /Usuarios, roles/],
      ['/api/auth/me', /credenciales/],
      ['/api/auth/meta/callback', /credenciales/],
      ['/api/settings/integrations', /claves de Apify/],
      ['/api/settings/integrations/test', /claves de Apify/],
      ['/api/oauth/grants', /propias autorizaciones/],
      ['/api/oauth/token', /propias autorizaciones/],
      ['/api/mcp', /propias autorizaciones/],
      ['/api/mcp/actions/abc', /propias autorizaciones/],
      ['/api/cron/track', /programador/],
      ['/api/seed', /carga inicial/],
      ['/api/discovery/seed', /carga inicial/],
      ['/api/invite/tok123', /persona invitada/],
      ['/api/influencers/invite/accept', /persona invitada/],
      ['/api/admin/meta-subscribe', /conexiones de Meta/],
      ['/api/brand-connect/invite', /conexiones de Meta/],
      ['/api/meta/webhooks/instagram', /conexiones de Meta/],
      ['/api/data-deletion', /RGPD/],
      ['/api/live-capture/collect', /widget/],
      ['/api/ai/chat', /crédito de IA/],
      ['/api/admin/cleanup-auto-added', /desactivada/],
      ['/api/dashboard/creator', /creadora/],
      ['/api/proxy/image', /imagen/],
    ]
    for (const [path, reason] of expectations) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        expect(refusal({ method, path, ...(method === 'GET' ? {} : { body: {} }) }), `${method} ${path}`).toMatch(reason)
      }
    }
  })

  it('writes and files excluded on purpose are refused with their reason, and files point to the screen in the platform', () => {
    expect(refusal({ method: 'POST', path: '/api/campaigns/c1/comments', body: {} })).toMatch(/comentarios es de pago/)
    expect(refusal({ method: 'POST', path: '/api/campaigns/c1/notify-post', body: {} })).toMatch(/correo a todo el equipo/)
    expect(refusal({ method: 'POST', path: '/api/creators/ad-permissions', body: {} })).toMatch(/permiso de uso/)
    expect(refusal({ method: 'DELETE', path: '/api/creators/ad-permissions' })).toMatch(/permiso de uso/)
    expect(refusal({ method: 'DELETE', path: '/api/meta/connections/abc' })).toMatch(/conexiones de Meta/)
    expect(refusal({ method: 'POST', path: '/api/campaigns/c1/brief-files', body: {} })).toMatch(/multipart/)
    expect(refusal({ method: 'POST', path: '/api/campaigns/c1/export', body: {} })).toMatch(/duplicado/)
    expect(refusal({ method: 'POST', path: '/api/campaigns/c1/media/m1/insights', body: {} })).toMatch(/crédito de IA/)
    expect(refusal({ method: 'GET', path: '/api/campaigns/c1/notes' })).toMatch(/notas internas/)
    expect(refusal({ method: 'GET', path: '/api/campaigns/c1/report/pdf' })).toContain(`${SITE}/campaigns/c1/report`)
    expect(refusal({ method: 'GET', path: '/api/portal/campaigns/c1/report/pdf' })).toContain(`${SITE}/portal/campaigns/c1/report`)
    expect(refusal({ method: 'GET', path: '/api/campaigns/c1/brief-files/f1' })).toContain(`${SITE}/campaigns/c1`)
    expect(refusal({ method: 'GET', path: '/api/campaigns/c1/shipping' })).toContain('GET /api/pipeline?campaignId=c1')
    expect(refusal({ method: 'GET', path: '/api/media/m1/thumb' })).toMatch(/imagen/)
    expect(refusal({ method: 'GET', path: '/api/influencers/i1/avatar' })).toMatch(/imagen/)
  })

  it('unknown routes and methods are refused with the list of what exists', () => {
    for (const path of ['/api/nope', '/api/campaigns/c1/unknown', '/api/teams']) {
      const message = refusal({ method: 'GET', path })
      expect(message, path).toContain('platform_request no puede hacer GET')
      expect(message).toContain('GET /api/campaigns')
      expect(message).toContain('GET, POST /api/discovery/search')
    }
    // A known route, a method it does not have here
    const onRoute = refusal({ method: 'PUT', path: '/api/templates/t1', body: {} })
    expect(onRoute).toContain('En esa ruta solo acepta: DELETE.')
    // Methods that do not exist, or in another case
    for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'get', 'Delete']) {
      expect(refusal({ method, path: '/api/campaigns' }), method).toContain('Método no permitido')
    }
  })

  it('every write that has a curated tool is refused with the name of that tool', () => {
    for (const write of CURATED_WRITES) {
      const message = refusal({ method: write.method, path: fill(write.pattern), body: {} })
      expect(message, `${write.method} ${write.pattern}`).toContain('tiene su herramienta propia')
      for (const tool of write.tools) expect(message).toContain(tool)
    }
    expect(refusal({ method: 'PATCH', path: '/api/campaigns/c1/influencers', body: { influencerId: 'i1', agreedFee: 300 } })).toContain('update_creator_deal')
    expect(refusal({ method: 'DELETE', path: '/api/lists/l1' })).toContain('delete_list')
  })

  it('bodies and queries out of the limits, and wrong arguments of a route, are refused', () => {
    expect(refusal({ method: 'GET', path: '/api/campaigns', body: { a: 1 } })).toContain('Un GET no lleva body')
    expect(refusal({ method: 'POST', path: '/api/templates', body: { name: 'x', text: 'x'.repeat(65 * 1024) } })).toContain('64 KB')
    let deep: unknown = 1
    for (let i = 0; i < 9; i++) deep = { d: deep }
    expect(refusal({ method: 'POST', path: '/api/templates', body: deep })).toContain('8 niveles')
    let eight: unknown = 1
    for (let i = 0; i < 8; i++) eight = { d: eight }
    expect(() => prepareGenericRequest({ method: 'POST', path: '/api/templates', body: eight })).not.toThrow()
    expect(refusal({ method: 'POST', path: '/api/client-contacts/import', body: { contacts: Array.from({ length: 201 }, () => ({})) } })).toContain('200 elementos')
    for (const key of ['token', 'apiKey', 'api_key', 'secret', 'password', 'key']) {
      expect(refusal({ method: 'GET', path: '/api/campaigns', query: { [key]: 'x' } }), key).toContain('credenciales')
    }
    expect(refusal({ method: 'GET', path: '/api/campaigns', select: ['campaigns[0].name'] })).toContain('select')
    expect(refusal({ method: 'GET', path: '/api/portal/overview' })).toContain('brandId')
    expect(refusal({ method: 'GET', path: '/api/portal/overview', query: { brandId: 'brand_assignment_x' } })).toContain('brandId')
    expect(refusal({ method: 'DELETE', path: '/api/campaigns/c1/brief-files' })).toContain('fileId')
    expect(refusal({ method: 'PATCH', path: '/api/notifications', body: {} })).toContain('markAll')
    expect(refusal({ method: 'POST', path: '/api/competitors/c1', body: { action: 'delete' } })).toContain('refresh')
    expect(refusal({ method: 'POST', path: '/api/competitors', body: { username: 'https://instagram.com/x', platform: 'INSTAGRAM' } })).toContain('usuario')
    expect(refusal({ method: 'POST', path: '/api/creators/lookalikes', body: {} })).toContain('creatorId')
    // The platform client lets `key` through for this one route, with a benchmark table name only
    // (QUERY_KEY_EXCEPTIONS); the rule checks the exact table before anything is prepared
    expect(BENCHMARK_DELETE_BLOCKED).toBe(false)
    expect(refusal({ method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'apify_api_key' } })).toContain('query.key debe ser')
    expect(refusal({ method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'all' } })).toContain('key=all solo vale con brandId')
    expect(refusal({ method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'benchmark_markets', brandId: 'brand_1_a' } })).toContain('solo de la agencia')
    expect(refusal({ method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'benchmark_fee_ranges', brandId: 'brand_assignment_x' } })).toContain('brandId')
    // `key` stays a credential everywhere else, whatever its value
    expect(refusal({ method: 'GET', path: '/api/settings/benchmarks', query: { key: 'benchmark_fee_ranges' } })).toContain('credenciales')
    expect(refusal({ method: 'GET', path: '/api/campaigns', query: { key: 'benchmark_fee_ranges' } })).toContain('credenciales')
    expect(refusal({ method: 'PUT', path: '/api/settings/benchmarks', body: { key: 'cron_track_last_run', value: 1 } })).toContain('key debe ser')
    expect(refusal({ method: 'GET', path: '/api/knowledge-base', query: { offset: -1 } })).toContain('offset')
  })

  it('the paid creator search and the username lookup are not reachable: only the free category search', () => {
    expect(refusal({ method: 'POST', path: '/api/influencers/discover', body: { query: 'maria' } })).toContain('analyze_creator_profile')
    expect(refusal({ method: 'POST', path: '/api/influencers/discover', body: { query: 'maria', mode: 'username' } })).toContain('analyze_creator_profile')
    expect(refusal({ method: 'POST', path: '/api/influencers/discover', body: { query: 'moda', mode: 'category', confirmPaid: true } })).toContain('run_paid_creator_search')
    expect(refusal({ method: 'POST', path: '/api/influencers/discover', body: { query: 'moda', mode: 'category', confirmPaid: 'true' } })).toContain('run_paid_creator_search')
    expect(refusal({ method: 'POST', path: '/api/influencers/discover', body: { query: 'moda', mode: 'category', confirmed: { hashtag: 'moda' } } })).toContain('run_paid_creator_search')
    expect(prepareGenericRequest({ method: 'POST', path: '/api/influencers/discover', body: { query: 'moda', mode: 'category' } }).confirmation).toBe('none')
  })
})

describe('platform_request: classes and forced values', () => {
  const cls = (args: PlatformRequestArgs) => prepareGenericRequest(args).confirmation

  it('reads run without confirmation; every DELETE waits for the approval in the platform', () => {
    expect(cls({ method: 'GET', path: '/api/campaigns/c1' })).toBe('none')
    expect(cls({ method: 'GET', path: '/api/pipeline', query: { campaignId: 'c1' } })).toBe('none')
    for (const rule of ALLOW_RULES.filter(r => r.method === 'DELETE')) {
      const body = rule.pattern === '/api/campaigns/[id]/brief-files' ? { fileId: 'f1' } : undefined
      const query = rule.pattern === '/api/settings/benchmarks' ? { key: 'benchmark_fee_ranges' } : undefined
      expect(cls({ method: 'DELETE', path: fill(rule.pattern), ...(body ? { body } : {}), ...(query ? { query } : {}) }), rule.pattern).toBe('destructive')
    }
    expect(cls({ method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'all', brandId: 'brand_1_a' } })).toBe('destructive')
  })

  it('paid reads need a token: lookalikes with a handle (free with creatorId only), competitors, live capture, real views', () => {
    expect(cls({ method: 'POST', path: '/api/creators/lookalikes', body: { handle: 'marta', platform: 'INSTAGRAM' } })).toBe('money')
    expect(cls({ method: 'POST', path: '/api/creators/lookalikes', body: { creatorId: 'cr1' } })).toBe('none')
    expect(cls({ method: 'POST', path: '/api/competitors', body: { username: 'rival', platform: 'INSTAGRAM' } })).toBe('money')
    expect(cls({ method: 'POST', path: '/api/competitors/c1', body: { action: 'refresh' } })).toBe('money')
    expect(cls({ method: 'POST', path: '/api/live-capture/enrich', body: {} })).toBe('money')
    const views = prepareGenericRequest({ method: 'POST', path: '/api/admin/enrich-views', body: {} })
    expect(views.confirmation).toBe('money')
    expect(views.rule.spend).toBe('core')
    expect(prepareGenericRequest({ method: 'POST', path: '/api/competitors', body: { username: 'rival', platform: 'TIKTOK' } }).rule.spend).toBe('optional')
  })

  it('changes of many records need a token; the small ones and the dry runs do not', () => {
    expect(cls({ method: 'PATCH', path: '/api/notifications', body: { markAll: true } })).toBe('bulk')
    expect(cls({ method: 'PATCH', path: '/api/notifications', body: { ids: ['n1', 'n2', 'n3', 'n4', 'n5'] } })).toBe('none')
    expect(cls({ method: 'PATCH', path: '/api/notifications', body: { ids: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] } })).toBe('bulk')
    const contacts = (n: number) => ({ contacts: Array.from({ length: n }, (_, i) => ({ name: `c${i}` })) })
    expect(cls({ method: 'POST', path: '/api/client-contacts/import', body: contacts(5) })).toBe('none')
    expect(cls({ method: 'POST', path: '/api/client-contacts/import', body: contacts(6) })).toBe('bulk')
    expect(cls({ method: 'POST', path: '/api/client-contacts/import', body: contacts(200) })).toBe('bulk')
    expect(cls({ method: 'PUT', path: '/api/settings/benchmarks', body: { key: 'benchmark_fee_ranges', value: {} } })).toBe('bulk')
    expect(cls({ method: 'POST', path: '/api/admin/backfill-categories' })).toBe('bulk')
    expect(cls({ method: 'POST', path: '/api/admin/backfill-categories', query: { dryRun: true } })).toBe('none')
    expect(cls({ method: 'POST', path: '/api/admin/backfill-categories', query: { dryRun: 'true' } })).toBe('none')
    expect(cls({ method: 'POST', path: '/api/admin/fanout-media', body: { dryRun: true } })).toBe('none')
    expect(cls({ method: 'POST', path: '/api/admin/fanout-media', body: {} })).toBe('bulk')
    expect(cls({ method: 'POST', path: '/api/admin/fanout-media', body: { dryRun: 'yes' } })).toBe('bulk')
    for (const p of ['/api/admin/backfill-contact-addresses', '/api/admin/backfill-contacts', '/api/admin/backfill-gender', '/api/admin/sync-creator-pool']) {
      expect(cls({ method: 'POST', path: p, body: {} }), p).toBe('bulk')
    }
    for (const p of ['/api/admin/benchmarks/recompute', '/api/admin/cache-avatars', '/api/admin/cache-thumbs', '/api/templates', '/api/client-contacts', '/api/live-capture/widgets', '/api/intelligence', '/api/pricing/analyze', '/api/reports/scheduled', '/api/discovery/search']) {
      expect(cls({ method: 'POST', path: p, body: {} }), p).toBe('none')
    }
    // A widget that already runs on a client's website: every change waits for the administrator.
    // Creating one (POST above) shows nothing to anybody until its snippet is installed.
    for (const body of [{ isActive: false }, { brandLogo: 'https://cdn.example/l.png' }, { allowedDomains: ['x.example'] }, { headlineText: 'Hola' }, { name: 'Interno' }]) {
      expect(cls({ method: 'PATCH', path: '/api/live-capture/widgets/w1', body }), JSON.stringify(body)).toBe('outbound')
    }
    expect(() => prepareGenericRequest({ method: 'PATCH', path: '/api/live-capture/widgets/w1', body: {} })).toThrow(/al menos uno/)
    expect(() => prepareGenericRequest({ method: 'PATCH', path: '/api/live-capture/widgets/w1', body: { apiKey: 'k' } })).toThrow(/al menos uno/)
  })

  it('forces the values of the proposal and says so', () => {
    const search = prepareGenericRequest({ method: 'POST', path: '/api/discovery/search', body: { query: 'moda', limit: 500 } })
    expect(search.send.body).toEqual({ query: 'moda', limit: 100 })
    expect(search.forced.join(' ')).toContain('100')
    expect(prepareGenericRequest({ method: 'POST', path: '/api/discovery/search', body: { limit: 20 } }).send.body).toEqual({ limit: 20 })

    const exported = prepareGenericRequest({ method: 'GET', path: '/api/campaigns/c1/export', query: { format: 'csv' } })
    expect(exported.send.query).toEqual({ format: 'json' })
    expect(exported.forced.join(' ')).toContain('json')
    expect(prepareGenericRequest({ method: 'GET', path: '/api/campaigns/c1/export' }).send.query).toEqual({ format: 'json' })

    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/cache-avatars', body: { limit: 400 } }).send.body).toEqual({ limit: 100 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/cache-avatars', body: {} }).send.body).toEqual({ limit: 100 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/cache-thumbs', body: { mode: 'embed', limit: 300 } }).send.body).toEqual({ mode: 'embed', limit: 100 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/enrich-views', body: { limit: 80 } }).send.body).toEqual({ limit: 50 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/enrich-views', body: {} }).send.body).toEqual({ limit: 25 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/enrich-views', body: { mode: 'refresh' } }).send.body).toEqual({ mode: 'refresh', limit: 50 })
    expect(refusal({ method: 'POST', path: '/api/admin/enrich-views', body: { all: true } })).toContain('all no se acepta')
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/backfill-gender', body: { limit: 20000 } }).send.body).toEqual({ limit: 5000 })
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/backfill-gender', body: {} }).send.body).toEqual({ limit: 5000 })

    const report = prepareGenericRequest({ method: 'POST', path: '/api/reports/scheduled', body: { campaignId: 'c1', email: 'x@correo-inventado.test', frequency: 'weekly' } })
    expect(report.send.body).toEqual({ campaignId: 'c1' })
    expect(report.forced.join(' ')).toContain('no se programa')

    const kb = prepareGenericRequest({ method: 'GET', path: '/api/knowledge-base', query: { offset: 20000 } })
    expect(kb.send.query).toEqual({})
    expect(kb.original.query).toEqual({ offset: 20000 })
  })

  it('60 seconds for normal calls, 200 seconds for the long synchronous jobs', () => {
    expect(prepareGenericRequest({ method: 'GET', path: '/api/campaigns' }).timeoutMs).toBe(GENERIC_TIMEOUT_MS)
    expect(GENERIC_TIMEOUT_MS).toBe(60_000)
    expect(prepareGenericRequest({ method: 'POST', path: '/api/admin/sync-creator-pool', body: {} }).timeoutMs).toBe(GENERIC_LONG_TIMEOUT_MS)
    expect(prepareGenericRequest({ method: 'POST', path: '/api/creators/lookalikes', body: { creatorId: 'c1' } }).timeoutMs).toBe(GENERIC_LONG_TIMEOUT_MS)
    expect(GENERIC_LONG_TIMEOUT_MS).toBe(200_000)
  })
})

describe('platform_request: the allow table itself', () => {
  const inTable = (method: string, pattern: string) => PLATFORM_ROUTES.some(r => r.pattern === pattern && (r.methods as readonly string[]).includes(method))

  it('every rule is a route and method of the platform client table, once', () => {
    for (const rule of ALLOW_RULES) expect(inTable(rule.method, rule.pattern), `${rule.method} ${rule.pattern}`).toBe(true)
    const keys = ALLOW_RULES.map(r => `${r.method} ${r.pattern}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('no rule is under a part out of reach for good, and no rule is a write owned by a curated tool', () => {
    for (const rule of ALLOW_RULES) {
      for (const prefix of PLATFORM_FORBIDDEN_PREFIXES) expect(isUnder(rule.pattern, prefix), `${rule.pattern} under ${prefix}`).toBe(false)
      expect(CURATED_WRITES.some(w => w.method === rule.method && w.pattern === rule.pattern), `${rule.method} ${rule.pattern}`).toBe(false)
    }
    for (const write of CURATED_WRITES) expect(inTable(write.method, write.pattern), `${write.method} ${write.pattern}`).toBe(true)
  })

  it('only a change of a live widget answers outbound; every confirmable rule has a preview, and every DELETE is destructive', () => {
    const outbound = ALLOW_RULES.filter(r => (r.classes ?? ['none']).includes('outbound')).map(r => `${r.method} ${r.pattern}`)
    // What the visitors of a client's website see changes there at once: approved in the platform (fix of 12 Nov 2026)
    expect(outbound).toEqual(['PATCH /api/live-capture/widgets/[id]'])
    for (const rule of ALLOW_RULES) {
      const classes = rule.classes ?? ['none']
      if (classes.some(c => c !== 'none')) expect(typeof rule.preview, `${rule.method} ${rule.pattern}`).toBe('function')
      if (rule.method === 'DELETE') expect(classes, rule.pattern).toEqual(['destructive'])
      if (classes.includes('money')) expect(rule.spend, rule.pattern).toBeDefined()
    }
  })

  it('every deny rule refuses something the allow table does not allow', () => {
    for (const rule of DENY_RULES) {
      for (const method of rule.methods ?? ['GET', 'POST', 'DELETE']) {
        expect(ALLOW_RULES.some(r => r.method === method && r.pattern === rule.pattern), `${method} ${rule.pattern}`).toBe(false)
        expect(denyReason(method, fill(rule.pattern)), `${method} ${rule.pattern}`).not.toBeNull()
      }
    }
  })

  it('the list of what exists names every rule', () => {
    const summary = allowedSummary()
    for (const rule of ALLOW_RULES) expect(summary).toContain(rule.pattern)
    expect(summary).not.toContain('/api/team')
  })
})

describe('platform_request: the answer', () => {
  const base = { includeContact: false, includeEconomics: false }

  it('cuts lists to 50 with _truncated, texts to 1,000 characters, and stays under 30,000 characters', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, caption: 'x'.repeat(1500) }))
    const answer = shapeGenericAnswer({ data: { rows } }, base)
    const data = answer.data as { rows: { caption: string }[] }
    expect(data.rows.length).toBeLessThanOrEqual(50)
    expect(answer._truncated).toEqual([expect.objectContaining({ path: 'data.rows', total: 120 })])
    expect(data.rows[0].caption.length).toBeLessThan(1100)
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(GENERIC_OUTPUT_MAX_CHARS)
    expect((answer._notes as string[]).join(' ')).toContain('_truncated')
  })

  it('drops images and snapshots, never returns secrets, and removes contact data and money unless asked', () => {
    const data = {
      influencer: {
        id: 'i1', username: 'marta', avatarUrl: 'https://cdn.example/a.jpg', thumbnailUrl: 'x', baselineSnapshot: { a: 1 },
        email: 'marta@correo-inventado.test', phone: '+34600111222', shippingAddress1: 'Calle Inventada 1',
        standardFee: 300, agreedFee: 200, apiKey: 'k', token: 't', password: 'p', encryptedToken: 'e',
      },
    }
    const plain = JSON.stringify(shapeGenericAnswer({ data }, base))
    for (const absent of ['avatarUrl', 'thumbnailUrl', 'baselineSnapshot', 'marta@correo', '+34600', 'Calle Inventada', 'standardFee', 'agreedFee', 'apiKey', '"token"', 'password', 'encryptedToken']) {
      expect(plain, absent).not.toContain(absent)
    }
    expect(plain).toContain('"hasEmail":true')
    expect(plain).toContain('includeEconomics')
    const full = JSON.stringify(shapeGenericAnswer({ data }, { includeContact: true, includeEconomics: true }))
    expect(full).toContain('marta@correo-inventado.test')
    expect(full).toContain('"standardFee":300')
    expect(full).not.toContain('apiKey')
    expect(full).not.toContain('avatarUrl')
  })

  it('keeps only the selected dot paths, through arrays', () => {
    const value = { campaign: { name: 'C', status: 'ACTIVE', influencers: [{ status: 'AGREED', influencer: { username: 'a', followers: 1 } }, { status: 'POSTED' }] }, other: 1 }
    expect(selectPaths(value, ['campaign.name', 'campaign.influencers.status'])).toEqual({ campaign: { name: 'C', influencers: [{ status: 'AGREED' }, { status: 'POSTED' }] } })
    const answer = shapeGenericAnswer({ data: value }, { ...base, select: ['campaign.influencers.influencer.username'] })
    expect(answer.data).toEqual({ campaign: { influencers: [{ influencer: { username: 'a' } }, {}] } })
  })
})

describe('platform_request: the tool as Claude sees it', () => {
  it('has a name of at most 64 characters, a Spanish title, a description that says it is a last resort, and write annotations', () => {
    expect(platformRequestTool.name).toBe(PLATFORM_REQUEST_NAME)
    expect(platformRequestTool.name.length).toBeLessThanOrEqual(64)
    expect(platformRequestTool.title).toContain('último recurso')
    expect(platformRequestTool.description).toMatch(/^LAST RESORT/)
    expect(platformRequestTool.description).toContain('curated tool first')
    expect(platformRequestTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false })
    expect(Object.keys(platformRequestTool.input).sort()).toEqual(['actionId', 'body', 'confirmToken', 'includeContact', 'includeEconomics', 'method', 'path', 'query', 'select'])
    expect([...platformRequestTool.confirmations].sort()).toEqual(['bulk', 'destructive', 'money', 'none', 'outbound'])
  })

  it('registers exactly once, wired through the server call limit and the turn of the request', async () => {
    const registerTool = vi.fn()
    const take = vi.fn(() => ({ limited: true, startedAt: Date.now() }))
    const inTurn = vi.fn(async (work: () => Promise<unknown>) => work())
    registerPlatformRequest({ registerTool } as never, { caller: { grantId: 'g', userId: 'u' }, take, inTurn: inTurn as WriteToolWiring['inTurn'] })
    expect(registerTool).toHaveBeenCalledTimes(1)
    const [name, config, handler] = registerTool.mock.calls[0] as [string, { title: string; annotations: unknown; inputSchema: Record<string, unknown> }, (a: unknown, e: { requestId: number }) => Promise<unknown>]
    expect(name).toBe('platform_request')
    expect(config.title).toBe(platformRequestTool.title)
    expect(config.annotations).toEqual(platformRequestTool.annotations)
    expect(Object.keys(config.inputSchema)).toContain('path')
    // Over the server's limit: the call does not run (and needs no database to say so... except the log, which is absent here)
    const answer = (await handler({ method: 'GET', path: '/api/health' }, { requestId: 7 })) as { isError?: boolean }
    expect(take).toHaveBeenCalledWith(7, 'platform_request')
    expect(inTurn).toHaveBeenCalledTimes(1)
    expect(answer.isError).toBe(true)
  })
})
