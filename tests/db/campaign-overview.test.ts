/**
 * The campaign overview when a creator is a person with several profiles.
 *
 * Media.influencerId is the CREDITED member; Media.publishedByInfluencerId is
 * the profile that published when it is another profile of her person. These
 * tests prove, on a real (throwaway) database:
 *   - a creator counts once and her row adds up every network (byPlatform);
 *   - audience estimates use the followers of the account that published;
 *   - "vs su habitual" ignores what her other profiles published;
 *   - hiding a creator hides her pieces of every network;
 *   - a campaign with no linked profile gives the figures it always gave.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No test may reach a scraper: the capture module imports it, so it is replaced.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    isApifyExhausted: vi.fn(() => false),
  }
})

import { prisma } from '@/lib/db'
import type { ScrapedPost } from '@/lib/apify'
import type { MediaType, Platform } from '@/generated/prisma/client'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import type { TeamCampaignOverview } from '@/lib/campaign-overview'
import { sanitizeCampaignForBrand } from '@/lib/brand-scope'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { getCreatorStoryViewRates } from '@/lib/emv-server'
import type { CampaignOverview } from '@/lib/metrics'
import { linkProfile, unlinkProfile } from '@/lib/person-profiles'
import { revalidateCampaignMedia, upsertCampaignPost } from '@/lib/campaign-capture'

const PM = { id: 'user-pm', name: 'Laura PM' }
const RATES = { rates: DEFAULT_EMV_RATES }

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(reset)
afterAll(reset)

function profile(username: string, platform: Platform, followers: number) {
  return prisma.influencer.create({ data: { username, platform, followers } })
}

/** An October-like campaign: 1 to 31 Oct 2026, Instagram + TikTok, brand @vileda.es / #vileda. */
async function octoberCampaign() {
  const user = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM' } })
  return prisma.campaign.create({
    data: {
      name: '10.- Vileda - Micros Octubre (test)',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['vileda.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: user.id,
    },
  })
}

/** A video baseline frozen before the campaign: her usual reel gets `medianViews` views. */
function videoBaseline(medianViews: number) {
  return {
    family: 'video', format: 'REEL', n: 10, nRaw: 12, medianViews, medianEngagement: 80, pctBranded: 0,
    windowDays: 180, before: '2026-09-25T00:00:00.000Z', capturedAt: '2026-09-25T00:00:00.000Z', source: 'apify',
  }
}

function join(campaignId: string, influencerId: string, extra: { agreedFee?: number; baselineSnapshot?: object } = {}) {
  return prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED', ...extra } })
}

let seq = 0
interface PieceInput {
  /** The credited member (Media.influencerId) */
  member: { id: string }
  /** The profile that published, when it is not the member's own */
  publishedBy?: { id: string } | null
  platform?: Platform
  mediaType?: MediaType
  views?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
  reach?: number
  postedAt?: string
  isDeleted?: boolean
  /** null = a row outside any campaign (profile analysis, an older story) */
  campaignId: string | null
}

function piece(p: PieceInput) {
  seq++
  return prisma.media.create({
    data: {
      externalId: `piece-${seq}`,
      platform: p.platform ?? 'INSTAGRAM',
      mediaType: p.mediaType ?? 'REEL',
      caption: 'Probando la fregona nueva #vileda #publi',
      likes: p.likes ?? 0,
      comments: p.comments ?? 0,
      shares: p.shares ?? 0,
      saves: p.saves ?? 0,
      views: p.views ?? 0,
      reach: p.reach ?? 0,
      mentions: [],
      hashtags: ['vileda'],
      isDeleted: p.isDeleted ?? false,
      postedAt: new Date(p.postedAt ?? `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T10:00:00Z`),
      influencerId: p.member.id,
      publishedByInfluencerId: p.publishedBy?.id ?? null,
      campaignId: p.campaignId,
      source: 'manual',
    },
  })
}

async function overviewOf(campaignId: string, options: Parameters<typeof computeCampaignOverview>[1] = RATES): Promise<CampaignOverview> {
  const overview = await computeCampaignOverview(campaignId, options)
  expect(overview).not.toBeNull()
  return overview as CampaignOverview
}

function creator(overview: CampaignOverview, influencerId: string) {
  const row = overview.perInfluencer.find(p => p.influencerId === influencerId)
  expect(row, `creator ${influencerId} in the overview`).toBeDefined()
  return row!
}

function pieceOf(overview: CampaignOverview, mediaId: string) {
  const row = overview.perMedia.find(m => m.id === mediaId)
  expect(row, `piece ${mediaId} in the overview`).toBeDefined()
  return row!
}

/** The overview without the keys this delivery added: what every consumer saw before. */
function withoutNewKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNewKeys)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'publishedBy' && k !== 'byPlatform')
        .map(([k, v]) => [k, withoutNewKeys(v)])
    )
  }
  return value
}

