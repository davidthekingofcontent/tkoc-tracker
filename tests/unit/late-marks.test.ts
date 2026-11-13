/**
 * «Fuera de plazo» on screen (Nov 2026): the badge of a late piece, the team
 * line «Han entregado X · Con retraso Y · Sin publicar Z» and the message of
 * «Añadir publicación por URL». TEAM ONLY: the campaign page shows them to
 * staff, the report only in the agency view on screen (never in the client
 * view, the print or the PDF), and a brand's overview carries none of the keys
 * (the server strips them: tests/db/late-overview.test.ts).
 *
 * Pure markup and source checks: no browser, no database.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { translations } from '@/i18n/translations'
import {
  DeliverySummaryLine,
  LateBadge,
  campaignIsRunning,
  deliverySummaryOf,
  deliverySummaryText,
  lateDaysByMediaId,
  lateDaysForDisplay,
  lateDaysText,
} from '@/components/campaign-report'
import { campaignWindowEndExclusive, lateDaysOf } from '@/lib/assignment-rules'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in values ? String(values[k]) : whole))

const es = translations.es.campaignReport
const en = translations.en.campaignReport

describe('the late badge', () => {
  it('«Fuera de plazo · N días», singular for one day, in both languages', () => {
    expect(lateDaysText(5, es)).toBe('5 días')
    expect(lateDaysText(1, es)).toBe('1 día')
    expect(lateDaysText(1, en)).toBe('1 day')
    const html = renderToStaticMarkup(createElement(LateBadge, { days: 5, tr: es }))
    expect(html).toContain('Fuera de plazo · 5 días')
    expect(html).toContain(`title="${es.lateBadgeTitle}"`)
    expect(html).toContain('data-late-days="5"')
    expect(renderToStaticMarkup(createElement(LateBadge, { days: 1, tr: en }))).toContain('Late · 1 day')
  })

  it('nothing without a positive number of days (inside the window, a brand overview, garbage)', () => {
    for (const days of [null, undefined, 0, -3, Number.NaN]) {
      expect(renderToStaticMarkup(createElement(LateBadge, { days, tr: es }))).toBe('')
    }
  })

  it('the days are read from the TEAM overview by media id; a brand overview has none', () => {
    const team = { perMedia: [{ id: 'm1', lateDays: 5 }, { id: 'm2', lateDays: null }, { id: 'm3' }, { id: 4, lateDays: 2 }, null] }
    expect(Array.from(lateDaysByMediaId(team))).toEqual([['m1', 5]])
    expect(lateDaysByMediaId({ perMedia: [{ id: 'm1', views: 10 }] }).size).toBe(0)
    expect(lateDaysByMediaId(null).size).toBe(0)
    expect(lateDaysByMediaId({ perMedia: 'x' }).size).toBe(0)
  })
})

describe('the team line under «Prometido vs entregado»', () => {
  const summary = { expected: 6, delivered: 2, late: 3, notPublished: 1, inProgress: 0 }

  it('after the end: delivered, late, not published', () => {
    expect(deliverySummaryText(summary, false, es)).toBe('Han entregado 2 · Con retraso 3 · Sin publicar 1')
    const html = renderToStaticMarkup(createElement(DeliverySummaryLine, { summary, running: false, tr: es }))
    expect(html).toContain('Han entregado 2 · Con retraso 3 · Sin publicar 1')
    expect(html).not.toContain('En curso')
    expect(html).toContain('solo equipo')
    expect(html).toContain(`title="${fill(es.deliverySummaryTitle, { expected: 6 })}"`)
  })

  it('while the campaign runs, also «En curso W»', () => {
    expect(deliverySummaryText({ ...summary, inProgress: 1, late: 2 }, true, es)).toBe('Han entregado 2 · Con retraso 2 · Sin publicar 1 · En curso 1')
    expect(deliverySummaryText(summary, true, en)).toBe('Delivered 2 · Late 3 · Not published 1 · In progress 0')
  })

  it('only from a well-formed team summary; nothing for a brand (no summary) or an older answer', () => {
    expect(deliverySummaryOf({ creators: {}, summary })).toEqual(summary)
    expect(deliverySummaryOf({ creators: {} })).toBeNull()
    expect(deliverySummaryOf({ summary: { ...summary, late: '3' } })).toBeNull()
    expect(deliverySummaryOf(null)).toBeNull()
    expect(renderToStaticMarkup(createElement(DeliverySummaryLine, { summary: null, running: true, tr: es }))).toBe('')
  })

  it('«running» is judged like the server: the window ends at the start of the day after the end date (UTC)', () => {
    const end = '2026-10-31T00:00:00.000Z'
    expect(campaignIsRunning(end, new Date('2026-10-31T23:59:59.000Z'))).toBe(true)
    expect(campaignIsRunning(end, new Date('2026-11-01T00:00:00.000Z'))).toBe(false)
    expect(campaignIsRunning(null, new Date('2030-01-01T00:00:00.000Z'))).toBe(true)
  })
})

describe('the display mirror keeps step with the rule (src/lib/assignment-rules.ts)', () => {
  it('days late and the end of the window agree on every boundary', () => {
    const ends = ['2026-10-31T00:00:00.000Z', '2026-10-31', new Date('2026-02-28T00:00:00.000Z'), '2026-12-31T00:00:00', null, '', 'not a date']
    const posts = ['2026-10-31T23:59:59.999Z', '2026-11-01T00:00:00.000Z', '2026-11-05T10:00:00.000Z', '2026-11-30T23:59:00.000Z', '2026-12-01T00:00:00.000Z', '2026-09-30T10:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', null, 'x']
    for (const end of ends) {
      for (const posted of posts) {
        expect(lateDaysForDisplay(posted, end), `${posted} / ${String(end)}`).toBe(lateDaysOf(posted, end))
      }
      const at = campaignWindowEndExclusive(end)
      if (at) {
        expect(campaignIsRunning(end, new Date(at.getTime() - 1))).toBe(true)
        expect(campaignIsRunning(end, at)).toBe(false)
      } else {
        expect(campaignIsRunning(end, new Date('2099-01-01T00:00:00.000Z'))).toBe(true)
      }
    }
    expect(lateDaysForDisplay('2026-11-05T10:00:00.000Z', '2026-10-31T00:00:00.000Z')).toBe(5)
  })

  it('no client component loads assignment-rules (it reads a server environment variable when it loads)', () => {
    for (const file of ['src/components/campaign-report.tsx', 'src/app/(dashboard)/campaigns/[id]/page.tsx', 'src/components/person-merge/merge-api.ts', 'src/components/person-merge/merge-views.tsx']) {
      expect(source(file), file).not.toMatch(/from '@\/lib\/assignment-rules'/)
    }
  })
})

describe('«Añadir publicación por URL» says it was added late', () => {
  it('the sentence of the owner, filled as the page fills it', () => {
    const cd = translations.es.campaignDetail
    expect(fill(cd.manualDetailLate, { days: lateDaysText(5, es) })).toBe('Añadida fuera de plazo: 5 días después del fin de la campaña.')
    expect(fill(translations.en.campaignDetail.manualDetailLate, { days: lateDaysText(1, en) })).toBe('Added as late: 1 day after the end of the campaign.')
  })

  it('the page uses the server\'s lateDays on a new piece; refusals keep showing the API text', () => {
    const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
    expect(page).toContain("data.created !== false && typeof data.lateDays === 'number' && data.lateDays >= 1")
    expect(page).toContain('fillManualText(cd.manualDetailLate, { days: lateDaysText(data.lateDays, t.campaignReport) })')
    expect(page).toContain('}, late)')
    expect(page).toContain('const shown = lead ? { ...outcome, message: `${lead} ${outcome.message}` } : outcome')
    expect(page).toContain("notAdded(typeof data.error === 'string' && data.error ? data.error : cd.manualDetailError)")
    // The «¿De quién es esta publicación?» path: the same rule, from the stored date
    expect(page).toContain("const lateDays = saved.created !== false ? lateDaysForDisplay(posted, campaign?.endDate ?? null) : null")
  })
})

describe('team only, everywhere it is drawn', () => {
  it('the campaign page shows the badge and the line to staff only', () => {
    const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
    expect(page).toContain('{canEdit && <LateBadge days={lateDaysById.get(m.id)} tr={t.campaignReport} className="mt-2" />}')
    expect(page).toContain('{canEdit && lateDaysById.has(story.id) && (')
    expect(page).toMatch(/\{canEdit && \(\s*<DeliverySummaryLine summary=\{deliverySummaryOf\(delivery\)\}/)
  })

  it('the report draws them only in the agency view, never printed', () => {
    const report = source('src/components/campaign-report.tsx')
    const uses = report.split('\n').filter(line => /<LateBadge |<DeliverySummaryLine$|<DeliverySummaryLine /.test(line) && !line.includes('export function'))
    expect(uses.length).toBe(3)
    // Highlights: gated by !clientView on the same line
    expect(report).toContain('{!clientView && <LateBadge days={metrics?.lateDays} tr={tr} className="no-print print:hidden" />}')
    // Annex: the days are only read in the agency view
    expect(report).toContain("const lateDays = !clientView && typeof metrics?.lateDays === 'number' && metrics.lateDays >= 1 ? metrics.lateDays : null")
    expect(report).toContain('{lateDays !== null && <LateBadge days={lateDays} tr={tr} className="no-print print:hidden" />}')
    // The line next to «Prometido vs entregado»
    expect(report).toMatch(/\{!clientView && \(\s*<DeliverySummaryLine\s+summary=\{deliverySummaryOf\(overview\?\.delivery\)\}[\s\S]{0,200}className="no-print [^"]*print:hidden/)
    // The client view is the portal and every print (the server PDF prints too)
    expect(report).toContain('const clientView = isPortal || printing')
  })
})
