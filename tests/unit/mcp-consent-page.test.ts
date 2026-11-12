import { beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: a fixed signing secret, and no address in the environment
// so the connector answers for the production one. The page is a server
// component: its three server-only inputs (cookie, redirect, database) are
// replaced here; sessions, request validation and the consent token are the
// real code.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL

  /** What redirect() of next/navigation does in a server component: it never returns. */
  class Redirected extends Error {
    readonly url: string
    constructor(url: string) {
      super(`redirect to ${url}`)
      this.url = url
    }
  }
  return {
    Redirected,
    cookie: { value: undefined as string | undefined },
    users: new Map<string, { id: string; name: string; role: string; isActive: boolean }>(),
    clients: new Map<string, { clientId: string; name: string; redirectUris: string[] }>(),
    lookups: { user: 0, client: 0 },
  }
})

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'token' && h.cookie.value !== undefined ? { name, value: h.cookie.value } : undefined),
  }),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new h.Redirected(url)
  },
}))
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        h.lookups.user++
        return h.users.get(where.id) ?? null
      },
    },
    mcpClient: {
      findUnique: async ({ where }: { where: { clientId: string } }) => {
        h.lookups.client++
        return h.clients.get(where.clientId) ?? null
      },
    },
  },
}))

import jwt from 'jsonwebtoken'
import { renderToStaticMarkup } from 'react-dom/server'
import AuthorizePage, { dynamic, metadata } from '@/app/oauth/authorize/page'
import {
  CONSENT_FORM_ACTION,
  CONSENT_TOKEN_FIELD,
  DECISION_ALLOW,
  DECISION_DENY,
  DECISION_FIELD,
} from '@/components/mcp/consent-form'
import { translations } from '@/i18n/translations'
import { generateToken } from '@/lib/auth'
import { ISSUER, MCP_GRANT_SCOPE, MCP_RESOURCE, MCP_SCOPE } from '@/lib/mcp/config'
import { pkceChallengeS256, randomSecret, verifyConsentToken } from '@/lib/mcp/crypto'

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const CHALLENGE = pkceChallengeS256('v'.repeat(43))
const es = translations.es.mcp.consent

type Query = Record<string, string | string[] | undefined>

function addUser(role: string, opts: { isActive?: boolean; name?: string } = {}) {
  const user = { id: `user_${h.users.size + 1}`, name: opts.name ?? `Nombre ${role}`, role, isActive: opts.isActive ?? true }
  h.users.set(user.id, user)
  return user
}

function signIn(user: { id: string; role: string }): void {
  h.cookie.value = generateToken(user.id, user.role)
}

function addClient(name = 'Claude', redirectUris: string[] = [CLAUDE_CALLBACK]) {
  const client = { clientId: randomSecret(), name, redirectUris }
  h.clients.set(client.clientId, client)
  return client
}

function validQuery(clientId: string, extra: Query = {}): Query {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: MCP_RESOURCE,
    scope: MCP_SCOPE,
    ...extra,
  }
}

/** Opens the page as the server would: the HTML it answers with, or where it redirects. */
async function open(query: Query): Promise<{ html: string; redirect: null } | { html: null; redirect: string }> {
  try {
    const element = await AuthorizePage({ searchParams: Promise.resolve(query) })
    return { html: renderToStaticMarkup(element), redirect: null }
  } catch (e) {
    if (e instanceof h.Redirected) return { html: null, redirect: e.url }
    throw e
  }
}

/** Text of the HTML as a person reads it (entities decoded). */
function decode(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function consentTokenOf(html: string): string {
  const inputs: string[] = html.match(/<input\b[^>]*>/g) ?? []
  expect(inputs).toHaveLength(1)
  const input = inputs[0] ?? ''
  expect(input).toContain('type="hidden"')
  expect(input).toContain(`name="${CONSENT_TOKEN_FIELD}"`)
  const value = /\bvalue="([^"]*)"/.exec(input)
  expect(value).not.toBeNull()
  return value?.[1] ?? ''
}

beforeEach(() => {
  h.cookie.value = undefined
  h.users.clear()
  h.clients.clear()
  h.lookups.user = 0
  h.lookups.client = 0
})

