import { describe, expect, it, vi } from 'vitest'

// Before any import: no address in the environment, so the card shows the production one
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClaudeConnectionsCard } from '@/components/mcp/claude-connections-card'
import {
  GRANTS_ENDPOINT,
  loadConnections,
  loadServerUrl,
  revokeConnection,
  toConnections,
} from '@/components/mcp/connections-api'
import { translations } from '@/i18n/translations'

const SERVER_URL = 'https://intelligence.thekingofcontent.agency/api/mcp'

interface Call {
  url: string
  method: string
}

/** A fetch that answers from a script and remembers what it was asked. */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: unknown, init?: { method?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    return answer(call)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ROW = {
  id: 'grant_1',
  clientId: 'client_abc',
  clientName: 'Claude',
  userId: 'user_1',
  userName: 'Ana Admin',
  scope: 'tkoc.read',
  createdAt: '2026-11-12T09:30:00.000Z',
  lastUsedAt: null,
}

describe('card «Conexiones con Claude»: reading the grants API', () => {
  it('accepts { grants: [...] } or a bare array and keeps only what the card shows', () => {
    // ROW is an authorisation of before the write layer: the card says it is read only
    const expected = [
      { id: 'grant_1', clientName: 'Claude', userName: 'Ana Admin', createdAt: '2026-11-12T09:30:00.000Z', lastUsedAt: null, readOnly: true },
    ]
    expect(toConnections({ grants: [ROW] })).toEqual(expected)
    expect(toConnections([ROW])).toEqual(expected)
    // Anything else a row might carry never reaches the page (the scope itself neither: only whether it writes)
    const leaky = { ...ROW, email: 'ana@example.com', accessToken: 'secret', tokenHash: 'abc' }
    expect(toConnections([leaky])).toEqual(expected)
  })

  it('tells a read-only connection from one that can make changes (fix of 12 Nov 2026)', () => {
    const rows = toConnections([
      { ...ROW, id: 'old', scope: 'tkoc.read' },
      { ...ROW, id: 'new', scope: 'tkoc.read tkoc.write' },
      { ...ROW, id: 'odd', scope: 'tkoc.readtkoc.write' },
      { ...ROW, id: 'none', scope: undefined },
    ])
    expect(Object.fromEntries(rows.map(r => [r.id, r.readOnly]))).toEqual({ old: true, new: false, odd: true, none: true })
  })

  it('drops malformed rows and never throws on a surprising answer', () => {
    expect(toConnections({ grants: [null, 7, 'x', {}, { id: '' }, { id: 5 }, { id: 'ok', clientName: 9, userName: '  ', lastUsedAt: '2026-11-12T10:00:00.000Z' }] })).toEqual([
      { id: 'ok', clientName: null, userName: null, createdAt: null, lastUsedAt: '2026-11-12T10:00:00.000Z', readOnly: true },
    ])
    for (const odd of [null, undefined, 'text', 42, {}, { grants: 'no' }, { error: 'Forbidden' }]) {
      expect(toConnections(odd)).toEqual([])
    }
  })

  it('loads the list with one GET, and reports a failure instead of an empty list', async () => {
    const ok = fakeFetch(() => json({ grants: [ROW] }))
    expect(await loadConnections(ok.fetch)).toHaveLength(1)
    expect(ok.calls).toEqual([{ url: GRANTS_ENDPOINT, method: 'GET' }])
    expect(GRANTS_ENDPOINT).toBe('/api/oauth/grants')

    expect(await loadConnections(fakeFetch(() => json({ grants: [] })).fetch)).toEqual([])
    for (const status of [401, 403, 404, 500]) {
      expect(await loadConnections(fakeFetch(() => json({ error: 'no' }, status)).fetch)).toBeNull()
    }
    // A 200 that is not a list (a login page, an error object) is a failure too
    expect(await loadConnections(fakeFetch(() => json({ error: 'Forbidden' })).fetch)).toBeNull()
    expect(await loadConnections(fakeFetch(() => new Response('<html>login</html>', { status: 200 })).fetch)).toBeNull()
    expect(
      await loadConnections(
        fakeFetch(() => {
          throw new Error('network down')
        }).fetch,
      ),
    ).toBeNull()
  })

  it('revokes with DELETE on the encoded id and tells the three outcomes apart', async () => {
    const ok = fakeFetch(() => json({ ok: true }))
    expect(await revokeConnection('grant_1', ok.fetch)).toBe('revoked')
    expect(ok.calls).toEqual([{ url: '/api/oauth/grants/grant_1', method: 'DELETE' }])

    expect(await revokeConnection('grant_1', fakeFetch(() => new Response(null, { status: 204 })).fetch)).toBe('revoked')
    expect(await revokeConnection('grant_1', fakeFetch(() => json({ error: 'gone' }, 404)).fetch)).toBe('alreadyGone')
    for (const status of [400, 401, 403, 500]) {
      expect(await revokeConnection('grant_1', fakeFetch(() => json({ error: 'no' }, status)).fetch)).toBe('revokeError')
    }
    expect(
      await revokeConnection(
        'grant_1',
        fakeFetch(() => {
          throw new Error('network down')
        }).fetch,
      ),
    ).toBe('revokeError')

    // An id can never walk out of the grants path
    const odd = fakeFetch(() => json({ ok: true }))
    await revokeConnection('../users/1?x=y#z', odd.fetch)
    expect(odd.calls[0].url).toBe('/api/oauth/grants/..%2Fusers%2F1%3Fx%3Dy%23z')
  })

  it('takes the server address from the protected resource metadata, and only a plain http(s) address', async () => {
    const ok = fakeFetch(() => json({ resource: SERVER_URL, authorization_servers: ['https://intelligence.thekingofcontent.agency'] }))
    expect(await loadServerUrl(ok.fetch)).toBe(SERVER_URL)
    expect(ok.calls).toEqual([{ url: '/.well-known/oauth-protected-resource', method: 'GET' }])

    for (const resource of ['javascript:alert(1)', 'https://a.example/x y', 'https://a.example/"><script>', '', 7, null, undefined]) {
      expect(await loadServerUrl(fakeFetch(() => json({ resource })).fetch)).toBeNull()
    }
    expect(await loadServerUrl(fakeFetch(() => json({}, 404)).fetch)).toBeNull()
    expect(await loadServerUrl(fakeFetch(() => new Response('not json', { status: 200 })).fetch)).toBeNull()
  })
})

describe('card «Conexiones con Claude»: what it shows before any data arrives', () => {
  const html = renderToStaticMarkup(createElement(ClaudeConnectionsCard))
  const c = translations.es.mcp.connections

  it('has the title, the server address to copy and the copy button', () => {
    expect(html).toContain('<h3 class="text-lg font-semibold text-gray-900 dark:text-white">Conexiones con Claude</h3>')
    // Since the write layer (12 Nov 2026) the connection reads and changes data
    expect(html).toContain('Lee y hace cambios')
    expect(html).not.toContain('Solo lectura')
    expect(html).toMatch(new RegExp(`<input[^>]*readOnly=""[^>]*value="${SERVER_URL}"`))
    expect(html).toContain('Copiar')
  })

  it('has the three steps in order and the Claude Code command with the same address', () => {
    const at = [c.step1, c.step2, c.step3].map(step => html.indexOf(step))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain(`claude mcp add --transport http tkoc ${SERVER_URL}`)
  })

  it('starts loading: no list, no error, no revoke button yet', () => {
    expect(html).toContain(`aria-label="${c.loading}"`)
    expect(html).not.toContain('<ul')
    expect(html).not.toContain(c.loadError)
    expect(html).not.toContain(c.empty)
    expect(html).not.toContain(c.revoke)
    expect(html).not.toMatch(/<script/i)
  })
})
