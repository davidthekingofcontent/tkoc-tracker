/**
 * Late pieces («fuera de plazo») through the two manual paths:
 * POST /api/campaigns/[id]/media/manual («Añadir publicación por URL») and
 * POST /api/campaigns/[id]/stories («Registrar Story»).
 *
 * The route handlers are called directly on a real (throwaway) database with
 * the October-like campaign of fixtures/october.ts (invented handles; four
 * members are still CONTRACTED and have published nothing, like @masqueropa
 * in the real case). The network is mocked: the scraper answers from a table,
 * the session is whatever the test says, `fetch` is a stub.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  apifyConfigured: true,
  posts: new Map<string, unknown>(),
  session: null as null | { id: string; email: string; name: string; role: string },
}))

// No test may reach a scraper.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => net.posts.get(url) ?? null),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => net.apifyConfigured),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})

// The session is the test's; the role rule (isStaffRole) is the real one.
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedSinglePost } from '@/lib/apify'
import { POST as addManual } from '@/app/api/campaigns/[id]/media/manual/route'
import { POST as addStory } from '@/app/api/campaigns/[id]/stories/route'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { seedOctober, storyIdAt, tiktokIdAt } from './fixtures/october'
import type { OctoberFixture } from './fixtures/october'

const fetchStub = vi.fn()
vi.stubGlobal('fetch', fetchStub)

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

let fx: OctoberFixture

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  fetchStub.mockImplementation(async () => { throw new Error('fetch: the network is mocked in tests') })
  net.apifyConfigured = true
  net.posts.clear()
  fx = await seedOctober()
  net.session = fx.pm
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

async function add(body: unknown, campaignId: string = fx.campaignId): Promise<Answer> {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await addManual(request, { params: Promise.resolve({ id: campaignId }) })
  return { status: response.status, body: await response.json() }
}

async function story(body: Record<string, unknown>, campaignId: string = fx.campaignId): Promise<Answer> {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await addStory(request, { params: Promise.resolve({ id: campaignId }) })
  return { status: response.status, body: await response.json() }
}

let seq = 0
/** An Instagram post of `handle` the (mocked) network can read: a /p/ link, its shortcode and its numeric id */
function igPost(handle: string, postedAt: string, figures: Partial<ScrapedSinglePost> = {}) {
  seq++
  const code = `DfLate${String(seq).padStart(5, '0')}`
  const url = `https://www.instagram.com/p/${code}/`
  const scraped: ScrapedSinglePost = {
    externalId: `37600000000${String(seq).padStart(8, '0')}`, caption: 'Probando la fregona nueva #marcademo', likes: 120, comments: 8, views: 0,
    thumbnailUrl: null, postedAt, ownerUsername: handle, mediaType: 'POST', hashtags: ['#marcademo'], mentions: [], ...figures,
  }
  net.posts.set(url, scraped)
  return { url, code, scraped }
}

/** A TikTok video of `handle` the network can read */
function tiktokVideo(handle: string, postedAt: string, low: number) {
  const id = tiktokIdAt(postedAt, low)
  const url = `https://www.tiktok.com/@${handle}/video/${id}`
  net.posts.set(url, {
    externalId: id, caption: 'Vídeo de prueba #marcademo', likes: 50, comments: 2, views: 900, thumbnailUrl: null,
    postedAt, ownerUsername: handle, mediaType: 'VIDEO', hashtags: ['#marcademo'], mentions: [],
  } satisfies ScrapedSinglePost)
  return { id, url }
}

const member = (handle: string) => fx.instagram[handle].id
const piecesOf = (handle: string, campaignId = fx.campaignId) => prisma.media.count({ where: { campaignId, influencerId: member(handle) } })

/** Everything a refused request must leave untouched */
async function state() {
  const [media, persons, logs, linked, influencers] = await Promise.all([
    prisma.media.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.influencer.count({ where: { personId: { not: null } } }),
    prisma.influencer.count(),
  ])
  return { media, persons, logs, linked, influencers }
}

/** A November campaign (invented) where `handle` is also a member */
async function november(handles: string[]) {
  const campaign = await prisma.campaign.create({
    data: {
      name: '11.- Marca Demo - Micros Noviembre (test)', status: 'ACTIVE', type: 'INFLUENCER_TRACKING',
      startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-30T00:00:00Z'),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: fx.pm.id,
    },
  })
  for (const h of handles) await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: member(h), status: 'PROSPECT' } })
  return campaign
}