describe('GET /oauth/authorize: who may see the consent screen', () => {
  it('without a session goes to /login and comes back to the very same request', async () => {
    const client = addClient()
    const query = validQuery(client.clientId)
    const result = await open(query)
    expect(result.html).toBeNull()
    expect(result.redirect!.startsWith('/login?next=')).toBe(true)

    const next = new URLSearchParams(result.redirect!.slice('/login?'.length)).get('next')!
    expect(next.startsWith('/oauth/authorize?')).toBe(true)
    const back = new URLSearchParams(next.slice('/oauth/authorize?'.length))
    expect(Object.fromEntries(back)).toEqual(query)
    // Decided before anything is read: neither the user nor the client was looked up
    expect(h.lookups).toEqual({ user: 0, client: 0 })
  })

  it('keeps repeated parameters when it sends the user to /login, and has no stray "?" for an empty query', async () => {
    const repeated = await open({ client_id: ['a', 'b'], state: 'x y&z' })
    const next = new URLSearchParams(repeated.redirect!.slice('/login?'.length)).get('next')!
    expect(next).toBe('/oauth/authorize?client_id=a&client_id=b&state=x+y%26z')

    expect((await open({})).redirect).toBe('/login?next=%2Foauth%2Fauthorize')
  })

  it('treats a forged, expired, deactivated or stale session as no session', async () => {
    const admin = addUser('ADMIN')
    const client = addClient()
    const query = validQuery(client.clientId)

    h.cookie.value = 'not-a-jwt'
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    h.cookie.value = jwt.sign({ userId: admin.id, role: 'ADMIN' }, 'another-secret', { expiresIn: '7d' })
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    h.cookie.value = jwt.sign({ userId: admin.id, role: 'ADMIN' }, process.env.JWT_SECRET!, { expiresIn: -60 })
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    // The claim says ADMIN, the database says EMPLOYEE: the claim alone is never enough
    const employee = addUser('EMPLOYEE')
    h.cookie.value = generateToken(employee.id, 'ADMIN')
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    const inactive = addUser('ADMIN', { isActive: false })
    signIn(inactive)
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    signIn({ id: 'user_that_was_deleted', role: 'ADMIN' })
    expect((await open(query)).redirect).toMatch(/^\/login\?next=/)

    // None of them got as far as the request itself
    expect(h.lookups.client).toBe(0)
  })

  it('an EMPLOYEE sees the refusal, never the request', async () => {
    const client = addClient('<b>Cliente</b>')
    signIn(addUser('EMPLOYEE'))
    const result = await open(validQuery(client.clientId))
    expect(result.redirect).toBeNull()
    expect(result.html).toContain('Solo un administrador puede conectar Claude con la plataforma.')
    expect(result.html).not.toContain('<form')
    expect(result.html).not.toContain(CONSENT_TOKEN_FIELD)
    expect(result.html).not.toContain('Cliente')
    expect(h.lookups.client).toBe(0)
  })

  it('a BRAND or CREATOR session is sent to its own home', async () => {
    const client = addClient()
    signIn(addUser('BRAND'))
    expect(await open(validQuery(client.clientId))).toEqual({ html: null, redirect: '/portal' })
    signIn(addUser('CREATOR'))
    expect(await open(validQuery(client.clientId))).toEqual({ html: null, redirect: '/dashboard' })
    expect(h.lookups.client).toBe(0)
  })
})

