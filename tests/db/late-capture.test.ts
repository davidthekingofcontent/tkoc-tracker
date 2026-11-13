/**
 * A late piece («fuera de plazo») and the automatic paths:
 *   - revalidateCampaignMedia keeps a hand-added late row (up to 30 days
 *     after the end) and still detaches a scraped one; the Claude
 *     connector's preview of a revalidation says the same;
 *   - no automatic path files a post a second time in another campaign while
 *     a LATE row of it exists: the central upserts (posts and stories), the
 *     per-member capture, Meta's materialisation and the admin fan-out skip
 *     it, count it in their summary and log it.
 * Real (throwaway) database, invented handles, network mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  profile: null as unknown,
  session: null as null | { id: string; email: string; name: string; role: string },
}))

// No test may reach a scraper: the profile read by the per-member capture comes from the test.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: vi.fn(async () => net.profile),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
  }
})

// The profile refresh after a capture caches avatars and fills the creator pool in the background: not here.
vi.mock('@/lib/influencer-upsert', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/influencer-upsert')>()
  return { ...real, afterInfluencerUpsert: vi.fn() }
})

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedPost, ScrapedStory } from '@/lib/apify'
import {
  captureMemberContent,
  findLateCopyElsewhere,
  newCaptureSkips,
  revalidateCampaignMedia,
  upsertCampaignPost,
  upsertCampaignStory,
} from '@/lib/campaign-capture'
import { materializeMetaContent } from '@/lib/meta-materialize'
import { projectRevalidation } from '@/lib/mcp/tools/write/campaigns'
import { POST as fanout } from '@/app/api/admin/fanout-media/route'
import { seedOctober, storyIdAt } from './fixtures/october'
import type { OctoberFixture } from './fixtures/october'

const fetchStub = vi.fn()
vi.stubGlobal('fetch', fetchStub)

async function reset() {
  await prisma.metaMedia.deleteMany()
  await prisma.metaAccountSnapshot.deleteMany()
  await prisma.socialToken.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

let fx: OctoberFixture
beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  fetchStub.mockImplementation(async () => { throw new Error('fetch: the network is mocked in tests') })
  net.profile = null
  fx = await seedOctober()
  net.session = null
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const member = (handle: string) => fx.instagram[handle].id

/** A piece of `handle` in October (or any campaign), written directly */
function row(handle: string, data: { postedAt: string | null; source?: string; externalId?: string | null; permalink?: string | null; mediaType?: 'POST' | 'REEL' | 'STORY'; campaignId?: string | null; hashtags?: string[]; mentions?: string[] }) {
  return prisma.media.create({
    data: {
      externalId: data.externalId === undefined ? `late-${Math.random().toString(36).slice(2, 10)}` : data.externalId,
      platform: 'INSTAGRAM',
      mediaType: data.mediaType ?? 'POST',
      permalink: data.permalink ?? null,
      caption: 'Probando la fregona nueva',
      hashtags: data.hashtags ?? ['#marcademo'],
      mentions: data.mentions ?? [],
      postedAt: data.postedAt ? new Date(data.postedAt) : null,
      source: data.source ?? 'manual',
      influencerId: member(handle),
      campaignId: data.campaignId === undefined ? fx.campaignId : data.campaignId,
    },
  })
}

/** An invented November campaign where these creators are confirmed members */
async function november(handles: string[], window = { start: '2026-11-01T00:00:00Z', end: '2026-11-30T00:00:00Z' }) {
  const campaign = await prisma.campaign.create({
    data: {
      name: '11.- Marca Demo - Micros Noviembre (test)', status: 'ACTIVE', type: 'INFLUENCER_TRACKING',
      startDate: new Date(window.start), endDate: new Date(window.end),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: fx.pm.id,
    },
  })
  for (const h of handles) await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: member(h), status: 'AGREED' } })
  return campaign
}

