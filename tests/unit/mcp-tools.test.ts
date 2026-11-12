import { describe, expect, it, vi } from 'vitest'

// Before any import: no database, no address and no Apify token in the
// environment. Nothing in this file reaches a database or the network.
//
// `@/lib/db` is replaced by a database that IGNORES `select` and `where` and
// answers every read with rows that carry every private column (POISON). It is
// the worst case for the tools: if one of them copied a row instead of naming
// its fields, the private columns would be in its answer.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'unit-test-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.DATABASE_URL
  delete process.env.APIFY_API_KEY

  /** Every forbidden column, filled with a value that is easy to find. Spread into every fixture row. */
  const POISON: Record<string, unknown> = {
    email: 'LEAK-email@correo-inventado.test',
    phone: 'LEAK-+34600111222',
    password: 'LEAK-password-hash',
    shippingAddress1: 'LEAK-Calle Inventada 1',
    shippingAddress2: 'LEAK-4B',
    shippingName: 'LEAK-destinataria',
    shippingPhone: 'LEAK-+34600999888',
    shippingEmail: 'LEAK-envio@correo-inventado.test',
    shippingCity: 'LEAK-ciudad-envio',
    shippingPostCode: 'LEAK-28000',
    shippingComments: 'LEAK-comentario',
    notes: 'LEAK-nota-interna',
    accessToken: 'LEAK-access-token',
    refreshToken: 'LEAK-refresh-token',
    token: 'LEAK-invitation-token',
    tokenHash: 'LEAK-token-hash',
    shareToken: 'LEAK-share-token',
    bio: 'LEAK-bio',
    website: 'LEAK-https://web.test',
    city: 'LEAK-ciudad',
    standardFee: 987654.32,
    caption: 'LEAK-caption',
    briefText: 'LEAK-brief',
    manualROINotes: 'LEAK-roi',
    businessResultsNotes: 'LEAK-negocio',
    trackedLink: 'LEAK-https://utm.test',
    portfolioUrl: 'LEAK-https://portfolio.test',
    avatarUrl: 'LEAK-https://cdn.test/a.jpg',
    detail: 'LEAK-https://api.apify.com/v2?token=abc',
    user: { email: 'LEAK-owner@correo-inventado.test', password: 'LEAK-owner-hash' },
    contactInfo: [{ email: 'LEAK-contact@correo-inventado.test', phone: 'LEAK-contact-phone', notes: 'LEAK-contact-note' }],
    socialTokens: [{ accessToken: 'LEAK-social-access', refreshToken: 'LEAK-social-refresh' }],
  }

  const creator = {
    ...POISON, id: 'inf1', username: 'marta_fit', platform: 'INSTAGRAM', displayName: 'Marta Inventada', followers: 50000, following: 300,
    postsCount: 420, engagementRate: 3.2, avgLikes: 900, avgComments: 40, avgViews: 12000, country: 'ES', language: 'es', isVerified: true,
    lastScraped: new Date('2026-11-01T08:00:00.000Z'), gender: 'F', _count: { campaigns: 2 },
  }
  const membership = {
    ...POISON, id: 'ci1', campaignId: 'c1', influencerId: 'inf1', status: 'POSTED', agreedFee: 12345.67, cost: 99.99, askingFee: 99999.99,
    deliverablesPlanned: 2, negotiatedFormat: null, baselineSnapshot: null, trackedClicks: 5, influencer: creator,
  }
  const campaign = {
    ...POISON, id: 'c1', name: 'Campaña Inventada', status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'],
    startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-10-31T00:00:00.000Z'), budget: 65432.1,
    targetAccounts: ['marcainventada'], targetHashtags: [], targetKeywords: ['superfregona'], targetViews: 1000, targetCpmMax: 20,
    promoCode: 'OTONO10', clientReportedSales: 12, clientReportedRevenue: 98765.4, businessResultsSource: 'LEAK-fuente',
    influencers: [membership], _count: { influencers: 1, media: 3 },
  }
  const piece = (id: string, over: Record<string, unknown>) => ({
    ...POISON, id, campaignId: 'c1', influencerId: 'inf1', platform: 'INSTAGRAM', mediaType: 'REEL', externalId: `35000000000000000${id}`,
    permalink: `https://www.instagram.com/reel/DAbc_123x${id}/`, caption: 'LEAK-caption con @marcainventada', mentions: ['marcainventada'], hashtags: [],
    likes: 100, comments: 10, shares: 5, saves: 5, views: 4000, reach: 3000, impressions: 0, postedAt: new Date('2026-10-05T10:00:00.000Z'),
    source: 'apify', insightsSource: null, isDeleted: false, isAdDisclosed: true, isPaidPartnership: false,
    influencer: creator, campaign, ...over,
  })
  const media = [piece('1', {}), piece('2', { views: 6000 }), piece('3', { mediaType: 'POST', views: 0, reach: 0, permalink: 'https://www.instagram.com/p/DPost000003/' })]
  const settings = [
    { key: 'campaign_brand_c1', value: 'brand_1790000000000_ab12cd34' },
    { key: 'brand_1790000000000_ab12cd34', value: JSON.stringify({ name: 'Marca Inventada', website: 'LEAK-https://marca.test', brandUserId: 'LEAK-user' }) },
    { key: 'apify_api_key', value: 'LEAK-apify-key' },
    { key: 'cron_stories_last_run', value: '2026-11-12T09:00:00.000Z' },
    { key: 'cron_stories_last_result', value: JSON.stringify({ at: '2026-11-12T09:00:00.000Z', failed: true, reason: 'exception', detail: 'LEAK-exception text', totalStories: 3 }) },
    { key: 'cron_tiktok-link_last_result', value: JSON.stringify({ at: '2026-11-11T09:00:00.000Z', linked: 1, videos: 2, campaigns: [{ id: 'c1', name: 'Campaña Inventada', linked: ['marta_fit'] }], secret: 'LEAK-extra' }) },
  ]
  const alert = { ...POISON, id: 'n1', userId: 'u1', type: 'cron_stale', title: 'El rastreo de stories ha fallado', message: 'No se ha podido completar.', link: '/settings', createdAt: new Date('2026-11-11T07:00:00.000Z') }

  const model = (rows: unknown[]) => ({
    findMany: async () => rows,
    findUnique: async () => rows[0] ?? null,
    findFirst: async () => rows[0] ?? null,
    count: async () => rows.length,
  })
  const prisma = {
    campaign: model([campaign]),
    campaignInfluencer: model([{ ...membership, campaign }]),
    influencer: model([creator]),
    media: { ...model(media), groupBy: async () => [{ campaignId: 'c1', _count: { _all: 3 } }] },
    // A single setting is only ever asked for by the EMV rates and the Apify token: neither exists here
    setting: { ...model(settings), findUnique: async () => null },
    user: model([{ ...POISON, id: 'u1', name: 'Administradora', role: 'ADMIN', isActive: true }]),
    notification: model([alert]),
  }
  return { POISON, prisma }
})

vi.mock('@/lib/db', () => ({ prisma: h.prisma }))
// Apify with real amounts in its budget: the tools may only pass on the percentage
vi.mock('@/lib/apify', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/apify')>()),
  checkApifyAuth: async () => 'rejected' as const,
  getApifyBudget: async () => ({
    usd: 81.37, limit: 88.53, softLimit: 75.22, coreLimit: 84.07, cycleEndsAt: '2026-12-01T00:00:00.000Z',
    optionalBlocked: true, coreBlocked: false, usedPct: 92,
  }),
}))

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { stripEconomics } from '@/lib/campaign-overview'
import type { CampaignOverview, PerInfluencerMetrics } from '@/lib/metrics'
import { ARGS_SUMMARY_MAX_CHARS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '@/lib/mcp/config'
import { MAX_TOOL_INPUT_ELEMENTS, MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS, createMcpServer } from '@/lib/mcp/server'
import { MCP_TOOLS } from '@/lib/mcp/tools'
import { WRITE_TOOLS, registerWriteTools } from '@/lib/mcp/tools/write'
import { brandNameFromSetting, isBrandId } from '@/lib/mcp/tools/brands'
import {
  type DiagnosisCampaign,
  type DiagnosisMember,
  type DiagnosisRecord,
  diagnosePost,
  isSamePublication,
  parseLink,
} from '@/lib/mcp/tools/explain-missing-post'
import {
  serializeAlert,
  serializeApify,
  serializeBrandTargets,
  serializeCampaign,
  serializeCampaignCreator,
  serializeCampaignCreatorEconomics,
  serializeCampaignEconomics,
  serializeCampaignResults,
  serializeCaptureJob,
  serializeCreator,
  serializeCreatorCampaign,
  serializeCreatorProfile,
  serializeMedia,
  serializeMediaRecord,
  serializeStoriesResult,
  serializeTikTokLinkResult,
} from '@/lib/mcp/tools/serializers'
import {
  LIST_MAX_CHARS,
  ToolError,
  clampLimit,
  cleanHandle,
  dayAfter,
  formatArgsSummary,
  listEnvelope,
  parseDay,
  shortText,
  summarizeHandleArg,
  summarizeQuery,
} from '@/lib/mcp/tools/shared'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOOLS_DIR = path.resolve(here, '..', '..', 'src', 'lib', 'mcp', 'tools')

// ---------- What must never leave ----------

/** The keys the spec names, plus the other private columns of the same rows. Compared in lower case. */
const FORBIDDEN_KEYS = [
  'email', 'phone', 'password', 'shippingAddress1', 'notes', 'accessToken',
  'shippingAddress2', 'shippingName', 'shippingPhone', 'shippingEmail', 'shippingCity', 'shippingPostCode', 'shippingComments',
  'refreshToken', 'token', 'tokenHash', 'codeHash', 'shareToken', 'invitationToken',
  'bio', 'website', 'city', 'standardFee', 'caption', 'briefText', 'manualROINotes', 'businessResultsNotes', 'businessNotes',
  'trackedLink', 'portfolioUrl', 'avatarUrl', 'usd', 'limit', 'softLimit', 'coreLimit', 'detail',
].map(k => k.toLowerCase())

const POISON = h.POISON

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

function expectClean(output: unknown) {
  const keys = keysOf(output)
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `forbidden key "${k}"`).toBe(false)
  const text = JSON.stringify(output)
  expect(text).not.toContain('LEAK-')
  expect(text).not.toContain('987654.32')
}

