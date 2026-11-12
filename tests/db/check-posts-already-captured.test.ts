/**
 * GET /api/cron/check-posts decides that a post is "already captured" in a
 * campaign by the POST (externalId + network + campaign, the key a campaign
 * holds one row by), not by the creator row it is filed under (review of
 * delivery 1, 12 Nov 2026).
 *
 * By influencerId, a post that the campaign already holds under another row
 * was taken for new on every run and announced again («@x ha publicado») every
 * day: a creator's TikTok video credited to her Instagram row once that TikTok
 * account is also a member, or a collab post filed under the other creator.
 *
 * The network is mocked: the profile read (fetchProfile) answers from a table
 * and Apify reports itself out of budget so the views refresh does not run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ profiles: new Map<string, unknown>() }))

vi.mock('@/lib/apify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apify')>()
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    ...real,
    isApifyConfiguredAsync: vi.fn(async () => true),
    checkApifyAuth: vi.fn(async () => 'ok'),
    // "Exhausted" only skips the views refresh that runs after the capture
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
import type { Platform } from '@/generated/prisma/client'
import { GET } from '@/app/api/cron/check-posts/route'
import { linkProfile } from '@/lib/person-profiles'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

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
  vi.clearAllMocks()
  net.profiles.clear()
  delete process.env.CRON_SECRET
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

function post(platform: Platform, handle: string, externalId: string, permalinkCode: string): ScrapedPost {
  return {
    externalId,
    caption: 'Probando la mopa nueva #marcademo',
    mediaUrl: null,
    thumbnailUrl: null,
    permalink: platform === 'TIKTOK' ? `https://www.tiktok.com/@${handle}/video/${externalId}` : `https://www.instagram.com/p/${permalinkCode}/`,
    mediaType: platform === 'TIKTOK' ? 'VIDEO' : 'POST',
    likes: 120, comments: 4, shares: 0, saves: 0, views: 5400,
    postedAt: '2026-10-12T10:00:00.000Z',
    hashtags: ['marcademo'],
    mentions: [],
  }
}

function serve(platform: Platform, username: string, posts: ScrapedPost[]) {
  const profile: ScrapedProfile = {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: posts,
  }
  net.profiles.set(`${platform}:${username}`, profile)
}

async function run(): Promise<Record<string, unknown>> {
  const response = await GET(new NextRequest('http://localhost/api/cron/check-posts?force=1'))
  return response.json()
}

describe('check-posts: a post the campaign already holds is not new, whoever it is filed under', () => {
  it('holds a linked profile’s video credited to the member and a collab post filed under the other creator; stores and announces only what is new, once', async () => {
    const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
    const campaign = await prisma.campaign.create({
      data: {
        name: 'Marca Demo - Octubre (test)', status: 'ACTIVE',
        startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
        targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: pm.id,
      },
    })
    const member = async (username: string, platform: Platform) => {
      const row = await prisma.influencer.create({ data: { username, platform } })
      await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: row.id, status: 'COMPLETED' } })
      return row
    }

    // Alba (Instagram) and her TikTok, linked as one person. Her TikTok video is
    // in the campaign under her Instagram row; then a PM also added the TikTok
    // account as a member in Elegir (what the old discovery notice invited).
    const alba = await member('alba_prueba', 'INSTAGRAM')
    const albaTikTok = await member('alba.tiktok', 'TIKTOK')
    await linkProfile({ memberInfluencerId: alba.id, profileInfluencerId: albaTikTok.id, actor: null, evidence: 'pm_manual' })
    const video = post('TIKTOK', 'alba.tiktok', '7690000000000000001', '')
    const held = await prisma.media.create({
      data: {
        externalId: video.externalId, platform: 'TIKTOK', mediaType: 'VIDEO', permalink: video.permalink, views: 5000, likes: 100,
        postedAt: new Date(video.postedAt!), hashtags: video.hashtags, source: 'apify',
        influencerId: alba.id, publishedByInfluencerId: albaTikTok.id, campaignId: campaign.id,
      },
    })

    // A collab post of Ana and Bea: the campaign holds it under Ana
    const ana = await member('ana_prueba', 'INSTAGRAM')
    const bea = await member('bea_prueba', 'INSTAGRAM')
    const collab = post('INSTAGRAM', 'bea_prueba', '3745000000000000501', 'DfColabAnaBea')
    await prisma.media.create({
      data: {
        externalId: collab.externalId, platform: 'INSTAGRAM', mediaType: 'POST', permalink: collab.permalink, views: 0, likes: 300,
        postedAt: new Date(collab.postedAt!), hashtags: collab.hashtags, source: 'apify', influencerId: ana.id, campaignId: campaign.id,
      },
    })

    // Bea's genuinely new post. Its id equals the id of a row of ANOTHER network
    // in the campaign: never the same post (ids are per network).
    const fresh = post('INSTAGRAM', 'bea_prueba', '7690000000000000002', 'DfNuevoBea01')
    await prisma.media.create({
      data: {
        externalId: fresh.externalId, platform: 'TIKTOK', mediaType: 'VIDEO', permalink: 'https://www.tiktok.com/@alba.tiktok/video/7690000000000000002',
        postedAt: new Date('2026-10-13T10:00:00Z'), hashtags: ['marcademo'], source: 'apify',
        influencerId: alba.id, publishedByInfluencerId: albaTikTok.id, campaignId: campaign.id,
      },
    })

    serve('TIKTOK', 'alba.tiktok', [video])
    serve('INSTAGRAM', 'bea_prueba', [collab, fresh])
    serve('INSTAGRAM', 'alba_prueba', [])
    serve('INSTAGRAM', 'ana_prueba', [])
    const mediaBefore = await prisma.media.count()

    const first = await run()
    expect(first).toMatchObject({ success: true, influencersChecked: 4, newPosts: 1 })
    // Only Bea's new post entered, under her
    expect(await prisma.media.count()).toBe(mediaBefore + 1)
    expect(await prisma.media.findFirstOrThrow({ where: { externalId: fresh.externalId, platform: 'INSTAGRAM' } })).toMatchObject({
      influencerId: bea.id, publishedByInfluencerId: null, campaignId: campaign.id,
    })
    // The rows it already held are untouched: the video stays credited to Alba, published by her TikTok
    expect(await prisma.media.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ influencerId: alba.id, publishedByInfluencerId: albaTikTok.id, views: 5000 })
    expect(await prisma.media.count({ where: { externalId: collab.externalId } })).toBe(1)
    // One notice, about the new post only
    const notices = await prisma.notification.findMany({ select: { title: true, message: true } })
    expect(notices.map(n => n.title)).toEqual(['@bea_prueba ha publicado'])
    expect(notices[0].message).toContain('DfNuevoBea01')

    // The next day: nothing is new, nothing is announced again
    const second = await run()
    expect(second).toMatchObject({ success: true, influencersChecked: 4, newPosts: 0 })
    expect(await prisma.media.count()).toBe(mediaBefore + 1)
    expect(await prisma.notification.count()).toBe(1)
  }, 60_000)
})
