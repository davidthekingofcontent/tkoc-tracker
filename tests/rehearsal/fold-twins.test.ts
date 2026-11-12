/**
 * REHEARSAL: folding the twin members on the LOCAL COPY of production data.
 *
 * Until 12 Nov 2026 a TikTok link of a creator registered with Instagram
 * created a second member of the campaign (source 'tiktok_link:<id>'). On the
 * copy refreshed at 12:45 UTC on 12 Nov 2026, «10.- Vileda - Micros Octubre»
 * has 40 members (4 twins) and «Dorco - Delyplus» 30 (2 twins). The owner's
 * acceptance: October shows again 36 creators, 27 with content and 35
 * publications. src/lib/person-fold.ts does it; this file proves it on real data:
 *
 *   1. before folding, every campaign's overview computed with the NEW code
 *      equals the golden snapshot computed with the PRODUCTION code;
 *   2. the twins are listed (6: 4 in October, 2 in Dorco), none blocked, and
 *      every one is folded through the library by an ADMIN of the copy;
 *   3. October: 36 members, 27 with content, 35 pieces, and views, likes,
 *      comments, shares, saves and every sum of pieces exactly as before; each
 *      original row adds up her TikTok piece (publishedBy, byPlatform.TIKTOK)
 *      and keeps her own fee, status and shipping. Dorco: 28 members, same
 *      pieces and sums. Every OTHER campaign: identical to the snapshot;
 *   4. the 6 folds are undone: every column of campaign_influencers, media and
 *      campaign_notes of those campaigns is identical to before; then they are
 *      folded again.
 *
 * IT WRITES TO THE COPY, which ends FOLDED. So it is opt-in and runs alone:
 *
 *   REHEARSAL_DATABASE_URL='postgresql://tkoc:local-only@localhost:54329/tkoc_copy' \
 *   REHEARSAL_FOLD=1 \
 *   GOLDEN_FILE=<scratchpad>/golden-base-20261112-1230.json \
 *   GOLDEN_IGNORE_KEYS=publishedBy,byPlatform \
 *   npx vitest run --project rehearsal rehearsal/fold-twins.test.ts
 *
 * Run again, it first undoes the folds in force (newest first) and starts from
 * the copy as it was. After it, overviews.test.ts no longer matches the golden
 * snapshot for those two campaigns: that is the point.
 *
 * Nothing reaches the network (the scraper is mocked and nothing here calls it).
 * No creator is named in this file.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in the rehearsal`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
  }
})

import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import type { CampaignOverview, PerInfluencerMetrics, PerMediaMetrics } from '@/lib/metrics'
import { foldTwins, listLiveFolds, listTwinMemberships, undoFold } from '@/lib/person-fold'
import type { FoldResult, TwinMembership } from '@/lib/person-fold'

/** «10.- Vileda - Micros Octubre» and «Dorco - Delyplus» on the copy */
const OCTOBER = 'cmtif1vzv0ddg01pcs30xx4jt'
const DORCO = 'cmwapcb700vfz01nzj6ywm6hk'
/** The owner's acceptance for October */
const OCTOBER_AFTER = { members: 36, creatorsActive: 27, media: 35 }
const EXPECTED_TWINS = { [OCTOBER]: 4, [DORCO]: 2 }

const ENABLED = process.env.REHEARSAL_FOLD === '1'
const GOLDEN_FILE = process.env.GOLDEN_FILE || ''
/** Keys the production code did not have when the snapshot was taken */
const IGNORED = new Set((process.env.GOLDEN_IGNORE_KEYS ?? 'publishedBy,byPlatform').split(',').map(k => k.trim()).filter(Boolean))
const NOW = new Date('2026-11-12T12:00:00Z')

type Json = Record<string, unknown>