/**
 * Three members with content on two networks:
 *  - @ale_ficticia (Instagram, 2.382) with her TikTok (29.000) linked: one reel of her own, one TikTok video, two stories
 *  - @risas_inventadas (Instagram, 19) with a second Instagram @risas_inventadas_ (8.100) linked: one reel from the second profile
 *  - @dana_ejemplo_dos twice, as Instagram and as TikTok member (today's legacy double membership): each keeps her own
 *  - @sinpublicar, a member with nothing published
 */
async function twoNetworkCampaign() {
  const campaign = await octoberCampaign()
  const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
  const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
  const humor = await profile('risas_inventadas', 'INSTAGRAM', 19)
  const humorReal = await profile('risas_inventadas_', 'INSTAGRAM', 8100)
  const dianaIg = await profile('dana_ejemplo_dos', 'INSTAGRAM', 12000)
  const dianaTt = await profile('dana_ejemplo_dos', 'TIKTOK', 40000)
  const idle = await profile('sinpublicar', 'INSTAGRAM', 5000)

  await join(campaign.id, aleIg.id, { agreedFee: 300, baselineSnapshot: videoBaseline(1000) })
  await join(campaign.id, humor.id, { agreedFee: 150 })
  await join(campaign.id, dianaIg.id, { agreedFee: 200 })
  await join(campaign.id, dianaTt.id)
  await join(campaign.id, idle.id)

  await linkProfile({ memberInfluencerId: aleIg.id, profileInfluencerId: aleTt.id, actor: PM, evidence: 'pm_confirmed' })
  await linkProfile({ memberInfluencerId: humor.id, profileInfluencerId: humorReal.id, actor: PM, evidence: 'pm_confirmed' })

  const c = campaign.id
  const media = {
    aleReel: await piece({ campaignId: c, member: aleIg, views: 2000, likes: 100, comments: 10 }),
    aleTiktok: await piece({ campaignId: c, member: aleIg, publishedBy: aleTt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 54000, likes: 1200, comments: 40, shares: 30, saves: 20 }),
    aleStory1: await piece({ campaignId: c, member: aleIg, mediaType: 'STORY', views: 300, postedAt: '2026-10-20T09:00:00Z' }),
    aleStory2: await piece({ campaignId: c, member: aleIg, mediaType: 'STORY', views: 250, postedAt: '2026-10-20T09:20:00Z' }),
    humorReel: await piece({ campaignId: c, member: humor, publishedBy: humorReal, views: 9000, likes: 400, comments: 25, saves: 5 }),
    dianaReel: await piece({ campaignId: c, member: dianaIg, views: 7000, likes: 300 }),
    dianaVideo: await piece({ campaignId: c, member: dianaTt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 15000, likes: 700, shares: 12 }),
  }
  return { campaign, aleIg, aleTt, humor, humorReal, dianaIg, dianaTt, idle, media }
}

// ---------------------------------------------------------------------------

