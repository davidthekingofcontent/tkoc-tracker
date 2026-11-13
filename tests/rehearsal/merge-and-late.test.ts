/**
 * REHEARSAL of the delivery «Fusión de duplicadas + publicaciones fuera de
 * plazo» on the LOCAL COPY of production data (refreshed 13 Nov 2026 21:10 UTC).
 *
 * The owner's acceptance: in «10.- Vileda - Micros Octubre» three creators
 * have two records each, created by hand before the person/profiles model.
 * Merging them must leave 33 creators, 29 with content and 38 publications
 * (36 / 29 / 38 before), every view and interaction as it was and the cost
 * 300 lower. A publication of 5 Nov of a member who has not delivered must be
 * accepted in October, 5 days late. This file proves it on real data:
 *
 *   a. before anything, every campaign's overview with the NEW code equals the
 *      golden snapshot taken with the PRODUCTION code (new keys ignored);
 *   b. the candidates of October are listed (they must include the three pairs
 *      and the fourth case the owner did not list), with the global count by
 *      strength and the time it takes;
 *   c. the three merges are applied through the library as an ADMIN of the
 *      copy: October 33 / 29 / 38, every sum and every piece as before, cost
 *      −300; June keeps its figures with the moved row; every other campaign
 *      identical to the snapshot;
 *   d. the three merges are undone: every row of every table a merge writes is
 *      identical, column by column, to before; then they are applied again;
 *   e. a late publication is added through the real manual route (scraper
 *      MOCKED, invented figures): 201 with lateDays 5, October 39 pieces and 30
 *      creators with content, the revalidation keeps it, a second late piece of
 *      the same creator is refused; then the simulated row is removed.
 *
 * IT WRITES TO THE COPY, which ends with the three merges applied and holding
 * only real data. Opt-in, and alone:
 *
 *   REHEARSAL_DATABASE_URL="$(cat <scratchpad>/local-url.txt)" \
 *   REHEARSAL_MERGE=1 \
 *   GOLDEN_FILE=<scratchpad>/golden-main-20261113.json \
 *   npx vitest run --project rehearsal rehearsal/merge-and-late.test.ts
 *
 * With REHEARSAL_REPORT=<file>, every figure it prints is also written there
 * (the console of a passing test is not always shown).
 *
 * Run again, it first undoes the merges a previous run left (newest first) and
 * removes any simulated late row, so every run starts from the copy as it was.
 * overviews.test.ts with REHEARSAL_UNDO_MERGES=1 does the same undo first, so
 * the order «overviews, then this file» compares the copy as it was with the
 * golden snapshot and leaves it merged.
 *
 * Nothing reaches the network (the scraper is mocked). No creator is named in
 * this file: profiles are addressed by their ids; handles are read from the copy.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

/** What the rehearsal reports: printed, and written to REHEARSAL_REPORT when set */
const reportLines: string[] = []
function log(line: string): void {
  reportLines.push(line)
  console.log(line)
}
afterAll(() => {
  if (process.env.REHEARSAL_REPORT) fs.writeFileSync(process.env.REHEARSAL_REPORT, reportLines.join('\n') + '\n')
})

const net = vi.hoisted(() => ({
  /** What the (mocked) network answers for each clean link */
  posts: new Map<string, unknown>(),
}))
const auth = vi.hoisted(() => ({
  /** The session the manual route sees: an ADMIN of the copy, set in beforeAll */
  session: null as null | { id: string; email: string; name: string; role: string },
}))

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

