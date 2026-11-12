import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, no public address (every
// URL is built from the production default), no Apify token.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-platform-request'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
  return {
    apify: { exhausted: false, usedPct: 42 as number | null, optionalBlocked: false, coreBlocked: false },
    lookalikes: [] as { handle?: string; creatorId?: string }[],
  }
})

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
// The lookalike engine reads Apify for an unknown handle: every run is kept here instead
vi.mock('@/lib/lookalikes', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/lookalikes')>()
  return {
    ...actual,
    findLookalikes: async (input: { handle?: string; creatorId?: string }) => {
      h.lookalikes.push({ handle: input.handle, creatorId: input.creatorId })
      return { source: null, lookalikes: [], detectedPlatform: 'INSTAGRAM', platformSource: 'selector', parsedHandle: input.handle ?? '' }
    },
  }
})

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { MCP_RESOURCE } from '@/lib/mcp/config'
import { decidePendingAction } from '@/lib/mcp/confirm'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { createGrantAndCode, registerClient } from '@/lib/mcp/oauth'
import { canProceed, getRemaining } from '@/lib/rate-limiter'
import { WRITE_RATE_LIMITS } from '@/lib/mcp/write-tool'
import { setPlatformTransport } from '@/lib/mcp/platform-client'
import { platformRequestTool } from '@/lib/mcp/tools/write/platform-request'
import { createPlatformRouter } from '../helpers/platform-router'

const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const SITE = 'https://intelligence.thekingofcontent.agency'
const tag = randomUUID().slice(0, 8)
const router = createPlatformRouter()

const fx = {
  ada: '',
  emp: '',
  grant: '',
  grantReadOnly: '',
  grantAllowance: '',
  campaign: '',
  campaignName: `Campaña Genérica ${tag}`,
  marta: '',
  template: '',
  templateName: `Plantilla Genérica ${tag}`,
}
const created = { users: [] as string[], influencers: [] as string[] }

async function keepAlive(grantId: string): Promise<void> {
  await prisma.mcpToken.create({ data: { grantId, kind: 'access', tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 3_600_000) } })
}

