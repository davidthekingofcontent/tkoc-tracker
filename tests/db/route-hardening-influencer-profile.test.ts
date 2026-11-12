import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// PATCH /api/influencers/[id] had no role check, turned text into a fee of
// null in silence (parseFloat(x) || null) and stored any value as e-mail,
// phone or website.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-influencer'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { PATCH } from '@/app/api/influencers/[id]/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', emp: '', client: '', creator: '', influencer: '' }
const tokens: Record<string, string> = {}

function patch(body: unknown, who = 'admin'): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/influencers/${fx.influencer}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return PATCH(req, { params: Promise.resolve({ id: fx.influencer }) })
}

const current = () => prisma.influencer.findUniqueOrThrow({ where: { id: fx.influencer }, select: { standardFee: true, email: true, phone: true, website: true } })

beforeAll(async () => {
  const mk = (name: string, role: 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR') =>
    prisma.user.create({ data: { email: `${name}-inf-${tag}@correo-inventado.test`, password: 'x', name, role } })
  const [admin, emp, client, creator] = await Promise.all([mk('admin', 'ADMIN'), mk('emp', 'EMPLOYEE'), mk('client', 'BRAND'), mk('creator', 'CREATOR')])
  Object.assign(fx, { admin: admin.id, emp: emp.id, client: client.id, creator: creator.id })
  tokens.admin = generateToken(admin.id, 'ADMIN')
  tokens.emp = generateToken(emp.id, 'EMPLOYEE')
  tokens.client = generateToken(client.id, 'BRAND')
  tokens.creator = generateToken(creator.id, 'CREATOR')
  const inf = await prisma.influencer.create({
    data: { username: `marta_inf_${tag}`, platform: 'INSTAGRAM', standardFee: 500, email: 'marta@correo-inventado.test', phone: '+34 600 111 222', website: 'https://marta.example' },
  })
  fx.influencer = inf.id
})

afterAll(async () => {
  await prisma.influencer.deleteMany({ where: { id: fx.influencer } })
  await prisma.user.deleteMany({ where: { id: { in: [fx.admin, fx.emp, fx.client, fx.creator] } } })
})

describe('PATCH /api/influencers/[id]', () => {
  it('only agency staff: a client or a creator session is refused and nothing changes', async () => {
    const before = await current()
    expect((await patch({ standardFee: 1 }, 'client')).status).toBe(403)
    expect((await patch({ email: 'otra@correo-inventado.test' }, 'creator')).status).toBe(403)
    expect(await current()).toEqual(before)
    expect((await patch({ standardFee: 650 }, 'emp')).status).toBe(200)
    expect((await current()).standardFee).toBe(650)
  })

  it('a fee that is not a number, or negative, is a 400 and the stored fee stays', async () => {
    for (const standardFee of ['abc', -5, '-1', true, { v: 1 }, '12abc']) {
      expect((await patch({ standardFee })).status, JSON.stringify(standardFee)).toBe(400)
    }
    expect((await current()).standardFee).toBe(650)
  })

  it('the analyze page still saves a fee, numeric text is accepted, and 0, null or empty clear it as before', async () => {
    expect((await patch({ standardFee: 300 })).status).toBe(200)
    expect((await current()).standardFee).toBe(300)
    expect((await patch({ standardFee: '450.5' })).status).toBe(200)
    expect((await current()).standardFee).toBe(450.5)
    for (const standardFee of [0, null, '']) {
      await prisma.influencer.update({ where: { id: fx.influencer }, data: { standardFee: 100 } })
      expect((await patch({ standardFee })).status, JSON.stringify(standardFee)).toBe(200)
      expect((await current()).standardFee, JSON.stringify(standardFee)).toBeNull()
    }
  })

  it('an e-mail, phone or website of the wrong shape is a 400 and nothing is written', async () => {
    const before = await current()
    const bad: Record<string, unknown>[] = [
      { email: 'not-an-email' },
      { email: 42 },
      { phone: 'llámame' },
      { phone: '12' },
      { website: 'javascript:alert(1)' },
      { website: 'marta.example' },
      { website: `https://x.example/${'a'.repeat(300)}` },
      { standardFee: 200, email: 'bad' },
    ]
    for (const body of bad) expect((await patch(body)).status, JSON.stringify(body)).toBe(400)
    expect(await current()).toEqual(before)
  })

  it('good values are stored trimmed, and null clears them', async () => {
    expect((await patch({ email: '  nueva@correo-inventado.test ', phone: '+34 (600) 999-000', website: 'https://marta-nueva.example/kit' })).status).toBe(200)
    expect(await current()).toMatchObject({ email: 'nueva@correo-inventado.test', phone: '+34 (600) 999-000', website: 'https://marta-nueva.example/kit' })
    expect((await patch({ email: null, phone: null, website: null })).status).toBe(200)
    expect(await current()).toMatchObject({ email: null, phone: null, website: null })
  })
})
