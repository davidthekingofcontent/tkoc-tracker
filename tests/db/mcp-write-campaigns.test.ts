import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, no public address (every
// URL is built from the production default), no Apify token.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-write-campaigns'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
  return { mail: [] as unknown[] }
})

// No e-mail may leave: every brand-assignment e-mail the platform tries to send is kept here
vi.mock('@/lib/email', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  return {
    ...actual,
    sendBrandAssignmentEmail: async (args: unknown) => {
      h.mail.push(args)
    },
  }
})

// This file runs far more than 20 writes in a minute on one grant: the per-minute write
// allowance (tested in mcp-pending-actions.test.ts) is lifted here; every other limit is real.
vi.mock('@/lib/rate-limiter', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/rate-limiter')>()
  return {
    ...actual,
    canProceed: (key: string, max: number, windowMs: number) => key.startsWith('mcp:write:min:') || actual.canProceed(key, max, windowMs),
  }
})

import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { prisma } from '@/lib/db'
import { CAMPAIGN_OBJECTIVES } from '@/lib/campaign-intelligence'
import { MCP_RESOURCE } from '@/lib/mcp/config'
import { decidePendingAction } from '@/lib/mcp/confirm'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { createGrantAndCode, registerClient } from '@/lib/mcp/oauth'
import { setPlatformTransport } from '@/lib/mcp/platform-client'
import { WRITE_CONTROL_FIELDS, writeToolConfig, type WriteTool } from '@/lib/mcp/write-tool'
import {
  CAMPAIGN_WRITE_TOOLS,
  OBJECTIVES,
  createCampaign,
  deleteCampaign,
  recordBusinessResults,
  registerCampaignWriteTools,
  revalidateCampaignMedia,
  setCampaignAccess,
  setCampaignGoals,
  setCampaignStatus,
  setCampaignTrackingTargets,
  updateCampaign,
} from '@/lib/mcp/tools/write/campaigns'
import { REPORT_WRITE_TOOLS, editReportContent, markReportSent, registerReportWriteTools, setReportVisibility } from '@/lib/mcp/tools/write/report'
import { BRAND_ID_RE, BRAND_WRITE_TOOLS, createBrand, deleteBrand, registerBrandWriteTools, updateBrand } from '@/lib/mcp/tools/write/brands'
import { createPlatformRouter } from '../helpers/platform-router'

const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const SITE = 'https://intelligence.thekingofcontent.agency'
const tag = randomUUID().slice(0, 8)
const router = createPlatformRouter()

// ============ Fixtures (invented data) ============

const fx = {
  ada: '',
  bea: '',
  laura: '',
  portalUser: '',
  grantAda: '',
  grantReadOnly: '',
  brandId: `brand_1731400000000_${tag}`,
  doomedBrandId: `brand_1731400000002_${tag}`,
  decoyKey: `brand_1731400000001_${tag}`,
  main: '',
  other: '',
  reval: '',
  doomed: '',
  bare: '',
  doomedBrandCampaign: '',
  statusIds: [] as string[],
  marta: '',
  luis: '',
  nora: '',
  mainMedia: [] as string[],
  otherMedia: '',
  r: {} as Record<'r1' | 'r2' | 'r3' | 'r3copy' | 'r4' | 'r5', string>,
}

const created = { users: [] as string[], influencers: [] as string[], campaigns: [] as string[], settings: [] as string[] }

async function keepAlive(grantId: string): Promise<void> {
  await prisma.mcpToken.create({ data: { grantId, kind: 'access', tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 3_600_000) } })
}

async function grantFor(userId: string): Promise<string> {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, `198.51.100.77-${tag}`)
  const { grantId } = await createGrantAndCode({ userId, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) })
  await keepAlive(grantId)
  return grantId
}

// ============ Calling a tool as Claude would ============

