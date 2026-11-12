import { describe, expect, it } from 'vitest'
import {
  OUTPUT_MAX_CHARS,
  contactKind,
  filterOutput,
  isEconomicsKey,
  isSecretKey,
  maskEmailsInText,
  redactSecretsInText,
  renderToolOutput,
  trimOutput,
} from '@/lib/mcp/output-filter'
import { INTERNAL_NOTICE } from '@/lib/mcp/tools/serializers'

/** Every key of a JSON value, at any depth, in lower case. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k.toLowerCase())
      keysOf(v, out)
    }
  }
  return out
}

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhYmMiLCJyb2xlIjoiQURNSU4ifQ.c2lnbmF0dXJlLW5vLWRlYmUtc2FsaXI'
const APIFY = 'apify_api_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
const META = 'EAA' + 'B'.repeat(60)

/** A creator, a membership and a contact as the platform's routes spread them. */
function platformAnswer() {
  return {
    item: {
      id: 'mem_1',
      status: 'CONTRACTED',
      agreedFee: 300,
      cost: 45.5,
      askingFee: 400,
      notes: 'Llamar el lunes',
      shippingName: 'DESTINATARIA-NO-DEBE-SALIR',
      shippingAddress1: 'Calle Inventada 123',
      shippingCity: 'Villainventada',
      shippingPostCode: '28001',
      shippingPhone: '+34600999888',
      shippingEmail: 'envios@correo-inventado.test',
      shippingProduct: 'Fregona',
      trackedLink: 'https://enlace.test/?utm=1',
      influencer: {
        id: 'inf_1',
        username: 'marta_fit',
        email: 'marta@correo-inventado.test',
        phone: '+34600111222',
        city: 'Villainventada',
        country: 'ES',
        standardFee: 7777.77,
        engagementRate: 3.2,
        followers: 50000,
        password: '$2b$12$HASH',
        user: { id: 'u1', passwordHash: 'x', resetToken: 'r', invitationToken: 'i' },
      },
    },
    contact: { id: 'c1', addressName: 'Marta', address1: 'Calle 1', address2: null, postCode: '28001', city: 'Madrid', country: 'ES', contactEmail: 'm@x.test' },
    campaign: { id: 'cmp', name: 'Campaña', budget: 65432.1, cpmReal: 12.3, emv: 9999, estimatedMediaValue: 1234, targetCpmMax: 20, clientReportedRevenue: 98765.4, paymentType: 'PAID', views: 1000, feedback: 'ok' },
    connection: { id: 'conn', accessToken: 'tok', refreshToken: 'ref', encryptedPageToken: 'enc', tokenExpiresAt: '2026-12-01T00:00:00.000Z', apiKey: 'k', key: 'secret-key', secret: 's', authorizationCode: 'c', fileData: 'base64...', shareToken: 'share', tokenHash: 'h' },
    keywords: ['fregona'],
    targetKeywords: ['superfregona'],
  }
}

