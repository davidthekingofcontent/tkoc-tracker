import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, no public address, no Apify token.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-write-creators'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
  return {
    apify: { configured: true, exhausted: false, usedPct: 40 as number | null, optionalBlocked: false, coreBlocked: false },
    /** Every paid profile read the platform asked for, as `PLATFORM:username`. */
    scrapes: [] as string[],
    singlePosts: [] as string[],
    mail: [] as { to: string; inviterName: string; campaignName: string }[],
  }
})

// Apify: nothing leaves the machine; every paid read is recorded
vi.mock('@/lib/apify', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  const profile = (username: string) => ({
    username, displayName: `Perfil ${username}`, bio: null, avatarUrl: null, followers: 12_345, following: 10, postsCount: 5,
    engagementRate: 2.5, avgLikes: 100, avgComments: 5, avgViews: 1000, isVerified: false, website: null, email: null,
    country: 'ES', city: null, recentPosts: [],
  })
  return {
    ...actual,
    isApifyConfigured: () => h.apify.configured,
    isApifyConfiguredAsync: async () => h.apify.configured,
    isApifyExhausted: () => h.apify.exhausted,
    getApifyResumeDate: () => (h.apify.exhausted ? '2026-12-01T00:00:00.000Z' : null),
    getApifyBudget: async () => ({
      usd: null, limit: null, cycleEndsAt: '2026-12-01T00:00:00.000Z', softLimit: null, coreLimit: null,
      optionalBlocked: h.apify.optionalBlocked, coreBlocked: h.apify.coreBlocked, usedPct: h.apify.usedPct,
    }),
    scrapeProfile: async (username: string, platform: string) => {
      h.scrapes.push(`${platform}:${username}`)
      return profile(username)
    },
    scrapeStories: async () => [],
    scrapeSinglePost: async (url: string) => {
      h.singlePosts.push(url)
      return null
    },
    scrapeHashtag: async () => [],
    scrapeAccountMentions: async () => [],
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
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { MCP_RESOURCE } from '@/lib/mcp/config'
import { decidePendingAction } from '@/lib/mcp/confirm'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { createGrantAndCode, registerClient } from '@/lib/mcp/oauth'
import { setPlatformTransport } from '@/lib/mcp/platform-client'
import { isTokenClass, isApprovalClass } from '@/lib/mcp/confirm'
import type { WriteTool } from '@/lib/mcp/write-tool'
import {
  CREATOR_WRITE_TOOLS,
  addCreatorNote,
  addCreatorsToCampaign,
  analyzeCreatorProfile,
  createCreatorManually,
  importCreatorsToDatabase,
  inviteCreatorToConnect,
  moveCreatorsBetweenCampaigns,
  registerCreatorWriteTools,
  removeCreatorFromCampaign,
  runPaidCreatorSearch,
  saveContactAddress,
  setCreatorShipping,
  setCreatorStatus,
  updateCreatorDeal,
  updateCreatorProfile,
} from '@/lib/mcp/tools/write/creators'
import {
  PUBLICATION_WRITE_TOOLS,
  addPublicationsByUrl,
  correctPublicationMetrics,
  registerPublicationWriteTools,
  registerStories,
  tagPublications,
} from '@/lib/mcp/tools/write/publications'
import { LIST_WRITE_TOOLS, addCreatorsToList, createList, deleteList, registerListWriteTools, removeCreatorsFromList, updateList } from '@/lib/mcp/tools/write/lists'
import {
  TRACKING_WRITE_TOOLS,
  launchCampaignTracking,
  registerTrackingWriteTools,
  resetTrackingRuns,
  syncInstagramConnection,
} from '@/lib/mcp/tools/write/tracking'
import { revalidateCampaignMedia } from '@/lib/mcp/tools/write/campaigns'
import { createPlatformRouter } from '../helpers/platform-router'

const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const tag = randomUUID().slice(0, 8)
const router = createPlatformRouter()
const DAY = 24 * 60 * 60_000

const ALL_TOOLS: readonly WriteTool[] = [...CREATOR_WRITE_TOOLS, ...PUBLICATION_WRITE_TOOLS, ...LIST_WRITE_TOOLS, ...TRACKING_WRITE_TOOLS]

// ============ Fixtures (invented data) ============

const fx = {
  ada: { id: '', name: 'Ada Admin' },
  bea: { id: '' },
  emp: { id: '' },
  campaignA: '',
  campaignAName: `Campaña Creadoras ${tag}`,
  campaignT: '',
  campaignB: '',
  campaignP: '',
  marta: '', luis: '', nora: '', rita: '', rosa: '', tina: '', fresca: '', vieja: '',
  extras: [] as string[],
  martaReel: '',
  listId: '',
  /** Campaigns of the tests of the fixes (12 Nov 2026), removed with the others. */
  more: [] as string[],
}
const created = { users: [] as string[], influencers: [] as string[], grants: [] as string[] }
const handle = (name: string) => `${name}_${tag}`

let ipCounter = 0
async function grantFor(userId: string): Promise<string> {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, `203.0.113.${++ipCounter}-${tag}`)
  const { grantId } = await createGrantAndCode({ userId, clientId: client.client_id, redirectUri: CLAUDE_AI, codeChallenge: pkceChallengeS256(randomSecret()) })
  await prisma.mcpToken.create({ data: { grantId, kind: 'access', tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'), expiresAt: new Date(Date.now() + 3_600_000) } })
  created.grants.push(grantId)
  return grantId
}

interface Answer {
  isError: boolean
  text: string
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(tool: WriteTool, grantId: string, args: Record<string, unknown>, userId = fx.ada.id): Promise<Answer> {
  const res = await tool.call(args, { grantId, userId })
  const text = res.content[0]?.type === 'text' ? res.content[0].text : ''
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}

const membership = (campaignId: string, influencerId: string) =>
  prisma.campaignInfluencer.findUnique({ where: { campaignId_influencerId: { campaignId, influencerId } } })
// Two lines can share a millisecond: the cuid of the newer one sorts after (it carries a counter)
const lastLog = (grantId: string) => prisma.mcpCallLog.findFirstOrThrow({ where: { grantId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
const callsTo = (method: string, pattern: string) => router.calls.filter(c => c.method === method && c.pattern === pattern)
const approve = (id: string) => decidePendingAction({ id, deciderId: fx.ada.id, decision: 'approve' })
/** An Instagram story id (snowflake) published at this instant. */
const storyIdAt = (ms: number) => ((BigInt(ms - 1314220021721) << BigInt(23)) + BigInt(4242)).toString()

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  setPlatformTransport(router.transport)

  const user = (name: string, role: 'ADMIN' | 'EMPLOYEE') =>
    prisma.user.create({ data: { email: `${name.toLowerCase().replace(/\s/g, '.')}-${tag}@correo-inventado.test`, password: 'x', name, role } })
  const [ada, bea, emp] = await Promise.all([user('Ada Admin', 'ADMIN'), user('Bea Admin', 'ADMIN'), user('Pepa Empleada', 'EMPLOYEE')])
  created.users.push(ada.id, bea.id, emp.id)
  Object.assign(fx, { ada: { id: ada.id, name: ada.name }, bea: { id: bea.id }, emp: { id: emp.id } })

  const start = new Date(Date.now() - 40 * DAY)
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(Date.now() + 40 * DAY)
  end.setUTCHours(0, 0, 0, 0)
  const campaign = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.campaign.create({ data: { name, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: start, endDate: end, userId: ada.id, ...extra } })
  const [a, t, b, p] = await Promise.all([
    campaign(fx.campaignAName),
    campaign(`Campaña Rastreo ${tag}`, { targetHashtags: [`marcaprueba${tag}`] }),
    campaign(`Campaña Destino ${tag}`),
    campaign(`Campaña Pausada ${tag}`, { status: 'PAUSED' }),
  ])
  Object.assign(fx, { campaignA: a.id, campaignT: t.id, campaignB: b.id, campaignP: p.id })

  const inf = async (name: string, extra: Record<string, unknown> = {}) => {
    const row = await prisma.influencer.create({ data: { username: handle(name), platform: 'INSTAGRAM', followers: 1000, ...extra } })
    created.influencers.push(row.id)
    return row.id
  }
  fx.marta = await inf('marta', { email: `marta-${tag}@correo-inventado.test`, phone: '+34600111222', standardFee: 7777 })
  fx.luis = await inf('luis')
  fx.nora = await inf('nora')
  fx.rita = await inf('rita')
  fx.rosa = await inf('rosa')
  fx.tina = await inf('tina')
  fx.fresca = await inf('fresca', { followers: 5000, engagementRate: 3, lastScraped: new Date() })
  fx.vieja = await inf('vieja', { followers: 5000, engagementRate: 3, lastScraped: new Date(Date.now() - 3 * DAY) })
  for (let i = 1; i <= 6; i++) fx.extras.push(await inf(`extra${i}`))

  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: a.id, influencerId: fx.marta, status: 'NEGOTIATING', agreedFee: 100, notes: 'nota vieja' },
      { campaignId: a.id, influencerId: fx.luis, status: 'PROSPECT' },
      { campaignId: a.id, influencerId: fx.rita, status: 'NEGOTIATING', agreedFee: 250 },
      { campaignId: a.id, influencerId: fx.rosa, status: 'PROSPECT' },
      ...fx.extras.map(id => ({ campaignId: a.id, influencerId: id, status: 'PROSPECT' as const })),
      { campaignId: t.id, influencerId: fx.tina, status: 'NEGOTIATING' },
    ],
  })
  const inWindow = new Date(Date.now() - 5 * DAY)
  const reel = await prisma.media.create({
    data: { campaignId: a.id, influencerId: fx.marta, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `reel-marta-${tag}`, likes: 50, views: 1000, postedAt: inWindow, source: 'manual' },
  })
  fx.martaReel = reel.id
  await prisma.media.createMany({
    data: [
      { campaignId: a.id, influencerId: fx.rita, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `reel-rita-${tag}`, likes: 9, postedAt: inWindow, source: 'manual' },
      { campaignId: a.id, influencerId: fx.rita, platform: 'INSTAGRAM', mediaType: 'STORY', externalId: `story-rita-${tag}`, views: 30, postedAt: inWindow, source: 'manual' },
    ],
  })
  const list = await prisma.list.create({
    data: { name: `Lista Prueba ${tag}`, userId: ada.id, items: { create: [{ influencerId: fx.marta }, { influencerId: fx.luis }, { influencerId: fx.nora }] } },
  })
  fx.listId = list.id
})

beforeEach(() => {
  Object.assign(h.apify, { configured: true, exhausted: false, usedPct: 40, optionalBlocked: false, coreBlocked: false })
})

afterAll(async () => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
  // Fire-and-forget work of the routes (captures, notifications) settles first
  await new Promise(resolve => setTimeout(resolve, 500))
  const campaigns = [fx.campaignA, fx.campaignT, fx.campaignB, fx.campaignP, ...fx.more]
  const tagged = await prisma.influencer.findMany({ where: { username: { contains: tag } }, select: { id: true } })
  const influencers = [...new Set([...created.influencers, ...tagged.map(r => r.id)])]
  const quiet = async (work: Promise<unknown>) => {
    await work.catch(() => {})
  }
  await quiet(prisma.mcpPendingAction.deleteMany({ where: { grantId: { in: created.grants } } }))
  await quiet(prisma.mcpCallLog.deleteMany({ where: { grantId: { in: created.grants } } }))
  await quiet(prisma.invitation.deleteMany({ where: { invitedBy: { in: created.users } } }))
  await quiet(prisma.campaignNote.deleteMany({ where: { campaignId: { in: campaigns } } }))
  await quiet(prisma.media.deleteMany({ where: { OR: [{ campaignId: { in: campaigns } }, { influencerId: { in: influencers } }] } }))
  await quiet(prisma.campaignInfluencer.deleteMany({ where: { campaignId: { in: campaigns } } }))
  await quiet(prisma.scrapeJob.deleteMany({ where: { OR: [{ campaignId: { in: campaigns } }, { targetUsername: { contains: tag } }] } }))
  await quiet(prisma.listItem.deleteMany({ where: { list: { userId: { in: created.users } } } }))
  await quiet(prisma.list.deleteMany({ where: { userId: { in: created.users } } }))
  await quiet(prisma.contact.deleteMany({ where: { userId: { in: created.users } } }))
  await quiet(prisma.campaign.deleteMany({ where: { id: { in: campaigns } } }))
  await quiet(prisma.creatorPlatformProfile.deleteMany({ where: { OR: [{ username: { contains: tag } }, { influencerId: { in: influencers } }] } }))
  await quiet(prisma.influencer.deleteMany({ where: { id: { in: influencers } } }))
  await quiet(prisma.notification.deleteMany({ where: { userId: { in: created.users } } }))
  await quiet(prisma.mcpToken.deleteMany({ where: { grantId: { in: created.grants } } }))
  await quiet(prisma.mcpAuthCode.deleteMany({ where: { userId: { in: created.users } } }))
  await quiet(prisma.mcpGrant.deleteMany({ where: { userId: { in: created.users } } }))
  await quiet(prisma.user.deleteMany({ where: { id: { in: created.users } } }))
})

// ============ The catalogue ============

describe('the creator, publication, list and tracking tools as the server will register them', () => {
  const EXPECTED = [
    'add_creators_to_campaign', 'set_creator_status', 'update_creator_deal', 'set_creator_shipping', 'remove_creator_from_campaign',
    'move_creators_between_campaigns', 'add_creator_note', 'add_publications_by_url', 'register_stories', 'correct_publication_metrics',
    'tag_publications', 'launch_campaign_tracking', 'sync_instagram_connection', 'analyze_creator_profile', 'import_creators_to_database',
    'run_paid_creator_search', 'update_creator_profile', 'create_creator_manually', 'create_list', 'add_creators_to_list', 'update_list',
    'remove_creators_from_list', 'delete_list', 'save_contact_address', 'invite_creator_to_connect',
  ]

  it('are the 25 tools of the task, once each; link_creator_profile is not among them', () => {
    const names = ALL_TOOLS.map(t => t.name)
    expect([...names].sort()).toEqual([...EXPECTED].sort())
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('link_creator_profile')
  })

  it('the four registration functions hand every tool exactly once', () => {
    const seen: string[] = []
    const register = (t: WriteTool) => seen.push(t.name)
    registerCreatorWriteTools(register)
    registerPublicationWriteTools(register)
    registerListWriteTools(register)
    registerTrackingWriteTools(register)
    expect(seen).toEqual(ALL_TOOLS.map(t => t.name))
  })

  it('each has a short snake_case name, a title, a description for a model and write annotations', () => {
    for (const t of ALL_TOOLS) {
      expect(t.name.length).toBeLessThanOrEqual(64)
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(t.title.trim().length).toBeGreaterThan(5)
      expect(t.description.length).toBeGreaterThan(200)
      expect(t.annotations).toMatchObject({ title: t.title, readOnlyHint: false })
      expect(typeof t.annotations.destructiveHint).toBe('boolean')
    }
  })

  it('each input converts to the JSON schema the MCP SDK sends, with the control fields of its classes', () => {
    for (const t of ALL_TOOLS) {
      const schema = z.toJSONSchema(z.object(t.input), { target: 'draft-7', io: 'input' }) as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['includeContact', 'includeEconomics']))
      expect('confirmToken' in schema.properties).toBe(t.confirmations.some(isTokenClass))
      expect('actionId' in schema.properties).toBe(t.confirmations.some(isApprovalClass))
    }
  })

  it('the deleting tools and the ones that write to a person wait for the administrator in the platform', () => {
    const approval = ALL_TOOLS.filter(t => t.confirmations.some(isApprovalClass)).map(t => t.name).sort()
    expect(approval).toEqual(['delete_list', 'invite_creator_to_connect', 'move_creators_between_campaigns', 'remove_creator_from_campaign', 'remove_creators_from_list'])
    for (const name of approval) expect(ALL_TOOLS.find(t => t.name === name)?.description).toContain('APPROVAL')
  })

  it('no text of these files carries an em-dash', () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'mcp', 'tools', 'write')
    for (const file of ['creators.ts', 'publications.ts', 'lists.ts', 'tracking.ts']) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain('—')
    }
  })
})