/** Keys sorted, ignored keys out, and the arrays whose order comes from a query with no ORDER BY sorted. */
function canonical(value: unknown, ignore: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(v => canonical(v, ignore))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(([k]) => !ignore.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v, ignore)])
    )
  }
  return value
}
function canonicalOverview(o: unknown, ignore: Set<string> = new Set()): Json | null {
  if (!o) return null
  const c = JSON.parse(JSON.stringify(canonical(o, ignore))) as Json & {
    perInfluencer?: Array<{ influencerId: string }>
    perMedia?: Array<{ id: string }>
    delivery?: { disclosure?: { missingMediaIds?: string[] } }
  }
  c.perInfluencer?.sort((a, b) => a.influencerId.localeCompare(b.influencerId))
  c.perMedia?.sort((a, b) => a.id.localeCompare(b.id))
  c.delivery?.disclosure?.missingMediaIds?.sort()
  return c
}

const without = (row: object, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)))

/**
 * Every path where two canonical overviews differ. Creator rows are matched by
 * influencerId and pieces by id: «perInfluencer[<id>]» = a row only one side
 * has, «perInfluencer[<id>].views» = a value that changed.
 */
function diffPaths(a: unknown, b: unknown, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  const rowKey = at === 'perInfluencer' ? 'influencerId' : at === 'perMedia' ? 'id' : null
  if (rowKey && Array.isArray(a) && Array.isArray(b)) {
    const byKey = (rows: unknown[]) => new Map(rows.map(r => [String((r as Json)[rowKey]), r]))
    const ma = byKey(a)
    const mb = byKey(b)
    const out: string[] = []
    for (const id of new Set([...ma.keys(), ...mb.keys()])) {
      if (!ma.has(id) || !mb.has(id)) out.push(`${at}[${id}]`)
      else out.push(...diffPaths(ma.get(id), mb.get(id), `${at}[${id}]`))
    }
    return out
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: string[] = []
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diffPaths((a as Json)[k], (b as Json)[k], at ? `${at}.${k}` : k))
    return out
  }
  return [at || '(root)']
}

/** The values of a creator's row that add up the pieces of her twin; nothing else of her row may move. */
const ROW_KEYS_THAT_ADD_UP = new Set(['media', 'posts', 'stories', 'deleted', 'views', 'engagements', 'audience', 'er', 'cpm', 'emvBasic', 'emvExtended', 'emvRatio'])

/** Whether a difference from the snapshot is one a fold is expected to make. */
function expectedAfterFold(path: string, ids: { twins: Set<string>; originals: Set<string>; twinPieces: Set<string> }): boolean {
  if (['totals.members', 'totals.creatorsActive', 'delivery.allOk', 'balance.execution'].includes(path)) return true
  if (/^delivery\.creators\.(delivered|planned|ok)$/.test(path)) return true
  const row = path.match(/^perInfluencer\[([^\]]+)\](?:\.(\w+))?/)
  if (row) return row[2] === undefined ? ids.twins.has(row[1]) : ids.originals.has(row[1]) && ROW_KEYS_THAT_ADD_UP.has(row[2])
  const piece = path.match(/^perMedia\[([^\]]+)\]\.influencerId$/)
  if (piece) return ids.twinPieces.has(piece[1])
  return false
}

async function overviewOf(campaignId: string): Promise<CampaignOverview> {
  const o = await computeCampaignOverview(campaignId, { now: NOW } as never)
  if (!o) throw new Error(`no overview for ${campaignId}`)
  return o
}

/** Every row, every column, of the tables a fold writes, for the given campaigns. */
async function rowsOf(campaignIds: string[]) {
  const read = async (table: 'campaign_influencers' | 'media' | 'campaign_notes') => {
    const rows = await prisma.$queryRawUnsafe<Array<{ row: unknown }>>(
      `SELECT row_to_json(t.*) AS row FROM "${table}" t WHERE t."campaignId" = ANY($1::text[]) ORDER BY t.id`,
      campaignIds
    )
    return rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Json)
  }
  return { memberships: await read('campaign_influencers'), media: await read('media'), notes: await read('campaign_notes') }
}

