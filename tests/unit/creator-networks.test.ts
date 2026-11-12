/**
 * One row per creator, with her networks (src/components/campaign-report.tsx):
 * `creatorNetworksOf` reads overview.perInfluencer[].byPlatform and
 * `CreatorNetworkList` renders it. The same piece is used by the report's «Red»
 * column (what the PDF prints), the portal's team table and the campaign page
 * (Elegir cards, Planificar table). Server-rendered markup: no DOM library, so
 * no hover is exercised here; the title attribute is checked instead.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CreatorNetworkList,
  creatorNetworkTitle,
  creatorNetworksOf,
  isMultiNetwork,
  networkLabel,
  type CreatorNetwork,
} from '@/components/campaign-report'
import { translations } from '@/i18n/translations'

const es = translations.es.campaignReport
const en = translations.en.campaignReport

/** A folded October creator: her Instagram reels and the TikTok video of her linked profile, in one row */
const folded = {
  INSTAGRAM: { pieces: 2, views: 9_000, engagements: 400 },
  TIKTOK: { pieces: 1, views: 15_400, engagements: 900 },
}

function render(props: Partial<Parameters<typeof CreatorNetworkList>[0]> & { networks: CreatorNetwork[]; ownPlatform: string | null }) {
  return renderToStaticMarkup(createElement(CreatorNetworkList, { texts: es, locale: 'es', ...props }))
}

describe('creatorNetworksOf', () => {
  it('lists every network she published on, her own first, with the pieces and views of each', () => {
    expect(creatorNetworksOf(folded, 'INSTAGRAM')).toEqual([
      { platform: 'INSTAGRAM', pieces: 2, views: 9_000 },
      { platform: 'TIKTOK', pieces: 1, views: 15_400 },
    ])
    // her own network first even when another sorts before it
    expect(creatorNetworksOf({ INSTAGRAM: { pieces: 1, views: 5 }, TIKTOK: { pieces: 3, views: 7 }, YOUTUBE: { pieces: 1, views: 0 } }, 'TIKTOK').map(n => n.platform))
      .toEqual(['TIKTOK', 'INSTAGRAM', 'YOUTUBE'])
  })

  it('the sums of the list are the sums of her row (nothing is added or lost)', () => {
    const list = creatorNetworksOf(folded, 'INSTAGRAM')
    expect(list.reduce((s, n) => s + n.pieces, 0)).toBe(3)
    expect(list.reduce((s, n) => s + n.views, 0)).toBe(24_400)
  })

  it('falls back to her own network when she has no piece, or the overview has no breakdown', () => {
    expect(creatorNetworksOf({}, 'INSTAGRAM')).toEqual([{ platform: 'INSTAGRAM', pieces: 0, views: 0 }])
    expect(creatorNetworksOf(undefined, 'TIKTOK')).toEqual([{ platform: 'TIKTOK', pieces: 0, views: 0 }])
    expect(creatorNetworksOf(null, 'YOUTUBE')).toEqual([{ platform: 'YOUTUBE', pieces: 0, views: 0 }])
    // a network with 0 pieces is not a network she published on
    expect(creatorNetworksOf({ TIKTOK: { pieces: 0, views: 0 } }, 'INSTAGRAM')).toEqual([{ platform: 'INSTAGRAM', pieces: 0, views: 0 }])
    expect(creatorNetworksOf(undefined, null)).toEqual([])
  })

  it('the report lists only networks with pieces; the roster keeps her own network too', () => {
    // every piece of hers is a TikTok video credited to her Instagram membership
    const onlyTikTok = { TIKTOK: { pieces: 1, views: 3_000 } }
    expect(creatorNetworksOf(onlyTikTok, 'INSTAGRAM')).toEqual([{ platform: 'TIKTOK', pieces: 1, views: 3_000 }])
    expect(creatorNetworksOf(onlyTikTok, 'INSTAGRAM', { includeOwn: true })).toEqual([
      { platform: 'INSTAGRAM', pieces: 0, views: 0 },
      { platform: 'TIKTOK', pieces: 1, views: 3_000 },
    ])
  })

  it('tolerates what an API may send: missing views, nulls, lowercase keys', () => {
    expect(creatorNetworksOf({ instagram: { pieces: 2 }, TIKTOK: null, YOUTUBE: { pieces: null, views: 9 } }, 'instagram'))
      .toEqual([{ platform: 'INSTAGRAM', pieces: 2, views: 0 }])
  })
})