// ============ none: update_creator_deal ============

describe('update_creator_deal (none: runs at once and is logged)', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('changes the fee and the deliverables; the fee stays out of the answer without includeEconomics', async () => {
    const a = await call(updateCreatorDeal, grant, { campaignId: fx.campaignA, influencerIds: [fx.marta], agreedFee: 3456, deliverablesPlanned: 3 })
    expect(a.isError).toBe(false)
    expect(a.data.updated).toHaveLength(1)
    expect(a.data.updated[0].changes.deliverablesPlanned).toEqual({ before: null, after: 3 })
    expect(a.data.updated[0].changes.agreedFee).toBeUndefined()
    expect(a.text).not.toContain('3456')
    expect(a.data._notes.join(' ')).toContain('includeEconomics')
    const row = await membership(fx.campaignA, fx.marta)
    expect(row).toMatchObject({ agreedFee: 3456, deliverablesPlanned: 3 })
    const log = await lastLog(grant)
    expect(log).toMatchObject({ tool: 'update_creator_deal', ok: true })
    expect(log.argsSummary).toBe(`[none:execute http=200,200] campaignId=${fx.campaignA} creators=1 fields=agreedFee,deliverablesPlanned`)
  })

  it('with includeEconomics the answer shows the fee before and after', async () => {
    const a = await call(updateCreatorDeal, grant, { campaignId: fx.campaignA, influencerIds: [fx.marta], agreedFee: 4000, includeEconomics: true })
    expect(a.data.updated[0].changes.agreedFee).toEqual({ before: 3456, after: 4000 })
    expect(a.data._notes.join(' ')).toMatch(/internal/i)
  })

  it('refuses text or negative amounts and per-creator fields for several creators, changing nothing', async () => {
    for (const bad of [{ agreedFee: '300' }, { agreedFee: -5 }, { cost: Number.NaN }, { trackedLink: 'javascript:alert(1)' }]) {
      const a = await call(updateCreatorDeal, grant, { campaignId: fx.campaignA, influencerIds: [fx.marta], ...bad })
      expect(a.isError).toBe(true)
      expect(a.text).toBe('Invalid arguments for update_creator_deal.')
    }
    const two = await call(updateCreatorDeal, grant, { campaignId: fx.campaignA, influencerIds: [fx.marta, fx.luis], notes: 'texto' })
    expect(two.isError).toBe(true)
    expect(two.text).toContain('solo se pueden cambiar con una creadora por llamada')
    const outsider = await call(updateCreatorDeal, grant, { campaignId: fx.campaignA, influencerIds: [fx.nora], urgent: true })
    expect(outsider.isError).toBe(true)
    expect(outsider.text).toContain('No es integrante')
    expect(await membership(fx.campaignA, fx.marta)).toMatchObject({ agreedFee: 4000, notes: 'nota vieja' })
  })

  it('more than 5 creators: a preview and a token first, then exactly one run; the old token runs nothing again', async () => {
    const args = { campaignId: fx.campaignA, influencerIds: fx.extras, urgent: true, deliverablesPlanned: 2 }
    const first = await call(updateCreatorDeal, grant, args)
    expect(first.data).toMatchObject({ needsConfirmation: true })
    expect(first.data.preview).toContain('Vas a aplicar a 6 creadoras')
    expect(first.data.preview).toContain('urgente: sí')
    expect((await membership(fx.campaignA, fx.extras[0]))?.urgent).toBe(false)
    const patches = callsTo('PATCH', '/api/campaigns/[id]/influencers').length
    const second = await call(updateCreatorDeal, grant, { ...args, confirmToken: first.data.confirmToken })
    expect(second.isError).toBe(false)
    expect(second.data.updated).toHaveLength(6)
    expect(callsTo('PATCH', '/api/campaigns/[id]/influencers').length).toBe(patches + 6)
    for (const id of fx.extras) expect(await membership(fx.campaignA, id)).toMatchObject({ urgent: true, deliverablesPlanned: 2 })
    // The values it showed have changed: the same token only gets a new preview, nothing runs
    const again = await call(updateCreatorDeal, grant, { ...args, confirmToken: first.data.confirmToken })
    expect(again.data).toMatchObject({ needsConfirmation: true })
    expect(again.data.notice).toContain('No se ha hecho nada')
    expect(callsTo('PATCH', '/api/campaigns/[id]/influencers').length).toBe(patches + 6)
  })
})

