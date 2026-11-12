/**
 * «¿De quién es esta publicación?»: the PM's answer is bound to the author she
 * was SHOWN (review of delivery 1, 12 Nov 2026). The confirmation resends the
 * request with that author's handle (linkProfileAuthor) and network
 * (linkProfileAuthorPlatform); POST /api/campaigns/[id]/media/manual reads the
 * author again and links nothing when it is another one, or on another
 * network, or cannot be read at all.
 *
 * The handle half and the renamed-account cases are in manual-media.test.ts
 * («the PM’s answer is about the author she was shown»); this file covers the
 * network and the author that cannot be read any more.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  apifyConfigured: true,
  posts: new Map<string, unknown>(),
  session: null as null | { id: string; email: string; name: string; role: string },
}))

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => net.posts.get(url) ?? null),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => net.apifyConfigured),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
  }
})
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedSinglePost } from '@/lib/apify'
import { POST } from '@/app/api/campaigns/[id]/media/manual/route'
import { tiktokIdAt } from './fixtures/october'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

const UNKNOWN_AUTHOR = 'No he podido leer de quién es esta publicación. Inténtalo en unos minutos o pega el enlace con el usuario.'

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

let campaignId = ''
let alba = ''

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  net.apifyConfigured = true
  net.posts.clear()
  const pm = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo - Octubre (test)', status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
    },
  })
  const member = await prisma.influencer.create({ data: { username: 'alba_prueba', platform: 'INSTAGRAM', followers: 2100 } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: member.id, status: 'COMPLETED' } })
  campaignId = campaign.id
  alba = member.id
  net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
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

async function add(body: Record<string, unknown>): Promise<Answer> {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: campaignId }) })
  return { status: response.status, body: await response.json() }
}

async function state() {
  const [influencers, persons, logs, media, linked, memberships] = await Promise.all([
    prisma.influencer.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.media.count(),
    prisma.influencer.count({ where: { personId: { not: null } } }),
    prisma.campaignInfluencer.count(),
  ])
  return { influencers, persons, logs, media, linked, memberships }
}

describe('the network the PM was shown', () => {
  it('an answer about the author on another network links nothing and asks again; the right one links her', async () => {
    const id = tiktokIdAt('2026-10-14T10:00:00.000Z', 91)
    const url = `https://www.tiktok.com/@alba.tiktok/video/${id}`
    net.posts.set(url, {
      externalId: id, caption: 'Vídeo #marcademo', likes: 50, comments: 2, views: 900, thumbnailUrl: null,
      postedAt: '2026-10-14T10:00:00.000Z', ownerUsername: 'alba.tiktok', mediaType: 'VIDEO', hashtags: ['#marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    const before = await state()

    const question = await add({ url })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: 'alba.tiktok', platform: 'TIKTOK', verified: true })

    // Her answer names the handle, but on Instagram: not the author of this request
    const wrongNetwork = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: 'alba.tiktok', linkProfileAuthorPlatform: 'INSTAGRAM' })
    expect(wrongNetwork.status).toBe(409)
    expect(wrongNetwork.body.code).toBe('profile_not_linked')
    expect(wrongNetwork.body.author).toEqual({ handle: 'alba.tiktok', platform: 'TIKTOK', verified: true })
    expect(await state()).toEqual(before)

    // The network is compared in any casing
    const ok = await add({ url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: '@Alba.TikTok', linkProfileAuthorPlatform: 'tiktok' })
    expect(ok.status).toBe(201)
    expect(ok.body.linkedProfile).toEqual({ handle: 'alba.tiktok', platform: 'TIKTOK', memberUsername: 'alba_prueba' })
    expect(ok.body.media).toMatchObject({ influencerId: alba, platform: 'TIKTOK' })
    expect(ok.body.media.publishedBy).toMatchObject({ username: 'alba.tiktok', platform: 'TIKTOK' })
    expect((await state()).memberships).toBe(before.memberships)
  })
})

describe('an author that cannot be read any more', () => {
  it('stores nothing: her answer was about @x, not about the creator herself', async () => {
    // An Instagram reel: its link carries no @user, only the scraper names the author
    const url = 'https://www.instagram.com/reel/DfOtraCuentaB1/'
    net.posts.set(url, {
      externalId: '3745000000000000911', caption: 'Desde mi otra cuenta #marcademo', likes: 700, comments: 30, views: 9500, thumbnailUrl: null,
      postedAt: '2026-10-11T10:00:00.000Z', ownerUsername: 'alba.otra_cuenta', mediaType: 'REEL', hashtags: ['#marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    const before = await state()

    const question = await add({ url, influencerId: alba })
    expect(question.status).toBe(409)
    expect(question.body.author).toEqual({ handle: 'alba.otra_cuenta', platform: 'INSTAGRAM', verified: true })

    // She answers; meanwhile the scraper stopped answering: nobody can be read as the author now
    net.apifyConfigured = false
    const answer = { url, influencerId: alba, linkProfileTo: alba, linkProfileAuthor: 'alba.otra_cuenta', linkProfileAuthorPlatform: 'INSTAGRAM', postedAt: '2026-10-11T10:00:00.000Z' }
    expect(await add(answer)).toEqual({ status: 400, body: { error: UNKNOWN_AUTHOR } })
    // Only the handle sent (a page of before the network was added): the same
    expect(await add({ ...answer, linkProfileAuthorPlatform: undefined })).toEqual({ status: 400, body: { error: UNKNOWN_AUTHOR } })
    expect(await state()).toEqual(before)

    // When the network answers again, the same answer registers that profile
    net.apifyConfigured = true
    const ok = await add(answer)
    expect(ok.status).toBe(201)
    expect(ok.body.linkedProfile).toEqual({ handle: 'alba.otra_cuenta', platform: 'INSTAGRAM', memberUsername: 'alba_prueba' })
    expect(ok.body.media.publishedBy).toMatchObject({ username: 'alba.otra_cuenta', platform: 'INSTAGRAM' })
  })

  it('the form without a confirmation keeps working as before: the picked creator, as her own', async () => {
    net.apifyConfigured = false
    const res = await add({ url: 'https://www.instagram.com/reel/DfSuyaPropia1/', influencerId: alba, postedAt: '2026-10-11T10:00:00.000Z', views: 300 })
    expect(res.status).toBe(201)
    expect(res.body.media).toMatchObject({ influencerId: alba, publishedByInfluencerId: null, platform: 'INSTAGRAM' })
    expect(res.body.linkedProfile).toBeNull()
  })
})