interface Answer {
  isError: boolean
  text: string
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(tool: WriteTool, grantId: string, userId: string, args: Record<string, unknown>): Promise<Answer> {
  const res = await tool.call(args, { grantId, userId })
  const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}
const asAda = (tool: WriteTool, args: Record<string, unknown>) => call(tool, fx.grantAda, fx.ada, args)

const callsTo = (method: string, pattern: string) => router.calls.filter(c => c.method === method && c.pattern === pattern).length

async function lastLog() {
  // Two lines can share a millisecond: the cuid of the newer one sorts after (it carries a counter)
  return prisma.mcpCallLog.findFirstOrThrow({ where: { grantId: fx.grantAda }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

/** The administrator who authorised the grant presses «Confirmar» in the platform. */
async function approve(actionId: string) {
  expect(await decidePendingAction({ id: actionId, deciderId: fx.ada, decision: 'approve' })).toEqual({ ok: true, status: 'approved' })
}

async function reportConfig(campaignId: string) {
  const row = await prisma.setting.findUnique({ where: { key: `campaign_report_${campaignId}` } })
  return row ? JSON.parse(row.value) : null
}

// ============ Setup ============

beforeAll(async () => {
  // Nothing in this file may reach a network
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  setPlatformTransport(router.transport)

  const user = (name: string, role: 'ADMIN' | 'EMPLOYEE' | 'BRAND', extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `${name.toLowerCase().replace(/\s/g, '.')}-${tag}@correo-inventado.test`, password: 'x', name, role, ...extra } })
  const [ada, bea, laura, portal] = await Promise.all([
    user('Ada Admin', 'ADMIN'),
    user('Bea Admin', 'ADMIN'),
    user('Laura Gestora', 'EMPLOYEE'),
    user('Portal Cliente', 'BRAND'),
  ])
  created.users.push(ada.id, bea.id, laura.id, portal.id)
  Object.assign(fx, { ada: ada.id, bea: bea.id, laura: laura.id, portalUser: portal.id })

  fx.grantAda = await grantFor(ada.id)
  fx.grantReadOnly = (await prisma.mcpGrant.create({ data: { clientId: 'old-client', userId: ada.id, scope: 'tkoc.read', resource: MCP_RESOURCE } })).id
  await keepAlive(fx.grantReadOnly)

  // Brands: two real ones and a settings row whose key LOOKS like a brand id but is not a brand
  const brandDoc = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, name, assignedEmployees: [ada.id], createdBy: ada.id, createdAt: '2026-10-01T00:00:00.000Z', ...extra })
  await prisma.setting.createMany({
    data: [
      { key: fx.brandId, value: brandDoc(fx.brandId, 'Zentolia', { website: 'https://zentolia.example' }) },
      { key: fx.doomedBrandId, value: brandDoc(fx.doomedBrandId, 'Lumbrera', { brandUserId: portal.id }) },
      // Not a brand document (a stored value): the brands route skips it, its PATCH and DELETE would not
      { key: fx.decoyKey, value: 'valor-guardado-que-no-es-una-marca' },
    ],
  })
  created.settings.push(fx.brandId, fx.doomedBrandId, fx.decoyKey)

  const inf = (username: string) => prisma.influencer.create({ data: { username: `${username}_${tag}`, platform: 'INSTAGRAM', followers: 1000 } })
  const [marta, luis, nora] = await Promise.all([inf('marta'), inf('luis'), inf('nora')])
  created.influencers.push(marta.id, luis.id, nora.id)
  Object.assign(fx, { marta: marta.id, luis: luis.id, nora: nora.id })

  const campaign = async (name: string, extra: Record<string, unknown> = {}) => {
    const c = await prisma.campaign.create({
      data: {
        name,
        status: 'ACTIVE',
        type: 'INFLUENCER_TRACKING',
        platforms: ['INSTAGRAM'],
        startDate: new Date('2026-10-01T00:00:00.000Z'),
        endDate: new Date('2026-12-31T00:00:00.000Z'),
        userId: ada.id,
        assignments: { create: { userId: ada.id } },
        ...extra,
      },
    })
    created.campaigns.push(c.id)
    return c.id
  }

  // The main campaign: frozen targets, brand attached, two members, eight pieces
  fx.main = await campaign('Zentolia Otoño', {
    objective: 'awareness',
    targetViews: 100000,
    targetCpmMax: 12.5,
    targetsFrozenAt: new Date('2026-10-01T00:00:00.000Z'),
    targetAccounts: ['zentolia.es'],
    targetHashtags: ['zentolia'],
  })
  await prisma.setting.create({ data: { key: `campaign_brand_${fx.main}`, value: fx.brandId } })
  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: fx.main, influencerId: marta.id, status: 'CONTRACTED' },
      { campaignId: fx.main, influencerId: luis.id, status: 'CONTRACTED' },
    ],
  })
  for (let i = 0; i < 8; i++) {
    const m = await prisma.media.create({
      data: {
        campaignId: fx.main,
        influencerId: i % 2 === 0 ? marta.id : luis.id,
        platform: 'INSTAGRAM',
        mediaType: i % 3 === 0 ? 'REEL' : 'POST',
        externalId: `main-${i}-${tag}`,
        hashtags: ['zentolia'],
        postedAt: new Date(`2026-10-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`),
      },
    })
    fx.mainMedia.push(m.id)
  }

  // Another campaign, with a piece that is NOT of the main one
  fx.other = await campaign('Velmora Invierno')
  fx.otherMedia = (
    await prisma.media.create({ data: { campaignId: fx.other, influencerId: nora.id, platform: 'INSTAGRAM', mediaType: 'POST', externalId: `other-${tag}`, postedAt: new Date('2026-10-20T10:00:00.000Z') } })
  ).id

  // The campaign to revalidate: five pieces whose fate is known
  fx.reval = await campaign('Zentolia Revalida', { endDate: new Date('2026-10-31T00:00:00.000Z'), targetHashtags: ['zentolia'] })
  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: fx.reval, influencerId: marta.id, status: 'POSTED' },
      { campaignId: fx.reval, influencerId: luis.id, status: 'POSTED' },
    ],
  })
  const piece = (data: Record<string, unknown>) =>
    prisma.media.create({ data: { platform: 'INSTAGRAM', ...data } as Parameters<typeof prisma.media.create>[0]['data'] }).then(m => m.id)
  fx.r = {
    // kept: member, inside, brand hashtag
    r1: await piece({ campaignId: fx.reval, influencerId: marta.id, mediaType: 'REEL', source: 'apify', externalId: `r1-${tag}`, hashtags: ['zentolia'], postedAt: new Date('2026-10-05T10:00:00.000Z') }),
    // out: no brand reference, only copy → detached
    r2: await piece({ campaignId: fx.reval, influencerId: marta.id, mediaType: 'POST', source: 'apify', externalId: `r2-${tag}`, caption: 'un día cualquiera', postedAt: new Date('2026-10-06T10:00:00.000Z') }),
    // out: outside the dates, another copy exists → deleted
    r3: await piece({ campaignId: fx.reval, influencerId: luis.id, mediaType: 'REEL', source: 'apify', externalId: `r3-${tag}`, hashtags: ['zentolia'], postedAt: new Date('2026-09-15T10:00:00.000Z') }),
    r3copy: await piece({ campaignId: fx.other, influencerId: luis.id, mediaType: 'REEL', source: 'apify', externalId: `r3-${tag}`, postedAt: new Date('2026-09-15T10:00:00.000Z') }),
    // out: not a member (hand-added pieces too), only copy → detached
    r4: await piece({ campaignId: fx.reval, influencerId: nora.id, mediaType: 'POST', source: 'manual', externalId: `r4-${tag}`, postedAt: new Date('2026-10-07T10:00:00.000Z') }),
    // kept: a hand-added story of a member
    r5: await piece({ campaignId: fx.reval, influencerId: luis.id, mediaType: 'STORY', source: 'manual', externalId: null, postedAt: new Date('2026-10-08T10:00:00.000Z') }),
  }

  // The campaign to delete: two members, a post and a story, a brief file, a note, a team of one
  fx.doomed = await campaign('Zentolia Borrar')
  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: fx.doomed, influencerId: marta.id, status: 'NEGOTIATING', agreedFee: 300, shippingAddress1: 'Calle Inventada 1' },
      { campaignId: fx.doomed, influencerId: luis.id, status: 'NEGOTIATING' },
    ],
  })
  await prisma.media.create({ data: { campaignId: fx.doomed, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `doomed-${tag}`, postedAt: new Date('2026-10-05T10:00:00.000Z') } })
  await prisma.media.create({ data: { campaignId: fx.doomed, influencerId: luis.id, platform: 'INSTAGRAM', mediaType: 'STORY', source: 'manual', postedAt: new Date('2026-10-05T10:00:00.000Z') } })
  await prisma.briefFile.create({ data: { campaignId: fx.doomed, fileName: 'brief.pdf', fileType: 'application/pdf', fileSize: 3, fileData: Buffer.from('pdf') } })
  await prisma.campaignNote.create({ data: { campaignId: fx.doomed, influencerId: marta.id, userId: ada.id, userName: 'Ada Admin', text: 'nota interna' } })

  // A campaign with one rule only, to empty its rules
  fx.bare = await campaign('Zentolia Vacía', { targetHashtags: ['zentolia'] })

  // The campaign of the brand to delete
  fx.doomedBrandCampaign = await campaign('Lumbrera Primavera')
  await prisma.setting.create({ data: { key: `campaign_brand_${fx.doomedBrandCampaign}`, value: fx.doomedBrandId } })

  // Six campaigns for the status changes
  for (let i = 1; i <= 6; i++) fx.statusIds.push(await campaign(`Estado ${i}`))
})

