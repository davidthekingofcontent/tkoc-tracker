import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, no public address (every
// URL is built from the production default), no Apify token.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-pending-actions'
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
  return {
    Redirected,
    cookie: { value: undefined as string | undefined },
    apify: { exhausted: false, usedPct: 42 as number | null, optionalBlocked: false, coreBlocked: false },
    mail: [] as { to: string; inviterName: string; campaignName: string }[],
  }
})

// The page reads its cookie through next/headers and leaves through redirect()
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
// Apify: the state /api/apify-status reports is set by each test
vi.mock('@/lib/apify', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return {
    ...actual,
    isApifyExhausted: () => h.apify.exhausted,
    getApifyResumeDate: () => (h.apify.exhausted ? '2026-12-01T00:00:00.000Z' : null),
    getApifyBudget: async () => ({
      usd: null, limit: null, cycleEndsAt: '2026-12-01T00:00:00.000Z', softLimit: null, coreLimit: null,
      optionalBlocked: h.apify.optionalBlocked, coreBlocked: h.apify.coreBlocked, usedPct: h.apify.usedPct,
    }),
  }
})
// The e-mail library: every invitation the platform tries to send is kept here
vi.mock('@/lib/email', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  return {
    ...actual,
    sendInfluencerInviteEmail: async (args: { to: string; inviterName: string; campaignName: string }) => {
      h.mail.push({ to: args.to, inviterName: args.inviterName, campaignName: args.campaignName })
    },
  }
})

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { generateToken, hashPassword } from '@/lib/auth'
import ConfirmActionPage from '@/app/mcp/confirmar/[id]/page'
import { POST as decide } from '@/app/api/mcp/actions/[id]/route'
import { POST as oauthDecide } from '@/app/api/oauth/authorize/route'
import { safeNextPath } from '@/app/(auth)/login/safe-next'
import { middleware } from '@/middleware'
import { ACTION_PASSWORD_FIELD, ACTION_TOKEN_FIELD } from '@/components/mcp/action-form'
import { MCP_RESOURCE, MCP_GRANT_SCOPE } from '@/lib/mcp/config'
import {
  CONFIRM_TOKEN_TTL_MS,
  createPendingAction,
  decidePendingAction,
  signConfirmToken,
  signDecisionToken,
} from '@/lib/mcp/confirm'
import { pkceChallengeS256, randomSecret, signConsentToken } from '@/lib/mcp/crypto'
import { createGrantAndCode, registerClient } from '@/lib/mcp/oauth'
import { setPlatformTransport } from '@/lib/mcp/platform-client'
import { idInput } from '@/lib/mcp/tools/shared'
import { WRITE_RATE_LIMITS, defineWriteTool, type WriteTool } from '@/lib/mcp/write-tool'
import { classifyCall } from '@/components/mcp/activity-api'
import { createPlatformRouter } from '../helpers/platform-router'

const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const SITE = 'https://intelligence.thekingofcontent.agency'
/** The invented password of every user of this file (bcrypt-hashed in the database, as at login). */
const PASSWORD = 'Contraseña-Inventada-1'
const tag = randomUUID().slice(0, 8)
const router = createPlatformRouter()

// ============ Fixtures (invented data) ============

const fx = {
  ada: { id: '', name: 'Ada Admin' },
  bea: { id: '', name: 'Bea Admin' },
  carla: { id: '', name: 'Carla Admin' },
  emp: { id: '' },
  brand: { id: '' },
  creator: { id: '' },
  grantAda: '',
  grantBea: '',
  grantCarla: '',
  grantReadOnly: '',
  campaign: '',
  campaignName: `Campaña Acciones ${tag}`,
  marta: '',
  luis: '',
  nora: '',
}

const created = { users: [] as string[], influencers: [] as string[] }

let ipCounter = 0
/**
 * A live grant, as after a real connection. It gets an access token row so the
 * housekeeping of every registration (sweepExpired) does not close it.
 */
async function keepAlive(grantId: string): Promise<void> {
  await prisma.mcpToken.create({ data: { grantId, kind: 'access', tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 3_600_000) } })
}

async function grantFor(userId: string): Promise<string> {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, `198.51.100.${++ipCounter}-${tag}`)
  const { grantId } = await createGrantAndCode({ userId, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) })
  await keepAlive(grantId)
  return grantId
}

async function member(influencerId: string) {
  return prisma.campaignInfluencer.findUnique({ where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId } } })
}

async function ensureMember(influencerId: string) {
  if (!(await member(influencerId))) await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaign, influencerId, status: 'NEGOTIATING' } })
}

const callsTo = (method: string, pattern: string) => router.calls.filter(c => c.method === method && c.pattern === pattern).length

// ============ Tools of the test, built with the real helper ============

const removeCreator = defineWriteTool({
  name: 'test_remove_creator',
  title: 'Quitar creadora (prueba)',
  description: 'Removes one creator from a campaign.',
  input: { campaignId: idInput('Campaign id'), influencerId: idInput('Creator id') },
  confirmations: ['destructive'],
  annotations: { destructiveHint: true },
  summarize: a => ({ campaignId: a.campaignId, influencerId: a.influencerId }),
  plan: async (a, ctx) => {
    const data = await ctx.platformJson<{ campaign: { name: string } }>({ method: 'GET', path: `/api/campaigns/${a.campaignId}` })
    return { confirmation: 'destructive', preview: `Vas a quitar a la creadora ${a.influencerId} de «${data.campaign.name}». No se puede deshacer. ¿Confirmas?` }
  },
  execute: async (a, ctx) => {
    await ctx.platformJson({ method: 'DELETE', path: `/api/campaigns/${a.campaignId}/influencers`, body: { influencerId: a.influencerId } })
    return { removed: true, campaignId: a.campaignId, influencerId: a.influencerId }
  },
})

const inviteCreator = defineWriteTool({
  name: 'test_invite_creator',
  title: 'Invitar creadora (prueba)',
  description: 'Sends an invitation e-mail to a creator.',
  input: { email: z.string().email(), campaignId: idInput('Campaign id') },
  confirmations: ['outbound'],
  annotations: { destructiveHint: false, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId }),
  plan: async a => ({ confirmation: 'outbound', preview: `Vas a ENVIAR UN CORREO a ${a.email} invitándola a conectar su cuenta. ¿Confirmas el envío a ${a.email}?` }),
  execute: async (a, ctx) => ctx.platformJson({ method: 'POST', path: '/api/influencers/invite', body: { email: a.email, campaignId: a.campaignId, locale: 'es' } }),
})

function paidTool(name: string, spend: 'core' | 'optional'): WriteTool {
  return defineWriteTool({
    name,
    title: 'Acción de pago (prueba)',
    description: 'Sets the deliverables of a creator, as if it spent Apify.',
    input: { campaignId: idInput('Campaign id'), influencerId: idInput('Creator id'), deliverables: z.number().int().min(0).max(50) },
    confirmations: ['money'],
    annotations: { destructiveHint: false },
    summarize: a => ({ campaignId: a.campaignId, influencerId: a.influencerId, deliverables: a.deliverables }),
    plan: async (a, ctx) => {
      const status = await ctx.apifyStatus()
      const data = await ctx.platformJson<{ campaign: { influencers: unknown[] } }>({ method: 'GET', path: `/api/campaigns/${a.campaignId}` })
      return {
        confirmation: 'money',
        spend,
        preview: `Vas a gastar una lectura de perfil de Apify (uso actual del plan: ${status.usedPct} %). ¿Confirmas?`,
        fingerprint: JSON.stringify({ members: data.campaign.influencers.length }),
      }
    },
    execute: async (a, ctx) => {
      await ctx.platformJson({ method: 'PATCH', path: `/api/campaigns/${a.campaignId}/influencers`, body: { influencerId: a.influencerId, deliverablesPlanned: a.deliverables } })
      return { done: true }
    },
  })
}
const paidCore = paidTool('test_paid_core', 'core')
const paidOptional = paidTool('test_paid_optional', 'optional')