describe('isMultiNetwork and the hover text', () => {
  it('a row is multi-network only when it spans a network other than her own', () => {
    expect(isMultiNetwork(creatorNetworksOf(folded, 'INSTAGRAM'), 'INSTAGRAM')).toBe(true)
    expect(isMultiNetwork(creatorNetworksOf({ INSTAGRAM: { pieces: 4, views: 1 } }, 'INSTAGRAM'), 'INSTAGRAM')).toBe(false)
    expect(isMultiNetwork(creatorNetworksOf({ TIKTOK: { pieces: 1, views: 1 } }, 'INSTAGRAM'), 'INSTAGRAM')).toBe(true)
    expect(isMultiNetwork(creatorNetworksOf({}, 'INSTAGRAM'), 'INSTAGRAM')).toBe(false)
  })

  it('names the pieces and the views of one network, singular and plural, in both languages', () => {
    expect(creatorNetworkTitle({ platform: 'TIKTOK', pieces: 1, views: 15_400 }, es, 'es')).toBe('1 pieza en TikTok · 15,4K vistas')
    expect(creatorNetworkTitle({ platform: 'INSTAGRAM', pieces: 2, views: 0 }, es, 'es')).toBe('2 piezas en Instagram')
    expect(creatorNetworkTitle({ platform: 'YOUTUBE', pieces: 3, views: 900 }, en, 'en')).toBe('3 pieces on YouTube · 900 views')
  })

  it('network names are the brands, not the enum', () => {
    expect(['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'tiktok', 'OTRA', ''].map(networkLabel)).toEqual(['Instagram', 'TikTok', 'YouTube', 'TikTok', 'Otra', ''])
  })
})

describe('CreatorNetworkList markup', () => {
  it('a creator who only published on her own network looks as before: one badge, no count, no hover text', () => {
    const html = render({ networks: creatorNetworksOf({ INSTAGRAM: { pieces: 4, views: 100 } }, 'INSTAGRAM'), ownPlatform: 'INSTAGRAM' })
    expect(html.match(/data-network=/g)).toHaveLength(1)
    expect(html).toContain('data-network="INSTAGRAM"')
    expect(html).toContain('>Instagram</span>')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('· 4')
    // the house Badge with the Instagram colours
    expect(html).toContain('bg-pink-50')
  })

  it('a folded creator shows both networks with the pieces of each, and says it on hover', () => {
    const html = render({ networks: creatorNetworksOf(folded, 'INSTAGRAM'), ownPlatform: 'INSTAGRAM' })
    expect(html.match(/data-network="([A-Z]+)"/g)).toEqual(['data-network="INSTAGRAM"', 'data-network="TIKTOK"'])
    expect(html).toContain('title="2 piezas en Instagram · 9K vistas"')
    expect(html).toContain('title="1 pieza en TikTok · 15,4K vistas"')
    expect(html).toMatch(/Instagram<span class="[^"]*tabular-nums[^"]*">· 2<\/span>/)
    expect(html).toMatch(/TikTok<span class="[^"]*tabular-nums[^"]*">· 1<\/span>/)
    expect(html).toContain('bg-cyan-50')
  })

  it('in the roster, her own network without pieces carries no count, the other network does', () => {
    const html = render({ networks: creatorNetworksOf({ TIKTOK: { pieces: 1, views: 0 } }, 'INSTAGRAM', { includeOwn: true }), ownPlatform: 'INSTAGRAM' })
    expect(html).toMatch(/data-network="INSTAGRAM"[^>]*>Instagram<\/span>/)
    expect(html).toMatch(/TikTok<span[^>]*>· 1<\/span>/)
  })

  it('without any network it shows a dash, never an empty cell', () => {
    expect(render({ networks: [], ownPlatform: null })).toContain('—')
  })

  it('the plain variant (portal) renders icon and text with the same counts', () => {
    const html = render({
      variant: 'plain',
      networks: creatorNetworksOf(folded, 'INSTAGRAM'),
      ownPlatform: 'INSTAGRAM',
      renderIcon: platform => createElement('i', { 'data-icon': platform }),
    })
    expect(html).not.toContain('rounded-full border')
    expect(html).toContain('<i data-icon="INSTAGRAM"></i>Instagram')
    expect(html).toContain('<i data-icon="TIKTOK"></i>TikTok')
    expect(html).toContain('· 2')
    expect(html).toContain('· 1')
  })

  it('English texts on hover in English', () => {
    const html = render({ texts: en, locale: 'en', networks: creatorNetworksOf(folded, 'INSTAGRAM'), ownPlatform: 'INSTAGRAM' })
    expect(html).toContain('title="1 piece on TikTok · 15.4K views"')
  })

  it('every new text exists in both languages with the same placeholders', () => {
    for (const key of ['networkPiecesOne', 'networkPiecesMany', 'networkViews', 'creatorsFootnoteNetworks'] as const) {
      const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(es[key].length, key).toBeGreaterThan(0)
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]))
    }
    // no em-dash in the new sentences
    expect(es.creatorsFootnoteNetworks).not.toContain('—')
  })
})
