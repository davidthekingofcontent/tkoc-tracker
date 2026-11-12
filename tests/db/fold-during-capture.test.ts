/**
 * A fold of a TikTok twin (src/lib/person-fold.ts) that commits WHILE a capture
 * is running must never leave a piece filed under the twin (review of delivery
 * 1b, 12 Nov 2026).
 *
 * check-posts loads the members once and then reads one account after another
 * for minutes; the manual endpoint loads the roster and then waits up to ~20 s
 * for the scraper. If the twin was folded meanwhile and the piece was still
 * written under it, the piece counted in the campaign totals and showed in no
 * creator row, until a revalidation detached it (or deleted it).
 *
 * Now the credit is read at write time and the write holds the membership
 * (withCampaignMembership): the piece goes to the creator's own row, published
 * by the TikTok account; a write for a profile that is no longer a member
 * stores nothing.
 *
 * The network is mocked: the profile read and the single-post scraper answer
 * from a table, and each can run the fold "while the network answers".
 * Every handle and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  profiles: new Map<string, unknown>(),
  posts: new Map<string, unknown>(),
  /** Runs while the network "answers" for this key (PLATFORM:username, or the link) */
  during: new Map<string, () => Promise<unknown>>(),
  exhausted: false,
  session: null as null | { id: string; email: string; name: string; role: string },
}))

vi.mock('@/lib/apify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apify')>()
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    ...real,
    isApifyConfiguredAsync: vi.fn(async () => true),
    checkApifyAuth: vi.fn(async () => 'ok'),
    isApifyExhausted: vi.fn(() => net.exhausted),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usedPct: 10, cycleEndsAt: null })),
    scrapeSinglePost: vi.fn(async (url: string) => {
      await net.during.get(url)?.()
      return net.posts.get(url) ?? null
    }),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapePostsBatch: blocked('scrapePostsBatch'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})
vi.mock('@/lib/platform-client', () => ({
  fetchProfile: vi.fn(async (username: string, platform: string) => {
    await net.during.get(`${platform}:${username}`)?.()
    const profile = net.profiles.get(`${platform}:${username}`)
    return profile ? { profile, dataSource: 'apify' } : null
  }),
}))
vi.mock('@/lib/youtube-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/youtube-api')>()), isYouTubeApiConfigured: vi.fn(() => false) }))
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import pg from 'pg'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedPost, ScrapedProfile, ScrapedSinglePost } from '@/lib/apify'
import { GET as checkPosts } from '@/app/api/cron/check-posts/route'
import { POST as addManual } from '@/app/api/campaigns/[id]/media/manual/route'
import { upsertCampaignPost } from '@/lib/campaign-capture'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { TWIN_SOURCE_PREFIX, foldTwinMembership } from '@/lib/person-fold'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignNote.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  net.profiles.clear()
  net.posts.clear()
  net.during.clear()
  net.exhausted = false
  net.session = null
  delete process.env.CRON_SECRET
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const VIDEO_ID = '7690000000000000101'
const VIDEO_URL = `https://www.tiktok.com/@lucia_prueba/video/${VIDEO_ID}`

/** An October campaign where @lucia_prueba is a member with her Instagram and, a second time, with her TikTok (a twin). */
async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const admin = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo - Octubre (prueba)', status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: admin.id,
    },
  })
  const instagram = await prisma.influencer.create({ data: { username: 'lucia_prueba', platform: 'INSTAGRAM', followers: 2100 } })
  const tiktok = await prisma.influencer.create({ data: { username: 'lucia_prueba', platform: 'TIKTOK', followers: 31000 } })
  const original = await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: instagram.id, status: 'COMPLETED', agreedFee: 200 } })
  const twin = await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: tiktok.id, status: 'COMPLETED', source: `${TWIN_SOURCE_PREFIX}${instagram.id}` },
  })
  return {
    admin: { id: admin.id, email: admin.email, name: 'Ada Admin', role: 'ADMIN' },
    campaignId: campaign.id,
    instagram: instagram.id,
    tiktok: tiktok.id,
    originalMembership: original.id,
    twinMembership: twin.id,
  }
}
type Fixture = Awaited<ReturnType<typeof seed>>

function video(): ScrapedPost {
  return {
    externalId: VIDEO_ID, caption: 'Probando la mopa nueva #marcademo', mediaUrl: null, thumbnailUrl: null, permalink: VIDEO_URL,
    mediaType: 'VIDEO', likes: 120, comments: 4, shares: 0, saves: 0, views: 5400, postedAt: '2026-10-12T10:00:00.000Z',
    hashtags: ['marcademo'], mentions: [],
  }
}

function serve(platform: string, username: string, posts: ScrapedPost[]) {
  const profile: ScrapedProfile = {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: posts,
  }
  net.profiles.set(`${platform}:${username}`, profile)
}

