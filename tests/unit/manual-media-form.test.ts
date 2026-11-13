/**
 * «Añadir publicación por URL» on the campaign page
 * (src/app/(dashboard)/campaigns/[id]/page.tsx).
 *
 * 12 Nov 2026: two TikTok links pasted while the previous link was processing
 * never reached the server. The URL field stayed enabled, Enter did not look at
 * the request in flight, and the previous answer cleared the field (wiping the
 * new link) and said «Publicación añadida», which seemed to be about it.
 *
 * A Next.js page may export only its component, so the helpers that name a link
 * live unexported in the page. These tests take them FROM THE PAGE SOURCE (the
 * block between the two marker comments), strip the types with the TypeScript
 * compiler and run them: what is tested is exactly what ships. The form's
 * behaviour (one link at a time, every field disabled, Enter, the conditional
 * reset, the modal) needs a browser to be clicked, which this suite does not
 * have; it is checked on the source as invariants that must not regress.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parsePostUrl } from '@/lib/post-url'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import { tiktokIdPostedAt } from '@/lib/tiktok-id'
import { translations } from '@/i18n/translations'

const here = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.resolve(here, '..', '..', 'src', 'app', '(dashboard)', 'campaigns', '[id]', 'page.tsx')
const source = fs.readFileSync(PAGE, 'utf8')

const es = translations.es.campaignDetail
const en = translations.en.campaignDetail
type Texts = typeof es

interface ManualHelpers {
  MANUAL_EMPTY_FORM: Record<string, string>
  fillManualText(template: string, values: Record<string, string>): string
  describeManualLink(url: string, texts: Texts, locale: string): string
  describeAddedPiece(media: unknown, texts: Texts, locale: string): string | null
}

function loadHelpers(): ManualHelpers {
  const start = source.indexOf('// ---- «Añadir publicación por URL»: every message names the link it is about')
  const end = source.indexOf('// ---- end of the «Añadir publicación por URL» helpers')
  if (start < 0 || end <= start) throw new Error('the marker comments around the helpers are gone from page.tsx')
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText
  const factory = new Function(
    'parsePostUrl', 'parseInstagramStoryUrl', 'tiktokIdPostedAt',
    `${js}\nreturn { MANUAL_EMPTY_FORM, fillManualText, describeManualLink, describeAddedPiece }`,
  ) as (...deps: unknown[]) => ManualHelpers
  return factory(parsePostUrl, parseInstagramStoryUrl, tiktokIdPostedAt)
}

const h = loadHelpers()

/** The opening tags of every <tag> inside `block` (attributes may hold arrow functions: braces are tracked) */
function openingTags(block: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}\\b`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    let depth = 0
    let i = m.index + 1
    for (; i < block.length; i++) {
      const c = block[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    out.push(block.slice(m.index, i + 1))
  }
  return out
}

function between(from: string, to: string): string {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a + 1)
  if (a < 0 || b < 0) throw new Error(`page.tsx: cannot find the block ${from} … ${to}`)
  return source.slice(a, b)
}

const form = between('{showManualMedia && (', '{media.length === 0 ? (')
const handler = between('async function handleAddManualMedia()', 'async function handleRevalidateMedia()')

describe('every message names the link it is about', () => {
  it('the owner\'s example: «Añadida: TikTok de @gema.ficticia_ (vídeo del 21 oct)», from the server\'s answer', () => {
    // The TikTok video is credited to her Instagram membership; the answer names the profile that published it
    const media = {
      platform: 'TIKTOK',
      mediaType: 'VIDEO',
      postedAt: '2026-10-21T10:00:00.000Z',
      influencer: { username: 'gladys.instagram' },
      publishedBy: { username: 'gema.ficticia_', platform: 'TIKTOK' },
    }
    const piece = h.describeAddedPiece(media, es, 'es')
    expect(h.fillManualText(es.manualResultAdded, { link: piece! })).toBe('Añadida: TikTok de @gema.ficticia_ (vídeo del 21 oct)')
    expect(h.fillManualText(en.manualResultAdded, { link: h.describeAddedPiece(media, en, 'en')! })).toBe('Added: TikTok by @gema.ficticia_ (video, 21 Oct)')
  })

  it('a piece of her own profile is named with her handle; an answer without a network gives no name', () => {
    expect(h.describeAddedPiece({ platform: 'INSTAGRAM', mediaType: 'REEL', postedAt: '2026-10-05T09:00:00Z', influencer: { username: 'nuria_demo15' }, publishedBy: null }, es, 'es'))
      .toBe('Instagram de @nuria_demo15 (reel del 5 oct)')
    expect(h.describeAddedPiece({ platform: 'INSTAGRAM', mediaType: 'STORY', influencer: { username: 'x' } }, es, 'es')).toBe('Instagram de @x (story)')
    expect(h.describeAddedPiece({ mediaType: 'REEL' }, es, 'es')).toBeNull()
    expect(h.describeAddedPiece(null, es, 'es')).toBeNull()
    expect(h.describeAddedPiece('boom', es, 'es')).toBeNull()
  })

  it('the two links lost on 12 Nov are named from the URL alone, with the date their id carries', () => {
    expect(h.describeManualLink('https://www.tiktok.com/@sara_inventada17/video/7694005611729571094', es, 'es'))
      .toBe('TikTok de @sara_inventada17 (vídeo del 7 oct)')
    expect(h.describeManualLink('https://www.tiktok.com/@lili_ficticia/video/7694256646884773153?is_from_webapp=1', es, 'es'))
      .toBe('TikTok de @lili_ficticia (vídeo del 8 oct)')
    expect(h.describeManualLink('https://www.tiktok.com/@lili_ficticia/video/7694256646884773153', en, 'en'))
      .toBe('TikTok by @lili_ficticia (video, 8 Oct)')
  })

  it('Instagram links, stories, short links and anything unknown', () => {
    expect(h.describeManualLink('https://www.instagram.com/reel/DPx1abcDEF/', es, 'es')).toBe('Instagram (reel)')
    expect(h.describeManualLink('instagram.com/gema.ficticia_/p/DPx1abcDEF/', es, 'es')).toBe('Instagram de @gema.ficticia_ (publicación)')
    // a story id carries its publication time (Instagram snowflake): 21 Oct 2026, 18:30 UTC
    const storyId = (BigInt(Date.UTC(2026, 9, 21, 18, 30) - 1314220021721) << BigInt(23)).toString()
    expect(h.describeManualLink(`https://www.instagram.com/stories/gema.ficticia_/${storyId}/`, es, 'es')).toBe('Instagram de @gema.ficticia_ (story del 21 oct)')
    expect(h.describeManualLink('https://youtube.com/shorts/abcdefghijk', es, 'es')).toBe('YouTube (short)')
    expect(h.describeManualLink('https://vm.tiktok.com/ZMabc123/', es, 'es')).toBe('vm.tiktok.com/ZMabc123/')
    const long = `https://example.com/${'a'.repeat(80)}`
    const named = h.describeManualLink(long, es, 'es')
    expect(named.length).toBe(58)
    expect(named.endsWith('…')).toBe(true)
  })
})

