/**
 * Merging two records of one creator and undoing it (previewMerge,
 * applyMerge, undoMerge in src/lib/person-merge.ts), on a real, throwaway
 * database with an October-like campaign: 36 members, among them one person
 * as two members (Instagram and TikTok, both real: «link») and one person as
 * her real Instagram plus her TikTok handle saved as an Instagram profile
 * (a wrong handle, also a member of a June campaign: «absorb»).
 * These tests prove:
 *   - the preview changes nothing and says what will happen, campaign by
 *     campaign; the merge does exactly that: 36 → 34 members, the same pieces,
 *     views, likes, comments, shares, saves and per-piece figures, the cost of
 *     the folded rows less; the June membership of the wrong handle moves with
 *     its piece (absorb) and the other TikTok campaign is untouched (link);
 *   - notes, the client report's hidden creators and ad permissions follow;
 *   - a money conflict refuses until chosen, and «add» adds;
 *   - a stale preview is refused; the same post under both rows keeps one;
 *   - undo puts every column of every row back; after an edit it refuses
 *     unless forced, and then reports what it overwrote;
 *   - two merges of the same pair at once: one merge and a clean 409.
 * Every handle, name and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No test may reach a scraper (the overview's modules must never call one)
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

import pg from 'pg'
import { Prisma } from '@/generated/prisma/client'
import type { MediaType, Platform } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import type { CampaignOverview } from '@/lib/metrics'
import { linkProfile } from '@/lib/person-profiles'
import {
  MergeError,
  applyMerge,
  listMergeHistory,
  previewMerge,
  undoMerge,
  type MergeChoices,
  type MergeMode,
} from '@/lib/person-merge'

const RATES = { rates: DEFAULT_EMV_RATES }

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignNote.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.contact.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.setting.deleteMany({ where: { OR: [{ key: { startsWith: 'campaign_report_' } }, { key: { startsWith: 'ad_permissions_' } }] } })
  await prisma.user.deleteMany()
}

beforeEach(reset)
afterAll(reset)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let mediaSeq = 0
function piece(campaignId: string | null, influencerId: string, platform: Platform, mediaType: MediaType, figures: { views: number; likes: number; comments: number; shares?: number; saves?: number; reach?: number }, extra: { postedAt?: string; publishedByInfluencerId?: string; permalink?: string; externalId?: string; insightsSource?: string } = {}) {
  mediaSeq++
  return prisma.media.create({
    data: {
      externalId: extra.externalId ?? `merge-${mediaSeq}`,
      platform,
      mediaType,
      campaignId,
      influencerId,
      publishedByInfluencerId: extra.publishedByInfluencerId ?? null,
      permalink: extra.permalink ?? `https://example.test/p/merge-${mediaSeq}`,
      caption: 'Probando #marcademo',
      views: figures.views,
      likes: figures.likes,
      comments: figures.comments,
      shares: figures.shares ?? 0,
      saves: figures.saves ?? 0,
      reach: figures.reach ?? 0,
      postedAt: new Date(extra.postedAt ?? `2026-10-${String(5 + (mediaSeq % 20)).padStart(2, '0')}T10:00:00.000Z`),
      insightsSource: extra.insightsSource ?? null,
      source: 'manual',
    },
    select: { id: true },
  })
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const admin = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const pm = await prisma.user.create({ data: { email: `pm-${stamp}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = (name: string, start: string, end: string, platforms: Platform[] = ['INSTAGRAM', 'TIKTOK']) => prisma.campaign.create({
    data: { name, status: 'ACTIVE', startDate: new Date(start), endDate: new Date(end), platforms, targetHashtags: ['marcademo'], userId: admin.id },
    select: { id: true },
  })
  const oct = await campaign('Micros Octubre (prueba)', '2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')
  const jun = await campaign('Micros Junio (prueba)', '2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z')
  const ttOnly = await campaign('Solo TikTok (prueba)', '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z', ['TIKTOK'])

  const inf = (username: string, platform: Platform, followers: number, extra: { website?: string } = {}) =>
    prisma.influencer.create({ data: { username, platform, followers, ...extra }, select: { id: true } })
  const danaIg = (await inf('dana_ejemplo', 'INSTAGRAM', 652)).id
  const danaTt = (await inf('dana_ejemplo', 'TIKTOK', 18700)).id
  const vaneReal = (await inf('vane_inventada', 'INSTAGRAM', 2300, { website: 'https://www.tiktok.com/@vane_mal' })).id
  const vaneWrong = (await inf('vane_mal', 'INSTAGRAM', 0)).id
  const fillers: string[] = []
  for (let i = 1; i <= 32; i++) fillers.push((await inf(`relleno_${String(i).padStart(2, '0')}`, 'INSTAGRAM', 1000 + i * 37)).id)

  const member = (campaignId: string, influencerId: string, fee: number, createdAt: string) =>
    prisma.campaignInfluencer.create({
      data: { campaignId, influencerId, status: 'COMPLETED', agreedFee: fee, cost: fee, createdAt: new Date(createdAt), addedById: pm.id, addedByName: 'Laura PM' },
      select: { id: true },
    })
  // October: 36 members, all COMPLETED with a fee of 100; the second rows were added by hand later
  const danaIgOct = (await member(oct.id, danaIg, 100, '2026-09-20T08:00:00.123Z')).id
  const danaTtOct = (await member(oct.id, danaTt, 100, '2026-11-02T10:00:00Z')).id
  const vaneRealOct = (await member(oct.id, vaneReal, 100, '2026-09-20T08:05:00Z')).id
  const vaneWrongOct = (await member(oct.id, vaneWrong, 100, '2026-10-19T09:00:00Z')).id
  for (const [i, f] of fillers.entries()) await member(oct.id, f, 100, `2026-09-21T08:${String(i).padStart(2, '0')}:00Z`)
  // June: dana's Instagram, the wrong handle (fee 50) and three fillers
  const danaIgJun = (await member(jun.id, danaIg, 100, '2026-05-20T08:00:00Z')).id
  const vaneWrongJun = (await member(jun.id, vaneWrong, 50, '2026-05-21T08:00:00Z')).id
  for (const f of fillers.slice(0, 3)) await member(jun.id, f, 80, '2026-05-22T08:00:00Z')
  // A TikTok-only campaign where only dana's TikTok is a member
  const danaTtOnly = (await member(ttOnly.id, danaTt, 70, '2026-08-20T08:00:00Z')).id

  // Pieces
  const danaTtVideo = (await piece(oct.id, danaTt, 'TIKTOK', 'VIDEO', { views: 5400, likes: 120, comments: 4, shares: 3, saves: 2 })).id
  const vaneReel = (await piece(oct.id, vaneReal, 'INSTAGRAM', 'REEL', { views: 2600, likes: 140, comments: 9, shares: 1, saves: 5 })).id
  for (const [i, f] of fillers.slice(0, 26).entries()) await piece(oct.id, f, 'INSTAGRAM', 'REEL', { views: 500 + i * 90, likes: 20 + i, comments: i % 5, shares: i % 3, saves: i % 4 })
  for (const f of fillers.slice(0, 5)) await piece(oct.id, f, 'INSTAGRAM', 'STORY', { views: 300, likes: 0, comments: 0, reach: 280 })
  const vaneWrongJunReel = (await piece(jun.id, vaneWrong, 'INSTAGRAM', 'REEL', { views: 900, likes: 30, comments: 2 }, { postedAt: '2026-06-10T10:00:00Z' })).id
  await piece(jun.id, fillers[0], 'INSTAGRAM', 'REEL', { views: 1200, likes: 60, comments: 4 }, { postedAt: '2026-06-11T10:00:00Z' })
  const danaTtOnlyVideo = (await piece(ttOnly.id, danaTt, 'TIKTOK', 'VIDEO', { views: 7000, likes: 300, comments: 12 }, { postedAt: '2026-09-10T10:00:00Z' })).id

  // Notes, client report configurations, ad permissions
  const note = (campaignId: string, influencerId: string, text: string) =>
    prisma.campaignNote.create({ data: { campaignId, influencerId, userId: pm.id, userName: 'Laura PM', text }, select: { id: true } })
  const wrongNotesOct = [(await note(oct.id, vaneWrong, 'Es su TikTok')).id, (await note(oct.id, vaneWrong, 'Revisar el usuario')).id]
  const realNoteOct = (await note(oct.id, vaneReal, 'Reel entregado')).id
  const wrongNoteJun = (await note(jun.id, vaneWrong, 'Junio: entregado')).id
  await prisma.setting.create({ data: { key: `campaign_report_${oct.id}`, value: JSON.stringify({ hiddenSections: ['learnings'], hiddenInfluencerIds: [vaneWrong, fillers[9]], intro: 'Para la marca' }) } })
  await prisma.setting.create({ data: { key: `campaign_report_${jun.id}`, value: JSON.stringify({ hiddenInfluencerIds: [vaneWrong] }) } })
  await prisma.setting.create({ data: { key: `ad_permissions_${jun.id}_${vaneWrong}`, value: JSON.stringify([{ id: 'perm_1', creatorId: vaneWrong, campaignId: jun.id, status: 'GRANTED' }]) } })

  return {
    admin: { id: admin.id, name: 'Ada Admin' }, pm: { id: pm.id, name: 'Laura PM' },
    oct: oct.id, jun: jun.id, ttOnly: ttOnly.id,
    danaIg, danaTt, vaneReal, vaneWrong, fillers,
    danaIgOct, danaTtOct, vaneRealOct, vaneWrongOct, danaIgJun, vaneWrongJun, danaTtOnly,
    danaTtVideo, vaneReel, vaneWrongJunReel, danaTtOnlyVideo,
    wrongNotesOct, realNoteOct, wrongNoteJun,
  }
}
type Fx = Awaited<ReturnType<typeof seed>>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
const TABLES = ['campaign_influencers', 'media', 'campaign_notes', 'influencers', 'persons', 'settings'] as const
async function rowsOf(table: string): Promise<Row[]> {
  const rows = await prisma.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(t.*) AS row FROM ${Prisma.raw(`"${table}"`)} t ORDER BY t.id`
  return rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Row)
}
async function snapshot(): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {}
  for (const t of TABLES) out[t] = await rowsOf(t)
  return out
}
const byId = (rows: Row[]) => new Map(rows.map(r => [String(r.id), r]))
const without = (row: object, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))

async function overview(campaignId: string): Promise<CampaignOverview> {
  const o = await computeCampaignOverview(campaignId, RATES)
  if (!o) throw new Error('no overview')
  return o
}

const ACTOR = (fx: Fx) => fx.admin

async function merge(fx: Fx, keepId: string, otherId: string, mode: MergeMode, choices?: MergeChoices) {
  const preview = await previewMerge({ keepId, otherId, mode, choices })
  return applyMerge({ keepId, otherId, mode, choices, fingerprint: preview.fingerprint }, ACTOR(fx))
}

async function expectMergeError(promise: Promise<unknown>, code: MergeError['code']): Promise<MergeError> {
  const err = await promise.then(() => null, e => e)
  expect(err, `expected MergeError ${code}`).toBeInstanceOf(MergeError)
  expect((err as MergeError).code).toBe(code)
  expect((err as MergeError).status).toBe(code === 'invalid' ? 400 : code === 'forbidden' ? 403 : code === 'not_found' ? 404 : 409)
  return err as MergeError
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown }

/** Runs `start` while ANOTHER connection holds a row lock, released once `waiters` sessions wait for a lock. */
async function whileLocked(lockSql: string, params: unknown[], waiters: number, start: () => Array<Promise<unknown>>): Promise<Settled[]> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('BEGIN')
    const locked = await client.query(lockSql, params)
    expect(locked.rowCount).toBeGreaterThan(0)
    const pending = start().map(p => p.then((value): Settled => ({ ok: true, value }), (error): Settled => ({ ok: false, error })))
    const deadline = Date.now() + 20_000
    for (;;) {
      await client.query('SELECT pg_stat_clear_snapshot()')
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)
      if (rows[0].n >= waiters) break
      if (Date.now() > deadline) throw new Error(`only ${rows[0].n} of ${waiters} sessions ever waited for the lock`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await client.query('COMMIT')
    return await Promise.all(pending)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
  }
}

