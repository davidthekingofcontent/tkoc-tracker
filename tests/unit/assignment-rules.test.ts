/**
 * src/lib/assignment-rules.ts — the late rule («fuera de plazo») of the manual
 * paths, pure: days late, what a creator still owes, the decision of
 * «Añadir publicación por URL» / «Registrar Story», the exclusivity predicate
 * of the automatic capture and what revalidation keeps. Invented handles only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LATE_ACCEPT_MAX_DAYS,
  OWING_STATUSES,
  campaignWindowEndExclusive,
  countedElsewhereMessage,
  decideLateWindow,
  decideManualLate,
  isHandAddedRow,
  keepsLateHandAddedRow,
  lateCopyElsewhere,
  lateDaysOf,
  pendingOf,
} from '@/lib/assignment-rules'
import { campaignWindowEndExclusive as reExported } from '@/lib/campaign-capture'

/** October as it is stored: date-only values at midnight UTC */
const END = new Date('2026-10-31T00:00:00Z')
const OCTOBER = { type: 'INFLUENCER_TRACKING', status: 'ACTIVE', startDate: new Date('2026-10-01T00:00:00Z'), endDate: END, name: '10.- Marca Demo - Micros Octubre' }
const owes = { status: 'CONTRACTED', deliverablesPlanned: null, delivered: 0, handle: 'creadora_demo_25' }

describe('LATE_ACCEPT_MAX_DAYS', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('is 30 by default', () => {
    expect(LATE_ACCEPT_MAX_DAYS).toBe(30)
  })

  it('can be overridden by the environment, and a value that is not a positive whole number is ignored', async () => {
    vi.stubEnv('LATE_ACCEPT_MAX_DAYS', '45')
    vi.resetModules()
    expect((await import('@/lib/assignment-rules')).LATE_ACCEPT_MAX_DAYS).toBe(45)
    for (const bad of ['0', '-3', 'treinta', '2.5', '']) {
      vi.stubEnv('LATE_ACCEPT_MAX_DAYS', bad)
      vi.resetModules()
      expect((await import('@/lib/assignment-rules')).LATE_ACCEPT_MAX_DAYS, bad).toBe(30)
    }
  })
})

