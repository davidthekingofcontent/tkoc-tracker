/**
 * POST /api/influencers/[id]/link-profile — «Añadir perfil de TikTok» in Elegir
 * (review of 16 Nov 2026, point 5): a PM registers a creator's TikTok by hand,
 * with no video to prove it, so the daily pass can read it.
 *
 * Staff only, checked by the route itself. It finds or creates the profile row
 * (never scrapes), links it to the creator's person with evidence 'pm_manual'
 * and a PersonLog row, refuses a brand account and a profile of another person,
 * never creates a membership and never touches Media. Afterwards the daily
 * TikTok pass reads the account as "known" (the network is mocked).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ session: null as null | { id: string; email: string; name: string; role: string } }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => auth.session) }
})
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeTikTokProfilesBatch: vi.fn(),
    isApifyExhausted: vi.fn(() => false),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
  }
})
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedProfile, TikTokProfilesBatch } from '@/lib/apify'
import { POST } from '@/app/api/influencers/[id]/link-profile/route'
import { linkProfile } from '@/lib/person-profiles'
import { runTikTokAutolink } from '@/lib/tiktok-autolink'

const batch = vi.mocked(scrapeTikTokProfilesBatch)

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

beforeEach(async () => {
  await reset()
  auth.session = null
  batch.mockReset()
})
afterAll(reset)

async function link(creatorId: string, body: unknown) {
  const request = new NextRequest(`http://localhost/api/influencers/${creatorId}/link-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: creatorId }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json()) as any }
}

/** A live campaign (Instagram + TikTok, brand @marca.demo / #marcademo) with one CONTRACTED Instagram creator in PROSPECT-free state. */
async function fixture() {
  const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo - Noviembre (test)', status: 'ACTIVE',
      startDate: new Date(Date.now() - 10 * 86_400_000), endDate: new Date(Date.now() + 15 * 86_400_000),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
    },
  })
  const creator = await prisma.influencer.create({ data: { username: 'ale_ficticia', platform: 'INSTAGRAM', followers: 2382, displayName: 'Ale Ficticia' } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: creator.id, status: 'CONTRACTED' } })
  return { pm, campaign, creator }
}

async function counts() {
  return {
    influencers: await prisma.influencer.count(),
    memberships: await prisma.campaignInfluencer.count(),
    persons: await prisma.person.count(),
    logs: await prisma.personLog.count(),
    media: await prisma.media.count(),
  }
}