describe('key classification', () => {
  it('secrets: tokens of every kind, passwords, keys, encrypted values', () => {
    for (const k of ['password', 'passwordHash', 'hashed_password', 'token', 'accessToken', 'refresh_token', 'inviteToken', 'invitationToken', 'shareToken', 'resetToken', 'pageAccessToken', 'apiKey', 'api_key', 'APIFY_API_KEY'.toLowerCase(), 'key', 'secret', 'clientSecret', 'webhookSecret', 'encryptedToken', 'encrypted_page_token', 'authorizationCode', 'fileData', 'tokenHash', 'codeHash', 'jwt', 'cookie', 'privateKey']) {
      expect(isSecretKey(k), k).toBe(true)
    }
    for (const k of ['tokenExpiresAt', 'keywords', 'targetKeywords', 'maxTokens', 'tokensUsed', 'monkey', 'keyMetric', 'description', 'id', 'name', 'codeChallenge']) {
      expect(isSecretKey(k), k).toBe(false)
    }
  })

  it('contact: e-mails, phones, every shipping field and postal addresses', () => {
    const cases: [string, string | null][] = [
      ['email', 'email'], ['contactEmail', 'email'], ['shippingEmail', 'email'], ['emails', 'email'], ['emailAddress', 'email'],
      ['phone', 'phone'], ['phoneNumber', 'phone'], ['whatsapp', 'phone'], ['mobile', 'phone'],
      ['shippingName', 'address'], ['shippingAddress1', 'address'], ['shippingProduct', 'address'], ['shipping_city', 'address'],
      ['address', 'address'], ['address1', 'address'], ['address2', 'address'], ['addressName', 'address'], ['postCode', 'address'],
      ['postalCode', 'address'], ['zip', 'address'], ['city', 'address'], ['savedAddress', 'address'],
      ['country', null], ['username', null], ['name', null], ['website', null], ['followers', null],
    ]
    for (const [k, kind] of cases) expect(contactKind(k), k).toBe(kind)
    // The country of an address is part of it; the country of a creator is not
    expect(contactKind('country', true)).toBe('address')
    expect(contactKind('region', true)).toBe('address')
  })

  it('economics: fees, costs, CPM, EMV, budgets, revenue, prices, spend', () => {
    for (const k of ['fee', 'agreedFee', 'standardFee', 'askingFee', 'fees', 'cost', 'productCost', 'costPerView', 'cpm', 'cpmReal', 'targetCpmMax', 'CPM', 'emv', 'totalEMV', 'EMVTotal', 'emvRates', 'estimatedMediaValue', 'budget', 'clientReportedRevenue', 'roi', 'manualROINotes', 'roas', 'price', 'priceRange', 'usd', 'spendUsd', 'agreed_fee']) {
      expect(isEconomicsKey(k), k).toBe(true)
    }
    for (const k of ['feedback', 'feed', 'coffee', 'paymentType', 'engagementRate', 'views', 'followers', 'costume', 'pieces', 'status', 'description']) {
      expect(isEconomicsKey(k), k).toBe(false)
    }
  })
})

