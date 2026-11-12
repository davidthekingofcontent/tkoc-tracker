/**
 * The output filter of the write layer of the MCP connector: what every write
 * tool (and the guarded generic tool) passes its answer through before Claude
 * sees it. The answers of the platform's own routes are spread rows (every
 * column of a creator, a membership, a contact), so here the rule is DENY BY
 * KEY NAME, at any depth, whatever the route returned:
 *
 *  - always removed: passwords and their hashes, tokens of any kind (session,
 *    access, refresh, invitation, share, page tokens), API keys, secrets, a
 *    key literally called `key`, anything whose name starts with `encrypted`,
 *    authorization codes and file contents. Values that look like a JWT, a
 *    bearer token, an Apify token or a Meta token are blanked wherever they are;
 *  - removed unless includeContact is true: e-mails, phones, every `shipping*`
 *    field and postal addresses (address lines, post code, city, and the
 *    country or region of an address). The object they were in gets
 *    `hasEmail`, `hasPhone` and `hasAddress` instead, so the model still knows
 *    whether the data exists. E-mail addresses inside free text are masked too;
 *  - removed unless includeEconomics is true: fees, costs, CPM, EMV, budgets,
 *    revenue, prices and spend. When they are kept, the answer says they are
 *    internal agency figures.
 *
 * Then the answer is trimmed: long strings and long arrays are cut, and the
 * whole JSON never exceeds `maxChars` (60,000 by default). Every cut is said
 * in `_notes`, with the path of each array that was shortened.
 *
 * Pure module: no database, no network. Safe to import from unit tests.
 */
import { INTERNAL_NOTICE } from './tools/serializers'

// ============ Limits ============

/** Longest answer of a write tool, in characters of JSON. */
export const OUTPUT_MAX_CHARS = 60_000
/** Longest array kept before the size pass (the generic tool passes 50). */
export const OUTPUT_MAX_ARRAY_ITEMS = 200
/** Longest string kept (the generic tool passes 1,000). */
export const OUTPUT_MAX_STRING_CHARS = 2_000
/** Deepest nesting walked. Deeper values are replaced by a marker. */
const MAX_DEPTH = 40
/** Room kept for the `_notes` of a trimmed answer. */
const NOTES_RESERVE_CHARS = 2_000

export interface OutputOptions {
  /** E-mails, phones and addresses stay in the answer. Default false. */
  includeContact?: boolean
  /** Fees, costs, CPM, EMV and other money figures stay in the answer. Default false. */
  includeEconomics?: boolean
  /** More keys to drop, compared normalised (case and punctuation ignored): `avatarUrl`, `thumbnailUrl`... */
  dropKeys?: readonly string[]
  /** Longest JSON answer. Default OUTPUT_MAX_CHARS. */
  maxChars?: number
  /** Longest array before the size pass. Default OUTPUT_MAX_ARRAY_ITEMS. */
  maxArrayItems?: number
  /** Longest string. Default OUTPUT_MAX_STRING_CHARS. */
  maxStringChars?: number
  /**
   * The answer is the result of a change that just ran. The notes about what
   * was removed then never say "call again": calling a write tool again makes
   * the change a second time. They point to a read instead.
   */
  afterWrite?: boolean
}

// ============ Key classification ============

/** A key in lower case with every character that is not a letter or a digit removed. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The words of a key: `agreedFee` → agreed, fee; `cost_per_view` → cost, per, view; `totalEMV` → total, emv. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const SECRET_EXACT = new Set([
  'password', 'passwords', 'passwordhash', 'hashedpassword', 'pass', 'pwd',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'sessiontoken',
  'apikey', 'apisecret', 'secret', 'secrets', 'clientsecret',
  'key', 'privatekey', 'secretkey', 'accesskey', 'signingkey', 'encryptionkey',
  'authorization', 'authorizationcode', 'authcode', 'cookie', 'cookies', 'jwt',
  'filedata', 'tokenhash', 'codehash', 'codeverifier', 'otp',
])
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'passwordhash', 'apikey', 'tokenhash', 'privatekey']
const SECRET_PREFIXES = ['encrypted', 'password']

/** Never returned, whatever the flags say. */
export function isSecretKey(key: string): boolean {
  const n = normalizeKey(key)
  if (!n) return false
  return SECRET_EXACT.has(n) || SECRET_SUFFIXES.some(s => n.endsWith(s)) || SECRET_PREFIXES.some(p => n.startsWith(p))
}

