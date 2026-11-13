/**
 * Late pieces in the team figures, and nowhere else.
 *
 * computeCampaignOverview gains four team-only keys (perMedia[].lateDays,
 * perInfluencer[].latePieces / maxLateDays, delivery.summary); every existing
 * key keeps its value. «Fuera de plazo» never reaches the client: the portal
 * payload, the brand's view of the campaign, stripEconomics and the exports
 * (CSV / JSON) carry none of the four.
 * Real (throwaway) database, invented handles, network mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  session: null as null | { id: string; email: string; name: string; role: string },
}))

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

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => net.session) }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { InfluencerStatus, MediaType } from '@/generated/prisma/client'
import { computeCampaignOverview, stripEconomics, stripTeamOnly } from '@/lib/campaign-overview'
import type { TeamCampaignOverview } from '@/lib/campaign-overview'
import { DEFAULT_EMV_RATES } from '@/lib/emv'
import { GET as portalGET } from '@/app/api/portal/campaigns/[id]/route'
import { GET as campaignGET } from '@/app/api/campaigns/[id]/route'
import { GET as exportGET } from '@/app/api/campaigns/[id]/export/route'

const fetchStub = vi.fn()
vi.stubGlobal('fetch', fetchStub)

async function reset() {
  await prisma.setting.deleteMany()
  await prisma.campaignAssignment.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.user.deleteMany()
}

const LATE_KEYS = ['lateDays', 'latePieces', 'maxLateDays']
/** The keys each part of the overview had before the late rule (Nov 2026) */
const MEDIA_KEYS = ['audience', 'audienceBasis', 'audienceEstimated', 'emvBasic', 'emvExtended', 'engagements', 'id', 'influencerId', 'isDeleted', 'mediaType', 'publishedBy', 'views', 'viewsPlausible']
const CREATOR_KEYS = [
  'audience', 'byPlatform', 'cost', 'cpm', 'deleted', 'deliverablesPlanned', 'displayName', 'emvBasic', 'emvExtended', 'emvRatio',
  'engagements', 'er', 'followers', 'influencerId', 'media', 'platform', 'posts', 'status', 'stories', 'trackedClicks', 'username', 'views', 'vsBaseline',
]
const DELIVERY_KEYS = ['allOk', 'creators', 'dates', 'disclosure', 'pieces']

interface Fixture {
  campaignId: string
  pm: { id: string; email: string; name: string; role: string }
  brand: { id: string; email: string; name: string; role: string }
  c: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g', string>
  media: Record<string, string>
}

let fx: Fixture
const NOW_AFTER = new Date('2026-11-13T12:00:00Z')
const NOW_DURING = new Date('2026-10-20T12:00:00Z')

async function seed(): Promise<Fixture> {
  const pmRow = await prisma.user.create({ data: { email: 'pm-late@example.test', password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const brandRow = await prisma.user.create({ data: { email: 'marca-late@example.test', password: 'x', name: 'Cliente', role: 'BRAND' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Octubre (test de piezas tardías)', status: 'ACTIVE', type: 'INFLUENCER_TRACKING',
      startDate: new Date('2026-10-01T00:00:00Z'), endDate: new Date('2026-10-31T00:00:00Z'),
      targetAccounts: ['marca.demo'], targetHashtags: ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: brandRow.id,
    },
  })
  await prisma.campaignAssignment.create({ data: { campaignId: campaign.id, userId: brandRow.id } })

  const c = {} as Fixture['c']
  const join = async (key: keyof Fixture['c'], status: InfluencerStatus, deliverablesPlanned: number | null = null) => {
    const inf = await prisma.influencer.create({ data: { username: `creadora_plazo_${key}`, platform: 'INSTAGRAM', followers: 3000 } })
    c[key] = inf.id
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: inf.id, status, deliverablesPlanned, agreedFee: 100 } })
  }
  await join('a', 'COMPLETED')        // one piece in the window → delivered
  await join('b', 'CONTRACTED')       // one piece 5 days late → late
  await join('c', 'AGREED', 2)        // one of two in the window → late once ended, in progress before
  await join('d', 'CONTRACTED')       // nothing → not published
  await join('e', 'PROSPECT')         // not expected: nothing was agreed
  await join('f', 'POSTED', 2)        // two of two in the window → delivered
  await join('g', 'COMPLETED', 2)     // one in the window + one 2 days late → late

  const media: Record<string, string> = {}
  let n = 0
  const piece = async (key: keyof Fixture['c'], postedAt: string, mediaType: MediaType = 'REEL') => {
    n++
    const m = await prisma.media.create({
      data: {
        externalId: `plazo-${n}`, platform: 'INSTAGRAM', mediaType, caption: 'Probando la fregona nueva #marcademo #publi',
        likes: 50 + n, comments: 3, views: 1000 + n * 100, hashtags: ['marcademo'], mentions: [], postedAt: new Date(postedAt),
        source: 'manual', influencerId: c[key], campaignId: campaign.id,
      },
    })
    media[`${key}${n}`] = m.id
    return m.id
  }
  media.a = await piece('a', '2026-10-10T10:00:00Z')
  media.b = await piece('b', '2026-11-05T10:00:00Z')
  media.c = await piece('c', '2026-10-12T10:00:00Z')
  media.f1 = await piece('f', '2026-10-13T10:00:00Z')
  media.f2 = await piece('f', '2026-10-14T10:00:00Z', 'STORY')
  media.g1 = await piece('g', '2026-10-15T10:00:00Z')
  media.g2 = await piece('g', '2026-11-02T08:00:00Z')

  const user = (u: typeof pmRow) => ({ id: u.id, email: u.email, name: u.name, role: u.role })
  return { campaignId: campaign.id, pm: user(pmRow), brand: user(brandRow), c, media }
}

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  fetchStub.mockImplementation(async () => { throw new Error('fetch: the network is mocked in tests') })
  net.session = null
  fx = await seed()
})
afterAll(async () => {
  await reset()
  vi.unstubAllGlobals()
})

