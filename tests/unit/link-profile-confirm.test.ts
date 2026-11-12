/**
 * «¿De quién es esta publicación?» (src/components/link-profile-confirm.tsx):
 * the pure helpers that read the 409 `profile_not_linked`, build the selector
 * and the resent request, and the first render of each state of the modal
 * (server-rendered markup: no DOM library, so no click is exercised here).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LinkProfileConfirm,
  closedQuestionResult,
  failureOf,
  linkProfileOptions,
  linkProfileResendBody,
  noClearAnswer,
  profileNotLinkedFrom,
  readLinkProfileAnswer,
  type LinkProfileRequest,
} from '@/components/link-profile-confirm'
import { translations } from '@/i18n/translations'

const es = translations.es.campaignDetail
const en = translations.en.campaignDetail

const members = [
  { influencer: { id: 'ig-sara', username: 'sara_inventada17', platform: 'INSTAGRAM' } },
  { influencer: { id: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM' } },
  { influencer: { id: 'tt-diana', username: 'dana_ejemplo_dos', platform: 'TIKTOK' } },
  { influencer: { id: 'ig-diana', username: 'dana_ejemplo_dos', platform: 'INSTAGRAM' } },
  { influencer: null },
  { influencer: { id: 'ig-Zoe', username: 'Zoe', platform: 'INSTAGRAM' } },
]

const answer409 = {
  code: 'profile_not_linked',
  error: 'Este contenido es de @ale_ficticia en TikTok, que no está registrado como perfil de ninguna creadora de esta campaña.',
  author: { handle: '@ale_ficticia', platform: 'TIKTOK', verified: true },
  suggestions: [
    { influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'same_handle' },
    { influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'bio_link' },
  ],
}

describe('profileNotLinkedFrom', () => {
  it('reads the 409, strips the @ and de-duplicates the suggestions', () => {
    const r = profileNotLinkedFrom(409, answer409)
    expect(r).toEqual({
      author: { handle: 'ale_ficticia', platform: 'TIKTOK', verified: true },
      suggestions: [{ influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'same_handle' }],
    })
  })
  it('is null for any other answer', () => {
    expect(profileNotLinkedFrom(400, answer409)).toBeNull()
    expect(profileNotLinkedFrom(409, { code: 'profile_of_other_person', error: 'x' })).toBeNull()
    expect(profileNotLinkedFrom(409, { error: 'Este contenido ya está en esta campaña con otro creador' })).toBeNull()
    expect(profileNotLinkedFrom(409, null)).toBeNull()
    expect(profileNotLinkedFrom(409, 'boom')).toBeNull()
    expect(profileNotLinkedFrom(409, { code: 'profile_not_linked' })).toBeNull()
    expect(profileNotLinkedFrom(409, { code: 'profile_not_linked', author: { handle: '', platform: 'TIKTOK' } })).toBeNull()
    expect(profileNotLinkedFrom(409, { code: 'profile_not_linked', author: { handle: 'x' } })).toBeNull()
  })
  it('treats anything but verified:true as unverified, and tolerates no suggestions', () => {
    expect(profileNotLinkedFrom(409, { code: 'profile_not_linked', author: { handle: 'x', platform: 'INSTAGRAM' } }))
      .toEqual({ author: { handle: 'x', platform: 'INSTAGRAM', verified: false }, suggestions: [] })
    expect(profileNotLinkedFrom(409, { code: 'profile_not_linked', author: { handle: 'x', platform: 'INSTAGRAM', verified: 'true' }, suggestions: 'no' })?.author.verified).toBe(false)
  })
})

describe('linkProfileOptions', () => {
  it('lists the suggestions first with their reason, then the rest by username', () => {
    const { options, suggested } = linkProfileOptions(
      [
        { influencerId: 'ig-sara', username: 'sara_inventada17', platform: 'INSTAGRAM', reason: 'selected' },
        { influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'same_handle' },
        { influencerId: 'ig-diana', username: '', platform: '', reason: 'bio_link' },
        { influencerId: 'ghost', username: 'nuevo', platform: 'YOUTUBE', reason: 'something_new' },
        { influencerId: 'nameless', username: '', platform: '', reason: 'selected' },
      ],
      members,
      es,
    )
    expect(suggested).toEqual(['ig-sara', 'ig-alez', 'ig-diana', 'ghost'])
    expect(options).toEqual([
      { value: 'ig-sara', label: '@sara_inventada17 · Instagram · la que has elegido' },
      { value: 'ig-alez', label: '@ale_ficticia · Instagram · mismo usuario en otra red' },
      { value: 'ig-diana', label: '@dana_ejemplo_dos · Instagram · enlaza este perfil en su bio' },
      { value: 'ghost', label: '@nuevo · YouTube' },
      { value: 'tt-diana', label: '@dana_ejemplo_dos · TikTok' },
      { value: 'ig-Zoe', label: '@Zoe · Instagram' },
    ])
  })
  it('with no suggestion lists every member once', () => {
    const { options, suggested } = linkProfileOptions([], [...members, members[0]], es)
    expect(suggested).toEqual([])
    expect(options.map(o => o.value)).toEqual(['ig-alez', 'tt-diana', 'ig-diana', 'ig-sara', 'ig-Zoe'].sort((a, b) => {
      const name = (id: string) => members.find(m => m.influencer?.id === id)!.influencer!.username
      return name(a).localeCompare(name(b), 'es', { sensitivity: 'base' })
    }))
    expect(new Set(options.map(o => o.value)).size).toBe(options.length)
  })
})

describe('linkProfileResendBody', () => {
  it('keeps the request and adds the answer, with the author the answer is about', () => {
    const body = { url: 'https://www.tiktok.com/@ale_ficticia/video/7695852671042964758', influencerId: 'ig-sara', views: 10 }
    expect(linkProfileResendBody(body, 'ig-alez', false, 'ale_ficticia')).toEqual({
      url: body.url, views: 10, influencerId: 'ig-alez', linkProfileTo: 'ig-alez', linkProfileAuthor: 'ale_ficticia',
    })
    expect(linkProfileResendBody({ url: body.url }, 'ig-alez', true, '@risas_inventadas_')).toEqual({
      url: body.url, influencerId: 'ig-alez', linkProfileTo: 'ig-alez', linkProfileAuthor: 'risas_inventadas_', confirmUnverified: true,
    })
    // the original is untouched
    expect(body.influencerId).toBe('ig-sara')
  })

  it('the author sent is the one of THIS answer, never one left in the kept request', () => {
    const stale = { url: 'https://www.tiktok.com/@viejo/video/1', linkProfileAuthor: 'viejo', linkProfileTo: 'otra', confirmUnverified: true }
    expect(linkProfileResendBody(stale, 'ig-alez', false, 'nuevo')).toMatchObject({ linkProfileTo: 'ig-alez', linkProfileAuthor: 'nuevo' })
  })
})

describe('readLinkProfileAnswer', () => {
  const base = { sentConfirmUnverified: false, texts: es }
  it('success names what the server linked', () => {
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 201, data: { linkedProfile: { handle: 'ale_ficticia', platform: 'TIKTOK', memberUsername: '@ale_ficticia' } } }))
      .toEqual({ kind: 'done', message: 'Publicación añadida. @ale_ficticia queda como perfil de @ale_ficticia.' })
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 201, data: { linkedProfile: { handle: 'risas_inventadas_', platform: 'INSTAGRAM', memberUsername: 'risas_inventadas' } } }))
      .toEqual({ kind: 'done', message: 'Publicación añadida. @risas_inventadas_ queda como perfil de @risas_inventadas.' })
    expect(readLinkProfileAnswer({ ...base, texts: en, ok: true, status: 200, data: { linkedProfile: { handle: 'a$&b', platform: 'TIKTOK', memberUsername: 'c' } } }))
      .toEqual({ kind: 'done', message: 'Post added. @a$&b is now a profile of @c.' })
  })
  it('success carries the stored row and whether it was new, so the form names THIS piece', () => {
    const media = { id: 'm1', platform: 'TIKTOK', mediaType: 'VIDEO', postedAt: '2026-10-07T10:00:00.000Z', influencer: { username: 'sara_inventada17' }, publishedBy: { username: 'sara_inventada17' } }
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 201, data: { created: true, media, linkedProfile: { handle: 'sara_inventada17', platform: 'TIKTOK', memberUsername: 'sara_inventada17' } } }))
      .toEqual({ kind: 'done', message: 'Publicación añadida. @sara_inventada17 queda como perfil de @sara_inventada17.', media, created: true })
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 200, data: { created: false, media } })).toEqual({ kind: 'done', message: 'Publicación añadida.', media, created: false })
    // Anything else in those fields is not passed on
    const odd = readLinkProfileAnswer({ ...base, ok: true, status: 200, data: { created: 'yes', media: 'm1' } })
    expect(odd).toEqual({ kind: 'done', message: 'Publicación añadida.' })
    expect(Object.keys(odd)).toEqual(['kind', 'message'])
  })
  it('success without a link claims nothing about the profile', () => {
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 200, data: { linkedProfile: null } })).toEqual({ kind: 'done', message: 'Publicación añadida.' })
    expect(readLinkProfileAnswer({ ...base, ok: true, status: 200, data: {} })).toEqual({ kind: 'done', message: 'Publicación añadida.' })
  })
  it('409 again with verified:false asks for the confirmation once', () => {
    const data = { ...answer409, author: { ...answer409.author, verified: false } }
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 409, data })).toEqual({ kind: 'confirm_unverified' })
    expect(readLinkProfileAnswer({ ...base, sentConfirmUnverified: true, ok: false, status: 409, data })).toEqual({ kind: 'error', message: answer409.error })
    // verified:true and still refused: show the sentence, never loop
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 409, data: answer409 })).toEqual({ kind: 'error', message: answer409.error })
  })
  it('a new question about ANOTHER author than the one she answered for replaces the one on screen', () => {
    const shownAuthor = { handle: 'ale_ficticia', platform: 'TIKTOK', verified: true }
    const other = {
      ...answer409,
      author: { handle: 'alez_antiguo', platform: 'TIKTOK', verified: false },
      suggestions: [{ influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'selected' }],
    }
    // Whether or not she had ticked the confirmation: it was about the other author
    for (const sentConfirmUnverified of [false, true]) {
      expect(readLinkProfileAnswer({ ...base, sentConfirmUnverified, shownAuthor, ok: false, status: 409, data: other })).toEqual({
        kind: 'author_changed',
        author: { handle: 'alez_antiguo', platform: 'TIKTOK', verified: false },
        suggestions: [{ influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'selected' }],
      })
    }
    // The mirror: she was shown the @user of the link and the network now names the real author
    expect(readLinkProfileAnswer({ ...base, sentConfirmUnverified: true, shownAuthor: { handle: 'alez_antiguo', platform: 'TIKTOK', verified: false }, ok: false, status: 409, data: answer409 }))
      .toMatchObject({ kind: 'author_changed', author: { handle: 'ale_ficticia', platform: 'TIKTOK', verified: true } })
    // The same author (any casing, with @) is not a change: only the confirmation is asked for
    const sameUnverified = { ...answer409, author: { handle: '@Ale_Ficticia', platform: 'tiktok', verified: false } }
    expect(readLinkProfileAnswer({ ...base, shownAuthor, ok: false, status: 409, data: sameUnverified })).toEqual({ kind: 'confirm_unverified' })
    // The same handle on another network is another author
    expect(readLinkProfileAnswer({ ...base, shownAuthor, ok: false, status: 409, data: { ...answer409, author: { handle: 'ale_ficticia', platform: 'INSTAGRAM', verified: true } } }))
      .toMatchObject({ kind: 'author_changed', author: { handle: 'ale_ficticia', platform: 'INSTAGRAM' } })
  })

  it('profile of another person, dates and anything else show the server sentence', () => {
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 409, data: { code: 'profile_of_other_person', error: '@ale_ficticia ya es un perfil de @otra.' } }))
      .toEqual({ kind: 'error', message: '@ale_ficticia ya es un perfil de @otra.' })
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 400, data: { error: 'Fuera de las fechas de la campaña' } }))
      .toEqual({ kind: 'error', message: 'Fuera de las fechas de la campaña' })
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 500, data: null })).toEqual({ kind: 'error', message: 'No se pudo añadir la publicación' })
    expect(readLinkProfileAnswer({ ...base, ok: false, status: 400, data: { error: 'Indica la fecha', needsPostedAt: true } }))
      .toEqual({ kind: 'needs_date', message: 'Indica la fecha' })
  })
})

describe('closing the question after a resend that failed (review of delivery 1b)', () => {
  const link = 'TikTok de @ale_ficticia (vídeo del 21 oct)'
  const modal = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'components', 'link-profile-confirm.tsx'), 'utf8')
  const confirm = modal.slice(modal.indexOf('async function handleConfirm()'), modal.indexOf('// Not closable while the request is on its way'))

  it('no resend, or the server asked again: «No añadida» and «has cerrado la pregunta sin responder»', () => {
    expect(closedQuestionResult(null, link, es)).toEqual({ type: 'error', title: 'No añadida: TikTok de @ale_ficticia (vídeo del 21 oct)', message: es.manualDetailCancelled })
    expect(failureOf({ kind: 'confirm_unverified' })).toBeNull()
    expect(failureOf({ kind: 'author_changed', author: { handle: 'otra', platform: 'TIKTOK', verified: true }, suggestions: [] })).toBeNull()
  })

  it('the resend got no answer (it may be stored): «Sin confirmar», with the network sentence', () => {
    expect(closedQuestionResult({ kind: 'network' }, link, es)).toEqual({ type: 'error', title: 'Sin confirmar: TikTok de @ale_ficticia (vídeo del 21 oct)', message: es.manualDetailNetworkError })
    expect(closedQuestionResult({ kind: 'network' }, link, en).title).toBe('Not confirmed: TikTok de @ale_ficticia (vídeo del 21 oct)')
  })

  it('the server refused it: «No añadida» with the server’s own reason, never «sin responder»', () => {
    const refused = readLinkProfileAnswer({ ok: false, status: 409, data: { error: 'Este contenido ya está registrado para otro creador.' }, sentConfirmUnverified: false, texts: es })
    expect(failureOf(refused)).toEqual({ kind: 'refused', message: 'Este contenido ya está registrado para otro creador.' })
    const expired = readLinkProfileAnswer({ ok: false, status: 401, data: { error: 'Not authenticated' }, sentConfirmUnverified: false, texts: es })
    expect(closedQuestionResult(failureOf(expired), link, es)).toEqual({ type: 'error', title: `No añadida: ${link}`, message: 'Not authenticated' })
    expect(failureOf({ kind: 'needs_date', message: 'Indica la fecha' })).toEqual({ kind: 'refused', message: 'Indica la fecha' })
  })

  it('a gateway’s answer (502-504, not JSON) is no answer; the server’s own JSON error is one', () => {
    for (const status of [502, 503, 504]) expect(noClearAnswer({ ok: false, status }, null), String(status)).toBe(true)
    expect(noClearAnswer({ ok: false, status: 502 }, { error: 'x' })).toBe(false)
    expect(noClearAnswer({ ok: false, status: 500 }, null)).toBe(false)
    expect(noClearAnswer({ ok: false, status: 409 }, null)).toBe(false)
    expect(noClearAnswer({ ok: true, status: 201 }, null)).toBe(false)
  })

  it('the dialog records how the last resend ended and hands it to the form when it is closed', () => {
    expect(modal).toContain('const close = () => { if (!submitting) onClose(lastFailure) }')
    // no answer, and a gateway's answer: «network»
    expect(confirm).toMatch(/if \(noClearAnswer\(res, data\)\) \{[\s\S]*?setLastFailure\(\{ kind: 'network' \}\)[\s\S]*?return/)
    expect(confirm).toMatch(/catch \{[\s\S]*?setLastFailure\(\{ kind: 'network' \}\)/)
    // every other answer that did not store it: what failureOf says
    expect(confirm).toContain('setLastFailure(failureOf(outcome))')
    expect(confirm.indexOf('setLastFailure(failureOf(outcome))')).toBeGreaterThan(confirm.indexOf("if (outcome.kind === 'done')"))
  })
})

describe('markup (server render, Spanish by default)', () => {
  const noop = () => {}
  const render = (request: LinkProfileRequest | null) =>
    renderToStaticMarkup(createElement(LinkProfileConfirm, { campaignId: 'c1', request, members, onClose: noop, onDone: noop }))
  const confirmButton = (html: string) => {
    const buttons = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? []
    return buttons.find(b => b.includes('Añadir como su perfil y guardar')) ?? ''
  }
  const body = { url: 'https://www.tiktok.com/@ale_ficticia/video/7695852671042964758' }

  it('renders nothing when closed', () => {
    expect(render(null)).toBe('')
  })

  it('one suggestion, verified: preselected and ready to confirm, no checkbox', () => {
    const html = render({ body, ...profileNotLinkedFrom(409, answer409)! })
    expect(html).toContain('¿De quién es esta publicación?')
    expect(html).toContain('Este contenido es de @ale_ficticia en TikTok. No está registrado como perfil de ninguna creadora de esta campaña.')
    expect(html).toContain('Es otro perfil de:')
    expect(html).toMatch(/<option value="ig-alez" selected="">@ale_ficticia · Instagram · mismo usuario en otra red<\/option>/)
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('No he podido comprobar')
    expect(confirmButton(html)).not.toBe('')
    expect(confirmButton(html)).not.toContain(' disabled=""')
    expect(html).toContain('>Cancelar</button>')
    // suggestion first, then the others
    expect(html.indexOf('value="ig-alez"')).toBeLessThan(html.indexOf('value="ig-sara"'))
    expect((html.match(/value="ig-alez"/g) ?? []).length).toBe(1)
  })

  it('several suggestions: nothing preselected, confirm disabled', () => {
    const html = render({
      body,
      author: { handle: 'ale_ficticia', platform: 'TIKTOK', verified: true },
      suggestions: [
        { influencerId: 'ig-sara', username: 'sara_inventada17', platform: 'INSTAGRAM', reason: 'selected' },
        { influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'same_handle' },
      ],
    })
    expect(html).toMatch(/<option value="" disabled="" selected="">Elige una creadora…<\/option>/)
    expect(confirmButton(html)).toContain(' disabled=""')
  })

  it('no suggestion: nothing preselected', () => {
    const html = render({ body, author: { handle: 'alguien', platform: 'INSTAGRAM', verified: true }, suggestions: [] })
    expect(html).toContain('Este contenido es de @alguien en Instagram.')
    expect(html).toMatch(/<option value="" disabled="" selected="">/)
    expect(confirmButton(html)).toContain(' disabled=""')
  })

  it('unverified: the extra line and the checkbox; confirm disabled even with one suggestion', () => {
    const html = render({
      body,
      author: { handle: 'ale_ficticia', platform: 'TIKTOK', verified: false },
      suggestions: [{ influencerId: 'ig-alez', username: 'ale_ficticia', platform: 'INSTAGRAM', reason: 'same_handle' }],
    })
    expect(html).toContain('No he podido comprobar el autor con la red. Confírmalo tú.')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Confirmo que es su perfil')
    expect(html).toMatch(/<option value="ig-alez" selected="">/)
    expect(confirmButton(html)).toContain(' disabled=""')
  })
})

describe('texts', () => {
  it('says which author is on screen now when it changed, in both languages', () => {
    for (const texts of [es, en]) {
      expect(texts.linkProfileAuthorChanged).toContain('@{author}')
      expect(texts.linkProfileAuthorChanged).toContain('{network}')
    }
    expect(es.linkProfileAuthorChanged).toBe('Al comprobarlo de nuevo, este contenido es de @{author} en {network}. Elige otra vez de quién es el perfil.')
  })

  it('no em-dash and the same placeholders in both languages', () => {
    const keys = Object.keys(es).filter(k => k.startsWith('linkProfile')) as Array<keyof typeof es>
    expect(keys.length).toBe(15)
    for (const k of keys) {
      const a = String(es[k]); const b = String(en[k])
      expect(a).not.toMatch(/[—–]/)
      expect(b).not.toMatch(/[—–]/)
      expect((a.match(/\{\w+\}/g) ?? []).sort()).toEqual((b.match(/\{\w+\}/g) ?? []).sort())
    }
  })
})