// ============ money: add_creators_to_campaign ============

describe('add_creators_to_campaign (money: preview first, one paid run with the right token)', () => {
  let grant = ''
  const nueva = handle('nueva')
  const args = () => ({
    campaignId: fx.campaignA,
    handles: [`@${nueva.toUpperCase()}`, `@${handle('luis').toUpperCase()}`, `https://www.instagram.com/${handle('nora').toUpperCase()}/`],
  })
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('the first call spends nothing, adds nobody and says who is new, who is known and who is already in', async () => {
    const before = callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length
    const a = await call(addCreatorsToCampaign, grant, args())
    expect(a.isError).toBe(false)
    expect(a.data).toMatchObject({ needsConfirmation: true, validForMinutes: 5 })
    const preview: string = a.data.preview
    expect(preview).toContain(`Vas a añadir 2 creadoras a «${fx.campaignAName}» como Prospecto`)
    expect(preview).toContain(`Ya están en la base de datos: @${handle('nora')} (Instagram)`)
    expect(preview).toContain(`Nuevas, hay que buscarlas en Apify: @${nueva} (Instagram) (una lectura de perfil cada una)`)
    expect(preview).toContain(`Ya en la campaña, se omiten: @${handle('luis')} (Instagram)`)
    expect(preview).toContain('Gasto: hasta 1 lectura de perfil de Apify (uso actual del plan: 40 %)')
    expect(preview).not.toMatch(/\d\s?(€|\$|USD|EUR)/)
    expect(callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length).toBe(before)
    expect(h.scrapes.filter(s => s.toLowerCase().includes(nueva))).toEqual([])
    expect(await membership(fx.campaignA, fx.nora)).toBeNull()
    expect((await lastLog(grant)).argsSummary).toMatch(/^\[money:preview http=200,200\] campaignId=\S+ handles=3$/)
  })

  it('a forged token or other arguments get a new preview and run nothing', async () => {
    const first = await call(addCreatorsToCampaign, grant, args())
    const forged = await call(addCreatorsToCampaign, grant, { ...args(), confirmToken: `${first.data.confirmToken.slice(0, -4)}AAAA` })
    expect(forged.data).toMatchObject({ needsConfirmation: true })
    expect(forged.data.notice).toContain('No se ha hecho nada')
    const other = await call(addCreatorsToCampaign, grant, { ...args(), platform: 'INSTAGRAM', confirmToken: first.data.confirmToken })
    expect(other.data).toMatchObject({ needsConfirmation: true })
    expect(await membership(fx.campaignA, fx.nora)).toBeNull()
    expect(h.scrapes.filter(s => s.toLowerCase().includes(nueva))).toEqual([])
  })

  it('the right token adds them once: the known creator by her stored handle, the new one read once in lower case', async () => {
    const first = await call(addCreatorsToCampaign, grant, args())
    const run = await call(addCreatorsToCampaign, grant, { ...args(), confirmToken: first.data.confirmToken })
    expect(run.isError).toBe(false)
    expect(run.data.added).toBe(2)
    const results = Object.fromEntries(run.data.creators.map((c: { handle: string; result: string }) => [c.handle, c.result]))
    expect(results).toEqual({ [`@${handle('nora')}`]: 'added', [`@${nueva}`]: 'created_and_added' })
    expect(await membership(fx.campaignA, fx.nora)).toMatchObject({ status: 'PROSPECT' })
    const created = await prisma.influencer.findMany({ where: { username: { equals: nueva, mode: 'insensitive' } } })
    expect(created.map(c => c.username)).toEqual([nueva])
    expect(await prisma.influencer.count({ where: { username: { equals: handle('nora'), mode: 'insensitive' } } })).toBe(1)
    expect(h.scrapes.filter(s => s.toLowerCase().includes(nueva))).toEqual([`INSTAGRAM:${nueva}`])
    expect((await lastLog(grant)).argsSummary).toMatch(/^\[money:execute http=200,200,200\] /)

    // Again with the same token: both are members now, so there is nothing to add, to read or to confirm
    const bulk = callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length
    const reused = await call(addCreatorsToCampaign, grant, { ...args(), confirmToken: first.data.confirmToken })
    expect(reused.isError).toBe(false)
    expect(reused.data.added).toBe(0)
    expect(callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length).toBe(bulk)
    expect(h.scrapes.filter(s => s.toLowerCase().includes(nueva))).toHaveLength(1)
  })

  it('with Apify unavailable an unknown handle is refused before anything happens', async () => {
    h.apify.exhausted = true
    const a = await call(addCreatorsToCampaign, grant, { campaignId: fx.campaignA, handles: [`@${handle('otra')}`] })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('Apify no está disponible')
    expect(await prisma.influencer.count({ where: { username: handle('otra') } })).toBe(0)
  })

  it('a post URL or another site is not a profile', async () => {
    const a = await call(addCreatorsToCampaign, grant, { campaignId: fx.campaignA, handles: ['https://www.instagram.com/p/Cabc123/', 'https://example.com/someone'] })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('No son perfiles válidos')
  })
})

// ============ set_creator_status ============

describe('set_creator_status', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('a stage without capture changes at once and reports before and after', async () => {
    const a = await call(setCreatorStatus, grant, { campaignId: fx.campaignA, influencerIds: [fx.luis], status: 'NEGOTIATING' })
    expect(a.isError).toBe(false)
    expect(a.data.changed).toEqual([expect.objectContaining({ handle: `@${handle('luis')}`, change: 'Prospecto → Negociando', captureLaunched: false })])
    expect(await membership(fx.campaignA, fx.luis)).toMatchObject({ status: 'NEGOTIATING' })
  })

  it('a change into Acordado in a campaign with targets is paid: preview first; skipCapture uses the Kanban route and reads nothing', async () => {
    const paid = await call(setCreatorStatus, grant, { campaignId: fx.campaignT, influencerIds: [fx.tina], status: 'AGREED' })
    expect(paid.data).toMatchObject({ needsConfirmation: true })
    expect(paid.data.preview).toContain(`@${handle('tina')}: Negociando → Acordado`)
    expect(paid.data.preview).toContain('1 de ellas lanza una lectura de perfil en Apify')
    expect(await membership(fx.campaignT, fx.tina)).toMatchObject({ status: 'NEGOTIATING' })

    const kanban = callsTo('PATCH', '/api/pipeline/[id]').length
    const free = await call(setCreatorStatus, grant, { campaignId: fx.campaignT, influencerIds: [fx.tina], status: 'AGREED', skipCapture: true })
    expect(free.isError).toBe(false)
    expect(free.data.changed[0]).toMatchObject({ change: 'Negociando → Acordado', captureLaunched: false })
    expect(callsTo('PATCH', '/api/pipeline/[id]').length).toBe(kanban + 1)
    expect(await membership(fx.campaignT, fx.tina)).toMatchObject({ status: 'AGREED' })
    expect(h.scrapes.filter(s => s.includes(handle('tina')))).toEqual([])
  })

  it('refuses a creator who is not a member', async () => {
    const a = await call(setCreatorStatus, grant, { campaignId: fx.campaignT, influencerIds: [fx.luis], status: 'POSTED' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('No es integrante')
  })

  it('with the capture budget blocked a paid change is refused and points to skipCapture', async () => {
    h.apify.coreBlocked = true
    const a = await call(setCreatorStatus, grant, { campaignId: fx.campaignT, influencerIds: [fx.tina], status: 'CONTRACTED' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('vuelve a llamar con skipCapture: true')
    expect(await membership(fx.campaignT, fx.tina)).toMatchObject({ status: 'AGREED' })
  })
})

// ============ destructive: remove_creator_from_campaign ============

describe('remove_creator_from_campaign (destructive: approved in the platform, runs once with the stored arguments)', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('pending, denied and expired actions never run; an approved one runs once, with what was stored', async () => {
    // 1. The first call removes nothing and describes what would go
    const first = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rita })
    expect(first.data).toMatchObject({ needsApproval: true, validForMinutes: 15 })
    expect(first.data.preview).toContain(`Vas a quitar a @${handle('rita')} de «${fx.campaignAName}»`)
    expect(first.data.preview).toContain('Se BORRAN sus 1 publicación y 1 story capturada')
    expect(first.data.preview).toContain('No se puede deshacer')
    expect(first.data.preview).not.toContain('250')
    const id: string = first.data.actionId
    expect(await membership(fx.campaignA, fx.rita)).not.toBeNull()

    // 2. Pending: never runs
    const pending = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rita, actionId: id })
    expect(pending.isError).toBe(true)
    expect(pending.text).toContain('Todavía nadie la ha confirmado')

    // 3. An EMPLOYEE and another administrator cannot approve it
    expect(await decidePendingAction({ id, deciderId: fx.emp.id, decision: 'approve' })).toEqual({ ok: false, reason: 'not_admin' })
    expect(await decidePendingAction({ id, deciderId: fx.bea.id, decision: 'approve' })).toEqual({ ok: false, reason: 'foreign' })

    // 4. Denied: never runs
    expect(await decidePendingAction({ id, deciderId: fx.ada.id, decision: 'deny' })).toEqual({ ok: true, status: 'denied' })
    const denied = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rita, actionId: id })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('se canceló')
    expect(await membership(fx.campaignA, fx.rita)).not.toBeNull()

    // 5. Approved: runs once, with the STORED arguments (the second call names someone else)
    const again = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rita })
    expect(await approve(again.data.actionId)).toEqual({ ok: true, status: 'approved' })
    const deletes = callsTo('DELETE', '/api/campaigns/[id]/influencers').length
    const run = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.luis, actionId: again.data.actionId })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ removed: true, creator: `@${handle('rita')}`, deleted: { publications: 1, stories: 1 } })
    expect(run.data.confirmedAction).toEqual({ actionId: again.data.actionId, ranWithStoredArguments: true })
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers').length).toBe(deletes + 1)
    expect(await membership(fx.campaignA, fx.rita)).toBeNull()
    expect(await prisma.media.count({ where: { campaignId: fx.campaignA, influencerId: fx.rita } })).toBe(0)
    expect(await membership(fx.campaignA, fx.luis)).not.toBeNull()
    const twice = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rita, actionId: again.data.actionId })
    expect(twice.isError).toBe(true)
    expect(twice.text).toContain('ya se ejecutó')
    expect(callsTo('DELETE', '/api/campaigns/[id]/influencers').length).toBe(deletes + 1)

    // 6. Expired: neither approved nor run
    const late = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rosa })
    await prisma.mcpPendingAction.update({ where: { id: late.data.actionId }, data: { expiresAt: new Date(Date.now() - 1000) } })
    expect(await approve(late.data.actionId)).toMatchObject({ ok: false, reason: 'expired' })
    const expired = await call(removeCreatorFromCampaign, grant, { campaignId: fx.campaignA, influencerId: fx.rosa, actionId: late.data.actionId })
    expect(expired.isError).toBe(true)
    expect(expired.text).toContain('caducado')
    expect(await membership(fx.campaignA, fx.rosa)).not.toBeNull()
  })
})

