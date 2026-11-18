/**
 * «Creadoras en Prospecto: la captura no las lee» (review of 16 Nov 2026,
 * point 5): the notice on the campaign page comes from GET /api/campaigns/[id]
 * (captureNotice, staff only) and the weekly notification from the watchdog,
 * both from the one rule of src/lib/prospect-notice.ts.
 *
 *  - GET: a campaign started 16 days ago with 33 of 33 in PROSPECT carries the
 *    notice and the other profiles of each member (memberProfiles); a brand
 *    gets neither; the overview keeps its keys.
 *  - watchdog: the team (creator + assigned PMs) and every active ADMIN are
 *    told once, each person once; not again before 7 days; again after; the
 *    setting is cleared when the notice no longer applies.
 *
 * No network: Apify is mocked out.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ session: null as null | { id: string; email: string; name: string; role: string } }))

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
    checkApifyAuth: vi.fn(async () => 'ok'),
  }
})
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { InfluencerStatus } from '@/generated/prisma/client'
import { GET as campaignGET } from '@/app/api/campaigns/[id]/route'
import { GET as watchdogGET } from '@/app/api/cron/watchdog/route'
import { linkProfile } from '@/lib/person-profiles'
import { PROSPECT_NOTICE_TYPE, prospectNoticeSettingKey } from '@/lib/prospect-notice'

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignAssignment.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(async () => {
  await reset()
  net.session = null
  delete process.env.CRON_SECRET
})
afterAll(reset)

const DAY = 86_400_000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY)
const daysAhead = (n: number) => new Date(Date.now() + n * DAY)

async function user(role: 'ADMIN' | 'EMPLOYEE' | 'BRAND', name: string, isActive = true) {
  return prisma.user.create({ data: { email: `${name.toLowerCase().replace(/\s+/g, '.')}-${Math.random()}@example.test`, password: 'x', name, role, isActive } })
}

/** «Micros Noviembre»-like: started 16 days ago, 33 Instagram members, all PROSPECT unless told otherwise. */
async function microsNoviembre(ownerId: string, statuses: InfluencerStatus[] = Array.from({ length: 33 }, () => 'PROSPECT' as const), over: Record<string, unknown> = {}) {
  const campaign = await prisma.campaign.create({
    data: {
      name: '11.- Marca Demo - Micros Noviembre (test)', status: 'ACTIVE',
      startDate: daysAgo(16), endDate: daysAhead(14),
      targetAccounts: ['marca.demo'], targetHashtags: [], targetKeywords: [], platforms: ['INSTAGRAM', 'TIKTOK'], userId: ownerId,
      ...over,
    },
  })
  const members = []
  const prefix = `micro_demo_${Math.random().toString(36).slice(2, 7)}`
  for (let i = 0; i < statuses.length; i++) {
    const row = await prisma.influencer.create({ data: { username: `${prefix}_${i}`, platform: 'INSTAGRAM', followers: 2000 + i } })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: row.id, status: statuses[i] } })
    members.push(row)
  }
  return { campaign, members }
}

