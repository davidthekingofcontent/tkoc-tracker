/**
 * Finding the records that may be one creator (findMergeCandidates,
 * countSameCampaignCandidates, dismissCandidate) on a real, throwaway
 * database. These tests prove:
 *   - every kind of evidence is found: a pair counted twice in one campaign
 *     (same handle on two networks, a link to a wrong handle, near handles),
 *     a link to the other profile, case/dot/underscore variants, the same
 *     handle on two networks, near handles with a second coincidence;
 *   - never on an e-mail, a phone or a name alone, never two profiles that are
 *     already one person unless both are members of one campaign (then she is
 *     counted twice: «cuenta doble»), never a dismissed pair (until the
 *     dismissal is undone), never a profile absorbed by a merge in force while
 *     it is nobody's member;
 *   - the suggestion: which record stays and whether the other is another
 *     account of hers (link) or a wrong handle (absorb);
 *   - the campaign filter, the banner count, and the speed at production size.
 * The finder changes nothing. Every handle, name and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No test may reach a scraper
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

import { Prisma } from '@/generated/prisma/client'
import type { Platform } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { linkProfile } from '@/lib/person-profiles'
import {
  applyMerge,
  countSameCampaignCandidates,
  dismissCandidate,
  findMergeCandidates,
  listMergeHistory,
  previewMerge,
  undoMerge,
  type MergeCandidate,
} from '@/lib/person-merge'

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

type Row = Record<string, unknown>
async function rowsOf(table: string): Promise<Row[]> {
  const rows = await prisma.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(t.*) AS row FROM ${Prisma.raw(`"${table}"`)} t ORDER BY t.id`
  return rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Row)
}
async function snapshot() {
  const out: Record<string, Row[]> = {}
  for (const t of ['campaign_influencers', 'media', 'campaign_notes', 'influencers', 'persons', 'person_logs', 'settings']) out[t] = await rowsOf(t)
  return out
}

let seq = 0
async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const admin = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const campaign = (name: string, start: string) => prisma.campaign.create({
    data: { name, startDate: new Date(start), endDate: new Date(new Date(start).getTime() + 30 * 86_400_000), platforms: ['INSTAGRAM', 'TIKTOK'], targetHashtags: ['marcademo'], userId: admin.id },
  })
  const oct = await campaign('Micros Octubre (prueba)', '2026-10-01T00:00:00Z')
  const jun = await campaign('Micros Junio (prueba)', '2026-06-01T00:00:00Z')

  const inf = (username: string, platform: Platform, followers: number, extra: Partial<{ website: string; bio: string; displayName: string; email: string; phone: string; lastScraped: Date }> = {}) =>
    prisma.influencer.create({ data: { username, platform, followers, ...extra }, select: { id: true, username: true, platform: true } })
  const member = (campaignId: string, influencerId: string, agreedFee: number | null = 100) =>
    prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED', agreedFee, cost: agreedFee ?? 0 } })
  const piece = (campaignId: string | null, influencerId: string, platform: Platform, publishedByInfluencerId: string | null = null) => {
    seq++
    return prisma.media.create({
      data: {
        externalId: `cand-${seq}`, platform, mediaType: platform === 'TIKTOK' ? 'VIDEO' : 'REEL', campaignId, influencerId, publishedByInfluencerId,
        permalink: `https://example.test/p/cand-${seq}`, postedAt: new Date('2026-10-12T10:00:00Z'), views: 100, likes: 10, comments: 1, source: 'manual',
      },
    })
  }

  // 1. One person as two members of October: Instagram and TikTok with the same handle
  const danaIg = await inf('dana_ejemplo', 'INSTAGRAM', 652)
  const danaTt = await inf('dana_ejemplo', 'TIKTOK', 18700)
  await member(oct.id, danaIg.id)
  await member(jun.id, danaIg.id)
  await member(oct.id, danaTt.id)
  await piece(oct.id, danaTt.id, 'TIKTOK')

  // 2. Her TikTok handle saved as an Instagram profile, next to her real Instagram, both members of October
  const vaneReal = await inf('vane_inventada', 'INSTAGRAM', 2300, { website: 'https://www.tiktok.com/@vane_mal' })
  // Read by the scraper: 0 followers is a fact, not an unknown
  const vaneWrong = await inf('vane_mal', 'INSTAGRAM', 0, { lastScraped: new Date('2026-10-20T08:00:00Z') })
  await member(oct.id, vaneReal.id)
  await member(oct.id, vaneWrong.id)
  await piece(oct.id, vaneReal.id, 'INSTAGRAM')

  // 3. Near handles in one campaign: a 2-follower row and the real one
  const liliOld = await inf('lili_bosque', 'INSTAGRAM', 2)
  const liliNew = await inf('lili_bosque_', 'INSTAGRAM', 650)
  await member(oct.id, liliOld.id)
  await member(oct.id, liliNew.id)
  await piece(oct.id, liliNew.id, 'INSTAGRAM')

  // 4. A bio that links another profile, no campaign in common
  const gema = await inf('gema_ficticia', 'INSTAGRAM', 3000, { bio: 'Mi otra cuenta: instagram.com/gema_cocina_demo' })
  const gemaCocina = await inf('gema_cocina_demo', 'INSTAGRAM', 400)
  await member(jun.id, gema.id)

  // 5. Same handle on Instagram and TikTok, only one of them in a campaign
  const alba = await inf('alba_prueba', 'INSTAGRAM', 2100)
  const albaTt = await inf('alba_prueba', 'TIKTOK', 31000)
  await member(jun.id, alba.id)

  // 6. Case, dots and underscores on one network
  const beaDot = await inf('Bea.Ejemplo', 'INSTAGRAM', 800)
  const beaUnderscore = await inf('bea_ejemplo', 'INSTAGRAM', 50)
  await member(jun.id, beaDot.id)

  // 7. Near handles plus the same display name, different campaigns
  const nuria15 = await inf('nuria_demo15', 'INSTAGRAM', 3400, { displayName: 'Nuria Ejemplo' })
  const nuria16 = await inf('nuria_demo16', 'INSTAGRAM', 120, { displayName: 'Nuria  Ejemplo ✨' })
  await member(oct.id, nuria15.id)
  await member(jun.id, nuria16.id)
  // Near handles WITHOUT a second coincidence, different campaigns: not proposed
  const sara1 = await inf('sara_inventada1', 'INSTAGRAM', 900, { displayName: 'Sara Uno' })
  const sara2 = await inf('sara_inventada2', 'INSTAGRAM', 950, { displayName: 'Sara Dos' })
  await member(oct.id, sara1.id)
  await member(jun.id, sara2.id)

  // 8. Same e-mail, phone and display name, unrelated handles: never proposed
  const carla = await inf('carla_uno_demo', 'INSTAGRAM', 700, { displayName: 'Carla Pepa', email: 'misma@example.test', phone: '600000001' })
  const pepa = await inf('pepa_dos_demo', 'INSTAGRAM', 700, { displayName: 'Carla Pepa', email: 'misma@example.test', phone: '600000001' })
  await member(oct.id, carla.id)
  await member(oct.id, pepa.id)

  // 9. A pair that will be dismissed
  const rosa = await inf('rocio_prueba', 'INSTAGRAM', 1200)
  const rosaTt = await inf('rocio_prueba', 'TIKTOK', 1500)
  await member(jun.id, rosa.id)

  // 10. Already one person, both members of October: counted twice there, so proposed («cuenta doble»)
  const maria = await inf('maria_demo', 'INSTAGRAM', 900)
  const mariaTt = await inf('maria_demo', 'TIKTOK', 4000)
  await member(oct.id, maria.id)
  await member(oct.id, mariaTt.id)
  await linkProfile({ memberInfluencerId: maria.id, profileInfluencerId: mariaTt.id, actor: null, evidence: 'pm_manual' })

  // 11. Two shells nobody uses (no campaign, no piece): never proposed
  await inf('shell_demo', 'INSTAGRAM', 0)
  await inf('shell_demo', 'TIKTOK', 0)

  return { admin, oct, jun, danaIg, danaTt, vaneReal, vaneWrong, liliOld, liliNew, gema, gemaCocina, alba, albaTt, beaDot, beaUnderscore, nuria15, nuria16, sara1, sara2, carla, pepa, rosa, rosaTt, maria, mariaTt }
}

const keyOf = (a: { id: string }, b: { id: string }) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`)
const find = (list: MergeCandidate[], a: { id: string }, b: { id: string }) => list.find(c => c.key === keyOf(a, b))

describe('findMergeCandidates', () => {
  it('finds every kind of evidence, never on e-mail or name alone; one person only when she is counted twice; strongest first; changes nothing', async () => {
    const fx = await seed()
    const before = await snapshot()
    const list = await findMergeCandidates()
    expect(await snapshot()).toEqual(before)

    // «Cuenta doble»: the three pairs of October, first
    const dana = find(list, fx.danaIg, fx.danaTt)!
    const vane = find(list, fx.vaneReal, fx.vaneWrong)!
    const lili = find(list, fx.liliOld, fx.liliNew)!
    for (const c of [dana, vane, lili]) {
      expect(c, 'a pair counted twice in October').toBeTruthy()
      expect(c.kind).toBe('same_campaign')
      expect(c.strength).toBe('double_count')
      expect(c.sharedCampaigns).toEqual([{ id: fx.oct.id, name: 'Micros Octubre (prueba)', membersBefore: 12, membersAfter: 11 }])
      expect(c.evidence[0]).toEqual({ code: 'same_campaign', text: expect.stringContaining('«Micros Octubre (prueba)»') })
    }
    expect(dana.evidence.map(e => e.code)).toEqual(['same_campaign', 'same_handle_cross_network'])
    expect(dana.evidence[1].text).toBe('@dana_ejemplo (Instagram) y @dana_ejemplo (TikTok) tienen el mismo usuario en dos redes.')
    // tiktok.com/@vane_mal links a TikTok account, and @vane_mal is stored as Instagram: the same handle on another network, not a link to this profile
    expect(vane.evidence.map(e => e.code)).toEqual(['same_campaign', 'same_handle_cross_network'])
    expect(vane.evidence[1].text).toBe('@vane_inventada (Instagram) enlaza tiktok.com/@vane_mal en su web o bio, y @vane_mal está registrado como perfil de Instagram, no de TikTok.')
    expect(lili.evidence.map(e => e.code)).toEqual(['same_campaign', 'case_only'])
    expect(list.slice(0, 4).map(c => c.kind)).toEqual(['same_campaign', 'same_campaign', 'same_campaign', 'same_campaign'])
    // Already one person, both members of October: she counts twice there
    const maria = find(list, fx.maria, fx.mariaTt)!
    expect(maria).toMatchObject({ kind: 'same_campaign', strength: 'double_count', sharedCampaigns: [{ id: fx.oct.id, name: 'Micros Octubre (prueba)', membersBefore: 12, membersAfter: 11 }] })
    expect(maria.evidence[0].text).toBe('@maria_demo (Instagram) y @maria_demo (TikTok) ya son perfiles de la misma persona y las dos son miembros de «Micros Octubre (prueba)»: la campaña cuenta a la misma creadora dos veces.')

    // The other kinds, outside a shared campaign
    expect(find(list, fx.gema, fx.gemaCocina)).toMatchObject({ kind: 'links_to_other', strength: 'strong', sharedCampaigns: [] })
    expect(find(list, fx.beaDot, fx.beaUnderscore)).toMatchObject({ kind: 'case_only', strength: 'strong' })
    expect(find(list, fx.alba, fx.albaTt)).toMatchObject({ kind: 'same_handle_cross_network', strength: 'review' })
    const nuria = find(list, fx.nuria15, fx.nuria16)!
    expect(nuria).toMatchObject({ kind: 'near_handle', strength: 'review' })
    expect(nuria.evidence).toEqual([{ code: 'near_handle', text: '@nuria_demo15 (Instagram) y @nuria_demo16 (Instagram) tienen usuarios casi iguales y el mismo nombre («Nuria Ejemplo»).' }])

    // Never proposed
    expect(find(list, fx.sara1, fx.sara2), 'near handles without a second coincidence').toBeUndefined()
    expect(find(list, fx.carla, fx.pepa), 'same e-mail, phone and name').toBeUndefined()
    expect(list.some(c => c.profiles.some(p => p.username === 'shell_demo')), 'nobody uses them').toBe(false)

    // Strongest first: «cuenta doble», then strong, then «revisar»
    const ranks = list.map(c => ({ double_count: 0, strong: 1, review: 2 })[c.strength])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(list).toHaveLength(9)
  })

  it('suggests which record stays: the wrong handle is absorbed, two real accounts are linked', async () => {
    const fx = await seed()
    const list = await findMergeCandidates()

    const vane = find(list, fx.vaneReal, fx.vaneWrong)!
    expect(vane.suggestion).toMatchObject({ keepId: fx.vaneReal.id, otherId: fx.vaneWrong.id, mode: 'absorb' })
    expect(vane.suggestion.reason).toContain('@vane_mal (Instagram) tiene 0 seguidores y ninguna publicación propia')
    expect(vane.suggestion.reason).toContain('@vane_inventada (Instagram) enlaza tiktok.com/@vane_mal: es su cuenta de TikTok, guardada como Instagram')
    expect(vane.profiles.map(p => p.id)).toEqual([fx.vaneReal.id, fx.vaneWrong.id])

    // Two real accounts on two networks: linked; the one in more campaigns stays
    const dana = find(list, fx.danaIg, fx.danaTt)!
    expect(dana.suggestion).toMatchObject({ keepId: fx.danaIg.id, otherId: fx.danaTt.id, mode: 'link' })
    const [keep, other] = dana.profiles
    expect(keep).toMatchObject({ id: fx.danaIg.id, username: 'dana_ejemplo', platform: 'INSTAGRAM', followers: 652, pieces: 0, ownPieces: 0, otherProfiles: [] })
    expect(keep.campaigns.map(c => [c.name, c.membershipStatus, c.pieces, c.hasFee])).toEqual([
      ['Micros Octubre (prueba)', 'COMPLETED', 0, true],
      ['Micros Junio (prueba)', 'COMPLETED', 0, true],
    ])
    expect(other).toMatchObject({ id: fx.danaTt.id, pieces: 1, ownPieces: 1 })

    // 2 followers and nothing of her own: absorbed into the real one
    expect(find(list, fx.liliOld, fx.liliNew)!.suggestion).toMatchObject({ keepId: fx.liliNew.id, otherId: fx.liliOld.id, mode: 'absorb' })
  })

  it('the campaign filter keeps the pairs where one of the two persons is a member; the banner counts the «cuenta doble» ones', async () => {
    const fx = await seed()
    const jun = await findMergeCandidates({ campaignId: fx.jun.id })
    expect(jun.map(c => c.key).sort()).toEqual([
      keyOf(fx.danaIg, fx.danaTt), keyOf(fx.gema, fx.gemaCocina), keyOf(fx.alba, fx.albaTt),
      keyOf(fx.beaDot, fx.beaUnderscore), keyOf(fx.nuria15, fx.nuria16), keyOf(fx.rosa, fx.rosaTt),
    ].sort())
    expect(await countSameCampaignCandidates(fx.oct.id)).toBe(4)
    expect(await countSameCampaignCandidates(fx.jun.id)).toBe(0)
    expect(await countSameCampaignCandidates('no-such-campaign')).toBe(0)
  })

  it('a dismissed pair is not proposed until the dismissal is undone; dismissing twice is one dismissal', async () => {
    const fx = await seed()
    const actor = { id: fx.admin.id, name: fx.admin.name }
    expect(find(await findMergeCandidates(), fx.rosa, fx.rosaTt)).toBeTruthy()
    const first = await dismissCandidate(fx.rosaTt.id, fx.rosa.id, actor)
    expect(first.alreadyDismissed).toBe(false)
    expect(await dismissCandidate(fx.rosa.id, fx.rosaTt.id, actor)).toEqual({ logId: first.logId, alreadyDismissed: true })
    expect(find(await findMergeCandidates(), fx.rosa, fx.rosaTt)).toBeUndefined()

    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: first.logId } })
    expect(log).toMatchObject({ action: 'dismiss_candidate', actorId: fx.admin.id, actorName: 'Ada Admin' })
    expect(log.summary).toBe('@rocio_prueba (Instagram) y @rocio_prueba (TikTok) no son la misma persona: no se vuelven a proponer para fusionar.')
    expect((log.after as { pair: string[] }).pair).toEqual([fx.rosa.id, fx.rosaTt.id].sort())
    expect((await listMergeHistory())[0]).toMatchObject({ logId: first.logId, action: 'dismiss_candidate', undoable: true, actorName: 'Ada Admin' })

    const undone = await undoMerge(first.logId, actor)
    expect(undone).toMatchObject({ kind: 'dismiss_candidate', alreadyUndone: false })
    expect(find(await findMergeCandidates(), fx.rosa, fx.rosaTt)).toBeTruthy()
    expect(await undoMerge(first.logId, actor)).toMatchObject({ alreadyUndone: true, undoLogId: undone.undoLogId })
    expect((await listMergeHistory())[0]).toMatchObject({ logId: first.logId, undoable: false, undoneByName: 'Ada Admin' })

    await expect(dismissCandidate(fx.rosa.id, fx.rosa.id, actor)).rejects.toMatchObject({ code: 'invalid' })
    await expect(dismissCandidate(fx.rosa.id, 'no-such-profile', actor)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a profile absorbed by a merge in force is not proposed again; after the undo it is', async () => {
    const fx = await seed()
    const actor = { id: fx.admin.id, name: fx.admin.name }
    // A TikTok row with the wrong handle's name: proposed with the wrong Instagram row today
    const vaneMalTt = await prisma.influencer.create({ data: { username: 'vane_mal', platform: 'TIKTOK', followers: 7600 } })
    await prisma.media.create({ data: { externalId: 'tt-vane', platform: 'TIKTOK', mediaType: 'VIDEO', campaignId: fx.oct.id, influencerId: fx.vaneReal.id, publishedByInfluencerId: vaneMalTt.id, postedAt: new Date('2026-10-20T10:00:00Z'), source: 'manual' } })
    expect(find(await findMergeCandidates(), fx.vaneWrong, vaneMalTt)).toBeTruthy()

    const preview = await previewMerge({ keepId: fx.vaneReal.id, otherId: fx.vaneWrong.id, mode: 'absorb' })
    const merged = await applyMerge({ keepId: fx.vaneReal.id, otherId: fx.vaneWrong.id, mode: 'absorb', fingerprint: preview.fingerprint }, actor)
    const after = await findMergeCandidates()
    expect(after.some(c => c.profiles.some(p => p.id === fx.vaneWrong.id))).toBe(false)
    expect(find(after, fx.vaneReal, fx.vaneWrong)).toBeUndefined()

    await undoMerge(merged.logId, actor)
    expect(find(await findMergeCandidates(), fx.vaneWrong, vaneMalTt)).toBeTruthy()
    expect(find(await findMergeCandidates(), fx.vaneReal, fx.vaneWrong)).toBeTruthy()
  })

  it('runs well under 2 s at production size (3,510 profiles, 456 memberships)', async () => {
    const admin = await prisma.user.create({ data: { email: `perf-${Date.now()}@example.test`, password: 'x', name: 'Perf', role: 'ADMIN' } })
    const campaigns = await Promise.all(Array.from({ length: 12 }, (_, i) => prisma.campaign.create({
      data: { name: `Campaña ${i}`, startDate: new Date(Date.UTC(2026, i % 12, 1)), userId: admin.id },
      select: { id: true },
    })))
    const words = ['casa', 'moda', 'cocina', 'viaje', 'belleza', 'hogar', 'fit', 'mama', 'deco', 'tips']
    const rows: Prisma.InfluencerCreateManyInput[] = []
    for (let i = 0; i < 3510; i++) {
      const handle = `${words[i % words.length]}_${words[(i * 7) % words.length]}${i}`
      // ~85% hashtag shells (0 followers, no bio); the rest real-looking, some with links and names
      const real = i % 7 === 0
      rows.push({
        id: `perf${String(i).padStart(6, '0')}`,
        username: handle,
        platform: i % 5 === 0 ? 'TIKTOK' : 'INSTAGRAM',
        followers: real ? 1000 + i : 0,
        displayName: real ? `Creadora ${words[i % words.length]} ${i % 300}` : null,
        website: real && i % 3 === 0 ? `https://www.tiktok.com/@${words[(i + 1) % words.length]}_${words[((i + 1) * 7) % words.length]}${i + 1}` : null,
        bio: real ? 'Contenido de hogar y recetas. Colaboraciones por DM.' : null,
      })
    }
    await prisma.influencer.createMany({ data: rows })
    const memberships: Prisma.CampaignInfluencerCreateManyInput[] = []
    for (let i = 0; i < 456; i++) memberships.push({ campaignId: campaigns[i % 12].id, influencerId: rows[(i * 7) % rows.length].id!, status: 'COMPLETED', agreedFee: 100 })
    await prisma.campaignInfluencer.createMany({ data: memberships, skipDuplicates: true })
    const media: Prisma.MediaCreateManyInput[] = []
    for (let i = 0; i < 2000; i++) {
      const m = memberships[i % memberships.length]
      media.push({ externalId: `perf-${i}`, platform: 'INSTAGRAM', mediaType: 'REEL', campaignId: m.campaignId, influencerId: m.influencerId, postedAt: new Date('2026-10-10T00:00:00Z'), views: i })
    }
    await prisma.media.createMany({ data: media })

    await findMergeCandidates() // warm-up (connection, query plans)
    const t0 = performance.now()
    const list = await findMergeCandidates()
    const ms = performance.now() - t0
    expect(Array.isArray(list)).toBe(true)
    expect(ms, `findMergeCandidates took ${Math.round(ms)} ms`).toBeLessThan(2000)
    const t1 = performance.now()
    await countSameCampaignCandidates(campaigns[0].id)
    expect(performance.now() - t1).toBeLessThan(1000)
  }, 120_000)
})