describe('a creator counts once and her row adds up every network', () => {
  it('byPlatform sums equal the creator totals, for every creator', async () => {
    const f = await twoNetworkCampaign()
    const o = await overviewOf(f.campaign.id)

    expect(o.perInfluencer).toHaveLength(5)
    for (const p of o.perInfluencer) {
      const networks = Object.values(p.byPlatform ?? {})
      expect(networks.reduce((s, n) => s + n.pieces, 0), `pieces of @${p.username}`).toBe(p.media)
      expect(networks.reduce((s, n) => s + n.views, 0), `views of @${p.username}`).toBe(p.views)
      expect(networks.reduce((s, n) => s + n.engagements, 0), `engagements of @${p.username}`).toBe(p.engagements)
    }

    // @ale_ficticia: one row, Instagram member, with her TikTok video inside
    const ale = creator(o, f.aleIg.id)
    expect(ale).toMatchObject({ username: 'ale_ficticia', platform: 'INSTAGRAM', followers: 2382, media: 4, stories: 2, posts: 2, views: 56550, engagements: 1400 })
    expect(ale.byPlatform).toEqual({
      INSTAGRAM: { pieces: 3, views: 2550, engagements: 110 },
      TIKTOK: { pieces: 1, views: 54000, engagements: 1290 },
    })
    // A second profile on the SAME network adds to that network
    expect(creator(o, f.humor.id).byPlatform).toEqual({ INSTAGRAM: { pieces: 1, views: 9000, engagements: 430 } })
    // The legacy double membership: each member keeps her own content
    expect(creator(o, f.dianaIg.id).byPlatform).toEqual({ INSTAGRAM: { pieces: 1, views: 7000, engagements: 300 } })
    expect(creator(o, f.dianaTt.id).byPlatform).toEqual({ TIKTOK: { pieces: 1, views: 15000, engagements: 712 } })
    // Nothing published: an empty breakdown, never a missing key
    expect(creator(o, f.idle.id).byPlatform).toEqual({})
  })

  it('no linked profile is ever a row or a counted creator', async () => {
    const f = await twoNetworkCampaign()
    const o = await overviewOf(f.campaign.id)

    expect(o.totals.members).toBe(5)
    expect(o.totals.creatorsActive).toBe(4)
    expect(o.delivery.creators).toEqual({ planned: 5, delivered: 4, ok: false })
    expect(o.totals.media).toBe(7)
    expect(o.totals.views).toBe(87550)
    expect(o.totals.engagements).toBe(2842)
    expect(o.perInfluencer.map(p => p.influencerId).sort()).toEqual([f.aleIg.id, f.humor.id, f.dianaIg.id, f.dianaTt.id, f.idle.id].sort())
    expect(o.perInfluencer.some(p => p.influencerId === f.aleTt.id || p.influencerId === f.humorReal.id)).toBe(false)
    // The creators add up to the campaign
    expect(o.perInfluencer.reduce((s, p) => s + p.views, 0)).toBe(o.totals.views)
    expect(o.perInfluencer.reduce((s, p) => s + p.engagements, 0)).toBe(o.totals.engagements)
    expect(o.perInfluencer.reduce((s, p) => s + p.media, 0)).toBe(o.totals.media)
    // Every piece is credited to a member
    const members = new Set(o.perInfluencer.map(p => p.influencerId))
    expect(o.perMedia.every(m => members.has(m.influencerId as string))).toBe(true)
  })

  it('each piece says which profile published it; her own profile is null', async () => {
    const f = await twoNetworkCampaign()
    const o = await overviewOf(f.campaign.id)

    expect(pieceOf(o, f.media.aleTiktok.id)).toMatchObject({
      influencerId: f.aleIg.id,
      publishedBy: { influencerId: f.aleTt.id, username: 'ale_ficticia', platform: 'TIKTOK' },
    })
    expect(pieceOf(o, f.media.humorReel.id)).toMatchObject({
      influencerId: f.humor.id,
      publishedBy: { influencerId: f.humorReal.id, username: 'risas_inventadas_', platform: 'INSTAGRAM' },
    })
    for (const own of [f.media.aleReel, f.media.aleStory1, f.media.aleStory2, f.media.dianaReel, f.media.dianaVideo]) {
      expect(pieceOf(o, own.id).publishedBy, own.externalId as string).toBeNull()
    }
    // Only the handle and the network travel: no followers, no person, no staff name
    expect(Object.keys(pieceOf(o, f.media.aleTiktok.id).publishedBy as object).sort()).toEqual(['influencerId', 'platform', 'username'])
  })

  it('what the capture writes for a linked profile shows up in the member row, and survives revalidation and unlinking', async () => {
    const campaign = await octoberCampaign()
    const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
    const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
    const other = await profile('sara_inventada17', 'INSTAGRAM', 6225)
    await join(campaign.id, aleIg.id, { agreedFee: 300 })
    await join(campaign.id, other.id, { agreedFee: 200 })
    await piece({ campaignId: campaign.id, member: aleIg, views: 2000, likes: 100 })
    await piece({ campaignId: campaign.id, member: other, views: 4000, likes: 150 })
    const before = await overviewOf(campaign.id)

    await linkProfile({ memberInfluencerId: aleIg.id, profileInfluencerId: aleTt.id, actor: PM, evidence: 'pm_confirmed' })
    // Linking alone changes no figure
    expect(await overviewOf(campaign.id)).toEqual(before)

    const video: ScrapedPost = {
      externalId: '7695852671042964758',
      caption: 'Probando la fregona nueva #vileda',
      mediaUrl: null,
      thumbnailUrl: null,
      permalink: 'https://www.tiktok.com/@ale_ficticia/video/7695852671042964758',
      mediaType: 'VIDEO',
      likes: 120, comments: 4, shares: 3, saves: 2, views: 5400,
      postedAt: '2026-10-12T10:00:00.000Z',
      hashtags: ['vileda'],
      mentions: [],
    }
    expect(await upsertCampaignPost(campaign.id, aleIg.id, 'TIKTOK', video, { publishedByInfluencerId: aleTt.id })).toBe(true)
    await revalidateCampaignMedia(campaign.id)

    const after = await overviewOf(campaign.id)
    expect(after.totals.members).toBe(before.totals.members)
    expect(after.totals.creatorsActive).toBe(before.totals.creatorsActive)
    expect(after.perInfluencer).toHaveLength(before.perInfluencer.length)
    expect(after.totals.media).toBe(before.totals.media + 1)
    expect(after.totals.views).toBe(before.totals.views + 5400)
    expect(after.totals.engagements).toBe(before.totals.engagements + 129)
    const ale = creator(after, aleIg.id)
    expect(ale.byPlatform).toEqual({
      INSTAGRAM: { pieces: 1, views: 2000, engagements: 100 },
      TIKTOK: { pieces: 1, views: 5400, engagements: 129 },
    })
    expect(after.perMedia.filter(m => m.publishedBy).map(m => m.publishedBy)).toEqual([
      { influencerId: aleTt.id, username: 'ale_ficticia', platform: 'TIKTOK' },
    ])
    // The other creator is untouched
    expect(creator(after, other.id)).toEqual(creator(before, other.id))

    // Unlinking never moves content: the figures only depend on the stored pieces
    await unlinkProfile({ profileInfluencerId: aleTt.id, actor: PM, reason: 'prueba' })
    expect(await overviewOf(campaign.id)).toEqual(after)
  })
})

