/**
 * POST /api/campaigns/[id]/stories, «Registrar Story» (revisión semanal 16 nov
 * 2026, point 2): the owner of the story link is resolved with the campaign
 * roster, as «Añadir publicación por URL» does.
 *
 *  - A story published from another profile of the same creator is accepted,
 *    credited to her member row and remembers the profile that published it.
 *  - «El enlace es de @x, no de @y» only when no profile of the person matches.
 *  - The brand's accounts are never credited to a creator (same guard as the
 *    manual route).
 *  - A highlight is refused unless the PM types the date.
 *  - Every 400/409 is logged as [manual-refusal].
 *
 * No network: stories are never scraped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-stories-roster'
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { linkProfile } from '@/lib/person-profiles'
import { POST } from '@/app/api/campaigns/[id]/stories/route'
import { storyIdAt } from './fixtures/october'

const tag = randomUUID().slice(0, 8)
const DAY = 24 * 60 * 60_000
const BRAND_ID = `brand_${tag}`
const OWN = `marcademo.oficial.${tag}`

const fx = {
  admin: '', token: '', campaign: '',
  marta: '', martaSecond: '', martaTikTok: '', lucia: '', luciaTwo: '', nadie: '', brandRow: '',
  influencers: [] as string[],
}
const h = (name: string) => `${name}.${tag}`

async function post(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/campaigns/${fx.campaign}/stories`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await POST(req, { params: Promise.resolve({ id: fx.campaign }) })
  return { status: res.status, body: await res.json() }
}

let seq = 1
/** A story link of `handle` published 2 days ago (inside the campaign window), each one a different story */
function storyLink(handle: string, daysAgo = 2) {
  const iso = new Date(Date.now() - daysAgo * DAY).toISOString()
  const id = storyIdAt(iso, seq++)
  return { url: `https://www.instagram.com/stories/${handle}/${id}/`, id, postedAt: iso }
}

async function creator(username: string, platform: 'INSTAGRAM' | 'TIKTOK' = 'INSTAGRAM') {
  const row = await prisma.influencer.create({ data: { username, platform } })
  fx.influencers.push(row.id)
  return row.id
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `admin-roster-${tag}@correo-inventado.test`, password: 'x', name: 'Admin Roster', role: 'ADMIN' } })
  fx.admin = admin.id
  fx.token = generateToken(admin.id, 'ADMIN')
  const campaign = await prisma.campaign.create({
    data: {
      name: `Roster ${tag}`, status: 'ACTIVE', type: 'INFLUENCER_TRACKING', platforms: ['INSTAGRAM'],
      startDate: new Date(Date.now() - 30 * DAY), endDate: new Date(Date.now() + 30 * DAY),
      targetAccounts: [h('marca.demo')], userId: admin.id,
    },
  })
  fx.campaign = campaign.id
  // The brand's own Instagram connected through Meta (not among the targets)
  await prisma.setting.create({ data: { key: BRAND_ID, value: JSON.stringify({ id: BRAND_ID, name: 'Marca Demo' }) } })
  await prisma.setting.create({ data: { key: `brand_ig_${BRAND_ID}`, value: OWN } })
  await prisma.setting.create({ data: { key: `campaign_brand_${fx.campaign}`, value: BRAND_ID } })

  // Members: @marta (CONTRACTED) and @lucia (POSTED), each with a second Instagram profile linked
  fx.marta = await creator(h('marta'))
  fx.martaSecond = await creator(h('marta.second'))
  fx.lucia = await creator(h('lucia'))
  fx.luciaTwo = await creator(h('lucia.two'))
  fx.nadie = await creator(h('nadie'))
  await prisma.campaignInfluencer.createMany({
    data: [
      { campaignId: fx.campaign, influencerId: fx.marta, status: 'CONTRACTED' },
      { campaignId: fx.campaign, influencerId: fx.lucia, status: 'POSTED' },
    ],
  })
  await linkProfile({ memberInfluencerId: fx.marta, profileInfluencerId: fx.martaSecond, actor: null, evidence: 'pm_manual' })
  await linkProfile({ memberInfluencerId: fx.lucia, profileInfluencerId: fx.luciaTwo, actor: null, evidence: 'pm_manual' })
})

