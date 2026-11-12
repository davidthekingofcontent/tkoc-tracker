import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// PATCH /api/campaigns/[id]/influencers stored cost and agreedFee as
// parseFloat(x) || 0 with no sign check (text became a fee of 0 in silence,
// negatives were accepted), had no type or length check on notes and the
// shipping fields, and parseInt'ed shippingQty with no NaN or range check.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-campaign-influencers'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { PATCH } from '@/app/api/campaigns/[id]/influencers/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', token: '', campaign: '', marta: '' }

function patch(body: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/campaigns/${fx.campaign}/influencers`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ influencerId: fx.marta, ...body }),
  })
  return PATCH(req, { params: Promise.resolve({ id: fx.campaign }) })
}

const member = () =>
  prisma.campaignInfluencer.findUniqueOrThrow({
    where: { campaignId_influencerId: { campaignId: fx.campaign, influencerId: fx.marta } },
    select: { cost: true, agreedFee: true, dealClosedAt: true, notes: true, shippingName: true, shippingAddress1: true, shippingQty: true, shippingComments: true, status: true },
  })

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network access is not allowed in this test')
  }))
  const admin = await prisma.user.create({ data: { email: `admin-ci-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Miembros', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const campaign = await prisma.campaign.create({
    data: { name: `Campaña Miembros ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date('2026-10-01T00:00:00.000Z'), userId: admin.id },
  })
  fx.campaign = campaign.id
  const marta = await prisma.influencer.create({ data: { username: `marta_ci_${tag}`, platform: 'INSTAGRAM' } })
  fx.marta = marta.id
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: marta.id, status: 'NEGOTIATING', cost: 120, agreedFee: 120 } })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.contact.deleteMany({ where: { influencerId: fx.marta } }).catch(() => {})
  await prisma.influencer.deleteMany({ where: { id: fx.marta } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('PATCH /api/campaigns/[id]/influencers: money', () => {
  it('a fee or cost that is not a number, or negative, is a 400 and the stored values stay', async () => {
    const bad: Record<string, unknown>[] = [
      { cost: 'abc' },
      { cost: -5 },
      { cost: '-1' },
      { cost: '300€' },
      { agreedFee: 'trescientos' },
      { agreedFee: -0.01 },
      { agreedFee: true },
      { agreedFee: { v: 1 } },
      { agreedFee: 300, cost: 'x' },
    ]
    for (const body of bad) expect((await patch(body)).status, JSON.stringify(body)).toBe(400)
    expect(await member()).toMatchObject({ cost: 120, agreedFee: 120 })
  })

  it('the fee input of the campaign page still saves (handleSaveFee), and emptying it still stores 0', async () => {
    // handleSaveFee sends the typed text as cost and the parsed number as agreedFee
    expect((await patch({ cost: '350', agreedFee: 350 })).status).toBe(200)
    expect(await member()).toMatchObject({ cost: 350, agreedFee: 350 })
    expect((await patch({ cost: '', agreedFee: 0 })).status).toBe(200)
    expect(await member()).toMatchObject({ cost: 0, agreedFee: 0 })
    expect((await patch({ cost: null })).status).toBe(200)
    expect((await member()).cost).toBe(0)
    // The deal closes when the fee first goes from 0 to more than 0
    expect((await patch({ cost: '410.5', agreedFee: 410.5 })).status).toBe(200)
    const after = await member()
    expect(after).toMatchObject({ cost: 410.5, agreedFee: 410.5 })
    expect(after.dealClosedAt).not.toBeNull()
  })
})

describe('PATCH /api/campaigns/[id]/influencers: notes and shipping', () => {
  it('notes that are not text, or too long, are a 400', async () => {
    for (const notes of [42, { a: 1 }, 'x'.repeat(5001)]) {
      expect((await patch({ notes })).status, typeof notes).toBe(400)
    }
    expect((await patch({ notes: 'Prefiere envío por la mañana' })).status).toBe(200)
    expect((await member()).notes).toBe('Prefiere envío por la mañana')
    expect((await patch({ notes: null })).status).toBe(200)
    expect((await member()).notes).toBeNull()
  })

  it('shipping fields that are not text or are huge, and a quantity that is not a whole number in range, are a 400; nothing is written', async () => {
    const before = await member()
    const bad: Record<string, unknown>[] = [
      { shippingName: 12345 },
      { shippingAddress1: ['Calle', 'Inventada'] },
      { shippingComments: 'c'.repeat(2001) },
      { shippingCity: 'x'.repeat(1001) },
      { shippingQty: 'muchas' },
      { shippingQty: '-1' },
      { shippingQty: 5_000_000 },
      { shippingQty: true },
      { shippingName: 'Marta', shippingQty: 'x' },
    ]
    for (const body of bad) expect((await patch(body)).status, JSON.stringify(body)).toBe(400)
    expect(await member()).toEqual(before)
  })

  it('the shipping modal still saves what it sends (empty strings and the quantity as text)', async () => {
    const res = await patch({
      shippingName: 'Marta Inventada',
      shippingAddress1: 'Calle Inventada 123',
      shippingAddress2: '',
      shippingCity: 'Ciudad Inventada',
      shippingPostCode: '00000',
      shippingCountry: 'España',
      shippingPhone: '600 000 000 (tardes)',
      shippingEmail: 'marta@correo-inventado.test',
      shippingProduct: 'Producto de prueba',
      shippingQty: '2',
      shippingComments: '',
    })
    expect(res.status).toBe(200)
    expect(await member()).toMatchObject({ shippingName: 'Marta Inventada', shippingAddress1: 'Calle Inventada 123', shippingQty: 2, shippingComments: null })
    // 0 clears the quantity as before; the text '0' stores 0 as before
    expect((await patch({ shippingQty: 0 })).status).toBe(200)
    expect((await member()).shippingQty).toBeNull()
    expect((await patch({ shippingQty: '0' })).status).toBe(200)
    expect((await member()).shippingQty).toBe(0)
  })

  it('the status is untouched by all of the above', async () => {
    expect((await member()).status).toBe('NEGOTIATING')
  })
})