// ---------------------------------------------------------------------------

describe('audience estimates use the followers of the account that published', () => {
  it('a piece with no real data is estimated on the publishing profile, not on the member', async () => {
    const campaign = await octoberCampaign()
    const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
    const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
    const humor = await profile('risas_inventadas', 'INSTAGRAM', 19)
    const humorReal = await profile('risas_inventadas_', 'INSTAGRAM', 8100)
    await join(campaign.id, aleIg.id)
    await join(campaign.id, humor.id)
    const c = campaign.id

    // No views, reach or impressions: the audience can only be estimated from followers
    const tiktok = await piece({ campaignId: c, member: aleIg, publishedBy: aleTt, platform: 'TIKTOK', mediaType: 'VIDEO', likes: 30 })
    const aleOwn = await piece({ campaignId: c, member: aleIg, mediaType: 'POST', likes: 12 })
    const secondIg = await piece({ campaignId: c, member: humor, publishedBy: humorReal, mediaType: 'POST', likes: 50 })
    const humorOwn = await piece({ campaignId: c, member: humor, mediaType: 'POST', likes: 1 })

    const o = await overviewOf(c)
    // 29.000 followers on TikTok (micro, 18 %), not her 2.382 on Instagram (nano, 25 % → 596)
    expect(pieceOf(o, tiktok.id)).toMatchObject({ audience: 5220, audienceBasis: 'estimated_post', audienceEstimated: true })
    expect(pieceOf(o, aleOwn.id)).toMatchObject({ audience: 596, audienceBasis: 'estimated_post', audienceEstimated: true })
    // 8.100 followers on her real Instagram (nano, 25 %), not the 19 of the profile she is a member with (→ 5)
    expect(pieceOf(o, secondIg.id)).toMatchObject({ audience: 2025, audienceBasis: 'estimated_post', audienceEstimated: true })
    expect(pieceOf(o, humorOwn.id)).toMatchObject({ audience: 5, audienceBasis: 'estimated_post', audienceEstimated: true })

    // The creator's row adds what was estimated for each of her pieces, and stays an estimate
    expect(creator(o, aleIg.id).audience).toMatchObject({ estimated: 5816, real: 0, total: 5816 })
    expect(creator(o, humor.id).audience).toMatchObject({ estimated: 2030, real: 0, total: 2030 })
    expect(o.totals.audience).toMatchObject({ estimated: 7846, real: 0 })
    // Her card still shows the followers of the profile she is a member with
    expect(creator(o, aleIg.id).followers).toBe(2382)
    // Estimates never become a rate
    expect(o.totals.er.value).toBeNull()
  })

  it('real figures always win: followers are not used at all', async () => {
    const campaign = await octoberCampaign()
    const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
    const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
    await join(campaign.id, aleIg.id)
    const video = await piece({ campaignId: campaign.id, member: aleIg, publishedBy: aleTt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 54000, likes: 1200 })

    const o = await overviewOf(campaign.id)
    expect(pieceOf(o, video.id)).toMatchObject({ audience: 54000, audienceBasis: 'views', audienceEstimated: false, viewsPlausible: true })
    // TikTok video CPM (8 €), because the piece is a TikTok video whoever is credited
    expect(pieceOf(o, video.id).emvBasic).toBe(432)
  })

  it('a story from another profile: that account’s followers, its own learned view rate and its own sequence', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('risas_inventadas', 'INSTAGRAM', 2000)
    const second = await profile('risas_inventadas_', 'INSTAGRAM', 8000)
    await join(campaign.id, member.id)
    const c = campaign.id

    // What each account has taught us outside this campaign: the member's
    // stories are seen by all her followers, the second profile's by half
    await piece({ campaignId: null, member, mediaType: 'STORY', views: 2000, postedAt: '2026-08-01T10:00:00Z' })
    await piece({ campaignId: null, member: second, mediaType: 'STORY', views: 4000, postedAt: '2026-08-01T10:00:00Z' })

    // Three stories of the campaign with no real views, within the same hour
    const own = await piece({ campaignId: c, member, mediaType: 'STORY', postedAt: '2026-10-15T10:00:00Z' })
    const other1 = await piece({ campaignId: c, member, publishedBy: second, mediaType: 'STORY', postedAt: '2026-10-15T10:30:00Z' })
    const other2 = await piece({ campaignId: c, member, publishedBy: second, mediaType: 'STORY', postedAt: '2026-10-15T11:00:00Z' })

    const o = await overviewOf(c)
    // Her own profile: 2.000 followers × her rate (100 %)
    expect(pieceOf(o, own.id)).toMatchObject({ audience: 2000, audienceBasis: 'estimated_story', audienceEstimated: true })
    // The second profile: 8.000 followers × ITS rate (50 %), first story of ITS sequence.
    // With the member's rate it would be 8.000; counted as her second story, 15 % less.
    expect(pieceOf(o, other1.id)).toMatchObject({ audience: 4000, audienceBasis: 'estimated_story', audienceEstimated: true })
    // Second story of the second profile's sequence: −15 %
    expect(pieceOf(o, other2.id)).toMatchObject({ audience: 3400, audienceBasis: 'estimated_story', audienceEstimated: true })
    // Story CPM 8 €
    expect(pieceOf(o, other1.id).emvBasic).toBe(32)

    expect(o.totals.emvEstimatedStories).toBe(3)
    expect(o.totals.emvEstimatedAudience).toBe(9400)
    // All three count in the one creator of the campaign
    expect(o.perInfluencer).toHaveLength(1)
    expect(creator(o, member.id)).toMatchObject({ media: 3, stories: 3 })
    expect(creator(o, member.id).audience.estimated).toBe(9400)
  })

  it('a story with REAL views published from another profile teaches that profile’s view rate, never the member’s', async () => {
    const campaign = await octoberCampaign()
    // The member row is the wrong handle (19 followers); her real Instagram has 8.000
    const member = await profile('risas_inventadas', 'INSTAGRAM', 19)
    const second = await profile('risas_inventadas_', 'INSTAGRAM', 8000)
    const untouched = await profile('ale_ficticia', 'INSTAGRAM', 1000)
    await join(campaign.id, member.id)
    await join(campaign.id, untouched.id)
    const c = campaign.id

    // Credited to the member, published by her second profile, with the views the creator sent: 2.000 of 8.000 = 25 %
    await piece({ campaignId: c, member, publishedBy: second, mediaType: 'STORY', views: 2000, postedAt: '2026-10-10T10:00:00Z' })
    // A creator with no linked profile: 400 of 1.000 = 40 %, as always
    await piece({ campaignId: c, member: untouched, mediaType: 'STORY', views: 400, postedAt: '2026-10-10T10:00:00Z' })

    const rates = await getCreatorStoryViewRates([member.id, second.id, untouched.id])
    // Divided by the member's 19 followers it would be capped at 100 % and filed under the member
    expect(rates.get(second.id)).toBe(0.25)
    expect(rates.has(member.id)).toBe(false)
    expect(rates.get(untouched.id)).toBe(0.4)
    // Asked for the publisher alone (what the overview does), the same rate
    expect((await getCreatorStoryViewRates([second.id])).get(second.id)).toBe(0.25)
    // Asked for the member alone, her second profile's story teaches her nothing
    expect((await getCreatorStoryViewRates([member.id])).size).toBe(0)

    // Through the overview: a later story of each account with no real views
    const ownLater = await piece({ campaignId: c, member, mediaType: 'STORY', postedAt: '2026-10-20T10:00:00Z' })
    const secondLater = await piece({ campaignId: c, member, publishedBy: second, mediaType: 'STORY', postedAt: '2026-10-21T10:00:00Z' })
    const o = await overviewOf(c)
    // Second profile: 8.000 followers × its learned 25 %
    expect(pieceOf(o, secondLater.id)).toMatchObject({ audience: 2000, audienceBasis: 'estimated_story', audienceEstimated: true })
    // The member's own profile learned nothing from it: 19 followers at the generic rate, never 19 × 100 %
    expect(pieceOf(o, ownLater.id).audienceBasis).toBe('estimated_story')
    expect(pieceOf(o, ownLater.id).audience).toBeLessThan(19)
  })

  it('a publishing profile with no followers on record gives no estimate, never one borrowed from the member', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('nuria_demo15', 'INSTAGRAM', 3099)
    // Profiles created by hand when a link was pasted: nobody has read their followers yet
    const bareTiktok = await profile('nuria_demo15', 'TIKTOK', 0)
    const bareInstagram = await profile('nuria_demo15_', 'INSTAGRAM', 0)
    await join(campaign.id, member.id)
    const video = await piece({ campaignId: campaign.id, member, publishedBy: bareTiktok, platform: 'TIKTOK', mediaType: 'VIDEO', likes: 9 })
    const story = await piece({ campaignId: campaign.id, member, publishedBy: bareInstagram, mediaType: 'STORY' })

    const o = await overviewOf(campaign.id)
    // With the member's 3.099 followers these would be 775 and 465
    expect(pieceOf(o, video.id)).toMatchObject({ audience: 0, audienceBasis: 'none' })
    expect(pieceOf(o, story.id)).toMatchObject({ audience: 0, audienceBasis: 'none', emvBasic: 0 })
    expect(o.totals.audience).toMatchObject({ total: 0, withoutBase: 2 })
    // The interactions are real and still count
    expect(o.totals.engagements).toBe(9)
  })
})

