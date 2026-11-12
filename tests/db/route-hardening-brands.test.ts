import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// PATCH and DELETE /api/brands used the brandId as a settings key with no
// check that it was a brand: a wrong id rewrote or deleted ANY settings row
// (stored keys, report configurations, cron stamps). assignedEmployees was
// saved before being checked, and brandUserId was never checked.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-brands'
  return { mails: [] as string[] }
})

// Assigning people sends them an e-mail: kept here, never sent
vi.mock('@/lib/email', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  return { ...actual, sendBrandAssignmentEmail: async (args: { to: string }) => { h.mails.push(args.to) } }
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { DELETE, GET, PATCH } from '@/app/api/brands/route'

const tag = randomUUID().slice(0, 8)
const brandId = `brand_1731400000000_${tag}`
const otherKeys = {
  cron: `cron_track_last_run_${tag}`,
  ig: `brand_ig_${brandId}`,
  assignment: `brand_assignment_${tag}`,
  report: `campaign_report_${tag}`,
  // A brand_ row whose document is not this id: never treated as a brand
  impostor: `brand_${tag}_impostor`,
  // A brand_ row whose document has no name: GET /api/brands used to answer 500 to everybody
  nameless: `brand_${tag}_nameless`,
}
const fx = { admin: '', emp: '', client: '', creator: '', token: '', campaignMapping: `campaign_brand_${tag}` }
const users: string[] = []

function call(handler: (r: NextRequest) => Promise<Response>, method: 'GET' | 'PATCH' | 'DELETE', body?: unknown, query = ''): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/brands${query}`, {
    method,
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return handler(req)
}

async function brandDoc() {
  const row = await prisma.setting.findUnique({ where: { key: brandId } })
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  const mk = (name: string, role: 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR') =>
    prisma.user.create({ data: { email: `${name}-${tag}@correo-inventado.test`, password: 'x', name, role } })
  const [admin, emp, client, creator] = await Promise.all([mk('admin', 'ADMIN'), mk('emp', 'EMPLOYEE'), mk('client', 'BRAND'), mk('creator', 'CREATOR')])
  users.push(admin.id, emp.id, client.id, creator.id)
  Object.assign(fx, { admin: admin.id, emp: emp.id, client: client.id, creator: creator.id, token: generateToken(admin.id, 'ADMIN') })

  await prisma.setting.createMany({
    data: [
      { key: brandId, value: JSON.stringify({ id: brandId, name: `Marca Inventada ${tag}`, assignedEmployees: [admin.id, 'ghost-user-that-left'], createdBy: admin.id, createdAt: '2026-11-01T00:00:00.000Z' }) },
      { key: otherKeys.cron, value: '2026-11-12T08:00:00.000Z' },
      { key: otherKeys.ig, value: 'marca_inventada' },
      { key: otherKeys.assignment, value: '[]' },
      { key: otherKeys.report, value: JSON.stringify({ name: 'not a brand', hiddenMediaIds: [] }) },
      { key: otherKeys.impostor, value: JSON.stringify({ id: 'brand_somebody_else', name: 'Impostora' }) },
      { key: otherKeys.nameless, value: JSON.stringify({ id: otherKeys.nameless, website: 'https://sin-nombre.test' }) },
      { key: fx.campaignMapping, value: brandId },
    ],
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.setting.deleteMany({ where: { key: { in: [brandId, ...Object.values(otherKeys), fx.campaignMapping] } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('brands: the list survives a broken document', () => {
  it('GET skips a brand_ row without a name instead of answering 500, and still lists the real brands', async () => {
    const res = await call(GET, 'GET')
    expect(res.status).toBe(200)
    const { brands } = (await res.json()) as { brands: { id: string; name: unknown }[] }
    expect(brands.map(b => b.name)).toContain(`Marca Inventada ${tag}`)
    expect(brands.find(b => b.id === otherKeys.nameless)).toBeUndefined()
    for (const b of brands) expect(typeof b.name, b.id).toBe('string')
  })
})

describe('brands: only a brand document can be changed or deleted', () => {
  it('PATCH with the key of any other settings row is a 404 and the row is untouched', async () => {
    for (const key of Object.values(otherKeys)) {
      const before = await prisma.setting.findUniqueOrThrow({ where: { key } })
      const res = await call(PATCH, 'PATCH', { brandId: key, name: 'Hackeada', website: 'https://evil.example' })
      expect(res.status, key).toBe(404)
      expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value, key).toBe(before.value)
    }
    expect((await call(PATCH, 'PATCH', { brandId: 12345, name: 'x' })).status).toBe(404)
  })

  it('DELETE with the key of any other settings row is a 404 and the row survives', async () => {
    for (const key of Object.values(otherKeys)) {
      const res = await call(DELETE, 'DELETE', undefined, `?brandId=${encodeURIComponent(key)}`)
      expect(res.status, key).toBe(404)
      expect(await prisma.setting.count({ where: { key } }), key).toBe(1)
    }
  })

  it('a wrong assignedEmployees, an unknown or creator account, or a non-client brandUserId is a 400 and nothing is saved', async () => {
    const before = await brandDoc()
    const bad: Record<string, unknown>[] = [
      { assignedEmployees: 'not-a-list' },
      { assignedEmployees: [123] },
      { assignedEmployees: [fx.admin, 'nobody-has-this-id'] },
      { assignedEmployees: [fx.admin, fx.creator] },
      { brandUserId: fx.emp },
      { brandUserId: 'nobody-has-this-id' },
      { brandUserId: 42 },
      { name: 12345 },
      { website: { url: 'x' } },
    ]
    for (const body of bad) {
      const res = await call(PATCH, 'PATCH', { brandId, ...body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await brandDoc()).toEqual(before)
    expect(h.mails).toEqual([])
  })

  it('the brands page still saves what it sends: staff and client users (an old id already there is kept), and a client login', async () => {
    // As handleSaveManage sends it: the stored list (with an id of someone who left) plus new people
    const res = await call(PATCH, 'PATCH', { brandId, assignedEmployees: [fx.admin, 'ghost-user-that-left', fx.emp, fx.client], brandUserId: fx.client })
    expect(res.status).toBe(200)
    const doc = await brandDoc()
    expect(doc?.assignedEmployees).toEqual([fx.admin, 'ghost-user-that-left', fx.emp, fx.client])
    expect(doc?.brandUserId).toBe(fx.client)
    expect(h.mails).toHaveLength(2)

    const renamed = await call(PATCH, 'PATCH', { brandId, name: `Marca Renombrada ${tag}`, website: 'https://marca-inventada.example' })
    expect(renamed.status).toBe(200)
    expect(await brandDoc()).toMatchObject({ name: `Marca Renombrada ${tag}`, website: 'https://marca-inventada.example' })
  })

  it('DELETE of a real brand still works and removes its campaign mappings', async () => {
    const res = await call(DELETE, 'DELETE', undefined, `?brandId=${brandId}`)
    expect(res.status).toBe(200)
    expect(await prisma.setting.count({ where: { key: { in: [brandId, fx.campaignMapping] } } })).toBe(0)
    // The other rows were never touched
    expect(await prisma.setting.count({ where: { key: { in: Object.values(otherKeys) } } })).toBe(Object.keys(otherKeys).length)
  })
})
