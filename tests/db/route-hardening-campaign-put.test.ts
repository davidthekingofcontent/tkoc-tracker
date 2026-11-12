import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// PUT /api/campaigns/[id] stored an empty name, ignored an invalid status in
// silence (answering 200, so a caller believed it had changed it), stored
// budget, isPinned and briefFiles as received and turned a wrong manualROI
// into NaN.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-campaign-put'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { PUT } from '@/app/api/campaigns/[id]/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', token: '', campaign: '', name: `Campaña PUT ${tag}` }

function put(body: unknown): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/campaigns/${fx.campaign}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return PUT(req, { params: Promise.resolve({ id: fx.campaign }) })
}

const current = () =>
  prisma.campaign.findUniqueOrThrow({ where: { id: fx.campaign }, select: { name: true, status: true, budget: true, isPinned: true, briefFiles: true, manualROI: true } })

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-put-${tag}@correo-inventado.test`, password: 'x', name: 'Admin PUT', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const campaign = await prisma.campaign.create({
    data: {
      name: fx.name, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], objective: 'awareness', budget: 1000,
      startDate: new Date('2026-10-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: admin.id,
    },
  })
  fx.campaign = campaign.id
})

afterAll(async () => {
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('PUT /api/campaigns/[id]', () => {
  it('an empty or non-text name is a 400, never stored', async () => {
    for (const name of ['', '   ', 123, null, 'x'.repeat(201)]) {
      const res = await put({ name })
      expect(res.status, JSON.stringify(name)).toBe(400)
    }
    expect((await current()).name).toBe(fx.name)
  })

  it('an invalid status is a 400 instead of a silent 200, and the status stays', async () => {
    for (const status of ['DONE', 'active', '', 7]) {
      const res = await put({ status })
      expect(res.status, JSON.stringify(status)).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('ACTIVE, PAUSED, ARCHIVED')
    }
    expect((await current()).status).toBe('ACTIVE')
  })

  it('budget, isPinned, briefFiles and manualROI of the wrong type are a 400 and nothing is written', async () => {
    const before = await current()
    const bad: Record<string, unknown>[] = [
      { budget: 'mucho' },
      { budget: -1 },
      { isPinned: 'yes' },
      { briefFiles: 'brief.pdf' },
      { briefFiles: [1, 2] },
      { manualROI: 'abc' },
      { manualROI: {} },
      { status: 'PAUSED', name: '' },
    ]
    for (const body of bad) expect((await put(body)).status, JSON.stringify(body)).toBe(400)
    expect(await current()).toEqual(before)
  })

  it('what the screens send still works: pause and activate, the edit modal, and good values of the other fields', async () => {
    expect((await put({ status: 'PAUSED' })).status).toBe(200)
    expect((await current()).status).toBe('PAUSED')
    expect((await put({ status: 'ACTIVE' })).status).toBe(200)

    // The edit modal of the campaign page (handleSaveEdit), with a name typed with spaces around
    const modal = await put({
      name: `  ${fx.name} editada  `,
      status: 'ACTIVE',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      country: null,
      targetHashtags: [],
      targetAccounts: [],
      targetKeywords: [],
      objective: 'awareness',
      targetViews: null,
      targetReach: null,
      targetEngagement: null,
      targetER: null,
      targetCpmMax: null,
    })
    expect(modal.status).toBe(200)
    expect((await current()).name).toBe(`${fx.name} editada`)

    expect((await put({ budget: 2500.5, isPinned: true, briefFiles: ['brief-a.pdf'], manualROI: '2.5' })).status).toBe(200)
    expect(await current()).toMatchObject({ budget: 2500.5, isPinned: true, briefFiles: ['brief-a.pdf'], manualROI: 2.5 })
    expect((await put({ budget: null, manualROI: '' })).status).toBe(200)
    expect(await current()).toMatchObject({ budget: null, manualROI: null })
  })

  it('a long name already stored can be saved again unchanged', async () => {
    const long = `${'L'.repeat(230)} ${tag}`
    await prisma.campaign.update({ where: { id: fx.campaign }, data: { name: long } })
    expect((await put({ name: long, status: 'ACTIVE' })).status).toBe(200)
    expect((await current()).name).toBe(long)
  })
})
