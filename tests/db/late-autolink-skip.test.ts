/**
 * The daily TikTok pass and a video that already counts LATE in another
 * campaign (review of 13 Nov 2026). The video is not this campaign's: it is
 * skipped with its reason and counted in the summary, never a failure (which
 * would re-read the pair from the start every day at Apify's cost and show it
 * as failed), and it is never the evidence that links a TikTok account.
 * Real (throwaway) database, invented handles, network mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeTikTokProfilesBatch: vi.fn(),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    isApifyExhausted: vi.fn(() => false),
  }
})
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { prisma } from '@/lib/db'
import { scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedPost, ScrapedProfile, TikTokProfilesBatch } from '@/lib/apify'
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
beforeEach(async () => { await reset(); batch.mockReset() })
afterAll(reset)

const LATE_VIDEO = '7698000000000000001'
const NEW_VIDEO = '7698000000000000002'
function video(handle: string, id: string, postedAt: string): ScrapedPost {
  return {
    externalId: id, caption: 'Probando la fregona nueva #marcademo', mediaUrl: null, thumbnailUrl: null,
    permalink: `https://www.tiktok.com/@${handle}/video/${id}`, mediaType: 'VIDEO', likes: 120, comments: 4, shares: 3, saves: 2, views: 5400,
    postedAt, hashtags: ['marcademo'], mentions: [],
  }
}
function account(username: string, videos: ScrapedPost[]): ScrapedProfile {
  return {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: videos,
  }
}

async function seed() {
  const user = await prisma.user.create({ data: { email: `pm-${Date.now()}@example.test`, password: 'x', name: 'PM' } })
  const base = { targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'] as ('INSTAGRAM' | 'TIKTOK')[], userId: user.id, status: 'ACTIVE' as const, type: 'INFLUENCER_TRACKING' as const }
  const oct = await prisma.campaign.create({ data: { ...base, name: 'Octubre (test)', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z') } })
  const nov = await prisma.campaign.create({ data: { ...base, name: 'Noviembre (test)', startDate: new Date('2026-11-01T00:00:00Z'), endDate: new Date('2026-11-30T00:00:00Z') } })
  // A recurring creator: she owes October and is also confirmed in November
  const ig = await prisma.influencer.create({ data: { username: 'creadora_tt_demo', platform: 'INSTAGRAM', followers: 900 } })
  await prisma.campaignInfluencer.create({ data: { campaignId: oct.id, influencerId: ig.id, status: 'CONTRACTED' } })
  await prisma.campaignInfluencer.create({ data: { campaignId: nov.id, influencerId: ig.id, status: 'CONTRACTED' } })
  // The PM added her 5 Nov TikTok video to October «fuera de plazo» (what the manual route stores)
  await prisma.media.create({
    data: {
      externalId: LATE_VIDEO, platform: 'TIKTOK', mediaType: 'VIDEO', permalink: `https://www.tiktok.com/@creadora_tt_demo/video/${LATE_VIDEO}`,
      caption: 'Probando la fregona nueva #marcademo', hashtags: ['#marcademo'], mentions: [], postedAt: new Date('2026-11-05T10:00:00Z'),
      source: 'manual', dataSource: 'apify', influencerId: ig.id, campaignId: oct.id,
    },
  })
  return { oct, nov, ig }
}

describe('the daily TikTok pass and a video that counts late elsewhere', () => {
  it('it is a skip with its reason, not a failure: the pair is read and stamped, nothing is linked on its evidence, no false notice', async () => {
    const { nov, oct } = await seed()
    batch.mockImplementation(async (handles: string[]) => {
      const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
      for (const h of handles) if (h === 'creadora_tt_demo') out.profiles.set(h, account(h, [video(h, LATE_VIDEO, '2026-11-05T10:00:00.000Z')]))
      return out
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let first, second
    try {
      first = await runTikTokAutolink({ now: new Date('2026-11-10T12:00:00Z') })
      second = await runTikTokAutolink({ now: new Date('2026-11-11T12:00:00Z') })
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/TIKTOK:7698000000000000001 not stored in campaign .*already counts late .*«Octubre \(test\)»/)
    } finally {
      warn.mockRestore()
    }
    for (const run of [first, second]) {
      expect(run.failed).toEqual([])
      expect(run.partial).toBe(false)
      expect(run.skippedLateElsewhere).toBe(1)
      expect(run.videos).toBe(0)
      expect(run.linked).toBe(0)
    }
    // The second pass is a daily read (the pair was stamped), not a first read back to the start
    expect(batch.mock.calls[0][1]).toMatchObject({ resultsPerPage: 100 })
    expect(batch.mock.calls[1][1]).not.toMatchObject({ resultsPerPage: 100 })
    // The video stays only in October; no TikTok profile was linked on its evidence; no notice says it entered
    expect(await prisma.media.count({ where: { externalId: LATE_VIDEO, campaignId: nov.id } })).toBe(0)
    expect(await prisma.media.count({ where: { externalId: LATE_VIDEO, campaignId: oct.id } })).toBe(1)
    expect(await prisma.influencer.count({ where: { username: 'creadora_tt_demo', platform: 'TIKTOK', personId: { not: null } } })).toBe(0)
    expect(await prisma.notification.count({ where: { title: 'TikTok vinculado' } })).toBe(0)
  })

  it('another video of the campaign in the same read still enters, and it is the one that links the account', async () => {
    const { nov } = await seed()
    batch.mockImplementation(async (handles: string[]) => {
      const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
      for (const h of handles) if (h === 'creadora_tt_demo') {
        out.profiles.set(h, account(h, [video(h, LATE_VIDEO, '2026-11-05T10:00:00.000Z'), video(h, NEW_VIDEO, '2026-11-08T10:00:00.000Z')]))
      }
      return out
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let run
    try {
      run = await runTikTokAutolink({ now: new Date('2026-11-10T12:00:00Z') })
    } finally {
      warn.mockRestore()
    }
    expect(run).toMatchObject({ failed: [], partial: false, skippedLateElsewhere: 1, videos: 1, linked: 1 })
    expect((await prisma.media.findMany({ where: { campaignId: nov.id }, select: { externalId: true } })).map(m => m.externalId)).toEqual([NEW_VIDEO])
    const notice = await prisma.notification.findFirstOrThrow({ where: { title: 'TikTok vinculado' } })
    expect(notice.message).toContain('Se ha capturado 1 vídeo en "Noviembre (test)"')
  })
})
