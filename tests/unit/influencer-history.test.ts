/**
 * «Historial» of a creator in the Choose tab (src/components/influencer-history.tsx),
 * review of 16 Nov 2026, point 3: the panel is a Modal (nothing clips it), the
 * statuses and campaign types are translated, each campaign shows its month,
 * the campaign being looked at is marked, and the reliability says what it is
 * computed over. Server-rendered markup, no DOM: the route is tested in
 * tests/db/influencer-history-route.test.ts. Every handle and figure is invented.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { translations } from '@/i18n/translations'
import {
  InfluencerHistoryButton,
  InfluencerHistoryPanel,
  campaignTypeLabel,
  historyMonthLabel,
  pipelineStatusLabel,
  type PriceEntry,
  type Score,
} from '@/components/influencer-history'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

/** Intl writes «300 €» with a no-break space: compared as a plain one. */
const norm = (s: string) => s.replace(/ /g, ' ')

function entry(over: Partial<PriceEntry> & { campaignId: string; campaignName: string }): PriceEntry {
  return {
    campaignType: 'INFLUENCER_TRACKING',
    agreedFee: null,
    cost: null,
    status: 'PROSPECT',
    startDate: null,
    endDate: null,
    mediaValue: 0,
    ...over,
  }
}

const NOV = entry({ campaignId: 'cnov', campaignName: 'Marca Demo - Micros Noviembre (prueba)', status: 'CONTRACTED', agreedFee: 250, startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-30T00:00:00.000Z' })
const OCT = entry({ campaignId: 'coct', campaignName: 'Marca Demo - Micros Octubre (prueba)', status: 'COMPLETED', agreedFee: 300, startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-31T00:00:00.000Z', mediaValue: 1240, emvExtended: 1240, ratioEmv: 4.13, profile: { id: 'tt1', username: 'vane.inventada.tt', platform: 'TIKTOK' } })
const POOL = entry({ campaignId: 'cpool', campaignName: 'Seleccion de Micros (prueba)', status: 'PROSPECT', campaignType: 'UGC' })
const SHIP = entry({ campaignId: 'cship', campaignName: 'Envios (prueba)', status: 'SHIPPING', campaignType: 'SOCIAL_LISTENING', startDate: '2026-10-20T00:00:00.000Z', endDate: '2026-12-05T00:00:00.000Z' })

const SCORE: Score = { total: 61, engagement: 40, reliability: 50, reliabilityBasis: { delivered: 1, closed: 2 }, roi: 100, ratioEmv: 100, consistency: 60 }

const panel = (props: Partial<Parameters<typeof InfluencerHistoryPanel>[0]> = {}) =>
  norm(renderToStaticMarkup(createElement(InfluencerHistoryPanel, { priceHistory: [NOV, OCT, POOL, SHIP], score: SCORE, locale: 'es', ...props })))

describe('labels', () => {
  it('the pipeline status as the PM reads it, SHIPPING included; an unknown value stays as it came', () => {
    expect(pipelineStatusLabel('COMPLETED', 'es')).toBe('Completado')
    expect(pipelineStatusLabel('PROSPECT', 'es')).toBe('Prospecto')
    expect(pipelineStatusLabel('SHIPPING', 'es')).toBe('Envío')
    expect(pipelineStatusLabel('SHIPPING', 'en')).toBe('Shipping')
    expect(pipelineStatusLabel('POSTED', 'en')).toBe('Posted')
    expect(pipelineStatusLabel('WHATEVER', 'es')).toBe('WHATEVER')
    expect(translations.es.pipeline.shipping).toBe('Envío')
    expect(translations.en.pipeline.shipping).toBe('Shipping')
  })

  it('the campaign type in both languages; UGC is UGC', () => {
    expect(campaignTypeLabel('INFLUENCER_TRACKING', 'es')).toBe('Seguimiento de Influencers')
    expect(campaignTypeLabel('INFLUENCER_TRACKING', 'en')).toBe('Influencer Tracking')
    expect(campaignTypeLabel('SOCIAL_LISTENING', 'es')).toBe('Social Listening')
    expect(campaignTypeLabel('UGC', 'en')).toBe('UGC')
    expect(campaignTypeLabel('OTHER', 'es')).toBe('OTHER')
  })

  it('«mes AAAA» from the campaign dates, in Europe/Madrid, without long dashes', () => {
    expect(historyMonthLabel(OCT, 'es')).toBe('octubre 2026')
    expect(historyMonthLabel(OCT, 'en')).toBe('October 2026')
    // A campaign spanning months names both; across years, both years
    expect(historyMonthLabel(SHIP, 'es')).toBe('octubre a diciembre 2026')
    expect(historyMonthLabel(SHIP, 'en')).toBe('October to December 2026')
    expect(historyMonthLabel({ startDate: '2026-12-01T00:00:00.000Z', endDate: '2027-01-31T00:00:00.000Z' }, 'es')).toBe('diciembre 2026 a enero 2027')
    // Midnight in Madrid on 1 Oct is still 30 Sep in UTC: the month is the PM's, not the server's
    expect(historyMonthLabel({ startDate: '2026-09-30T22:00:00.000Z', endDate: null }, 'es')).toBe('octubre 2026')
    // Only one date, or none
    expect(historyMonthLabel({ startDate: null, endDate: '2026-11-30T00:00:00.000Z' }, 'es')).toBe('noviembre 2026')
    expect(historyMonthLabel(POOL, 'es')).toBeNull()
    expect(historyMonthLabel({ startDate: 'not a date', endDate: null }, 'es')).toBeNull()
  })
})

describe('the panel', () => {
  it('shows each campaign with its month, translated type and status, fee and EMV; no raw enum reaches the PM', () => {
    const html = panel()
    expect(html).toContain('Marca Demo - Micros Octubre (prueba)')
    expect(html).toContain('octubre 2026')
    expect(html).toContain('noviembre 2026')
    expect(html).toContain('>Completado<')
    expect(html).toContain('>Contratado<')
    expect(html).toContain('>Prospecto<')
    expect(html).toContain('>Envío<')
    expect(html).toContain('Seguimiento de Influencers')
    expect(html).toContain('>UGC<')
    expect(html).toContain('>Social Listening<')
    expect(html).toContain('300 €')
    expect(html).toContain('250 €')
    expect(html).toContain('EMV: ')
    expect(html).toContain('Ratio EMV ')
    for (const raw of ['>COMPLETED<', '>CONTRACTED<', '>PROSPECT<', '>SHIPPING<', 'INFLUENCER_TRACKING', 'SOCIAL_LISTENING']) {
      expect(html, raw).not.toContain(raw)
    }
    // A campaign without dates says so instead of showing nothing
    expect(html).toContain('Sin fechas')
    // The profile that holds the membership when it is not the Instagram one
    expect(html).toContain('@vane.inventada.tt (TikTok)')
    // Nothing is truncated: the old 180 px cap is gone
    expect(html).not.toContain('max-w-[180px]')
    expect(html).not.toContain('truncate')
  })

  it('marks «Esta campaña» on the campaign being looked at, and only there', () => {
    const html = panel({ campaignId: 'coct' })
    expect(html.match(/data-current-campaign="true"/g)?.length).toBe(1)
    expect(html).toContain('>Esta campaña<')
    const octRow = html.slice(html.indexOf('Micros Octubre (prueba)'), html.indexOf('Seleccion de Micros (prueba)'))
    expect(octRow).toContain('Esta campaña')
    const novRow = html.slice(html.indexOf('Micros Noviembre (prueba)'), html.indexOf('Micros Octubre (prueba)'))
    expect(novRow).not.toContain('Esta campaña')
    // Without a campaign, or with one not in the history, nothing is marked
    expect(panel()).not.toContain('data-current-campaign')
    expect(panel({ campaignId: 'cother' })).not.toContain('data-current-campaign')
  })

  it('the score card says what the reliability is computed over: published among agreed, never prospects', () => {
    expect(panel()).toContain('Fiabilidad: 1 de 2 campañas acordadas publicadas')
    const noBasis = panel({ score: { ...SCORE, reliability: 0, reliabilityBasis: { delivered: 0, closed: 0 } } })
    expect(noBasis).toContain('Sin campañas acordadas todavía: los prospectos no cuentan')
    // An old answer without the basis still renders
    const legacy = panel({ score: { total: 55, engagement: 8, reliability: 67, roi: 62, consistency: 100 } })
    expect(legacy).toContain('>55<')
    expect(legacy).not.toContain('acordadas')
    expect(panel()).toContain('Puntuación global')
    expect(panel()).toContain('Bueno')
  })

  it('in English, with the same data', () => {
    const html = panel({ locale: 'en', campaignId: 'coct' })
    expect(html).toContain('October 2026')
    expect(html).toContain('>Completed<')
    expect(html).toContain('>Shipping<')
    expect(html).toContain('Influencer Tracking')
    expect(html).toContain('>This campaign<')
    expect(html).toContain('Reliability: 1 of 2 agreed campaigns published')
    expect(html).toContain('Overall score')
    expect(html).toContain('No dates')
    expect(html).toContain('€300')
  })

  it('the empty, loading and failed states', () => {
    expect(panel({ priceHistory: [], score: null })).toContain('Sin historial de campañas')
    expect(panel({ priceHistory: [], score: null, locale: 'en' })).toContain('No campaign history')
    const loading = panel({ isLoading: true })
    expect(loading).toContain('animate-spin')
    expect(loading).not.toContain('Micros Octubre')
    expect(panel({ error: 'No se pudo cargar el historial' })).toContain('No se pudo cargar el historial')
  })

  it('a campaign name written by somebody else stays text', () => {
    const evil = panel({ priceHistory: [entry({ campaignId: 'cx', campaignName: '<img src=x onerror=alert(1)>' })] })
    expect(evil).not.toContain('<img src=x')
    expect(evil).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('the button and the modal', () => {
  it('renders the translated button closed; the modal only opens on click', () => {
    const es = renderToStaticMarkup(createElement(InfluencerHistoryButton, { influencerId: 'i1', influencerName: 'Vane Inventada', locale: 'es', campaignId: 'coct' }))
    expect(es).toContain('>Historial</button>')
    expect(es).toContain('title="Historial y puntuación"')
    expect(es).not.toContain('Historial de campañas y puntuación')
    const en = renderToStaticMarkup(createElement(InfluencerHistoryButton, { influencerId: 'i1', influencerName: 'Vane Inventada', locale: 'en' }))
    expect(en).toContain('>History</button>')
  })

  it('is the centered Modal of the UI kit, not an absolute panel that the card can clip; the list scrolls inside at about 70vh', () => {
    const src = source('src/components/influencer-history.tsx')
    expect(src).toContain("from '@/components/ui/modal'")
    expect(src).toMatch(/<Modal\s+open=\{isOpen\}/)
    expect(src).not.toContain('absolute right-0')
    expect(src).not.toContain('z-[100]')
    expect(src).toContain('max-h-[70vh] overflow-y-auto')
    // Dark mode is covered
    expect(src).toContain('dark:bg-gray-900')
  })

  it('the campaign page passes the campaign it shows, in both card variants', () => {
    const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
    const uses = page.match(/<InfluencerHistoryButton[\s\S]*?\/>/g) ?? []
    expect(uses.length).toBe(2)
    for (const use of uses) expect(use).toContain('campaignId={campaignId}')
  })

  it('both languages carry the same texts', () => {
    expect(Object.keys(translations.es.influencerHistory).sort()).toEqual(Object.keys(translations.en.influencerHistory).sort())
    expect(Object.keys(translations.es.pipeline).sort()).toEqual(Object.keys(translations.en.pipeline).sort())
  })
})
