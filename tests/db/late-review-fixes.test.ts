/**
 * The late rule after the adversarial review (13 Nov 2026). Each test fails
 * on the code before the fix:
 *   - a late add that claims an unattached Meta row is stored as hand-added,
 *     so the next revalidation keeps it;
 *   - a scraped row left after its window (its campaign's end moved earlier)
 *     is not a late piece: it never keeps the post out of the campaign where
 *     it belongs (automatic capture and manual add);
 *   - the same late post added to two campaigns at once is stored in one;
 *   - re-pasting a piece the campaign holds inside its dates with a date after
 *     the end does not turn it into a late piece;
 *   - a Meta story mention of a story counted late elsewhere (another id, the
 *     same creator, the same time) is not filed again.
 * Real (throwaway) database, invented handles, network mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  posts: new Map<string, unknown>(),
  session: null as null | { id: string; email: string; name: string; role: string },
  delayMs: 0,
}))

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => {
      if (net.delayMs) await new Promise(r => setTimeout(r, net.delayMs))
      return net.posts.get(url) ?? null
    }),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => true),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { prisma } from '@/lib/db'
import type { ScrapedPost } from '@/lib/apify'
import { POST as addManual } from '@/app/api/campaigns/[id]/media/manual/route'
import { revalidateCampaignMedia, upsertCampaignPost } from '@/lib/campaign-capture'
import { materializeMetaContent } from '@/lib/meta-materialize'
import { seedOctober, storyIdAt } from './fixtures/october'
import type { OctoberFixture } from './fixtures/october'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.metaStoryMention.deleteMany()
  await prisma.metaMedia.deleteMany()
  await prisma.metaAccountSnapshot.deleteMany()
  await prisma.socialToken.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.user.deleteMany()
}

let fx: OctoberFixture
beforeEach(async () => {
  await reset()
  net.posts.clear()
  net.delayMs = 0
  fx = await seedOctober()
  net.session = fx.pm
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const member = (handle: string) => fx.instagram[handle].id

async function add(body: unknown, campaignId: string = fx.campaignId) {
  const request = new Request(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await addManual(request as any, { params: Promise.resolve({ id: campaignId }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json()) as any }
}

let seq = 0
/** A public Instagram post of `handle` the (mocked) scraper reads */
function igPost(handle: string, postedAt: string) {
  seq++
  const code = `DfFix${String(seq).padStart(6, '0')}`
  const url = `https://www.instagram.com/p/${code}/`
  const externalId = `37633300000${String(seq).padStart(8, '0')}`
  net.posts.set(url, {
    externalId, caption: 'Probando #marcademo', likes: 10, comments: 1, views: 0,
    thumbnailUrl: null, postedAt, ownerUsername: handle, mediaType: 'POST', hashtags: ['#marcademo'], mentions: [],
  })
  return { url, code, externalId }
}

/** An invented campaign where these creators are confirmed members */
async function campaign(name: string, window: { start: string; end: string }, handles: string[], status: 'CONTRACTED' | 'AGREED' = 'CONTRACTED') {
  const c = await prisma.campaign.create({
    data: {
      name, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', startDate: new Date(window.start), endDate: new Date(window.end),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: fx.pm.id,
    },
  })
  for (const h of handles) await prisma.campaignInfluencer.create({ data: { campaignId: c.id, influencerId: member(h), status } })
  return c
}
const NOVEMBER = { start: '2026-11-01T00:00:00Z', end: '2026-11-30T00:00:00Z' }

// ---------------------------------------------------------------------------

