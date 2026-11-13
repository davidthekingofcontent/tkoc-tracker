/**
 * POST /api/campaigns/[id]/media/manual — «Añadir publicación por URL» when a
 * creator is a person with several profiles.
 *
 * The route handler is called directly, on a real (throwaway) database with an
 * October-like campaign (fixtures/october.ts: invented handles and figures).
 * The network is replaced: the scraper answers from a table, the session is
 * whatever the test says, and `fetch` (short links) is a stub.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  /** Is there an Apify token? false = the scraper is never asked */
  apifyConfigured: true,
  apifyExhausted: false,
  /** What the network answers for each clean link; a link that is not here cannot be read */
  posts: new Map<string, unknown>(),
  session: null as null | { id: string; email: string; name: string; role: string },
}))

// No test may reach a scraper.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => net.posts.get(url) ?? null),
    isApifyExhausted: vi.fn(() => net.apifyExhausted),
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
import { scrapeSinglePost } from '@/lib/apify'
import type { ScrapedSinglePost } from '@/lib/apify'
import { POST } from '@/app/api/campaigns/[id]/media/manual/route'
import { GET as getCampaign } from '@/app/api/campaigns/[id]/route'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { revalidateCampaignMedia } from '@/lib/campaign-capture'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { linkProfile } from '@/lib/person-profiles'
import {
  REAL_INSTAGRAM_OF_RISAS,
  SEVEN_LINKS,
  SEVEN_TOTALS,
  SIX,
  TWICE,
  seedOctober,
  storyIdAt,
  tiktokIdAt,
} from './fixtures/october'
import type { OctoberFixture, SevenLink } from './fixtures/october'

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
  net.apifyExhausted = false
  net.posts.clear()
  for (const link of SEVEN_LINKS) net.posts.set(link.canonicalUrl, link.scraped)
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

/** Calls the route handler the way Next.js does. */
async function add(body: unknown, campaignId: string = fx.campaignId): Promise<Answer> {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: campaignId }) })
  return { status: response.status, body: await response.json() }
}

/** Everything a refused request must leave untouched. */
async function state() {
  const [memberships, influencers, persons, logs, media, linkedProfiles] = await Promise.all([
    prisma.campaignInfluencer.findMany({ select: { id: true, campaignId: true, influencerId: true }, orderBy: { id: 'asc' } }),
    prisma.influencer.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.media.count(),
    prisma.influencer.count({ where: { personId: { not: null } } }),
  ])
  return { memberships, influencers, persons, logs, media, linkedProfiles }
}

function memberOf(link: SevenLink) {
  return fx.instagram[link.memberHandle]
}

/** The two steps of the UI: the question (409), then the same request with the PM's answer. */
async function addWithAnswer(link: SevenLink): Promise<Answer> {
  const question = await add({ url: link.url })
  expect(question.status).toBe(409)
  expect(question.body.code).toBe('profile_not_linked')
  const answer = await add({ url: link.url, influencerId: memberOf(link).id, linkProfileTo: memberOf(link).id })
  expect(answer.status).toBe(201)
  return answer
}

function unreadable(url: string): void {
  net.posts.delete(url)
}

/** A TikTok video of `handle` that the network can read. */
function tiktokVideo(handle: string, postedAt: string, low: number, figures: Partial<ScrapedSinglePost> = {}) {
  const id = tiktokIdAt(postedAt, low)
  const url = `https://www.tiktok.com/@${handle}/video/${id}`
  const scraped: ScrapedSinglePost = {
    externalId: id, caption: 'Vídeo de prueba #marcademo', likes: 50, comments: 2, views: 900, thumbnailUrl: null,
    postedAt, ownerUsername: handle, mediaType: 'VIDEO', hashtags: ['#marcademo'], mentions: [], ...figures,
  }
  net.posts.set(url, scraped)
  return { id, url, scraped }
}

// ---------------------------------------------------------------------------