beforeEach(async () => {
  await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
})

afterAll(async () => {
  await prisma.media.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign } })
  await prisma.campaign.deleteMany({ where: { id: fx.campaign } })
  const persons = await prisma.influencer.findMany({ where: { id: { in: fx.influencers } }, select: { personId: true } })
  const personIds = persons.map(p => p.personId).filter((p): p is string => !!p)
  await prisma.personLog.deleteMany({ where: { personId: { in: personIds } } })
  await prisma.influencer.deleteMany({ where: { id: { in: fx.influencers } } })
  await prisma.person.deleteMany({ where: { id: { in: personIds } } })
  await prisma.setting.deleteMany({ where: { key: { in: [BRAND_ID, `brand_ig_${BRAND_ID}`, `campaign_brand_${fx.campaign}`] } } })
  await prisma.user.deleteMany({ where: { id: fx.admin } })
})

describe('whose story it is: the roster decides', () => {
  it('her own link: credited to her, published by nobody else, on Instagram', async () => {
    const link = storyLink(h('marta'))
    const res = await post({ influencerId: fx.marta, permalink: link.url, views: 120 })
    expect(res.status).toBe(201)
    expect(res.body.story).toMatchObject({ influencerId: fx.marta, publishedByInfluencerId: null, platform: 'INSTAGRAM', externalId: link.id, source: 'manual', views: 120 })
    expect(new Date(res.body.story.postedAt).toISOString()).toBe(link.postedAt)
  })

  it('a story from her second Instagram is accepted, credited to her row and remembers the profile that published it', async () => {
    const link = storyLink(h('marta.second'))
    const res = await post({ influencerId: fx.marta, permalink: link.url, views: 300, reach: 280 })
    expect(res.status).toBe(201)
    expect(res.body.story).toMatchObject({ influencerId: fx.marta, publishedByInfluencerId: fx.martaSecond, platform: 'INSTAGRAM', externalId: link.id, views: 300, reach: 280 })
    expect(res.body.updated).toBe(false)

    // Registered again (the figures arrived): the same row is refreshed and keeps who published it
    const again = await post({ influencerId: fx.marta, permalink: link.url, views: 450 })
    expect(again.status).toBe(200)
    expect(again.body.updated).toBe(true)
    expect(again.body.story).toMatchObject({ id: res.body.story.id, publishedByInfluencerId: fx.martaSecond, views: 450, reach: 280 })
    expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(1)
  })

  it('«El enlace es de @x, no de @y» only when no profile of the person matches, naming the member to pick', async () => {
    const before = await prisma.media.count({ where: { campaignId: fx.campaign } })

    // Nobody's profile in this campaign
    const stranger = await post({ influencerId: fx.marta, permalink: storyLink(h('nadie')).url })
    expect(stranger.status).toBe(400)
    expect(stranger.body).toEqual({ error: `El enlace es de @${h('nadie')}, no de @${h('marta')}.`, ownerUsername: h('nadie') })

    // Another member's own profile
    const other = await post({ influencerId: fx.marta, permalink: storyLink(h('lucia')).url })
    expect(other.status).toBe(400)
    expect(other.body).toEqual({ error: `El enlace es de @${h('lucia')}, no de @${h('marta')}.`, ownerUsername: h('lucia') })

    // Another member's second profile: the form is told the member it counts for
    const otherSecond = await post({ influencerId: fx.marta, permalink: storyLink(h('lucia.two')).url })
    expect(otherSecond.status).toBe(400)
    expect(otherSecond.body).toEqual({
      error: `El enlace es de @${h('lucia.two')}, que es un perfil de @${h('lucia')}, no de @${h('marta')}.`,
      ownerUsername: h('lucia'),
    })

    expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(before)
  })

  it('a legacy double membership (her TikTok row is a member too): credited where the roster says, as the manual route does', async () => {
    fx.martaTikTok = await creator(h('marta'), 'TIKTOK')
    await linkProfile({ memberInfluencerId: fx.marta, profileInfluencerId: fx.martaTikTok, actor: null, evidence: 'pm_manual' })
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaign, influencerId: fx.martaTikTok, status: 'CONTRACTED' } })
    try {
      const link = storyLink(h('marta'))
      // The PM picked her TikTok row; the link is her Instagram story, itself a member: filed under the Instagram row
      const res = await post({ influencerId: fx.martaTikTok, permalink: link.url })
      expect(res.status).toBe(201)
      expect(res.body.story).toMatchObject({ influencerId: fx.marta, publishedByInfluencerId: null, platform: 'INSTAGRAM' })
    } finally {
      await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign, influencerId: fx.martaTikTok } })
    }
  })
})

