/**
 * Folding the «twin» members (src/lib/person-fold.ts and /api/admin/fold-twins).
 *
 * Until 12 Nov 2026 a TikTok link of a creator registered with Instagram
 * created a SECOND member of the campaign (source 'tiktok_link:<instagram id>').
 * A fold credits the twin's pieces and notes to the creator's own row, removes
 * the second row, and keeps everything to put it back. On a real (throwaway)
 * database, these tests prove:
 *   - the fold moves the pieces (keeping who published them) and the notes,
 *     deletes only the twin's row and never writes the original's;
 *   - the overview counts one creator less, and the same views, likes,
 *     comments, shares, saves and pieces;
 *   - every blocker blocks and leaves the database exactly as it was;
 *   - undo puts every row back, column for column;
 *   - it is idempotent, and two folds of the same twin at once give one fold
 *     and a clean error;
 *   - the route is for an ADMIN only.
 * Every handle and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  session: null as null | { id: string; email: string; name: string; role: string },
}))

// No test may reach a scraper (the overview's modules must never call one).
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    isApifyExhausted: vi.fn(() => false),
  }
})

// The session is the test's; the role rule (isStaffRole) is the real one.
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import pg from 'pg'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import type { MediaType, Platform } from '@/generated/prisma/client'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import type { CampaignOverview } from '@/lib/metrics'
import {
  FoldError,
  TWIN_SOURCE_PREFIX,
  foldTwinMembership,
  foldTwins,
  listLiveFolds,
  listTwinMemberships,
  rowBlockers,
  undoFold,
} from '@/lib/person-fold'
import type { FoldBlockerCode } from '@/lib/person-fold'
import { GET, POST } from '@/app/api/admin/fold-twins/route'

const RATES = { rates: DEFAULT_EMV_RATES }

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignNote.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.setting.deleteMany({ where: { OR: [{ key: { startsWith: 'campaign_report_' } }, { key: { startsWith: 'ad_permissions_' } }] } })
  await prisma.user.deleteMany()
}

beforeEach(async () => {
  await reset()
  net.session = null
})
afterAll(reset)

// ---------------------------------------------------------------------------
// Fixture: an October-like campaign with two twins
// ---------------------------------------------------------------------------

/** A video baseline frozen before the campaign (her usual reel gets `medianViews` views). */
function videoBaseline(medianViews: number) {
  return {
    family: 'video', format: 'REEL', n: 10, nRaw: 12, medianViews, medianEngagement: 80, pctBranded: 0,
    windowDays: 180, before: '2026-09-25T00:00:00.000Z', capturedAt: '2026-09-25T00:00:00.000Z', source: 'apify',
  }
}

interface Fixture {
  admin: { id: string; email: string; name: string; role: string }
  employee: { id: string; email: string; name: string; role: string }
  campaignId: string
  /** Another campaign where the first twin's TikTok is an ordinary member */
  otherCampaignId: string
  /** Instagram member with fee, shipping, deal, baseline and content; her twin has content too */
  alba: string
  albaTt: string
  albaTwinMembership: string
  /** Instagram member with no content; her twin has two pieces */
  gema: string
  gemaTt: string
  gemaTwinMembership: string
  /** A third profile that published one of gema_tt's pieces */
  gemaOther: string
  bea: string
  dana: string
  albaMembership: string
  /** Pieces of the campaign */
  albaReel: string
  albaTtVideo: string
  gemaTtVideo1: string
  gemaTtVideo2: string
  beaReel: string
  /** alba_tt's piece in the other campaign, and one attached to no campaign */
  albaTtOtherVideo: string
  albaTtLoose: string
  /** Notes of the campaign on the twin, on the original, and the twin's note in the other campaign */
  twinNotes: string[]
  albaNote: string
  otherCampaignNote: string
}

let mediaSeq = 0
function piece(campaignId: string | null, influencerId: string, platform: Platform, mediaType: MediaType, figures: { views: number; likes: number; comments: number; shares?: number; saves?: number }, extra: { publishedByInfluencerId?: string; postedAt?: string } = {}) {
  mediaSeq++
  return prisma.media.create({
    data: {
      externalId: `ext-${mediaSeq}`,
      platform,
      mediaType,
      campaignId,
      influencerId,
      permalink: `https://example.test/p/${mediaSeq}`,
      caption: 'Probando #vileda',
      views: figures.views,
      likes: figures.likes,
      comments: figures.comments,
      shares: figures.shares ?? 0,
      saves: figures.saves ?? 0,
      postedAt: new Date(extra.postedAt ?? `2026-10-${String(10 + (mediaSeq % 15)).padStart(2, '0')}T10:00:00.000Z`),
      publishedByInfluencerId: extra.publishedByInfluencerId ?? null,
      source: 'manual',
    },
    select: { id: true },
  })
}

