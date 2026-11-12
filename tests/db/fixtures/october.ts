/**
 * An October-like campaign for the manual-media endpoint tests.
 *
 * It has the SHAPE of the real «Micros Octubre» case (36 memberships, the
 * same person twice as Instagram and TikTok, six Instagram members whose
 * TikTok accounts exist in the table but are not members, a member registered
 * with a wrong Instagram handle) but every handle, id and figure is INVENTED:
 * nothing here is a real person's data.
 *
 *   36 memberships = 35 Instagram (31 COMPLETED, 4 CONTRACTED) + 1 TikTok
 *   media before   = 23 Instagram reels + 7 Instagram stories + 1 TikTok video
 *   seven links    = six TikTok videos and one Instagram reel, all published
 *                    by profiles that are NOT members
 */
import { prisma } from '@/lib/db'
import type { ScrapedSinglePost } from '@/lib/apify'
import type { InfluencerStatus, Platform } from '@/generated/prisma/client'

/** A TikTok id built the way the real ones are: the top 32 bits are Unix seconds. */
export function tiktokIdAt(iso: string, low = 1): string {
  const seconds = BigInt(Math.floor(Date.parse(iso) / 1000))
  return ((seconds << BigInt(32)) | BigInt(low)).toString()
}

/** An Instagram story id (snowflake): milliseconds since the Instagram epoch, shifted 23 bits. */
export function storyIdAt(iso: string, low = 1): string {
  const ms = BigInt(Date.parse(iso) - 1314220021721)
  return ((ms << BigInt(23)) | BigInt(low)).toString()
}

/** The six creators of the case: Instagram members whose TikTok account exists as a non-member row. */
export const SIX = [
  { handle: 'alba_prueba', igFollowers: 2100, tiktokFollowers: 31000, website: 'https://www.tiktok.com/@alba_prueba' },
  { handle: 'gema.ficticia_', igFollowers: 240, tiktokFollowers: 16500, website: 'https://www.tiktok.com/@gema.ficticia_?lang=es' },
  { handle: 'sara_inventada17', igFollowers: 5800, tiktokFollowers: 12200, website: null },
  // Registered with a wrong Instagram handle: her real Instagram is @risasdeprueba_, which has no row
  { handle: 'risasdeprueba', igFollowers: 12, tiktokFollowers: 7600, website: null },
  { handle: 'nuria_demo15', igFollowers: 3400, tiktokFollowers: 1300, website: null },
  { handle: 'lili_ficticia', igFollowers: 5, tiktokFollowers: 2050, website: null },
] as const

/** The same handle is a member twice (Instagram and TikTok): 36 «creators» are 35 people. */
export const TWICE = 'dana_ejemplo'
export const REAL_INSTAGRAM_OF_RISAS = 'risasdeprueba_'

export interface SevenLink {
  /** What the PM pastes */
  url: string
  /** The clean link the endpoint works with (and what the scraper is asked for) */
  canonicalUrl: string
  platform: Platform
  /** The account that published it */
  author: string
  /** The Instagram member it belongs to */
  memberHandle: string
  /** Why the endpoint suggests that member, or null when it cannot suggest her */
  expectedReason: 'bio_link' | 'same_handle' | null
  postedAt: string
  /** What the (mocked) network answers for it */
  scraped: ScrapedSinglePost
}

function tiktokLink(handle: string, postedAt: string, low: number, figures: { views: number; likes: number; comments: number }, expectedReason: SevenLink['expectedReason']): SevenLink {
  const id = tiktokIdAt(postedAt, low)
  const url = `https://www.tiktok.com/@${handle}/video/${id}`
  return {
    url,
    canonicalUrl: url,
    platform: 'TIKTOK',
    author: handle,
    memberHandle: handle,
    expectedReason,
    postedAt,
    scraped: {
      externalId: id,
      caption: 'Probando la fregona nueva #marcademo',
      likes: figures.likes,
      comments: figures.comments,
      views: figures.views,
      thumbnailUrl: null,
      postedAt,
      ownerUsername: handle,
      mediaType: 'VIDEO',
      hashtags: ['#marcademo'],
      mentions: [],
    },
  }
}

