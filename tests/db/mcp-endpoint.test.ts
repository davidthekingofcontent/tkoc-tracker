import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, no address in the
// environment (every URL is built from the default one) and no Apify token,
// so nothing in this file can reach the network.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
})

// The platform's Apify helper, watched: how many calls to it are in flight at
// once. Everything else of the module is the real thing (and with no token it
// asks nobody).
const apifyWatch = vi.hoisted(() => ({ active: 0, peak: 0, delayMs: 0 }))
vi.mock('@/lib/apify', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  return {
    ...actual,
    checkApifyAuth: async (fresh?: boolean) => {
      apifyWatch.active += 1
      apifyWatch.peak = Math.max(apifyWatch.peak, apifyWatch.active)
      try {
        if (apifyWatch.delayMs > 0) await new Promise(resolve => setTimeout(resolve, apifyWatch.delayMs))
        return await actual.checkApifyAuth(fresh)
      } finally {
        apifyWatch.active -= 1
      }
    },
  }
})

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { CALL_RATE_LIMIT, LIST_MAX_LIMIT, MCP_RESOURCE, REQUEST_RATE_LIMIT, WWW_AUTHENTICATE_BEARER } from '@/lib/mcp/config'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { allowCall, allowRequest, createGrantAndCode, exchangeCode, registerClient, revokeGrant } from '@/lib/mcp/oauth'
import { DELETE, GET, POST } from '@/app/api/mcp/route'
import { MAX_TOOL_INPUT_ELEMENTS, MCP_SERVER_INSTRUCTIONS } from '@/lib/mcp/server'
import { WRITE_TOOLS } from '@/lib/mcp/tools/write'

const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const ENDPOINT = 'https://intelligence.thekingofcontent.agency/api/mcp'
const DAY = 24 * 60 * 60 * 1000

// ---------- Invented data. Every value below that must never leave is unique and searchable ----------

const SECRETS = {
  adminEmail: 'admin.inventado@correo-inventado.test',
  passwordHash: '$2b$12$HASH-INVENTADO-NO-DEBE-SALIR',
  creatorEmail: 'marta@correo-inventado.test',
  creatorPhone: '+34600111222',
  creatorBio: 'BIO-NO-DEBE-SALIR escribe a marta@correo-inventado.test',
  creatorWebsite: 'https://web-de-marta-inventada.test',
  creatorCity: 'Villainventada',
  membershipNotes: 'NOTA-INTERNA-NO-DEBE-SALIR',
  shippingName: 'DESTINATARIA-NO-DEBE-SALIR',
  shippingAddress: 'Calle Inventada 123, 4B',
  shippingPhone: '+34600999888',
  shippingEmail: 'envios@correo-inventado.test',
  trackedLink: 'https://enlace-utm-inventado.test/?utm=NO-DEBE-SALIR',
  portfolioUrl: 'https://portfolio-inventado.test/NO-DEBE-SALIR',
  caption: 'CAPTION-NO-DEBE-SALIR',
  briefText: 'BRIEF-NO-DEBE-SALIR',
  roiNotes: 'NOTA-ROI-NO-DEBE-SALIR',
  businessNotes: 'NOTA-NEGOCIO-NO-DEBE-SALIR',
  shareToken: 'SHARETOKEN-NO-DEBE-SALIR',
  settingSecret: 'SECRETO-AJUSTE-NO-DEBE-SALIR',
  brandWebsite: 'https://web-de-la-marca-inventada.test',
  cronExceptionDetail: 'https://api.apify.com/v2/acts?token=TOKEN-APIFY-NO-DEBE-SALIR',
  employeeAlert: 'AVISO-DE-EQUIPO-NO-ES-DE-ADMIN',
  metaUserId: '10203040506070809',
  deletionCode: 'CODIGO-BORRADO-NO-DEBE-SALIR',
}

/** Money and estimates of the fixtures. They may only appear with includeEconomics. */
const MONEY = { fee: 12345.67, productCost: 4321.09, budget: 65432.1, revenue: 98765.4, standardFee: 7777.77 }

/** Keys that no answer of any tool may contain, at any depth (compared in lower case). */
const FORBIDDEN_KEYS = [
  'email', 'phone', 'password', 'shippingaddress1', 'notes', 'accesstoken',
  'shippingaddress2', 'shippingname', 'shippingphone', 'shippingemail', 'shippingcity', 'shippingpostcode',
  'bio', 'website', 'city', 'caption', 'brieftext', 'manualroinotes', 'businessresultsnotes', 'businessnotes',
  'sharetoken', 'token', 'refreshtoken', 'tokenhash', 'standardfee', 'trackedlink', 'portfoliourl', 'avatarurl',
  'usd', 'softlimit', 'corelimit', 'detail',
]
/** Keys that may only appear when the caller asked with includeEconomics: true. */
const MONEY_KEY = /fee|cost|emv|cpm|budget|revenue|roas|estimat|internal/i

const created = {
  userIds: [] as string[],
  campaignIds: [] as string[],
  influencerIds: [] as string[],
  settingKeys: [] as string[],
}