/** Where the piece is, and what the campaign counts */
async function outcome(fx: Fixture) {
  const pieces = await prisma.media.findMany({ where: { campaignId: fx.campaignId }, select: { externalId: true, platform: true, influencerId: true, publishedByInfluencerId: true } })
  const members = await prisma.campaignInfluencer.findMany({ where: { campaignId: fx.campaignId }, select: { influencerId: true } })
  const overview = await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES })
  return { pieces, members: members.map(m => m.influencerId), overview: overview! }
}

/** Every piece the campaign counts is in a creator row: nothing filed under a profile that is not a member. */
function expectEveryPieceInARow(o: Awaited<ReturnType<typeof outcome>>) {
  for (const p of o.pieces) expect(o.members, `${p.platform}:${p.externalId}`).toContain(p.influencerId)
  expect(o.overview.perInfluencer.reduce((n, r) => n + r.media, 0)).toBe(o.overview.totals.media)
}

describe('a fold that commits while a capture runs', () => {
  it('check-posts: the new video read for the twin after the fold goes to her own row, published by the TikTok account', async () => {
    const fx = await seed()
    net.exhausted = true // only skips the views refresh after the capture
    serve('INSTAGRAM', 'lucia_prueba', [])
    serve('TIKTOK', 'lucia_prueba', [video()])
    // The run has loaded the members (the twin among them); an ADMIN folds the twin while its account is being read
    let folded: Awaited<ReturnType<typeof foldTwinMembership>> | null = null
    net.during.set('TIKTOK:lucia_prueba', async () => { folded = await foldTwinMembership(fx.twinMembership, { id: fx.admin.id, name: fx.admin.name }) })

    const response = await checkPosts(new NextRequest('http://localhost/api/cron/check-posts?force=1'))
    const body = await response.json()
    expect(body).toMatchObject({ success: true, influencersChecked: 2, newPosts: 1 })
    expect(folded).toMatchObject({ membershipId: fx.twinMembership, movedPieces: 0 })

    const o = await outcome(fx)
    expect(o.members).toEqual([fx.instagram])
    expect(o.pieces).toEqual([{ externalId: VIDEO_ID, platform: 'TIKTOK', influencerId: fx.instagram, publishedByInfluencerId: fx.tiktok }])
    expectEveryPieceInARow(o)
    expect(o.overview.totals).toMatchObject({ members: 1, creatorsActive: 1, media: 1, views: 5400 })
    expect(o.overview.perInfluencer).toHaveLength(1)
    expect(o.overview.perInfluencer[0]).toMatchObject({ influencerId: fx.instagram, media: 1, views: 5400 })
    expect(o.overview.perInfluencer[0].byPlatform?.TIKTOK).toEqual({ pieces: 1, views: 5400, engagements: 124 })
    // Its own notice, once
    expect(await prisma.notification.count({ where: { title: '@lucia_prueba ha publicado' } })).toBeGreaterThan(0)

    // The next run holds it: nothing new, nothing moves
    net.during.clear()
    const again = await (await checkPosts(new NextRequest('http://localhost/api/cron/check-posts?force=1'))).json()
    expect(again).toMatchObject({ success: true, newPosts: 0 })
    expect((await outcome(fx)).pieces).toEqual(o.pieces)
  }, 60_000)

  it('the manual endpoint: a link of the twin added while the twin is folded is stored in her own row', async () => {
    const fx = await seed()
    net.session = fx.admin
    net.posts.set(VIDEO_URL, {
      externalId: VIDEO_ID, caption: 'Probando la mopa nueva #marcademo', likes: 120, comments: 4, views: 5400, thumbnailUrl: null,
      postedAt: '2026-10-12T10:00:00.000Z', ownerUsername: 'lucia_prueba', mediaType: 'VIDEO', hashtags: ['marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    // The PM picked the TikTok row in the form; the fold commits while the scraper reads the link
    net.during.set(VIDEO_URL, () => foldTwinMembership(fx.twinMembership, { id: fx.admin.id, name: fx.admin.name }))

    const request = new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}/media/manual`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: VIDEO_URL, influencerId: fx.tiktok }),
    })
    const response = await addManual(request, { params: Promise.resolve({ id: fx.campaignId }) })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body).toMatchObject({ created: true, linkedProfile: null })
    expect(body.media).toMatchObject({ influencerId: fx.instagram, publishedByInfluencerId: fx.tiktok, platform: 'TIKTOK' })

    const o = await outcome(fx)
    expect(o.members).toEqual([fx.instagram])
    expect(o.pieces).toEqual([{ externalId: VIDEO_ID, platform: 'TIKTOK', influencerId: fx.instagram, publishedByInfluencerId: fx.tiktok }])
    expectEveryPieceInARow(o)
    expect(o.overview.totals).toMatchObject({ members: 1, creatorsActive: 1, media: 1 })
  })

  it('the manual endpoint: a member removed while the link is read, with no other row of hers, stores nothing and says so', async () => {
    const fx = await seed()
    net.session = fx.admin
    net.posts.set(VIDEO_URL, {
      externalId: VIDEO_ID, caption: null, likes: 120, comments: 4, views: 5400, thumbnailUrl: null,
      postedAt: '2026-10-12T10:00:00.000Z', ownerUsername: 'lucia_prueba', mediaType: 'VIDEO', hashtags: [], mentions: [],
    } satisfies ScrapedSinglePost)
    // Not a fold: a PM removes the TikTok row (the two profiles were never linked)
    net.during.set(VIDEO_URL, () => prisma.campaignInfluencer.delete({ where: { id: fx.twinMembership } }))

    const request = new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}/media/manual`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: VIDEO_URL }),
    })
    const response = await addManual(request, { params: Promise.resolve({ id: fx.campaignId }) })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: '@lucia_prueba ya no está en esta campaña. Recarga la página y vuelve a pegar el enlace.' })
    expect(await prisma.media.count()).toBe(0)
  })
})

