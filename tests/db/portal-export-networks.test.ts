/**
 * One row per creator, with her networks: the client portal payload and the
 * campaign export (CSV / JSON).
 *
 * A creator is a person with several profiles. Her pieces of every profile are
 * credited to her membership (Media.influencerId) and the overview splits them
 * by the network of the publication (perInfluencer[].byPlatform). These tests
 * call the two route handlers on a real (throwaway) database and prove:
 *   - GET /api/portal/campaigns/[id] carries, per creator, the pieces and the
 *     views of each network and NOTHING else (no engagement split, no money);
 *     her row appears once; a creator hidden from the client stays out;
 *   - GET /api/campaigns/[id]/export has a «Redes» column with the networks and
 *     the pieces of each, and is staff only.
 * The network is mocked: no scraper is reachable, the session is the test's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  session: null as null | { id: string; email: string; name: string; role: string },
}))

// No test may reach a scraper.
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
  }
})

// The session is the test's; the role rule (isStaffRole) is the real one.
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { MediaType, Platform } from '@/generated/prisma/client'
import { GET as portalGET } from '@/app/api/portal/campaigns/[id]/route'
import { GET as exportGET, POST as exportPOST } from '@/app/api/campaigns/[id]/export/route'
import { linkProfile } from '@/lib/person-profiles'
import { loadReportConfig } from '@/lib/report-config'

async function reset() {
  await prisma.setting.deleteMany()
  await prisma.campaignAssignment.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.personLog.deleteMany()
  await prisma.person.deleteMany()
  await prisma.user.deleteMany()
}

interface Fixture {
  campaignId: string
  pm: { id: string }
  brandUser: { id: string }
  ana: { id: string }      // Instagram member with her TikTok linked: 2 reels + 1 TikTok video
  anaTikTok: { id: string }
  bea: { id: string }      // Instagram member, 1 reel
  cris: { id: string }     // TikTok member, nothing published yet
  dani: { id: string }     // Instagram member hidden from the client, 1 TikTok video of a linked profile
}

let fx: Fixture
let seq = 0

function piece(member: { id: string }, campaignId: string, p: { platform: Platform; mediaType?: MediaType; views: number; likes?: number; comments?: number; publishedBy?: { id: string } }) {
  seq++
  return prisma.media.create({
    data: {
      externalId: `n-${seq}`,
      platform: p.platform,
      mediaType: p.mediaType ?? (p.platform === 'TIKTOK' ? 'VIDEO' : 'REEL'),
      caption: 'Probando la fregona nueva #vileda #publi',
      likes: p.likes ?? 100,
      comments: p.comments ?? 10,
      views: p.views,
      mentions: [],
      hashtags: ['vileda'],
      postedAt: new Date(`2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T10:00:00Z`),
      influencerId: member.id,
      publishedByInfluencerId: p.publishedBy?.id ?? null,
      campaignId,
      source: 'manual',
    },
  })
}

async function seed(): Promise<Fixture> {
  const pm = await prisma.user.create({ data: { email: 'pm@example.test', password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const brandUser = await prisma.user.create({ data: { email: 'marca@example.test', password: 'x', name: 'Cliente', role: 'BRAND' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Octubre (test de redes)',
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['vileda.es'],
      targetHashtags: ['vileda'],
      targetKeywords: [],
      platforms: ['INSTAGRAM', 'TIKTOK'],
      // The brand user OWNS the campaign row: the old export let an owner BRAND in; staff only now
      userId: brandUser.id,
    },
  })
  await prisma.campaignAssignment.create({ data: { campaignId: campaign.id, userId: brandUser.id } })

  const profile = (username: string, platform: Platform, followers: number) => prisma.influencer.create({ data: { username, platform, followers } })
  const ana = await profile('ana.ig', 'INSTAGRAM', 20_000)
  const anaTikTok = await profile('ana.tt', 'TIKTOK', 8_000)
  const bea = await profile('bea.ig', 'INSTAGRAM', 12_000)
  const cris = await profile('cris.tt', 'TIKTOK', 30_000)
  const dani = await profile('dani.ig', 'INSTAGRAM', 9_000)
  const daniTikTok = await profile('dani.tt', 'TIKTOK', 3_000)

  const join = (influencerId: string, extra: Record<string, unknown> = {}) =>
    prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId, status: 'COMPLETED', ...extra } })
  // Fee, cost and shipping are agency data: they must never reach the portal
  await join(ana.id, { agreedFee: 500, cost: 450, shippingName: 'Ana Pérez', shippingCity: 'Madrid' })
  await join(bea.id, { agreedFee: 300 })
  await join(cris.id, { status: 'AGREED' })
  await join(dani.id, { agreedFee: 200 })

  await linkProfile({ memberInfluencerId: ana.id, profileInfluencerId: anaTikTok.id, actor: { id: pm.id, name: pm.name }, evidence: 'pm_confirmed' })
  await linkProfile({ memberInfluencerId: dani.id, profileInfluencerId: daniTikTok.id, actor: { id: pm.id, name: pm.name }, evidence: 'pm_confirmed' })

  await piece(ana, campaign.id, { platform: 'INSTAGRAM', views: 4_000 })
  await piece(ana, campaign.id, { platform: 'INSTAGRAM', views: 5_000 })
  await piece(ana, campaign.id, { platform: 'TIKTOK', views: 15_400, likes: 900, publishedBy: anaTikTok })
  await piece(bea, campaign.id, { platform: 'INSTAGRAM', views: 1_000 })
  await piece(dani, campaign.id, { platform: 'TIKTOK', views: 2_500, publishedBy: daniTikTok })

  // The PM hid dani from the client report
  await prisma.setting.create({ data: { key: `campaign_report_${campaign.id}`, value: JSON.stringify({ hiddenInfluencerIds: [dani.id] }) } })

  return { campaignId: campaign.id, pm, brandUser, ana, anaTikTok, bea, cris, dani }
}

const asBrand = () => { net.session = { id: fx.brandUser.id, email: 'marca@example.test', name: 'Cliente', role: 'BRAND' } }
const asEmployee = () => { net.session = { id: fx.pm.id, email: 'pm@example.test', name: 'Laura PM', role: 'EMPLOYEE' } }

function portal(campaignId = fx.campaignId) {
  return portalGET(new NextRequest(`http://localhost/api/portal/campaigns/${campaignId}?mediaLimit=100`), { params: Promise.resolve({ id: campaignId }) })
}

function exportAs(format: 'csv' | 'json', campaignId = fx.campaignId) {
  return exportGET(new NextRequest(`http://localhost/api/campaigns/${campaignId}/export?format=${format}`), { params: Promise.resolve({ id: campaignId }) })
}

/** The «RENDIMIENTO POR CREADOR» block of the CSV as objects keyed by its header */
function creatorRows(csv: string): Array<Record<string, string>> {
  const lines = csv.replace(/^﻿/, '').split('\n')
  const start = lines.indexOf('RENDIMIENTO POR CREADOR')
  expect(start, 'the CSV has the per-creator block').toBeGreaterThan(-1)
  const header = lines[start + 1].split(';')
  const rows: Array<Record<string, string>> = []
  for (let i = start + 2; i < lines.length && lines[i] !== ''; i++) {
    const cells = lines[i].split(';')
    rows.push(Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])))
  }
  return rows
}