interface Fixtures {
  admin: { id: string; name: string }
  employee: { id: string }
  campaignId: string
  archivedId: string
  marta: string
  martaTikTok: string
  lookalike: string
  luis: string
  reelId: string
  brandId: string
}
let fx: Fixtures

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}-${randomUUID().slice(0, 8)}`

/** A real connection: register, approve as the administrator, exchange the code. */
async function connect(adminId: string) {
  const client = await registerClient({ client_name: 'Claude', redirect_uris: [CLAUDE_AI] }, nextIp())
  const verifier = randomSecret()
  const { grantId, code } = await createGrantAndCode({
    userId: adminId,
    clientId: client.client_id,
    redirectUri: CLAUDE_AI,
    codeChallenge: pkceChallengeS256(verifier),
  })
  const tokens = await exchangeCode(
    new URLSearchParams({ code, client_id: client.client_id, code_verifier: verifier, redirect_uri: CLAUDE_AI }),
  )
  return { grantId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token }
}

let rpcId = 0
function post(token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) })

interface ToolAnswer {
  status: number
  isError: boolean
  text: string
  /** The parsed JSON of a successful answer. */
  data: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const res = await post(token, rpc('tools/call', { name, arguments: args }))
  const body = (await res.json()) as { result?: { content: { type: string; text: string }[]; isError?: boolean } }
  const text = body.result?.content?.[0]?.text ?? ''
  const isError = body.result?.isError === true
  let data: unknown = null
  if (!isError) data = JSON.parse(text)
  return { status: res.status, isError, text, data }
}

/** Every key of a JSON value, at any depth, in lower case. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k.toLowerCase())
      keysOf(v, out)
    }
  }
  return out
}

/** Every number of a JSON value, at any depth. (Ids are random text: a figure is looked for among the numbers, not in the raw answer.) */
function numbersOf(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number') out.add(value)
  else if (Array.isArray(value)) for (const v of value) numbersOf(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersOf(v, out)
  return out
}

/** No forbidden key and none of the planted values. `text` is the raw answer. */
function expectClean(answer: ToolAnswer) {
  const keys = keysOf(answer.data)
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `forbidden key "${k}"`).toBe(false)
  for (const [what, secret] of Object.entries(SECRETS)) expect(answer.text, `leaked ${what}`).not.toContain(secret)
  expect(answer.text).not.toContain('@correo-inventado.test')
  expect(answer.text).not.toContain('NO-DEBE-SALIR')
}

/** No money and no estimate: by key name and by the planted values. */
function expectNoMoney(answer: ToolAnswer) {
  const offending = [...keysOf(answer.data)].filter(k => k !== 'economicsincluded' && MONEY_KEY.test(k))
  expect(offending).toEqual([])
  for (const [what, amount] of Object.entries(MONEY)) expect(answer.text, `leaked ${what}`).not.toContain(String(amount))
}

async function wipeMcp() {
  await prisma.mcpCallLog.deleteMany()
  await prisma.mcpToken.deleteMany()
  await prisma.mcpAuthCode.deleteMany()
  await prisma.mcpGrant.deleteMany()
  await prisma.mcpClient.deleteMany()
}

beforeAll(async () => {
  // Any attempt to reach the network fails the test that made it
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  await wipeMcp()

  const tag = randomUUID().slice(0, 8)
  const admin = await prisma.user.create({
    data: { email: SECRETS.adminEmail.replace('@', `+${tag}@`), password: SECRETS.passwordHash, name: 'Administradora Inventada', role: 'ADMIN' },
  })
  const admin2 = await prisma.user.create({
    data: { email: `admin2-${tag}@correo-inventado.test`, password: SECRETS.passwordHash, name: 'Segundo Admin', role: 'ADMIN' },
  })
  const employee = await prisma.user.create({
    data: { email: `pm-${tag}@correo-inventado.test`, password: SECRETS.passwordHash, name: 'PM Inventada', role: 'EMPLOYEE' },
  })
  created.userIds.push(admin.id, admin2.id, employee.id)

  const campaign = await prisma.campaign.create({
    data: {
      name: 'Campaña Inventada Otoño',
      status: 'ACTIVE',
      type: 'INFLUENCER_TRACKING',
      platforms: ['INSTAGRAM', 'TIKTOK'],
      startDate: new Date('2026-10-01T00:00:00.000Z'),
      endDate: new Date('2026-10-31T00:00:00.000Z'),
      budget: MONEY.budget,
      targetAccounts: ['marcainventada'],
      targetHashtags: ['marcainventada'],
      targetKeywords: ['superfregona'],
      targetViews: 100000,
      targetCpmMax: 20,
      manualROINotes: SECRETS.roiNotes,
      briefText: SECRETS.briefText,
      promoCode: 'OTONO10',
      clientReportedSales: 12,
      clientReportedRevenue: MONEY.revenue,
      businessResultsNotes: SECRETS.businessNotes,
      shareToken: `${SECRETS.shareToken}-${tag}`,
      userId: admin.id,
    },
  })
  const archived = await prisma.campaign.create({
    data: {
      name: 'Campaña Archivada Inventada',
      status: 'ARCHIVED',
      type: 'UGC',
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-03-31T00:00:00.000Z'),
      userId: admin.id,
    },
  })
  created.campaignIds.push(campaign.id, archived.id)

  // Brand: a real brand document for the first campaign. The second campaign
  // points at a setting that is NOT a brand and holds a secret.
  const brandId = `brand_1790000000000_${tag}`
  const poisonKey = `meta_app_secret_${tag}`
  await prisma.setting.createMany({
    data: [
      {
        key: brandId,
        value: JSON.stringify({ id: brandId, name: 'Marca Inventada', website: SECRETS.brandWebsite, assignedEmployees: [employee.id], brandUserId: 'x', createdBy: admin.id, createdAt: new Date().toISOString() }),
      },
      { key: `campaign_brand_${campaign.id}`, value: brandId },
      { key: poisonKey, value: JSON.stringify({ name: SECRETS.settingSecret }) },
      { key: `campaign_brand_${archived.id}`, value: poisonKey },
    ],
  })
  created.settingKeys.push(brandId, `campaign_brand_${campaign.id}`, poisonKey, `campaign_brand_${archived.id}`)

  const marta = await prisma.influencer.create({
    data: {
      username: 'marta_fit', platform: 'INSTAGRAM', displayName: 'Marta Inventada', followers: 50000, following: 300, postsCount: 420,
      engagementRate: 3.2, avgLikes: 900, avgComments: 40, avgViews: 12000, country: 'ES', language: 'es', isVerified: true,
      email: SECRETS.creatorEmail, phone: SECRETS.creatorPhone, bio: SECRETS.creatorBio, website: SECRETS.creatorWebsite,
      city: SECRETS.creatorCity, standardFee: MONEY.standardFee, avatarUrl: 'https://cdn-inventado.test/NO-DEBE-SALIR.jpg',
    },
  })
  const martaTikTok = await prisma.influencer.create({ data: { username: 'Marta_Fit', platform: 'TIKTOK', displayName: 'Marta en TikTok', followers: 8000 } })
  // Differs from marta_fit only where `_` would be a wildcard
  const lookalike = await prisma.influencer.create({ data: { username: 'martaxfit', platform: 'INSTAGRAM', displayName: 'Otra Persona', followers: 100 } })
  const luis = await prisma.influencer.create({
    data: { username: 'luis.tok', platform: 'TIKTOK', displayName: 'Luis Inventado', followers: 20000, email: 'luis@correo-inventado.test', phone: '+34600333444' },
  })
  created.influencerIds.push(marta.id, martaTikTok.id, lookalike.id, luis.id)

  await prisma.campaignInfluencer.create({
    data: {
      campaignId: campaign.id, influencerId: marta.id, status: 'POSTED', agreedFee: MONEY.fee, cost: 99.99, deliverablesPlanned: 3,
      notes: SECRETS.membershipNotes, shippingName: SECRETS.shippingName, shippingAddress1: SECRETS.shippingAddress,
      shippingPhone: SECRETS.shippingPhone, shippingEmail: SECRETS.shippingEmail, shippingCity: SECRETS.creatorCity,
      trackedLink: SECRETS.trackedLink, portfolioUrl: SECRETS.portfolioUrl,
    },
  })
  await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: luis.id, status: 'NEGOTIATING', cost: MONEY.productCost, notes: SECRETS.membershipNotes },
  })
  await prisma.campaignInfluencer.create({ data: { campaignId: archived.id, influencerId: marta.id, status: 'COMPLETED' } })

  const base = { campaignId: campaign.id, caption: `${SECRETS.caption} con @marcainventada`, mentions: ['marcainventada'], hashtags: [] as string[] }
  const reel = await prisma.media.create({
    data: {
      ...base, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: '3500000000000000001',
      permalink: 'https://www.instagram.com/reel/DAbc_123xyZ/', likes: 100, comments: 10, shares: 5, saves: 5, views: 2000, reach: 1500,
      postedAt: new Date('2026-10-05T10:00:00.000Z'), source: 'apify', isAdDisclosed: true,
    },
  })
  await prisma.media.create({
    data: {
      ...base, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'POST', externalId: 'DPost00001a',
      permalink: 'https://www.instagram.com/p/DPost00001a/', likes: 50, comments: 5, postedAt: new Date('2026-10-10T09:00:00.000Z'), source: 'manual',
    },
  })
  await prisma.media.create({
    data: {
      ...base, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'STORY', externalId: '3700000000000000001_555',
      views: 800, postedAt: new Date('2026-10-12T18:00:00.000Z'), source: 'apify', insightsSource: 'creator_screenshot',
    },
  })
  await prisma.media.create({
    data: {
      ...base, influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: '3500000000000000002',
      permalink: 'https://www.instagram.com/reel/DSecond0002/', likes: 200, comments: 20, views: 3000,
      postedAt: new Date('2026-10-20T12:00:00.000Z'), source: 'apify', isDeleted: true,
    },
  })
  await prisma.media.create({
    data: {
      ...base, influencerId: luis.id, platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7400000000000000001',
      permalink: 'https://www.tiktok.com/@luis.tok/video/7400000000000000001', likes: 300, comments: 30, shares: 10, views: 5000,
      postedAt: new Date('2026-10-15T20:00:00.000Z'), source: 'apify',
    },
  })
  // Read from her profile, in no campaign: published before the campaign and without the brand
  await prisma.media.create({
    data: {
      influencerId: marta.id, platform: 'INSTAGRAM', mediaType: 'REEL', externalId: '3400000000000000009',
      permalink: 'https://www.instagram.com/reel/DLoose00099/', caption: `${SECRETS.caption} sin marca`, likes: 9, views: 90,
      postedAt: new Date('2026-09-01T10:00:00.000Z'), source: 'apify',
    },
  })

  // State of the capture
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const cron = [
    { key: 'cron_stories_last_run', value: hoursAgo(2) },
    { key: 'cron_stories_last_failed', value: hoursAgo(30) },
    { key: 'cron_track_last_run', value: hoursAgo(30) },
    // No job but stories records failures: a stray key like this one must not be reported as a failure record
    { key: 'cron_check-posts_last_failed', value: hoursAgo(5) },
    {
      key: 'cron_stories_last_result',
      value: JSON.stringify({
        at: hoursAgo(2), usernamesChecked: 7, partial: false, totalStories: 9, newStories: 4, newByLink: 1, newByReshare: 1, rejectedByRules: 5,
        campaigns: [{ id: campaign.id, name: 'Campaña Inventada Otoño', creators: 1, newStories: 4 }],
        skipped: [{ id: archived.id, name: 'Campaña Archivada Inventada', reason: 'too_long', detail: SECRETS.cronExceptionDetail }],
        detail: SECRETS.cronExceptionDetail,
        somethingNew: SECRETS.settingSecret,
      }),
    },
    {
      key: 'cron_tiktok-link_last_result',
      value: JSON.stringify({
        at: hoursAgo(20), campaigns: [{ id: campaign.id, name: 'Campaña Inventada Otoño', candidates: 1, linked: ['marta_fit'], videos: 2 }],
        handlesScanned: 1, answered: 1, notFound: 0, linked: 1, videos: 2, truncated: [], partial: false,
      }),
    },
  ]
  await prisma.setting.createMany({ data: cron })
  created.settingKeys.push(...cron.map(c => c.key))

  const alert = { type: 'apify_budget', title: 'Apify ha rechazado el token', message: 'La captura automática está parada.' }
  const at = new Date(Date.now() - 3_600_000)
  await prisma.notification.createMany({
    data: [
      { ...alert, userId: admin.id, createdAt: at },
      { ...alert, userId: admin2.id, createdAt: at }, // the same alert, to the other administrator
      { userId: admin.id, type: 'cron_stale', title: 'El rastreo de stories ha fallado', message: 'No se ha podido completar.', createdAt: new Date(Date.now() - 2 * DAY) },
      { userId: admin.id, type: 'cron_stale', title: 'Aviso antiguo', message: 'De hace más de siete días.', createdAt: new Date(Date.now() - 9 * DAY) },
      { userId: admin.id, type: 'media_posted', title: 'Nueva publicación', message: 'No es un aviso de la captura.' },
      { userId: employee.id, type: 'cron_stale', title: 'Cuentas de marca corregidas', message: SECRETS.employeeAlert },
      // Same alert type, sent to the administrators, and NOT about the capture: the platform records a
      // data-deletion request of Meta this way (src/app/api/data-deletion/route.ts) and its text names a person
      {
        userId: admin.id, type: 'cron_stale', title: 'Solicitud de borrado de datos de Meta',
        message: `Meta ha enviado una solicitud de borrado de datos del usuario de Meta ${SECRETS.metaUserId} (código de confirmación ${SECRETS.deletionCode}).`,
        createdAt: new Date(Date.now() - 3 * 3_600_000),
      },
    ],
  })

  fx = {
    admin: { id: admin.id, name: admin.name },
    employee: { id: employee.id },
    campaignId: campaign.id,
    archivedId: archived.id,
    marta: marta.id,
    martaTikTok: martaTikTok.id,
    lookalike: lookalike.id,
    luis: luis.id,
    reelId: reel.id,
    brandId,
  }
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await wipeMcp()
  await prisma.notification.deleteMany({ where: { userId: { in: created.userIds } } })
  await prisma.setting.deleteMany({ where: { key: { in: created.settingKeys } } })
  await prisma.campaign.deleteMany({ where: { id: { in: created.campaignIds } } }) // memberships and media go with them
  await prisma.influencer.deleteMany({ where: { id: { in: created.influencerIds } } })
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } })
})

// =====================================================================

describe('who may call /api/mcp', () => {
  it('answers 401 with the exact WWW-Authenticate header when there is no token', async () => {
    const res = await post(null, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://intelligence.thekingofcontent.agency/.well-known/oauth-protected-resource"',
    )
    expect(res.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'unauthorized', error_description: expect.any(String) })
  })

  it('answers the same 401 for a token that is not one of ours, for a refresh token and for a token in the URL', async () => {
    const { accessToken, refreshToken } = await connect(fx.admin.id)
    const bad = [randomSecret(), 'garbage', refreshToken, `${accessToken}x`]
    for (const token of bad) {
      const res = await post(token, rpc('tools/list'))
      expect(res.status, token.slice(0, 6)).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
      expect((await res.json()).error).toBe('invalid_token')
    }
    // A valid token in the query string is not a credential
    const inUrl = await POST(
      new Request(`${ENDPOINT}?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(rpc('tools/list')),
      }),
    )
    expect(inUrl.status).toBe(401)
    expect(inUrl.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
    // Nothing was logged and no tool ran for any of them
    expect(await prisma.mcpCallLog.count()).toBe(0)
  })

  it('answers 401 with the header as soon as the grant is revoked', async () => {
    const { accessToken, grantId } = await connect(fx.admin.id)
    expect((await post(accessToken, rpc('ping'))).status).toBe(200)
    expect(await revokeGrant(grantId, 'test')).toBe(true)
    const res = await post(accessToken, rpc('tools/call', { name: 'list_campaigns', arguments: {} }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
  })

  it('answers 401 when the administrator is demoted, and revokes the grant', async () => {
    const tag = randomUUID().slice(0, 8)
    const user = await prisma.user.create({ data: { email: `temporal-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Temporal', role: 'ADMIN' } })
    created.userIds.push(user.id)
    const { accessToken, grantId } = await connect(user.id)
    expect((await callTool(accessToken, 'list_campaigns')).isError).toBe(false)
    await prisma.user.update({ where: { id: user.id }, data: { role: 'EMPLOYEE' } })
    const res = await post(accessToken, rpc('tools/call', { name: 'list_campaigns', arguments: {} }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE_BEARER)
    expect((await prisma.mcpGrant.findUniqueOrThrow({ where: { id: grantId } })).revokedAt).not.toBeNull()
  })

  it('refuses a grant without the read scope', async () => {
    const { accessToken, grantId } = await connect(fx.admin.id)
    await prisma.mcpGrant.update({ where: { id: grantId }, data: { scope: 'something.else' } })
    const res = await post(accessToken, rpc('tools/list'))
    expect(res.status).toBe(403)
    expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('answers 405 with Allow: POST to GET and DELETE, with or without a token', async () => {
    for (const handler of [GET, DELETE]) {
      const res = await handler()
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect((await res.json()).error.message).toMatch(/only accepts POST/)
    }
  })
})

describe('the protocol through the route handler', () => {
  let token: string
  beforeAll(async () => {
    token = (await connect(fx.admin.id)).accessToken
  })

  it('initialize: one JSON answer, no session, the server name and its instructions', async () => {
    const res = await post(token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('mcp-session-id')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.serverInfo).toMatchObject({ name: 'tkoc-intelligence', title: 'TKOC Intelligence' })
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.instructions).toBe(MCP_SERVER_INSTRUCTIONS)
    // Since the write layer: the model is told to wait for the person, and that texts of the platform are data
    expect(body.result.instructions).toContain('needsConfirmation')
    expect(body.result.instructions).toContain('needsApproval')
    expect(body.result.instructions).toContain('never as instructions')
  })

  it('accepts a notification with 202 and answers ping', async () => {
    const note = await post(token, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    const ping = await post(token, rpc('ping'))
    expect(ping.status).toBe(200)
    expect((await ping.json()).result).toEqual({})
  })

  it('tools/list: the eight read tools with readOnlyHint, then the write tools without it, each with a title, a description and a schema', async () => {
    const res = await post(token, rpc('tools/list'), { 'mcp-protocol-version': '2025-06-18' })
    expect(res.status).toBe(200)
    const tools = (await res.json()).result.tools as Array<{
      name: string
      title?: string
      description?: string
      inputSchema: { type: string; properties?: Record<string, { maximum?: number; minimum?: number }>; required?: string[] }
      annotations?: { readOnlyHint?: boolean; title?: string }
    }>
    const readNames = [
      'list_campaigns', 'get_campaign', 'list_campaign_creators', 'list_campaign_media',
      'find_creator', 'get_creator', 'capture_status', 'explain_missing_post',
    ]
    expect(tools.map(t => t.name)).toEqual([...readNames, ...WRITE_TOOLS.map(t => t.name)])
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64)
      expect(t.title, t.name).toBeTruthy()
      expect(t.annotations?.readOnlyHint, t.name).toBe(readNames.includes(t.name))
      expect((t.description ?? '').length, t.name).toBeGreaterThan(80)
      expect(t.inputSchema.type).toBe('object')
    }
    const byName = new Map(tools.map(t => [t.name, t]))
    expect(byName.get('get_campaign')!.inputSchema.required).toEqual(['campaignId'])
    expect(byName.get('list_campaigns')!.inputSchema.properties!.limit).toMatchObject({ minimum: 1, maximum: LIST_MAX_LIMIT })
    expect(byName.get('explain_missing_post')!.inputSchema.required!.sort()).toEqual(['campaignId', 'url'])
  })

  it('refuses what the transport refuses: wrong Accept, wrong content type, a body that is too large, an unknown protocol version', async () => {
    expect((await post(token, rpc('ping'), { accept: 'application/json' })).status).toBe(406)
    expect((await post(token, rpc('ping'), { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post(token, '{not json')).status).toBe(400)
    const huge = JSON.stringify(rpc('ping', { padding: 'x'.repeat(300 * 1024) }))
    expect((await post(token, huge)).status).toBe(413)
    expect((await post(token, rpc('ping'), { 'mcp-protocol-version': '1999-01-01' })).status).toBe(400)
  })
})

describe('the tools on invented data', () => {
  let token: string
  let grantId: string
  beforeAll(async () => {
    const c = await connect(fx.admin.id)
    token = c.accessToken
    grantId = c.grantId
  })

  it('list_campaigns: the listed fields, the brand name only from a real brand document, and the status filter', async () => {
    const all = await callTool(token, 'list_campaigns')
    expect(all.status).toBe(200)
    expect(all.isError).toBe(false)
    expectClean(all)
    expectNoMoney(all)
    expect(all.data.campaigns).toMatchObject({ returned: 2, total: 2, truncated: false })
    const autumn = all.data.campaigns.items.find((c: { id: string }) => c.id === fx.campaignId)
    expect(autumn).toEqual({
      id: fx.campaignId,
      name: 'Campaña Inventada Otoño',
      brand: 'Marca Inventada',
      status: 'ACTIVE',
      type: 'INFLUENCER_TRACKING',
      platforms: ['INSTAGRAM', 'TIKTOK'],
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      creators: 2,
      pieces: 5,
    })
    // Its mapping points at a setting that is not a brand: no name is taken from it
    const archived = all.data.campaigns.items.find((c: { id: string }) => c.id === fx.archivedId)
    expect(archived.brand).toBeNull()

    const active = await callTool(token, 'list_campaigns', { status: 'ACTIVE' })
    expect(active.data.campaigns.items.map((c: { id: string }) => c.id)).toEqual([fx.campaignId])

    const one = await callTool(token, 'list_campaigns', { limit: 1 })
    expect(one.data.campaigns).toMatchObject({ returned: 1, total: 2, truncated: true })
    expect(one.data.campaigns.truncation).toContain('Showing 1 of 2')
  })

  it('get_campaign: the figures of the platform, no money and no estimate without includeEconomics', async () => {
    const overview = (await computeCampaignOverview(fx.campaignId))!
    const answer = await callTool(token, 'get_campaign', { campaignId: fx.campaignId })
    expect(answer.isError).toBe(false)
    expectClean(answer)
    expectNoMoney(answer)
    expect(answer.data.economicsIncluded).toBe(false)
    // Whatever the key would be called: none of the money or estimate figures of the overview is in the answer
    const internalFigures = [overview.totals.cost, overview.totals.cpm as number, overview.totals.emvExtended, overview.totals.emvBasic, overview.totals.audience.estimated]
    const returned = numbersOf(answer.data)
    for (const figure of internalFigures) {
      expect(figure).toBeGreaterThan(100)
      expect(returned.has(figure), `internal figure ${figure}`).toBe(false)
    }
    expect(answer.data.campaign).toMatchObject({ id: fx.campaignId, brand: 'Marca Inventada', creators: 2, pieces: 5 })
    expect(answer.data.brandTargets).toEqual({ accounts: ['marcainventada'], hashtags: ['marcainventada'], productKeywords: ['superfregona'] })

    // Hand-checked sums of the fixtures…
    expect(answer.data.totals).toMatchObject({
      pieces: 5, posts: 4, stories: 1, piecesDeletedByCreator: 1, creators: 2, creatorsWithPieces: 2,
      views: 10800, likes: 650, comments: 65, shares: 15, saves: 5, interactions: 735, reach: 1500,
    })
    // …and the same numbers as the computation behind the screens
    expect(answer.data.totals.views).toBe(overview.totals.views)
    expect(answer.data.totals.interactions).toBe(overview.totals.engagements)
    expect(answer.data.totals.engagementRate.percent).toBe(overview.totals.er.value)
    expect(answer.data.totals.engagementRate.percent).toBeGreaterThan(0)
    expect(answer.data.delivery.creators).toEqual(overview.delivery.creators)
    expect(answer.data.delivery.pieces).toMatchObject({ planned: 3, delivered: 5, ok: true })
    // The CPM objective is money: only the views objective is public
    expect(answer.data.objectives.map((o: { metric: string }) => o.metric)).toEqual(['views'])
    expect(answer.data.balance.execution).toBe(overview.balance.execution)
  })

  it('get_campaign with includeEconomics: fee, cost and EMV appear, labelled as internal, and still nothing private', async () => {
    const overview = (await computeCampaignOverview(fx.campaignId))!
    const answer = await callTool(token, 'get_campaign', { campaignId: fx.campaignId, includeEconomics: true })
    expect(answer.isError).toBe(false)
    expectClean(answer)
    expect(answer.data.economicsIncluded).toBe(true)
    const eco = answer.data.internalEconomics
    expect(eco.internal).toBe(true)
    expect(eco.notice).toMatch(/Internal agency figures/)
    expect(eco.budget).toBe(MONEY.budget)
    expect(eco.cost).toBe(Math.round((MONEY.fee + MONEY.productCost) * 100) / 100)
    expect(eco.cost).toBe(overview.totals.cost)
    expect(eco.cpm).toBe(overview.totals.cpm)
    expect(eco.emv).toMatchObject({ estimate: true, extended: overview.totals.emvExtended, basic: overview.totals.emvBasic })
    expect(eco.emv.extended).toBeGreaterThan(0)
    expect(eco.cpmObjective.metric).toBe('cpm')
    expect(eco.clientReportedResults).toMatchObject({ promoCode: 'OTONO10', sales: 12, revenue: MONEY.revenue })
    // The public part is the same with and without the flag
    const plain = await callTool(token, 'get_campaign', { campaignId: fx.campaignId })
    expect(answer.data.totals).toEqual(plain.data.totals)
  })

  it('list_campaign_creators: handle, network, status and figures; fee and cost only with the flag', async () => {
    const plain = await callTool(token, 'list_campaign_creators', { campaignId: fx.campaignId })
    expect(plain.isError).toBe(false)
    expectClean(plain)
    expectNoMoney(plain)
    expect(plain.data.creators).toMatchObject({ returned: 2, total: 2, truncated: false })
    const overview = (await computeCampaignOverview(fx.campaignId))!
    const returned = numbersOf(plain.data)
    for (const member of overview.perInfluencer) {
      for (const figure of [member.cost, member.cpm as number, member.emvExtended]) {
        expect(figure).toBeGreaterThan(80)
        expect(returned.has(figure), `internal figure ${figure} of @${member.username}`).toBe(false)
      }
    }
    // Most views first
    expect(plain.data.creators.items[0]).toMatchObject({
      creatorId: fx.marta, handle: 'marta_fit', network: 'INSTAGRAM', status: 'POSTED', followers: 50000,
      pieces: 4, posts: 3, stories: 1, piecesDeletedByCreator: 1, piecesPlanned: 3, views: 5800, interactions: 395,
    })
    expect(plain.data.creators.items[1]).toMatchObject({ handle: 'luis.tok', network: 'TIKTOK', status: 'NEGOTIATING', pieces: 1, views: 5000 })

    const money = await callTool(token, 'list_campaign_creators', { campaignId: fx.campaignId, includeEconomics: true })
    expectClean(money)
    expect(money.data.internalNotice).toMatch(/Internal agency figures/)
    expect(money.data.creators.items[0].internalEconomics).toMatchObject({ internal: true, fee: MONEY.fee, cost: MONEY.fee })
    expect(money.data.creators.items[0].internalEconomics.emvExtended).toBeGreaterThan(0)
    // No fee agreed: the cost is the product cost
    expect(money.data.creators.items[1].internalEconomics).toMatchObject({ internal: true, fee: null, cost: MONEY.productCost })

    const cut = await callTool(token, 'list_campaign_creators', { campaignId: fx.campaignId, limit: 1 })
    expect(cut.data.creators).toMatchObject({ returned: 1, total: 2, truncated: true })
  })

  it('list_campaign_media: the pieces newest first, without captions, with the filters', async () => {
    const all = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId })
    expect(all.isError).toBe(false)
    expectClean(all)
    expectNoMoney(all)
    expect(all.data.pieces).toMatchObject({ returned: 5, total: 5, truncated: false })
    const items = all.data.pieces.items as Array<Record<string, unknown>>
    expect(items.map(i => i.postedAt)).toEqual([...items.map(i => i.postedAt)].sort().reverse())
    expect(items.find(i => i.id === fx.reelId)).toEqual({
      id: fx.reelId,
      permalink: 'https://www.instagram.com/reel/DAbc_123xyZ/',
      creator: 'marta_fit',
      network: 'INSTAGRAM',
      type: 'REEL',
      postedAt: '2026-10-05T10:00:00.000Z',
      likes: 100, comments: 10, shares: 5, saves: 5, views: 2000, reach: 1500,
      capturedBy: 'apify',
      statsFrom: null,
      deletedByCreator: false,
    })
    expect(items.filter(i => i.capturedBy === 'manual')).toHaveLength(1)
    expect(items.find(i => i.type === 'STORY')).toMatchObject({ statsFrom: 'creator_screenshot', permalink: null })
    // A figure the network does not publish for a piece is null, never a 0 that reads as measured
    expect(items.find(i => i.capturedBy === 'manual')).toMatchObject({ likes: 50, comments: 5, views: null, reach: null, saves: null, shares: null })
    expect(items.find(i => i.type === 'STORY')).toMatchObject({ views: 800, reach: null, saves: null, shares: null })
    // TikTok publishes shares and views; nobody publishes saves
    expect(items.find(i => i.network === 'TIKTOK')).toMatchObject({ views: 5000, shares: 10, saves: null, reach: null })
    expect(all.data.pieces.items.some((i: Record<string, unknown>) => i.views === 0 || i.reach === 0 || i.saves === 0)).toBe(false)

    const hers = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, creator: '@MARTA_FIT' })
    expect(hers.data.pieces.total).toBe(4)
    expect(hers.data.filters.creator).toBe('@MARTA_FIT')
    // `_` is not a wildcard: marta_fi_ is nobody
    const other = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, creator: 'marta_fi_' })
    expect(other.data.pieces.total).toBe(0)
    expect((await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, creator: 'marta%' })).isError).toBe(true)

    const reels = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, type: 'REEL', limit: 1 })
    expect(reels.data.pieces).toMatchObject({ returned: 1, total: 2, truncated: true })
    expect(reels.data.pieces.items[0].postedAt).toBe('2026-10-20T12:00:00.000Z')

    const window = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, since: '2026-10-10', until: '2026-10-15' })
    expect(window.data.pieces.items.map((i: { type: string }) => i.type).sort()).toEqual(['POST', 'STORY', 'VIDEO'])

    const backwards = await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, since: '2026-10-15', until: '2026-10-10' })
    expect(backwards.isError).toBe(true)
  })

  it('find_creator: by handle or public name, no contact data, and `_` is not a wildcard', async () => {
    const byHandle = await callTool(token, 'find_creator', { query: 'marta_fit' })
    expect(byHandle.isError).toBe(false)
    expectClean(byHandle)
    expectNoMoney(byHandle)
    const handles = byHandle.data.creators.items.map((c: { handle: string; network: string }) => `${c.handle}:${c.network}`)
    expect(handles).toEqual(['marta_fit:INSTAGRAM', 'Marta_Fit:TIKTOK'])
    expect(byHandle.data.creators.items[0]).toEqual({
      id: fx.marta, handle: 'marta_fit', network: 'INSTAGRAM', name: 'Marta Inventada', followers: 50000, country: 'ES', verified: true, campaigns: 2,
    })

    const byName = await callTool(token, 'find_creator', { query: 'inventad' })
    expect(byName.data.creators.items.map((c: { handle: string }) => c.handle).sort()).toEqual(['luis.tok', 'marta_fit'])

    const onTikTok = await callTool(token, 'find_creator', { query: '@marta', platform: 'TIKTOK' })
    expect(onTikTok.data.creators.items.map((c: { id: string }) => c.id)).toEqual([fx.martaTikTok])

    // Searching by a part of her e-mail finds nobody: the e-mail is not searched
    const byEmail = await callTool(token, 'find_creator', { query: 'correo-inventado' })
    expect(byEmail.data.creators.total).toBe(0)

    const percent = await callTool(token, 'find_creator', { query: '%%' })
    expect(percent.data.creators.total).toBe(0)
  })

  it('get_creator: the public profile and her campaigns, by id or by handle and network', async () => {
    const byId = await callTool(token, 'get_creator', { influencerId: fx.marta })
    expect(byId.isError).toBe(false)
    expectClean(byId)
    expectNoMoney(byId)
    expect(byId.data.creator).toEqual({
      id: fx.marta, handle: 'marta_fit', network: 'INSTAGRAM', name: 'Marta Inventada', followers: 50000, country: 'ES', verified: true,
      following: 300, posts: 420, profileEngagementRate: 3.2, averageLikes: 900, averageComments: 40, averageViews: 12000,
      language: 'es', profileReadAt: null,
    })
    expect(byId.data.campaigns).toMatchObject({ returned: 2, total: 2, truncated: false })
    expect(byId.data.campaigns.items[0]).toEqual({
      campaignId: fx.campaignId, name: 'Campaña Inventada Otoño', brand: 'Marca Inventada', campaignStatus: 'ACTIVE',
      creatorStatus: 'POSTED', startDate: '2026-10-01', endDate: '2026-10-31', pieces: 4,
    })
    expect(byId.data.campaigns.items[1]).toMatchObject({ campaignId: fx.archivedId, brand: null, creatorStatus: 'COMPLETED', pieces: 0 })

    const byHandle = await callTool(token, 'get_creator', { handle: '@Marta_Fit', platform: 'INSTAGRAM' })
    expect(byHandle.data.creator.id).toBe(fx.marta)

    const ambiguous = await callTool(token, 'get_creator', { handle: 'marta_fit' })
    expect(ambiguous.data.found).toBe(false)
    expect(ambiguous.data.candidates.map((c: { id: string }) => c.id).sort()).toEqual([fx.marta, fx.martaTikTok].sort())
    expectClean(ambiguous)

    expect((await callTool(token, 'get_creator', { handle: 'nobody_here' })).isError).toBe(true)
    expect((await callTool(token, 'get_creator', {})).isError).toBe(true)
    expect((await callTool(token, 'get_creator', { influencerId: 'doesnotexist' })).isError).toBe(true)
  })

  it('capture_status: the jobs, the last results without their free text, Apify without amounts and the alerts of the administrators', async () => {
    const answer = await callTool(token, 'capture_status')
    expect(answer.isError).toBe(false)
    expectClean(answer)
    expectNoMoney(answer)
    expect(answer.text).not.toContain('TOKEN-APIFY')
    const jobs = new Map<string, Record<string, unknown>>(answer.data.jobs.map((j: { job: string }) => [j.job, j]))
    expect([...jobs.keys()]).toEqual(['stories', 'track', 'check-posts', 'tiktok-link', 'watchdog'])
    expect(jobs.get('stories')!.hoursSinceLastRunStamp).toBeCloseTo(2, 0)
    expect(jobs.get('stories')).toMatchObject({ failuresRecorded: true, lastFailedAt: expect.any(String) })
    expect(jobs.get('stories')!.runStampMeans).toMatch(/when a scan starts/)
    expect(jobs.get('track')!.hoursSinceLastRunStamp).toBeCloseTo(30, 0)
    // A run stamp is a run stamp: nothing in the answer calls it a completed run
    expect(jobs.get('track')).not.toHaveProperty('lastCompletedRunAt')
    // Only stories records its failures: the others never say "no failure", they say it is not recorded
    for (const job of ['track', 'check-posts', 'tiktok-link', 'watchdog']) {
      expect(jobs.get(job), job).toMatchObject({ failuresRecorded: false, lastFailedAt: 'not_recorded' })
    }
    expect(jobs.get('check-posts')).toMatchObject({ lastRunStampAt: null, hoursSinceLastRunStamp: null })
    expect(jobs.get('check-posts')!.runStampMeans).toMatch(/also when it failed/)

    expect(answer.data.storiesLastResult).toMatchObject({
      failed: false, creatorsChecked: 7, storiesSeen: 9, newStories: 4, newByBrandLink: 1, newBySharedPost: 1, rejectedByRules: 5,
      campaignsScanned: [{ campaignId: fx.campaignId, name: 'Campaña Inventada Otoño', creators: 1, newStories: 4 }],
      campaignsNotScanned: [{ campaignId: fx.archivedId, name: 'Campaña Archivada Inventada', reason: 'too_long' }],
    })
    expect(answer.data.tiktokLinkLastResult).toMatchObject({ accountsLinked: 1, videosCaptured: 2, handlesRead: 1 })
    expect(answer.data.tiktokLinkLastResult.campaigns[0].linked).toEqual(['marta_fit'])

    // No token in this test: nothing is known, nothing is asked, nothing is blocked
    expect(answer.data.apify).toEqual({
      tokenState: 'unknown', monthlyLimitReached: false, resumesAt: null, planUsedPercent: null,
      captureJobsPausedByPlanLimit: false, discoverSearchPausedByPlanLimit: false, cycleEndsAt: null,
    })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()

    // Two alerts of the last seven days, each once although two administrators received the first
    expect(answer.data.alertsLast7Days).toMatchObject({ returned: 2, total: 2, truncated: false })
    expect(answer.data.alertsLast7Days.items.map((a: { title: string }) => a.title)).toEqual([
      'Apify ha rechazado el token',
      'El rastreo de stories ha fallado',
    ])
    expect(answer.data.alertsLast7Days.items[0]).toMatchObject({ type: 'apify_budget', message: 'La captura automática está parada.' })
    // The data-deletion request has the same alert type and is not about the capture: counted, not a word of it shown
    expect(answer.data.otherAlertsNotShown).toBe(1)
    expect(answer.text).not.toContain('borrado de datos')
  })

  it('explain_missing_post: a piece that is in the campaign, found by its link although the stored id is another', async () => {
    const answer = await callTool(token, 'explain_missing_post', {
      campaignId: fx.campaignId,
      url: 'https://www.instagram.com/marta_fit/reel/DAbc_123xyZ/?igsh=abc',
    })
    expect(answer.isError).toBe(false)
    expectClean(answer)
    expectNoMoney(answer)
    expect(answer.data.link).toMatchObject({ recognised: true, network: 'INSTAGRAM', type: 'REEL', publicationId: 'DAbc_123xyZ', handleInLink: 'marta_fit' })
    expect(answer.data.inThisCampaign).toBe(true)
    expect(answer.data.platformRecords.inThisCampaign).toEqual([
      { pieceId: fx.reelId, campaignId: fx.campaignId, campaign: 'Campaña Inventada Otoño', creator: 'marta_fit', type: 'REEL', postedAt: '2026-10-05T10:00:00.000Z', capturedBy: 'apify', deletedByCreator: false },
    ])
    expect(answer.data.author).toEqual({ handle: 'marta_fit', knownFrom: 'platform_record', isMember: true, statusInCampaign: 'POSTED' })
    const results = Object.fromEntries(answer.data.checks.map((c: { rule: string; result: string }) => [c.rule, c.result]))
    expect(results).toEqual({ campaign_active: 'pass', brand_targets: 'pass', membership: 'pass', creator_status: 'pass', dates: 'pass', brand_reference: 'pass' })
    expect(answer.data.conclusion).toMatch(/IS in this campaign/)
  })

  it('explain_missing_post: a piece outside the dates and without the brand, kept in no campaign', async () => {
    const answer = await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'instagram.com/reel/DLoose00099' })
    expectClean(answer)
    expect(answer.data.inThisCampaign).toBe(false)
    expect(answer.data.platformRecords.notInAnyCampaign).toHaveLength(1)
    const results = Object.fromEntries(answer.data.checks.map((c: { rule: string; result: string }) => [c.rule, c.result]))
    expect(results).toMatchObject({ membership: 'pass', dates: 'fail', brand_reference: 'fail' })
    expect(answer.data.conclusion).toMatch(/NOT in this campaign/)
    expect(answer.data.conclusion).toMatch(/It does not meet: dates, brand_reference\./)
  })

  it('explain_missing_post: says what it cannot know without reading the network', async () => {
    // A reel nobody stored: the link carries no author
    const unknown = await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'https://www.instagram.com/reel/DNeverSeen01/' })
    expectClean(unknown)
    const results = Object.fromEntries(unknown.data.checks.map((c: { rule: string; result: string }) => [c.rule, c.result]))
    expect(results).toMatchObject({ membership: 'unknown', dates: 'unknown', brand_reference: 'unknown' })
    expect(unknown.data.author).toEqual({ handle: null, knownFrom: null, isMember: null, statusInCampaign: null })
    expect(unknown.data.notDeterminedWithoutReadingTheNetwork.length).toBeGreaterThanOrEqual(4)
    expect(unknown.data.conclusion).toMatch(/Could not be checked without reading the network: membership, dates, brand_reference\. No rule that can be checked rejects it\./)

    // A TikTok video of somebody who is not a member
    const stranger = await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'https://www.tiktok.com/@marta_fit/video/7499999999999999999' })
    const strangerResults = Object.fromEntries(stranger.data.checks.map((c: { rule: string; result: string }) => [c.rule, c.result]))
    expect(strangerResults.membership).toBe('fail')
    expect(stranger.data.checks.find((c: { rule: string }) => c.rule === 'membership').explanation).toMatch(/member on INSTAGRAM/)

    // A story looked up in a campaign that is archived, has no brand targets and ended months before
    const story = await callTool(token, 'explain_missing_post', { campaignId: fx.archivedId, url: 'https://www.instagram.com/stories/marta_fit/3700000000000000001/' })
    expect(story.data.link).toMatchObject({ type: 'STORY', handleInLink: 'marta_fit' })
    const storyResults = Object.fromEntries(story.data.checks.map((c: { rule: string; result: string }) => [c.rule, c.result]))
    expect(storyResults).toMatchObject({ campaign_active: 'fail', brand_targets: 'fail', stories_scan: 'fail' })
    // The platform has that story, in the other campaign
    expect(story.data.platformRecords.inOtherCampaigns).toHaveLength(1)

    const notALink = await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'https://vm.tiktok.com/ZMabcdef/' })
    expect(notALink.data.link.recognised).toBe(false)
    expect(notALink.data.checks[0]).toMatchObject({ rule: 'link', result: 'fail' })

    const missing = await callTool(token, 'explain_missing_post', { campaignId: 'nosuchcampaign', url: 'https://www.instagram.com/reel/DAbc_123xyZ/' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/Campaign not found/)
  })

  it('writes one log line per call: the tool, a summary of the arguments and the size of the answer, never the answer', async () => {
    await prisma.mcpCallLog.deleteMany()
    // The rows are read back in the order they were written: keep their timestamps apart
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    const ok = await callTool(token, 'get_campaign', { campaignId: fx.campaignId, includeEconomics: true })
    await tick()
    const search = await callTool(token, 'find_creator', { query: 'Marta Inventada' })
    await tick()
    const link = await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'https://www.tiktok.com/@luis.tok/video/7400000000000000001?secret=NO-DEBE-SALIR' })
    await tick()
    const failed = await callTool(token, 'get_campaign', { campaignId: 'nosuchcampaign' })
    expect(failed.isError).toBe(true)
    await tick()
    // Refused by the SDK before any tool runs: still logged
    const invalid = await callTool(token, 'list_campaigns', { limit: 9999 })
    expect(invalid.status).toBe(200)
    expect(invalid.isError).toBe(true)
    await tick()
    const unknownTool = await callTool(token, 'drop_everything', { now: true })
    expect(unknownTool.isError).toBe(true)

    const rows = await prisma.mcpCallLog.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows.map(r => [r.tool, r.ok])).toEqual([
      ['get_campaign', true],
      ['find_creator', true],
      ['explain_missing_post', true],
      ['get_campaign', false],
      ['list_campaigns', false],
      ['drop_everything', false],
    ])
    for (const r of rows) {
      expect(r.grantId).toBe(grantId)
      expect(r.userId).toBe(fx.admin.id)
      expect(r.argsSummary.length).toBeLessThanOrEqual(300)
      expect(r.ms).toBeGreaterThanOrEqual(0)
    }
    expect(rows[0].argsSummary).toBe(`campaignId=${fx.campaignId} includeEconomics=true`)
    expect(rows[0].resultChars).toBe(ok.text.length)
    // A name typed by a person is not kept: only that there was a text, and its length
    expect(rows[1].argsSummary).toBe('query=(text, 15 chars)')
    expect(rows[1].resultChars).toBe(search.text.length)
    // The link is kept as what it identifies, without its query string
    expect(rows[2].argsSummary).toBe(`campaignId=${fx.campaignId} link=TIKTOK:VIDEO:7400000000000000001 handle=@luis.tok`)
    expect(rows[2].resultChars).toBe(link.text.length)
    expect(rows[3].argsSummary).toBe('campaignId=nosuchcampaign includeEconomics=false')
    expect(rows[4]).toMatchObject({ argsSummary: 'not run: unknown tool or invalid arguments', resultChars: 0 })
    // Nothing of any answer, and nothing private, is in the log
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain('NO-DEBE-SALIR')
    expect(stored).not.toContain('Marta')
    expect(stored).not.toContain('Marca Inventada')
    expect(stored).not.toContain(String(MONEY.fee))
  })

  it('lets a large write call reach its tool, and refuses a flood of elements before any validation, logged once each', async () => {
    await prisma.mcpCallLog.deleteMany()
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    // 3,000 elements: far above what a read tool takes, under the ceiling. platform_request itself
    // refuses the route (users are out of reach), which proves the call reached the tool
    const big = await callTool(token, 'platform_request', { method: 'POST', path: '/api/team', body: { ids: Array.from({ length: 3_000 }, () => 0) } })
    expect(big.isError).toBe(true)
    expect(big.text).not.toContain('elements')
    await tick()
    const flood = await callTool(token, 'platform_request', { method: 'POST', path: '/api/team', body: { ids: Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, () => 0) } })
    expect(flood.isError).toBe(true)
    expect(flood.text).toContain(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`)
    const rows = await prisma.mcpCallLog.findMany({ orderBy: { createdAt: 'asc' } })
    expect(rows.map(r => [r.tool, r.ok])).toEqual([['platform_request', false], ['platform_request', false]])
    // The first was refused by the tool (its own log line), the second by the SDK (the server's line)
    expect(rows[0].argsSummary).toMatch(/^\[-:refused\] method=POST route=\/api\/team /)
    expect(rows[1].argsSummary).toBe('not run: unknown tool or invalid arguments')
  })

  it('keeps no number typed into a search or a handle: it may be a phone number', async () => {
    await prisma.mcpCallLog.deleteMany()
    const tick = () => new Promise(resolve => setTimeout(resolve, 5))
    const phone = await callTool(token, 'find_creator', { query: '612345678' })
    expect(phone.data.creators.total).toBe(0)
    await tick()
    await callTool(token, 'get_creator', { handle: '612345678' })
    await tick()
    await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId, creator: '@612345678' })
    const rows = await prisma.mcpCallLog.findMany({ orderBy: { createdAt: 'asc' }, select: { tool: true, argsSummary: true } })
    expect(rows).toEqual([
      { tool: 'find_creator', argsSummary: 'query=(text, 9 chars)' },
      { tool: 'get_creator', argsSummary: 'handle=(digits only)' },
      { tool: 'list_campaign_media', argsSummary: `campaignId=${fx.campaignId} creator=(digits only)` },
    ])
    expect(JSON.stringify(rows)).not.toContain('612345678')
  })

  it('answers a failure of ours with a generic sentence, logs it and tells nothing about the database', async () => {
    await prisma.mcpCallLog.deleteMany()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    // A real failure: the table the brand names are read from is gone for a moment
    await prisma.$executeRawUnsafe('ALTER TABLE "settings" RENAME TO "settings_gone_for_a_test"')
    let answer: ToolAnswer
    try {
      answer = await callTool(token, 'list_campaigns')
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "settings_gone_for_a_test" RENAME TO "settings"')
    }
    const logged = quiet.mock.calls.map(c => c.join(' ')).join('\n')
    quiet.mockRestore()
    expect(answer.status).toBe(200)
    expect(answer.isError).toBe(true)
    expect(answer.text).toBe('The tool failed on the server. Nothing was changed. Try again in a moment.')
    // The cause went to the server log, not to the client
    expect(logged).toContain('[MCP] list_campaigns failed')
    expect(await prisma.mcpCallLog.findMany()).toMatchObject([{ tool: 'list_campaigns', ok: false, argsSummary: '' }])
    // And the platform works again
    expect((await callTool(token, 'list_campaigns')).isError).toBe(false)
  })

  it('returns no data when the call cannot be logged', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    await prisma.$executeRawUnsafe('ALTER TABLE "mcp_call_logs" RENAME TO "mcp_call_logs_gone_for_a_test"')
    let answer: ToolAnswer
    try {
      answer = await callTool(token, 'list_campaigns')
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "mcp_call_logs_gone_for_a_test" RENAME TO "mcp_call_logs"')
      quiet.mockRestore()
    }
    expect(answer.isError).toBe(true)
    expect(answer.text).toBe('The call could not be recorded, so no data was returned. Try again in a moment.')
    expect(answer.text).not.toContain('Campaña')
  })

  it('never writes to the data of the platform', async () => {
    const snapshot = async () => ({
      campaigns: await prisma.campaign.findMany({ orderBy: { id: 'asc' } }),
      members: await prisma.campaignInfluencer.findMany({ orderBy: { id: 'asc' } }),
      creators: await prisma.influencer.findMany({ orderBy: { id: 'asc' } }),
      media: await prisma.media.findMany({ orderBy: { id: 'asc' } }),
      settings: await prisma.setting.findMany({ orderBy: { key: 'asc' } }),
      notifications: await prisma.notification.count(),
      users: await prisma.user.findMany({ orderBy: { id: 'asc' } }),
    })
    const before = await snapshot()
    await callTool(token, 'list_campaigns')
    await callTool(token, 'get_campaign', { campaignId: fx.campaignId, includeEconomics: true })
    await callTool(token, 'list_campaign_creators', { campaignId: fx.campaignId, includeEconomics: true })
    await callTool(token, 'list_campaign_media', { campaignId: fx.campaignId })
    await callTool(token, 'find_creator', { query: 'marta' })
    await callTool(token, 'get_creator', { influencerId: fx.marta })
    await callTool(token, 'capture_status')
    await callTool(token, 'explain_missing_post', { campaignId: fx.campaignId, url: 'https://www.instagram.com/reel/DAbc_123xyZ/' })
    expect(await snapshot()).toEqual(before)
  })
})