describe('the brand’s accounts are never credited to a creator', () => {
  it('a story of a "Cuenta de Marca Objetivo" or of the brand’s connected Instagram is refused for any creator', async () => {
    const target = await post({ influencerId: fx.marta, permalink: storyLink(h('marca.demo')).url })
    expect(target).toEqual({
      status: 400,
      body: { error: `@${h('marca.demo')} es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @${h('marta')}.` },
    })
    const own = await post({ influencerId: fx.lucia, permalink: storyLink(OWN).url })
    expect(own).toEqual({
      status: 400,
      body: { error: `@${OWN} es la cuenta de la marca de esta campaña. Su contenido no se guarda en la fila de @${h('lucia')}.` },
    })
    expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(0)
  })

  it('also when the brand’s account was registered as a profile of hers elsewhere', async () => {
    const brandSecond = await creator(h('marca.demo'))
    await linkProfile({ memberInfluencerId: fx.lucia, profileInfluencerId: brandSecond, actor: null, evidence: 'pm_manual' })
    const res = await post({ influencerId: fx.lucia, permalink: storyLink(h('marca.demo')).url })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(`@${h('marca.demo')} es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @${h('lucia')}.`)
    // Nor to another creator who picked herself
    const other = await post({ influencerId: fx.marta, permalink: storyLink(h('marca.demo')).url })
    expect(other.status).toBe(400)
    expect(other.body.error).toContain('Su contenido no se guarda en la fila de @')
    expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(0)
  })

  it('the brand added as a creator keeps its own stories', async () => {
    fx.brandRow = await creator(OWN)
    await prisma.campaignInfluencer.create({ data: { campaignId: fx.campaign, influencerId: fx.brandRow, status: 'COMPLETED' } })
    try {
      const res = await post({ influencerId: fx.brandRow, permalink: storyLink(OWN).url })
      expect(res.status).toBe(201)
      expect(res.body.story).toMatchObject({ influencerId: fx.brandRow, publishedByInfluencerId: null })
    } finally {
      await prisma.campaignInfluencer.deleteMany({ where: { campaignId: fx.campaign, influencerId: fx.brandRow } })
    }
  })
})

describe('a highlight is not a dated story', () => {
  const HIGHLIGHT = 'https://www.instagram.com/stories/highlights/17912345678901234/'

  it('is refused without a typed date, with the same first sentence as «Añadir publicación por URL»', async () => {
    const res = await post({ influencerId: fx.marta, permalink: HIGHLIGHT, views: 50 })
    expect(res.status).toBe(400)
    expect(res.body.needsPostedAt).toBe(true)
    expect(res.body.error).toContain('Los destacados (highlights) no son stories con fecha')
    expect(res.body.error).toContain('"Fecha de publicación"')
    expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(0)
  })

  it('is stored as a hand-added story with the typed date when the PM types one', async () => {
    const postedAt = new Date(Date.now() - 4 * DAY).toISOString()
    const res = await post({ influencerId: fx.marta, permalink: `${HIGHLIGHT}?igsh=abc`, postedAt, views: 50 })
    expect(res.status).toBe(201)
    expect(res.body.story).toMatchObject({ influencerId: fx.marta, externalId: null, permalink: HIGHLIGHT, source: 'manual', views: 50, platform: 'INSTAGRAM' })
    expect(new Date(res.body.story.postedAt).toISOString()).toBe(postedAt)
  })
})