// The session is the rehearsal's (an ADMIN of the copy); the role rule (isStaffRole) is the real one.
vi.mock('@/lib/auth', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => auth.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import type { TeamCampaignOverview } from '@/lib/campaign-overview'
import { revalidateCampaignMedia, revalidationVerdict } from '@/lib/campaign-capture'
import { applyMerge, findMergeCandidates, pairKey, previewMerge, undoMerge } from '@/lib/person-merge'
import type { MergeApplyResult, MergeCandidate, MergeChoices } from '@/lib/person-merge'
import { parsePostUrl } from '@/lib/post-url'
import { POST as addManualMedia } from '@/app/api/campaigns/[id]/media/manual/route'
import { JUNE, MERGES, OCTOBER, assertOnTheCopy, rehearsalAdmin, undoRehearsalMerges } from './merge-pairs'
/** The fourth case the owner did not list: the finder must show it; nobody merges it here */
const FOURTH_PAIR = pairKey('cmtjuo6c70ffl01pc31zm37h8', 'cmvfcrx9205tg01n0h3nkd8p1')
/** The owner's acceptance for October after the three merges */
const OCTOBER_AFTER = { members: 33, creatorsActive: 29, media: 38 }

/** The member who has not delivered in October, and her publication of 5 Nov (late piece) */
const LATE_MEMBER = 'cmpu6fnic03iz01qkmxujqn37'
const LATE_URL = 'https://www.instagram.com/p/DfXPzSYjZ-T/'
const LATE_POSTED_AT = '2026-11-05T10:00:00.000Z'
/** A second, INVENTED publication of hers after the end: must be refused (she owes nothing any more) */
const SECOND_LATE_URL = 'https://www.instagram.com/p/DfZEnsayo01/'
const SECOND_LATE_POSTED_AT = '2026-11-06T10:00:00.000Z'
/** Invented figures of the simulated publication */
const LATE_FIGURES = { views: 1234, likes: 56, comments: 7 }

const ENABLED = process.env.REHEARSAL_MERGE === '1'
const GOLDEN_FILE = process.env.GOLDEN_FILE || ''
/** Keys the production code did not have when the snapshot was taken */
const IGNORED = new Set((process.env.GOLDEN_IGNORE_KEYS ?? 'lateDays,latePieces,maxLateDays,summary').split(',').map(k => k.trim()).filter(Boolean))
const NOW = new Date('2026-11-13T22:00:00Z')

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

/** Every path where two canonical overviews differ; creator rows matched by influencerId, pieces by id. */
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

async function overviewOf(campaignId: string): Promise<TeamCampaignOverview> {
  const o = await computeCampaignOverview(campaignId, { now: NOW })
  if (!o) throw new Error(`no overview for ${campaignId}`)
  return o
}

function numbers(o: TeamCampaignOverview) {
  const t = o.totals
  return {
    members: t.members, creatorsActive: t.creatorsActive, media: t.media,
    views: t.views, likes: t.likes, comments: t.comments, shares: t.shares, saves: t.saves, engagements: t.engagements,
    cost: t.cost, cpm: t.cpm, membersWithCost: t.membersWithCost, emvRatio: t.emvRatio,
  }
}

/** Every row, every column, of every table a merge (or its undo) writes. */
const SNAPSHOT_TABLES = ['campaign_influencers', 'media', 'campaign_notes', 'influencers', 'persons', 'settings'] as const
type Snapshot = Record<(typeof SNAPSHOT_TABLES)[number], Json[]>
async function snapshotRows(): Promise<Snapshot> {
  const out = {} as Snapshot
  for (const table of SNAPSHOT_TABLES) {
    const rows = await prisma.$queryRawUnsafe<Array<{ row: unknown }>>(`SELECT row_to_json(t.*) AS row FROM "${table}" t ORDER BY t.id`)
    out[table] = rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Json)
  }
  return out
}
/** Row ids that differ between two snapshots of a table (missing on one side, or any column different). */
function rowDifferences(a: Json[], b: Json[]): string[] {
  const ma = new Map(a.map(r => [String(r.id), JSON.stringify(r)]))
  const mb = new Map(b.map(r => [String(r.id), JSON.stringify(r)]))
  const out: string[] = []
  for (const id of new Set([...ma.keys(), ...mb.keys()])) if (ma.get(id) !== mb.get(id)) out.push(id)
  return out
}

/** Instagram shortcode → numeric media id (what the scraper reports as externalId). */
function instagramIdOf(shortcode: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let id = BigInt(0)
  for (const ch of shortcode) id = id * BigInt(64) + BigInt(alphabet.indexOf(ch))
  return id.toString()
}

/** Tells the mocked network about a publication of `author` and returns its clean link and shortcode. */
function serve(url: string, author: string, postedAt: string): { canonicalUrl: string; shortcode: string } {
  const parsed = parsePostUrl(url)
  if (!parsed || parsed.platform !== 'INSTAGRAM') throw new Error(`not an Instagram publication link: ${url}`)
  net.posts.set(parsed.canonicalUrl, {
    externalId: instagramIdOf(parsed.externalId),
    caption: 'Ensayo (cifras inventadas)',
    likes: LATE_FIGURES.likes,
    comments: LATE_FIGURES.comments,
    views: LATE_FIGURES.views,
    thumbnailUrl: null,
    postedAt,
    ownerUsername: author,
    mediaType: 'REEL',
    hashtags: [],
    mentions: [],
  })
  return { canonicalUrl: parsed.canonicalUrl, shortcode: parsed.externalId }
}