describe('upsertCampaignPost writes a piece into a campaign only under a member', () => {
  it('a profile that is not a member: nothing stored', async () => {
    const fx = await seed()
    const outsider = await prisma.influencer.create({ data: { username: 'otra_cuenta', platform: 'TIKTOK' } })
    expect(await upsertCampaignPost(fx.campaignId, outsider.id, 'TIKTOK', video())).toBe(false)
    expect(await prisma.media.count()).toBe(0)
    // A member: stored, as always
    expect(await upsertCampaignPost(fx.campaignId, fx.tiktok, 'TIKTOK', video())).toBe(true)
    expect(await prisma.media.findFirstOrThrow({ where: { externalId: VIDEO_ID } })).toMatchObject({ influencerId: fx.tiktok, campaignId: fx.campaignId, publishedByInfluencerId: null })
  })

  it('an unattached row is not attached under a profile that is not a member', async () => {
    const fx = await seed()
    const outsider = await prisma.influencer.create({ data: { username: 'otra_cuenta', platform: 'TIKTOK' } })
    const loose = await prisma.media.create({
      data: { externalId: VIDEO_ID, platform: 'TIKTOK', mediaType: 'VIDEO', permalink: VIDEO_URL, postedAt: new Date('2026-10-12T10:00:00Z'), source: 'apify', influencerId: outsider.id, campaignId: null },
    })
    expect(await upsertCampaignPost(fx.campaignId, outsider.id, 'TIKTOK', video(), { publishedByInfluencerId: fx.tiktok })).toBe(false)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: loose.id } })).toMatchObject({ campaignId: null, influencerId: outsider.id })
  })

  it('the write waits for a fold holding the twin’s membership, and then stores nothing under it', async () => {
    const fx = await seed()
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      // The fold: the twin's row locked FOR UPDATE, then deleted, then committed
      await client.query('BEGIN')
      await client.query('SELECT id FROM campaign_influencers WHERE id = $1 FOR UPDATE', [fx.twinMembership])
      const pending = upsertCampaignPost(fx.campaignId, fx.tiktok, 'TIKTOK', video())
      // The capture's write is now waiting for the membership
      const deadline = Date.now() + 20_000
      for (;;) {
        await client.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
        )
        if (rows[0].n >= 1) break
        if (Date.now() > deadline) throw new Error('the capture never waited for the membership')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await client.query('DELETE FROM campaign_influencers WHERE id = $1', [fx.twinMembership])
      await client.query('COMMIT')
      expect(await pending).toBe(false)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
    expect(await prisma.media.count()).toBe(0)
  })

  it('a PM editing the member’s row (status, fee) does not hold the capture', async () => {
    const fx = await seed()
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      // The PM's save, not committed yet: an ordinary UPDATE of the membership
      await client.query('BEGIN')
      await client.query('UPDATE campaign_influencers SET "agreedFee" = 250, status = $2 WHERE id = $1', [fx.originalMembership, 'POSTED'])
      const stored = await Promise.race([
        upsertCampaignPost(fx.campaignId, fx.instagram, 'TIKTOK', video(), { publishedByInfluencerId: fx.tiktok }),
        new Promise<'waited'>(resolve => setTimeout(() => resolve('waited'), 5_000)),
      ])
      expect(stored).toBe(true)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }
    expect(await prisma.media.findFirstOrThrow({ where: { externalId: VIDEO_ID } })).toMatchObject({ influencerId: fx.instagram, publishedByInfluencerId: fx.tiktok })
    expect(await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.originalMembership } })).toMatchObject({ agreedFee: 250, status: 'POSTED' })
  })
})
