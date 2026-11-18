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

/** Where a product name that does not carry the brand goes (Nov 2026: #flectionsystem for the client Dorco). */
export const PRODUCT_KEYWORDS_POINTER =
  'Si es el nombre de un producto que no lleva la marca, escribe su nombre completo (p. ej. "Flection System") en "Palabras clave del producto".'

export function genericHashtagsError(generic: string[]): string {
  const list = (generic || []).map(h => `#${stripSigil(h)}`).filter(h => h.length > 1)
  const base = list.length > 0 ? `${GENERIC_HASHTAGS_ERROR} Hashtags a revisar: ${list.join(', ')}.` : GENERIC_HASHTAGS_ERROR
  return `${base} ${PRODUCT_KEYWORDS_POINTER}`
}

// ---------------------------------------------------------------------------
// Product keywords — the third kind of brand target
// ---------------------------------------------------------------------------

/** Most product keywords a campaign may hold. */
export const MAX_TARGET_KEYWORDS = 10
/** Shortest keyword (letters/digits once squashed). */
const MIN_KEYWORD_LENGTH = 4
/** A ONE-word keyword shorter than this must carry the brand's name ('dorco' for Dorco; never 'turbo', 'spin', 'h2pro'). */
const MIN_SINGLE_WORD_KEYWORD_LENGTH = 6
const MAX_KEYWORD_CHARS = 60

/**
 * Generic product / marketing words (normalized): alone, or combined only with
 * each other and with everyday words, they are not a product's name. These are
 * exactly the words the brand-identifying hashtag rule exists to stop
 * ('turbo', 'mopa' — doc item 5, Oct 2026): a refused hashtag must not become
 * a keyword. A safety net, not a dictionary.
 */
const GENERIC_KEYWORD_WORDS = new Set<string>([
  'mopa', 'turbo', 'spin', 'crema', 'gel', 'serum', 'champu', 'perfume', 'maquillaje', 'skincare',
  'maquinilla', 'cuchilla', 'cuchillas', 'afeitado', 'limpieza', 'limpiar', 'producto', 'productos',
  'sorteo', 'promo', 'promocion', 'oferta', 'ofertas', 'gratis', 'regalo', 'regalos', 'descuento',
  'descuentos', 'codigo', 'rebajas', 'precio', 'barato', 'compra', 'compras', 'publi', 'publicidad',
  'colaboracion', 'novedad', 'novedades', 'review', 'resena', 'unboxing', 'haul', 'tutorial', 'rutina',
  'receta', 'recetas', 'verano', 'invierno', 'navidad', 'black', 'friday', 'nuevos', 'nuevas', 'mejor',
  'mejores', 'favorito', 'favoritos', 'calidad', 'original', 'premium', 'plus', 'super', 'mega', 'mini',
  'maxi', 'pack', 'system', 'sistema', 'para', 'como', 'esta', 'este', 'todo', 'todos', 'todas', 'desde',
  'hasta', 'sobre', 'entre', 'with', 'from', 'this', 'that', 'your',
])

/**
 * Canonical stored form of the product keywords: one phrase per element
 * (split on commas / semicolons / line breaks, NEVER on spaces — "flection
 * system" is one keyword), no leading @/#, inner spaces collapsed, lowercase,
 * de-duplicated, empties dropped. Anything that is not a string or an array of
 * strings yields [].
 */