// ---------------------------------------------------------------------------

describe('«Añadir publicación por URL» after the end of the campaign', () => {
  it('a CONTRACTED member with no number of deliverables, 5 Nov: stored in October, 5 days late', async () => {
    const post = igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z')
    const res = await add({ url: post.url })
    expect(res.status).toBe(201)
    expect(res.body.lateDays).toBe(5)
    expect(res.body.created).toBe(true)
    expect(res.body.media).toMatchObject({ campaignId: fx.campaignId, influencerId: member('creadora_demo_25'), source: 'manual', postedAt: '2026-11-05T10:00:00.000Z' })

    const o = await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES })
    expect(o!.totals.media).toBe(32)
    expect(o!.perMedia.find(m => m.id === res.body.media.id)!.lateDays).toBe(5)
    expect(o!.perInfluencer.find(p => p.influencerId === member('creadora_demo_25'))).toMatchObject({ media: 1, latePieces: 1, maxLateDays: 5 })
  })

  it('a second late piece for the creator who owed one is refused: nothing pending, nothing stored', async () => {
    expect((await add({ url: igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z').url })).status).toBe(201)
    const before = await state()
    const second = await add({ url: igPost('creadora_demo_25', '2026-11-06T10:00:00.000Z').url })
    expect(second).toEqual({
      status: 400,
      body: {
        code: 'nothing_pending',
        error: '@creadora_demo_25 ya tiene una publicación en esta campaña y no tiene un número de entregables: no le queda nada por entregar. Si le falta otra, pon sus entregables.',
        postedAt: '2026-11-06T10:00:00.000Z',
        lateDays: 6,
      },
    })
    expect(await state()).toEqual(before)
  })

  it('a COMPLETED member owes nothing: 400 nothing_pending, with the sentence that says how to fix it', async () => {
    const before = await state()
    const res = await add({ url: igPost('creadora_demo_01', '2026-11-05T10:00:00.000Z').url })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      code: 'nothing_pending',
      error: '@creadora_demo_01 está en Completado: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.',
      lateDays: 5,
    })
    expect(await state()).toEqual(before)
  })

  it('with a number of deliverables she may add late pieces up to it, not one more', async () => {
    await prisma.campaignInfluencer.update({ where: { campaignId_influencerId: { campaignId: fx.campaignId, influencerId: member('creadora_demo_25') } }, data: { deliverablesPlanned: 2 } })
    expect((await add({ url: igPost('creadora_demo_25', '2026-11-02T10:00:00.000Z').url })).body.lateDays).toBe(2)
    expect((await add({ url: igPost('creadora_demo_25', '2026-11-03T10:00:00.000Z').url })).body.lateDays).toBe(3)
    const third = await add({ url: igPost('creadora_demo_25', '2026-11-04T10:00:00.000Z').url })
    expect(third.status).toBe(400)
    expect(third.body.error).toBe('@creadora_demo_25 ya ha entregado 2 de 2: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
    expect(await piecesOf('creadora_demo_25')).toBe(2)
  })

  it('more than 30 days after the end: 400 too_late with the days', async () => {
    // A campaign that ended on 5 Oct: 5 Nov is 31 days late
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { endDate: new Date('2026-10-05T00:00:00Z') } })
    const before = await state()
    const res = await add({ url: igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z').url })
    expect(res).toEqual({
      status: 400,
      body: {
        code: 'too_late',
        error: 'Se publicó 31 días después del fin de la campaña; el máximo para contarla fuera de plazo son 30.',
        postedAt: '2026-11-05T10:00:00.000Z',
        lateDays: 31,
      },
    })
    expect(await state()).toEqual(before)
  })

  it('before the start: refused exactly as before the late rule', async () => {
    const res = await add({ url: igPost('creadora_demo_25', '2026-09-28T10:00:00.000Z').url })
    expect(res).toEqual({
      status: 400,
      body: { error: 'El contenido se publicó el 2026-09-28, fuera del periodo de la campaña (2026-10-01 – 2026-10-31).', postedAt: '2026-09-28T10:00:00.000Z' },
    })
  })

  it('inside the window nothing changes: 201, not late, also for a COMPLETED member', async () => {
    const res = await add({ url: igPost('creadora_demo_01', '2026-10-31T23:59:59.000Z').url })
    expect(res.status).toBe(201)
    expect(res.body.lateDays).toBeNull()
    expect(res.body.media.postedAt).toBe('2026-10-31T23:59:59.000Z')
  })

  it('a paused campaign takes no late piece', async () => {
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { status: 'PAUSED' } })
    const res = await add({ url: igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z').url })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'campaign_not_active', lateDays: 5 })
    expect(res.body.error).toContain('está en pausa')
    expect(await piecesOf('creadora_demo_25')).toBe(0)
  })

  it('a Social Listening campaign keeps the strict window', async () => {
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { type: 'SOCIAL_LISTENING' } })
    const res = await add({ url: igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z').url })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('not_collaboration')
    expect(res.body.error).toContain('El contenido se publicó el 2026-11-05, fuera del periodo de la campaña (2026-10-01 – 2026-10-31).')
    expect(await piecesOf('creadora_demo_25')).toBe(0)
  })

  it('a post that already has a row in another campaign: 409 counted_elsewhere, by its id or by its shortcode', async () => {
    const nov = await november(['creadora_demo_26'])
    const post = igPost('creadora_demo_26', '2026-11-05T10:00:00.000Z')
    // November captured it with the scraper's numeric id and the link
    await prisma.media.create({
      data: {
        externalId: post.scraped.externalId, platform: 'INSTAGRAM', mediaType: 'POST', permalink: `https://www.instagram.com/p/${post.code}/`,
        postedAt: new Date('2026-11-05T10:00:00Z'), source: 'apify', hashtags: ['#marcademo'], influencerId: member('creadora_demo_26'), campaignId: nov.id,
      },
    })
    const expected = {
      status: 409,
      body: {
        code: 'counted_elsewhere',
        error: 'Esta publicación ya cuenta en «11.- Marca Demo - Micros Noviembre (test)». Una publicación fuera de plazo solo cuenta en una campaña.',
        campaign: { id: nov.id, name: '11.- Marca Demo - Micros Noviembre (test)' },
      },
    }
    expect(await add({ url: post.url })).toEqual(expected)
    // Without the scraper the link only gives the shortcode: the same post all the same
    net.apifyConfigured = false
    expect(await add({ url: post.url, influencerId: member('creadora_demo_26'), postedAt: '2026-11-05T10:00:00.000Z' })).toEqual(expected)
    expect(await piecesOf('creadora_demo_26')).toBe(0)
  })

  it('the other way round: once a post counts late in October, adding it inside November is refused too', async () => {
    const nov = await november(['creadora_demo_25'])
    const post = igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z')
    expect((await add({ url: post.url })).body.lateDays).toBe(5)
    const res = await add({ url: post.url }, nov.id)
    expect(res).toEqual({
      status: 409,
      body: {
        code: 'counted_elsewhere',
        error: 'Esta publicación ya cuenta fuera de plazo en «10.- Marca Demo - Micros Octubre (test)». Una publicación fuera de plazo solo cuenta en una campaña.',
        campaign: { id: fx.campaignId, name: '10.- Marca Demo - Micros Octubre (test)' },
      },
    })
    expect(await piecesOf('creadora_demo_25', nov.id)).toBe(0)
    // A post that counts in October INSIDE its dates is no obstacle: it counts in every campaign whose rules it satisfies
    const inside = igPost('creadora_demo_25', '2026-10-30T10:00:00.000Z')
    expect((await add({ url: inside.url })).status).toBe(201)
    await prisma.campaign.update({ where: { id: nov.id }, data: { startDate: new Date('2026-10-25T00:00:00Z') } })
    expect((await add({ url: inside.url }, nov.id)).status).toBe(201)
  })

  it('two late adds at once for a creator who owes one: one is stored, the other is refused', async () => {
    const a = igPost('creadora_demo_27', '2026-11-06T10:00:00.000Z')
    const b = igPost('creadora_demo_27', '2026-11-07T10:00:00.000Z')
    // Each insert into media takes 400 ms inside its transaction: the first
    // piece is written but not committed while the other request reads what
    // she has delivered. Only the exclusive membership lock makes it wait.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION late_test_slow_insert() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER late_test_slow_insert AFTER INSERT ON media FOR EACH ROW EXECUTE FUNCTION late_test_slow_insert()`)
    try {
      const answers = await Promise.all([add({ url: a.url }), add({ url: b.url })])
      expect(answers.map(r => r.status).sort()).toEqual([201, 400])
      expect(answers.find(r => r.status === 400)!.body.code).toBe('nothing_pending')
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS late_test_slow_insert ON media')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS late_test_slow_insert()')
    }
    expect(await piecesOf('creadora_demo_27')).toBe(1)
  })

  it('pasting the same late link again refreshes her piece: 200, still late, nothing counted twice', async () => {
    const post = igPost('creadora_demo_25', '2026-11-05T10:00:00.000Z')
    expect((await add({ url: post.url })).status).toBe(201)
    net.posts.set(post.url, { ...post.scraped, likes: 300 })
    const again = await add({ url: post.url })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, lateDays: 5 })
    expect(again.body.media.likes).toBe(300)
    expect(await piecesOf('creadora_demo_25')).toBe(1)
  })

  it('from another profile of hers: asked whose profile it is, then stored late once she says so', async () => {
    const video = tiktokVideo('demo28_en_tiktok', '2026-11-04T18:00:00.000Z', 61)
    const question = await add({ url: video.url })
    expect(question.status).toBe(409)
    expect(question.body.code).toBe('profile_not_linked')
    const answer = await add({ url: video.url, linkProfileTo: member('creadora_demo_28') })
    expect(answer.status).toBe(201)
    expect(answer.body.lateDays).toBe(4)
    expect(answer.body.linkedProfile).toMatchObject({ handle: 'demo28_en_tiktok', platform: 'TIKTOK', memberUsername: 'creadora_demo_28' })
    expect(answer.body.media).toMatchObject({ influencerId: member('creadora_demo_28'), platform: 'TIKTOK' })
  })

  it('when she owes nothing the answer comes BEFORE anything is linked: no profile, no person, no log', async () => {
    const video = tiktokVideo('alba_prueba', '2026-11-04T18:00:00.000Z', 62)
    const before = await state()
    const res = await add({ url: video.url, linkProfileTo: member('alba_prueba') })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('nothing_pending')
    expect(await state()).toEqual(before)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: fx.tiktokOutside['alba_prueba'].id } })).personId).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('«Registrar Story» after the end of the campaign', () => {
  const link = (handle: string, iso: string, low: number) => `https://www.instagram.com/stories/${handle}/${storyIdAt(iso, low)}/`

  it('a story of a member who owes one, dated by its link 3 Nov: stored, 3 days late', async () => {
    const res = await story({ influencerId: member('creadora_demo_27'), permalink: link('creadora_demo_27', '2026-11-03T09:00:00.000Z', 7), views: 800 })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ updated: false, lateDays: 3 })
    expect(res.body.story).toMatchObject({ campaignId: fx.campaignId, mediaType: 'STORY', source: 'manual' })
  })

  it('a second late story for the creator who owed one is refused', async () => {
    expect((await story({ influencerId: member('creadora_demo_27'), postedAt: '2026-11-03T09:00:00.000Z' })).status).toBe(201)
    const res = await story({ influencerId: member('creadora_demo_27'), postedAt: '2026-11-03T09:30:00.000Z' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'nothing_pending', lateDays: 3 })
    expect(await piecesOf('creadora_demo_27')).toBe(1)
  })

  it('two late stories at once for a creator who owes one: one is stored', async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION late_test_slow_insert() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER late_test_slow_insert AFTER INSERT ON media FOR EACH ROW EXECUTE FUNCTION late_test_slow_insert()`)
    try {
      const answers = await Promise.all([
        story({ influencerId: member('creadora_demo_26'), postedAt: '2026-11-03T09:00:00.000Z', views: 10 }),
        story({ influencerId: member('creadora_demo_26'), postedAt: '2026-11-03T09:05:00.000Z', views: 20 }),
      ])
      expect(answers.map(r => r.status).sort()).toEqual([201, 400])
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS late_test_slow_insert ON media')
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS late_test_slow_insert()')
    }
    expect(await piecesOf('creadora_demo_26')).toBe(1)
  })

  it('a COMPLETED creator owes nothing', async () => {
    const res = await story({ influencerId: member('creadora_demo_01'), postedAt: '2026-11-03T09:00:00.000Z', views: 500 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('@creadora_demo_01 está en Completado: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
  })

  it('more than 30 days late, with its own wording', async () => {
    const res = await story({ influencerId: member('creadora_demo_27'), postedAt: '2026-12-05T09:00:00.000Z' })
    expect(res).toEqual({
      status: 400,
      body: {
        code: 'too_late',
        error: 'La story se publicó 35 días después del fin de la campaña; el máximo para contarla fuera de plazo son 30.',
        postedAt: '2026-12-05T09:00:00.000Z',
        lateDays: 35,
      },
    })
  })

  it('without a date once the campaign has ended, and before the start: refused as before', async () => {
    expect(await story({ influencerId: member('creadora_demo_27'), views: 10 })).toMatchObject({
      status: 400,
      body: { error: 'La campaña ya terminó (2026-10-01 – 2026-10-31): indica la fecha de publicación de la story.', needsPostedAt: true },
    })
    const early = await story({ influencerId: member('creadora_demo_27'), permalink: link('creadora_demo_27', '2026-09-28T09:00:00.000Z', 8) })
    expect(early).toEqual({
      status: 400,
      body: {
        error: 'La story se publicó el 2026-09-28 (según el enlace), fuera del periodo de la campaña (2026-10-01 – 2026-10-31).',
        needsPostedAt: false,
        postedAt: '2026-09-28T09:00:00.000Z',
      },
    })
    expect(await piecesOf('creadora_demo_27')).toBe(0)
  })

  it('the same story already in another campaign: 409 counted_elsewhere', async () => {
    const nov = await november(['creadora_demo_27'])
    const url = link('creadora_demo_27', '2026-11-03T09:00:00.000Z', 9)
    const id = url.split('/').filter(Boolean).pop()!
    await prisma.media.create({
      data: { externalId: id, platform: 'INSTAGRAM', mediaType: 'STORY', postedAt: new Date('2026-11-03T09:00:00Z'), source: 'apify', influencerId: member('creadora_demo_27'), campaignId: nov.id },
    })
    const res = await story({ influencerId: member('creadora_demo_27'), permalink: url })
    expect(res).toEqual({
      status: 409,
      body: {
        code: 'counted_elsewhere',
        error: 'Esta story ya cuenta en «11.- Marca Demo - Micros Noviembre (test)». Una story fuera de plazo solo cuenta en una campaña.',
        campaign: { id: nov.id, name: '11.- Marca Demo - Micros Noviembre (test)' },
      },
    })
  })

  it('a story that counts late in October is refused inside November', async () => {
    const nov = await november(['creadora_demo_27'])
    const url = link('creadora_demo_27', '2026-11-03T09:00:00.000Z', 11)
    expect((await story({ influencerId: member('creadora_demo_27'), permalink: url })).body.lateDays).toBe(3)
    const res = await story({ influencerId: member('creadora_demo_27'), permalink: url }, nov.id)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'counted_elsewhere',
      error: 'Esta story ya cuenta fuera de plazo en «10.- Marca Demo - Micros Octubre (test)». Una story fuera de plazo solo cuenta en una campaña.',
    })
    expect(await piecesOf('creadora_demo_27', nov.id)).toBe(0)
  })

  it('inside the window nothing changes, and the route is for the agency team only', async () => {
    const ok = await story({ influencerId: member('creadora_demo_01'), postedAt: '2026-10-20T09:00:00.000Z', views: 100 })
    expect(ok.status).toBe(201)
    expect(ok.body.lateDays).toBeNull()
    for (const role of ['BRAND', 'CREATOR']) {
      net.session = { ...fx.pm, role }
      expect((await story({ influencerId: member('creadora_demo_27'), postedAt: '2026-11-03T09:00:00.000Z' })).status, role).toBe(403)
    }
    net.session = null
    expect((await story({ influencerId: member('creadora_demo_27'), postedAt: '2026-11-03T09:00:00.000Z' })).status).toBe(401)
    expect(await piecesOf('creadora_demo_27')).toBe(0)
  })
})
