/**
 * Adversarial review of «Revisión semanal 16 nov 2026», lens 3 (coherence of
 * texts and UI). Read-only checks that FAIL while the two leftovers below are
 * in the tree, and pass once they are fixed:
 *
 *  1. The Stories sub-tab of the campaign page renders TWO story lists: the
 *     StoriesTracker (updated: «Publicada hace N días», never grey) and, right
 *     under it, the grid of discovered stories (page.tsx, the block after
 *     `<TabsContent value="sub-stories">`), which still paints every story
 *     older than 24 h with a grey ring and the badge «Expirado» / «Expired»
 *     (t.campaignDetail.storyExpired). The manual, the knowledge and the
 *     assistant's role now say a story is never "expirada" in the report.
 *  2. Ajustes → Integraciones → «Cuentas de Instagram conectadas» has a
 *     hard-coded subtitle saying the accounts sync «cada 6 horas»; meta-sync
 *     ticks every 2 h (TWO_HOURS_MS in src/instrumentation.ts). The translation
 *     key integrations.connectedAccountsSubtitle was corrected to 2 h but that
 *     page does not use it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translations } from '@/i18n/translations'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('lens 3: a story older than 24 h is never shown as "Expirada" anywhere in the Stories tab', () => {
  const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
  const storiesTab = page.slice(page.indexOf('<TabsContent value="sub-stories">'), page.indexOf('<TabsContent value="sub-pipeline">'))

  it('the Stories sub-tab exists and holds the discovered-stories grid', () => {
    expect(storiesTab.length).toBeGreaterThan(0)
    expect(storiesTab).toContain('stories.map((story)')
  })

  it('no "Expirado" badge nor grey ring on stories older than 24 h in the discovered-stories grid', () => {
    expect(storiesTab).not.toContain('storyExpired')
    expect(storiesTab).not.toMatch(/isExpired \? 'bg-gray-100'/)
    expect(storiesTab).not.toContain('Expired badge')
  })

  it('the translation key of the old badge is gone in both languages', () => {
    expect(translations.es.campaignDetail).not.toHaveProperty('storyExpired')
    expect(translations.en.campaignDetail).not.toHaveProperty('storyExpired')
  })
})

describe('lens 3: the Meta sync cadence shown in Ajustes is the one the scheduler runs', () => {
  const settings = source('src/app/(dashboard)/settings/page.tsx')
  const instrumentation = source('src/instrumentation.ts')

  it('meta-sync ticks every 2 h', () => {
    expect(instrumentation).toMatch(/name: 'meta-sync',\s+path: '\/api\/cron\/meta-sync',\s+intervalMs: TWO_HOURS_MS/)
  })

  it('the connected-accounts subtitle does not say 6 hours (hard-coded text or translation)', () => {
    expect(settings).not.toContain('cada 6 horas')
    expect(settings).not.toContain('every 6 hours')
    expect(translations.es.integrations.meta.connectedAccountsSubtitle).toContain('2 horas')
    expect(translations.en.integrations.meta.connectedAccountsSubtitle).toContain('2 hours')
  })
})