describe('POST /api/influencers/[id]/link-profile', () => {
  it('is staff only, checked by the route: no session 401, a brand or a creator 403, and nothing is created', async () => {
    const { creator } = await fixture()
    const before = await counts()
    auth.session = null
    expect((await link(creator.id, { platform: 'TIKTOK', username: 'ale.nueva' })).status).toBe(401)
    for (const role of ['BRAND', 'CREATOR']) {
      auth.session = { id: 'u-x', email: 'x@example.test', name: 'X', role }
      expect((await link(creator.id, { platform: 'TIKTOK', username: 'ale.nueva' })).status, role).toBe(403)
    }
    expect(await counts()).toEqual(before)
  })

  it('links a TikTok account that has no row yet: creates the bare profile (followers 0, never scraped), one person, a pm_manual log; no membership, no media', async () => {
    const { pm, campaign, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const before = await counts()

    const res = await link(creator.id, { platform: 'tiktok', username: '@Ale.Nueva', campaignId: campaign.id })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      logId: expect.any(String),
      personId: expect.any(String),
      alreadyLinked: false,
      profile: { id: expect.any(String), username: 'Ale.Nueva', platform: 'TIKTOK', created: true },
    })

    const profile = await prisma.influencer.findUniqueOrThrow({ where: { id: res.body.profile.id } })
    expect(profile).toMatchObject({ username: 'Ale.Nueva', platform: 'TIKTOK', followers: 0, lastScraped: null, personId: res.body.personId, addedById: pm.id })
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: creator.id } })).personId).toBe(res.body.personId)
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: res.body.logId } })
    expect(log).toMatchObject({ action: 'link_profile', evidence: 'pm_manual', actorId: pm.id, actorName: 'Laura PM', personId: res.body.personId })
    expect(log.summary).toContain('@Ale.Nueva (TikTok) añadido como perfil de @ale_ficticia (Instagram)')
    expect(log.summary).toContain('Marca Demo - Noviembre (test)')
    expect(await counts()).toEqual({ ...before, influencers: before.influencers + 1, persons: before.persons + 1, logs: before.logs + 1 })

    // The same request again: idempotent, no second log
    const again = await link(creator.id, { platform: 'TIKTOK', username: 'ale.nueva' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ alreadyLinked: true, logId: null, profile: { id: profile.id, created: false } })
    expect(await prisma.personLog.count()).toBe(before.logs + 1)
  })

  it('accepts the profile URL and reuses an existing row whatever its casing', async () => {
    const { pm, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'ADMIN' }
    const existing = await prisma.influencer.create({ data: { username: 'Ale.Nueva', platform: 'TIKTOK', followers: 29000 } })
    const res = await link(creator.id, { platform: 'TIKTOK', username: 'https://www.tiktok.com/@ale.nueva?lang=es' })
    expect(res.status).toBe(200)
    expect(res.body.profile).toEqual({ id: existing.id, username: 'Ale.Nueva', platform: 'TIKTOK', created: false })
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: existing.id } }))).toMatchObject({ followers: 29000, personId: res.body.personId })
  })

  it('refuses a brand account of her campaign (a target, or the brand’s connected Instagram) and creates no row', async () => {
    const { pm, campaign, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const before = await counts()
    const target = await link(creator.id, { platform: 'TIKTOK', username: '@marca.demo' })
    expect(target.status).toBe(409)
    expect(target.body).toMatchObject({ code: 'brand_account' })
    expect(target.body.error).toContain('@marca.demo es una cuenta de la marca de "Marca Demo - Noviembre (test)"')

    // The brand's connected Instagram, not typed among the targets
    await prisma.setting.create({ data: { key: `campaign_brand_${campaign.id}`, value: 'brand-demo' } })
    await prisma.setting.create({ data: { key: 'brand_ig_brand-demo', value: 'marcademo.oficial' } })
    const own = await link(creator.id, { platform: 'INSTAGRAM', username: 'marcademo.oficial' })
    expect(own.status).toBe(409)
    expect(own.body).toMatchObject({ code: 'brand_account' })
    expect(await counts()).toEqual(before)
  })

  it('a campaignId the creator is not in, or an invented one, never narrows the brand guard (18 Nov 2026): still 409 brand_account', async () => {
    const { pm, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const before = await counts()
    // An invented campaign: her own campaigns are still checked
    const invented = await link(creator.id, { platform: 'TIKTOK', username: 'marca.demo', campaignId: 'no-such-campaign' })
    expect(invented.status).toBe(409)
    expect(invented.body).toMatchObject({ code: 'brand_account' })
    // A real campaign she is NOT in, whose brand account is the handle: checked too (a union, never a narrowing)
    const other = await prisma.campaign.create({
      data: {
        name: 'Otra Marca - Demo (test)', status: 'ACTIVE',
        startDate: new Date(Date.now() - 5 * 86_400_000), endDate: new Date(Date.now() + 20 * 86_400_000),
        targetAccounts: ['otra.marca'], targetHashtags: [], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
      },
    })
    const foreign = await link(creator.id, { platform: 'TIKTOK', username: '@otra.marca', campaignId: other.id })
    expect(foreign.status).toBe(409)
    expect(foreign.body).toMatchObject({ code: 'brand_account' })
    expect(foreign.body.error).toContain('"Otra Marca - Demo (test)"')
    expect(await counts()).toEqual(before)
  })

  it('refuses a profile that already belongs to ANOTHER person, naming her, and changes nothing', async () => {
    const { pm, campaign, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const other = await prisma.influencer.create({ data: { username: 'otra_creadora', platform: 'INSTAGRAM' } })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: other.id, status: 'CONTRACTED' } })
    const tiktok = await prisma.influencer.create({ data: { username: 'otra.tiktok', platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: { id: pm.id, name: pm.name }, evidence: 'pm_confirmed' })
    const before = await counts()

    const res = await link(creator.id, { platform: 'TIKTOK', username: 'otra.tiktok' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'other_person' })
    expect(res.body.error).toContain('@otra.tiktok (TikTok) ya es perfil de otra persona: @otra_creadora (Instagram)')
    expect(await counts()).toEqual(before)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: creator.id } })).personId).toBeNull()
  })

  it('answers 400 for a bad platform or username, 404 for an unknown creator and 409 for her own row', async () => {
    const { pm, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    expect(await link(creator.id, { platform: 'TWITCH', username: 'ale' })).toMatchObject({ status: 400, body: { code: 'invalid_platform' } })
    expect(await link(creator.id, { platform: 'TIKTOK', username: '' })).toMatchObject({ status: 400, body: { code: 'invalid_username' } })
    expect(await link(creator.id, { platform: 'TIKTOK', username: 'ale ficticia' })).toMatchObject({ status: 400, body: { code: 'invalid_username' } })
    expect(await link(creator.id, { platform: 'TIKTOK', username: 'https://www.tiktok.com/foryou' })).toMatchObject({ status: 400, body: { code: 'invalid_username' } })
    expect(await link(creator.id, { platform: 'TIKTOK', username: 'https://www.instagram.com/ale_ficticia/' })).toMatchObject({ status: 400, body: { code: 'invalid_username' } })
    expect(await link(creator.id, 'not json')).toMatchObject({ status: 400, body: { code: 'invalid_platform' } })
    expect((await link('no-such-creator', { platform: 'TIKTOK', username: 'ale.nueva' })).status).toBe(404)
    expect(await link(creator.id, { platform: 'INSTAGRAM', username: '@Ale_Ficticia' })).toMatchObject({ status: 409, body: { code: 'same_profile' } })
    expect(await prisma.personLog.count()).toBe(0)
    expect(await prisma.influencer.count()).toBe(1)
  })

  it('the daily TikTok pass then reads the linked account as "known" for the confirmed creator (no candidate search, no second member)', async () => {
    const { pm, campaign, creator } = await fixture()
    auth.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    expect((await link(creator.id, { platform: 'TIKTOK', username: 'ale.nueva' })).status).toBe(200)

    const requested: string[][] = []
    batch.mockImplementation(async (handles: string[]) => {
      requested.push([...handles])
      const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
      const profile: ScrapedProfile = {
        username: 'ale.nueva', displayName: null, bio: null, avatarUrl: null, followers: 12000, following: 10, postsCount: 50, engagementRate: 2.5,
        avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: [],
      }
      for (const handle of handles) if (handle === 'ale.nueva') out.profiles.set(handle, profile)
      return out
    })
    const summary = await runTikTokAutolink({ campaignId: campaign.id })
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: campaign.name, candidates: 0, known: 1, linked: [], videos: 0 }])
    expect(requested.flat()).toEqual(['ale.nueva'])
    // Still one member; the read refreshed the bare row
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: campaign.id } })).toBe(1)
    expect((await prisma.influencer.findFirstOrThrow({ where: { username: 'ale.nueva', platform: 'TIKTOK' } })).followers).toBe(12000)
  })
})