async function getCampaign(id: string) {
  const res = await campaignGET(new NextRequest(`http://localhost/api/campaigns/${id}`), { params: Promise.resolve({ id }) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function watchdog() {
  const res = await watchdogGET(new NextRequest('http://localhost/api/cron/watchdog'))
  return (await res.json()) as Record<string, unknown>
}

const prospectNotices = () => prisma.notification.findMany({ where: { type: PROSPECT_NOTICE_TYPE }, orderBy: { userId: 'asc' } })

describe('GET /api/campaigns/[id]: captureNotice and memberProfiles', () => {
  it('carries the notice for a campaign 16 days in with 33 of 33 in PROSPECT, and the linked TikTok of a member', async () => {
    const pm = await user('EMPLOYEE', 'Laura PM')
    const { campaign, members } = await microsNoviembre(pm.id)
    const tiktok = await prisma.influencer.create({ data: { username: 'micro.tt', platform: 'TIKTOK' } })
    await linkProfile({ memberInfluencerId: members[0].id, profileInfluencerId: tiktok.id, actor: { id: pm.id, name: pm.name }, evidence: 'pm_manual' })

    net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const { status, body } = await getCampaign(campaign.id)
    expect(status).toBe(200)
    expect(body.captureNotice).toEqual({ members: 33, prospects: 33, scanning: 0, startedDays: 16 })
    expect(body.memberProfiles).toEqual({ [members[0].id]: [{ id: tiktok.id, username: 'micro.tt', platform: 'TIKTOK' }] })
    // Added beside the overview, never inside it
    expect(body.overview).not.toHaveProperty('captureNotice')
    expect(body.overview).not.toHaveProperty('memberProfiles')
  })

  it('no notice for Dorco-like statuses (22 CONTRACTED + 6 POSTED), for a campaign 2 days in, or for a brand', async () => {
    const pm = await user('EMPLOYEE', 'Laura PM')
    net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const dorco = await microsNoviembre(pm.id, [...Array.from({ length: 22 }, () => 'CONTRACTED' as const), ...Array.from({ length: 6 }, () => 'POSTED' as const)], { name: 'Dorco - Demo (test)' })
    expect((await getCampaign(dorco.campaign.id)).body.captureNotice).toBeNull()
    const young = await microsNoviembre(pm.id, ['PROSPECT', 'PROSPECT'], { name: 'Joven (test)', startDate: daysAgo(2) })
    expect((await getCampaign(young.campaign.id)).body.captureNotice).toBeNull()

    const brand = await user('BRAND', 'Cliente Demo')
    const theirs = await microsNoviembre(brand.id)
    net.session = { id: brand.id, email: brand.email, name: brand.name, role: 'BRAND' }
    const { status, body } = await getCampaign(theirs.campaign.id)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('captureNotice')
    expect(body).not.toHaveProperty('memberProfiles')
  })

  it('no notice for a paused or closed campaign in dates with everybody in PROSPECT: no cron reads it (18 Nov 2026)', async () => {
    const pm = await user('EMPLOYEE', 'Laura PM')
    net.session = { id: pm.id, email: pm.email, name: pm.name, role: 'EMPLOYEE' }
    const paused = await microsNoviembre(pm.id, undefined, { name: 'Pausada (test)', status: 'PAUSED' })
    const { status, body } = await getCampaign(paused.campaign.id)
    expect(status).toBe(200)
    expect(body.captureNotice).toBeNull()
    // The field is still there for the staff (null), only its value changes
    expect(body).toHaveProperty('captureNotice')
    const closed = await microsNoviembre(pm.id, undefined, { name: 'Archivada (test)', status: 'ARCHIVED' })
    expect((await getCampaign(closed.campaign.id)).body.captureNotice).toBeNull()
  })
})

describe('watchdog: the weekly notice to the team and the ADMINs', () => {
  it('tells the creator of the campaign, the assigned PMs and every active ADMIN once each; not the inactive ADMIN nor an unrelated PM', async () => {
    const owner = await user('EMPLOYEE', 'Laura PM')
    const assigned = await user('EMPLOYEE', 'Carla PM')
    const unrelated = await user('EMPLOYEE', 'Nadia PM')
    const admin = await user('ADMIN', 'Ada Admin')
    const ownerAdmin = await user('ADMIN', 'Owner Admin') // creator of the campaign AND admin: told once
    const inactive = await user('ADMIN', 'Ex Admin', false)
    const { campaign } = await microsNoviembre(ownerAdmin.id)
    await prisma.campaignAssignment.create({ data: { campaignId: campaign.id, userId: assigned.id } })
    await prisma.campaignAssignment.create({ data: { campaignId: campaign.id, userId: owner.id } })
    // Another live campaign whose creators are confirmed: no notice for it
    await microsNoviembre(owner.id, ['CONTRACTED', 'POSTED', 'CONTRACTED'], { name: 'Dorco - Demo (test)' })

    const body = await watchdog()
    expect(body.ok).toBe(true)
    const notices = body.prospectNotices as Array<Record<string, unknown>>
    expect(notices).toEqual([{ campaignId: campaign.id, name: campaign.name, notice: { members: 33, prospects: 33, scanning: 0, startedDays: 16 }, notified: true, lastNoticeAt: null, recipients: 4 }])

    const rows = await prospectNotices()
    expect(rows.map(r => r.userId).sort()).toEqual([owner.id, assigned.id, admin.id, ownerAdmin.id].sort())
    expect(rows.every(r => r.title === 'Creadoras en Prospecto: la captura no las lee')).toBe(true)
    expect(rows[0].message).toContain(`En "${campaign.name}", la captura automática (publicaciones, stories, TikTok) solo lee creadoras en Acordado o posterior: 33 de 33 están en Prospecto.`)
    expect(rows[0].message).toContain('Cambia el estado en Elegir')
    expect(rows[0].link).toBe(`/campaigns/${campaign.id}`)
    expect(rows.some(r => r.userId === unrelated.id || r.userId === inactive.id)).toBe(false)
    const stamp = await prisma.setting.findUniqueOrThrow({ where: { key: prospectNoticeSettingKey(campaign.id) } })
    expect(Date.now() - Date.parse(stamp.value)).toBeLessThan(60_000)
  })

  it('does not repeat before 7 days, repeats after, and clears the setting once the creators are confirmed', async () => {
    const owner = await user('EMPLOYEE', 'Laura PM')
    await user('ADMIN', 'Ada Admin')
    const { campaign } = await microsNoviembre(owner.id)

    expect(((await watchdog()).prospectNotices as Array<{ notified: boolean }>)[0].notified).toBe(true)
    expect(await prospectNotices()).toHaveLength(2)

    // The next tick, and the next days: told already
    const again = (await watchdog()).prospectNotices as Array<{ notified: boolean; lastNoticeAt: string | null }>
    expect(again[0]).toMatchObject({ notified: false })
    expect(again[0].lastNoticeAt).not.toBeNull()
    expect(await prospectNotices()).toHaveLength(2)

    // Eight days later the notice persists: told again
    await prisma.setting.update({ where: { key: prospectNoticeSettingKey(campaign.id) }, data: { value: daysAgo(8).toISOString() } })
    expect(((await watchdog()).prospectNotices as Array<{ notified: boolean }>)[0].notified).toBe(true)
    expect(await prospectNotices()).toHaveLength(4)

    // The PM confirms the creators: no notice, the setting is cleared so a relapse is told at once
    await prisma.campaignInfluencer.updateMany({ where: { campaignId: campaign.id }, data: { status: 'CONTRACTED' } })
    const cleared = await watchdog()
    expect(cleared.prospectNotices).toEqual([])
    expect(await prisma.setting.findUnique({ where: { key: prospectNoticeSettingKey(campaign.id) } })).toBeNull()
    expect(await prospectNotices()).toHaveLength(4)
  })

  it('a Social Listening campaign and one that ended are never the subject of the notice', async () => {
    const owner = await user('EMPLOYEE', 'Laura PM')
    await user('ADMIN', 'Ada Admin')
    await microsNoviembre(owner.id, ['PROSPECT', 'PROSPECT', 'PROSPECT'], { name: 'Contratos anuales (test)', type: 'SOCIAL_LISTENING', endDate: null })
    await microsNoviembre(owner.id, ['PROSPECT', 'PROSPECT'], { name: 'Octubre (test)', startDate: daysAgo(40), endDate: daysAgo(5) })
    const body = await watchdog()
    expect(body.prospectNotices).toEqual([])
    expect(await prospectNotices()).toHaveLength(0)
  })
})