afterAll(async () => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
  const grants = [fx.grantAda, fx.grantReadOnly]
  await prisma.mcpPendingAction.deleteMany({ where: { grantId: { in: grants } } })
  await prisma.mcpCallLog.deleteMany({ where: { grantId: { in: grants } } })
  const campaignIds = [...created.campaigns]
  const keys = [
    ...created.settings,
    ...campaignIds.flatMap(id => [`campaign_brand_${id}`, `campaign_report_${id}`]),
  ]
  await prisma.setting.deleteMany({ where: { key: { in: keys } } })
  await prisma.campaignNote.deleteMany({ where: { campaignId: { in: campaignIds } } })
  await prisma.media.deleteMany({ where: { OR: [{ campaignId: { in: campaignIds } }, { influencerId: { in: created.influencers } }] } })
  await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } })
  await prisma.influencer.deleteMany({ where: { id: { in: created.influencers } } })
  await prisma.notification.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpToken.deleteMany({ where: { grantId: { in: grants } } })
  await prisma.mcpAuthCode.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.mcpGrant.deleteMany({ where: { userId: { in: created.users } } })
  await prisma.user.deleteMany({ where: { id: { in: created.users } } })
})

// ============ The tool set ============

const ALL = [...CAMPAIGN_WRITE_TOOLS, ...REPORT_WRITE_TOOLS, ...BRAND_WRITE_TOOLS]

describe('the campaign, report and brand write tools', () => {
  it('are the fifteen tools of the proposal, each named once, with a title, a description and annotations', () => {
    expect(ALL.map(t => t.name)).toEqual([
      'create_campaign', 'update_campaign', 'set_campaign_status', 'set_campaign_tracking_targets', 'set_campaign_goals',
      'record_business_results', 'delete_campaign', 'revalidate_campaign_media', 'set_campaign_access',
      'set_report_visibility', 'edit_report_content', 'mark_report_sent',
      'create_brand', 'update_brand', 'delete_brand',
    ])
    expect(new Set(ALL.map(t => t.name)).size).toBe(ALL.length)
    for (const tool of ALL) {
      expect(tool.name.length).toBeLessThanOrEqual(64)
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.title.trim().length).toBeGreaterThan(5)
      expect(tool.description.length).toBeGreaterThan(200)
      expect(tool.annotations).toMatchObject({ title: tool.title, readOnlyHint: false, openWorldHint: false })
      expect(typeof tool.annotations.destructiveHint).toBe('boolean')
      // Every tool that may delete is announced as destructive
      if (tool.confirmations.includes('destructive')) expect(tool.annotations.destructiveHint).toBe(true)
      for (const field of WRITE_CONTROL_FIELDS) {
        if (field === 'confirmToken') expect(field in tool.input).toBe(tool.confirmations.includes('bulk') || tool.confirmations.includes('money'))
        else if (field === 'actionId') expect(field in tool.input).toBe(tool.confirmations.includes('destructive') || tool.confirmations.includes('outbound'))
        else expect(field in tool.input).toBe(true)
      }
    }
  })

  it('each registration function hands over its own tools exactly once', () => {
    const seen: string[] = []
    registerCampaignWriteTools(t => seen.push(t.name))
    registerReportWriteTools(t => seen.push(t.name))
    registerBrandWriteTools(t => seen.push(t.name))
    expect(seen).toEqual(ALL.map(t => t.name))
  })

  it('the objectives are the platform ones', () => {
    expect([...OBJECTIVES]).toEqual(CAMPAIGN_OBJECTIVES.map(o => o.value))
  })

  it('the MCP SDK lists them with their schemas and runs one through its own validation', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' }, { maxToolInputElements: 1000 })
    const register = (tool: WriteTool) =>
      server.registerTool(tool.name, writeToolConfig(tool), args => tool.call(args, { grantId: fx.grantAda, userId: fx.ada }))
    registerCampaignWriteTools(register)
    registerReportWriteTools(register)
    registerBrandWriteTools(register)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(clientSide)
    try {
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(ALL.map(t => t.name))
      const visibility = tools.find(t => t.name === 'set_report_visibility')!
      expect(Object.keys(visibility.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['campaignId', 'hideMediaIds', 'confirmToken', 'includeContact']))
      expect(visibility.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
      const brandDelete = tools.find(t => t.name === 'delete_brand')!
      expect(Object.keys(brandDelete.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['brandId', 'actionId']))

      const res = await client.callTool({ name: 'update_campaign', arguments: { campaignId: fx.bare, isPinned: true } })
      expect(res.isError).not.toBe(true)
      const data = JSON.parse((res.content as { text: string }[])[0].text)
      expect(data).toMatchObject({ changed: ['isPinned'], before: { isPinned: false }, after: { isPinned: true } })
    } finally {
      await client.close()
      await server.close()
    }
  })
})

// ============ Brands ============

