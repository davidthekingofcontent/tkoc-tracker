/**
 * The acceptance of delivery 1 («una creadora = una persona con varios
 * perfiles») on REAL DATA: the publications the owner's brief lists are added
 * to the real campaign through the real route handler.
 *
 * It runs on a THROWAWAY CLONE of the local copy (CREATE DATABASE … TEMPLATE,
 * on the same local server) that is dropped at the end: the local copy itself
 * is never written, so overviews.test.ts keeps comparing it with its snapshot.
 * The last test proves it by counting the copy's rows before and after.
 *
 * The network is mocked (no scraper, no session service): the views, likes
 * and comments of the publications come from the input file and are invented.
 *
 * Input: REHEARSAL_OCTOBER_FILE, a JSON file kept OUT of the repository
 * because it names real creators:
 *   { campaignId, campaignName, members,
 *     links: [{ url, member, author, views, likes, comments, postedAt?, externalId? }] }
 *   member = the Instagram handle the creator is in the campaign with
 *   author = the handle of the account that published (what the network reports)
 * Without the variable the whole file is skipped.
 *
 *   REHEARSAL_DATABASE_URL=… REHEARSAL_OCTOBER_FILE=… npx vitest run --project rehearsal
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { cloneOfLocalCopy, countSourceRows } from './clone'
// Only PURE modules are imported statically. Everything that uses the
// database is loaded in beforeAll, once the clone exists (see the @/lib/db
// mock below: it refuses to be loaded earlier).
import { parsePostUrl } from '@/lib/post-url'
import { tiktokIdPostedAt } from '@/lib/tiktok-id'

const net = vi.hoisted(() => ({
  /** What the (mocked) network answers for each clean link */
  posts: new Map<string, unknown>(),
}))

const db = vi.hoisted(() => ({
  /** The clone's URL: set once the clone exists, before anything loads @/lib/db */
  url: '',
  /** Closes the client and its connections (needed before the clone can be dropped) */
  close: null as null | (() => Promise<void>),
}))

// The application's database client, pointed at the CLONE and owned by this
// file: it can only ever be built with the clone's URL, and its connections
// are closed here before the clone is dropped.
vi.mock('@/lib/db', async () => {
  if (!db.url) throw new Error('The clone is not ready: nothing may load @/lib/db before it exists')
  const { PrismaClient } = await import('@/generated/prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  // Given the URL (not a pool), the adapter owns its connections and closes them on $disconnect
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: db.url }) })
  db.close = async () => { await client.$disconnect().catch(() => {}) }
  return { prisma: client }
})

// No test may reach a scraper.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in the rehearsal`) })
  return {
    scrapeSinglePost: vi.fn(async (url: string) => net.posts.get(url) ?? null),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => true),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})

const SESSION = { id: 'ensayo-entrega-1', email: 'ensayo@example.test', name: 'Ensayo entrega 1', role: 'EMPLOYEE' }
// The session is the rehearsal's; the role rule (isStaffRole) is the real one.
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => SESSION) }
})

interface InputLink {
  url: string
  member: string
  author: string
  views: number
  likes: number
  comments: number
  postedAt?: string
  externalId?: string
}
interface Input {
  campaignId: string
  campaignName: string
  members: number
  links: InputLink[]
}

const FILE = process.env.REHEARSAL_OCTOBER_FILE || ''
const input: Input | null = FILE ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) as Input) : null

const clone = cloneOfLocalCopy('ensayo_octubre')

// ----- what is loaded once the clone exists --------------------------------
type Db = typeof import('@/lib/db')
type RouteModule = typeof import('@/app/api/campaigns/[id]/media/manual/route')
type OverviewModule = typeof import('@/lib/campaign-overview')
type CaptureModule = typeof import('@/lib/campaign-capture')
let prisma: Db['prisma']
let POST: RouteModule['POST']
let computeCampaignOverview: OverviewModule['computeCampaignOverview']
let revalidateCampaignMedia: CaptureModule['revalidateCampaignMedia']
let NextRequestCtor: typeof import('next/server').NextRequest

let sourceBefore: Record<string, number> = {}

