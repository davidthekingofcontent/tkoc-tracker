import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No test may reach a scraper: the daily pass reads TikTok through this module.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeTikTokProfilesBatch: vi.fn(),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    isApifyExhausted: vi.fn(() => false),
  }
})
// Every profile write is followed by a copy of the avatar (network, headless
// browser) and by the creator pool: neither belongs in a test.
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { prisma } from '@/lib/db'
import { isApifyExhausted, scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedPost, ScrapedProfile, TikTokProfilesBatch } from '@/lib/apify'
import type { InfluencerStatus, Platform, Prisma } from '@/generated/prisma/client'
import { revalidateCampaignMedia } from '@/lib/campaign-capture'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import { findOrCreateInfluencerExact, linkProfile } from '@/lib/person-profiles'
import * as autolinkModule from '@/lib/tiktok-autolink'
import { TIKTOK_LINK_SOURCE_PREFIX, linkedInstagramId, runTikTokAutolink, tiktokCandidateHandle } from '@/lib/tiktok-autolink'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PM = { id: 'user-pm', name: 'Laura PM' }
/** "Today" of the pass: inside the October campaign */
const NOW = new Date('2026-10-20T12:00:00Z')
const CAMPAIGN_NAME = '10.- Vileda - Micros Octubre (test)'
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
  batch.mockReset()
  batch.mockImplementation(async () => { throw new Error('scrapeTikTokProfilesBatch: no TikTok account was served to this test') })
  vi.mocked(isApifyExhausted).mockReturnValue(false)
})
afterAll(reset)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function profile(username: string, platform: Platform = 'INSTAGRAM', extra: Partial<Prisma.InfluencerUncheckedCreateInput> = {}) {
  return prisma.influencer.create({ data: { username, platform, ...extra } })
}

/** An October-like campaign: 1 to 31 Oct 2026, Instagram + TikTok, brand @vileda.es / #vileda, with its own PM. */
async function octoberCampaign(over: Partial<Prisma.CampaignUncheckedCreateInput> = {}) {
  const user = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: CAMPAIGN_NAME,
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['vileda.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: user.id,
      ...over,
    },
  })
  return { ...campaign, pmId: user.id }
}

function join(campaignId: string, influencerId: string, extra: { status?: InfluencerStatus; source?: string; agreedFee?: number; createdAt?: Date } = {}) {
  return prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED', ...extra } })
}

/** A TikTok video that passes the campaign rules unless told otherwise (12 Oct, #vileda). */
function video(handle: string, id: string, over: Partial<ScrapedPost> = {}): ScrapedPost {
  return {
    externalId: id,
    caption: 'Probando la fregona nueva #vileda',
    mediaUrl: null,
    thumbnailUrl: null,
    permalink: `https://www.tiktok.com/@${handle}/video/${id}`,
    mediaType: 'VIDEO',
    likes: 120,
    comments: 4,
    shares: 3,
    saves: 2,
    views: 5400,
    postedAt: '2026-10-12T10:00:00.000Z',
    hashtags: ['vileda'],
    mentions: [],
    ...over,
  }
}

function account(username: string, videos: ScrapedPost[], over: Partial<ScrapedProfile> = {}): ScrapedProfile {
  return {
    username,
    displayName: null,
    bio: null,
    avatarUrl: null,
    followers: 1000,
    following: 10,
    postsCount: 50,
    engagementRate: 2.5,
    avgLikes: 100,
    avgComments: 5,
    avgViews: 4000,
    isVerified: false,
    website: null,
    email: null,
    country: null,
    city: null,
    recentPosts: videos,
    ...over,
  }
}

/** What TikTok answers: handle → its profile, or 'missing'. A handle that is not listed gets no answer at all. */
function serveTikTok(accounts: Record<string, ScrapedProfile | 'missing'>, before?: (handles: string[]) => Promise<void>) {
  batch.mockImplementation(async (handles: string[]) => {
    if (before) await before(handles)
    const out: TikTokProfilesBatch = { profiles: new Map(), notFound: new Set(), incomplete: new Set(), partial: false }
    for (const handle of handles) {
      const answer = accounts[handle]
      if (answer === 'missing') out.notFound.add(handle)
      else if (answer) out.profiles.set(handle, answer)
    }
    return out
  })
}

const requestedHandles = () => batch.mock.calls.flatMap(call => call[0]).sort()

async function counts() {
  return {
    influencers: await prisma.influencer.count(),
    memberships: await prisma.campaignInfluencer.count(),
    persons: await prisma.person.count(),
    logs: await prisma.personLog.count(),
    media: await prisma.media.count(),
    notifications: await prisma.notification.count(),
  }
}

const ALEZ_VIDEO = '7695852671042964758'

/** The case of the brief: an Instagram member whose TikTok row exists and is a member of nothing. */
async function ale_ficticiaFixture() {
  const campaign = await octoberCampaign()
  const ig = await profile('ale_ficticia', 'INSTAGRAM', { followers: 2382, displayName: 'Ale Zweig' })
  const tt = await profile('ale_ficticia', 'TIKTOK', { followers: 29000 })
  await join(campaign.id, ig.id, { agreedFee: 200 })
  return { campaign, ig, tt }
}

// ---------------------------------------------------------------------------