describe('every refusal leaves a trace in the server log', () => {
  it('a 400 is logged as [manual-refusal] with the campaign, the creator, the code, the reason and the link, never the figures; a success is not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const link = storyLink(h('nadie'))
      const refused = await post({ influencerId: fx.marta, permalink: link.url, views: 777 })
      expect(refused.status).toBe(400)
      const entries = warn.mock.calls.filter(call => call[0] === '[manual-refusal]').map(call => JSON.parse(String(call[1])) as Record<string, unknown>)
      expect(entries).toEqual([{
        route: 'stories', campaignId: fx.campaign, influencerId: fx.marta, status: 400, code: 'link_owner',
        reason: `El enlace es de @${h('nadie')}, no de @${h('marta')}.`, url: link.url,
      }])
      // Never the figures typed: asserted by key (the story id in `url` may well contain any digits)
      expect(entries[0]).not.toHaveProperty('views')
      expect(entries[0]).not.toHaveProperty('reach')
      expect(entries[0]).not.toHaveProperty('impressions')

      warn.mockClear()
      const highlight = await post({ influencerId: fx.marta, permalink: 'https://www.instagram.com/stories/highlights/17912345678901234/' })
      expect(highlight.status).toBe(400)
      expect(JSON.parse(String(warn.mock.calls[0][1]))).toMatchObject({ code: 'highlight_needs_date', status: 400 })

      warn.mockClear()
      const notMember = await post({ influencerId: fx.nadie, permalink: null })
      expect(notMember.status).toBe(400)
      expect(JSON.parse(String(warn.mock.calls[0][1]))).toMatchObject({ code: 'not_member', influencerId: fx.nadie, url: null })

      warn.mockClear()
      expect((await post({ influencerId: fx.marta, permalink: storyLink(h('marta')).url })).status).toBe(201)
      expect(warn.mock.calls.filter(call => call[0] === '[manual-refusal]')).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('a permalink that is not a story link is still a web address (18 Nov 2026)', () => {
  it('refuses javascript: and a 20 kB string with 400, stores nothing, and logs the link cut at 500 characters', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const postedAt = new Date(Date.now() - 1 * DAY).toISOString()
      const before = await prisma.media.count({ where: { campaignId: fx.campaign } })
      const script = await post({ influencerId: fx.marta, permalink: 'javascript:alert(document.domain)', postedAt, views: 10 })
      expect(script.status).toBe(400)
      expect(script.body).toMatchObject({ error: expect.stringContaining('dirección web') })
      const huge = `https://example.test/${'a'.repeat(20_000)}`
      const long = await post({ influencerId: fx.marta, permalink: huge, postedAt, views: 5 })
      expect(long.status).toBe(400)
      expect(await prisma.media.count({ where: { campaignId: fx.campaign } })).toBe(before)
      const logged = warn.mock.calls.filter(c => c[0] === '[manual-refusal]').map(c => JSON.parse(String(c[1])) as { url: string | null })
      expect(logged).toHaveLength(2)
      expect(logged[0].url).toBe('javascript:alert(document.domain)')
      expect(logged[1].url).toHaveLength(500)
    } finally {
      warn.mockRestore()
    }
  })

  it('a web address typed without its scheme is stored with https://', async () => {
    const postedAt = new Date(Date.now() - 1 * DAY).toISOString()
    const res = await post({ influencerId: fx.marta, permalink: 'www.ejemplo.test/mi-story', postedAt, views: 3 })
    expect(res.status).toBe(201)
    expect(res.body.story.permalink).toBe('https://www.ejemplo.test/mi-story')
  })
})
