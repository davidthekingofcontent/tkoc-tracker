/**
 * «Fichas duplicadas» (/creators/duplicadas, ADMIN only), the screen of the
 * merge tool: the contract with /api/admin/person-merge (merge-api.ts, with a
 * scripted fetch) and the server-rendered markup of its pieces (cards, review,
 * history, the notice of the campaign page). No browser, no database: the
 * route itself is tested in tests/db/person-merge-route.test.ts.
 *
 * What matters most here (owner's rules):
 *  - a merge cannot be applied by accident: «Fusionar» only on a fresh preview
 *    of exactly what is selected with nothing missing, then an in-page
 *    confirmation (never window.confirm);
 *  - nothing is preselected where the API has no default;
 *  - ADMIN only: server-side check on the page, the entry in the sidebar from
 *    the session.
 * Every handle and figure is invented.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { translations } from '@/i18n/translations'
import type {
  MergeCampaignEffect,
  MergeCandidate,
  MergeFieldOutcome,
  MergeHistoryEntry,
  MergePreview,
  MergeProfileSummary,
} from '@/lib/person-merge'
import {
  MERGE_ENDPOINT,
  addedValue,
  canMerge,
  chosenFor,
  fieldValueText,
  initialSelection,
  keepUnchangedChoices,
  loadDuplicateCount,
  loadMergeScreen,
  mergeScreenHref,
  modeFor,
  otherOf,
  profileHref,
  requestApply,
  requestDismiss,
  requestPreview,
  requestUndo,
  withChoice,
} from '@/components/person-merge/merge-api'
import {
  CandidateCard,
  DuplicatesNoticeView,
  HistoryList,
  MergeResultPanel,
  ReviewPanel,
  type ReviewPanelProps,
} from '@/components/person-merge/merge-views'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const es = translations.es.personMerge
const en = translations.en.personMerge
const noop = () => {}

// ---------------------------------------------------------------- fixtures

function profile(over: Partial<MergeProfileSummary> & { id: string; username: string }): MergeProfileSummary {
  return {
    platform: 'INSTAGRAM',
    followers: 0,
    displayName: null,
    personId: null,
    otherProfiles: [],
    campaigns: [],
    pieces: 0,
    ownPieces: 0,
    ...over,
  }
}

const OCT = { id: 'coct0000000001', name: 'Micros Octubre (prueba)' }
const JUN = { id: 'cjun0000000001', name: 'Micros Junio (prueba)' }

function candidate(over: Partial<MergeCandidate> = {}): MergeCandidate {
  const keep = profile({
    id: 'ikeep000000001', username: 'vane_inventada', followers: 2300, pieces: 1, ownPieces: 1,
    campaigns: [{ id: OCT.id, name: OCT.name, campaignStatus: 'ACTIVE', startDate: '2026-10-01T00:00:00.000Z', membershipStatus: 'COMPLETED', pieces: 1, hasFee: true }],
  })
  const other = profile({
    id: 'iother00000001', username: 'vane_mal', followers: 0,
    campaigns: [
      { id: OCT.id, name: OCT.name, campaignStatus: 'ACTIVE', startDate: '2026-10-01T00:00:00.000Z', membershipStatus: 'COMPLETED', pieces: 0, hasFee: true },
      { id: JUN.id, name: JUN.name, campaignStatus: 'ACTIVE', startDate: '2026-06-01T00:00:00.000Z', membershipStatus: 'CONTRACTED', pieces: 0, hasFee: false },
    ],
  })
  return {
    key: 'ikeep000000001|iother00000001',
    kind: 'same_campaign',
    strength: 'double_count',
    profiles: [keep, other],
    evidence: [
      { code: 'same_campaign', text: '@vane_inventada y @vane_mal son miembros de «Micros Octubre (prueba)».' },
      { code: 'links_to_other', text: 'La web de @vane_inventada enlaza a tiktok.com/@vane_mal.' },
    ],
    sharedCampaigns: [{ id: OCT.id, name: OCT.name, membersBefore: 36, membersAfter: 35 }],
    suggestion: { keepId: keep.id, otherId: other.id, mode: 'absorb', reason: '@vane_mal no tiene seguidores ni publicaciones propias.' },
    latestCampaignAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

function field(over: Partial<MergeFieldOutcome> & { group: string }): MergeFieldOutcome {
  return {
    label: over.group,
    kind: 'survivor',
    survivorValue: null,
    otherValue: null,
    resolution: 'conflict',
    conflict: true,
    options: ['keep', 'other'],
    default: 'keep',
    chosen: 'keep',
    needsChoice: false,
    result: null,
    ...over,
  }
}

const FEE_CONFLICT = field({ group: 'agreedFee', label: 'Honorario acordado', kind: 'money', survivorValue: 100, otherValue: 150, options: ['keep', 'other', 'add'], default: null, chosen: null, needsChoice: true })
const STATUS_CONFLICT = field({ group: 'status', label: 'Estado', kind: 'status', survivorValue: 'COMPLETED', otherValue: 'POSTED', default: 'keep', chosen: 'keep', result: 'COMPLETED' })
const NOTES_JOINED = field({ group: 'notes', label: 'Notas', kind: 'notes', resolution: 'joined', conflict: false, options: [], default: null, chosen: null })

function effect(over: Partial<MergeCampaignEffect> = {}): MergeCampaignEffect {
  return {
    campaignId: OCT.id,
    campaignName: OCT.name,
    campaignStatus: 'ACTIVE',
    action: 'fold',
    otherMembershipId: 'mother0000001',
    survivor: { membershipId: 'mkeep00000001', influencerId: 'ikeep000000001', username: 'vane_inventada', platform: 'INSTAGRAM' },
    target: { influencerId: 'ikeep000000001', username: 'vane_inventada', platform: 'INSTAGRAM' },
    membersBefore: 36,
    membersAfter: 35,
    piecesBefore: 38,
    piecesAfter: 38,
    movedPieces: 0,
    movedNotes: 0,
    viewsAndEngagements: 'unchanged',
    costBefore: 3600,
    costAfter: null,
    fields: [FEE_CONFLICT, STATUS_CONFLICT, NOTES_JOINED],
    conflicts: [FEE_CONFLICT, STATUS_CONFLICT],
    duplicates: [],
    warnings: ['«Micros Octubre (prueba)»: aviso de prueba.'],
    ...over,
  }
}

function preview(over: Partial<MergePreview> = {}): MergePreview {
  return {
    keep: { id: 'ikeep000000001', username: 'vane_inventada', platform: 'INSTAGRAM', followers: 2300, personId: null },
    other: { id: 'iother00000001', username: 'vane_mal', platform: 'INSTAGRAM', followers: 0, personId: null },
    mode: 'absorb',
    person: { keptPersonId: null, createsPerson: false, joining: [], otherLeavesPerson: false, otherPersonId: null },
    campaigns: [
      effect(),
      effect({ campaignId: JUN.id, campaignName: JUN.name, action: 'move', survivor: null, membersBefore: 20, membersAfter: 20, piecesBefore: 5, piecesAfter: 5, costBefore: 2000, costAfter: 2000, fields: [], conflicts: [], warnings: [] }),
    ],
    warnings: ['@vane_mal (Instagram) deja de rastrearse.'],
    missingChoices: [{ campaignId: OCT.id, group: 'agreedFee', label: 'Honorario acordado' }],
    nothingToDo: false,
    canApply: false,
    fingerprint: 'f'.repeat(64),
    summary: '@vane_mal (Instagram) fusionada en @vane_inventada (Instagram): «Micros Octubre (prueba)» 36 → 35 creadoras',
    ...over,
  }
}

const SELECTION = { keepId: 'ikeep000000001', otherId: 'iother00000001', mode: 'absorb' as const }

function review(over: Partial<ReviewPanelProps> = {}): string {
  const props: ReviewPanelProps = {
    candidate: candidate(),
    selection: SELECTION,
    choices: {},
    preview: preview(),
    loading: false,
    error: null,
    notice: null,
    step: 'review',
    texts: es,
    locale: 'es',
    onKeep: noop,
    onMode: noop,
    onChoice: noop,
    onMerge: noop,
    onConfirm: noop,
    onBack: noop,
    onCancel: noop,
    ...over,
  }
  return norm(renderToStaticMarkup(createElement(ReviewPanel, props)))
}

/** The radio inputs of a group: [value-less, checked?] in document order. */
function radios(html: string, name: string): boolean[] {
  const out: boolean[] = []
  for (const m of html.matchAll(/<input[^>]*>/g)) {
    const tag = m[0]
    if (!tag.includes(`name="${name}"`)) continue
    out.push(/\schecked=""/.test(tag))
  }
  return out
}