describe('what other modules still import', () => {
  it('tiktokCandidateHandle: the TikTok linked in her Instagram bio or website, else the same username', () => {
    expect(tiktokCandidateHandle({ username: 'Ale_Ficticia' })).toEqual({ handle: 'ale_ficticia', via: 'same' })
    expect(tiktokCandidateHandle({ username: 'risas_inventadas_', website: 'https://www.tiktok.com/@Risas_InVentadas?lang=es' })).toEqual({ handle: 'risas_inventadas', via: 'bio' })
    expect(tiktokCandidateHandle({ username: 'gladys', bio: 'mi tiktok.com/@gema.ficticia_.', website: null })).toEqual({ handle: 'gema.ficticia_', via: 'bio' })
    expect(tiktokCandidateHandle({ username: '@lili_ficticia', bio: null, website: 'https://linktr.ee/lilin' })).toEqual({ handle: 'lili_ficticia', via: 'same' })
  })

  it('linkedInstagramId still recognises a legacy twin membership', () => {
    expect(linkedInstagramId(`${TIKTOK_LINK_SOURCE_PREFIX}abc123`)).toBe('abc123')
    expect(linkedInstagramId('manual')).toBeNull()
    expect(linkedInstagramId(null)).toBeNull()
  })

  it('ensureTikTokTwin is gone: the module no longer exports a way to add a TikTok account as a member', () => {
    expect(Object.keys(autolinkModule).sort()).toEqual(['TIKTOK_LINK_SOURCE_PREFIX', 'linkedInstagramId', 'runTikTokAutolink', 'tiktokCandidateHandle'])
    expect('ensureTikTokTwin' in autolinkModule).toBe(false)
  })

  it('nothing in the application writes a twin membership any more', () => {
    // CampaignInfluencer.source = 'tiktok_link:<id>' was the mark of a twin. It
    // may still be READ (legacy rows), never written: the prefix is only used
    // by linkedInstagramId and by the legacy tests.
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'generated') walk(full); continue }
        if (!/\.tsx?$/.test(entry.name)) continue
        const text = fs.readFileSync(full, 'utf8')
        if (/ensureTikTokTwin/.test(text)) offenders.push(`${path.relative(src, full)}: ensureTikTokTwin`)
        // a write would build the source from the prefix: `${TIKTOK_LINK_SOURCE_PREFIX}${…}` or 'tiktok_link:' + …
        if (/\$\{TIKTOK_LINK_SOURCE_PREFIX\}|TIKTOK_LINK_SOURCE_PREFIX\s*\+|['"`]tiktok_link:['"`]\s*\+|`tiktok_link:\$\{/.test(text)) offenders.push(`${path.relative(src, full)}: builds a tiktok_link source`)
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('linking on evidence', () => {
  it('adds the TikTok account as a profile of the Instagram member and stores the video under her, with no new member', async () => {
    const { campaign, ig, tt } = await ale_ficticiaFixture()
    serveTikTok({
      ale_ficticia: account('ale_ficticia', [
        video('ale_ficticia', ALEZ_VIDEO),
        video('ale_ficticia', '7695000000000000001', { caption: 'Mi rutina de mañana', hashtags: ['grwm'] }), // no brand
      ], { followers: 29500, displayName: 'Ale' }),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary).toMatchObject({ handlesScanned: 1, answered: 1, linked: 1, videos: 1, notLinked: [], failed: [], partial: false })
    expect(summary.skipped).toBeUndefined()
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 1, known: 0, linked: ['ale_ficticia'], videos: 1 }])
    // First read of the pair: back to the campaign start
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]).toEqual([['ale_ficticia'], { resultsPerPage: 100, oldestPostDate: '2026-10-01' }])

    // No membership was created: the campaign has the same creators
    const memberships = await prisma.campaignInfluencer.findMany()
    expect(memberships).toHaveLength(1)
    expect(memberships[0]).toMatchObject({ influencerId: ig.id, status: 'COMPLETED', source: 'manual', agreedFee: 200 })
    // The TikTok row that already existed is reused, not duplicated, and refreshed
    expect(await prisma.influencer.count()).toBe(2)
    const tiktok = await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })
    expect(tiktok).toMatchObject({ username: 'ale_ficticia', platform: 'TIKTOK', followers: 29500, displayName: 'Ale' })

    // One person, both profiles, logged as the system with the evidence
    const member = await prisma.influencer.findUniqueOrThrow({ where: { id: ig.id } })
    expect(member.personId).toEqual(expect.any(String))
    expect(tiktok.personId).toBe(member.personId)
    expect(await prisma.person.count()).toBe(1)
    const logs = await prisma.personLog.findMany()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      action: 'link_profile',
      personId: member.personId,
      actorId: null,
      actorName: null,
      evidence: 'autolink_video',
      summary: `@ale_ficticia (TikTok) añadido como perfil de @ale_ficticia (Instagram). Publicó un vídeo de la campaña "${CAMPAIGN_NAME}": https://www.tiktok.com/@ale_ficticia/video/${ALEZ_VIDEO}`,
    })

    // The video: credited to the Instagram member, published by the TikTok profile, on TikTok
    const media = await prisma.media.findMany()
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({
      externalId: ALEZ_VIDEO,
      platform: 'TIKTOK',
      mediaType: 'VIDEO',
      influencerId: ig.id,
      publishedByInfluencerId: tt.id,
      campaignId: campaign.id,
      views: 5400,
      source: 'apify',
      dataSource: 'apify',
    })
    // ...which is what the roster says, and what revalidation keeps
    expect((await loadCampaignRoster(campaign.id)).creditFor('TIKTOK', '@ale_ficticia')).toMatchObject({ self: false, member: { influencerId: ig.id }, publisher: { influencerId: tt.id } })
    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 1, detached: 0 })

    // The team is told that a PROFILE was added
    const notifications = await prisma.notification.findMany()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      userId: campaign.pmId,
      type: 'influencer_added',
      title: 'TikTok vinculado',
      message: `@ale_ficticia (TikTok) se ha añadido como perfil de @ale_ficticia. Se ha capturado 1 vídeo en "${CAMPAIGN_NAME}". La campaña sigue con las mismas creadoras.`,
      link: `/campaigns/${campaign.id}`,
    })
  })

  it('creates the TikTok profile when it did not exist, from the link in her Instagram website', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('risas_inventadas_', 'INSTAGRAM', { website: 'https://www.tiktok.com/@risas_inventadas' })
    await join(campaign.id, ig.id, { status: 'CONTRACTED' })
    serveTikTok({
      risas_inventadas: account('risas_inventadas', [
        video('risas_inventadas', '7693578978421935382'),
        video('risas_inventadas', '7693578978421935999', { postedAt: '2026-10-15T08:00:00.000Z', caption: 'Con @vileda.es', hashtags: [], mentions: ['vileda.es'] }),
      ], { followers: 8287, bio: 'Humor y amor' }),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(requestedHandles()).toEqual(['risas_inventadas'])
    expect(summary).toMatchObject({ linked: 1, videos: 2 })
    const tiktok = await prisma.influencer.findUniqueOrThrow({ where: { username_platform: { username: 'risas_inventadas', platform: 'TIKTOK' } } })
    expect(tiktok).toMatchObject({ followers: 8287, bio: 'Humor y amor', dataSource: 'apify', addedById: null, addedByName: null })
    expect(tiktok.lastScraped).toBeInstanceOf(Date)
    expect(tiktok.personId).toEqual(expect.any(String))
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: ig.id } })).personId).toBe(tiktok.personId)

    expect(await prisma.campaignInfluencer.count()).toBe(1)
    const media = await prisma.media.findMany({ orderBy: { externalId: 'asc' } })
    expect(media.map(m => m.externalId)).toEqual(['7693578978421935382', '7693578978421935999'])
    for (const row of media) expect(row).toMatchObject({ influencerId: ig.id, publishedByInfluencerId: tiktok.id, platform: 'TIKTOK', campaignId: campaign.id })
    expect((await prisma.notification.findMany()).map(n => n.message)).toEqual([
      `@risas_inventadas (TikTok) se ha añadido como perfil de @risas_inventadas_. Se han capturado 2 vídeos en "${CAMPAIGN_NAME}". La campaña sigue con las mismas creadoras.`,
    ])
  })

  it('links nothing without a video of the campaign: a namesake is never added', async () => {
    const { ig, tt } = await ale_ficticiaFixture()
    const before = await counts()
    serveTikTok({
      ale_ficticia: account('ale_ficticia', [
        video('ale_ficticia', '7600000000000000001', { caption: 'Mi rutina', hashtags: ['grwm'] }), // no brand
        video('ale_ficticia', '7600000000000000002', { postedAt: '2026-09-20T10:00:00.000Z' }), // before the campaign
        video('ale_ficticia', '7600000000000000003', { postedAt: '2026-11-02T10:00:00.000Z' }), // after the campaign
        video('ale_ficticia', '', {}), // no id
      ], { followers: 31000 }),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary).toMatchObject({ handlesScanned: 1, answered: 1, linked: 0, videos: 0, notLinked: [], failed: [] })
    expect(summary.campaigns[0]).toMatchObject({ candidates: 1, known: 0, linked: [], videos: 0 })
    expect(await counts()).toEqual(before)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: ig.id } })).personId).toBeNull()
    // The account was not linked, so its row is not touched either
    expect(await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })).toMatchObject({ personId: null, followers: 29000 })
  })

  it('creates no profile row for an account TikTok does not know, or that published nothing of the campaign', async () => {
    const campaign = await octoberCampaign()
    const a = await profile('sara_inventada17')
    const b = await profile('nuria_demo15')
    await join(campaign.id, a.id)
    await join(campaign.id, b.id)
    serveTikTok({ sara_inventada17: 'missing', nuria_demo15: account('nuria_demo15', []) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(requestedHandles()).toEqual(['nuria_demo15', 'sara_inventada17'])
    expect(summary).toMatchObject({ handlesScanned: 2, answered: 2, notFound: 1, linked: 0, videos: 0 })
    expect(await prisma.influencer.count()).toBe(2)
    expect(await prisma.influencer.count({ where: { platform: 'TIKTOK' } })).toBe(0)
    expect(await prisma.person.count()).toBe(0)
  })

  it('does not look for members that are not confirmed, nor in campaigns that do not include TikTok or are over', async () => {
    const campaign = await octoberCampaign()
    const prospect = await profile('lili_ficticia')
    await join(campaign.id, prospect.id, { status: 'NEGOTIATING' })
    const instagramOnly = await octoberCampaign({ platforms: ['INSTAGRAM'] })
    const confirmed = await profile('gema.ficticia_')
    await join(instagramOnly.id, confirmed.id)
    const september = await octoberCampaign({ startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z') })
    await join(september.id, confirmed.id)
    serveTikTok({ lili_ficticia: account('lili_ficticia', [video('lili_ficticia', '7694256646884773153')]), 'gema.ficticia_': account('gema.ficticia_', [video('gema.ficticia_', '7699205467465108768')]) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(batch).not.toHaveBeenCalled()
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 0, known: 0, linked: [], videos: 0 }])
    expect(await prisma.media.count()).toBe(0)
    expect(await prisma.person.count()).toBe(0)
  })

  it('when the video was already in the campaign it is not duplicated and keeps whoever added it', async () => {
    const { campaign, ig, tt } = await ale_ficticiaFixture()
    const byHand = await prisma.media.create({
      data: {
        platform: 'TIKTOK', mediaType: 'VIDEO', externalId: ALEZ_VIDEO, source: 'manual', dataSource: 'manual',
        permalink: `https://www.tiktok.com/@ale_ficticia/video/${ALEZ_VIDEO}`, postedAt: new Date('2026-10-12T10:00:00Z'),
        influencerId: ig.id, campaignId: campaign.id, views: 100, likes: 500,
      },
    })
    serveTikTok({ ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)]) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary).toMatchObject({ linked: 1, videos: 0 })
    const media = await prisma.media.findMany()
    expect(media).toHaveLength(1)
    // Same row, still the PM's: only its public figures were raised
    expect(media[0]).toMatchObject({ id: byHand.id, source: 'manual', dataSource: 'manual', influencerId: ig.id, publishedByInfluencerId: null, views: 5400, likes: 500 })
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })).personId).toEqual(expect.any(String))
    expect((await prisma.notification.findMany()).map(n => n.message)).toEqual([
      `@ale_ficticia (TikTok) se ha añadido como perfil de @ale_ficticia. Su vídeo de "${CAMPAIGN_NAME}" ya estaba en la campaña. La campaña sigue con las mismas creadoras.`,
    ])
    expect(await prisma.campaignInfluencer.count()).toBe(1)
  })

  it('a creator of two campaigns is linked once, her video enters both and both teams are told', async () => {
    const first = await octoberCampaign()
    const second = await octoberCampaign({ name: 'Vileda - Spin Octubre (test)' })
    const ig = await profile('ale_ficticia', 'INSTAGRAM')
    await join(first.id, ig.id)
    await join(second.id, ig.id, { status: 'POSTED' })
    serveTikTok({ ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)]) })

    const summary = await runTikTokAutolink({ now: NOW })

    // One read for both campaigns, one link, one person
    expect(batch).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ handlesScanned: 1, linked: 1, videos: 2 })
    expect(summary.campaigns.map(c => c.linked)).toEqual([['ale_ficticia'], ['ale_ficticia']])
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.personLog.count()).toBe(1)
    expect(await prisma.influencer.count()).toBe(2)
    expect(await prisma.campaignInfluencer.count()).toBe(2)

    const tiktok = await prisma.influencer.findFirstOrThrow({ where: { platform: 'TIKTOK' } })
    const media = await prisma.media.findMany()
    expect(media.map(m => m.campaignId).sort()).toEqual([first.id, second.id].sort())
    for (const row of media) expect(row).toMatchObject({ externalId: ALEZ_VIDEO, influencerId: ig.id, publishedByInfluencerId: tiktok.id })

    const notifications = await prisma.notification.findMany()
    expect(notifications.map(n => n.userId).sort()).toEqual([first.pmId, second.pmId].sort())
    expect(notifications.every(n => n.title === 'TikTok vinculado')).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('guards', () => {
  it('a TikTok account that already is a profile of another person is skipped, not read, and reported', async () => {
    const campaign = await octoberCampaign()
    // In the campaign: Instagram @lucia. Not in it: another creator whose TikTok is @lucia
    const member = await profile('lucia', 'INSTAGRAM')
    await join(campaign.id, member.id)
    const other = await profile('lucia.real', 'INSTAGRAM')
    const tiktok = await profile('lucia', 'TIKTOK', { followers: 7000 })
    const { personId: otherPerson } = await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    const before = await counts()
    // If it were read, this video would be evidence enough
    serveTikTok({ lucia: account('lucia', [video('lucia', '7700000000000000001')]) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(batch).not.toHaveBeenCalled()
    expect(summary.notLinked).toEqual([{ campaignId: campaign.id, campaign: CAMPAIGN_NAME, member: 'lucia', handle: 'lucia', reason: 'other_person' }])
    expect(summary).toMatchObject({ handlesScanned: 0, linked: 0, videos: 0, failed: [] })
    expect(summary.campaigns[0]).toMatchObject({ candidates: 0, known: 0, linked: [] })
    // Nothing is created, linked or stored; the only write is ONE notice to the
    // campaign team that her TikTok is left unread (never a silent pause)
    expect(await counts()).toEqual({ ...before, notifications: before.notifications + 1 })
    const [notice] = await prisma.notification.findMany()
    expect(notice).toMatchObject({ userId: campaign.pmId, title: 'TikTok sin vincular', link: `/campaigns/${campaign.id}` })
    expect(notice.message).toContain('@lucia (TikTok) no se ha añadido como perfil de @lucia')
    expect(notice.message).toContain('@lucia.real')
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBe(otherPerson)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBeNull()
  })

  it('the same guard when the member already has a person of her own', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('lucia', 'INSTAGRAM')
    const memberYoutube = await profile('lucia', 'YOUTUBE')
    await join(campaign.id, member.id)
    const { personId: memberPerson } = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: memberYoutube.id, actor: PM, evidence: 'pm_confirmed' })
    const other = await profile('lucia.real', 'INSTAGRAM')
    const tiktok = await profile('lucia', 'TIKTOK')
    const { personId: otherPerson } = await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    serveTikTok({ lucia: account('lucia', [video('lucia', '7700000000000000001')]) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(batch).not.toHaveBeenCalled()
    expect(summary.notLinked).toEqual([{ campaignId: campaign.id, campaign: CAMPAIGN_NAME, member: 'lucia', handle: 'lucia', reason: 'other_person' }])
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBe(otherPerson)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBe(memberPerson)
    expect(await prisma.media.count()).toBe(0)
    expect(await prisma.personLog.count()).toBe(2)
  })

  it('refuses at the moment of linking when the account got another person while TikTok was being read', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('nuria_demo15', 'INSTAGRAM')
    await join(campaign.id, member.id)
    const other = await profile('otra.nuria', 'INSTAGRAM')
    const tiktok = await profile('nuria_demo15', 'TIKTOK')
    serveTikTok(
      { nuria_demo15: account('nuria_demo15', [video('nuria_demo15', '7693284871007128835')]) },
      // A PM links that TikTok to another creator in the meantime
      async () => { await linkProfile({ memberInfluencerId: other.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' }) },
    )

    const summary = await runTikTokAutolink({ now: NOW })

    expect(requestedHandles()).toEqual(['nuria_demo15'])
    expect(summary.notLinked).toEqual([{ campaignId: campaign.id, campaign: CAMPAIGN_NAME, member: 'nuria_demo15', handle: 'nuria_demo15', reason: 'other_person' }])
    expect(summary).toMatchObject({ linked: 0, videos: 0, failed: [] })
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBe((await prisma.influencer.findUniqueOrThrow({ where: { id: other.id } })).personId)
    expect(await prisma.media.count()).toBe(0)
    expect(await prisma.campaignInfluencer.count()).toBe(1)
    // No «TikTok vinculado»: ONE notice that her TikTok is left unread (the
    // other creator is not a member of this campaign, so nothing reads it here)
    const notices = await prisma.notification.findMany()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ userId: campaign.pmId, title: 'TikTok sin vincular', link: `/campaigns/${campaign.id}` })
    expect(notices[0].message).toContain('@nuria_demo15 (TikTok) no se ha añadido como perfil de @nuria_demo15')
    expect(notices[0].message).toContain('@otra.nuria')
    expect(await prisma.personLog.count()).toBe(1) // the PM's link only
  })

  it('one account failing does not stop the others, is reported and is read again on the next pass', async () => {
    const campaign = await octoberCampaign()
    const gone = await profile('sara_inventada17', 'INSTAGRAM')
    const fine = await profile('lili_ficticia', 'INSTAGRAM')
    await join(campaign.id, gone.id, { createdAt: new Date('2026-09-20T00:00:00Z') })
    await join(campaign.id, fine.id, { createdAt: new Date('2026-09-21T00:00:00Z') })
    serveTikTok(
      {
        sara_inventada17: account('sara_inventada17', [video('sara_inventada17', '7694005611729571094')]),
        lili_ficticia: account('lili_ficticia', [video('lili_ficticia', '7694256646884773153')]),
      },
      // The first creator is removed from the platform while TikTok is being read
      async () => { await prisma.influencer.delete({ where: { id: gone.id } }) },
    )

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary.failed).toEqual([{ campaignId: campaign.id, campaign: CAMPAIGN_NAME, member: 'sara_inventada17', handle: 'sara_inventada17' }])
    expect(summary).toMatchObject({ partial: true, linked: 1, videos: 1, notLinked: [] })
    expect(summary.skipped).toBeUndefined()
    expect(summary.campaigns[0].linked).toEqual(['lili_ficticia'])
    const media = await prisma.media.findMany()
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ externalId: '7694256646884773153', influencerId: fine.id })
    expect(await prisma.person.count()).toBe(1)
    // Only the pair that was dealt with is recorded as read
    const memo = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'tiktok_link_checked' } })).value)
    expect(Object.keys(memo)).toEqual([`${campaign.id}:lili_ficticia`])
  })

  it('a video that cannot be stored is not lost: the pair is reported and read again from the start', async () => {
    const { campaign, ig, tt } = await ale_ficticiaFixture()
    serveTikTok({
      ale_ficticia: account('ale_ficticia', [
        video('ale_ficticia', ALEZ_VIDEO),
        // The database refuses this one (a media type it does not know)
        video('ale_ficticia', '7696000000000000009', { mediaType: 'HOLOGRAM' as unknown as ScrapedPost['mediaType'] }),
      ]),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary.failed).toEqual([{ campaignId: campaign.id, campaign: CAMPAIGN_NAME, member: 'ale_ficticia', handle: 'ale_ficticia' }])
    expect(summary).toMatchObject({ partial: true, linked: 1, videos: 1 })
    // What could be done was done: the profile is linked and the other video is in
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })).personId).toEqual(expect.any(String))
    const media = await prisma.media.findMany()
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ externalId: ALEZ_VIDEO, influencerId: ig.id, publishedByInfluencerId: tt.id })
    // Not recorded as read...
    expect(await prisma.setting.findUnique({ where: { key: 'tiktok_link_checked' } })).toMatchObject({ value: '{}' })

    // ...so the next pass goes back to the campaign start again, and now it works
    serveTikTok({ ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO), video('ale_ficticia', '7696000000000000009')]) })
    const next = await runTikTokAutolink({ now: new Date('2026-10-21T12:00:00Z') })

    expect(batch.mock.calls[1]).toEqual([['ale_ficticia'], { resultsPerPage: 100, oldestPostDate: '2026-10-01' }])
    expect(next).toMatchObject({ failed: [], partial: false, linked: 0, videos: 1 })
    expect(await prisma.media.count()).toBe(2)
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.personLog.count()).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('profiles already linked keep being read', () => {
  it('reads the TikTok profile a PM linked to a member, whatever its handle, and credits the member', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('gladys.ig', 'INSTAGRAM', { followers: 190 })
    await join(campaign.id, ig.id, { status: 'POSTED' })
    // Linked by hand (as "Añadir publicación por URL" does): a bare row, never analysed
    const tt = await findOrCreateInfluencerExact('TIKTOK', 'gema.ficticia_', PM)
    const { personId } = await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_confirmed' })
    const before = await counts()
    serveTikTok({
      'gema.ficticia_': account('gema.ficticia_', [
        video('gema.ficticia_', '7699205467465108768'),
        video('gema.ficticia_', '7699205467465108999', { postedAt: '2026-10-18T10:00:00.000Z', views: 800 }),
        video('gema.ficticia_', '7699000000000000001', { caption: 'Otro tema', hashtags: [] }),
      ], { followers: 18000, avgViews: 3100 }),
      // Her Instagram username on TikTok is somebody else: it must not even be asked for
      'gladys.ig': account('gladys.ig', [video('gladys.ig', '7700000000000000009')]),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(batch.mock.calls).toEqual([[['gema.ficticia_'], { resultsPerPage: 100, oldestPostDate: '2026-10-01' }]])
    expect(summary).toMatchObject({ handlesScanned: 1, linked: 0, videos: 2, notLinked: [], failed: [] })
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 0, known: 1, linked: [], videos: 2 }])

    // Nothing about identity or membership changed
    expect(await counts()).toEqual({ ...before, media: 2, notifications: 2 })
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })).personId).toBe(personId)

    const media = await prisma.media.findMany({ orderBy: { externalId: 'asc' } })
    expect(media.map(m => m.externalId)).toEqual(['7699205467465108768', '7699205467465108999'])
    for (const row of media) expect(row).toMatchObject({ influencerId: ig.id, publishedByInfluencerId: tt.id, platform: 'TIKTOK', campaignId: campaign.id, source: 'apify' })
    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 2, detached: 0 })

    // The profile nobody else reads is kept fresh (a row never analysed takes everything)
    const refreshed = await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })
    expect(refreshed).toMatchObject({ followers: 18000, avgViews: 3100, addedByName: 'Laura PM' })
    expect(refreshed.lastScraped).toBeInstanceOf(Date)

    // The team gets the notice a member's new post gets
    const notifications = await prisma.notification.findMany({ orderBy: { message: 'asc' } })
    expect(notifications.every(n => n.type === 'media_posted' && n.title === '@gladys.ig ha publicado' && n.userId === campaign.pmId)).toBe(true)
    expect(notifications.map(n => n.message)).toEqual([
      `@gladys.ig ha publicado en TikTok desde su perfil @gema.ficticia_ para la campaña "${CAMPAIGN_NAME}". Ver: https://www.tiktok.com/@gema.ficticia_/video/7699205467465108768 Consejo: espera 7 días antes de revisar las métricas.`,
      `@gladys.ig ha publicado en TikTok desde su perfil @gema.ficticia_ para la campaña "${CAMPAIGN_NAME}". Ver: https://www.tiktok.com/@gema.ficticia_/video/7699205467465108999 Consejo: espera 7 días antes de revisar las métricas.`,
    ])
  })

  it('keeps reading after linking: a later video enters on the next pass, with a short daily read', async () => {
    const { campaign, ig, tt } = await ale_ficticiaFixture()
    serveTikTok({ ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)]) })
    await runTikTokAutolink({ now: NOW })
    const afterFirst = await counts()

    const later = video('ale_ficticia', '7696000000000000002', { postedAt: '2026-10-21T08:00:00.000Z', views: 900 })
    serveTikTok({ ale_ficticia: account('ale_ficticia', [later, video('ale_ficticia', ALEZ_VIDEO, { views: 9000 })]) })
    const summary = await runTikTokAutolink({ now: new Date('2026-10-21T12:00:00Z') })

    // Daily read: only what is new since the last pass, minus a day of margin
    expect(batch.mock.calls[1]).toEqual([['ale_ficticia'], { resultsPerPage: 40, oldestPostDate: '2026-10-19' }])
    expect(summary).toMatchObject({ handlesScanned: 1, linked: 0, videos: 1 })
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 0, known: 1, linked: [], videos: 1 }])

    expect(await counts()).toEqual({ ...afterFirst, media: 2, notifications: 2 })
    const media = await prisma.media.findMany({ orderBy: { postedAt: 'asc' } })
    expect(media.map(m => [m.externalId, m.views])).toEqual([[ALEZ_VIDEO, 9000], ['7696000000000000002', 900]])
    for (const row of media) expect(row).toMatchObject({ influencerId: ig.id, publishedByInfluencerId: tt.id, platform: 'TIKTOK', campaignId: campaign.id })
    expect((await prisma.notification.findMany({ orderBy: { createdAt: 'asc' } })).map(n => n.title)).toEqual(['TikTok vinculado', '@ale_ficticia ha publicado'])
  })

  it('a windowed read never replaces the averages of a profile that was analysed', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('lili_ficticia', 'INSTAGRAM')
    const tt = await profile('lili_ficticia', 'TIKTOK', { followers: 1969, avgViews: 50000, avgLikes: 4000, engagementRate: 9.1, lastScraped: new Date('2026-09-01T00:00:00Z') })
    await join(campaign.id, ig.id)
    await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_confirmed' })
    serveTikTok({ lili_ficticia: account('lili_ficticia', [], { followers: 2100, avgViews: 12, avgLikes: 1, engagementRate: 0.1, displayName: 'Lilin' }) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(summary).toMatchObject({ handlesScanned: 1, videos: 0, linked: 0 })
    const refreshed = await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })
    expect(refreshed).toMatchObject({ followers: 2100, displayName: 'Lilin', avgViews: 50000, avgLikes: 4000, engagementRate: 9.1 })
    expect(refreshed.lastScraped!.getTime()).toBeGreaterThan(new Date('2026-09-01T00:00:00Z').getTime())
    expect(await prisma.media.count()).toBe(0)
    expect(await prisma.notification.count()).toBe(0)
  })

  it('does not read a linked TikTok profile that is itself a member: the member crons do, and its content is its own', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('dana_ejemplo_dos', 'INSTAGRAM')
    const tt = await profile('dana_ejemplo_dos', 'TIKTOK')
    await join(campaign.id, ig.id)
    await join(campaign.id, tt.id)
    await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_manual' })
    serveTikTok({ dana_ejemplo_dos: account('dana_ejemplo_dos', [video('dana_ejemplo_dos', '7700000000000000002')]) })

    const summary = await runTikTokAutolink({ now: NOW })

    expect(batch).not.toHaveBeenCalled()
    expect(summary.campaigns[0]).toMatchObject({ candidates: 0, known: 0, linked: [], videos: 0 })
    expect(await prisma.media.count()).toBe(0)
    expect(await prisma.campaignInfluencer.count()).toBe(2)
  })

  it('does not read the linked profile of a member that is not confirmed', async () => {
    const campaign = await octoberCampaign()
    const ig = await profile('ale_ficticia', 'INSTAGRAM')
    const tt = await profile('ale_ficticia', 'TIKTOK')
    await join(campaign.id, ig.id, { status: 'OUTREACH' })
    await linkProfile({ memberInfluencerId: ig.id, profileInfluencerId: tt.id, actor: PM, evidence: 'pm_confirmed' })
    serveTikTok({ ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)]) })

    await runTikTokAutolink({ now: NOW })

    expect(batch).not.toHaveBeenCalled()
    expect(await prisma.media.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('a second run', () => {
  it('creates nothing new: no person, no log, no profile, no member, no video, no notice', async () => {
    const { campaign, ig, tt } = await ale_ficticiaFixture()
    const answer = { ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)], { followers: 29500 }) }
    serveTikTok(answer)
    const first = await runTikTokAutolink({ now: NOW })
    expect(first).toMatchObject({ linked: 1, videos: 1 })
    const afterFirst = await counts()
    expect(afterFirst).toEqual({ influencers: 2, memberships: 1, persons: 1, logs: 1, media: 1, notifications: 1 })
    const mediaBefore = await prisma.media.findMany()
    const membershipsBefore = await prisma.campaignInfluencer.findMany()
    const logsBefore = await prisma.personLog.findMany()

    // The same day again (a forced run), and the day after: TikTok answers the same
    const again = await runTikTokAutolink({ now: NOW })
    const nextDay = await runTikTokAutolink({ now: new Date('2026-10-21T12:00:00Z') })

    for (const summary of [again, nextDay]) {
      expect(summary).toMatchObject({ handlesScanned: 1, answered: 1, linked: 0, videos: 0, notLinked: [], failed: [], partial: false })
      expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 0, known: 1, linked: [], videos: 0 }])
    }
    expect(await counts()).toEqual(afterFirst)
    expect(await prisma.campaignInfluencer.findMany()).toEqual(membershipsBefore)
    expect(await prisma.personLog.findMany()).toEqual(logsBefore)
    const mediaAfter = await prisma.media.findMany()
    expect(mediaAfter).toHaveLength(1)
    expect(mediaAfter[0]).toMatchObject({
      id: mediaBefore[0].id,
      influencerId: ig.id,
      publishedByInfluencerId: tt.id,
      campaignId: campaign.id,
      views: mediaBefore[0].views,
      discoveredAt: mediaBefore[0].discoveredAt,
    })
    expect(await prisma.influencer.count({ where: { personId: { not: null } } })).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe('legacy twins', () => {
  it('are left exactly as they are, and their Instagram member is not looked for again', async () => {
    const campaign = await octoberCampaign()
    // A twin created by the pass before 12 Nov 2026 (the two of «Dorco - Delyplus»)
    const ig = await profile('hola_soy_demo', 'INSTAGRAM', { followers: 5000 })
    const twin = await profile('hola_soy_demo', 'TIKTOK', { followers: 9000 })
    await join(campaign.id, ig.id, { status: 'POSTED', agreedFee: 300 })
    await join(campaign.id, twin.id, { status: 'POSTED', source: `${TIKTOK_LINK_SOURCE_PREFIX}${ig.id}` })
    // A twin whose TikTok handle is not her Instagram one
    const ig2 = await profile('pablo.ugc', 'INSTAGRAM')
    const twin2 = await profile('pablo_ugc_demo', 'TIKTOK')
    await join(campaign.id, ig2.id)
    await join(campaign.id, twin2.id, { source: `${TIKTOK_LINK_SOURCE_PREFIX}${ig2.id}` })
    // The same person added twice by hand, once per network (@dana_ejemplo_dos in October)
    const dianaIg = await profile('dana_ejemplo_dos', 'INSTAGRAM')
    const dianaTt = await profile('dana_ejemplo_dos', 'TIKTOK')
    await join(campaign.id, dianaIg.id)
    await join(campaign.id, dianaTt.id)
    // Content the twins already hold
    await prisma.media.create({ data: { platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7690000000000000001', caption: '#vileda', hashtags: ['vileda'], postedAt: new Date('2026-10-05T10:00:00Z'), influencerId: twin.id, campaignId: campaign.id, views: 1200 } })
    await prisma.media.create({ data: { platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7690000000000000002', caption: '#vileda', hashtags: ['vileda'], postedAt: new Date('2026-10-06T10:00:00Z'), influencerId: dianaTt.id, campaignId: campaign.id, views: 700 } })
    // And one creator the pass does have to look for
    const alez = await profile('ale_ficticia', 'INSTAGRAM')
    await join(campaign.id, alez.id)

    const snapshot = async () => ({
      memberships: await prisma.campaignInfluencer.findMany({ where: { influencerId: { not: alez.id } }, orderBy: { id: 'asc' } }),
      media: await prisma.media.findMany({ where: { influencerId: { in: [twin.id, dianaTt.id] } }, orderBy: { id: 'asc' } }),
      profiles: await prisma.influencer.findMany({ where: { id: { in: [ig.id, twin.id, ig2.id, twin2.id, dianaIg.id, dianaTt.id] } }, orderBy: { id: 'asc' } }),
    })
    const before = await snapshot()
    expect(before.memberships).toHaveLength(6)
    // If any of these were read, their videos would be evidence
    serveTikTok({
      hola_soy_demo: account('hola_soy_demo', [video('hola_soy_demo', '7690000000000000001'), video('hola_soy_demo', '7690000000000000009')]),
      pablo_ugc_demo: account('pablo_ugc_demo', [video('pablo_ugc_demo', '7690000000000000003')]),
      'pablo.ugc': account('pablo.ugc', [video('pablo.ugc', '7690000000000000004')]),
      dana_ejemplo_dos: account('dana_ejemplo_dos', [video('dana_ejemplo_dos', '7690000000000000002')]),
      ale_ficticia: account('ale_ficticia', [video('ale_ficticia', ALEZ_VIDEO)]),
    })

    const summary = await runTikTokAutolink({ now: NOW })

    // Only the creator without a TikTok in the campaign was read
    expect(requestedHandles()).toEqual(['ale_ficticia'])
    expect(summary.campaigns).toEqual([{ id: campaign.id, name: CAMPAIGN_NAME, candidates: 1, known: 0, linked: ['ale_ficticia'], videos: 1 }])

    // The twins, the double membership and their content: byte for byte as before
    expect(await snapshot()).toEqual(before)
    expect(before.profiles.every(p => p.personId === null)).toBe(true)
    // 7 memberships before and after: the new profile is not a member
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: campaign.id } })).toBe(7)
    // The roster still credits each legacy account to itself
    const roster = await loadCampaignRoster(campaign.id)
    expect(roster.creditFor('TIKTOK', 'hola_soy_demo')).toMatchObject({ self: true, member: { influencerId: twin.id } })
    expect(roster.creditFor('TIKTOK', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: dianaTt.id } })
    expect(roster.creditFor('TIKTOK', 'ale_ficticia')).toMatchObject({ self: false, member: { influencerId: alez.id } })
    expect(await prisma.person.count()).toBe(1)
  })
})