/**
 * The whole overview, with every list in a stable order: pieces published at
 * the same instant come back from the database in any order once a row has
 * been rewritten, and so do the id lists built from them.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(stable)
    const key = (x: unknown) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Row).id ?? (x as Row).influencerId ?? JSON.stringify(x)) : String(x))
    return items.every(x => typeof x === 'string' || (x && typeof x === 'object' && ('id' in (x as Row) || 'influencerId' in (x as Row))))
      ? [...items].sort((a, b) => key(a).localeCompare(key(b)))
      : items
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v)]))
  return value
}

/** Every figure of the overview that a merge must not change (members, cost and what is divided by the cost apart). */
function figures(o: CampaignOverview) {
  return {
    totals: without(o.totals, 'members', 'cost', 'membersWithCost', 'cpm', 'emvRatio'),
    // Pieces published at the same instant come back in any order: compared by id
    perMedia: [...o.perMedia].sort((a, b) => a.id.localeCompare(b.id)).map(m => without(m, 'influencerId', 'publishedBy', 'username', 'followers')),
    timeline: o.timeline,
  }
}

// ---------------------------------------------------------------------------

describe('previewMerge', () => {
  it('says what a link merge does, campaign by campaign, and changes nothing', async () => {
    const fx = await seed()
    const before = await snapshot()
    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    expect(await snapshot()).toEqual(before)

    expect(p).toMatchObject({
      keep: { id: fx.danaIg, username: 'dana_ejemplo', platform: 'INSTAGRAM', followers: 652, personId: null },
      other: { id: fx.danaTt, platform: 'TIKTOK' },
      mode: 'link',
      person: { keptPersonId: null, createsPerson: true, joining: [{ id: fx.danaTt }], otherLeavesPerson: false },
      missingChoices: [],
      nothingToDo: false,
      canApply: true,
      summary: '@dana_ejemplo (TikTok) unida como perfil de @dana_ejemplo (Instagram): «Micros Octubre (prueba)» 36 → 35 creadoras',
    })
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const oct = p.campaigns.find(c => c.campaignId === fx.oct)!
    expect(oct).toMatchObject({
      action: 'fold',
      otherMembershipId: fx.danaTtOct,
      survivor: { membershipId: fx.danaIgOct, influencerId: fx.danaIg, username: 'dana_ejemplo', platform: 'INSTAGRAM' },
      target: { influencerId: fx.danaIg },
      membersBefore: 36, membersAfter: 35, piecesBefore: 33, piecesAfter: 33, movedPieces: 1, movedNotes: 0,
      viewsAndEngagements: 'unchanged', costBefore: 3600, costAfter: 3500,
      fields: [], conflicts: [], duplicates: [], warnings: [],
    })
    const tt = p.campaigns.find(c => c.campaignId === fx.ttOnly)!
    expect(tt).toMatchObject({ action: 'unchanged', membersBefore: 1, membersAfter: 1, movedPieces: 0, costBefore: 70, costAfter: 70 })
    expect(tt.warnings).toEqual(['@dana_ejemplo (TikTok) sigue siendo miembro de «Solo TikTok (prueba)»: la persona cuenta en esa campaña a través de este perfil.'])
    expect(p.campaigns).toHaveLength(2)
  })

  it('says what an absorb merge does: a fold in October, a move in June, notes, report and permissions, and that the wrong handle stops being read', async () => {
    const fx = await seed()
    const p = await previewMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb' })
    expect(p.person).toMatchObject({ keptPersonId: null, createsPerson: false, joining: [], otherLeavesPerson: false })
    expect(p.summary).toBe('@vane_mal (Instagram) fusionada en @vane_inventada (Instagram): «Micros Octubre (prueba)» 36 → 35 creadoras; «Micros Junio (prueba)»: su ficha pasa a @vane_inventada')
    const oct = p.campaigns.find(c => c.campaignId === fx.oct)!
    expect(oct).toMatchObject({ action: 'fold', survivor: { membershipId: fx.vaneRealOct }, movedPieces: 0, movedNotes: 2, costBefore: 3600, costAfter: 3500 })
    expect(oct.warnings).toEqual(['En el informe del cliente de «Micros Octubre (prueba)» @vane_mal (Instagram) está oculta y @vane_inventada (Instagram) no: sus publicaciones pasarán a verse en el informe.'])
    const jun = p.campaigns.find(c => c.campaignId === fx.jun)!
    expect(jun).toMatchObject({ action: 'move', survivor: null, target: { influencerId: fx.vaneReal }, membersBefore: 5, membersAfter: 5, piecesBefore: 2, piecesAfter: 2, movedPieces: 1, movedNotes: 1, costBefore: 390, costAfter: 390 })
    expect(jun.warnings).toEqual([
      'En el informe del cliente de «Micros Junio (prueba)» @vane_mal (Instagram) estaba oculta: queda oculta @vane_inventada (Instagram) en su lugar.',
      'Los permisos de anuncios de @vane_mal (Instagram) en «Micros Junio (prueba)» pasan a @vane_inventada (Instagram).',
    ])
    expect(p.warnings[0]).toBe('@vane_mal (Instagram) deja de rastrearse: sale de todas sus campañas. Sus publicaciones se quedan, acreditadas a la ficha que se queda.')
  })

  it('warns, never silently, when nobody will read the folded TikTok account', async () => {
    const fx = await seed()
    await prisma.campaign.update({ where: { id: fx.oct }, data: { platforms: ['INSTAGRAM'] } })
    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    expect(p.campaigns.find(c => c.campaignId === fx.oct)!.warnings).toEqual([
      '«Micros Octubre (prueba)»: después de fusionarla nadie lee @dana_ejemplo (TikTok): la campaña no incluye TikTok en sus plataformas (Aprender → "Editar Campaña" → "Plataformas").',
    ])
  })

  it('refuses bad input clearly', async () => {
    const fx = await seed()
    await expectMergeError(previewMerge({ keepId: fx.danaIg, otherId: fx.danaIg, mode: 'link' }), 'invalid')
    await expectMergeError(previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'fold' as MergeMode }), 'invalid')
    await expectMergeError(previewMerge({ keepId: fx.danaIg, otherId: 'no-such-profile', mode: 'link' }), 'not_found')
    await expectMergeError(previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices: { [fx.oct]: { agreedFee: 'both' as 'add' } } }), 'invalid')
  })
})

