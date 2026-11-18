/**
 * GET /api/cron/check-posts, review of 16 Nov 2026, point 6: a campaign that
 * ended more than 3 days ago is not read any more (133 of the 176 creators read
 * every day in production belonged only to campaigns over since October; rule 2
 * rejects everything they publish now). Each skipped campaign is named in the
 * answer, in the stored summary and in the log. A campaign inside the 3 days of
 * grace, one without an end date and one in dates are read as before. The
 * views refresh of 7 and 14 days is a separate step and is not touched here.
 *
 * The network is mocked: the profile read answers from a table; Apify reports
 * itself exhausted so the views refresh does not run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ profiles: new Map<string, unknown>(), reads: [] as string[] }))

vi.mock('@/lib/apify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apify')>()
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    ...real,
    isApifyConfiguredAsync: vi.fn(async () => true),
    checkApifyAuth: vi.fn(async () => 'ok'),
    isApifyExhausted: vi.fn(() => true),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usedPct: 10, cycleEndsAt: null })),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapePostsBatch: blocked('scrapePostsBatch'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})
vi.mock('@/lib/platform-client', () => ({
  fetchProfile: vi.fn(async (username: string, platform: string) => {
    net.reads.push(`${platform}:${username}`)
    const profile = net.profiles.get(`${platform}:${username}`)
    return profile ? { profile, dataSource: 'apify' } : null
  }),
}))
vi.mock('@/lib/youtube-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/youtube-api')>()), isYouTubeApiConfigured: vi.fn(() => false) }))
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedPost, ScrapedProfile } from '@/lib/apify'
import type { Prisma } from '@/generated/prisma/client'
import { GET } from '@/app/api/cron/check-posts/route'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  net.profiles.clear()
  net.reads.length = 0
  delete process.env.CRON_SECRET
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)
const daysAhead = (n: number) => new Date(Date.now() + n * DAY)

function serve(username: string, posts: ScrapedPost[] = []) {
  const profile: ScrapedProfile = {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: posts,
  }
  net.profiles.set(`INSTAGRAM:${username}`, profile)
}

async function campaignWith(creator: string, over: Partial<Prisma.CampaignUncheckedCreateInput>) {
  const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo (test)', status: 'ACTIVE',
      startDate: daysAgo(10), endDate: daysAhead(10),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: pm.id,
      ...over,
    },
  })
  const row = await prisma.influencer.create({ data: { username: creator, platform: 'INSTAGRAM' } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: row.id, status: 'COMPLETED' } })
  serve(creator)
  return campaign
}

async function run() {
  const response = await GET(new NextRequest('http://localhost/api/cron/check-posts?force=1'))
  return (await response.json()) as Record<string, unknown>
}

describe('check-posts and the campaigns that have ended', () => {
  it('reads the creators of the campaigns in dates, in grace and without end date; names the ended one with its reason and does not read its creator', async () => {
    const ended = await campaignWith('solo_octubre', { name: 'Marca Demo - Octubre (test)', startDate: daysAgo(40), endDate: daysAgo(10) })
    const grace = await campaignWith('ultimo_dia', { name: 'Marca Demo - Gracia (test)', startDate: daysAgo(30), endDate: daysAgo(2) })
    const live = await campaignWith('en_fechas', { name: 'Marca Demo - Noviembre (test)' })
    const open = await campaignWith('anual', { name: 'Marca Demo - Contratos anuales (test)', type: 'SOCIAL_LISTENING', startDate: daysAgo(300), endDate: null })

    const body = await run()
    expect(body).toMatchObject({ success: true, campaignsActive: 3, influencersChecked: 3, newPosts: 0 })
    expect(body.campaignsSkipped).toEqual([{ id: ended.id, name: ended.name, reason: 'ended' }])
    expect(net.reads.sort()).toEqual(['INSTAGRAM:anual', 'INSTAGRAM:en_fechas', 'INSTAGRAM:ultimo_dia'])
    void grace; void live; void open

    // The stored summary says the same, for the Monday review without Railway
    const stored = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'cron_check-posts_last_result' } })).value)
    expect(stored).toMatchObject({ campaignsActive: 3, campaignsSkipped: [{ id: ended.id, reason: 'ended' }], influencersChecked: 3, newPosts: 0, errors: 0, viewsRefresh: { skipped: 'apify_exhausted' } })
  })

  it('a creator who is in an ended campaign AND in a live one is read once, and her new post enters only the live campaign', async () => {
    const ended = await campaignWith('comparte', { name: 'Marca Demo - Octubre (test)', startDate: daysAgo(40), endDate: daysAgo(10) })
    const live = await campaignWith('otra', { name: 'Marca Demo - Noviembre (test)' })
    const shared = await prisma.influencer.findFirstOrThrow({ where: { username: 'comparte' } })
    await prisma.campaignInfluencer.create({ data: { campaignId: live.id, influencerId: shared.id, status: 'CONTRACTED' } })
    serve('comparte', [{
      externalId: '3745000000000000301', caption: 'Nueva mopa #marcademo', mediaUrl: null, thumbnailUrl: null,
      permalink: 'https://www.instagram.com/p/DfNuevoComp/', mediaType: 'REEL', likes: 10, comments: 1, shares: 0, saves: 0, views: 900,
      postedAt: daysAgo(1).toISOString(), hashtags: ['marcademo'], mentions: [],
    }])

    const body = await run()
    expect(body).toMatchObject({ success: true, campaignsActive: 1, influencersChecked: 2, newPosts: 1 })
    expect(body.campaignsSkipped).toEqual([{ id: ended.id, name: ended.name, reason: 'ended' }])
    expect(net.reads.filter(r => r === 'INSTAGRAM:comparte')).toHaveLength(1)
    const rows = await prisma.media.findMany({ where: { externalId: '3745000000000000301' }, select: { campaignId: true, influencerId: true } })
    expect(rows).toEqual([{ campaignId: live.id, influencerId: shared.id }])
  })

  it('when every campaign has ended nothing is read, the answer and the summary still name them', async () => {
    const a = await campaignWith('a_demo', { name: 'Marca Demo - Septiembre (test)', startDate: daysAgo(70), endDate: daysAgo(40) })
    const b = await campaignWith('b_demo', { name: 'Marca Demo - Octubre (test)', startDate: daysAgo(40), endDate: daysAgo(10) })
    const body = await run()
    expect(body).toMatchObject({ message: 'No active campaigns', newPosts: 0 })
    expect((body.campaignsSkipped as Array<{ id: string }>).map(c => c.id).sort()).toEqual([a.id, b.id].sort())
    expect(net.reads).toEqual([])
    const stored = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'cron_check-posts_last_result' } })).value)
    expect(stored).toMatchObject({ campaignsActive: 0, influencersChecked: 0 })
    expect(stored.campaignsSkipped).toHaveLength(2)
    // A completed run with nothing to read is still a run: stamped
    expect(await prisma.setting.findUnique({ where: { key: 'cron_check-posts_last_run' } })).not.toBeNull()
  })
})
