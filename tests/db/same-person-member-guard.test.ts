/**
 * A creator is a person: once her TikTok is linked to her Instagram (or folded
 * into her row), her TikTok profile must never become a second member of a
 * campaign where she already is, whichever way a PM tries: add one, bulk add,
 * move or copy from another campaign.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeStoriesDetailed: blocked('scrapeStoriesDetailed'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfigured: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
    checkApifyAuth: vi.fn(async () => 'unknown'),
  }
})
const session = { id: 'u-pm', email: 'pm@example.test', name: 'Laura PM', role: 'EMPLOYEE' }
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<typeof import('@/lib/auth')>()), getSession: vi.fn(async () => session) }))
// Side effects of adding a member that are not under test
vi.mock('@/lib/campaign-capture', async (orig) => ({ ...(await orig<typeof import('@/lib/campaign-capture')>()), triggerMemberCapture: vi.fn() }))

import { prisma } from '@/lib/db'
import { linkProfile } from '@/lib/person-profiles'
import { POST as addOne } from '@/app/api/campaigns/[id]/influencers/route'
import { POST as moveOrCopy } from '@/app/api/campaigns/[id]/influencers/move/route'

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.contact.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaignAssignment.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}
beforeEach(reset)
afterAll(reset)

async function setup() {
  await prisma.user.create({ data: { id: session.id, email: session.email, password: 'x', name: session.name, role: 'EMPLOYEE' } })
  const mk = (name: string) => prisma.campaign.create({
    data: { name, userId: session.id, startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-30T00:00:00Z'), platforms: ['INSTAGRAM', 'TIKTOK'], targetAccounts: ['vileda.es'] },
  })
  const target = await mk('Noviembre')
  const source = await mk('Octubre')
  const ig = await prisma.influencer.create({ data: { username: 'ale_ficticia', platform: 'INSTAGRAM' } })
  const tk = await prisma.influencer.create({ data: { username: 'ale_ficticia', platform: 'TIKTOK' } })
  await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tk.id, actor: { id: session.id, name: session.name }, evidence: 'pm_manual' })
  await prisma.campaignInfluencer.create({ data: { campaignId: target.id, influencerId: ig.id, source: 'manual', agreedFee: 100 } })
  return { target, source, ig, tk }
}

const req = (url: string, body: unknown) => new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('a linked profile never becomes a second member', () => {
  it('add one: 409 naming the creator, nothing created', async () => {
    const { target, tk } = await setup()
    const res = await addOne(req(`http://t/api/campaigns/${target.id}/influencers`, { influencerId: tk.id }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('same_person')
    expect(body.error).toContain('@ale_ficticia')
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: target.id } })).toBe(1)
  })

  it('add one: an unlinked profile with the same handle is still added (no guessing on handles)', async () => {
    const { target } = await setup()
    const other = await prisma.influencer.create({ data: { username: 'ale_ficticia', platform: 'YOUTUBE' } })
    const res = await addOne(req(`http://t/api/campaigns/${target.id}/influencers`, { influencerId: other.id }), { params: Promise.resolve({ id: target.id }) })
    expect(res.status).toBe(201)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: target.id } })).toBe(2)
  })

  it('copy from another campaign: the linked profile is skipped as already there', async () => {
    const { target, source, tk } = await setup()
    await prisma.campaignInfluencer.create({ data: { campaignId: source.id, influencerId: tk.id, source: 'manual' } })
    const res = await moveOrCopy(
      req(`http://t/api/campaigns/${source.id}/influencers/move`, { targetCampaignId: target.id, influencerIds: [tk.id], mode: 'copy' }),
      { params: Promise.resolve({ id: source.id }) }
    )
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBeLessThan(300)
    expect(JSON.stringify(body)).toContain('ale_ficticia')
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: target.id } })).toBe(1)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: source.id } })).toBe(1)
  })
})