describe('the seven links of October', () => {
  it('starts as the real case: 36 memberships, one handle twice, six TikTok accounts outside', async () => {
    const memberships = await prisma.campaignInfluencer.findMany({
      where: { campaignId: fx.campaignId },
      select: { status: true, influencer: { select: { username: true, platform: true } } },
    })
    expect(memberships).toHaveLength(36)
    expect(memberships.filter(m => m.influencer.platform === 'INSTAGRAM')).toHaveLength(35)
    expect(memberships.filter(m => m.influencer.platform === 'TIKTOK').map(m => m.influencer.username)).toEqual([TWICE])
    expect(memberships.filter(m => m.influencer.username === TWICE)).toHaveLength(2)
    expect(memberships.filter(m => m.status === 'CONTRACTED')).toHaveLength(4)
    for (const c of SIX) {
      const outside = await prisma.influencer.findUniqueOrThrow({
        where: { username_platform: { username: c.handle, platform: 'TIKTOK' } },
        select: { personId: true, _count: { select: { campaigns: true } } },
      })
      expect(outside).toEqual({ personId: null, _count: { campaigns: 0 } })
    }
    expect(await prisma.influencer.count({ where: { username: REAL_INSTAGRAM_OF_RISAS } })).toBe(0)
    expect(await prisma.media.count({ where: { campaignId: fx.campaignId } })).toBe(31)
  })

  it('each link is answered 409 profile_not_linked, with the author and who she may be, and nothing is created', async () => {
    const before = await state()

    for (const link of SEVEN_LINKS) {
      const res = await add({ url: link.url })
      expect(res.status, link.url).toBe(409)
      expect(res.body.code).toBe('profile_not_linked')
      expect(res.body.author).toEqual({ handle: link.author, platform: link.platform, verified: true })
      expect(res.body.error).toBe(
        `Este contenido es de @${link.author} en ${link.platform === 'TIKTOK' ? 'TikTok' : 'Instagram'}, que no está registrado como perfil de ninguna creadora de esta campaña.`
      )
      expect(res.body.suggestions).toEqual(
        link.expectedReason
          ? [{ influencerId: memberOf(link).id, username: link.memberHandle, platform: 'INSTAGRAM', reason: link.expectedReason }]
          : []
      )
    }

    expect(await state()).toEqual(before)
  })

  it('each link is stored once the PM says whose profile it is: under the member, with the profile that published it, and no member is created', async () => {
    const before = await state()
    const mediaIds: string[] = []

    for (const link of SEVEN_LINKS) {
      const res = await addWithAnswer(link)
      const member = memberOf(link)

      expect(res.body.created).toBe(true)
      expect(res.body.enriched).toBe(true)
      expect(res.body.isStory).toBe(false)
      expect(res.body.linkedProfile).toEqual({ handle: link.author, platform: link.platform, memberUsername: link.memberHandle })

      const row = await prisma.media.findUniqueOrThrow({
        where: { id: res.body.media.id },
        include: { publishedBy: { select: { id: true, username: true, platform: true, personId: true } }, influencer: { select: { personId: true } } },
      })
      mediaIds.push(row.id)
      // Credited to the Instagram MEMBER…
      expect(row.influencerId).toBe(member.id)
      expect(row.campaignId).toBe(fx.campaignId)
      // …published by the other profile, on the publication's network
      expect(row.platform).toBe(link.platform)
      expect(row.publishedBy?.username).toBe(link.author)
      expect(row.publishedBy?.platform).toBe(link.platform)
      expect(row.publishedByInfluencerId).not.toBe(member.id)
      expect(row.publishedBy?.personId).toBeTruthy()
      expect(row.publishedBy?.personId).toBe(row.influencer.personId)
      expect(row.externalId).toBe(link.scraped.externalId)
      expect(row.views).toBe(link.scraped.views)
      expect(row.likes).toBe(link.scraped.likes)
      expect(row.comments).toBe(link.scraped.comments)
      expect(row.postedAt?.toISOString()).toBe(link.postedAt)
      expect(row.source).toBe('manual')
      expect(res.body.media.publishedBy).toEqual({ id: row.publishedByInfluencerId, username: link.author, platform: link.platform })
    }

    const after = await state()
    // 36 memberships before and after, the very same rows: nobody joined the campaign
    expect(after.memberships).toHaveLength(36)
    expect(after.memberships).toEqual(before.memberships)
    expect(await prisma.campaignInfluencer.count({ where: { influencer: { publishedMedia: { some: {} } } } })).toBe(0)
    // Seven new pieces
    expect(after.media).toBe(before.media + 7)
    expect(new Set(mediaIds).size).toBe(7)
    // The six TikTok rows already existed: the only new profile is the real Instagram of @risasdeprueba
    expect(after.influencers).toBe(before.influencers + 1)
    const created = await prisma.influencer.findUniqueOrThrow({ where: { username_platform: { username: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM' } } })
    expect(created.addedById).toBe(fx.pm.id)
    expect(created.addedByName).toBe('Laura PM')
    expect(await prisma.campaignInfluencer.count({ where: { influencerId: created.id } })).toBe(0)
    // One person per creator; the one with the wrong handle now has three profiles
    expect(after.persons).toBe(6)
    const risas = await prisma.influencer.findUniqueOrThrow({ where: { id: fx.instagram['risasdeprueba'].id }, select: { personId: true } })
    const hers = await prisma.influencer.findMany({ where: { personId: risas.personId }, select: { username: true, platform: true }, orderBy: [{ platform: 'asc' }, { username: 'asc' }] })
    expect(hers).toEqual([
      { username: 'risasdeprueba', platform: 'INSTAGRAM' },
      { username: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM' },
      { username: 'risasdeprueba', platform: 'TIKTOK' },
    ])
    // Seven links, each logged with who confirmed it and how the author was known
    const logs = await prisma.personLog.findMany({ select: { action: true, evidence: true, actorId: true, actorName: true, undoneAt: true } })
    expect(logs).toHaveLength(7)
    for (const log of logs) {
      expect(log).toEqual({ action: 'link_profile', evidence: 'pm_confirmed', actorId: fx.pm.id, actorName: 'Laura PM', undoneAt: null })
    }
  })

  it('adding a link again updates the row it has and creates nothing', async () => {
    const first: Record<string, string> = {}
    for (const link of SEVEN_LINKS) first[link.url] = (await addWithAnswer(link)).body.media.id
    const before = await state()

    for (const link of SEVEN_LINKS) {
      // The platform reports more views now
      net.posts.set(link.canonicalUrl, { ...link.scraped, views: link.scraped.views + 1000 })

      // As the form sends it: just the link…
      const plain = await add({ url: link.url })
      expect(plain.status, link.url).toBe(200)
      expect(plain.body.created).toBe(false)
      expect(plain.body.linkedProfile).toBeNull()
      expect(plain.body.media.id).toBe(first[link.url])
      expect(plain.body.media.views).toBe(link.scraped.views + 1000)

      // …with the creator picked, and as the confirmation would send it a second time
      const picked = await add({ url: link.url, influencerId: memberOf(link).id })
      const resent = await add({ url: link.url, influencerId: memberOf(link).id, linkProfileTo: memberOf(link).id })
      for (const res of [picked, resent]) {
        expect(res.status).toBe(200)
        expect(res.body.created).toBe(false)
        expect(res.body.linkedProfile).toBeNull()
        expect(res.body.media.id).toBe(first[link.url])
        expect(res.body.media.influencerId).toBe(memberOf(link).id)
      }
    }

    expect(await state()).toEqual(before)
  })

  it('once a profile is registered, her next publications from it need no question, even with the network down', async () => {
    const link = SEVEN_LINKS[0]
    const member = memberOf(link)
    await addWithAnswer(link)
    const before = await state()

    // A new video of the same TikTok account, read from the network
    const next = tiktokVideo('alba_prueba', '2026-10-19T10:00:00.000Z', 21, { views: 2600 })
    const read = await add({ url: next.url })
    expect(read.status).toBe(201)
    expect(read.body.linkedProfile).toBeNull()
    expect(read.body.media.influencerId).toBe(member.id)
    expect(read.body.media.publishedByInfluencerId).toBe(fx.tiktokOutside['alba_prueba'].id)
    expect(read.body.media.platform).toBe('TIKTOK')

    // And another one with no scraper: the @user of the link is enough for a profile she already has
    net.apifyConfigured = false
    const offline = `https://www.tiktok.com/@Alba_Prueba/video/${tiktokIdAt('2026-10-23T10:00:00.000Z', 22)}`
    const unread = await add({ url: offline, influencerId: member.id, views: 150 })
    expect(unread.status).toBe(201)
    expect(unread.body.enriched).toBe(false)
    expect(unread.body.media.influencerId).toBe(member.id)
    expect(unread.body.media.publishedByInfluencerId).toBe(fx.tiktokOutside['alba_prueba'].id)
    expect(unread.body.media.postedAt).toBe('2026-10-23T10:00:00.000Z')

    const after = await state()
    expect(after).toEqual({ ...before, media: before.media + 2 })
  })

  it('the campaign still has 36 creators and its views and interactions rise by the new content', async () => {
    const before = await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES })
    expect(before?.totals.members).toBe(36)
    expect(before?.perInfluencer).toHaveLength(36)
    const albaBefore = before?.perInfluencer.find(p => p.influencerId === fx.instagram['alba_prueba'].id)
    expect(albaBefore?.vsBaseline).toBeTruthy()

    for (const link of SEVEN_LINKS) await addWithAnswer(link)

    const after = await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES })
    expect(after?.totals.members).toBe(36)
    expect(after?.perInfluencer).toHaveLength(36)
    expect(after?.totals.media).toBe(before!.totals.media + 7)
    expect(after?.totals.views).toBe(before!.totals.views + SEVEN_TOTALS.views)
    expect(after?.totals.engagements).toBe(before!.totals.engagements + SEVEN_TOTALS.engagements)
    // A creator never appears twice and none was added
    expect(new Set(after!.perInfluencer.map(p => p.influencerId)).size).toBe(36)
    expect(after!.perInfluencer.map(p => p.influencerId).sort()).toEqual(before!.perInfluencer.map(p => p.influencerId).sort())
    // Her TikTok video counts in her row but does not touch the comparison with her usual Instagram reel
    const albaAfter = after?.perInfluencer.find(p => p.influencerId === fx.instagram['alba_prueba'].id)
    expect(albaAfter?.vsBaseline).toEqual(albaBefore?.vsBaseline)

    // The periodic revalidation keeps every new piece (none is detached or hidden later)
    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 38, detached: 0 })
    const later = await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES })
    expect(later?.totals.views).toBe(after?.totals.views)
    expect(later?.totals.members).toBe(36)
  })
})

// ---------------------------------------------------------------------------