// ============ outbound: invite_creator_to_connect ============

describe('invite_creator_to_connect (outbound: one e-mail, after approval, to the stored address)', () => {
  let grant = ''
  const typed = `Invitada.${tag}@Correo-Inventado.test`
  const address = typed.toLowerCase()
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('sends nothing until approved, then exactly one e-mail; never a second one', async () => {
    const first = await call(inviteCreatorToConnect, grant, { email: typed, campaignId: fx.campaignA })
    expect(first.data).toMatchObject({ needsApproval: true })
    expect(first.text).not.toContain(address)
    expect(first.data.preview).toContain('Vas a ENVIAR UN CORREO a [correo oculto]')
    const stored = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: first.data.actionId } })
    expect(stored.preview).toContain(`Vas a ENVIAR UN CORREO a ${address}, en nombre de Ada Admin`)
    expect(stored.preview).toContain(`por la campaña «${fx.campaignAName}»`)
    expect(stored.preview).toContain('llevas 0 de 5 invitaciones')
    expect(stored.argsJson).toContain(address)
    expect(h.mail).toHaveLength(0)

    await approve(first.data.actionId)
    const sent = await call(inviteCreatorToConnect, grant, { email: typed, actionId: first.data.actionId })
    expect(sent.isError).toBe(false)
    expect(sent.data.sent).toBe(true)
    expect(sent.data.email).toBeUndefined()
    expect(h.mail).toEqual([{ to: address, inviterName: 'Ada Admin', campaignName: fx.campaignAName }])
    expect(await prisma.invitation.count({ where: { email: address, role: 'CREATOR' } })).toBe(1)

    const twice = await call(inviteCreatorToConnect, grant, { email: typed, actionId: first.data.actionId })
    expect(twice.isError).toBe(true)
    expect(h.mail).toHaveLength(1)

    const pendingAgain = await call(inviteCreatorToConnect, grant, { email: address })
    expect(pendingAgain.isError).toBe(true)
    expect(pendingAgain.text).toContain('Ya hay una invitación pendiente')
  })
})

// ============ Contact data: shipping, Contacts address, creator record ============

describe('contact data stays out of the answers unless includeContact', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('set_creator_shipping saves the address, says which fields, and only shows them with includeContact', async () => {
    const a = await call(setCreatorShipping, grant, {
      campaignId: fx.campaignA, influencerId: fx.marta, shippingName: 'Destinataria Inventada', shippingAddress1: 'Calle Falsa 123',
      shippingCity: 'Villainventada', shippingPostCode: '28999', shippingProduct: 'Producto X', shippingQty: 2,
    })
    expect(a.isError).toBe(false)
    expect(a.text).not.toContain('Calle Falsa')
    expect(a.text).not.toContain('Destinataria')
    expect(a.data.fieldsSaved).toEqual(expect.arrayContaining(['shippingName', 'shippingAddress1', 'shippingQty']))
    expect(a.data.values).toEqual({ hasAddress: true })
    expect(a.data.savedInContacts).toBe('Esta dirección pasa a ser la guardada en Contactos para próximas campañas.')
    expect(await membership(fx.campaignA, fx.marta)).toMatchObject({ shippingAddress1: 'Calle Falsa 123', shippingQty: 2 })
    const contact = await prisma.contact.findUnique({ where: { influencerId_userId: { influencerId: fx.marta, userId: fx.ada.id } } })
    expect(contact?.address1).toBe('Calle Falsa 123')

    const shown = await call(setCreatorShipping, grant, { campaignId: fx.campaignA, influencerId: fx.marta, shippingAddress1: 'Calle Falsa 124', includeContact: true })
    expect(shown.data.values).toEqual({ shippingAddress1: 'Calle Falsa 124' })
  })

  it('save_contact_address needs a street for a new contact, creates it, and hides the values by default', async () => {
    const noStreet = await call(saveContactAddress, grant, { influencerId: fx.luis, city: 'Villainventada' })
    expect(noStreet.isError).toBe(true)
    expect(noStreet.text).toContain('Falta la calle')
    expect(await prisma.contact.count({ where: { influencerId: fx.luis, userId: fx.ada.id } })).toBe(0)

    const a = await call(saveContactAddress, grant, { influencerId: fx.luis, address1: 'Avenida Inventada 7', city: 'Villainventada', phone: '600000000' })
    expect(a.isError).toBe(false)
    expect(a.data).toMatchObject({ contactCreated: true, notice: 'Es la dirección que se propondrá en los próximos envíos.' })
    expect(a.text).not.toContain('Avenida Inventada')
    expect(a.text).not.toContain('600000000')
    expect(a.data.fieldsSaved).toEqual(['address1', 'city', 'phone'])

    const copy = await call(setCreatorShipping, grant, { campaignId: fx.campaignA, influencerId: fx.luis, useSavedAddress: true, shippingProduct: 'Producto Y' })
    expect(copy.isError).toBe(false)
    expect(copy.data.copiedFromContacts).toBe(true)
    expect(await membership(fx.campaignA, fx.luis)).toMatchObject({ shippingAddress1: 'Avenida Inventada 7', shippingProduct: 'Producto Y' })
  })

  it('update_creator_profile validates formats and keeps e-mail, phone and fee out of the answer by default', async () => {
    const bad = await call(updateCreatorProfile, grant, { influencerId: fx.marta, email: 'no-es-un-correo' })
    expect(bad.isError).toBe(true)
    const a = await call(updateCreatorProfile, grant, { influencerId: fx.marta, email: `nuevo-${tag}@correo-inventado.test`, standardFee: 800, gender: 'F' })
    expect(a.isError).toBe(false)
    expect(a.text).not.toContain('correo-inventado')
    expect(a.text).not.toContain('7777')
    expect(a.data.fieldsChanged).toEqual(['standardFee', 'email', 'gender'])
    expect(a.data.changes.gender).toEqual({ before: null, after: 'F' })
    expect(a.data.notice).toBe('La ficha es compartida: el cambio lo ven todas las PM.')
    const row = await prisma.influencer.findUniqueOrThrow({ where: { id: fx.marta } })
    expect(row).toMatchObject({ email: `nuevo-${tag}@correo-inventado.test`, standardFee: 800, gender: 'F', genderSource: 'manual' })
    const shown = await call(updateCreatorProfile, grant, { influencerId: fx.marta, phone: '+34 600 222 333', includeContact: true })
    expect(shown.data.changes.phone).toEqual({ before: '+34600111222', after: '+34 600 222 333' })
  })
})

// ============ Notes ============