describe('one link at a time (source invariants of the form)', () => {
  it('the form is busy while a link is on its way AND while the question about it is open', () => {
    expect(source).toMatch(/const manualMediaBusy = isAddingManualMedia \|\| linkProfileRequest !== null/)
    expect(source).toMatch(/const canSendManualMedia = !manualMediaBusy && /)
  })

  it('every field of the form is disabled while busy', () => {
    const fields = [...openingTags(form, 'input'), ...openingTags(form, 'select')]
    // URL, creator, the count fields (one tag rendered per field) and the date
    expect(fields.length).toBeGreaterThanOrEqual(4)
    for (const tag of fields) expect(tag, tag.slice(0, 80)).toContain('disabled={manualMediaBusy}')
  })

  it('Enter sends only what the button would send, and nothing while busy', () => {
    const [url] = openingTags(form, 'input').filter(tag => tag.includes('type="url"'))
    expect(url).toBeDefined()
    expect(url).toMatch(/onKeyDown=\{\(e\) => \{[\s\S]*e\.preventDefault\(\)[\s\S]*if \(canSendManualMedia\) void handleAddManualMedia\(\)/)
    // the old handler, which ignored the request in flight, is gone from the whole page
    expect(source).not.toMatch(/e\.key === 'Enter' && handleAddManualMedia\(\)/)
    const [button] = openingTags(form, 'Button').filter(tag => tag.includes('handleAddManualMedia'))
    expect(button).toContain('disabled={!canSendManualMedia}')
    expect(button).toContain('aria-busy={isAddingManualMedia}')
  })

  it('a synchronous lock is taken before the request and released only when the answer (or the question) is over', () => {
    const firstAwait = handler.indexOf('await ')
    const guard = handler.indexOf('if (!url || manualMediaLock.current || linkProfileRequest) return')
    const take = handler.indexOf('manualMediaLock.current = true')
    expect(guard).toBeGreaterThan(-1)
    expect(take).toBeGreaterThan(guard)
    expect(take).toBeLessThan(firstAwait)
    expect(handler).toMatch(/finally \{\s*if \(!waitsForAnswer\) manualMediaLock\.current = false/)
    // the 409 that opens the question keeps the lock
    expect(handler).toMatch(/waitsForAnswer = true\s*setLinkProfileRequest/)
    // every way out of the question releases it
    const confirm = openingTags(source, 'LinkProfileConfirm')[0]
    expect(confirm.match(/finishLinkProfileQuestion\(/g)).toHaveLength(3)
    for (const prop of ['onClose=', 'onDone=', 'onNeedsPostedAt=']) expect(confirm).toContain(prop)
    expect(between('function finishLinkProfileQuestion(', 'async function handleRevalidateMedia()')).toMatch(/^[^\n]*\n\s*manualMediaLock\.current = false/)
  })

  it('a link saved through «¿De quién es esta publicación?» is named from the answer, as a direct add is', () => {
    const confirm = openingTags(source, 'LinkProfileConfirm')[0]
    const onDone = confirm.slice(confirm.indexOf('onDone='), confirm.indexOf('onNeedsPostedAt='))
    expect(onDone).toMatch(/onDone=\{\(message, saved\) => \{/)
    expect(onDone).toContain('describeAddedPiece(saved.media, t.campaignDetail, locale) ?? describeManualLink(sentUrl, t.campaignDetail, locale)')
    expect(onDone).toContain('saved.created === false ? t.campaignDetail.manualResultUpdated : t.campaignDetail.manualResultAdded')
    // What the modal passes is the answer's own row
    const modal = fs.readFileSync(path.resolve(here, '..', '..', 'src', 'components', 'link-profile-confirm.tsx'), 'utf8')
    expect(modal).toContain('onDone(outcome.message, { media: outcome.media, created: outcome.created })')
    // An Instagram /p/ link has no handle in the URL: the answer names who published it
    const media = { platform: 'INSTAGRAM', mediaType: 'REEL', postedAt: '2026-10-21T09:00:00.000Z', influencer: { username: 'gema.ficticia_' }, publishedBy: null }
    expect(h.describeAddedPiece(media, es, 'es')).toBe('Instagram de @gema.ficticia_ (reel del 21 oct)')
    expect(h.describeManualLink('https://www.instagram.com/p/DPq1aBcDeFg/', es, 'es')).not.toContain('@')
  })

  it('the form is cleared only if it still holds the link that was sent', () => {
    expect(source).not.toMatch(/setManualMediaForm\(\{\s*url: ''/)
    expect(source).not.toMatch(/setManualMediaForm\(MANUAL_EMPTY_FORM\)/)
    const resets = source.match(/setManualMediaForm\(f => \(f\.url\.trim\(\) === (\w+) \? MANUAL_EMPTY_FORM : f\)\)/g) ?? []
    // the direct answer and the answer through the question
    expect(resets).toHaveLength(2)
    expect(source.split('MANUAL_EMPTY_FORM').length - 1).toBe(1 + resets.length)
  })

  it('every result message carries the link it is about', () => {
    const calls = source.match(/(?:setManualMediaResult|showManualResult|postManualOutcome\(campaignId,)\s*\(?\{[^}]*/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    for (const call of calls) expect(call, call).toContain('title:')
    // the handler speaks only through showManualResult (the form, or the PM's return if she left)
    expect(handler).not.toMatch(/setManualMediaResult\(\{/)
    // the panel cannot be hidden, nor the form closed, while a link is on its way
    expect(source).toMatch(/onClick=\{\(\) => \{ setShowManualMedia\(v => !v\); setManualMediaResult\(null\) \}\}\s*\/\/[^\n]*\n\s*disabled=\{isAddingManualMedia\}/)
    expect(form).toMatch(/<Button variant="secondary" size="sm" disabled=\{isAddingManualMedia\}/)
  })
})

describe('what the form says, and when (review of delivery 1b)', () => {
  it('no answer from the server, or a gateway’s answer: «Sin confirmar», never a firm «No añadida»', () => {
    expect(handler).toMatch(/const notConfirmed = \(message: string\) => showManualResult\(\{ type: 'error', title: fillManualText\(cd\.manualResultUnknown, \{ link \}\), message \}\)/)
    // the fetch rejected
    expect(handler).toMatch(/\} catch \{\s*\/\/[^\n]*\n\s*notConfirmed\(cd\.manualDetailNetworkError\)\s*return/)
    // a body that is not the server's JSON with a 502-504: checked before anything reads it
    const check = handler.indexOf('if (noClearAnswer(res, parsed)) {')
    expect(check).toBeGreaterThan(-1)
    expect(handler.slice(check, check + 120)).toContain('notConfirmed(cd.manualDetailNoAnswer)')
    expect(check).toBeLessThan(handler.indexOf('if (!res.ok) {'))
    expect(handler).not.toContain('notAdded(cd.manualDetailNetworkError)')
  })

  it('a piece that was already there says so, a story included; one claimed from no campaign is «Añadida»', () => {
    expect(handler).toMatch(/message: data\.created === false\s*\? cd\.manualDetailAlreadyThere\s*: data\.isStory\s*\? cd\.manualStoryAdded/)
    // the server answers created:true for an unattached row it attaches (tests/db/manual-media.test.ts)
    const route = fs.readFileSync(path.resolve(here, '..', '..', 'src', 'app', 'api', 'campaigns', '[id]', 'media', 'manual', 'route.ts'), 'utf8')
    expect(route).toContain('const created = !existing || claimsLooseRow')
  })

  it('the form is free as soon as the answer is in: the campaign reloads behind it', () => {
    expect(handler).toContain('void fetchCampaign()')
    expect(handler).not.toContain('await fetchCampaign()')
  })

  it('the date typed for one link is never sent with another', () => {
    const [url] = openingTags(form, 'input').filter(tag => tag.includes('type="url"'))
    expect(url).toContain("setManualMediaForm(f => ({ ...f, url: e.target.value, postedAt: '' }))")
    expect(handler).toContain('if (showManualPostedAt && manualMediaForm.postedAt) {')
  })

  it('the URL field takes the focus back only when the focus was lost, never from another field', () => {
    expect(source).toMatch(/const focusLost = !document\.activeElement \|\| document\.activeElement === document\.body\s*\n\s*if \(manualMediaWasBusy\.current && !manualMediaBusy && focusLost\) manualUrlInputRef\.current\?\.focus/)
  })

  it('leaving the page with a link unfinished asks first: closing the tab and every link of the app', () => {
    const guard = between('// Leaving the page with a link unfinished asks first', '// Revalidate media against the capture rules')
    expect(guard).toContain('if (!manualPendingLink) return')
    expect(guard).toContain("window.addEventListener('beforeunload', onBeforeUnload)")
    expect(guard).toContain("window.addEventListener('click', onClick, true)")
    expect(guard).toMatch(/if \(!window\.confirm\(question\)\) \{\s*e\.preventDefault\(\)\s*e\.stopPropagation\(\)/)
    expect(guard).toContain('fillManualText(t.campaignDetail.manualLeaveConfirm, { link: manualPendingLink })')
    // pending = on its way, or its question open
    expect(source).toMatch(/const manualPendingLink = manualMediaSending\s*\n\s*\?\? \(linkProfileRequest \?/)
  })

  it('an answer that lands after the PM left is kept and shown when she is back; a question left open says nothing was saved', () => {
    // (13 Nov 2026: `lead` puts «Añadida fuera de plazo: …» before the message; the routing is the same)
    expect(source).toMatch(/function showManualResult\(outcome: ManualOutcome, lead\?: string \| null\) \{\s*const shown = lead \? \{ \.\.\.outcome, message: `\$\{lead\} \$\{outcome\.message\}` \} : outcome\s*if \(manualMediaOpenFor\.current === campaignId\) setManualMediaResult\(shown\)\s*else postManualOutcome\(campaignId, shown\)/)
    // the 409 that would open the question, with the page gone
    expect(handler).toMatch(/if \(manualMediaOpenFor\.current !== campaignId\) \{\s*\/\/[^\n]*\n\s*notAdded\(cd\.manualDetailQuestionLeft\)\s*return/)
    // the page going away with the question open
    const effect = between('const manualMediaOpenFor = useRef<string | null>(null)', 'function showManualResult(')
    expect(effect).toContain('manualMediaOpenFor.current = campaignId')
    expect(effect).toContain('manualMediaOpenFor.current = null')
    expect(effect).toContain("postManualOutcome(campaignId, { type: 'error', title: fillManualText(t.campaignDetail.manualResultNotAdded, { link }), message: t.campaignDetail.manualDetailQuestionLeft })")
    expect(effect).toMatch(/const take = \(\) => \{[\s\S]*manualOutcomeInbox\.delete\(campaignId\)[\s\S]*setToast\(/)
    expect(handler).toMatch(/manualQuestionLink\.current = link\s*\n\s*waitsForAnswer = true\s*\n\s*setLinkProfileRequest/)
    expect(between('function finishLinkProfileQuestion(', 'async function handleRevalidateMedia()')).toContain('if (result) showManualResult(result)')
  })

  it('the question closed after a resend that failed is not «sin responder»', () => {
    const confirm = openingTags(source, 'LinkProfileConfirm')[0]
    expect(confirm).toContain('onClose={(lastFailure) => {')
    expect(confirm).toContain('finishLinkProfileQuestion(closedQuestionResult(lastFailure, link, t.campaignDetail), sentUrl)')
    expect(confirm).not.toContain('manualDetailCancelled')
  })
})

describe('texts', () => {
  const keys = [
    'manualResultAdded', 'manualResultUpdated', 'manualResultNotAdded', 'manualDetailEnriched', 'manualDetailNotEnriched',
    'manualDetailAlreadyThere', 'manualDetailCancelled', 'manualDetailError', 'manualDetailNetworkError', 'manualDetailBadDate',
    'manualSending', 'manualLinkOf', 'manualLinkKindDate',
    'manualResultUnknown', 'manualDetailNoAnswer', 'manualDetailQuestionLeft', 'manualLeaveConfirm',
  ] as const

  it('exist in both languages with the same placeholders, and no em-dash', () => {
    const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of keys) {
      expect(es[key].length, key).toBeGreaterThan(0)
      expect(placeholders(es[key]), key).toEqual(placeholders(en[key]))
      expect(es[key], key).not.toContain('—')
    }
    expect(Object.keys(es.manualMediaKinds).sort()).toEqual(['CAROUSEL', 'POST', 'REEL', 'SHORT', 'STORY', 'VIDEO'])
    expect(Object.keys(en.manualMediaKinds).sort()).toEqual(Object.keys(es.manualMediaKinds).sort())
  })

  it('the three titles name the link', () => {
    expect(es.manualResultAdded).toBe('Añadida: {link}')
    expect(es.manualResultUpdated).toBe('Actualizada: {link}')
    expect(es.manualResultNotAdded).toBe('No añadida: {link}')
    expect(es.manualResultUnknown).toBe('Sin confirmar: {link}')
    expect(es.manualSending).toContain('{link}')
    expect(es.manualLeaveConfirm).toContain('{link}')
  })

  it('while a link is processing, the line under the form also asks not to leave the page', () => {
    expect(es.manualSending).toBe('Añadiendo {link}. Espera la respuesta antes de pegar otro enlace y no salgas de la página.')
    expect(en.manualSending).toContain('do not leave the page')
  })

  it('the summary card names what it counts: creators with content, not profiles', () => {
    expect(es.profilesPosted).toBe('Creadoras con contenido')
    expect(en.profilesPosted).toBe('Creators with content')
    expect(source).toMatch(/label=\{t\.campaignDetail\.profilesPosted\}\s*\n\s*value=\{totals\.creatorsActive\}/)
  })
})