interface PortalCreator {
  influencerId: string
  media: number
  views: number
  byPlatform: Record<string, Record<string, unknown>>
}

beforeAll(reset)
beforeEach(async () => {
  await reset()
  net.session = null
  fx = await seed()
})
afterAll(reset)

describe('GET /api/portal/campaigns/[id]: her networks reach the client, nothing else', () => {
  it('the fixture hides dani from the client (sanity check of the report config)', async () => {
    expect((await loadReportConfig(fx.campaignId)).hiddenInfluencerIds).toEqual([fx.dani.id])
  })

  it('each creator row carries the pieces and views of every network she published on, summed in her row', async () => {
    asBrand()
    const res = await portal()
    expect(res.status).toBe(200)
    const body = await res.json()
    const rows: PortalCreator[] = body.overview.perInfluencer
    const ana = rows.find(r => r.influencerId === fx.ana.id)!
    expect(ana.byPlatform).toEqual({
      INSTAGRAM: { pieces: 2, views: 9_000 },
      TIKTOK: { pieces: 1, views: 15_400 },
    })
    expect(rows.find(r => r.influencerId === fx.bea.id)!.byPlatform).toEqual({ INSTAGRAM: { pieces: 1, views: 1_000 } })
    expect(rows.find(r => r.influencerId === fx.cris.id)!.byPlatform).toEqual({})
    for (const row of rows) {
      const networks = Object.values(row.byPlatform)
      // the breakdown adds up to her row: no number the client did not already have in total
      expect(networks.reduce((s, n) => s + (n.pieces as number), 0)).toBe(row.media)
      expect(networks.reduce((s, n) => s + (n.views as number), 0)).toBe(row.views)
      // allow-list: pieces and views only (no engagement split, no money)
      for (const n of networks) expect(Object.keys(n).sort()).toEqual(['pieces', 'views'])
    }
  })

  it('a creator with several profiles is ONE row in the team and in the figures; the hidden creator is not there', async () => {
    asBrand()
    const body = await (await portal()).json()
    const team: Array<{ influencer: { id: string; username: string; platform: string } }> = body.campaign.influencers
    expect(team.map(m => m.influencer.username).sort()).toEqual(['ana.ig', 'bea.ig', 'cris.tt'])
    expect(team.filter(m => m.influencer.id === fx.ana.id)).toHaveLength(1)
    // her TikTok profile is never a member of its own
    expect(team.some(m => m.influencer.id === fx.anaTikTok.id)).toBe(false)
    const ids = (body.overview.perInfluencer as PortalCreator[]).map(r => r.influencerId).sort()
    expect(ids).toEqual([fx.ana.id, fx.bea.id, fx.cris.id].sort())
    expect(body.overview.totals.creatorsActive).toBe(2)
    // her TikTok video is in her row and in the totals, the hidden creator's video is not
    expect(body.overview.totals.media).toBe(4)
    expect(body.overview.totals.views).toBe(25_400)
  })

  it('no economics and no staff names anywhere in the payload', async () => {
    asBrand()
    const text = JSON.stringify(await (await portal()).json())
    for (const key of ['"agreedFee"', '"cost"', '"emvBasic"', '"emvRatio"', '"cpm"', '"shippingName"', '"shippingCity"', '"addedByName"', '"engagements":{']) {
      expect(text, key).not.toContain(key)
    }
    expect(text).not.toContain('Ana Pérez')
    expect(text).not.toContain('Laura PM')
  })

  it('keeps its role rule: staff without ADMIN, anonymous and out-of-scope brands are refused', async () => {
    asEmployee()
    expect((await portal()).status).toBe(403)
    net.session = null
    expect((await portal()).status).toBe(401)
    const other = await prisma.user.create({ data: { email: 'otra@example.test', password: 'x', name: 'Otra marca', role: 'BRAND' } })
    net.session = { id: other.id, email: 'otra@example.test', name: 'Otra', role: 'BRAND' }
    expect((await portal()).status).toBe(404)
  })
})