describe('add_creator_note', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('refuses a creator who is not a member (no unreachable note) and signs the note of a member', async () => {
    const outsider = await call(addCreatorNote, grant, { campaignId: fx.campaignA, influencerId: fx.vieja, text: 'Pidió 400 €' })
    expect(outsider.isError).toBe(true)
    expect(await prisma.campaignNote.count({ where: { campaignId: fx.campaignA, influencerId: fx.vieja } })).toBe(0)

    const a = await call(addCreatorNote, grant, { campaignId: fx.campaignA, influencerId: fx.marta, text: '  Pidió 400 € por dos reels  ' })
    expect(a.isError).toBe(false)
    expect(a.data.text).toBe('Pidió 400 € por dos reels (vía Claude)')
    expect(a.data.notice).toBe('Queda firmada por Ada Admin y no se puede editar ni borrar.')
    const note = await prisma.campaignNote.findFirstOrThrow({ where: { campaignId: fx.campaignA, influencerId: fx.marta } })
    expect(note).toMatchObject({ userId: fx.ada.id, userName: 'Ada Admin', text: 'Pidió 400 € por dos reels (vía Claude)' })
    expect((await lastLog(grant)).argsSummary).not.toContain('Pidió')
  })
})

// ============ Lists ============

describe('lists', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('create_list refuses a name the admin already uses and creates the list for the admin', async () => {
    const dup = await call(createList, grant, { name: `  lista prueba ${tag} ` })
    expect(dup.isError).toBe(true)
    expect(dup.text).toContain('Ya tienes una lista llamada')
    const a = await call(createList, grant, { name: `Nueva Lista ${tag}` })
    expect(a.data).toMatchObject({ created: true, owner: 'Ada Admin', creators: 0 })
    expect(await prisma.list.findUniqueOrThrow({ where: { id: a.data.listId } })).toMatchObject({ userId: fx.ada.id, name: `Nueva Lista ${tag}` })
  })

  it('add_creators_to_list reports added, already in the list and not found', async () => {
    const a = await call(addCreatorsToList, grant, { listId: fx.listId, influencerIds: [fx.tina, fx.marta, 'ckdoesnotexist'] })
    const byId = Object.fromEntries(a.data.results.map((r: { influencerId: string; result: string }) => [r.influencerId, r.result]))
    expect(byId).toEqual({ [fx.tina]: 'added', [fx.marta]: 'already_in_list', ckdoesnotexist: 'not_found' })
  })

  it('update_list renames and archives, showing before and after', async () => {
    const a = await call(updateList, grant, { listId: fx.listId, name: `Lista Renombrada ${tag}`, isArchived: true })
    expect(a.data.changes).toEqual({
      name: { before: `Lista Prueba ${tag}`, after: `Lista Renombrada ${tag}` },
      isArchived: { before: false, after: true },
    })
  })

  it('remove_creators_from_list only ever deletes single items, after approval', async () => {
    const first = await call(removeCreatorsFromList, grant, { listId: fx.listId, influencerIds: [fx.nora, fx.luis] })
    expect(first.data).toMatchObject({ needsApproval: true })
    expect(first.data.preview).toContain('Solo salen de la lista; sus fichas y contactos no se tocan.')
    expect(await prisma.listItem.count({ where: { listId: fx.listId } })).toBe(4)
    await approve(first.data.actionId)
    const before = callsTo('DELETE', '/api/lists/[id]').length
    const run = await call(removeCreatorsFromList, grant, { listId: fx.listId, influencerIds: [fx.nora, fx.luis], actionId: first.data.actionId })
    expect(run.data.removed).toBe(2)
    const deletes = callsTo('DELETE', '/api/lists/[id]').slice(before)
    expect(deletes).toHaveLength(2)
    for (const d of deletes) expect(d.url).toMatch(/\?itemId=[A-Za-z0-9_-]+$/)
    expect(await prisma.list.findUnique({ where: { id: fx.listId } })).not.toBeNull()
    expect(await prisma.listItem.count({ where: { listId: fx.listId } })).toBe(2)
    const outsider = await call(removeCreatorsFromList, grant, { listId: fx.listId, influencerIds: [fx.vieja] })
    expect(outsider.isError).toBe(true)
    expect(outsider.text).toContain('No están en la lista')
  })

  it('delete_list waits for approval and names the owner and the size', async () => {
    const first = await call(deleteList, grant, { listId: fx.listId })
    expect(first.data.preview).toContain(`Vas a BORRAR la lista «Lista Renombrada ${tag}» de Ada Admin con sus 2 creadoras`)
    expect(await prisma.list.findUnique({ where: { id: fx.listId } })).not.toBeNull()
    await approve(first.data.actionId)
    const run = await call(deleteList, grant, { listId: fx.listId, actionId: first.data.actionId })
    expect(run.data).toMatchObject({ deleted: true, creatorsItHad: 2 })
    expect(await prisma.list.findUnique({ where: { id: fx.listId } })).toBeNull()
    expect(await prisma.influencer.count({ where: { id: { in: [fx.marta, fx.tina] } } })).toBe(2)
  })
})

// ============ Publications ============

describe('publications and stories', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('register_stories without a link needs a time, and a retry of the same story is refused', async () => {
    const noTime = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [{ influencerId: fx.luis, views: 120 }] })
    expect(noTime.isError).toBe(true)
    expect(noTime.text).toContain('hace falta postedAt')

    const postedAt = new Date(Date.now() - 3 * DAY).toISOString()
    const story = { influencerId: fx.luis, views: 120, reach: 90, postedAt }
    const a = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [story] })
    expect(a.isError).toBe(false)
    expect(a.data.results[0]).toMatchObject({ result: 'created', views: 120, reach: 90 })
    const retry = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [story] })
    expect(retry.isError).toBe(true)
    expect(retry.text).toContain('Parece un reintento')
    expect(await prisma.media.count({ where: { campaignId: fx.campaignA, influencerId: fx.luis, mediaType: 'STORY' } })).toBe(1)
    const allowed = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [{ ...story, allowDuplicate: true }] })
    expect(allowed.isError).toBe(false)
    expect(allowed.data.results[0].result).toBe('created')
    expect(await prisma.media.count({ where: { campaignId: fx.campaignA, influencerId: fx.luis, mediaType: 'STORY' } })).toBe(2)
  })

  it('register_stories with the story link creates it once and updates it after', async () => {
    const link = `https://www.instagram.com/stories/${handle('luis')}/${storyIdAt(Date.now() - 2 * DAY)}/`
    const a = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [{ influencerId: fx.luis, permalink: link, views: 300 }] })
    expect(a.data.results[0].result).toBe('created')
    const b = await call(registerStories, grant, { campaignId: fx.campaignA, stories: [{ influencerId: fx.luis, permalink: link, views: 450 }] })
    expect(b.data.results[0]).toMatchObject({ result: 'updated', views: 450 })
    const other = await call(registerStories, grant, {
      campaignId: fx.campaignA,
      stories: [{ influencerId: fx.luis, permalink: `https://www.instagram.com/stories/${handle('marta')}/${storyIdAt(Date.now() - DAY)}/` }],
    })
    expect(other.isError).toBe(true)
    expect(other.text).toContain(`el enlace es de @${handle('marta')}`)
  })

  it('add_publications_by_url: a story is free and runs at once, a post is paid and waits, garbage is refused', async () => {
    const storyLink = `https://www.instagram.com/stories/${handle('marta')}/${storyIdAt(Date.now() - 4 * DAY)}/`
    const free = await call(addPublicationsByUrl, grant, { campaignId: fx.campaignA, publications: [{ url: storyLink, views: 77 }] })
    expect(free.isError).toBe(false)
    expect(free.data.results[0]).toMatchObject({ result: 'added', creator: `@${handle('marta')}`, type: 'STORY', views: 77, readFromApify: false })
    expect(h.singlePosts).toEqual([])

    const paid = await call(addPublicationsByUrl, grant, { campaignId: fx.campaignA, publications: [{ url: `https://www.instagram.com/p/Cxyz${tag}/` }] })
    expect(paid.data).toMatchObject({ needsConfirmation: true })
    expect(paid.data.preview).toContain('1 se lee en Apify, una lectura por publicación (uso actual del plan: 40 %)')
    expect(h.singlePosts).toEqual([])

    const garbage = await call(addPublicationsByUrl, grant, { campaignId: fx.campaignA, publications: [{ url: 'https://bit.ly/abcdef' }] })
    expect(garbage.isError).toBe(true)
    expect(garbage.text).toContain('No son enlaces de publicación válidos')
  })

  it('correct_publication_metrics shows before and after and keeps the higher public likes', async () => {
    const a = await call(correctPublicationMetrics, grant, {
      campaignId: fx.campaignA, mediaId: fx.martaReel, source: 'creator_screenshot', views: 2000, likes: 40, reach: 1500,
    })
    expect(a.isError).toBe(false)
    expect(a.data.figures).toEqual({ reach: { before: 0, after: 1500 }, views: { before: 1000, after: 2000 }, likes: { before: 50, after: 50 } })
    expect(a.data.keptBecausePublicFigureWasHigher).toEqual(['likes'])
    expect(a.data.notice).toBe('Estas cifras cuentan ya como audiencia real en los totales, el informe y el portal del cliente.')
    const other = await call(correctPublicationMetrics, grant, { campaignId: fx.campaignT, mediaId: fx.martaReel, source: 'manual', views: 1 })
    expect(other.isError).toBe(true)
    expect(other.text).toContain('Esa publicación no está en esta campaña')
  })

  it('tag_publications writes the tags and shows the previous ones', async () => {
    const a = await call(tagPublications, grant, { campaignId: fx.campaignA, items: [{ mediaId: fx.martaReel, contentAngle: 'tutorial', hook: 'Mira esto' }] })
    expect(a.data.results[0]).toMatchObject({
      result: 'tagged',
      tags: { contentAngle: { before: null, after: 'tutorial' }, hook: { before: null, after: 'Mira esto' } },
    })
    const empty = await call(tagPublications, grant, { campaignId: fx.campaignA, items: [{ mediaId: fx.martaReel }] })
    expect(empty.isError).toBe(true)
  })
})