describe('a profile that belongs to nobody in the campaign', () => {
  it('stays refused with a clear message and creates nothing, whether the account exists in the table or not', async () => {
    // An account nobody has ever registered, and one that exists as a row but is not a member
    const stranger = tiktokVideo('cuenta_desconocida', '2026-10-10T10:00:00.000Z', 31)
    const known = await prisma.influencer.create({ data: { username: 'otra_cuenta_demo', platform: 'TIKTOK', followers: 700 } })
    const outsider = tiktokVideo(known.username, '2026-10-11T10:00:00.000Z', 32)
    const before = await state()

    for (const [video, handle] of [[stranger, 'cuenta_desconocida'], [outsider, 'otra_cuenta_demo']] as const) {
      const res = await add({ url: video.url })
      expect(res.status).toBe(409)
      expect(res.body).toEqual({
        code: 'profile_not_linked',
        error: `Este contenido es de @${handle} en TikTok, que no está registrado como perfil de ninguna creadora de esta campaña.`,
        author: { handle, platform: 'TIKTOK', verified: true },
        suggestions: [],
      })
    }

    expect(await state()).toEqual(before)
    expect(await prisma.media.count({ where: { externalId: { in: [stranger.id, outsider.id] } } })).toBe(0)
  })

  it('suggests the creator picked in the form first, then the bio link, then the same handle, never twice', async () => {
    const link = SEVEN_LINKS[0] // @alba_prueba on TikTok: her Instagram links it and has the same handle
    const other = fx.instagram['creadora_demo_05']

    const withOther = await add({ url: link.url, influencerId: other.id })
    expect(withOther.status).toBe(409)
    expect(withOther.body.suggestions).toEqual([
      { influencerId: other.id, username: 'creadora_demo_05', platform: 'INSTAGRAM', reason: 'selected' },
      { influencerId: memberOf(link).id, username: 'alba_prueba', platform: 'INSTAGRAM', reason: 'bio_link' },
    ])

    const withHerself = await add({ url: link.url, influencerId: memberOf(link).id })
    expect(withHerself.body.suggestions).toEqual([
      { influencerId: memberOf(link).id, username: 'alba_prueba', platform: 'INSTAGRAM', reason: 'selected' },
    ])

    // A TikTok user that an Instagram member links in her bio under ANOTHER handle
    await prisma.influencer.update({ where: { id: other.id }, data: { bio: 'Hogar y orden. TikTok: tiktok.com/@orden.en.casa' } })
    const video = tiktokVideo('orden.en.casa', '2026-10-14T09:00:00.000Z', 33)
    const viaBio = await add({ url: video.url })
    expect(viaBio.status).toBe(409)
    expect(viaBio.body.suggestions).toEqual([
      { influencerId: other.id, username: 'creadora_demo_05', platform: 'INSTAGRAM', reason: 'bio_link' },
    ])
  })

  it('never offers to register something that is not a username', async () => {
    const url = 'https://www.instagram.com/reel/DfNombreRaro1/'
    net.posts.set(url, {
      externalId: '3745000000000000888', caption: null, likes: 10, comments: 1, views: 100, thumbnailUrl: null,
      postedAt: '2026-10-12T10:00:00.000Z', ownerUsername: 'Nombre Con Espacios', mediaType: 'REEL', hashtags: [], mentions: [],
    } satisfies ScrapedSinglePost)
    const before = await state()

    for (const body of [{ url }, { url, linkProfileTo: fx.instagram['alba_prueba'].id }]) {
      const res = await add(body)
      expect(res).toEqual({
        status: 400,
        body: { error: 'No he podido leer de quién es esta publicación. Inténtalo en unos minutos o pega el enlace con el usuario.' },
      })
    }
    expect(await state()).toEqual(before)
  })

  it('never takes maria_garcia for maria.garcia', async () => {
    const member = await prisma.influencer.create({ data: { username: 'maria_garcia', platform: 'TIKTOK' } })
    const campaign = await prisma.campaign.create({
      data: { name: 'Otra (test)', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'), platforms: ['TIKTOK'], userId: fx.pm.id },
    })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: member.id } })
    const video = tiktokVideo('maria.garcia', '2026-10-10T10:00:00.000Z', 34)

    const res = await add({ url: video.url }, campaign.id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('profile_not_linked')
    expect(res.body.suggestions).toEqual([])
    expect(await prisma.media.count({ where: { campaignId: campaign.id } })).toBe(0)

    // Her own handle, in any casing, is hers
    const own = tiktokVideo('Maria_Garcia', '2026-10-10T11:00:00.000Z', 35)
    const ok = await add({ url: own.url }, campaign.id)
    expect(ok.status).toBe(201)
    expect(ok.body.media.influencerId).toBe(member.id)
    expect(ok.body.media.publishedByInfluencerId).toBeNull()
    expect(ok.body.linkedProfile).toBeNull()
  })

  it('refuses a linkProfileTo that is not a member of this campaign', async () => {
    const outsider = await prisma.influencer.create({ data: { username: 'no_es_miembro', platform: 'INSTAGRAM' } })
    const before = await state()

    for (const linkProfileTo of [outsider.id, fx.tiktokOutside['alba_prueba'].id, 'no-existe']) {
      const res = await add({ url: SEVEN_LINKS[0].url, linkProfileTo })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('La creadora elegida no está en esta campaña. Añádela primero.')
    }
    const picked = await add({ url: SEVEN_LINKS[0].url, influencerId: outsider.id })
    expect(picked.status).toBe(400)
    expect(picked.body.error).toBe('El creador no está en esta campaña. Añádelo primero.')

    expect(await state()).toEqual(before)
    expect(scrapeSinglePost).not.toHaveBeenCalled()
  })

  it('refuses to register a profile that already belongs to another person, naming her', async () => {
    const hers = await prisma.influencer.create({ data: { username: 'persona_ajena', platform: 'INSTAGRAM', followers: 4000 } })
    const hersTikTok = await prisma.influencer.create({ data: { username: 'persona_ajena_tt', platform: 'TIKTOK', followers: 900 } })
    await linkProfile({ memberInfluencerId: hers.id, profileInfluencerId: hersTikTok.id, actor: null, evidence: 'pm_manual' })
    const video = tiktokVideo('persona_ajena_tt', '2026-10-10T10:00:00.000Z', 36)
    const before = await state()

    const question = await add({ url: video.url })
    expect(question.status).toBe(409)
    expect(question.body.code).toBe('profile_not_linked')

    const res = await add({ url: video.url, linkProfileTo: fx.instagram['alba_prueba'].id })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      code: 'profile_of_other_person',
      error: '@persona_ajena_tt en TikTok ya es un perfil de @persona_ajena (Instagram). No puede ser también un perfil de @alba_prueba.',
    })

    expect(await state()).toEqual(before)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: fx.instagram['alba_prueba'].id } })).personId).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('a refused request leaves nothing behind', () => {
  it('a date outside the campaign is refused, with or without the PM’s answer: no profile, no person, no log, no piece', async () => {
    const late = tiktokVideo('alba_prueba', '2026-11-05T10:00:00.000Z', 41)
    const early = tiktokVideo('cuenta_sin_fila', '2026-09-28T10:00:00.000Z', 42)
    const before = await state()
    const alba = fx.instagram['alba_prueba'].id

    // After the end it could only count as a late piece (Nov 2026), and
    // @alba_prueba is COMPLETED: she owes nothing. Refused before anything is linked.
    for (const body of [
      { url: late.url, linkProfileTo: alba },
      { url: late.url, influencerId: alba, linkProfileTo: alba, confirmUnverified: true },
    ]) {
      const res = await add(body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('nothing_pending')
      expect(res.body.error).toBe('@alba_prueba está en Completado: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
      expect(res.body.postedAt).toBe('2026-11-05T10:00:00.000Z')
    }
    // Without her answer the author is asked about first: nothing is created either
    expect((await add({ url: late.url })).body.code).toBe('profile_not_linked')

    const tooEarly = await add({ url: early.url, linkProfileTo: alba })
    expect(tooEarly.status).toBe(400)
    expect(tooEarly.body.error).toBe('El contenido se publicó el 2026-09-28, fuera del periodo de la campaña (2026-10-01 – 2026-10-31).')

    expect(await state()).toEqual(before)
    expect(await prisma.influencer.count({ where: { username: 'cuenta_sin_fila' } })).toBe(0)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: alba } })).personId).toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: fx.tiktokOutside['alba_prueba'].id } })).personId).toBeNull()
  })

  it('the last day of the campaign is inside; the day after is not, read from the id of the link alone', async () => {
    net.apifyConfigured = false
    const alba = fx.instagram['alba_prueba'].id
    const lastDay = `https://www.tiktok.com/@alba_prueba/video/${tiktokIdAt('2026-10-31T23:59:59.000Z', 43)}`
    const dayAfter = `https://www.tiktok.com/@alba_prueba/video/${tiktokIdAt('2026-11-01T00:00:00.000Z', 44)}`

    // The day after is 1 day late: only a late piece, and @alba_prueba (COMPLETED) owes nothing
    const refused = await add({ url: dayAfter, linkProfileTo: alba, confirmUnverified: true })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ code: 'nothing_pending', lateDays: 1, postedAt: '2026-11-01T00:00:00.000Z' })
    expect(await prisma.person.count()).toBe(0)

    const ok = await add({ url: lastDay, linkProfileTo: alba, confirmUnverified: true })
    expect(ok.status).toBe(201)
    expect(ok.body.media.postedAt).toBe('2026-10-31T23:59:59.000Z')
  })

  it('once the profile is registered, saying the piece is somebody else’s is refused and changes nothing', async () => {
    const link = SEVEN_LINKS[2] // @sara_inventada17 on TikTok
    await addWithAnswer(link)
    const before = await state()

    // Same publication, but now the PM says it is somebody else's
    const res = await add({ url: link.url, influencerId: fx.instagram['creadora_demo_01'].id })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Este contenido es de @sara_inventada17, que es un perfil de @sara_inventada17, no de @creadora_demo_01.')
    expect(res.body.ownerUsername).toBe('sara_inventada17')

    expect(await state()).toEqual(before)
  })

  it('that refusal names the creator to pick, also when her profile has another handle', async () => {
    const reel = SEVEN_LINKS[4] // the Instagram reel of @risasdeprueba_, a profile of the member @risasdeprueba
    await addWithAnswer(reel)
    const before = await state()

    const res = await add({ url: reel.url, influencerId: fx.instagram['creadora_demo_01'].id })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(`Este contenido es de @${REAL_INSTAGRAM_OF_RISAS}, que es un perfil de @risasdeprueba, no de @creadora_demo_01.`)
    // What the form preselects: the member's handle, not the handle of the profile that published
    expect(res.body.ownerUsername).toBe('risasdeprueba')

    expect(await state()).toEqual(before)
  })
})

// ---------------------------------------------------------------------------

