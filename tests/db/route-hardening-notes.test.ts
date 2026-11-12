import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// POST /api/campaigns/[id]/notes checked neither that the campaign exists nor
// that the creator is a member, and had no maximum length: a wrong id created
// a note nobody could ever see or delete.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-notes'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { GET, POST } from '@/app/api/campaigns/[id]/notes/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', token: '', campaign: '', member: '', outsider: '' }

function post(campaignId: string, body: unknown): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/campaigns/${campaignId}/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ id: campaignId }) })
}

const notesCount = () => prisma.campaignNote.count({ where: { userId: fx.admin } })

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-notes-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Notas', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const campaign = await prisma.campaign.create({
    data: { name: `Campaña Notas ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date('2026-10-01T00:00:00.000Z'), userId: admin.id },
  })
  fx.campaign = campaign.id
  const [member, outsider] = await Promise.all([
    prisma.influencer.create({ data: { username: `miembro_${tag}`, platform: 'INSTAGRAM' } }),
    prisma.influencer.create({ data: { username: `ajena_${tag}`, platform: 'INSTAGRAM' } }),
  ])
  fx.member = member.id
  fx.outsider = outsider.id
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: member.id, status: 'NEGOTIATING' } })
})

afterAll(async () => {
  await prisma.campaignNote.deleteMany({ where: { userId: fx.admin } })
  await prisma.notification.deleteMany({ where: { userId: fx.admin } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.influencer.deleteMany({ where: { id: { in: [fx.member, fx.outsider] } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('POST /api/campaigns/[id]/notes', () => {
  it('a campaign that does not exist is a 404 and no note is created', async () => {
    expect((await post('no-such-campaign', { influencerId: fx.member, text: 'Hola' })).status).toBe(404)
    expect(await notesCount()).toBe(0)
  })

  it('a creator who is not in the campaign is a 400 and no note is created', async () => {
    for (const influencerId of [fx.outsider, 'no-such-creator']) {
      const res = await post(fx.campaign, { influencerId, text: 'Hola' })
      expect(res.status, influencerId).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('no está en la campaña')
    }
    expect((await post(fx.campaign, { influencerId: 42, text: 'Hola' })).status).toBe(400)
    expect(await notesCount()).toBe(0)
  })

  it('a note longer than 5,000 characters is a 400', async () => {
    const res = await post(fx.campaign, { influencerId: fx.member, text: 'x'.repeat(5001) })
    expect(res.status).toBe(400)
    expect(await notesCount()).toBe(0)
  })

  it('the notes dialog still works: a note on a member is saved and read back', async () => {
    const res = await post(fx.campaign, { influencerId: fx.member, text: `  Envío confirmado ${tag}  ` })
    expect(res.status).toBe(201)
    const read = await GET(
      new NextRequest(`http://localhost/api/campaigns/${fx.campaign}/notes?influencerId=${fx.member}`, { headers: { authorization: `Bearer ${fx.token}` } }),
      { params: Promise.resolve({ id: fx.campaign }) },
    )
    const data = (await read.json()) as { notes: { text: string; userName: string }[] }
    expect(data.notes).toEqual([expect.objectContaining({ text: `Envío confirmado ${tag}`, userName: 'Admin Notas' })])
    expect((await post(fx.campaign, { influencerId: fx.member, text: 'y'.repeat(5000) })).status).toBe(201)
  })
})