describe('GET /oauth/authorize: what is being asked', () => {
  it('an unknown client or a redirect URI that is not its own gets an error page and NO redirect', async () => {
    signIn(addUser('ADMIN'))
    const client = addClient()
    const cases: Query[] = [
      validQuery(randomSecret()), // never registered
      validQuery('not-even-a-client-id'),
      validQuery(client.clientId, { client_id: undefined }),
      validQuery(client.clientId, { client_id: [client.clientId, client.clientId] }),
      validQuery(client.clientId, { redirect_uri: 'https://claude.ai.evil.com/api/mcp/auth_callback' }),
      validQuery(client.clientId, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback@evil.com' }),
      validQuery(client.clientId, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), // allowed in general, not registered by this client
      validQuery(client.clientId, { redirect_uri: 'http://localhost:8080/callback' }),
      validQuery(client.clientId, { redirect_uri: undefined }),
      validQuery(client.clientId, { redirect_uri: [CLAUDE_CALLBACK, CLAUDE_CALLBACK] }),
    ]
    for (const query of cases) {
      const result = await open(query)
      expect(result.redirect).toBeNull()
      expect(result.html).toContain(es.invalidTitle)
      expect(result.html).toContain(es.invalid)
      expect(result.html).toMatch(/Código: invalid_(client|request)/)
      expect(result.html).not.toContain('<form')
      expect(result.html).not.toContain(CONSENT_TOKEN_FIELD)
      // Nothing of the request is echoed into the page
      expect(result.html).not.toContain('evil')
      expect(result.html).not.toContain('st-123')
    }
  })

  it('any other problem goes back to the client with error, state and iss, and no code', async () => {
    signIn(addUser('ADMIN'))
    const client = addClient()
    const cases: Array<[Query, string]> = [
      [validQuery(client.clientId, { code_challenge: undefined }), 'invalid_request'],
      [validQuery(client.clientId, { code_challenge_method: 'plain' }), 'invalid_request'],
      [validQuery(client.clientId, { response_type: 'token' }), 'unsupported_response_type'],
      [validQuery(client.clientId, { resource: 'https://example.com/api/mcp' }), 'invalid_target'],
      // tkoc.read and tkoc.write are both known since the write layer; anything else is not
      [validQuery(client.clientId, { scope: 'tkoc.admin' }), 'invalid_scope'],
      [validQuery(client.clientId, { scope: 'tkoc.read offline_access' }), 'invalid_scope'],
    ]
    for (const [query, error] of cases) {
      const result = await open(query)
      expect(result.html).toBeNull()
      const url = new URL(result.redirect!)
      expect(url.origin + url.pathname).toBe(CLAUDE_CALLBACK)
      expect(url.searchParams.get('error')).toBe(error)
      expect(url.searchParams.get('state')).toBe('st-123')
      expect(url.searchParams.get('iss')).toBe(ISSUER)
      expect(url.searchParams.has('code')).toBe(false)
    }
  })
})

describe('GET /oauth/authorize: the consent screen', () => {
  it('shows who asks, what it gets, what it never gets and where it is revoked, in Spanish', async () => {
    const admin = addUser('ADMIN', { name: 'Ana Admin' })
    signIn(admin)
    const client = addClient('Claude')
    const result = await open(validQuery(client.clientId))
    expect(result.redirect).toBeNull()
    const html = result.html!

    expect(html).toContain('Conectar Claude con la plataforma')
    expect(html).toContain('Has iniciado sesión como Ana Admin.')
    expect(html).toContain('<bdi>Claude</bdi>')
    expect(html).toContain('Al terminar volverás a claude.ai.')
    // What the grant allows since the write layer (tkoc.read tkoc.write, one consent)
    expect(html).toContain('Qué puede hacer')
    expect(html).toContain('Leer y modificar campañas, creadoras, publicaciones, listas, informes y rastreos, con tu usuario.')
    expect(html).toContain('Qué te pedirá confirmar siempre')
    expect(html).toContain('Borrar, gastar Apify, enviar correos, cambios en bloque y los textos del informe que ve el cliente.')
    expect(html).toContain('Qué no puede tocar nunca')
    expect(html).toContain('Usuarios, permisos, claves e integraciones.')
    // The read-only promise would no longer be true
    expect(html).not.toContain('No puede cambiar nada')
    expect(html).toContain('Puedes revocar la conexión cuando quieras en Ajustes, pestaña Integraciones.')
    expect(html).toContain('Permite solo si acabas de iniciar tú esta conexión desde Claude.')
  })

  it('is a plain HTML form: POST to the decision route, the signed token and two submit buttons, no script', async () => {
    const admin = addUser('ADMIN')
    signIn(admin)
    const client = addClient()
    const html = (await open(validQuery(client.clientId))).html!

    const forms = html.match(/<form\b[^>]*>/g) ?? []
    expect(forms).toHaveLength(1)
    expect(forms[0]).toContain('method="post"')
    expect(forms[0]).toContain(`action="${CONSENT_FORM_ACTION}"`)
    expect(CONSENT_FORM_ACTION).toBe('/api/oauth/authorize')

    // «Cancelar» first in the document, «Permitir» second
    const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)]
    expect(buttons.map(b => b[2])).toEqual(['Cancelar', 'Permitir'])
    expect(buttons[0][1]).toContain(`name="${DECISION_FIELD}"`)
    expect(buttons[0][1]).toContain(`value="${DECISION_DENY}"`)
    expect(buttons[1][1]).toContain(`name="${DECISION_FIELD}"`)
    expect(buttons[1][1]).toContain(`value="${DECISION_ALLOW}"`)
    for (const b of buttons) {
      expect(b[1]).toContain('type="submit"')
      // The attribute, not the `disabled:` style variants of the class list
      expect(b[1]).not.toMatch(/\sdisabled(=|\s|$)/)
    }

    // Works with JavaScript off: no script, no inline handler, no javascript: URL
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\son[a-z]+=/i)
    expect(html).not.toMatch(/javascript:/i)
    expect(consentTokenOf(html)).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('signs the token for this administrator and this exact request', async () => {
    const admin = addUser('ADMIN')
    signIn(admin)
    const client = addClient()
    const before = Date.now()
    const html = (await open(validQuery(client.clientId, { resource: undefined, scope: undefined }))).html!
    const check = verifyConsentToken(consentTokenOf(html))
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.fields).toEqual({
      userId: admin.id,
      clientId: client.clientId,
      redirectUri: CLAUDE_CALLBACK,
      codeChallenge: CHALLENGE,
      state: 'st-123',
      resource: MCP_RESOURCE,
      scope: MCP_GRANT_SCOPE,
    })
    expect(check.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000)
    expect(check.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000)

    // No state in the request: none is invented
    const noState = (await open(validQuery(client.clientId, { state: undefined }))).html!
    const second = verifyConsentToken(consentTokenOf(noState))
    expect(second.ok && second.fields.state).toBe(null)

    // Another administrator gets a token of their own
    const other = addUser('ADMIN')
    signIn(other)
    const third = verifyConsentToken(consentTokenOf((await open(validQuery(client.clientId))).html!))
    expect(third.ok && third.fields.userId).toBe(other.id)

    // Whatever known scope the client names, the consent is for both scopes
    for (const scope of ['tkoc.read', 'tkoc.write', 'tkoc.read tkoc.write', 'tkoc.write tkoc.read']) {
      const shown = await open(validQuery(client.clientId, { scope }))
      expect(shown.redirect, scope).toBeNull()
      const signed = verifyConsentToken(consentTokenOf(shown.html!))
      expect(signed.ok && signed.fields.scope, scope).toBe(MCP_GRANT_SCOPE)
    }
  })

  it('escapes everything that comes from the client registration and from the user name', async () => {
    const hostile = `<img src=x onerror="alert(1)"> & 'Claude' </bdi></form><script>alert(2)</script> $& $1`
    signIn(addUser('ADMIN', { name: `Ana <i>$&</i> $' {host}` }))
    const client = addClient(hostile)
    const html = (await open(validQuery(client.clientId))).html!

    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<i>/i)
    expect(html.match(/<form\b/g)).toHaveLength(1)
    expect(html.match(/<\/form>/g)).toHaveLength(1)
    expect(html.match(/<bdi>/g)).toHaveLength(1)
    // Still there, as text, character for character
    expect(decode(html)).toContain(`<bdi>${hostile}</bdi>`)
    expect(decode(html)).toContain(`Has iniciado sesión como Ana <i>$&</i> $' {host}.`)
    expect(html).toContain('Al terminar volverás a claude.ai.')
  })

  it('says so when the browser will return to an application on this computer (any port)', async () => {
    const admin = addUser('ADMIN')
    signIn(admin)
    const client = addClient('Claude Code', ['http://localhost:3118/callback'])
    const html = (await open(validQuery(client.clientId, { redirect_uri: 'http://localhost:53124/callback' }))).html!
    expect(html).toContain('Al terminar volverás a una aplicación de este ordenador (localhost:53124).')
    const check = verifyConsentToken(consentTokenOf(html))
    expect(check.ok && check.fields.redirectUri).toBe('http://localhost:53124/callback')
  })
})