export function normalizeKeywords(values: unknown): string[] {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : []
  const out = new Set<string>()
  for (const value of list) {
    if (typeof value !== 'string') continue
    // Also split before a sigil: "#flectionsystem #deliplus" pasted from the
    // hashtags field is two keywords, not one that never matches.
    for (const part of value.split(/[,;\n]+|\s+(?=[#@])/)) {
      const clean = part.trim().replace(/^[@#]+/, '').replace(/[@#]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
      if (clean) out.add(clean)
    }
  }
  return Array.from(out)
}

/**
 * A product keyword is the product's NAME ("Flection System"), not a generic
 * word. It does not have to carry the brand (that is its whole point), but it
 * has the same capture surface as a target hashtag — every post of the
 * campaign's creators inside the dates — so it is refused when:
 *   - it has fewer than 4 letters/digits once squashed, is a number, or is longer than a phrase;
 *   - every one of its words is short (< 4), a number, or an everyday/generic
 *     word ('nueva casa', 'mopa', 'turbo', 'sorteo');
 *   - it is ONE word of fewer than 6 letters that does not contain a brand stem
 *     ('dorco' is fine for the brand Dorco; 'spin' or 'h2pro' never are).
 * `stems` are the campaign's brand stems (brandStems of its accounts and brand name).
 */
export function validateKeywords(keywords: string[], stems: string[] = []): { ok: string[]; invalid: string[] } {
  const brand = (stems || []).filter(s => s.length >= 3)
  const weak = (word: string) =>
    word.length < MIN_KEYWORD_LENGTH || isNumeric(word) || isGenericWord(word)
  const ok: string[] = []
  const invalid: string[] = []
  for (const keyword of keywords || []) {
    const stem = normalizeStem(keyword)
    const words = alnumWords(keyword)
    const carriesBrand = brand.some(s => stem.includes(s))
    const bad =
      stem.length < MIN_KEYWORD_LENGTH ||
      keyword.length > MAX_KEYWORD_CHARS ||
      isNumeric(stem) ||
      // the words as typed ('black friday') AND the same thing glued, the way a
      // refused hashtag arrives ('blackfriday', 'sorteo2026'): both are generic
      (!carriesBrand && (weak(stem) || words.every(weak) || isGluedGenericWords(stem))) ||
      (words.length === 1 && stem.length < MIN_SINGLE_WORD_KEYWORD_LENGTH && !carriesBrand)
    ;(bad ? invalid : ok).push(keyword)
  }
  return { ok, invalid }
}

/** An everyday/generic word, also in plural ('cremas', 'sorteos', 'reviews'). */
function isGenericWord(word: string): boolean {
  const known = (w: string) => NON_BRAND_WORDS.has(w) || GENERIC_KEYWORD_WORDS.has(w)
  if (known(word)) return true
  if (word.endsWith('es') && known(word.slice(0, -2))) return true
  return word.endsWith('s') && known(word.slice(0, -1))
}

/**
 * True when the squashed keyword is nothing but generic words (and numbers)
 * written together: 'blackfriday', 'nuevacasa', 'sorteonavidad', 'sorteo2026'.
 * Only dictionary words and digit runs are pieces — never arbitrary scraps —
 * so 'flectionsystem' ('flection' is not a generic word) is not one.
 */
function isGluedGenericWords(stem: string): boolean {
  const n = stem.length
  const reachable = new Array<boolean>(n + 1).fill(false)
  reachable[0] = true
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue
    for (let j = i + 1; j <= n; j++) {
      const piece = stem.slice(i, j)
      if (isNumeric(piece) || (piece.length >= 3 && isGenericWord(piece))) reachable[j] = true
    }
  }
  return reachable[n]
}

export const TOO_MANY_KEYWORDS_ERROR = `Como máximo ${MAX_TARGET_KEYWORDS} palabras clave del producto.`

export function keywordsError(invalid: string[]): string {
  const list = (invalid || []).map(k => `"${k}"`).join(', ')
  return `Las palabras clave del producto deben ser el nombre completo del producto, no una palabra genérica o muy corta: "mopa", "turbo" o "nuevo" capturarían cualquier contenido, y una sola palabra de menos de 6 letras solo vale si lleva el nombre de la marca. Ejemplo: "Flection System".${list ? ` Palabras a revisar: ${list}.` : ''}`
}

/** The keywords as rule (3) searches them: squashed alphanumeric needles ('flection system' → 'flectionsystem'). */
export function keywordNeedles(keywords: string[] | null | undefined): string[] {
  const out = new Set<string>()
  for (const keyword of keywords || []) {
    const stem = normalizeStem(String(keyword ?? ''))
    if (stem.length >= MIN_KEYWORD_LENGTH) out.add(stem)
  }
  return Array.from(out)
}

// ---------------------------------------------------------------------------
// Brand accounts are the BRAND's — never a creator of the campaign
// ---------------------------------------------------------------------------

/** How a target account and a creator handle are compared: no @/#, lowercase (handles are case-insensitive). */
export function handleKey(handle: string | null | undefined): string {
  return stripSigil(String(handle ?? '')).toLowerCase()
}

/**
 * Is `handle` one of the campaign's "Cuentas de Marca Objetivo"? Exact handle,
 * any casing, with or without @ ("@vileda.es @viledaturbo" typed together is
 * two accounts). Nov 2026: the brand's own account must never be registered as
 * a profile of a creator, or every publication of the brand would be credited
 * to her (src/app/api/campaigns/[id]/media/manual, src/lib/tiktok-autolink.ts).
 */
export function isBrandAccount(targetAccounts: string[] | null | undefined, handle: string | null | undefined): boolean {
  const key = handleKey(handle)
  return !!key && splitHandles(targetAccounts).some(account => account.toLowerCase() === key)
}

/**
 * Splits the target accounts into the brand's (`brand`) and those that are in
 * fact creators of the campaign (`members`). Nov 2026: a PM typed the 28
 * creators of a campaign into "Cuentas de Marca Objetivo"; every creator's own
 * @mention then counted as a brand reference and unrelated posts were captured.
 */
export function splitMemberAccounts(
  targetAccounts: string[] | null | undefined,
  memberHandles: Array<string | null | undefined>,
  brandName?: string | null,
  campaignName?: string | null
): { brand: string[]; members: string[] } {
  const memberKeys = new Set(memberHandles.map(handleKey).filter(Boolean))
  // An account that carries the brand's name IS the brand, even when the
  // brand's own account was also added as a creator (its posts enter the
  // campaign that way): never take it for a creator. The name comes from the
  // attached brand and, since many campaigns have none attached, from the
  // campaign's own name ('11.- Vileda - Micros Noviembre' → 'vileda').
  const longStems = new Set(brandStems([], brandName).filter(s => s.length >= MIN_SEGMENT_STEM_LENGTH))
  for (const word of alnumWords(campaignName)) {
    if (word.length >= MIN_SEGMENT_STEM_LENGTH && !isNumeric(word) && !NON_BRAND_WORDS.has(word) && !CAMPAIGN_NAME_WORDS.has(word)) longStems.add(word)
  }
  // A short brand name ('HP', 'NYX', 'BMW') only counts at the START of the handle
  const shortStem = normalizeStem(brandName || '')
  const brand: string[] = []
  const members: string[] = []
  for (const account of splitHandles(targetAccounts)) {
    const stem = normalizeStem(account)
    const isBrand =
      Array.from(longStems).some(s => stem.includes(s)) ||
      (shortStem.length >= MIN_FULL_STEM_LENGTH && shortStem.length < MIN_SEGMENT_STEM_LENGTH && stem.startsWith(shortStem))
    ;(!isBrand && memberKeys.has(account.toLowerCase()) ? members : brand).push(account)
  }
  return { brand, members }
}

/** Words of a campaign's name that say nothing about its brand (months, tiers, admin words). */
const CAMPAIGN_NAME_WORDS = new Set<string>([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
  'noviembre', 'diciembre', 'micros', 'macros', 'micro', 'macro', 'nanos', 'campana', 'campaign',
  'influencers', 'influencer', 'creadores', 'creadoras', 'seleccion', 'contratos', 'anuales', 'anual',
  'prueba', 'test', 'lanzamiento', 'navidad', 'verano', 'invierno', 'primavera', 'otono', 'black', 'friday',
])

export function memberAccountsError(members: string[]): string {
  const list = (members || []).map(m => `@${stripSigil(m)}`).join(', ')
  return `Las Cuentas de Marca Objetivo son las cuentas de la MARCA, no las de los creadores: los creadores se añaden en la pestaña Elegir.${list ? ` Cuentas a quitar: ${list}.` : ''}`
}

// ---------------------------------------------------------------------------
// Brand accounts are ACCOUNTS of the brand — never a product word
// ---------------------------------------------------------------------------

/**
 * Why (weekly review, 16 Nov 2026): «12.- Micros Diciembre» was created with
 * targetAccounts ['vileda.es', 'turbo', 'infinityflex']. Hashtags and product
 * keywords are judged (validateTargetHashtags, validateKeywords) but the
 * accounts were only compared with the creators' handles (splitMemberAccounts),
 * so two product words entered as ACCOUNTS: rule (3) would have taken every
 * member caption containing "turbo" for a brand reference, and the daily cron
 * would have read the tagged posts of the Instagram accounts @turbo and
 * @infinityflex. Same pattern as the generic hashtags of October.
 *
 * An account is refused when:
 *   (a) it is a generic word — 'turbo', 'mopa', 'turbos', 'turbo.es',
 *       'turbomopa', 'sorteo2026': a word of NON_BRAND_WORDS /
 *       GENERIC_KEYWORD_WORDS (plural included), several of them glued, a
 *       number, or a handle whose every word of 3+ letters is one — unless it
 *       carries a stem of the brand ('@turbo' is fine for a brand named Turbo);
 *   (b) the campaign has a brand ATTACHED (Setting campaign_brand_<id>) and the
 *       account carries none of the brand's stems nor a brand word of the
 *       campaign's name, and is not the brand's connected Instagram (Setting
 *       brand_ig_<brandId>): 'infinityflex' in a Vileda campaign, '@deliplus'
 *       in a Dorco campaign named 'Dorco - Diciembre'.
 * Without an attached brand, (b) is skipped: an account that is not a generic
 * word is accepted as before. The campaign's name alone never triggers (b)
 * (review of 18 Nov 2026: the code cannot tell a brand word from any other
 * word, so 'Lanzamiento Infinity Flex', 'Reto 30 días', 'Embajadoras 2027' or
 * 'Hogar brillante' refused @vileda.es, and 'Dorco - Delyplus' refused the
 * distributor @deliplus over one letter); its words only ADD stems that let an
 * account through.
 *
 * Escape routes, visible on purpose (no hidden bypass): a legitimate handle
 * that IS a common word passes once the campaign has its brand attached (the
 * brand's name becomes a stem; the brand is chosen when the campaign is
 * created from "Nueva Campaña", not in the wizard nor in "Editar Campaña");
 * the account of a distributor or of a product line with another name
 * ('@deliplus' for Dorco) passes when that name is in the campaign's name
 * ('Dorco x Deliplus'; one letter off, 'Delyplus', still counts) or when it is
 * the brand's connected Instagram. The product's words themselves go to
 * "Palabras clave del producto". The campaign's own name never whitelists a
 * generic word ('Micros Turbo Diciembre' does not make '@turbo' an account):
 * only the attached brand does.
 */
export interface TargetAccountsContext {
  /** Name of the brand attached to the campaign, when any. */
  brandName?: string | null
  /** The campaign's name: its brand words count as stems ('11.- Vileda - Micros Noviembre' → 'vileda'). */
  campaignName?: string | null
  /** Instagram accounts the brand connected through Meta (Setting brand_ig_<brandId>): accepted as they are. */
  connectedAccounts?: ReadonlyArray<string> | null
}

/**
 * Stems the brand accounts are judged against: the attached brand's name
 * (brandStems) and the brand words of the campaign's name — 4+ letters, not a
 * number, not an everyday/qualifier word, not a month/tier/admin word and not
 * a generic product word. Never the accounts themselves (that would be circular).
 */
export function campaignBrandStems(brandName?: string | null, campaignName?: string | null): string[] {
  const out = new Set<string>(brandStems([], brandName))
  for (const word of alnumWords(campaignName)) {
    if (word.length >= MIN_SEGMENT_STEM_LENGTH && !isNumeric(word) && !CAMPAIGN_NAME_WORDS.has(word) && !isGenericWord(word)) out.add(word)
  }
  return Array.from(out)
}

/** From this length a stem and a handle word one letter apart are the same name ('delyplus' / 'deliplus'). */
const MIN_NEAR_MATCH_LENGTH = 6

/** Levenshtein distance ≤ 1 (one letter changed, added or removed), in one pass. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else {
      i++
      j++
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/**
 * The handle carries a stem: its normalized form CONTAINS a stem of 4+
 * characters ('viledaes' ⊇ 'vileda'), it is itself a 4+ character prefix of
 * one ('pccomp' ⊂ 'pccomponentes'; never an everyday word), it STARTS with a
 * short brand name ('hp.espana' for HP; 'shop' is not HP), or one of its words
 * of 6+ letters is one letter away from a stem of 6+ letters ('deliplus' for
 * a campaign named 'Dorco - Delyplus': a misspelt distributor is still the
 * distributor).
 */
function carriesStem(account: string, stems: string[]): boolean {
  const normalized = normalizeStem(account)
  if (!normalized) return false
  const words = [normalized, ...alnumWords(account)].filter(w => w.length >= MIN_NEAR_MATCH_LENGTH && !NON_BRAND_WORDS.has(w))
  for (const stem of stems) {
    if (!stem) continue
    if (stem.length < MIN_SEGMENT_STEM_LENGTH) {
      if (normalized.startsWith(stem)) return true
      continue
    }
    if (normalized.includes(stem)) return true
    if (normalized.length >= MIN_SEGMENT_STEM_LENGTH && !NON_BRAND_WORDS.has(normalized) && stem.startsWith(normalized)) return true
    if (stem.length >= MIN_NEAR_MATCH_LENGTH && words.some(w => withinOneEdit(w, stem))) return true
  }
  return false
}

/**
 * A handle that is a generic word rather than an account: 'turbo', 'turbos',
 * 'turbomopa', 'sorteo2026', '2026', and 'turbo.es' / 'mopa_2026' (every word
 * of 3+ letters is generic; shorter scraps and numbers do not decide, so '@hp'
 * and '@a1' are handles).
 */
function isGenericAccount(account: string): boolean {
  const stem = normalizeStem(account)
  if (!stem) return false
  if (isNumeric(stem) || isGenericWord(stem) || isGluedGenericWords(stem)) return true
  const significant = alnumWords(account).filter(word => word.length >= 3 && !isNumeric(word))
  return significant.length > 0 && significant.every(isGenericWord)
}

/**
 * Splits the campaign's brand accounts into accepted ones (`ok`), generic
 * words (`generic`, rule a) and handles that do not carry the brand
 * (`notBrand`, rule b; empty when no brand is attached). One handle per
 * element, no @ (splitHandles): "@vileda.es @turbo" is two.
 *
 *   validateTargetAccounts(['vileda.es', 'turbo', 'infinityflex'], { brandName: 'Vileda España' })
 *     → { ok: ['vileda.es'], generic: ['turbo'], notBrand: ['infinityflex'] }
 *   validateTargetAccounts(['infinityflex'], {})            → { ok: ['infinityflex'], generic: [], notBrand: [] }
 *   validateTargetAccounts(['turbo'], {})                   → { ok: [], generic: ['turbo'], notBrand: [] }
 *   validateTargetAccounts(['turbo'], { brandName: 'Turbo' }) → { ok: ['turbo'], generic: [], notBrand: [] }
 *   validateTargetAccounts(['vileda.es'], { campaignName: 'Hogar brillante' }) → { ok: ['vileda.es'], generic: [], notBrand: [] }
 *   validateTargetAccounts(['deliplus'], { brandName: 'Dorco', campaignName: 'Dorco - Delyplus' }) → ok ['deliplus']
 */
export function validateTargetAccounts(
  accounts: string[] | null | undefined,
  ctx: TargetAccountsContext = {}
): { ok: string[]; generic: string[]; notBrand: string[] } {
  // Rule (b) needs an attached brand; the campaign's name only adds stems that let an account through
  const judgesBrand = brandStems([], ctx.brandName).length > 0
  const stems = campaignBrandStems(ctx.brandName, ctx.campaignName)
  const connected = new Set(splitHandles(ctx.connectedAccounts ? Array.from(ctx.connectedAccounts) : []).map(a => a.toLowerCase()))
  const ok: string[] = []
  const generic: string[] = []
  const notBrand: string[] = []
  for (const account of splitHandles(accounts)) {
    if (connected.has(account.toLowerCase()) || carriesStem(account, stems)) {
      ok.push(account)
    } else if (isGenericAccount(account)) {
      generic.push(account)
    } else if (judgesBrand) {
      notBrand.push(account)
    } else {
      ok.push(account)
    }
  }
  return { ok, generic, notBrand }
}

export const GENERIC_ACCOUNTS_ERROR =
  'Las Cuentas de Marca Objetivo son cuentas reales de la marca, no palabras: "turbo" o "mopa" harían pasar por contenido de la campaña cualquier publicación que las mencione.'
export const ACCOUNTS_NOT_BRAND_ERROR =
  'Las Cuentas de Marca Objetivo deben llevar el nombre de la marca de la campaña (p. ej. @vileda.es para Vileda).'
/** The sentence agreed on 17 Nov 2026: where the product's words go and what this field is for. */
export const ACCOUNTS_POINTER =
  'Pon las palabras del producto en Palabras clave del producto; aquí van solo las cuentas de la marca o del distribuidor.'
// The brand of a campaign is chosen when it is created from "Nueva Campaña"
// (the wizard and "Editar Campaña" have no brand field, and the platform has no
// way to change a campaign's brand later): the escape says so instead of
// promising a step that does not exist (review of 18 Nov 2026).
const GENERIC_ACCOUNTS_ESCAPE =
  'Si de verdad es el usuario de la marca, la campaña necesita tener asignada la marca con ese nombre: se elige al crear la campaña desde Campañas, "Nueva Campaña" (el Asistente y "Editar Campaña" no asignan marca). Con la marca asignada, vuelve a guardar.'
const ACCOUNTS_NOT_BRAND_ESCAPE =
  'Si es la cuenta del distribuidor o de un producto con otro nombre, pon ese nombre en el nombre de la campaña (p. ej. «Dorco x Deliplus») y vuelve a guardar.'

/**
 * Spanish 400 message of POST /api/campaigns and PUT /api/campaigns/[id] when
 * validateTargetAccounts refuses something: the refused handles are named (the
 * forms only display `error`), then the pointer and the escape route of each rule.
 */
export function targetAccountsError(generic: string[], notBrand: string[]): string {
  const list = (items: string[]) => (items || []).map(a => `@${stripSigil(a)}`).filter(a => a.length > 1).join(', ')
  const parts: string[] = []
  if ((generic || []).length > 0) parts.push(`${GENERIC_ACCOUNTS_ERROR} Cuentas a revisar: ${list(generic)}.`)
  if ((notBrand || []).length > 0) parts.push(`${ACCOUNTS_NOT_BRAND_ERROR} Cuentas a revisar: ${list(notBrand)}.`)
  parts.push(ACCOUNTS_POINTER)
  if ((generic || []).length > 0) parts.push(GENERIC_ACCOUNTS_ESCAPE)
  if ((notBrand || []).length > 0) parts.push(ACCOUNTS_NOT_BRAND_ESCAPE)
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// What the PM typed in the target fields (wizard, edit modal, new campaign page)
// ---------------------------------------------------------------------------

export interface TypedTargets {
  /** '@x' tokens, without the @ */
  accounts: string[]
  /** '#x' tokens, without the # */
  hashtags: string[]
  /** tokens with neither sigil, as typed */
  bare: string[]
}

/** Tokens of a free-text targets field: split on commas, semicolons, line breaks and spaces. */
function typedTokens(text: string | ReadonlyArray<string> | null | undefined): string[] {
  const list = Array.isArray(text) ? text : [text ?? '']
  return list.flatMap(v => String(v ?? '').split(/[\s,;]+/)).map(t => t.trim()).filter(Boolean)
}

const hasSigil = (token: string) => token.startsWith('@') || token.startsWith('#')

/**
 * Classifies what the PM typed: '@x' is an account and '#x' a hashtag,
 * whichever field it was typed in; a token with neither sigil is `bare`. In
 * the accounts field a bare token is ambiguous — 'vileda.es' is an account
 * without its @, 'turbo' is a product word (16 Nov 2026) — so the screens ask
 * the PM which it is before sending (markBareAsAccounts / moveBareToKeywords)
 * instead of guessing or dropping it in silence. De-duplicated, input order.
 */
export function classifyTypedTargets(text: string | ReadonlyArray<string> | null | undefined): TypedTargets {
  const accounts = new Set<string>()
  const hashtags = new Set<string>()
  const bare = new Set<string>()
  for (const token of typedTokens(text)) {
    const clean = stripSigil(token)
    if (token.startsWith('@')) {
      if (clean) accounts.add(clean)
    } else if (token.startsWith('#')) {
      if (clean) hashtags.add(clean)
    } else {
      bare.add(token)
    }
  }
  return { accounts: Array.from(accounts), hashtags: Array.from(hashtags), bare: Array.from(bare) }
}

/**
 * The two free-text fields of the wizard and the edit modal, read together: a
 * bare token in the HASHTAGS field is a hashtag (the # has always been
 * optional there); a bare token in the ACCOUNTS field is `bare` and holds the
 * save until the PM says what it is. A sigil wins over the field it is in.
 */
export function readTargetFields(accountsText: string, hashtagsText: string): TypedTargets {
  const a = classifyTypedTargets(accountsText)
  const h = classifyTypedTargets(hashtagsText)
  return {
    accounts: Array.from(new Set([...a.accounts, ...h.accounts])),
    hashtags: Array.from(new Set([...h.hashtags, ...h.bare.map(stripSigil).filter(Boolean), ...a.hashtags])),
    bare: a.bare,
  }
}

/** The accounts field with an @ in front of every bare token: the PM said they are accounts. */
export function markBareAsAccounts(accountsText: string): string {
  return typedTokens(accountsText).map(token => (hasSigil(token) ? token : `@${token}`)).join(', ')
}

/**
 * The bare tokens leave the accounts field and join the product keywords field
 * (comma separated, one keyword each, no repeats): the PM said they are words
 * of the product. The server then judges them as keywords ("turbo" alone is
 * still refused there, with the pointer to write the product's full name).
 */
export function moveBareToKeywords(accountsText: string, keywordsText: string): { accounts: string; keywords: string } {
  const tokens = typedTokens(accountsText)
  const keywords: string[] = []
  const seen = new Set<string>()
  const add = (value: string) => {
    const clean = value.trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) return
    seen.add(key)
    keywords.push(clean)
  }
  for (const part of (keywordsText || '').split(/[,;\n]+/)) add(part)
  for (const token of tokens) if (!hasSigil(token)) add(token)
  return { accounts: tokens.filter(hasSigil).join(', '), keywords: keywords.join(', ') }
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

/** Lowercase alphanumeric tokens of a text, in order (accents stripped). */
export function textTokens(text: string | null | undefined): string[] {
  return alnumWords(text)
}

/**
 * Whole-word search of `needle` (squashed alphanumeric, see normalizeStem) in
 * a token list. It matches when the needle lies inside ONE token
 * ('limpiezaconvileda' ⊇ 'vileda') or starts at the beginning of a token and
 * runs over the following ones ('pc' 'componentes' ⊇ 'pccomponentes';
 * 'flection' 'system' ⊇ 'flectionsystem'; 'vileda' 'turbosmart' ⊇
 * 'viledaturbo'). A needle that would start in the MIDDLE of a word and end in
 * the next one is not a match: with the spaces simply removed (as rule 3 did
 * until Nov 2026) "jugador con" contained "dorco" and a football reel entered
 * a razor campaign.
 */
export function tokensContain(tokens: string[], needle: string): boolean {
  if (!needle) return false
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i]
    if (first.includes(needle)) return true
    if (!needle.startsWith(first)) continue
    let run = first
    for (let j = i + 1; j < tokens.length && run.length < needle.length; j++) run += tokens[j]
    if (run === needle) return true
    // May end inside the last word only when it starts with a real word
    // ('vileda' 'turbosmart' ⊇ 'viledaturbo'), never from a scrap of letters:
    // "Ballon d'Or con…" ('d' 'or' 'con') is not "dorco".
    if (first.length >= 4 && run.startsWith(needle)) return true
  }
  return false
}

/**
 * Strict whole-word search, for product keywords: the needle must be exactly
 * a run of complete tokens ('flection' 'system' = 'flectionsystem'; 'dorco' =
 * 'dorco'). "espuma" does not contain "puma", "turbodiesel" is not "turbo".
 */
export function tokensContainWords(tokens: string[], needle: string): boolean {
  if (!needle) return false
  for (let i = 0; i < tokens.length; i++) {
    if (!needle.startsWith(tokens[i])) continue
    let run = tokens[i]
    for (let j = i + 1; j < tokens.length && run.length < needle.length; j++) run += tokens[j]
    if (run === needle) return true
  }
  return false
}

/**
 * A hashtag or mention glues words together, so there a product keyword also
 * counts at the START or at the END of the tag: '#flectionsystem6',
 * '#deliplusflectionsystem', '@dorco_es'. Never in the middle
 * ('#bronceadorcorporal' is not 'dorco').
 */
export function tagCarriesKeyword(tag: string | null | undefined, needle: string): boolean {
  if (!needle) return false
  const glued = alnumWords(tag).join('')
  return glued.startsWith(needle) || glued.endsWith(needle)
}
