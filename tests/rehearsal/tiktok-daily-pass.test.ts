/**
 * The daily TikTok pass (src/lib/tiktok-autolink.ts) on REAL DATA, after
 * delivery 1: it must never add a member, must leave the legacy twins as they
 * are, and must add a creator's TikTok as a PROFILE of hers on the evidence of
 * a video of the campaign.
 *
 * Like october-links.test.ts it works on a THROWAWAY CLONE of the local copy
 * (the copy itself is never written) with the network mocked: TikTok answers
 * what this file says. It reads the same input file, REHEARSAL_OCTOBER_FILE
 * (kept out of the repository: it names real creators), and uses its campaign
 * and its first TikTok link. Without the variable the whole file is skipped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { cloneOfLocalCopy, countSourceRows } from './clone'
// Only PURE modules are imported statically (see the @/lib/db mock below).
import { parsePostUrl } from '@/lib/post-url'
import { tiktokIdPostedAt } from '@/lib/tiktok-id'
import type { ScrapedPost, ScrapedProfile, TikTokProfilesBatch } from '@/lib/apify'

const tiktok = vi.hoisted(() => ({
  /** What TikTok answers: handle → its profile. A handle that is not here does not exist on TikTok. */
  accounts: new Map<string, unknown>(),
  /** Every handle the pass asked TikTok for, in order */
  requested: [] as string[],
}))

const db = vi.hoisted(() => ({
  url: '',
  close: null as null | (() => Promise<void>),
}))

// The application's database client, pointed at the CLONE and owned by this file.
vi.mock('@/lib/db', async () => {
  if (!db.url) throw new Error('The clone is not ready: nothing may load @/lib/db before it exists')
  const { PrismaClient } = await import('@/generated/prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url }) })
  db.close = async () => { await client.$disconnect().catch(() => {}) }
  return { prisma: client }
})

// No test may reach a scraper: the daily pass reads TikTok through this module.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in the rehearsal`) })
  return {
    scrapeTikTokProfilesBatch: vi.fn(async (handles: string[]) => {
      tiktok.requested.push(...handles)
      const out = { profiles: new Map<string, unknown>(), notFound: new Set<string>(), incomplete: new Set<string>(), partial: false }
      for (const handle of handles) {
        const answer = tiktok.accounts.get(handle)
        if (answer) out.profiles.set(handle, answer)
        else out.notFound.add(handle)
      }
      return out as unknown as TikTokProfilesBatch
    }),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    isApifyExhausted: vi.fn(() => false),
  }
})
// Every profile write is followed by a copy of the avatar (network) and by the creator pool: neither belongs here.
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

interface InputLink { url: string; member: string; author: string; views: number; likes: number; comments: number }
interface Input { campaignId: string; campaignName: string; members: number; links: InputLink[] }

const FILE = process.env.REHEARSAL_OCTOBER_FILE || ''
const input: Input | null = FILE ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) as Input) : null
const link = input?.links.find(l => parsePostUrl(l.url)?.platform === 'TIKTOK') ?? null

const clone = cloneOfLocalCopy('ensayo_tiktok')

type Db = typeof import('@/lib/db')
type Autolink = typeof import('@/lib/tiktok-autolink')
type OverviewModule = typeof import('@/lib/campaign-overview')
let prisma: Db['prisma']
let runTikTokAutolink: Autolink['runTikTokAutolink']
let computeCampaignOverview: OverviewModule['computeCampaignOverview']
let sourceBefore: Record<string, number> = {}

/** Everything the pass may never change, and what it may only change on evidence. */
async function state() {
  const [memberships, influencers, persons, logs, media] = await Promise.all([
    prisma.campaignInfluencer.findMany({ select: { id: true, campaignId: true, influencerId: true, status: true, source: true, agreedFee: true }, orderBy: { id: 'asc' } }),
    prisma.influencer.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.media.count(),
  ])
  return { memberships, influencers, persons, logs, media }
}

function account(username: string, videos: ScrapedPost[]): ScrapedProfile {
  return {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50,
    engagementRate: 2.5, avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null,
    email: null, country: null, city: null, recentPosts: videos,
  }
}

