/**
 * The merge tool after the adversarial review (13 Nov 2026). Each test fails
 * on the code before the fix:
 *   - undo: a piece captured after the merge and credited across the union of
 *     persons (her third profile, filed under the kept profile) is credited
 *     again as the roster says once everything is back;
 *   - a person with three profiles: the preview names the campaign the merge
 *     leaves with two rows of one person, the card does not promise a fold
 *     there, and the finder then proposes that pair as «cuenta doble»;
 *   - the suggestion never absorbs a real account: a link to the same handle
 *     on a third network, unread followers, a connected account;
 *   - the duplicate a merge detached is not attached again by the next capture;
 *   - an absorbed profile added again to a campaign is proposed again.
 * Real (throwaway) database, invented handles, network mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
  }
})

import type { MediaType, Platform } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { linkProfile } from '@/lib/person-profiles'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import { upsertCampaignPost } from '@/lib/campaign-capture'
import {
  MergeError,
  applyMerge,
  countSameCampaignCandidates,
  findMergeCandidates,
  previewMerge,
  undoMerge,
  type MergeMode,
} from '@/lib/person-merge'

async function reset() {
  await prisma.socialToken.deleteMany()
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

let seq = 0
async function base() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const admin = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const campaign = async (name: string) => (await prisma.campaign.create({
    data: { name, status: 'ACTIVE', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z'), platforms: ['INSTAGRAM', 'TIKTOK'], targetHashtags: ['marcademo'], userId: admin.id },
    select: { id: true },
  })).id
  const inf = async (username: string, platform: Platform, followers: number, extra: { website?: string; lastScraped?: Date } = {}) =>
    (await prisma.influencer.create({ data: { username, platform, followers, ...extra }, select: { id: true } })).id
  const member = async (campaignId: string, influencerId: string, fee = 100) =>
    (await prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED', agreedFee: fee, cost: fee }, select: { id: true } })).id
  const piece = async (campaignId: string | null, influencerId: string, platform: Platform, mediaType: MediaType, extra: { externalId?: string; permalink?: string; publishedByInfluencerId?: string; insightsSource?: string; views?: number } = {}) => {
    seq++
    return (await prisma.media.create({
      data: {
        externalId: extra.externalId ?? `fix-${seq}`,
        platform, mediaType, campaignId, influencerId,
        publishedByInfluencerId: extra.publishedByInfluencerId ?? null,
        permalink: extra.permalink ?? `https://example.test/p/fix-${seq}`,
        caption: 'Probando #marcademo', views: extra.views ?? 1000, likes: 50, comments: 3,
        postedAt: new Date('2026-10-10T10:00:00Z'), insightsSource: extra.insightsSource ?? null, source: 'manual',
      },
      select: { id: true },
    })).id
  }
  return { admin: { id: admin.id, name: 'Ada Admin' }, campaign, inf, member, piece }
}

async function merge(actor: { id: string; name: string }, keepId: string, otherId: string, mode: MergeMode) {
  const preview = await previewMerge({ keepId, otherId, mode })
  return { preview, result: await applyMerge({ keepId, otherId, mode, fingerprint: preview.fingerprint }, actor) }
}
const pair = (a: string, b: string) => [a, b].sort().join('|')

// ---------------------------------------------------------------------------

describe('undo and a piece credited across the union of persons', () => {
  it('her third profile\'s video, filed under the kept profile after the merge, goes to the record the roster says once undone', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    const K = await b.inf('cara_ejemplo', 'INSTAGRAM', 3000)
    const O = await b.inf('cara_otra', 'INSTAGRAM', 800)
    const O2 = await b.inf('cara_otra', 'TIKTOK', 9000)
    await linkProfile({ memberInfluencerId: O, profileInfluencerId: O2, actor: null, evidence: 'pm_manual' })
    await b.member(C, K); await b.member(C, O)
    const { result } = await merge(b.admin, K, O, 'link')

    // The daily TikTok pass after the merge: the roster credits O2 to K now
    const during = (await loadCampaignRoster(C)).creditForInfluencer(O2)!
    expect(during.member.influencerId).toBe(K)
    expect(await upsertCampaignPost(C, during.member.influencerId, 'TIKTOK', {
      externalId: '7400000000000000001', caption: 'Probando #marcademo', mediaUrl: null, thumbnailUrl: null,
      permalink: 'https://www.tiktok.com/@cara_otra/video/7400000000000000001', mediaType: 'VIDEO', likes: 10, comments: 1, shares: 0, saves: 0, views: 500,
      postedAt: '2026-10-12T10:00:00.000Z', hashtags: ['marcademo'], mentions: [],
    }, { publishedByInfluencerId: O2 })).toBe(true)
    const video = await prisma.media.findFirstOrThrow({ where: { externalId: '7400000000000000001' }, select: { id: true } })

    // The undo lists it (nothing is overwritten unseen) and asks to confirm
    const err = await undoMerge(result.logId, b.admin).then(() => null, e => e as MergeError)
    expect(err).toBeInstanceOf(MergeError)
    expect(err!.code).toBe('changed_since')
    const details = err!.details as { differences: Array<{ kind: string; id: string; text: string }>; differencesHash: string }
    expect(details.differences).toEqual([expect.objectContaining({
      kind: 'piece', id: video.id,
      text: 'Desde la fusión ha entrado en «Campaña C (prueba)» una publicación de @cara_otra (TikTok) que cuenta para @cara_ejemplo (Instagram) por la fusión: al deshacerla pasa a la ficha que le corresponda en la campaña.',
    })])

    const undone = await undoMerge(result.logId, b.admin, { force: true, differencesHash: details.differencesHash })
    expect(undone.notRestored).toEqual([])
    // Back with the member of her person: @cara_otra, published from her TikTok
    expect(await prisma.media.findUniqueOrThrow({ where: { id: video.id }, select: { influencerId: true, publishedByInfluencerId: true, campaignId: true } }))
      .toEqual({ influencerId: O, publishedByInfluencerId: O2, campaignId: C })
    expect((await loadCampaignRoster(C)).creditForInfluencer(O2)!.member.influencerId).toBe(O)
    const o = await computeCampaignOverview(C, { rates: DEFAULT_EMV_RATES })
    expect(o!.perInfluencer.find(p => p.influencerId === O)!.media).toBe(1)
    expect(o!.perInfluencer.find(p => p.influencerId === K)!.media).toBe(0)
  })
})

describe('a person with three profiles', () => {
  it('the merge says which campaign it leaves with two rows of one person; the card does not promise a fold there; the finder then proposes that pair', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    const D = await b.campaign('Campaña D (prueba)')
    const K = await b.inf('anaejemplo', 'INSTAGRAM', 2000)
    const O = await b.inf('anaejemplo.tt', 'INSTAGRAM', 0, { lastScraped: new Date('2026-10-01T00:00:00Z') }) // her TikTok handle saved as Instagram
    const T = await b.inf('anaejemplo', 'TIKTOK', 5000)
    await linkProfile({ memberInfluencerId: T, profileInfluencerId: O, actor: null, evidence: 'pm_manual' })
    await b.member(C, K); await b.member(C, O)
    await b.member(D, K); await b.member(D, T)
    await b.piece(D, K, 'INSTAGRAM', 'REEL'); await b.piece(D, T, 'TIKTOK', 'VIDEO')

    // The card of K/O folds C only: D keeps its two rows (the other profile is not a member there)
    const card = (await findMergeCandidates({ campaignId: C })).find(c => c.key === pair(K, O))!
    expect(card.suggestion).toMatchObject({ keepId: K, otherId: O, mode: 'absorb' })
    expect(card.sharedCampaigns.map(s => [s.name, s.membersBefore, s.membersAfter])).toEqual(expect.arrayContaining([
      ['Campaña C (prueba)', 2, 1],
      ['Campaña D (prueba)', 2, 2],
    ]))
    // Today D counts her twice through K and T: both pairs (K/T, and K/O through O's person) say so
    expect(await countSameCampaignCandidates(D)).toBe(2)

    // The preview names D
    const { preview } = await merge(b.admin, K, O, 'absorb')
    expect(preview.campaigns.map(c => c.campaignName)).toEqual(['Campaña C (prueba)'])
    expect(preview.warnings).toContain('En «Campaña D (prueba)» @anaejemplo (TikTok) y @anaejemplo (Instagram) son miembros y pasan a ser perfiles de la misma persona: esta fusión no las une y la campaña la sigue contando dos veces. Después aparecerán en «Fichas duplicadas» como cuenta doble para fusionarlas.')

    // Now one person, two rows in D: still a «cuenta doble» in D, on the banner and on the screen
    const [k, t] = await Promise.all([K, T].map(id => prisma.influencer.findUniqueOrThrow({ where: { id }, select: { personId: true } })))
    expect(k.personId).toBe(t.personId)
    expect(await countSameCampaignCandidates(D)).toBe(1)
    const kt = (await findMergeCandidates({ campaignId: D })).find(c => c.key === pair(K, T))!
    expect(kt).toMatchObject({ kind: 'same_campaign', strength: 'double_count' })
    expect(kt.sharedCampaigns).toEqual([{ id: D, name: 'Campaña D (prueba)', membersBefore: 2, membersAfter: 1 }])

    // And merging it folds D: one creator, the same two pieces
    const second = await merge(b.admin, kt.suggestion.keepId, kt.suggestion.otherId, kt.suggestion.mode)
    expect(second.result.campaigns.find(c => c.campaignId === D)).toMatchObject({ action: 'fold', membersBefore: 2, membersAfter: 1, piecesBefore: 2, piecesAfter: 2 })
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: D } })).toBe(1)
    expect(await countSameCampaignCandidates(D)).toBe(0)
  })
})

describe('the suggestion never absorbs a real account', () => {
  it('a link to the same handle on a THIRD network: two real accounts, linked; graded «Revisar»-level evidence', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    const ig = await b.inf('neii_demo', 'INSTAGRAM', 4000, { website: 'https://youtube.com/@neii_demo' })
    const tt = await b.inf('neii_demo', 'TIKTOK', 13900)
    await b.member(C, ig); await b.member(C, tt)
    await b.piece(C, tt, 'TIKTOK', 'VIDEO'); await b.piece(C, tt, 'TIKTOK', 'VIDEO')
    const c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(ig, tt))!
    expect(c.suggestion.mode).toBe('link')
    expect(c.suggestion.reason).not.toContain('equivocado')
    // youtube.com/@neii_demo is not a link to the TikTok profile: it says only «the same handle on another network»
    expect(c.evidence.map(e => e.code)).not.toContain('links_to_other')
  })

  it('without a shared campaign, a link to the same handle on another network is «Revisar», not «Fuerte»', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    const gema = await b.inf('gema_demo', 'INSTAGRAM', 3000, { website: 'https://www.tiktok.com/@gema_cocina' })
    const cocinaIg = await b.inf('gema_cocina', 'INSTAGRAM', 400)
    await b.member(C, gema)
    const c = (await findMergeCandidates()).find(x => x.key === pair(gema, cocinaIg))!
    expect(c).toMatchObject({ kind: 'same_handle_cross_network', strength: 'review' })
  })

  it('a profile never read (0 followers but unknown), with a connected account, or with a real audience is never «un usuario equivocado»', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    // Near handles, both members of C, nothing else
    const real = await b.inf('lalyhogar_demo', 'TIKTOK', 2500)
    await b.piece(C, real, 'TIKTOK', 'VIDEO')
    const unread = await b.inf('jolyhogar_demo', 'INSTAGRAM', 0)
    await b.member(C, real); await b.member(C, unread)
    let c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(real, unread))!
    expect(c.suggestion.mode).toBe('link')

    // Read, and 0 followers: now it is a wrong or abandoned handle
    await prisma.influencer.update({ where: { id: unread }, data: { lastScraped: new Date('2026-10-20T00:00:00Z') } })
    c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(real, unread))!
    expect(c.suggestion).toMatchObject({ keepId: real, otherId: unread, mode: 'absorb' })

    // ...unless an account connection hangs from it
    await prisma.socialToken.create({ data: { platform: 'INSTAGRAM', tokenType: 'creator', accessToken: 'token-de-prueba', influencerId: unread } })
    c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(real, unread))!
    expect(c.suggestion.mode).toBe('link')
    await prisma.socialToken.deleteMany()

    // ...or it has a real audience, even when the other links it as her TikTok handle
    const vane = await b.inf('vane_demo', 'INSTAGRAM', 2300, { website: 'https://www.tiktok.com/@vane_tt_demo' })
    const vaneTtAsIg = await b.inf('vane_tt_demo', 'INSTAGRAM', 3100, { lastScraped: new Date('2026-10-20T00:00:00Z') })
    await b.member(C, vane); await b.member(C, vaneTtAsIg)
    c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(vane, vaneTtAsIg))!
    expect(c.suggestion.mode).toBe('link')
    // With no audience, that link is the reason to absorb it (the October pattern)
    await prisma.influencer.update({ where: { id: vaneTtAsIg }, data: { followers: 0, lastScraped: null } })
    c = (await findMergeCandidates({ campaignId: C })).find(x => x.key === pair(vane, vaneTtAsIg))!
    expect(c.suggestion).toMatchObject({ keepId: vane, otherId: vaneTtAsIg, mode: 'absorb' })
    expect(c.suggestion.reason).toContain('@vane_demo (Instagram) enlaza tiktok.com/@vane_tt_demo: es su cuenta de TikTok, guardada como Instagram')
    expect(c.suggestion.reason).not.toContain('0 seguidores')
  })
})

describe('the duplicate a merge detached', () => {
  it('is not attached again by the next capture of the same post: the campaign keeps one row', async () => {
    const b = await base()
    const C = await b.campaign('Campaña C (prueba)')
    const K = await b.inf('beaejemplo', 'INSTAGRAM', 3000)
    const O = await b.inf('BeaEjemplo', 'INSTAGRAM', 0)
    await b.member(C, K); await b.member(C, O)
    // The same post under both rows: K's via Meta (richer), O's via Apify's numeric id
    const kept = await b.piece(C, K, 'INSTAGRAM', 'REEL', { externalId: 'meta-17890001', permalink: 'https://www.instagram.com/p/DupProbe01/', insightsSource: 'creator_screenshot', views: 5000 })
    const dup = await b.piece(C, O, 'INSTAGRAM', 'REEL', { externalId: '3511111111111111111', permalink: 'https://www.instagram.com/reel/DupProbe01/', views: 900 })
    const { preview } = await merge(b.admin, K, O, 'absorb')
    expect(preview.campaigns[0].duplicates).toEqual([expect.objectContaining({ keepMediaId: kept, detachMediaId: dup })])
    expect((await computeCampaignOverview(C, { rates: DEFAULT_EMV_RATES }))!.totals.media).toBe(1)

    // The next daily capture of K returns the post with Apify's numeric id
    const ok = await upsertCampaignPost(C, K, 'INSTAGRAM', {
      externalId: '3511111111111111111', caption: 'Probando #marcademo', mediaUrl: null, thumbnailUrl: null,
      permalink: 'https://www.instagram.com/reel/DupProbe01/', mediaType: 'REEL', likes: 60, comments: 4, shares: 0, saves: 0, views: 950,
      postedAt: '2026-10-10T10:00:00.000Z', hashtags: ['marcademo'], mentions: [],
    })
    expect(ok).toBe(true)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: dup }, select: { campaignId: true } })).toEqual({ campaignId: null })
    expect(await prisma.media.count({ where: { campaignId: C, permalink: { contains: '/DupProbe01' } } })).toBe(1)
    expect((await computeCampaignOverview(C, { rates: DEFAULT_EMV_RATES }))!.totals.media).toBe(1)
    // The campaign's own row was refreshed instead (public counts only raise)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: kept }, select: { views: true, likes: true } })).toEqual({ views: 5000, likes: 60 })
  })
})

describe('an absorbed profile added again', () => {
  it('next to the real account in a later campaign, it is proposed again (and counted on the banner)', async () => {
    const b = await base()
    const OCT = await b.campaign('Octubre (prueba)')
    const NOV = await b.campaign('Noviembre (prueba)')
    const real = await b.inf('vane_real_demo', 'INSTAGRAM', 2300, { website: 'https://www.tiktok.com/@vane_mal_demo' })
    const wrong = await b.inf('vane_mal_demo', 'INSTAGRAM', 0)
    await b.member(OCT, real); await b.member(OCT, wrong)
    await merge(b.admin, real, wrong, 'absorb')
    // While it is nobody's member it is not proposed again
    expect((await findMergeCandidates()).some(c => c.key === pair(real, wrong))).toBe(false)
    // A PM adds both again in November, as happened in October
    await b.member(NOV, real); await b.member(NOV, wrong)
    expect(await countSameCampaignCandidates(NOV)).toBe(1)
    expect((await findMergeCandidates({ campaignId: NOV })).map(c => c.key)).toEqual([pair(real, wrong)])
  })
})