/** The seven publications of the case, in the order of the brief (ids, dates and figures are invented). */
export const SEVEN_LINKS: SevenLink[] = [
  tiktokLink('alba_prueba', '2026-10-12T18:30:00.000Z', 11, { views: 5400, likes: 320, comments: 14 }, 'bio_link'),
  tiktokLink('gema.ficticia_', '2026-10-21T19:45:10.000Z', 12, { views: 12100, likes: 910, comments: 33 }, 'bio_link'),
  tiktokLink('sara_inventada17', '2026-10-07T08:05:00.000Z', 13, { views: 2300, likes: 150, comments: 6 }, 'same_handle'),
  tiktokLink('risasdeprueba', '2026-10-06T16:20:30.000Z', 14, { views: 8800, likes: 640, comments: 21 }, 'same_handle'),
  {
    // An Instagram reel link carries no username: only the network knows whose it is
    url: 'https://www.instagram.com/reels/DfIcTiCiA01/',
    canonicalUrl: 'https://www.instagram.com/reel/DfIcTiCiA01/',
    platform: 'INSTAGRAM',
    author: REAL_INSTAGRAM_OF_RISAS,
    memberHandle: 'risasdeprueba',
    expectedReason: null,
    postedAt: '2026-10-09T17:20:00.000Z',
    scraped: {
      externalId: '3745000000000000001',
      caption: 'Truco de limpieza #marcademo',
      likes: 480,
      comments: 19,
      views: 7300,
      thumbnailUrl: null,
      postedAt: '2026-10-09T17:20:00.000Z',
      ownerUsername: REAL_INSTAGRAM_OF_RISAS,
      mediaType: 'REEL',
      hashtags: ['#marcademo'],
      mentions: ['@marca.demo'],
    },
  },
  tiktokLink('nuria_demo15', '2026-10-05T21:10:00.000Z', 16, { views: 1900, likes: 95, comments: 3 }, 'same_handle'),
  tiktokLink('lili_ficticia', '2026-10-08T12:40:15.000Z', 17, { views: 3100, likes: 210, comments: 9 }, 'same_handle'),
]

export const SEVEN_TOTALS = {
  views: SEVEN_LINKS.reduce((n, l) => n + l.scraped.views, 0),
  engagements: SEVEN_LINKS.reduce((n, l) => n + l.scraped.likes + l.scraped.comments, 0),
}

export interface OctoberFixture {
  campaignId: string
  /** The project manager who uses the endpoint (a real User row) */
  pm: { id: string; email: string; name: string; role: string }
  /** Instagram members by handle (the TikTok member of TWICE is `tiktokTwice`) */
  instagram: Record<string, { id: string; username: string }>
  /** TikTok rows that are NOT members, by handle */
  tiktokOutside: Record<string, { id: string; username: string }>
  /** The one TikTok member */
  tiktokTwice: { id: string; username: string }
}

/** A video baseline frozen before the campaign: her usual reel gets `medianViews` views. */
export function videoBaseline(medianViews: number) {
  return {
    family: 'video', format: 'REEL', n: 10, nRaw: 12, medianViews, medianEngagement: 80, pctBranded: 0,
    windowDays: 180, before: '2026-09-25T00:00:00.000Z', capturedAt: '2026-09-25T00:00:00.000Z', source: 'apify',
  }
}