type ContactKind = 'email' | 'phone' | 'address'

const PHONE_EXACT = new Set(['mobile', 'telephone', 'tel', 'whatsapp', 'movil', 'telefono'])
const ADDRESS_EXACT = new Set([
  'address', 'addresses', 'address1', 'address2', 'address3', 'addressline1', 'addressline2', 'addressname',
  'street', 'streetaddress', 'postcode', 'postalcode', 'zip', 'zipcode', 'fulladdress', 'postaladdress', 'city',
])
/** Keys that make an object an address: its country and region are then part of the address. */
const ADDRESS_MARKERS = new Set(['address1', 'address2', 'addressline1', 'addressname', 'street', 'streetaddress', 'postcode', 'postalcode', 'zip', 'zipcode'])
const ADDRESS_CONTEXT_ONLY = new Set(['country', 'countrycode', 'region', 'province', 'recipient', 'recipientname'])

/**
 * Contact data, kept only with includeContact. `inAddress`: the key sits in an
 * object that is an address (it has address lines or a post code), so its
 * country and region belong to that address. Elsewhere `country` is the
 * country of a creator and stays.
 */
export function contactKind(key: string, inAddress = false): ContactKind | null {
  const n = normalizeKey(key)
  if (!n) return null
  if (n.endsWith('email') || n.endsWith('emails') || n.endsWith('emailaddress')) return 'email'
  if (n.endsWith('phone') || n.endsWith('phones') || n.endsWith('phonenumber') || PHONE_EXACT.has(n)) return 'phone'
  if (n.startsWith('shipping') || ADDRESS_EXACT.has(n) || n.endsWith('address') || n.endsWith('addresses')) return 'address'
  if (inAddress && ADDRESS_CONTEXT_ONLY.has(n)) return 'address'
  return null
}

const MONEY_WORDS = new Set([
  'fee', 'fees', 'cost', 'costs', 'cpm', 'cpms', 'cpe', 'cpv', 'cpc', 'emv', 'budget', 'budgets',
  'revenue', 'revenues', 'roi', 'roas', 'price', 'prices', 'usd', 'eur', 'euros', 'spend', 'spent',
  'margin', 'invoice', 'invoiced',
])

/** Money figures and estimates, kept only with includeEconomics. */
export function isEconomicsKey(key: string): boolean {
  const n = normalizeKey(key)
  if (!n) return false
  if (n.includes('mediavalue') || n.startsWith('emv')) return true
  return keyWords(key).some(w => MONEY_WORDS.has(w))
}

// ============ Values ============

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  // A JWT (the platform's own session tokens, Meta id tokens)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // An Authorization header value
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // An Apify token
  /\bapify_api_[A-Za-z0-9]{16,}/g,
  // A Meta (Facebook / Instagram) access token
  /\bEAA[A-Za-z0-9]{40,}/g,
  // A token or key passed in a URL
  /([?&](?:access_token|token|apikey|api_key|key|secret|code)=)[^&#\s"']+/gi,
]

