/**
 * A piece already in the campaign under the creator, pasted again through a
 * profile of hers that is ALREADY registered, learns who published it (review
 * of delivery 1, 12 Nov 2026). Before, `publishedByInfluencerId` was only
 * written when a profile was linked in that same request or an unattached row
 * was claimed: the piece kept counting as published from her own profile, in
 * «vs su habitual» (the client sees it) and in the estimates by followers.
 *
 * The case where the profile is linked in the same request is in
 * manual-media.test.ts («a piece that was stored before its publisher was
 * known»).
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
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { linkProfile } from '@/lib/person-profiles'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.media.deleteMany()
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
  net.apifyConfigured = true
  net.posts.clear()
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

async function add(campaignId: string, body: Record<string, unknown>) {
  const request = new NextRequest(`http://localhost/api/campaigns/${campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: campaignId }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json()) as any }
}

describe('re-adding a piece through a profile that is already hers', () => {
  it('fills in who published it, links nothing new and creates nothing', async () => {
    const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
    net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Marca Demo - Octubre (test)', status: 'ACTIVE',
        startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
        targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: pm.id,
      },
    })
    const alba = await prisma.influencer.create({ data: { username: 'alba_prueba', platform: 'INSTAGRAM', followers: 2100 } })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: alba.id, status: 'COMPLETED' } })
    // Her second Instagram account, registered as hers some time ago
    const second = await prisma.influencer.create({ data: { username: 'alba.otra_cuenta', platform: 'INSTAGRAM', followers: 19 } })
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: second.id, actor: null, evidence: 'pm_manual' })

    // Added while the network could not be read: no author, the PM picked her and typed the date
    const url = 'https://www.instagram.com/reel/DfReAnadida01/'
    net.apifyConfigured = false
    const first = await add(campaign.id, { url, influencerId: alba.id, postedAt: '2026-10-11T10:00:00.000Z', views: 9000 })
    expect(first.status).toBe(201)
    expect(first.body.media.publishedByInfluencerId).toBeNull()

    // Pasted again with the network back: the scraper names her second account
    net.apifyConfigured = true
    net.posts.set(url, {
      externalId: '3745000000000000701', caption: 'Desde mi otra cuenta #marcademo', likes: 700, comments: 30, views: 9500, thumbnailUrl: null,
      postedAt: '2026-10-11T10:00:00.000Z', ownerUsername: 'alba.otra_cuenta', mediaType: 'REEL', hashtags: ['#marcademo'], mentions: [],
    } satisfies ScrapedSinglePost)
    const before = { influencers: await prisma.influencer.count(), persons: await prisma.person.count(), logs: await prisma.personLog.count() }

    const again = await add(campaign.id, { url })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, linkedProfile: null })
    expect(again.body.media).toMatchObject({ id: first.body.media.id, influencerId: alba.id, publishedByInfluencerId: second.id, views: 9500 })
    expect(again.body.media.publishedBy).toMatchObject({ username: 'alba.otra_cuenta', platform: 'INSTAGRAM' })
    expect({ influencers: await prisma.influencer.count(), persons: await prisma.person.count(), logs: await prisma.personLog.count() }).toEqual(before)
    expect(await prisma.media.count()).toBe(1)

    // What the report reads: still her row, published from her other account
    const overview = await computeCampaignOverview(campaign.id, { rates: DEFAULT_EMV_RATES })
    expect(overview!.totals.members).toBe(1)
    const piece = overview!.perMedia.find(m => m.id === first.body.media.id)
    expect(piece?.publishedBy).toMatchObject({ influencerId: second.id, username: 'alba.otra_cuenta', platform: 'INSTAGRAM' })
  })
})
