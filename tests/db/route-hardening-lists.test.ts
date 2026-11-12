import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// DELETE /api/lists/[id] deleted the WHOLE list when itemId came empty and
// answered 500 for an unknown item; PUT answered 200 to a body that changed
// nothing; POST stored any name as received.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-lists'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { POST as createList } from '@/app/api/lists/route'
import { DELETE, PUT } from '@/app/api/lists/[id]/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', token: '', list: '', items: [] as string[], influencers: [] as string[] }
const lists: string[] = []

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const del = (id: string, query = '') => DELETE(request('DELETE', `/api/lists/${id}${query}`), params(id))
const put = (id: string, body: unknown) => PUT(request('PUT', `/api/lists/${id}`, body), params(id))

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-lists-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Listas', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const [a, b] = await Promise.all([
    prisma.influencer.create({ data: { username: `ana_lists_${tag}`, platform: 'INSTAGRAM' } }),
    prisma.influencer.create({ data: { username: `bea_lists_${tag}`, platform: 'INSTAGRAM' } }),
  ])
  fx.influencers.push(a.id, b.id)
  const list = await prisma.list.create({ data: { name: `Lista ${tag}`, userId: admin.id } })
  fx.list = list.id
  lists.push(list.id)
  const [i1, i2] = await Promise.all([
    prisma.listItem.create({ data: { listId: list.id, influencerId: a.id } }),
    prisma.listItem.create({ data: { listId: list.id, influencerId: b.id } }),
  ])
  fx.items.push(i1.id, i2.id)
})

afterAll(async () => {
  await prisma.listItem.deleteMany({ where: { listId: { in: lists } } })
  await prisma.list.deleteMany({ where: { userId: fx.admin } })
  await prisma.contact.deleteMany({ where: { userId: fx.admin } }).catch(() => {})
  await prisma.influencer.deleteMany({ where: { id: { in: fx.influencers } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('lists: removing one creator never deletes the list', () => {
  it('an empty itemId is a 400 and the list keeps every creator', async () => {
    for (const query of ['?itemId=', '?itemId=%20%20']) {
      const res = await del(fx.list, query)
      expect(res.status, query).toBe(400)
      expect(await prisma.list.count({ where: { id: fx.list } })).toBe(1)
      expect(await prisma.listItem.count({ where: { listId: fx.list } })).toBe(2)
    }
  })

  it('an unknown item is a 404 (it was a 500), and an item of another list is never removed', async () => {
    const other = await prisma.list.create({ data: { name: `Otra ${tag}`, userId: fx.admin } })
    lists.push(other.id)
    expect((await del(fx.list, '?itemId=nobody-has-this-id')).status).toBe(404)
    // The item exists, but in another list
    expect((await del(other.id, `?itemId=${fx.items[0]}`)).status).toBe(404)
    expect(await prisma.listItem.count({ where: { listId: fx.list } })).toBe(2)
  })

  it('a real item is removed as the list page does, and the list stays', async () => {
    const res = await del(fx.list, `?itemId=${fx.items[0]}`)
    expect(res.status).toBe(200)
    expect(await prisma.listItem.count({ where: { listId: fx.list } })).toBe(1)
    expect(await prisma.list.count({ where: { id: fx.list } })).toBe(1)
  })
})

describe('lists: PUT and POST say when they did nothing', () => {
  it('PUT with nothing to change, or with a wrong value, is a 400 and the list is unchanged', async () => {
    const before = await prisma.list.findUniqueOrThrow({ where: { id: fx.list } })
    for (const body of [{}, { isPinned: 'yes' }, { isArchived: 1 }, { name: '   ' }, { name: 42 }, { name: 'x'.repeat(201) }, { color: 'red' }]) {
      expect((await put(fx.list, body)).status, JSON.stringify(body)).toBe(400)
    }
    const after = await prisma.list.findUniqueOrThrow({ where: { id: fx.list } })
    expect({ name: after.name, isPinned: after.isPinned, isArchived: after.isArchived }).toEqual({ name: before.name, isPinned: before.isPinned, isArchived: before.isArchived })
  })

  it('PUT as the list page sends it (pin, archive, rename) still works', async () => {
    expect((await put(fx.list, { isPinned: true })).status).toBe(200)
    expect((await put(fx.list, { isArchived: true })).status).toBe(200)
    expect((await put(fx.list, { name: `  Lista renombrada ${tag}  ` })).status).toBe(200)
    expect(await prisma.list.findUniqueOrThrow({ where: { id: fx.list } })).toMatchObject({ isPinned: true, isArchived: true, name: `Lista renombrada ${tag}` })
  })

  it('POST refuses a name that is not text or is too long, and trims a good one', async () => {
    for (const name of [123, { a: 1 }, '   ', 'x'.repeat(201)]) {
      expect((await createList(request('POST', '/api/lists', { name }))).status, JSON.stringify(name)).toBe(400)
    }
    const res = await createList(request('POST', '/api/lists', { name: `  Nueva ${tag}  ` }))
    expect(res.status).toBe(201)
    const created = (await res.json()) as { list: { id: string; name: string } }
    lists.push(created.list.id)
    expect(created.list.name).toBe(`Nueva ${tag}`)
  })
})

describe('lists: deleting the whole list', () => {
  it('without itemId the list is deleted, as the delete button of /lists relies on', async () => {
    const res = await del(fx.list)
    expect(res.status).toBe(200)
    expect(await prisma.list.count({ where: { id: fx.list } })).toBe(0)
  })
})
