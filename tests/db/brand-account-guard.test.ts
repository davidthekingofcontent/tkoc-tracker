/**
 * The brand's own account is never a profile of a creator (review of delivery
 * 1, 12 Nov 2026). "The brand's account" is either a "Cuenta de Marca
 * Objetivo" of the campaign or the Instagram account the brand attached to the
 * campaign connected through Meta (Setting campaign_brand_<campaignId> → brand
 * id → Setting brand_ig_<brandId>), also when the PM did not type it among the
 * targets.
 *
 *  - POST /api/campaigns/[id]/media/manual answers 400 with a clear sentence
 *    and creates, links and stores nothing, whatever the PM picks or confirms.
 *  - The daily TikTok pass (runTikTokAutolink) never reads such an account as
 *    the TikTok of a creator, linked or candidate, and reports it in its run
 *    summary.
 *
 * The network is mocked: the scraper answers from a table, TikTok from a stub,
 * the session is the test's and `fetch` throws.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  apifyConfigured: true,
  /** What the network answers for each clean link; a link that is not here cannot be read */
  posts: new Map<string, unknown>(),
  session: null as null | { id: string; email: string; name: string; role: string },
}))

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => net.posts.get(url) ?? null),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => net.apifyConfigured),
    scrapeTikTokProfilesBatch: vi.fn(),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
  }
})
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})
// A profile write is followed by an avatar copy and the creator pool: not in a test
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedPost, ScrapedProfile, ScrapedSinglePost, TikTokProfilesBatch } from '@/lib/apify'
import { POST } from '@/app/api/campaigns/[id]/media/manual/route'
import { loadCampaignBrandAccounts } from '@/lib/campaign-capture'
import { linkProfile } from '@/lib/person-profiles'
import { runTikTokAutolink } from '@/lib/tiktok-autolink'
import { tiktokIdAt } from './fixtures/october'

const fetchStub = vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') })
vi.stubGlobal('fetch', fetchStub)

const batch = vi.mocked(scrapeTikTokProfilesBatch)
/** "Today" of the daily pass: inside the campaign */
const NOW = new Date('2026-10-20T12:00:00Z')
/** The brand's Instagram connected through Meta: NOT among the campaign's targets */
const OWN = 'marcademo.oficial'
const OWN_REFUSAL = `@${OWN} es la cuenta de la marca de esta campaña. No se puede registrar como perfil de una creadora.`
const TARGET_REFUSAL = '@marca.demo es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora.'

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

interface Fixture {
  campaignId: string
  pmId: string
  alba: { id: string }
}

/** October campaign of the brand "Marca Demo": target @marca.demo / #marcademo, its Instagram @marcademo.oficial connected. */
async function seed(): Promise<Fixture> {
  const pm = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo - Octubre (test)',
      status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.demo'],
      targetHashtags: ['marcademo'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: pm.id,
    },
  })
  const alba = await prisma.influencer.create({ data: { username: 'alba_prueba', platform: 'INSTAGRAM', followers: 2100 } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: alba.id, status: 'COMPLETED' } })
  await attachBrand(campaign.id)
  net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
  return { campaignId: campaign.id, pmId: pm.id, alba }
}

/** The brand as the app stores it (src/app/api/brands, the Meta brand-connect callback). */
async function attachBrand(campaignId: string) {
  const brandId = 'brand_1700000000000_demo'
  await prisma.setting.upsert({ where: { key: brandId }, update: {}, create: { key: brandId, value: JSON.stringify({ id: brandId, name: 'Marca Demo' }) } })
  await prisma.setting.upsert({ where: { key: `brand_ig_${brandId}` }, update: {}, create: { key: `brand_ig_${brandId}`, value: OWN } })
  await prisma.setting.create({ data: { key: `campaign_brand_${campaignId}`, value: brandId } })
}

let fx: Fixture

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  net.apifyConfigured = true
  net.posts.clear()
  batch.mockReset()
  batch.mockImplementation(async () => { throw new Error('scrapeTikTokProfilesBatch: no TikTok account was served to this test') })
  fx = await seed()
})

afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

interface Answer {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

async function add(body: Record<string, unknown>, campaignId: string = fx.campaignId): Promise<Answer> {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: campaignId }) })
  return { status: response.status, body: await response.json() }
}

/** Everything a refused request must leave as it was */
async function state() {
  const [memberships, influencers, persons, logs, media, linked] = await Promise.all([
    prisma.campaignInfluencer.count(),
    prisma.influencer.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.media.count(),
    prisma.influencer.count({ where: { personId: { not: null } } }),
  ])
  return { memberships, influencers, persons, logs, media, linked }
}