/** Blanks every credential found in a text. */
export function redactSecretsInText(text: string): string {
  let out = text
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (match, prefix?: unknown) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[oculto]` : '[oculto]'))
  }
  return out
}

const isLocalChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45
const isDomainChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45
const DOMAIN_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

/**
 * Masks the e-mail addresses of a text (a note, an error message) when
 * contact data is not wanted. Linear in the length of the text: it works from
 * each `@` outwards instead of letting a regular expression retry every
 * position of a long run of letters (which is quadratic).
 */
export function maskEmailsInText(text: string): string {
  let at = text.indexOf('@')
  if (at === -1) return text
  let out = ''
  let copied = 0
  while (at !== -1) {
    let start = at
    while (start > copied && isLocalChar(text.charCodeAt(start - 1))) start--
    let end = at + 1
    while (end < text.length && isDomainChar(text.charCodeAt(end))) end++
    while (end > at + 1 && (text[end - 1] === '.' || text[end - 1] === '-')) end--
    if (start < at && DOMAIN_RE.test(text.slice(at + 1, end))) {
      out += `${text.slice(copied, start)}[correo oculto]`
      copied = end
      at = text.indexOf('@', end)
    } else {
      at = text.indexOf('@', at + 1)
    }
  }
  return out + text.slice(copied)
}

// ============ The filter ============

export interface FilterReport {
  /** Keys removed because they were secrets. */
  secretsRemoved: number
  /** Something of contact data was removed. */
  contactRemoved: boolean
  /** Some money figure was removed. */
  economicsRemoved: boolean
  /** Some money figure was KEPT (includeEconomics): the answer must say it is internal. */
  economicsKept: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.some(hasValue)
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasValue)
  return true
}

/**
 * Applies the deny-by-key rules to a value of any shape and returns a clean
 * copy (the input is never modified). Dates become ISO strings, `undefined`,
 * functions and symbols disappear, non-finite numbers become null, bigints
 * become strings and a value seen twice on the same branch (a cycle) becomes
 * a marker.
 */
export function filterOutput(value: unknown, options: OutputOptions = {}): { value: unknown; report: FilterReport } {
  const includeContact = options.includeContact === true
  const includeEconomics = options.includeEconomics === true
  const drop = new Set((options.dropKeys ?? []).map(normalizeKey))
  const report: FilterReport = { secretsRemoved: 0, contactRemoved: false, economicsRemoved: false, economicsKept: false }
  const onBranch = new WeakSet<object>()

  const cleanString = (s: string): string => {
    const out = redactSecretsInText(s)
    return includeContact ? out : maskEmailsInText(out)
  }

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null) return null
    switch (typeof v) {
      case 'string':
        return cleanString(v)
      case 'number':
        return Number.isFinite(v) ? v : null
      case 'boolean':
        return v
      case 'bigint':
        return v.toString()
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
    }
    if (depth >= MAX_DEPTH) return '[demasiado profundo]'
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
    // A value that knows its own JSON (Prisma's Decimal, for one)
    if (!Array.isArray(v) && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return walk((v as { toJSON: () => unknown }).toJSON(), depth + 1)
    }
    const obj = v as object
    if (onBranch.has(obj)) return '[referencia circular]'
    onBranch.add(obj)
    try {
      if (Array.isArray(obj)) {
        const out: unknown[] = []
        for (const item of obj) {
          const w = walk(item, depth + 1)
          out.push(w === undefined ? null : w)
        }
        return out
      }
      if (obj instanceof Map) return walk(Object.fromEntries(obj), depth)
      if (obj instanceof Set) return walk([...obj], depth)
      const source = isPlainObject(obj) ? obj : (Object.fromEntries(Object.entries(obj)) as Record<string, unknown>)
      const keys = Object.keys(source)
      const inAddress = keys.some(k => ADDRESS_MARKERS.has(normalizeKey(k)))
      const out: Record<string, unknown> = {}
      const found: Partial<Record<ContactKind, boolean>> = {}
      for (const key of keys) {
        const child = source[key]
        if (isSecretKey(key)) {
          report.secretsRemoved++
          continue
        }
        if (drop.has(normalizeKey(key))) continue
        const contact = contactKind(key, inAddress)
        if (contact && !includeContact) {
          report.contactRemoved = true
          found[contact] = (found[contact] ?? false) || hasValue(child)
          continue
        }
        if (isEconomicsKey(key)) {
          if (!includeEconomics) {
            report.economicsRemoved = true
            continue
          }
          if (hasValue(child)) report.economicsKept = true
        }
        const w = walk(child, depth + 1)
        if (w !== undefined) out[key] = w
      }
      // Whether the removed data exists, without the data
      const flags: [ContactKind, string][] = [['email', 'hasEmail'], ['phone', 'hasPhone'], ['address', 'hasAddress']]
      for (const [kind, flag] of flags) {
        if (found[kind] !== undefined && !(flag in out)) out[flag] = found[kind]
      }
      return out
    } finally {
      onBranch.delete(obj)
    }
  }

  return { value: walk(value, 0), report }
}

// ============ Trimming ============

export interface ArrayCut {
  /** Where the array was, as `campaigns[2].media`. `$` is the answer itself. */
  path: string
  total: number
  returned: number
}

export interface TrimReport {
  arrays: ArrayCut[]
  stringsCut: number
  /** Nothing could make it fit: only the start of the JSON is returned, as text. */
  partial: boolean
}

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? (parent === '$' ? key : `${parent}.${key}`) : `${parent}[${JSON.stringify(key)}]`
}

function cutString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [recortado: ${s.length - max} caracteres más]` : s
}