interface Answer {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

async function add(body: unknown): Promise<Answer> {
  const request = new NextRequestCtor(`http://localhost/api/campaigns/${input!.campaignId}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await POST(request, { params: Promise.resolve({ id: input!.campaignId }) })
  return { status: response.status, body: await response.json() }
}

/** A TikTok id built the way the real ones are: the top 32 bits are Unix seconds. */
function tiktokIdAt(iso: string, low: number): string {
  return ((BigInt(Math.floor(Date.parse(iso) / 1000)) << BigInt(32)) | BigInt(low)).toString()
}

/** Tells the mocked network about a publication and returns its clean link. */
function serve(link: InputLink): { canonicalUrl: string; platform: string; postedAt: string } {
  const parsed = parsePostUrl(link.url)
  if (!parsed) throw new Error(`not a publication link: ${link.url}`)
  const postedAt = link.postedAt ?? tiktokIdPostedAt(parsed.externalId)?.toISOString()
  if (!postedAt) throw new Error(`no date for ${link.url}: give postedAt in the input file`)
  net.posts.set(parsed.canonicalUrl, {
    externalId: link.externalId ?? parsed.externalId,
    caption: 'Ensayo',
    likes: link.likes,
    comments: link.comments,
    views: link.views,
    thumbnailUrl: null,
    postedAt,
    ownerUsername: link.author,
    mediaType: parsed.mediaType,
    hashtags: [],
    mentions: [],
  })
  return { canonicalUrl: parsed.canonicalUrl, platform: parsed.platform, postedAt }
}

/** Everything a refused request must leave untouched, and what no request may ever change. */
async function state() {
  const [memberships, allMemberships, influencers, persons, logs, media, campaignMedia] = await Promise.all([
    prisma.campaignInfluencer.findMany({ where: { campaignId: input!.campaignId }, select: { id: true, influencerId: true, status: true, agreedFee: true }, orderBy: { id: 'asc' } }),
    prisma.campaignInfluencer.count(),
    prisma.influencer.count(),
    prisma.person.count(),
    prisma.personLog.count(),
    prisma.media.count(),
    prisma.media.count({ where: { campaignId: input!.campaignId } }),
  ])
  return { memberships, allMemberships, influencers, persons, logs, media, campaignMedia }
}

async function overviewsOfEveryCampaign(): Promise<Record<string, string>> {
  const campaigns = await prisma.campaign.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  const now = new Date('2026-11-12T12:00:00Z')
  const out: Record<string, string> = {}
  for (const c of campaigns) out[c.id] = JSON.stringify(await computeCampaignOverview(c.id, { now } as never))
  return out
}

const members = new Map<string, { id: string; username: string }>()
const memberOf = (link: InputLink) => {
  const m = members.get(link.member.toLowerCase())
  if (!m) throw new Error(`@${link.member} is not an Instagram member of the campaign in the copy`)
  return m
}

describe.skipIf(!input)('the publications of the brief, on a clone of the local copy', () => {
  let before: Awaited<ReturnType<typeof state>>
  let overviewsBefore: Record<string, string> = {}
  const stored = new Map<string, string>()

  beforeAll(async () => {
    sourceBefore = await countSourceRows()
    await clone.create()
    // From here on the database is the clone: only now load what uses it
    db.url = clone.url
    process.env.DATABASE_URL = db.url
    ;({ prisma } = await import('@/lib/db'))
    const [{ current }] = await prisma.$queryRaw<Array<{ current: string }>>`select current_database() as current`
    if (current !== clone.name) throw new Error(`Refusing to run: connected to "${current}", not to the clone "${clone.name}"`)
    ;({ POST } = await import('@/app/api/campaigns/[id]/media/manual/route'))
    ;({ computeCampaignOverview } = await import('@/lib/campaign-overview'))
    ;({ revalidateCampaignMedia } = await import('@/lib/campaign-capture'))
    ;({ NextRequest: NextRequestCtor } = await import('next/server'))

    const rows = await prisma.campaignInfluencer.findMany({
      where: { campaignId: input!.campaignId, influencer: { platform: 'INSTAGRAM' } },
      select: { influencer: { select: { id: true, username: true } } },
    })
    for (const r of rows) members.set(r.influencer.username.toLowerCase(), r.influencer)
    for (const link of input!.links) serve(link)
    overviewsBefore = await overviewsOfEveryCampaign()
    before = await state()
  }, 120_000)

  afterAll(async () => {
    if (db.close) await db.close()
    await clone.drop()
  }, 120_000)

  it('the copy holds the case of the brief', async () => {
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: input!.campaignId }, select: { name: true } })
    expect(campaign.name).toBe(input!.campaignName)
    expect(before.memberships).toHaveLength(input!.members)
    for (const link of input!.links) {
      expect(memberOf(link).id, `@${link.member}`).toBeTruthy()
      const parsed = parsePostUrl(link.url)!
      // None of the publications is in the campaign yet
      expect(await prisma.media.count({ where: { campaignId: input!.campaignId, OR: [{ externalId: parsed.externalId }, { permalink: { contains: parsed.permalinkNeedle } }] } }), link.url).toBe(0)
    }
    // Nobody is linked to anybody yet: the new columns start empty
    expect(before.persons).toBe(0)
    expect(await prisma.influencer.count({ where: { personId: { not: null } } })).toBe(0)
    expect(await prisma.media.count({ where: { publishedByInfluencerId: { not: null } } })).toBe(0)
  })

  it('each link asks whose profile it is, and that answer creates nothing', async () => {
    for (const link of input!.links) {
      const res = await add({ url: link.url })
      expect(res.status, link.url).toBe(409)
      expect(res.body.code, link.url).toBe('profile_not_linked')
      expect(res.body.author.handle).toBe(link.author.toLowerCase())
      expect(res.body.author.verified).toBe(true)
      expect(res.body.error).toContain('no está registrado como perfil de ninguna creadora de esta campaña')
      // Same handle on the other network: the member is offered
      if (link.author.toLowerCase() === link.member.toLowerCase()) {
        expect(res.body.suggestions.map((s: { influencerId: string }) => s.influencerId), link.url).toContain(memberOf(link).id)
      }
    }
    expect(await state()).toEqual(before)
  })

  it('each link is stored once the PM says whose profile it is, without creating a member', async () => {
    for (const link of input!.links) {
      const member = memberOf(link)
      const { platform, postedAt } = serve(link)
      const res = await add({ url: link.url, influencerId: member.id, linkProfileTo: member.id })
      expect([200, 201], `${link.url}: ${JSON.stringify(res.body)}`).toContain(res.status)
      expect(res.body.linkedProfile).toEqual({ handle: expect.any(String), platform, memberUsername: member.username })
      expect(String(res.body.linkedProfile.handle).toLowerCase()).toBe(link.author.toLowerCase())
      stored.set(link.url, res.body.media.id)

      const row = await prisma.media.findUniqueOrThrow({
        where: { id: res.body.media.id },
        include: { publishedBy: { select: { username: true, platform: true, personId: true } }, influencer: { select: { personId: true } } },
      })
      // Credited to the member she already is, published by her other profile, on the publication's network
      expect(row.campaignId).toBe(input!.campaignId)
      expect(row.influencerId).toBe(member.id)
      expect(row.platform).toBe(platform)
      expect(row.publishedByInfluencerId).not.toBeNull()
      expect(row.publishedByInfluencerId).not.toBe(member.id)
      expect(row.publishedBy?.username.toLowerCase()).toBe(link.author.toLowerCase())
      expect(row.publishedBy?.platform).toBe(platform)
      expect(row.publishedBy?.personId).toBeTruthy()
      expect(row.publishedBy?.personId).toBe(row.influencer.personId)
      expect(row.postedAt?.toISOString()).toBe(postedAt)
      expect(row.views).toBe(link.views)
      // The profile that published is not a member of anything because of this
      expect(await prisma.campaignInfluencer.count({ where: { influencerId: row.publishedByInfluencerId! } })).toBe(0)
    }

    const after = await state()
    // The same memberships, row by row, here and in every other campaign
    expect(after.memberships).toEqual(before.memberships)
    expect(after.memberships).toHaveLength(input!.members)
    expect(after.allMemberships).toBe(before.allMemberships)
    expect(after.campaignMedia).toBe(before.campaignMedia + input!.links.length)
    expect(new Set(stored.values()).size).toBe(input!.links.length)
    // One person per creator of the list, one log line per link
    expect(after.persons).toBe(new Set(input!.links.map(l => l.member.toLowerCase())).size)
    expect(after.logs).toBe(input!.links.length)
  })

  it('the campaign has the same creators and its views and interactions rise by the new content', async () => {
    const was = JSON.parse(overviewsBefore[input!.campaignId])
    const now = await computeCampaignOverview(input!.campaignId, { now: new Date('2026-11-12T12:00:00Z') } as never)
    expect(was.totals.members).toBe(input!.members)
    expect(now?.totals.members).toBe(input!.members)
    expect(now?.perInfluencer).toHaveLength(was.perInfluencer.length)
    expect(now!.perInfluencer.map(p => p.influencerId).sort()).toEqual(was.perInfluencer.map((p: { influencerId: string }) => p.influencerId).sort())
    const views = input!.links.reduce((n, l) => n + l.views, 0)
    const engagements = input!.links.reduce((n, l) => n + l.likes + l.comments, 0)
    expect(now?.totals.media).toBe(was.totals.media + input!.links.length)
    expect(now?.totals.views).toBe(was.totals.views + views)
    expect(now?.totals.engagements).toBe(was.totals.engagements + engagements)
    expect(now!.totals.views).toBeGreaterThan(was.totals.views)
    expect(now!.totals.engagements).toBeGreaterThan(was.totals.engagements)
    // Each creator's row gained exactly her own pieces, and "vs su habitual" did not move
    for (const row of now!.perInfluencer) {
      const old = was.perInfluencer.find((p: { influencerId: string }) => p.influencerId === row.influencerId)
      const hers = input!.links.filter(l => memberOf(l).id === row.influencerId)
      expect(row.media, row.username).toBe(old.media + hers.length)
      expect(row.views, row.username).toBe(old.views + hers.reduce((n, l) => n + l.views, 0))
      expect(JSON.stringify(row.vsBaseline), row.username).toBe(JSON.stringify(old.vsBaseline))
    }
  })

  it('adding a link again does not duplicate it', async () => {
    const was = await state()
    for (const link of input!.links) {
      for (const body of [{ url: link.url }, { url: link.url, influencerId: memberOf(link).id, linkProfileTo: memberOf(link).id }]) {
        const res = await add(body)
        expect(res.status, link.url).toBe(200)
        expect(res.body.created).toBe(false)
        expect(res.body.linkedProfile).toBeNull()
        expect(res.body.media.id).toBe(stored.get(link.url))
      }
    }
    expect(await state()).toEqual(was)
  })

  it('a link of somebody who is not in the campaign stays refused, with a clear message', async () => {
    const was = await state()
    // An account that has no row at all, and one that exists in the table but is nobody's profile here
    const outsiders = await prisma.influencer.findMany({
      where: { platform: 'TIKTOK', personId: null, campaigns: { none: {} } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { username: true },
      take: 200,
    })
    const outsider = outsiders.find(o => /^[a-z0-9._]{2,24}$/.test(o.username))
    expect(outsider, 'a TikTok account of the table that is nobody\'s profile').toBeDefined()
    if (!outsider) return
    for (const [i, handle] of ['cuenta_inexistente_ensayo', outsider.username].entries()) {
      const url = `https://www.tiktok.com/@${handle}/video/${tiktokIdAt('2026-10-15T10:00:00.000Z', 900 + i)}`
      serve({ url, member: '', author: handle, views: 10, likes: 1, comments: 0 })
      const res = await add({ url })
      expect(res.status, url).toBe(409)
      expect(res.body.code).toBe('profile_not_linked')
      expect(res.body.error).toBe(`Este contenido es de @${handle.toLowerCase()} en TikTok, que no está registrado como perfil de ninguna creadora de esta campaña.`)
    }
    expect(await state()).toEqual(was)
  })

  it('a link outside the campaign dates stays refused, before and after the window', async () => {
    const was = await state()
    const tiktok = input!.links.find(l => parsePostUrl(l.url)?.platform === 'TIKTOK')!
    for (const [i, day] of ['2026-11-05T10:00:00.000Z', '2026-09-20T10:00:00.000Z'].entries()) {
      // From a profile that is now registered, and from one that is not (with the PM's answer)
      const known = `https://www.tiktok.com/@${tiktok.author}/video/${tiktokIdAt(day, 950 + i)}`
      const unknown = `https://www.tiktok.com/@cuenta_inexistente_ensayo/video/${tiktokIdAt(day, 960 + i)}`
      serve({ url: known, member: tiktok.member, author: tiktok.author, views: 10, likes: 1, comments: 0 })
      serve({ url: unknown, member: tiktok.member, author: 'cuenta_inexistente_ensayo', views: 10, likes: 1, comments: 0 })
      for (const body of [{ url: known }, { url: unknown, linkProfileTo: memberOf(tiktok).id }]) {
        const res = await add(body)
        expect(res.status, JSON.stringify(body)).toBe(400)
        expect(res.body.error).toContain(`El contenido se publicó el ${day.slice(0, 10)}, fuera del periodo de la campaña`)
      }
    }
    expect(await state()).toEqual(was)
  })

  it('the revalidation keeps every new piece and no other campaign changed', async () => {
    const revalidated = await revalidateCampaignMedia(input!.campaignId)
    console.log(`revalidation of the campaign on the clone: kept ${revalidated.kept}, detached ${revalidated.detached}`)
    expect(revalidated.kept).toBeGreaterThanOrEqual(input!.links.length)
    for (const [url, id] of stored) {
      const row = await prisma.media.findUnique({ where: { id }, select: { campaignId: true } })
      expect(row?.campaignId, url).toBe(input!.campaignId)
    }
    const overviewsAfter = await overviewsOfEveryCampaign()
    expect(Object.keys(overviewsAfter).sort()).toEqual(Object.keys(overviewsBefore).sort())
    let unchanged = 0
    for (const [id, text] of Object.entries(overviewsBefore)) {
      if (id === input!.campaignId) continue
      expect(overviewsAfter[id] === text, `overview of campaign ${id}`).toBe(true)
      unchanged++
    }
    expect(unchanged).toBe(Object.keys(overviewsBefore).length - 1)
  })

  it('the local copy itself was never written', async () => {
    expect(await countSourceRows()).toEqual(sourceBefore)
  })
})