// ============ Tracking and Apify-backed creator tools ============

describe('tracking and the creator tools that read Apify', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
    resetTrackingRuns()
  })

  it('launch_campaign_tracking refuses paused campaigns and a plan at 95 %; otherwise preview, then one run', async () => {
    const paused = await call(launchCampaignTracking, grant, { campaignId: fx.campaignP })
    expect(paused.isError).toBe(true)
    expect(paused.text).toContain('Solo se rastrean campañas activas')

    h.apify.usedPct = 96
    const full = await call(launchCampaignTracking, grant, { campaignId: fx.campaignT })
    expect(full.isError).toBe(true)
    expect(full.text).toContain('El plan de Apify está al 96 %')
    h.apify.usedPct = 40

    const tracks = callsTo('POST', '/api/campaigns/[id]/track').length
    const first = await call(launchCampaignTracking, grant, { campaignId: fx.campaignT })
    expect(first.data.preview).toContain(`Vas a lanzar «Rastrear ahora» en «Campaña Rastreo ${tag}»: 1 integrante`)
    expect(first.data.preview).toContain('1 hashtag en 1 red')
    expect(first.data.preview).toContain('Es la acción que más Apify consume (uso actual del plan: 40 %)')
    expect(callsTo('POST', '/api/campaigns/[id]/track').length).toBe(tracks)
    const run = await call(launchCampaignTracking, grant, { campaignId: fx.campaignT, confirmToken: first.data.confirmToken })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ launched: true, finished: true, targetsConfigured: true })
    expect(callsTo('POST', '/api/campaigns/[id]/track').length).toBe(tracks + 1)
    expect((await lastLog(grant)).argsSummary).toMatch(/^\[money:execute http=200,200,200,200\] campaignId=/)

    // Same state, same token: it works once only
    const reused = await call(launchCampaignTracking, grant, { campaignId: fx.campaignT, confirmToken: first.data.confirmToken })
    expect(reused.isError).toBe(true)
    expect(reused.text).toContain('ya se usó')
    expect(callsTo('POST', '/api/campaigns/[id]/track').length).toBe(tracks + 1)
  })

  it('sync_instagram_connection only syncs the admin\'s own connections', async () => {
    const a = await call(syncInstagramConnection, grant, { connectionId: 'ckno-such-connection' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('Esa conexión no está entre tus cuentas de Instagram conectadas')
  })

  it('analyze_creator_profile is free with fresh data and asks first when it must read Apify', async () => {
    const fresh = await call(analyzeCreatorProfile, grant, { username: `@${handle('fresca').toUpperCase()}`, platform: 'INSTAGRAM' })
    expect(fresh.isError).toBe(false)
    expect(fresh.data.creator).toMatchObject({ influencerId: fx.fresca, username: handle('fresca') })
    expect(fresh.data.freshFromApify).toBe(false)
    expect(h.scrapes.filter(s => s.includes(handle('fresca')))).toEqual([])
    const stale = await call(analyzeCreatorProfile, grant, { username: `https://www.instagram.com/${handle('vieja')}/`, platform: 'INSTAGRAM' })
    expect(stale.data).toMatchObject({ needsConfirmation: true })
    expect(stale.data.preview).toContain(`Vas a analizar el perfil @${handle('vieja')} (Instagram): una lectura de perfil en Apify`)
    const wrongNetwork = await call(analyzeCreatorProfile, grant, { username: `https://www.tiktok.com/@${handle('vieja')}`, platform: 'INSTAGRAM' })
    expect(wrongNetwork.isError).toBe(true)
  })

  it('analyze, import and the paid search are refused when the optional budget is paused', async () => {
    h.apify.optionalBlocked = true
    const a = await call(analyzeCreatorProfile, grant, { username: handle('vieja'), platform: 'INSTAGRAM' })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('El gasto opcional de Apify está en pausa')
    const b = await call(importCreatorsToDatabase, grant, { handles: [`@${handle('desconocida')}`], platform: 'INSTAGRAM' })
    expect(b.isError).toBe(true)
  })

  it('import_creators_to_database: unknown handles cost a read each and need a confirmation', async () => {
    const a = await call(importCreatorsToDatabase, grant, { handles: [`@${handle('desconocida')}`, handle('desconocida')], platform: 'INSTAGRAM' })
    expect(a.data).toMatchObject({ needsConfirmation: true })
    expect(a.data.preview).toContain(`Desconocidas, una lectura de perfil en Apify cada una: @${handle('desconocida')}`)
    const mixed = await call(importCreatorsToDatabase, grant, { handles: ['https://www.tiktok.com/@alguien'], platform: 'INSTAGRAM' })
    expect(mixed.isError).toBe(true)
    expect(mixed.text).toContain('Una red por llamada')
  })

  it('run_paid_creator_search: the first call is the free search and the paid run waits for a yes', async () => {
    const a = await call(runPaidCreatorSearch, grant, { query: `limpieza hogar ${tag}`, platform: 'INSTAGRAM' })
    expect(a.isError).toBe(false)
    if (a.data.needsConfirmation) {
      expect(a.data.preview).toContain('Búsqueda de pago en Instagram del hashtag #')
      expect(a.data.preview).toContain('(uso actual del plan: 40 %)')
      expect(a.data.preview).not.toMatch(/\d\s?(€|\$|USD|EUR)/)
    } else {
      expect(a.data.paid).toBe(false)
    }
    expect(callsTo('POST', '/api/influencers/discover').length).toBeGreaterThan(0)
  })

  it('the paid runs of analyze, import, paid search and a post URL each read Apify once, only with their token', async () => {
    // analyze: one profile read of the stored handle
    const analyzeArgs = { username: handle('vieja').toUpperCase(), platform: 'INSTAGRAM' }
    const offer = await call(analyzeCreatorProfile, grant, analyzeArgs)
    expect(h.scrapes.filter(s => s.includes(handle('vieja')))).toEqual([])
    const analyzed = await call(analyzeCreatorProfile, grant, { ...analyzeArgs, confirmToken: offer.data.confirmToken })
    expect(analyzed.isError).toBe(false)
    expect(analyzed.data).toMatchObject({ freshFromApify: true, creator: { influencerId: fx.vieja, followers: 12_345 } })
    expect(h.scrapes.filter(s => s.includes(handle('vieja')))).toEqual([`INSTAGRAM:${handle('vieja')}`])

    // import: the unknown handle becomes a creator with an id
    const importArgs = { handles: [`@${handle('importada')}`], platform: 'INSTAGRAM' }
    const importOffer = await call(importCreatorsToDatabase, grant, importArgs)
    const imported = await call(importCreatorsToDatabase, grant, { ...importArgs, confirmToken: importOffer.data.confirmToken })
    expect(imported.isError).toBe(false)
    expect(imported.data.creators[0]).toMatchObject({ handle: `@${handle('importada')}`, result: 'scraped' })
    expect(imported.data.creators[0].influencerId).toEqual(expect.any(String))
    expect(h.scrapes.filter(s => s.includes(handle('importada')))).toHaveLength(1)

    // paid search: the confirmed run is the one offered
    const searchArgs = { query: `limpieza hogar ${tag}`, platform: 'INSTAGRAM' }
    const searchOffer = await call(runPaidCreatorSearch, grant, searchArgs)
    if (searchOffer.data.needsConfirmation) {
      const paidSearch = await call(runPaidCreatorSearch, grant, { ...searchArgs, confirmToken: searchOffer.data.confirmToken })
      expect(paidSearch.isError).toBe(false)
      expect(paidSearch.data).toMatchObject({ paid: true })
      expect(await lastLog(grant)).toMatchObject({ tool: 'run_paid_creator_search', ok: true })
      expect((await lastLog(grant)).argsSummary).toMatch(/^\[money:execute http=200,200,200\] queryChars=\d+ platform=INSTAGRAM$/)
    }

    // a post URL: one single-post read, the typed date and the chosen member
    const postUrl = `https://www.instagram.com/p/Cpaid${tag}/`
    const pubArgs = { campaignId: fx.campaignA, publications: [{ url: postUrl, influencerId: fx.marta, views: 900, postedAt: new Date(Date.now() - 6 * DAY).toISOString() }] }
    const pubOffer = await call(addPublicationsByUrl, grant, pubArgs)
    expect(h.singlePosts).toEqual([])
    const added = await call(addPublicationsByUrl, grant, { ...pubArgs, confirmToken: pubOffer.data.confirmToken })
    expect(added.isError).toBe(false)
    expect(added.data.results[0]).toMatchObject({ result: 'added', creator: `@${handle('marta')}`, views: 900 })
    expect(h.singlePosts).toHaveLength(1)
  })

  it('create_creator_manually refuses a handle that exists under another casing and lower-cases a new one', async () => {
    const dup = await call(createCreatorManually, grant, { username: `@${handle('fresca').toUpperCase()}`, platform: 'INSTAGRAM' })
    expect(dup.isError).toBe(true)
    expect(dup.text).toContain(`Ya existe @${handle('fresca')} en Instagram (id ${fx.fresca})`)
    const a = await call(createCreatorManually, grant, { username: `Manual_${tag.toUpperCase()}`, platform: 'INSTAGRAM', country: 'es', gender: 'X' })
    expect(a.isError).toBe(false)
    expect(a.data.notice).toBe('Ficha creada sin métricas. Para traer sus datos reales hay que analizar el perfil (consume Apify).')
    const row = await prisma.influencer.findUniqueOrThrow({ where: { id: a.data.influencerId } })
    expect(row).toMatchObject({ username: handle('manual'), country: 'ES', gender: 'X', followers: 0 })
  })
})