describe('brands', () => {
  let velmora = ''

  it('create_brand creates the brand through the platform and returns its id', async () => {
    const answer = await asAda(createBrand, { name: 'Velmora Cosmetics', website: 'https://velmora.example' })
    expect(answer.isError).toBe(false)
    velmora = answer.data.brand.id
    created.settings.push(velmora)
    expect(velmora).toMatch(BRAND_ID_RE)
    expect(answer.data.brand).toMatchObject({ name: 'Velmora Cosmetics', website: 'https://velmora.example' })
    expect(answer.data.message).toContain(velmora)
    const stored = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: velmora } })).value)
    expect(stored).toMatchObject({ id: velmora, name: 'Velmora Cosmetics', createdBy: fx.ada, assignedEmployees: [fx.ada] })
    const log = await lastLog()
    expect(log).toMatchObject({ tool: 'create_brand', ok: true })
    expect(log.argsSummary).toBe('[none:execute http=201] website=true logo=false')
  })

  it('a name equal or very similar to an existing brand comes back with the platform own Spanish refusal', async () => {
    const before = await prisma.setting.count({ where: { key: { startsWith: 'brand_' } } })
    const answer = await asAda(createBrand, { name: 'zentolia' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Ya existe una marca igual o muy similar: "Zentolia"')
    expect(await prisma.setting.count({ where: { key: { startsWith: 'brand_' } } })).toBe(before)
  })

  it('update_brand renames and clears the website, reporting before and after', async () => {
    const answer = await asAda(updateBrand, { brandId: velmora, name: 'Velmora Beauty', website: null })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({
      changed: ['name', 'website'],
      before: { name: 'Velmora Cosmetics', website: 'https://velmora.example' },
      after: { name: 'Velmora Beauty', website: null },
    })
    const stored = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: velmora } })).value)
    expect(stored.name).toBe('Velmora Beauty')
    expect(stored.website).toBeUndefined()
    expect(h.mail).toEqual([])
  })

  it('says so when the platform ignores a change of capital letters only', async () => {
    const answer = await asAda(updateBrand, { brandId: velmora, name: 'velmora beauty' })
    expect(answer.isError).toBe(false)
    expect(answer.data.changed).toEqual([])
    expect(answer.data.notes[0]).toContain('solo cambiaban mayúsculas o minúsculas')
  })

  it('never touches a settings row that is not a brand, even with a brand-like key', async () => {
    const patches = callsTo('PATCH', '/api/brands')
    const decoy = await call(updateBrand, fx.grantAda, fx.ada, { brandId: fx.decoyKey, name: 'Pirata' })
    expect(decoy.isError).toBe(true)
    expect(decoy.text).toContain('No existe ninguna marca con ese id')
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: fx.decoyKey } })).value).toBe('valor-guardado-que-no-es-una-marca')
    for (const brandId of ['apify_api_key', `campaign_report_${fx.main}`, `brand_user_${fx.ada}`, 'brand_1731400000000_X']) {
      const refused = await asAda(updateBrand, { brandId, name: 'Pirata' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toBe('Invalid arguments for update_brand.')
    }
    const deleted = await asAda(deleteBrand, { brandId: fx.decoyKey })
    expect(deleted.isError).toBe(true)
    expect(await prisma.setting.findUnique({ where: { key: fx.decoyKey } })).not.toBeNull()
    expect(callsTo('PATCH', '/api/brands')).toBe(patches)
    expect(callsTo('DELETE', '/api/brands')).toBe(0)
  })

  it('delete_brand waits for the administrator, names the campaigns that lose the brand, then deletes it once', async () => {
    const first = await asAda(deleteBrand, { brandId: fx.doomedBrandId })
    expect(first.isError).toBe(false)
    expect(first.data.needsApproval).toBe(true)
    expect(first.data.preview).toContain('Vas a BORRAR la marca «Lumbrera».')
    expect(first.data.preview).toContain('Su campaña «Lumbrera Primavera» se queda sin marca de forma definitiva')
    expect(first.data.preview).toContain('Su usuario de portal dejará de ver campañas.')
    expect(first.data.preview).toContain('No se puede deshacer.')
    const actionId = first.data.actionId

    const early = await asAda(deleteBrand, { brandId: fx.doomedBrandId, actionId })
    expect(early.isError).toBe(true)
    expect(early.text).toContain('Todavía nadie la ha confirmado')
    expect(await prisma.setting.findUnique({ where: { key: fx.doomedBrandId } })).not.toBeNull()
    expect(callsTo('DELETE', '/api/brands')).toBe(0)

    await approve(actionId)
    const run = await asAda(deleteBrand, { brandId: fx.doomedBrandId, actionId })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ deleted: true, brand: { id: fx.doomedBrandId, name: 'Lumbrera' }, campaignsUnlinked: 1 })
    expect(await prisma.setting.findUnique({ where: { key: fx.doomedBrandId } })).toBeNull()
    expect(await prisma.setting.findUnique({ where: { key: `campaign_brand_${fx.doomedBrandCampaign}` } })).toBeNull()
    expect(await prisma.campaign.findUnique({ where: { id: fx.doomedBrandCampaign } })).not.toBeNull()
    expect(callsTo('DELETE', '/api/brands')).toBe(1)

    const again = await asAda(deleteBrand, { brandId: fx.doomedBrandId, actionId })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('ya se ejecutó')
    expect(callsTo('DELETE', '/api/brands')).toBe(1)
  })
})

// ============ create_campaign ============

describe('create_campaign', () => {
  const base = { name: 'Zentolia Navidad', brandId: fx.brandId, startDate: '2026-12-01', endDate: '2026-12-31', platforms: ['INSTAGRAM', 'TIKTOK'] }

  it('refuses before calling the platform when the objective or every numeric target is missing, or the brand does not exist', async () => {
    const posts = callsTo('POST', '/api/campaigns')
    const noObjective = await asAda(createCampaign, { ...base, brandId: fx.brandId, targetViews: 1000 })
    expect(noObjective.isError).toBe(true)
    expect(noObjective.text).toContain('Falta el objetivo de la campaña')
    const noTarget = await asAda(createCampaign, { ...base, brandId: fx.brandId, objective: 'engagement' })
    expect(noTarget.isError).toBe(true)
    expect(noTarget.text).toContain('Falta al menos una meta numérica')
    const noBrand = await asAda(createCampaign, { ...base, brandId: 'brand_1731400000009_nadie', objective: 'engagement', targetViews: 1000 })
    expect(noBrand.isError).toBe(true)
    expect(noBrand.text).toContain('No existe ninguna marca con ese id')
    const repeated = await asAda(createCampaign, { ...base, brandId: fx.brandId, platforms: ['INSTAGRAM', 'INSTAGRAM'], objective: 'engagement', targetViews: 1000 })
    expect(repeated.isError).toBe(true)
    expect(callsTo('POST', '/api/campaigns')).toBe(posts)
  })

  it('relays the platform refusal of a generic hashtag', async () => {
    const answer = await asAda(createCampaign, { ...base, brandId: fx.brandId, objective: 'engagement', targetViews: 1000, targetHashtags: ['mopa'] })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('La plataforma ha respondido 400')
    expect(answer.text).toContain('Los hashtags objetivo deben identificar a la marca')
  })

  it('creates an ACTIVE campaign attached to the brand, says that capture starts, and keeps the CPM out unless asked', async () => {
    const answer = await asAda(createCampaign, {
      ...base,
      brandId: fx.brandId,
      objective: 'engagement',
      targetViews: 50000,
      targetCpmMax: 9,
      targetHashtags: ['#zentolianavidad'],
      country: 'ES',
    })
    expect(answer.isError).toBe(false)
    const c = answer.data.campaign
    created.campaigns.push(c.id)
    expect(c).toMatchObject({
      name: 'Zentolia Navidad', status: 'ACTIVE', type: 'INFLUENCER_TRACKING', brandId: fx.brandId, brand: 'Zentolia',
      platforms: ['INSTAGRAM', 'TIKTOK'], startDate: '2026-12-01', endDate: '2026-12-31', country: 'ES', objective: 'engagement',
      targetViews: 50000, tracking: { hashtags: ['zentolianavidad'] }, link: `${SITE}/campaigns/${c.id}`,
    })
    expect(c.targetCpmMax).toBeUndefined()
    expect(answer.data._notes).toBeUndefined()
    expect(answer.data.notice).toContain('Campaña creada y ACTIVA')
    expect(answer.data.notice).toContain('consume Apify')
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id }, include: { assignments: true } })
    expect(row).toMatchObject({ status: 'ACTIVE', userId: fx.ada, targetCpmMax: 9 })
    expect(row.targetsFrozenAt).not.toBeNull()
    expect(row.assignments.map(a => a.userId)).toEqual([fx.ada])
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: `campaign_brand_${c.id}` } })).value).toBe(fx.brandId)
    expect((await lastLog()).argsSummary).toMatch(/^\[none:execute http=200,201\] type=INFLUENCER_TRACKING brandId=brand_/)

    // The same call again (a retry after a lost answer) creates nothing
    const posts = callsTo('POST', '/api/campaigns')
    const retry = await asAda(createCampaign, { ...base, brandId: fx.brandId, objective: 'engagement', targetViews: 50000 })
    expect(retry.isError).toBe(true)
    expect(retry.text).toContain(`ya se creó una campaña con ese nombre (id ${c.id})`)
    expect(callsTo('POST', '/api/campaigns')).toBe(posts)
  })
})

// ============ update_campaign ============