function scrapedPost(code: string, numericId: string, postedAt: string): ScrapedPost {
  return {
    externalId: numericId, caption: 'Probando la fregona nueva #marcademo', mediaUrl: null, thumbnailUrl: null,
    permalink: `https://www.instagram.com/p/${code}/`, mediaType: 'POST', likes: 100, comments: 4, shares: 0, saves: 0, views: 0,
    postedAt, hashtags: ['#marcademo'], mentions: [],
  }
}

// ---------------------------------------------------------------------------

describe('revalidation keeps a hand-added late piece and nothing else after the end', () => {
  it('kept: manual 5 days late, a legacy hand-added story 3 days late; detached: scraped late, 31 days late, before the start, undated', async () => {
    const keptLate = await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z' })
    const keptStory = await row('creadora_demo_26', { postedAt: '2026-11-03T10:00:00Z', mediaType: 'STORY', externalId: null, source: 'apify' })
    const scraped = await row('creadora_demo_02', { postedAt: '2026-11-05T10:00:00Z', source: 'apify' })
    const tooLate = await row('creadora_demo_27', { postedAt: '2026-12-01T00:00:00Z' })
    const early = await row('creadora_demo_28', { postedAt: '2026-09-28T10:00:00Z' })
    const undated = await row('creadora_demo_28', { postedAt: null })

    // The connector's preview says exactly what the platform does
    const preview = await projectRevalidation(fx.campaignId)
    expect(preview).toMatchObject({ total: 37, leave: 4 })
    expect(preview.examples.join(' | ')).toContain('fuera de fechas')

    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 33, detached: 4 })
    const where = async (id: string) => (await prisma.media.findUnique({ where: { id }, select: { campaignId: true } }))?.campaignId ?? null
    expect(await where(keptLate.id)).toBe(fx.campaignId)
    expect(await where(keptStory.id)).toBe(fx.campaignId)
    for (const gone of [scraped, tooLate, early, undated]) expect(await where(gone.id)).toBeNull()
    // Run twice: the same
    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 33, detached: 0 })
  })

  it('whether she still owed it is not checked again: the late piece is what completed her', async () => {
    const late = await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z' })
    await prisma.campaignInfluencer.update({ where: { campaignId_influencerId: { campaignId: fx.campaignId, influencerId: member('creadora_demo_25') } }, data: { status: 'COMPLETED' } })
    await revalidateCampaignMedia(fx.campaignId)
    expect((await prisma.media.findUniqueOrThrow({ where: { id: late.id } })).campaignId).toBe(fx.campaignId)
  })

  it('a Social Listening campaign keeps its strict window', async () => {
    const late = await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z' })
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { type: 'SOCIAL_LISTENING' } })
    expect((await projectRevalidation(fx.campaignId)).leave).toBe(1)
    expect(await revalidateCampaignMedia(fx.campaignId)).toEqual({ kept: 31, detached: 1 })
    expect((await prisma.media.findUniqueOrThrow({ where: { id: late.id } })).campaignId).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('a late piece counts in one campaign: the automatic paths never file it again elsewhere', () => {
  it('upsertCampaignPost: refused for a post late in October, by its shortcode; counted in the run summary', async () => {
    // October holds it late, added by hand without the scraper: externalId = shortcode
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: 'DfGuard0001', permalink: 'https://www.instagram.com/p/DfGuard0001/' })
    const nov = await november(['creadora_demo_25'])
    const skips = newCaptureSkips()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ok = await upsertCampaignPost(nov.id, member('creadora_demo_25'), 'INSTAGRAM', scrapedPost('DfGuard0001', '3770000000000000001', '2026-11-05T10:00:00.000Z'), { skips })
      expect(ok).toBe(false)
      expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/already counts late .*«10\.- Marca Demo - Micros Octubre \(test\)»/)
    } finally {
      warn.mockRestore()
    }
    expect(skips).toEqual({ lateElsewhere: 1, examples: ['INSTAGRAM:3770000000000000001 → «10.- Marca Demo - Micros Octubre (test)»'] })
    expect(await prisma.media.count({ where: { campaignId: nov.id } })).toBe(0)
  })

  it('an unattached copy of the post is not claimed either', async () => {
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: '3770000000000000002', permalink: 'https://www.instagram.com/p/DfGuard0002/' })
    const loose = await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: '3770000000000000002', permalink: 'https://www.instagram.com/p/DfGuard0002/', source: 'apify', campaignId: null })
    const nov = await november(['creadora_demo_25'])
    expect(await upsertCampaignPost(nov.id, member('creadora_demo_25'), 'INSTAGRAM', scrapedPost('DfGuard0002', '3770000000000000002', '2026-11-05T10:00:00.000Z'))).toBe(false)
    expect((await prisma.media.findUniqueOrThrow({ where: { id: loose.id } })).campaignId).toBeNull()
  })

  it('a copy inside its own window is not late: the post still counts in every campaign whose rules it satisfies', async () => {
    await row('creadora_demo_25', { postedAt: '2026-10-28T10:00:00Z', externalId: '3770000000000000003', permalink: 'https://www.instagram.com/p/DfGuard0003/' })
    const overlapping = await november(['creadora_demo_25'], { start: '2026-10-25T00:00:00Z', end: '2026-11-30T00:00:00Z' })
    expect(await upsertCampaignPost(overlapping.id, member('creadora_demo_25'), 'INSTAGRAM', scrapedPost('DfGuard0003', '3770000000000000003', '2026-10-28T10:00:00.000Z'))).toBe(true)
    expect(await prisma.media.count({ where: { campaignId: overlapping.id } })).toBe(1)
  })

  it('findLateCopyElsewhere matches the exact shortcode only, never a longer one that starts with it', async () => {
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: 'DfGuard0004x', permalink: 'https://www.instagram.com/p/DfGuard0004x/' })
    const nov = await november(['creadora_demo_25'])
    expect(await findLateCopyElsewhere({ platform: 'INSTAGRAM', externalIds: ['3770000000000000004'], permalinks: ['https://www.instagram.com/p/DfGuard0004/'] }, nov.id)).toBeNull()
    expect(await findLateCopyElsewhere({ platform: 'INSTAGRAM', externalIds: [], permalinks: ['https://www.instagram.com/reel/DfGuard0004x/'] }, nov.id)).toMatchObject({ campaignId: fx.campaignId })
    // A row that only kept the shortcode as its id, without a link, is the same post too
    await row('creadora_demo_26', { postedAt: '2026-11-06T10:00:00Z', externalId: 'DfGuard0010', permalink: null })
    expect(await findLateCopyElsewhere({ platform: 'INSTAGRAM', externalIds: ['3770000000000000010'], permalinks: ['https://www.instagram.com/p/DfGuard0010/'] }, nov.id)).toMatchObject({ campaignId: fx.campaignId })
    // Another network never matches
    expect(await findLateCopyElsewhere({ platform: 'TIKTOK', externalIds: ['DfGuard0010'] }, nov.id)).toBeNull()
  })

  it('upsertCampaignStory: the same story id late in October is not stored in November', async () => {
    const storyId = storyIdAt('2026-11-03T09:00:00.000Z', 3)
    await row('creadora_demo_25', { postedAt: '2026-11-03T09:00:00Z', mediaType: 'STORY', externalId: storyId })
    const nov = await november(['creadora_demo_25'])
    const story: ScrapedStory = {
      externalId: storyId, mediaUrl: null, thumbnailUrl: null, permalink: null, mediaType: 'STORY', views: 0,
      postedAt: '2026-11-03T09:00:00.000Z', expiresAt: null, mentions: ['marca.demo'], hashtags: [], stickers: [],
    }
    const skips = newCaptureSkips()
    expect(await upsertCampaignStory(nov.id, member('creadora_demo_25'), story, undefined, { skips })).toBe(false)
    expect(skips.lateElsewhere).toBe(1)
    expect(await prisma.media.count({ where: { campaignId: nov.id } })).toBe(0)
  })

  it('the per-member capture skips it and says so in its result', async () => {
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: 'DfGuard0005', permalink: 'https://www.instagram.com/p/DfGuard0005/' })
    const nov = await november(['creadora_demo_25'])
    net.profile = {
      username: 'creadora_demo_25', displayName: null, bio: null, avatarUrl: null, followers: 4900, following: 10, postsCount: 2,
      engagementRate: 0, avgLikes: 0, avgComments: 0, avgViews: 0, isVerified: false, website: null, email: null, country: null, city: null,
      recentPosts: [
        scrapedPost('DfGuard0005', '3770000000000000005', '2026-11-05T10:00:00.000Z'),
        scrapedPost('DfGuard0006', '3770000000000000006', '2026-11-08T10:00:00.000Z'),
      ],
    }
    const result = await captureMemberContent(nov.id, member('creadora_demo_25'))
    expect(result).toEqual({ captured: 1, skipped: 1, skippedLateElsewhere: 1 })
    const inNovember = await prisma.media.findMany({ where: { campaignId: nov.id }, select: { externalId: true } })
    expect(inNovember).toEqual([{ externalId: '3770000000000000006' }])
  })

  it("Meta's materialisation skips it and counts it; another tagged post still enters", async () => {
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: 'DfGuard0007', permalink: 'https://www.instagram.com/p/DfGuard0007/' })
    const nov = await november(['creadora_demo_25'])
    const token = await prisma.socialToken.create({ data: { platform: 'INSTAGRAM', tokenType: 'brand', accessToken: 'token-de-prueba', isValid: true } })
    await prisma.metaAccountSnapshot.create({ data: { socialTokenId: token.id, igUsername: 'marca.demo', followersCount: 1, followsCount: 1, mediaCount: 1 } })
    for (const [igMediaId, code, day] of [['17900000000000007', 'DfGuard0007', '05'], ['17900000000000008', 'DfGuard0008', '09']]) {
      await prisma.metaMedia.create({
        data: {
          socialTokenId: token.id, igMediaId, mediaType: 'IMAGE', igUsername: 'creadora_demo_25', caption: 'Con @marca.demo',
          permalink: `https://www.instagram.com/p/${code}/`, postedAt: new Date(`2026-11-${day}T10:00:00Z`), likeCount: 10,
        },
      })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await materializeMetaContent(nov.id)).toEqual({ created: 1, updated: 0, skippedLateElsewhere: 1 })
    } finally {
      warn.mockRestore()
    }
    expect((await prisma.media.findMany({ where: { campaignId: nov.id }, select: { externalId: true } })).map(m => m.externalId)).toEqual(['17900000000000008'])
  })

  it('the admin fan-out does not copy it and reports the skip', async () => {
    // October holds the post late, added by hand; the fan-out's source is a Meta
    // copy of it in another campaign whose dates include 5 Nov (an autumn one)
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: 'DfGuard0009', permalink: 'https://www.instagram.com/p/DfGuard0009/' })
    const autumn = await november(['creadora_demo_25'], { start: '2026-10-20T00:00:00Z', end: '2026-11-20T00:00:00Z' })
    await row('creadora_demo_25', { postedAt: '2026-11-05T10:00:00Z', externalId: '17900000000000009', permalink: 'https://www.instagram.com/p/DfGuard0009/', source: 'meta_api', mentions: ['marca.demo'], campaignId: autumn.id })
    const nov = await november(['creadora_demo_25'])
    net.session = { id: fx.pm.id, email: fx.pm.email, name: fx.pm.name, role: 'ADMIN' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let body: Record<string, unknown>
    try {
      const res = await fanout(new NextRequest('http://localhost/api/admin/fanout-media', { method: 'POST', body: JSON.stringify({}) }))
      expect(res.status).toBe(200)
      body = await res.json()
    } finally {
      warn.mockRestore()
    }
    expect(body).toMatchObject({ created: 0, candidates: 0, skippedLateElsewhere: 1 })
    expect(await prisma.media.count({ where: { campaignId: nov.id } })).toBe(0)
  })
})