/** A row as Prisma could return it if somebody selected everything: the real fields plus every private one. */
const fat = <T extends object>(row: T): T => ({ ...POISON, ...row })

// ---------- A campaign overview with money in it ----------

const MONEY_VALUES = [16666.76, 12345.67, 4321.09, 1543.22, 2128.56, 233.9, 109.4, 145.9, 69.4, 65432.1, 98765.4, 8230.5, 5.93, 6000, 16300]
const MONEY_KEY = /fee|cost|emv|cpm|budget|revenue|roas|estimat|internal|efficien/i

const er = (value: number | null, pieces: number) => ({ value, numerator: 680, denominator: 10800, estimatedShare: 0, pieces, rawValue: 6.3 })
const audience = {
  total: 16300, real: 10300, estimated: 6000, estimatedShare: 0.368,
  byBasis: { reach: 1500, impressions: 0, views: 8800, estimated_story: 0, estimated_post: 6000, none: 0 },
  countsByBasis: { reach: 1, impressions: 0, views: 3, estimated_story: 0, estimated_post: 1, none: 0 },
  realPieces: 4, withoutBase: 0,
}

const member: PerInfluencerMetrics = fat({
  influencerId: 'inf1', username: 'marta_fit', platform: 'INSTAGRAM', displayName: 'Marta Inventada', followers: 50000,
  media: 4, stories: 1, posts: 3, deleted: 1, views: 5800, engagements: 395, audience, er: er(5.86, 3),
  cost: 12345.67, emvBasic: 69.4, emvExtended: 145.9, emvRatio: 0.01, cpm: 2128.56,
  deliverablesPlanned: 3, status: 'POSTED', trackedClicks: 77, vsBaseline: null,
})

const overview: CampaignOverview = {
  definitionsVersion: 2,
  totals: {
    media: 5, mediaDeleted: 1, stories: 1, posts: 4, creatorsActive: 2,
    views: 10800, likes: 650, comments: 65, shares: 15, saves: 5, engagements: 735,
    audience, reachReal: 1500, impressionsReal: null, er: er(6.3, 4),
    cost: 16666.76, membersWithCost: 2, members: 2,
    emvBasic: 109.4, emvExtended: 233.9, emvEstimatedStories: 0, emvRealStories: 1, emvEstimatedAudience: 0,
    emvTrustMultiplier: 1, emvRatio: 0.01, cpm: 1543.22, mediaCounts: { REEL: 2, POST: 1, STORY: 1, VIDEO: 1 },
  },
  perInfluencer: [member],
  perMedia: [],
  timeline: [],
  targets: [
    { key: 'views', target: 100000, actual: 10800, variationPct: -89.2, lowerIsBetter: false, verdict: 'below' },
    { key: 'cpm', target: 20, actual: 1543.22, variationPct: -7616.1, lowerIsBetter: true, verdict: 'below' },
  ],
  business: {
    promoCode: 'OTONO10', codeRedemptions: 3, clientReportedSales: 12, clientReportedLeads: null, clientReportedRevenue: 98765.4,
    source: 'LEAK-fuente', reportedAt: '2026-10-30T00:00:00.000Z', businessNotes: 'LEAK-nota-del-cliente', cpa: 8230.5, roas: 5.93,
  },
  erOnReach: er(8, 1),
  delivery: {
    creators: { planned: 1, delivered: 1, ok: true },
    pieces: { planned: 3, delivered: 5, ok: true },
    dates: { inWindow: 5, total: 5, ok: true },
    disclosure: { disclosed: 1, total: 4, ok: false, missingMediaIds: Array.from({ length: 30 }, (_, i) => `m${i}`) },
    allOk: false,
  },
  balance: { execution: 'issues', results: 'below', efficiency: 'worse', dataReliability: 'high', realShare: 0.8 },
}

function expectNoMoney(output: unknown) {
  expect([...keysOf(output)].filter(k => MONEY_KEY.test(k))).toEqual([])
  const text = JSON.stringify(output)
  for (const amount of MONEY_VALUES) expect(text, `amount ${amount}`).not.toContain(String(amount))
}

// =====================================================================