async function seed(): Promise<Fixture> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const adminUser = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const employeeUser = await prisma.user.create({ data: { email: `pm-${stamp}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Micros Octubre (prueba)',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: adminUser.id,
    },
  })
  const other = await prisma.campaign.create({
    data: {
      name: 'Otra campaña (prueba)',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['TIKTOK'],
      userId: adminUser.id,
    },
  })
  const inf = (username: string, platform: Platform, followers: number) =>
    prisma.influencer.create({ data: { username, platform, followers }, select: { id: true } })
  const alba = await inf('alba_prueba', 'INSTAGRAM', 2100)
  const albaTt = await inf('alba_prueba', 'TIKTOK', 31000)
  const gema = await inf('gema.ficticia_', 'INSTAGRAM', 240)
  const gemaTt = await inf('gema.ficticia_', 'TIKTOK', 16500)
  const gemaOther = await inf('gema_otra_cuenta', 'TIKTOK', 900)
  const bea = await inf('bea_ejemplo', 'INSTAGRAM', 8000)
  const dana = await inf('dana_ejemplo', 'INSTAGRAM', 1500)

  const albaMembership = await prisma.campaignInfluencer.create({
    data: {
      campaignId: campaign.id, influencerId: alba.id, status: 'CONTRACTED', agreedFee: 300, cost: 20, commission: 10, askingFee: 350,
      notes: 'Prefiere los martes', negotiatedFormat: 'REEL', rightsDays: 30, exclusivityDays: 30, whitelisting: true,
      dealClosedAt: new Date('2026-09-20T09:30:00.123Z'), deliverablesPlanned: 2, trackedLink: 'https://example.test/u?utm=alba', trackedClicks: 12,
      baselineSnapshot: videoBaseline(900), baselineAt: new Date('2026-09-25T00:00:00Z'),
      shippingName: 'Alba P.', shippingAddress1: 'Calle Inventada 1', shippingCity: 'Madrid', shippingPostCode: '28001', shippingCountry: 'ES',
      shippingPhone: '600000000', shippingEmail: 'alba@example.test', shippingProduct: 'Fregona', shippingQty: 2, shippingComments: 'Portal B',
      addedById: employeeUser.id, addedByName: 'Laura PM', createdAt: new Date('2026-09-15T08:00:00.456Z'),
    },
    select: { id: true },
  })
  const albaTwin = await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: albaTt.id, status: 'COMPLETED', source: `${TWIN_SOURCE_PREFIX}${alba.id}`, createdAt: new Date('2026-11-10T16:12:00.789Z') },
    select: { id: true },
  })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: gema.id, status: 'COMPLETED', agreedFee: 150 } })
  const gemaTwin = await prisma.campaignInfluencer.create({
    data: { campaignId: campaign.id, influencerId: gemaTt.id, status: 'COMPLETED', source: `${TWIN_SOURCE_PREFIX}${gema.id}` },
    select: { id: true },
  })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: bea.id, status: 'COMPLETED', agreedFee: 200 } })
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: dana.id, status: 'CONTRACTED' } })
  // In the other campaign alba's TikTok is an ordinary member, not a twin
  await prisma.campaignInfluencer.create({ data: { campaignId: other.id, influencerId: albaTt.id, status: 'COMPLETED', agreedFee: 90 } })

  const albaReel = await piece(campaign.id, alba.id, 'INSTAGRAM', 'REEL', { views: 1000, likes: 50, comments: 5, shares: 1, saves: 2 })
  const albaTtVideo = await piece(campaign.id, albaTt.id, 'TIKTOK', 'VIDEO', { views: 5400, likes: 120, comments: 4, shares: 3, saves: 2 })
  const gemaTtVideo1 = await piece(campaign.id, gemaTt.id, 'TIKTOK', 'VIDEO', { views: 3000, likes: 80, comments: 6, shares: 1, saves: 1 })
  const gemaTtVideo2 = await piece(campaign.id, gemaTt.id, 'TIKTOK', 'VIDEO', { views: 700, likes: 10, comments: 1 }, { publishedByInfluencerId: gemaOther.id })
  const beaReel = await piece(campaign.id, bea.id, 'INSTAGRAM', 'REEL', { views: 2500, likes: 90, comments: 9, shares: 2, saves: 3 })
  const albaTtOtherVideo = await piece(other.id, albaTt.id, 'TIKTOK', 'VIDEO', { views: 800, likes: 20, comments: 2 })
  const albaTtLoose = await piece(null, albaTt.id, 'TIKTOK', 'VIDEO', { views: 100, likes: 1, comments: 0 })

  const note = (campaignId: string, influencerId: string, text: string) =>
    prisma.campaignNote.create({ data: { campaignId, influencerId, userId: employeeUser.id, userName: 'Laura PM', text }, select: { id: true } })
  const twinNotes = [(await note(campaign.id, albaTt.id, 'Vídeo entregado el 12')).id, (await note(campaign.id, albaTt.id, 'Pedir el enlace bueno')).id]
  const albaNote = (await note(campaign.id, alba.id, 'Contrato firmado')).id
  const otherCampaignNote = (await note(other.id, albaTt.id, 'Nota de la otra campaña')).id

  return {
    admin: { id: adminUser.id, email: adminUser.email, name: 'Ada Admin', role: 'ADMIN' },
    employee: { id: employeeUser.id, email: employeeUser.email, name: 'Laura PM', role: 'EMPLOYEE' },
    campaignId: campaign.id,
    otherCampaignId: other.id,
    alba: alba.id,
    albaTt: albaTt.id,
    albaTwinMembership: albaTwin.id,
    gema: gema.id,
    gemaTt: gemaTt.id,
    gemaTwinMembership: gemaTwin.id,
    gemaOther: gemaOther.id,
    bea: bea.id,
    dana: dana.id,
    albaMembership: albaMembership.id,
    albaReel: albaReel.id,
    albaTtVideo: albaTtVideo.id,
    gemaTtVideo1: gemaTtVideo1.id,
    gemaTtVideo2: gemaTtVideo2.id,
    beaReel: beaReel.id,
    albaTtOtherVideo: albaTtOtherVideo.id,
    albaTtLoose: albaTtLoose.id,
    twinNotes,
    albaNote,
    otherCampaignNote,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

/** Every row of a table, every column, as the database stores it. */
async function rowsOf(table: 'campaign_influencers' | 'media' | 'campaign_notes' | 'influencers' | 'persons' | 'person_logs' | 'settings'): Promise<Row[]> {
  const rows = await prisma.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(t.*) AS row FROM ${Prisma.raw(`"${table}"`)} t ORDER BY t.id`
  return rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Row)
}

async function snapshot() {
  return {
    memberships: await rowsOf('campaign_influencers'),
    media: await rowsOf('media'),
    notes: await rowsOf('campaign_notes'),
    influencers: await rowsOf('influencers'),
    persons: await rowsOf('persons'),
    logs: await rowsOf('person_logs'),
    settings: await rowsOf('settings'),
  }
}

const byId = (rows: Row[]) => new Map(rows.map(r => [String(r.id), r]))
const without = (row: object, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))

async function overview(campaignId: string): Promise<CampaignOverview> {
  const o = await computeCampaignOverview(campaignId, RATES)
  if (!o) throw new Error('no overview')
  return o
}

async function expectFoldError(promise: Promise<unknown>, code: FoldError['code']): Promise<FoldError> {
  const err = await promise.then(() => null, e => e)
  expect(err, `expected FoldError ${code}`).toBeInstanceOf(FoldError)
  expect((err as FoldError).code).toBe(code)
  return err as FoldError
}

