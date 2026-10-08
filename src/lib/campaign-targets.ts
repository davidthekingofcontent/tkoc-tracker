/**
 * BRAND-IDENTIFYING TARGETS — pure helpers (no I/O) shared by the campaign
 * create/update routes (validation) and the capture rule engine (rule 3).
 *
 * Why (doc item 5, 2026-10-08): campaign "10.- Vileda - Micros Octubre" had
 * targetAccounts ['@vileda.es'] and targetHashtags ['turbo', 'mopa', 'h2pro',
 * 'spin']. Those hashtags are GENERIC — any creator cleaning a sofa or raffling
 * wood oil writes #turbo or #mopa — so rule (3) of campaign-capture captured a
 * sofa-cleaning reel and a wood-oil giveaway into a Vileda campaign. The other
 * Vileda campaigns use 'vileda', 'viledaturbo', 'viledah2pro', 'viledapunch':
 * those carry the brand name and are fine.
 *
 * A hashtag is brand-identifying when its normalized form CONTAINS one of the
 * brand's stems, or when the tag itself (4+ characters) is a PREFIX of a stem
 * ('#vileda' for '@viledaespana', '#zara' for '@zarahome'). Stems come from
 * the target accounts — the squashed handle ('viledaes') plus its LEADING
 * segment ('@vileda.es' → 'vileda'); qualifiers after the brand name never
 * count ('@nike_spain' → 'nike', not 'spain') — and, when known, from the
 * brand name's words of 4+ letters ('PC Componentes' → 'componentes' and
 * 'pccomponentes'; 'Vileda España' → 'vileda', not 'españa'). Qualifier and
 * everyday words (NON_BRAND_WORDS) are never stems: '#españa', '#spain',
 * '#casa' or '#hola' are exactly the "any creator writes it" tags the rule
 * exists to stop. When no stem can be derived (no accounts, no brand name)
 * there is nothing to judge against and the hashtags are accepted as before.
 */

/** Shortest handle segment / brand-name word / prefix tag that counts as a stem. */
const MIN_SEGMENT_STEM_LENGTH = 4
/** Shortest squashed handle / brand name that counts as a stem ('@hp' → 'hp'). */
const MIN_FULL_STEM_LENGTH = 2
/**
 * Shortest leading segment that rule (3) derives SILENTLY from a qualified
 * handle (accountCoreStems). Stricter than validation on purpose: the PM never
 * sees this stem, so 4-letter everyday words ('casa', 'hola', 'moda', 'vida',
 * 'home', 'love') must not become a whole-word caption match. A 4-letter brand
 * with a qualified handle ('@nike_spain') is still matched through its exact
 * handle, its hashtags and its keywords — only the derived stem is skipped.
 */
const MIN_CORE_STEM_LENGTH = 5

/**
 * Words that never identify a brand on their own, even when they are the
 * leading segment of a target handle or a word of the brand name (normalized:
 * lowercase, no accents). Two families: qualifiers ('@nike_spain' → 'spain',
 * 'Vileda España' → 'espana') and everyday words that head many creator
 * handles ('@casa.decor' → 'casa', '@hola.com' → 'hola'). A safety net, not an
 * exhaustive dictionary — the length minimums do most of the work.
 */
const NON_BRAND_WORDS = new Set<string>([
  // qualifiers / regions / company words
  'espana', 'spain', 'iberia', 'europa', 'europe', 'latam', 'portugal', 'mexico', 'global',
  'internacional', 'international', 'oficial', 'official', 'grupo', 'group', 'store', 'shop',
  'tienda', 'online', 'brand', 'marca', 'team', 'club', 'real',
  // everyday words that head many handles
  'hola', 'casa', 'hogar', 'home', 'mama', 'papa', 'vida', 'life', 'moda', 'style', 'estilo',
  'amor', 'love', 'feliz', 'happy', 'buenos', 'buenas', 'mundo', 'world', 'cocina', 'comida',
  'food', 'salud', 'belleza', 'beauty', 'familia', 'family', 'viaje', 'viajes', 'travel',
  'fitness', 'deco', 'decor', 'blog', 'foto', 'fotos', 'photo', 'diario', 'daily', 'nueva',
  'nuevo', 'baby', 'bebe', 'kids', 'ninos', 'girl', 'chica', 'arte', 'ropa', 'yoga', 'cafe',
  'hair', 'skin', 'nails', 'makeup', 'look', 'looks', 'outfit', 'tips',
])