describe('the serializers: one per entity, named fields only', () => {
  const campaignRow = fat({
    id: 'c1', name: 'Campaña Inventada', status: 'ACTIVE', type: 'UGC', platforms: ['INSTAGRAM'],
    startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-10-31T00:00:00.000Z'),
    budget: 65432.1, targetAccounts: ['marca'], targetHashtags: ['marca'], targetKeywords: ['fregona'], userId: 'u1',
  })
  const mediaRow = fat({
    id: 'm1', permalink: 'https://www.instagram.com/reel/DAbc_123xyZ/', platform: 'INSTAGRAM', mediaType: 'REEL',
    postedAt: new Date('2026-10-05T10:00:00.000Z'), likes: 100, comments: 10, shares: 5, saves: 5, views: 2000, reach: 1500,
    source: 'apify', insightsSource: null, isDeleted: false, mentions: ['LEAK-mention'], hashtags: ['LEAK-tag'],
    influencer: fat({ username: 'marta_fit' }), campaign: fat({ id: 'c1', name: 'Campaña Inventada' }),
  })
  const creatorRow = fat({
    id: 'inf1', username: 'marta_fit', platform: 'INSTAGRAM', displayName: 'Marta Inventada', followers: 50000, country: 'ES',
    isVerified: true, following: 300, postsCount: 420, engagementRate: 3.2, avgLikes: 900, avgComments: 40, avgViews: 12000,
    language: 'es', lastScraped: new Date('2026-11-01T08:00:00.000Z'), gender: 'F',
  })

  it('a campaign', () => {
    const out = serializeCampaign(campaignRow, { brand: 'Marca Inventada', creators: 2, pieces: 5 })
    expect(out).toEqual({
      id: 'c1', name: 'Campaña Inventada', brand: 'Marca Inventada', status: 'ACTIVE', type: 'UGC', platforms: ['INSTAGRAM'],
      startDate: '2026-10-01', endDate: '2026-10-31', creators: 2, pieces: 5,
    })
    expectClean(out)
    expectNoMoney(out)
    expect(serializeBrandTargets(campaignRow)).toEqual({ accounts: ['marca'], hashtags: ['marca'], productKeywords: ['fregona'] })
  })

  it('the public results of a campaign carry no fee, no cost and no estimate, stripped or not', () => {
    for (const source of [stripEconomics(overview), overview]) {
      const out = serializeCampaignResults(source)
      expectClean(out)
      expectNoMoney(out)
      expect(Object.keys(out)).toEqual(['totals', 'objectives', 'delivery', 'balance'])
      expect(out.totals).toMatchObject({ pieces: 5, posts: 4, stories: 1, views: 10800, interactions: 735, reach: 1500, creators: 2 })
      expect(out.totals.engagementRate).toEqual({ percent: 6.3, pieces: 4, notPublishedBecause: null })
      // The CPM objective is money
      expect(out.objectives.map(o => o.metric)).toEqual(['views'])
      // A long list of ids is cut, its length is not
      expect(out.delivery.adDisclosure).toMatchObject({ missing: 30 })
      expect(out.delivery.adDisclosure.missingPieceIds).toHaveLength(20)
      expect(Object.keys(out.balance)).toEqual(['execution', 'results', 'dataReliability', 'shareOfPiecesWithRealData'])
    }
  })

  it('says why an engagement rate is not published', () => {
    const stripped = stripEconomics({ ...overview, totals: { ...overview.totals, er: { ...er(null, 1), reason: 'insufficient_sample' } } })
    expect(serializeCampaignResults(stripped).totals.engagementRate).toEqual({ percent: null, pieces: 1, notPublishedBecause: 'insufficient_sample' })
  })

  it('the economics of a campaign are labelled internal and never carry the notes of the client', () => {
    const out = serializeCampaignEconomics(overview, fat({ budget: 65432.1 }))
    expectClean(out)
    expect(out).toMatchObject({
      internal: true, currency: 'EUR', budget: 65432.1, cost: 16666.76, creatorsWithCost: 2, cpm: 1543.22, efficiency: 'worse',
      emv: { estimate: true, extended: 233.9, basic: 109.4, ratioToCost: 0.01 },
      estimatedAudience: { estimate: true, estimated: 6000, realPlusEstimated: 16300, estimatedShare: 0.37 },
      clientReportedResults: { promoCode: 'OTONO10', sales: 12, revenue: 98765.4, costPerAcquisition: 8230.5, roas: 5.93 },
    })
    expect(out.notice).toMatch(/Internal agency figures/)
    expect(out.cpmObjective).toMatchObject({ metric: 'cpm', target: 20 })
    expect(serializeCampaignEconomics({ ...overview, business: null }, {}).clientReportedResults).toBeNull()
  })

  it('a creator inside a campaign: figures without money, money only in its own block', () => {
    const publicRow = serializeCampaignCreator(stripEconomics(overview).perInfluencer[0])
    expect(publicRow).toEqual({
      creatorId: 'inf1', handle: 'marta_fit', network: 'INSTAGRAM', status: 'POSTED', followers: 50000, pieces: 4, posts: 3,
      stories: 1, piecesDeletedByCreator: 1, piecesPlanned: 3, views: 5800, interactions: 395,
      engagementRate: { percent: 5.86, pieces: 3, notPublishedBecause: null },
    })
    expectClean(publicRow)
    expectNoMoney(publicRow)
    // Not stripped by mistake: the public serializer still copies no money
    expectNoMoney(serializeCampaignCreator(member))

    const money = serializeCampaignCreatorEconomics(member, fat({ agreedFee: 12345.67, cost: 99.99, askingFee: 99999.99, commission: 15 }))
    expect(money).toEqual({ internal: true, currency: 'EUR', fee: 12345.67, cost: 12345.67, cpm: 2128.56, emvExtended: 145.9, emvBasic: 69.4, emvRatioToCost: 0.01 })
    expectClean(money)
    expect(serializeCampaignCreatorEconomics(member, null).fee).toBeNull()
  })

  it('a publication: no caption, no mentions, and only an http link', () => {
    const out = serializeMedia(mediaRow)
    expect(out).toEqual({
      id: 'm1', permalink: 'https://www.instagram.com/reel/DAbc_123xyZ/', creator: 'marta_fit', network: 'INSTAGRAM', type: 'REEL',
      postedAt: '2026-10-05T10:00:00.000Z', likes: 100, comments: 10, shares: 5, saves: 5, views: 2000, reach: 1500,
      capturedBy: 'apify', statsFrom: null, deletedByCreator: false,
    })
    expectClean(out)
    expectNoMoney(out)
    expect(serializeMedia({ ...mediaRow, permalink: 'javascript:alert(1)' }).permalink).toBeNull()
    expect(serializeMedia({ ...mediaRow, permalink: null, influencer: null })).toMatchObject({ permalink: null, creator: null })
    expect(serializeMediaRecord(mediaRow)).toEqual({
      pieceId: 'm1', campaignId: 'c1', campaign: 'Campaña Inventada', creator: 'marta_fit', type: 'REEL',
      postedAt: '2026-10-05T10:00:00.000Z', capturedBy: 'apify', deletedByCreator: false,
    })
    expectClean(serializeMediaRecord(mediaRow))
  })

  it('a publication: a figure that is not known is null, never a 0 that reads as measured', () => {
    const scraped = { ...mediaRow, likes: 0, comments: 0, shares: 0, saves: 0, views: 0, reach: 0 }
    // A scraped Instagram story: no public views, reach, saves or shares
    expect(serializeMedia({ ...scraped, mediaType: 'STORY' })).toMatchObject({ likes: 0, comments: 0, views: null, reach: null, saves: null, shares: null })
    // A public view count below the likes is not a real audience (the platform shows «—» for it)
    expect(serializeMedia({ ...scraped, likes: 900, views: 120 }).views).toBeNull()
    expect(serializeMedia({ ...scraped, likes: 900, views: 900 }).views).toBe(900)
    // A reel Meta delivered with 0 views and real reach
    expect(serializeMedia({ ...scraped, source: 'meta_api', likes: 40, reach: 3200 })).toMatchObject({ views: null, reach: 3200 })
    // A public TikTok scrape does read shares, so its 0 is a real 0; nobody publishes saves
    expect(serializeMedia({ ...scraped, platform: 'TIKTOK', mediaType: 'VIDEO', views: 5000, likes: 300 })).toMatchObject({ views: 5000, shares: 0, saves: null })
    expect(serializeMedia({ ...scraped, platform: 'TIKTOK', mediaType: 'VIDEO', source: 'manual' }).shares).toBeNull()
    // The creator's own figures, when there are some
    expect(serializeMedia({ ...scraped, insightsSource: 'creator_screenshot', views: 4000, reach: 3000, saves: 12, shares: 3 })).toMatchObject({
      views: 4000, reach: 3000, saves: 12, shares: 3, statsFrom: 'creator_screenshot',
    })
  })

  it('a creator: public identity and public figures, no contact data and no usual fee', () => {
    const short = serializeCreator(creatorRow)
    expect(short).toEqual({ id: 'inf1', handle: 'marta_fit', network: 'INSTAGRAM', name: 'Marta Inventada', followers: 50000, country: 'ES', verified: true })
    expectClean(short)
    const profile = serializeCreatorProfile(creatorRow)
    expect(Object.keys(profile)).toEqual([
      'id', 'handle', 'network', 'name', 'followers', 'country', 'verified',
      'following', 'posts', 'profileEngagementRate', 'averageLikes', 'averageComments', 'averageViews', 'language', 'profileReadAt',
    ])
    expect(profile.profileReadAt).toBe('2026-11-01T08:00:00.000Z')
    expectClean(profile)
    expectNoMoney(profile)

    const membership = serializeCreatorCampaign(
      fat({ status: 'POSTED', agreedFee: 12345.67, campaign: fat({ id: 'c1', name: 'Campaña Inventada', status: 'ACTIVE', startDate: new Date('2026-10-01T00:00:00Z'), endDate: null, budget: 65432.1 }) }),
      { brand: null, pieces: 4 },
    )
    expect(membership).toEqual({
      campaignId: 'c1', name: 'Campaña Inventada', brand: null, campaignStatus: 'ACTIVE', creatorStatus: 'POSTED',
      startDate: '2026-10-01', endDate: null, pieces: 4,
    })
    expectClean(membership)
    expectNoMoney(membership)
  })

  it('the state of the capture: stamps, stored summaries without their free text, Apify without amounts, alerts', () => {
    const now = new Date('2026-11-12T12:00:00.000Z')
    expect(serializeCaptureJob('stories', '2026-11-12T09:00:00.000Z', 'not a date', now, true)).toEqual({
      job: 'stories', lastRunStampAt: '2026-11-12T09:00:00.000Z', hoursSinceLastRunStamp: 3, failuresRecorded: true, lastFailedAt: null,
    })
    expect(serializeCaptureJob('stories', undefined, '2026-11-11T09:00:00.000Z', now, true).lastFailedAt).toBe('2026-11-11T09:00:00.000Z')
    expect(serializeCaptureJob('track', undefined, undefined, now, false)).toEqual({
      job: 'track', lastRunStampAt: null, hoursSinceLastRunStamp: null, failuresRecorded: false, lastFailedAt: 'not_recorded',
    })
    // A job that records no failures never says "no failure", whatever a stray key holds
    expect(serializeCaptureJob('check-posts', '2026-11-12T11:00:00.000Z', '2026-11-12T10:00:00.000Z', now, false)).toMatchObject({
      failuresRecorded: false, lastFailedAt: 'not_recorded',
    })

    const stories = serializeStoriesResult(
      JSON.stringify(fat({
        at: '2026-11-12T09:00:00.000Z', failed: true, reason: 'exception', failedBatches: 2, usernamesChecked: 7, totalStories: 9, newStories: 4,
        campaigns: [fat({ id: 'c1', name: 'Campaña Inventada', creators: 1, newStories: 4 }), 'garbage', { name: 'no id' }],
        skipped: [fat({ id: 'c2', name: 'Otra', reason: 'too_long' }), { id: 'c3', name: 'Rara', reason: 'LEAK text that is not a label' }],
      })),
    )
    expect(stories).toMatchObject({
      failed: true, failureReason: 'exception', failedBatches: 2, creatorsChecked: 7, storiesSeen: 9, newStories: 4,
      campaignsScanned: [{ campaignId: 'c1', name: 'Campaña Inventada', creators: 1, newStories: 4 }],
      campaignsNotScanned: [{ campaignId: 'c2', name: 'Otra', reason: 'too_long' }, { campaignId: 'c3', name: 'Rara', reason: null }],
    })
    expectClean(stories)
    expect(serializeStoriesResult('not json')).toBeNull()
    expect(serializeStoriesResult('[1,2]')).toBeNull()
    expect(serializeStoriesResult(null)).toBeNull()

    const tiktok = serializeTikTokLinkResult(
      JSON.stringify(fat({ at: '2026-11-11T09:00:00.000Z', campaigns: [fat({ id: 'c1', name: 'Campaña Inventada', candidates: 2, linked: ['marta_fit', 5], videos: 3 })], handlesScanned: 2, answered: 2, notFound: 0, linked: 1, videos: 3, truncated: ['luis.tok'], partial: false })),
    )
    expect(tiktok).toMatchObject({
      accountsLinked: 1, videosCaptured: 3, handlesRead: 2, handlesPossiblyCut: ['luis.tok'], skippedBecause: null,
      campaigns: [{ campaignId: 'c1', candidates: 2, linked: ['marta_fit'], videos: 3 }],
    })
    expectClean(tiktok)

    const apify = serializeApify({
      auth: 'rejected', exhausted: true, resumesAt: '2026-12-01T00:00:00.000Z',
      budget: fat({ usd: 81.37, limit: 88.5, softLimit: 75.22, coreLimit: 84.07, usedPct: 92, coreBlocked: false, optionalBlocked: true, cycleEndsAt: '2026-12-01T00:00:00.000Z' }),
    })
    expect(apify).toEqual({
      tokenState: 'rejected', monthlyLimitReached: true, resumesAt: '2026-12-01T00:00:00.000Z', planUsedPercent: 92,
      captureJobsPausedByPlanLimit: false, discoverSearchPausedByPlanLimit: true, cycleEndsAt: '2026-12-01T00:00:00.000Z',
    })
    expectClean(apify)
    for (const amount of ['81.37', '88.5', '75.22', '84.07']) expect(JSON.stringify(apify)).not.toContain(amount)
    expect(serializeApify({ auth: 'whatever', exhausted: false, resumesAt: null, budget: { usedPct: null, coreBlocked: false, optionalBlocked: false, cycleEndsAt: null } }).tokenState).toBe('unknown')

    const alert = serializeAlert(fat({ id: 'n1', userId: 'u1', type: 'cron_stale', title: 'El rastreo de stories ha fallado', message: 'x'.repeat(2000), link: '/settings', createdAt: new Date('2026-11-10T07:00:00.000Z'), metadata: { secret: 'LEAK-meta' } }))
    expect(Object.keys(alert)).toEqual(['type', 'title', 'message', 'at'])
    expect(alert.message).toHaveLength(700)
    expectClean(alert)
  })

  it('removes control and direction-override characters from text typed by people', () => {
    expect(shortText('Campaña‮ evil\u0000\nsegunda línea')).toBe('Campaña evil segunda línea')
    expect(shortText('   ')).toBeNull()
    expect(shortText(42)).toBeNull()
    expect(serializeCampaign({ ...campaignRow, name: 'x'.repeat(500) }, { brand: 'y'.repeat(500), creators: 0, pieces: 0 })).toMatchObject({
      name: 'x'.repeat(200), brand: 'y'.repeat(120),
    })
  })
})