// ============ Moving creators ============

describe('move_creators_between_campaigns', () => {
  let grant = ''
  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
  })

  it('a small copy runs at once; a move waits for approval and keeps creators with captured content', async () => {
    const copy = await call(moveCreatorsBetweenCampaigns, grant, { sourceCampaignId: fx.campaignA, targetCampaignId: fx.campaignB, influencerIds: [fx.luis], mode: 'copy' })
    expect(copy.isError).toBe(false)
    expect(copy.data).toMatchObject({ copiedKeptInSource: 1, arriveAs: 'Prospecto' })
    expect(await membership(fx.campaignB, fx.luis)).toMatchObject({ status: 'PROSPECT' })
    expect(await membership(fx.campaignA, fx.luis)).not.toBeNull()

    const move = await call(moveCreatorsBetweenCampaigns, grant, { sourceCampaignId: fx.campaignA, targetCampaignId: fx.campaignB, influencerIds: [fx.marta], mode: 'move' })
    expect(move.data).toMatchObject({ needsApproval: true })
    expect(move.data.preview).toContain('Las 1 que tienen contenido capturado se quedan también')
    expect(await membership(fx.campaignB, fx.marta)).toBeNull()
    await approve(move.data.actionId)
    const run = await call(moveCreatorsBetweenCampaigns, grant, { sourceCampaignId: fx.campaignA, targetCampaignId: fx.campaignB, influencerIds: [fx.marta], mode: 'move', actionId: move.data.actionId })
    expect(run.data).toMatchObject({ movedAndRemovedFromSource: 0, keptInSourceBecauseOfContent: [`@${handle('marta')}`] })
    expect(await membership(fx.campaignA, fx.marta)).not.toBeNull()
    expect(await membership(fx.campaignB, fx.marta)).toMatchObject({ status: 'PROSPECT' })

    const same = await call(moveCreatorsBetweenCampaigns, grant, { sourceCampaignId: fx.campaignA, targetCampaignId: fx.campaignA, influencerIds: [fx.marta], mode: 'copy' })
    expect(same.isError).toBe(true)
  })
})

// ============ Who may write ============

describe('only a live write grant of an active ADMIN can use these tools', () => {
  it('a read-only grant gets the reconnect message and changes nothing', async () => {
    const readOnly = (await prisma.mcpGrant.create({ data: { clientId: `old-client-${tag}`, userId: fx.ada.id, scope: 'tkoc.read', resource: MCP_RESOURCE } })).id
    created.grants.push(readOnly)
    const a = await call(createList, readOnly, { name: `Lista Solo Lectura ${tag}` })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('es de solo lectura')
    expect(await prisma.list.count({ where: { name: `Lista Solo Lectura ${tag}` } })).toBe(0)
  })

  it('an admin demoted after authorising is refused and the grant is revoked', async () => {
    const dora = await prisma.user.create({ data: { email: `dora-${tag}@correo-inventado.test`, password: 'x', name: 'Dora Admin', role: 'ADMIN' } })
    created.users.push(dora.id)
    const grant = await grantFor(dora.id)
    await prisma.user.update({ where: { id: dora.id }, data: { role: 'EMPLOYEE' } })
    const a = await call(addCreatorNote, grant, { campaignId: fx.campaignA, influencerId: fx.marta, text: 'no debe guardarse' }, dora.id)
    expect(a.isError).toBe(true)
    expect(a.text).toContain('Solo un administrador activo')
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grant } })).revokedAt).not.toBeNull()
    expect(await prisma.campaignNote.count({ where: { text: { contains: 'no debe guardarse' } } })).toBe(0)
  })
})

// ============ Fixes of 12 Nov 2026 (review of the write layer) ============

