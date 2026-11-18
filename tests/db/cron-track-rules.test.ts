/**
 * GET /api/cron/track (runCronTracking), review of 16 Nov 2026, points 5 and 6:
 *
 *  - a creator of the campaign (a member, or a linked profile of a member's
 *    person) is NEVER skipped by the country filter: that filter only leaves
 *    out foreign authors found by hashtag (in production @elemor_encasa, AR,
 *    member of a Spanish campaign, was skipped 156 times);
 *  - a campaign that ended more than 3 days ago is not read any more and is
 *    named in the summary with its reason; one without an end date is read;
 *  - mentions are not scraped on TikTok/YouTube (not supported): no scrape job,
 *    the targets are named in the summary with the reason 'unsupported'.
 *
 * The network is mocked: the hashtag and mention scrapes answer from tables.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  hashtags: new Map<string, unknown[]>(),
  mentions: new Map<string, unknown[]>(),
}))

vi.mock('@/lib/apify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apify')>()
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    ...real,
    isApifyConfigured: vi.fn(() => true),
    isApifyConfiguredAsync: vi.fn(async () => true),
    checkApifyAuth: vi.fn(async () => 'ok'),
    isApifyExhausted: vi.fn(() => false),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usd: 1, coreLimit: 100, usedPct: 10, cycleEndsAt: null })),
    detectCountry: vi.fn(() => null),
    scrapeHashtag: vi.fn(async (hashtag: string, platform: string) => net.hashtags.get(`${platform}:${hashtag}`) ?? []),
    scrapeAccountMentions: vi.fn(async (account: string, platform: string) => {
      if (platform !== 'INSTAGRAM') throw new Error(`scrapeAccountMentions must not be called for ${platform}`)
      return net.mentions.get(`${platform}:${account}`) ?? []
    }),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapePostsBatch: blocked('scrapePostsBatch'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})
vi.mock('@/lib/youtube-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/youtube-api')>()), isYouTubeApiConfigured: vi.fn(() => false) }))
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { prisma } from '@/lib/db'
import type { HashtagResult, ScrapedPost } from '@/lib/apify'
import { scrapeAccountMentions, scrapeHashtag } from '@/lib/apify'
import type { Platform, Prisma } from '@/generated/prisma/client'
import { runCronTracking } from '@/app/api/cron/track/route'
import { linkProfile } from '@/lib/person-profiles'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.scrapeJob.deleteMany()
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
  net.hashtags.clear()
  net.mentions.clear()
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)
const daysAhead = (n: number) => new Date(Date.now() + n * DAY)

function post(platform: Platform, handle: string, externalId: string): ScrapedPost {
  return {
    externalId,
    caption: 'Probando la mopa nueva #marcademo',
    mediaUrl: null,
    thumbnailUrl: null,
    permalink: platform === 'TIKTOK' ? `https://www.tiktok.com/@${handle}/video/${externalId}` : `https://www.instagram.com/p/C${externalId.slice(-8)}/`,
    mediaType: platform === 'TIKTOK' ? 'VIDEO' : 'REEL',
    likes: 120, comments: 4, shares: 0, saves: 0, views: 5400,
    postedAt: daysAgo(2).toISOString(),
    hashtags: ['marcademo'],
    mentions: [],
  }
}

function author(handle: string, posts: ScrapedPost[], over: Partial<HashtagResult> = {}): HashtagResult {
  return { posts, authorUsername: handle, authorDisplayName: null, authorAvatarUrl: null, authorFollowers: 5000, ...over }
}

async function pm() {
  return prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
}

/** A Spanish campaign in dates with #marcademo on Instagram and TikTok. */
async function spanishCampaign(over: Partial<Prisma.CampaignUncheckedCreateInput> = {}) {
  const user = await pm()
  return prisma.campaign.create({
    data: {
      name: 'Marca Demo - Noviembre (test)', status: 'ACTIVE', country: 'ES',
      startDate: daysAgo(10), endDate: daysAhead(10),
      targetAccounts: [], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: user.id,
      ...over,
    },
  })
}

async function member(campaignId: string, username: string, platform: Platform, extra: Partial<Prisma.InfluencerUncheckedCreateInput> = {}) {
  const row = await prisma.influencer.create({ data: { username, platform, followers: 3000, ...extra } })
  await prisma.campaignInfluencer.create({ data: { campaignId, influencerId: row.id, status: 'CONTRACTED' } })
  return row
}

