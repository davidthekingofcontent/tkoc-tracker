import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// No test may reach a scraper: the capture module imports it, so it is replaced.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    isApifyExhausted: vi.fn(() => false),
  }
})

import { prisma } from '@/lib/db'
import type { ScrapedPost } from '@/lib/apify'
import { scrapeProfile } from '@/lib/apify'
import type { Platform } from '@/generated/prisma/client'
import {
  PersonLinkError,
  findInfluencerExact,
  findOrCreateInfluencerExact,
  linkProfile,
  unlinkProfile,
} from '@/lib/person-profiles'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import { revalidateCampaignMedia, upsertCampaignPost } from '@/lib/campaign-capture'

const PM = { id: 'user-pm', name: 'Laura PM' }

async function reset() {
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(reset)
afterAll(reset)

function profile(username: string, platform: Platform = 'INSTAGRAM', extra: { followers?: number; displayName?: string; createdAt?: Date; personId?: string } = {}) {
  return prisma.influencer.create({ data: { username, platform, ...extra } })
}

/** An October-like campaign: 1 to 31 Oct 2026, Instagram + TikTok, brand @vileda.es / #vileda. */
async function octoberCampaign() {
  const user = await prisma.user.create({ data: { email: `pm-${Date.now()}-${Math.random()}@example.test`, password: 'x', name: 'Laura PM' } })
  return prisma.campaign.create({
    data: {
      name: '10.- Vileda - Micros Octubre (test)',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['vileda.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      userId: user.id,
    },
  })
}

function join(campaignId: string, influencerId: string, extra: { agreedFee?: number; createdAt?: Date } = {}) {
  return prisma.campaignInfluencer.create({ data: { campaignId, influencerId, status: 'COMPLETED', ...extra } })
}

function tiktokVideo(over: Partial<ScrapedPost> = {}): ScrapedPost {
  return {
    externalId: '7695852671042964758',
    caption: 'Probando la fregona nueva #vileda',
    mediaUrl: null,
    thumbnailUrl: null,
    permalink: 'https://www.tiktok.com/@ale_ficticia/video/7695852671042964758',
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

async function expectLinkError(promise: Promise<unknown>, code: PersonLinkError['code']): Promise<PersonLinkError> {
  const err = await promise.then(() => null, e => e)
  expect(err).toBeInstanceOf(PersonLinkError)
  expect((err as PersonLinkError).code).toBe(code)
  return err as PersonLinkError
}

// ---------------------------------------------------------------------------

describe('findInfluencerExact', () => {
  it('finds a profile whatever the casing, the @ or the spaces', async () => {
    const row = await profile('Ale_Ficticia', 'TIKTOK', { followers: 29000 })

    for (const typed of ['ale_ficticia', 'ALE_FICTICIA', ' @Ale_Ficticia ', '@@ale_ficticia']) {
      expect(await findInfluencerExact('TIKTOK', typed)).toEqual({ id: row.id, username: 'Ale_Ficticia', platform: 'TIKTOK', personId: null, followers: 29000 })
    }
  })

  it('never treats _ or % as a pattern', async () => {
    await profile('maria.garcia')
    await profile('mariaXgarcia')
    expect(await findInfluencerExact('INSTAGRAM', 'maria_garcia')).toBeNull()
    expect(await findInfluencerExact('INSTAGRAM', 'maria%')).toBeNull()
    expect(await findInfluencerExact('INSTAGRAM', '%')).toBeNull()
    expect(await findInfluencerExact('INSTAGRAM', 'maria.garci_')).toBeNull()

    const real = await profile('maria_garcia')
    expect((await findInfluencerExact('INSTAGRAM', 'Maria_Garcia'))?.id).toBe(real.id)
    expect((await findInfluencerExact('INSTAGRAM', 'maria.garcia'))?.username).toBe('maria.garcia')
  })

  it('does not cross networks and answers null for nothing', async () => {
    await profile('ale_ficticia', 'TIKTOK')
    expect(await findInfluencerExact('INSTAGRAM', 'ale_ficticia')).toBeNull()
    expect(await findInfluencerExact('YOUTUBE', 'ale_ficticia')).toBeNull()
    expect(await findInfluencerExact('TIKTOK', '')).toBeNull()
    expect(await findInfluencerExact('TIKTOK', ' @ ')).toBeNull()
  })

  it('among rows that differ only in casing: as typed, else the linked one, else the oldest', async () => {
    const oldest = await profile('Lili_ficticia', 'TIKTOK', { createdAt: new Date('2026-01-01T00:00:00Z') })
    const newer = await profile('lili_ficticia', 'TIKTOK', { createdAt: new Date('2026-06-01T00:00:00Z') })
    const newest = await profile('LILI_FICTICIA', 'TIKTOK', { createdAt: new Date('2026-09-01T00:00:00Z') })

    expect((await findInfluencerExact('TIKTOK', 'lili_ficticia'))?.id).toBe(newer.id)
    expect((await findInfluencerExact('TIKTOK', '@LILI_FICTICIA'))?.id).toBe(newest.id)
    expect((await findInfluencerExact('TIKTOK', 'LiLi_FiCtIcia'))?.id).toBe(oldest.id)

    const person = await prisma.person.create({ data: { displayName: 'Lilin' } })
    await prisma.influencer.update({ where: { id: newest.id }, data: { personId: person.id } })
    expect(await findInfluencerExact('TIKTOK', 'LiLi_FiCtIcia')).toMatchObject({ id: newest.id, personId: person.id })
  })
})

describe('findOrCreateInfluencerExact', () => {
  it('creates a bare profile stamped with who added it, once', async () => {
    const first = await findOrCreateInfluencerExact('INSTAGRAM', ' @Risas_inventadas_ ', PM)
    expect(first).toMatchObject({ username: 'Risas_inventadas_', platform: 'INSTAGRAM', personId: null, followers: 0, created: true })

    const row = await prisma.influencer.findUniqueOrThrow({ where: { id: first.id } })
    expect(row).toMatchObject({ username: 'Risas_inventadas_', addedById: 'user-pm', addedByName: 'Laura PM', personId: null, lastScraped: null, followers: 0 })

    const again = await findOrCreateInfluencerExact('INSTAGRAM', 'risas_inventadas_', { id: 'someone-else', name: 'Otra' })
    expect(again).toMatchObject({ id: first.id, username: 'Risas_inventadas_', created: false })
    expect(await prisma.influencer.count()).toBe(1)
    // The stamp of the first creation is kept
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: first.id } })).addedByName).toBe('Laura PM')
    expect(vi.mocked(scrapeProfile)).not.toHaveBeenCalled()
  })

  it('reuses an existing row and leaves it untouched', async () => {
    const existing = await profile('gema.ficticia_', 'TIKTOK', { followers: 18000 })
    const found = await findOrCreateInfluencerExact('TIKTOK', 'Gema.fiCticia_', PM)

    expect(found).toEqual({ id: existing.id, username: 'gema.ficticia_', platform: 'TIKTOK', personId: null, followers: 18000, created: false })
    expect(await prisma.influencer.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ addedById: null, addedByName: null, followers: 18000 })
  })

  it('the same handle on another network is another profile', async () => {
    const ig = await profile('sara_inventada17', 'INSTAGRAM')
    const tt = await findOrCreateInfluencerExact('TIKTOK', 'sara_inventada17', null)

    expect(tt.created).toBe(true)
    expect(tt.id).not.toBe(ig.id)
    expect(await prisma.influencer.findUniqueOrThrow({ where: { id: tt.id } })).toMatchObject({ platform: 'TIKTOK', addedById: null, addedByName: null })
  })

  it('creates one row when several requests arrive at once', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => findOrCreateInfluencerExact('TIKTOK', 'nuria_demo15', PM)))

    expect(await prisma.influencer.count()).toBe(1)
    expect(new Set(results.map(r => r.id)).size).toBe(1)
    expect(results.filter(r => r.created)).toHaveLength(1)
  })

  it('refuses an empty handle', async () => {
    await expect(findOrCreateInfluencerExact('TIKTOK', ' @ ', PM)).rejects.toThrow(/empty handle/)
    expect(await prisma.influencer.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('linkProfile', () => {
  it('creates the person when neither profile has one and logs before and after', async () => {
    const member = await profile('ale_ficticia', 'INSTAGRAM', { followers: 2382, displayName: 'Ale Zweig' })
    const tiktok = await profile('ale_ficticia', 'TIKTOK', { followers: 29000 })

    const result = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })

    expect(result.alreadyLinked).toBe(false)
    expect(result.logId).toEqual(expect.any(String))
    const person = await prisma.person.findUniqueOrThrow({ where: { id: result.personId }, include: { profiles: { orderBy: { platform: 'asc' } } } })
    expect(person).toMatchObject({ displayName: 'Ale Zweig', createdById: 'user-pm', createdByName: 'Laura PM' })
    expect(person.profiles.map(p => p.id).sort()).toEqual([member.id, tiktok.id].sort())

    const logs = await prisma.personLog.findMany()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      id: result.logId,
      action: 'link_profile',
      personId: result.personId,
      actorId: 'user-pm',
      actorName: 'Laura PM',
      evidence: 'pm_confirmed',
      summary: '@ale_ficticia (TikTok) añadido como perfil de @ale_ficticia (Instagram)',
      undoneAt: null,
      undoOfId: null,
    })
    expect(logs[0].before).toEqual({
      member: { id: member.id, username: 'ale_ficticia', platform: 'INSTAGRAM', personId: null },
      profile: { id: tiktok.id, username: 'ale_ficticia', platform: 'TIKTOK', personId: null },
    })
    expect(logs[0].after).toEqual({
      member: { id: member.id, username: 'ale_ficticia', platform: 'INSTAGRAM', personId: result.personId },
      profile: { id: tiktok.id, username: 'ale_ficticia', platform: 'TIKTOK', personId: result.personId },
      personCreated: true,
    })
  })

  it('is idempotent: linking again changes nothing and writes no log', async () => {
    const member = await profile('lili_ficticia', 'INSTAGRAM')
    const tiktok = await profile('lili_ficticia', 'TIKTOK')
    const first = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'scraped_owner' })

    const again = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: null, evidence: 'autolink_video' })
    expect(again).toEqual({ personId: first.personId, alreadyLinked: true, logId: null })
    // Also the other way round: they already share the person
    const reversed = await linkProfile({ memberInfluencerId: tiktok.id, profileInfluencerId: member.id, actor: PM, evidence: 'pm_manual' })
    expect(reversed).toEqual({ personId: first.personId, alreadyLinked: true, logId: null })

    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.personLog.count()).toBe(1)
  })

  it('adds a further profile to the person the member already has (two profiles on one network)', async () => {
    const member = await profile('risas_inventadas', 'INSTAGRAM', { followers: 19 })
    const tiktok = await profile('risas_inventadas', 'TIKTOK', { followers: 8287 })
    const realInstagram = await profile('risas_inventadas_', 'INSTAGRAM')

    const a = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    const b = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: realInstagram.id, actor: PM, evidence: 'pm_confirmed_unverified', summary: '  Confirmado por la PM sin poder leer el autor  ' })

    expect(b.personId).toBe(a.personId)
    expect(b.alreadyLinked).toBe(false)
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.influencer.count({ where: { personId: a.personId } })).toBe(3)
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: b.logId! } })
    expect(log).toMatchObject({ evidence: 'pm_confirmed_unverified', summary: 'Confirmado por la PM sin poder leer el autor' })
    expect(log.before).toMatchObject({ member: { personId: a.personId }, profile: { personId: null } })
    expect(log.after).toMatchObject({ profile: { id: realInstagram.id, personId: a.personId }, personCreated: false })
  })

  it('refuses a profile that already belongs to a different person and changes nothing', async () => {
    const ana = await profile('ana', 'INSTAGRAM')
    const anaTiktok = await profile('ana.tt', 'TIKTOK')
    const { personId: anaPerson } = await linkProfile({ memberInfluencerId: ana.id, profileInfluencerId: anaTiktok.id, actor: PM, evidence: 'pm_confirmed' })
    const bea = await profile('bea', 'INSTAGRAM')
    const beaYoutube = await profile('bea', 'YOUTUBE')
    const { personId: beaPerson } = await linkProfile({ memberInfluencerId: bea.id, profileInfluencerId: beaYoutube.id, actor: PM, evidence: 'pm_confirmed' })
    const carla = await profile('carla', 'INSTAGRAM')

    // Bea (has a person) claims Ana's TikTok; Carla (no person) claims it too
    const err = await expectLinkError(linkProfile({ memberInfluencerId: bea.id, profileInfluencerId: anaTiktok.id, actor: PM, evidence: 'pm_confirmed' }), 'profile_has_other_person')
    expect(err.personId).toBe(anaPerson)
    await expectLinkError(linkProfile({ memberInfluencerId: carla.id, profileInfluencerId: anaTiktok.id, actor: PM, evidence: 'pm_confirmed' }), 'profile_has_other_person')

    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: anaTiktok.id } })).personId).toBe(anaPerson)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: bea.id } })).personId).toBe(beaPerson)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: carla.id } })).personId).toBeNull()
    expect(await prisma.person.count()).toBe(2)
    expect(await prisma.personLog.count()).toBe(2)
  })

  it('refuses the same profile and unknown profiles', async () => {
    const member = await profile('ale_ficticia', 'INSTAGRAM')

    await expectLinkError(linkProfile({ memberInfluencerId: member.id, profileInfluencerId: member.id, actor: PM, evidence: 'pm_manual' }), 'same_profile')
    await expectLinkError(linkProfile({ memberInfluencerId: member.id, profileInfluencerId: 'does-not-exist', actor: PM, evidence: 'pm_manual' }), 'not_found')
    await expectLinkError(linkProfile({ memberInfluencerId: 'does-not-exist', profileInfluencerId: member.id, actor: PM, evidence: 'pm_manual' }), 'not_found')
    await expectLinkError(linkProfile({ memberInfluencerId: member.id, profileInfluencerId: '', actor: PM, evidence: 'pm_manual' }), 'not_found')

    expect(await prisma.person.count()).toBe(0)
    expect(await prisma.personLog.count()).toBe(0)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBeNull()
  })

  it('records the system as actor when a cron links', async () => {
    const member = await profile('hola_soy_demo', 'INSTAGRAM')
    const tiktok = await profile('hola_soy_demo', 'TIKTOK')
    const { logId, personId } = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: null, evidence: 'autolink_video' })

    expect(await prisma.personLog.findUniqueOrThrow({ where: { id: logId! } })).toMatchObject({ actorId: null, actorName: null, evidence: 'autolink_video' })
    expect(await prisma.person.findUniqueOrThrow({ where: { id: personId } })).toMatchObject({ displayName: 'hola_soy_demo', createdById: null, createdByName: null })
  })

  it('never touches memberships or media', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('sara_inventada17', 'INSTAGRAM')
    const tiktok = await profile('sara_inventada17', 'TIKTOK')
    await join(campaign.id, member.id, { agreedFee: 150 })
    const reel = await prisma.media.create({ data: { platform: 'INSTAGRAM', mediaType: 'REEL', externalId: 'reel-1', influencerId: member.id, campaignId: campaign.id, views: 900 } })
    const loose = await prisma.media.create({ data: { platform: 'TIKTOK', mediaType: 'VIDEO', externalId: 'tt-1', influencerId: tiktok.id, views: 3000 } })
    const before = {
      memberships: await prisma.campaignInfluencer.findMany({ orderBy: { id: 'asc' } }),
      media: await prisma.media.findMany({ orderBy: { id: 'asc' } }),
    }

    await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })

    expect(await prisma.campaignInfluencer.findMany({ orderBy: { id: 'asc' } })).toEqual(before.memberships)
    expect(await prisma.media.findMany({ orderBy: { id: 'asc' } })).toEqual(before.media)
    expect(before.media.map(m => m.id).sort()).toEqual([reel.id, loose.id].sort())
  })

  it('two simultaneous links of the same creator end in ONE person', async () => {
    const member = await profile('risas_inventadas', 'INSTAGRAM')
    const others = await Promise.all([
      profile('risas_inventadas', 'TIKTOK'),
      profile('risas_inventadas_', 'INSTAGRAM'),
      profile('risas_inventadas', 'YOUTUBE'),
    ])

    const results = await Promise.all(others.map(o => linkProfile({ memberInfluencerId: member.id, profileInfluencerId: o.id, actor: PM, evidence: 'pm_confirmed' })))

    expect(new Set(results.map(r => r.personId)).size).toBe(1)
    expect(await prisma.person.count()).toBe(1)
    expect(await prisma.influencer.count({ where: { personId: results[0].personId } })).toBe(4)
    expect(await prisma.personLog.count({ where: { action: 'link_profile' } })).toBe(3)

    // The same pair twice at once: one link, one log
    const a = await profile('gemela', 'INSTAGRAM')
    const b = await profile('gemela', 'TIKTOK')
    const pair = await Promise.all([1, 2, 3].map(() => linkProfile({ memberInfluencerId: a.id, profileInfluencerId: b.id, actor: PM, evidence: 'pm_confirmed' })))
    expect(pair.filter(r => !r.alreadyLinked)).toHaveLength(1)
    expect(new Set(pair.map(r => r.personId)).size).toBe(1)
    expect(await prisma.person.count()).toBe(2)
    expect(await prisma.personLog.count({ where: { personId: pair[0].personId } })).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('unlinkProfile', () => {
  it('undoes a link of two profiles: both are free again, logged as the undo of the link', async () => {
    const member = await profile('ale_ficticia', 'INSTAGRAM')
    const tiktok = await profile('ale_ficticia', 'TIKTOK')
    const link = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })

    const { logId } = await unlinkProfile({ profileInfluencerId: tiktok.id, actor: { id: 'user-admin', name: 'David' }, reason: 'Era otra persona con el mismo nombre' })

    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBeNull()
    // Nothing is deleted: the person row stays, with no profiles
    expect(await prisma.person.count()).toBe(1)

    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: logId } })
    expect(log).toMatchObject({
      action: 'unlink_profile',
      personId: link.personId,
      actorId: 'user-admin',
      actorName: 'David',
      undoOfId: link.logId,
      summary: '@ale_ficticia (TikTok) deja de ser perfil de @ale_ficticia (Instagram). Motivo: Era otra persona con el mismo nombre',
    })
    expect(log.before).toMatchObject({
      profile: { id: tiktok.id, username: 'ale_ficticia', platform: 'TIKTOK', personId: link.personId },
      person: { id: link.personId },
    })
    const beforeProfiles = (log.before as { person: { profiles: Array<{ id: string; personId: string }> } }).person.profiles
    expect(beforeProfiles.map(p => p.id).sort()).toEqual([member.id, tiktok.id].sort())
    expect(beforeProfiles.every(p => p.personId === link.personId)).toBe(true)
    expect(log.after).toMatchObject({
      profile: { id: tiktok.id, personId: null },
      personLeftWithoutProfiles: true,
      creditedMediaKept: 0,
      reason: 'Era otra persona con el mismo nombre',
    })
    expect(((log.after as { releasedProfileIds: string[] }).releasedProfileIds).sort()).toEqual([member.id, tiktok.id].sort())

    const linkLog = await prisma.personLog.findUniqueOrThrow({ where: { id: link.logId! } })
    expect(linkLog.undoneAt).toBeInstanceOf(Date)
    expect(linkLog.undoneById).toBe('user-admin')
  })

  it('keeps the other profiles together when the person still has two', async () => {
    const member = await profile('risas_inventadas', 'INSTAGRAM')
    const tiktok = await profile('risas_inventadas', 'TIKTOK')
    const realInstagram = await profile('risas_inventadas_', 'INSTAGRAM')
    const first = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    const second = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: realInstagram.id, actor: PM, evidence: 'pm_confirmed' })

    const { logId } = await unlinkProfile({ profileInfluencerId: tiktok.id, actor: PM })

    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBeNull()
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: member.id } })).personId).toBe(first.personId)
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: realInstagram.id } })).personId).toBe(first.personId)
    const log = await prisma.personLog.findUniqueOrThrow({ where: { id: logId } })
    expect(log.undoOfId).toBe(first.logId)
    expect(log.after).toMatchObject({ releasedProfileIds: [tiktok.id], personLeftWithoutProfiles: false })
    expect(log.summary).toBe('@risas_inventadas (TikTok) deja de ser perfil de @risas_inventadas (Instagram), @risas_inventadas_ (Instagram)')
    // Only the link of that profile is marked as undone
    expect((await prisma.personLog.findUniqueOrThrow({ where: { id: first.logId! } })).undoneAt).not.toBeNull()
    expect((await prisma.personLog.findUniqueOrThrow({ where: { id: second.logId! } })).undoneAt).toBeNull()
  })

  it('can be linked again after being unlinked', async () => {
    const member = await profile('lili_ficticia', 'INSTAGRAM')
    const tiktok = await profile('lili_ficticia', 'TIKTOK')
    await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    await unlinkProfile({ profileInfluencerId: member.id, actor: PM })
    expect(await prisma.influencer.count({ where: { personId: { not: null } } })).toBe(0)

    const again = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    expect(again.alreadyLinked).toBe(false)
    expect(await prisma.influencer.count({ where: { personId: again.personId } })).toBe(2)
    expect(await prisma.personLog.count({ where: { action: 'link_profile', undoneAt: null } })).toBe(1)
  })

  it('refuses a profile that is not linked, or does not exist, and writes nothing', async () => {
    const lonely = await profile('nuria_demo15', 'INSTAGRAM')

    await expectLinkError(unlinkProfile({ profileInfluencerId: lonely.id, actor: PM }), 'not_found')
    await expectLinkError(unlinkProfile({ profileInfluencerId: 'does-not-exist', actor: PM }), 'not_found')
    expect(await prisma.personLog.count()).toBe(0)
  })

  it('never moves or detaches content', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('gema.ficticia_', 'INSTAGRAM')
    const tiktok = await profile('gema.ficticia_', 'TIKTOK')
    await join(campaign.id, member.id)
    await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })
    const before = await prisma.media.findMany()
    expect(before).toHaveLength(1)

    const { logId } = await unlinkProfile({ profileInfluencerId: tiktok.id, actor: PM })

    expect(await prisma.media.findMany()).toEqual(before)
    expect(before[0]).toMatchObject({ influencerId: member.id, publishedByInfluencerId: tiktok.id, campaignId: campaign.id })
    expect((await prisma.personLog.findUniqueOrThrow({ where: { id: logId } })).after).toMatchObject({ creditedMediaKept: 1 })
    expect(await prisma.campaignInfluencer.count()).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('loadCampaignRoster', () => {
  it('reads the members and the other profiles of their persons', async () => {
    const campaign = await octoberCampaign()
    const alez = await profile('ale_ficticia', 'INSTAGRAM', { followers: 2382 })
    const alezTiktok = await profile('ale_ficticia', 'TIKTOK', { followers: 29000 })
    const humor = await profile('risas_inventadas', 'INSTAGRAM', { followers: 19 })
    const humorReal = await profile('risas_inventadas_', 'INSTAGRAM')
    const dianaIg = await profile('dana_ejemplo_dos', 'INSTAGRAM')
    const dianaTt = await profile('dana_ejemplo_dos', 'TIKTOK')
    const lilin = await profile('lili_ficticia', 'INSTAGRAM')
    await profile('lili_ficticia', 'TIKTOK') // exists, nobody linked it
    await join(campaign.id, alez.id, { agreedFee: 200, createdAt: new Date('2026-09-20T00:00:00Z') })
    await join(campaign.id, humor.id, { createdAt: new Date('2026-09-21T00:00:00Z') })
    await join(campaign.id, dianaIg.id, { createdAt: new Date('2026-09-22T00:00:00Z') })
    await join(campaign.id, dianaTt.id, { createdAt: new Date('2026-09-23T00:00:00Z') })
    await join(campaign.id, lilin.id, { createdAt: new Date('2026-09-24T00:00:00Z') })
    await linkProfile({ memberInfluencerId: alez.id, profileInfluencerId: alezTiktok.id, actor: PM, evidence: 'pm_confirmed' })
    await linkProfile({ memberInfluencerId: humor.id, profileInfluencerId: humorReal.id, actor: PM, evidence: 'pm_confirmed' })

    const roster = await loadCampaignRoster(campaign.id)

    expect(roster.members.map(m => m.username)).toEqual(['ale_ficticia', 'risas_inventadas', 'dana_ejemplo_dos', 'dana_ejemplo_dos', 'lili_ficticia'])
    expect(roster.members[0]).toMatchObject({ influencerId: alez.id, platform: 'INSTAGRAM', followers: 2382, hasFee: true, createdAt: new Date('2026-09-20T00:00:00Z') })
    expect(roster.members[1].hasFee).toBe(false)

    expect(roster.creditFor('TIKTOK', '@Ale_Ficticia')).toMatchObject({ self: false, member: { influencerId: alez.id }, publisher: { influencerId: alezTiktok.id, followers: 29000 } })
    expect(roster.creditForInfluencer(alezTiktok.id)).toMatchObject({ self: false, member: { influencerId: alez.id } })
    expect(roster.creditFor('INSTAGRAM', 'risas_inventadas_')).toMatchObject({ self: false, member: { influencerId: humor.id }, publisher: { influencerId: humorReal.id } })
    expect(roster.creditFor('INSTAGRAM', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: dianaIg.id } })
    expect(roster.creditFor('TIKTOK', 'dana_ejemplo_dos')).toMatchObject({ self: true, member: { influencerId: dianaTt.id } })
    // Same handle on TikTok, not linked: nobody
    expect(roster.creditFor('TIKTOK', 'lili_ficticia')).toBeNull()
    expect(roster.creditFor('TIKTOK', 'risas_inventadas')).toBeNull()

    // Another campaign does not see these members
    const other = await octoberCampaign()
    expect((await loadCampaignRoster(other.id)).members).toEqual([])
    expect((await loadCampaignRoster(other.id)).creditFor('TIKTOK', 'ale_ficticia')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('upsertCampaignPost with a publishing profile', () => {
  async function fixture() {
    const campaign = await octoberCampaign()
    const member = await profile('ale_ficticia', 'INSTAGRAM', { followers: 2382 })
    const tiktok = await profile('ale_ficticia', 'TIKTOK', { followers: 29000 })
    await join(campaign.id, member.id)
    await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })
    return { campaign, member, tiktok }
  }

  it('stores the piece under the member, remembers who published it and keeps the network of the publication', async () => {
    const { campaign, member, tiktok } = await fixture()

    expect(await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      influencerId: member.id,
      publishedByInfluencerId: tiktok.id,
      platform: 'TIKTOK',
      mediaType: 'VIDEO',
      campaignId: campaign.id,
      externalId: '7695852671042964758',
      views: 5400,
      source: 'apify',
    })
    // No member was created: the campaign has the same creators as before
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: campaign.id } })).toBe(1)
  })

  it('does not duplicate when the same piece arrives again, and only raises its figures', async () => {
    const { campaign, member, tiktok } = await fixture()
    await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })

    expect(await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo({ views: 9000, likes: 10 }), { publishedByInfluencerId: tiktok.id })).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ views: 9000, likes: 120, influencerId: member.id, publishedByInfluencerId: tiktok.id })
  })

  it('behaves as before for a caller that passes no publisher', async () => {
    const { campaign, member } = await fixture()
    const reel: ScrapedPost = tiktokVideo({ externalId: '3700000000000000001', mediaType: 'REEL', permalink: 'https://www.instagram.com/reel/DeKHOgcNODD/' })

    expect(await upsertCampaignPost(campaign.id, member.id, 'INSTAGRAM', reel)).toBe(true)
    expect(await upsertCampaignPost(campaign.id, member.id, 'INSTAGRAM', { ...reel, externalId: '3700000000000000002', permalink: 'https://www.instagram.com/reel/DeKHOgcNOD2/' }, { publishedByInfluencerId: null })).toBe(true)
    // Naming the member herself as the publisher is the same as naming nobody
    expect(await upsertCampaignPost(campaign.id, member.id, 'INSTAGRAM', { ...reel, externalId: '3700000000000000003', permalink: 'https://www.instagram.com/reel/DeKHOgcNOD3/' }, { publishedByInfluencerId: member.id })).toBe(true)

    const rows = await prisma.media.findMany({ orderBy: { externalId: 'asc' } })
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toMatchObject({ influencerId: member.id, publishedByInfluencerId: null, platform: 'INSTAGRAM', campaignId: campaign.id })
  })

  it('claims an unattached row of the publishing profile and credits it to the member', async () => {
    const { campaign, member, tiktok } = await fixture()
    // Left by a profile analysis of the TikTok account: hangs from that profile, no campaign
    const loose = await prisma.media.create({
      data: { platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7695852671042964758', influencerId: tiktok.id, views: 100, likes: 500 },
    })

    expect(await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: loose.id, influencerId: member.id, publishedByInfluencerId: tiktok.id, campaignId: campaign.id, views: 5400, likes: 500 })
  })

  it('claims an unattached Instagram row of a second profile found by its link, and revalidation keeps it', async () => {
    const campaign = await octoberCampaign()
    const member = await profile('risas_inventadas', 'INSTAGRAM', { followers: 19 })
    const real = await profile('risas_inventadas_', 'INSTAGRAM')
    await join(campaign.id, member.id)
    await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: real.id, actor: PM, evidence: 'pm_confirmed' })
    // The same reel stored earlier under another id space (Meta), hanging from the profile that published it
    const loose = await prisma.media.create({
      data: { platform: 'INSTAGRAM', mediaType: 'REEL', externalId: '17900000000000001', permalink: 'https://www.instagram.com/reel/DeKHOgcNODD/', influencerId: real.id, source: 'meta_api' },
    })
    const reel = tiktokVideo({ externalId: '3712345678901234567', mediaType: 'REEL', permalink: 'https://www.instagram.com/reel/DeKHOgcNODD/' })

    expect(await upsertCampaignPost(campaign.id, member.id, 'INSTAGRAM', reel, { publishedByInfluencerId: real.id })).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: loose.id, influencerId: member.id, publishedByInfluencerId: real.id, platform: 'INSTAGRAM', campaignId: campaign.id, views: 5400 })
    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 1, detached: 0 })
    expect(await prisma.campaignInfluencer.count()).toBe(1)
  })

  it('leaves an unattached row with its own profile when no publisher is passed (as before)', async () => {
    const { campaign } = await fixture()
    const twin = await profile('gemela_tiktok', 'TIKTOK')
    await join(campaign.id, twin.id)
    const loose = await prisma.media.create({
      data: { platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7695852671042964758', influencerId: twin.id },
    })

    expect(await upsertCampaignPost(campaign.id, twin.id, 'TIKTOK', tiktokVideo())).toBe(true)

    expect(await prisma.media.findMany()).toHaveLength(1)
    expect(await prisma.media.findUniqueOrThrow({ where: { id: loose.id } })).toMatchObject({ influencerId: twin.id, publishedByInfluencerId: null, campaignId: campaign.id })
  })

  it('a caller with no publisher that claims an unattached row credited across profiles files it under the account that published it', async () => {
    const { campaign, member, tiktok } = await fixture()
    await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })
    // The campaign's dates change and «Revalidar contenido» detaches the video: unattached, still credited to the Instagram member
    await prisma.campaign.update({ where: { id: campaign.id }, data: { startDate: new Date('2026-10-20T00:00:00Z') } })
    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 0, detached: 1 })
    const loose = await prisma.media.findFirstOrThrow()
    expect(loose).toMatchObject({ campaignId: null, influencerId: member.id, publishedByInfluencerId: tiktok.id })

    // Another campaign where the TikTok account ITSELF is a member and her Instagram is not: a member cron
    // (check-posts, the hashtag cron, «Rastrear Ahora») stores her video the way it always did, with no options
    const other = await octoberCampaign()
    await join(other.id, tiktok.id)
    expect(await upsertCampaignPost(other.id, tiktok.id, 'TIKTOK', tiktokVideo({ views: 6000 }))).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    // Not «in the other campaign under the Instagram member», who is not a member there
    expect(rows[0]).toMatchObject({ id: loose.id, campaignId: other.id, influencerId: tiktok.id, publishedByInfluencerId: null, views: 6000 })
    // Every piece of that campaign hangs from one of its members: the revalidation keeps it, the next pass has nothing to re-attach
    expect(await revalidateCampaignMedia(other.id)).toEqual({ kept: 1, detached: 0 })
    expect(await upsertCampaignPost(other.id, tiktok.id, 'TIKTOK', tiktokVideo({ views: 6000 }))).toBe(true)
    expect(await prisma.media.count()).toBe(1)
  })

  it('the same for an unattached Instagram row found by its link, whatever its source', async () => {
    for (const source of ['apify', 'manual'] as const) {
      await reset()
      const campaign = await octoberCampaign()
      const member = await profile('risas_inventadas', 'INSTAGRAM', { followers: 19 })
      const real = await profile('risas_inventadas_', 'INSTAGRAM')
      await join(campaign.id, member.id)
      await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: real.id, actor: PM, evidence: 'pm_confirmed' })
      // Detached from the first campaign: credited to the member, published by her other Instagram profile
      const loose = await prisma.media.create({
        data: {
          platform: 'INSTAGRAM', mediaType: 'REEL', externalId: 'DeKHOgcNODD', permalink: 'https://www.instagram.com/reel/DeKHOgcNODD/', source,
          caption: 'Probando la fregona nueva #vileda', hashtags: ['vileda'], postedAt: new Date('2026-10-12T10:00:00Z'),
          influencerId: member.id, publishedByInfluencerId: real.id, campaignId: null,
        },
      })
      // Her other profile is a member of another campaign; its cron knows the reel by its numeric id
      const other = await octoberCampaign()
      await join(other.id, real.id)
      const reel = tiktokVideo({ externalId: '3712345678901234567', mediaType: 'REEL', permalink: 'https://www.instagram.com/reel/DeKHOgcNODD/' })

      expect(await upsertCampaignPost(other.id, real.id, 'INSTAGRAM', reel), source).toBe(true)

      const rows = await prisma.media.findMany()
      expect(rows, source).toHaveLength(1)
      expect(rows[0], source).toMatchObject({ id: loose.id, campaignId: other.id, influencerId: real.id, publishedByInfluencerId: null, source })
      expect(await revalidateCampaignMedia(other.id), source).toEqual({ kept: 1, detached: 0 })
    }
  })

  it('does not move a row that is already in the campaign under another member', async () => {
    const { campaign, member, tiktok } = await fixture()
    // Legacy: the TikTok account was a member of its own (a twin) and holds the video
    await join(campaign.id, tiktok.id)
    await upsertCampaignPost(campaign.id, tiktok.id, 'TIKTOK', tiktokVideo())

    expect(await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo({ views: 7000 }), { publishedByInfluencerId: tiktok.id })).toBe(true)

    const rows = await prisma.media.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ influencerId: tiktok.id, publishedByInfluencerId: null, views: 7000 })
  })

  it('revalidation keeps a piece of another network credited to a member, and still detaches a non-member', async () => {
    const { campaign, member, tiktok } = await fixture()
    await upsertCampaignPost(campaign.id, member.id, 'TIKTOK', tiktokVideo(), { publishedByInfluencerId: tiktok.id })
    // Added by hand: no brand reference needed, still must stay
    const manual = await prisma.media.create({
      data: {
        platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7699205467465108768', source: 'manual', caption: 'sin etiqueta',
        postedAt: new Date('2026-10-20T09:00:00Z'), influencerId: member.id, publishedByInfluencerId: tiktok.id, campaignId: campaign.id,
      },
    })
    // The safety net is intact: a piece hanging from a profile that is not a member does not stay
    const stray = await prisma.media.create({
      data: {
        platform: 'TIKTOK', mediaType: 'VIDEO', externalId: '7693578978421935382', caption: '#vileda', hashtags: ['vileda'],
        postedAt: new Date('2026-10-20T09:00:00Z'), influencerId: tiktok.id, campaignId: campaign.id,
      },
    })

    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 2, detached: 1 })

    const attached = await prisma.media.findMany({ where: { campaignId: campaign.id }, orderBy: { externalId: 'asc' } })
    expect(attached.map(m => m.externalId)).toEqual(['7695852671042964758', '7699205467465108768'])
    for (const row of attached) expect(row).toMatchObject({ influencerId: member.id, publishedByInfluencerId: tiktok.id, platform: 'TIKTOK' })
    expect(attached.map(m => m.id)).toContain(manual.id)
    expect((await prisma.media.findUniqueOrThrow({ where: { id: stray.id } })).campaignId).toBeNull()

    // And a second pass changes nothing
    expect(await revalidateCampaignMedia(campaign.id)).toEqual({ kept: 2, detached: 0 })
  })
})