describe('the tools on a database that returns every column of every row', () => {
  const caller = { grantId: 'g1', userId: 'u1' }
  const run = (name: string, args: Record<string, unknown>) => MCP_TOOLS.find(t => t.name === name)!.prepare(args).run(caller)
  /** The money planted in that database and in the Apify budget. */
  const PLANTED_AMOUNTS = ['12345.67', '99.99', '99999.99', '65432.1', '98765.4', '987654.32', '81.37', '88.53', '75.22', '84.07']

  const CALLS: Array<[string, Record<string, unknown>]> = [
    ['list_campaigns', {}],
    ['get_campaign', { campaignId: 'c1' }],
    ['list_campaign_creators', { campaignId: 'c1' }],
    ['list_campaign_media', { campaignId: 'c1' }],
    ['find_creator', { query: 'marta' }],
    ['get_creator', { influencerId: 'inf1' }],
    ['get_creator', { handle: '@marta_fit' }],
    ['capture_status', {}],
    ['explain_missing_post', { campaignId: 'c1', url: 'https://www.instagram.com/reel/DAbc_123x1/' }],
    ['explain_missing_post', { campaignId: 'c1', url: 'https://www.instagram.com/reel/DNeverSeen01/' }],
  ]

  it.each(CALLS)('%s %j: no private key, no private value, no money', async (name, args) => {
    const out = await run(name, args)
    const text = JSON.stringify(out)
    expect(text.length).toBeGreaterThan(150)
    expectClean(out)
    expect([...keysOf(out)].filter(k => MONEY_KEY.test(k))).toEqual([])
    for (const amount of PLANTED_AMOUNTS) expect(text, `amount ${amount}`).not.toContain(amount)
  })

  it('really went through the rows of that database', async () => {
    const campaigns = (await run('list_campaigns', {})) as { campaigns: { items: Array<{ id: string; brand: string | null }> } }
    expect(campaigns.campaigns.items).toMatchObject([{ id: 'c1', brand: 'Marca Inventada', creators: 1, pieces: 3 }])
    const media = (await run('list_campaign_media', { campaignId: 'c1' })) as { pieces: { returned: number; items: Array<{ creator: string }> } }
    expect(media.pieces.returned).toBe(3)
    expect(media.pieces.items[0].creator).toBe('marta_fit')
    const found = (await run('explain_missing_post', { campaignId: 'c1', url: 'https://www.instagram.com/reel/DAbc_123x1/' })) as { inThisCampaign: boolean; platformRecords: { inThisCampaign: unknown[] } }
    expect(found.inThisCampaign).toBe(true)
    expect(found.platformRecords.inThisCampaign).toHaveLength(1)
    const status = (await run('capture_status', {})) as { apify: Record<string, unknown>; storiesLastResult: Record<string, unknown>; alertsLast7Days: { returned: number } }
    expect(status.apify).toMatchObject({ tokenState: 'rejected', planUsedPercent: 92, discoverSearchPausedByPlanLimit: true })
    expect(status.storiesLastResult).toMatchObject({ failed: true, failureReason: 'exception', storiesSeen: 3 })
    expect(status.alertsLast7Days.returned).toBe(1)
  })

  it('with includeEconomics the money appears, inside a block marked internal, and still nothing private', async () => {
    const campaign = (await run('get_campaign', { campaignId: 'c1', includeEconomics: true })) as {
      economicsIncluded: boolean
      internalEconomics: { internal: boolean; budget: number; cost: number; emv: { extended: number }; clientReportedResults: { revenue: number } }
    }
    expectClean(campaign)
    expect(campaign.economicsIncluded).toBe(true)
    expect(campaign.internalEconomics).toMatchObject({ internal: true, budget: 65432.1, cost: 12345.67, clientReportedResults: { revenue: 98765.4, sales: 12 } })
    expect(campaign.internalEconomics.emv.extended).toBeGreaterThan(0)
    // Money lives in that block and nowhere else
    const { internalEconomics: _money, ...rest } = campaign
    void _money
    expect([...keysOf(rest)].filter(k => MONEY_KEY.test(k))).toEqual([])

    const creators = (await run('list_campaign_creators', { campaignId: 'c1', includeEconomics: true })) as {
      internalNotice: string
      creators: { items: Array<{ handle: string; internalEconomics: { internal: boolean; fee: number; cost: number } }> }
    }
    expectClean(creators)
    expect(creators.internalNotice).toMatch(/Internal agency figures/)
    expect(creators.creators.items[0]).toMatchObject({ handle: 'marta_fit', internalEconomics: { internal: true, fee: 12345.67, cost: 12345.67 } })
    // The fee the creator asked for and the product cost are never returned, flag or not
    expect(JSON.stringify(creators)).not.toContain('99999.99')
    expect(JSON.stringify(creators)).not.toContain('99.99')
  })

  it('answers an expected failure with a sentence for the model, not with an exception of the database', async () => {
    await expect(run('get_campaign', { campaignId: 'c1' })).resolves.toBeTruthy()
    await expect(run('list_campaign_media', { campaignId: 'c1', since: '2026-10-15', until: '2026-10-10' })).rejects.toThrow(ToolError)
    await expect(run('list_campaign_media', { campaignId: 'c1', creator: 'not a handle' })).rejects.toThrow(ToolError)
    await expect(run('get_creator', {})).rejects.toThrow(ToolError)
    await expect(run('find_creator', { query: '@a' })).rejects.toThrow(ToolError)
  })
})