describe('GET /oauth/authorize: page settings and texts', () => {
  it('is never cached or indexed and keeps its query out of referrers', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(metadata.title).toBe('Conectar Claude · TKOC Intelligence')
    expect(metadata.robots).toEqual({ index: false, follow: false })
    expect(metadata.referrer).toBe('same-origin')
  })

  it('keeps the sentences of the specification verbatim', () => {
    expect(es.forbidden).toBe('Solo un administrador puede conectar Claude con la plataforma.')
    // The three sentences of the write layer (12 Nov 2026), in both languages
    const w = translations.es.mcp.write.consent
    expect(w.can).toBe('Leer y modificar campañas, creadoras, publicaciones, listas, informes y rastreos, con tu usuario.')
    expect(w.confirm).toBe('Borrar, gastar Apify, enviar correos, cambios en bloque y los textos del informe que ve el cliente.')
    expect(w.never).toBe('Usuarios, permisos, claves e integraciones.')
    expect(Object.keys(translations.en.mcp.write.consent).sort()).toEqual(Object.keys(w).sort())
    // The read-only sentences are gone
    expect(es).not.toHaveProperty('gets')
    expect(es).not.toHaveProperty('never')
    expect(es.allow).toBe('Permitir')
    expect(es.cancel).toBe('Cancelar')
    expect(translations.es.mcp.connections.title).toBe('Conexiones con Claude')
    expect(translations.es.mcp.connections.revoke).toBe('Revocar')
  })

  it('has no dash used as punctuation and no empty text in either language', () => {
    const texts = (o: unknown): string[] =>
      o && typeof o === 'object' ? Object.values(o as Record<string, unknown>).flatMap(texts) : [String(o)]
    for (const locale of ['es', 'en'] as const) {
      for (const sentence of texts(translations[locale].mcp)) {
        expect(sentence.trim().length).toBeGreaterThan(0)
        expect(sentence).not.toMatch(/[—–]/)
      }
    }
  })
})