describe.skipIf(!input || !link)('the daily TikTok pass, on a clone of the local copy', () => {
  let before: Awaited<ReturnType<typeof state>>
  let campaign: { id: string; name: string; startDate: Date; endDate: Date | null; targetHashtags: string[]; targetAccounts: string[] }
  let member: { id: string; username: string }
  let tiktokRow: { id: string; username: string } | null
  let midCampaign: Date
  let video: ScrapedPost

  beforeAll(async () => {
    sourceBefore = await countSourceRows()
    await clone.create()
    db.url = clone.url
    process.env.DATABASE_URL = db.url
    ;({ prisma } = await import('@/lib/db'))
    const [{ current }] = await prisma.$queryRaw<Array<{ current: string }>>`select current_database() as current`
    if (current !== clone.name) throw new Error(`Refusing to run: connected to "${current}", not to the clone "${clone.name}"`)
    ;({ runTikTokAutolink } = await import('@/lib/tiktok-autolink'))
    ;({ computeCampaignOverview } = await import('@/lib/campaign-overview'))

    campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: input!.campaignId },
      select: { id: true, name: true, startDate: true, endDate: true, targetHashtags: true, targetAccounts: true },
    })
    const membership = await prisma.campaignInfluencer.findFirstOrThrow({
      where: { campaignId: campaign.id, influencer: { platform: 'INSTAGRAM', username: { equals: link!.member, mode: 'insensitive' } } },
      select: { influencer: { select: { id: true, username: true } } },
    })
    member = membership.influencer
    tiktokRow = await prisma.influencer.findFirst({
      where: { platform: 'TIKTOK', username: { equals: link!.author, mode: 'insensitive' } },
      select: { id: true, username: true },
    })
    // A day in the middle of the campaign: what the cron saw while it was running
    const end = campaign.endDate ?? new Date(campaign.startDate.getTime() + 30 * 86_400_000)
    midCampaign = new Date((campaign.startDate.getTime() + end.getTime()) / 2)

    const parsed = parsePostUrl(link!.url)!
    const hashtag = campaign.targetHashtags[0]
    video = {
      externalId: parsed.externalId,
      caption: `Ensayo ${hashtag ? `#${hashtag}` : ''} ${campaign.targetAccounts[0] ? `@${campaign.targetAccounts[0]}` : ''}`.trim(),
      mediaUrl: null,
      thumbnailUrl: null,
      permalink: parsed.canonicalUrl,
      mediaType: 'VIDEO',
      likes: link!.likes,
      comments: link!.comments,
      shares: 0,
      saves: 0,
      views: link!.views,
      postedAt: tiktokIdPostedAt(parsed.externalId)!.toISOString(),
      hashtags: hashtag ? [hashtag] : [],
      mentions: campaign.targetAccounts[0] ? [campaign.targetAccounts[0]] : [],
    }
    before = await state()
  }, 120_000)

  afterAll(async () => {
    if (db.close) await db.close()
    await clone.drop()
  }, 120_000)

  it('today, with nothing new on TikTok, the pass over every live campaign changes nothing', async () => {
    tiktok.accounts.clear()
    tiktok.requested.length = 0
    const summary = await runTikTokAutolink({ now: new Date('2026-11-12T12:00:00Z') })
    console.log(`pass of 12 Nov 2026 on the clone: ${summary.campaigns.length} live campaign(s), ${summary.handlesScanned} TikTok account(s) asked for, linked ${summary.linked}, videos ${summary.videos}`)
    expect(summary.skipped).toBeUndefined()
    expect(summary).toMatchObject({ linked: 0, videos: 0, failed: [], notLinked: [], partial: false })
    expect(await state()).toEqual(before)

    // Legacy twins (TikTok accounts that are members, source 'tiktok_link:<id>'): never asked for, never touched
    const twins = before.memberships.filter(m => (m.source ?? '').startsWith('tiktok_link:'))
    const twinProfiles = await prisma.influencer.findMany({ where: { id: { in: twins.map(t => t.influencerId) } }, select: { username: true, personId: true } })
    console.log(`legacy twin memberships in the copy: ${twins.length}`)
    for (const twin of twinProfiles) {
      expect(tiktok.requested, `@${twin.username}`).not.toContain(twin.username.toLowerCase())
      expect(twin.personId).toBeNull()
    }
  })

  it('in the middle of the campaign it looks for the TikTok of its confirmed Instagram creators, and finding nothing changes nothing', async () => {
    tiktok.accounts.clear()
    tiktok.requested.length = 0
    const summary = await runTikTokAutolink({ now: midCampaign })
    const entry = summary.campaigns.find(c => c.id === campaign.id)
    expect(entry, 'the campaign of the brief is scanned').toBeDefined()
    expect(entry!.candidates).toBeGreaterThan(0)
    // The account of the brief's first TikTok link is one of the accounts asked for
    expect(tiktok.requested).toContain(link!.author.toLowerCase())
    expect(summary).toMatchObject({ linked: 0, videos: 0, failed: [], notLinked: [] })
    expect(await state()).toEqual(before)
  })

  it('a video of the campaign on her TikTok adds it as her PROFILE and stores the video in her row, with the same members', async () => {
    const overviewBefore = await computeCampaignOverview(campaign.id, { now: new Date('2026-11-12T12:00:00Z') } as never)
    const noticesBefore = await prisma.notification.count({ where: { title: 'TikTok vinculado' } })
    tiktok.accounts.clear()
    tiktok.accounts.set(link!.author.toLowerCase(), account(link!.author, [video]))
    tiktok.requested.length = 0

    const summary = await runTikTokAutolink({ now: new Date(midCampaign.getTime() + 86_400_000) })
    expect(summary).toMatchObject({ linked: 1, videos: 1, failed: [], notLinked: [] })
    expect(summary.campaigns.find(c => c.id === campaign.id)).toMatchObject({ linked: [expect.any(String)], videos: 1 })

    const after = await state()
    // Not one membership more or less, anywhere; not one of them changed
    expect(after.memberships).toEqual(before.memberships)
    expect(after.memberships.filter(m => m.campaignId === campaign.id)).toHaveLength(input!.members)
    // One person, one log line written by the system, one video
    expect(after.persons).toBe(before.persons + 1)
    expect(after.logs).toBe(before.logs + 1)
    expect(after.media).toBe(before.media + 1)
    // The TikTok row that already existed is reused; none is created for her
    if (tiktokRow) expect(after.influencers).toBe(before.influencers)

    const row = await prisma.media.findFirstOrThrow({
      where: { campaignId: campaign.id, platform: 'TIKTOK', externalId: video.externalId! },
      include: { publishedBy: { select: { id: true, username: true, platform: true, personId: true } }, influencer: { select: { personId: true } } },
    })
    expect(row.influencerId).toBe(member.id)
    expect(row.publishedBy?.platform).toBe('TIKTOK')
    expect(row.publishedBy?.username.toLowerCase()).toBe(link!.author.toLowerCase())
    if (tiktokRow) expect(row.publishedByInfluencerId).toBe(tiktokRow.id)
    expect(row.publishedBy?.personId).toBeTruthy()
    expect(row.publishedBy?.personId).toBe(row.influencer.personId)
    expect(row.views).toBe(link!.views)
    expect(await prisma.campaignInfluencer.count({ where: { influencerId: row.publishedByInfluencerId! } })).toBe(0)

    const log = await prisma.personLog.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })
    expect(log).toMatchObject({ action: 'link_profile', evidence: 'autolink_video', actorId: null, actorName: null })
    expect(await prisma.notification.count({ where: { title: 'TikTok vinculado' } })).toBeGreaterThan(noticesBefore)

    // In the figures: the same creators, her row one piece and its views richer
    const overviewAfter = await computeCampaignOverview(campaign.id, { now: new Date('2026-11-12T12:00:00Z') } as never)
    expect(overviewAfter?.totals.members).toBe(overviewBefore?.totals.members)
    expect(overviewAfter?.perInfluencer).toHaveLength(overviewBefore!.perInfluencer.length)
    expect(overviewAfter?.totals.media).toBe(overviewBefore!.totals.media + 1)
    expect(overviewAfter?.totals.views).toBe(overviewBefore!.totals.views + link!.views)
    const hers = overviewAfter!.perInfluencer.find(p => p.influencerId === member.id)!
    const hersBefore = overviewBefore!.perInfluencer.find(p => p.influencerId === member.id)!
    expect(hers.media).toBe(hersBefore.media + 1)
    expect(hers.byPlatform?.TIKTOK).toMatchObject({ pieces: 1, views: link!.views })
  })

  it('the next pass reads her profile again and creates nothing new', async () => {
    const was = await state()
    const noticesBefore = await prisma.notification.count()
    tiktok.requested.length = 0
    const summary = await runTikTokAutolink({ now: new Date(midCampaign.getTime() + 2 * 86_400_000) })
    expect(summary).toMatchObject({ linked: 0, videos: 0, failed: [], notLinked: [] })
    // Her TikTok is now a known profile: it keeps being read
    expect(tiktok.requested).toContain(link!.author.toLowerCase())
    expect(summary.campaigns.find(c => c.id === campaign.id)?.known).toBe(1)
    expect(await state()).toEqual(was)
    expect(await prisma.notification.count()).toBe(noticesBefore)
  })

  it('the local copy itself was never written', async () => {
    expect(await countSourceRows()).toEqual(sourceBefore)
  })
})
