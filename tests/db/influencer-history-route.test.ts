/**
 * GET /api/influencers/[id]/history after the review of 16 Nov 2026 (point 3):
 *  - the history is the PERSON's: the memberships of every linked profile
 *    (Instagram + TikTok) are added up, whichever profile is asked for;
 *  - one row per campaign, ordered by the campaign's start date (newest first),
 *    not by the membership's createdAt; campaigns without dates last;
 *  - reliability counts only the agreed campaigns (AGREED or later): being a
 *    PROSPECT in a pool neither counts nor penalises;
 *  - the EMV of a row is the member's row of the overview, which already
 *    credits what her other profile published.
 * Real throwaway database, no network (the overview never scrapes). Every
 * handle and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ session: null as null | { id: string; email: string; name: string; role: string } }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => auth.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { InfluencerStatus } from '@/generated/prisma/client'
import { GET } from '@/app/api/influencers/[id]/history/route'
import { linkProfile } from '@/lib/person-profiles'

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

async function history(influencerId: string) {
  const request = new NextRequest(`http://localhost/api/influencers/${influencerId}/history`)
  const response = await GET(request, { params: Promise.resolve({ id: influencerId }) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (await response.json()) as any }
}

const PM = { id: '', name: 'Laura PM' }

async function pm() {
  const user = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  PM.id = user.id
  auth.session = { id: user.id, email: user.email, name: user.name, role: 'EMPLOYEE' }
  return user
}

/** A campaign always has a start date (the schema requires it); the end date is optional (listening campaigns). */
async function campaign(name: string, startDate: string, endDate: string | null) {
  return prisma.campaign.create({
    data: {
      name,
      type: 'INFLUENCER_TRACKING',
      targetAccounts: ['marca.demo'],
      targetHashtags: [],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      startDate: new Date(startDate),
      endDate: endDate ? new Date(endDate) : null,
      userId: PM.id,
    },
  })
}

function member(campaignId: string, influencerId: string, status: InfluencerStatus, agreedFee: number | null = null, createdAt?: string) {
  return prisma.campaignInfluencer.create({
    data: { campaignId, influencerId, status, agreedFee, ...(createdAt ? { createdAt: new Date(createdAt) } : {}) },
  })
}

