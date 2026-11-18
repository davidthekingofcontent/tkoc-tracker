/**
 * «Stories sin rastrear» from the stories cron (revisión semanal 16 nov 2026,
 * point 1): repeated every 7 days while the reason persists, sent to the
 * campaign team AND the active ADMINs (each person once), and a second reason:
 * a campaign in dates with brand targets whose Instagram creators are all
 * still before Acordado three days after its start («0 de N»).
 *
 * The network is mocked: the stories actor answers nothing, Apify is fine.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    checkApifyAuth: vi.fn(async () => 'ok'),
    isApifyConfiguredAsync: vi.fn(async () => true),
    isApifyExhausted: vi.fn(() => false),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usd: 1, coreLimit: 100, usedPct: 10, cycleEndsAt: null })),
    scrapeStoriesDetailed: vi.fn(async () => ({ results: [], partial: false, failed: false })),
    STORIES_BATCH_MAX: 100,
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
  }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { scrapeStoriesDetailed } from '@/lib/apify'
import { GET } from '@/app/api/cron/stories/route'
import { parseStoriesNotice, storiesNoticeKey } from '@/lib/stories-notices'

const DAY = 24 * 60 * 60_000
const TITLE = 'Stories sin rastrear'

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

interface People { pm: string; admin: string; inactiveAdmin: string; outsider: string }
let people: People

async function seedPeople(): Promise<People> {
  const user = (name: string, role: 'ADMIN' | 'EMPLOYEE', isActive = true) =>
    prisma.user.create({ data: { email: `${name}-${Date.now()}-${Math.random()}@example.test`, password: 'x', name, role, isActive } })
  const [pm, admin, inactiveAdmin, outsider] = await Promise.all([user('Laura PM', 'EMPLOYEE'), user('Admin', 'ADMIN'), user('Antiguo Admin', 'ADMIN', false), user('Otra PM', 'EMPLOYEE')])
  return { pm: pm.id, admin: admin.id, inactiveAdmin: inactiveAdmin.id, outsider: outsider.id }
}

interface CampaignSpec {
  name?: string
  type?: 'INFLUENCER_TRACKING' | 'UGC' | 'SOCIAL_LISTENING'
  start?: Date
  end?: Date | null
  targets?: string[]
  members?: Array<'PROSPECT' | 'CONTRACTED' | 'POSTED'>
}

let seq = 0
async function campaign(spec: CampaignSpec) {
  seq++
  const c = await prisma.campaign.create({
    data: {
      name: spec.name ?? `Campaña ${seq}`,
      status: 'ACTIVE',
      type: spec.type ?? 'INFLUENCER_TRACKING',
      platforms: ['INSTAGRAM'],
      startDate: spec.start ?? new Date(Date.now() - 10 * DAY),
      endDate: spec.end === undefined ? new Date(Date.now() + 20 * DAY) : spec.end,
      targetAccounts: spec.targets ?? ['marca.demo'],
      userId: people.pm,
    },
  })
  for (const [i, status] of (spec.members ?? []).entries()) {
    const creator = await prisma.influencer.create({ data: { username: `creadora_${seq}_${i}`, platform: 'INSTAGRAM' } })
    await prisma.campaignInfluencer.create({ data: { campaignId: c.id, influencerId: creator.id, status } })
  }
  return c
}

async function run() {
  const res = await GET(new NextRequest('http://localhost/api/cron/stories?force=1'))
  expect(res.status).toBe(200)
  return res.json()
}

const notices = (campaignId?: string) =>
  prisma.notification.findMany({
    where: { title: TITLE, ...(campaignId && { link: `/campaigns/${campaignId}` }) },
    select: { userId: true, message: true, link: true, type: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
const stored = async (campaignId: string) => parseStoriesNotice((await prisma.setting.findUnique({ where: { key: storiesNoticeKey(campaignId) } }))?.value)
async function stamp(campaignId: string, reason: string, at: Date | null) {
  const key = storiesNoticeKey(campaignId)
  const value = at ? JSON.stringify({ reason, at: at.toISOString() }) : reason
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

beforeEach(async () => {
  await reset()
  vi.mocked(scrapeStoriesDetailed).mockClear()
  delete process.env.CRON_SECRET
  people = await seedPeople()
})
afterAll(reset)

describe('a live campaign with confirmed creators left out of the scan', () => {
  it('is told to the team and the active ADMINs, each once, and the setting remembers the reason and the date', async () => {
    const c = await campaign({ name: '11. VILEDA - UGC NOVIEMBRE', targets: [], members: ['CONTRACTED', 'POSTED'] })
    const before = Date.now()
    const summary = await run()

    const rows = await notices(c.id)
    expect(rows.map(r => r.userId).sort()).toEqual([people.admin, people.pm].sort())
    for (const row of rows) {
      expect(row.type).toBe('cron_stale')
      // Product keywords count as a target too (campaignHasTargets): the notice names the three kinds
      expect(row.message).toBe('Las stories de "11. VILEDA - UGC NOVIEMBRE" no se están rastreando: no tiene Cuentas de Marca Objetivo, hashtags ni palabras clave del producto; añade al menos uno en Editar campaña para que sus stories entren.')
    }
    const record = await stored(c.id)
    expect(record?.reason).toBe('no_targets')
    expect(Date.parse(record!.at!)).toBeGreaterThanOrEqual(before - 1000)
    expect(summary.noticesSent).toEqual([{ id: c.id, name: '11. VILEDA - UGC NOVIEMBRE', reason: 'no_targets' }])
    const last = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'cron_stories_last_result' } })).value)
    expect(last.noticesSent).toEqual(summary.noticesSent)
    expect(last.skipped).toEqual([expect.objectContaining({ id: c.id, reason: 'no_targets' })])
  })

  it('an ADMIN who is also on the team gets it once', async () => {
    const c = await campaign({ targets: [], members: ['CONTRACTED'] })
    await prisma.campaignAssignment.create({ data: { campaignId: c.id, userId: people.admin } })
    await run()
    expect((await notices(c.id)).map(r => r.userId).sort()).toEqual([people.admin, people.pm].sort())
  })

  it('is repeated after 7 days while the reason persists, not before', async () => {
    const c = await campaign({ targets: [], members: ['CONTRACTED'] })
    await run()
    expect(await notices(c.id)).toHaveLength(2)

    // The next ticks of the same week: silent
    await run()
    await stamp(c.id, 'no_targets', new Date(Date.now() - 6 * DAY))
    await run()
    expect(await notices(c.id)).toHaveLength(2)

    // A week after the last notice: told again, and the date moves
    await stamp(c.id, 'no_targets', new Date(Date.now() - 7 * DAY - 60_000))
    const summary = await run()
    expect(await notices(c.id)).toHaveLength(4)
    expect(summary.noticesSent).toEqual([expect.objectContaining({ id: c.id, reason: 'no_targets' })])
    expect(Date.now() - Date.parse((await stored(c.id))!.at!)).toBeLessThan(60_000)
  })

  it('a notice stored before 16 Nov 2026 (the reason alone) is sent again now and upgraded', async () => {
    const c = await campaign({ targets: [], members: ['CONTRACTED'] })
    await stamp(c.id, 'no_targets', null)
    await run()
    expect(await notices(c.id)).toHaveLength(2)
    expect((await stored(c.id))?.at).toBeTruthy()
  })

  it('a change of reason is told at once', async () => {
    const c = await campaign({ targets: [], members: ['CONTRACTED'] })
    await run()
    expect(await notices(c.id)).toHaveLength(2)
    // The PM adds the brand account but the campaign has no end date: another reason
    await prisma.campaign.update({ where: { id: c.id }, data: { targetAccounts: ['marca.demo'], endDate: null } })
    await run()
    const rows = await notices(c.id)
    expect(rows).toHaveLength(4)
    expect(rows[3].message).toContain('no tiene fecha de fin')
    expect((await stored(c.id))?.reason).toBe('too_long')
  })

  it('a Social Listening campaign and a campaign outside its dates: the first is told, the second is not a gap', async () => {
    const listening = await campaign({ type: 'SOCIAL_LISTENING', members: ['CONTRACTED'] })
    const ended = await campaign({ start: new Date(Date.now() - 60 * DAY), end: new Date(Date.now() - 5 * DAY), members: ['CONTRACTED'] })
    await run()
    expect((await notices(listening.id)).map(r => r.message)).toEqual(expect.arrayContaining([expect.stringContaining('Social Listening')]))
    expect(await notices(ended.id)).toEqual([])
  })

  it('a campaign without confirmed creators that is also out of the scan is not told twice over', async () => {
    // No targets AND nobody confirmed: the skip reason is what the PM must fix first; nobody is told for an empty roster
    const c = await campaign({ targets: [], members: ['PROSPECT'] })
    await run()
    expect(await notices(c.id)).toEqual([])
  })
})

describe('the second reason: scanned, but nobody in Acordado or later', () => {
  it('is told three days after the start with «0 de N», weekly, and not before three days', async () => {
    const micros = await campaign({ name: '11.- Vileda - Micros Noviembre', start: new Date(Date.now() - 4 * DAY), members: ['PROSPECT', 'PROSPECT', 'PROSPECT'] })
    const fresh = await campaign({ name: 'Recién creada', start: new Date(Date.now() - 1 * DAY), members: ['PROSPECT', 'PROSPECT'] })
    const summary = await run()

    const rows = await notices(micros.id)
    expect(rows.map(r => r.userId).sort()).toEqual([people.admin, people.pm].sort())
    expect(rows[0].message).toBe('Las stories de "11.- Vileda - Micros Noviembre" no se están rastreando: la captura automática solo lee creadoras en Acordado o posterior y tiene 0 de 3 en esos estados; cambia su estado en Elegir.')
    expect(await notices(fresh.id)).toEqual([])
    expect((await stored(micros.id))?.reason).toBe('no_confirmed')
    expect(summary.noticesSent).toEqual([{ id: micros.id, name: '11.- Vileda - Micros Noviembre', reason: 'no_confirmed' }])
    // The campaign is scanned (with nobody to read): it is in the scanned list, not among the skipped
    const last = JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key: 'cron_stories_last_result' } })).value)
    expect(last.campaigns).toEqual(expect.arrayContaining([expect.objectContaining({ id: micros.id, creators: 0 })]))
    expect(last.skipped).toEqual([])

    // The next tick: the setting is kept (it is not cleared for a scanned campaign that still has nobody) and nothing is repeated
    await run()
    expect(await notices(micros.id)).toHaveLength(2)
    expect((await stored(micros.id))?.reason).toBe('no_confirmed')

    // A week later: repeated
    await stamp(micros.id, 'no_confirmed', new Date(Date.now() - 8 * DAY))
    await run()
    expect(await notices(micros.id)).toHaveLength(4)
  })

  it('is not told for a campaign with a confirmed creator, and the setting is cleared once somebody is confirmed', async () => {
    const c = await campaign({ start: new Date(Date.now() - 10 * DAY), members: ['PROSPECT', 'PROSPECT'] })
    await run()
    expect(await notices(c.id)).toHaveLength(2)

    // The PM moves one creator to Contratada: scanned for real, the notice is cleared
    const member = await prisma.campaignInfluencer.findFirstOrThrow({ where: { campaignId: c.id } })
    await prisma.campaignInfluencer.update({ where: { id: member.id }, data: { status: 'CONTRACTED' } })
    await run()
    expect(vi.mocked(scrapeStoriesDetailed)).toHaveBeenCalledTimes(1)
    expect(await stored(c.id)).toBeNull()
    expect(await notices(c.id)).toHaveLength(2)

    // She goes back to Prospecto (a mistake): told again at once, not a week later
    await prisma.campaignInfluencer.update({ where: { id: member.id }, data: { status: 'PROSPECT' } })
    await run()
    expect(await notices(c.id)).toHaveLength(4)
  })

  it('nobody active to tell: tried again on the next tick that has someone', async () => {
    const c = await campaign({ start: new Date(Date.now() - 10 * DAY), members: ['PROSPECT'] })
    await prisma.user.updateMany({ where: { id: { in: [people.pm, people.admin] } }, data: { isActive: false } })
    await run()
    expect(await notices(c.id)).toEqual([])
    expect(await stored(c.id)).toBeNull()

    await prisma.user.updateMany({ where: { id: { in: [people.pm, people.admin] } }, data: { isActive: true } })
    await run()
    expect(await notices(c.id)).toHaveLength(2)
  })
})