// ---------------------------------------------------------------------------

describe('the additive SQL on a real database', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const dir = path.resolve(here, '..', '..', 'prisma', 'additive')

  function statements(file: string): string[] {
    return fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n')
      .map(line => line.replace(/--.*$/, ''))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !/^(BEGIN|COMMIT)$/i.test(s))
  }

  async function shape(client: pg.Client) {
    const columns = await client.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`
    )
    const indexes = await client.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`)
    const constraints = await client.query(
      `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`
    )
    return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows }
  }

  const NEW_COLUMNS = [
    'campaign_influencers.addedById', 'campaign_influencers.addedByName',
    'influencers.addedById', 'influencers.addedByName', 'influencers.personId',
    'media.publishedByInfluencerId',
  ]

  it('applies on the tables as they were, keeps every existing row and gives the shape the schema expects', async () => {
    // Existing data, as production has it
    const campaign = await octoberCampaign()
    const member = await profile('ale_ficticia', 'INSTAGRAM', { followers: 2382 })
    const tiktok = await profile('ale_ficticia', 'TIKTOK')
    await join(campaign.id, member.id, { agreedFee: 200 })
    await prisma.media.create({ data: { platform: 'INSTAGRAM', mediaType: 'REEL', externalId: 'reel-1', influencerId: member.id, campaignId: campaign.id, views: 900 } })
    const { personId } = await linkProfile({ memberInfluencerId: member.id, profileInfluencerId: tiktok.id, actor: PM, evidence: 'pm_confirmed' })

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      // Everything happens inside ONE transaction that is rolled back at the end
      await client.query('BEGIN')
      const pushed = await shape(client)
      const has = (s: Awaited<ReturnType<typeof shape>>, key: string) => s.columns.some(c => `${c.table_name}.${c.column_name}` === key)
      for (const key of NEW_COLUMNS) expect(has(pushed, key), key).toBe(true)

      // 1. The inverse script brings the database to its shape before this delivery
      for (const stmt of statements('2026-11-12-person-profiles.down.sql')) await client.query(stmt)
      const before = await shape(client)
      for (const key of NEW_COLUMNS) expect(has(before, key), key).toBe(false)
      expect(before.columns.some(c => c.table_name === 'persons' || c.table_name === 'person_logs')).toBe(false)
      const counts = async () => (await client.query(
        `SELECT (SELECT count(*) FROM influencers)::int AS influencers, (SELECT count(*) FROM campaign_influencers)::int AS memberships,
                (SELECT count(*) FROM media)::int AS media, (SELECT count(*) FROM campaigns)::int AS campaigns,
                (SELECT sum(views) FROM media)::int AS views, (SELECT sum("agreedFee") FROM campaign_influencers)::int AS fees`
      )).rows[0]
      const rowsBefore = await counts()
      expect(rowsBefore).toEqual({ influencers: 2, memberships: 1, media: 1, campaigns: 1, views: 900, fees: 200 })

      // 2. The additive script applies on top of existing rows...
      for (const stmt of statements('2026-11-12-person-profiles.sql')) await client.query(stmt)

      // ...loses nothing, leaves the new columns empty...
      expect(await counts()).toEqual(rowsBefore)
      const filled = await client.query(
        `SELECT (SELECT count(*) FROM influencers WHERE "personId" IS NOT NULL OR "addedById" IS NOT NULL OR "addedByName" IS NOT NULL)::int AS influencers,
                (SELECT count(*) FROM media WHERE "publishedByInfluencerId" IS NOT NULL)::int AS media,
                (SELECT count(*) FROM campaign_influencers WHERE "addedById" IS NOT NULL OR "addedByName" IS NOT NULL)::int AS memberships,
                (SELECT count(*) FROM persons)::int AS persons, (SELECT count(*) FROM person_logs)::int AS logs`
      )
      expect(filled.rows[0]).toEqual({ influencers: 0, media: 0, memberships: 0, persons: 0, logs: 0 })

      // ...and ends exactly where `prisma db push` of the current schema ends
      expect(await shape(client)).toEqual(pushed)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end()
    }

    // The rehearsal left the test database untouched
    expect((await prisma.influencer.findUniqueOrThrow({ where: { id: tiktok.id } })).personId).toBe(personId)
    expect(await prisma.personLog.count()).toBe(1)
  })
})