function numbers(o: CampaignOverview) {
  const t = o.totals
  return { members: t.members, creatorsActive: t.creatorsActive, media: t.media, views: t.views, likes: t.likes, comments: t.comments, shares: t.shares, saves: t.saves, engagements: t.engagements }
}

describe.skipIf(!ENABLED)('folding the twin members on the local copy', () => {
  let actor: { id: string; name: string }
  let campaigns: Array<{ id: string; name: string }> = []
  let golden: Record<string, unknown> = {}
  /** Overview of every campaign with the NEW code before folding (full keys) */
  const before = new Map<string, CampaignOverview>()
  let twins: TwinMembership[] = []
  let twinCampaigns: string[] = []
  let rowsBefore: Awaited<ReturnType<typeof rowsOf>>
  let folds: FoldResult[] = []

  const keyOf = (c: { id: string; name: string }) => `${c.name} [${c.id}]`

  beforeAll(async () => {
    const [{ current }] = await prisma.$queryRaw<Array<{ current: string }>>`select current_database() as current`
    const wanted = new URL(process.env.REHEARSAL_DATABASE_URL || 'postgresql://x@localhost:1/none').pathname.replace(/^\//, '')
    if (current !== wanted) throw new Error(`Refusing to run: connected to "${current}", not to "${wanted}"`)
    if (!GOLDEN_FILE || !fs.existsSync(GOLDEN_FILE)) throw new Error('GOLDEN_FILE must name the snapshot taken with the production code')
    golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'))

    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true } })
    if (!admin) throw new Error('The copy has no active ADMIN user to act as')
    actor = { id: admin.id, name: admin.name }

    // A previous run leaves the copy folded: undo those folds first (newest first), so every run starts from the copy as it was
    const live = await listLiveFolds()
    for (const fold of live) await undoFold(fold.logId, actor)
    if (live.length > 0) console.log(`[fold rehearsal] undid ${live.length} folds left by a previous run`)

    campaigns = await prisma.campaign.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } })
  })

  it('1. before folding, every overview with the new code equals the snapshot of the production code', async () => {
    expect(Object.keys(golden).sort()).toEqual(campaigns.map(keyOf).sort())
    for (const c of campaigns) {
      const o = await overviewOf(c.id)
      before.set(c.id, o)
      expect(canonicalOverview(o, IGNORED), keyOf(c)).toEqual(canonicalOverview(golden[keyOf(c)], IGNORED))
    }
    const october = before.get(OCTOBER)!
    console.log(`[fold rehearsal] before: October ${JSON.stringify(numbers(october))}; Dorco ${JSON.stringify(numbers(before.get(DORCO)!))}`)
  })

  it('2. lists 6 twins (4 in October, 2 in Dorco), none blocked, and folds every one', async () => {
    expect(before.size, 'step 1 must run first').toBe(campaigns.length)
    twins = await listTwinMemberships()
    const perCampaign: Record<string, number> = {}
    for (const t of twins) perCampaign[t.campaignId] = (perCampaign[t.campaignId] ?? 0) + 1
    console.log(`[fold rehearsal] twins: ${twins.map(t => `${t.campaignName}: @${t.twin.username} (${t.twin.platform}, ${t.pieces} pieces, ${t.notes} notes) -> @${t.original?.username ?? '?'}${t.blockers.length ? ` BLOCKED: ${t.blockers.map(b => b.reason).join('; ')}` : ''}${t.warnings.length ? ` WARNING: ${t.warnings.join('; ')}` : ''}`).join(' | ')}`)
    expect(perCampaign).toEqual(EXPECTED_TWINS)
    for (const t of twins) {
      expect(t.blockers, `${t.campaignName} @${t.twin.username}`).toEqual([])
      expect(t.original, `${t.campaignName} @${t.twin.username}`).not.toBeNull()
    }
    twinCampaigns = Object.keys(perCampaign).sort()
    rowsBefore = await rowsOf(twinCampaigns)

    const report = await foldTwins({ actor })
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.folded.map(f => f.membershipId).sort()).toEqual(twins.map(t => t.membershipId).sort())
    folds = report.folded
    for (const f of folds) {
      const t = twins.find(x => x.membershipId === f.membershipId)!
      expect(f.movedPieces, `@${t.twin.username}`).toBe(t.pieces)
      expect(f.movedNotes, `@${t.twin.username}`).toBe(t.notes)
    }
    expect(await listTwinMemberships()).toEqual([])
    expect(await listLiveFolds()).toHaveLength(6)
  })

  it('3. October counts 36 creators, 27 with content and 35 pieces; Dorco 28; the sums do not move; every other campaign is identical', async () => {
    expect(folds, 'step 2 must run first').toHaveLength(6)
    const originalOf = new Map(twins.map(t => [t.twin.influencerId, t.original!.influencerId]))

    for (const campaignId of twinCampaigns) {
      const old = before.get(campaignId)!
      const now = await overviewOf(campaignId)
      const mine = twins.filter(t => t.campaignId === campaignId)
      const twinIds = new Set(mine.map(t => t.twin.influencerId))
      const label = campaignId === OCTOBER ? 'October' : campaignId === DORCO ? 'Dorco' : campaignId

      // Members: one row less per twin. With content: the members the pieces are credited to now.
      const expectedActive = new Set(old.perMedia.map(m => originalOf.get(m.influencerId ?? '') ?? m.influencerId)).size
      expect(now.totals.members, label).toBe(old.totals.members - mine.length)
      expect(now.totals.creatorsActive, label).toBe(expectedActive)
      // Every sum over the pieces is exactly what it was
      expect(without(now.totals, 'members', 'creatorsActive'), label).toEqual(without(old.totals, 'members', 'creatorsActive'))
      expect(now.timeline, label).toEqual(old.timeline)
      expect(now.targets, label).toEqual(old.targets)
      expect(without(now.delivery, 'creators', 'allOk'), label).toEqual(without(old.delivery, 'creators', 'allOk'))
      expect(without(now.balance, 'execution'), label).toEqual(without(old.balance, 'execution'))

      // Pieces: the same ones; the twins' pieces are credited to the original and say who published them
      const nowMedia = new Map(now.perMedia.map(m => [m.id, m]))
      expect(Array.from(nowMedia.keys()).sort()).toEqual(old.perMedia.map(m => m.id).sort())
      for (const m of old.perMedia) {
        const after = nowMedia.get(m.id)! as PerMediaMetrics
        if (twinIds.has(m.influencerId ?? '')) {
          expect(after.influencerId, m.id).toBe(originalOf.get(m.influencerId ?? ''))
          expect(after.publishedBy?.influencerId, m.id).toBe(m.publishedBy?.influencerId ?? m.influencerId)
          expect(without(after, 'influencerId', 'publishedBy'), m.id).toEqual(without(m, 'influencerId', 'publishedBy'))
        } else {
          expect(after, m.id).toEqual(m)
        }
      }

      // Creators: the twins' rows are gone; each original adds up both rows, per network, and keeps her own deal
      const oldRows = new Map(old.perInfluencer.map(p => [p.influencerId, p]))
      const nowRows = new Map(now.perInfluencer.map(p => [p.influencerId, p]))
      expect(Array.from(nowRows.keys()).sort()).toEqual(Array.from(oldRows.keys()).filter(id => !twinIds.has(id)).sort())
      for (const [id, row] of nowRows) {
        const t = mine.find(x => x.original!.influencerId === id)
        if (!t) { expect(row, id).toEqual(oldRows.get(id)); continue }
        const own = oldRows.get(id)! as PerInfluencerMetrics
        const twin = oldRows.get(t.twin.influencerId)! as PerInfluencerMetrics
        const who = `@${own.username}`
        for (const k of ['media', 'stories', 'posts', 'deleted', 'views', 'engagements'] as const) expect(row[k], `${who} ${k}`).toBe(own[k] + twin[k])
        expect(Math.abs(row.emvExtended - (own.emvExtended + twin.emvExtended)), `${who} emv`).toBeLessThanOrEqual(0.011)
        expect({ cost: row.cost, status: row.status, deliverablesPlanned: row.deliverablesPlanned, trackedClicks: row.trackedClicks, followers: row.followers, username: row.username, platform: row.platform, vsBaseline: row.vsBaseline }, who)
          .toEqual({ cost: own.cost, status: own.status, deliverablesPlanned: own.deliverablesPlanned, trackedClicks: own.trackedClicks, followers: own.followers, username: own.username, platform: own.platform, vsBaseline: own.vsBaseline })
        const networks = new Set([...Object.keys(own.byPlatform ?? {}), ...Object.keys(twin.byPlatform ?? {})])
        for (const n of networks) {
          const a = own.byPlatform?.[n] ?? { pieces: 0, views: 0, engagements: 0 }
          const b = twin.byPlatform?.[n] ?? { pieces: 0, views: 0, engagements: 0 }
          expect(row.byPlatform?.[n], `${who} ${n}`).toEqual({ pieces: a.pieces + b.pieces, views: a.views + b.views, engagements: a.engagements + b.engagements })
        }
        // Her TikTok piece is in her row
        expect(row.byPlatform?.[t.twin.platform]?.pieces ?? 0, `${who} ${t.twin.platform}`).toBeGreaterThanOrEqual(t.pieces)
        if (campaignId === OCTOBER) expect(t.pieces, `${who}: the twin had a piece`).toBeGreaterThan(0)
      }

      // Their fee, status and shipping (every column of the original rows) did not change
      const rowsNow = await rowsOf([campaignId])
      for (const t of mine) {
        const was = rowsBefore.memberships.find(r => r.id === t.original!.membershipId)
        expect(rowsNow.memberships.find(r => r.id === t.original!.membershipId), `@${t.original!.username}`).toEqual(was)
      }
      console.log(`[fold rehearsal] after: ${label} ${JSON.stringify(numbers(now))}`)
    }

    const october = await overviewOf(OCTOBER)
    expect({ members: october.totals.members, creatorsActive: october.totals.creatorsActive, media: october.totals.media }).toEqual(OCTOBER_AFTER)
    expect((await overviewOf(DORCO)).totals.members).toBe(before.get(DORCO)!.totals.members - 2)

    // Every other campaign is identical to the snapshot and to the new code's figures before the folds
    for (const c of campaigns) {
      if (twinCampaigns.includes(c.id)) continue
      const o = await overviewOf(c.id)
      expect(canonicalOverview(o), keyOf(c)).toEqual(canonicalOverview(before.get(c.id)))
      expect(canonicalOverview(o, IGNORED), keyOf(c)).toEqual(canonicalOverview(golden[keyOf(c)], IGNORED))
    }

    // Against the snapshot of the PRODUCTION code: the campaigns that differ are
    // exactly the two with twins, and only in what a fold is expected to change
    const differing: Record<string, string[]> = {}
    for (const c of campaigns) {
      const paths = diffPaths(canonicalOverview(await overviewOf(c.id), IGNORED), canonicalOverview(golden[keyOf(c)], IGNORED))
      if (paths.length > 0) differing[c.id] = paths
    }
    expect(Object.keys(differing).sort()).toEqual([...twinCampaigns].sort())
    for (const [campaignId, paths] of Object.entries(differing)) {
      const mine = twins.filter(t => t.campaignId === campaignId)
      const twinIds = new Set(mine.map(t => t.twin.influencerId))
      const ids = {
        twins: twinIds,
        originals: new Set(mine.map(t => t.original!.influencerId)),
        twinPieces: new Set(before.get(campaignId)!.perMedia.filter(m => twinIds.has(m.influencerId ?? '')).map(m => m.id)),
      }
      const label = campaignId === OCTOBER ? 'October' : campaignId === DORCO ? 'Dorco' : campaignId
      expect(paths.filter(p => !expectedAfterFold(p, ids)), `${label}: differences a fold must not make`).toEqual([])
      // ...and what it must change did change
      expect(paths, label).toContain('totals.members')
      for (const id of ids.twins) expect(paths, `${label}: the twin's row is gone`).toContain(`perInfluencer[${id}]`)
      for (const id of ids.twinPieces) expect(paths, `${label}: the twin's piece is credited to the original`).toContain(`perMedia[${id}].influencerId`)
      // Readable: the twins and originals by role, the pieces counted
      const roleOf = (id: string) => {
        const t = mine.find(x => x.twin.influencerId === id || x.original!.influencerId === id)
        return t ? (t.twin.influencerId === id ? `twin @${t.twin.username}` : `@${t.original!.username}`) : id
      }
      const summary = new Map<string, number>()
      for (const p of paths) {
        const named = p.replace(/^perInfluencer\[([^\]]+)\]/, (_, id: string) => `perInfluencer[${roleOf(id)}]`).replace(/^perMedia\[[^\]]+\]/, 'perMedia[twin piece]')
        summary.set(named, (summary.get(named) ?? 0) + 1)
      }
      console.log(`[fold rehearsal] ${label} differs from the golden snapshot in ${paths.length} values: ${Array.from(summary).map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(', ')}`)
    }
    console.log(`[fold rehearsal] campaigns that differ from the golden snapshot after the fold: ${Object.keys(differing).map(id => campaigns.find(c => c.id === id)!.name).join(' | ')} (of ${campaigns.length})`)
  })

  it('4. undoing the 6 folds gives back every row, column for column; then they are folded again', async () => {
    expect(folds, 'step 2 must run first').toHaveLength(6)
    for (const f of [...folds].reverse()) {
      const undone = await undoFold(f.logId, actor)
      expect(undone, f.membershipId).toMatchObject({ restoredPieces: f.movedPieces, restoredNotes: f.movedNotes, piecesNotRestored: 0, notesNotRestored: 0 })
    }
    const rowsUndone = await rowsOf(twinCampaigns)
    expect(rowsUndone.memberships).toEqual(rowsBefore.memberships)
    expect(rowsUndone.media).toEqual(rowsBefore.media)
    expect(rowsUndone.notes).toEqual(rowsBefore.notes)
    expect(await listLiveFolds()).toEqual([])
    // The profiles stay one person
    for (const t of twins) {
      const [twin, original] = await Promise.all([
        prisma.influencer.findUniqueOrThrow({ where: { id: t.twin.influencerId }, select: { personId: true } }),
        prisma.influencer.findUniqueOrThrow({ where: { id: t.original!.influencerId }, select: { personId: true } }),
      ])
      expect(twin.personId, `@${t.twin.username}`).toBeTruthy()
      expect(twin.personId, `@${t.twin.username}`).toBe(original.personId)
    }
    // And the figures are the snapshot's again
    for (const c of campaigns) {
      expect(canonicalOverview(await overviewOf(c.id), IGNORED), keyOf(c)).toEqual(canonicalOverview(golden[keyOf(c)], IGNORED))
    }

    // The copy ends folded
    const again = await foldTwins({ actor })
    expect(again.failed).toEqual([])
    expect(again.skipped).toEqual([])
    expect(again.folded).toHaveLength(6)
    expect(again.folded.every(f => !f.linkedNow)).toBe(true)
    const october = await overviewOf(OCTOBER)
    expect({ members: october.totals.members, creatorsActive: october.totals.creatorsActive, media: october.totals.media }).toEqual(OCTOBER_AFTER)
    expect(await listLiveFolds()).toHaveLength(6)
    console.log(`[fold rehearsal] the copy ends folded: October ${JSON.stringify(numbers(october))}; Dorco ${JSON.stringify(numbers(await overviewOf(DORCO)))}`)
  })
})