/** A reel published by `owner` on 15 Oct, with the brand's hashtag */
function reel(code: string, owner: string, low: number): string {
  const url = `https://www.instagram.com/reel/${code}/`
  net.posts.set(url, {
    externalId: `37450000000000008${low}`, caption: 'Con nuestra creadora #marcademo', likes: 900, comments: 40, views: 52000, thumbnailUrl: null,
    postedAt: '2026-10-15T10:00:00.000Z', ownerUsername: owner, mediaType: 'REEL', hashtags: ['#marcademo'], mentions: [],
  } satisfies ScrapedSinglePost)
  return url
}

/** A TikTok video of `handle` on 16 Oct */
function tiktok(handle: string, low: number): string {
  const id = tiktokIdAt('2026-10-16T10:00:00.000Z', low)
  const url = `https://www.tiktok.com/@${handle}/video/${id}`
  net.posts.set(url, {
    externalId: id, caption: 'Vídeo #marcademo', likes: 50, comments: 2, views: 80000, thumbnailUrl: null,
    postedAt: '2026-10-16T10:00:00.000Z', ownerUsername: handle, mediaType: 'VIDEO', hashtags: ['#marcademo'], mentions: [],
  } satisfies ScrapedSinglePost)
  return url
}

// ---------------------------------------------------------------------------

describe('loadCampaignBrandAccounts', () => {
  it('gives the targets as typed and the brand’s connected Instagram, per campaign', async () => {
    const plain = await prisma.campaign.create({
      data: { name: 'Sin marca (test)', targetAccounts: ['@Otra.Marca @otra_tienda'], targetHashtags: [], targetKeywords: [], userId: fx.pmId },
    })
    const accounts = await loadCampaignBrandAccounts([
      { id: fx.campaignId, targetAccounts: ['@Marca.Demo'] },
      { id: plain.id, targetAccounts: ['@Otra.Marca @otra_tienda'] },
    ])
    expect(accounts.get(fx.campaignId)).toEqual({ targets: ['marca.demo'], own: [OWN] })
    expect(accounts.get(plain.id)).toEqual({ targets: ['otra.marca', 'otra_tienda'], own: [] })
    expect(await loadCampaignBrandAccounts([])).toEqual(new Map())
  })

  it('a brand with no connected Instagram, or a mapping to nothing, gives no own account', async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: 'brand_ig_' } } })
    expect((await loadCampaignBrandAccounts([{ id: fx.campaignId, targetAccounts: ['marca.demo'] }])).get(fx.campaignId)).toEqual({ targets: ['marca.demo'], own: [] })
    await prisma.setting.update({ where: { key: `campaign_brand_${fx.campaignId}` }, data: { value: ' ' } })
    expect((await loadCampaignBrandAccounts([{ id: fx.campaignId, targetAccounts: [] }])).get(fx.campaignId)).toEqual({ targets: [], own: [] })
  })
})

describe('«Añadir publicación por URL»: the brand’s connected Instagram is never a creator’s profile', () => {
  it('refuses its reel and its TikTok whatever the PM picks or confirms, and registers nothing', async () => {
    const brandReel = reel('DfDeLaMarcaOf1', 'MarcaDemo.Oficial', 1)
    const brandVideo = tiktok(OWN, 71)
    const alba = fx.alba.id
    const before = await state()

    for (const body of [
      // As the form sends it, with and without a creator picked
      { url: brandReel },
      { url: brandReel, influencerId: alba },
      // As the confirmation sends it, bound to the author she was shown
      { url: brandReel, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: OWN, linkProfileAuthorPlatform: 'INSTAGRAM' },
      // The brand's TikTok under the same username
      { url: brandVideo },
      { url: brandVideo, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: OWN, linkProfileAuthorPlatform: 'TIKTOK' },
    ]) {
      expect(await add(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: OWN_REFUSAL } })
    }
    // With the network down the @user of the link is the brand's: the same
    net.apifyConfigured = false
    expect(await add({ url: brandVideo, influencerId: alba, linkProfileTo: alba, confirmUnverified: true })).toEqual({ status: 400, body: { error: OWN_REFUSAL } })

    expect(await state()).toEqual(before)
    expect(await prisma.influencer.count({ where: { username: { in: [OWN, 'MarcaDemo.Oficial'] } } })).toBe(0)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: alba } })).personId).toBeNull()
  })

  it('an account of the brand registered on a creator before is not credited to her here', async () => {
    const brandTikTok = await prisma.influencer.create({ data: { username: OWN, platform: 'TIKTOK', followers: 250000 } })
    await linkProfile({ memberInfluencerId: fx.alba.id, profileInfluencerId: brandTikTok.id, actor: null, evidence: 'pm_manual' })
    const video = tiktok(OWN, 72)
    const before = await state()

    for (const body of [{ url: video }, { url: video, influencerId: fx.alba.id }]) {
      expect(await add(body)).toEqual({
        status: 400,
        body: { error: `@${OWN} es la cuenta de la marca de esta campaña. Su contenido no se guarda en la fila de @alba_prueba.` },
      })
    }
    expect(await state()).toEqual(before)
  })

  it('the brand added as a creator keeps its own publications', async () => {
    const brandRow = await prisma.influencer.create({ data: { username: OWN, platform: 'INSTAGRAM', followers: 90000 } })
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaignId, influencerId: brandRow.id, status: 'COMPLETED' } })

    const own = await add({ url: reel('DfDeLaMarcaOf2', OWN, 2) })
    expect(own.status).toBe(201)
    expect(own.body.media.influencerId).toBe(brandRow.id)
    expect(own.body.media.publishedByInfluencerId).toBeNull()
  })

  it('it is the brand of THIS campaign: in a campaign of another brand the question is asked as for anybody', async () => {
    const other = await prisma.campaign.create({
      data: {
        name: 'Otra marca - Octubre (test)', status: 'ACTIVE',
        startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
        targetAccounts: ['otra.marca'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: fx.pmId,
      },
    })
    await prisma.campaignInfluencer.create({ data: { campaignId: other.id, influencerId: fx.alba.id, status: 'COMPLETED' } })

    const question = await add({ url: reel('DfDeLaMarcaOf3', OWN, 3) }, other.id)
    expect(question.status).toBe(409)
    expect(question.body.code).toBe('profile_not_linked')
  })

  it('a target account keeps its own sentence', async () => {
    expect(await add({ url: reel('DfDeLaMarcaTg1', 'marca.demo', 4), linkProfileTo: fx.alba.id })).toEqual({ status: 400, body: { error: TARGET_REFUSAL } })
  })
})