async function add(body: unknown): Promise<{ status: number; body: Json }> {
  const request = new NextRequest(`http://localhost/api/campaigns/${OCTOBER}/media/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await addManualMedia(request, { params: Promise.resolve({ id: OCTOBER }) })
  return { status: response.status, body: (await response.json()) as Json }
}

/** The simulated rows of the late step (any campaign, any run): only ever rows this file created */
async function simulatedLateRows(): Promise<Array<{ id: string; campaignId: string | null }>> {
  const shortcodes = [LATE_URL, SECOND_LATE_URL].map(u => parsePostUrl(u)!.externalId)
  const ids = shortcodes.map(instagramIdOf)
  return prisma.media.findMany({
    where: {
      platform: 'INSTAGRAM',
      OR: [{ externalId: { in: [...ids, ...shortcodes] } }, ...shortcodes.map(s => ({ permalink: { contains: `/p/${s}` } }))],
    },
    select: { id: true, campaignId: true },
  })
}

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ['media', 'influencers', 'campaign_influencers', 'persons', 'person_logs', 'campaigns', 'notifications', 'settings', 'campaign_notes']) {
    out[table] = Number((await prisma.$queryRawUnsafe<Array<{ n: number }>>(`select count(*)::int as n from "${table}"`))[0].n)
  }
  return out
}

describe.skipIf(!ENABLED)('merging the duplicates and adding a late piece on the local copy', () => {
  let actor: { id: string; name: string }
  let campaigns: Array<{ id: string; name: string }> = []
  let golden: Record<string, unknown> = {}
  /** Overview of every campaign with the NEW code before anything (full keys) */
  const before = new Map<string, TeamCampaignOverview>()
  let rowsBefore: Snapshot
  let applied: MergeApplyResult[] = []
  let mergedOctober: TeamCampaignOverview | null = null
  const handle = new Map<string, string>()

  const keyOf = (c: { id: string; name: string }) => `${c.name} [${c.id}]`
  const who = (id: string) => `@${handle.get(id) ?? id}`

  /** The pair as the library merges it now: preview, «keep» on every conflict, apply with its fingerprint */
  async function merge(m: (typeof MERGES)[number]): Promise<MergeApplyResult> {
    const first = await previewMerge({ keepId: m.keepId, otherId: m.otherId, mode: m.mode })
    const choices: MergeChoices = {}
    for (const c of first.campaigns) {
      for (const f of c.conflicts) (choices[c.campaignId] ??= {})[f.group] = 'keep'
    }
    const preview = Object.keys(choices).length > 0 ? await previewMerge({ keepId: m.keepId, otherId: m.otherId, mode: m.mode, choices }) : first
    expect(preview.missingChoices, m.label).toEqual([])
    expect(preview.canApply, m.label).toBe(true)
    expect(preview.nothingToDo, m.label).toBe(false)
    for (const c of preview.campaigns) {
      // Pieces before = after (no duplicate post in these pairs), views and engagements unchanged
      expect(c.piecesAfter, `${m.label} ${c.campaignName}`).toBe(c.piecesBefore)
      expect(c.duplicates, `${m.label} ${c.campaignName}`).toEqual([])
    }
    log(`[merge rehearsal] preview ${m.label}: ${preview.summary}`)
    for (const c of preview.campaigns) {
      log(`[merge rehearsal]   «${c.campaignName}» ${c.action}: creadoras ${c.membersBefore} → ${c.membersAfter}, publicaciones ${c.piecesBefore} → ${c.piecesAfter}, coste ${c.costBefore} → ${c.costAfter}; campos: ${c.fields.map(f => `${f.label} (${f.resolution}${f.conflict ? `, elegido ${f.chosen ?? f.default}` : ''})`).join(', ') || '—'}; conflictos: ${c.conflicts.length}`)
    }
    if (preview.warnings.length > 0) log(`[merge rehearsal]   avisos: ${preview.warnings.join(' | ')}`)
    return applyMerge({ keepId: m.keepId, otherId: m.otherId, mode: m.mode, choices, fingerprint: preview.fingerprint }, actor)
  }

  beforeAll(async () => {
    await assertOnTheCopy()
    if (!GOLDEN_FILE || !fs.existsSync(GOLDEN_FILE)) throw new Error('GOLDEN_FILE must name the snapshot taken with the production code')
    golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'))

    const admin = await rehearsalAdmin()
    actor = { id: admin.id, name: admin.name }
    auth.session = { id: admin.id, email: admin.email, name: admin.name, role: 'ADMIN' }

    const ids = [...MERGES.flatMap(m => [m.keepId, m.otherId]), ...FOURTH_PAIR.split('|'), LATE_MEMBER]
    for (const p of await prisma.influencer.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, platform: true } })) {
      handle.set(p.id, `${p.username} (${p.platform})`)
    }

    // A previous run leaves the copy merged (and, if it stopped midway, a simulated late row): start from the copy as it was
    const leftovers = await simulatedLateRows()
    if (leftovers.length > 0) {
      await prisma.media.deleteMany({ where: { id: { in: leftovers.map(r => r.id) } } })
      log(`[merge rehearsal] removed ${leftovers.length} simulated late rows left by a previous run`)
    }
    const undone = await undoRehearsalMerges(actor)
    if (undone > 0) log(`[merge rehearsal] undid ${undone} merges left by a previous run`)

    campaigns = await prisma.campaign.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } })
  })

  it('a. before anything, every overview with the new code equals the snapshot of the production code', async () => {
    expect(Object.keys(golden).sort()).toEqual(campaigns.map(keyOf).sort())
    let identical = 0
    for (const c of campaigns) {
      const o = await overviewOf(c.id)
      before.set(c.id, o)
      expect(canonicalOverview(o, IGNORED), keyOf(c)).toEqual(canonicalOverview(golden[keyOf(c)], IGNORED))
      identical++
    }
    log(`[merge rehearsal] a. ${identical} of ${campaigns.length} campaigns identical to the golden snapshot (ignoring ${Array.from(IGNORED).join(', ')})`)
    log(`[merge rehearsal] a. October before: ${JSON.stringify(numbers(before.get(OCTOBER)!))}`)
    log(`[merge rehearsal] a. June before: ${JSON.stringify(numbers(before.get(JUNE)!))}`)
  })

  it('b. the candidates of October include the three pairs and the fourth case; global count by strength and time', async () => {
    const t0 = performance.now()
    const october = await findMergeCandidates({ campaignId: OCTOBER })
    const octoberMs = performance.now() - t0
    const t1 = performance.now()
    const all = await findMergeCandidates()
    const allMs = performance.now() - t1

    const line = (c: MergeCandidate) => {
      const [k, o] = c.profiles
      const p = (x: typeof k) => `@${x.username} (${x.platform}, ${x.followers} seguidores, ${x.pieces} piezas${x.personId ? ', con persona' : ''}; ${x.campaigns.map(cc => `${cc.name}: ${cc.membershipStatus}, ${cc.pieces} piezas${cc.hasFee ? ', tiene honorario' : ''}`).join(' / ') || 'sin campañas'})`
      const shared = c.sharedCampaigns.map(s => `«${s.name}» ${s.membersBefore} → ${s.membersAfter} creadoras`).join('; ')
      const keeps = c.profiles.find(x => x.id === c.suggestion.keepId)!
      return `${c.kind} [${c.strength}] ${p(k)} + ${p(o)} | sugerencia: se queda @${keeps.username} (${keeps.platform}), ${c.suggestion.mode} (${c.suggestion.reason}) | ${shared || 'sin campaña compartida'} | ${c.evidence.map(e => `${e.code}: ${e.text}`).join(' / ')}`
    }
    log(`[merge rehearsal] b. October: ${october.length} candidates in ${octoberMs.toFixed(0)} ms`)
    for (const c of october) log(`[merge rehearsal] b.   ${line(c)}`)

    const keys = new Set(october.map(c => c.key))
    for (const m of MERGES) expect(keys.has(pairKey(m.keepId, m.otherId)), `${m.label} is listed`).toBe(true)
    expect(keys.has(FOURTH_PAIR), 'the fourth case is listed').toBe(true)
    // The three pairs inflate the count today: «cuenta doble», listed first
    for (const m of MERGES) {
      const c = october.find(x => x.key === pairKey(m.keepId, m.otherId))!
      expect(c.kind, m.label).toBe('same_campaign')
      expect(c.sharedCampaigns.find(s => s.id === OCTOBER), m.label).toMatchObject({ membersBefore: 36, membersAfter: 35 })
    }
    const firstOther = october.findIndex(c => c.kind !== 'same_campaign')
    if (firstOther >= 0) expect(october.slice(firstOther).every(c => c.kind !== 'same_campaign')).toBe(true)

    const byStrength: Record<string, number> = {}
    const byKind: Record<string, number> = {}
    for (const c of all) {
      byStrength[c.strength] = (byStrength[c.strength] ?? 0) + 1
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1
    }
    log(`[merge rehearsal] b. global: ${all.length} candidates in ${allMs.toFixed(0)} ms; by strength ${JSON.stringify(byStrength)}; by kind ${JSON.stringify(byKind)}`)
    for (const c of all.filter(x => !keys.has(x.key))) log(`[merge rehearsal] b.   (outside October) ${line(c)}`)
    expect(allMs, 'well under 2 s on production size').toBeLessThan(2000)
    // Read only: the finder wrote nothing
    expect(await prisma.personLog.count({ where: { action: { in: ['merge', 'dismiss_candidate'] }, undoneAt: null } })).toBe(0)
  })

  it('c. the three merges: October 33 / 29 / 38 with every sum as before and cost −300; June keeps its figures; every other campaign identical', async () => {
    expect(before.size, 'step a must run first').toBe(campaigns.length)
    rowsBefore = await snapshotRows()
    const countsBefore = await tableCounts()

    applied = []
    for (const m of MERGES) {
      const t0 = performance.now()
      const result = await merge(m)
      log(`[merge rehearsal] c. applied ${m.label} in ${(performance.now() - t0).toFixed(0)} ms: ${result.summary}${result.warnings.length ? ` | avisos: ${result.warnings.join(' | ')}` : ''}`)
      applied.push(result)
    }

    // October
    const was = before.get(OCTOBER)!
    const now = await overviewOf(OCTOBER)
    log(`[merge rehearsal] c. October before ${JSON.stringify(numbers(was))}`)
    log(`[merge rehearsal] c. October after  ${JSON.stringify(numbers(now))}`)
    expect({ members: now.totals.members, creatorsActive: now.totals.creatorsActive, media: now.totals.media }).toEqual(OCTOBER_AFTER)
    for (const k of ['views', 'likes', 'comments', 'shares', 'saves', 'engagements', 'media', 'posts', 'stories', 'mediaDeleted', 'audience', 'er', 'emvBasic', 'emvExtended', 'mediaCounts', 'reachReal', 'impressionsReal'] as const) {
      expect(now.totals[k], `October totals.${k}`).toEqual(was.totals[k])
    }
    expect(now.totals.cost).toBe(was.totals.cost - 300)
    expect(now.timeline).toEqual(was.timeline)
    // Every piece: the same ones with the same figures; only the TikTok piece of pair 1 changes the member it is credited to
    const otherIds = new Set(MERGES.map(m => m.otherId))
    const linkPair = MERGES[0]
    expect(now.perMedia.map(m => m.id).sort()).toEqual(was.perMedia.map(m => m.id).sort())
    const nowMedia = new Map(now.perMedia.map(m => [m.id, m]))
    let reCredited = 0
    for (const m of was.perMedia) {
      const after = nowMedia.get(m.id)!
      if (m.influencerId === linkPair.otherId) {
        reCredited++
        expect(after.influencerId, m.id).toBe(linkPair.keepId)
        expect(after.publishedBy?.influencerId, m.id).toBe(linkPair.otherId)
        expect(without(after, 'influencerId', 'publishedBy'), m.id).toEqual(without(m, 'influencerId', 'publishedBy'))
      } else {
        expect(otherIds.has(m.influencerId ?? ''), `${m.id} was credited to an absorbed profile`).toBe(false)
        expect(after, m.id).toEqual(m)
      }
    }
    expect(reCredited).toBe(1)
    // Creators: the three other rows are gone; the kept rows of the absorbed pairs are as they were; pair 1's row now holds her piece
    const nowRows = new Map(now.perInfluencer.map(p => [p.influencerId, p]))
    const wasRows = new Map(was.perInfluencer.map(p => [p.influencerId, p]))
    expect(Array.from(nowRows.keys()).sort()).toEqual(Array.from(wasRows.keys()).filter(id => !otherIds.has(id)).sort())
    for (const [id, row] of nowRows) {
      if (id === linkPair.keepId) continue
      expect(row, who(id)).toEqual(wasRows.get(id))
    }
    const kept = nowRows.get(linkPair.keepId)!
    const own = wasRows.get(linkPair.keepId)!
    const twin = wasRows.get(linkPair.otherId)!
    for (const k of ['media', 'posts', 'stories', 'views', 'engagements'] as const) expect(kept[k], `${who(linkPair.keepId)} ${k}`).toBe(own[k] + twin[k])
    expect({ cost: kept.cost, status: kept.status, followers: kept.followers, username: kept.username, platform: kept.platform }).toEqual({ cost: own.cost, status: own.status, followers: own.followers, username: own.username, platform: own.platform })
    log(`[merge rehearsal] c. ${who(linkPair.keepId)} row after: media ${kept.media}, views ${kept.views}, engagements ${kept.engagements}, byPlatform ${JSON.stringify(kept.byPlatform)}`)
    mergedOctober = now

    // June: same members and figures; the wrong profile's row is now the real profile's
    const pili = MERGES[2]
    const juneWas = before.get(JUNE)!
    const june = await overviewOf(JUNE)
    log(`[merge rehearsal] c. June before ${JSON.stringify(numbers(juneWas))}`)
    log(`[merge rehearsal] c. June after  ${JSON.stringify(numbers(june))}`)
    expect(june.totals).toEqual(juneWas.totals)
    expect(june.perMedia).toEqual(juneWas.perMedia)
    expect(without(june.delivery, 'summary')).toEqual(without(juneWas.delivery, 'summary'))
    const juneIds = june.perInfluencer.map(p => p.influencerId)
    expect(juneIds).toContain(pili.keepId)
    expect(juneIds).not.toContain(pili.otherId)
    expect(juneIds).toContain(MERGES[0].keepId) // pair 1 (link) is untouched in June
    const moved = june.perInfluencer.find(p => p.influencerId === pili.keepId)!
    const old = juneWas.perInfluencer.find(p => p.influencerId === pili.otherId)!
    expect(without(moved, 'influencerId', 'username', 'displayName', 'followers')).toEqual(without(old, 'influencerId', 'username', 'displayName', 'followers'))
    const juneMembership = await prisma.campaignInfluencer.findMany({ where: { campaignId: JUNE, influencerId: { in: [pili.keepId, pili.otherId] } }, select: { id: true, influencerId: true } })
    const juneRowBefore = rowsBefore.campaign_influencers.find(r => r.campaignId === JUNE && r.influencerId === pili.otherId)!
    expect(juneMembership).toEqual([{ id: juneRowBefore.id, influencerId: pili.keepId }])
    log(`[merge rehearsal] c. June: the membership row ${juneRowBefore.id} of ${who(pili.otherId)} is now ${who(pili.keepId)}'s`)

    // Every other campaign: identical to the snapshot and to the new code's figures before the merges
    const differing: string[] = []
    for (const c of campaigns) {
      const o = c.id === OCTOBER ? now : c.id === JUNE ? june : await overviewOf(c.id)
      if (c.id !== OCTOBER && c.id !== JUNE) expect(canonicalOverview(o), keyOf(c)).toEqual(canonicalOverview(before.get(c.id)))
      const paths = diffPaths(canonicalOverview(o, IGNORED), canonicalOverview(golden[keyOf(c)], IGNORED))
      if (paths.length > 0) {
        differing.push(c.id)
        const named = paths.map(p => p.replace(/\[([a-z0-9]{25})\]/g, (_, id: string) => `[${handle.has(id) ? who(id) : 'piece'}]`))
        const counted = new Map<string, number>()
        for (const p of named) counted.set(p, (counted.get(p) ?? 0) + 1)
        log(`[merge rehearsal] c. ${c.name} differs from the golden snapshot in ${paths.length} values: ${Array.from(counted).map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(', ')}`)
      }
    }
    expect(differing.sort()).toEqual([OCTOBER, JUNE].sort())
    log(`[merge rehearsal] c. ${campaigns.length - differing.length} of ${campaigns.length} campaigns identical to the golden snapshot after the merges`)

    // What the merges wrote, by table
    const rowsAfter = await snapshotRows()
    const changed = Object.fromEntries(SNAPSHOT_TABLES.map(t => [t, rowDifferences(rowsBefore[t], rowsAfter[t]).length]))
    const counts = await tableCounts()
    log(`[merge rehearsal] c. rows changed by the merges: ${JSON.stringify(changed)}; counts before ${JSON.stringify(countsBefore)} after ${JSON.stringify(counts)}`)
    expect(counts.campaign_influencers).toBe(countsBefore.campaign_influencers - 3)
    expect(counts.influencers).toBe(countsBefore.influencers)
    expect(counts.media).toBe(countsBefore.media)
    expect(counts.person_logs).toBe(countsBefore.person_logs + 3)
  })

  it('d. undoing the three merges gives back every row, column for column; then they are applied again', async () => {
    expect(applied, 'step c must run first').toHaveLength(3)
    for (const r of [...applied].reverse()) {
      const undone = await undoMerge(r.logId, actor)
      expect(undone.alreadyUndone).toBe(false)
      expect(undone.overwritten).toEqual([])
      expect(undone.notRestored).toEqual([])
      log(`[merge rehearsal] d. undid «${r.summary}»: ${JSON.stringify(undone.restored)}`)
    }
    const rowsUndone = await snapshotRows()
    const compared: Record<string, string> = {}
    for (const t of SNAPSHOT_TABLES) {
      const diff = rowDifferences(rowsBefore[t], rowsUndone[t])
      compared[t] = `${rowsUndone[t].length} rows, ${diff.length} different`
      expect(diff, t).toEqual([])
      expect(rowsUndone[t], t).toEqual(rowsBefore[t])
    }
    log(`[merge rehearsal] d. after the undo, row by row against before: ${JSON.stringify(compared)}`)
    for (const c of campaigns) {
      expect(canonicalOverview(await overviewOf(c.id), IGNORED), keyOf(c)).toEqual(canonicalOverview(golden[keyOf(c)], IGNORED))
    }
    log(`[merge rehearsal] d. after the undo, ${campaigns.length} of ${campaigns.length} campaigns identical to the golden snapshot`)
    // Undo is idempotent
    expect((await undoMerge(applied[0].logId, actor)).alreadyUndone).toBe(true)

    // The copy ends merged
    applied = []
    for (const m of MERGES) applied.push(await merge(m))
    const october = await overviewOf(OCTOBER)
    expect({ members: october.totals.members, creatorsActive: october.totals.creatorsActive, media: october.totals.media }).toEqual(OCTOBER_AFTER)
    expect(canonicalOverview(october)).toEqual(canonicalOverview(mergedOctober))
    log(`[merge rehearsal] d. applied again; October ${JSON.stringify(numbers(october))}`)
  })

  it('e. a late piece of a member who has not delivered: 201 lateDays 5, October 39 / 30, kept by the revalidation, a second one refused; then removed', async () => {
    expect(applied, 'step d must run first').toHaveLength(3)
    const merged = await overviewOf(OCTOBER)
    const mergedRows = await prisma.$queryRawUnsafe<Array<{ row: unknown }>>(`SELECT row_to_json(t.*) AS row FROM media t WHERE t."campaignId" = $1 ORDER BY t.id`, OCTOBER)
    const countsBefore = await tableCounts()
    const member = await prisma.influencer.findUniqueOrThrow({ where: { id: LATE_MEMBER }, select: { username: true, platform: true } })
    const membership = await prisma.campaignInfluencer.findFirstOrThrow({ where: { campaignId: OCTOBER, influencerId: LATE_MEMBER }, select: { status: true, deliverablesPlanned: true } })
    expect(await prisma.media.count({ where: { campaignId: OCTOBER, influencerId: LATE_MEMBER } }), 'she has delivered nothing in October').toBe(0)
    log(`[merge rehearsal] e. ${who(LATE_MEMBER)}: ${membership.status}, deliverablesPlanned ${membership.deliverablesPlanned}, 0 pieces in October`)

    serve(LATE_URL, member.username, LATE_POSTED_AT)
    const res = await add({ url: LATE_URL })
    log(`[merge rehearsal] e. late add: ${res.status} lateDays ${res.body.lateDays} created ${res.body.created}`)
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.lateDays).toBe(5)
    expect(res.body.created).toBe(true)
    expect(res.body.linkedProfile).toBeNull()
    const mediaId = (res.body.media as { id: string }).id
    const row = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } })
    expect({ campaignId: row.campaignId, influencerId: row.influencerId, publishedByInfluencerId: row.publishedByInfluencerId, source: row.source, postedAt: row.postedAt?.toISOString(), views: row.views })
      .toEqual({ campaignId: OCTOBER, influencerId: LATE_MEMBER, publishedByInfluencerId: null, source: 'manual', postedAt: LATE_POSTED_AT, views: LATE_FIGURES.views })

    const withLate = await overviewOf(OCTOBER)
    log(`[merge rehearsal] e. October with the late piece: ${JSON.stringify(numbers(withLate))}`)
    log(`[merge rehearsal] e. delivery.summary: ${JSON.stringify(withLate.delivery.summary)} (before the late piece: ${JSON.stringify(merged.delivery.summary)})`)
    expect(withLate.totals.media).toBe(39)
    expect(withLate.totals.creatorsActive).toBe(30)
    expect(withLate.totals.members).toBe(33)
    expect(withLate.totals.views).toBe(merged.totals.views + LATE_FIGURES.views)
    expect(withLate.perMedia.find(m => m.id === mediaId)?.lateDays).toBe(5)
    expect(withLate.perInfluencer.find(p => p.influencerId === LATE_MEMBER)).toMatchObject({ media: 1, latePieces: 1, maxLateDays: 5 })
    expect(withLate.delivery.summary.late).toBe(merged.delivery.summary.late + 1)
    expect(withLate.delivery.summary.notPublished).toBe(merged.delivery.summary.notPublished - 1)
    const s = withLate.delivery.summary
    expect(s.delivered + s.late + s.notPublished + s.inProgress).toBe(s.expected)

    // The revalidation keeps it, and (checked first, on the pure verdict) detaches no real row of the copy
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: OCTOBER },
      select: { type: true, targetAccounts: true, targetHashtags: true, targetKeywords: true, startDate: true, endDate: true, influencers: { select: { influencerId: true } } },
    })
    const memberIds = new Set(campaign.influencers.map(ci => ci.influencerId))
    const rows = await prisma.media.findMany({
      where: { campaignId: OCTOBER },
      select: { id: true, influencerId: true, externalId: true, mediaType: true, caption: true, hashtags: true, mentions: true, postedAt: true, source: true },
    })
    const verdicts: Record<string, number> = {}
    for (const r of rows) {
      const v = revalidationVerdict(campaign, memberIds, r)
      verdicts[v] = (verdicts[v] ?? 0) + 1
      if (r.id === mediaId) expect(v).toBe('keep_late_manual')
    }
    log(`[merge rehearsal] e. revalidation verdicts of October: ${JSON.stringify(verdicts)}`)
    expect(Object.keys(verdicts).every(v => v.startsWith('keep')), 'the revalidation would detach a real row of the copy: not run').toBe(true)
    const revalidated = await revalidateCampaignMedia(OCTOBER)
    log(`[merge rehearsal] e. revalidateCampaignMedia(October): kept ${revalidated.kept}, detached ${revalidated.detached}`)
    expect(revalidated).toEqual({ kept: 39, detached: 0 })
    expect((await prisma.media.findUniqueOrThrow({ where: { id: mediaId }, select: { campaignId: true } })).campaignId).toBe(OCTOBER)

    // A second late piece of hers: she owes nothing any more
    serve(SECOND_LATE_URL, member.username, SECOND_LATE_POSTED_AT)
    const countsWithLate = await tableCounts()
    const second = await add({ url: SECOND_LATE_URL })
    log(`[merge rehearsal] e. second late add: ${second.status} ${second.body.code}: ${second.body.error}`)
    expect(second.status).toBe(400)
    expect(second.body.code).toBe('nothing_pending')
    expect(await tableCounts()).toEqual(countsWithLate)

    // Remove the simulated row: the copy holds only real data, exactly as merged
    const simulated = await simulatedLateRows()
    expect(simulated).toEqual([{ id: mediaId, campaignId: OCTOBER }])
    await prisma.media.delete({ where: { id: mediaId } })
    expect(await simulatedLateRows()).toEqual([])
    expect(await tableCounts()).toEqual(countsBefore)
    const rowsAfter = await prisma.$queryRawUnsafe<Array<{ row: unknown }>>(`SELECT row_to_json(t.*) AS row FROM media t WHERE t."campaignId" = $1 ORDER BY t.id`, OCTOBER)
    expect(rowsAfter).toEqual(mergedRows)
    expect(canonicalOverview(await overviewOf(OCTOBER))).toEqual(canonicalOverview(merged))
    log(`[merge rehearsal] e. simulated row removed; October back to ${JSON.stringify(numbers(await overviewOf(OCTOBER)))}`)
  })
})