/**
 * Cuts strings longer than `maxStringChars` and arrays longer than
 * `maxArrayItems`, then halves the largest arrays until the JSON fits in
 * `maxChars` (minus room for the notes). The value must already be JSON-safe
 * (the output of filterOutput).
 */
export function trimOutput(value: unknown, options: OutputOptions = {}): { value: unknown; report: TrimReport } {
  const maxChars = Math.max(1_000, options.maxChars ?? OUTPUT_MAX_CHARS)
  const maxArray = Math.max(1, options.maxArrayItems ?? OUTPUT_MAX_ARRAY_ITEMS)
  const maxString = Math.max(20, options.maxStringChars ?? OUTPUT_MAX_STRING_CHARS)
  const budget = maxChars - NOTES_RESERVE_CHARS
  const report: TrimReport = { arrays: [], stringsCut: 0, partial: false }
  const cuts = new Map<string, ArrayCut>()

  const recordCut = (path: string, total: number, returned: number) => {
    const known = cuts.get(path)
    if (known) known.returned = returned
    else cuts.set(path, { path, total, returned })
  }

  // First pass: strings and arrays to their ceilings
  const first = (v: unknown, path: string): unknown => {
    if (typeof v === 'string') {
      if (v.length > maxString) report.stringsCut++
      return cutString(v, maxString)
    }
    if (Array.isArray(v)) {
      const kept = v.length > maxArray ? v.slice(0, maxArray) : v
      if (kept.length < v.length) recordCut(path, v.length, kept.length)
      return kept.map((item, i) => first(item, childPath(path, i)))
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = first(child, childPath(path, k))
      return out
    }
    return v
  }
  let current = first(value, '$')

  // Size pass: halve the largest array until it fits
  const size = (v: unknown) => JSON.stringify(v ?? null).length
  interface Candidate {
    path: string
    arr: unknown[]
    bytes: number
    replace(a: unknown[]): void
  }
  const largestArray = (root: unknown, replaceRoot: (a: unknown[]) => void): Candidate | null => {
    const found: Candidate[] = []
    const visit = (v: unknown, path: string, replace: (a: unknown[]) => void) => {
      if (Array.isArray(v)) {
        if (v.length > 1) found.push({ path, arr: v, bytes: size(v), replace })
        v.forEach((item, i) => visit(item, childPath(path, i), a => { v[i] = a }))
      } else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        for (const k of Object.keys(o)) visit(o[k], childPath(path, k), a => { o[k] = a })
      }
    }
    visit(root, '$', replaceRoot)
    return found.reduce<Candidate | null>((best, c) => (!best || c.bytes > best.bytes ? c : best), null)
  }
  for (let round = 0; round < 80 && size(current) > budget; round++) {
    const target = largestArray(current, a => { current = a })
    if (!target) break
    const keep = Math.max(1, Math.floor(target.arr.length / 2))
    recordCut(target.path, cuts.get(target.path)?.total ?? target.arr.length, keep)
    target.replace(target.arr.slice(0, keep))
  }

  // Still too large: every string down to 200 characters
  if (size(current) > budget) {
    const shorten = (v: unknown): unknown => {
      if (typeof v === 'string') {
        if (v.length > 200) report.stringsCut++
        return cutString(v, 200)
      }
      if (Array.isArray(v)) return v.map(shorten)
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = shorten(child)
        return out
      }
      return v
    }
    current = shorten(current)
  }

  // Nothing helped: the start of the JSON, as text
  if (size(current) > budget) {
    report.partial = true
    current = { partialJson: JSON.stringify(current).slice(0, Math.max(0, budget - 200)) }
  }

  report.arrays = [...cuts.values()]
  return { value: current, report }
}