describe('GET /api/campaigns/[id]/export: a «Redes» column with the networks and the pieces of each', () => {
  it('CSV: the column sits after «Plataforma» and lists every network with her pieces there', async () => {
    asEmployee()
    const res = await exportAs('csv')
    expect(res.status).toBe(200)
    const csv = await res.text()
    const lines = csv.replace(/^﻿/, '').split('\n')
    const header = lines[lines.indexOf('RENDIMIENTO POR CREADOR') + 1]
    expect(header.startsWith('Usuario;Nombre;Plataforma;Redes;Seguidores;')).toBe(true)

    const rows = creatorRows(csv)
    const byUser = Object.fromEntries(rows.map(r => [r.Usuario, r]))
    // one row per member: her TikTok profile is not a row of its own
    expect(rows.map(r => r.Usuario).sort()).toEqual(['@ana.ig', '@bea.ig', '@cris.tt', '@dani.ig'])
    expect(byUser['@ana.ig'].Plataforma).toBe('INSTAGRAM')
    expect(byUser['@ana.ig'].Redes).toBe('Instagram: 2 | TikTok: 1')
    expect(byUser['@ana.ig'].Publicaciones).toBe('3')
    expect(byUser['@ana.ig'].Vistas).toBe('24400')
    expect(byUser['@bea.ig'].Redes).toBe('Instagram: 1')
    // nothing published yet: her own network, with 0
    expect(byUser['@cris.tt'].Redes).toBe('TikTok: 0')
    // all her pieces are on another network than her own: that network only
    expect(byUser['@dani.ig'].Redes).toBe('TikTok: 1')
    // the block keeps its width: every row has as many cells as the header
    for (const line of lines.slice(lines.indexOf('RENDIMIENTO POR CREADOR') + 2, lines.indexOf('RENDIMIENTO POR CREADOR') + 2 + rows.length)) {
      expect(line.split(';')).toHaveLength(header.split(';').length)
    }
    // the definition travels with the file
    expect(lines.some(l => l.startsWith('Redes;'))).toBe(true)
  })

  it('JSON: each creator carries her breakdown by network (agency export: pieces, views and interactions)', async () => {
    asEmployee()
    const body = await (await exportAs('json')).json()
    const ana = (body.influencers as Array<{ influencerId: string; byPlatform: unknown }>).find(i => i.influencerId === fx.ana.id)!
    expect(ana.byPlatform).toEqual({
      INSTAGRAM: { pieces: 2, views: 9_000, engagements: 220 },
      TIKTOK: { pieces: 1, views: 15_400, engagements: 910 },
    })
  })

  it('is staff only: a brand is refused even when it owns the campaign row; anonymous is refused', async () => {
    asBrand()
    expect((await exportAs('csv')).status).toBe(403)
    expect((await exportAs('json')).status).toBe(403)
    const post = await exportPOST(
      new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}/export`, { method: 'POST', body: JSON.stringify({ format: 'csv' }) }),
      { params: Promise.resolve({ id: fx.campaignId }) },
    )
    expect(post.status).toBe(403)
    net.session = { id: 'creator-1', email: 'c@example.test', name: 'Creadora', role: 'CREATOR' }
    expect((await exportAs('csv')).status).toBe(403)
    net.session = null
    expect((await exportAs('csv')).status).toBe(401)
    net.session = { id: fx.pm.id, email: 'admin@example.test', name: 'Admin', role: 'ADMIN' }
    expect((await exportAs('csv')).status).toBe(200)
  })
})