async function call(method: 'GET' | 'POST', body?: unknown, query = ''): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const request = new NextRequest(`http://localhost/api/admin/fold-twins${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const response = method === 'GET' ? await GET(request) : await POST(request)
  return { status: response.status, body: await response.json() }
}

const ACTOR = (fx: Fixture) => ({ id: fx.admin.id, name: fx.admin.name })

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown }

/**
 * Runs `start` while ANOTHER connection holds a row lock (`lockSql`), and
 * releases it only once `waiters` sessions are waiting for a lock: the calls
 * are then provably inside their transactions at the same time, whatever the
 * machine's speed.
 */
async function whileLocked(
  lockSql: string,
  params: unknown[],
  waiters: number,
  start: () => Array<Promise<unknown>>,
  /** Runs in the lock-holding transaction once everybody waits, right before it commits */
  beforeRelease?: (client: pg.Client) => Promise<unknown>
): Promise<Settled[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(lockSql, params)
    expect(locked.rowCount).toBeGreaterThan(0)
    const pending = start().map(p => p.then((value): Settled => ({ ok: true, value }), (error): Settled => ({ ok: false, error })))
    const deadline = Date.now() + 20_000
    for (;;) {
      // Inside a transaction pg_stat_activity is a snapshot taken at its first read: drop it every time
      await client.query('SELECT pg_stat_clear_snapshot()')
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
      )
      if (rows[0].n >= waiters) break
      if (Date.now() > deadline) throw new Error(`only ${rows[0].n} of ${waiters} sessions ever waited for the lock`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (beforeRelease) await beforeRelease(client)
    await client.query('COMMIT')
    return await Promise.all(pending)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  }
}

// ---------------------------------------------------------------------------

describe('listTwinMemberships', () => {
  it('lists each twin with its original, its pieces and notes, and no blocker; it changes nothing', async () => {
    const fx = await seed()
    const before = await snapshot()
    const twins = await listTwinMemberships()
    expect(twins.map(t => t.membershipId)).toEqual([fx.albaTwinMembership, fx.gemaTwinMembership])
    const [albaTwin, gemaTwin] = twins
    expect(albaTwin).toMatchObject({
      campaignId: fx.campaignId,
      campaignMembers: 6,
      twin: { influencerId: fx.albaTt, username: 'alba_prueba', platform: 'TIKTOK', status: 'COMPLETED', personId: null },
      original: { influencerId: fx.alba, membershipId: fx.albaMembership, platform: 'INSTAGRAM', status: 'CONTRACTED' },
      pieces: 1,
      notes: 2,
      blockers: [],
    })
    expect(gemaTwin).toMatchObject({ twin: { influencerId: fx.gemaTt }, original: { influencerId: fx.gema }, pieces: 2, notes: 0, blockers: [] })
    expect(await listTwinMemberships(fx.otherCampaignId)).toEqual([])
    expect(await snapshot()).toEqual(before)
  })

  it('reads the prefix literally: "_" is not a wildcard', async () => {
    const fx = await seed()
    await prisma.campaignInfluencer.update({ where: { id: fx.gemaTwinMembership }, data: { source: `tiktokXlink:${fx.gema}` } })
    expect((await listTwinMemberships()).map(t => t.membershipId)).toEqual([fx.albaTwinMembership])
  })
})

describe('foldTwinMembership', () => {
  it('moves the pieces and notes of that campaign to the original, keeps who published them and deletes only the twin row', async () => {
    const fx = await seed()
    const before = await snapshot()
    const result = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    const after = await snapshot()

    expect(result).toMatchObject({
      campaignId: fx.campaignId,
      membershipId: fx.albaTwinMembership,
      twin: { influencerId: fx.albaTt, username: 'alba_prueba', platform: 'TIKTOK' },
      original: { influencerId: fx.alba, membershipId: fx.albaMembership },
      linkedNow: true,
      movedPieces: 1,
      movedNotes: 2,
    })

    // Memberships: only the twin's row is gone; the original's row is byte-identical
    const removed = before.memberships.filter(r => !after.memberships.some(a => a.id === r.id))
    expect(removed.map(r => r.id)).toEqual([fx.albaTwinMembership])
    expect(after.memberships).toEqual(before.memberships.filter(r => r.id !== fx.albaTwinMembership))
    expect(byId(after.memberships).get(fx.albaMembership)).toEqual(byId(before.memberships).get(fx.albaMembership))

    // Media: the twin's piece of THIS campaign is credited to alba and published by the TikTok profile
    const mediaBefore = byId(before.media)
    const mediaAfter = byId(after.media)
    expect(mediaAfter.get(fx.albaTtVideo)).toMatchObject({ influencerId: fx.alba, publishedByInfluencerId: fx.albaTt, platform: 'TIKTOK' })
    expect(without(mediaAfter.get(fx.albaTtVideo)!, 'influencerId', 'publishedByInfluencerId', 'updatedAt'))
      .toEqual(without(mediaBefore.get(fx.albaTtVideo)!, 'influencerId', 'publishedByInfluencerId', 'updatedAt'))
    // Every other piece, the twin's piece in the other campaign and the loose one included, is untouched
    for (const [id, row] of mediaBefore) if (id !== fx.albaTtVideo) expect(mediaAfter.get(id), id).toEqual(row)

    // Notes: the twin's notes of this campaign move; alba's and the other campaign's do not
    const notesAfter = byId(after.notes)
    for (const id of fx.twinNotes) expect(notesAfter.get(id)).toEqual({ ...byId(before.notes).get(id), influencerId: fx.alba })
    expect(notesAfter.get(fx.albaNote)).toEqual(byId(before.notes).get(fx.albaNote))
    expect(notesAfter.get(fx.otherCampaignNote)).toEqual(byId(before.notes).get(fx.otherCampaignNote))

    // One person, two profiles
    const [albaRow, albaTtRow] = await Promise.all([
      prisma.influencer.findUniqueOrThrow({ where: { id: fx.alba } }),
      prisma.influencer.findUniqueOrThrow({ where: { id: fx.albaTt } }),
    ])
    expect(albaRow.personId).toBeTruthy()
    expect(albaTtRow.personId).toBe(albaRow.personId)
    expect(result.personId).toBe(albaRow.personId)

    // The log keeps the whole deleted row and the previous values of every moved row
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: result.logId } })
    expect(log).toMatchObject({ action: 'fold_membership', personId: albaRow.personId, actorId: fx.admin.id, actorName: 'Ada Admin', evidence: 'autolink_video', undoneAt: null })
    const logged = log.before as { membership: Row; media: Row[]; notes: Row[]; original: Row }
    expect(logged.membership).toEqual(byId(before.memberships).get(fx.albaTwinMembership))
    expect(logged.media).toEqual([{ id: fx.albaTtVideo, influencerId: fx.albaTt, publishedByInfluencerId: null, updatedAt: mediaBefore.get(fx.albaTtVideo)!.updatedAt }])
    expect(logged.notes).toEqual([...fx.twinNotes].sort().map(id => ({ id, influencerId: fx.albaTt })))
    expect(logged.original).toEqual({ membershipId: fx.albaMembership, influencerId: fx.alba })
    expect(await prisma.personLog.count({ where: { action: 'link_profile' } })).toBe(1)
    expect(await listLiveFolds(fx.campaignId)).toEqual([expect.objectContaining({ logId: result.logId, campaignId: fx.campaignId, membershipId: fx.albaTwinMembership })])
  })

  it('keeps an existing publisher and moves pieces of a twin whose original had none', async () => {
    const fx = await seed()
    const result = await foldTwinMembership(fx.gemaTwinMembership, ACTOR(fx))
    expect(result.movedPieces).toBe(2)
    const [v1, v2] = await Promise.all([
      prisma.media.findUniqueOrThrow({ where: { id: fx.gemaTtVideo1 } }),
      prisma.media.findUniqueOrThrow({ where: { id: fx.gemaTtVideo2 } }),
    ])
    expect(v1).toMatchObject({ influencerId: fx.gema, publishedByInfluencerId: fx.gemaTt })
    expect(v2).toMatchObject({ influencerId: fx.gema, publishedByInfluencerId: fx.gemaOther })
  })

  it('the overview counts one member less and the same pieces, views and interactions', async () => {
    const fx = await seed()
    const other = await overview(fx.otherCampaignId)
    const o0 = await overview(fx.campaignId)
    expect(o0.totals).toMatchObject({ members: 6, creatorsActive: 4, media: 5, views: 12600, likes: 350, comments: 25, shares: 7, saves: 8 })

    await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    const o1 = await overview(fx.campaignId)
    // alba and her TikTok had content: one creator with content less
    expect(o1.totals.members).toBe(5)
    expect(o1.totals.creatorsActive).toBe(3)

    await foldTwinMembership(fx.gemaTwinMembership, ACTOR(fx))
    const o2 = await overview(fx.campaignId)
    // gema had none and her TikTok had two pieces: gema now counts with content
    expect(o2.totals.members).toBe(4)
    expect(o2.totals.creatorsActive).toBe(3)

    for (const o of [o1, o2]) {
      // Every sum over the pieces is exactly what it was
      expect(without(o.totals, 'members', 'creatorsActive')).toEqual(without(o0.totals, 'members', 'creatorsActive'))
      expect(o.timeline).toEqual(o0.timeline)
      expect(o.targets).toEqual(o0.targets)
      // creators and the team's delivery summary (Nov 2026) count members: they follow the fold
      expect(without(o.delivery, 'creators', 'allOk', 'summary')).toEqual(without(o0.delivery, 'creators', 'allOk', 'summary'))
      const strip = (m: object) => without(m, 'influencerId', 'publishedBy')
      expect(o.perMedia.map(strip)).toEqual(o0.perMedia.map(strip))
    }

    // One row per creator: alba adds up both networks; her fee, status and baseline comparison are hers
    const albaBefore = o0.perInfluencer.find(p => p.influencerId === fx.alba)!
    const albaTtBefore = o0.perInfluencer.find(p => p.influencerId === fx.albaTt)!
    const albaAfter = o2.perInfluencer.find(p => p.influencerId === fx.alba)!
    expect(o2.perInfluencer.map(p => p.influencerId).sort()).toEqual([fx.alba, fx.gema, fx.bea, fx.dana].sort())
    expect(albaAfter.media).toBe(albaBefore.media + albaTtBefore.media)
    expect(albaAfter.views).toBe(albaBefore.views + albaTtBefore.views)
    expect(albaAfter.engagements).toBe(albaBefore.engagements + albaTtBefore.engagements)
    // Each row is rounded to cents: the sum of two rounded rows may differ by one cent
    expect(Math.abs(albaAfter.emvExtended - (albaBefore.emvExtended + albaTtBefore.emvExtended))).toBeLessThanOrEqual(0.011)
    expect(albaAfter.byPlatform).toEqual({ INSTAGRAM: albaBefore.byPlatform!.INSTAGRAM, TIKTOK: albaTtBefore.byPlatform!.TIKTOK })
    expect(albaAfter).toMatchObject({ cost: albaBefore.cost, status: 'CONTRACTED', deliverablesPlanned: 2, trackedClicks: 12, followers: 2100 })
    expect(albaAfter.vsBaseline).toEqual(albaBefore.vsBaseline)
    const gemaAfter = o2.perInfluencer.find(p => p.influencerId === fx.gema)!
    expect(gemaAfter).toMatchObject({ media: 2, views: 3700, status: 'COMPLETED' })
    expect(Object.keys(gemaAfter.byPlatform!)).toEqual(['TIKTOK'])
    // The moved pieces say who published them
    expect(o2.perMedia.find(m => m.id === fx.albaTtVideo)!.publishedBy).toEqual({ influencerId: fx.albaTt, username: 'alba_prueba', platform: 'TIKTOK' })
    expect(o2.perMedia.find(m => m.id === fx.gemaTtVideo2)!.publishedBy).toEqual({ influencerId: fx.gemaOther, username: 'gema_otra_cuenta', platform: 'TIKTOK' })

    // The campaign where alba's TikTok is an ordinary member did not move
    expect(await overview(fx.otherCampaignId)).toEqual(other)
  })

  it('refuses a membership that is not a twin, and one already folded, cleanly', async () => {
    const fx = await seed()
    const bea = await prisma.campaignInfluencer.findFirstOrThrow({ where: { campaignId: fx.campaignId, influencerId: fx.bea } })
    await expectFoldError(foldTwinMembership(bea.id, ACTOR(fx)), 'not_a_twin')
    await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    const folded = await snapshot()
    await expectFoldError(foldTwinMembership(fx.albaTwinMembership, ACTOR(fx)), 'already_folded')
    expect(await snapshot()).toEqual(folded)
  })
})

// ---------------------------------------------------------------------------

describe('blockers', () => {
  const ROW_CASES: Array<[string, Prisma.CampaignInfluencerUncheckedUpdateInput, FoldBlockerCode]> = [
    ['an agreed fee', { agreedFee: 150 }, 'fee'],
    ['a cost', { cost: 20 }, 'fee'],
    ['a commission', { commission: 5 }, 'fee'],
    ['an asking fee', { askingFee: 200 }, 'fee'],
    ['notes on her card', { notes: 'Ojo con la talla' }, 'notes'],
    ['a shipping address', { shippingAddress1: 'Calle Inventada 2' }, 'shipping'],
    ['a shipping quantity', { shippingQty: 3 }, 'shipping'],
    ['deliverables', { deliverablesPlanned: 1 }, 'deliverables'],
    ['a tracked link', { trackedLink: 'https://example.test/?utm=tt' }, 'tracked_link'],
    ['tracked clicks', { trackedClicks: 4 }, 'tracked_link'],
    ['a baseline', { baselineSnapshot: videoBaseline(500), baselineAt: new Date('2026-09-25T00:00:00Z') }, 'baseline'],
    ['a negotiated format', { negotiatedFormat: 'VIDEO' }, 'deal_terms'],
    ['rights days', { rightsDays: 90 }, 'deal_terms'],
    ['exclusivity', { exclusivityDays: 30 }, 'deal_terms'],
    ['whitelisting', { whitelisting: true }, 'deal_terms'],
    ['a closed deal', { dealClosedAt: new Date('2026-10-02T00:00:00Z') }, 'deal_terms'],
    ['a UGC portfolio', { portfolioUrl: 'https://example.test/portfolio' }, 'ugc'],
    ['UGC content delivered', { contentDelivered: true }, 'ugc'],
  ]

  for (const [what, data, code] of ROW_CASES) {
    it(`a twin with ${what} is not folded (${code}) and nothing changes`, async () => {
      const fx = await seed()
      await prisma.campaignInfluencer.update({ where: { id: fx.albaTwinMembership }, data })
      const before = await snapshot()
      const listed = (await listTwinMemberships(fx.campaignId)).find(t => t.membershipId === fx.albaTwinMembership)!
      expect(listed.blockers.map(b => b.code)).toEqual([code])
      const err = await expectFoldError(foldTwinMembership(fx.albaTwinMembership, ACTOR(fx)), 'blocked')
      expect(err.blockers.map(b => b.code)).toEqual([code])
      expect(err.message).toContain(listed.blockers[0].reason)
      expect(await snapshot()).toEqual(before)
    })
  }

  const report = (campaignId: string, hiddenInfluencerIds: string[]) =>
    prisma.setting.create({ data: { key: `campaign_report_${campaignId}`, value: JSON.stringify({ hiddenInfluencerIds }) } })

  const KEYED_CASES: Array<[string, (fx: Fixture) => Promise<unknown>, FoldBlockerCode]> = [
    ['hidden in the client report while the original is not', fx => report(fx.campaignId, [fx.albaTt]), 'report_hidden'],
    ['visible in the client report while the original is hidden', fx => report(fx.campaignId, [fx.alba]), 'report_original_hidden'],
    ['an unreadable client report configuration', fx => prisma.setting.create({ data: { key: `campaign_report_${fx.campaignId}`, value: '{not json' } }), 'report_unreadable'],
    ['ad permissions of her own', fx => prisma.setting.create({ data: { key: `ad_permissions_${fx.campaignId}_${fx.albaTt}`, value: JSON.stringify([{ id: 'perm_1', status: 'GRANTED' }]) } }), 'ad_permissions'],
    ['an original that is no longer a member', fx => prisma.campaignInfluencer.delete({ where: { id: fx.albaMembership } }), 'original_missing'],
    ['a profile that already belongs to another person', async fx => {
      const person = await prisma.person.create({ data: { displayName: 'Otra persona' } })
      await prisma.influencer.update({ where: { id: fx.albaTt }, data: { personId: person.id } })
      await prisma.influencer.update({ where: { id: fx.dana }, data: { personId: person.id } })
    }, 'other_person'],
    ['an original that is a twin too', fx => prisma.campaignInfluencer.update({ where: { id: fx.albaMembership }, data: { source: `${TWIN_SOURCE_PREFIX}${fx.dana}` } }), 'original_is_twin'],
    ['a source that points at itself', fx => prisma.campaignInfluencer.update({ where: { id: fx.albaTwinMembership }, data: { source: `${TWIN_SOURCE_PREFIX}${fx.albaTt}` } }), 'not_a_twin'],
  ]

  for (const [what, arrange, code] of KEYED_CASES) {
    it(`a twin with ${what} is not folded (${code}) and nothing changes`, async () => {
      const fx = await seed()
      await arrange(fx)
      const before = await snapshot()
      const listed = (await listTwinMemberships(fx.campaignId)).find(t => t.membershipId === fx.albaTwinMembership)!
      expect(listed.blockers.map(b => b.code)).toContain(code)
      const err = await expectFoldError(foldTwinMembership(fx.albaTwinMembership, ACTOR(fx)), 'blocked')
      expect(err.blockers.map(b => b.code)).toContain(code)
      expect(await snapshot()).toEqual(before)
    })
  }

  it('the person who owns the profile is named in the reason', async () => {
    const fx = await seed()
    const person = await prisma.person.create({ data: { displayName: 'Otra persona' } })
    await prisma.influencer.update({ where: { id: fx.albaTt }, data: { personId: person.id } })
    await prisma.influencer.update({ where: { id: fx.dana }, data: { personId: person.id } })
    const listed = (await listTwinMemberships(fx.campaignId)).find(t => t.membershipId === fx.albaTwinMembership)!
    expect(listed.blockers.find(b => b.code === 'other_person')!.reason).toContain('@dana_ejemplo (Instagram)')
  })

  it('hidden alike (both) or an empty permission list does not block; the twin’s id leaves the hidden list, so the report counts one hidden creator, and undo puts the configuration back exactly', async () => {
    const fx = await seed()
    const key = `campaign_report_${fx.campaignId}`
    // As the report editor stores it: other settings, and the two rows of alba hidden
    const value = JSON.stringify({ hiddenSections: ['learnings'], hiddenMediaIds: [fx.beaReel], hiddenInfluencerIds: [fx.alba, fx.albaTt], notes: 'Para la marca' })
    await prisma.setting.create({ data: { key, value } })
    await prisma.setting.create({ data: { key: `ad_permissions_${fx.campaignId}_${fx.albaTt}`, value: '[]' } })
    expect((await listTwinMemberships(fx.campaignId)).find(t => t.membershipId === fx.albaTwinMembership)!.blockers).toEqual([])
    const settingsBefore = await rowsOf('settings')

    const folded = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    expect(folded.reportUnhidden).toBe(true)
    // Only the twin's id is gone; every other setting of the report is as it was
    const config = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key } })).value)
    expect(config).toEqual({ hiddenSections: ['learnings'], hiddenMediaIds: [fx.beaReel], hiddenInfluencerIds: [fx.alba], notes: 'Para la marca' })
    // The agency's note under the report counts the hidden ids: one creator, not two
    expect(config.hiddenInfluencerIds).toHaveLength(1)
    // Hidden before and after: the client view (the saved list) still leaves alba and her TikTok piece out
    const client = await computeCampaignOverview(fx.campaignId, { ...RATES, exclude: { mediaIds: config.hiddenMediaIds, influencerIds: config.hiddenInfluencerIds } })
    expect(client!.perMedia.map(m => m.id)).not.toContain(fx.albaTtVideo)
    expect(client!.perMedia.map(m => m.id)).not.toContain(fx.albaReel)
    expect(client!.perInfluencer.map(p => p.influencerId)).not.toContain(fx.alba)
    // The log keeps the value to put back
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: folded.logId } })
    expect((log.before as { report: unknown }).report).toEqual({ key, value, folded: JSON.stringify(config) })

    const undone = await undoFold(folded.logId, ACTOR(fx))
    expect(undone.reportRestored).toBe(true)
    expect(await rowsOf('settings')).toEqual(settingsBefore)
  })

  it('undo of a fold whose report was edited since: the twin’s id goes back only while the original is still hidden', async () => {
    const fx = await seed()
    const key = `campaign_report_${fx.campaignId}`
    await prisma.setting.create({ data: { key, value: JSON.stringify({ hiddenInfluencerIds: [fx.alba, fx.albaTt] }) } })
    const a = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    // The PM hides bea too, after the fold
    await prisma.setting.update({ where: { key }, data: { value: JSON.stringify({ hiddenInfluencerIds: [fx.alba, fx.bea] }) } })
    expect((await undoFold(a.logId, ACTOR(fx))).reportRestored).toBe(true)
    expect(JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key } })).value)).toEqual({ hiddenInfluencerIds: [fx.alba, fx.bea, fx.albaTt] })

    // Folded again, and the PM shows alba again: the twin's row comes back visible, as she is
    const again = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    expect(again.reportUnhidden).toBe(true)
    await prisma.setting.update({ where: { key }, data: { value: JSON.stringify({ hiddenInfluencerIds: [fx.bea] }) } })
    expect((await undoFold(again.logId, ACTOR(fx))).reportRestored).toBe(false)
    expect(JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key } })).value)).toEqual({ hiddenInfluencerIds: [fx.bea] })
  })

  it('a twin hidden in no report: the configuration is not written', async () => {
    const fx = await seed()
    const key = `campaign_report_${fx.campaignId}`
    const value = JSON.stringify({ hiddenInfluencerIds: [fx.bea] })
    await prisma.setting.create({ data: { key, value } })
    const folded = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    expect(folded.reportUnhidden).toBe(false)
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toBe(value)
    expect((await undoFold(folded.logId, ACTOR(fx))).reportRestored).toBe(false)
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toBe(value)
  })

  it('a blocked twin is reported by the batch fold and the others are folded', async () => {
    const fx = await seed()
    await prisma.campaignInfluencer.update({ where: { id: fx.albaTwinMembership }, data: { agreedFee: 80 } })
    const report = await foldTwins({ campaignId: fx.campaignId, actor: ACTOR(fx) })
    expect(report.folded.map(f => f.membershipId)).toEqual([fx.gemaTwinMembership])
    expect(report.skipped).toEqual([expect.objectContaining({ membershipId: fx.albaTwinMembership, twin: 'alba_prueba', original: 'alba_prueba', blockers: [expect.objectContaining({ code: 'fee' })] })])
    expect(report.failed).toEqual([])
    expect(await prisma.campaignInfluencer.findUnique({ where: { id: fx.albaTwinMembership } })).not.toBeNull()
  })

  it('a fee typed on the twin while the fold waits for its row is seen under the lock: blocked, nothing moved', async () => {
    const fx = await seed()
    const before = await snapshot()
    // The PM's edit holds the twin's row; the fold has already passed the listing when it is saved
    const [result] = await whileLocked('SELECT id FROM campaign_influencers WHERE id = $1 FOR UPDATE', [fx.albaTwinMembership], 1,
      () => [foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))],
      client => client.query('UPDATE campaign_influencers SET "agreedFee" = 120 WHERE id = $1', [fx.albaTwinMembership]))
    expect(result.ok).toBe(false)
    const err = (result as Extract<Settled, { ok: false }>).error
    expect(err).toBeInstanceOf(FoldError)
    expect((err as FoldError).code).toBe('blocked')
    expect((err as FoldError).blockers.map(b => b.code)).toEqual(['fee'])

    const after = await snapshot()
    expect(after.media).toEqual(before.media)
    expect(after.notes).toEqual(before.notes)
    expect(after.memberships.map(r => without(r, 'agreedFee'))).toEqual(before.memberships.map(r => without(r, 'agreedFee')))
    expect(await prisma.personLog.count({ where: { action: 'fold_membership' } })).toBe(0)
    // The link of the two profiles was made before the transaction and stays: harmless, the twin is still
    // a member and its pieces are still credited to itself (rule 1 of the roster)
    expect(await prisma.personLog.count({ where: { action: 'link_profile' } })).toBe(1)
  })

  it('rowBlockers sees nothing on a twin with default values', () => {
    expect(rowBlockers({ cost: 0, commission: 0, shippingQty: 1, whitelisting: false, urgent: false, crossposting: false, contentDelivered: false, notes: '  ' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('undoFold', () => {
  it('puts every row back, column for column; the two profiles stay one person', async () => {
    const fx = await seed()
    const before = await snapshot()
    const overviewBefore = await overview(fx.campaignId)
    const a = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    const g = await foldTwinMembership(fx.gemaTwinMembership, ACTOR(fx))

    const undoneG = await undoFold(g.logId, ACTOR(fx))
    const undoneA = await undoFold(a.logId, ACTOR(fx))
    expect(undoneA).toMatchObject({ foldLogId: a.logId, membershipId: fx.albaTwinMembership, restoredPieces: 1, restoredNotes: 2, piecesNotRestored: 0, notesNotRestored: 0 })
    expect(undoneG).toMatchObject({ restoredPieces: 2, restoredNotes: 0 })

    const after = await snapshot()
    expect(after.memberships).toEqual(before.memberships)
    expect(after.media).toEqual(before.media)
    expect(after.notes).toEqual(before.notes)
    expect(after.settings).toEqual(before.settings)
    expect(await overview(fx.campaignId)).toMatchObject({ totals: overviewBefore.totals })

    // The link stays
    const [alba, albaTt] = await Promise.all([
      prisma.influencer.findUniqueOrThrow({ where: { id: fx.alba } }),
      prisma.influencer.findUniqueOrThrow({ where: { id: fx.albaTt } }),
    ])
    expect(albaTt.personId).toBe(alba.personId)
    expect(alba.personId).toBeTruthy()

    // The folds are marked undone, each undo is logged
    for (const fold of [a, g]) {
      const log = await prisma.personLog.findUniqueOrThrow({ where: { id: fold.logId } })
      expect(log.undoneAt).toBeInstanceOf(Date)
      expect(log.undoneById).toBe(fx.admin.id)
      expect(await prisma.personLog.count({ where: { action: 'undo', undoOfId: fold.logId } })).toBe(1)
    }
    expect(await listLiveFolds()).toEqual([])

    await expectFoldError(undoFold(a.logId, ACTOR(fx)), 'already_undone')
    await expectFoldError(undoFold('no-such-log', ACTOR(fx)), 'not_found')

    // And it can be folded again
    const again = await foldTwins({ campaignId: fx.campaignId, actor: ACTOR(fx) })
    expect(again.folded.map(f => f.membershipId).sort()).toEqual([fx.albaTwinMembership, fx.gemaTwinMembership].sort())
    expect(again.folded.every(f => !f.linkedNow)).toBe(true)
    expect((await overview(fx.campaignId)).totals).toMatchObject({ members: 4, creatorsActive: 3, media: 5 })
  })

  it('leaves a piece changed since the fold where it is and counts it', async () => {
    const fx = await seed()
    const g = await foldTwinMembership(fx.gemaTwinMembership, ACTOR(fx))
    await prisma.media.delete({ where: { id: fx.gemaTtVideo1 } })
    const undone = await undoFold(g.logId, ACTOR(fx))
    expect(undone).toMatchObject({ restoredPieces: 1, piecesNotRestored: 1 })
    expect(await prisma.media.findUniqueOrThrow({ where: { id: fx.gemaTtVideo2 } })).toMatchObject({ influencerId: fx.gemaTt, publishedByInfluencerId: fx.gemaOther })
  })

  it('refuses when the profile is a member of the campaign again, and changes nothing', async () => {
    const fx = await seed()
    const a = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaignId, influencerId: fx.albaTt, status: 'PROSPECT' } })
    const state = await snapshot()
    await expectFoldError(undoFold(a.logId, ACTOR(fx)), 'blocked')
    expect(await snapshot()).toEqual(state)
  })
})

// ---------------------------------------------------------------------------

describe('safe to run twice, and at the same time', () => {
  it('a second batch run folds nothing and changes nothing; a campaign with no twins changes nothing', async () => {
    const fx = await seed()
    const untouched = await snapshot()
    const none = await foldTwins({ campaignId: fx.otherCampaignId, actor: ACTOR(fx) })
    expect(none).toEqual({ folded: [], skipped: [], failed: [] })
    expect(await snapshot()).toEqual(untouched)

    const first = await foldTwins({ campaignId: fx.campaignId, actor: ACTOR(fx) })
    expect(first.folded).toHaveLength(2)
    const folded = await snapshot()
    const second = await foldTwins({ campaignId: fx.campaignId, actor: ACTOR(fx) })
    expect(second).toEqual({ folded: [], skipped: [], failed: [] })
    expect(await snapshot()).toEqual(folded)
  })

  it('two folds of the same twin at once: one fold, the other a clean error', async () => {
    const fx = await seed()
    // The twin's piece is held by another connection: both folds are inside their transactions before either can finish
    const results = await whileLocked('SELECT id FROM media WHERE id = $1 FOR UPDATE', [fx.albaTtVideo], 2, () => [
      foldTwinMembership(fx.albaTwinMembership, ACTOR(fx)),
      foldTwinMembership(fx.albaTwinMembership, ACTOR(fx)),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find((r): r is Extract<Settled, { ok: false }> => !r.ok)!
    expect(lost.error).toBeInstanceOf(FoldError)
    expect((lost.error as FoldError).code).toBe('already_folded')

    expect(await prisma.personLog.count({ where: { action: 'fold_membership' } })).toBe(1)
    expect(await prisma.personLog.count({ where: { action: 'link_profile' } })).toBe(1)
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.campaignId } })).toBe(5)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: fx.albaTtVideo } })).toMatchObject({ influencerId: fx.alba, publishedByInfluencerId: fx.albaTt })
    expect(await prisma.campaignNote.count({ where: { campaignId: fx.campaignId, influencerId: fx.alba } })).toBe(3)
  })

  it('three folds of the same twin started together: one fold, two clean errors', async () => {
    const fx = await seed()
    const results = await Promise.allSettled([1, 2, 3].map(() => foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(FoldError)
      expect((r.reason as FoldError).code).toBe('already_folded')
    }
    expect(await prisma.personLog.count({ where: { action: 'fold_membership' } })).toBe(1)
    expect(await prisma.person.count()).toBe(1)
  })

  it('two undos of the same fold at once: one undo, the other a clean error', async () => {
    const fx = await seed()
    const before = await snapshot()
    const a = await foldTwinMembership(fx.albaTwinMembership, ACTOR(fx))
    // The moved piece is held by another connection: both undos are inside their transactions before either can finish
    const results = await whileLocked('SELECT id FROM media WHERE id = $1 FOR UPDATE', [fx.albaTtVideo], 2, () => [
      undoFold(a.logId, ACTOR(fx)),
      undoFold(a.logId, ACTOR(fx)),
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find((r): r is Extract<Settled, { ok: false }> => !r.ok)!
    expect(lost.error).toBeInstanceOf(FoldError)
    expect((lost.error as FoldError).code).toBe('already_undone')
    expect(await prisma.personLog.count({ where: { action: 'undo' } })).toBe(1)
    const after = await snapshot()
    expect(after.memberships).toEqual(before.memberships)
    expect(after.media).toEqual(before.media)
    expect(after.notes).toEqual(before.notes)
  })
})

// ---------------------------------------------------------------------------

describe('/api/admin/fold-twins', () => {
  it('answers 401 without a session and 403 to anyone who is not an ADMIN, and changes nothing', async () => {
    const fx = await seed()
    const before = await snapshot()
    net.session = null
    expect((await call('GET')).status).toBe(401)
    expect((await call('POST', { all: true })).status).toBe(401)
    for (const role of ['EMPLOYEE', 'BRAND', 'CREATOR']) {
      net.session = { ...fx.employee, role }
      expect((await call('GET')).status, role).toBe(403)
      expect((await call('POST', { all: true })).status, role).toBe(403)
      expect((await call('POST', { undo: 'x' })).status, role).toBe(403)
    }
    expect(await snapshot()).toEqual(before)
  })

  it('lists, folds and undoes for an ADMIN', async () => {
    const fx = await seed()
    net.session = fx.admin
    const before = await snapshot()

    const listed = await call('GET', undefined, `?campaignId=${fx.campaignId}`)
    expect(listed.status).toBe(200)
    expect(listed.body.foldable).toBe(2)
    expect(listed.body.twins.map((t: { membershipId: string }) => t.membershipId)).toEqual([fx.albaTwinMembership, fx.gemaTwinMembership])
    expect(listed.body.folds).toEqual([])
    expect(await snapshot()).toEqual(before)

    // Folding everything must be asked for explicitly
    const vague = await call('POST', {})
    expect(vague.status).toBe(400)
    expect((await call('POST', { membershipIds: 'x' })).status).toBe(400)
    expect((await call('POST', 'not json')).status).toBe(400)
    expect(await snapshot()).toEqual(before)

    const folded = await call('POST', { membershipIds: [fx.albaTwinMembership] })
    expect(folded.status).toBe(200)
    expect(folded.body.folded).toEqual([expect.objectContaining({ membershipId: fx.albaTwinMembership, movedPieces: 1, movedNotes: 2 })])
    expect(folded.body.skipped).toEqual([])
    const rest = await call('POST', { all: true })
    expect(rest.body.folded.map((f: { membershipId: string }) => f.membershipId)).toEqual([fx.gemaTwinMembership])
    expect((await call('GET')).body.folds).toHaveLength(2)

    const undone = await call('POST', { undo: folded.body.folded[0].logId })
    expect(undone.status).toBe(200)
    expect(undone.body.undone).toMatchObject({ membershipId: fx.albaTwinMembership, restoredPieces: 1 })
    expect((await call('POST', { undo: folded.body.folded[0].logId })).status).toBe(409)
    expect((await call('POST', { undo: 'no-such-log' })).status).toBe(404)
    expect((await call('POST', { undo: '' })).status).toBe(400)
    expect(await prisma.campaignInfluencer.findUnique({ where: { id: fx.albaTwinMembership } })).not.toBeNull()
  })

  it('says, in the listing AND in the report of the fold, when nobody will read the TikTok account after it', async () => {
    const fx = await seed()
    net.session = fx.admin
    // An active campaign without TikTok among its platforms: today check-posts reads the twin; after the fold, nobody would
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { status: 'ACTIVE', platforms: ['INSTAGRAM'] } })
    const silent = 'después de fusionarla nadie lee @alba_prueba (TikTok): la campaña no incluye TikTok en sus plataformas (Aprender → "Editar Campaña" → "Plataformas")'

    const listed = await call('GET', undefined, `?campaignId=${fx.campaignId}`)
    const albaTwin = listed.body.twins.find((t: { membershipId: string }) => t.membershipId === fx.albaTwinMembership)
    expect(albaTwin.warnings).toEqual([silent])
    expect(albaTwin.blockers).toEqual([])

    const folded = await call('POST', { membershipIds: [fx.albaTwinMembership] })
    expect(folded.status).toBe(200)
    expect(folded.body.folded).toEqual([expect.objectContaining({ membershipId: fx.albaTwinMembership, warnings: [silent] })])

    // With TikTok among the platforms and a confirmed original, nothing to warn about
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { platforms: ['INSTAGRAM', 'TIKTOK'] } })
    const rest = await call('POST', { campaignId: fx.campaignId })
    expect(rest.body.folded).toEqual([expect.objectContaining({ membershipId: fx.gemaTwinMembership, warnings: [] })])
  })
})