describe('applyMerge', () => {
  it('the October-like case: 36 → 34 members, every piece and sum unchanged, the June row moved with its piece, the TikTok campaign untouched', async () => {
    const fx = await seed()
    const [oct0, jun0, tt0] = [await overview(fx.oct), await overview(fx.jun), await overview(fx.ttOnly)]
    expect(oct0.totals).toMatchObject({ members: 36, creatorsActive: 28, media: 33, cost: 3600 })
    const before = await snapshot()

    const dana = await merge(fx, fx.danaIg, fx.danaTt, 'link')
    const vane = await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')
    expect(dana.campaigns.find(c => c.campaignId === fx.oct)).toMatchObject({ action: 'fold', membersBefore: 36, membersAfter: 35 })
    expect(vane.campaigns.find(c => c.campaignId === fx.oct)).toMatchObject({ action: 'fold', membersBefore: 35, membersAfter: 34 })

    // October: two members less; the same pieces, views and interactions; the folded fees less
    const oct1 = await overview(fx.oct)
    expect(oct1.totals).toMatchObject({ members: 34, creatorsActive: 28, media: 33, cost: 3400 })
    expect(figures(oct1)).toEqual(figures(oct0))
    const danaRow = oct1.perInfluencer.find(p => p.influencerId === fx.danaIg)!
    expect(danaRow).toMatchObject({ media: 1, views: 5400 })
    expect(oct1.perMedia.find(m => m.id === fx.danaTtVideo)!.publishedBy).toEqual({ influencerId: fx.danaTt, username: 'dana_ejemplo', platform: 'TIKTOK' })
    expect(oct1.perInfluencer.map(p => p.influencerId)).not.toContain(fx.danaTt)
    expect(oct1.perInfluencer.map(p => p.influencerId)).not.toContain(fx.vaneWrong)

    // June: same members and figures; the wrong handle's row is now the real one's, with its piece
    const jun1 = await overview(fx.jun)
    expect(jun1.totals).toEqual(jun0.totals)
    expect(figures(jun1)).toEqual(figures(jun0))
    expect(jun1.perInfluencer.map(p => p.influencerId)).toContain(fx.vaneReal)
    expect(jun1.perInfluencer.map(p => p.influencerId)).not.toContain(fx.vaneWrong)
    // The TikTok-only campaign (link mode): untouched
    expect(stable(await overview(fx.ttOnly))).toEqual(stable(tt0))

    const after = await snapshot()
    const m0 = byId(before.campaign_influencers)
    const m1 = byId(after.campaign_influencers)
    // Only the two folded October rows are gone; the survivors are byte-identical (nothing to merge on them)
    expect(before.campaign_influencers.filter(r => !m1.has(String(r.id))).map(r => r.id).sort()).toEqual([fx.danaTtOct, fx.vaneWrongOct].sort())
    expect(m1.get(fx.danaIgOct)).toEqual(m0.get(fx.danaIgOct))
    expect(m1.get(fx.vaneRealOct)).toEqual(m0.get(fx.vaneRealOct))
    // The June row moved: same id, every column but the profile (and its updatedAt)
    expect(m1.get(fx.vaneWrongJun)).toMatchObject({ influencerId: fx.vaneReal, agreedFee: 50 })
    expect(without(m1.get(fx.vaneWrongJun)!, 'influencerId', 'updatedAt')).toEqual(without(m0.get(fx.vaneWrongJun)!, 'influencerId', 'updatedAt'))
    expect(m1.get(fx.danaTtOnly)).toEqual(m0.get(fx.danaTtOnly))
    expect(m1.get(fx.danaIgJun)).toEqual(m0.get(fx.danaIgJun))

    // Pieces: credited to the surviving member, keeping who published them; nothing else moved
    const p0 = byId(before.media)
    const p1 = byId(after.media)
    expect(p1.get(fx.danaTtVideo)).toMatchObject({ influencerId: fx.danaIg, publishedByInfluencerId: fx.danaTt, campaignId: fx.oct })
    expect(p1.get(fx.vaneWrongJunReel)).toMatchObject({ influencerId: fx.vaneReal, publishedByInfluencerId: fx.vaneWrong, campaignId: fx.jun })
    for (const [id, row] of p0) if (id !== fx.danaTtVideo && id !== fx.vaneWrongJunReel) expect(p1.get(id), id).toEqual(row)

    // Notes follow the row
    const n1 = byId(after.campaign_notes)
    for (const id of fx.wrongNotesOct) expect(n1.get(id)).toMatchObject({ influencerId: fx.vaneReal, campaignId: fx.oct })
    expect(n1.get(fx.wrongNoteJun)).toMatchObject({ influencerId: fx.vaneReal, campaignId: fx.jun })
    expect(n1.get(fx.realNoteOct)).toEqual(byId(before.campaign_notes).get(fx.realNoteOct))

    // The client report's hidden creators and the ad permissions are re-keyed
    const setting = async (key: string) => (await prisma.setting.findUnique({ where: { key } }))?.value ?? null
    expect(JSON.parse((await setting(`campaign_report_${fx.oct}`))!)).toEqual({ hiddenSections: ['learnings'], hiddenInfluencerIds: [fx.fillers[9]], intro: 'Para la marca' })
    expect(JSON.parse((await setting(`campaign_report_${fx.jun}`))!)).toEqual({ hiddenInfluencerIds: [fx.vaneReal] })
    expect(await setting(`ad_permissions_${fx.jun}_${fx.vaneWrong}`)).toBeNull()
    expect(JSON.parse((await setting(`ad_permissions_${fx.jun}_${fx.vaneReal}`))!)).toEqual([{ id: 'perm_1', creatorId: fx.vaneReal, campaignId: fx.jun, status: 'GRANTED' }])

    // One person for dana's two profiles; the wrong handle belongs to nobody; no other profile was written
    const [danaIg, danaTt, vaneWrong, vaneReal] = await Promise.all([fx.danaIg, fx.danaTt, fx.vaneWrong, fx.vaneReal].map(id => prisma.influencer.findUniqueOrThrow({ where: { id } })))
    expect(danaIg.personId).toBeTruthy()
    expect(danaTt.personId).toBe(danaIg.personId)
    expect(dana.personId).toBe(danaIg.personId)
    expect(vaneWrong.personId).toBeNull()
    expect(vaneReal.personId).toBeNull()
    expect(await prisma.person.findUniqueOrThrow({ where: { id: danaIg.personId! } })).toMatchObject({ displayName: 'dana_ejemplo', createdById: fx.admin.id })
    const i0 = byId(before.influencers)
    const i1 = byId(after.influencers)
    for (const [id, row] of i0) expect(without(i1.get(id)!, 'personId'), id).toEqual(without(row, 'personId'))

    // One log row each, with the summary, who did it, and every row as it was
    const logs = await prisma.personLog.findMany({ where: { action: 'merge' }, orderBy: { createdAt: 'asc' } })
    expect(logs.map(l => l.summary)).toEqual([dana.summary, vane.summary])
    expect(logs[0]).toMatchObject({ actorId: fx.admin.id, actorName: 'Ada Admin', personId: danaIg.personId, undoneAt: null })
    expect(logs[1].personId).toBeNull()
    const logged = logs[1].before as { memberships: Row[] }
    expect(byId(logged.memberships).get(fx.vaneWrongOct)).toEqual(m0.get(fx.vaneWrongOct))
    expect(byId(logged.memberships).get(fx.vaneWrongJun)).toEqual(m0.get(fx.vaneWrongJun))
    expect((await listMergeHistory()).map(h => [h.action, h.summary, h.undoable, h.mode])).toEqual([
      ['merge', vane.summary, true, 'absorb'],
      ['merge', dana.summary, true, 'link'],
    ])
  })

  it('a money conflict refuses the merge until it is chosen; «add» adds', async () => {
    const fx = await seed()
    await prisma.campaignInfluencer.update({ where: { id: fx.danaTtOct }, data: { agreedFee: 80, cost: 80 } })
    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    expect(p.canApply).toBe(false)
    expect(p.missingChoices).toEqual([
      { campaignId: fx.oct, group: 'agreedFee', label: 'Honorario acordado' },
      { campaignId: fx.oct, group: 'cost', label: 'Coste' },
    ])
    const oct = p.campaigns.find(c => c.campaignId === fx.oct)!
    expect(oct.costAfter).toBeNull()
    expect(oct.conflicts.map(c => [c.group, c.survivorValue, c.otherValue, c.default, c.needsChoice])).toEqual([['agreedFee', 100, 80, null, true], ['cost', 100, 80, null, true]])

    const before = await snapshot()
    const err = await expectMergeError(applyMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', fingerprint: p.fingerprint }, ACTOR(fx)), 'needs_choice')
    expect(err.details).toEqual({ missingChoices: p.missingChoices })
    expect(err.message).toContain('Honorario acordado («Micros Octubre (prueba)»)')
    // One choice is not enough either
    await expectMergeError(applyMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices: { [fx.oct]: { agreedFee: 'add' } }, fingerprint: p.fingerprint }, ACTOR(fx)), 'needs_choice')
    expect(await snapshot()).toEqual(before)

    const choices: MergeChoices = { [fx.oct]: { agreedFee: 'add', cost: 'add' } }
    const chosen = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices })
    expect(chosen.fingerprint).toBe(p.fingerprint) // choices are not data: the preview is the same
    expect(chosen.canApply).toBe(true)
    expect(chosen.campaigns.find(c => c.campaignId === fx.oct)!.costAfter).toBe(3580)
    const cost0 = (await overview(fx.oct)).totals.cost
    await applyMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices, fingerprint: p.fingerprint }, ACTOR(fx))
    expect(await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.danaIgOct } })).toMatchObject({ agreedFee: 180, cost: 180 })
    // The money is the same: two rows of 100 and 80 became one of 180
    expect((await overview(fx.oct)).totals.cost).toBe(cost0)
  })

  it('the survivor takes the values as chosen, and undo puts its row back exactly', async () => {
    const fx = await seed()
    await prisma.campaignInfluencer.update({ where: { id: fx.danaTtOct }, data: { status: 'POSTED', notes: 'Vídeo el 12', shippingName: 'Dana E.', shippingCity: 'Málaga', deliverablesPlanned: 2 } })
    await prisma.campaignInfluencer.update({ where: { id: fx.danaIgOct }, data: { status: 'CONTRACTED', notes: 'Prefiere martes', deliverablesPlanned: 1 } })
    const survivor0 = (await rowsOf('campaign_influencers')).find(r => r.id === fx.danaIgOct)!
    const choices: MergeChoices = { [fx.oct]: { deliverablesPlanned: 'other', status: 'keep' } }
    const result = await merge(fx, fx.danaIg, fx.danaTt, 'link', choices)
    const survivor = await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.danaIgOct } })
    expect(survivor).toMatchObject({
      status: 'CONTRACTED', deliverablesPlanned: 2, notes: 'Prefiere martes\n\nVídeo el 12', shippingName: 'Dana E.', shippingCity: 'Málaga',
      agreedFee: 100, createdAt: new Date('2026-09-20T08:00:00.123Z'), addedByName: 'Laura PM',
    })
    await undoMerge(result.logId, ACTOR(fx))
    expect((await rowsOf('campaign_influencers')).find(r => r.id === fx.danaIgOct)).toEqual(survivor0)
  })

  it('the library itself refuses an actor who is not an active ADMIN, and changes nothing', async () => {
    const fx = await seed()
    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    const before = await snapshot()
    const input = { keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' as const, fingerprint: p.fingerprint }
    await expectMergeError(applyMerge(input, fx.pm), 'forbidden')
    await expectMergeError(applyMerge(input, null), 'forbidden')
    await expectMergeError(applyMerge(input, { id: 'no-such-user', name: 'Nadie' }), 'forbidden')
    await prisma.user.update({ where: { id: fx.admin.id }, data: { isActive: false } })
    await expectMergeError(applyMerge(input, ACTOR(fx)), 'forbidden')
    expect(await snapshot()).toEqual(before)
    await prisma.user.update({ where: { id: fx.admin.id }, data: { isActive: true } })
    const done = await applyMerge(input, ACTOR(fx))
    await expectMergeError(undoMerge(done.logId, fx.pm), 'forbidden')
  })

  it('refuses a stale preview and changes nothing', async () => {
    const fx = await seed()
    const p = await previewMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb' })
    await prisma.campaignInfluencer.update({ where: { id: fx.vaneWrongOct }, data: { notes: 'Escrita después de la vista previa' } })
    const before = await snapshot()
    await expectMergeError(applyMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: p.fingerprint }, ACTOR(fx)), 'stale')
    await expectMergeError(applyMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: 'not-a-preview' }, ACTOR(fx)), 'stale')
    // A preview made for the other mode is not this merge's preview
    const link = await previewMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'link' })
    await expectMergeError(applyMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: link.fingerprint }, ACTOR(fx)), 'stale')
    await expectMergeError(applyMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: '' }, ACTOR(fx)), 'invalid')
    expect(await snapshot()).toEqual(before)
    expect(await prisma.personLog.count()).toBe(0)

    // A fresh preview goes through, and the note written meanwhile is kept
    await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')
    expect(await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.vaneRealOct } })).toMatchObject({ notes: 'Escrita después de la vista previa' })
  })

  it('the same post under both rows of one campaign: the richer row stays, the other is detached (never deleted); undo puts both back', async () => {
    const fx = await seed()
    // Post A: the survivor's row is richer. Post B: the other's row is richer (real statistics).
    const aReal = (await piece(fx.oct, fx.vaneReal, 'INSTAGRAM', 'REEL', { views: 5000, likes: 200, comments: 10 }, { externalId: 'meta-178900001', permalink: 'https://www.instagram.com/p/DupCodeAA1/' })).id
    const aWrong = (await piece(fx.oct, fx.vaneWrong, 'INSTAGRAM', 'REEL', { views: 100, likes: 5, comments: 0 }, { externalId: '3500000000000000001', permalink: 'https://www.instagram.com/reel/DupCodeAA1/' })).id
    const bReal = (await piece(fx.oct, fx.vaneReal, 'INSTAGRAM', 'REEL', { views: 900, likes: 20, comments: 1 }, { externalId: 'meta-178900002', permalink: 'https://www.instagram.com/reel/DupCodeBB2/' })).id
    const bWrong = (await piece(fx.oct, fx.vaneWrong, 'INSTAGRAM', 'REEL', { views: 800, likes: 15, comments: 1 }, { externalId: '3500000000000000002', permalink: 'https://www.instagram.com/p/DupCodeBB2/', insightsSource: 'creator_screenshot' })).id
    const before = await snapshot()
    const pieces0 = (await overview(fx.oct)).totals.media

    const p = await previewMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb' })
    const oct = p.campaigns.find(c => c.campaignId === fx.oct)!
    expect(oct.duplicates).toEqual([
      { keepMediaId: aReal, detachMediaId: aWrong, platform: 'INSTAGRAM', permalink: 'https://www.instagram.com/reel/DupCodeAA1/' },
      { keepMediaId: bWrong, detachMediaId: bReal, platform: 'INSTAGRAM', permalink: 'https://www.instagram.com/reel/DupCodeBB2/' },
    ])
    expect(oct).toMatchObject({ piecesBefore: pieces0, piecesAfter: pieces0 - 2, movedPieces: 1 })

    const result = await applyMerge({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: p.fingerprint }, ACTOR(fx))
    const rows = byId(await rowsOf('media'))
    expect(rows.get(aReal)).toEqual(byId(before.media).get(aReal))
    expect(rows.get(aWrong)).toMatchObject({ campaignId: null, influencerId: fx.vaneWrong })
    expect(rows.get(bWrong)).toMatchObject({ campaignId: fx.oct, influencerId: fx.vaneReal, publishedByInfluencerId: fx.vaneWrong })
    expect(rows.get(bReal)).toMatchObject({ campaignId: null, influencerId: fx.vaneReal })
    expect((await overview(fx.oct)).totals.media).toBe(pieces0 - 2)

    await undoMerge(result.logId, ACTOR(fx))
    expect(await snapshot()).toEqual(before)
  })

  it('person union: the other person’s profiles join the kept one (link); in absorb the other leaves; undo restores every person', async () => {
    const fx = await seed()
    // dana's Instagram already has a person with a YouTube; dana's TikTok has one with a second Instagram
    const yt = await prisma.influencer.create({ data: { username: 'dana_canal', platform: 'YOUTUBE', followers: 300 } })
    const ig2 = await prisma.influencer.create({ data: { username: 'dana_recetas', platform: 'INSTAGRAM', followers: 90 } })
    await linkProfile({ memberInfluencerId: fx.danaIg, profileInfluencerId: yt.id, actor: null, evidence: 'pm_manual' })
    await linkProfile({ memberInfluencerId: fx.danaTt, profileInfluencerId: ig2.id, actor: null, evidence: 'pm_manual' })
    const before = await snapshot()
    const personOf = async (id: string) => (await prisma.influencer.findUniqueOrThrow({ where: { id } })).personId
    const kept = await personOf(fx.danaIg)
    const otherPerson = await personOf(fx.danaTt)

    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    expect(p.person).toMatchObject({ keptPersonId: kept, createsPerson: false, otherPersonId: otherPerson })
    expect(p.person.joining.map(j => j.id).sort()).toEqual([ig2.id, fx.danaTt].sort())
    const linked = await applyMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', fingerprint: p.fingerprint }, ACTOR(fx))
    for (const id of [fx.danaIg, yt.id, fx.danaTt, ig2.id]) expect(await personOf(id), id).toBe(kept)
    expect(await prisma.person.count({ where: { id: otherPerson! } })).toBe(1) // never deleted, left without profiles
    await undoMerge(linked.logId, ACTOR(fx))
    expect(await snapshot()).toEqual(before)

    const absorbed = await merge(fx, fx.danaIg, fx.danaTt, 'absorb')
    expect(await personOf(fx.danaTt)).toBeNull()
    expect(await personOf(ig2.id)).toBe(kept)
    await undoMerge(absorbed.logId, ACTOR(fx))
    expect(await snapshot()).toEqual(before)
  })
})