// ---------------------------------------------------------------------------

describe('"vs su habitual" only compares pieces from the member’s own profile', () => {
  it('vsBaseline ignores cross-network pieces and pieces of a second profile on the same network', async () => {
    const campaign = await octoberCampaign()
    const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
    const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
    const aleIg2 = await profile('ale_ficticia.reels', 'INSTAGRAM', 900)
    await join(campaign.id, aleIg.id, { agreedFee: 300, baselineSnapshot: videoBaseline(1000) })
    await piece({ campaignId: campaign.id, member: aleIg, views: 2000, likes: 100 })

    const before = creator(await overviewOf(campaign.id), aleIg.id)
    expect(before.vsBaseline).toEqual({ multiplier: 2, metric: 'views', baseline: 1000, actual: 2000, n: 10, piecesCompared: 1, source: 'apify' })

    // Her TikTok video (27 times her usual Instagram reel) and a reel from a second Instagram profile
    await piece({ campaignId: campaign.id, member: aleIg, publishedBy: aleTt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 54000, likes: 1200 })
    await piece({ campaignId: campaign.id, member: aleIg, publishedBy: aleIg2, views: 30000, likes: 900 })

    const after = creator(await overviewOf(campaign.id), aleIg.id)
    // The pieces count in her row…
    expect(after).toMatchObject({ media: 3, views: 86000 })
    // …but the comparison with her Instagram habit is exactly the one it was
    expect(after.vsBaseline).toEqual(before.vsBaseline)
  })

  it('a member whose only pieces come from another profile has no comparison at all', async () => {
    const campaign = await octoberCampaign()
    const aleIg = await profile('ale_ficticia', 'INSTAGRAM', 2382)
    const aleTt = await profile('ale_ficticia', 'TIKTOK', 29000)
    await join(campaign.id, aleIg.id, { baselineSnapshot: videoBaseline(1000) })
    await piece({ campaignId: campaign.id, member: aleIg, publishedBy: aleTt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 54000, likes: 1200 })

    const ale = creator(await overviewOf(campaign.id), aleIg.id)
    expect(ale.views).toBe(54000)
    expect(ale.vsBaseline).toBeNull()
  })

  it('pieces recorded before Nov 2026 are compared as they always were, whatever their network', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('lili_ficticia', 'INSTAGRAM', 2000)
    await join(campaign.id, ig.id, { baselineSnapshot: videoBaseline(1000) })
    // No publisher recorded: an old row keeps counting in the comparison, even a
    // TikTok one stored under the Instagram member (nothing existing is reinterpreted)
    await piece({ campaignId: campaign.id, member: ig, views: 1000, likes: 40 })
    await piece({ campaignId: campaign.id, member: ig, platform: 'TIKTOK', mediaType: 'VIDEO', views: 3000, likes: 90 })

    const row = creator(await overviewOf(campaign.id), ig.id)
    expect(row.vsBaseline).toMatchObject({ multiplier: 2, actual: 2000, piecesCompared: 2 })
  })
})