describe('update_campaign', () => {
  it('changes only what differs and lists every change as before and after', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]')
    const answer = await asAda(updateCampaign, {
      campaignId: fx.main,
      name: 'Zentolia Otoño 2026',
      endDate: '2027-01-15',
      platforms: ['INSTAGRAM', 'TIKTOK'],
      paymentType: 'PAID', // already PAID: not sent
    })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({
      changed: ['name', 'endDate', 'platforms'],
      before: { name: 'Zentolia Otoño', endDate: '2026-12-31', platforms: ['INSTAGRAM'] },
      after: { name: 'Zentolia Otoño 2026', endDate: '2027-01-15', platforms: ['INSTAGRAM', 'TIKTOK'] },
    })
    expect(answer.data.notes[0]).toContain('revalidate_campaign_media')
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts + 1)
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })
    expect(row.name).toBe('Zentolia Otoño 2026')
    expect(row.endDate?.toISOString().slice(0, 10)).toBe('2027-01-15')
  })

  it('refuses an end before the start and calls nothing when nothing changes', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]')
    const early = await asAda(updateCampaign, { campaignId: fx.main, endDate: '2026-09-01' })
    expect(early.isError).toBe(true)
    expect(early.text).toContain('no puede ser anterior a la de inicio (2026-10-01)')
    const same = await asAda(updateCampaign, { campaignId: fx.main, name: 'Zentolia Otoño 2026' })
    expect(same.data).toMatchObject({ changed: [] })
    const nothing = await asAda(updateCampaign, { campaignId: fx.main })
    expect(nothing.isError).toBe(true)
    const missing = await asAda(updateCampaign, { campaignId: 'no-existe', name: 'x' })
    expect(missing.text).toContain('No existe ninguna campaña con ese id')
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts)
  })
})

// ============ set_campaign_status ============

describe('set_campaign_status', () => {
  it('up to five campaigns: runs at once and reports before and after', async () => {
    const [a, b] = fx.statusIds
    const answer = await asAda(setCampaignStatus, { campaignIds: [a, b], status: 'PAUSED' })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ status: 'PAUSED', changed: 2, failed: 0 })
    expect(answer.data.results).toEqual([
      { id: a, name: 'Estado 1', before: 'ACTIVE', after: 'PAUSED', result: 'cambiada' },
      { id: b, name: 'Estado 2', before: 'ACTIVE', after: 'PAUSED', result: 'cambiada' },
    ])
    expect(answer.data.notice).toContain('se detiene')
    expect(await prisma.campaign.count({ where: { id: { in: [a, b] }, status: 'PAUSED' } })).toBe(2)
  })

  it('more than five: a preview and a token first; a token for other arguments runs nothing; the right one runs once', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]')
    const args = { campaignIds: fx.statusIds, status: 'ARCHIVED' }
    const first = await asAda(setCampaignStatus, args)
    expect(first.data.needsConfirmation).toBe(true)
    expect(first.data.preview).toContain('Vas a poner 6 campañas en estado archivada')
    expect(first.data.preview).toContain('«Estado 1» (pausada)')
    expect(first.data.preview).toContain('«Estado 6» (activa)')
    expect(first.data.preview).toContain('no se borra nada y se puede revertir')
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts)

    const other = await asAda(setCampaignStatus, { ...args, status: 'PAUSED', confirmToken: first.data.confirmToken })
    expect(other.data.needsConfirmation).toBe(true)
    expect(other.data.notice).toBeDefined()
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts)
    expect(await prisma.campaign.count({ where: { id: { in: fx.statusIds }, status: 'ARCHIVED' } })).toBe(0)

    const run = await asAda(setCampaignStatus, { ...args, confirmToken: first.data.confirmToken })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ status: 'ARCHIVED', changed: 6, failed: 0 })
    expect(await prisma.campaign.count({ where: { id: { in: fx.statusIds }, status: 'ARCHIVED' } })).toBe(6)
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts + 6)
    expect((await lastLog()).argsSummary).toMatch(/^\[bulk:execute http=(200,){5}200\] status=ARCHIVED campaigns=6/)

    const reused = await asAda(setCampaignStatus, { ...args, confirmToken: first.data.confirmToken })
    expect(reused.isError || reused.data.needsConfirmation).toBe(true)
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts + 6)
  })

  it('refuses unknown campaigns and changes none', async () => {
    const answer = await asAda(setCampaignStatus, { campaignIds: [fx.statusIds[0], 'no-existe'], status: 'ACTIVE' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('no-existe')
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fx.statusIds[0] } })).status).toBe('ARCHIVED')
  })
})

// ============ set_campaign_tracking_targets ============

describe('set_campaign_tracking_targets', () => {
  it('replaces only the lists given and shows the three lists before and after', async () => {
    const answer = await asAda(setCampaignTrackingTargets, { campaignId: fx.main, targetHashtags: ['#zentolia', 'zentoliaotono'], targetKeywords: ['Crema Zentolia Nocturna'] })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({
      before: { accounts: ['zentolia.es'], hashtags: ['zentolia'], productKeywords: [] },
      after: { accounts: ['zentolia.es'], hashtags: ['zentolia', 'zentoliaotono'], productKeywords: ['crema zentolia nocturna'] },
      notice: 'Los contenidos ya capturados no cambian hasta que se rastree o se revalide la campaña.',
    })
  })

  it("relays the platform refusal of a creator's handle as a brand account", async () => {
    const answer = await asAda(setCampaignTrackingTargets, { campaignId: fx.main, targetAccounts: ['zentolia.es', `marta_${tag}`] })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('Las Cuentas de Marca Objetivo son las cuentas de la MARCA')
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })).targetAccounts).toEqual(['zentolia.es'])
  })

  it('leaving a campaign with no rule at all needs allowNoTargets', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]')
    const refused = await asAda(setCampaignTrackingTargets, { campaignId: fx.bare, targetHashtags: null })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('allowNoTargets: true')
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts)
    const allowed = await asAda(setCampaignTrackingTargets, { campaignId: fx.bare, targetHashtags: [], allowNoTargets: true })
    expect(allowed.isError).toBe(false)
    expect(allowed.data.after).toEqual({ accounts: [], hashtags: [], productKeywords: [] })
  })
})

// ============ set_campaign_goals ============