export async function seedOctober(): Promise<OctoberFixture> {
  const pm = await prisma.user.create({
    data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' },
  })
  const campaign = await prisma.campaign.create({
    data: {
      name: '10.- Marca Demo - Micros Octubre (test)',
      status: 'ACTIVE',
      type: 'INFLUENCER_TRACKING',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.demo'],
      targetHashtags: ['marcademo'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: pm.id,
    },
  })

  const instagram: OctoberFixture['instagram'] = {}
  const tiktokOutside: OctoberFixture['tiktokOutside'] = {}
  let order = 0
  const join = async (influencerId: string, status: InfluencerStatus, extra: { agreedFee?: number; baselineSnapshot?: object } = {}) => {
    order++
    await prisma.campaignInfluencer.create({
      data: {
        campaignId: campaign.id,
        influencerId,
        status,
        source: 'manual',
        // Memberships in a known order (the roster breaks ties by the oldest)
        createdAt: new Date(Date.UTC(2026, 8, 20, 9, order)),
        ...extra,
      },
    })
  }

  // The six of the case: Instagram member + a TikTok row that is not a member
  for (const c of SIX) {
    const ig = await prisma.influencer.create({
      data: { username: c.handle, platform: 'INSTAGRAM', followers: c.igFollowers, website: c.website },
    })
    instagram[c.handle] = { id: ig.id, username: ig.username }
    await join(ig.id, 'COMPLETED', {
      agreedFee: 120,
      // Her usual Instagram reel: the "vs su habitual" comparison of the report
      ...(c.handle === 'alba_prueba' ? { baselineSnapshot: videoBaseline(1000) } : {}),
    })
    const tt = await prisma.influencer.create({
      data: { username: c.handle, platform: 'TIKTOK', followers: c.tiktokFollowers, dataSource: 'apify' },
    })
    tiktokOutside[c.handle] = { id: tt.id, username: tt.username }
  }

  // The person who is a member twice
  const twiceIg = await prisma.influencer.create({ data: { username: TWICE, platform: 'INSTAGRAM', followers: 5100 } })
  instagram[TWICE] = { id: twiceIg.id, username: twiceIg.username }
  await join(twiceIg.id, 'COMPLETED', { agreedFee: 120 })
  const twiceTt = await prisma.influencer.create({ data: { username: TWICE, platform: 'TIKTOK', followers: 9400 } })
  await join(twiceTt.id, 'COMPLETED')

  // 28 more Instagram members: 35 Instagram in all, 4 of them still CONTRACTED
  for (let i = 1; i <= 28; i++) {
    const handle = `creadora_demo_${String(i).padStart(2, '0')}`
    const row = await prisma.influencer.create({ data: { username: handle, platform: 'INSTAGRAM', followers: 1000 + i * 150 } })
    instagram[handle] = { id: row.id, username: row.username }
    await join(row.id, i > 24 ? 'CONTRACTED' : 'COMPLETED', { agreedFee: 100 })
  }

  // What the campaign already had: 23 reels, 7 stories, 1 TikTok video
  let n = 0
  const piece = (influencerId: string, platform: Platform, mediaType: 'REEL' | 'STORY' | 'VIDEO', figures: { views: number; likes?: number; comments?: number; reach?: number }, day: number) => {
    n++
    return prisma.media.create({
      data: {
        externalId: `before-${n}`,
        platform,
        mediaType,
        caption: 'Probando la fregona nueva #marcademo',
        permalink: `https://example.test/before/${n}`,
        views: figures.views,
        likes: figures.likes ?? 0,
        comments: figures.comments ?? 0,
        reach: figures.reach ?? 0,
        hashtags: ['#marcademo'],
        mentions: [],
        postedAt: new Date(Date.UTC(2026, 9, day, 12, 0, 0)),
        source: mediaType === 'STORY' ? 'manual' : 'apify',
        influencerId,
        campaignId: campaign.id,
      },
    })
  }
  await piece(instagram['alba_prueba'].id, 'INSTAGRAM', 'REEL', { views: 1500, likes: 90, comments: 4 }, 3)
  for (let i = 1; i <= 22; i++) {
    const handle = `creadora_demo_${String(i).padStart(2, '0')}`
    await piece(instagram[handle].id, 'INSTAGRAM', 'REEL', { views: 800 + i * 110, likes: 40 + i * 3, comments: 2 + (i % 5) }, 2 + (i % 27))
  }
  for (let i = 1; i <= 7; i++) {
    const handle = `creadora_demo_${String(i).padStart(2, '0')}`
    await piece(instagram[handle].id, 'INSTAGRAM', 'STORY', { views: 300 + i * 20, reach: 250 + i * 20 }, 10 + i)
  }
  await piece(twiceTt.id, 'TIKTOK', 'VIDEO', { views: 4200, likes: 260, comments: 11 }, 15)

  return {
    campaignId: campaign.id,
    pm: { id: pm.id, email: pm.email, name: pm.name, role: pm.role },
    instagram,
    tiktokOutside,
    tiktokTwice: { id: twiceTt.id, username: twiceTt.username },
  }
}