// ============ The answer of a write tool ============

const CONTACT_NOTE =
  'Contact data (e-mails, phones, addresses) was removed; hasEmail, hasPhone and hasAddress say whether it exists. Call again with includeContact: true only if the person needs it.'
const ECONOMICS_NOTE =
  'Money figures (fees, costs, CPM, EMV, budgets) were removed. Call again with includeEconomics: true only if the person asks for them.'
/** After a change: calling the write tool again would make the change a second time. */
export const CONTACT_NOTE_AFTER_WRITE =
  'Contact data (e-mails, phones, addresses) was removed; hasEmail, hasPhone and hasAddress say whether it exists. The change is done: do NOT repeat this call to see them, it would make the change again. If the person needs them, read the record with a read tool or a platform_request GET with includeContact: true.'
export const ECONOMICS_NOTE_AFTER_WRITE =
  'Money figures (fees, costs, CPM, EMV, budgets) were removed. The change is done: do NOT repeat this call to see them, it would make the change again. If the person asks for them, read the record with a read tool or a platform_request GET with includeEconomics: true.'

/**
 * What a write tool returns to the model: filterOutput, then trimOutput, then
 * compact JSON of at most `maxChars` characters. Whatever was removed or cut
 * is explained in `_notes` (a plain object answer gets the key; anything else
 * is wrapped as `{ result, _notes }`).
 */
export function renderToolOutput(value: unknown, options: OutputOptions = {}): string {
  const maxChars = Math.max(1_000, options.maxChars ?? OUTPUT_MAX_CHARS)
  const filtered = filterOutput(value, options)
  const trimmed = trimOutput(filtered.value, options)

  const notes: string[] = []
  const afterWrite = options.afterWrite === true
  if (filtered.report.contactRemoved) notes.push(afterWrite ? CONTACT_NOTE_AFTER_WRITE : CONTACT_NOTE)
  if (filtered.report.economicsRemoved) notes.push(afterWrite ? ECONOMICS_NOTE_AFTER_WRITE : ECONOMICS_NOTE)
  if (filtered.report.economicsKept) notes.push(INTERNAL_NOTICE)
  for (const cut of trimmed.report.arrays.slice(0, 10)) {
    notes.push(`List ${cut.path} cut: showing ${cut.returned} of ${cut.total}. Ask for less (filters, a smaller page) to see the rest.`)
  }
  if (trimmed.report.arrays.length > 10) notes.push(`${trimmed.report.arrays.length - 10} more lists were cut as well.`)
  if (trimmed.report.stringsCut > 0) notes.push(`${trimmed.report.stringsCut} long texts were shortened.`)
  if (trimmed.report.partial) notes.push('The answer was too large: only its beginning is returned, as text.')

  let answer: unknown = trimmed.value
  if (notes.length > 0) {
    if (isPlainObject(answer)) {
      const existing = Array.isArray(answer._notes) ? (answer._notes as unknown[]) : []
      answer = { ...answer, _notes: [...existing, ...notes] }
    } else {
      answer = { result: answer, _notes: notes }
    }
  }
  const text = JSON.stringify(answer ?? null)
  if (text.length <= maxChars) return text
  // The notes themselves pushed it over (it cannot be much): last resort
  return JSON.stringify({ partialJson: text.slice(0, maxChars - 300), _notes: ['The answer was too large: only its beginning is returned, as text.'] })
}