describe('a late add that claims an unattached Meta row', () => {
  it('stores it as hand-added (it keeps its Meta figures), so revalidation keeps the late piece', async () => {
    const post = igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z')
    // A Meta Graph row of the post, unattached (another campaign's revalidation left it)
    const loose = await prisma.media.create({
      data: {
        externalId: '17912345678901234', platform: 'INSTAGRAM', mediaType: 'REEL', permalink: `https://www.instagram.com/reel/${post.code}/`,
        caption: 'Probando @marca.demo', mentions: ['marca.demo'], hashtags: [], postedAt: new Date('2026-11-05T10:00:00Z'),
        reach: 4321, impressions: 5000, source: 'meta_api', dataSource: 'api', influencerId: member('creadora_demo_25'), campaignId: null,
      },
    })
    const res = await add({ url: post.url })
    expect(res.status).toBe(201)
    expect(res.body.lateDays).toBe(5)
    expect(res.body.media.id).toBe(loose.id)
    expect(res.body.media.source).toBe('manual')
    expect(res.body.media).toMatchObject({ reach: 4321, impressions: 5000, campaignId: fx.campaignId })

    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 32, detached: 0 })
    expect((await prisma.media.findUniqueOrThrow({ where: { id: loose.id } })).campaignId).toBe(fx.campaignId)
  })

  it('a Meta row claimed INSIDE the window keeps its origin, as before', async () => {
    const post = igPost('creadora_demo_25', '2026-10-20T10:00:00.000Z')
    const loose = await prisma.media.create({
      data: {
        externalId: '17912345678901299', platform: 'INSTAGRAM', mediaType: 'REEL', permalink: `https://www.instagram.com/reel/${post.code}/`,
        caption: 'Probando @marca.demo', mentions: ['marca.demo'], hashtags: [], postedAt: new Date('2026-10-20T10:00:00Z'),
        source: 'meta_api', dataSource: 'api', influencerId: member('creadora_demo_25'), campaignId: null,
      },
    })
    const res = await add({ url: post.url })
    expect(res.status).toBe(201)
    expect(res.body.lateDays).toBeNull()
    expect((await prisma.media.findUniqueOrThrow({ where: { id: loose.id } })).source).toBe('meta_api')
  })
})

describe('a scraped row left after its window is not a late piece', () => {
  it('it does not keep the post out of November, neither from the automatic capture nor from a manual add', async () => {
    // October still ran to 15 Nov when the post was scraped into it...
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { endDate: new Date('2026-11-15T00:00:00Z') } })
    const code = 'DfStale000001'
    const scraped: ScrapedPost = {
      externalId: '3761999000000000001', caption: 'Probando #marcademo', mediaUrl: null, thumbnailUrl: null,
      permalink: `https://instagram.com/p/${code}`, mediaType: 'REEL', likes: 5, comments: 1, shares: 0, saves: 0, views: 100,
      postedAt: '2026-11-05T10:00:00.000Z', hashtags: ['#marcademo'], mentions: [],
    }
    expect(await upsertCampaignPost(fx.campaignId, member('creadora_demo_02'), 'INSTAGRAM', scraped)).toBe(true)
    // ...then the PM corrected its end to 31 Oct (no revalidation runs on a date edit)
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { endDate: new Date('2026-10-31T00:00:00Z') } })

    const nov = await campaign('11.- Marca Demo - Micros Noviembre (test)', NOVEMBER, ['creadora_demo_02'])
    expect(await upsertCampaignPost(nov.id, member('creadora_demo_02'), 'INSTAGRAM', scraped)).toBe(true)
    expect(await prisma.media.count({ where: { campaignId: nov.id } })).toBe(1)

    // The same for the manual add of another such post
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { endDate: new Date('2026-11-15T00:00:00Z') } })
    const other = igPost('creadora_demo_02', '2026-11-06T10:00:00.000Z')
    expect(await upsertCampaignPost(fx.campaignId, member('creadora_demo_02'), 'INSTAGRAM', { ...scraped, externalId: other.externalId, permalink: other.url, postedAt: '2026-11-06T10:00:00.000Z' })).toBe(true)
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { endDate: new Date('2026-10-31T00:00:00Z') } })
    const res = await add({ url: other.url }, nov.id)
    expect(res.status).toBe(201)
    expect(res.body.lateDays).toBeNull()
  })
})

describe('one campaign only, at the same time', () => {
  it('the same late post added at once to two campaigns where she owes a piece is stored in ONE of them', async () => {
    // A second ACTIVE campaign that ended 25 Oct, where she is CONTRACTED too
    const other = await campaign('Otra campaña (test)', { start: '2026-10-01T00:00:00Z', end: '2026-10-25T00:00:00Z' }, ['creadora_demo_27'])
    for (let i = 0; i < 6; i++) {
      const p = igPost('creadora_demo_27', '2026-11-05T10:00:00.000Z')
      net.delayMs = 30
      const [r1, r2] = await Promise.all([add({ url: p.url }), add({ url: p.url }, other.id)])
      const rows = await prisma.media.count({ where: { permalink: { contains: `/${p.code}` }, campaignId: { not: null } } })
      expect(rows, `run ${i}`).toBe(1)
      expect([r1.status, r2.status].sort(), `run ${i}`).toEqual([201, 409])
      expect([r1.body.code, r2.body.code]).toContain('counted_elsewhere')
      // Free her again for the next run
      await prisma.media.deleteMany({ where: { permalink: { contains: `/${p.code}` } } })
    }
  })

  it('an add inside November\'s window racing a late add of the same post to October: one of them', async () => {
    const nov = await campaign('11.- Marca Demo - Micros Noviembre (test)', NOVEMBER, ['creadora_demo_26'])
    for (let i = 0; i < 4; i++) {
      const p = igPost('creadora_demo_26', '2026-11-05T10:00:00.000Z')
      net.delayMs = 30
      const [late, inWindow] = await Promise.all([add({ url: p.url }), add({ url: p.url }, nov.id)])
      const rows = await prisma.media.count({ where: { permalink: { contains: `/${p.code}` }, campaignId: { not: null } } })
      expect(rows, `run ${i}`).toBe(1)
      expect([late.status, inWindow.status].sort(), `run ${i}`).toEqual([201, 409])
      await prisma.media.deleteMany({ where: { permalink: { contains: `/${p.code}` } } })
    }
  })
})