// ---------------------------------------------------------------------------
// The daily TikTok pass
// ---------------------------------------------------------------------------

function video(handle: string, id: string): ScrapedPost {
  return {
    externalId: id, caption: 'Probando #marcademo', mediaUrl: null, thumbnailUrl: null,
    permalink: `https://www.tiktok.com/@${handle}/video/${id}`, mediaType: 'VIDEO',
    likes: 120, comments: 4, shares: 3, saves: 2, views: 5400, postedAt: '2026-10-12T10:00:00.000Z', hashtags: ['marcademo'], mentions: [],
  }
}

function account(username: string, videos: ScrapedPost[]): ScrapedProfile {
  return {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: videos,
  }
}

/** TikTok answers for every account it is asked about, each with a video of the campaign */
function serveEveryAccount() {
  batch.mockImplementation(async (handles: string[]) => {
    const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
    handles.forEach((handle, i) => out.profiles.set(handle, account(handle, [video(handle, `77000000000000001${i}`)])))
    return out
  })
}
const requestedHandles = () => batch.mock.calls.flatMap(call => call[0]).sort()

describe('the daily TikTok pass never reads the brand’s account as a creator’s TikTok', () => {
  it('skips a candidate her bio points at and a profile linked to her before, reports both, and reads the rest', async () => {
    const join = async (username: string, website: string | null) => {
      const row = await prisma.influencer.create({ data: { username, platform: 'INSTAGRAM', website } })
      await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaignId, influencerId: row.id, status: 'COMPLETED' } })
      return row
    }
    // Her Instagram bio links the brand's TikTok: the connected account, and a target account
    await join('lucia_prueba', `https://www.tiktok.com/@${OWN}`)
    await join('sara_prueba', 'https://www.tiktok.com/@marca.demo')
    // A creator with her own TikTok: read as always
    await join('nora_prueba', null)
    // alba has the brand's TikTok registered as hers (before this rule)
    const brandTikTok = await prisma.influencer.create({ data: { username: OWN, platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: fx.alba.id, profileInfluencerId: brandTikTok.id, actor: null, evidence: 'pm_manual' })
    serveEveryAccount()

    const summary = await runTikTokAutolink({ now: NOW })

    expect(requestedHandles()).toEqual(['nora_prueba'])
    const reported = summary.notLinked.map(n => `${n.member}→${n.handle}:${n.reason}`).sort()
    expect(reported).toEqual([
      `alba_prueba→${OWN}:brand_account`,
      `lucia_prueba→${OWN}:brand_account`,
      'sara_prueba→marca.demo:brand_account',
    ])
    expect(summary).toMatchObject({ linked: 1, videos: 1, failed: [] })
    expect(summary.campaigns[0]).toMatchObject({ candidates: 1, known: 0, linked: ['nora_prueba'] })

    // Nothing of the brand was stored, linked or created
    const media = await prisma.media.findMany({ select: { externalId: true, publishedBy: { select: { username: true } } } })
    expect(media).toEqual([{ externalId: '770000000000000010', publishedBy: { username: 'nora_prueba' } }])
    expect(await prisma.influencer.count({ where: { platform: 'TIKTOK', username: { in: [OWN, 'marca.demo'] } } })).toBe(1) // alba's old link only
    // A brand account is a decision, not a capture gap: no «TikTok sin vincular»
    expect(await prisma.notification.count({ where: { title: 'TikTok sin vincular' } })).toBe(0)
  })
})
