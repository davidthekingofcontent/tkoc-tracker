/**
 * «Stories sin rastrear» and the Stories tab (revisión semanal 16 nov 2026,
 * points 1 and 2): the pure rules of src/lib/stories-notices.ts, the texts
 * of the tab in both languages, and the invariants of the components that a
 * browser would be needed to click.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STORIES_NOTICE_REPEAT_MS,
  STORIES_NO_CONFIRMED_AFTER_MS,
  daysSincePosted,
  noConfirmedNoticeDue,
  parseStoriesNotice,
  serializeStoriesNotice,
  storiesLastResultFor,
  storiesNoticeDetail,
  storiesNoticeDue,
  storiesNoticeKey,
} from '@/lib/stories-notices'
import { translations } from '@/i18n/translations'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const NOW = new Date('2026-11-16T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe('the notice setting (stories_skip_notice_<campaignId>)', () => {
  it('reads the JSON of today and the bare reason of the old format', () => {
    expect(storiesNoticeKey('abc')).toBe('stories_skip_notice_abc')
    expect(parseStoriesNotice(serializeStoriesNotice('no_targets', NOW))).toEqual({ reason: 'no_targets', at: NOW.toISOString() })
    expect(parseStoriesNotice('no_targets')).toEqual({ reason: 'no_targets', at: null })
    expect(parseStoriesNotice('  too_long ')).toEqual({ reason: 'too_long', at: null })
  })

  it('treats garbage as nothing stored', () => {
    for (const v of [null, undefined, '', '   ', '{', '{"at":"2026-11-01T00:00:00Z"}', '{"reason":""}']) {
      expect(parseStoriesNotice(v), String(v)).toBeNull()
    }
    expect(parseStoriesNotice('{"reason":"no_targets","at":"not a date"}')).toEqual({ reason: 'no_targets', at: null })
  })

  it('is due when nothing is stored, when the reason changed, and when the last notice has no date', () => {
    expect(storiesNoticeDue(null, 'no_targets', NOW)).toBe(true)
    expect(storiesNoticeDue({ reason: 'too_long', at: ago(DAY) }, 'no_targets', NOW)).toBe(true)
    expect(storiesNoticeDue({ reason: 'no_targets', at: null }, 'no_targets', NOW)).toBe(true)
  })

  it('repeats every 7 days while the reason persists, not before', () => {
    expect(STORIES_NOTICE_REPEAT_MS).toBe(7 * DAY)
    expect(storiesNoticeDue({ reason: 'no_targets', at: ago(0) }, 'no_targets', NOW)).toBe(false)
    expect(storiesNoticeDue({ reason: 'no_targets', at: ago(6 * DAY + 23 * 60 * 60 * 1000) }, 'no_targets', NOW)).toBe(false)
    expect(storiesNoticeDue({ reason: 'no_targets', at: ago(7 * DAY) }, 'no_targets', NOW)).toBe(true)
    expect(storiesNoticeDue({ reason: 'no_confirmed', at: ago(20 * DAY) }, 'no_confirmed', NOW)).toBe(true)
  })
})

describe('the second reason: nobody in Acordado or later', () => {
  const started = (daysAgo: number) => ({ startDate: new Date(NOW.getTime() - daysAgo * DAY) })

  it('is owed three days after the start of a campaign with Instagram creators and none confirmed', () => {
    expect(STORIES_NO_CONFIRMED_AFTER_MS).toBe(3 * DAY)
    expect(noConfirmedNoticeDue(started(3), { confirmedCreators: 0, instagramCreators: 33 }, NOW)).toBe(true)
    expect(noConfirmedNoticeDue(started(10), { confirmedCreators: 0, instagramCreators: 1 }, NOW)).toBe(true)
  })

  it('is not owed before three days, with a confirmed creator, or with nobody to confirm', () => {
    expect(noConfirmedNoticeDue(started(2.9), { confirmedCreators: 0, instagramCreators: 33 }, NOW)).toBe(false)
    expect(noConfirmedNoticeDue(started(10), { confirmedCreators: 1, instagramCreators: 33 }, NOW)).toBe(false)
    expect(noConfirmedNoticeDue(started(10), { confirmedCreators: 0, instagramCreators: 0 }, NOW)).toBe(false)
    expect(noConfirmedNoticeDue({ startDate: 'no date' }, { confirmedCreators: 0, instagramCreators: 3 }, NOW)).toBe(false)
  })

  it('tells the team «0 de N» and where to fix it', () => {
    const detail = storiesNoticeDetail('no_confirmed', { ...started(5), endDate: null }, { instagramCreators: 33 })
    expect(detail).toContain('0 de 33')
    expect(detail).toContain('Acordado o posterior')
    expect(detail).toContain('Elegir')
  })
})

describe('what the team is told for each reason', () => {
  const campaign = { startDate: new Date('2026-10-06T00:00:00Z'), endDate: null }

  it('names the action in the words of the screen, in Spanish, without long dashes or arrows', () => {
    const texts = {
      listening: storiesNoticeDetail('listening', campaign),
      no_targets: storiesNoticeDetail('no_targets', campaign),
      too_long: storiesNoticeDetail('too_long', campaign),
      no_confirmed: storiesNoticeDetail('no_confirmed', campaign, { instagramCreators: 4 }),
    }
    expect(texts.listening).toContain('Social Listening')
    expect(texts.no_targets).toContain('Cuentas de Marca Objetivo')
    expect(texts.no_targets).toContain('Editar campaña')
    expect(texts.too_long).toContain('fecha de fin')
    expect(texts.too_long).toContain('máximo 100')
    for (const text of Object.values(texts)) {
      expect(text).not.toMatch(/[—→]/)
    }
  })

  it('says how long a dated campaign lasts', () => {
    const dated = storiesNoticeDetail('too_long', { startDate: '2026-01-01T00:00:00Z', endDate: '2026-06-30T00:00:00Z' })
    expect(dated).toContain('dura 180 días')
  })
})

describe('the last run, for one campaign', () => {
  const result = JSON.stringify({
    at: '2026-11-16T11:04:23.000Z',
    usernamesChecked: 36,
    totalStories: 62,
    newStories: 0,
    campaigns: [
      { id: 'macros', name: '11.-Vileda - Macros Noviembre', creators: 8, newStories: 2 },
      { id: 'micros', name: '11.- Vileda - Micros Noviembre', creators: 0, newStories: 0 },
    ],
    skipped: [{ id: 'ugc', name: '11. VILEDA - UGC NOVIEMBRE', reason: 'no_targets', detail: 'no tiene …' }],
  })

  it('finds a scanned campaign, a skipped one, and nothing for the rest', () => {
    expect(storiesLastResultFor(result, 'macros')).toEqual({ at: '2026-11-16T11:04:23.000Z', failed: false, scanned: true, creators: 8, newStories: 2, reason: null })
    expect(storiesLastResultFor(result, 'micros')).toMatchObject({ scanned: true, creators: 0, newStories: 0 })
    expect(storiesLastResultFor(result, 'ugc')).toEqual({ at: '2026-11-16T11:04:23.000Z', failed: false, scanned: false, creators: null, newStories: null, reason: 'no_targets' })
    expect(storiesLastResultFor(result, 'other')).toBeNull()
  })

  it('reads a failed run and survives a missing or broken setting', () => {
    const failed = JSON.stringify({ at: '2026-11-15T23:04:00.000Z', failed: true, reason: 'apify_token', skipped: [{ id: 'ugc', reason: 'no_targets' }] })
    expect(storiesLastResultFor(failed, 'ugc')).toMatchObject({ failed: true, scanned: false, reason: 'no_targets' })
    for (const raw of [null, undefined, '', 'not json', '[]', '42']) {
      expect(storiesLastResultFor(raw, 'macros'), String(raw)).toBeNull()
    }
  })
})

describe('«Publicada hace N días»', () => {
  it('counts whole days since the publication, 0 on its day, null without a date', () => {
    expect(daysSincePosted(ago(2 * 60 * 60 * 1000), NOW)).toBe(0)
    expect(daysSincePosted(ago(DAY), NOW)).toBe(1)
    expect(daysSincePosted(ago(3 * DAY + 60_000), NOW)).toBe(3)
    expect(daysSincePosted(new Date(NOW.getTime() - 10 * DAY), NOW)).toBe(10)
    expect(daysSincePosted(null, NOW)).toBeNull()
    expect(daysSincePosted('garbage', NOW)).toBeNull()
    // A date in the future (clock drift) is "today", never negative
    expect(daysSincePosted(new Date(NOW.getTime() + DAY), NOW)).toBe(0)
  })
})

describe('the texts of the Stories tab', () => {
  const es = translations.es.campaignDetail
  const en = translations.en.campaignDetail
  const NEW_KEYS = [
    'storiesScanNoTargets', 'storiesScanNoEndDate', 'storiesScanTooLong', 'storiesScanInactive', 'storiesScanListening', 'storiesScanWindow', 'storiesScanNoConfirmed',
    'storiesScanOk', 'storiesScanLastRun', 'storiesScanLastResult', 'storiesScanNever',
    'storiesActive', 'storiesPostedToday', 'storiesPostedOneDayAgo', 'storiesPostedDaysAgo', 'storiesNoDate',
  ] as const
  const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()

  it('exist in Spanish and English with the same placeholders', () => {
    for (const key of NEW_KEYS) {
      expect(typeof es[key], key).toBe('string')
      expect(typeof en[key], key).toBe('string')
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]))
    }
    expect(es.storiesScanNoEndDate).toContain('{max}')
    expect(es.storiesScanNoConfirmed).toContain('0 de {n}')
    expect(es.storiesPostedDaysAgo).toBe('Publicada hace {n} días')
    expect(en.storiesPostedDaysAgo).toBe('Published {n} days ago')
  })

  it('give the one action that fixes each reason, in the words of the screen', () => {
    expect(es.storiesScanNoTargets).toContain('Editar campaña')
    // Product keywords count as a target (campaignHasTargets): the action names the three kinds
    expect(es.storiesScanNoTargets).toContain('palabra clave del producto')
    expect(en.storiesScanNoTargets).toContain('product keyword')
    expect(es.storiesScanNoEndDate).toContain('fecha de fin')
    // With an end date, the campaign is too long: the action is to shorten it, not to "set an end date"
    expect(es.storiesScanTooLong).toContain('Acórtala')
    expect(es.storiesScanTooLong).not.toContain('fecha de fin')
    expect(es.storiesScanInactive).toContain('pausada o cerrada')
    expect(es.storiesScanListening).toContain('escucha')
    expect(es.storiesScanNoConfirmed).toContain('Acordado o posterior')
    expect(es.storiesScanNoConfirmed).toContain('Elegir')
    // Stories are scanned every 12 h (STORIES_DEFAULT_MIN_HOURS): the text says so, and only that
    expect(es.storiesScanOk).toContain('12 h')
    expect(en.storiesScanOk).toContain('12 h')
  })

  it('a story saved through «Añadir publicación por URL» says where it is', () => {
    expect(es.manualStoryAdded.startsWith('Story guardada: la verás en la pestaña Stories')).toBe(true)
    expect(en.manualStoryAdded.startsWith('Story saved: you will see it in the Stories tab')).toBe(true)
  })

  it('no text says «Expirada»: what expires is the story on Instagram, not in the report', () => {
    const tracker = source('src/components/stories-tracker.tsx')
    expect(tracker).not.toMatch(/'Expirada'|'Expired'/)
    expect(tracker).toContain('storiesPostedDaysAgo')
    expect(tracker).toContain('data-testid="stories-scan-notice"')
    for (const key of NEW_KEYS) {
      if (key === 'storiesScanLastResult' || key === 'storiesScanNever' || key === 'storiesScanLastRun') continue
      expect(tracker, key).toContain(key)
    }
  })
})

describe('«Añadir publicación por URL» opens the Stories sub-tab after saving a story', () => {
  const page = source('src/app/(dashboard)/campaigns/[id]/page.tsx')

  it('the sub-tabs of Ejecutar are controlled and the handler switches to Stories only for a new story', () => {
    expect(page).toContain('<Tabs defaultValue="sub-media" value={execSubTab} onValueChange={setExecSubTab}>')
    expect(page).toMatch(/if \(data\.isStory === true && data\.created !== false && manualMediaOpenFor\.current === campaignId\) setExecSubTab\('sub-stories'\)/)
  })
})

describe('every refusal of the two manual paths leaves a trace in the log', () => {
  it('both routes write [manual-refusal] with the campaign, the creator, the code, the reason and the link, never the figures', () => {
    const stories = source('src/app/api/campaigns/[id]/stories/route.ts')
    const manual = source('src/app/api/campaigns/[id]/media/manual/route.ts')
    for (const route of [stories, manual]) {
      expect(route).toContain("console.warn('[manual-refusal]'")
      for (const field of ['campaignId', 'influencerId', 'code', 'reason', 'url']) expect(route).toContain(field)
      expect(route).not.toMatch(/\[manual-refusal\][^\n]*views/)
    }
    // In «Registrar Story» every 400/409 goes through the logging helper: no bare refusal is left
    const post = stories.slice(stories.indexOf('export async function POST'))
    expect(post).not.toMatch(/NextResponse\.json\([^)]*\{ status: 4(00|09) \}/)
  })
})