describe('undoMerge', () => {
  it('puts every column of every touched row back; idempotent; the merge can be done again', async () => {
    const fx = await seed()
    const before = await snapshot()
    const [oct0, jun0] = [await overview(fx.oct), await overview(fx.jun)]
    const dana = await merge(fx, fx.danaIg, fx.danaTt, 'link')
    const vane = await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')

    const undoneVane = await undoMerge(vane.logId, ACTOR(fx))
    expect(undoneVane).toMatchObject({ kind: 'merge', alreadyUndone: false, overwritten: [], notRestored: [], restored: { memberships: 3, pieces: 1, notes: 3, settings: 4, profiles: 0 } })
    const undoneDana = await undoMerge(dana.logId, ACTOR(fx))
    expect(undoneDana).toMatchObject({ restored: { memberships: 2, pieces: 1, notes: 0, settings: 0, profiles: 2 } })

    // Row by row, column by column
    const after = await snapshot()
    for (const t of TABLES) expect(after[t], t).toEqual(before[t])
    expect(stable(await overview(fx.oct))).toEqual(stable(oct0))
    expect(stable(await overview(fx.jun))).toEqual(stable(jun0))

    // Logged; a second undo changes nothing and says so
    for (const r of [dana, vane]) {
      const log = await prisma.personLog.findUniqueOrThrow({ where: { id: r.logId } })
      expect(log.undoneAt).toBeInstanceOf(Date)
      expect(log.undoneById).toBe(fx.admin.id)
      expect(await prisma.personLog.count({ where: { action: 'undo', undoOfId: r.logId } })).toBe(1)
    }
    expect(await undoMerge(vane.logId, ACTOR(fx))).toMatchObject({ alreadyUndone: true, undoLogId: undoneVane.undoLogId })
    expect(await snapshot()).toEqual(before)
    expect((await listMergeHistory()).every(h => !h.undoable && h.undoneByName === 'Ada Admin')).toBe(true)
    await expectMergeError(undoMerge('no-such-log', ACTOR(fx)), 'not_found')
    await expectMergeError(undoMerge('', ACTOR(fx)), 'invalid')

    await merge(fx, fx.danaIg, fx.danaTt, 'link')
    await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')
    expect((await overview(fx.oct)).totals.members).toBe(34)
  })

  it('after an edit it refuses without force and changes nothing; with force it restores and reports what it overwrote; a new piece of the restored profile goes back to her row', async () => {
    const fx = await seed()
    const dana = await merge(fx, fx.danaIg, fx.danaTt, 'link')
    // After the merge: the PM edits the surviving row, and the daily pass files a new TikTok video of dana's under it
    await prisma.campaignInfluencer.update({ where: { id: fx.danaIgOct }, data: { agreedFee: 150 } })
    const newVideo = (await piece(fx.oct, fx.danaIg, 'TIKTOK', 'VIDEO', { views: 300, likes: 9, comments: 0 }, { publishedByInfluencerId: fx.danaTt })).id
    const state = await snapshot()

    const err = await expectMergeError(undoMerge(dana.logId, ACTOR(fx)), 'changed_since')
    const differences = (err.details as { differences: Array<{ kind: string; id: string; text: string; blocking: boolean }> }).differences
    expect(differences).toEqual([
      { kind: 'membership', id: fx.danaIgOct, blocking: false, text: 'La ficha de @dana_ejemplo (Instagram) en «Micros Octubre (prueba)» ha cambiado desde la fusión: Honorario acordado 100 → 150.' },
      { kind: 'piece', id: newVideo, blocking: false, text: 'Desde la fusión ha entrado en «Micros Octubre (prueba)» una publicación de @dana_ejemplo (TikTok): vuelve a su ficha.' },
    ])
    expect(await snapshot()).toEqual(state)
    expect((await prisma.personLog.findUniqueOrThrow({ where: { id: dana.logId } })).undoneAt).toBeNull()

    // Forcing needs the hash of the list that was shown: without it, or with an older one, it asks again
    const hash = (err.details as { differencesHash: string }).differencesHash
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    await expectMergeError(undoMerge(dana.logId, ACTOR(fx), { force: true }), 'changed_since')
    await expectMergeError(undoMerge(dana.logId, ACTOR(fx), { force: true, differencesHash: 'f'.repeat(64) }), 'changed_since')
    expect(await snapshot()).toEqual(state)
    const forced = await undoMerge(dana.logId, ACTOR(fx), { force: true, differencesHash: hash })
    expect(forced.overwritten).toEqual(differences)
    expect(await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.danaIgOct } })).toMatchObject({ agreedFee: 100 })
    expect(await prisma.campaignInfluencer.findUniqueOrThrow({ where: { id: fx.danaTtOct } })).toMatchObject({ influencerId: fx.danaTt, agreedFee: 100 })
    expect(await prisma.media.findUniqueOrThrow({ where: { id: newVideo } })).toMatchObject({ influencerId: fx.danaTt, publishedByInfluencerId: null, campaignId: fx.oct })
    expect(await prisma.media.findUniqueOrThrow({ where: { id: fx.danaTtVideo } })).toMatchObject({ influencerId: fx.danaTt, publishedByInfluencerId: null })
    const undoLog = await prisma.personLog.findFirstOrThrow({ where: { action: 'undo', undoOfId: dana.logId } })
    expect(undoLog.summary).toContain('forzado: 2 cambios sobrescritos')
  })

  it('a forced undo overwrites only what the ADMIN was shown: a change made after the list was shown is listed and asked again', async () => {
    const fx = await seed()
    const dana = await merge(fx, fx.danaIg, fx.danaTt, 'link')
    await prisma.campaignInfluencer.update({ where: { id: fx.danaIgOct }, data: { agreedFee: 150 } })
    const shown = await expectMergeError(undoMerge(dana.logId, ACTOR(fx)), 'changed_since')
    const shownHash = (shown.details as { differencesHash: string }).differencesHash
    // Meanwhile a PM edits the surviving row again (notes)
    await prisma.campaignInfluencer.update({ where: { id: fx.danaIgOct }, data: { notes: 'Envío confirmado' } })
    const state = await snapshot()
    const again = await expectMergeError(undoMerge(dana.logId, ACTOR(fx), { force: true, differencesHash: shownHash }), 'changed_since')
    expect(again.message).toContain('Desde que revisaste los cambios ha cambiado algo más')
    const list = (again.details as { differences: Array<{ text: string }> }).differences.map(d => d.text).join(' ')
    expect(list).toContain('Honorario acordado 100 → 150')
    expect(list).toContain('Notas — → Envío confirmado')
    expect(await snapshot()).toEqual(state)
    expect((await prisma.personLog.findUniqueOrThrow({ where: { id: dana.logId } })).undoneAt).toBeNull()
    // With the list of now, it goes
    const forced = await undoMerge(dana.logId, ACTOR(fx), { force: true, differencesHash: (again.details as { differencesHash: string }).differencesHash })
    expect(forced.overwritten.map(d => d.text).join(' ')).toContain('Envío confirmado')
  })

  it('refuses even with force when the restored profile is a member of that campaign again, and changes nothing', async () => {
    const fx = await seed()
    const vane = await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.oct, influencerId: fx.vaneWrong, status: 'PROSPECT' } })
    const state = await snapshot()
    const err = await expectMergeError(undoMerge(vane.logId, ACTOR(fx), { force: true }), 'cannot_undo')
    expect(err.message).toContain('@vane_mal (Instagram) vuelve a ser miembro de «Micros Octubre (prueba)»')
    expect(await snapshot()).toEqual(state)
  })

  it('a report configuration edited since: with force only the merged ids go back, the PM’s other edits stay', async () => {
    const fx = await seed()
    const vane = await merge(fx, fx.vaneReal, fx.vaneWrong, 'absorb')
    const key = `campaign_report_${fx.jun}`
    await prisma.setting.update({ where: { key }, data: { value: JSON.stringify({ hiddenInfluencerIds: [fx.vaneReal, fx.fillers[1]], intro: 'Nuevo texto' }) } })
    const err = await expectMergeError(undoMerge(vane.logId, ACTOR(fx)), 'changed_since')
    await undoMerge(vane.logId, ACTOR(fx), { force: true, differencesHash: (err.details as { differencesHash: string }).differencesHash })
    expect(JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key } })).value)).toEqual({ hiddenInfluencerIds: [fx.fillers[1], fx.vaneWrong], intro: 'Nuevo texto' })
  })
})