describe('the window and the days late', () => {
  it('there is one window end: the capture re-exports the one of the rules', () => {
    expect(reExported).toBe(campaignWindowEndExclusive)
    expect(campaignWindowEndExclusive(END)?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(campaignWindowEndExclusive('2026-10-31')?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(campaignWindowEndExclusive(null)).toBeNull()
    expect(campaignWindowEndExclusive('no es una fecha')).toBeNull()
  })

  it('lateDaysOf: whole days since the end, counted from 1, in UTC', () => {
    expect(lateDaysOf(new Date('2026-10-31T23:59:59Z'), END)).toBeNull()
    expect(lateDaysOf(new Date('2026-11-01T00:00:00Z'), END)).toBe(1)
    expect(lateDaysOf(new Date('2026-11-01T23:59:59Z'), END)).toBe(1)
    expect(lateDaysOf(new Date('2026-11-05T10:00:00Z'), END)).toBe(5)
    expect(lateDaysOf(new Date('2026-11-30T23:59:00Z'), END)).toBe(30)
    expect(lateDaysOf(new Date('2026-12-01T00:00:00Z'), END)).toBe(31)
    expect(lateDaysOf('2026-11-05T10:00:00.000Z', '2026-10-31T00:00:00.000Z')).toBe(5)
  })

  it('lateDaysOf: null without an end date, before the start, inside the window, or undated', () => {
    expect(lateDaysOf(new Date('2027-03-01T00:00:00Z'), null)).toBeNull()
    expect(lateDaysOf(new Date('2026-09-28T10:00:00Z'), END)).toBeNull()
    expect(lateDaysOf(new Date('2026-10-15T10:00:00Z'), END)).toBeNull()
    expect(lateDaysOf(null, END)).toBeNull()
    expect(lateDaysOf('ayer', END)).toBeNull()
  })
})

describe('pendingOf: what a creator still owes', () => {
  const STATUSES = ['PROSPECT', 'OUTREACH', 'NEGOTIATING', 'AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED']

  it('only Agreed, Contracted, Shipping and Posted can owe', () => {
    expect([...OWING_STATUSES]).toEqual(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED'])
  })

  it('every status × planned null / 0 / 2 × delivered 0 / 1 / 2', () => {
    for (const status of STATUSES) {
      for (const planned of [null, 0, 2]) {
        for (const delivered of [0, 1, 2]) {
          const got = pendingOf({ status, deliverablesPlanned: planned, delivered })
          const label = `${status} planned=${planned} delivered=${delivered}`
          if (!(OWING_STATUSES as readonly string[]).includes(status)) {
            expect(got, label).toEqual({ owes: false, kind: 'none', remaining: 0 })
          } else if (planned === 2) {
            expect(got, label).toEqual({ owes: delivered < 2, kind: 'defined', remaining: 2 - delivered })
          } else {
            // No number (null, or 0 like the overview reads it): one piece
            expect(got, label).toEqual({ owes: delivered === 0, kind: 'implicit', remaining: delivered === 0 ? 1 : 0 })
          }
        }
      }
    }
  })

  it('delivering more than planned owes nothing and never a negative remainder', () => {
    expect(pendingOf({ status: 'POSTED', deliverablesPlanned: 2, delivered: 5 })).toEqual({ owes: false, kind: 'defined', remaining: 0 })
  })
})

describe('decideManualLate: «Añadir publicación por URL» and «Registrar Story»', () => {
  it('inside the window: ok, not late, whoever she is', () => {
    expect(decideManualLate({ campaign: OCTOBER, member: { ...owes, status: 'COMPLETED' }, postedAt: new Date('2026-10-31T23:59:59Z') })).toEqual({ ok: true, lateDays: null })
  })

  it('a member who owes one piece, 5 Nov: accepted, 5 days late', () => {
    expect(decideManualLate({ campaign: OCTOBER, member: owes, postedAt: new Date('2026-11-05T10:00:00Z') })).toEqual({ ok: true, lateDays: 5 })
    expect(decideManualLate({ campaign: OCTOBER, member: { ...owes, status: 'POSTED', deliverablesPlanned: 3, delivered: 2 }, postedAt: '2026-11-30T23:59:00Z' })).toEqual({ ok: true, lateDays: 30 })
  })

  it('Completed: nothing pending, and the answer says how to fix it', () => {
    const d = decideManualLate({ campaign: OCTOBER, member: { status: 'COMPLETED', deliverablesPlanned: null, delivered: 0, handle: 'masqueropa_demo' }, postedAt: new Date('2026-11-05T10:00:00Z') })
    expect(d).toEqual({
      ok: false,
      code: 'nothing_pending',
      lateDays: 5,
      message: '@masqueropa_demo está en Completado: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.',
    })
  })

  it('nothing pending: her number reached, or her one piece already in', () => {
    const defined = decideManualLate({ campaign: OCTOBER, member: { ...owes, deliverablesPlanned: 2, delivered: 2 }, postedAt: new Date('2026-11-02T10:00:00Z') })
    expect(defined).toMatchObject({ ok: false, code: 'nothing_pending' })
    expect(!defined.ok && defined.message).toBe('@creadora_demo_25 ya ha entregado 2 de 2: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
    const implicit = decideManualLate({ campaign: OCTOBER, member: { ...owes, delivered: 1 }, postedAt: new Date('2026-11-02T10:00:00Z') })
    expect(!implicit.ok && implicit.message).toBe('@creadora_demo_25 ya tiene una publicación en esta campaña y no tiene un número de entregables: no le queda nada por entregar. Si le falta otra, pon sus entregables.')
    const before = decideManualLate({ campaign: OCTOBER, member: { ...owes, status: 'NEGOTIATING' }, postedAt: new Date('2026-11-02T10:00:00Z') })
    expect(!before.ok && before.message).toBe('@creadora_demo_25 está en Negociando: no le queda nada por entregar en esta campaña. Si aún le falta, cambia su estado o pon sus entregables.')
  })

  it('more than 30 days late: too late, with the days', () => {
    expect(decideManualLate({ campaign: OCTOBER, member: owes, postedAt: new Date('2026-12-11T10:00:00Z') })).toEqual({
      ok: false,
      code: 'too_late',
      lateDays: 41,
      message: 'Se publicó 41 días después del fin de la campaña; el máximo para contarla fuera de plazo son 30.',
    })
    expect(decideManualLate({ campaign: OCTOBER, member: owes, postedAt: new Date('2026-12-01T00:00:00Z') })).toMatchObject({ ok: false, code: 'too_late', lateDays: 31 })
  })

  it('before the start: the answer of always, and never late', () => {
    expect(decideManualLate({ campaign: OCTOBER, member: owes, postedAt: new Date('2026-09-28T10:00:00Z') })).toEqual({
      ok: false,
      code: 'before_start',
      message: 'El contenido se publicó el 2026-09-28, fuera del periodo de la campaña (2026-10-01 – 2026-10-31).',
    })
  })

  it('undated: refused', () => {
    expect(decideManualLate({ campaign: OCTOBER, member: owes, postedAt: null })).toMatchObject({ ok: false, code: 'undated' })
  })

  it('Social Listening keeps the strict window', () => {
    const d = decideManualLate({ campaign: { ...OCTOBER, type: 'SOCIAL_LISTENING' }, member: owes, postedAt: new Date('2026-11-05T10:00:00Z') })
    expect(d).toMatchObject({ ok: false, code: 'not_collaboration', lateDays: 5 })
    expect(!d.ok && d.message).toBe(
      'El contenido se publicó el 2026-11-05, fuera del periodo de la campaña (2026-10-01 – 2026-10-31). En una campaña de escucha social solo cuenta lo publicado dentro de sus fechas.'
    )
    // A UGC campaign is a collaboration
    expect(decideManualLate({ campaign: { ...OCTOBER, type: 'UGC' }, member: owes, postedAt: new Date('2026-11-05T10:00:00Z') })).toEqual({ ok: true, lateDays: 5 })
  })

  it('a paused or archived campaign takes no late piece', () => {
    const paused = decideManualLate({ campaign: { ...OCTOBER, status: 'PAUSED' }, member: owes, postedAt: new Date('2026-11-05T10:00:00Z') })
    expect(paused).toMatchObject({ ok: false, code: 'campaign_not_active' })
    expect(!paused.ok && paused.message).toBe('«10.- Marca Demo - Micros Octubre» está en pausa: una publicación de después del fin solo cuenta fuera de plazo en una campaña activa. Si aún debe contar, actívala y vuelve a añadirla.')
    expect(decideManualLate({ campaign: { ...OCTOBER, status: 'ARCHIVED' }, member: owes, postedAt: new Date('2026-11-05T10:00:00Z') })).toMatchObject({ ok: false, code: 'campaign_not_active' })
  })

  it('the campaign is judged before the creator: a paused campaign says so even for a creator who owes nothing', () => {
    expect(decideManualLate({ campaign: { ...OCTOBER, status: 'PAUSED' }, member: { ...owes, status: 'COMPLETED' }, postedAt: new Date('2026-11-05T10:00:00Z') })).toMatchObject({ code: 'campaign_not_active' })
    expect(decideManualLate({ campaign: OCTOBER, member: { ...owes, status: 'COMPLETED' }, postedAt: new Date('2026-12-20T10:00:00Z') })).toMatchObject({ code: 'too_late' })
  })

  it('without an end date nothing is ever late; an end date that cannot be read is refused', () => {
    expect(decideManualLate({ campaign: { ...OCTOBER, endDate: null }, member: { ...owes, status: 'COMPLETED' }, postedAt: new Date('2027-05-05T10:00:00Z') })).toEqual({ ok: true, lateDays: null })
    expect(decideLateWindow({ campaign: { ...OCTOBER, endDate: 'nunca' }, postedAt: new Date('2027-05-05T10:00:00Z') })).toMatchObject({ ok: false, code: 'no_end_date' })
  })

  it('a story speaks of a story', () => {
    const early = decideLateWindow({ campaign: OCTOBER, postedAt: new Date('2026-09-28T10:00:00Z') }, { subject: 'story', dateNote: ' (según el enlace)' })
    expect(!early.ok && early.message).toBe('La story se publicó el 2026-09-28 (según el enlace), fuera del periodo de la campaña (2026-10-01 – 2026-10-31).')
    const tooLate = decideLateWindow({ campaign: OCTOBER, postedAt: new Date('2026-12-11T10:00:00Z') }, { subject: 'story' })
    expect(!tooLate.ok && tooLate.message).toBe('La story se publicó 41 días después del fin de la campaña; el máximo para contarla fuera de plazo son 30.')
    expect(countedElsewhereMessage('11.- Noviembre', { subject: 'story' })).toBe('Esta story ya cuenta en «11.- Noviembre». Una story fuera de plazo solo cuenta en una campaña.')
    expect(countedElsewhereMessage('11.- Noviembre')).toBe('Esta publicación ya cuenta en «11.- Noviembre». Una publicación fuera de plazo solo cuenta en una campaña.')
  })
})

describe('lateCopyElsewhere: the guard of the automatic capture', () => {
  const NOV_END = new Date('2026-11-30T00:00:00Z')
  /** A copy as a PM added it «fuera de plazo» (hand-added), unless told otherwise */
  const copy = (c: { campaignId: string | null; postedAt: Date | null; campaignEndDate: Date | null } & Partial<{ source: string; mediaType: string; externalId: string | null; campaignType: string }>) => ({
    source: 'manual', mediaType: 'REEL', externalId: 'DfDemoLate01', ...c,
  })

  it('finds the copy that counts late in ANOTHER campaign (added by hand after its end)', () => {
    const late = copy({ campaignId: 'oct', postedAt: new Date('2026-11-05T10:00:00Z'), campaignEndDate: END })
    expect(lateCopyElsewhere([late], 'nov')).toBe(late)
  })

  it('a copy inside its own window is not late: the post counts in every campaign whose rules it satisfies', () => {
    expect(lateCopyElsewhere([copy({ campaignId: 'oct', postedAt: new Date('2026-10-28T10:00:00Z'), campaignEndDate: END })], 'nov')).toBeNull()
  })

  it('the campaign being written, unattached copies, campaigns without an end and undated copies never block', () => {
    expect(lateCopyElsewhere([
      copy({ campaignId: 'nov', postedAt: new Date('2026-12-02T10:00:00Z'), campaignEndDate: NOV_END }),
      copy({ campaignId: null, postedAt: new Date('2026-11-05T10:00:00Z'), campaignEndDate: END }),
      copy({ campaignId: 'always', postedAt: new Date('2026-11-05T10:00:00Z'), campaignEndDate: null }),
      copy({ campaignId: 'oct', postedAt: null, campaignEndDate: END }),
      copy({ campaignId: 'sep', postedAt: new Date('2026-08-01T10:00:00Z'), campaignEndDate: new Date('2026-09-30T00:00:00Z') }),
    ], 'nov')).toBeNull()
  })

  it('only a piece the late rule keeps blocks: a scraped or Meta row left after its window, one 31+ days late or a Social Listening copy do not', () => {
    const at = { campaignId: 'oct', postedAt: new Date('2026-11-05T10:00:00Z'), campaignEndDate: END }
    // A row scraped while October still ran to 15 Nov, then its end moved to 31 Oct: revalidation would detach it
    expect(lateCopyElsewhere([copy({ ...at, source: 'apify' })], 'nov')).toBeNull()
    expect(lateCopyElsewhere([copy({ ...at, source: 'meta_api' })], 'nov')).toBeNull()
    expect(lateCopyElsewhere([copy({ ...at, postedAt: new Date('2026-12-01T00:00:00Z') })], 'dec')).toBeNull()
    expect(lateCopyElsewhere([copy({ ...at, campaignType: 'SOCIAL_LISTENING' })], 'nov')).toBeNull()
    // A story registered by hand before `source` existed is hand-added
    const legacyStory = copy({ ...at, source: 'apify', mediaType: 'STORY', externalId: null })
    expect(lateCopyElsewhere([legacyStory], 'nov')).toBe(legacyStory)
  })

  it('a late copy blocks however many other copies there are', () => {
    const late = copy({ campaignId: 'oct', postedAt: new Date('2026-11-20T10:00:00Z'), campaignEndDate: END })
    expect(lateCopyElsewhere([copy({ campaignId: 'other', postedAt: new Date('2026-11-03T10:00:00Z'), campaignEndDate: NOV_END }), late], 'dec')).toBe(late)
  })
})

describe('revalidation keeps a hand-added late piece', () => {
  const row = (r: Partial<{ source: string; mediaType: string; externalId: string | null; postedAt: Date | null }>) => ({
    source: 'manual', mediaType: 'REEL', externalId: 'DfDemoLate01', postedAt: new Date('2026-11-05T10:00:00Z'), ...r,
  })

  it('a manual row up to 30 days late stays; 31 days does not', () => {
    expect(keepsLateHandAddedRow({ endDate: END }, row({}))).toBe(true)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ postedAt: new Date('2026-11-30T23:59:00Z') }))).toBe(true)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ postedAt: new Date('2026-12-01T00:00:00Z') }))).toBe(false)
  })

  it('a story added by hand before `source` existed counts as hand-added', () => {
    expect(isHandAddedRow({ source: 'apify', mediaType: 'STORY', externalId: null })).toBe(true)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ source: 'apify', mediaType: 'STORY', externalId: null }))).toBe(true)
  })

  it('scraped and Meta rows, rows before the start, undated rows and Social Listening are not kept by this rule', () => {
    expect(keepsLateHandAddedRow({ endDate: END }, row({ source: 'apify' }))).toBe(false)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ source: 'meta_api' }))).toBe(false)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ postedAt: new Date('2026-09-28T10:00:00Z') }))).toBe(false)
    expect(keepsLateHandAddedRow({ endDate: END }, row({ postedAt: null }))).toBe(false)
    expect(keepsLateHandAddedRow({ endDate: END, type: 'SOCIAL_LISTENING' }, row({}))).toBe(false)
    expect(keepsLateHandAddedRow({ endDate: null }, row({}))).toBe(false)
  })
})
