/**
 * The pure rules of the merge tool (src/lib/person-merge.ts): which links,
 * handles and names count as evidence, and how two membership rows of one
 * campaign are merged. No database, no network. Every handle is invented.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// person-merge reuses the capture's post keys; the capture module loads the scraper: never reachable here
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return { scrapeProfile: blocked('scrapeProfile'), scrapeStories: blocked('scrapeStories'), scrapeSinglePost: blocked('scrapeSinglePost'), isApifyExhausted: vi.fn(() => false) }
})

import {
  MEMBERSHIP_FIELD_GROUPS,
  editDistanceWithin,
  extractProfileLinks,
  handlesAreNear,
  linkText,
  looseHandle,
  mergeMembershipRows,
  normalizeDisplayName,
  pairKey,
} from '@/lib/person-merge'

describe('links in a website or bio', () => {
  it('reads TikTok, Instagram and YouTube profile links, normalised', () => {
    expect(extractProfileLinks('https://www.tiktok.com/@Vane_Prueba?lang=es', null)).toEqual([{ platform: 'TIKTOK', handle: 'vane_prueba' }])
    expect(extractProfileLinks(null, 'Sígueme en instagram.com/Gema.Ficticia. y en youtube.com/@gema-demo')).toEqual([
      { platform: 'INSTAGRAM', handle: 'gema.ficticia' },
      { platform: 'YOUTUBE', handle: 'gema-demo' },
    ])
    expect(extractProfileLinks('https://instagr.am/alba_demo')).toEqual([{ platform: 'INSTAGRAM', handle: 'alba_demo' }])
  })

  it('never takes a post, a reel, an e-mail, a phone or a bare name for a profile', () => {
    expect(extractProfileLinks('https://www.instagram.com/p/DfXabc123/ https://instagram.com/reel/Cxyz987/ instagram.com/stories/x')).toEqual([])
    expect(extractProfileLinks('vane.prueba@example.test · 600 000 000 · Vane Prueba · @vane_prueba')).toEqual([])
  })

  it('de-duplicates and writes a link back the way the texts show it', () => {
    expect(extractProfileLinks('tiktok.com/@dana', 'TIKTOK.COM/@Dana')).toHaveLength(1)
    expect(linkText({ platform: 'TIKTOK', handle: 'dana' })).toBe('tiktok.com/@dana')
    expect(linkText({ platform: 'INSTAGRAM', handle: 'dana' })).toBe('instagram.com/dana')
    expect(linkText({ platform: 'YOUTUBE', handle: 'dana' })).toBe('youtube.com/@dana')
  })
})

describe('near handles', () => {
  it('one contains the other, or at most three edits apart, on handles of five or more characters', () => {
    expect(handlesAreNear('lili_woods', 'lili_woods_')).toBe(true)
    expect(handlesAreNear('@Lili_Woods', 'lili_woods_')).toBe(true)
    expect(handlesAreNear('marta_demo', 'marta_dema')).toBe(true)
    expect(handlesAreNear('marta_demo', 'marto_dama')).toBe(true) // 3 edits
    expect(handlesAreNear('martademo', 'mortadima1')).toBe(false) // 4 edits
    expect(handlesAreNear('tips_casa_piliglez', 'tips_casa_piligonzalez')).toBe(false) // 4 insertions: the link is the evidence there
  })

  it('short or equal handles are never «near»', () => {
    expect(handlesAreNear('ana', 'anab')).toBe(false)
    expect(handlesAreNear('lucia', 'lucia')).toBe(false)
    expect(handlesAreNear('lucia', 'LUCIA')).toBe(false)
  })

  it('edit distance stops early and is exact when within the limit', () => {
    expect(editDistanceWithin('kitten', 'sitting', 3)).toBe(3)
    expect(editDistanceWithin('kitten', 'sitting', 2)).toBeNull()
    expect(editDistanceWithin('abc', 'abcdefgh', 3)).toBeNull()
    expect(editDistanceWithin('', '', 0)).toBe(0)
  })

  it('loose handles ignore case, dots and underscores; display names ignore accents and symbols', () => {
    expect(looseHandle('@Ale.Ficticia')).toBe(looseHandle('ale_ficticia'))
    expect(looseHandle('ale.ficticia')).not.toBe(looseHandle('ale.ficticias'))
    expect(normalizeDisplayName('  Lucía  Pérez ✨')).toBe('lucia perez')
    expect(normalizeDisplayName('Ana')).toBeNull()
    expect(normalizeDisplayName(null)).toBeNull()
    expect(pairKey('b', 'a')).toBe('a|b')
  })
})

// ---------------------------------------------------------------------------

/** A membership row as row_to_json gives it, with the schema's defaults. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm1', campaignId: 'c1', influencerId: 'i1', status: 'COMPLETED', source: 'manual',
    cost: 0, agreedFee: null, commission: 0, notes: null, portfolioUrl: null, contentDelivered: false,
    askingFee: null, negotiatedFormat: null, rightsDays: null, exclusivityDays: null, whitelisting: false, urgent: false, crossposting: false,
    dealClosedAt: null, deliverablesPlanned: null, trackedLink: null, trackedClicks: null, baselineSnapshot: null, baselineAt: null,
    shippingName: null, shippingAddress1: null, shippingAddress2: null, shippingCity: null, shippingPostCode: null, shippingCountry: null,
    shippingPhone: null, shippingEmail: null, shippingProduct: null, shippingQty: 1, shippingComments: null,
    addedById: null, addedByName: null, createdAt: '2026-10-01T09:00:00', updatedAt: '2026-10-02T09:00:00',
    ...over,
  }
}

describe('merging two membership rows of one campaign', () => {
  it('identical rows (the October pairs: fee 100 and cost 100 on both) merge into the survivor unchanged, with nothing to choose', () => {
    const s = row({ agreedFee: 100, cost: 100 })
    const o = row({ id: 'm2', influencerId: 'i2', agreedFee: 100, cost: 100, createdAt: '2026-11-02T10:00:00' })
    const m = mergeMembershipRows(s, o)
    expect(m.fields).toEqual([])
    expect(m.missing).toEqual([])
    expect(m.changedColumns).toEqual([])
    expect(m.merged).toEqual(s)
  })

  it('a value on one side only is kept; ids, campaign and updatedAt never move', () => {
    const s = row({ agreedFee: 120, notes: null, trackedLink: null })
    const o = row({ id: 'm2', influencerId: 'i2', campaignId: 'c9', cost: 30, notes: 'Talla M', trackedLink: 'https://example.test/u', updatedAt: '2030-01-01T00:00:00' })
    const m = mergeMembershipRows(s, o)
    expect(m.merged).toMatchObject({ id: 'm1', campaignId: 'c1', influencerId: 'i1', updatedAt: '2026-10-02T09:00:00', agreedFee: 120, cost: 30, notes: 'Talla M', trackedLink: 'https://example.test/u' })
    expect(m.fields.map(f => [f.group, f.resolution])).toEqual([['cost', 'from_other'], ['notes', 'from_other'], ['tracked', 'from_other']])
    expect(m.missing).toEqual([])
    expect(m.changedColumns.sort()).toEqual(['cost', 'notes', 'trackedLink'])
  })

  it('money in conflict has NO default: listed, missing until chosen; keep / other / add', () => {
    const s = row({ agreedFee: 100 })
    const o = row({ id: 'm2', agreedFee: 80.5 })
    const none = mergeMembershipRows(s, o)
    expect(none.missing).toEqual(['agreedFee'])
    expect(none.fields).toEqual([expect.objectContaining({ group: 'agreedFee', conflict: true, options: ['keep', 'other', 'add'], default: null, chosen: null, needsChoice: true, result: null, survivorValue: 100, otherValue: 80.5 })])
    expect(none.merged.agreedFee).toBe(100)
    expect(mergeMembershipRows(s, o, { agreedFee: 'keep' }).merged.agreedFee).toBe(100)
    expect(mergeMembershipRows(s, o, { agreedFee: 'other' }).merged.agreedFee).toBe(80.5)
    const added = mergeMembershipRows(s, o, { agreedFee: 'add' })
    expect(added.merged.agreedFee).toBe(180.5)
    expect(added.missing).toEqual([])
    expect(added.fields[0]).toMatchObject({ chosen: 'add', needsChoice: false, result: 180.5 })
    // Zero is no money: the side with money wins without a choice
    expect(mergeMembershipRows(row({ cost: 0 }), row({ id: 'm2', cost: 40 })).merged.cost).toBe(40)
    for (const g of ['cost', 'commission', 'askingFee']) {
      expect(mergeMembershipRows(row({ [g]: 10 }), row({ id: 'm2', [g]: 20 })).missing, g).toEqual([g])
    }
  })

  it('deliverables in conflict: keep / other / add, no default', () => {
    const m = mergeMembershipRows(row({ deliverablesPlanned: 2 }), row({ id: 'm2', deliverablesPlanned: 1 }))
    expect(m.missing).toEqual(['deliverablesPlanned'])
    expect(mergeMembershipRows(row({ deliverablesPlanned: 2 }), row({ id: 'm2', deliverablesPlanned: 1 }), { deliverablesPlanned: 'add' }).merged.deliverablesPlanned).toBe(3)
    expect(mergeMembershipRows(row({ deliverablesPlanned: null }), row({ id: 'm2', deliverablesPlanned: 1 })).merged.deliverablesPlanned).toBe(1)
  })

  it('status: the most advanced by default, listed, and can be overridden', () => {
    const m = mergeMembershipRows(row({ status: 'CONTRACTED' }), row({ id: 'm2', status: 'COMPLETED' }))
    expect(m.merged.status).toBe('COMPLETED')
    expect(m.fields).toEqual([expect.objectContaining({ group: 'status', conflict: true, default: 'other', chosen: 'other', needsChoice: false })])
    expect(mergeMembershipRows(row({ status: 'COMPLETED' }), row({ id: 'm2', status: 'AGREED' })).merged.status).toBe('COMPLETED')
    expect(mergeMembershipRows(row({ status: 'CONTRACTED' }), row({ id: 'm2', status: 'COMPLETED' }), { status: 'keep' }).merged.status).toBe('CONTRACTED')
  })

  it('the shipping block is one choice: taken whole from the only side with data, no default when both have data', () => {
    const address = { shippingName: 'Vane P.', shippingAddress1: 'Calle Inventada 3', shippingCity: 'Sevilla', shippingQty: 2 }
    const only = mergeMembershipRows(row(), row({ id: 'm2', ...address }))
    expect(only.merged).toMatchObject(address)
    expect(only.fields.map(f => f.group)).toEqual(['shipping'])
    const both = mergeMembershipRows(row({ shippingName: 'Otra', shippingCity: 'Bilbao' }), row({ id: 'm2', ...address }))
    expect(both.missing).toEqual(['shipping'])
    expect(both.fields[0]).toMatchObject({ options: ['keep', 'other'], default: null })
    const other = mergeMembershipRows(row({ shippingName: 'Otra', shippingCity: 'Bilbao' }), row({ id: 'm2', ...address }), { shipping: 'other' })
    // The whole block, never a mix of two addresses
    expect(other.merged).toMatchObject({ ...address, shippingAddress2: null })
    expect(mergeMembershipRows(row({ shippingName: 'Otra' }), row({ id: 'm2', ...address }), { shipping: 'add' }).invalid).toEqual(['shipping'])
  })

  it('notes are joined; booleans: true wins; deal terms and the like default to the survivor’s', () => {
    const m = mergeMembershipRows(
      row({ notes: 'Prefiere martes', whitelisting: false, urgent: true, negotiatedFormat: 'REEL', rightsDays: 30, baselineSnapshot: { n: 3 }, baselineAt: '2026-09-01T00:00:00' }),
      row({ id: 'm2', notes: 'Vídeo el 12', whitelisting: true, urgent: false, negotiatedFormat: 'VIDEO', rightsDays: 90, baselineSnapshot: { n: 5 }, baselineAt: '2026-09-02T00:00:00' })
    )
    expect(m.merged.notes).toBe('Prefiere martes\n\nVídeo el 12')
    expect(m.merged).toMatchObject({ whitelisting: true, urgent: true, negotiatedFormat: 'REEL', rightsDays: 30, baselineSnapshot: { n: 3 }, baselineAt: '2026-09-01T00:00:00' })
    expect(m.missing).toEqual([])
    const by = new Map(m.fields.map(f => [f.group, f]))
    expect(by.get('notes')).toMatchObject({ resolution: 'joined', conflict: false })
    expect(by.get('whitelisting')).toMatchObject({ conflict: true, default: 'other', chosen: 'other' })
    expect(by.get('urgent')).toMatchObject({ conflict: true, default: 'keep', chosen: 'keep' })
    expect(by.get('negotiatedFormat')).toMatchObject({ conflict: true, default: 'keep' })
    expect(by.get('baseline')).toMatchObject({ conflict: true, default: 'keep', survivorValue: { baselineSnapshot: { n: 3 }, baselineAt: '2026-09-01T00:00:00' } })
    expect(mergeMembershipRows(row({ rightsDays: 30 }), row({ id: 'm2', rightsDays: 90 }), { rightsDays: 'other' }).merged.rightsDays).toBe(90)
  })

  it('createdAt and who added her: the earliest row’s', () => {
    const s = row({ createdAt: '2026-11-02T10:00:00', addedById: 'u2', addedByName: 'Laura PM' })
    const o = row({ id: 'm2', createdAt: '2026-10-19T08:00:00.5', addedById: null, addedByName: null })
    const m = mergeMembershipRows(s, o)
    expect(m.merged).toMatchObject({ createdAt: '2026-10-19T08:00:00.5', addedById: null, addedByName: null })
    expect(m.fields).toEqual([expect.objectContaining({ group: 'createdAt', resolution: 'earliest', conflict: false })])
    expect(mergeMembershipRows(o, s).fields).toEqual([])
  })

  it('a column the groups do not know (added to the table later) defaults to the survivor’s, listed', () => {
    const m = mergeMembershipRows(row({ futureColumn: 'a' }), row({ id: 'm2', futureColumn: 'b' }))
    expect(m.merged.futureColumn).toBe('a')
    expect(m.fields).toEqual([expect.objectContaining({ group: 'futureColumn', default: 'keep', conflict: true })])
  })

  it('every column of campaign_influencers in the schema belongs to one group (or is an id, the campaign or updatedAt)', () => {
    const schema = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prisma', 'schema.prisma'), 'utf8')
    const block = schema.match(/model CampaignInfluencer \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const columns = block.split('\n')
      .map(line => line.match(/^\s+(\w+)\s+(\w+)(\?|\[\])?/))
      .filter((m): m is RegExpMatchArray => !!m && !['Campaign', 'Influencer'].includes(m[2]))
      .map(m => m[1])
    expect(columns.length).toBeGreaterThan(30)
    const grouped = new Set(MEMBERSHIP_FIELD_GROUPS.flatMap(g => g.columns))
    expect(columns.filter(c => !grouped.has(c) && !['id', 'campaignId', 'influencerId', 'updatedAt'].includes(c))).toEqual([])
    // And the row of these tests has them all
    expect(columns.filter(c => !(c in row()))).toEqual([])
    expect(new Set(MEMBERSHIP_FIELD_GROUPS.map(g => g.group)).size).toBe(MEMBERSHIP_FIELD_GROUPS.length)
  })
})