const updateFees = defineWriteTool({
  name: 'test_update_fees',
  title: 'Cambiar fees (prueba)',
  description: 'Changes the agreed fee of creators.',
  input: { campaignId: idInput('Campaign id'), fees: z.array(z.object({ influencerId: idInput('Creator id'), agreedFee: z.number().min(0) })).min(1).max(20) },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: false, idempotentHint: true },
  summarize: a => ({ campaignId: a.campaignId, creators: a.fees.length }),
  plan: async a => (a.fees.length > 5 ? { confirmation: 'bulk', preview: `Vas a cambiar el fee de ${a.fees.length} creadoras. ¿Confirmas?` } : { confirmation: 'none' }),
  execute: async (a, ctx) => {
    const items: unknown[] = []
    for (const f of a.fees) {
      items.push(await ctx.platformJson({ method: 'PATCH', path: `/api/campaigns/${a.campaignId}/influencers`, body: { influencerId: f.influencerId, agreedFee: f.agreedFee } }))
    }
    return { updated: items.length, items }
  },
})

// ============ Calling a tool as Claude would ============

interface Answer {
  isError: boolean
  text: string
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(tool: WriteTool, grantId: string, userId: string, args: Record<string, unknown>, options = {}): Promise<Answer> {
  const res = await tool.call(args, { grantId, userId }, options)
  const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
  let data: unknown = null
  if (!res.isError) data = JSON.parse(text)
  return { isError: res.isError === true, text, data }
}
const asAda = (tool: WriteTool, args: Record<string, unknown>, options = {}) => call(tool, fx.grantAda, fx.ada.id, args, options)

async function lastLog(grantId: string) {
  // Two lines can share a millisecond: the cuid of the newer one sorts after (it carries a counter)
  return prisma.mcpCallLog.findFirstOrThrow({ where: { grantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

// ============ The confirmation page and its form ============

function signIn(user: { id: string }, role: string): string {
  const token = generateToken(user.id, role)
  h.cookie.value = token
  return token
}

async function openPage(id: string): Promise<{ html: string; redirect: null } | { html: null; redirect: string }> {
  try {
    const element = await ConfirmActionPage({ params: Promise.resolve({ id }) })
    return { html: renderToStaticMarkup(element), redirect: null }
  } catch (e) {
    if (e instanceof h.Redirected) return { html: null, redirect: e.url }
    throw e
  }
}

function decode(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function tokenOf(html: string): string {
  const input = (html.match(/<input\b[^>]*>/g) ?? []).find(i => i.includes(`name="${ACTION_TOKEN_FIELD}"`)) ?? ''
  return /\bvalue="([^"]*)"/.exec(input)?.[1] ?? ''
}

function post(id: string, fields: Record<string, string>, opts: { cookie?: string | null; site?: string | null; query?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (opts.cookie) headers.cookie = `token=${opts.cookie}`
  if (opts.site !== null) headers['sec-fetch-site'] = opts.site ?? 'same-origin'
  const req = new NextRequest(`${SITE}/api/mcp/actions/${id}${opts.query ?? ''}`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() })
  return decide(req, { params: Promise.resolve({ id }) })
}

async function statusOf(id: string): Promise<string> {
  return (await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id } })).status
}

// ============ Setup ============

beforeAll(async () => {
  // Nothing in this file may reach a network
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  setPlatformTransport(router.transport)

  const hash = await hashPassword(PASSWORD)
  const user = (name: string, role: 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR') =>
    prisma.user.create({ data: { email: `${name.toLowerCase().replace(/\s/g, '.')}-${tag}@correo-inventado.test`, password: hash, name, role } })
  const [ada, bea, carla, emp, brand, creator] = await Promise.all([
    user('Ada Admin', 'ADMIN'), user('Bea Admin', 'ADMIN'), user('Carla Admin', 'ADMIN'),
    user('Pepa Empleada', 'EMPLOYEE'), user('Marca Cliente', 'BRAND'), user('Creadora Usuaria', 'CREATOR'),
  ])
  created.users.push(ada.id, bea.id, carla.id, emp.id, brand.id, creator.id)
  Object.assign(fx, { ada: { id: ada.id, name: ada.name }, bea: { id: bea.id, name: bea.name }, carla: { id: carla.id, name: carla.name }, emp: { id: emp.id }, brand: { id: brand.id }, creator: { id: creator.id } })

  fx.grantAda = await grantFor(ada.id)
  fx.grantBea = await grantFor(bea.id)
  fx.grantCarla = await grantFor(carla.id)
  // An authorisation of before the write layer: read only
  fx.grantReadOnly = (await prisma.mcpGrant.create({ data: { clientId: 'old-client', userId: ada.id, scope: 'tkoc.read', resource: MCP_RESOURCE } })).id
  await keepAlive(fx.grantReadOnly)

  const campaign = await prisma.campaign.create({
    data: { name: fx.campaignName, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: ada.id },
  })
  fx.campaign = campaign.id
  const inf = (username: string, extra: Record<string, unknown> = {}) => prisma.influencer.create({ data: { username: `${username}_${tag}`, platform: 'INSTAGRAM', followers: 1000, ...extra } })
  const [marta, luis, nora] = await Promise.all([
    inf('marta', { email: 'marta@correo-inventado.test', phone: '+34600111222', standardFee: 7777.77 }),
    inf('luis'),
    inf('nora'),
  ])
  created.influencers.push(marta.id, luis.id, nora.id)
  Object.assign(fx, { marta: marta.id, luis: luis.id, nora: nora.id })
  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: campaign.id, influencerId: marta.id, status: 'NEGOTIATING', agreedFee: 100, shippingName: 'DESTINATARIA-NO-DEBE-SALIR', shippingAddress1: 'Calle Inventada 123', shippingEmail: 'envios@correo-inventado.test' },
      { campaignId: campaign.id, influencerId: luis.id, status: 'NEGOTIATING' },
    ],
  })
  await prisma.media.create({ data: { campaignId: campaign.id, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `ext-pa-${tag}`, likes: 3, postedAt: new Date('2026-10-05T10:00:00.000Z'), source: 'manual' } })
})

beforeEach(() => {
  h.cookie.value = undefined
  Object.assign(h.apify, { exhausted: false, usedPct: 42, optionalBlocked: false, coreBlocked: false })
})

afterAll(async () => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
  await prisma.mcpPendingAction.deleteMany({ where: { grantId: { in: [fx.grantAda, fx.grantBea, fx.grantCarla, fx.grantReadOnly] } } })
  await prisma.mcpCallLog.deleteMany({ where: { grantId: { in: [fx.grantAda, fx.grantBea, fx.grantCarla, fx.grantReadOnly] } } })
  await prisma.invitation.deleteMany({ where: { invitedBy: { in: created.users } } })
  await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.contact.deleteMany({ where: { influencerId: { in: created.influencers } } }).catch(() => {})
  await prisma.influencer.deleteMany({ where: { id: { in: created.influencers } } })
  await prisma.notification.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpToken.deleteMany({ where: { grantId: { in: [fx.grantAda, fx.grantBea, fx.grantCarla, fx.grantReadOnly] } } })
  await prisma.mcpAuthCode.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpGrant.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
})

// ============ Destructive: a pending action approved in the platform ============