describe('filterOutput', () => {
  it('removes every secret at any depth, whatever the flags say', () => {
    for (const flags of [{}, { includeContact: true, includeEconomics: true }]) {
      const { value, report } = filterOutput(platformAnswer(), flags)
      const keys = keysOf(value)
      for (const k of ['password', 'passwordhash', 'resettoken', 'invitationtoken', 'accesstoken', 'refreshtoken', 'encryptedpagetoken', 'apikey', 'key', 'secret', 'authorizationcode', 'filedata', 'sharetoken', 'tokenhash']) {
        expect(keys.has(k), k).toBe(false)
      }
      expect(keys.has('tokenexpiresat')).toBe(true)
      expect(keys.has('keywords') && keys.has('targetkeywords')).toBe(true)
      expect(report.secretsRemoved).toBeGreaterThanOrEqual(14)
    }
  })

  it('removes contact data by default and says whether it exists', () => {
    const { value, report } = filterOutput(platformAnswer())
    const v = value as any // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = JSON.stringify(value)
    for (const leaked of ['correo-inventado', '+34600', 'DESTINATARIA', 'Calle', '28001', 'Villainventada', 'Fregona', 'm@x.test']) expect(text, leaked).not.toContain(leaked)
    expect(report.contactRemoved).toBe(true)
    expect(v.item.hasEmail).toBe(true)
    expect(v.item.hasPhone).toBe(true)
    expect(v.item.hasAddress).toBe(true)
    expect(v.item.influencer.hasEmail).toBe(true)
    expect(v.item.influencer.hasPhone).toBe(true)
    // The creator's country stays; the country of the contact's address goes
    expect(v.item.influencer.country).toBe('ES')
    expect('country' in v.contact).toBe(false)
    expect(v.contact.hasAddress).toBe(true)
    expect(v.contact.hasEmail).toBe(true)
    expect(v.item.notes).toBe('Llamar el lunes')
    expect(v.item.trackedLink).toBe('https://enlace.test/?utm=1')
  })

  it('flags false when the removed field was empty', () => {
    const { value } = filterOutput({ email: null, phone: '', address1: '   ', name: 'x' })
    expect(value).toEqual({ name: 'x', hasEmail: false, hasPhone: false, hasAddress: false })
  })

  it('keeps contact data with includeContact', () => {
    const { value, report } = filterOutput(platformAnswer(), { includeContact: true })
    const text = JSON.stringify(value)
    for (const kept of ['marta@correo-inventado.test', '+34600111222', 'DESTINATARIA-NO-DEBE-SALIR', 'Calle Inventada 123', 'envios@correo-inventado.test']) expect(text).toContain(kept)
    expect(report.contactRemoved).toBe(false)
    expect(keysOf(value).has('hasemail')).toBe(false)
  })

  it('masks e-mail addresses inside free text unless includeContact', () => {
    const answer = { message: 'Invitación enviada a marta.fit+1@correo-inventado.test y a otra@x.co', handle: '@marta_fit' }
    expect(filterOutput(answer).value).toEqual({ message: 'Invitación enviada a [correo oculto] y a [correo oculto]', handle: '@marta_fit' })
    expect(filterOutput(answer, { includeContact: true }).value).toEqual(answer)
  })

  it('removes money figures by default and keeps them, reported as internal, with includeEconomics', () => {
    const plain = filterOutput(platformAnswer())
    const keys = keysOf(plain.value)
    for (const k of ['agreedfee', 'cost', 'askingfee', 'standardfee', 'budget', 'cpmreal', 'emv', 'estimatedmediavalue', 'targetcpmmax', 'clientreportedrevenue']) expect(keys.has(k), k).toBe(false)
    for (const k of ['paymenttype', 'views', 'feedback', 'engagementrate', 'followers']) expect(keys.has(k), k).toBe(true)
    expect(plain.report.economicsRemoved).toBe(true)
    expect(plain.report.economicsKept).toBe(false)

    const withMoney = filterOutput(platformAnswer(), { includeEconomics: true })
    expect((withMoney.value as { item: { agreedFee: number } }).item.agreedFee).toBe(300)
    expect(withMoney.report.economicsKept).toBe(true)
    expect(withMoney.report.economicsRemoved).toBe(false)
  })

  it('blanks credentials found inside text, wherever they are', () => {
    const answer = {
      detail: `Apify dijo: token ${APIFY} rechazado`,
      header: `Bearer ${JWT}`,
      session: JWT,
      meta: `page token ${META}`,
      url: 'https://api.apify.com/v2/acts?token=TOKEN-NO-DEBE-SALIR&x=1',
      url2: 'https://graph.facebook.com/me?access_token=ABC123SECRET',
      fine: 'eyJ no es un token',
    }
    const text = JSON.stringify(filterOutput(answer, { includeContact: true, includeEconomics: true }).value)
    for (const leaked of [APIFY, JWT, META, 'TOKEN-NO-DEBE-SALIR', 'ABC123SECRET']) expect(text).not.toContain(leaked)
    expect(text).toContain('?token=[oculto]&x=1')
    expect(text).toContain('eyJ no es un token')
    expect(redactSecretsInText('nada que ocultar')).toBe('nada que ocultar')
    expect(maskEmailsInText('sin correos @handle')).toBe('sin correos @handle')
  })

  it('makes any value JSON-safe and never modifies its input', () => {
    const input: Record<string, unknown> = {
      when: new Date('2026-11-12T10:00:00.000Z'),
      bad: new Date('nope'),
      nan: NaN,
      inf: Infinity,
      big: BigInt(42),
      undef: undefined,
      fn: () => 1,
      list: [1, undefined, () => 2],
      set: new Set(['a']),
      map: new Map([['k1', 1]]),
      decimal: { toJSON: () => '12.50' },
    }
    input.self = input
    const before = Object.keys(input).length
    const { value } = filterOutput(input)
    expect(value).toEqual({
      when: '2026-11-12T10:00:00.000Z',
      bad: null,
      nan: null,
      inf: null,
      big: '42',
      list: [1, null, null],
      set: ['a'],
      map: { k1: 1 },
      decimal: '12.50',
      self: '[referencia circular]',
    })
    expect(Object.keys(input).length).toBe(before)
    expect(input.when).toBeInstanceOf(Date)
  })

  it('drops the extra keys it is asked to drop', () => {
    const { value } = filterOutput({ id: 1, avatarUrl: 'x', thumbnail_url: 'y', nested: [{ AvatarURL: 'z', ok: 1 }] }, { dropKeys: ['avatarUrl', 'thumbnailUrl'] })
    expect(value).toEqual({ id: 1, nested: [{ ok: 1 }] })
  })
})