describe('fixes of 12 Nov 2026: confirmations bound to their class and state, Apify gates, time budget, addresses', () => {
  let grant = ''
  const ids = { free: '', track: '', creators: [] as string[] }
  const window = () => {
    const start = new Date(Date.now() - 40 * DAY)
    start.setUTCHours(0, 0, 0, 0)
    const end = new Date(Date.now() + 40 * DAY)
    end.setUTCHours(0, 0, 0, 0)
    return { startDate: start, endDate: end }
  }
  const newCampaign = async (name: string, extra: Record<string, unknown> = {}) => {
    const c = await prisma.campaign.create({ data: { name, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], userId: fx.ada.id, ...window(), ...extra } })
    fx.more.push(c.id)
    return c.id
  }
  const scrapedPiece = (influencerId: string, n: number) =>
    prisma.media.create({
      data: {
        campaignId: ids.track, influencerId, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `fix-scraped-${n}-${tag}`,
        caption: 'Un reel cualquiera, sin la marca', likes: 5, postedAt: new Date(Date.now() - 5 * DAY), source: 'apify',
      },
    })

  beforeAll(async () => {
    grant = await grantFor(fx.ada.id)
    resetTrackingRuns()
    ids.free = await newCampaign(`Campaña Sin Reglas ${tag}`)
    ids.track = await newCampaign(`Campaña Con Reglas ${tag}`, { targetHashtags: [`marcafix${tag}`] })
    for (let i = 1; i <= 7; i++) {
      const row = await prisma.influencer.create({ data: { username: handle(`fix${i}`), platform: 'INSTAGRAM', followers: 1000 } })
      created.influencers.push(row.id)
      ids.creators.push(row.id)
    }
  })

  it('add_creators_to_campaign: the token of a free bulk preview never runs the paid call the campaign turned into', async () => {
    const args = { campaignId: ids.free, influencerIds: ids.creators.slice(0, 6) }
    const free = await call(addCreatorsToCampaign, grant, args)
    expect(free.data).toMatchObject({ needsConfirmation: true })
    expect(free.data.preview).toContain('No se gasta Apify')
    // Before the yes is used, the campaign gets a hashtag (set_campaign_tracking_targets runs at once)
    await prisma.campaign.update({ where: { id: ids.free }, data: { targetHashtags: [`marcafix${tag}`] } })
    const adds = callsTo('POST', '/api/campaigns/[id]/influencers').length
    const scrapes = h.scrapes.length
    const second = await call(addCreatorsToCampaign, grant, { ...args, confirmToken: free.data.confirmToken })
    expect(second.isError).toBe(false)
    expect(second.data).toMatchObject({ needsConfirmation: true })
    expect(second.data.notice).toContain('No se ha hecho nada')
    expect(second.data.preview).toContain('Gasto: hasta 6 lecturas de perfil de Apify')
    expect(callsTo('POST', '/api/campaigns/[id]/influencers').length).toBe(adds)
    expect(h.scrapes.length).toBe(scrapes)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: ids.free } })).toBe(0)
    expect((await lastLog(grant)).argsSummary).toMatch(/^\[money:preview /)
    await prisma.campaign.update({ where: { id: ids.free }, data: { targetHashtags: [] } })
  })

  it('set_creator_status: the token of a free bulk preview never fires the paid captures once the campaign has targets', async () => {
    const six = ids.creators.slice(0, 6)
    await prisma.campaignInfluencer.createMany({ data: six.map(influencerId => ({ campaignId: ids.free, influencerId, status: 'PROSPECT' as const })) })
    const args = { campaignId: ids.free, influencerIds: six, status: 'CONTRACTED' }
    const free = await call(setCreatorStatus, grant, args)
    expect(free.data).toMatchObject({ needsConfirmation: true })
    expect(free.data.preview).toContain('no se captura nada')
    await prisma.campaign.update({ where: { id: ids.free }, data: { targetHashtags: [`marcafix${tag}`] } })
    const second = await call(setCreatorStatus, grant, { ...args, confirmToken: free.data.confirmToken })
    expect(second.data).toMatchObject({ needsConfirmation: true })
    expect(second.data.preview).toContain('lectura de perfil en Apify')
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: ids.free, status: 'CONTRACTED' } })).toBe(0)
    await prisma.campaign.update({ where: { id: ids.free }, data: { targetHashtags: [] } })
    await prisma.campaignInfluencer.deleteMany({ where: { campaignId: ids.free } })
  })

  it('add_publications_by_url: a free preview while Apify was down never redeems the paid reads once it is back', async () => {
    await prisma.campaignInfluencer.create({ data: { campaignId: ids.track, influencerId: ids.creators[6], status: 'POSTED' } })
    const publications = Array.from({ length: 6 }, (_, i) => ({ url: `https://www.instagram.com/p/Cfix${i}${tag}/`, influencerId: ids.creators[6], postedAt: new Date(Date.now() - 3 * DAY).toISOString() }))
    h.apify.exhausted = true
    const free = await call(addPublicationsByUrl, grant, { campaignId: ids.track, publications })
    expect(free.data).toMatchObject({ needsConfirmation: true })
    expect(free.data.preview).toContain('Apify no está disponible ahora')
    h.apify.exhausted = false
    const second = await call(addPublicationsByUrl, grant, { campaignId: ids.track, publications, confirmToken: free.data.confirmToken })
    expect(second.data).toMatchObject({ needsConfirmation: true })
    expect(second.data.preview).toContain('se leen en Apify')
    expect(h.singlePosts.filter(u => u.includes(`Cfix0${tag}`))).toEqual([])
    expect(await prisma.media.count({ where: { campaignId: ids.track, influencerId: ids.creators[6] } })).toBe(0)
    await prisma.campaignInfluencer.deleteMany({ where: { campaignId: ids.track, influencerId: ids.creators[6] } })
  })

  it('add_creators_to_campaign: a creator not in the database is an import, paused with the optional budget; known ones are still offered', async () => {
    Object.assign(h.apify, { optionalBlocked: true, usedPct: 88 })
    const unknown = handle('fixnueva')
    const a = await call(addCreatorsToCampaign, grant, { campaignId: ids.track, handles: [`@${unknown}`] })
    expect(a.isError).toBe(true)
    expect(a.text).toContain('El gasto opcional de Apify está en pausa (88 % del plan usado)')
    expect(a.text).toContain(`@${unknown}`)
    expect(h.scrapes.filter(s => s.includes(unknown))).toEqual([])
    expect(await prisma.influencer.count({ where: { username: unknown } })).toBe(0)
    // A creator already in the database is capture: core spend, still offered
    const known = await call(addCreatorsToCampaign, grant, { campaignId: ids.track, influencerIds: [ids.creators[0]] })
    expect(known.isError).toBe(false)
    expect(known.data).toMatchObject({ needsConfirmation: true })
  })

  it('add_creators_to_campaign keeps ONE time budget for the call: after a slow first network the next one is not attempted', async () => {
    const ig = handle('fixig')
    const tt = handle('fixtt')
    const args = { campaignId: ids.track, handles: [`@${ig}`, `https://www.tiktok.com/@${tt}`] }
    const first = await call(addCreatorsToCampaign, grant, args)
    expect(first.data).toMatchObject({ needsConfirmation: true })
    const bulk = callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length
    // The Instagram batch answers OK, but after 140 seconds
    vi.useFakeTimers({ toFake: ['Date'] })
    setPlatformTransport(async request => {
      const res = await router.transport(request)
      if (new URL(request.url).pathname.endsWith('/influencers/bulk')) vi.setSystemTime(Date.now() + 140_000)
      return res
    })
    try {
      const run = await call(addCreatorsToCampaign, grant, { ...args, confirmToken: first.data.confirmToken })
      expect(run.isError).toBe(false)
      expect(callsTo('POST', '/api/campaigns/[id]/influencers/bulk').length).toBe(bulk + 1)
      const byHandle = Object.fromEntries(run.data.creators.map((c: { handle: string }) => [c.handle, c]))
      expect(byHandle[`@${ig}`]).toMatchObject({ result: 'created_and_added' })
      expect(byHandle[`@${tt}`]).toMatchObject({ result: 'not_attempted', platform: 'TIKTOK' })
      expect(byHandle[`@${tt}`].reason).toContain('se acabó el tiempo')
      expect(run.data.notAttempted).toContain('Vuelve a llamar solo con lo que falta')
      expect(h.scrapes.filter(s => s.includes(tt))).toEqual([])
    } finally {
      setPlatformTransport(router.transport)
      vi.useRealTimers()
    }
  })

  it('set_creator_shipping: a street alone keeps the other lines, in the campaign and in Contacts', async () => {
    const who = ids.creators[5]
    const email = `ana-${tag}@correo-inventado.test`
    await prisma.campaignInfluencer.create({
      data: {
        campaignId: ids.track, influencerId: who, status: 'SHIPPING', shippingName: 'Ana Inventada', shippingAddress1: 'Calle Vieja 1', shippingAddress2: '3º B',
        shippingCity: 'Villavieja', shippingPostCode: '28000', shippingCountry: 'España', shippingPhone: '+34 600 000 001', shippingEmail: email,
      },
    })
    const a = await call(setCreatorShipping, grant, { campaignId: ids.track, influencerId: who, shippingAddress1: 'Calle Mayor 5', shippingPostCode: '28001', shippingCity: 'Madrid' })
    expect(a.isError).toBe(false)
    expect([...a.data.fieldsSaved].sort()).toEqual(['shippingAddress1', 'shippingCity', 'shippingPostCode'])
    expect([...a.data.keptFromCurrent].sort()).toEqual(['shippingAddress2', 'shippingCountry', 'shippingEmail', 'shippingName', 'shippingPhone'])
    expect(a.data.savedInContacts).toBeTruthy()
    expect(a.text).not.toContain('Ana Inventada')
    const contact = await prisma.contact.findUnique({ where: { influencerId_userId: { influencerId: who, userId: fx.ada.id } } })
    expect(contact).toMatchObject({
      address1: 'Calle Mayor 5', city: 'Madrid', postCode: '28001',
      addressName: 'Ana Inventada', address2: '3º B', country: 'España', phone: '+34 600 000 001', email,
    })
    expect(await membership(ids.track, who)).toMatchObject({ shippingAddress1: 'Calle Mayor 5', shippingName: 'Ana Inventada', shippingPhone: '+34 600 000 001', shippingEmail: email })
  })

  it('set_creator_shipping: with no address in the campaign yet, the lines left out come from Contacts, as in the form', async () => {
    const who = ids.creators[4]
    await prisma.campaignInfluencer.create({ data: { campaignId: ids.track, influencerId: who, status: 'SHIPPING' } })
    await prisma.contact.create({
      data: { influencerId: who, userId: fx.ada.id, status: 'new', addressName: 'Bea Inventada', address1: 'Calle Contacto 9', city: 'Sevilla', postCode: '41000', country: 'España', phone: '+34 600 000 002', addressUpdatedAt: new Date() },
    })
    const a = await call(setCreatorShipping, grant, { campaignId: ids.track, influencerId: who, shippingAddress1: 'Calle Nueva 2' })
    expect(a.isError).toBe(false)
    expect([...a.data.keptFromCurrent].sort()).toEqual(['shippingCity', 'shippingCountry', 'shippingName', 'shippingPhone', 'shippingPostCode'])
    const contact = await prisma.contact.findUnique({ where: { influencerId_userId: { influencerId: who, userId: fx.ada.id } } })
    expect(contact).toMatchObject({ address1: 'Calle Nueva 2', addressName: 'Bea Inventada', city: 'Sevilla', phone: '+34 600 000 002', country: 'España' })
  })

  it('launch_campaign_tracking: refused without rules, and while its final revalidation would take pieces out; its token is bound to the dates', async () => {
    const tracks = callsTo('POST', '/api/campaigns/[id]/track').length
    const noRules = await call(launchCampaignTracking, grant, { campaignId: ids.free })
    expect(noRules.isError).toBe(true)
    expect(noRules.text).toContain('no tiene cuentas de marca, hashtags ni palabras clave de producto')

    const member = ids.creators[3]
    await prisma.campaignInfluencer.create({ data: { campaignId: ids.track, influencerId: member, status: 'POSTED' } })
    const piece = await scrapedPiece(member, 1)
    const refused = await call(launchCampaignTracking, grant, { campaignId: ids.track })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('sacaría 1 pieza')
    expect(refused.text).toContain('revalidate_campaign_media')
    expect(callsTo('POST', '/api/campaigns/[id]/track').length).toBe(tracks)
    expect(await prisma.media.count({ where: { id: piece.id, campaignId: ids.track } })).toBe(1)

    await prisma.media.delete({ where: { id: piece.id } })
    const first = await call(launchCampaignTracking, grant, { campaignId: ids.track })
    expect(first.data).toMatchObject({ needsConfirmation: true })
    expect(first.data.preview).toContain('no saldría ninguna pieza')
    // The end date moves after the yes (update_campaign runs at once): the token is stale
    await prisma.campaign.update({ where: { id: ids.track }, data: { endDate: new Date(window().endDate.getTime() + DAY) } })
    const stale = await call(launchCampaignTracking, grant, { campaignId: ids.track, confirmToken: first.data.confirmToken })
    expect(stale.data).toMatchObject({ needsConfirmation: true })
    expect(stale.data.notice).toContain('No se ha hecho nada')
    expect(callsTo('POST', '/api/campaigns/[id]/track').length).toBe(tracks)
    await prisma.campaign.update({ where: { id: ids.track }, data: window() })
  })

  it('revalidate_campaign_media: an approval never runs once the dates or rules changed after it', async () => {
    const member = ids.creators[3]
    const piece = await scrapedPiece(member, 2)
    const first = await call(revalidateCampaignMedia, grant, { campaignId: ids.track })
    expect(first.data).toMatchObject({ needsApproval: true })
    expect(first.data.preview).toContain('saldrían 1')
    await approve(first.data.actionId)
    // After the approval the campaign starts tomorrow: every piece would be out of dates
    await prisma.campaign.update({ where: { id: ids.track }, data: { startDate: new Date(Date.now() + DAY) } })
    const revalidations = callsTo('POST', '/api/campaigns/[id]/revalidate-media').length
    const stale = await call(revalidateCampaignMedia, grant, { campaignId: ids.track, actionId: first.data.actionId })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('ha cambiado lo que haría')
    expect(callsTo('POST', '/api/campaigns/[id]/revalidate-media').length).toBe(revalidations)
    expect(await prisma.media.count({ where: { id: piece.id, campaignId: ids.track } })).toBe(1)
    // Back to the approved dates, the approved revalidation runs once
    await prisma.campaign.update({ where: { id: ids.track }, data: window() })
    const run = await call(revalidateCampaignMedia, grant, { campaignId: ids.track, actionId: first.data.actionId })
    expect(run.isError).toBe(false)
    expect(run.data).toMatchObject({ removed: 1 })
    expect(callsTo('POST', '/api/campaigns/[id]/revalidate-media').length).toBe(revalidations + 1)
  })
})