/** The <button> whose text contains `label`, as markup. */
function button(html: string, label: string): string | null {
  for (const m of html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)) if (m[0].includes(label)) return m[0]
  return null
}

/** Intl writes «150 €» with a no-break space: compared as a plain one. */
const norm = (s: string) => s.replace(/\u00a0/g, ' ')

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

// ============ fetch, scripted ============

interface Call { url: string; method: string; body: unknown }
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: unknown, init?: { method?: string; body?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    return answer(call)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const failing = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch

// ===========================================================================

describe('merge-api: paths and loading', () => {
  it('the screen, its campaign filter and the record of a profile', () => {
    expect(mergeScreenHref(null)).toBe('/creators/duplicadas')
    expect(mergeScreenHref('cabc123456789')).toBe('/creators/duplicadas?campaign=cabc123456789')
    expect(mergeScreenHref('a b&c')).toBe('/creators/duplicadas?campaign=a%20b%26c')
    // Her account on its network (there is no in-app page of an Influencer record: /creators/[id] is the discovery base)
    expect(profileHref({ username: 'vane_mal', platform: 'INSTAGRAM' })).toBe('https://www.instagram.com/vane_mal/')
    expect(profileHref({ username: '@dana.ejemplo', platform: 'TIKTOK' })).toBe('https://www.tiktok.com/@dana.ejemplo')
    expect(profileHref({ username: 'canal_demo', platform: 'YOUTUBE' })).toBe('https://www.youtube.com/@canal_demo')
    expect(profileHref({ username: 'a/b?c', platform: 'INSTAGRAM' })).toBe('https://www.instagram.com/a%2Fb%3Fc/')
  })

  it('loads candidates and history of one campaign, keeping only well-formed rows', async () => {
    const good = candidate()
    const { fetch, calls } = fakeFetch(() => json({
      campaign: OCT,
      candidates: [good, { key: 'broken' }, null],
      history: [{ logId: 'l1', action: 'merge', summary: 'x', actorName: 'Ada', createdAt: '2026-11-13T10:00:00.000Z', undoneAt: null, undoneByName: null, undoable: true, pair: null, mode: 'link' }, { nope: 1 }],
    }))
    const out = await loadMergeScreen(OCT.id, fetch)
    expect(calls[0].url).toBe(`${MERGE_ENDPOINT}?campaignId=${OCT.id}`)
    expect(out).toEqual({ ok: true, data: { campaign: OCT, candidates: [good], history: [expect.objectContaining({ logId: 'l1' })] } })
  })

  it('a refusal keeps the server sentence; no answer and a strange 200 are failures, never "no duplicates"', async () => {
    expect(await loadMergeScreen('cx', fakeFetch(() => json({ error: 'No encuentro esa campaña.' }, 404)).fetch))
      .toEqual({ ok: false, status: 404, error: 'No encuentro esa campaña.' })
    expect(await loadMergeScreen(null, failing)).toEqual({ ok: false, status: null, error: null })
    expect(await loadMergeScreen(null, fakeFetch(() => json({ candidates: 'x' })).fetch)).toEqual({ ok: false, status: 200, error: null })
    expect(await loadMergeScreen(null, fakeFetch(() => new Response('<html>', { status: 502 })).fetch)).toEqual({ ok: false, status: 502, error: null })
  })

  it('the count of the campaign notice: only a real number counts', async () => {
    const { fetch, calls } = fakeFetch(() => json({ count: 3 }))
    expect(await loadDuplicateCount(OCT.id, fetch)).toBe(3)
    expect(calls[0].url).toBe(`${MERGE_ENDPOINT}?campaignId=${OCT.id}&countOnly=1`)
    expect(await loadDuplicateCount(OCT.id, fakeFetch(() => json({ error: 'Solo un administrador…' }, 403)).fetch)).toBeNull()
    expect(await loadDuplicateCount(OCT.id, fakeFetch(() => json({ count: '3' })).fetch)).toBeNull()
    expect(await loadDuplicateCount(OCT.id, failing)).toBeNull()
  })
})

describe('merge-api: actions', () => {
  it('apply sends exactly the selection, the choices and the fingerprint of the preview', async () => {
    const result = { logId: 'l1', summary: 's', keepId: 'a', otherId: 'b', mode: 'absorb', personId: null, campaigns: [], warnings: [] }
    const { fetch, calls } = fakeFetch(() => json({ result }))
    const choices = { [OCT.id]: { agreedFee: 'keep' as const } }
    expect(await requestApply({ ...SELECTION, choices, fingerprint: 'abc' }, fetch)).toEqual({ ok: true, data: result })
    expect(calls[0]).toEqual({ url: MERGE_ENDPOINT, method: 'POST', body: { action: 'apply', ...SELECTION, choices, fingerprint: 'abc' } })
  })

  it('a 409 is a refusal with its code and details; a gateway or a dropped connection is "no answer"', async () => {
    const stale = await requestApply({ ...SELECTION, choices: {}, fingerprint: 'x' }, fakeFetch(() => json({ error: 'Las fichas han cambiado…', code: 'stale' }, 409)).fetch)
    expect(stale).toMatchObject({ ok: false, kind: 'refused', status: 409, code: 'stale', error: 'Las fichas han cambiado…' })
    const missing = await requestApply({ ...SELECTION, choices: {}, fingerprint: 'x' }, fakeFetch(() => json({ error: 'Falta elegir', code: 'needs_choice', missingChoices: [{ campaignId: OCT.id, group: 'agreedFee', label: 'Honorario acordado' }, { bad: 1 }] }, 409)).fetch)
    expect(missing).toMatchObject({ kind: 'refused', code: 'needs_choice', missingChoices: [{ campaignId: OCT.id, group: 'agreedFee', label: 'Honorario acordado' }] })
    for (const f of [failing, fakeFetch(() => new Response('Bad gateway', { status: 502 })).fetch, fakeFetch(() => json({ error: 'x' }, 504)).fetch, fakeFetch(() => json({})).fetch]) {
      expect(await requestApply({ ...SELECTION, choices: {}, fingerprint: 'x' }, f)).toEqual({ ok: false, kind: 'no_answer' })
    }
  })

  it('undo forces only when asked, with the hash of the differences shown, and passes the differences on', async () => {
    const differences = [{ kind: 'membership', id: 'm1', text: 'La ficha de @x ha cambiado: Honorario acordado 100 → 150.', blocking: false }]
    const { fetch, calls } = fakeFetch(call => ((call.body as { force?: boolean }).force ? json({ undone: { undoLogId: 'u1' } }) : json({ error: 'Han cambiado cosas', code: 'changed_since', differences, differencesHash: 'h1' }, 409)))
    expect(await requestUndo('l1', null, fetch)).toMatchObject({ kind: 'refused', code: 'changed_since', differences, differencesHash: 'h1' })
    expect(await requestUndo('l1', { differencesHash: 'h1' }, fetch)).toEqual({ ok: true, data: { undoLogId: 'u1' } })
    expect(calls.map(c => c.body)).toEqual([{ action: 'undo', logId: 'l1' }, { action: 'undo', logId: 'l1', force: true, differencesHash: 'h1' }])
  })

  it('preview and dismiss post their action', async () => {
    const { fetch, calls } = fakeFetch(call => json((call.body as { action: string }).action === 'preview' ? { preview: preview() } : { dismissed: { logId: 'd1', alreadyDismissed: false } }))
    expect((await requestPreview({ ...SELECTION, choices: {} }, fetch)).ok).toBe(true)
    expect(await requestDismiss('a', 'b', fetch)).toEqual({ ok: true, data: { logId: 'd1', alreadyDismissed: false } })
    expect(calls.map(c => c.body)).toEqual([{ action: 'preview', ...SELECTION, choices: {} }, { action: 'dismiss', aId: 'a', bId: 'b' }])
  })
})

describe('merge-api: the decisions of the screen', () => {
  it('the review starts with the suggestion; the other profile is the one not kept', () => {
    const c = candidate()
    expect(initialSelection(c)).toEqual(SELECTION)
    expect(initialSelection(candidate({ suggestion: { ...c.suggestion, keepId: 'iother00000001', mode: 'link' } }))).toEqual({ keepId: 'iother00000001', otherId: 'ikeep000000001', mode: 'link' })
    expect(otherOf(c, 'iother00000001')).toBe('ikeep000000001')
  })

  it('keeping the record the finder did not suggest never carries «absorb» over: it goes back to «link»', () => {
    const c = candidate() // suggestion: keep vane_inventada, absorb vane_mal
    expect(modeFor(c, 'ikeep000000001')).toBe('absorb')
    expect(modeFor(c, 'iother00000001')).toBe('link')
    expect(modeFor(candidate({ suggestion: { ...c.suggestion, mode: 'link' } }), 'ikeep000000001')).toBe('link')
  })

  it('after a refused apply, a choice survives only where the field still has the values the ADMIN saw', () => {
    const seen = preview()
    const choices = { [OCT.id]: { agreedFee: 'add' as const, status: 'other' as const }, [JUN.id]: { cost: 'keep' as const } }
    // The same values: every choice of a field that still exists stays
    expect(keepUnchangedChoices(choices, seen, preview())).toEqual({ [OCT.id]: { agreedFee: 'add', status: 'other' } })
    // The other row's fee went from 150 to 200: «Sumarlos» is asked again; the status choice stays
    const feeChanged = preview({ campaigns: [effect({ fields: [{ ...FEE_CONFLICT, otherValue: 200 }, STATUS_CONFLICT, NOTES_JOINED], conflicts: [{ ...FEE_CONFLICT, otherValue: 200 }, STATUS_CONFLICT] })] })
    expect(keepUnchangedChoices(choices, seen, feeChanged)).toEqual({ [OCT.id]: { status: 'other' } })
    // Another row survives now: nothing of that campaign is kept
    const otherSurvivor = preview({ campaigns: [effect({ survivor: { membershipId: 'mnew000000001', influencerId: 'ikeep000000001', username: 'vane_inventada', platform: 'INSTAGRAM' } })] })
    expect(keepUnchangedChoices(choices, seen, otherSurvivor)).toEqual({})
    // Nothing seen: nothing kept
    expect(keepUnchangedChoices(choices, null, preview())).toEqual({})
  })

  it('a choice is added without touching the previous object; the one in force is the ADMIN\'s, else the server\'s', () => {
    const before = { [OCT.id]: { status: 'other' as const } }
    const after = withChoice(before, OCT.id, 'agreedFee', 'add')
    expect(before).toEqual({ [OCT.id]: { status: 'other' } })
    expect(after).toEqual({ [OCT.id]: { status: 'other', agreedFee: 'add' } })
    expect(chosenFor(after, OCT.id, FEE_CONFLICT)).toBe('add')
    expect(chosenFor({}, OCT.id, FEE_CONFLICT)).toBeNull()
    expect(chosenFor({}, OCT.id, STATUS_CONFLICT)).toBe('keep')
  })

  it('«Fusionar» only on a fresh preview of exactly what is selected, applicable, with something to do', () => {
    const ok = preview({ canApply: true, missingChoices: [] })
    expect(canMerge(ok, SELECTION, false)).toBe(true)
    expect(canMerge(ok, SELECTION, true)).toBe(false)
    expect(canMerge(null, SELECTION, false)).toBe(false)
    expect(canMerge(preview(), SELECTION, false)).toBe(false)
    expect(canMerge(ok, { ...SELECTION, mode: 'link' }, false)).toBe(false)
    expect(canMerge(ok, { keepId: SELECTION.otherId, otherId: SELECTION.keepId, mode: 'absorb' }, false)).toBe(false)
    expect(canMerge({ ...ok, nothingToDo: true }, SELECTION, false)).toBe(false)
    expect(canMerge({ ...ok, fingerprint: '' }, SELECTION, false)).toBe(false)
  })

  it('values are written the way the ADMIN reads them', () => {
    expect(norm(fieldValueText(FEE_CONFLICT, 150, es, 'es'))).toBe('150 €')
    expect(fieldValueText(FEE_CONFLICT, 1234.5, es, 'en')).toBe('€1,234.5')
    expect(fieldValueText(FEE_CONFLICT, null, es, 'es')).toBe('—')
    expect(fieldValueText(STATUS_CONFLICT, 'POSTED', es, 'es')).toBe('Publicado')
    expect(fieldValueText(STATUS_CONFLICT, 'POSTED', en, 'en')).toBe('Posted')
    expect(fieldValueText({ group: 'whitelisting', kind: 'boolean' }, true, es, 'es')).toBe('Sí')
    expect(fieldValueText({ group: 'shipping', kind: 'shipping' }, { shippingName: 'Ana Ficticia', shippingCity: 'Madrid', shippingPhone: null, shippingQty: 2 }, es, 'es')).toBe('Ana Ficticia, Madrid, 2')
    expect(fieldValueText({ group: 'tracked', kind: 'survivor' }, { trackedLink: 'https://ejemplo.test/x', trackedClicks: 1200 }, es, 'es')).toBe('https://ejemplo.test/x · 1.200 clics')
    expect(fieldValueText({ group: 'createdAt', kind: 'earliest' }, { createdAt: '2026-10-19T10:00:00.000Z', addedById: 'u1', addedByName: 'Ada' }, es, 'es')).toBe('19 oct 2026 · Ada')
    expect(addedValue(FEE_CONFLICT)).toBe(250)
    expect(addedValue({ kind: 'money', survivorValue: 0.1, otherValue: 0.2 })).toBe(0.3)
  })
})

describe('the candidate card', () => {
  const html = renderToStaticMarkup(createElement(CandidateCard, { candidate: candidate(), texts: es, locale: 'es', reviewing: false, dismissing: false, busy: false, onReview: noop, onDismiss: noop }))

  it('shows the strength, the shared campaign «antes → después» and both profiles with a link to their account', () => {
    expect(html).toContain('Cuenta doble en una campaña')
    expect(html).toContain('36 → 35 creadoras')
    expect(html).toContain('href="https://www.instagram.com/vane_inventada/"')
    expect(html).toContain('href="https://www.instagram.com/vane_mal/"')
    expect(html).toContain('title="Abrir @vane_mal en Instagram (pestaña nueva)"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('>@vane_inventada<')
    expect(html).toContain('2.300 seguidores')
    expect(html).toContain('0 seguidores')
    expect(html).toContain(es.suggestedKeep)
  })

  it('lists each profile\'s campaigns with status, pieces and whether a fee is set', () => {
    expect(html).toContain('Micros Junio (prueba)')
    expect(html).toContain('Contratado')
    expect(html).toContain('1 publicación')
    expect(html).toContain('tiene honorario')
  })

  it('names the evidence and the suggestion, and offers both actions', () => {
    expect(html).toContain(escapeHtml('@vane_inventada y @vane_mal son miembros de «Micros Octubre (prueba)».'))
    expect(html).toContain('La web de @vane_inventada enlaza a tiktok.com/@vane_mal.')
    expect(html).toContain('Sugerencia: @vane_mal no tiene seguidores ni publicaciones propias.')
    expect(button(html, 'Revisar y fusionar')).not.toBeNull()
    expect(button(html, 'No es la misma persona')).not.toBeNull()
  })

  it('a sentence written by somebody else stays text', () => {
    const evil = renderToStaticMarkup(createElement(CandidateCard, {
      candidate: candidate({ evidence: [{ code: 'links_to_other', text: '<img src=x onerror=alert(1)>' }] }),
      texts: es, locale: 'es', reviewing: false, dismissing: false, busy: false, onReview: noop, onDismiss: noop,
    }))
    expect(evil).not.toContain('<img src=x')
    expect(evil).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('in English, with the same server sentences', () => {
    const eng = renderToStaticMarkup(createElement(CandidateCard, { candidate: candidate(), texts: en, locale: 'en', reviewing: false, dismissing: false, busy: false, onReview: noop, onDismiss: noop }))
    expect(eng).toContain('Counted twice in a campaign')
    expect(eng).toContain('Review and merge')
    expect(eng).toContain('Not the same person')
    expect(eng).toContain('36 → 35 creators')
  })
})

describe('the review: a merge cannot be applied by accident', () => {
  it('the suggestion is preselected: the record that stays and what the other one is', () => {
    const html = review()
    expect(radios(html, `keep-${candidate().key}`)).toEqual([true, false])
    expect(radios(html, `mode-${candidate().key}`)).toEqual([false, true])
    expect(html).toContain('Otro perfil suyo: se sigue rastreando')
    expect(html).toContain('Un usuario equivocado o antiguo: deja de rastrearse')
  })

  it('with the OTHER record kept, no mode is tagged «sugerida» (the suggestion was about the other record staying)', () => {
    const tagged = (html: string) => (html.match(/>sugerida</g) ?? []).length
    // The suggestion as it comes: the kept record and «absorb» carry the tag
    expect(tagged(review())).toBe(2)
    // vane_mal ticked as the record that stays, with «absorb» still selected: only the keep radio of the suggested record keeps its tag
    const swapped = review({ selection: { keepId: 'iother00000001', otherId: 'ikeep000000001', mode: 'absorb' }, preview: null })
    expect(radios(swapped, `keep-${candidate().key}`)).toEqual([false, true])
    expect(tagged(swapped)).toBe(1)
    const modeLabels = swapped.slice(swapped.indexOf(es.modeQuestion))
    expect(modeLabels).not.toContain('>sugerida<')
  })

  it('a money conflict without default has NOTHING checked, says so, and «Fusionar» stays disabled', () => {
    const html = review()
    expect(radios(html, `choice-${OCT.id}-agreedFee`)).toEqual([false, false, false])
    expect(html).toContain('Elige una opción')
    expect(html).toContain('Quedarse con el de @vane_inventada: 100 €')
    expect(html).toContain('Quedarse con el de @vane_mal: 150 €')
    expect(html).toContain('Sumarlos: 250 €')
    expect(html).toContain(escapeHtml('Falta elegir: Honorario acordado («Micros Octubre (prueba)»).'))
    expect(button(html, '>Fusionar<')).toMatch(/disabled=""/)
  })

  it('in English the names of the fields are English too (the server writes them in Spanish)', () => {
    const html = review({ texts: en, locale: 'en' })
    expect(html).toContain('Agreed fee')
    expect(html).not.toContain('Honorario acordado')
    expect(html).toContain('Notes:')
    expect(html).not.toContain('Notas:')
    expect(html).toContain(escapeHtml('Still to choose: Agreed fee («Micros Octubre (prueba)»).'))
    // Every group of the membership row has its name in both languages
    expect(Object.keys(en.fieldLabel).sort()).toEqual(Object.keys(es.fieldLabel).sort())
    expect(Object.keys(es.fieldLabel)).toHaveLength(21)
  })

  it('a conflict with a default shows it checked and marked; the joined notes are listed', () => {
    const html = review()
    expect(radios(html, `choice-${OCT.id}-status`)).toEqual([true, false])
    expect(html).toContain('(por defecto)')
    expect(html).toContain('Notas: se guardan las dos, una tras otra')
  })

  it('the choice made shows at once; with the server saying it can be applied, «Fusionar» is enabled', () => {
    const html = review({ choices: { [OCT.id]: { agreedFee: 'add' } }, preview: preview({ canApply: true, missingChoices: [] }) })
    expect(radios(html, `choice-${OCT.id}-agreedFee`)).toEqual([false, false, true])
    expect(button(html, '>Fusionar<')).not.toMatch(/disabled=""/)
  })

  it('the effects per campaign: creators, pieces, views unchanged, cost (pending while a fee is unchosen)', () => {
    const html = review()
    expect(html).toContain('Las dos fichas quedan en una: @vane_inventada')
    expect(html).toContain('Su ficha pasa a @vane_inventada, con sus publicaciones')
    expect(html).toMatch(/36 → <span[^>]*>35<\/span>/)
    expect(html).toContain('38 → 38')
    expect(html).toContain('sin cambios')
    expect(html).toContain('3600 € → <span')
    expect(html).toContain('falta elegir')
    expect(html).toContain('2000 € → 2000 €')
    expect(html).toContain('Ten en cuenta')
    expect(html).toContain('@vane_mal (Instagram) deja de rastrearse.')
  })

  it('a preview of another selection (or while computing) shows no figures and no way to merge', () => {
    const html = review({ selection: { ...SELECTION, mode: 'link' }, preview: preview({ canApply: true, missingChoices: [] }), loading: true })
    expect(html).not.toContain('Qué cambia en cada campaña')
    expect(html).toContain('Calculando qué cambia…')
    expect(button(html, '>Fusionar<')).toMatch(/disabled=""/)
  })

  it('«Fusionar» only opens the in-page confirmation, with the summary; «Sí, fusionar» applies', () => {
    const html = review({ step: 'confirm', preview: preview({ canApply: true, missingChoices: [] }) })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('¿Fusionar ahora?')
    expect(html).toContain(escapeHtml(preview().summary))
    expect(button(html, 'Sí, fusionar')).not.toBeNull()
    expect(button(html, 'Volver a revisar')).not.toBeNull()
    expect(button(html, '>Fusionar<')).toBeNull()
    // Nothing can be changed while confirming
    expect(html).toMatch(/<fieldset disabled=""/)
    for (const file of ['src/components/person-merge/merge-views.tsx', 'src/components/person-merge/person-merge-screen.tsx']) {
      expect(source(file)).not.toMatch(/window\.confirm|\bconfirm\(/)
    }
  })

  it('while applying, the confirmation cannot be pressed twice', () => {
    const html = review({ step: 'applying', preview: preview({ canApply: true, missingChoices: [] }) })
    expect(button(html, 'Fusionando…')).toMatch(/disabled=""/)
  })

  it('in English', () => {
    const html = review({ texts: en, locale: 'en' })
    expect(html).toContain('Which record stays?')
    expect(html).toContain('A wrong or old handle: no longer tracked')
    expect(html).toContain('Choose one')
    expect(html).toContain('€3,600 → <span')
  })
})

describe('the result and the history', () => {
  const entries: MergeHistoryEntry[] = [
    { logId: 'l2', action: 'merge', summary: '@vane_mal (Instagram) fusionada en @vane_inventada (Instagram)', actorName: 'Ada Admin', createdAt: '2026-11-13T10:00:00.000Z', undoneAt: null, undoneByName: null, undoable: true, pair: ['ikeep000000001', 'iother00000001'], mode: 'absorb' },
    { logId: 'l1', action: 'dismiss_candidate', summary: '@gema y @rosa no son la misma persona', actorName: 'Ada Admin', createdAt: '2026-11-12T10:00:00.000Z', undoneAt: '2026-11-12T11:00:00.000Z', undoneByName: 'Bea Admin', undoable: false, pair: null, mode: null },
  ]
  const render = (undo: Parameters<typeof HistoryList>[0]['undo'] = {}, texts = es, locale: 'es' | 'en' = 'es') =>
    renderToStaticMarkup(createElement(HistoryList, { entries, undo, busy: false, texts, locale, onUndo: noop, onForce: noop, onCancelUndo: noop }))

  it('each entry says what, who and when; only what is in force can be undone', () => {
    const html = render()
    expect(html).toContain('Fusión')
    expect(html).toContain('Descartada')
    expect(html).toContain('por Ada Admin')
    expect(html).toContain('Deshecha el 12 nov 2026')
    expect(html).toContain('por Bea Admin')
    expect(html.match(/>Deshacer</g)?.length).toBe(1)
  })

  it('changes since the merge are listed and the ADMIN is asked again before forcing', () => {
    const html = render({ l2: { status: 'ask_force', message: 'x', differences: [{ kind: 'membership', id: 'm1', text: 'La ficha de @vane_inventada (Instagram) en «Micros Octubre (prueba)» ha cambiado desde la fusión: Honorario acordado 100 → 150.', blocking: false }] } })
    expect(html).toContain('Han cambiado cosas desde la fusión')
    expect(html).toContain('Honorario acordado 100 → 150.')
    expect(button(html, 'Deshacer igualmente')).not.toBeNull()
    expect(button(html, 'Cancelar')).not.toBeNull()
  })

  it('what cannot be undone even forcing says why and offers no force; «Deshacer» stays, to try again once solved', () => {
    const html = render({ l2: { status: 'blocked', message: 'No se puede deshacer.', differences: [{ kind: 'membership', id: 'm1', text: '@vane_mal vuelve a ser miembro.', blocking: true }] } })
    expect(html).toContain('No se puede deshacer')
    expect(html).toContain('@vane_mal vuelve a ser miembro.')
    expect(button(html, 'Deshacer igualmente')).toBeNull()
    expect(html.match(/>Deshacer</g)?.length).toBe(1)
  })

  it('when the list changed while forcing, it says so and asks again with the list of now', () => {
    const html = render({ l2: { status: 'ask_force', changedAgain: true, differencesHash: 'h2', differences: [{ kind: 'piece', id: 'p1', text: 'Una publicación nueva.', blocking: false }] } })
    expect(html).toContain('Ha cambiado algo más después de que vieras la lista')
    expect(html).toContain('Una publicación nueva.')
    expect(button(html, 'Deshacer igualmente')).not.toBeNull()
  })

  it('an undo done says so; it claims a full restore only when nothing was overwritten and everything went back', () => {
    const result = { undoLogId: 'u', mergeLogId: 'l2', kind: 'merge' as const, alreadyUndone: false, restored: { memberships: 2, pieces: 1, notes: 0, settings: 0, profiles: 1 }, overwritten: [] as Array<{ kind: 'membership'; id: string; text: string; blocking: boolean }>, notRestored: [] as string[] }
    const clean = render({ l2: { status: 'done', result } })
    expect(clean).toContain('Deshecha: todo vuelve a estar como antes.')
    const overwritten = render({ l2: { status: 'done', result: { ...result, overwritten: [{ kind: 'membership', id: 'm', text: 'Honorario acordado 100 → 150.', blocking: false }] } } })
    expect(overwritten).not.toContain('todo vuelve a estar como antes')
    expect(overwritten).toContain('Deshecha, pero no todo ha quedado exactamente como antes')
    expect(overwritten).toContain('Sobrescrito: Honorario acordado 100 → 150.')
    const notBack = render({ l2: { status: 'done', result: { ...result, notRestored: ['La publicación p1 ya no existe.'] } } })
    expect(notBack).not.toContain('todo vuelve a estar como antes')
    expect(notBack).toContain('No se ha podido devolver: La publicación p1 ya no existe.')
  })

  it('the result of a merge, with the figures per campaign', () => {
    const html = norm(renderToStaticMarkup(createElement(MergeResultPanel, {
      result: { logId: 'l2', summary: '@vane_mal (Instagram) fusionada en @vane_inventada (Instagram)', keepId: 'a', otherId: 'b', mode: 'absorb', personId: null, campaigns: [{ campaignId: OCT.id, campaignName: OCT.name, action: 'fold', membersBefore: 36, membersAfter: 35, piecesBefore: 38, piecesAfter: 38, costBefore: 3600, costAfter: 3500 }], warnings: [] },
      texts: es, locale: 'es', onClose: noop,
    })))
    expect(html).toContain('Fusionada')
    expect(html).toContain('creadoras 36 → 35 · publicaciones 38 → 38 · coste 3600 € → 3500 €')
    expect(html).toContain('deshazla desde el historial')
  })

  it('in English', () => {
    const html = render({}, en, 'en')
    expect(html).toContain('Merge')
    expect(html).toContain('Undone on 12 Nov 2026')
    expect(html).toContain('>Undo<')
  })
})

describe('the notice of the campaign page (ADMIN only)', () => {
  it('«Hay N posibles fichas duplicadas en esta campaña. Revisarlas», linking to the screen filtered to it', () => {
    const many = renderToStaticMarkup(createElement(DuplicatesNoticeView, { count: 3, campaignId: OCT.id, texts: es }))
    expect(many).toContain('Hay 3 posibles fichas duplicadas en esta campaña.')
    expect(many).toContain(`href="/creators/duplicadas?campaign=${OCT.id}"`)
    expect(many).toContain('>Revisarlas</a>')
    const one = renderToStaticMarkup(createElement(DuplicatesNoticeView, { count: 1, campaignId: OCT.id, texts: es }))
    expect(one).toContain('Hay 1 posible ficha duplicada en esta campaña.')
    expect(one).toContain('>Revisarla</a>')
    expect(renderToStaticMarkup(createElement(DuplicatesNoticeView, { count: 0, campaignId: OCT.id, texts: es }))).toBe('')
    expect(renderToStaticMarkup(createElement(DuplicatesNoticeView, { count: 2, campaignId: OCT.id, texts: en }))).toContain('There are 2 possible duplicate records in this campaign.')
  })
})

describe('ADMIN only, on the server', () => {
  it('the page checks the session against the database before rendering, and sends everyone else away', () => {
    const page = source('src/app/(dashboard)/creators/duplicadas/page.tsx')
    expect(page).not.toMatch(/^['"]use client['"]/m)
    expect(page).toContain("checkAdminSession((await cookies()).get('token')?.value)")
    expect(page).toContain("if (session.status === 'anonymous') redirect('/login')")
    expect(page).toContain("if (session.status === 'forbidden') redirect(session.role === 'BRAND' ? '/portal' : '/dashboard')")
    expect(page).toContain("export const dynamic = 'force-dynamic'")
  })

  it('the sidebar shows the entry from the session role (never the localStorage default), and the campaign page only to an ADMIN', () => {
    const sidebar = source('src/components/layout/sidebar.tsx')
    expect(sidebar).toContain('{ key: "duplicates", icon: GitMerge, href: "/creators/duplicadas" }')
    expect(sidebar).toContain('const { isAdmin: sessionIsAdmin } = useRole()')
    expect(sidebar).toContain('sessionIsAdmin ? [...secondaryNavItems, ...adminNavItems] : secondaryNavItems')
    const campaignPage = source('src/app/(dashboard)/campaigns/[id]/page.tsx')
    expect(campaignPage).toContain('<DuplicatesNotice campaignId={campaignId} isAdmin={isAdmin} />')
    expect(source('src/components/person-merge/duplicates-notice.tsx')).toContain('if (!isAdmin || !count || count.campaignId !== campaignId) return null')
  })

  it('the route the screen calls is the ADMIN-only one, never reachable by the connector', () => {
    expect(MERGE_ENDPOINT).toBe('/api/admin/person-merge')
    expect(source('src/lib/mcp/platform-client.ts')).toContain("'/api/admin/person-merge'")
  })

  it('both languages carry the same texts of the screen', () => {
    const keys = (o: unknown, prefix = ''): string[] =>
      o && typeof o === 'object' ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k)) : [prefix]
    expect(keys(es).sort()).toEqual(keys(en).sort())
    expect(translations.es.nav.duplicates).toBe('Fichas duplicadas')
    expect(translations.en.nav.duplicates).toBe('Duplicate records')
  })
})
