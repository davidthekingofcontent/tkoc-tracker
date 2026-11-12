/**
 * The daily TikTok pass never skips an account silently (review of delivery 1,
 * 12 Nov 2026; David's rule: no capture path stops without telling anyone).
 *
 * A creator's candidate TikTok account that already is a profile of ANOTHER
 * person is not linked and, from then on, not read for that campaign. That
 * skip is:
 *  - in the run summary (summary.notLinked, reason 'other_person'), which the
 *    cron stores in Setting cron_tiktok-link_last_result;
 *  - told ONCE to the campaign team («TikTok sin vincular», naming both
 *    creators), again only if it stops and later comes back; not told when the
 *    account is read anyway for a confirmed member of that other person.
 *
 * The network is mocked (scrapeTikTokProfilesBatch is a stub).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeTikTokProfilesBatch: vi.fn(),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => true),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usedPct: 10, cycleEndsAt: null })),
    checkApifyAuth: vi.fn(async () => 'ok'),
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
import type { Platform } from '@/generated/prisma/client'
import { linkProfile, unlinkProfile } from '@/lib/person-profiles'
import { runTikTokAutolink } from '@/lib/tiktok-autolink'
import type { TikTokAutolinkSummary } from '@/lib/tiktok-autolink'
import { GET as cronTikTokLink } from '@/app/api/cron/tiktok-link/route'

const batch = vi.mocked(scrapeTikTokProfilesBatch)
const NOW = new Date('2026-10-20T12:00:00Z')
const CAMPAIGN = 'Marca Demo - Octubre (test)'
const NOTICE = 'TikTok sin vincular'

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
  batch.mockReset()
  batch.mockImplementation(async () => { throw new Error('scrapeTikTokProfilesBatch: no TikTok account was served to this test') })
  delete process.env.CRON_SECRET
})
afterAll(reset)

function profile(username: string, platform: Platform = 'INSTAGRAM') {
  return prisma.influencer.create({ data: { username, platform } })
}

async function campaignWithPm(dates: { start: Date; end: Date } = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') }) {
  const pm = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: CAMPAIGN, status: 'ACTIVE', startDate: dates.start, endDate: dates.end,
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
    },
  })
  return { campaign, pm }
}

function join(campaignId: string, influencerId: string) {
  return prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED' } })
}

/**
 * In the campaign: Instagram @lucia_prueba. Not in it: another creator,
 * Instagram @lucia.real, whose TikTok @lucia_prueba is registered as hers.
 */
async function skippedCase(dates?: { start: Date; end: Date }) {
  const { campaign, pm } = await campaignWithPm(dates)
  const member = await profile('lucia_prueba')
  await join(campaign.id, member.id)
  const other = await profile('lucia.real')
  const tiktok = await profile('lucia_prueba', 'TIKTOK')
  await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: null, evidence: 'pm_manual' })
  return { campaign, pm, member, other, tiktok }
}

const SKIP = (campaignId: string) => ({ campaignId, campaign: CAMPAIGN, member: 'lucia_prueba', handle: 'lucia_prueba', reason: 'other_person' })
const notices = () => prisma.notification.findMany({ where: { title: NOTICE }, select: { userId: true, message: true, link: true } })

/** TikTok answers for @lucia_prueba with no video of the campaign */
function serveNothingNew() {
  batch.mockImplementation(async (handles: string[]) => {
    const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
    for (const handle of handles) {
      out.profiles.set(handle, {
        username: handle, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 5, engagementRate: 1,
        avgLikes: 1, avgComments: 0, avgViews: 10, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: [],
      } satisfies ScrapedProfile)
    }
    return out
  })
}

describe('a candidate TikTok account that already is a profile of another person', () => {
  it('is reported in the run summary on every pass and told to the team once, naming both creators', async () => {
    const { campaign, pm } = await skippedCase()

    const first = await runTikTokAutolink({ now: NOW })
    expect(batch).not.toHaveBeenCalled()
    expect(first.notLinked).toEqual([SKIP(campaign.id)])
    expect(await notices()).toEqual([{
      userId: pm.id,
      message: `@lucia_prueba (TikTok) no se ha añadido como perfil de @lucia_prueba en "${CAMPAIGN}": ya es un perfil de @lucia.real (Instagram). Sus vídeos de TikTok no entran solos en esta campaña. Si son la misma persona, avisa a David: todavía no se pueden unir desde la plataforma.`,
      link: `/campaigns/${campaign.id}`,
    }])

    // Next day: still in the summary, not told again
    const second = await runTikTokAutolink({ now: new Date(NOW.getTime() + 86_400_000) })
    expect(second.notLinked).toEqual([SKIP(campaign.id)])
    expect(await notices()).toHaveLength(1)
  })

  it('is told again when it comes back after it was solved', async () => {
    const { campaign, other, tiktok } = await skippedCase()
    await runTikTokAutolink({ now: NOW })
    expect(await notices()).toHaveLength(1)

    // Solved: the TikTok is no longer the other creator's. The pass reads it (nothing of the campaign yet)
    await unlinkProfile({ profileInfluencerId: tiktok.id, actor: null, reason: 'test' })
    serveNothingNew()
    const freed = await runTikTokAutolink({ now: new Date(NOW.getTime() + 86_400_000) })
    expect(freed.notLinked).toEqual([])
    expect(batch).toHaveBeenCalledTimes(1)

    // It comes back: told again, once
    await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: null, evidence: 'pm_manual' })
    const back = await runTikTokAutolink({ now: new Date(NOW.getTime() + 2 * 86_400_000) })
    expect(back.notLinked).toEqual([SKIP(campaign.id)])
    expect(await notices()).toHaveLength(2)
  })

  it('is not told when the account is read anyway, for a confirmed member of that other person', async () => {
    const { campaign, other } = await skippedCase()
    await join(campaign.id, other.id)
    serveNothingNew()

    const summary = await runTikTokAutolink({ now: NOW })
    // Reported, and read for @lucia.real (her known profile)
    expect(summary.notLinked).toEqual([SKIP(campaign.id)])
    expect(summary.campaigns[0]).toMatchObject({ known: 1, candidates: 0 })
    expect(batch.mock.calls.flatMap(call => call[0])).toEqual(['lucia_prueba'])
    expect(await notices()).toEqual([])
  })

  it('a campaign with nobody active to tell is told on the first pass that has someone', async () => {
    const { pm } = await skippedCase()
    await prisma.user.update({ where: { id: pm.id }, data: { isActive: false } })
    await runTikTokAutolink({ now: NOW })
    expect(await notices()).toEqual([])

    await prisma.user.update({ where: { id: pm.id }, data: { isActive: true } })
    await runTikTokAutolink({ now: new Date(NOW.getTime() + 86_400_000) })
    expect((await notices()).map(n => n.userId)).toEqual([pm.id])
  })

  it('the daily cron stores the run summary with the skip', async () => {
    // A campaign live today, whatever today is
    const day = 86_400_000
    const { campaign } = await skippedCase({ start: new Date(Date.now() - 10 * day), end: new Date(Date.now() + 10 * day) })

    const response = await cronTikTokLink(new NextRequest('http://localhost/api/cron/tiktok-link'))
    expect(response.status).toBe(200)
    const stored = await prisma.setting.findUniqueOrThrow({ where: { key: 'cron_tiktok-link_last_result' } })
    const summary = JSON.parse(stored.value) as TikTokAutolinkSummary
    expect(summary.notLinked).toEqual([SKIP(campaign.id)])
    expect(await notices()).toHaveLength(1)
  })
})