describe('the rate limits of a grant: 120 tool calls and 600 requests per 10 minutes', () => {
  it('a tool call over its allowance is a tool error the model can read, and the connection keeps working', async () => {
    const a = await connect(fx.admin.id)
    const b = await connect(fx.admin.id)
    // The allowance of tool calls is spent: only tool calls spend it
    for (let i = 0; i < CALL_RATE_LIMIT.max; i++) expect(allowCall(a.grantId)).toBe(true)

    const over = await callTool(a.accessToken, 'list_campaigns')
    expect(over.status).toBe(200)
    expect(over.isError).toBe(true)
    expect(over.text).toMatch(/Rate limit reached: at most 120 tool calls every 10 minutes/)
    expect(over.text).not.toContain('Campaña')
    expect(await prisma.mcpCallLog.findMany({ where: { grantId: a.grantId }, select: { tool: true, ok: true, argsSummary: true } })).toEqual([
      { tool: 'list_campaigns', ok: false, argsSummary: 'not run: rate limit' },
    ])

    // Everything that is not a tool call still works: Claude can still connect and list the tools
    const hello = await post(a.accessToken, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }))
    expect(hello.status).toBe(200)
    expect((await post(a.accessToken, rpc('tools/list'))).status).toBe(200)
    expect((await post(a.accessToken, rpc('ping'))).status).toBe(200)
    expect((await callTool(a.accessToken, 'list_campaigns')).isError).toBe(true)

    // Another connection of the same administrator has its own allowance
    expect((await callTool(b.accessToken, 'list_campaigns')).isError).toBe(false)
  })

  it('initialize, tools/list and ping never spend a tool call', async () => {
    const c = await connect(fx.admin.id)
    for (let i = 0; i < 5; i++) {
      expect((await post(c.accessToken, rpc('tools/list'))).status).toBe(200)
      expect((await post(c.accessToken, rpc('ping'))).status).toBe(200)
    }
    // Exactly the 120 tool calls are left
    for (let i = 0; i < CALL_RATE_LIMIT.max; i++) expect(allowCall(c.grantId)).toBe(true)
    expect(allowCall(c.grantId)).toBe(false)
  })

  it('answers 429 to the request after the last one allowed, of any kind, and only for that grant', async () => {
    const a = await connect(fx.admin.id)
    const b = await connect(fx.admin.id)
    for (let i = 0; i < REQUEST_RATE_LIMIT.max; i++) expect(allowRequest(a.grantId)).toBe(true)
    for (const body of [rpc('ping'), rpc('tools/list'), rpc('tools/call', { name: 'list_campaigns', arguments: {} })]) {
      const res = await post(a.accessToken, body)
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe('60')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect((await res.json()).error).toBe('rate_limited')
      // The token is still valid: it is a limit, not a 401
      expect(res.headers.get('www-authenticate')).toBeNull()
    }
    // Nothing ran, so nothing was logged
    expect(await prisma.mcpCallLog.count({ where: { grantId: a.grantId } })).toBe(0)
    expect((await post(b.accessToken, rpc('ping'))).status).toBe(200)
  })

  it('counts every tool call of a batch, the first one included', async () => {
    const c = await connect(fx.admin.id)
    // Two calls left
    for (let i = 0; i < CALL_RATE_LIMIT.max - 2; i++) expect(allowCall(c.grantId)).toBe(true)
    const res = await post(c.accessToken, [
      rpc('tools/call', { name: 'list_campaigns', arguments: { limit: 1 } }),
      rpc('tools/call', { name: 'list_campaigns', arguments: { limit: 1 } }),
      rpc('tools/call', { name: 'list_campaigns', arguments: { limit: 1 } }),
      rpc('tools/call', { name: 'list_campaigns', arguments: { limit: 1 } }),
    ])
    expect(res.status).toBe(200)
    const answers = (await res.json()) as Array<{ result: { isError?: boolean; content: { text: string }[] } }>
    expect(answers).toHaveLength(4)
    // The first two spend the last two calls; the other two are refused
    expect(answers.filter(a => !a.result.isError)).toHaveLength(2)
    const refused = answers.filter(a => a.result.isError)
    expect(refused).toHaveLength(2)
    for (const r of refused) {
      expect(r.result.content[0].text).toMatch(/Rate limit reached/)
      expect(r.result.content[0].text).not.toContain('Campaña')
    }
    const rows = await prisma.mcpCallLog.findMany({ where: { grantId: c.grantId } })
    expect(rows.filter(r => r.ok)).toHaveLength(2)
    expect(rows.filter(r => !r.ok).map(r => r.argsSummary)).toEqual(['not run: rate limit', 'not run: rate limit'])
    // The next tool call is refused, a request that is not a tool call is not
    expect((await callTool(c.accessToken, 'list_campaigns')).isError).toBe(true)
    expect((await post(c.accessToken, rpc('ping'))).status).toBe(200)
  })
})

describe('a batch of calls in one request', () => {
  it('runs its tool calls one after the other, never side by side', async () => {
    const c = await connect(fx.admin.id)
    apifyWatch.peak = 0
    apifyWatch.delayMs = 40
    try {
      const res = await post(c.accessToken, [
        rpc('tools/call', { name: 'capture_status', arguments: {} }),
        rpc('tools/call', { name: 'capture_status', arguments: {} }),
        rpc('tools/call', { name: 'capture_status', arguments: {} }),
      ])
      expect(res.status).toBe(200)
      const answers = (await res.json()) as Array<{ result: { isError?: boolean } }>
      expect(answers).toHaveLength(3)
      expect(answers.every(a => !a.result.isError)).toBe(true)
    } finally {
      apifyWatch.delayMs = 0
    }
    expect(apifyWatch.peak).toBe(1)
    expect(await prisma.mcpCallLog.count({ where: { grantId: c.grantId, tool: 'capture_status', ok: true } })).toBe(3)
  })
})

describe('the resource this endpoint is', () => {
  it('is the URL the tokens are bound to', () => {
    expect(MCP_RESOURCE).toBe(ENDPOINT)
  })
})
