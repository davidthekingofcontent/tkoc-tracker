import { describe, expect, it, vi } from 'vitest'

// Before any import: no address in the environment, so the card shows the production one
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClaudeConnectionsCard } from '@/components/mcp/claude-connections-card'
import { ActivityView } from '@/components/mcp/claude-activity'
import {
  ACTIVITY_CALLS_LIMIT,
  ACTIVITY_ENDPOINT,
  ACTIVITY_PENDING_LIMIT,
  CALL_RESULTS,
  CARD_PREVIEW_MAX_CHARS,
  STARTED_STALE_MS,
  cardPreview,
  classifyCall,
  loadActivity,
  toActivity,
  type Activity,
} from '@/components/mcp/activity-api'
import { MCP_WRITE_TEXTS } from '@/components/mcp/write-texts'
import { translations } from '@/i18n/translations'

/**
 * The card «Conexiones con Claude» after the write layer (12 Nov 2026): what
 * the connection can do, and «Actividad de Claude» (pending actions first,
 * then the last 50 calls). Pure logic and server-rendered HTML: no browser,
 * no database. The route itself is tested in tests/db/mcp-activity-route.test.ts.
 */

const es = translations.es.mcp
const en = translations.en.mcp
const NOW = new Date('2026-11-12T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

interface Call {
  url: string
  method: string
  cache: string | undefined
}

/** A fetch that answers from a script and remembers what it was asked. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: unknown, init?: { method?: string; cache?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET', cache: init?.cache }
    calls.push(call)
    return answer(call)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Every key path of an object, sorted (to compare the two languages). */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort()
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

// ============ classifyCall: what a log line says ============

describe('activity: how a line of McpCallLog is read', () => {
  it('a read tool: answered, failed, over the limit, or refused by the SDK', () => {
    expect(classifyCall('campaignId=c1 limit=50', true, NOW, NOW)).toEqual({ kind: 'read', result: 'read', confirmation: null, httpStatus: null })
    expect(classifyCall('', true, NOW, NOW).result).toBe('read')
    expect(classifyCall('campaignId=c1', false, NOW, NOW)).toEqual({ kind: 'read', result: 'failed', confirmation: null, httpStatus: null })
    // The two fixed sentences of src/lib/mcp/server.ts
    expect(classifyCall('not run: rate limit', false, NOW, NOW).result).toBe('limited')
    expect(classifyCall('not run: unknown tool or invalid arguments', false, NOW, NOW).result).toBe('invalid')
  })

  it('a write tool: every step of the write helper, with its class and the last HTTP status', () => {
    const w = (line: string, ok: boolean) => classifyCall(line, ok, NOW, NOW)
    expect(w('[none:execute http=200] campaignId=c1', true)).toEqual({ kind: 'write', result: 'done', confirmation: 'none', httpStatus: 200 })
    expect(w('[bulk:execute http=200,200,201] campaignId=c1 n=7', true)).toEqual({ kind: 'write', result: 'done', confirmation: 'bulk', httpStatus: 201 })
    expect(w('[money:preview http=200] campaignId=c1', true)).toEqual({ kind: 'write', result: 'preview', confirmation: 'money', httpStatus: 200 })
    expect(w('[destructive:approval http=200] campaignId=c1 actionId=a1', true)).toEqual({
      kind: 'write',
      result: 'approval',
      confirmation: 'destructive',
      httpStatus: 200,
    })
    expect(w('[outbound:approval] campaignId=c1', true).result).toBe('approval')
    // A write tool's call that changed nothing (a platform_request GET) is a «Consulta», never «Hecho»
    expect(w('[none:read http=200] method=GET route=/api/meta/connections', true)).toEqual({ kind: 'write', result: 'read', confirmation: 'none', httpStatus: 200 })
    expect(w('[none:read http=200] method=GET', true).result).not.toBe('done')
    expect(w('[money:refused http=200] campaignId=c1', false)).toEqual({ kind: 'write', result: 'refused', confirmation: 'money', httpStatus: 200 })
    expect(w('[destructive:failed http=500] campaignId=c1', false)).toEqual({ kind: 'write', result: 'failed', confirmation: 'destructive', httpStatus: 500 })
    expect(w('[none:failed http=200,timeout] campaignId=c1', false)).toEqual({ kind: 'write', result: 'failed', confirmation: 'none', httpStatus: null })
    // Stopped before the class was known. Written as templates: Tailwind scans this folder too, and a
    // literal log prefix without a class (a dash, a colon and the step in brackets) would become an
    // invalid CSS rule in the build
    const noClass = '-'
    expect(w(`[${noClass}:invalid]`, false)).toEqual({ kind: 'write', result: 'invalid', confirmation: null, httpStatus: null })
    expect(w(`[${noClass}:limited]`, false).result).toBe('limited')
    expect(w(`[${noClass}:refused] campaignId=c1`, false)).toEqual({ kind: 'write', result: 'refused', confirmation: null, httpStatus: null })
  })

  it('a write still open: running for a while, then "not finished"', () => {
    expect(classifyCall('started', false, ago(30_000), NOW)).toEqual({ kind: 'write', result: 'running', confirmation: null, httpStatus: null })
    expect(classifyCall('started', false, ago(STARTED_STALE_MS + 1), NOW).result).toBe('unfinished')
  })

  it('something that only looks like a prefix is read as a read line', () => {
    for (const line of ['[admin:execute] x=1', '[none:deleted] x=1', ' [none:execute] x=1', 'started ', '[none:execute http=<script>] x']) {
      expect(classifyCall(line, true, NOW, NOW).kind).toBe('read')
    }
  })
})

describe('activity: the preview the card shows', () => {
  it('folds control characters and line breaks, and cuts long text with an ellipsis', () => {
    expect(cardPreview('Vas a\nBORRAR‮la campaña\t«X».')).toBe('Vas a BORRAR la campaña «X».')
    const long = cardPreview('a'.repeat(CARD_PREVIEW_MAX_CHARS + 50))
    expect(long).toHaveLength(CARD_PREVIEW_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(cardPreview('corta')).toBe('corta')
  })
})

// ============ toActivity / loadActivity: what the card accepts ============

const PENDING_MINE = {
  id: 'act_mine',
  tool: 'remove_creator_from_campaign',
  confirmation: 'destructive',
  status: 'pending',
  createdAt: '2026-11-12T11:55:00.000Z',
  expiresAt: '2026-11-12T12:10:00.000Z',
  ownerName: 'Ana Admin',
  mine: true,
  approvePath: '/mcp/confirmar/act_mine',
  preview: 'Vas a quitar a @marta de «Noviembre».',
}
const PENDING_OTHER = {
  id: 'act_other',
  tool: 'invite_creator_to_connect',
  confirmation: 'outbound',
  status: 'pending',
  createdAt: '2026-11-12T11:50:00.000Z',
  expiresAt: '2026-11-12T12:05:00.000Z',
  ownerName: 'Bea Admin',
  mine: false,
  approvePath: null,
  preview: null,
}
const CALL = {
  id: 'log_1',
  at: '2026-11-12T11:58:00.000Z',
  tool: 'update_creator_deal',
  kind: 'write',
  result: 'done',
  confirmation: 'none',
  httpStatus: 200,
  userName: 'Ana Admin',
}

describe('activity: reading the answer of the route', () => {
  it('keeps the known fields of well-formed rows and drops everything else', () => {
    const leaky = {
      pending: [{ ...PENDING_MINE, argsJson: '{"email":"x@y.z"}', grantId: 'g1', userId: 'u1', tokenHash: 'abc' }],
      calls: [{ ...CALL, argsSummary: 'campaignId=c1', grantId: 'g1', email: 'ana@example.com', resultChars: 10 }],
      extra: 'ignored',
    }
    const activity = toActivity(leaky) as Activity
    expect(activity.pending).toEqual([PENDING_MINE])
    expect(activity.calls).toEqual([CALL])
    expect(JSON.stringify(activity)).not.toMatch(/argsJson|argsSummary|grantId|userId|tokenHash|email|resultChars/)
  })

  it('only ever keeps a link to the confirmation page of that same action, and only for the viewer’s own pending ones', () => {
    const link = (over: Record<string, unknown>) => (toActivity({ pending: [{ ...PENDING_MINE, ...over }], calls: [] }) as Activity).pending[0].approvePath
    expect(link({})).toBe('/mcp/confirmar/act_mine')
    for (const approvePath of [
      'javascript:alert(1)',
      '//evil.example/mcp/confirmar/act_mine',
      'https://evil.example/mcp/confirmar/act_mine',
      '/mcp/confirmar/other_action',
      '/mcp/confirmar/act_mine?next=/x',
      '/mcp/confirmar/../api/act_mine',
      '/api/mcp/actions/act_mine',
      7,
    ]) {
      expect(link({ approvePath })).toBeNull()
    }
    expect(link({ mine: false })).toBeNull()
    expect(link({ status: 'approved' })).toBeNull()
    // Somebody else's action never carries its preview either
    expect((toActivity({ pending: [{ ...PENDING_MINE, mine: false }], calls: [] }) as Activity).pending[0].preview).toBeNull()
  })

  it('drops malformed rows and refuses a body that is not the activity', () => {
    const activity = toActivity({
      pending: [null, 5, { ...PENDING_MINE, id: '' }, { ...PENDING_MINE, id: 'a b' }, { ...PENDING_MINE, confirmation: 'money' }, { ...PENDING_MINE, status: 'denied' }, { ...PENDING_MINE, expiresAt: 'soon' }, PENDING_OTHER],
      calls: [
        { ...CALL, id: 'ok1' },
        { ...CALL, id: 'x', result: 'hacked' },
        { ...CALL, id: 'y', tool: '<img src=x>' },
        { ...CALL, id: 'z', at: 'yesterday' },
        { ...CALL, id: 'w', confirmation: 'admin', httpStatus: 9999, userName: '  ', kind: 'other' },
        // What the server logs for a call to a tool that does not exist: kept
        { ...CALL, id: 'v', tool: '(invalid name)', kind: 'read', result: 'invalid', confirmation: null, httpStatus: null },
      ],
    }) as Activity
    expect(activity.pending.map(p => p.id)).toEqual(['act_other'])
    expect(activity.calls.map(c => c.id)).toEqual(['ok1', 'w', 'v'])
    expect(activity.calls[1]).toMatchObject({ confirmation: null, httpStatus: null, userName: null, kind: 'read' })

    for (const odd of [null, undefined, 'text', 42, [], {}, { pending: [] }, { calls: [] }, { error: 'Forbidden' }, { pending: 'x', calls: [] }]) {
      expect(toActivity(odd)).toBeNull()
    }
  })

  it('never keeps more rows than the card shows', () => {
    const many = toActivity({
      pending: Array.from({ length: ACTIVITY_PENDING_LIMIT + 5 }, (_, i) => ({ ...PENDING_OTHER, id: `p${i}` })),
      calls: Array.from({ length: ACTIVITY_CALLS_LIMIT + 5 }, (_, i) => ({ ...CALL, id: `c${i}` })),
    }) as Activity
    expect(many.pending).toHaveLength(ACTIVITY_PENDING_LIMIT)
    expect(many.calls).toHaveLength(ACTIVITY_CALLS_LIMIT)
    expect(ACTIVITY_CALLS_LIMIT).toBe(50)
  })

  it('loads with one uncached GET and reports a failure as null, never as an empty activity', async () => {
    const ok = fakeFetch(() => json({ pending: [PENDING_MINE], calls: [CALL] }))
    expect(await loadActivity(ok.fetch)).toEqual({ pending: [PENDING_MINE], calls: [CALL] })
    expect(ok.calls).toEqual([{ url: ACTIVITY_ENDPOINT, method: 'GET', cache: 'no-store' }])
    expect(ACTIVITY_ENDPOINT).toBe('/api/oauth/activity')

    expect(await loadActivity(fakeFetch(() => json({ pending: [], calls: [] })).fetch)).toEqual({ pending: [], calls: [] })
    for (const status of [401, 403, 404, 500]) {
      expect(await loadActivity(fakeFetch(() => json({ error: 'no' }, status)).fetch)).toBeNull()
    }
    expect(await loadActivity(fakeFetch(() => json({ error: 'Forbidden' })).fetch)).toBeNull()
    expect(await loadActivity(fakeFetch(() => new Response('<html>login</html>', { status: 200 })).fetch)).toBeNull()
    expect(
      await loadActivity(
        fakeFetch(() => {
          throw new Error('network down')
        }).fetch,
      ),
    ).toBeNull()
  })
})

// ============ What the card shows ============

describe('card «Conexiones con Claude»: what the connection can do', () => {
  const html = renderToStaticMarkup(createElement(ClaudeConnectionsCard))
  const w = MCP_WRITE_TEXTS.es.consent

  it('no longer says it is read-only', () => {
    expect(html).toContain(es.connections.accessBadge)
    expect(html).toContain(es.connections.introWrite)
    expect(html).not.toContain('Solo lectura')
    expect(es.connections).not.toHaveProperty('readOnly')
    expect(es.connections).not.toHaveProperty('intro')
    expect(html).not.toContain('No puede cambiar nada')
  })

  it('says what it can do, what it always asks to confirm and how, and what it can never touch, in that order', () => {
    const parts = [
      w.canLabel,
      w.can,
      w.confirmLabel,
      w.confirm,
      es.connections.howConfirmLabel,
      es.connections.confirmInChat,
      es.connections.confirmInPlatform,
      w.neverLabel,
      w.never,
      es.connections.serverUrl,
    ]
    const at = parts.map(p => html.indexOf(escapeHtml(p)))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The sentences the owner asked for (spec, 12 Nov 2026)
    expect(w.can).toBe('Leer y modificar campañas, creadoras, publicaciones, listas, informes y rastreos, con tu usuario.')
    expect(w.confirm).toBe('Borrar, gastar Apify, enviar correos, cambios en bloque y los textos del informe que ve el cliente.')
    expect(w.never).toBe('Usuarios, permisos, claves e integraciones.')
  })

  it('keeps the address, the steps and the list of connections, and adds the activity, loading', () => {
    expect(html).toContain('claude mcp add --transport http tkoc https://intelligence.thekingofcontent.agency/api/mcp')
    expect(html).toContain(escapeHtml(es.connections.step1))
    expect(html).toContain(es.connections.listTitle)
    expect(html).toContain(`<h3 id="mcp-activity-title" class="text-lg font-semibold text-gray-900 dark:text-white">${es.activity.title}</h3>`)
    expect(html.indexOf(es.connections.listTitle)).toBeLessThan(html.indexOf(es.activity.title))
    expect(html).toContain(`aria-label="${es.activity.loading}"`)
    expect(html).not.toContain(es.activity.loadError)
    expect(html).not.toContain(es.activity.confirm)
    expect(html).not.toMatch(/<script/i)
  })
})

describe('card «Conexiones con Claude»: the activity', () => {
  const render = (props: Parameters<typeof ActivityView>[0]) => renderToStaticMarkup(createElement(ActivityView, props))
  const a = es.activity

  const activity = toActivity({
    pending: [
      PENDING_MINE,
      { ...PENDING_MINE, id: 'act_approved', status: 'approved', approvePath: null, preview: 'Vas a borrar la lista «Verano».' },
      PENDING_OTHER,
    ],
    calls: [
      CALL,
      { ...CALL, id: 'log_2', tool: 'launch_campaign_tracking', result: 'preview', confirmation: 'money', userName: 'Bea Admin' },
      { ...CALL, id: 'log_3', tool: 'list_campaigns', kind: 'read', result: 'read', confirmation: null, httpStatus: null, userName: null },
      { ...CALL, id: 'log_4', tool: 'delete_list', result: 'failed', confirmation: 'destructive', userName: '<img src=x onerror=alert(1)>' },
    ],
  }) as Activity

  it('shows the actions waiting for a confirmation first, with «Confirmar» only on the viewer’s own', () => {
    const html = render({ state: 'ready', activity })
    expect(html.indexOf(a.pendingTitle)).toBeLessThan(html.indexOf(a.recentTitle))
    // One link, to the confirmation page of the viewer's own pending action
    const links = [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(m => [m[1], m[2]])
    expect(links).toEqual([['/mcp/confirmar/act_mine', a.confirm]])
    expect(html).toContain(escapeHtml(PENDING_MINE.preview))
    // Already confirmed: waiting for Claude, no link
    expect(html).toContain(a.approved)
    // Somebody else's: whose it is, no preview, no link
    expect(html).toContain(escapeHtml('Es de la conexión de Bea Admin. Solo Bea Admin puede confirmarla.'))
    expect(html).toContain(a.classes.destructive)
    expect(html).toContain(a.classes.outbound)
  })

  it('lists every call with tool, result, when and who; names are escaped', () => {
    const html = render({ state: 'ready', activity })
    for (const tool of ['update_creator_deal', 'launch_campaign_tracking', 'list_campaigns', 'delete_list']) expect(html).toContain(`>${tool}</code>`)
    for (const label of [a.results.done, a.results.preview, a.results.read, a.results.failed]) expect(html).toContain(label)
    expect(html).toContain(a.classes.money)
    expect(html).toContain('Ana Admin')
    expect(html).toContain(a.unknownUser)
    // 11:58 UTC is 12:58 in Madrid
    expect(html).toContain('12:58 · Ana Admin')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toMatch(/<script/i)
  })

  it('says so when Claude has done nothing yet, and hides the waiting block when nothing waits', () => {
    const html = render({ state: 'ready', activity: { pending: [], calls: [] } })
    expect(html).toContain(a.empty)
    expect(html).not.toContain(a.pendingTitle)
    expect(html).not.toContain('<ul')
  })

  it('a refresh that failed keeps the list on screen and says it could not load', () => {
    const html = render({ state: 'ready', activity, stale: true, onRefresh: () => {} })
    expect(html).toContain(a.loadError)
    expect(html.indexOf(a.loadError)).toBeLessThan(html.indexOf(a.pendingTitle))
    expect(html).toContain('>update_creator_deal</code>')
    expect(render({ state: 'ready', activity })).not.toContain(a.loadError)
  })

  it('shows the error with a retry, and nothing else, when it could not load', () => {
    const html = render({ state: 'error', activity: null, onRefresh: () => {} })
    expect(html).toContain(a.loadError)
    expect(html).toContain(a.retry)
    expect(html).not.toContain(a.recentTitle)
    expect(html).not.toContain('<ul')
  })
})

// ============ Texts ============

describe('texts of the card', () => {
  const NEW_CONNECTION_KEYS = ['accessBadge', 'introWrite', 'howConfirmLabel', 'confirmInChat', 'confirmInPlatform'] as const

  it('exist in both languages, with the same keys', () => {
    expect(keyPaths(en.activity)).toEqual(keyPaths(es.activity))
    expect(keyPaths(en.connections)).toEqual(keyPaths(es.connections))
    for (const key of NEW_CONNECTION_KEYS) {
      expect(es.connections[key].trim()).not.toBe('')
      expect(en.connections[key].trim()).not.toBe('')
    }
    // Every result and every class the route can send has a label
    expect(Object.keys(es.activity.results).sort()).toEqual([...CALL_RESULTS].sort())
    expect(Object.keys(es.activity.classes).sort()).toEqual(['bulk', 'client', 'destructive', 'money', 'outbound'])
  })

  it('have no em-dash and keep their placeholders in both languages', () => {
    const all = [...NEW_CONNECTION_KEYS.map(k => es.connections[k]), ...NEW_CONNECTION_KEYS.map(k => en.connections[k]), JSON.stringify(es.activity), JSON.stringify(en.activity)]
    const EM_DASH = String.fromCharCode(0x2014)
    for (const s of all) expect(s).not.toContain(EM_DASH)
    for (const key of ['expires', 'ownerOnly', 'byWhom'] as const) {
      const holders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(holders(en.activity[key])).toEqual(holders(es.activity[key]))
    }
  })
})