describe('set_campaign_goals', () => {
  it('frozen targets: a change needs a reason, which is appended to the permanent log', async () => {
    const refused = await asAda(setCampaignGoals, { campaignId: fx.main, targetViews: 200000 })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('Las metas están congeladas desde el 2026-10-01')
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })).targetViews).toBe(100000)

    const answer = await asAda(setCampaignGoals, { campaignId: fx.main, targetViews: 200000, targetsChangeReason: 'El cliente amplía la campaña' })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ changed: ['targetViews'], before: { targetViews: 100000 }, after: { targetViews: 200000 } })
    expect(answer.data.notes[0]).toBe('El cambio queda anotado de forma permanente en el historial de objetivos con el motivo: El cliente amplía la campaña.')
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })
    const log = row.targetsChangeLog as { field: string; from: number; to: number; reason: string }[]
    expect(log.at(-1)).toMatchObject({ field: 'targetViews', from: 100000, to: 200000, reason: 'El cliente amplía la campaña' })
    // The reason is free text: it never reaches the call log
    expect((await lastLog()).argsSummary).not.toContain('amplía')
  })

  it('the maximum CPM is money: shown only with includeEconomics', async () => {
    const hidden = await asAda(setCampaignGoals, { campaignId: fx.main, targetCpmMax: 15, targetsChangeReason: 'Nuevo acuerdo' })
    expect(hidden.isError).toBe(false)
    expect(hidden.data.changed).toEqual(['targetCpmMax'])
    expect(hidden.data.before).toEqual({})
    expect(hidden.data.after).toEqual({})
    expect(hidden.data.notes).toContain(
      'Guardado: targetCpmMax. Es una cifra económica interna: su valor solo se muestra cuando la herramienta se llama con includeEconomics: true. No hace falta repetir la llamada.',
    )
    // No generic "call again" note: calling a write tool again is not a read
    expect(hidden.data._notes).toBeUndefined()
    expect(hidden.text).not.toContain('12.5')
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })).targetCpmMax).toBe(15)
    const shown = await asAda(setCampaignGoals, { campaignId: fx.main, targetCpmMax: 16, targetsChangeReason: 'Otro acuerdo', includeEconomics: true })
    expect(shown.data).toMatchObject({ before: { targetCpmMax: 15 }, after: { targetCpmMax: 16 } })
    expect(shown.data._notes[0]).toContain('Internal agency figures')
  })

  it('never leaves a campaign without objective or without any numeric target', async () => {
    const noObjective = await asAda(setCampaignGoals, { campaignId: fx.main, objective: null })
    expect(noObjective.isError).toBe(true)
    expect(noObjective.text).toContain('debe tener objetivo')
    const noTargets = await asAda(setCampaignGoals, { campaignId: fx.main, targetViews: null, targetCpmMax: null, targetsChangeReason: 'Sin metas' })
    expect(noTargets.isError).toBe(true)
    expect(noTargets.text).toContain('al menos una meta numérica')
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })
    expect(row).toMatchObject({ objective: 'awareness', targetViews: 200000, targetCpmMax: 16 })
  })
})

// ============ record_business_results ============

describe('record_business_results', () => {
  it('saves the figures the person gives; revenue only travels back with includeEconomics; free text never reaches the log', async () => {
    const answer = await asAda(recordBusinessResults, {
      campaignId: fx.main,
      promoCode: 'ZENTO10',
      codeRedemptions: 42,
      clientReportedRevenue: 1234.5,
      businessResultsReportedAt: '2026-11-10',
      businessResultsNotes: 'Datos del Shopify del cliente',
    })
    expect(answer.isError).toBe(false)
    expect(answer.data.saved).toEqual({ promoCode: 'ZENTO10', codeRedemptions: 42, businessResultsReportedAt: '2026-11-10', businessResultsNotes: 'Datos del Shopify del cliente' })
    expect(answer.data.before).toEqual({ promoCode: null, codeRedemptions: null, businessResultsReportedAt: null, businessResultsNotes: null })
    expect(answer.data.notice).toBe('Visibles en el apartado de negocio del informe y del portal del cliente.')
    expect(answer.data.notes[0]).toContain('Guardado: clientReportedRevenue.')
    expect(answer.data._notes).toBeUndefined()
    expect(answer.text).not.toContain('1234.5')
    const row = await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })
    expect(row).toMatchObject({ promoCode: 'ZENTO10', codeRedemptions: 42, clientReportedRevenue: 1234.5, businessResultsNotes: 'Datos del Shopify del cliente' })
    const log = (await lastLog()).argsSummary
    expect(log).toBe(`[none:execute http=200] campaignId=${fx.main} fields=code,redemptions,revenue,reportedAt,notes`)
    expect(log).not.toContain('ZENTO10')
    expect(log).not.toContain('Shopify')

    const withMoney = await asAda(recordBusinessResults, { campaignId: fx.main, clientReportedRevenue: 2000, promoCode: null, includeEconomics: true })
    expect(withMoney.data.saved).toEqual({ promoCode: null, clientReportedRevenue: 2000 })
    expect(withMoney.data.before).toEqual({ promoCode: 'ZENTO10', clientReportedRevenue: 1234.5 })
  })
})

// ============ set_campaign_access ============

describe('set_campaign_access', () => {
  it('grant runs at once, notifies in the platform only, and is idempotent', async () => {
    const answer = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.laura, action: 'grant' })
    expect(answer.isError).toBe(false)
    expect(answer.data).toMatchObject({ result: 'acceso dado', person: { id: fx.laura, name: 'Laura Gestora' } })
    expect(await prisma.campaignAssignment.findUnique({ where: { campaignId_userId: { campaignId: fx.main, userId: fx.laura } } })).not.toBeNull()
    expect(await prisma.notification.count({ where: { userId: fx.laura, type: 'campaign_access' } })).toBe(1)
    const again = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.laura, action: 'grant' })
    expect(again.data.result).toBe('ya lo tenía')
    expect(await prisma.notification.count({ where: { userId: fx.laura, type: 'campaign_access' } })).toBe(1)
    expect(answer.text).not.toContain('@correo-inventado.test')
  })

  it('refuses someone who is not active staff and lists who can be added, without e-mails', async () => {
    const answer = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.portalUser, action: 'grant' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain(`Laura Gestora (${fx.laura})`)
    expect(answer.text).not.toContain('correo-inventado')
  })

  it('revoke waits for the administrator, then removes the access once; the creator always keeps it', async () => {
    const first = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.laura, action: 'revoke' })
    expect(first.data.needsApproval).toBe(true)
    expect(first.data.preview).toBe('Vas a quitar a Laura Gestora del equipo de «Zentolia Otoño 2026»: dejará de verla en su lista y de recibir sus avisos. Se puede volver a dar. ¿Confirmas?')
    const still = () => prisma.campaignAssignment.findUnique({ where: { campaignId_userId: { campaignId: fx.main, userId: fx.laura } } })
    expect(await still()).not.toBeNull()
    await approve(first.data.actionId)
    const run = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.laura, action: 'revoke', actionId: first.data.actionId })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ result: 'acceso quitado', person: { id: fx.laura, name: 'Laura Gestora' } })
    expect(await still()).toBeNull()

    const owner = await asAda(setCampaignAccess, { campaignId: fx.main, userId: fx.ada, action: 'revoke' })
    expect(owner.isError).toBe(true)
    expect(owner.text).toContain('conserva el acceso')
    expect(await prisma.mcpPendingAction.count({ where: { grantId: fx.grantAda, tool: 'set_campaign_access', status: 'pending' } })).toBe(0)
  })
})

// ============ set_report_visibility ============

