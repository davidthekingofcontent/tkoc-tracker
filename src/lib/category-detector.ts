import { SPAIN_CATEGORIES } from '@/lib/spain-categories'

export interface CategoryDetectionInput {
  bio?: string
  /**
   * Post captions. A keyword or brand found here counts for confidence exactly
   * like one found in the bio, but weighs less as ranking evidence: the bio is
   * how the creator describes herself, a caption is one post.
   */
  captions?: string[]
  hashtags?: string[]
  mentions?: string[]
  brandMentions?: string[]
}

export interface CategoryMatch {
  category: string   // slug
  confidence: number // 0-1
  source: string     // keywords/hashtags/brands
}

// ============ TEXT NORMALISATION ============

/**
 * Canonical form for every comparison in this module: Unicode NFD, diacritics
 * stripped ("cocinaespañola" → "cocinaespanola", "día" → "dia"), lowercase,
 * whitespace collapsed to single spaces and trimmed.
 */
export function normalizeForMatch(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const termRegexCache = new Map<string, RegExp | null>()
const termCountRegexCache = new Map<string, RegExp | null>()

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word/phrase regex for an already-normalised term, cached per flag set. */
function termRegex(normalizedTerm: string, flags: string, cache: Map<string, RegExp | null>): RegExp | null {
  let re = cache.get(normalizedTerm)
  if (re === undefined) {
    try {
      re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedTerm)}(?=$|[^\\p{L}\\p{N}])`, flags)
    } catch {
      re = null
    }
    cache.set(normalizedTerm, re)
  }
  return re
}

/**
 * True when `normalizedText` (already passed through normalizeForMatch)
 * contains `term` as a WHOLE word or phrase: the term is normalised the same
 * way and must be delimited by start/end of text or by a character that is
 * neither a letter nor a digit. So "madrid" matches "vivo en madrid" but
 * "ley" no longer matches "ashley", "gol" ⊄ "golpe" and "bar" ⊄ "barcelona".
 */
export function textHasTerm(normalizedText: string, term: string): boolean {
  if (!normalizedText) return false
  const normalizedTerm = normalizeForMatch(term)
  if (!normalizedTerm) return false
  const re = termRegex(normalizedTerm, 'u', termRegexCache)
  return re ? re.test(normalizedText) : false
}

/** How many times `term` occurs in `normalizedText` as a whole word/phrase (same boundaries as textHasTerm). */
function countTerm(normalizedText: string, term: string): number {
  if (!normalizedText) return 0
  const normalizedTerm = normalizeForMatch(term)
  if (!normalizedTerm) return 0
  const re = termRegex(normalizedTerm, 'gu', termCountRegexCache)
  return re ? (normalizedText.match(re) || []).length : 0
}

/**
 * Evidence a hit contributes to the ranking: log-scaled occurrences, so a
 * keyword repeated in 40 captions (≈5.4) does not outweigh six different
 * keywords seen once (6). Confidence keeps its presence-based weights; the
 * evidence only decides the order when confidences tie.
 */
function evidenceOf(occurrences: number): number {
  return occurrences > 0 ? Math.log2(1 + occurrences) : 0
}

/** A hit in the bio weighs this much more than the same hit in a caption (ranking only). */
const BIO_EVIDENCE_WEIGHT = 2

/** "#TrucosDeLimpieza" → "trucosdelimpieza"; multi-word terms lose their spaces ("hogar limpio" → "hogarlimpio"). */
function normalizeHashtag(tag: string): string {
  return normalizeForMatch(tag).replace(/^#+/, '').replace(/\s+/g, '')
}

/** "@Vileda_ES" → "vileda_es" */
function normalizeMention(m: string): string {
  return normalizeForMatch(m).replace(/^@+/, '')
}

/**
 * Brands of three characters or fewer ("Dia", "Cif", "LG", "AKI", "HSN") are
 * everyday words or letter pairs in free text ("cada día"): they only count
 * when they are the @mention itself, never inside a bio.
 */
const MIN_BIO_BRAND_LENGTH = 4

/**
 * Brands of up to four characters ("Dia", "GAME", "LG", "SEAT", "Calm",
 * "Nike") are words or letter pairs inside other people's handles
 * ("@the_game", "@back_seat"): as a mention they must be the handle itself
 * (see handleIsBrand), never a token of it.
 */
const MAX_STRICT_HANDLE_BRAND_LENGTH = 4

function isShortBioBrand(brand: string): boolean {
  return normalizeForMatch(brand).length < MIN_BIO_BRAND_LENGTH
}

function isStrictHandleBrand(brand: string): boolean {
  return normalizeForMatch(brand).length <= MAX_STRICT_HANDLE_BRAND_LENGTH
}

/** Term variants a brand can take as a handle: "Don Limpio" → ["don limpio", "donlimpio"]. */
function brandHandleVariants(brand: string): string[] {
  const normalized = normalizeForMatch(brand)
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '')
  return compact && compact !== normalized ? [normalized, compact] : [normalized]
}

/**
 * What may follow a short brand in its own handle (after an optional
 * separator): "dia", "dia_es", "diasupermercados", "game_es", "lg.spain",
 * "hsnstore". Anything else ("el_dia_a_dia", "the_game", "lg_photography",
 * "lgbt") is not the brand.
 */
const SHORT_BRAND_HANDLE_SUFFIXES = new Set([
  '', 'es', 'esp', 'espana', 'spain', 'iberia', 'oficial', 'official', 'store', 'shop', 'tienda', 'supermercados',
])

/**
 * Does a normalised @handle (no "@", lowercase, no diacritics) refer to
 * `brand`? Long brands may appear as a whole token of the handle
 * ("vileda_es", "leroymerlin.spain"); brands of up to
 * MAX_STRICT_HANDLE_BRAND_LENGTH characters must BE the handle, optionally
 * followed by one separator and a platform suffix
 * (SHORT_BRAND_HANDLE_SUFFIXES), because as a token they are everyday words
 * ("dia" ⊂ "@un_dia_en_casa", "game" ⊂ "@the_game").
 */
function handleIsBrand(handle: string, brand: string): boolean {
  const variants = brandHandleVariants(brand)
  if (!isStrictHandleBrand(brand)) return variants.some(v => textHasTerm(handle, v))
  return variants.some(v => {
    if (!v || !handle.startsWith(v)) return false
    return SHORT_BRAND_HANDLE_SUFFIXES.has(handle.slice(v.length).replace(/^[._-]/, ''))
  })
}

// ============ DETECTION ============

/**
 * Detect categories from bio, hashtags, mentions, and brand mentions.
 * Uses the SPAIN_CATEGORIES taxonomy for matching.
 *
 * Every comparison is diacritic-insensitive and case-insensitive; keywords and
 * brands must appear as whole words/phrases, hashtags must be equal after
 * normalisation. Pure function, no DB.
 *
 * Returns top 5 matches sorted by confidence.
 */
export function detectCategories(input: CategoryDetectionInput): CategoryMatch[] {
  const scores: Record<string, { total: number; sources: Set<string>; matches: number; evidence: number }> = {}

  const bioNorm = normalizeForMatch(input.bio || '')
  const captionsNorm = normalizeForMatch((input.captions || []).filter(Boolean).join('\n'))
  const hasText = Boolean(bioNorm || captionsNorm)
  /** Occurrences of a keyword/brand in bio + captions: one distinct hit, bio-weighted evidence. */
  const textOccurrences = (term: string): { hit: boolean; evidence: number } => {
    const inBio = countTerm(bioNorm, term)
    const inCaptions = countTerm(captionsNorm, term)
    return { hit: inBio + inCaptions > 0, evidence: BIO_EVIDENCE_WEIGHT * evidenceOf(inBio) + evidenceOf(inCaptions) }
  }
  // Hashtags keep their frequency across posts (#receta in 20 captions ≠ once).
  const hashtagCounts = new Map<string, number>()
  for (const tag of input.hashtags || []) {
    const normalized = normalizeHashtag(tag)
    if (normalized) hashtagCounts.set(normalized, (hashtagCounts.get(normalized) || 0) + 1)
  }
  const mentionList = (input.mentions || []).map(normalizeMention).filter(Boolean)
  const brandMentionList = (input.brandMentions || []).map(normalizeMention).filter(Boolean)
  // Callers usually pass the same list as mentions and brandMentions: do not count it twice.
  const allMentionText = input.brandMentions === input.mentions ? mentionList : [...mentionList, ...brandMentionList]

  for (const cat of SPAIN_CATEGORIES) {
    const slug = cat.slug

    if (!scores[slug]) {
      scores[slug] = { total: 0, sources: new Set(), matches: 0, evidence: 0 }
    }
    const score = scores[slug]

    // 1. Keyword matching in bio/captions (weight: 0.3 per match, max ~0.6) — whole words/phrases only
    if (hasText) {
      let keywordHits = 0
      let keywordEvidence = 0
      for (const kw of cat.keywords) {
        const found = textOccurrences(kw)
        if (found.hit) {
          keywordHits++
          keywordEvidence += found.evidence
        }
      }
      if (keywordHits > 0) {
        score.total += Math.min(0.6, keywordHits * 0.3)
        score.sources.add('keywords')
        score.matches += keywordHits
        score.evidence += keywordEvidence
      }
    }

    // 2. Hashtag matching (weight: 0.25 per match, max ~0.5) — exact equality after normalisation
    if (hashtagCounts.size > 0) {
      let hashtagHits = 0
      let hashtagEvidence = 0
      const seen = new Set<string>()
      const tally = (normalizedTag: string) => {
        if (!normalizedTag || seen.has(normalizedTag)) return
        const occurrences = hashtagCounts.get(normalizedTag) || 0
        if (occurrences > 0) {
          seen.add(normalizedTag)
          hashtagHits++
          hashtagEvidence += evidenceOf(occurrences)
        }
      }
      for (const catTag of cat.hashtagsEs) tally(normalizeHashtag(catTag))
      // Also check keywords as hashtags (e.g., #receta matching "receta" keyword)
      for (const kw of cat.keywords) tally(normalizeHashtag(kw))
      if (hashtagHits > 0) {
        score.total += Math.min(0.5, hashtagHits * 0.25)
        score.sources.add('hashtags')
        score.matches += hashtagHits
        score.evidence += hashtagEvidence
      }
    }

    // 3. Brand matching in mentions (weight: 0.4 per match, max ~0.6) — the handle is the brand (see handleIsBrand)
    if (allMentionText.length > 0) {
      let brandHits = 0
      let brandEvidence = 0
      for (const brand of cat.brandsEs) {
        let occurrences = 0
        for (const handle of allMentionText) {
          if (handleIsBrand(handle, brand)) occurrences++
        }
        if (occurrences > 0) {
          brandHits++
          brandEvidence += evidenceOf(occurrences)
        }
      }
      if (brandHits > 0) {
        score.total += Math.min(0.6, brandHits * 0.4)
        score.sources.add('brands')
        score.matches += brandHits
        score.evidence += brandEvidence
      }
    }

    // 4. Brand matching in bio/captions (weight: 0.2 per match, max ~0.4) — whole words/phrases only
    if (hasText) {
      let bioBrandHits = 0
      let bioBrandEvidence = 0
      for (const brand of cat.brandsEs) {
        if (isShortBioBrand(brand)) continue
        const found = textOccurrences(brand)
        if (found.hit) {
          bioBrandHits++
          bioBrandEvidence += found.evidence
        }
      }
      if (bioBrandHits > 0) {
        score.total += Math.min(0.4, bioBrandHits * 0.2)
        score.sources.add('brands')
        score.matches += bioBrandHits
        score.evidence += bioBrandEvidence
      }
    }
  }

  // Convert to array, cap confidence at 1.0, take the top 5. Order: confidence,
  // then evidence (log-scaled occurrences), then distinct hits, then number of
  // sources — never the position in SPAIN_CATEGORIES, which used to decide the
  // primary category whenever the per-source caps saturated.
  const results: CategoryMatch[] = Object.entries(scores)
    .filter(([, v]) => v.total > 0)
    .map(([slug, v]) => ({
      category: slug,
      confidence: Math.round(Math.min(1.0, v.total) * 100) / 100,
      source: Array.from(v.sources).join('+'),
      evidence: v.evidence,
      matches: v.matches,
      sourceCount: v.sources.size,
    }))
    .sort((a, b) =>
      b.confidence - a.confidence ||
      b.evidence - a.evidence ||
      b.matches - a.matches ||
      b.sourceCount - a.sourceCount)
    .slice(0, 5)
    .map(({ category, confidence, source }) => ({ category, confidence, source }))

  return results
}