const overview = (now: Date = NOW_AFTER) => computeCampaignOverview(fx.campaignId, { rates: DEFAULT_EMV_RATES, now }) as Promise<TeamCampaignOverview>
const creator = (o: TeamCampaignOverview, id: string) => o.perInfluencer.find(p => p.influencerId === id)!

/** Every key of a JSON payload, at any depth */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); allKeys(v, out) }
  return out
}

// ---------------------------------------------------------------------------

describe('the team figures', () => {
  it('each piece says how many days after the end it was published (null inside the window)', async () => {
    const o = await overview()
    const late = Object.fromEntries(o.perMedia.map(m => [m.id, m.lateDays]))
    expect(late).toEqual({ [fx.media.a]: null, [fx.media.b]: 5, [fx.media.c]: null, [fx.media.f1]: null, [fx.media.f2]: null, [fx.media.g1]: null, [fx.media.g2]: 2 })
  })

  it('each creator: her late pieces and the most days late', async () => {
    const o = await overview()
    expect(creator(o, fx.c.b)).toMatchObject({ media: 1, latePieces: 1, maxLateDays: 5 })
    expect(creator(o, fx.c.g)).toMatchObject({ media: 2, latePieces: 1, maxLateDays: 2 })
    for (const k of ['a', 'c', 'd', 'e', 'f'] as const) expect(creator(o, fx.c[k]), k).toMatchObject({ latePieces: 0, maxLateDays: null })
  })

  it('delivery.summary once the campaign has ended: the four buckets add up to the members in Agreed or later', async () => {
    const o = await overview(NOW_AFTER)
    expect(o.delivery.summary).toEqual({ expected: 6, delivered: 2, late: 3, notPublished: 1, inProgress: 0 })
  })

  it('delivery.summary while the campaign runs: part of a defined number is in progress, not late', async () => {
    const o = await overview(NOW_DURING)
    expect(o.delivery.summary).toEqual({ expected: 6, delivered: 2, late: 2, notPublished: 1, inProgress: 1 })
  })

  it('the existing keys are the same and keep their values: only the four team keys are new', async () => {
    const o = await overview()
    expect(Object.keys(o.perMedia[0]).sort()).toEqual([...MEDIA_KEYS, 'lateDays'].sort())
    expect(Object.keys(o.perInfluencer[0]).sort()).toEqual([...CREATOR_KEYS, 'latePieces', 'maxLateDays'].sort())
    expect(Object.keys(o.delivery).sort()).toEqual([...DELIVERY_KEYS, 'summary'].sort())
    const shared = stripTeamOnly(o)
    expect(Object.keys(shared.perMedia[0]).sort()).toEqual(MEDIA_KEYS)
    expect(Object.keys(shared.perInfluencer[0]).sort()).toEqual(CREATOR_KEYS)
    expect(Object.keys(shared.delivery).sort()).toEqual(DELIVERY_KEYS)
    // Every other value untouched: the shared overview is the team one minus the four keys
    const byHand = JSON.parse(JSON.stringify(o))
    for (const m of byHand.perMedia) delete m.lateDays
    for (const p of byHand.perInfluencer) { delete p.latePieces; delete p.maxLateDays }
    delete byHand.delivery.summary
    expect(JSON.parse(JSON.stringify(shared))).toEqual(byHand)
    // The judgement of time only touches the summary
    expect(stripTeamOnly(await overview(NOW_DURING))).toEqual(shared)
  })

  it('«Fechas»: a late piece the rule accepted (added by hand, at most 30 days late) counts as inside the dates; any other row after the end still fails it', async () => {
    const o = await overview()
    expect(o.delivery.dates).toEqual({ inWindow: 7, total: 7, ok: true })
    expect(o.delivery.creators).toEqual({ planned: 6, delivered: 5, ok: false })
    // The same post scraped (not added by hand) is not a late piece: the row fails, as before
    await prisma.media.update({ where: { id: fx.media.b }, data: { source: 'apify' } })
    expect((await overview()).delivery.dates).toEqual({ inWindow: 6, total: 7, ok: false })
    // 31 days late is beyond the late rule
    await prisma.media.update({ where: { id: fx.media.b }, data: { source: 'manual', postedAt: new Date('2026-12-01T00:00:00Z') } })
    expect((await overview()).delivery.dates).toEqual({ inWindow: 6, total: 7, ok: false })
  })

  it('what every brand projection gets: the late piece inside the dates, no «fuera de plazo» hint (stripEconomics)', async () => {
    const brand = stripEconomics(await overview())
    expect(brand.delivery.dates).toEqual({ inWindow: 7, total: 7, ok: true })
    // A Social Listening campaign keeps its strict window
    await prisma.campaign.update({ where: { id: fx.campaignId }, data: { type: 'SOCIAL_LISTENING' } })
    expect(stripEconomics(await overview()).delivery.dates).toEqual({ inWindow: 5, total: 7, ok: false })
  })
})