describe('set_report_visibility', () => {
  it('hides a few pieces at once and keeps what was hidden before', async () => {
    const [m0, m1] = fx.mainMedia
    const answer = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: [m0, m1] })
    expect(answer.isError).toBe(false)
    expect(answer.data.hidden.publications.map((p: { id: string }) => p.id)).toEqual([m0, m1])
    expect(answer.data.hidden.publications[0].label).toBe(`REEL de @marta_${tag} (2026-10-10)`)
    expect(answer.data.nowHiddenInReport.publications).toBe(2)
    expect(answer.data.notice).toContain('El cliente lo ve de inmediato')
    expect((await reportConfig(fx.main)).hiddenMediaIds).toEqual([m0, m1])
  })

  it('refuses ids of another campaign and ids both to hide and to show', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]/report-config')
    const foreign = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: [fx.otherMedia] })
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toContain(`publicaciones que no son de esta campaña: ${fx.otherMedia}`)
    const notMember = await asAda(setReportVisibility, { campaignId: fx.main, hideInfluencerIds: [fx.nora] })
    expect(notMember.isError).toBe(true)
    const both = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: [fx.mainMedia[2]], showMediaIds: [fx.mainMedia[2]] })
    expect(both.isError).toBe(true)
    expect(callsTo('PUT', '/api/campaigns/[id]/report-config')).toBe(puts)
  })

  it('more than five pieces: a preview first; a change in between makes the token stale; the right one saves', async () => {
    const six = fx.mainMedia.slice(2, 8)
    const first = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: six })
    expect(first.data.needsConfirmation).toBe(true)
    expect(first.data.preview).toContain('Vas a OCULTAR en el informe de cliente de «Zentolia Otoño 2026»: 6 publicaciones')
    expect((await reportConfig(fx.main)).hiddenMediaIds).toHaveLength(2)

    // Someone shows a piece in between: the stored lists changed, the token no longer describes them
    const between = await asAda(setReportVisibility, { campaignId: fx.main, showMediaIds: [fx.mainMedia[0]] })
    expect(between.data.shown.publications.map((p: { id: string }) => p.id)).toEqual([fx.mainMedia[0]])
    const stale = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: six, confirmToken: first.data.confirmToken })
    expect(stale.data.needsConfirmation).toBe(true)
    expect(stale.data.notice).toBeDefined()
    expect((await reportConfig(fx.main)).hiddenMediaIds).toEqual([fx.mainMedia[1]])

    const run = await asAda(setReportVisibility, { campaignId: fx.main, hideMediaIds: six, confirmToken: stale.data.confirmToken })
    expect(run.isError).toBe(false)
    expect((await reportConfig(fx.main)).hiddenMediaIds).toEqual([fx.mainMedia[1], ...six])
  })

  it('creators, sections and columns: hidden and shown again, only what changes', async () => {
    const answer = await asAda(setReportVisibility, { campaignId: fx.main, hideInfluencerIds: [fx.luis], hideSections: ['sentiment'], hideColumns: ['creators.cpm'] })
    expect(answer.isError).toBe(false)
    expect(answer.data.hidden).toMatchObject({ creators: [{ id: fx.luis, label: `@luis_${tag}` }], sections: ['sentiment'], columns: ['creators.cpm'] })
    let cfg = await reportConfig(fx.main)
    expect(cfg).toMatchObject({ hiddenInfluencerIds: [fx.luis], hiddenSections: ['sentiment'], hiddenColumns: ['creators.cpm'] })
    const back = await asAda(setReportVisibility, { campaignId: fx.main, showInfluencerIds: [fx.luis], showSections: ['sentiment', 'business'] })
    expect(back.data.shown).toMatchObject({ creators: [{ id: fx.luis }], sections: ['sentiment'] })
    cfg = await reportConfig(fx.main)
    expect(cfg).toMatchObject({ hiddenInfluencerIds: [], hiddenSections: [], hiddenColumns: ['creators.cpm'] })
    expect(cfg.hiddenMediaIds).toHaveLength(7)
  })
})

// ============ edit_report_content ============

describe('edit_report_content', () => {
  it('saves texts and comments, returning what was there before', async () => {
    const answer = await asAda(editReportContent, {
      campaignId: fx.main,
      title: 'Zentolia, otoño 2026',
      intro: 'Resumen para el cliente.',
      highlightedComments: [{ text: 'Me encanta esta crema', author: '@ana', sentiment: 'positive', mediaId: fx.mainMedia[0] }],
    })
    expect(answer.isError).toBe(false)
    expect(answer.data.changed).toEqual(['title', 'intro', 'highlightedComments'])
    expect(answer.data.before).toEqual({ title: null, intro: null, highlightedComments: [] })
    expect(answer.data.saved).toEqual({
      title: 'Zentolia, otoño 2026',
      intro: 'Resumen para el cliente.',
      highlightedComments: [{ id: 'c1', text: 'Me encanta esta crema', author: 'ana', sentiment: 'positive', mediaId: fx.mainMedia[0] }],
    })
    expect(answer.data.notice).toBe('Visible ya para el cliente en el portal y en el PDF.')
    // Untouched parts stay (the hidden pieces of the previous tests)
    expect((await reportConfig(fx.main)).hiddenMediaIds).toHaveLength(7)
  })

  it('refuses a comment linked to a publication of another campaign', async () => {
    const answer = await asAda(editReportContent, { campaignId: fx.main, highlightedComments: [{ text: 'Otro', mediaId: fx.otherMedia }] })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain(fx.otherMedia)
    expect((await reportConfig(fx.main)).highlightedComments).toHaveLength(1)
  })

  it("'Prometido vs entregado': a row given replaces that row, the rest is kept, null returns to automatic", async () => {
    await asAda(editReportContent, { campaignId: fx.main, delivery: { overrides: { disclosure: { ok: true, note: 'Todas con #publi' } } } })
    let d = (await reportConfig(fx.main)).delivery
    expect(d).toEqual({ overrides: { disclosure: { ok: true, note: 'Todas con #publi' } }, extraRows: [] })

    await asAda(editReportContent, { campaignId: fx.main, delivery: { extraRows: [{ label: 'Exclusividad', value: '12 meses', ok: true }] } })
    d = (await reportConfig(fx.main)).delivery
    expect(d).toEqual({ overrides: { disclosure: { ok: true, note: 'Todas con #publi' } }, extraRows: [{ id: 'd1', label: 'Exclusividad', value: '12 meses', ok: true }] })

    await asAda(editReportContent, { campaignId: fx.main, delivery: { overrides: { pieces: { planned: 12 }, disclosure: null } } })
    d = (await reportConfig(fx.main)).delivery
    expect(d).toEqual({ overrides: { pieces: { planned: 12 } }, extraRows: [{ id: 'd1', label: 'Exclusividad', value: '12 meses', ok: true }] })

    const reset = await asAda(editReportContent, { campaignId: fx.main, delivery: null })
    expect(reset.data.before.delivery.overrides).toEqual({ pieces: { planned: 12 } })
    expect((await reportConfig(fx.main)).delivery).toEqual({ overrides: {}, extraRows: [] })
  })
})