describe('a destructive action waits for the administrator, then runs once with the stored arguments', () => {
  let actionId = ''

  it('the first call changes nothing: it creates a pending action and returns its preview and link', async () => {
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.marta })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ needsApproval: true, validForMinutes: 15 })
    actionId = answer.data.actionId
    expect(answer.data.approveUrl).toBe(`${SITE}/mcp/confirmar/${actionId}`)
    expect(answer.data.preview).toContain(fx.campaignName)
    expect(answer.data.instructions).toContain('«Confirmar»')
    // The model is told never to confirm through a browser itself
    expect(answer.data.instructions).toContain('Never open that link, type into it or press its buttons yourself')
    expect(new Date(answer.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000)

    expect(await member(fx.marta)).not.toBeNull()
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before)
    const row = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(row).toMatchObject({
      kind: 'approval', confirmation: 'destructive', grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_remove_creator',
      status: 'pending', decidedAt: null, decidedById: null, executedAt: null, tokenHash: null,
      argsJson: JSON.stringify({ campaignId: fx.campaign, influencerId: fx.marta }),
    })
    const log = await lastLog(fx.grantAda)
    expect(log).toMatchObject({ tool: 'test_remove_creator', ok: true })
    expect(log.argsSummary).toBe(`[destructive:approval http=200] campaignId=${fx.campaign} influencerId=${fx.marta} actionId=${actionId}`)
  })

  it('never runs while it is pending', async () => {
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.marta, actionId })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Todavía nadie la ha confirmado')
    expect(answer.text).toContain(`${SITE}/mcp/confirmar/${actionId}`)
    expect(await member(fx.marta)).not.toBeNull()
    expect(await statusOf(actionId)).toBe('pending')
    expect((await lastLog(fx.grantAda)).argsSummary).toMatch(/^\[destructive:refused\] /)
  })

  it('an EMPLOYEE cannot approve it: not on the page, not through the form, not in the core', async () => {
    const empToken = signIn(fx.emp, 'EMPLOYEE')
    const page = await openPage(actionId)
    expect(page.html).toContain('Solo un administrador puede confirmar acciones de Claude.')
    expect(page.html).not.toContain('Vas a quitar')
    expect(page.html).not.toContain('<form')
    const res = await post(actionId, { [ACTION_TOKEN_FIELD]: signDecisionToken(actionId, fx.emp.id), decision: 'confirm' }, { cookie: empToken })
    expect(res.status).toBe(403)
    expect(await decidePendingAction({ id: actionId, deciderId: fx.emp.id, decision: 'approve' })).toEqual({ ok: false, reason: 'not_admin' })
    expect(await statusOf(actionId)).toBe('pending')
  })

  it('another administrator cannot approve or cancel it: it belongs to whoever authorised the grant', async () => {
    const beaToken = signIn(fx.bea, 'ADMIN')
    const page = await openPage(actionId)
    const text = decode(page.html ?? '')
    expect(text).toContain('Esta acción no es tuya')
    expect(text).toContain('Solo Ada Admin puede confirmarla o cancelarla.')
    expect(text).not.toContain('Vas a quitar')
    expect(text).not.toContain('<form')
    for (const decision of ['confirm', 'cancel']) {
      const res = await post(actionId, { [ACTION_TOKEN_FIELD]: signDecisionToken(actionId, fx.bea.id), decision, [ACTION_PASSWORD_FIELD]: PASSWORD }, { cookie: beaToken })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`/mcp/confirmar/${actionId}`)
    }
    expect(await decidePendingAction({ id: actionId, deciderId: fx.bea.id, decision: 'approve' })).toEqual({ ok: false, reason: 'foreign' })
    expect(await statusOf(actionId)).toBe('pending')
  })

  it('its administrator sees the preview, who asks, until when, and the two buttons', async () => {
    signIn(fx.ada, 'ADMIN')
    const page = await openPage(actionId)
    const html = page.html ?? ''
    const text = decode(html)
    expect(text).toContain('Claude te pide confirmar una acción')
    expect(text).toContain(`Vas a quitar a la creadora ${fx.marta} de «${fx.campaignName}»`)
    expect(text).toContain('Claude') // the client's own name
    expect(text).toContain('Conectado a la plataforma por Ada Admin.')
    expect(text).toMatch(/A las \d{2}:\d{2}, dentro de 1[45] min\./)
    expect(text).toContain('test_remove_creator')
    expect(html).toContain(`action="/api/mcp/actions/${actionId}"`)
    const buttons = [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/g)]
    expect(buttons.map(b => b[2])).toEqual(['Cancelar', 'Confirmar'])
    // «Confirmar» asks for the password, in a field the browser does not fill in by itself
    const password = (html.match(/<input\b[^>]*>/g) ?? []).find(i => i.includes(`name="${ACTION_PASSWORD_FIELD}"`)) ?? ''
    expect(password).toContain('type="password"')
    expect(password).toMatch(/autocomplete="new-password"/i)
    expect(text).toContain('Tu contraseña de la plataforma')
    expect(buttons[1][1]).toContain('form="mcp-action-confirm"')
    expect(html).toContain('<form id="mcp-action-confirm"')
    expect(buttons[0][1]).toContain('name="decision"')
    expect(buttons[0][1]).toContain('value="cancel"')
    expect(buttons[1][1]).toContain('name="decision"')
    expect(buttons[1][1]).toContain('value="confirm"')
    expect(html).not.toContain('<script')
    expect(tokenOf(html)).not.toBe('')
  })

  it('the form refuses what does not come from that page, for that administrator and that action', async () => {
    const adaToken = signIn(fx.ada, 'ADMIN')
    const good = tokenOf((await openPage(actionId)).html ?? '')
    const consent = signConsentToken({ userId: fx.ada.id, clientId: 'c'.repeat(43), redirectUri: CLAUDE_AI, codeChallenge: actionId, state: null, resource: MCP_RESOURCE, scope: MCP_GRANT_SCOPE })
    const other = await createPendingAction({ grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_remove_creator', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.luis }, preview: 'otra' })
    const cases: [Promise<Response>, number][] = [
      [post(actionId, { [ACTION_TOKEN_FIELD]: good, decision: 'confirm' }, { cookie: null }), 401],
      [post(actionId, { decision: 'confirm' }, { cookie: adaToken }), 400],
      [post(actionId, { [ACTION_TOKEN_FIELD]: 'garbage', decision: 'confirm' }, { cookie: adaToken }), 400],
      [post(actionId, { [ACTION_TOKEN_FIELD]: signDecisionToken(other.id, fx.ada.id), decision: 'confirm' }, { cookie: adaToken }), 403],
      [post(actionId, { [ACTION_TOKEN_FIELD]: signDecisionToken(actionId, fx.bea.id), decision: 'confirm' }, { cookie: adaToken }), 403],
      [post(actionId, { [ACTION_TOKEN_FIELD]: consent, decision: 'confirm' }, { cookie: adaToken }), 403],
      [post(actionId, { [ACTION_TOKEN_FIELD]: signDecisionToken(actionId, fx.ada.id, Date.now() - 11 * 60_000), decision: 'confirm' }, { cookie: adaToken }), 400],
      [post(actionId, { [ACTION_TOKEN_FIELD]: good, decision: 'confirm' }, { cookie: adaToken, site: 'cross-site' }), 403],
      [post(actionId, { [ACTION_TOKEN_FIELD]: good, decision: 'confirm' }, { cookie: adaToken, query: '?decision=confirm' }), 400],
      [post(actionId, { [ACTION_TOKEN_FIELD]: good, decision: 'yes' }, { cookie: adaToken }), 400],
      [post(actionId, { [ACTION_TOKEN_FIELD]: good }, { cookie: adaToken }), 400],
      [post('not.an.id', { [ACTION_TOKEN_FIELD]: good, decision: 'confirm' }, { cookie: adaToken }), 404],
    ]
    for (const [pending, status] of cases) {
      const res = await pending
      expect(res.status).toBe(status)
      expect(res.headers.get('location')).toBe(null)
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
    expect(await statusOf(actionId)).toBe('pending')
    // A decision token is not an OAuth consent: posted to /api/oauth/authorize it creates nothing
    const grantsBefore = await prisma.mcpGrant.count()
    for (const decision of ['allow', 'deny']) {
      const res = await oauthDecide(new NextRequest(`${SITE}/api/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `token=${adaToken}`, 'sec-fetch-site': 'same-origin' },
        body: new URLSearchParams({ consent_token: good, decision }).toString(),
      }))
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBe(null)
    }
    expect(await prisma.mcpGrant.count()).toBe(grantsBefore)
  })

  it('«Confirmar» without the password, or with a wrong one, confirms nothing (a browser driven by Claude cannot confirm)', async () => {
    const adaToken = signIn(fx.ada, 'ADMIN')
    const token = tokenOf((await openPage(actionId)).html ?? '')
    const attempts: Record<string, string>[] = [{}, { [ACTION_PASSWORD_FIELD]: '' }, { [ACTION_PASSWORD_FIELD]: 'no-es-la-contraseña' }, { [ACTION_PASSWORD_FIELD]: PASSWORD.toLowerCase() }]
    for (const extra of attempts) {
      const res = await post(actionId, { [ACTION_TOKEN_FIELD]: token, decision: 'confirm', ...extra }, { cookie: adaToken })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe(`/mcp/confirmar/${actionId}?error=password`)
      expect(await statusOf(actionId)).toBe('pending')
    }
    // The page says why, and never prints what was typed
    const refused = await ConfirmActionPage({ params: Promise.resolve({ id: actionId }), searchParams: Promise.resolve({ error: 'password' }) })
    const html = decode(renderToStaticMarkup(refused))
    expect(html).toContain('La contraseña no era correcta o faltaba. No se ha confirmado nada.')
    expect(html).not.toContain('no-es-la-contraseña')
    expect(html).toContain('<form id="mcp-action-confirm"')
    // Any other value of the parameter shows nothing more
    const other = decode(renderToStaticMarkup(await ConfirmActionPage({ params: Promise.resolve({ id: actionId }), searchParams: Promise.resolve({ error: '<b>x</b>' }) })))
    expect(other).not.toContain('No se ha confirmado nada')
    expect(other).not.toContain('<b>x</b>')
  })

  it('five wrong passwords in a row pause «Confirmar» for that administrator', async () => {
    const carlaToken = signIn(fx.carla, 'ADMIN')
    const pending = await createPendingAction({ grantId: fx.grantCarla, userId: fx.carla.id, tool: 'test_remove_creator', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.luis }, preview: 'Quitar a Luis' })
    const form = (password: string) => ({ [ACTION_TOKEN_FIELD]: signDecisionToken(pending.id, fx.carla.id), decision: 'confirm', [ACTION_PASSWORD_FIELD]: password })
    for (let i = 0; i < 5; i++) expect((await post(pending.id, form(`mala-${i}`), { cookie: carlaToken })).status).toBe(303)
    // Now even the right one waits
    const paused = await post(pending.id, form(PASSWORD), { cookie: carlaToken })
    expect(paused.status).toBe(429)
    expect(await paused.text()).not.toContain(PASSWORD)
    expect(await statusOf(pending.id)).toBe('pending')
    // «Cancelar» needs no password and is never paused
    expect((await post(pending.id, { [ACTION_TOKEN_FIELD]: signDecisionToken(pending.id, fx.carla.id), decision: 'cancel' }, { cookie: carlaToken })).status).toBe(303)
    expect(await statusOf(pending.id)).toBe('denied')
  })

  it('«Confirmar» by its administrator, with the password, approves it, and approving runs nothing', async () => {
    const adaToken = signIn(fx.ada, 'ADMIN')
    const token = tokenOf((await openPage(actionId)).html ?? '')
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const res = await post(actionId, { [ACTION_TOKEN_FIELD]: token, decision: 'confirm', [ACTION_PASSWORD_FIELD]: PASSWORD }, { cookie: adaToken })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`/mcp/confirmar/${actionId}`)
    const row = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(row).toMatchObject({ status: 'approved', decidedById: fx.ada.id, executedAt: null })
    expect(await member(fx.marta)).not.toBeNull()
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before)
    const text = decode((await openPage(actionId)).html ?? '')
    expect(text).toContain('Acción confirmada')
    expect(text).not.toContain('<form')
    // Deciding again changes nothing
    expect(await decidePendingAction({ id: actionId, deciderId: fx.ada.id, decision: 'deny' })).toEqual({ ok: false, reason: 'already_decided', status: 'approved' })
  })

  it('no other grant and no other tool can run it', async () => {
    const fromBea = await call(removeCreator, fx.grantBea, fx.bea.id, { campaignId: fx.campaign, influencerId: fx.marta, actionId })
    expect(fromBea.isError).toBe(true)
    expect(fromBea.text).toContain('No hay ninguna acción con ese identificador para esta conexión')
    const otherTool = await asAda(inviteCreator, { email: 'x@correo-inventado.test', campaignId: fx.campaign, actionId })
    expect(otherTool.isError).toBe(true)
    expect(otherTool.text).toContain('pertenece a otra herramienta (test_remove_creator)')
    expect(await statusOf(actionId)).toBe('approved')
    expect(await member(fx.marta)).not.toBeNull()
  })

  it('the next call runs it ONCE, with the STORED arguments, whatever it sends', async () => {
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    // The model sends another creator: the stored one is removed, Luis is not touched
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.luis, actionId })
    expect(answer.isError).toBe(false)
    expect(answer.data).toEqual({
      removed: true, campaignId: fx.campaign, influencerId: fx.marta,
      confirmedAction: { actionId, ranWithStoredArguments: true },
    })
    expect(await member(fx.marta)).toBeNull()
    expect(await member(fx.luis)).not.toBeNull()
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before + 1)
    const row = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(row).toMatchObject({ status: 'executed', resultStatus: 200 })
    expect(row.executedAt).toBeInstanceOf(Date)
    // Two platform calls: the plan of the STORED arguments again (the state must still be the approved one), then the run
    expect((await lastLog(fx.grantAda)).argsSummary).toBe(`[destructive:execute http=200,200] campaignId=${fx.campaign} influencerId=${fx.marta} actionId=${actionId}`)

    const again = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.marta, actionId })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('ya se ejecutó')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before + 1)

    signIn(fx.ada, 'ADMIN')
    expect(decode((await openPage(actionId)).html ?? '')).toContain('Acción ya ejecutada')
  })

  it('two simultaneous calls with the same approved action: exactly one runs', async () => {
    await ensureMember(fx.nora)
    const pending = await createPendingAction({ grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_remove_creator', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.nora }, preview: 'Quitar a Nora' })
    expect(await decidePendingAction({ id: pending.id, deciderId: fx.ada.id, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const answers = await Promise.all([1, 2, 3].map(() => asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.nora, actionId: pending.id })))
    expect(answers.filter(a => !a.isError)).toHaveLength(1)
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before + 1)
    expect(await member(fx.nora)).toBeNull()
  })
})

describe('a cancelled, expired or orphaned action never runs', () => {
  it('«Cancelar» denies it for good', async () => {
    const adaToken = signIn(fx.ada, 'ADMIN')
    const first = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.luis })
    const id = first.data.actionId
    const token = tokenOf((await openPage(id)).html ?? '')
    const res = await post(id, { [ACTION_TOKEN_FIELD]: token, decision: 'cancel' }, { cookie: adaToken })
    expect(res.status).toBe(303)
    expect(await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'denied', decidedById: fx.ada.id })
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.luis, actionId: id })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('se canceló')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before)
    expect(await member(fx.luis)).not.toBeNull()
    expect(decode((await openPage(id)).html ?? '')).toContain('Acción cancelada')
    // Cancelled stays cancelled
    expect(await decidePendingAction({ id, deciderId: fx.ada.id, decision: 'approve' })).toEqual({ ok: false, reason: 'already_decided', status: 'denied' })
  })

  it('15 minutes after it was asked for it can no longer be approved', async () => {
    const adaToken = signIn(fx.ada, 'ADMIN')
    const old = await createPendingAction(
      { grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_remove_creator', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.luis }, preview: 'Quitar a Luis' },
      new Date(Date.now() - 16 * 60_000),
    )
    // The page signs nothing for it
    const page = decode((await openPage(old.id)).html ?? '')
    expect(page).toContain('Acción caducada')
    expect(page).not.toContain('<form')
    const res = await post(old.id, { [ACTION_TOKEN_FIELD]: signDecisionToken(old.id, fx.ada.id), decision: 'confirm', [ACTION_PASSWORD_FIELD]: PASSWORD }, { cookie: adaToken })
    expect(res.status).toBe(303)
    expect(await statusOf(old.id)).toBe('expired')
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.luis, actionId: old.id })
    expect(answer.text).toContain('ha caducado')
    expect(await member(fx.luis)).not.toBeNull()
  })

  it('approved but not run within the 15 minutes: it expires instead of running', async () => {
    const pending = await createPendingAction({ grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_remove_creator', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.luis }, preview: 'Quitar a Luis' })
    expect((await decidePendingAction({ id: pending.id, deciderId: fx.ada.id, decision: 'approve' })).ok).toBe(true)
    await prisma.mcpPendingAction.update({ where: { id: pending.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const before = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const answer = await asAda(removeCreator, { campaignId: fx.campaign, influencerId: fx.luis, actionId: pending.id })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('ha caducado')
    expect(await statusOf(pending.id)).toBe('expired')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(before)
    expect(await member(fx.luis)).not.toBeNull()
  })

  it('when the connection that asked for it is revoked, it cannot be approved nor run', async () => {
    const grant = await grantFor(fx.ada.id)
    const first = await call(removeCreator, grant, fx.ada.id, { campaignId: fx.campaign, influencerId: fx.luis })
    const id = first.data.actionId
    await prisma.mcpGrant.update({ where: { id: grant }, data: { revokedAt: new Date(), revokedReason: 'test' } })
    const adaToken = signIn(fx.ada, 'ADMIN')
    expect(decode((await openPage(id)).html ?? '')).toContain('Conexión cerrada')
    const res = await post(id, { [ACTION_TOKEN_FIELD]: signDecisionToken(id, fx.ada.id), decision: 'confirm', [ACTION_PASSWORD_FIELD]: PASSWORD }, { cookie: adaToken })
    expect(res.status).toBe(303)
    expect(await statusOf(id)).toBe('pending')
    const answer = await call(removeCreator, grant, fx.ada.id, { campaignId: fx.campaign, influencerId: fx.luis, actionId: id })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('ya no está activa')
    expect(await member(fx.luis)).not.toBeNull()
    await prisma.mcpPendingAction.deleteMany({ where: { grantId: grant } })
    await prisma.mcpCallLog.deleteMany({ where: { grantId: grant } })
  })
})

// ============ Outbound: an e-mail to a person ============

describe('an outbound action: the e-mail leaves once, after the approval, to the stored address', () => {
  it('sends nothing until approved, then exactly one e-mail', async () => {
    h.mail.length = 0
    const email = `nueva.creadora+${tag}@correo-inventado.test`
    const first = await asAda(inviteCreator, { email, campaignId: fx.campaign })
    expect(first.data).toMatchObject({ needsApproval: true })
    // The model sees the address masked; the administrator sees it in the platform
    expect(first.text).not.toContain(email)
    expect(first.data.preview).toContain('[correo oculto]')
    const id = first.data.actionId
    expect((await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id } })).preview).toContain(email)
    signIn(fx.ada, 'ADMIN')
    expect(decode((await openPage(id)).html ?? '')).toContain(`Vas a ENVIAR UN CORREO a ${email}`)
    expect(decode((await openPage(id)).html ?? '')).toContain('Envía un mensaje a una persona o cambia algo que ve gente de fuera de la agencia.')

    const early = await asAda(inviteCreator, { email, campaignId: fx.campaign, actionId: id })
    expect(early.isError).toBe(true)
    expect(h.mail).toHaveLength(0)

    expect((await decidePendingAction({ id, deciderId: fx.ada.id, decision: 'approve' })).ok).toBe(true)
    // Another address in the second call is ignored
    const run = await asAda(inviteCreator, { email: 'otra@correo-inventado.test', campaignId: fx.campaign, actionId: id })
    expect(run.isError).toBe(false)
    expect(h.mail).toEqual([{ to: email, inviterName: 'Ada Admin', campaignName: fx.campaignName }])
    // The answer of the route carries the e-mail: removed by default
    expect(run.text).not.toContain('correo-inventado')
    expect(run.data.invitation.hasEmail).toBe(true)
    expect((await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id } })).confirmation).toBe('outbound')

    const twice = await asAda(inviteCreator, { email, campaignId: fx.campaign, actionId: id })
    expect(twice.isError).toBe(true)
    expect(h.mail).toHaveLength(1)
  })

  it('at most 5 e-mails a day per connection: the sixth is refused before it is even offered', async () => {
    const grant = await grantFor(fx.ada.id)
    const ranAt = new Date()
    await prisma.mcpPendingAction.createMany({
      data: Array.from({ length: WRITE_RATE_LIMITS.outboundPerDay }, (_, i) => ({
        kind: 'approval', confirmation: 'outbound', grantId: grant, userId: fx.ada.id, tool: 'test_invite_creator', argsJson: '{}', preview: `p${i}`,
        status: 'executed', expiresAt: ranAt, executedAt: ranAt, decidedAt: ranAt, decidedById: fx.ada.id,
      })),
    })
    const answer = await call(inviteCreator, grant, fx.ada.id, { email: 'sexta@correo-inventado.test', campaignId: fx.campaign })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('como mucho 5 envíos a personas al día')
    expect(await prisma.mcpPendingAction.count({ where: { grantId: grant, status: 'pending' } })).toBe(0)
    await prisma.mcpPendingAction.deleteMany({ where: { grantId: grant } })
    await prisma.mcpCallLog.deleteMany({ where: { grantId: grant } })
  })
})

// ============ Money: the two-step token ============

describe('a paid action: preview and token first, the second call runs it once', () => {
  const args = () => ({ campaignId: fx.campaign, influencerId: fx.luis, deliverables: 3 })
  const deliverables = async () => (await member(fx.luis))?.deliverablesPlanned ?? null
  const patches = () => callsTo('PATCH', '/api/campaigns/[id]/influencers')

  it('the first call checks Apify, changes nothing and returns the preview and a token', async () => {
    const before = patches()
    const answer = await asAda(paidCore, args())
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ needsConfirmation: true, validForMinutes: 5 })
    expect(answer.data.preview).toContain('uso actual del plan: 42 %')
    expect(answer.data.confirmToken).toMatch(/^c1\./)
    expect(answer.data.instructions).toContain('wait for an explicit yes')
    expect(patches()).toBe(before)
    expect(await deliverables()).toBe(null)
    expect((await lastLog(fx.grantAda)).argsSummary).toMatch(/^\[money:preview http=200,200\] /)
  })

  it('a wrong, altered, foreign, stale or expired token runs nothing: a new preview comes back', async () => {
    const before = patches()
    const { confirmToken } = (await asAda(paidCore, args())).data
    const [v, payload, sig] = String(confirmToken).split('.')
    const tries: [WriteTool, string, string, Record<string, unknown>][] = [
      [paidCore, fx.grantAda, fx.ada.id, { ...args(), confirmToken: 'c1.garbage.garbage' }],
      [paidCore, fx.grantAda, fx.ada.id, { ...args(), confirmToken: `${v}.${payload}.${sig.slice(0, -4)}AAAA` }],
      // the same token with other arguments
      [paidCore, fx.grantAda, fx.ada.id, { ...args(), deliverables: 4, confirmToken }],
      // the same token through another tool
      [paidOptional, fx.grantAda, fx.ada.id, { ...args(), confirmToken }],
      // the same token from another administrator's connection
      [paidCore, fx.grantBea, fx.bea.id, { ...args(), confirmToken }],
      // a token that expired
      [paidCore, fx.grantAda, fx.ada.id, { ...args(), confirmToken: signConfirmToken({ tool: 'test_paid_core', args: args(), grantId: fx.grantAda, fingerprint: JSON.stringify({ members: 1 }) }, Date.now() - CONFIRM_TOKEN_TTL_MS - 1000).token }],
    ]
    for (const [tool, grant, user, a] of tries) {
      const answer = await call(tool, grant, user, a)
      expect(answer.isError).toBe(false)
      expect(answer.data.needsConfirmation).toBe(true)
      expect(answer.data.notice).toContain('No se ha hecho nada')
      expect(answer.data.confirmToken).not.toBe(confirmToken)
    }
    expect(patches()).toBe(before)
    expect(await deliverables()).toBe(null)
    expect(await prisma.mcpPendingAction.count({ where: { kind: 'token' } })).toBe(0)
  })

  it('a change of the state the preview described makes the token stale', async () => {
    const { confirmToken } = (await asAda(paidCore, args())).data
    await ensureMember(fx.nora) // one member more than in the preview
    const answer = await asAda(paidCore, { ...args(), confirmToken })
    expect(answer.data.needsConfirmation).toBe(true)
    expect(answer.data.notice).toBeTruthy()
    expect(await deliverables()).toBe(null)
    await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign, influencerId: fx.nora } })
  })

  it('the right token, with the same arguments, runs it once; the token never works again', async () => {
    const { confirmToken } = (await asAda(paidCore, args())).data
    const before = patches()
    // Same arguments in another key order
    const run = await asAda(paidCore, { deliverables: 3, influencerId: fx.luis, campaignId: fx.campaign, confirmToken })
    expect(run.isError).toBe(false)
    expect(run.data).toEqual({ done: true })
    expect(patches()).toBe(before + 1)
    expect(await deliverables()).toBe(3)
    const record = await prisma.mcpPendingAction.findFirstOrThrow({ where: { kind: 'token', grantId: fx.grantAda } })
    expect(record).toMatchObject({ confirmation: 'money', status: 'executed', tool: 'test_paid_core', userId: fx.ada.id })
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(record.argsJson).toBe(JSON.stringify({ campaignId: fx.campaign, deliverables: 3, influencerId: fx.luis }))
    expect((await lastLog(fx.grantAda)).argsSummary).toMatch(/^\[money:execute http=200,200,200\] /)

    const reused = await asAda(paidCore, { ...args(), confirmToken })
    expect(reused.isError).toBe(true)
    expect(reused.text).toContain('ya se usó')
    expect(patches()).toBe(before + 1)
    await prisma.campaignInfluencer.update({ where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.luis } }, data: { deliverablesPlanned: null } })
  })

  it('no token is offered, and none is spent, while Apify is unavailable or its budget gate is closed', async () => {
    const since = new Date()
    const { confirmToken } = (await asAda(paidCore, args())).data
    const before = patches()
    const blocked: [Partial<typeof h.apify>, WriteTool, string][] = [
      [{ exhausted: true }, paidCore, 'Apify no está disponible'],
      [{ coreBlocked: true, optionalBlocked: true, usedPct: 96 }, paidCore, 'presupuesto de captura de Apify está bloqueado (96 % del plan usado)'],
      [{ optionalBlocked: true, usedPct: 88 }, paidOptional, 'gasto opcional de Apify está en pausa (88 % del plan usado)'],
    ]
    for (const [state, tool, message] of blocked) {
      Object.assign(h.apify, { exhausted: false, usedPct: 42, optionalBlocked: false, coreBlocked: false }, state)
      const first = await asAda(tool, args())
      expect(first.isError).toBe(true)
      expect(first.text).toContain(message)
      expect(first.text).not.toContain('confirmToken')
      // Even with a valid token in hand
      const second = await asAda(tool, { ...args(), confirmToken })
      expect(second.isError).toBe(true)
    }
    expect(patches()).toBe(before)
    expect(await prisma.mcpPendingAction.count({ where: { kind: 'token', grantId: fx.grantAda, createdAt: { gte: since } } })).toBe(0)
    // Core spend goes on above the optional gate
    Object.assign(h.apify, { optionalBlocked: true, usedPct: 88 })
    expect((await asAda(paidCore, args())).data.needsConfirmation).toBe(true)
  })

  it('at most 30 paid actions a day per connection', async () => {
    const grant = await grantFor(fx.ada.id)
    const ranAt = new Date()
    await prisma.mcpPendingAction.createMany({
      data: Array.from({ length: WRITE_RATE_LIMITS.moneyPerDay }, (_, i) => ({
        kind: 'token', confirmation: 'money', grantId: grant, userId: fx.ada.id, tool: 'test_paid_core', argsJson: '{}', preview: 'p',
        status: 'executed', expiresAt: ranAt, executedAt: ranAt, tokenHash: `${tag}-${String(i).padStart(4, '0')}`.padEnd(64, 'f'),
      })),
    })
    const answer = await call(paidCore, grant, fx.ada.id, args())
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('como mucho 30 acciones de pago al día')
    await prisma.mcpPendingAction.deleteMany({ where: { grantId: grant } })
    await prisma.mcpCallLog.deleteMany({ where: { grantId: grant } })
  })
})

// ============ No confirmation, the output filter and who may write ============

describe('a direct write, its answer, and who may write at all', () => {
  it('runs at once, and the answer carries no fee, no contact data and no secret unless asked', async () => {
    await ensureMember(fx.marta)
    await prisma.campaignInfluencer.update({
      where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.marta } },
      data: { shippingName: 'DESTINATARIA-NO-DEBE-SALIR', shippingAddress1: 'Calle Inventada 123', shippingEmail: 'envios@correo-inventado.test' },
    })
    const answer = await asAda(updateFees, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 4321.98 }] })
    expect(answer.isError).toBe(false)
    expect((await member(fx.marta))?.agreedFee).toBe(4321.98)
    expect(answer.data.updated).toBe(1)
    const item = answer.data.items[0].item
    for (const leaked of ['4321.98', '7777.77', 'correo-inventado', '+34600111222', 'DESTINATARIA', 'Calle Inventada']) expect(answer.text, leaked).not.toContain(leaked)
    expect(item.hasAddress).toBe(true)
    expect(item.influencer.hasEmail).toBe(true)
    expect(item.influencer.hasPhone).toBe(true)
    expect(answer.data._notes.join(' ')).toContain('includeEconomics')
    expect((await lastLog(fx.grantAda)).argsSummary).toBe(`[none:execute http=200] campaignId=${fx.campaign} creators=1`)

    const withAll = await asAda(updateFees, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 4322.5 }], includeEconomics: true, includeContact: true })
    expect(withAll.data.items[0].item.agreedFee).toBe(4322.5)
    expect(withAll.data.items[0].item.shippingName).toBe('DESTINATARIA-NO-DEBE-SALIR')
    expect(withAll.data.items[0].item.influencer.email).toBe('marta@correo-inventado.test')
    expect(withAll.text).toContain('Internal agency figures')
  })

  it('a bulk change asks for confirmation first', async () => {
    const fees = Array.from({ length: 6 }, (_, i) => ({ influencerId: i % 2 ? fx.marta : fx.luis, agreedFee: 500 + i }))
    const answer = await asAda(updateFees, { campaignId: fx.campaign, fees })
    expect(answer.data).toMatchObject({ needsConfirmation: true, preview: 'Vas a cambiar el fee de 6 creadoras. ¿Confirmas?' })
    expect((await member(fx.marta))?.agreedFee).toBe(4322.5)
  })

  it('a connection authorised before the write layer stays read-only, and says how to fix it', async () => {
    const before = await member(fx.marta)
    const answer = await call(updateFees, fx.grantReadOnly, fx.ada.id, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 1 }] })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('solo lectura')
    expect(answer.text).toContain('vuelve a conectarlo')
    expect((await member(fx.marta))?.agreedFee).toBe(before?.agreedFee)
    const log = await lastLog(fx.grantReadOnly)
    expect(log).toMatchObject({ ok: false, tool: 'test_update_fees' })
    expect(log.argsSummary).toMatch(/^\[-:refused\] /)
  })

  it('an administrator demoted after authorising cannot write, and the connection is revoked', async () => {
    await prisma.user.update({ where: { id: fx.carla.id }, data: { role: 'EMPLOYEE' } })
    const answer = await call(updateFees, fx.grantCarla, fx.carla.id, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 2 }] })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Solo un administrador activo')
    expect((await member(fx.marta))?.agreedFee).toBe(4322.5)
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: fx.grantCarla } })).revokedAt).toBeInstanceOf(Date)
    // A demoted administrator cannot confirm a pending action either
    const pending = await createPendingAction({ grantId: fx.grantCarla, userId: fx.carla.id, tool: 'test_remove_creator', confirmation: 'destructive', args: {}, preview: 'x' })
    expect(await decidePendingAction({ id: pending.id, deciderId: fx.carla.id, decision: 'approve' })).toEqual({ ok: false, reason: 'not_admin' })
  })

  it('every call leaves exactly one log line, refused ones included', async () => {
    const count = () => prisma.mcpCallLog.count({ where: { grantId: fx.grantAda } })
    const before = await count()
    await asAda(updateFees, { campaignId: fx.campaign, fees: [] }) // invalid
    // Templates, not literals: Tailwind scans the tests too, and a literal log prefix without a class
    // (a dash, a colon and the step in brackets) would be an invalid CSS rule in the build
    const noClass = '-'
    expect((await lastLog(fx.grantAda)).argsSummary).toBe(`[${noClass}:invalid]`)
    await asAda(updateFees, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 9 }] }, { rateLimited: true })
    expect((await lastLog(fx.grantAda)).argsSummary).toBe(`[${noClass}:limited]`)
    await asAda(updateFees, { campaignId: fx.campaign, fees: [{ influencerId: 'not-a-member', agreedFee: 9 }] })
    const failed = await lastLog(fx.grantAda)
    expect(failed.ok).toBe(false)
    expect(failed.argsSummary).toMatch(/^\[none:failed http=404\] /)
    expect(await count()).toBe(before + 3)
    expect((await member(fx.marta))?.agreedFee).toBe(4322.5)
  })
})

// ============ Fixes of 12 Nov 2026: what a confirmation is bound to ============

describe('a confirmation is bound to its class and to the state it described', () => {
  /** The switches a test flips between the preview and the second call, as other tools of class none would. */
  const state = { paid: false, rule: 'dos piezas', refuse: '' }
  const patches = () => callsTo('PATCH', '/api/campaigns/[id]/influencers')
  const deliverables = async () => (await member(fx.luis))?.deliverablesPlanned ?? null

  // Free (bulk) or paid (money) depending on the state, like add_creators_to_campaign when the campaign gains targets
  const flipping = defineWriteTool({
    name: 'test_flip_class',
    title: 'Clase que cambia (prueba)',
    description: 'Sets the deliverables of a creator; free or paid depending on the campaign.',
    input: { campaignId: idInput('Campaign id'), influencerId: idInput('Creator id'), deliverables: z.number().int().min(0).max(50) },
    confirmations: ['bulk', 'money'],
    annotations: { destructiveHint: false },
    summarize: a => ({ campaignId: a.campaignId }),
    plan: async () =>
      state.paid
        ? { confirmation: 'money', spend: 'core', preview: 'Vas a gastar una lectura de Apify. ¿Confirmas?', fingerprint: 'mismo estado' }
        : { confirmation: 'bulk', preview: 'No se gasta Apify. ¿Confirmas?', fingerprint: 'mismo estado' },
    execute: async (a, ctx) => {
      await ctx.platformJson({ method: 'PATCH', path: `/api/campaigns/${a.campaignId}/influencers`, body: { influencerId: a.influencerId, deliverablesPlanned: a.deliverables } })
      return { done: true }
    },
  })

  // A destructive tool whose preview depends on rules other tools can change (like revalidate_campaign_media)
  const ruled = defineWriteTool({
    name: 'test_rule_bound',
    title: 'Acción ligada a reglas (prueba)',
    description: 'Removes one creator, as the rules of the campaign say.',
    input: { campaignId: idInput('Campaign id'), influencerId: idInput('Creator id') },
    confirmations: ['destructive'],
    annotations: { destructiveHint: true },
    summarize: a => ({ campaignId: a.campaignId, influencerId: a.influencerId }),
    plan: async () =>
      state.refuse
        ? { confirmation: 'destructive', refuse: state.refuse }
        : { confirmation: 'destructive', preview: `Con las reglas de ahora saldrían ${state.rule}. ¿Confirmas?`, fingerprint: state.rule },
    execute: async (a, ctx) => {
      await ctx.platformJson({ method: 'DELETE', path: `/api/campaigns/${a.campaignId}/influencers`, body: { influencerId: a.influencerId } })
      return { removed: true }
    },
  })

  // A call of a write tool that changes nothing (a platform_request GET)
  const reading = defineWriteTool({
    name: 'test_read_only_call',
    title: 'Lectura (prueba)',
    description: 'Reads the members of a campaign through the platform.',
    input: { campaignId: idInput('Campaign id') },
    confirmations: ['none'],
    annotations: { destructiveHint: false },
    summarize: a => ({ campaignId: a.campaignId }),
    plan: async () => ({ confirmation: 'none', readOnly: true }),
    execute: async (a, ctx) => ctx.platformJson({ method: 'GET', path: `/api/campaigns/${a.campaignId}` }),
  })

  beforeEach(() => {
    Object.assign(state, { paid: false, rule: 'dos piezas', refuse: '' })
  })

  it('a token of a free bulk preview never runs the call once it became paid: a new preview comes back', async () => {
    await ensureMember(fx.luis)
    const args = { campaignId: fx.campaign, influencerId: fx.luis, deliverables: 7 }
    const free = await asAda(flipping, args)
    expect(free.data).toMatchObject({ needsConfirmation: true, preview: 'No se gasta Apify. ¿Confirmas?' })
    // Between the yes and the second call the campaign turns paid (the fingerprint is the same)
    state.paid = true
    const before = patches()
    const second = await asAda(flipping, { ...args, confirmToken: free.data.confirmToken })
    expect(second.isError).toBe(false)
    expect(second.data).toMatchObject({ needsConfirmation: true, preview: 'Vas a gastar una lectura de Apify. ¿Confirmas?' })
    expect(second.data.notice).toContain('No se ha hecho nada')
    expect(patches()).toBe(before)
    expect(await deliverables()).not.toBe(7)
    expect(await prisma.mcpPendingAction.count({ where: { kind: 'token', tool: 'test_flip_class' } })).toBe(0)
    // The paid preview's own token runs it, once
    const paid = await asAda(flipping, { ...args, confirmToken: second.data.confirmToken })
    expect(paid.data).toEqual({ done: true })
    expect(await deliverables()).toBe(7)
    // And a paid token never redeems the call once it is free again
    state.paid = true
    const paidAgain = await asAda(flipping, { ...args, deliverables: 8 })
    state.paid = false
    const back = await asAda(flipping, { ...args, deliverables: 8, confirmToken: paidAgain.data.confirmToken })
    expect(back.data).toMatchObject({ needsConfirmation: true, preview: 'No se gasta Apify. ¿Confirmas?' })
    expect(await deliverables()).toBe(7)
    await prisma.campaignInfluencer.update({ where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.luis } }, data: { deliverablesPlanned: null } })
  })

  it('an approved action never runs against a state other than the one approved; back to that state, it runs once', async () => {
    await ensureMember(fx.nora)
    const first = await asAda(ruled, { campaignId: fx.campaign, influencerId: fx.nora })
    expect(first.data).toMatchObject({ needsApproval: true, preview: 'Con las reglas de ahora saldrían dos piezas. ¿Confirmas?' })
    const id: string = first.data.actionId
    expect((await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id } })).stateHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await decidePendingAction({ id, deciderId: fx.ada.id, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })

    // After the approval another tool (of class none) changes the rules: now everything would go
    state.rule = 'todas las piezas'
    const deletes = callsTo('DELETE', '/api/campaigns/[id]/influencers')
    const stale = await asAda(ruled, { campaignId: fx.campaign, influencerId: fx.nora, actionId: id })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('ha cambiado lo que haría')
    expect(stale.text).toContain('Vuelve a llamar sin actionId')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(deletes)
    expect(await member(fx.nora)).not.toBeNull()
    expect(await statusOf(id)).toBe('approved')
    expect((await lastLog(fx.grantAda)).argsSummary).toMatch(/^\[destructive:refused( http=[0-9,]+)?\] /)

    // A plan that now refuses (the creator left, the campaign is gone...) runs nothing either
    state.rule = 'dos piezas'
    state.refuse = 'Ya no es integrante de la campaña. No se ha hecho nada.'
    const refused = await asAda(ruled, { campaignId: fx.campaign, influencerId: fx.nora, actionId: id })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Ya no es integrante')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(deletes)

    // The rules are what was approved again: it runs, once
    state.refuse = ''
    const run = await asAda(ruled, { campaignId: fx.campaign, influencerId: fx.nora, actionId: id })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ removed: true, confirmedAction: { actionId: id, ranWithStoredArguments: true } })
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers')).toBe(deletes + 1)
    expect(await member(fx.nora)).toBeNull()
  })

  it('an approval stored without its state (stateHash missing) never runs', async () => {
    await ensureMember(fx.nora)
    const pending = await createPendingAction({ grantId: fx.grantAda, userId: fx.ada.id, tool: 'test_rule_bound', confirmation: 'destructive', args: { campaignId: fx.campaign, influencerId: fx.nora }, preview: 'x', fingerprint: 'dos piezas' })
    await prisma.mcpPendingAction.update({ where: { id: pending.id }, data: { stateHash: null } })
    await decidePendingAction({ id: pending.id, deciderId: fx.ada.id, decision: 'approve' })
    const answer = await asAda(ruled, { campaignId: fx.campaign, influencerId: fx.nora, actionId: pending.id })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('ha cambiado lo que haría')
    expect(await member(fx.nora)).not.toBeNull()
  })

  it('a call that changed nothing is logged as a read, and its notes may say "call again"; a change never says so', async () => {
    const read = await asAda(reading, { campaignId: fx.campaign })
    expect(read.isError).toBe(false)
    const log = await lastLog(fx.grantAda)
    expect(log.argsSummary).toMatch(/^\[none:read http=200\] campaignId=/)
    expect(classifyCall(log.argsSummary, log.ok, log.createdAt).result).toBe('read')
    expect(read.data._notes.join(' ')).toContain('Call again with includeContact: true')

    await ensureMember(fx.marta)
    const write = await asAda(updateFees, { campaignId: fx.campaign, fees: [{ influencerId: fx.marta, agreedFee: 4322.5 }] })
    const notes = write.data._notes.join(' ')
    expect(notes).toContain('do NOT repeat this call')
    expect(notes).not.toMatch(/Call again/)
    expect(classifyCall((await lastLog(fx.grantAda)).argsSummary, true, new Date()).result).toBe('done')
  })

  it('the daily allowance of outbound actions is counted per tool', async () => {
    const grant = await grantFor(fx.ada.id)
    const ranAt = new Date()
    // Five changes of another outbound tool today (say, a widget through platform_request)
    await prisma.mcpPendingAction.createMany({
      data: Array.from({ length: WRITE_RATE_LIMITS.outboundPerDay }, (_, i) => ({
        kind: 'approval', confirmation: 'outbound', grantId: grant, userId: fx.ada.id, tool: 'platform_request', argsJson: '{}', preview: `p${i}`,
        status: 'executed', expiresAt: ranAt, executedAt: ranAt, decidedAt: ranAt, decidedById: fx.ada.id,
      })),
    })
    const invite = await call(inviteCreator, grant, fx.ada.id, { email: `otra+${tag}@correo-inventado.test`, campaignId: fx.campaign })
    expect(invite.isError).toBe(false)
    expect(invite.data.needsApproval).toBe(true)
    await prisma.mcpPendingAction.deleteMany({ where: { grantId: grant } })
    await prisma.mcpCallLog.deleteMany({ where: { grantId: grant } })
  })
})

// ============ The page without a session, the login and the edge ============

describe('getting to the confirmation page', () => {
  it('without a session: to the login, which comes back to this very page', async () => {
    h.cookie.value = undefined
    expect(await openPage('ckabc123')).toEqual({ html: null, redirect: `/login?next=${encodeURIComponent('/mcp/confirmar/ckabc123')}` })
    expect(safeNextPath('/mcp/confirmar/ckabc123')).toBe('/mcp/confirmar/ckabc123')
    expect(await openPage('../evil')).toEqual({ html: null, redirect: '/login' })
  })

  it('BRAND and CREATOR go to their own home; unknown or malformed ids show a notice', async () => {
    signIn(fx.brand, 'BRAND')
    expect((await openPage('ckabc123')).redirect).toBe('/portal')
    signIn(fx.creator, 'CREATOR')
    expect((await openPage('ckabc123')).redirect).toBe('/dashboard')
    signIn(fx.ada, 'ADMIN')
    for (const id of ['ckdoesnotexist', 'a.b', 'x'.repeat(65)]) expect(decode((await openPage(id)).html ?? '')).toContain('Acción no encontrada')
    // A token record is not an action anyone can confirm
    const tokenRow = await prisma.mcpPendingAction.findFirst({ where: { kind: 'token' } })
    if (tokenRow) expect(decode((await openPage(tokenRow.id)).html ?? '')).toContain('Acción no encontrada')
  })

  it('the login honours exactly /mcp/confirmar/<id> and nothing that looks like it', () => {
    for (const ok of ['/mcp/confirmar/a', '/mcp/confirmar/ck_A-9', `/mcp/confirmar/${'x'.repeat(64)}`]) expect(safeNextPath(ok), ok).toBe(ok)
    for (const bad of [
      '/mcp/confirmar/', '/mcp/confirmar', '/mcp/confirmar/a/b', '/mcp/confirmar/a?x=1', '/mcp/confirmar/a#x', '/mcp/confirmar/../dashboard',
      '/mcp/confirmar/a b', '/mcp/confirmar/a%2F', '/mcp/confirmar/a.b', `/mcp/confirmar/${'x'.repeat(65)}`, '/MCP/confirmar/a',
      '//evil.example/mcp/confirmar/a', 'https://evil.example/mcp/confirmar/a', '/mcp/confirmar/a\\', ' /mcp/confirmar/a', '/mcp/confirmar/a\n',
    ]) {
      expect(safeNextPath(bad), JSON.stringify(bad)).toBe(null)
    }
    // What was honoured before still is
    expect(safeNextPath('/oauth/authorize?response_type=code')).toBe('/oauth/authorize?response_type=code')
    expect(safeNextPath('/dashboard')).toBe(null)
  })

  it('the edge asks for a session like the consent screen does, and never lets the page be framed', () => {
    const visit = (path: string, headers: Record<string, string> = {}) => middleware(new NextRequest(`https://app.example${path}`, { headers }))
    const passes = (res: Response) => res.headers.get('x-middleware-next') === '1'
    const noCookie = visit('/mcp/confirmar/ckabc123')
    expect(noCookie.status).toBe(307)
    const location = new URL(noCookie.headers.get('location') as string)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe('/mcp/confirmar/ckabc123')
    expect(safeNextPath(location.searchParams.get('next'))).toBe('/mcp/confirmar/ckabc123')
    // A bearer token is not a browser session
    expect(visit('/mcp/confirmar/ckabc123', { authorization: `Bearer ${generateToken('u', 'ADMIN')}` }).status).toBe(307)
    for (const role of ['ADMIN', 'EMPLOYEE']) {
      const res = visit('/mcp/confirmar/ckabc123', { cookie: `token=${generateToken(`user-${role}`, role)}` })
      expect(passes(res), role).toBe(true)
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    }
    const home = (role: string) => new URL(visit('/mcp/confirmar/ckabc123', { cookie: `token=${generateToken(`user-${role}`, role)}` }).headers.get('location') as string).pathname
    expect(home('BRAND')).toBe('/portal')
    expect(home('CREATOR')).toBe('/dashboard')
    // The decision route is an API route: BRAND and CREATOR are stopped at the edge
    for (const role of ['BRAND', 'CREATOR']) {
      expect(visit('/api/mcp/actions/ckabc123', { cookie: `token=${generateToken(`user-${role}`, role)}` }).status).toBe(403)
    }
  })
})

// ============ The hand-applied SQL, against a real database ============

describe('prisma/additive/2026-11-12-mcp-write.sql', () => {
  it('creates exactly the table prisma expects, and its rollback removes it and nothing else', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
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
      WHERE table_schema = $1::text AND table_name = 'mcp_pending_actions'
      ORDER BY ordinal_position`
    const indexesOf = `
      SELECT tablename, indexname, replace(indexdef, $1::text || '.', '') AS indexdef
      FROM pg_indexes WHERE schemaname = $1::text AND tablename = 'mcp_pending_actions'
      ORDER BY indexname`
    class Rollback extends Error {}
    let compared = false
    await prisma
      .$transaction(async tx => {
        // A scratch schema; `public` holds what `prisma db push` built from schema.prisma
        await tx.$executeRawUnsafe('CREATE SCHEMA mcp_write_sql_check')
        await tx.$executeRawUnsafe('SET LOCAL search_path TO mcp_write_sql_check')
        for (const s of statements('2026-11-12-mcp-write.sql')) await tx.$executeRawUnsafe(s)
        const fromSql = await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'mcp_write_sql_check')
        const fromPrisma = await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'public')
        expect(fromSql).toHaveLength(17)
        expect(fromSql).toEqual(fromPrisma)
        const idxSql = await tx.$queryRawUnsafe<Record<string, unknown>[]>(indexesOf, 'mcp_write_sql_check')
        const idxPrisma = await tx.$queryRawUnsafe<Record<string, unknown>[]>(indexesOf, 'public')
        expect(idxSql).toHaveLength(4)
        expect(idxSql).toEqual(idxPrisma)
        for (const s of statements('2026-11-12-mcp-write.down.sql')) await tx.$executeRawUnsafe(s)
        expect(await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'mcp_write_sql_check')).toEqual([])
        expect((await tx.$queryRawUnsafe<Record<string, unknown>[]>(columnsOf, 'public')).length).toBe(17)
        compared = true
        throw new Rollback()
      }, { timeout: 30_000 })
      .catch(e => {
        if (!(e instanceof Rollback)) throw e
      })
    expect(compared).toBe(true)
  })
})