describe('the country filter never skips a creator of the campaign', () => {
  it('a member from Argentina and a member’s linked TikTok from Brazil enter a Spanish campaign; a foreign non-member is left out and not announced', async () => {
    const campaign = await spanishCampaign()
    const elemor = await member(campaign.id, 'elemor_demo', 'INSTAGRAM', { country: 'AR' })
    const paula = await member(campaign.id, 'paula_demo', 'INSTAGRAM', { country: 'BR' })
    // Paula's TikTok is a linked profile of hers (not a member) and lives in Brazil too
    const paulaTikTok = await prisma.influencer.create({ data: { username: 'paula.tt', platform: 'TIKTOK', country: 'BR', followers: 9000 } })
    await linkProfile({ memberInfluencerId: paula.id, profileInfluencerId: paulaTikTok.id, actor: null, evidence: 'pm_manual' })
    // A foreign author who is nobody's creator: the filter is for her
    await prisma.influencer.create({ data: { username: 'ajena_mx', platform: 'INSTAGRAM', country: 'MX', followers: 8000 } })
    // A Spanish author who is nobody's creator: discovered, as before
    await prisma.influencer.create({ data: { username: 'descubierta_es', platform: 'INSTAGRAM', country: 'ES', followers: 8000 } })

    net.hashtags.set('INSTAGRAM:marcademo', [
      author('elemor_demo', [post('INSTAGRAM', 'elemor_demo', '3745000000000000101')]),
      author('ajena_mx', [post('INSTAGRAM', 'ajena_mx', '3745000000000000102')]),
      author('descubierta_es', [post('INSTAGRAM', 'descubierta_es', '3745000000000000103')]),
    ])
    net.hashtags.set('TIKTOK:marcademo', [
      author('paula.tt', [post('TIKTOK', 'paula.tt', '7690000000000000201')]),
    ])

    const results = await runCronTracking()
    expect(results).toMatchObject({ campaignsProcessed: 1, campaignsSkipped: [], totalPostsFound: 2, countrySkipped: 1, countrySkippedMembers: 0, errors: [] })

    // Elemor's reel is in, under her, although she is from Argentina
    expect(await prisma.media.findFirst({ where: { externalId: '3745000000000000101' } })).toMatchObject({ influencerId: elemor.id, publishedByInfluencerId: null, campaignId: campaign.id })
    // Paula's TikTok video is in, credited to her Instagram row, published by her TikTok
    expect(await prisma.media.findFirst({ where: { externalId: '7690000000000000201' } })).toMatchObject({ influencerId: paula.id, publishedByInfluencerId: paulaTikTok.id, campaignId: campaign.id })
    // The foreign non-member: nothing stored, nobody told
    expect(await prisma.media.count({ where: { externalId: '3745000000000000102' } })).toBe(0)
    expect(await prisma.media.count()).toBe(2)
    const notices = await prisma.notification.findMany({ where: { type: 'creator_discovered' }, select: { message: true } })
    expect(notices.map(n => n.message)).toEqual([expect.stringContaining('@descubierta_es')])
    // Nobody announced Paula's TikTok as a new creator either
    expect(notices.some(n => n.message.includes('paula.tt'))).toBe(false)
  })
})