describe('re-pasting a piece the campaign already holds', () => {
  it('a date after the end does not turn a piece inside the dates into a late one: refused as before, the row unchanged', async () => {
    const code = 'DfRefresh0001'
    const row = await prisma.media.create({
      data: {
        externalId: code, platform: 'INSTAGRAM', mediaType: 'POST', permalink: `https://www.instagram.com/p/${code}/`,
        caption: 'Probando #marcademo', hashtags: ['#marcademo'], mentions: [], postedAt: new Date('2026-10-20T10:00:00Z'),
        source: 'apify', influencerId: member('creadora_demo_01'), campaignId: fx.campaignId,
      },
    })
    // The scraper cannot read it this time; the PM (or the connector) types a date after the end
    const res = await add({ url: `https://www.instagram.com/p/${code}/`, influencerId: member('creadora_demo_01'), postedAt: '2026-11-05T10:00:00.000Z' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('El contenido se publicó el 2026-11-05, fuera del periodo de la campaña (2026-10-01 – 2026-10-31).')
    const after = await prisma.media.findUniqueOrThrow({ where: { id: row.id } })
    expect(after.postedAt?.toISOString()).toBe('2026-10-20T10:00:00.000Z')
    expect(after.source).toBe('apify')
  })
})

describe('a story counted late elsewhere, reaching another campaign under another id', () => {
  it('a Meta story mention of the same creator at the same time is not filed in November', async () => {
    const at = '2026-11-03T09:00:00.000Z'
    // October holds her 5-November story late, registered from its link (the id of the link)
    await prisma.media.create({
      data: {
        externalId: storyIdAt(at, 3), platform: 'INSTAGRAM', mediaType: 'STORY', permalink: `https://www.instagram.com/stories/creadora_demo_25/${storyIdAt(at, 3)}/`,
        hashtags: [], mentions: ['marca.demo'], postedAt: new Date(at), source: 'manual', dataSource: 'manual',
        influencerId: member('creadora_demo_25'), campaignId: fx.campaignId,
      },
    })
    const nov = await campaign('11.- Marca Demo - Micros Noviembre (test)', NOVEMBER, ['creadora_demo_25'], 'AGREED')
    const token = await prisma.socialToken.create({ data: { platform: 'INSTAGRAM', tokenType: 'brand', accessToken: 'token-de-prueba', isValid: true } })
    await prisma.metaAccountSnapshot.create({ data: { socialTokenId: token.id, igUsername: 'marca.demo', followersCount: 1, followsCount: 1, mediaCount: 1 } })
    // The webhook's mention of the same story (a Graph id), two minutes off; and another story of hers a day later
    await prisma.metaStoryMention.create({ data: { socialTokenId: token.id, mentionMediaId: '17999000000000001', mentionUsername: 'creadora_demo_25', mentionedAt: new Date('2026-11-03T09:02:00Z') } })
    await prisma.metaStoryMention.create({ data: { socialTokenId: token.id, mentionMediaId: '17999000000000002', mentionUsername: 'creadora_demo_25', mentionedAt: new Date('2026-11-04T18:00:00Z') } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await materializeMetaContent(nov.id)).toEqual({ created: 1, updated: 0, skippedLateElsewhere: 1 })
    } finally {
      warn.mockRestore()
    }
    expect((await prisma.media.findMany({ where: { campaignId: nov.id }, select: { externalId: true } })).map(m => m.externalId)).toEqual(['17999000000000002'])
  })
})