describe('the tool files read the database with explicit columns only', () => {
  const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts'))
  const source = (f: string) => fs.readFileSync(path.join(TOOLS_DIR, f), 'utf8')

  it('never selects a private column, never includes a whole relation and never writes', () => {
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const f of files) {
      const code = source(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const privateColumn = /\b(email|phone|password|notes|bio|website|city|standardFee|shippingAddress1|shippingAddress2|shippingName|shippingPhone|shippingEmail|accessToken|refreshToken|shareToken|token|briefText|manualROINotes|businessResultsNotes|askingFee|commission)\s*:\s*true\b/
      expect(privateColumn.exec(code)?.[0], f).toBeUndefined()
      expect(/\binclude\s*:/.test(code), `${f} uses include`).toBe(false)
      expect(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw\w*|\$queryRaw\w*)\s*\(/.exec(code)?.[0], f).toBeUndefined()
    }
  })

  it('every findMany, findUnique and findFirst names its columns with select', () => {
    let reads = 0
    for (const f of files) {
      const code = source(f)
      for (const m of code.matchAll(/prisma\.\w+\.(findMany|findUnique|findFirst|findUniqueOrThrow|findFirstOrThrow)\(/g)) {
        reads += 1
        // The text of the call, up to its closing parenthesis
        let depth = 1
        let i = m.index! + m[0].length
        while (i < code.length && depth > 0) {
          if (code[i] === '(') depth += 1
          else if (code[i] === ')') depth -= 1
          i += 1
        }
        expect(code.slice(m.index!, i), `${f}: a read without select`).toMatch(/\bselect\s*:/)
      }
    }
    expect(reads).toBeGreaterThanOrEqual(12)
  })

  it('only the serializers file builds answers from rows: no tool spreads a row', () => {
    const serializers = source('serializers.ts').replace(/\/\*[\s\S]*?\*\//g, '')
    // The only spread there is one serializer reusing another
    expect(serializers.match(/\.\.\.(?!serializeCreator\(row\))\w/g)).toBeNull()
  })
})

describe('what is shared by every tool', () => {
  it('caps every list at 200 rows, 50 by default', () => {
    expect([LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT]).toEqual([50, 200])
    expect(clampLimit(undefined)).toBe(50)
    expect(clampLimit(null)).toBe(50)
    expect(clampLimit(Number.NaN)).toBe(50)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(7.9)).toBe(7)
    expect(clampLimit(200)).toBe(200)
    expect(clampLimit(201)).toBe(200)
    expect(clampLimit(1e9)).toBe(200)
  })

  it('says when a list was cut, by count and by size', () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ i }))
    expect(listEnvelope(rows.slice(0, 3), 3, 50, 'x')).toEqual({ returned: 3, total: 3, truncated: false, items: rows.slice(0, 3) })
    const cut = listEnvelope(rows.slice(0, 50), 80, 50, 'Filter more.')
    expect(cut).toMatchObject({ returned: 50, total: 80, truncated: true, truncation: 'Showing 50 of 80. Filter more.' })
    // Never more than the limit, whatever the caller passes
    expect(listEnvelope(rows, 80, 10, 'x').items).toHaveLength(10)
    expect(listEnvelope(rows, 80, 5000, 'x').items).toHaveLength(80)
    expect(listEnvelope(Array.from({ length: 300 }, (_, i) => ({ i })), 300, 5000, 'x').items).toHaveLength(200)

    const big = Array.from({ length: 200 }, (_, i) => ({ i, text: 'x'.repeat(1000) }))
    const bySize = listEnvelope(big, 200, 200, 'Filter more.')
    expect(bySize.truncated).toBe(true)
    expect(bySize.returned).toBeLessThan(200)
    // Cut exactly where the next row would not fit any more (about 39 rows of 1 KB at 40,000 characters)
    const sizeOf = (rows: unknown[]) => rows.reduce<number>((n, r) => n + JSON.stringify(r).length + 1, 0)
    expect(sizeOf(bySize.items)).toBeLessThanOrEqual(LIST_MAX_CHARS)
    expect(sizeOf(big.slice(0, bySize.returned + 1))).toBeGreaterThan(LIST_MAX_CHARS)
    expect(bySize.returned).toBeGreaterThan(35)
    expect(JSON.stringify(bySize.items).length).toBeLessThanOrEqual(LIST_MAX_CHARS + 2)
    expect(bySize.truncation).toContain('cut to keep the answer small')
    // A total that is lower than what was returned is corrected, not believed
    expect(listEnvelope(rows.slice(0, 4), 0, 50, 'x')).toMatchObject({ returned: 4, total: 4, truncated: false })
  })

  it('keeps ids, handles, flags and limits in the log summary, at most 300 characters, never free text', () => {
    expect(ARGS_SUMMARY_MAX_CHARS).toBe(300)
    expect(formatArgsSummary({ campaignId: 'c1', includeEconomics: true, limit: 20, creator: undefined, type: null, empty: '' })).toBe(
      'campaignId=c1 includeEconomics=true limit=20',
    )
    expect(formatArgsSummary({ a: 'x'.repeat(500) })).toBe(`a=${'x'.repeat(80)}`)
    expect(formatArgsSummary(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, 'value'.repeat(5)]))).length).toBe(300)
    expect(formatArgsSummary({ a: 'line one\nline two‮\u0000' })).toBe('a=line one line two')
    expect(summarizeQuery('@marta_fit')).toBe('@marta_fit')
    expect(summarizeQuery('marta.fit')).toBe('@marta.fit')
    expect(summarizeQuery('María José García')).toBe('(text, 17 chars)')
    expect(summarizeQuery('marta@correo-inventado.test')).toBe('(text, 27 chars)')
    // Digits only: as likely a phone number as a handle, so never kept
    expect(summarizeQuery('612345678')).toBe('(text, 9 chars)')
    expect(summarizeQuery('@612345678')).toBe('(text, 10 chars)')
    expect(summarizeQuery('612.345.678')).toBe('(text, 11 chars)')
    expect(summarizeQuery('marta_1990')).toBe('@marta_1990')
    expect(summarizeHandleArg(undefined)).toBeUndefined()
    expect(summarizeHandleArg('@Marta_Fit')).toBe('@Marta_Fit')
    expect(summarizeHandleArg('612345678')).toBe('(digits only)')
    expect(summarizeHandleArg('María José')).toBe('(not a handle)')
  })

  it('keeps a list of the densest rows well under what Claude Code accepts (25,000 tokens)', () => {
    expect(LIST_MAX_CHARS).toBe(40_000)
    // The worst row of list_campaign_media: long ids, a TikTok link with a 19-digit id, big counters
    const rows = Array.from({ length: 200 }, (_, i) =>
      serializeMedia({
        id: `cm${String(i).padStart(3, '0')}x9q2w8e7r6t5y4u3i2o1p`,
        permalink: `https://www.tiktok.com/@creadora_con_nombre_largo_${i}/video/7${String(i).padStart(18, '9')}`,
        platform: 'TIKTOK', mediaType: 'VIDEO', postedAt: new Date('2026-10-05T10:00:00.123Z'),
        likes: 1234567, comments: 123456, shares: 123456, saves: 123456, views: 123456789, reach: 98765432,
        source: 'meta_api', insightsSource: 'creator_screenshot', isDeleted: false,
        influencer: { username: `creadora_con_nombre_largo_${i}` },
      }),
    )
    const envelope = listEnvelope(rows, 200, 200, 'Narrow with creator, type, since and until, or raise limit (at most 200).')
    expect(envelope.truncated).toBe(true)
    expect(envelope.truncation).toContain('cut to keep the answer small')
    const chars = JSON.stringify(envelope).length
    expect(chars).toBeLessThanOrEqual(LIST_MAX_CHARS + 500)
    // At 2.4 characters per token (JSON full of digits and ids) that is about 17,000 tokens
    expect(chars / 2.4).toBeLessThan(18_000)
  })

  it('reads handles and days strictly', () => {
    expect(cleanHandle(' @Marta_Fit ')).toBe('Marta_Fit')
    expect(cleanHandle('@@luis.tok')).toBe('luis.tok')
    for (const bad of ['', '@', 'marta fit', 'marta%', "x' OR 1=1", 'a/b', 'x'.repeat(61), 5, null, undefined]) {
      expect(cleanHandle(bad), String(bad)).toBeNull()
    }
    expect(parseDay('2026-10-05')?.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    for (const bad of ['2026-02-30', '2026-13-01', '05/10/2026', '2026-10-5', '']) expect(parseDay(bad), bad).toBeNull()
    expect(dayAfter(new Date('2026-10-31T00:00:00.000Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(dayAfter(new Date('2026-12-31T00:00:00.000Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('takes a brand name only from a brand document', () => {
    expect(isBrandId('brand_1790000000000_ab12cd34')).toBe(true)
    for (const bad of ['brand_assignment_u1', 'brand_user_u1', 'brand_ig_brand_1_x', 'brand_connect', 'apify_api_key', 'meta_app_secret', 'brand_', '', null, 5, 'brand_1%']) {
      expect(isBrandId(bad), String(bad)).toBe(false)
    }
    expect(brandNameFromSetting(JSON.stringify({ name: '  Marca Inventada ', website: 'LEAK', brandUserId: 'u9' }))).toBe('Marca Inventada')
    for (const bad of [null, '', 'not json', '"text"', '{"name":5}', '{"name":"  "}', 'null']) expect(brandNameFromSetting(bad)).toBeNull()
  })
})

describe('the eight tools', () => {
  const NAMES = [
    'list_campaigns', 'get_campaign', 'list_campaign_creators', 'list_campaign_media',
    'find_creator', 'get_creator', 'capture_status', 'explain_missing_post',
  ]

  it('are exactly the ones of the spec, each with a Spanish title and a description for the model', () => {
    expect(MCP_TOOLS.map(t => t.name)).toEqual(NAMES)
    for (const tool of MCP_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]{2,63}$/)
      expect(tool.title.length, tool.name).toBeGreaterThan(5)
      expect(tool.title.length, tool.name).toBeLessThanOrEqual(60)
      // Short, plain titles: no dashes
      expect(tool.title).not.toMatch(/[—–]/)
      expect(tool.description.length, tool.name).toBeGreaterThan(200)
      expect(tool.description.length, tool.name).toBeLessThan(1500)
    }
    expect(new Set(MCP_TOOLS.map(t => t.title)).size).toBe(8)
  })

  it('ask for money only through includeEconomics, on the two tools that have it', () => {
    const withFlag = MCP_TOOLS.filter(t => 'includeEconomics' in t.input).map(t => t.name)
    expect(withFlag).toEqual(['get_campaign', 'list_campaign_creators'])
  })

  it('refuse arguments that are not what they declare, before anything runs', () => {
    const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!
    const refused: Array<[string, unknown]> = [
      ['get_campaign', {}],
      ['get_campaign', { campaignId: "x' OR '1'='1" }],
      ['get_campaign', { campaignId: 'c1', includeEconomics: 'yes' }],
      ['get_campaign', { campaignId: 'x'.repeat(65) }],
      ['list_campaigns', { status: 'DELETED' }],
      ['list_campaigns', { limit: 0 }],
      ['list_campaigns', { limit: 201 }],
      ['list_campaigns', { limit: 2.5 }],
      ['list_campaign_media', { campaignId: 'c1', since: '05/10/2026' }],
      ['list_campaign_media', { campaignId: 'c1', until: '2026-02-30' }],
      ['list_campaign_media', { campaignId: 'c1', type: 'TWEET' }],
      ['find_creator', { query: 'a' }],
      ['find_creator', { query: 'marta', platform: 'FACEBOOK' }],
      ['get_creator', { influencerId: 'a b' }],
      ['explain_missing_post', { campaignId: 'c1' }],
      ['explain_missing_post', { campaignId: 'c1', url: 'x'.repeat(501) }],
    ]
    for (const [name, args] of refused) {
      expect(() => tool(name).prepare(args), `${name} ${JSON.stringify(args)}`).toThrow(ToolError)
    }
    // And what a well-formed call leaves in the log
    expect(tool('get_campaign').prepare({ campaignId: 'c1' }).summary).toBe('campaignId=c1 includeEconomics=false')
    expect(tool('list_campaign_media').prepare({ campaignId: 'c1', creator: '@marta_fit', type: 'REEL', since: '2026-10-01', limit: 5 }).summary).toBe(
      'campaignId=c1 creator=@marta_fit type=REEL since=2026-10-01 limit=5',
    )
    expect(tool('list_campaign_media').prepare({ campaignId: 'c1', creator: 'María José' }).summary).toBe('campaignId=c1 creator=(not a handle)')
    expect(tool('find_creator').prepare({ query: 'Marta Inventada' }).summary).toBe('query=(text, 15 chars)')
    expect(tool('find_creator').prepare({ query: '612345678' }).summary).toBe('query=(text, 9 chars)')
    expect(tool('get_creator').prepare({ handle: '612345678' }).summary).toBe('handle=(digits only)')
    expect(tool('list_campaign_media').prepare({ campaignId: 'c1', creator: '@612345678' }).summary).toBe('campaignId=c1 creator=(digits only)')
    expect(tool('get_creator').prepare({ handle: '@marta_fit', platform: 'INSTAGRAM' }).summary).toBe('handle=@marta_fit platform=INSTAGRAM')
    expect(tool('capture_status').prepare(undefined).summary).toBe('')
    expect(tool('explain_missing_post').prepare({ campaignId: 'c1', url: 'https://www.instagram.com/stories/marta_fit/3986689802749386127/?igsh=secret' }).summary).toBe(
      'campaignId=c1 link=INSTAGRAM:STORY:3986689802749386127 handle=@marta_fit',
    )
    expect(tool('explain_missing_post').prepare({ campaignId: 'c1', url: 'https://example.com/?token=LEAK-secret' }).summary).toBe('campaignId=c1 link=unrecognised')
  })

  it('are announced by a real server as read-only, next to the write tools, with their titles and schemas (no database needed)', async () => {
    const scope = createMcpServer({ grantId: 'g1', userId: 'u1' })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transport.onmessage = scope.observe
    await scope.server.connect(transport)
    const res = await transport.handleRequest(
      new Request('https://intelligence.thekingofcontent.agency/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    await scope.settle()
    await scope.server.close()
    expect(res.status).toBe(200)
    const listed = (await res.json()).result.tools as Array<{
      name: string
      title: string
      description: string
      inputSchema: { type: string; properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] }
      annotations: { readOnlyHint: boolean; openWorldHint: boolean; title: string; destructiveHint?: boolean; idempotentHint?: boolean }
    }>
    // The eight read tools first, then every write tool, each once
    expect(listed.map(t => t.name)).toEqual([...NAMES, ...WRITE_TOOLS.map(t => t.name)])
    expect(new Set(listed.map(t => t.name)).size).toBe(listed.length)
    for (const t of listed) {
      expect(t.name.length, t.name).toBeLessThanOrEqual(64)
      expect(t.title, t.name).toBeTruthy()
      expect(t.description.length, t.name).toBeGreaterThan(80)
      expect(t.inputSchema.type, t.name).toBe('object')
    }
    const tools = listed.filter(t => NAMES.includes(t.name))
    for (const t of tools) {
      expect(t.annotations).toEqual({ title: t.title, readOnlyHint: true, openWorldHint: false })
      expect(t.inputSchema.type).toBe('object')
      for (const [prop, schema] of Object.entries(t.inputSchema.properties ?? {})) {
        expect(schema.description, `${t.name}.${prop} has no description`).toBeTruthy()
      }
    }
    // A write tool never claims to be read-only, and says whether it destroys
    for (const t of listed.filter(t => !NAMES.includes(t.name))) {
      expect(t.annotations.readOnlyHint, t.name).toBe(false)
      expect(t.annotations.title, t.name).toBe(t.title)
      expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean')
      expect(typeof t.annotations.openWorldHint, t.name).toBe('boolean')
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toEqual(expect.arrayContaining(['includeContact', 'includeEconomics']))
    }
    const required = Object.fromEntries(tools.map(t => [t.name, (t.inputSchema.required ?? []).sort()]))
    expect(required).toEqual({
      list_campaigns: [], get_campaign: ['campaignId'], list_campaign_creators: ['campaignId'], list_campaign_media: ['campaignId'],
      find_creator: ['query'], get_creator: [], capture_status: [], explain_missing_post: ['campaignId', 'url'],
    })
    const props = Object.fromEntries(tools.map(t => [t.name, Object.keys(t.inputSchema.properties ?? {})]))
    expect(props).toEqual({
      list_campaigns: ['status', 'limit'],
      get_campaign: ['campaignId', 'includeEconomics'],
      list_campaign_creators: ['campaignId', 'includeEconomics', 'limit'],
      list_campaign_media: ['campaignId', 'creator', 'type', 'since', 'until', 'limit'],
      find_creator: ['query', 'platform', 'limit'],
      get_creator: ['influencerId', 'handle', 'platform'],
      capture_status: [],
      explain_missing_post: ['campaignId', 'url'],
    })
    expect(tools[0].inputSchema.properties!.status.enum).toEqual(['ACTIVE', 'PAUSED', 'ARCHIVED'])
    expect(MCP_SERVER_INFO).toEqual({ name: 'tkoc-intelligence', title: 'TKOC Intelligence', version: '1.0.0' })
  })
})

describe('the write tools on the server', () => {
  const wiring = {
    caller: { grantId: 'g1', userId: 'u1' },
    take: () => ({ limited: false, startedAt: Date.now() }),
    inTurn: <T,>(work: () => Promise<T>) => work(),
  }

  it('are registered once each, in the order of WRITE_TOOLS, and a name already taken stops the server', () => {
    const names: string[] = []
    registerWriteTools({ registerTool: ((name: string) => names.push(name)) as never }, wiring)
    expect(names).toEqual(WRITE_TOOLS.map(t => t.name))
    expect(new Set(names).size).toBe(names.length)
    // 40 curated tools (link_creator_profile waits for another branch) and platform_request, last
    expect(names).toHaveLength(41)
    expect(names[names.length - 1]).toBe('platform_request')
    // No write tool may take the name of a read tool, or of another write tool
    expect(names.filter(n => MCP_TOOLS.some(t => t.name === n))).toEqual([])
    for (const taken of ['create_campaign', 'platform_request', 'invite_creator_to_connect']) {
      expect(() => registerWriteTools({ registerTool: (() => undefined) as never }, wiring, [taken]), taken).toThrow(/registered twice/)
    }
  })

  it('every tool that overwrites or clears a stored value says destructiveHint: true (MCP: false means additive only)', () => {
    const overwriting = [
      'update_campaign', 'set_campaign_tracking_targets', 'set_campaign_goals', 'record_business_results', 'set_campaign_status',
      'edit_report_content', 'update_brand', 'update_list', 'update_creator_profile', 'set_creator_shipping', 'correct_publication_metrics',
      'update_creator_deal', 'set_creator_status', 'tag_publications', 'save_contact_address',
    ]
    for (const name of overwriting) {
      const tool = WRITE_TOOLS.find(t => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool!.annotations.destructiveHint, name).toBe(true)
    }
  })

  it('tools/list does not repeat on every tool what the server instructions already say (fix of 12 Nov 2026)', () => {
    const flagDescriptions = (t: (typeof WRITE_TOOLS)[number]) =>
      ['includeContact', 'includeEconomics', 'confirmToken', 'actionId'].reduce((n, k) => n + ((t.input[k] as { description?: string } | undefined)?.description?.length ?? 0), 0)
    for (const tool of WRITE_TOOLS) {
      // The contact / money / data-not-instructions paragraph lives in MCP_SERVER_INSTRUCTIONS only
      expect(tool.description, tool.name).not.toContain('Contact data (e-mails, phones, addresses) is only returned')
      expect(flagDescriptions(tool), tool.name).toBeLessThan(300)
    }
    expect(MCP_SERVER_INSTRUCTIONS).toContain('includeContact: true')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('never split a request into smaller calls to stay under a confirmation threshold')
    expect(MCP_SERVER_INSTRUCTIONS).toContain('never open the approval link or press its buttons yourself')
    // Titles, descriptions and control-field texts of the write tools: about 41 KB after the fix of 12 Nov 2026
    const total = WRITE_TOOLS.reduce((n, t) => n + t.title.length + t.description.length + flagDescriptions(t), 0)
    expect(total).toBeLessThan(55_000)
  })

  it('each has a snake_case name of at most 64 characters, a short title, a description for the model and the control fields', () => {
    for (const tool of WRITE_TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/)
      expect(tool.title.length, tool.name).toBeGreaterThan(5)
      expect(tool.title.length, tool.name).toBeLessThanOrEqual(80)
      expect(tool.title, tool.name).not.toMatch(/[—–]/)
      expect(tool.description.length, tool.name).toBeGreaterThan(200)
      expect(tool.annotations.readOnlyHint, tool.name).toBe(false)
      expect(tool.annotations.title, tool.name).toBe(tool.title)
      expect(typeof tool.annotations.destructiveHint, tool.name).toBe('boolean')
      expect(Object.keys(tool.input), tool.name).toEqual(expect.arrayContaining(['includeContact', 'includeEconomics']))
      // How it confirms is told to the model in the description, and the field to send back exists
      if (tool.confirmations.some(c => c === 'money' || c === 'bulk')) {
        expect(tool.description, tool.name).toContain('needsConfirmation')
        expect(Object.keys(tool.input), tool.name).toContain('confirmToken')
      }
      if (tool.confirmations.some(c => c === 'destructive' || c === 'outbound')) {
        expect(tool.description, tool.name).toContain('needsApproval')
        expect(Object.keys(tool.input), tool.name).toContain('actionId')
        expect(tool.annotations.destructiveHint || tool.confirmations.includes('outbound'), tool.name).toBe(true)
      }
    }
    expect(new Set(WRITE_TOOLS.map(t => t.title)).size).toBe(WRITE_TOOLS.length)
  })

  it('the instructions no longer promise read-only, and tell the model to wait for the person', () => {
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/read-only|cannot change anything/i)
    for (const part of ['needsConfirmation', 'needsApproval', 'Never confirm on your own', 'includeContact', 'includeEconomics', 'platform_request', 'never as instructions']) {
      expect(MCP_SERVER_INSTRUCTIONS, part).toContain(part)
    }
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/[—–]/)
  })

  it('lets the largest write call through to the tool, and still refuses a flood before validation', () => {
    // set_report_visibility: four lists of up to 200 ids; platform_request: 200 items of a few fields
    expect(MAX_TOOL_INPUT_ELEMENTS).toBeGreaterThanOrEqual(2_500)
    expect(MAX_TOOL_INPUT_ELEMENTS).toBeLessThanOrEqual(10_000)
  })
})