describe('when the network cannot say who published it', () => {
  it('needs the PM’s explicit confirmation before a profile is registered on her word', async () => {
    net.apifyConfigured = false // no token: nothing can be read
    const link = SEVEN_LINKS[0]
    const member = memberOf(link)
    const before = await state()

    const question = await add({ url: link.url })
    expect(question.status).toBe(409)
    expect(question.body.code).toBe('profile_not_linked')
    expect(question.body.author).toEqual({ handle: 'alba_prueba', platform: 'TIKTOK', verified: false })

    // Saying whose it is is not enough when the author comes only from the link
    for (const body of [
      { url: link.url, linkProfileTo: member.id },
      { url: link.url, influencerId: member.id, linkProfileTo: member.id, confirmUnverified: false },
      { url: link.url, linkProfileTo: member.id, confirmUnverified: 'true' },
    ]) {
      const again = await add(body)
      expect(again.status).toBe(409)
      expect(again.body.code).toBe('profile_not_linked')
      expect(again.body.author.verified).toBe(false)
      expect(again.body.suggestions[0]).toEqual({ influencerId: member.id, username: 'alba_prueba', platform: 'INSTAGRAM', reason: 'selected' })
    }
    expect(await state()).toEqual(before)

    const res = await add({ url: link.url, influencerId: member.id, linkProfileTo: member.id, confirmUnverified: true, views: 777, likes: 12, comments: 3 })
    expect(res.status).toBe(201)
    expect(res.body.enriched).toBe(false)
    expect(res.body.linkedProfile).toEqual({ handle: 'alba_prueba', platform: 'TIKTOK', memberUsername: 'alba_prueba' })
    expect(res.body.media.influencerId).toBe(member.id)
    expect(res.body.media.publishedByInfluencerId).toBe(fx.tiktokOutside['alba_prueba'].id)
    expect(res.body.media.platform).toBe('TIKTOK')
    // No date was typed: it comes from the id of the video
    expect(res.body.media.postedAt).toBe(link.postedAt)
    expect(res.body.media.views).toBe(777)
    expect(res.body.media.likes).toBe(12)
    expect(res.body.media.comments).toBe(3)
    expect(res.body.media.dataSource).toBe('manual')

    const logs = await prisma.personLog.findMany({ select: { action: true, evidence: true, actorId: true } })
    expect(logs).toEqual([{ action: 'link_profile', evidence: 'pm_confirmed_unverified', actorId: fx.pm.id }])
    expect((await state()).memberships).toEqual(before.memberships)
    expect(scrapeSinglePost).not.toHaveBeenCalled()
  })

  it('treats a scraper that answers nothing like no scraper at all', async () => {
    const link = SEVEN_LINKS[5]
    unreadable(link.canonicalUrl)

    const question = await add({ url: link.url })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: 'nuria_demo15', platform: 'TIKTOK', verified: false })
    expect(scrapeSinglePost).toHaveBeenCalledWith(link.canonicalUrl)

    const res = await add({ url: link.url, linkProfileTo: memberOf(link).id, confirmUnverified: true })
    expect(res.status).toBe(201)
    expect(res.body.media.postedAt).toBe(link.postedAt)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.campaignId } })).toBe(36)
  })

  it('the date in a TikTok id wins over a typed date, and a typed date is still used when the id says nothing', async () => {
    net.apifyConfigured = false
    const link = SEVEN_LINKS[6]
    const res = await add({ url: link.url, linkProfileTo: memberOf(link).id, confirmUnverified: true, postedAt: '2026-10-30T08:00:00.000Z' })
    expect(res.status).toBe(201)
    expect(res.body.media.postedAt).toBe(link.postedAt)

    // An id that is not a real TikTok id carries no date: the PM's is needed and used
    const odd = `https://www.tiktok.com/@${TWICE}/video/123456`
    const undated = await add({ url: odd })
    expect(undated.status).toBe(400)
    expect(undated.body.needsPostedAt).toBe(true)
    const dated = await add({ url: odd, postedAt: '2026-10-20T08:00:00.000Z' })
    expect(dated.status).toBe(201)
    expect(dated.body.media.postedAt).toBe('2026-10-20T08:00:00.000Z')
    expect(dated.body.media.influencerId).toBe(fx.tiktokTwice.id)
  })

  it('a story of a handle she does not have registered follows the same question and is never scraped', async () => {
    const storyId = storyIdAt('2026-10-18T09:30:00.000Z', 5)
    const url = `https://www.instagram.com/stories/${REAL_INSTAGRAM_OF_RISAS}/${storyId}/`
    const member = fx.instagram['risasdeprueba']

    const question = await add({ url, influencerId: member.id, views: 410, reach: 380 })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM', verified: false })
    expect(question.body.suggestions).toEqual([{ influencerId: member.id, username: 'risasdeprueba', platform: 'INSTAGRAM', reason: 'selected' }])
    expect(await prisma.influencer.count({ where: { username: REAL_INSTAGRAM_OF_RISAS } })).toBe(0)

    const res = await add({ url, influencerId: member.id, linkProfileTo: member.id, confirmUnverified: true, views: 410, reach: 380 })
    expect(res.status).toBe(201)
    expect(res.body.isStory).toBe(true)
    expect(res.body.media.mediaType).toBe('STORY')
    expect(res.body.media.platform).toBe('INSTAGRAM')
    expect(res.body.media.influencerId).toBe(member.id)
    expect(res.body.media.publishedBy).toMatchObject({ username: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM' })
    expect(res.body.media.views).toBe(410)
    expect(res.body.media.reach).toBe(380)
    expect(new Date(res.body.media.postedAt).toISOString()).toBe('2026-10-18T09:30:00.000Z')
    expect(scrapeSinglePost).not.toHaveBeenCalled()
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.campaignId } })).toBe(36)
  })

  it('an Instagram link with no user and no scrape needs the creator, and only a creator of that network', async () => {
    net.apifyConfigured = false
    const url = 'https://www.instagram.com/reel/DfSinAutor01/'
    const before = await state()

    const nobody = await add({ url, postedAt: '2026-10-12T10:00:00.000Z' })
    expect(nobody.status).toBe(400)
    expect(nobody.body).toEqual({ error: 'Indica el creador', ownerUsername: null })

    // The TikTok member cannot be the publisher of an Instagram reel, and nobody says who is
    const wrongNetwork = await add({ url, influencerId: fx.tiktokTwice.id, postedAt: '2026-10-12T10:00:00.000Z' })
    expect(wrongNetwork.status).toBe(400)
    expect(wrongNetwork.body.error).toBe('No he podido leer de quién es esta publicación. Inténtalo en unos minutos o pega el enlace con el usuario.')

    const undated = await add({ url, influencerId: fx.instagram['creadora_demo_02'].id })
    expect(undated.status).toBe(400)
    expect(undated.body.needsPostedAt).toBe(true)
    expect(undated.body.error).toBe('Apify no está disponible para leer la fecha de publicación. Indica postedAt (fecha de publicación) para añadir el contenido.')
    expect(await state()).toEqual(before)

    const ok = await add({ url, influencerId: fx.instagram['creadora_demo_02'].id, postedAt: '2026-10-12T10:00:00.000Z', likes: '40', views: 900 })
    expect(ok.status).toBe(201)
    expect(ok.body.enriched).toBe(false)
    expect(ok.body.linkedProfile).toBeNull()
    expect(ok.body.media.influencerId).toBe(fx.instagram['creadora_demo_02'].id)
    expect(ok.body.media.publishedByInfluencerId).toBeNull()
    expect(ok.body.media.externalId).toBe('DfSinAutor01')
    expect(ok.body.media.likes).toBe(40)
    expect(ok.body.media.views).toBe(900)
    expect(await prisma.person.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('who a publication is filed under', () => {
  it('an account that is itself a member keeps its own content (the legacy double membership)', async () => {
    const video = tiktokVideo(TWICE, '2026-10-16T10:00:00.000Z', 51)
    const before = await state()

    const res = await add({ url: video.url })
    expect(res.status).toBe(201)
    expect(res.body.media.influencerId).toBe(fx.tiktokTwice.id)
    expect(res.body.media.publishedByInfluencerId).toBeNull()
    expect(res.body.linkedProfile).toBeNull()

    // Picking her Instagram row in the form still files it under the TikTok account that published it
    const picked = await add({ url: video.url, influencerId: fx.instagram[TWICE].id })
    expect(picked.status).toBe(200)
    expect(picked.body.media.id).toBe(res.body.media.id)
    expect(picked.body.media.influencerId).toBe(fx.tiktokTwice.id)

    // So does the Instagram member whose bio links that TikTok account under another handle (a TikTok twin)
    const twinOwner = fx.instagram['creadora_demo_11']
    await prisma.influencer.update({ where: { id: twinOwner.id }, data: { website: 'https://www.tiktok.com/@gemela_demo' } })
    const twin = await prisma.influencer.create({ data: { username: 'gemela_demo', platform: 'TIKTOK' } })
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaignId, influencerId: twin.id, source: `tiktok_link:${twinOwner.id}` } })
    const twinVideo = tiktokVideo('gemela_demo', '2026-10-17T10:00:00.000Z', 52)
    const viaTwin = await add({ url: twinVideo.url, influencerId: twinOwner.id })
    expect(viaTwin.status).toBe(201)
    expect(viaTwin.body.media.influencerId).toBe(twin.id)
    expect(viaTwin.body.media.publishedByInfluencerId).toBeNull()

    // An unrelated creator picked by mistake is told whose it is; nothing is filed under her
    const mistake = await add({ url: video.url, influencerId: fx.instagram['creadora_demo_01'].id })
    expect(mistake.status).toBe(400)
    expect(mistake.body).toEqual({ error: `Este contenido es de @${TWICE}, no de @creadora_demo_01.`, ownerUsername: TWICE })

    const after = await state()
    expect(after.persons).toBe(0)
    expect(after.logs).toBe(0)
    expect(after.media).toBe(before.media + 2)
    expect(after.memberships).toHaveLength(37) // the twin this test added by hand, nothing else
  })

  it('refuses to file a member’s post under another member of the same network', async () => {
    const url = 'https://www.instagram.com/p/DfDeOtra001/'
    net.posts.set(url, {
      externalId: '3745000000000000777', caption: null, likes: 10, comments: 1, views: 0, thumbnailUrl: null,
      postedAt: '2026-10-12T10:00:00.000Z', ownerUsername: 'creadora_demo_03', mediaType: 'POST', hashtags: [], mentions: [],
    } satisfies ScrapedSinglePost)

    const res = await add({ url, influencerId: fx.instagram['creadora_demo_04'].id })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Este contenido es de @creadora_demo_03, no de @creadora_demo_04.', ownerUsername: 'creadora_demo_03' })
    expect(await prisma.media.count({ where: { externalId: '3745000000000000777' } })).toBe(0)

    // Without a creator picked it goes to its author, as always
    const ok = await add({ url })
    expect(ok.status).toBe(201)
    expect(ok.body.media.influencerId).toBe(fx.instagram['creadora_demo_03'].id)
    expect(ok.body.media.mediaType).toBe('POST')
  })

  it('claims an unattached row left by a profile analysis and credits it to the member', async () => {
    const link = SEVEN_LINKS[2] // @sara_inventada17 on TikTok
    const loose = await prisma.media.create({
      data: {
        externalId: link.scraped.externalId, platform: 'TIKTOK', mediaType: 'VIDEO', views: 100, likes: 5,
        permalink: link.canonicalUrl, postedAt: new Date(link.postedAt), source: 'apify',
        influencerId: fx.tiktokOutside['sara_inventada17'].id, campaignId: null,
      },
    })
    const before = await state()

    const question = await add({ url: link.url })
    expect(question.status).toBe(409)
    const res = await add({ url: link.url, linkProfileTo: memberOf(link).id })
    // It was in no campaign: for this one it is new (the form says «Añadida», not «Ya estaba en la campaña»)
    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)
    expect(res.body.media.id).toBe(loose.id)
    expect(res.body.media.campaignId).toBe(fx.campaignId)
    expect(res.body.media.influencerId).toBe(memberOf(link).id)
    expect(res.body.media.publishedByInfluencerId).toBe(fx.tiktokOutside['sara_inventada17'].id)
    expect(res.body.media.views).toBe(link.scraped.views)
    expect(res.body.media.source).toBe('manual')
    expect(res.body.linkedProfile).toEqual({ handle: 'sara_inventada17', platform: 'TIKTOK', memberUsername: 'sara_inventada17' })

    expect((await state()).media).toBe(before.media)
    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 32, detached: 0 })
  })

  it('keeps the refusal for a piece that is in the campaign under another creator', async () => {
    net.apifyConfigured = false
    const url = 'https://www.instagram.com/reel/DfDuplicada1/'
    const first = await add({ url, influencerId: fx.instagram['creadora_demo_06'].id, postedAt: '2026-10-12T10:00:00.000Z' })
    expect(first.status).toBe(201)

    const second = await add({ url: `${url}?igsh=abc`, influencerId: fx.instagram['creadora_demo_07'].id, postedAt: '2026-10-12T10:00:00.000Z' })
    expect(second.status).toBe(409)
    expect(second.body).toEqual({ error: 'Este contenido ya está registrado para otro creador.' })

    const same = await add({ url: 'instagram.com/creadora_demo_06/reel/DfDuplicada1', views: 1234 })
    expect(same.status).toBe(200)
    expect(same.body.media.id).toBe(first.body.media.id)
    expect(same.body.media.views).toBe(1234)
    expect(await prisma.media.count({ where: { permalink: { contains: 'DfDuplicada1' } } })).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('a brand account of the campaign is never a profile of a creator', () => {
  const BRAND_REFUSAL = '@marca.demo es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora.'

  /** A reel the BRAND's account published (a collab, a repost of a creator's video). */
  function brandReel(code: string, low: number): string {
    const url = `https://www.instagram.com/reel/${code}/`
    net.posts.set(url, {
      externalId: `37450000000000009${low}`, caption: 'Con nuestra creadora #marcademo', likes: 900, comments: 40, views: 52000, thumbnailUrl: null,
      postedAt: '2026-10-15T10:00:00.000Z', ownerUsername: 'Marca.Demo', mediaType: 'REEL', hashtags: ['#marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    return url
  }

  it('refuses a publication of the brand’s account whatever the PM picks or confirms, and registers nothing', async () => {
    const reel = brandReel('DfDeLaMarca1', 1)
    const video = tiktokVideo('marca.demo', '2026-10-16T10:00:00.000Z', 61, { views: 80000 })
    const alba = fx.instagram['alba_prueba'].id
    const before = await state()

    for (const body of [
      // As the form sends it, with and without a creator picked
      { url: reel },
      { url: reel, influencerId: alba },
      // As the confirmation would send it: before the review this registered the brand as her profile in one click
      { url: reel, influencerId: alba, linkProfileTo: alba },
      { url: reel, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: 'marca.demo', confirmUnverified: true },
      // The brand's TikTok under the same handle
      { url: video.url },
      { url: video.url, linkProfileTo: alba },
    ]) {
      expect(await add(body), JSON.stringify(body)).toEqual({ status: 400, body: { error: BRAND_REFUSAL } })
    }

    // The same with the network down: the @user of the link is the brand's
    net.apifyConfigured = false
    expect(await add({ url: video.url, influencerId: alba, linkProfileTo: alba, confirmUnverified: true })).toEqual({ status: 400, body: { error: BRAND_REFUSAL } })

    expect(await state()).toEqual(before)
    expect(await prisma.influencer.count({ where: { username: { in: ['marca.demo', 'Marca.Demo'] } } })).toBe(0)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: alba } })).personId).toBeNull()
  })

  it('reads the brand accounts as the PM typed them (with @, capitals, several in one field)', async () => {
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { targetAccounts: ['@Marca.Demo @marcademo_tienda'] } })
    const before = await state()

    expect(await add({ url: brandReel('DfDeLaMarca2', 2), linkProfileTo: fx.instagram['alba_prueba'].id })).toEqual({ status: 400, body: { error: BRAND_REFUSAL } })
    const shop = tiktokVideo('MarcaDemo_Tienda', '2026-10-16T10:00:00.000Z', 62)
    expect(await add({ url: shop.url, linkProfileTo: fx.instagram['alba_prueba'].id })).toEqual({
      status: 400,
      body: { error: '@marcademo_tienda es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora.' },
    })
    expect(await state()).toEqual(before)

    // A creator whose handle only CONTAINS the brand's is not the brand: the question is asked as always
    const fan = tiktokVideo('marca.demo.fans', '2026-10-16T11:00:00.000Z', 63)
    const question = await add({ url: fan.url })
    expect(question.status).toBe(409)
    expect(question.body.code).toBe('profile_not_linked')
  })

  it('a brand account that was registered on a creator elsewhere is not credited to her in this campaign', async () => {
    // Linked in a campaign where it was not a brand account (or before this rule existed)
    const alba = fx.instagram['alba_prueba']
    const brandTikTok = await prisma.influencer.create({ data: { username: 'marca.demo', platform: 'TIKTOK', followers: 250000 } })
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: brandTikTok.id, actor: null, evidence: 'pm_manual' })
    const video = tiktokVideo('marca.demo', '2026-10-16T10:00:00.000Z', 64, { views: 80000 })
    const before = await state()

    for (const body of [{ url: video.url }, { url: video.url, influencerId: alba.id }, { url: video.url, influencerId: fx.instagram['creadora_demo_01'].id }]) {
      expect(await add(body)).toEqual({
        status: 400,
        body: { error: '@marca.demo es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @alba_prueba.' },
      })
    }
    expect(await state()).toEqual(before)
    expect(await prisma.media.count({ where: { externalId: video.id } })).toBe(0)
  })

  it('the brand’s account added as a creator keeps its own content, and only its own row can take its other account', async () => {
    const brand = await prisma.influencer.create({ data: { username: 'marca.demo', platform: 'INSTAGRAM', followers: 90000 } })
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaignId, influencerId: brand.id, status: 'COMPLETED' } })

    // Its own reel: a member's publication, as always
    const own = await add({ url: brandReel('DfDeLaMarca3', 3) })
    expect(own.status).toBe(201)
    expect(own.body.media.influencerId).toBe(brand.id)
    expect(own.body.media.publishedByInfluencerId).toBeNull()

    // Its TikTok: not a creator's, so it is only asked about when the brand's own row is the one picked
    const video = tiktokVideo('marca.demo', '2026-10-16T10:00:00.000Z', 65)
    expect(await add({ url: video.url })).toEqual({ status: 400, body: { error: BRAND_REFUSAL } })
    expect(await add({ url: video.url, linkProfileTo: fx.instagram['alba_prueba'].id })).toEqual({ status: 400, body: { error: BRAND_REFUSAL } })
    const question = await add({ url: video.url, influencerId: brand.id })
    expect(question.status).toBe(409)
    expect(question.body.suggestions).toEqual([{ influencerId: brand.id, username: 'marca.demo', platform: 'INSTAGRAM', reason: 'selected' }])

    const res = await add({ url: video.url, influencerId: brand.id, linkProfileTo: brand.id, linkProfileAuthor: 'marca.demo' })
    expect(res.status).toBe(201)
    expect(res.body.linkedProfile).toEqual({ handle: 'marca.demo', platform: 'TIKTOK', memberUsername: 'marca.demo' })
    expect(res.body.media.influencerId).toBe(brand.id)
    expect(res.body.media.publishedBy).toMatchObject({ username: 'marca.demo', platform: 'TIKTOK' })

    // From then on its videos are the brand row's, never a creator's
    const next = tiktokVideo('marca.demo', '2026-10-17T10:00:00.000Z', 66)
    const mistaken = await add({ url: next.url, influencerId: fx.instagram['alba_prueba'].id })
    expect(mistaken.status).toBe(400)
    expect(mistaken.body.error).toBe('Este contenido es de @marca.demo, que es un perfil de @marca.demo, no de @alba_prueba.')
    const plain = await add({ url: next.url })
    expect(plain.status).toBe(201)
    expect(plain.body.media.influencerId).toBe(brand.id)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: fx.instagram['alba_prueba'].id } })).personId).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('the PM’s answer is about the author she was shown', () => {
  it('links nothing when the author read now is another one, and asks again about that one', async () => {
    // A TikTok link whose @user is no longer the real author (a renamed account): the network names @usuario_nuevo
    const id = tiktokIdAt('2026-10-14T10:00:00.000Z', 71)
    const url = `https://www.tiktok.com/@usuario_antiguo/video/${id}`
    const scraped: ScrapedSinglePost = {
      externalId: id, caption: 'Vídeo de prueba #marcademo', likes: 50, comments: 2, views: 900, thumbnailUrl: null,
      postedAt: '2026-10-14T10:00:00.000Z', ownerUsername: 'usuario_nuevo', mediaType: 'VIDEO', hashtags: ['#marcademo'], mentions: [],
    }
    net.posts.set(url, scraped)
    const alba = fx.instagram['alba_prueba'].id
    const before = await state()

    const shown = await add({ url })
    expect(shown.status).toBe(409)
    expect(shown.body.author).toEqual({ handle: 'usuario_nuevo', platform: 'TIKTOK', verified: true })

    // She answers for @usuario_nuevo, but this time the network does not answer: the server only has the @user of the link
    unreadable(url)
    const resent = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: 'usuario_nuevo' })
    expect(resent.status).toBe(409)
    expect(resent.body.code).toBe('profile_not_linked')
    expect(resent.body.author).toEqual({ handle: 'usuario_antiguo', platform: 'TIKTOK', verified: false })
    // Ticking «Confirmo que es su perfil» for the author she saw does not register the other one either
    const ticked = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: '@Usuario_Nuevo', confirmUnverified: true })
    expect(ticked.status).toBe(409)
    expect(ticked.body.code).toBe('profile_not_linked')
    expect(ticked.body.author).toEqual({ handle: 'usuario_antiguo', platform: 'TIKTOK', verified: false })
    expect(ticked.body.suggestions).toEqual([{ influencerId: alba, username: 'alba_prueba', platform: 'INSTAGRAM', reason: 'selected' }])
    expect(await state()).toEqual(before)

    // The mirror: she was shown the @user of the link and ticked; now the network names the real author
    net.posts.set(url, scraped)
    const mirror = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: 'usuario_antiguo', confirmUnverified: true })
    expect(mirror.status).toBe(409)
    expect(mirror.body.author).toEqual({ handle: 'usuario_nuevo', platform: 'TIKTOK', verified: true })
    expect(await state()).toEqual(before)
    expect(await prisma.influencer.count({ where: { username: { in: ['usuario_antiguo', 'usuario_nuevo'] } } })).toBe(0)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: alba } })).personId).toBeNull()

    // Answering for the author on screen (any casing, with @) registers exactly that one
    const ok = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: '@Usuario_Nuevo' })
    expect(ok.status).toBe(201)
    expect(ok.body.linkedProfile).toEqual({ handle: 'usuario_nuevo', platform: 'TIKTOK', memberUsername: 'alba_prueba' })
    expect(await prisma.influencer.count({ where: { username: 'usuario_antiguo' } })).toBe(0)
    expect(await prisma.personLog.findMany({ select: { evidence: true } })).toEqual([{ evidence: 'pm_confirmed' }])
  })

  it('with the network down she can still confirm the @user of the link she was shown', async () => {
    net.apifyConfigured = false
    const link = SEVEN_LINKS[5]
    const member = memberOf(link)

    const question = await add({ url: link.url })
    expect(question.body.author).toEqual({ handle: 'nuria_demo15', platform: 'TIKTOK', verified: false })
    const res = await add({ url: link.url, influencerId: member.id, linkProfileTo: member.id, linkProfileAuthor: question.body.author.handle, confirmUnverified: true })
    expect(res.status).toBe(201)
    expect(res.body.linkedProfile).toEqual({ handle: 'nuria_demo15', platform: 'TIKTOK', memberUsername: 'nuria_demo15' })
  })
})