// ---------------------------------------------------------------------------

describe('what the agency hides from the client', () => {
  it('a hidden creator hides her pieces of every network', async () => {
    const f = await twoNetworkCampaign()
    const full = await overviewOf(f.campaign.id)
    const o = await overviewOf(f.campaign.id, { ...RATES, exclude: { influencerIds: [f.aleIg.id] } })

    expect(o.perInfluencer.some(p => p.influencerId === f.aleIg.id)).toBe(false)
    expect(o.perMedia.some(m => m.influencerId === f.aleIg.id)).toBe(false)
    // Her TikTok video is gone too, although another profile published it
    expect(o.perMedia.some(m => m.id === f.media.aleTiktok.id)).toBe(false)
    expect(o.perMedia.some(m => m.publishedBy?.influencerId === f.aleTt.id)).toBe(false)
    expect(o.perMedia.map(m => m.id).sort()).toEqual([f.media.humorReel.id, f.media.dianaReel.id, f.media.dianaVideo.id].sort())

    const ale = creator(full, f.aleIg.id)
    expect(o.totals.members).toBe(full.totals.members - 1)
    expect(o.totals.creatorsActive).toBe(full.totals.creatorsActive - 1)
    expect(o.totals.media).toBe(full.totals.media - ale.media)
    expect(o.totals.views).toBe(full.totals.views - ale.views)
    expect(o.totals.engagements).toBe(full.totals.engagements - ale.engagements)
    expect(o.totals.mediaCounts).toEqual({ REEL: 2, VIDEO: 1 })
    expect(o.timeline.reduce((s, d) => s + d.posts, 0)).toBe(3)
    // The others are exactly as they were
    for (const id of [f.humor.id, f.dianaIg.id, f.dianaTt.id, f.idle.id]) expect(creator(o, id)).toEqual(creator(full, id))
  })

  it('hiding one piece of another network takes it out of her row and of her breakdown', async () => {
    const f = await twoNetworkCampaign()
    const o = await overviewOf(f.campaign.id, { ...RATES, exclude: { mediaIds: [f.media.aleTiktok.id] } })

    const ale = creator(o, f.aleIg.id)
    expect(ale).toMatchObject({ media: 3, views: 2550, engagements: 110 })
    expect(ale.byPlatform).toEqual({ INSTAGRAM: { pieces: 3, views: 2550, engagements: 110 } })
    expect(o.perMedia.some(m => m.publishedBy?.influencerId === f.aleTt.id)).toBe(false)
    expect(o.totals.members).toBe(5)
  })

  it('the client view keeps the breakdown and loses every economic figure', async () => {
    const f = await twoNetworkCampaign()
    const full = await overviewOf(f.campaign.id)
    const client = stripEconomics(full)

    const ale = creator(client, f.aleIg.id)
    expect(ale).toMatchObject({ cost: 0, emvRatio: null, cpm: null, emvBasic: 0 })
    expect(ale.byPlatform).toEqual(creator(full, f.aleIg.id).byPlatform)
    expect(pieceOf(client, f.media.aleTiktok.id).publishedBy).toEqual({ influencerId: f.aleTt.id, username: 'ale_ficticia', platform: 'TIKTOK' })
    // Nothing in the breakdown is money or an estimate
    expect(Object.keys(ale.byPlatform?.TIKTOK ?? {}).sort()).toEqual(['engagements', 'pieces', 'views'])
  })

  it('who on the team added a creator never reaches a brand', async () => {
    const payload = {
      campaign: {
        name: 'Octubre',
        influencers: [{
          status: 'COMPLETED', addedById: 'user-pm', addedByName: 'Laura PM', agreedFee: 300,
          influencer: { username: 'ale_ficticia', platform: 'INSTAGRAM', followers: 2382, addedById: 'user-pm', addedByName: 'Laura PM', personId: 'p1' },
        }],
      },
    }
    expect(sanitizeCampaignForBrand(payload)).toEqual({
      campaign: {
        name: 'Octubre',
        influencers: [{ status: 'COMPLETED', influencer: { username: 'ale_ficticia', platform: 'INSTAGRAM', followers: 2382, personId: 'p1' } }],
      },
    })
    expect(JSON.stringify(sanitizeCampaignForBrand(payload))).not.toContain('Laura')

    // The overview itself never carries those fields
    const f = await twoNetworkCampaign()
    const serialized = JSON.stringify(await overviewOf(f.campaign.id))
    expect(serialized).not.toContain('addedBy')
    expect(serialized).not.toContain(PM.name)
  })
})