describe('GET /api/influencers/[id]/history', () => {
  it('needs a session and a known profile', async () => {
    await pm()
    const ig = await prisma.influencer.create({ data: { username: 'sola_inventada', platform: 'INSTAGRAM' } })
    auth.session = null
    expect((await history(ig.id)).status).toBe(401)
    await pm()
    expect((await history('no-such-profile')).status).toBe(404)
    const ok = await history(ig.id)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ totalCampaigns: 0, priceHistory: [], profiles: [{ id: ig.id, username: 'sola_inventada', platform: 'INSTAGRAM' }] })
    expect(ok.body.score.reliabilityBasis).toEqual({ delivered: 0, closed: 0 })
  })

  it('adds up the campaigns of every linked profile of the person, whichever profile is asked for, newest start date first', async () => {
    await pm()
    const ig = await prisma.influencer.create({ data: { username: 'vane_inventada', platform: 'INSTAGRAM', engagementRate: 3 } })
    const tt = await prisma.influencer.create({ data: { username: 'vane.inventada.tt', platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_confirmed' })

    const oct = await campaign('Marca Demo - Micros Octubre (prueba)', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')
    const nov = await campaign('Marca Demo - Micros Noviembre (prueba)', '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z')
    const pool = await campaign('Seleccion de Micros (prueba)', '2026-09-01T00:00:00Z', '2026-12-31T00:00:00Z')
    const openEnded = await campaign('Escucha sin fin (prueba)', '2026-08-01T00:00:00Z', null)

    // Memberships created in an order that is NOT the chronological one of the campaigns
    await member(pool.id, ig.id, 'PROSPECT', null, '2026-11-16T12:00:00Z') // the newest row: a pool, PROSPECT
    await member(nov.id, tt.id, 'CONTRACTED', 250, '2026-11-02T10:00:00Z') // her TikTok is the member here
    await member(oct.id, ig.id, 'COMPLETED', 300, '2026-10-02T10:00:00Z')
    await member(openEnded.id, ig.id, 'AGREED', null, '2026-08-01T10:00:00Z')

    // A video she published from TikTok, credited to her Instagram membership of October
    await prisma.media.create({
      data: { externalId: '7690000000000000901', platform: 'TIKTOK', mediaType: 'VIDEO', views: 12000, likes: 400, comments: 20, influencerId: ig.id, publishedByInfluencerId: tt.id, campaignId: oct.id, postedAt: new Date('2026-10-10T10:00:00Z') },
    })

    const fromIg = await history(ig.id)
    expect(fromIg.status).toBe(200)
    expect(fromIg.body.totalCampaigns).toBe(4)
    expect(fromIg.body.profiles.map((p: { id: string }) => p.id).sort()).toEqual([ig.id, tt.id].sort())
    // By start date, newest first (createdAt order would be pool, nov, oct, openEnded); a missing end date changes nothing
    expect(fromIg.body.priceHistory.map((h: { campaignId: string }) => h.campaignId)).toEqual([nov.id, oct.id, pool.id, openEnded.id])
    expect(fromIg.body.priceHistory[3]).toMatchObject({ campaignId: openEnded.id, endDate: null, status: 'AGREED' })
    const [novRow, octRow, poolRow] = fromIg.body.priceHistory
    expect(novRow).toMatchObject({ campaignName: 'Marca Demo - Micros Noviembre (prueba)', status: 'CONTRACTED', agreedFee: 250, profile: { id: tt.id, username: 'vane.inventada.tt', platform: 'TIKTOK' } })
    expect(novRow.startDate).toBe('2026-11-01T00:00:00.000Z')
    expect(octRow).toMatchObject({ status: 'COMPLETED', agreedFee: 300, profile: { id: ig.id, platform: 'INSTAGRAM' }, media: 1 })
    expect(octRow.emvExtended).toBeGreaterThan(0)
    expect(octRow.ratioEmv).toBeGreaterThan(0)
    expect(poolRow).toMatchObject({ status: 'PROSPECT', agreedFee: null })

    // Asked through her TikTok profile: the same history
    const fromTt = await history(tt.id)
    expect(fromTt.status).toBe(200)
    expect(fromTt.body.totalCampaigns).toBe(4)
    expect(fromTt.body.priceHistory.map((h: { campaignId: string }) => h.campaignId)).toEqual([nov.id, oct.id, pool.id, openEnded.id])
    expect(fromTt.body.priceHistory[1]).toMatchObject({ status: 'COMPLETED', agreedFee: 300, media: 1 })

    // Reliability: published (October) among the agreed ones (October, November, the open-ended AGREED); the pool does not count
    expect(fromIg.body.score.reliabilityBasis).toEqual({ delivered: 1, closed: 3 })
    expect(fromIg.body.score.reliability).toBe(33)
    expect(fromTt.body.score.reliabilityBasis).toEqual({ delivered: 1, closed: 3 })
    // The totals add every profile's cost
    expect(fromIg.body.totals.cost).toBe(550)
  })

  it('a PROSPECT never penalises: a creator with a published campaign and a pool is 100 % reliable; one with only pools has nothing to measure', async () => {
    await pm()
    const ig = await prisma.influencer.create({ data: { username: 'ana_inventada', platform: 'INSTAGRAM' } })
    const oct = await campaign('Micros Octubre (prueba)', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')
    const pool = await campaign('Seleccion de Micros (prueba)', '2026-11-01T00:00:00Z', '2026-12-31T00:00:00Z')
    const dec = await campaign('Micros Diciembre (prueba)', '2026-12-01T00:00:00Z', '2026-12-31T00:00:00Z')
    await member(oct.id, ig.id, 'COMPLETED', 200)
    await member(pool.id, ig.id, 'PROSPECT')
    await member(dec.id, ig.id, 'OUTREACH')

    const res = await history(ig.id)
    expect(res.body.totalCampaigns).toBe(3)
    expect(res.body.score.reliabilityBasis).toEqual({ delivered: 1, closed: 1 })
    expect(res.body.score.reliability).toBe(100)

    // Agreed but not published does count against her
    const sep = await campaign('Micros Septiembre (prueba)', '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z')
    await member(sep.id, ig.id, 'CONTRACTED', 150)
    const again = await history(ig.id)
    expect(again.body.score.reliabilityBasis).toEqual({ delivered: 1, closed: 2 })
    expect(again.body.score.reliability).toBe(50)

    // Only pools: 0 of 0, nothing to measure (and nothing to punish beyond the absence of a record)
    const other = await prisma.influencer.create({ data: { username: 'bea_inventada', platform: 'INSTAGRAM' } })
    await member(pool.id, other.id, 'PROSPECT')
    await member(dec.id, other.id, 'PROSPECT')
    const onlyPools = await history(other.id)
    expect(onlyPools.body.totalCampaigns).toBe(2)
    expect(onlyPools.body.score.reliabilityBasis).toEqual({ delivered: 0, closed: 0 })
    expect(onlyPools.body.score.reliability).toBe(0)
  })

  it('a person twice in the same campaign (older data) is one row there: the profile asked for, else the most advanced status', async () => {
    await pm()
    const ig = await prisma.influencer.create({ data: { username: 'dana_inventada', platform: 'INSTAGRAM' } })
    const tt = await prisma.influencer.create({ data: { username: 'dana.inventada.tt', platform: 'TIKTOK' } })
    const oct = await campaign('Micros Octubre (prueba)', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')
    // Both rows exist BEFORE the link (the member guard forbids adding a second profile of a member)
    await member(oct.id, ig.id, 'CONTRACTED', 180)
    await member(oct.id, tt.id, 'COMPLETED', 90)
    await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_confirmed' })

    const fromIg = await history(ig.id)
    expect(fromIg.body.totalCampaigns).toBe(1)
    expect(fromIg.body.priceHistory).toHaveLength(1)
    expect(fromIg.body.priceHistory[0]).toMatchObject({ campaignId: oct.id, status: 'CONTRACTED', agreedFee: 180, profile: { id: ig.id } })
    expect(fromIg.body.score.reliabilityBasis).toEqual({ delivered: 0, closed: 1 })

    const fromTt = await history(tt.id)
    expect(fromTt.body.priceHistory).toHaveLength(1)
    expect(fromTt.body.priceHistory[0]).toMatchObject({ campaignId: oct.id, status: 'COMPLETED', agreedFee: 90, profile: { id: tt.id } })
  })

  it('a profile that is nobody\'s linked profile sees only its own memberships, as before', async () => {
    await pm()
    const a = await prisma.influencer.create({ data: { username: 'eva_inventada', platform: 'INSTAGRAM' } })
    const b = await prisma.influencer.create({ data: { username: 'eva_inventada', platform: 'TIKTOK' } })
    const oct = await campaign('Micros Octubre (prueba)', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')
    const nov = await campaign('Micros Noviembre (prueba)', '2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z')
    await member(oct.id, a.id, 'COMPLETED', 100)
    await member(nov.id, b.id, 'COMPLETED', 100)
    const res = await history(a.id)
    expect(res.body.totalCampaigns).toBe(1)
    expect(res.body.priceHistory.map((h: { campaignId: string }) => h.campaignId)).toEqual([oct.id])
    expect(res.body.profiles).toEqual([{ id: a.id, username: 'eva_inventada', platform: 'INSTAGRAM' }])
  })
})