// ---------------------------------------------------------------------------

describe('a piece that was stored before its publisher was known', () => {
  it('learns who published it when the profile is registered, and stops counting as published from her own profile', async () => {
    const alba = fx.instagram['alba_prueba']
    const url = 'https://www.instagram.com/reel/DfOtraCuenta1/'
    const vsBaseline = async () => (await computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES }))!.perInfluencer.find(p => p.influencerId === alba.id)!.vsBaseline
    const usual = await vsBaseline()
    expect(usual).toMatchObject({ piecesCompared: 1 })

    // Added while the network could not be read: no author, the PM picks the creator and types the date
    net.apifyConfigured = false
    const first = await add({ url, influencerId: alba.id, postedAt: '2026-10-11T10:00:00.000Z', views: 9000 })
    expect(first.status).toBe(201)
    expect(first.body.media.publishedByInfluencerId).toBeNull()
    // Taken for a reel of her own profile, it enters the comparison with her usual reel (the client sees it)
    expect(await vsBaseline()).toMatchObject({ piecesCompared: 2 })

    // Pasted again to refresh the figures: the network now says another account of hers published it
    net.apifyConfigured = true
    net.posts.set(url, {
      externalId: '3745000000000000902', caption: 'Desde mi otra cuenta #marcademo', likes: 700, comments: 30, views: 9500, thumbnailUrl: null,
      postedAt: '2026-10-11T10:00:00.000Z', ownerUsername: 'alba.otra_cuenta', mediaType: 'REEL', hashtags: ['#marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    const question = await add({ url, influencerId: alba.id })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: 'alba.otra_cuenta', platform: 'INSTAGRAM', verified: true })
    expect((await prisma.media.findUniqueOrThrow({ where: { id: first.body.media.id } })).publishedByInfluencerId).toBeNull()

    const res = await add({ url, influencerId: alba.id, linkProfileTo: alba.id, linkProfileAuthor: 'alba.otra_cuenta' })
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(false)
    expect(res.body.media.id).toBe(first.body.media.id)
    expect(res.body.linkedProfile).toEqual({ handle: 'alba.otra_cuenta', platform: 'INSTAGRAM', memberUsername: 'alba_prueba' })
    // The answer says the profile is hers, and the piece now says so too
    expect(res.body.media.influencerId).toBe(alba.id)
    expect(res.body.media.publishedBy).toMatchObject({ username: 'alba.otra_cuenta', platform: 'INSTAGRAM' })
    expect(res.body.media.views).toBe(9500)
    expect(await vsBaseline()).toEqual(usual)

    // Pasting it once more changes nothing
    const again = await add({ url })
    expect(again.status).toBe(200)
    expect(again.body.media.publishedByInfluencerId).toBe(res.body.media.publishedByInfluencerId)
    // With the network down the link says nothing about the author: the publisher that is known stays
    net.apifyConfigured = false
    const offline = await add({ url, influencerId: alba.id, views: 9900 })
    expect(offline.status).toBe(200)
    expect(offline.body.media.views).toBe(9900)
    expect(offline.body.media.publishedByInfluencerId).toBe(res.body.media.publishedByInfluencerId)
    expect(await vsBaseline()).toEqual(usual)
    expect(await prisma.media.count({ where: { permalink: { contains: 'DfOtraCuenta1' } } })).toBe(1)
  })

  it('the network corrects a publisher that was only the @user of the link, and a link alone never changes one that is known', async () => {
    const alba = fx.instagram['alba_prueba']
    const real = fx.tiktokOutside['alba_prueba']
    // She has two TikTok profiles registered
    const second = await prisma.influencer.create({ data: { username: 'alba_dos', platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: real.id, actor: null, evidence: 'pm_manual' })
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: second.id, actor: null, evidence: 'pm_manual' })

    // Network down: the video is pasted with the @user of her second profile in the link
    net.apifyConfigured = false
    const id = tiktokIdAt('2026-10-19T10:00:00.000Z', 81)
    const hinted = await add({ url: `https://www.tiktok.com/@alba_dos/video/${id}`, views: 300 })
    expect(hinted.status).toBe(201)
    expect(hinted.body.media.influencerId).toBe(alba.id)
    expect(hinted.body.media.publishedByInfluencerId).toBe(second.id)

    // The network answers: it was published from @alba_prueba
    net.apifyConfigured = true
    const canonical = `https://www.tiktok.com/@alba_dos/video/${id}`
    net.posts.set(canonical, {
      externalId: id, caption: null, likes: 20, comments: 1, views: 4100, thumbnailUrl: null,
      postedAt: '2026-10-19T10:00:00.000Z', ownerUsername: 'alba_prueba', mediaType: 'VIDEO', hashtags: [], mentions: [],
    } satisfies ScrapedSinglePost)
    const read = await add({ url: canonical })
    expect(read.status).toBe(200)
    expect(read.body.media.id).toBe(hinted.body.media.id)
    expect(read.body.media.influencerId).toBe(alba.id)
    expect(read.body.media.publishedByInfluencerId).toBe(real.id)

    // Network down again: the @user of the link is only a hint and does not move what the network said
    net.apifyConfigured = false
    const again = await add({ url: canonical, views: 4200 })
    expect(again.status).toBe(200)
    expect(again.body.media.views).toBe(4200)
    expect(again.body.media.publishedByInfluencerId).toBe(real.id)
    expect(await prisma.media.count({ where: { externalId: id } })).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('short links', () => {
  it('opens the short link first and finds duplicates on the real link', async () => {
    const link = SEVEN_LINKS[3] // @risasdeprueba on TikTok
    fetchStub.mockImplementation(async () =>
      new Response(null, { status: 301, headers: { location: `${link.canonicalUrl}?_r=1&share_app_id=1233` } })
    )
    const short = 'https://vm.tiktok.com/ZNdemo123/'

    const question = await add({ url: short })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: 'risasdeprueba', platform: 'TIKTOK', verified: true })
    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(String(fetchStub.mock.calls[0][0])).toBe(short)

    const res = await add({ url: short, linkProfileTo: memberOf(link).id })
    expect(res.status).toBe(201)
    expect(res.body.media.permalink).toBe(link.canonicalUrl)
    expect(res.body.media.externalId).toBe(link.scraped.externalId)

    // The long link is the same publication…
    const long = await add({ url: link.url })
    expect(long.status).toBe(200)
    expect(long.body.media.id).toBe(res.body.media.id)
    // …and so is the short one, pasted again
    const again = await add({ url: 'vm.tiktok.com/ZNdemo123' })
    expect(again.status).toBe(200)
    expect(again.body.media.id).toBe(res.body.media.id)
    expect(await prisma.media.count({ where: { externalId: link.scraped.externalId } })).toBe(1)
  })

  it('opens an Instagram share link too', async () => {
    const link = SEVEN_LINKS[4] // the reel of her real Instagram
    fetchStub.mockImplementation(async () =>
      new Response(null, { status: 302, headers: { location: `${link.canonicalUrl}?igsh=abc123` } })
    )

    const question = await add({ url: 'https://www.instagram.com/share/reel/BAdemo123/' })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM', verified: true })

    const res = await add({ url: 'https://www.instagram.com/share/reel/BAdemo123/', linkProfileTo: memberOf(link).id })
    expect(res.status).toBe(201)
    expect(res.body.media.permalink).toBe(link.canonicalUrl)
    expect(res.body.media.influencerId).toBe(memberOf(link).id)
    expect(res.body.media.publishedBy).toMatchObject({ username: REAL_INSTAGRAM_OF_RISAS, platform: 'INSTAGRAM' })
  })

  it('says so plainly when the short link cannot be opened', async () => {
    const before = await state()
    const message = 'No he podido abrir ese enlace corto. Abre la publicación en el navegador y pega el enlace completo.'

    // The network fails
    const down = await add({ url: 'https://vm.tiktok.com/ZNdemo123/' })
    expect(down).toEqual({ status: 400, body: { error: message } })

    // It leads somewhere that is not a publication
    fetchStub.mockImplementation(async () => new Response('<html></html>', { status: 200 }))
    const nowhere = await add({ url: 'https://www.tiktok.com/t/ZNdemo456/' })
    expect(nowhere).toEqual({ status: 400, body: { error: message } })

    // It leaves the platform
    fetchStub.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://example.test/video/1' } }))
    const elsewhere = await add({ url: 'https://vt.tiktok.com/ZNdemo789/' })
    expect(elsewhere).toEqual({ status: 400, body: { error: message } })

    expect(await state()).toEqual(before)
    expect(scrapeSinglePost).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('what the campaign page and the client receive afterwards', () => {
  /** GET /api/campaigns/[id], the request of the campaign page (one page of media). */
  async function campaignPage(): Promise<Answer> {
    const request = new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}?mediaLimit=100`)
    const response = await getCampaign(request, { params: Promise.resolve({ id: fx.campaignId }) })
    return { status: response.status, body: await response.json() }
  }

  it('the Media tab keeps the seven pieces: each hangs from a member and shows the network it was published on', async () => {
    const added: Record<string, SevenLink> = {}
    for (const link of SEVEN_LINKS) added[(await addWithAnswer(link)).body.media.id] = link

    const page = await campaignPage()
    expect(page.status).toBe(200)
    expect(page.body.campaign.influencers).toHaveLength(36)
    expect(page.body.campaign.media).toHaveLength(38)

    // The rule of the Media tab (campaigns/[id]/page.tsx): a piece is shown when its influencer is a member
    const memberIds = new Set(page.body.campaign.influencers.map((ci: { influencer: { id: string } }) => ci.influencer.id))
    const shown = page.body.campaign.media.filter((m: { influencer: { id: string } }) => memberIds.has(m.influencer.id))
    expect(shown).toHaveLength(38)
    for (const [id, link] of Object.entries(added)) {
      const row = shown.find((m: { id: string }) => m.id === id)
      expect(row, link.url).toBeDefined()
      // Filed under the member, with the network of the publication (the tab's network filter reads m.platform first)
      expect(row.influencer.id).toBe(memberOf(link).id)
      expect(row.influencer.username).toBe(link.memberHandle)
      expect(row.platform).toBe(link.platform)
      expect(row.views).toBe(link.scraped.views)
      // …and with its figures from the single overview
      expect(row.metrics).toMatchObject({ engagements: link.scraped.likes + link.scraped.comments })
    }
    // The network filter of the tab offers both networks, and TikTok holds the six new videos plus the one it had
    expect(shown.filter((m: { platform: string }) => m.platform === 'TIKTOK')).toHaveLength(7)
    expect(page.body.overview.totals.members).toBe(36)
  })

  it('who on the team added a creator or a profile never reaches the client', async () => {
    for (const link of SEVEN_LINKS) await addWithAnswer(link)
    // What later deliveries will write when a creator is added by hand
    const alba = fx.instagram['alba_prueba']
    await prisma.influencer.update({ where: { id: alba.id }, data: { addedById: fx.pm.id, addedByName: 'Laura PM' } })
    await prisma.campaignInfluencer.updateMany({ where: { campaignId: fx.campaignId, influencerId: alba.id }, data: { addedById: fx.pm.id, addedByName: 'Laura PM' } })

    // The agency sees it
    const staff = await campaignPage()
    const staffRow = staff.body.campaign.influencers.find((ci: { influencerId: string }) => ci.influencerId === alba.id)
    expect(staffRow.addedByName).toBe('Laura PM')
    expect(staffRow.influencer.addedByName).toBe('Laura PM')

    // The client that owns the campaign does not: neither the field nor the name, anywhere in the answer
    const brand = await prisma.user.create({ data: { email: `marca-${Date.now()}@example.test`, password: 'x', name: 'Marca Demo', role: 'BRAND' } })
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { userId: brand.id } })
    net.session = { id: brand.id, email: brand.email, name: brand.name, role: 'BRAND' }
    const client = await campaignPage()
    expect(client.status).toBe(200)
    const text = JSON.stringify(client.body)
    expect(text).not.toContain('addedByName')
    expect(text).not.toContain('addedById')
    expect(text).not.toContain('Laura PM')
    expect(text).not.toContain(fx.pm.id)
    // No money either, as always
    expect(text).not.toContain('agreedFee')
    // She still sees the 36 creators and the new pieces
    expect(client.body.campaign.influencers).toHaveLength(36)
    expect(client.body.campaign.media).toHaveLength(38)
    expect(client.body.overview.totals.members).toBe(36)
  })
})

// ---------------------------------------------------------------------------

describe('what the endpoint already did', () => {
  it('a member’s story: dated from its id, never scraped, views and reach from the PM, updated when added again', async () => {
    const storyId = storyIdAt('2026-10-20T07:15:00.000Z', 9)
    const url = `https://www.instagram.com/stories/creadora_demo_08/${storyId}/`

    const res = await add({ url: `${url}?igsh=xyz`, views: 500, reach: 450, likes: 99, postedAt: '2026-10-25T00:00:00.000Z' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ created: true, enriched: false, isStory: true, linkedProfile: null })
    expect(res.body.media).toMatchObject({
      mediaType: 'STORY', platform: 'INSTAGRAM', externalId: storyId, permalink: url,
      influencerId: fx.instagram['creadora_demo_08'].id, publishedByInfluencerId: null,
      views: 500, reach: 450, likes: 0, comments: 0, source: 'manual', dataSource: 'manual',
    })
    expect(new Date(res.body.media.postedAt).toISOString()).toBe('2026-10-20T07:15:00.000Z')

    const again = await add({ url, influencerId: fx.instagram['creadora_demo_08'].id, views: 640, reach: 600 })
    expect(again.status).toBe(200)
    expect(again.body.media.id).toBe(res.body.media.id)
    expect(again.body.media).toMatchObject({ views: 640, reach: 600 })

    const highlight = await add({ url: 'https://www.instagram.com/stories/highlights/17912345678901234/' })
    expect(highlight.status).toBe(400)
    expect(highlight.body.error).toContain('Los destacados (highlights) no son stories con fecha')

    expect(scrapeSinglePost).not.toHaveBeenCalled()
  })

  it('a YouTube video: the creator is picked, the date is typed, and she must be a YouTube member', async () => {
    const channel = await prisma.influencer.create({ data: { username: 'canal_demo', platform: 'YOUTUBE', followers: 12000 } })
    const instagram = await prisma.influencer.create({ data: { username: 'canal_demo_ig', platform: 'INSTAGRAM' } })
    const campaign = await prisma.campaign.create({
      data: { name: 'YouTube (test)', startDate: new Date('2026-10-01T00:00:00Z'), endDate: null, platforms: ['YOUTUBE', 'INSTAGRAM'], userId: fx.pm.id },
    })
    await prisma.campaignInfluencer.createMany({ data: [{ campaignId: campaign.id, influencerId: channel.id }, { campaignId: campaign.id, influencerId: instagram.id }] })
    const url = 'https://www.youtube.com/watch?v=TkDemoVid01&t=12s'

    const nobody = await add({ url, postedAt: '2026-10-09T10:00:00.000Z' }, campaign.id)
    expect(nobody).toEqual({ status: 400, body: { error: 'Indica el creador', ownerUsername: null } })

    const wrong = await add({ url, influencerId: instagram.id, postedAt: '2026-10-09T10:00:00.000Z' }, campaign.id)
    expect(wrong).toEqual({ status: 400, body: { error: 'La URL es de YouTube pero @canal_demo_ig está registrado en Instagram.' } })

    const ok = await add({ url, influencerId: channel.id, postedAt: '2026-10-09T10:00:00.000Z', views: 15000, likes: 800, comments: 40 }, campaign.id)
    expect(ok.status).toBe(201)
    expect(ok.body.media).toMatchObject({
      platform: 'YOUTUBE', mediaType: 'VIDEO', externalId: 'TkDemoVid01', permalink: 'https://www.youtube.com/watch?v=TkDemoVid01',
      influencerId: channel.id, publishedByInfluencerId: null, views: 15000, likes: 800, comments: 40,
    })

    const short = await add({ url: 'https://youtu.be/TkDemoVid01', influencerId: channel.id }, campaign.id)
    expect(short.status).toBe(200)
    expect(short.body.media.id).toBe(ok.body.media.id)
    // No end date: the window is open, and it says so when a date is before the start
    const early = await add({ url: 'https://www.youtube.com/shorts/aaaaaaaaaaa', influencerId: channel.id, postedAt: '2026-09-01T10:00:00.000Z' }, campaign.id)
    expect(early.status).toBe(400)
    expect(early.body.error).toBe('El contenido se publicó el 2026-09-01, fuera del periodo de la campaña (2026-10-01 – sin fecha de fin).')
  })

  it('the platform’s figures win over the PM’s when they carry signal; hers fill what the platform did not give', async () => {
    const url = 'https://www.instagram.com/reel/DfMetricas01/'
    net.posts.set(url, {
      externalId: '3745000000000000555', caption: 'Con #marcademo', likes: 300, comments: 0, views: 0, thumbnailUrl: 'https://example.test/t.jpg',
      postedAt: '2026-10-13T10:00:00.000Z', ownerUsername: 'creadora_demo_09', mediaType: 'REEL', hashtags: ['#marcademo'], mentions: ['@marca.demo'],
    } satisfies ScrapedSinglePost)

    const res = await add({ url, likes: 1, comments: 7, views: 4000, reach: 999, postedAt: '2026-10-01T00:00:00.000Z' })
    expect(res.status).toBe(201)
    expect(res.body.enriched).toBe(true)
    expect(res.body.media).toMatchObject({
      likes: 300, comments: 7, views: 4000, reach: 0, caption: 'Con #marcademo', thumbnailUrl: 'https://example.test/t.jpg',
      hashtags: ['#marcademo'], mentions: ['@marca.demo'], dataSource: 'apify', source: 'manual',
      influencerId: fx.instagram['creadora_demo_09'].id,
    })
    expect(res.body.media.postedAt).toBe('2026-10-13T10:00:00.000Z')

    for (const bad of [{ likes: -1 }, { comments: 'muchos' }, { views: '-3' }]) {
      const invalid = await add({ url, ...bad })
      expect(invalid.status).toBe(400)
      expect(invalid.body.error).toBe('likes, comments, views y reach deben ser números enteros positivos')
    }
    const badDate = await add({ url, postedAt: 'ayer' })
    expect(badDate).toEqual({ status: 400, body: { error: 'postedAt no es una fecha válida' } })
  })

  it('a publication the platform cannot date asks for the date', async () => {
    const url = 'https://www.instagram.com/p/DfSinFecha01/'
    net.posts.set(url, {
      externalId: '3745000000000000556', caption: null, likes: 20, comments: 1, views: 0, thumbnailUrl: null,
      postedAt: null, ownerUsername: 'creadora_demo_10', mediaType: 'POST', hashtags: [], mentions: [],
    } satisfies ScrapedSinglePost)

    const res = await add({ url })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'No se pudo determinar la fecha de publicación del contenido. Indica postedAt (fecha de publicación) para añadirlo.',
      needsPostedAt: true,
    })
    expect(await prisma.media.count({ where: { externalId: '3745000000000000556' } })).toBe(0)
  })

  it('does not recognise anything that is not a publication, and no longer says short links are not valid', async () => {
    for (const url of ['https://www.instagram.com/creadora_demo_01/', 'https://example.test/video/1', 'no es un enlace']) {
      const res = await add({ url })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/^URL no reconocida\./)
      expect(res.body.error).not.toContain('acortados')
    }
    expect(await add({ url: '   ' })).toEqual({ status: 400, body: { error: 'Indica la URL del contenido' } })
    expect(await add({})).toEqual({ status: 400, body: { error: 'Indica la URL del contenido' } })
    expect(await add('{ not json')).toEqual({ status: 400, body: { error: 'Cuerpo JSON inválido' } })
    expect(await add({ url: SEVEN_LINKS[0].url }, 'no-existe')).toEqual({ status: 404, body: { error: 'Campaign not found' } })
  })

  it('is for agency staff only: no session, a client and a creator are refused before anything is read', async () => {
    const before = await state()
    const body = { url: SEVEN_LINKS[0].url, linkProfileTo: fx.instagram['alba_prueba'].id }

    net.session = null
    expect(await add(body)).toEqual({ status: 401, body: { error: 'Not authenticated' } })
    for (const role of ['BRAND', 'CREATOR', 'employee', '']) {
      net.session = { ...fx.pm, role }
      expect(await add(body), role).toEqual({ status: 403, body: { error: 'Forbidden' } })
    }
    expect(await state()).toEqual(before)
    expect(scrapeSinglePost).not.toHaveBeenCalled()
    expect(fetchStub).not.toHaveBeenCalled()

    net.session = { ...fx.pm, role: 'ADMIN' }
    expect((await add(body)).status).toBe(201)
  })
})
