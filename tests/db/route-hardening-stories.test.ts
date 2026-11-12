import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// POST /api/campaigns/[id]/stories: without a story link nothing
// de-duplicated, so a retry (a client that timed out and sent again) added the
// same story twice and inflated the campaign totals. The check is asked for
// with `dedupe: true` (the Claude connector sends it); the platform's own form
// does not ask, so a PM can still log two real stories of the same minute with
// the same figures (fix of 12 Nov 2026: the form had no way to override a 409).
// Counts were coerced with
// Number(v) || 0, so a typo became 0 in silence; mediaUrl, thumbnailUrl,
// mentions and hashtags were stored unvalidated.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-hardening-stories'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { POST } from '@/app/api/campaigns/[id]/stories/route'

const tag = randomUUID().slice(0, 8)
const fx = { admin: '', token: '', campaign: '', marta: '' }
const DAY = 24 * 60 * 60_000

function post(body: Record<string, unknown>): Promise<Response> {
  const req = new NextRequest(`http://localhost/api/campaigns/${fx.campaign}/stories`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ influencerId: fx.marta, ...body }),
  })
  return POST(req, { params: Promise.resolve({ id: fx.campaign }) })
}

const stories = () => prisma.media.count({ where: { campaignId: fx.campaign, mediaType: 'STORY' } })

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-stories-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Stories', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  // A window around today, so a story without a date ("now") falls inside it
  const campaign = await prisma.campaign.create({
    data: { name: `Campaña Stories ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'], startDate: new Date(Date.now() - 30 * DAY), endDate: new Date(Date.now() + 30 * DAY), userId: admin.id },
  })
  fx.campaign = campaign.id
  const marta = await prisma.influencer.create({ data: { username: `marta_st_${tag}`, platform: 'INSTAGRAM' } })
  fx.marta = marta.id
  await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: marta.id, status: 'POSTED' } })
})

afterAll(async () => {
  await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  await prisma.influencer.deleteMany({ where: { id: fx.marta } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('POST /api/campaigns/[id]/stories without a story link', () => {
  const postedAt = new Date(Date.now() - 2 * DAY).toISOString()

  it('a retry with the same date and figures is refused as a duplicate when the caller asks (dedupe): the totals do not grow', async () => {
    const first = await post({ postedAt, views: 1200, reach: 900, replies: 3, permalink: null, dedupe: true })
    expect(first.status).toBe(201)
    const created = (await first.json()) as { story: { id: string } }
    expect(await stories()).toBe(1)

    const retry = await post({ postedAt, views: 1200, reach: 900, replies: 3, permalink: null, dedupe: true })
    expect(retry.status).toBe(409)
    expect(await retry.json()).toMatchObject({ duplicate: true, storyId: created.story.id })
    expect(await stories()).toBe(1)
  })

  it('another story of that moment with other figures, or with allowDuplicate, is still registered', async () => {
    expect((await post({ postedAt, views: 800, reach: 600, replies: 0, dedupe: true })).status).toBe(201)
    expect((await post({ postedAt, views: 1200, reach: 900, replies: 3, dedupe: true, allowDuplicate: true })).status).toBe(201)
    expect(await stories()).toBe(3)
  })

  it('the platform form (no dedupe) can still log a second real story of the same minute with the same figures', async () => {
    // What stories-tracker.tsx sends: datetime-local precision, figures 0 until the creator sends hers
    const minute = new Date(Date.now() - 6 * DAY)
    minute.setUTCSeconds(0, 0)
    const form = { postedAt: minute.toISOString(), views: 0, reach: 0, replies: 0, permalink: null }
    const before = await stories()
    expect((await post(form)).status).toBe(201)
    expect((await post(form)).status).toBe(201)
    expect(await stories()).toBe(before + 2)
    // The same twin, asked for by an API caller, is refused
    const twin = await post({ ...form, dedupe: true })
    expect(twin.status).toBe(409)
    expect(await stories()).toBe(before + 2)
  })

  it('without a date (the form left empty) two stories with the same figures are two stories, as before', async () => {
    const before = await stories()
    expect((await post({ views: 0, reach: 0, replies: 0, permalink: null })).status).toBe(201)
    expect((await post({ views: 0, reach: 0, replies: 0, permalink: null })).status).toBe(201)
    expect(await stories()).toBe(before + 2)
  })
})

describe('POST /api/campaigns/[id]/stories: values', () => {
  it('a count that is not a number, negative or too large is a 400 instead of a silent 0', async () => {
    const before = await stories()
    for (const body of [{ views: 'mil' }, { reach: -5 }, { impressions: 3_000_000_000 }, { replies: { n: 1 } }, { views: '12abc' }]) {
      const res = await post({ postedAt: new Date(Date.now() - DAY).toISOString(), ...body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await stories()).toBe(before)
  })

  it('numeric text is accepted; empty counts are 0 as before', async () => {
    const res = await post({ postedAt: new Date(Date.now() - 3 * DAY).toISOString(), views: '1500', reach: '', replies: null })
    expect(res.status).toBe(201)
    const { story } = (await res.json()) as { story: { views: number; reach: number; comments: number } }
    expect(story).toMatchObject({ views: 1500, reach: 0, comments: 0 })
  })

  it('mentions and hashtags must be lists of short texts, and media links absolute http(s) URLs', async () => {
    const before = await stories()
    const bad: Record<string, unknown>[] = [
      { mentions: 'marca' },
      { hashtags: [1, 2] },
      { hashtags: Array.from({ length: 51 }, (_, i) => `h${i}`) },
      { mediaUrl: 'javascript:alert(1)' },
      { thumbnailUrl: 'ftp://x.example/a.jpg' },
      { thumbnailUrl: 42 },
    ]
    for (const body of bad) {
      expect((await post({ postedAt: new Date(Date.now() - 4 * DAY).toISOString(), ...body })).status, JSON.stringify(body)).toBe(400)
    }
    expect(await stories()).toBe(before)
    const ok = await post({ postedAt: new Date(Date.now() - 5 * DAY).toISOString(), mentions: ['marca'], hashtags: ['marcaoficial'], mediaUrl: 'https://cdn.example/s.mp4' })
    expect(ok.status).toBe(201)
  })

  it('a creator id that is not text is a 400', async () => {
    expect((await post({ influencerId: 42 })).status).toBe(400)
  })
})
