import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Weekly review of 16 Nov 2026: «12.- Micros Diciembre» reached production with
// the product words 'turbo' and 'infinityflex' as brand ACCOUNTS. POST
// /api/campaigns and PUT /api/campaigns/[id] now judge the accounts the way
// they judge hashtags and keywords (validateTargetAccounts): a generic word or,
// with a brand to judge against, a handle without the brand's name is a 400
// that names the handles and points to "Palabras clave del producto". The
// validation only acts when the accounts are WRITTEN: a campaign already
// holding such accounts is still read and its other fields still saved.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-target-accounts'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { GET as listCampaigns, POST } from '@/app/api/campaigns/route'
import { GET as getCampaign, PUT } from '@/app/api/campaigns/[id]/route'

const tag = randomUUID().slice(0, 8)
const fx = {
  admin: '',
  token: '',
  brandId: `brand_1731500000000_${tag}`,
  dorcoId: `brand_1731500000001_${tag}`,
  legacy: '',
  dorco: '',
}
const created = { campaigns: [] as string[], settings: [] as string[] }

interface Answer {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

async function answer(res: Response): Promise<Answer> {
  return { status: res.status, body: await res.json() }
}

function post(body: Record<string, unknown>): Promise<Answer> {
  const req = new NextRequest('http://localhost/api/campaigns', {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req).then(answer)
}

function put(id: string, body: Record<string, unknown>): Promise<Answer> {
  const req = new NextRequest(`http://localhost/api/campaigns/${id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return PUT(req, { params: Promise.resolve({ id }) }).then(answer)
}

/** A valid new campaign of the brand (objective and a numeric target are mandatory) */
const base = {
  name: `12.- Micros Diciembre ${tag}`,
  type: 'INFLUENCER_TRACKING',
  platforms: ['INSTAGRAM', 'TIKTOK'],
  objective: 'awareness',
  targetViews: 100000,
  startDate: '2026-12-01',
  endDate: '2026-12-31',
}

const accountsOf = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id }, select: { targetAccounts: true, name: true, status: true } })

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-accounts-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Cuentas', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  // Two brands as the app stores them (Setting key=brandId → JSON { name })
  await prisma.setting.createMany({
    data: [
      { key: fx.brandId, value: JSON.stringify({ id: fx.brandId, name: 'Vileda España', createdBy: admin.id }) },
      { key: fx.dorcoId, value: JSON.stringify({ id: fx.dorcoId, name: 'Dorco', createdBy: admin.id }) },
    ],
  })
  created.settings.push(fx.brandId, fx.dorcoId)

  // A campaign that already holds the production state (written before the rule)
  const legacy = await prisma.campaign.create({
    data: {
      name: `Legacy Micros ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], objective: 'awareness', targetViews: 1000,
      targetAccounts: ['vileda.es', 'turbo', 'infinityflex'], targetHashtags: [], targetKeywords: [],
      startDate: new Date('2026-12-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: admin.id,
      assignments: { create: { userId: admin.id } },
    },
  })
  fx.legacy = legacy.id
  created.campaigns.push(legacy.id)
  await prisma.setting.create({ data: { key: `campaign_brand_${legacy.id}`, value: fx.brandId } })