describe('trimOutput and renderToolOutput', () => {
  it('cuts long strings and long arrays, and says where', () => {
    const { value, report } = trimOutput({ text: 'a'.repeat(5000), items: Array.from({ length: 500 }, (_, i) => i) }, { maxStringChars: 100, maxArrayItems: 50 })
    const v = value as { text: string; items: number[] }
    expect(v.text.startsWith('a'.repeat(100))).toBe(true)
    expect(v.text).toContain('recortado: 4900')
    expect(v.items).toHaveLength(50)
    expect(report.arrays).toEqual([{ path: 'items', total: 500, returned: 50 }])
    expect(report.stringsCut).toBe(1)
  })

  it('halves the largest arrays until the answer fits, keeping the original totals', () => {
    const big = { campaigns: Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, media: Array.from({ length: 150 }, (_, j) => ({ id: `m${i}-${j}`, views: j })) })) }
    const { value, report } = trimOutput(big, { maxChars: 20_000 })
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(20_000)
    expect(report.partial).toBe(false)
    expect(report.arrays.length).toBeGreaterThan(0)
    for (const cut of report.arrays) expect(cut.returned).toBeLessThan(cut.total)
  })

  it('renders compact JSON of at most 60,000 characters by default, whatever comes in', () => {
    expect(OUTPUT_MAX_CHARS).toBe(60_000)
    const huge = { rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, email: `p${i}@correo-inventado.test`, fee: i, caption: 'x'.repeat(3000) })) }
    const text = renderToolOutput(huge)
    expect(text.length).toBeLessThanOrEqual(60_000)
    const parsed = JSON.parse(text)
    expect(text).not.toContain('correo-inventado')
    expect(Array.isArray(parsed._notes)).toBe(true)
    expect(parsed._notes.some((n: string) => n.includes('rows cut'))).toBe(true)
    expect(parsed._notes.some((n: string) => n.includes('includeContact'))).toBe(true)
    expect(parsed._notes.some((n: string) => n.includes('includeEconomics'))).toBe(true)
    // A single enormous string still fits
    const one = renderToolOutput('z'.repeat(1_000_000), { maxStringChars: 2_000_000 })
    expect(one.length).toBeLessThanOrEqual(60_000)
    expect(() => JSON.parse(one)).not.toThrow()
  })

  it('leaves a small clean answer as it is, and labels kept money as internal', () => {
    expect(renderToolOutput({ ok: true, updated: 3 })).toBe('{"ok":true,"updated":3}')
    expect(renderToolOutput([1, 2])).toBe('[1,2]')
    const withMoney = JSON.parse(renderToolOutput({ fee: 300 }, { includeEconomics: true }))
    expect(withMoney).toEqual({ fee: 300, _notes: [INTERNAL_NOTICE] })
    const wrapped = JSON.parse(renderToolOutput([{ email: 'a@b.co' }]))
    expect(wrapped).toEqual({ result: [{ hasEmail: true }], _notes: [expect.stringContaining('includeContact')] })
  })

  it('after a change, never tells the model to call again to see what was removed (fix of 12 Nov 2026)', () => {
    // A read: calling again with the flag is the way to see it
    const read = JSON.parse(renderToolOutput({ contactEmail: 'a@b.co', fee: 3 }))
    expect(read._notes.join(' ')).toContain('Call again with includeContact: true')
    expect(read._notes.join(' ')).toContain('Call again with includeEconomics: true')
    // A write that ran: calling again would make the change a second time
    const written = JSON.parse(renderToolOutput({ contactEmail: 'a@b.co', changes: { standardFee: { before: 300, after: 400 } } }, { afterWrite: true }))
    const notes = written._notes.join(' ')
    expect(notes).not.toMatch(/Call again/i)
    expect(notes).toContain('do NOT repeat this call')
    expect(notes).toContain('read tool or a platform_request GET with includeContact: true')
    expect(notes).toContain('read tool or a platform_request GET with includeEconomics: true')
    expect(written.hasEmail).toBe(true)
    expect(JSON.stringify(written)).not.toContain('300')
  })

  it('honours a smaller ceiling (the generic tool asks for 30,000)', () => {
    const text = renderToolOutput({ rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, label: 'y'.repeat(100) })) }, { maxChars: 30_000, maxArrayItems: 50 })
    expect(text.length).toBeLessThanOrEqual(30_000)
    expect(JSON.parse(text).rows).toHaveLength(50)
  })
})
