/**
 * Adversarial review of the delivery «Revisión semanal 16 nov 2026», lens
 * «seguridad y permisos». Each test asserts the behaviour the specification
 * asks for; a RED test here is the demonstration of a finding, not a broken
 * fixture. The fix agent turns them green (or deletes the ones David decides
 * not to fix). Nothing here touches the network; the database is the
 * throwaway embedded PostgreSQL of the db project.
 *
 *  1. POST /api/influencers/[id]/link-profile: the brand guard is narrowed by
 *     the optional `campaignId` of the body. A campaignId the creator is not a
 *     member of leaves `memberships` empty, so NO brand account is checked and
 *     the brand's own handle is linked as a profile of the creator.
 *  2. POST /api/campaigns/[id]/stories («Registrar Story»): `permalink` is
 *     stored as pasted when it is not a story URL, with no scheme nor length
 *     check (mediaUrl and thumbnailUrl do have one, parseOptionalHttpUrl), and
 *     the Stories tab renders it as <a href>. The same string goes, unbounded,
 *     to the [manual-refusal] log.
 *  3. POST /api/discovery/search: `limit` and `offset` are sanitised to
 *     non-negative integers but not bounded, so a profile sort now runs
 *     `LIMIT 1000000` over the whole pool (the old code capped at 500) and a
 *     huge offset makes PostgreSQL fail on `::int`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-security-review-16nov'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { POST as linkProfilePost } from '@/app/api/influencers/[id]/link-profile/route'
import { POST as registerStoryPost } from '@/app/api/campaigns/[id]/stories/route'
import { POST as discoverySearchPost } from '@/app/api/discovery/search/route'

const tag = randomUUID().slice(0, 8)
const DAY = 24 * 60 * 60_000
const h = (name: string) => `${name}.${tag}`

const fx = { admin: '', token: '', campaign: '', creator: '', brandRows: [] as string[] }

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { email: `admin-sec-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Seguridad', role: 'ADMIN' },
  })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const campaign = await prisma.campaign.create({
    data: {
      name: `Seguridad ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM', 'TIKTOK'],
      startDate: new Date(Date.now() - 20 * DAY), endDate: new Date(Date.now() + 20 * DAY),
      targetAccounts: [h('marca.demo')], userId: admin.id,
    },
  })
  fx.campaign = campaign.id
  const creator = await prisma.influencer.create({ data: { username: h('marta'), platform: 'INSTAGRAM' } })
  fx.creator = creator.id
  await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaign, influencerId: fx.creator, status: 'CONTRACTED' } })
})

afterAll(async () => {
  await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  const rows = await prisma.influencer.findMany({ where: { username: { endsWith: `.${tag}` } }, select: { id: true, personId: true } })
  const personIds = rows.map(r => r.personId).filter((p): p is string => !!p)
  await prisma.personLog.deleteMany({ where: { personId: { in: personIds } } })
  await prisma.influencer.deleteMany({ where: { id: { in: rows.map(r => r.id) } } })
  await prisma.person.deleteMany({ where: { id: { in: personIds } } })
  await prisma.creatorProfile.deleteMany({ where: { displayName: { contains: tag } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

function staffRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('1. link-profile: the brand guard cannot be switched off with a foreign campaignId', () => {
  it('refuses the brand account (409 brand_account) even when the body names a campaign the creator is not in', async () => {
    const before = await prisma.influencer.count({ where: { username: h('marca.demo') } })
    const res = await linkProfilePost(
      staffRequest(`http://localhost/api/influencers/${fx.creator}/link-profile`, {
        platform: 'TIKTOK',
        username: h('marca.demo'),
        campaignId: `no-such-campaign-${tag}`,
      }),
      { params: Promise.resolve({ id: fx.creator }) },
    )
    const body = await res.json()
    // Expected by the specification (D2: «rechaza si es cuenta de marca»). Today: 200 and the brand's
    // handle becomes a profile of the creator (every brand post then credits her through the roster).
    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: 'brand_account' })
    expect(await prisma.influencer.count({ where: { username: h('marca.demo') } })).toBe(before)
  })
})

describe('2. «Registrar Story»: a permalink that is not a story URL is still validated as a URL', () => {
  const postedAt = new Date(Date.now() - 1 * DAY).toISOString()

  it('refuses a javascript: permalink (400) instead of storing it for the Stories tab to render as href', async () => {
    const res = await registerStoryPost(
      staffRequest(`http://localhost/api/campaigns/${fx.campaign}/stories`, {
        influencerId: fx.creator,
        permalink: 'javascript:alert(document.domain)',
        postedAt,
        views: 10,
      }),
      { params: Promise.resolve({ id: fx.campaign }) },
    )
    const body = await res.json()
    // Expected: the same rule mediaUrl / thumbnailUrl already get (parseOptionalHttpUrl, http(s) only, ≤ 2000).
    expect(res.status).toBe(400)
    expect(await prisma.media.count({ where: { campaignId: fx.campaign, permalink: { startsWith: 'javascript:' } } })).toBe(0)
    expect(body.story).toBeUndefined()
  })

  it('bounds the length of the permalink it stores and logs (the manual route logs at most 500 characters)', async () => {
    const huge = `https://example.test/${'a'.repeat(20_000)}`
    const res = await registerStoryPost(
      staffRequest(`http://localhost/api/campaigns/${fx.campaign}/stories`, {
        influencerId: fx.creator,
        permalink: huge,
        postedAt: new Date(Date.now() - 2 * DAY).toISOString(),
        views: 5,
      }),
      { params: Promise.resolve({ id: fx.campaign }) },
    )
    // Expected: refused as too long (mediaUrl is refused past 2000). Today: 201 and a 20 kB permalink row.
    expect(res.status).toBe(400)
    expect(await prisma.media.count({ where: { campaignId: fx.campaign, permalink: huge } })).toBe(0)
  })
})

describe('3. discovery/search: page size and offset are bounded', () => {
  const ids = { ana: `${tag}-ana` }

  beforeAll(async () => {
    await prisma.creatorProfile.create({ data: { id: ids.ana, displayName: `Ana ${tag}`, primaryPlatform: 'INSTAGRAM' } })
    await prisma.creatorPlatformProfile.create({
      data: { creatorId: ids.ana, platform: 'INSTAGRAM', username: `ana_${tag}`, followers: 1200, engagementRate: 3 },
    })
  })

  it('caps `limit` (the old profile sort never read more than 500 rows; the new SQL path has no cap)', async () => {
    const res = await discoverySearchPost(
      staffRequest('http://localhost/api/discovery/search', { query: tag, sortBy: 'followers', limit: 1_000_000 }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { limit: number }
    expect(body.limit).toBeLessThanOrEqual(500)
  })

  it('answers a client error, not a PostgreSQL integer overflow, for an absurd `offset`', async () => {
    const run = discoverySearchPost(
      staffRequest('http://localhost/api/discovery/search', { query: tag, sortBy: 'followers', offset: 1e12, limit: 10 }),
    )
    // Today: `OFFSET 1000000000000::int` throws "integer out of range" out of the handler (a 500 in production).
    await expect(run).resolves.toBeDefined()
    const res = await run
    expect(res.status).toBeLessThan(500)
  })
})