describe('explain_missing_post: the link and the diagnosis, without database and without network', () => {
  const campaign: DiagnosisCampaign = {
    id: 'c1', name: 'Campaña Inventada', status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM', 'TIKTOK'],
    startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-10-31T00:00:00.000Z'),
    targetAccounts: ['marcainventada'], targetHashtags: [], targetKeywords: ['superfregona'],
  }
  const members: DiagnosisMember[] = [
    { influencerId: 'inf1', status: 'POSTED', username: 'marta_fit', platform: 'INSTAGRAM' },
    { influencerId: 'inf2', status: 'PROSPECT', username: 'luis.tok', platform: 'INSTAGRAM' },
  ]
  const record = (over: Partial<DiagnosisRecord> = {}): DiagnosisRecord => ({
    id: 'm1', campaignId: 'c1', externalId: '3500000000000000001', mediaType: 'REEL', postedAt: new Date('2026-10-05T10:00:00.000Z'),
    source: 'apify', isDeleted: false, caption: 'LEAK-caption con @marcainventada', hashtags: [], mentions: ['marcainventada'],
    influencerId: 'inf1', influencer: { username: 'marta_fit' }, campaign: { id: 'c1', name: 'Campaña Inventada' }, ...over,
  })
  const run = (url: string, records: DiagnosisRecord[] = [], over: Partial<DiagnosisCampaign> = {}, now = new Date('2026-10-20T12:00:00.000Z')) =>
    diagnosePost({ link: parseLink(url), campaign: { ...campaign, ...over }, brand: 'Marca Inventada', creators: 2, pieces: 5, records, members, now })
  const results = (d: ReturnType<typeof run>) => Object.fromEntries(d.checks.map(c => [c.rule, c.result]))

  it('recognises the links the platform accepts and refuses the rest', () => {
    expect(parseLink('https://www.instagram.com/p/DeKHOgcNODD/')).toMatchObject({ kind: 'publication', target: { platform: 'INSTAGRAM', mediaType: 'POST', externalId: 'DeKHOgcNODD', isStory: false } })
    expect(parseLink('instagram.com/stories/marta.fit/3986689802749386127?igsh=abc')).toMatchObject({
      kind: 'publication',
      target: { platform: 'INSTAGRAM', mediaType: 'STORY', externalId: '3986689802749386127', ownerHint: 'marta.fit', isStory: true },
    })
    expect(parseLink('https://www.tiktok.com/@luis.tok/video/7400000000000000001')).toMatchObject({ kind: 'publication', target: { platform: 'TIKTOK', ownerHint: 'luis.tok' } })
    expect(parseLink('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({ kind: 'publication', target: { platform: 'YOUTUBE', mediaType: 'VIDEO' } })
    expect(parseLink('https://www.instagram.com/stories/highlights/17912345678901234/')).toEqual({ kind: 'highlight' })
    for (const bad of ['https://vm.tiktok.com/ZMabc/', 'https://example.com/p/abc', 'hola', 'https://www.instagram.com/marta_fit/']) {
      expect(parseLink(bad)).toEqual({ kind: 'unrecognised' })
    }
  })

  it('matches a stored row with a link by id or by permalink, and nothing else', () => {
    const reel = (parseLink('https://www.instagram.com/reel/DAbc_123xyZ/') as { target: Parameters<typeof isSamePublication>[0] }).target
    expect(isSamePublication(reel, { externalId: '3500000000000000001', permalink: 'https://www.instagram.com/p/DAbc_123xyZ/' })).toBe(true)
    expect(isSamePublication(reel, { externalId: 'DAbc_123xyZ', permalink: null })).toBe(true)
    // `_` in a shortcode is a character, not a wildcard, and a longer code is another post
    expect(isSamePublication(reel, { externalId: '1', permalink: 'https://www.instagram.com/reel/DAbcX123xyZ/' })).toBe(false)
    expect(isSamePublication(reel, { externalId: '1', permalink: 'https://www.instagram.com/reel/DAbc_123xyZ9/' })).toBe(false)
    expect(isSamePublication(reel, { externalId: '1', permalink: null })).toBe(false)
    const story = (parseLink('https://www.instagram.com/stories/marta_fit/3986689802749386127/') as { target: Parameters<typeof isSamePublication>[0] }).target
    expect(isSamePublication(story, { externalId: '3986689802749386127_555', permalink: null })).toBe(true)
    expect(isSamePublication(story, { externalId: '39866898027493861270', permalink: null })).toBe(false)
    expect(isSamePublication(story, { externalId: null, permalink: 'https://www.instagram.com/stories/marta_fit/3986689802749386127/' })).toBe(true)
  })

  it('a piece that is in the campaign: says so and never returns its caption', () => {
    const d = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record()])
    expect(d.inThisCampaign).toBe(true)
    expect(results(d)).toEqual({ campaign_active: 'pass', brand_targets: 'pass', membership: 'pass', creator_status: 'pass', dates: 'pass', brand_reference: 'pass' })
    expect(d.conclusion).toBe('The publication IS in this campaign (piece m1, captured by apify).')
    expect(d.notDeterminedWithoutReadingTheNetwork).toEqual([])
    expectClean(d)
  })

  it('a piece in the campaign that no longer meets a rule: a re-validation would detach it, a job condition would not', () => {
    const lateRule = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record({ postedAt: new Date('2026-11-05T10:00:00.000Z') })])
    expect(lateRule.conclusion).toMatch(/IS in this campaign.*no longer qualifies \(dates\).*would detach it/)
    // Paused campaign: nothing new is read, but the piece stays
    const paused = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record()], { status: 'PAUSED' })
    expect(results(paused).campaign_active).toBe('fail')
    expect(paused.conclusion).toBe('The publication IS in this campaign (piece m1, captured by apify).')
    // Added by hand: the brand rule does not apply
    const manual = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record({ source: 'manual', caption: 'nada', mentions: [] })])
    expect(results(manual).brand_reference).toBe('not_applicable')
    const deleted = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record({ isDeleted: true })])
    expect(deleted.conclusion).toMatch(/deleted it afterwards/)
  })

  it('a link that says nothing and a post nobody stored: everything is unknown, and it says so', () => {
    const d = run('https://www.instagram.com/reel/DNeverSeen01/')
    expect(results(d)).toEqual({ campaign_active: 'pass', brand_targets: 'pass', membership: 'unknown', dates: 'unknown', brand_reference: 'unknown' })
    expect(d.author).toEqual({ handle: null, knownFrom: null, isMember: null, statusInCampaign: null })
    expect(d.conclusion).toBe(
      'The publication is NOT in this campaign. Could not be checked without reading the network: membership, dates, brand_reference. No rule that can be checked rejects it.',
    )
    expect(d.notDeterminedWithoutReadingTheNetwork).toHaveLength(5)
  })

  it('a creator who is not a member, on that network or at all', () => {
    const stranger = run('https://www.tiktok.com/@nobody/video/7400000000000000009')
    expect(results(stranger).membership).toBe('fail')
    expect(stranger.author).toMatchObject({ handle: 'nobody', knownFrom: 'link', isMember: false })
    expect(stranger.conclusion).toMatch(/It does not meet: membership\./)
    const otherNetwork = run('https://www.tiktok.com/@Marta_Fit/video/7400000000000000009')
    expect(otherNetwork.checks.find(c => c.rule === 'membership')!.explanation).toMatch(/is a member on INSTAGRAM/)
    // The handle of a link is a hint
    expect(stranger.notDeterminedWithoutReadingTheNetwork[0]).toMatch(/really belongs to the handle/)
  })

  it('a story: the date comes from the link, the status and the scan decide whether it was read', () => {
    // 3986689802749386127 was published on 2026-09-15 (see src/lib/story-url.ts)
    const early = run('https://www.instagram.com/stories/marta_fit/3986689802749386127/')
    expect(early.link).toMatchObject({ type: 'STORY', handleInLink: 'marta_fit' })
    expect(early.link.publishedAtFromLink).toMatch(/^2026-09-15T/)
    expect(results(early)).toMatchObject({ membership: 'pass', creator_status: 'pass', dates: 'fail', brand_reference: 'unknown', stories_scan: 'fail' })
    expect(early.conclusion).toMatch(/It does not meet: dates\. The automatic capture does not read it: stories_scan\./)
    expect(early.notDeterminedWithoutReadingTheNetwork.join(' ')).toMatch(/expire after 24 hours/)

    // The same story in a campaign that started earlier, by a creator who is only a prospect
    const prospect = run('https://www.instagram.com/stories/luis.tok/3986689802749386127/', [], { startDate: new Date('2026-09-01T00:00:00.000Z') })
    expect(results(prospect)).toMatchObject({ membership: 'pass', creator_status: 'fail', dates: 'pass', stories_scan: 'pass' })
    expect(prospect.conclusion).toMatch(/The automatic capture does not read it: creator_status\./)

    // Social listening campaigns are not scanned for stories
    const listening = run('https://www.instagram.com/stories/marta_fit/3986689802749386127/', [], { startDate: new Date('2026-09-01T00:00:00.000Z'), type: 'SOCIAL_LISTENING' })
    expect(results(listening).stories_scan).toBe('fail')
    expect(listening.checks.find(c => c.rule === 'stories_scan')!.explanation).toMatch(/Social Listening/)
  })

  it('a campaign without brand targets captures nothing by itself', () => {
    const d = run('https://www.instagram.com/marta_fit/reel/DNeverSeen01/', [], { targetAccounts: [], targetHashtags: [], targetKeywords: [] })
    expect(results(d)).toMatchObject({ brand_targets: 'fail', membership: 'pass' })
    expect(d.conclusion).toMatch(/The automatic capture does not read it: brand_targets\./)
  })

  it('a link that is not a publication, and a highlight', () => {
    const short = run('https://vm.tiktok.com/ZMabcdef/')
    expect(short.link).toEqual({ recognised: false })
    expect(short.checks).toEqual([{ rule: 'link', decides: 'belongs', result: 'fail', explanation: expect.stringMatching(/Shortened links/) }])
    const highlight = run('https://www.instagram.com/stories/highlights/17912345678901234/')
    expect(highlight.conclusion).toMatch(/highlight has no publication date/)
  })

  it('a piece the platform has elsewhere: in another campaign, or in none', () => {
    const elsewhere = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record({ campaignId: 'c9', campaign: { id: 'c9', name: 'Otra Campaña' } })])
    expect(elsewhere.inThisCampaign).toBe(false)
    expect(elsewhere.platformRecords.inOtherCampaigns).toHaveLength(1)
    // Every rule passes: the capture simply has not filed it here yet
    expect(elsewhere.conclusion).toMatch(/NOT in this campaign although every check passes.*another campaign/)
    const loose = run('https://www.instagram.com/reel/DAbc_123xyZ/', [record({ campaignId: null, campaign: null, caption: 'sin marca', mentions: [] })])
    expect(results(loose).brand_reference).toBe('fail')
    expect(loose.conclusion).toMatch(/It does not meet: brand_reference\..*not attached to any campaign/)
    expectClean(loose)
  })
})
