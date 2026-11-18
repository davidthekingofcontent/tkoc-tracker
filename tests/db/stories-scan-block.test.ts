/**
 * GET /api/campaigns/[id]/stories (revisión semanal 16 nov 2026, point 1).
 *
 * The answer carries a `scan` block that says what the automatic scan does
 * with the campaign today, with the same rule the stories cron applies
 * (storiesCampaignSkipReason): the skip reason, how many Instagram creators
 * are in Acordado or later, when the last run was and what it did with this
 * campaign. Until now the tab showed nothing, and a campaign without brand
 * targets or with everybody in Prospecto looked like a scan with no stories.
 *
 * Every story also says how many days ago it was published (daysSincePosted):
 * what expires after 24 h is the story on Instagram, not its row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-stories-scan'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { GET } from '@/app/api/campaigns/[id]/stories/route'

const tag = randomUUID().slice(0, 8)
const DAY = 24 * 60 * 60_000
const fx = { admin: '', token: '', campaigns: [] as string[], creators: [] as string[] }

async function get(campaignId: string) {
  const req = new NextRequest(`http://localhost/api/campaigns/${campaignId}/stories`, {
    headers: { authorization: `Bearer ${fx.token}` },
  })
  const res = await GET(req, { params: Promise.resolve({ id: campaignId }) })
  return { status: res.status, body: await res.json() }
}

interface CampaignSpec {
  type?: 'INFLUENCER_TRACKING' | 'UGC' | 'SOCIAL_LISTENING'
  status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  start?: Date
  end?: Date | null
  targets?: string[]
  members?: Array<{ status: 'PROSPECT' | 'CONTRACTED' | 'POSTED'; platform?: 'INSTAGRAM' | 'TIKTOK' }>
}

async function campaign(spec: CampaignSpec): Promise<string> {
  const c = await prisma.campaign.create({
    data: {
      name: `Scan ${tag} ${fx.campaigns.length}`,
      status: spec.status ?? 'ACTIVE',
      type: spec.type ?? 'INFLUENCER_TRACKING',
      platforms: ['INSTAGRAM'],
      startDate: spec.start ?? new Date(Date.now() - 20 * DAY),
      endDate: spec.end === undefined ? new Date(Date.now() + 20 * DAY) : spec.end,
      targetAccounts: spec.targets ?? ['marca.demo'],
      userId: fx.admin,
    },
  })
  fx.campaigns.push(c.id)
  for (const [i, m] of (spec.members ?? []).entries()) {
    const creator = await prisma.influencer.create({ data: { username: `scan_${tag}_${fx.campaigns.length}_${i}`, platform: m.platform ?? 'INSTAGRAM' } })
    fx.creators.push(creator.id)
    await prisma.campaignInfluencer.create({ data: { campaignId: c.id, influencerId: creator.id, status: m.status } })
  }
  return c.id
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-scan-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Scan', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
})

afterAll(async () => {
  await prisma.media.deleteMany({ where: { campaignId: { in: fx.campaigns } } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: { in: fx.campaigns } } })
  await prisma.campaign.deleteMany({ where: { id: { in: fx.campaigns } } })
  await prisma.influencer.deleteMany({ where: { id: { in: fx.creators } } })
  await prisma.setting.deleteMany({ where: { key: { in: ['cron_stories_last_run', 'cron_stories_last_result'] } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('the scan block says why the campaign is not scanned, with the rule of the cron', () => {
  it('no_targets: a campaign in dates without brand accounts, hashtags or keywords', async () => {
    const id = await campaign({ targets: [], members: [{ status: 'CONTRACTED' }] })
    const { status, body } = await get(id)
    expect(status).toBe(200)
    expect(body.scan).toMatchObject({ reason: 'no_targets', confirmedCreators: 1, instagramCreators: 1, maxCampaignDays: 100 })
  })

  it('too_long: with targets but no end date (the UGC campaigns of November), or longer than the cap', async () => {
    const open = await campaign({ end: null, members: [{ status: 'POSTED' }] })
    expect((await get(open)).body.scan.reason).toBe('too_long')
    const long = await campaign({ start: new Date(Date.now() - 10 * DAY), end: new Date(Date.now() + 150 * DAY) })
    expect((await get(long)).body.scan.reason).toBe('too_long')
  })

  it('listening: a Social Listening campaign, whatever its targets and creators', async () => {
    const id = await campaign({ type: 'SOCIAL_LISTENING', members: [{ status: 'CONTRACTED' }] })
    expect((await get(id)).body.scan.reason).toBe('listening')
  })

  it('window: a campaign whose dates do not include today', async () => {
    const ended = await campaign({ start: new Date(Date.now() - 60 * DAY), end: new Date(Date.now() - 10 * DAY), members: [{ status: 'POSTED' }] })
    expect((await get(ended)).body.scan.reason).toBe('window')
    const future = await campaign({ start: new Date(Date.now() + 5 * DAY), end: new Date(Date.now() + 30 * DAY) })
    expect((await get(future)).body.scan.reason).toBe('window')
  })

  it('inactive: a paused or closed campaign in dates is read by no cron, whatever its targets or creators say (18 Nov 2026)', async () => {
    const paused = await campaign({ status: 'PAUSED', members: [{ status: 'CONTRACTED' }] })
    expect((await get(paused)).body.scan).toMatchObject({ reason: 'inactive', confirmedCreators: 1, instagramCreators: 1 })
    // Archived, and without targets too: the status comes first
    const closed = await campaign({ status: 'ARCHIVED', targets: [], members: [{ status: 'CONTRACTED' }] })
    expect((await get(closed)).body.scan.reason).toBe('inactive')
  })

  it('hasEndDate tells the tab whether a too_long campaign needs an end date or a shorter one', async () => {
    const open = await campaign({ end: null, members: [{ status: 'POSTED' }] })
    expect((await get(open)).body.scan).toMatchObject({ reason: 'too_long', hasEndDate: false })
    const long = await campaign({ start: new Date(Date.now() - 10 * DAY), end: new Date(Date.now() + 120 * DAY), members: [{ status: 'POSTED' }] })
    expect((await get(long)).body.scan).toMatchObject({ reason: 'too_long', hasEndDate: true })
    const fine = await campaign({ members: [{ status: 'POSTED' }] })
    expect((await get(fine)).body.scan).toMatchObject({ reason: null, hasEndDate: true })
  })

  it('no reason but nobody confirmed: every Instagram creator still in Prospecto (0 de N)', async () => {
    const id = await campaign({ members: [{ status: 'PROSPECT' }, { status: 'PROSPECT' }, { status: 'PROSPECT' }, { status: 'CONTRACTED', platform: 'TIKTOK' }] })
    const { scan } = (await get(id)).body
    // The TikTok member does not count: stories are scanned on Instagram only
    expect(scan).toMatchObject({ reason: null, confirmedCreators: 0, instagramCreators: 3 })
  })

  it('scanned: creators in Acordado or later are counted, the rest are not', async () => {
    const id = await campaign({ members: [{ status: 'CONTRACTED' }, { status: 'POSTED' }, { status: 'PROSPECT' }] })
    const { scan } = (await get(id)).body
    expect(scan).toMatchObject({ reason: null, confirmedCreators: 2, instagramCreators: 3 })
  })

  it('an unknown campaign has no scan block and no stories', async () => {
    const { status, body } = await get(`no-existe-${tag}`)
    expect(status).toBe(200)
    expect(body.scan).toBeNull()
    expect(body.stories).toEqual([])
  })
})

describe('the last run (settings cron_stories_last_run and cron_stories_last_result)', () => {
  it('is null before any run', async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['cron_stories_last_run', 'cron_stories_last_result'] } } })
    const id = await campaign({ members: [{ status: 'CONTRACTED' }] })
    const { scan } = (await get(id)).body
    expect(scan.lastRunAt).toBeNull()
    expect(scan.lastResultForCampaign).toBeNull()
    expect(scan.scannedCreators).toBeNull()
  })

  it('tells when it ran and what it did with THIS campaign: scanned, skipped, or not mentioned', async () => {
    const scanned = await campaign({ members: [{ status: 'CONTRACTED' }] })
    const skipped = await campaign({ targets: [], members: [{ status: 'CONTRACTED' }] })
    const absent = await campaign({ members: [{ status: 'CONTRACTED' }] })
    const at = '2026-11-16T11:04:23.000Z'
    await prisma.setting.upsert({ where: { key: 'cron_stories_last_run' }, update: { value: at }, create: { key: 'cron_stories_last_run', value: at } })
    const result = JSON.stringify({
      at,
      usernamesChecked: 9,
      totalStories: 12,
      newStories: 2,
      campaigns: [{ id: scanned, name: 'Scanned', creators: 8, newStories: 2 }],
      skipped: [{ id: skipped, name: 'Skipped', reason: 'no_targets', detail: 'no tiene …' }],
    })
    await prisma.setting.upsert({ where: { key: 'cron_stories_last_result' }, update: { value: result }, create: { key: 'cron_stories_last_result', value: result } })

    const a = (await get(scanned)).body.scan
    expect(a.lastRunAt).toBe(at)
    expect(a.scannedCreators).toBe(8)
    expect(a.lastResultForCampaign).toEqual({ at, failed: false, scanned: true, creators: 8, newStories: 2, reason: null })

    const b = (await get(skipped)).body.scan
    expect(b.scannedCreators).toBeNull()
    expect(b.lastResultForCampaign).toEqual({ at, failed: false, scanned: false, creators: null, newStories: null, reason: 'no_targets' })

    const c = (await get(absent)).body.scan
    expect(c.lastRunAt).toBe(at)
    expect(c.lastResultForCampaign).toBeNull()
  })
})

describe('«Publicada hace N días»: a story never expires in the report', () => {
  it('says how many days ago each story was published, in the list and in the per-creator groups; the first 24 h are still "active"', async () => {
    const id = await campaign({ members: [{ status: 'POSTED' }] })
    const creator = fx.creators[fx.creators.length - 1]
    await prisma.media.createMany({
      data: [
        { externalId: `live-${tag}`, platform: 'INSTAGRAM', mediaType: 'STORY', influencerId: creator, campaignId: id, postedAt: new Date(Date.now() - 2 * 60 * 60_000), views: 10, source: 'manual' },
        { externalId: `old-${tag}`, platform: 'INSTAGRAM', mediaType: 'STORY', influencerId: creator, campaignId: id, postedAt: new Date(Date.now() - 3 * DAY - 60_000), views: 20, source: 'apify' },
        { externalId: `undated-${tag}`, platform: 'INSTAGRAM', mediaType: 'STORY', influencerId: creator, campaignId: id, postedAt: null, views: 0, source: 'manual' },
      ],
    })
    const { body } = await get(id)
    const byId = Object.fromEntries((body.stories as Array<{ externalId: string }>).map(s => [s.externalId, s]))
    expect(byId[`live-${tag}`]).toMatchObject({ isActive: true, daysSincePosted: 0 })
    expect(byId[`old-${tag}`]).toMatchObject({ isActive: false, daysSincePosted: 3 })
    expect(byId[`undated-${tag}`]).toMatchObject({ isActive: false, daysSincePosted: null, expiresAt: null })
    expect(body.stats).toMatchObject({ total: 3, active: 1, expired: 2 })

    // The per-creator groups carry the same fields (they used to be the raw rows: every card looked expired)
    const group = (body.byInfluencer as Array<{ influencer: { id: string }; stories: Array<{ externalId: string; isActive: boolean; daysSincePosted: number | null }> }>)
      .find(g => g.influencer.id === creator)
    expect(group).toBeTruthy()
    const live = group!.stories.find(s => s.externalId === `live-${tag}`)
    expect(live).toMatchObject({ isActive: true, daysSincePosted: 0 })
    expect(group!.stories.find(s => s.externalId === `old-${tag}`)).toMatchObject({ isActive: false, daysSincePosted: 3 })
  })
})