  // A Dorco campaign for the distributor case
  const dorco = await prisma.campaign.create({
    data: {
      name: `Dorco - Diciembre ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], objective: 'awareness', targetViews: 1000,
      targetAccounts: [], targetHashtags: [], targetKeywords: ['flection system'],
      startDate: new Date('2026-12-01T00:00:00.000Z'), endDate: new Date('2026-12-31T00:00:00.000Z'), userId: admin.id,
      assignments: { create: { userId: admin.id } },
    },
  })
  fx.dorco = dorco.id
  created.campaigns.push(dorco.id)
  await prisma.setting.create({ data: { key: `campaign_brand_${dorco.id}`, value: fx.dorcoId } })
})

afterAll(async () => {
  const keys = [...created.settings, ...created.campaigns.map(id => `campaign_brand_${id}`), `brand_ig_${fx.brandId}`, `brand_ig_${fx.dorcoId}`]
  await prisma.setting.deleteMany({ where: { key: { in: keys } } })
  await prisma.campaign.deleteMany({ where: { id: { in: created.campaigns } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('POST /api/campaigns judges the brand accounts', () => {
  it('the production case is a 400 that names both handles, with the pointer, and creates nothing', async () => {
    const before = await prisma.campaign.count()
    const res = await post({ ...base, brandId: fx.brandId, targetAccounts: ['vileda.es', 'turbo', 'infinityflex'] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ genericAccounts: ['turbo'], accountsNotBrand: ['infinityflex'] })
    expect(res.body.error).toContain('Cuentas a revisar: @turbo.')
    expect(res.body.error).toContain('Cuentas a revisar: @infinityflex.')
    expect(res.body.error).toContain('Pon las palabras del producto en Palabras clave del producto; aquí van solo las cuentas de la marca o del distribuidor.')
    expect(await prisma.campaign.count()).toBe(before)
  })

  it('a generic word is refused even with no brand attached; the typed form is kept in the answer', async () => {
    const res = await post({ ...base, name: `Sin marca ${tag}`, targetAccounts: ['@Turbo', 'mopa_2026'] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ genericAccounts: ['turbo', 'mopa_2026'], accountsNotBrand: [] })
  })

  it("the brand's real handles are accepted and stored clean; a handle that is not a word passes when there is no brand to judge against", async () => {
    const ok = await post({ ...base, brandId: fx.brandId, targetAccounts: ['@Vileda.es', '@viledaturbo'], targetKeywords: ['Vileda Turbo'] })
    expect(ok.status).toBe(201)
    created.campaigns.push(ok.body.campaign.id)
    expect(ok.body.campaign.targetAccounts).toEqual(['vileda.es', 'viledaturbo'])
    expect(ok.body.campaign.targetKeywords).toEqual(['vileda turbo'])

    // No brand attached: only rule (a) applies, whatever the name says
    const free = await post({ ...base, name: 'Micros Diciembre (sin marca)', targetAccounts: ['infinityflex'] })
    expect(free.status).toBe(201)
    created.campaigns.push(free.body.campaign.id)
    expect(free.body.campaign.targetAccounts).toEqual(['infinityflex'])
  })

  it("the brand's connected Instagram is accepted whatever its name; the campaign's own name may carry the brand", async () => {
    await prisma.setting.create({ data: { key: `brand_ig_${fx.brandId}`, value: 'MarcaDemo.Oficial' } })
    const connected = await post({ ...base, name: `Conectada ${tag}`, brandId: fx.brandId, targetAccounts: ['marcademo.oficial'] })
    expect(connected.status).toBe(201)
    created.campaigns.push(connected.body.campaign.id)
    await prisma.setting.delete({ where: { key: `brand_ig_${fx.brandId}` } })

    // No brand attached: the name alone never judges (review of 18 Nov 2026: a creative name refused the brand's
    // own account), so 'infinityflex' is accepted; with the brand attached the same name refuses it
    const named = await post({ ...base, name: `Vileda - Micros ${tag}`, targetAccounts: ['infinityflex'] })
    expect(named.status).toBe(201)
    created.campaigns.push(named.body.campaign.id)
    const judged = await post({ ...base, name: `Vileda - Micros ${tag} (marca)`, brandId: fx.brandId, targetAccounts: ['infinityflex'] })
    expect(judged.status).toBe(400)
    expect(judged.body.accountsNotBrand).toEqual(['infinityflex'])
    // The brand's real account passes under any creative name, with or without the brand
    for (const name of ['Lanzamiento Infinity Flex', 'Reto 30 días', 'Hogar brillante']) {
      const ok = await post({ ...base, name: `${name} ${tag}`, targetAccounts: ['@vileda.es'] })
      expect(ok.status, name).toBe(201)
      created.campaigns.push(ok.body.campaign.id)
    }
  })
})

describe('PUT /api/campaigns/[id] judges the brand accounts only when they come in', () => {
  it('a campaign already holding generic accounts is still read, and a save that does not send the accounts still works', async () => {
    const listed = await listCampaigns(new NextRequest(`http://localhost/api/campaigns?search=Legacy%20Micros%20${tag}`, { headers: { authorization: `Bearer ${fx.token}` } })).then(answer)
    expect(listed.status).toBe(200)
    expect(listed.body.campaigns.map((c: { id: string }) => c.id)).toContain(fx.legacy)
    expect(listed.body.campaigns.find((c: { id: string }) => c.id === fx.legacy).targetAccounts).toEqual(['vileda.es', 'turbo', 'infinityflex'])

    const one = await getCampaign(new NextRequest(`http://localhost/api/campaigns/${fx.legacy}`, { headers: { authorization: `Bearer ${fx.token}` } }), { params: Promise.resolve({ id: fx.legacy }) }).then(answer)
    expect(one.status).toBe(200)
    expect(one.body.campaign.targetAccounts).toEqual(['vileda.es', 'turbo', 'infinityflex'])

    expect((await put(fx.legacy, { status: 'PAUSED' })).status).toBe(200)
    expect(await accountsOf(fx.legacy)).toMatchObject({ status: 'PAUSED', targetAccounts: ['vileda.es', 'turbo', 'infinityflex'] })
    expect((await put(fx.legacy, { status: 'ACTIVE', targetKeywords: ['Vileda Turbo'] })).status).toBe(200)
  })

  it('sending the accounts again (the edit modal) is the 400 with both lists, and nothing changes', async () => {
    const res = await put(fx.legacy, { name: `Legacy Micros ${tag} editada`, status: 'ACTIVE', targetAccounts: ['@vileda.es', '@turbo', '@infinityflex'], targetHashtags: [], targetKeywords: [] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ genericAccounts: ['turbo'], accountsNotBrand: ['infinityflex'] })
    expect(res.body.error).toContain('aquí van solo las cuentas de la marca o del distribuidor')
    expect(await accountsOf(fx.legacy)).toMatchObject({ name: `Legacy Micros ${tag}`, targetAccounts: ['vileda.es', 'turbo', 'infinityflex'] })
  })

  it('the correction the PM makes is saved: brand handles as accounts, product words as keywords', async () => {
    const res = await put(fx.legacy, { targetAccounts: ['@vileda.es'], targetKeywords: ['Vileda Turbo', 'Infinity Flex'] })
    expect(res.status).toBe(200)
    expect(res.body.campaign).toMatchObject({ targetAccounts: ['vileda.es'], targetKeywords: ['vileda turbo', 'infinity flex'] })
  })

  it('@deliplus in a Dorco campaign is refused as not carrying the brand; naming the distributor in the campaign saved in the same request lets it through', async () => {
    const refused = await put(fx.dorco, { targetAccounts: ['dorco_es', 'deliplus'] })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ genericAccounts: [], accountsNotBrand: ['deliplus'] })
    expect(refused.body.error).toContain('Dorco x Deliplus')
    expect((await accountsOf(fx.dorco)).targetAccounts).toEqual([])

    const named = await put(fx.dorco, { name: `Dorco x Deliplus - Diciembre ${tag}`, targetAccounts: ['dorco_es', 'deliplus'] })
    expect(named.status).toBe(200)
    expect(await accountsOf(fx.dorco)).toMatchObject({ name: `Dorco x Deliplus - Diciembre ${tag}`, targetAccounts: ['dorco_es', 'deliplus'] })
  })

  it("the brand's connected Instagram passes in PUT too, and the creators' guard still runs first", async () => {
    await prisma.setting.create({ data: { key: `brand_ig_${fx.dorcoId}`, value: 'dorco.oficial.tienda' } })
    const connected = await put(fx.dorco, { targetAccounts: ['dorco.oficial.tienda'] })
    expect(connected.status).toBe(200)
    expect((await accountsOf(fx.dorco)).targetAccounts).toEqual(['dorco.oficial.tienda'])
    await prisma.setting.delete({ where: { key: `brand_ig_${fx.dorcoId}` } })

    // A creator's handle typed as a brand account: the creators' guard answers first. The handle carries neither the
    // brand's name nor a word of the campaign's name (the test tag is one), or it would count as the brand's
    const handle = `creadora_sin_marca_${tag.slice(0, 4)}`
    const creator = await prisma.influencer.create({ data: { username: handle, platform: 'INSTAGRAM', followers: 1000 } })
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.dorco, influencerId: creator.id, status: 'CONTRACTED' } })
    const member = await put(fx.dorco, { targetAccounts: [handle, 'turbo'] })
    expect(member.status).toBe(400)
    expect(member.body.memberAccounts).toEqual([handle])
    expect(member.body.genericAccounts).toBeUndefined()
    await prisma.campaignInfluencer.deleteMany({ where: { influencerId: creator.id } })
    await prisma.influencer.delete({ where: { id: creator.id } })
  })
})