describe('at the same time', () => {
  it('two merges of the same pair at once: one merge, the other a clean 409', async () => {
    const fx = await seed()
    const p = await previewMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    const run = () => applyMerge({ keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', fingerprint: p.fingerprint }, ACTOR(fx))
    // A profile row of the pair is held by another connection: both merges are inside their transactions before either can go on
    const results = await whileLocked('SELECT id FROM influencers WHERE id = $1 FOR UPDATE', [[fx.danaIg, fx.danaTt].sort()[0]], 2, () => [run(), run()])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    const lost = results.find((r): r is Extract<Settled, { ok: false }> => !r.ok)!
    expect(lost.error).toBeInstanceOf(MergeError)
    expect((lost.error as MergeError).status).toBe(409)
    expect(['stale', 'busy']).toContain((lost.error as MergeError).code)

    expect(await prisma.personLog.count({ where: { action: 'merge' } })).toBe(1)
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.oct } })).toBe(35)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: fx.danaTtVideo } })).toMatchObject({ influencerId: fx.danaIg, publishedByInfluencerId: fx.danaTt })
  })

  it('two undos of the same merge at once: one undo, the other says it was already undone', async () => {
    const fx = await seed()
    const before = await snapshot()
    const dana = await merge(fx, fx.danaIg, fx.danaTt, 'link')
    const results = await whileLocked('SELECT id FROM person_logs WHERE id = $1 FOR UPDATE', [dana.logId], 2, () => [undoMerge(dana.logId, ACTOR(fx)), undoMerge(dana.logId, ACTOR(fx))])
    expect(results.every(r => r.ok)).toBe(true)
    const values = results.map(r => (r as Extract<Settled, { ok: true }>).value as { alreadyUndone: boolean })
    expect(values.map(v => v.alreadyUndone).sort()).toEqual([false, true])
    expect(await prisma.personLog.count({ where: { action: 'undo' } })).toBe(1)
    expect(await snapshot()).toEqual(before)
  })
})