/** Lowercase, accents stripped, everything but [a-z0-9] removed. */
export function normalizeStem(value: string): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

function stripSigil(value: string): string {
  return (value || '').trim().replace(/^[@#]+/, '')
}

/** One handle per element: "@vileda.es @viledaturbo" typed together is two handles. */
function splitHandles(values: string[] | null | undefined): string[] {
  return (values || [])
    .flatMap(v => String(v ?? '').split(/[\s,]+/))
    .map(stripSigil)
    .filter(Boolean)
}

/** Lowercase, accents stripped, split into alphanumeric words (empties dropped). */
function alnumWords(text: string | null | undefined): string[] {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function isNumeric(s: string): boolean {
  return /^\d+$/.test(s)
}

/**
 * Leading segment of a QUALIFIED handle — the brand name before the first
 * dot/underscore/hyphen ('@vileda.es' → 'vileda', '@nike_spain' → 'nike',
 * '@loreal-paris' → 'loreal') — when it has at least `minLength` characters,
 * is not a number and is not a qualifier/everyday word (NON_BRAND_WORDS).
 * Null otherwise, and for a handle without separator ('@pccomponentes'): its
 * squashed form is the stem there. Only the LEAD segment: qualifiers follow
 * the brand name by convention, so '@vileda.limpieza' never yields 'limpieza'.
 */
function leadingSegment(handle: string, minLength: number): string | null {
  const segments = alnumWords(handle)
  if (segments.length < 2) return null
  const lead = segments[0]
  if (lead.length < minLength || isNumeric(lead) || NON_BRAND_WORDS.has(lead)) return null
  return lead
}

/**
 * Stems of ONE handle: the squashed handle ('viledaes') plus its leading
 * segment when the handle is qualified ('vileda'; see leadingSegment —
 * '@nike_spain' → 'nikespain', 'nike'; '@casa.decor' → 'casadecor' only).
 */
function handleStems(handle: string): string[] {
  const out: string[] = []
  const full = normalizeStem(handle)
  if (full.length >= MIN_FULL_STEM_LENGTH) out.push(full)
  const lead = leadingSegment(handle, MIN_SEGMENT_STEM_LENGTH)
  if (lead) out.push(lead)
  return out
}

/**
 * Lowercase alphanumeric stems that identify the brand of a campaign: from
 * the target accounts ('@vileda.es' → 'viledaes', 'vileda') and from the
 * brand name when known ('PC Componentes' → 'pccomponentes', 'componentes';
 * 'Vileda España' → 'viledaespana', 'vileda'). Words shorter than 4 letters,
 * numbers and qualifier/everyday words (NON_BRAND_WORDS) are skipped.
 * De-duplicated, in input order.
 */
export function brandStems(targetAccounts: string[], brandName?: string | null): string[] {
  const out = new Set<string>()
  for (const handle of splitHandles(targetAccounts)) {
    for (const stem of handleStems(handle)) out.add(stem)
  }
  if (brandName && brandName.trim()) {
    const full = normalizeStem(brandName)
    if (full.length >= MIN_FULL_STEM_LENGTH) out.add(full)
    for (const word of alnumWords(brandName)) {
      if (word.length >= MIN_SEGMENT_STEM_LENGTH && !isNumeric(word) && !NON_BRAND_WORDS.has(word)) out.add(word)
    }
  }
  return Array.from(out)
}

/**
 * The normalized tag CONTAINS any stem ('viledaturbo' ⊇ 'vileda' → true), or
 * the tag itself — 4+ characters, not a qualifier/everyday word — is a PREFIX
 * of a stem ('vileda' ⊂ 'viledaespana', 'zara' ⊂ 'zarahome', 'pccomp' ⊂
 * 'pccomponentes' → true): a brand whose only handle is concatenated can
 * still use its own name. 'turbo', 'mopa', 'h2pro', 'spin' against
 * ['viledaes', 'vileda'] → false; 'espana' against ['viledaespana', 'vileda']
 * → false (not contained, not a prefix, and a qualifier word anyway).
 */
export function isBrandIdentifyingHashtag(tag: string, stems: string[]): boolean {
  const normalized = normalizeStem(stripSigil(tag))
  if (!normalized) return false
  const valid = stems.filter(stem => stem.length > 0)
  if (valid.some(stem => normalized.includes(stem))) return true
  if (normalized.length < MIN_SEGMENT_STEM_LENGTH || NON_BRAND_WORDS.has(normalized)) return false
  return valid.some(stem => stem.startsWith(normalized))
}

/**
 * Splits the campaign's target hashtags into brand-identifying ones (`ok`) and
 * generic ones (`generic`). With no derivable stem (no accounts, no brand
 * name) every hashtag is `ok`: there is nothing to judge against.
 *
 *   validateTargetHashtags(['turbo','mopa','h2pro','spin'], ['@vileda.es'])
 *     → { ok: [], generic: ['turbo','mopa','h2pro','spin'] }
 *   validateTargetHashtags(['viledaturbo','viledah2pro'], ['@vileda.es'])
 *     → { ok: ['viledaturbo','viledah2pro'], generic: [] }
 */
export function validateTargetHashtags(
  hashtags: string[],
  targetAccounts: string[],
  brandName?: string | null
): { ok: string[]; generic: string[] } {
  const list = (hashtags || []).map(h => String(h ?? '').trim()).filter(Boolean)
  const stems = brandStems(targetAccounts, brandName)
  if (stems.length === 0) return { ok: list, generic: [] }
  const ok: string[] = []
  const generic: string[] = []
  for (const tag of list) (isBrandIdentifyingHashtag(tag, stems) ? ok : generic).push(tag)
  return { ok, generic }
}

/**
 * Spanish 400 message sent by POST /api/campaigns and PUT /api/campaigns/[id]
 * when `generic` is not empty. The offending hashtags are appended so the PM
 * sees which ones to change (the forms only display `error`).
 */
export const GENERIC_HASHTAGS_ERROR =
  'Los hashtags objetivo deben identificar a la marca: "turbo" o "mopa" capturarían contenido de cualquier creadora. Usa hashtags con el nombre de la marca (p. ej. #viledaturbo).'

export function genericHashtagsError(generic: string[]): string {
  const list = (generic || []).map(h => `#${stripSigil(h)}`).filter(h => h.length > 1)
  return list.length > 0 ? `${GENERIC_HASHTAGS_ERROR} Hashtags a revisar: ${list.join(', ')}.` : GENERIC_HASHTAGS_ERROR
}

// ---------------------------------------------------------------------------
// Rule (3) support — the brand NAME inside a qualified handle
// ---------------------------------------------------------------------------

/**
 * The brand name carried by a handle that has a qualifier after a separator:
 * '@vileda.es' → 'vileda', '@loreal-paris' → 'loreal', '@pccomponentes_es' →
 * 'pccomponentes'. Leading segment only, 5+ characters (MIN_CORE_STEM_LENGTH),
 * not a number, not a qualifier/everyday word (NON_BRAND_WORDS). Yields
 * nothing for a handle without separator ('@pccomponentes'), a short lead
 * ('@nike_spain', '@hp.espana', '@la.casa.de.ana') or an everyday lead
 * ('@hola.com', '@casa.decor', '@cocina.facil') — the full normalized handle,
 * the hashtags and the keywords are still matched by itemReferencesBrand
 * (campaign-capture), only the derived stem is skipped.
 *
 * Needed because the brand's TikTok handle rarely equals its Instagram one and
 * TikTok's mention extraction stops at the dot ('@vileda.es' → '@vileda'): a
 * creator writing "@vileda" or "Vileda" must still count as a brand reference
 * (doc item 6). Conservative on purpose: the stem is derived automatically,
 * the PM never sees it, so a generic word must not slip in — with 'casa' as a
 * stem every member post saying "nueva casa" would be captured and KEPT by
 * revalidate-media.
 */
export function accountCoreStems(targetAccounts: string[]): string[] {
  const out = new Set<string>()
  for (const handle of splitHandles(targetAccounts)) {
    const lead = leadingSegment(handle, MIN_CORE_STEM_LENGTH)
    if (lead) out.add(lead)
  }
  return Array.from(out)
}

/** Alphanumeric words of a caption as a Set, for whole-word stem matching. */
export function captionWords(caption: string | null | undefined): Set<string> {
  return new Set(alnumWords(caption))
}
