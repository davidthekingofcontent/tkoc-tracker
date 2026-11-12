import { describe, expect, it, vi } from 'vitest'

// Before any import: a fixed signing secret, no address in the environment
// (every URL is built from the production default) and no database: the
// functions under test here are pure.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { z } from 'zod'
import { APP_URL, MCP_GRANT_SCOPE, MCP_RESOURCE, MCP_SCOPE, MCP_WRITE_SCOPE, authorizationServerMetadata, grantHasScope, isAllowedRedirectUri, protectedResourceMetadata } from '@/lib/mcp/config'
import {
  CONFIRM_TOKEN_TTL_MS,
  PENDING_ACTION_TTL_MS,
  approveUrlFor,
  argsDigest,
  canonicalJson,
  isActionId,
  isApprovalClass,
  isTokenClass,
  signConfirmToken,
  signDecisionToken,
  verifyConfirmToken,
  verifyDecisionToken,
  type ConfirmBinding,
} from '@/lib/mcp/confirm'
import { CONSENT_TOKEN_TTL_MS } from '@/lib/mcp/config'
import { looksLikeSecret, signConsentToken, verifyConsentToken } from '@/lib/mcp/crypto'
import { WRITE_CONTROL_FIELDS, defineWriteTool, writeToolConfig } from '@/lib/mcp/write-tool'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConsentScreen } from '@/components/mcp/consent-screen'
import { MCP_WRITE_TEXTS, fillText } from '@/components/mcp/write-texts'

const GRANT = 'grant_abc123'
const ARGS = { campaignId: 'cmp_1', influencerIds: ['a', 'b', 'c'], fee: 300, note: 'Hola', options: { notify: false, mode: 'move' } }
const binding = (over: Partial<ConfirmBinding> = {}): ConfirmBinding => ({ tool: 'add_creators_to_campaign', args: ARGS, grantId: GRANT, ...over })

describe('canonicalJson', () => {
  it('does not depend on the order of the keys, at any depth', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'x' } }
    const b = { a: { x: 'x', y: [1, { p: 2, q: 1 }] }, b: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":{"x":"x","y":[1,{"p":2,"q":1}]},"b":1}')
  })

  it('leaves out undefined values, so an absent optional argument and an undefined one are the same', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    expect(canonicalJson([undefined, 1])).toBe('[null,1]')
  })

  it('keeps every real difference', () => {
    const base = canonicalJson(ARGS)
    const variants: unknown[] = [
      { ...ARGS, fee: 301 },
      { ...ARGS, fee: '300' },
      { ...ARGS, influencerIds: ['a', 'c', 'b'] },
      { ...ARGS, influencerIds: ['a', 'b'] },
      { ...ARGS, note: 'Hola ' },
      { ...ARGS, extra: null },
      { ...ARGS, options: { notify: true, mode: 'move' } },
      Object.fromEntries(Object.entries(ARGS).filter(([k]) => k !== 'note')),
    ]
    for (const v of variants) expect(canonicalJson(v), JSON.stringify(v)).not.toBe(base)
  })

  it('refuses what JSON cannot carry faithfully', () => {
    for (const bad of [NaN, Infinity, -Infinity, () => 1, BigInt(1), Symbol('s')]) expect(() => canonicalJson({ x: bad })).toThrow()
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow()
    // The same object twice (not a cycle) is fine
    const shared = { k: 1 }
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"k":1},"b":{"k":1}}')
  })

  it('argsDigest is a hash of the canonical form', () => {
    expect(argsDigest({ b: 2, a: 1 })).toBe(argsDigest({ a: 1, b: 2 }))
    expect(argsDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
    expect(argsDigest({ a: 1 })).not.toBe(argsDigest({ a: 2 }))
  })
})