// ============ mark_report_sent ============

describe('mark_report_sent', () => {
  it('records numbered entries, sends nothing, and refuses a second one within ten minutes unless confirmed', async () => {
    const first = await asAda(markReportSent, { campaignId: fx.main, note: 'Enviado a marketing' })
    expect(first.isError).toBe(false)
    expect(first.data).toMatchObject({ version: 1, recordedBy: 'Ada Admin', note: 'Enviado a marketing' })
    expect(first.data.message).toBe('Anotado el envío n.º 1 del informe de «Zentolia Otoño 2026». Desde aquí no se ha enviado nada al cliente.')

    const retry = await asAda(markReportSent, { campaignId: fx.main })
    expect(retry.isError).toBe(true)
    expect(retry.text).toContain('Ya se anotó el envío n.º 1')
    expect((await reportConfig(fx.main)).sentVersions).toHaveLength(1)

    const second = await asAda(markReportSent, { campaignId: fx.main, repeatSend: true })
    expect(second.data.version).toBe(2)
    expect((await reportConfig(fx.main)).sentVersions).toHaveLength(2)
    expect(h.mail).toEqual([])
  })
})

// ============ revalidate_campaign_media ============

describe('revalidate_campaign_media', () => {
  it('the preview says how many pieces would leave and why; once approved, the platform takes out exactly those', async () => {
    const posts = callsTo('POST', '/api/campaigns/[id]/revalidate-media')
    const first = await asAda(revalidateCampaignMedia, { campaignId: fx.reval })
    expect(first.data.needsApproval).toBe(true)
    const p = first.data.preview as string
    expect(p).toContain('Vas a revalidar los 5 contenidos de «Zentolia Revalida»')
    expect(p).toContain('hashtags zentolia')
    expect(p).toContain('fechas del 2026-10-01 al 2026-10-31; 2 creadoras')
    expect(p).toContain('Con los datos de ahora saldrían 3: 2 se desvincularían y 1 se borrarían porque hay otra copia.')
    expect(p).toContain('fuera de fechas')
    expect(p).toContain('no menciona la marca')
    expect(p).toContain('ya no es creadora de la campaña')
    expect(callsTo('POST', '/api/campaigns/[id]/revalidate-media')).toBe(posts)
    expect(await prisma.media.count({ where: { campaignId: fx.reval } })).toBe(5)

    await approve(first.data.actionId)
    const run = await asAda(revalidateCampaignMedia, { campaignId: fx.reval, actionId: first.data.actionId })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ kept: 2, removed: 3, targetsConfigured: true })
    expect(callsTo('POST', '/api/campaigns/[id]/revalidate-media')).toBe(posts + 1)
    const left = await prisma.media.findMany({ where: { campaignId: fx.reval }, select: { id: true } })
    expect(left.map(m => m.id).sort()).toEqual([fx.r.r1, fx.r.r5].sort())
    expect((await prisma.media.findUniqueOrThrow({ where: { id: fx.r.r2 } })).campaignId).toBeNull()
    expect(await prisma.media.findUnique({ where: { id: fx.r.r3 } })).toBeNull()
    expect((await prisma.media.findUniqueOrThrow({ where: { id: fx.r.r4 } })).campaignId).toBeNull()
    expect(await prisma.media.findUnique({ where: { id: fx.r.r3copy } })).not.toBeNull()
  })
})

// ============ delete_campaign ============

describe('delete_campaign', () => {
  it('an unknown campaign is refused and leaves no pending action', async () => {
    const before = await prisma.mcpPendingAction.count({ where: { grantId: fx.grantAda } })
    const answer = await asAda(deleteCampaign, { campaignId: 'no-existe' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('No existe ninguna campaña con ese id')
    expect(await prisma.mcpPendingAction.count({ where: { grantId: fx.grantAda } })).toBe(before)
  })

  it('counts what goes in the preview, waits for the administrator, deletes once', async () => {
    const first = await asAda(deleteCampaign, { campaignId: fx.doomed })
    expect(first.data.needsApproval).toBe(true)
    expect(first.data.approveUrl).toBe(`${SITE}/mcp/confirmar/${first.data.actionId}`)
    expect(first.data.preview).toBe(
      'Vas a BORRAR DEFINITIVAMENTE la campaña «Zentolia Borrar» (sin marca, activa, del 2026-10-01 al 2026-12-31). ' +
        'Se eliminan: 2 creadoras con sus fees, condiciones y direcciones de envío; 1 publicaciones y 1 stories con sus métricas y comentarios; ' +
        '1 archivos de brief; 1 notas internas y el equipo asignado (1 persona). No se puede deshacer y no hay copia. Alternativa sin pérdida: archivarla. ¿Confirmas el borrado?',
    )
    expect(callsTo('DELETE', '/api/campaigns/[id]')).toBe(0)
    expect(await prisma.campaign.findUnique({ where: { id: fx.doomed } })).not.toBeNull()

    // Cancelled by someone else? Only its administrator decides
    expect(await decidePendingAction({ id: first.data.actionId, deciderId: fx.bea, decision: 'approve' })).toEqual({ ok: false, reason: 'foreign' })
    await approve(first.data.actionId)
    const run = await asAda(deleteCampaign, { campaignId: fx.main, actionId: first.data.actionId }) // other id sent: the STORED one runs
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ deleted: true, campaign: { id: fx.doomed, name: 'Zentolia Borrar' }, confirmedAction: { ranWithStoredArguments: true } })
    expect(await prisma.campaign.findUnique({ where: { id: fx.doomed } })).toBeNull()
    expect(await prisma.campaignNote.count({ where: { campaignId: fx.doomed } })).toBe(0)
    expect(await prisma.campaign.findUnique({ where: { id: fx.main } })).not.toBeNull()
    expect(callsTo('DELETE', '/api/campaigns/[id]')).toBe(1)
    expect((await lastLog()).argsSummary).toBe(`[destructive:execute http=200] campaignId=${fx.doomed} actionId=${first.data.actionId}`)
  })
})

// ============ Who may write ============

describe('who may write', () => {
  it('a connection authorised before the write layer is read-only and is told to reconnect', async () => {
    const puts = callsTo('PUT', '/api/campaigns/[id]')
    const answer = await call(updateCampaign, fx.grantReadOnly, fx.ada, { campaignId: fx.main, name: 'Pirata' })
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('solo lectura')
    expect(callsTo('PUT', '/api/campaigns/[id]')).toBe(puts)
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fx.main } })).name).toBe('Zentolia Otoño 2026')
  })

  it('every call leaves exactly one log line, refused ones included', async () => {
    const count = () => prisma.mcpCallLog.count({ where: { grantId: fx.grantAda } })
    const before = await count()
    await asAda(updateCampaign, { campaignId: fx.main, isPinned: false })
    await asAda(updateCampaign, { campaignId: fx.main, endDate: '2020-01-01' })
    await asAda(updateCampaign, { campaignId: fx.main, bogus: 1, name: '' })
    expect(await count()).toBe(before + 3)
  })
})