interface Answer {
  isError: boolean
  text: string
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(args: Record<string, unknown>, grantId = fx.grant, userId = fx.ada): Promise<Answer> {
  const res = await platformRequestTool.call(args, { grantId, userId })
  const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}

const callsTo = (method: string, pattern: string) => router.calls.filter(c => c.method === method && c.pattern === pattern).length
const logCount = (grantId = fx.grant) => prisma.mcpCallLog.count({ where: { grantId } })
// Two lines can share a millisecond: the cuid of the newer one sorts after (it carries a counter)
const lastLog = (grantId = fx.grant) => prisma.mcpCallLog.findFirstOrThrow({ where: { grantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })

beforeAll(async () => {
  // Nothing in this file may reach a network
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  setPlatformTransport(router.transport)

  const ada = await prisma.user.create({ data: { email: `ada-pr-${tag}@correo-inventado.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const emp = await prisma.user.create({ data: { email: `pepa-pr-${tag}@correo-inventado.test`, password: 'x', name: 'Pepa Empleada', role: 'EMPLOYEE' } })
  created.users.push(ada.id, emp.id)
  fx.ada = ada.id
  fx.emp = emp.id

  const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, `198.51.100.77-${tag}`)
  fx.grant = (await createGrantAndCode({ userId: ada.id, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) })).grantId
  await keepAlive(fx.grant)
  fx.grantReadOnly = (await prisma.mcpGrant.create({ data: { clientId: 'old-client', userId: ada.id, scope: 'tkoc.read', resource: MCP_RESOURCE } })).id
  await keepAlive(fx.grantReadOnly)

  const campaign = await prisma.campaign.create({
    data: { name: fx.campaignName, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: ada.id },
  })
  fx.campaign = campaign.id
  const marta = await prisma.influencer.create({
    data: { username: `marta_pr_${tag}`, platform: 'INSTAGRAM', followers: 1000, email: 'marta@correo-inventado.test', phone: '+34600111222', standardFee: 7777.77 },
  })
  created.influencers.push(marta.id)
  fx.marta = marta.id
  await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: marta.id, status: 'NEGOTIATING', agreedFee: 100, shippingName: 'DESTINATARIA-NO-DEBE-SALIR', shippingAddress1: 'Calle Inventada 123' },
  })
  const template = await prisma.campaignTemplate.create({ data: { name: fx.templateName, userId: ada.id, targetAccounts: [], targetHashtags: [] } })
  fx.template = template.id
  await prisma.notification.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({ userId: ada.id, type: 'note_added', title: `Aviso ${i}`, message: 'Mensaje inventado' })),
  })
})

beforeEach(() => {
  Object.assign(h.apify, { exhausted: false, usedPct: 42, optionalBlocked: false, coreBlocked: false })
  h.lookalikes.length = 0
})

afterAll(async () => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
  const grants = [fx.grant, fx.grantReadOnly, fx.grantAllowance].filter(Boolean)
  await prisma.mcpPendingAction.deleteMany({ where: { grantId: { in: grants } } })
  await prisma.mcpCallLog.deleteMany({ where: { grantId: { in: grants } } })
  await prisma.campaignTemplate.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.influencer.deleteMany({ where: { id: { in: created.influencers } } })
  await prisma.notification.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpToken.deleteMany({ where: { grantId: { in: grants } } })
  await prisma.mcpAuthCode.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpGrant.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
})

describe('platform_request against the real routes', () => {
  it('an allowed GET works, as the administrator, and leaves one log line with the route and the status', async () => {
    const before = await logCount()
    const answer = await call({ method: 'GET', path: `/api/campaigns/${fx.campaign}`, select: ['campaign.name', 'campaign.influencers.status'] })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ status: 200, route: 'GET /api/campaigns/[id]' })
    expect(answer.data.data.campaign.name).toBe(fx.campaignName)
    expect(answer.data.data.campaign.influencers).toEqual([{ status: 'NEGOTIATING' }])
    expect(await logCount()).toBe(before + 1)
    const log = await lastLog()
    expect(log).toMatchObject({ tool: 'platform_request', ok: true })
    // A GET changes nothing: logged as a read, so «Actividad de Claude» shows «Consulta», never «Hecho»
    expect(log.argsSummary).toMatch(new RegExp(`^\\[none:read http=200\\] method=GET route=/api/campaigns/\\[id\\] ids=${fx.campaign} body=none args=[0-9a-f]{12}$`))
  })

  it('contact data and money are absent by default and present only when asked', async () => {
    const plain = await call({ method: 'GET', path: `/api/influencers/${fx.marta}` })
    expect(plain.isError).toBe(false)
    const text = plain.text
    for (const absent of ['marta@correo-inventado.test', '+34600111222', '7777.77', 'standardFee']) expect(text, absent).not.toContain(absent)
    expect(plain.data.data.influencer).toMatchObject({ username: `marta_pr_${tag}`, hasEmail: true, hasPhone: true })
    expect(plain.data._notes.join(' ')).toContain('includeContact')

    const contact = await call({ method: 'GET', path: `/api/influencers/${fx.marta}`, includeContact: true })
    expect(contact.data.data.influencer).toMatchObject({ email: 'marta@correo-inventado.test', phone: '+34600111222' })
    expect(contact.text).not.toContain('7777.77')
    const money = await call({ method: 'GET', path: `/api/influencers/${fx.marta}`, includeEconomics: true })
    expect(money.data.data.influencer.standardFee).toBe(7777.77)
    expect(money.text).not.toContain('marta@correo-inventado.test')

    // The pipeline carries shipping data: never without includeContact
    const pipeline = await call({ method: 'GET', path: '/api/pipeline', query: { campaignId: fx.campaign } })
    expect(pipeline.isError).toBe(false)
    expect(pipeline.text).not.toContain('DESTINATARIA-NO-DEBE-SALIR')
    expect(pipeline.text).not.toContain('Calle Inventada')
  })

  it('a part out of reach for good is refused before anything is sent, with the reason, and logged', async () => {
    const routed = router.calls.length
    const before = await logCount()
    const answer = await call({ method: 'GET', path: '/api/team' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Usuarios, roles')
    const settings = await call({ method: 'GET', path: '/api/settings/integrations' })
    expect(settings.text).toContain('claves de Apify')
    const own = await call({ method: 'DELETE', path: `/api/oauth/grants/${fx.grant}` })
    expect(own.text).toContain('propias autorizaciones')
    expect(router.calls.length).toBe(routed)
    expect(await logCount()).toBe(before + 3)
    const log = await prisma.mcpCallLog.findFirstOrThrow({ where: { grantId: fx.grant, argsSummary: { contains: 'route=/api/team' } } })
    expect(log.ok).toBe(false)
    expect(log.argsSummary).toMatch(/^\[-:refused\] method=GET route=\/api\/team /)
  })

  it('a write with its own tool is refused with the name of the tool, and nothing changes', async () => {
    const routed = router.calls.length
    const answer = await call({ method: 'PATCH', path: `/api/campaigns/${fx.campaign}/influencers`, body: { influencerId: fx.marta, agreedFee: 999 } })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('update_creator_deal')
    expect(router.calls.length).toBe(routed)
    const row = await prisma.campaignInfluencer.findUniqueOrThrow({ where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.marta } } })
    expect(row.agreedFee).toBe(100)
  })

  it('credentials in the query, the paid username lookup and unknown routes are refused', async () => {
    const routed = router.calls.length
    expect((await call({ method: 'GET', path: '/api/campaigns', query: { token: 'abc' } })).text).toContain('credenciales')
    expect((await call({ method: 'POST', path: '/api/influencers/discover', body: { query: 'marta' } })).text).toContain('analyze_creator_profile')
    const unknown = await call({ method: 'GET', path: '/api/nope' })
    expect(unknown.text).toContain('Lo que puede llamar')
    expect(router.calls.length).toBe(routed)
  })

  it('a connection authorised before the write layer gets the reconnect message', async () => {
    const answer = await call({ method: 'GET', path: '/api/health' }, fx.grantReadOnly)
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('solo lectura')
  })

  it('the knowledge base comes in pages of 20,000 characters', async () => {
    const first = await call({ method: 'GET', path: '/api/knowledge-base' })
    expect(first.isError).toBe(false)
    const page = first.data.data
    expect(page.offset).toBe(0)
    expect(page.content.length).toBeLessThanOrEqual(20_000)
    expect(page.totalChars).toBeGreaterThan(0)
    if (page.totalChars > 20_000) {
      expect(page.nextOffset).toBe(20_000)
      const second = await call({ method: 'GET', path: '/api/knowledge-base', query: { offset: page.nextOffset } })
      expect(second.data.data.offset).toBe(20_000)
    } else {
      expect(page.nextOffset).toBeNull()
    }
  })

  it('reads spend their own allowance (60 per minute), never the writes\' (20 per minute, 300 per day)', async () => {
    // A connection of its own: its allowances are spent here on purpose
    const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, `198.51.100.78-${tag}`)
    fx.grantAllowance = (await createGrantAndCode({ userId: fx.ada, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) })).grantId
    await keepAlive(fx.grantAllowance)
    const g = fx.grantAllowance
    const { perMinute, perDay, readsPerMinute } = WRITE_RATE_LIMITS
    const read = () => call({ method: 'GET', path: `/api/campaigns/${fx.campaign}`, select: ['campaign.name'] }, g)

    expect((await read()).isError).toBe(false)
    expect(getRemaining(`mcp:write:min:${g}`, perMinute.max, perMinute.windowMs)).toBe(perMinute.max)
    expect(getRemaining(`mcp:write:day:${g}`, perDay.max, perDay.windowMs)).toBe(perDay.max)
    expect(getRemaining(`mcp:read:min:${g}`, readsPerMinute.max, readsPerMinute.windowMs)).toBe(readsPerMinute.max - 1)

    // The writes of this minute are spent: reads go on, a write is refused and changes nothing
    while (canProceed(`mcp:write:min:${g}`, perMinute.max, perMinute.windowMs)) { /* spend them */ }
    expect((await read()).isError).toBe(false)
    const templates = await prisma.campaignTemplate.count()
    const write = await call({ method: 'POST', path: '/api/templates', body: { name: `Plantilla límite ${tag}` } }, g)
    expect(write.isError).toBe(true)
    expect(write.text).toContain('Límite de cambios')
    expect(await prisma.campaignTemplate.count()).toBe(templates)

    // The reads of this minute are spent too: the next read is refused, with its own reason
    while (canProceed(`mcp:read:min:${g}`, readsPerMinute.max, readsPerMinute.windowMs)) { /* spend them */ }
    const refused = await read()
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Límite de lecturas')
    expect((await lastLog(g)).argsSummary).toMatch(/^\[none:refused\] method=GET /)
  })
})

describe('platform_request: a DELETE goes through the pending action', () => {
  let actionId = ''

  it('the first call deletes nothing: it returns the preview with the template name and the link', async () => {
    const before = callsTo('DELETE', '/api/templates/[id]')
    const answer = await call({ method: 'DELETE', path: `/api/templates/${fx.template}` })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ needsApproval: true, validForMinutes: 15 })
    actionId = answer.data.actionId
    expect(answer.data.approveUrl).toBe(`${SITE}/mcp/confirmar/${actionId}`)
    expect(answer.data.preview).toContain(`«${fx.templateName}»`)
    expect(answer.data.preview).toContain('creada por ti')
    expect(answer.data.preview).toContain('No se puede deshacer')
    expect(callsTo('DELETE', '/api/templates/[id]')).toBe(before)
    expect(await prisma.campaignTemplate.count({ where: { id: fx.template } })).toBe(1)
    const row = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: actionId } })
    expect(row).toMatchObject({ kind: 'approval', confirmation: 'destructive', tool: 'platform_request', status: 'pending' })
    expect((await lastLog()).argsSummary).toMatch(/^\[destructive:approval http=200\] method=DELETE route=\/api\/templates\/\[id\] /)
  })

  it('never runs while pending, and an EMPLOYEE cannot approve it', async () => {
    const answer = await call({ method: 'DELETE', path: `/api/templates/${fx.template}`, actionId })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Todavía nadie la ha confirmado')
    expect(await decidePendingAction({ id: actionId, deciderId: fx.emp, decision: 'approve' })).toEqual({ ok: false, reason: 'not_admin' })
    expect(await prisma.campaignTemplate.count({ where: { id: fx.template } })).toBe(1)
  })

  it('approved by its administrator, it runs once with the stored arguments and leaves a notification', async () => {
    expect(await decidePendingAction({ id: actionId, deciderId: fx.ada, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })
    const before = callsTo('DELETE', '/api/templates/[id]')
    // The second call names another template: the stored arguments run, not these
    const answer = await call({ method: 'DELETE', path: '/api/templates/someotherid', actionId })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ status: 200, route: 'DELETE /api/templates/[id]', confirmedAction: { actionId, ranWithStoredArguments: true } })
    expect(callsTo('DELETE', '/api/templates/[id]')).toBe(before + 1)
    expect(router.calls.filter(c => c.method === 'DELETE').at(-1)?.url).toBe(`/api/templates/${fx.template}`)
    expect(await prisma.campaignTemplate.count({ where: { id: fx.template } })).toBe(0)
    const note = await prisma.notification.findFirst({ where: { userId: fx.ada, type: 'mcp_action' } })
    expect(note?.message).toContain('DELETE /api/templates/[id]')

    const again = await call({ method: 'DELETE', path: `/api/templates/${fx.template}`, actionId })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('ya se ejecutó')
    expect(callsTo('DELETE', '/api/templates/[id]')).toBe(before + 1)
  })
})

describe('platform_request: a paid read needs the confirm token', () => {
  const args = { method: 'POST', path: '/api/creators/lookalikes', body: { handle: `rival_${tag}`, platform: 'INSTAGRAM' } }

  it('the first call reads nothing from Apify and returns an honest preview', async () => {
    const answer = await call(args)
    expect(answer.isError).toBe(false)
    expect(answer.data.needsConfirmation).toBe(true)
    expect(answer.data.preview).toContain(`@rival_${tag}`)
    expect(answer.data.preview).toContain('Esto consume Apify (uso actual del plan: 42 %)')
    expect(answer.data.preview).not.toMatch(/[$€]|USD|EUR/)
    expect(h.lookalikes).toEqual([])
  })

  it('a token for other arguments only gets a new preview; the right one runs once; reused, it is refused', async () => {
    const first = await call(args)
    const otherArgs = await call({ ...args, body: { handle: `otra_${tag}`, platform: 'INSTAGRAM' }, confirmToken: first.data.confirmToken })
    expect(otherArgs.data.needsConfirmation).toBe(true)
    expect(otherArgs.data.notice).toContain('caducado o no corresponde')
    expect(h.lookalikes).toEqual([])

    const ran = await call({ ...args, confirmToken: first.data.confirmToken })
    expect(ran.isError).toBe(false)
    expect(ran.data).toMatchObject({ status: 200, route: 'POST /api/creators/lookalikes' })
    expect(h.lookalikes).toEqual([{ handle: `rival_${tag}`, creatorId: undefined }])

    const reused = await call({ ...args, confirmToken: first.data.confirmToken })
    expect(reused.isError).toBe(true)
    expect(reused.text).toContain('ya se usó')
    expect(h.lookalikes).toHaveLength(1)
  })

  it('refused, with no token, when the optional budget of Apify is paused or Apify is unavailable', async () => {
    h.apify.optionalBlocked = true
    const paused = await call(args)
    expect(paused.isError).toBe(true)
    expect(paused.text).toContain('gasto opcional de Apify está en pausa')
    expect(paused.text).not.toContain('confirmToken')
    h.apify.optionalBlocked = false
    h.apify.exhausted = true
    const off = await call(args)
    expect(off.isError).toBe(true)
    expect(off.text).toContain('Apify no está disponible')
    expect(h.lookalikes).toEqual([])
  })

  it('with a creator id only it is free and runs at once', async () => {
    const answer = await call({ method: 'POST', path: '/api/creators/lookalikes', body: { creatorId: fx.marta } })
    expect(answer.isError).toBe(false)
    expect(answer.data.status).toBe(200)
    expect(h.lookalikes).toEqual([{ handle: undefined, creatorId: fx.marta }])
  })
})

describe('platform_request: the previews read the real routes', () => {
  const brandId = `brand_1731400000000_${tag}`
  const benchKey = `benchmark_fee_ranges_${brandId}`
  const made = { file: '', competitor: '', widget: '' }

  beforeAll(async () => {
    made.file = (await prisma.briefFile.create({ data: { campaignId: fx.campaign, fileName: `brief-${tag}.pdf`, fileType: 'application/pdf', fileSize: 1234, fileData: Buffer.from('PDF inventado') } })).id
    const competitor = await prisma.competitorAccount.create({ data: { username: `rival_pr_${tag}`, platform: 'INSTAGRAM' } })
    made.competitor = competitor.id
    await prisma.competitorPost.createMany({
      data: [1, 2].map(i => ({ externalId: `cp-${tag}-${i}`, platform: 'INSTAGRAM' as const, competitorId: competitor.id, hashtags: [], mentions: [] })),
    })
    const widget = await prisma.liveCaptureWidget.create({ data: { userId: fx.ada, name: `Widget ${tag}`, allowedDomains: ['tienda-inventada.example'] } })
    made.widget = widget.id
    await prisma.liveCapture.createMany({ data: [1, 2, 3].map(i => ({ widgetId: widget.id, email: `visitante${i}@correo-inventado.test` })) })
    await prisma.setting.createMany({
      data: [
        { key: brandId, value: JSON.stringify({ id: brandId, name: `Marca Previa ${tag}`, assignedEmployees: [fx.ada], createdBy: fx.ada, createdAt: '2026-11-01T00:00:00.000Z' }) },
        { key: benchKey, value: JSON.stringify({ INSTAGRAM: { MICRO: { REEL: [50, 60, 70, 80] } } }) },
      ],
    })
  })

  afterAll(async () => {
    await prisma.briefFile.deleteMany({ where: { campaignId: fx.campaign } })
    await prisma.competitorPost.deleteMany({ where: { competitorId: made.competitor } })
    await prisma.competitorAccount.deleteMany({ where: { id: made.competitor } })
    await prisma.liveCaptureWidget.deleteMany({ where: { userId: fx.ada } })
    await prisma.setting.deleteMany({ where: { key: { in: [brandId, benchKey] } } })
  })

  it('deleting a brief file, a competitor or a widget names what goes and how much, and deletes nothing yet', async () => {
    const file = await call({ method: 'DELETE', path: `/api/campaigns/${fx.campaign}/brief-files`, body: { fileId: made.file } })
    expect(file.data.needsApproval).toBe(true)
    expect(file.data.preview).toBe(`Vas a borrar el archivo «brief-${tag}.pdf» del brief de la campaña «${fx.campaignName}». No se puede deshacer: para recuperarlo habría que volver a subirlo desde la plataforma. ¿Confirmas?`)
    const wrongFile = await call({ method: 'DELETE', path: `/api/campaigns/${fx.campaign}/brief-files`, body: { fileId: 'not-a-file-of-this-campaign' } })
    expect(wrongFile.text).toContain('Ese archivo no está en el brief')

    const competitor = await call({ method: 'DELETE', path: `/api/competitors/${made.competitor}` })
    expect(competitor.data.preview).toContain(`@rival_pr_${tag} (Instagram) y sus 2 publicaciones guardadas`)
    expect(competitor.data.preview).toContain('nueva lectura de Apify')

    const widget = await call({ method: 'DELETE', path: `/api/live-capture/widgets/${made.widget}` })
    expect(widget.data.preview).toContain(`«Widget ${tag}» y sus 3 capturas`)
    expect(widget.data.preview).toContain('dejará de funcionar en la web del cliente')

    expect(await prisma.briefFile.count({ where: { id: made.file } })).toBe(1)
    expect(await prisma.competitorAccount.count({ where: { id: made.competitor } })).toBe(1)
    expect(await prisma.liveCaptureWidget.count({ where: { id: made.widget } })).toBe(1)
  })

  it('a change of a live widget (what the visitors of the client website see) waits for the administrator, with before and after', async () => {
    const patches = callsTo('PATCH', '/api/live-capture/widgets/[id]')
    const body = { headlineText: 'Oferta: escribe a promo@correo-inventado.test', brandLogo: 'https://imagenes-inventadas.example/p.png', isActive: false }
    const first = await call({ method: 'PATCH', path: `/api/live-capture/widgets/${made.widget}`, body })
    expect(first.isError).toBe(false)
    expect(first.data).toMatchObject({ needsApproval: true })
    const stored = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: first.data.actionId } })
    expect(stored.confirmation).toBe('outbound')
    expect(stored.preview).toContain(`Vas a cambiar el widget de captación «Widget ${tag}», que funciona en la web del cliente`)
    expect(stored.preview).toContain('titular: «Share your social media» → «Oferta: escribe a promo@correo-inventado.test»')
    expect(stored.preview).toContain('logo (dirección de la imagen que cargan los visitantes): vacío → «https://imagenes-inventadas.example/p.png»')
    expect(stored.preview).toContain('activo: sí → no')
    expect(callsTo('PATCH', '/api/live-capture/widgets/[id]')).toBe(patches)
    expect(await prisma.liveCaptureWidget.findUniqueOrThrow({ where: { id: made.widget } })).toMatchObject({ isActive: true, brandLogo: null })

    expect(await decidePendingAction({ id: first.data.actionId, deciderId: fx.ada, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })
    const run = await call({ method: 'PATCH', path: `/api/live-capture/widgets/${made.widget}`, body: { isActive: true }, actionId: first.data.actionId })
    expect(run.isError).toBe(false)
    expect(callsTo('PATCH', '/api/live-capture/widgets/[id]')).toBe(patches + 1)
    // The stored change ran, not the one of the second call
    expect(await prisma.liveCaptureWidget.findUniqueOrThrow({ where: { id: made.widget } })).toMatchObject({ isActive: false, brandLogo: 'https://imagenes-inventadas.example/p.png' })
    await prisma.liveCaptureWidget.update({ where: { id: made.widget }, data: { isActive: true, brandLogo: null, headlineText: 'Share your social media' } })
  })

  it('reading a widget never returns the visitors e-mails nor its key without includeContact', async () => {
    const answer = await call({ method: 'GET', path: `/api/live-capture/widgets/${made.widget}` })
    expect(answer.isError).toBe(false)
    expect(answer.text).not.toContain('visitante1@correo-inventado.test')
    expect(answer.text).not.toContain('"apiKey"')
    expect(answer.data.data.widget.captures[0].hasEmail).toBe(true)
  })

  it('replacing a benchmark table says whose it is and returns the value it replaced (with includeEconomics)', async () => {
    const value = { INSTAGRAM: { MICRO: { REEL: [100, 200, 300, 400] } } }
    const args = { method: 'PUT', path: '/api/settings/benchmarks', body: { key: 'benchmark_fee_ranges', value, brandId } }
    const first = await call(args)
    expect(first.data.needsConfirmation).toBe(true)
    expect(first.data.preview).toContain(`Vas a sustituir la tabla de rangos de fee de la marca «Marca Previa ${tag}»`)
    expect(first.data.preview).toContain('Metodología, Ajustes y la base de conocimiento')
    expect(first.data.preview).not.toMatch(/\b(50|60|70|80)\b/)
    const ran = await call({ ...args, confirmToken: first.data.confirmToken, includeEconomics: true })
    expect(ran.isError).toBe(false)
    expect(ran.data.previous).toEqual({ [benchKey]: { INSTAGRAM: { MICRO: { REEL: [50, 60, 70, 80] } } } })
    expect(JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: benchKey } })).value)).toEqual(value)
  })

  it('deleting a brand\'s benchmark table names the brand, waits for the approval, and returns the value it removed (with includeEconomics)', async () => {
    const args = { method: 'DELETE', path: '/api/settings/benchmarks', query: { key: 'benchmark_fee_ranges', brandId } }
    const stored = (await prisma.setting.findUniqueOrThrow({ where: { key: benchKey } })).value
    const deletes = () => callsTo('DELETE', '/api/settings/benchmarks')
    const before = deletes()
    const first = await call(args)
    expect(first.isError).toBe(false)
    expect(first.data.needsApproval).toBe(true)
    expect(first.data.preview).toContain(`Vas a borrar la tabla de rangos de fee propia de la marca «Marca Previa ${tag}»: la marca volverá a usar la de la agencia`)
    expect(first.data.preview).toContain('Metodología, Ajustes y la base de conocimiento')
    expect(first.data.preview).not.toContain('REEL')
    expect(deletes()).toBe(before)
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: benchKey } })).value).toBe(stored)

    // Another table name, or a key that is not a benchmark table, is refused before anything is prepared
    expect((await call({ ...args, query: { key: 'apify_api_key' } })).text).toContain('query.key debe ser')
    expect((await call({ ...args, query: { key: 'benchmark_markets', brandId } })).text).toContain('solo de la agencia')

    expect(await decidePendingAction({ id: first.data.actionId, deciderId: fx.ada, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })
    const ran = await call({ ...args, actionId: first.data.actionId, includeEconomics: true })
    expect(ran.isError).toBe(false)
    expect(ran.data).toMatchObject({ status: 200, route: 'DELETE /api/settings/benchmarks' })
    expect(ran.data.previous).toEqual({ [benchKey]: JSON.parse(stored) })
    expect(await prisma.setting.findUnique({ where: { key: benchKey } })).toBeNull()
    expect(deletes()).toBe(before + 1)
    const sent = new URL(router.calls.filter(c => c.method === 'DELETE').at(-1)?.url ?? '', SITE)
    expect(sent.pathname).toBe('/api/settings/benchmarks')
    expect(Object.fromEntries(sent.searchParams)).toEqual({ key: 'benchmark_fee_ranges', brandId })
  })

  it('the paid real-views read quotes the backlog, counts as core spend, and is refused when the capture budget is closed', async () => {
    h.apify.optionalBlocked = true
    const offered = await call({ method: 'POST', path: '/api/admin/enrich-views', body: { campaignId: fx.campaign, limit: 80 } })
    expect(offered.data.needsConfirmation).toBe(true)
    expect(offered.data.preview).toContain('hasta 50 reels y vídeos de esta campaña')
    expect(offered.data.preview).toContain('pendientes ahora: 0')
    expect(offered.data.preview).toContain('Esto consume Apify')
    expect(offered.data.preview).not.toMatch(/\$|USD|0,002/)
    h.apify.coreBlocked = true
    const closed = await call({ method: 'POST', path: '/api/admin/enrich-views', body: { campaignId: fx.campaign } })
    expect(closed.isError).toBe(true)
    expect(closed.text).toContain('bloqueado')
  })

  it('the bulk admin jobs run their dry run first and change nothing on the first call', async () => {
    const media = await prisma.media.count()
    const fanout = await call({ method: 'POST', path: '/api/admin/fanout-media', body: {} })
    if (fanout.isError) expect(fanout.text).toContain('no encuentra ninguna publicación que copiar')
    else expect(fanout.data.preview).toContain('Vas a copiar')
    expect(await prisma.media.count()).toBe(media)
    expect(callsTo('POST', '/api/admin/fanout-media')).toBeGreaterThanOrEqual(1)

    const signals = await prisma.creatorCategorySignal.count()
    const categories = await call({ method: 'POST', path: '/api/admin/backfill-categories' })
    if (categories.isError) expect(categories.text).toContain('no encuentra ninguna creadora que categorizar')
    else expect(categories.data.preview).toContain('Vas a guardar categorías')
    expect(await prisma.creatorCategorySignal.count()).toBe(signals)
    expect(router.calls.filter(c => c.pattern === '/api/admin/backfill-categories').every(c => c.url.includes('dryRun=true'))).toBe(true)
  })
})

describe('platform_request: a bulk change needs the confirm token', () => {
  it('marking every notification as read says how many, then runs with the token', async () => {
    const unread = await prisma.notification.count({ where: { userId: fx.ada, read: false } })
    expect(unread).toBeGreaterThanOrEqual(7)
    const args = { method: 'PATCH', path: '/api/notifications', body: { markAll: true } }
    const first = await call(args)
    expect(first.data.needsConfirmation).toBe(true)
    expect(first.data.preview).toBe(`Vas a marcar como leídas tus ${unread} notificaciones sin leer. ¿Confirmas?`)
    expect(await prisma.notification.count({ where: { userId: fx.ada, read: false } })).toBe(unread)

    const ran = await call({ ...args, confirmToken: first.data.confirmToken })
    expect(ran.isError).toBe(false)
    expect(ran.data.data).toMatchObject({ success: true, unreadCount: 0 })
    // Everything read; the only unread one is the notice this confirmed change leaves for the administrator
    const left = await prisma.notification.findMany({ where: { userId: fx.ada, read: false }, select: { type: true, message: true } })
    expect(left).toEqual([{ type: 'mcp_action', message: expect.stringContaining('PATCH /api/notifications') }])
  })

  it('up to five ids run without confirmation', async () => {
    const ids = (await prisma.notification.findMany({ where: { userId: fx.ada }, take: 3, select: { id: true } })).map(n => n.id)
    const answer = await call({ method: 'PATCH', path: '/api/notifications', body: { ids } })
    expect(answer.isError).toBe(false)
    expect(answer.data.status).toBe(200)
  })
})