describe('confirm token (money, bulk)', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0)

  it('verifies for the same tool, the same arguments (in any key order) and the same grant, within 5 minutes', () => {
    const { token, expiresAt } = signConfirmToken(binding(), now)
    expect(expiresAt.getTime()).toBe(now + CONFIRM_TOKEN_TTL_MS)
    expect(CONFIRM_TOKEN_TTL_MS).toBe(5 * 60_000)
    const reordered = { options: { mode: 'move', notify: false }, note: 'Hola', fee: 300, influencerIds: ['a', 'b', 'c'], campaignId: 'cmp_1' }
    expect(verifyConfirmToken(token, binding({ args: reordered }), now + 1)).toEqual({ ok: true, expiresAt })
    expect(verifyConfirmToken(token, binding(), now + CONFIRM_TOKEN_TTL_MS - 1).ok).toBe(true)
  })

  it('is bound to every argument: any change makes it a mismatch', () => {
    const { token } = signConfirmToken(binding(), now)
    const changes: Record<string, unknown>[] = [
      { ...ARGS, campaignId: 'cmp_2' },
      { ...ARGS, influencerIds: ['a', 'b', 'c', 'd'] },
      { ...ARGS, influencerIds: ['c', 'b', 'a'] },
      { ...ARGS, fee: 300.01 },
      { ...ARGS, fee: '300' },
      { ...ARGS, note: 'hola' },
      { ...ARGS, options: { notify: true, mode: 'move' } },
      { ...ARGS, extra: true },
      {},
    ]
    for (const args of changes) {
      expect(verifyConfirmToken(token, binding({ args }), now + 1), JSON.stringify(args)).toEqual({ ok: false, reason: 'mismatch' })
    }
  })

  it('is bound to the tool, the grant and the state the preview showed', () => {
    const { token } = signConfirmToken(binding({ fingerprint: '{"members":3}' }), now)
    expect(verifyConfirmToken(token, binding({ fingerprint: '{"members":3}' }), now).ok).toBe(true)
    expect(verifyConfirmToken(token, binding({ tool: 'launch_campaign_tracking', fingerprint: '{"members":3}' }), now)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyConfirmToken(token, binding({ grantId: 'grant_other', fingerprint: '{"members":3}' }), now)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyConfirmToken(token, binding({ fingerprint: '{"members":4}' }), now)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyConfirmToken(token, binding(), now)).toEqual({ ok: false, reason: 'mismatch' })
    // And the other way round: a token without state does not fit a call that has one
    const plain = signConfirmToken(binding(), now).token
    expect(verifyConfirmToken(plain, binding({ fingerprint: 'x' }), now)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('expires after 5 minutes', () => {
    const { token } = signConfirmToken(binding(), now)
    expect(verifyConfirmToken(token, binding(), now + CONFIRM_TOKEN_TTL_MS)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyConfirmToken(token, binding(), now + 60 * 60_000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('cannot be forged or altered', () => {
    const { token } = signConfirmToken(binding(), now)
    const [v, payload, sig] = token.split('.')
    // A payload rewritten for other arguments keeps the old signature: refused
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const forged = Buffer.from(JSON.stringify({ ...decoded, a: argsDigest({ campaignId: 'other' }) })).toString('base64url')
    expect(verifyConfirmToken(`${v}.${forged}.${sig}`, binding({ args: { campaignId: 'other' } }), now)).toEqual({ ok: false, reason: 'signature' })
    // Longer expiry: refused
    const later = Buffer.from(JSON.stringify({ ...decoded, e: now + 365 * 86_400_000 })).toString('base64url')
    expect(verifyConfirmToken(`${v}.${later}.${sig}`, binding(), now + CONFIRM_TOKEN_TTL_MS + 1)).toEqual({ ok: false, reason: 'signature' })
    // Another signature
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'AB' : 'AA')
    expect(verifyConfirmToken(`${v}.${payload}.${flipped}`, binding(), now).ok).toBe(false)
    // Signed with another secret
    const secret = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'another-secret'
    const foreign = signConfirmToken(binding(), now).token
    process.env.JWT_SECRET = secret
    expect(verifyConfirmToken(foreign, binding(), now)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses anything that is not one of its tokens', () => {
    const { token } = signConfirmToken(binding(), now)
    const consent = signConsentToken({ userId: 'u', clientId: 'c', redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'x'.repeat(43), state: null, resource: MCP_RESOURCE, scope: MCP_GRANT_SCOPE }, now)
    for (const bad of [undefined, null, 1, {}, '', 'c1', 'c1..', `c2.${token.split('.')[1]}.${token.split('.')[2]}`, `${token}.x`, token + '=', 'x'.repeat(2000), consent]) {
      const check = verifyConfirmToken(bad, binding(), now)
      expect(check.ok, String(bad).slice(0, 40)).toBe(false)
    }
  })

  it('never issues the same token twice, even for the same call at the same instant', () => {
    const a = signConfirmToken(binding(), now).token
    const b = signConfirmToken(binding(), now).token
    expect(a).not.toBe(b)
    expect(verifyConfirmToken(a, binding(), now).ok && verifyConfirmToken(b, binding(), now).ok).toBe(true)
  })

  it('carries no argument in clear: only their hash', () => {
    const { token } = signConfirmToken(binding({ args: { email: 'marta@correo-inventado.test', note: 'NOTA-NO-DEBE-SALIR' } }), now)
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    expect(payload).not.toContain('marta@')
    expect(payload).not.toContain('NOTA-NO-DEBE-SALIR')
  })
})

describe('decision token of the confirmation page (reuses the signed consent token)', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0)

  it('is valid for this action and this administrator, for 10 minutes', () => {
    const token = signDecisionToken('act_1', 'admin_1', now)
    expect(verifyDecisionToken(token, 'act_1', 'admin_1', now + 1)).toEqual({ ok: true })
    expect(verifyDecisionToken(token, 'act_1', 'admin_1', now + CONSENT_TOKEN_TTL_MS)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyDecisionToken(token, 'act_2', 'admin_1', now)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyDecisionToken(token, 'act_1', 'admin_2', now)).toEqual({ ok: false, reason: 'mismatch' })
    expect(verifyDecisionToken('garbage', 'act_1', 'admin_1', now)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('an OAuth consent token is not a decision token, even with the same user', () => {
    const consent = signConsentToken({ userId: 'admin_1', clientId: 'c'.repeat(43), redirectUri: 'https://claude.ai/api/mcp/auth_callback', codeChallenge: 'act_1', state: null, resource: MCP_RESOURCE, scope: MCP_GRANT_SCOPE }, now)
    expect(verifyDecisionToken(consent, 'act_1', 'admin_1', now)).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('a decision token can never pass as an OAuth consent: no real client, no registrable redirect URI, no OAuth scope', () => {
    const check = verifyConsentToken(signDecisionToken('act_1', 'admin_1', now), now)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(looksLikeSecret(check.fields.clientId)).toBe(false) // createGrantAndCode answers invalid_client
    expect(isAllowedRedirectUri(check.fields.redirectUri)).toBe(false) // the refusal branch never redirects
    expect(check.fields.scope.split(' ').every(s => [MCP_SCOPE, MCP_WRITE_SCOPE].includes(s))).toBe(false)
  })
})

describe('pending actions: pure pieces', () => {
  it('builds the approval link from APP_URL, never from a request', () => {
    expect(APP_URL).toBe('https://intelligence.thekingofcontent.agency')
    expect(approveUrlFor('ckabc123')).toBe('https://intelligence.thekingofcontent.agency/mcp/confirmar/ckabc123')
    expect(PENDING_ACTION_TTL_MS).toBe(15 * 60_000)
  })

  it('accepts only ids made of letters, digits, _ and -', () => {
    for (const ok of ['ckabc123', 'a', 'A_b-9', 'x'.repeat(64)]) expect(isActionId(ok), ok).toBe(true)
    for (const bad of ['', 'x'.repeat(65), '../x', 'a/b', 'a b', 'a%2F', 'a.b', null, 1, undefined]) expect(isActionId(bad), String(bad)).toBe(false)
  })

  it('sorts the classes into chat confirmations and platform approvals', () => {
    expect(isTokenClass('money') && isTokenClass('bulk')).toBe(true)
    expect(isApprovalClass('destructive') && isApprovalClass('outbound')).toBe(true)
    expect(isTokenClass('none') || isTokenClass('destructive') || isApprovalClass('money') || isApprovalClass('none')).toBe(false)
  })
})

describe('scopes', () => {
  it('a new authorisation grants read and write in one consent; the metadata announce both', () => {
    expect(MCP_SCOPE).toBe('tkoc.read')
    expect(MCP_WRITE_SCOPE).toBe('tkoc.write')
    expect(MCP_GRANT_SCOPE).toBe('tkoc.read tkoc.write')
    expect(protectedResourceMetadata().scopes_supported).toEqual(['tkoc.read', 'tkoc.write'])
    expect(authorizationServerMetadata().scopes_supported).toEqual(['tkoc.read', 'tkoc.write'])
  })

  it('a grant has a scope only as a whole item', () => {
    expect(grantHasScope('tkoc.read tkoc.write', 'tkoc.write')).toBe(true)
    expect(grantHasScope('tkoc.read', 'tkoc.write')).toBe(false)
    expect(grantHasScope('tkoc.read tkoc.writer', 'tkoc.write')).toBe(false)
    expect(grantHasScope('tkoc.readtkoc.write', 'tkoc.write')).toBe(false)
    expect(grantHasScope(null, 'tkoc.read')).toBe(false)
  })
})

describe('defineWriteTool: the contract the tools are built against', () => {
  const base = {
    name: 'test_tool',
    title: 'Herramienta de prueba',
    description: 'Does a test thing.',
    input: { campaignId: z.string() },
    annotations: { destructiveHint: true },
    summarize: (a: { campaignId: string }) => ({ campaignId: a.campaignId }),
    plan: async () => ({ confirmation: 'none' as const }),
    execute: async () => ({}),
  }

  it('adds the control fields each class needs, and nothing else', () => {
    const none = defineWriteTool({ ...base, confirmations: ['none'] })
    expect(Object.keys(none.input).sort()).toEqual(['campaignId', 'includeContact', 'includeEconomics'])
    const money = defineWriteTool({ ...base, confirmations: ['none', 'money'] })
    expect(Object.keys(money.input).sort()).toEqual(['campaignId', 'confirmToken', 'includeContact', 'includeEconomics'])
    const destructive = defineWriteTool({ ...base, confirmations: ['destructive'] })
    expect(Object.keys(destructive.input).sort()).toEqual(['actionId', 'campaignId', 'includeContact', 'includeEconomics'])
    const all = defineWriteTool({ ...base, confirmations: ['bulk', 'outbound'] })
    expect(Object.keys(all.input).sort()).toEqual(['actionId', 'campaignId', 'confirmToken', 'includeContact', 'includeEconomics'])
  })

  it('announces a write tool: title, readOnlyHint false, its destructive hint, and the confirmation rules in the description', () => {
    const tool = defineWriteTool({ ...base, confirmations: ['money', 'destructive'], annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true } })
    expect(tool.annotations).toEqual({ title: 'Herramienta de prueba', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
    expect(tool.description.startsWith('Does a test thing.')).toBe(true)
    expect(tool.description).toContain('needsConfirmation')
    expect(tool.description).toContain('show the preview, wait for an explicit yes')
    // A bulk confirmation cannot be dodged by splitting the request (fix of 12 Nov 2026)
    expect(tool.description).toContain('never split it to stay under a threshold')
    expect(tool.description).toContain('needsApproval')
    expect(tool.description).toContain('the person confirms in the platform, never you')
    // The contact and money rules live in the server instructions and in the flags' own
    // descriptions: tools/list does not repeat them on every tool
    expect(tool.description).not.toContain('Contact data')
    expect((tool.input.includeContact as { description?: string }).description).toBeTruthy()
    expect((tool.input.includeEconomics as { description?: string }).description).toBeTruthy()
    const config = writeToolConfig(tool)
    expect(config).toEqual({ title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations })
    const plain = defineWriteTool({ ...base, confirmations: ['none'], annotations: { destructiveHint: false } })
    expect(plain.annotations).toEqual({ title: 'Herramienta de prueba', readOnlyHint: false, destructiveHint: false, openWorldHint: false })
    expect(plain.description).not.toContain('needsConfirmation')
    expect(plain.description).not.toContain('needsApproval')
    expect(plain.description).toBe('Does a test thing.')
  })

  it('refuses a definition that breaks the contract', () => {
    expect(() => defineWriteTool({ ...base, name: 'Bad-Name', confirmations: ['none'] })).toThrow()
    expect(() => defineWriteTool({ ...base, name: 'x'.repeat(65), confirmations: ['none'] })).toThrow()
    expect(() => defineWriteTool({ ...base, title: ' ', confirmations: ['none'] })).toThrow()
    expect(() => defineWriteTool({ ...base, confirmations: [] })).toThrow()
    for (const field of WRITE_CONTROL_FIELDS) {
      expect(() => defineWriteTool({ ...base, input: { campaignId: z.string(), [field]: z.string().optional() }, confirmations: ['none'] }), field).toThrow()
    }
    expect(defineWriteTool({ ...base, name: 'x'.repeat(64), confirmations: ['none'] }).name).toHaveLength(64)
  })
})

describe('texts of the write scope', () => {
  it('the consent screen says what Claude can do, what it always asks to confirm and what it can never touch', () => {
    const html = renderToStaticMarkup(
      createElement(ConsentScreen, { clientName: 'Claude', redirectKind: 'claude', redirectHost: 'claude.ai', adminName: 'Ada', consentToken: 't' }),
    )
    expect(html).toContain('Leer y modificar campañas, creadoras, publicaciones, listas, informes y rastreos, con tu usuario.')
    expect(html).toContain('Borrar, gastar Apify, enviar correos, cambios en bloque y los textos del informe que ve el cliente.')
    expect(html).toContain('Usuarios, permisos, claves e integraciones.')
    // The read-only promise is gone: it would no longer be true
    expect(html).not.toContain('No puede cambiar nada')
    expect(html).not.toContain('No recibe correos, teléfonos, direcciones ni contraseñas.')
  })

  it('every text exists in Spanish and in English, with no em-dash', () => {
    const keys = (o: object, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]))
    expect(keys(MCP_WRITE_TEXTS.en).sort()).toEqual(keys(MCP_WRITE_TEXTS.es).sort())
    expect(JSON.stringify(MCP_WRITE_TEXTS)).not.toContain('\u2014')
    expect(JSON.stringify(MCP_WRITE_TEXTS)).not.toContain('—')
  })

  it('fills placeholders literally', () => {
    expect(fillText('Solo {owner} puede, {owner}.', { owner: '$& $1' })).toBe('Solo $& $1 puede, $& $1.')
    expect(fillText('{missing}', {})).toBe('{missing}')
  })
})
