/**
 * /api/admin/person-merge, through the real route handler, on a throwaway
 * database. These tests prove:
 *   - 401 without a session and 403 for EMPLOYEE, BRAND and CREATOR on every
 *     method and action, and nothing changes;
 *   - for an ADMIN: the candidates (with the campaign filter and its name),
 *     the banner count, preview, apply, a stale apply (409), a choice missing
 *     (409 with the missing choices), undo (with the differences on 409 and
 *     `force`), dismiss, and the history;
 *   - bad bodies answer 400 and unknown records 404, never 500.
 * Every handle and figure is invented.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  session: null as null | { id: string; email: string; name: string; role: string },
}))

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

// The session is the test's; the role rule (isStaffRole) is the real one
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { GET, POST } from '@/app/api/admin/person-merge/route'

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

type Row = Record<string, unknown>
async function snapshot() {
  const out: Record<string, Row[]> = {}
  for (const t of ['campaign_influencers', 'media', 'campaign_notes', 'influencers', 'persons', 'person_logs', 'settings']) {
    const rows = await prisma.$queryRaw<Array<{ row: unknown }>>`SELECT row_to_json(x.*) AS row FROM ${Prisma.raw(`"${t}"`)} x ORDER BY x.id`
    out[t] = rows.map(r => (typeof r.row === 'string' ? JSON.parse(r.row) : r.row) as Row)
  }
  return out
}

async function seed() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const admin = await prisma.user.create({ data: { email: `admin-${stamp}@example.test`, password: 'x', name: 'Ada Admin', role: 'ADMIN' } })
  const employee = await prisma.user.create({ data: { email: `pm-${stamp}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const oct = await prisma.campaign.create({
    data: { name: 'Micros Octubre (prueba)', startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'), platforms: ['INSTAGRAM', 'TIKTOK'], targetHashtags: ['marcademo'], userId: admin.id },
  })
  const danaIg = await prisma.influencer.create({ data: { username: 'dana_ejemplo', platform: 'INSTAGRAM', followers: 652 } })
  const danaTt = await prisma.influencer.create({ data: { username: 'dana_ejemplo', platform: 'TIKTOK', followers: 18700 } })
  const vaneReal = await prisma.influencer.create({ data: { username: 'vane_inventada', platform: 'INSTAGRAM', followers: 2300, website: 'https://www.tiktok.com/@vane_mal' } })
  const vaneWrong = await prisma.influencer.create({ data: { username: 'vane_mal', platform: 'INSTAGRAM', followers: 0 } })
  const bea = await prisma.influencer.create({ data: { username: 'paula_prueba', platform: 'INSTAGRAM', followers: 900 } })
  for (const [i, inf] of [danaIg, danaTt, vaneReal, vaneWrong, bea].entries()) {
    await prisma.campaignInfluencer.create({ data: { campaignId: oct.id, influencerId: inf.id, status: 'COMPLETED', agreedFee: 100, cost: 100, createdAt: new Date(Date.UTC(2026, 8, 20, 8, i)) } })
  }
  await prisma.media.create({ data: { externalId: 'tt-1', platform: 'TIKTOK', mediaType: 'VIDEO', campaignId: oct.id, influencerId: danaTt.id, postedAt: new Date('2026-10-10T10:00:00Z'), views: 5400, likes: 120, comments: 4, source: 'manual' } })
  await prisma.media.create({ data: { externalId: 'ig-1', platform: 'INSTAGRAM', mediaType: 'REEL', campaignId: oct.id, influencerId: vaneReal.id, postedAt: new Date('2026-10-11T10:00:00Z'), views: 2600, likes: 140, comments: 9, source: 'manual' } })
  return {
    admin: { id: admin.id, email: admin.email, name: 'Ada Admin', role: 'ADMIN' },
    employee: { id: employee.id, email: employee.email, name: 'Laura PM', role: 'EMPLOYEE' },
    oct: oct.id, danaIg: danaIg.id, danaTt: danaTt.id, vaneReal: vaneReal.id, vaneWrong: vaneWrong.id, bea: bea.id,
  }
}

async function call(method: 'GET' | 'POST', body?: unknown, query = ''): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const request = new NextRequest(`http://localhost/api/admin/person-merge${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const response = method === 'GET' ? await GET(request) : await POST(request)
  return { status: response.status, body: await response.json() }
}

describe('/api/admin/person-merge', () => {
  it('answers 401 without a session and 403 to anyone who is not an ADMIN, on every action, and changes nothing', async () => {
    const fx = await seed()
    const before = await snapshot()
    const posts = [
      { action: 'preview', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' },
      { action: 'apply', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', fingerprint: 'x' },
      { action: 'undo', logId: 'x' },
      { action: 'dismiss', aId: fx.danaIg, bId: fx.danaTt },
    ]
    net.session = null
    expect((await call('GET')).status).toBe(401)
    expect((await call('GET', undefined, `?campaignId=${fx.oct}&countOnly=1`)).status).toBe(401)
    for (const body of posts) expect((await call('POST', body)).status, body.action).toBe(401)
    for (const role of ['EMPLOYEE', 'BRAND', 'CREATOR']) {
      net.session = { ...fx.employee, role }
      expect((await call('GET')).status, role).toBe(403)
      expect((await call('GET', undefined, `?campaignId=${fx.oct}&countOnly=1`)).status, role).toBe(403)
      for (const body of posts) expect((await call('POST', body)).status, `${role} ${body.action}`).toBe(403)
    }
    expect(await snapshot()).toEqual(before)
  })

  it('lists, counts, previews, applies, refuses a stale apply, undoes and dismisses for an ADMIN', async () => {
    const fx = await seed()
    net.session = fx.admin
    const before = await snapshot()

    // Candidates with the campaign's name, and the banner count
    const listed = await call('GET', undefined, `?campaignId=${fx.oct}`)
    expect(listed.status).toBe(200)
    expect(listed.body.campaign).toEqual({ id: fx.oct, name: 'Micros Octubre (prueba)' })
    expect(listed.body.candidates.map((c: { kind: string }) => c.kind)).toEqual(['same_campaign', 'same_campaign'])
    expect(listed.body.history).toEqual([])
    expect((await call('GET', undefined, `?campaignId=${fx.oct}&countOnly=1`)).body).toEqual({ count: 2 })
    expect((await call('GET')).body.candidates).toHaveLength(2)
    expect(await snapshot()).toEqual(before)

    // Preview and apply
    const vane = listed.body.candidates.find((c: { suggestion: { otherId: string } }) => c.suggestion.otherId === fx.vaneWrong)
    expect(vane.suggestion).toMatchObject({ keepId: fx.vaneReal, mode: 'absorb' })
    const preview = await call('POST', { action: 'preview', keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb' })
    expect(preview.status).toBe(200)
    expect(preview.body.preview).toMatchObject({ canApply: true, campaigns: [expect.objectContaining({ campaignId: fx.oct, action: 'fold', membersBefore: 5, membersAfter: 4 })] })
    expect(await snapshot()).toEqual(before)
    const applied = await call('POST', { action: 'apply', keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: preview.body.preview.fingerprint })
    expect(applied.status).toBe(200)
    expect(applied.body.result).toMatchObject({ keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', campaigns: [expect.objectContaining({ membersBefore: 5, membersAfter: 4 })] })
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.oct } })).toBe(4)
    // The same preview again: stale
    const again = await call('POST', { action: 'apply', keepId: fx.vaneReal, otherId: fx.vaneWrong, mode: 'absorb', fingerprint: preview.body.preview.fingerprint })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('stale')
    expect((await call('GET', undefined, `?campaignId=${fx.oct}&countOnly=1`)).body).toEqual({ count: 1 })

    // A money conflict: 409 with what is missing
    await prisma.campaignInfluencer.updateMany({ where: { campaignId: fx.oct, influencerId: fx.danaTt }, data: { agreedFee: 80 } })
    const conflict = await call('POST', { action: 'preview', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })
    expect(conflict.body.preview.canApply).toBe(false)
    const refused = await call('POST', { action: 'apply', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', fingerprint: conflict.body.preview.fingerprint })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: 'needs_choice', missingChoices: [{ campaignId: fx.oct, group: 'agreedFee', label: 'Honorario acordado' }] })
    const dana = await call('POST', { action: 'apply', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices: { [fx.oct]: { agreedFee: 'keep' } }, fingerprint: conflict.body.preview.fingerprint })
    expect(dana.status).toBe(200)

    // History: newest first, undoable
    const history = (await call('GET')).body.history
    expect(history.map((h: { logId: string; undoable: boolean; actorName: string }) => [h.logId, h.undoable, h.actorName])).toEqual([
      [dana.body.result.logId, true, 'Ada Admin'],
      [applied.body.result.logId, true, 'Ada Admin'],
    ])

    // Undo after an edit: 409 with the differences, then forced
    await prisma.campaignInfluencer.updateMany({ where: { campaignId: fx.oct, influencerId: fx.vaneReal }, data: { notes: 'Nota posterior' } })
    const changed = await call('POST', { action: 'undo', logId: applied.body.result.logId })
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('changed_since')
    expect(changed.body.differences).toEqual([expect.objectContaining({ kind: 'membership', blocking: false, text: expect.stringContaining('Notas — → Nota posterior') })])
    expect((await call('POST', { action: 'undo', logId: applied.body.result.logId, force: 'yes' })).status).toBe(400)
    expect(changed.body.differencesHash).toMatch(/^[0-9a-f]{64}$/)
    expect((await call('POST', { action: 'undo', logId: applied.body.result.logId, force: true, differencesHash: 42 })).status).toBe(400)
    // Forcing without the hash of the list shown (or with another one) is asked again, with the list of now
    const unconfirmed = await call('POST', { action: 'undo', logId: applied.body.result.logId, force: true })
    expect(unconfirmed.status).toBe(409)
    expect(unconfirmed.body).toMatchObject({ code: 'changed_since', differencesHash: changed.body.differencesHash })
    const forced = await call('POST', { action: 'undo', logId: applied.body.result.logId, force: true, differencesHash: changed.body.differencesHash })
    expect(forced.status).toBe(200)
    expect(forced.body.undone).toMatchObject({ kind: 'merge', alreadyUndone: false, overwritten: [expect.objectContaining({ kind: 'membership' })] })
    expect((await call('POST', { action: 'undo', logId: applied.body.result.logId })).body.undone).toMatchObject({ alreadyUndone: true })
    expect(await prisma.campaignInfluencer.count({ where: { campaignId: fx.oct } })).toBe(4) // dana's merge is still in force

    // Dismiss
    const dismissed = await call('POST', { action: 'dismiss', aId: fx.vaneWrong, bId: fx.vaneReal })
    expect(dismissed.status).toBe(200)
    expect(dismissed.body.dismissed).toMatchObject({ alreadyDismissed: false })
    expect((await call('GET', undefined, `?campaignId=${fx.oct}`)).body.candidates).toEqual([])
    expect((await call('GET')).body.history[0]).toMatchObject({ action: 'dismiss_candidate', logId: dismissed.body.dismissed.logId, undoable: true })
  })

  it('answers 400 to a bad body and 404 to unknown records, never 500', async () => {
    const fx = await seed()
    net.session = fx.admin
    const before = await snapshot()
    expect((await call('POST', 'not json')).status).toBe(400)
    expect((await call('POST', [])).status).toBe(400)
    expect((await call('POST', { action: 'merge' })).status).toBe(400)
    expect((await call('POST', { action: 'preview', keepId: fx.danaIg, otherId: fx.danaIg, mode: 'link' })).status).toBe(400)
    expect((await call('POST', { action: 'preview', keepId: fx.danaIg, otherId: fx.danaTt })).status).toBe(400)
    expect((await call('POST', { action: 'preview', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link', choices: 'all' })).status).toBe(400)
    expect((await call('POST', { action: 'apply', keepId: fx.danaIg, otherId: fx.danaTt, mode: 'link' })).status).toBe(400)
    expect((await call('POST', { action: 'undo' })).status).toBe(400)
    expect((await call('POST', { action: 'dismiss', aId: fx.bea })).status).toBe(400)
    expect((await call('GET', undefined, '?countOnly=1')).status).toBe(400)
    expect((await call('POST', { action: 'preview', keepId: fx.danaIg, otherId: 'no-such-profile', mode: 'link' })).status).toBe(404)
    expect((await call('POST', { action: 'undo', logId: 'no-such-log' })).status).toBe(404)
    expect((await call('POST', { action: 'dismiss', aId: fx.bea, bId: 'no-such-profile' })).status).toBe(404)
    expect((await call('GET', undefined, '?campaignId=no-such-campaign')).status).toBe(404)
    expect(await snapshot()).toEqual(before)
  })
})