// ---------------------------------------------------------------------------

describe('«fuera de plazo» never reaches the client', () => {
  it('stripEconomics (every brand projection) drops the four keys', async () => {
    const keys = allKeys(stripEconomics(await overview()))
    for (const k of [...LATE_KEYS, 'summary']) expect(keys.has(k), k).toBe(false)
  })

  it('the portal payload has none of them, for the brand and for an ADMIN looking at the portal', async () => {
    for (const session of [fx.brand, { ...fx.pm, role: 'ADMIN' }]) {
      net.session = session
      const res = await portalGET(new NextRequest(`http://localhost/api/portal/campaigns/${fx.campaignId}?mediaLimit=100`), { params: Promise.resolve({ id: fx.campaignId }) })
      expect(res.status, session.role).toBe(200)
      const body = await res.json()
      const keys = allKeys(body)
      for (const k of LATE_KEYS) expect(keys.has(k), `${session.role}: ${k}`).toBe(false)
      expect(Object.keys(body.overview.delivery).sort(), session.role).toEqual(DELIVERY_KEYS)
      expect(JSON.stringify(body), session.role).not.toMatch(/"summary":\{"expected"/)
      // The late piece itself is there, as any piece: only the label is the team's
      expect(body.overview.totals.media).toBe(7)
    }
  })

  it('the brand reading the campaign through the agency route gets none of them; the team gets them', async () => {
    const get = async () => {
      const res = await campaignGET(new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}?view=report`), { params: Promise.resolve({ id: fx.campaignId }) })
      expect(res.status).toBe(200)
      return res.json()
    }
    net.session = fx.brand
    const brandKeys = allKeys(await get())
    for (const k of LATE_KEYS) expect(brandKeys.has(k), k).toBe(false)
    expect(JSON.stringify(await get())).not.toMatch(/"summary":\{"expected"/)

    net.session = fx.pm
    const team = await get()
    expect(team.overview.delivery.summary).toMatchObject({ expected: 6 })
    expect(team.overview.perMedia.find((m: { id: string }) => m.id === fx.media.b).lateDays).toBe(5)
  })

  it('the exports (JSON and CSV) carry none of them', async () => {
    net.session = fx.pm
    const json = await (await exportGET(new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}/export?format=json`), { params: Promise.resolve({ id: fx.campaignId }) })).json()
    const keys = allKeys(json)
    for (const k of LATE_KEYS) expect(keys.has(k), k).toBe(false)
    expect(Object.keys(json.delivery).sort()).toEqual(DELIVERY_KEYS)
    expect(json.media).toHaveLength(7)
    const csv = await (await exportGET(new NextRequest(`http://localhost/api/campaigns/${fx.campaignId}/export?format=csv`), { params: Promise.resolve({ id: fx.campaignId }) })).text()
    expect(csv).not.toMatch(/fuera de plazo|lateDays|latePieces|maxLateDays|retraso/i)
  })
})