// ---------------------------------------------------------------------------

describe('a campaign with no linked profile gives the figures it always gave', () => {
  async function legacyCampaign() {
    const campaign = await octoberCampaign()
    const a = await profile('gema.ficticia_', 'INSTAGRAM', 190)
    const b = await profile('sara_inventada17', 'INSTAGRAM', 6225)
    const tt = await profile('dana_ejemplo_dos', 'TIKTOK', 40000)
    // The same handle on TikTok exists but is NOT linked: it plays no part
    await profile('sara_inventada17', 'TIKTOK', 13400)
    await join(campaign.id, a.id, { agreedFee: 100, baselineSnapshot: videoBaseline(500) })
    await join(campaign.id, b.id, { agreedFee: 250 })
    await join(campaign.id, tt.id)
    const c = campaign.id
    const media = [
      await piece({ campaignId: c, member: a, views: 1500, likes: 80, comments: 5, postedAt: '2026-10-05T10:00:00Z' }),
      await piece({ campaignId: c, member: a, mediaType: 'POST', likes: 20, postedAt: '2026-10-06T10:00:00Z' }),
      await piece({ campaignId: c, member: b, views: 9000, likes: 410, comments: 22, shares: 9, saves: 14, postedAt: '2026-10-07T10:00:00Z' }),
      await piece({ campaignId: c, member: b, mediaType: 'STORY', postedAt: '2026-10-08T10:00:00Z' }),
      await piece({ campaignId: c, member: b, mediaType: 'STORY', postedAt: '2026-10-08T10:30:00Z' }),
      await piece({ campaignId: c, member: b, views: 3000, likes: 100, isDeleted: true, postedAt: '2026-10-09T10:00:00Z' }),
      await piece({ campaignId: c, member: tt, platform: 'TIKTOK', mediaType: 'VIDEO', views: 15000, likes: 700, shares: 12, postedAt: '2026-10-10T10:00:00Z' }),
    ]
    return { campaign, a, b, tt, media }
  }

  it('every piece is her own, and the old figures are the ones computed by hand', async () => {
    const f = await legacyCampaign()
    const o = await overviewOf(f.campaign.id)

    expect(o.perMedia.every(m => m.publishedBy === null)).toBe(true)
    expect(o.totals).toMatchObject({
      media: 7, mediaDeleted: 1, stories: 2, posts: 5, creatorsActive: 3, members: 3,
      views: 28500, likes: 1310, comments: 27, shares: 21, saves: 14, engagements: 1372,
      cost: 350, membersWithCost: 2,
      emvEstimatedStories: 2, emvEstimatedAudience: 1728,
      mediaCounts: { REEL: 3, POST: 1, STORY: 2, VIDEO: 1 },
    })
    // Estimates on the member's own followers, as always:
    //  stories of @sara_inventada17 (6.225, nano 15 %): 934 and, second of the sequence, 794
    //  image post of @gema.ficticia_ (190, nano 25 %): 48
    expect(o.totals.audience).toMatchObject({ real: 28500, estimated: 1776, realPieces: 4 })
    expect(pieceOf(o, f.media[3].id)).toMatchObject({ audience: 934, audienceBasis: 'estimated_story' })
    expect(pieceOf(o, f.media[4].id)).toMatchObject({ audience: 794, audienceBasis: 'estimated_story' })
    expect(pieceOf(o, f.media[1].id)).toMatchObject({ audience: 48, audienceBasis: 'estimated_post' })
    expect(o.totals.er).toMatchObject({ value: 4.74, numerator: 1352, denominator: 28500, pieces: 4 })
    expect(o.totals.cpm).toBe(12.28)
    expect(creator(o, f.a.id).vsBaseline).toEqual({ multiplier: 3, metric: 'views', baseline: 500, actual: 1500, n: 10, piecesCompared: 1, source: 'apify' })
    expect(creator(o, f.b.id)).toMatchObject({ media: 4, stories: 2, posts: 2, deleted: 1, views: 12000, engagements: 555, cost: 250 })
    expect(creator(o, f.tt.id)).toMatchObject({ platform: 'TIKTOK', media: 1, views: 15000, engagements: 712, cost: 0 })
  })

  it('writing the member herself as the publisher changes nothing at all', async () => {
    const f = await legacyCampaign()
    const before = await overviewOf(f.campaign.id)

    for (const m of f.media) await prisma.media.update({ where: { id: m.id }, data: { publishedByInfluencerId: m.influencerId } })
    expect(await overviewOf(f.campaign.id)).toEqual(before)
  })

  it('the overview only gained publishedBy per piece and byPlatform per creator, plus the team-only late keys (Nov 2026)', async () => {
    const f = await legacyCampaign()
    const o = await overviewOf(f.campaign.id)

    expect(Object.keys(o).sort()).toEqual(['balance', 'business', 'definitionsVersion', 'delivery', 'erOnReach', 'perInfluencer', 'perMedia', 'targets', 'timeline', 'totals'])
    expect(o.definitionsVersion).toBe(2)
    expect(Object.keys(o.perMedia[0]).sort()).toEqual([
      'audience', 'audienceBasis', 'audienceEstimated', 'emvBasic', 'emvExtended', 'engagements', 'id', 'influencerId',
      'isDeleted', 'lateDays', 'mediaType', 'publishedBy', 'views', 'viewsPlausible',
    ])
    expect(Object.keys(o.perInfluencer[0]).sort()).toEqual([
      'audience', 'byPlatform', 'cost', 'cpm', 'deleted', 'deliverablesPlanned', 'displayName', 'emvBasic', 'emvExtended', 'emvRatio',
      'engagements', 'er', 'followers', 'influencerId', 'latePieces', 'maxLateDays', 'media', 'platform', 'posts', 'status', 'stories', 'trackedClicks',
      'username', 'views', 'vsBaseline',
    ])
    // Nothing late in this campaign: the late keys are empty (src/lib/assignment-rules.ts)
    const team = o as unknown as TeamCampaignOverview
    expect(team.perMedia.every(m => m.lateDays === null)).toBe(true)
    expect(team.perInfluencer.every(p => p.latePieces === 0 && p.maxLateDays === null)).toBe(true)
    expect(Object.keys(o.totals).sort()).toEqual([
      'audience', 'comments', 'cost', 'cpm', 'creatorsActive', 'emvBasic', 'emvEstimatedAudience', 'emvEstimatedStories', 'emvExtended',
      'emvRatio', 'emvRealStories', 'emvTrustMultiplier', 'engagements', 'er', 'impressionsReal', 'likes', 'media', 'mediaCounts',
      'mediaDeleted', 'members', 'membersWithCost', 'posts', 'reachReal', 'saves', 'shares', 'stories', 'views',
    ])
    // And linking a profile that publishes nothing still changes nothing but nothing
    const tiktok = await prisma.influencer.findFirstOrThrow({ where: { username: 'sara_inventada17', platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: f.b.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    expect(withoutNewKeys(await overviewOf(f.campaign.id))).toEqual(withoutNewKeys(o))
    expect(await overviewOf(f.campaign.id)).toEqual(o)
  })
})