describe('a brand account registered as a profile of a creator (18 Nov 2026)', () => {
  it('is never credited to her: its posts are left out, named in the summary, and nobody is announced; her own posts still enter', async () => {
    const campaign = await spanishCampaign({ targetAccounts: ['marca.demo'] })
    const marta = await member(campaign.id, 'marta_demo', 'INSTAGRAM', { country: 'ES' })
    // By old data (or a wrong click) the brand's TikTok is a linked profile of Marta
    const brandTikTok = await prisma.influencer.create({ data: { username: 'marca.demo', platform: 'TIKTOK', country: 'ES', followers: 50_000 } })
    await linkProfile({ memberInfluencerId: marta.id, profileInfluencerId: brandTikTok.id, actor: null, evidence: 'pm_manual' })

    net.hashtags.set('TIKTOK:marcademo', [author('marca.demo', [post('TIKTOK', 'marca.demo', '7690000000000000301')])])
    net.hashtags.set('INSTAGRAM:marcademo', [author('marta_demo', [post('INSTAGRAM', 'marta_demo', '3745000000000000301')])])

    const results = await runCronTracking()
    expect(results).toMatchObject({ campaignsProcessed: 1, totalPostsFound: 1, errors: [] })
    expect(results.brandAuthorsSkipped).toEqual([{ campaignId: campaign.id, name: campaign.name, author: 'marca.demo', member: 'marta_demo', posts: 1 }])
    // The brand's video is nowhere; Marta's own reel is in her row
    expect(await prisma.media.count({ where: { externalId: '7690000000000000301' } })).toBe(0)
    expect(await prisma.media.findFirst({ where: { externalId: '3745000000000000301' } })).toMatchObject({ influencerId: marta.id, publishedByInfluencerId: null, campaignId: campaign.id })
    expect(await prisma.notification.count({ where: { type: 'creator_discovered' } })).toBe(0)
  })
})

describe('campaigns that have ended', () => {
  it('a campaign ended more than 3 days ago is not read and is named with its reason; one ended yesterday and one without an end date are read', async () => {
    const ended = await spanishCampaign({ name: 'Marca Demo - Octubre (test)', startDate: daysAgo(40), endDate: daysAgo(10), targetHashtags: ['marcaoctubre'] })
    const grace = await spanishCampaign({ name: 'Marca Demo - Gracia (test)', startDate: daysAgo(30), endDate: daysAgo(1), targetHashtags: ['marcagracia'] })
    const listening = await spanishCampaign({ name: 'Marca Demo - Contratos anuales (test)', type: 'SOCIAL_LISTENING', startDate: daysAgo(300), endDate: null, targetHashtags: ['marcaanual'] })
    const future = await spanishCampaign({ name: 'Marca Demo - Diciembre (test)', startDate: daysAhead(5), endDate: daysAhead(35), targetHashtags: ['marcadiciembre'] })

    const results = await runCronTracking()
    expect(results.campaignsProcessed).toBe(2)
    expect(results.campaignsSkipped.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { id: future.id, name: future.name, reason: 'future' },
      { id: ended.id, name: ended.name, reason: 'ended' },
    ])
    const scraped = vi.mocked(scrapeHashtag).mock.calls.map(c => c[0]).sort()
    expect(scraped).toEqual(['marcaanual', 'marcaanual', 'marcagracia', 'marcagracia'])
    expect(await prisma.scrapeJob.count({ where: { campaignId: ended.id } })).toBe(0)
    expect(await prisma.scrapeJob.count({ where: { campaignId: grace.id } })).toBe(2)
    expect(await prisma.scrapeJob.count({ where: { campaignId: listening.id } })).toBe(2)
  })
})

describe('mentions on networks where they cannot be read', () => {
  it('scrapes @marca.demo only on Instagram; TikTok and YouTube are named as unsupported and get no scrape job', async () => {
    const campaign = await spanishCampaign({ targetAccounts: ['marca.demo', 'marca.distribuidor'], targetHashtags: [], platforms: ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] })
    const results = await runCronTracking()
    expect(results.campaignsProcessed).toBe(1)
    expect(vi.mocked(scrapeAccountMentions).mock.calls.map(c => `${c[1]}:${c[0]}`).sort()).toEqual(['INSTAGRAM:marca.demo', 'INSTAGRAM:marca.distribuidor'])
    expect(results.unsupportedMentions.map(u => ({ ...u, accounts: [...u.accounts].sort() })).sort((a, b) => a.platform.localeCompare(b.platform))).toEqual([
      { campaignId: campaign.id, name: campaign.name, platform: 'TIKTOK', accounts: ['marca.demo', 'marca.distribuidor'] },
      { campaignId: campaign.id, name: campaign.name, platform: 'YOUTUBE', accounts: ['marca.demo', 'marca.distribuidor'] },
    ])
    const jobs = await prisma.scrapeJob.findMany({ where: { campaignId: campaign.id }, select: { platform: true, jobType: true, status: true } })
    expect(jobs).toHaveLength(2)
    expect(jobs.every(j => j.platform === 'INSTAGRAM' && j.jobType === 'cron-mentions' && j.status === 'COMPLETED')).toBe(true)
  })
})
