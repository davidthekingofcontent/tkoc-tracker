// Discover — cheap category search helpers.
//
// David (2026-09-14): "apify cobra demasiado — habrá que buscar por categoría
// de otra manera". A category search used to launch
// apify~instagram-hashtag-scraper with resultsLimit 500 (≈ 1,15 $) on every
// click, with no cache and no confirmation. This module holds the pieces that
// make the flow cheap:
//
//   1. Query → SPAIN_CATEGORIES mapping (pure) so the DB can be searched first.
//   2. Cost estimate + hard caps on how many posts a paid run may fetch (pure).
//   3. A 7-day Postgres cache of hashtag runs (HashtagSearchCache) and a
//      module-level in-flight map so two PMs clicking at once pay once.
//
// The pure helpers (sections 1–2) are exercised offline by the scratchpad
// check script; keep them free of DB/network side effects.

import { SPAIN_CATEGORIES, type SpainCategoryDef } from '@/lib/spain-categories'
import { isApifyExhausted, type HashtagResult } from '@/lib/apify'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'

// ============ 1. PRICING & LIMITS (measured 2026-09) ============

/** apify~instagram-hashtag-scraper ≈ 0,0023 $ per post (500 posts = 1,15 $). */
export const APIFY_USD_PER_HASHTAG_POST = 0.0023
/** apify~instagram-profile-scraper ≈ 0,0023 $ per profile. */
export const APIFY_USD_PER_PROFILE = 0.0023
/** Default posts per paid hashtag run (env DISCOVER_HASHTAG_LIMIT). Never 500 again. */
export const DISCOVER_HASHTAG_DEFAULT_LIMIT = 60
/** Absolute cap on posts per run, even if the env asks for more. */
export const DISCOVER_HASHTAG_MAX_POSTS = 150
/** Default number of NEW handles (not in our DB) enriched via profile scraper (env DISCOVER_ENRICH_LIMIT). */
export const DISCOVER_ENRICH_DEFAULT_LIMIT = 0
/** Cap on profile enrichments per paid search. */
export const DISCOVER_ENRICH_MAX = 25
/** A cached hashtag run is served for 7 days. */
export const HASHTAG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** An EMPTY hashtag run is only trusted for 1 day (the tag may simply be new). */
export const HASHTAG_CACHE_EMPTY_TTL_MS = 24 * 60 * 60 * 1000

/** Parse an env value into a posts limit: default 60, clamped to [1, 150]. */
export function resolveHashtagLimit(envValue: string | undefined | null): number {
  const n = Number.parseInt(String(envValue ?? '').trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return DISCOVER_HASHTAG_DEFAULT_LIMIT
  return Math.min(n, DISCOVER_HASHTAG_MAX_POSTS)
}

/** Parse an env value into the profile-enrichment limit: default 0, clamped to [0, 25]. */
export function resolveEnrichLimit(envValue: string | undefined | null): number {
  const raw = String(envValue ?? '').trim()
  if (raw === '') return DISCOVER_ENRICH_DEFAULT_LIMIT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return DISCOVER_ENRICH_DEFAULT_LIMIT
  return Math.min(n, DISCOVER_ENRICH_MAX)
}

/**
 * Estimated USD for one paid category search: one hashtag run of `posts`
 * results plus up to `profilesToEnrich` profile scrapes. Rounded to cents.
 * (The per-run-start overhead of the actor is not measured and not included.)
 */
export function estimateHashtagCostUsd(posts: number, profilesToEnrich = 0): number {
  const p = Math.max(0, Math.min(posts, DISCOVER_HASHTAG_MAX_POSTS))
  const e = Math.max(0, Math.min(profilesToEnrich, DISCOVER_ENRICH_MAX))
  const usd = p * APIFY_USD_PER_HASHTAG_POST + e * APIFY_USD_PER_PROFILE
  return Math.round(usd * 100) / 100
}

// ============ 2. QUERY → CATEGORY MAPPING (pure) ============

/** lowercase, strip accents, collapse whitespace. */
export function normalizeText(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** "#Limpieza Hogar" → "limpiezahogar" (Instagram tags have no spaces/#). */
export function cleanHashtag(raw: string): string {
  return (raw || '').replace(/#/g, '').replace(/\s+/g, '').toLowerCase()
}

export type CategoryMatchReason = 'slug' | 'name' | 'keyword' | 'hashtag' | 'partial' | null

/**
 * Words that must never become a `bio contains` term: "limpieza del hogar"
 * would otherwise match every bio with "modelo" or "Delgado" through "del".
 */
const STOP_WORDS = new Set([
  'del', 'los', 'las', 'una', 'uno', 'unos', 'unas', 'por', 'para', 'con', 'sin', 'sobre',
  'que', 'como', 'mas', 'muy', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'best', 'top', 'all', 'new',
])

/** Free-text term usable against bios: ≥ 3 chars and not a stop word. */
function isSearchTerm(w: string): boolean {
  return w.length >= 3 && !STOP_WORDS.has(w)
}

export interface CategoryMatch {
  /** Best matching SPAIN_CATEGORIES entry, or null when the query is free text. */
  category: SpainCategoryDef | null
  matchedOn: CategoryMatchReason
  /** Hashtag (without #) a paid run would use — the category's first hashtagEs or the query itself. */
  hashtag: string
  /** All hashtags (without #) that identify this category, for the DB search. */
  hashtags: string[]
  /** Free-text terms (≥ 3 chars) to match against bios / names in the DB. */
  terms: string[]
}

function scoreCategory(cat: SpainCategoryDef, q: string, qTag: string): { score: number; reason: CategoryMatchReason } {
  let score = 0
  let reason: CategoryMatchReason = null
  const bump = (s: number, r: CategoryMatchReason) => { if (s > score) { score = s; reason = r } }

  const slugWords = cat.slug.replace(/-/g, ' ')
  if (cat.slug === q || slugWords === q || cat.slug.replace(/-/g, '') === qTag) bump(100, 'slug')
  if (normalizeText(cat.nameEs) === q || normalizeText(cat.nameEn) === q) bump(90, 'name')
  for (const k of cat.keywords) {
    const nk = normalizeText(k)
    if (nk === q) bump(80, 'keyword')
  }
  for (const h of cat.hashtagsEs) {
    if (normalizeText(cleanHashtag(h)) === qTag) bump(75, 'hashtag')
  }
  if (q.length >= 3) {
    const nameEs = normalizeText(cat.nameEs)
    const nameEn = normalizeText(cat.nameEn)
    if (nameEs.split(' ').includes(q) || nameEn.split(' ').includes(q)) bump(45, 'partial')
    else if (nameEs.includes(q) || nameEn.includes(q)) bump(40, 'partial')
    if (cat.parentSlug.split('-').includes(q)) bump(38, 'partial')
    for (const k of cat.keywords) {
      const nk = normalizeText(k)
      if (nk.split(' ').includes(q)) bump(35, 'partial')
      else if (q.length >= 4 && (nk.includes(q) || (nk.length >= 4 && q.includes(nk)))) bump(30, 'partial')
    }
    if (qTag.length >= 4) {
      for (const h of cat.hashtagsEs) {
        const nh = normalizeText(cleanHashtag(h))
        if (nh.includes(qTag)) bump(20, 'partial')
      }
    }
  }
  return { score, reason }
}

/**
 * Map a free-text category query ("limpieza", "hogar", "home", "#fitness")
 * to the SPAIN_CATEGORIES entry it belongs to. Deterministic: ties resolve
 * to the first entry in the list. Never throws; an unknown query yields
 * category null and a hashtag built from the query itself.
 */
export function resolveCategoryQuery(query: string, categories: SpainCategoryDef[] = SPAIN_CATEGORIES): CategoryMatch {
  const q = normalizeText(query.replace(/#/g, ''))
  const qTag = cleanHashtag(normalizeText(query))

  let best: { cat: SpainCategoryDef; score: number; reason: CategoryMatchReason } | null = null
  if (q) {
    for (const cat of categories) {
      const { score, reason } = scoreCategory(cat, q, qTag)
      if (score > 0 && (!best || score > best.score)) best = { cat, score, reason }
    }
  }

  const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)))

  if (!best) {
    const terms = uniq([q, ...q.split(' ')].filter(isSearchTerm))
    return { category: null, matchedOn: null, hashtag: qTag, hashtags: qTag ? [qTag] : [], terms }
  }

  const cat = best.cat
  const hashtags = uniq(cat.hashtagsEs.map(cleanHashtag))
  const primary = hashtags[0] || qTag
  const terms = uniq([
    q,
    ...q.split(' '),
    ...cat.keywords.map(normalizeText),
  ].filter(isSearchTerm)).slice(0, 14)

  return { category: cat, matchedOn: best.reason, hashtag: primary, hashtags, terms }
}

/** Cache key for a paid hashtag run: "INSTAGRAM:limpieza:60". */
export function buildHashtagCacheKey(platform: string, hashtag: string, limit: number): string {
  return `${String(platform || 'INSTAGRAM').toUpperCase()}:${cleanHashtag(hashtag)}:${Math.max(1, Math.floor(limit))}`
}

/** True when a cache row fetched at `fetchedAt` is still fresh at `now`. */
export function isCacheFresh(fetchedAt: Date, resultCount: number, now: Date = new Date()): boolean {
  const ttl = resultCount > 0 ? HASHTAG_CACHE_TTL_MS : HASHTAG_CACHE_EMPTY_TTL_MS
  return now.getTime() - fetchedAt.getTime() < ttl
}

// ============ 3. 7-DAY POSTGRES CACHE + IN-FLIGHT COALESCING ============

export interface CachedHashtagSearch {
  results: HashtagResult[]
  fetchedAt: Date
}

/** Read a fresh cache row, or null. Never throws (a missing table just means no cache). */
export async function getCachedHashtagSearch(key: string): Promise<CachedHashtagSearch | null> {
  try {
    const row = await prisma.hashtagSearchCache.findUnique({ where: { key } })
    if (!row) return null
    const results = Array.isArray(row.payload) ? (row.payload as unknown as HashtagResult[]) : []
    if (!isCacheFresh(row.fetchedAt, results.length)) return null
    return { results, fetchedAt: row.fetchedAt }
  } catch (err) {
    console.error('[Discover] cache read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Upsert a cache row and prune rows past the 7-day TTL (a changed
 * DISCOVER_HASHTAG_LIMIT leaves orphan keys behind otherwise). Never throws;
 * returns false when the write failed (e.g. table not migrated yet) so the
 * caller can tell the PM the run was NOT cached.
 */
export async function setCachedHashtagSearch(key: string, results: HashtagResult[]): Promise<boolean> {
  try {
    const payload = results as unknown as Prisma.InputJsonValue
    await prisma.hashtagSearchCache.upsert({
      where: { key },
      update: { payload, fetchedAt: new Date() },
      create: { key, payload, fetchedAt: new Date() },
    })
    await prisma.hashtagSearchCache.deleteMany({ where: { fetchedAt: { lt: new Date(Date.now() - HASHTAG_CACHE_TTL_MS) } } })
    return true
  } catch (err) {
    console.error('[Discover] cache write failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export interface HashtagRunOutcome {
  results: HashtagResult[]
  /** True when the run was written to the 7-day cache (false: write failed or breaker-caused empty). */
  cacheWritten: boolean
  /** True when the run came back empty because the Apify breaker is open — not a real result. */
  exhausted: boolean
}

// Identical searches launched while one is still running share the same
// promise (and therefore the same single Apify run). Per-process state.
const inFlight = new Map<string, Promise<HashtagRunOutcome>>()

/** Number of hashtag runs currently in flight (for tests/diagnostics). */
export function inFlightHashtagRuns(): number {
  return inFlight.size
}

/**
 * Run `scrape` for `key` unless an identical run is already in flight, in
 * which case the caller awaits that one. The result is written to the 7-day
 * cache before the promise resolves — except an empty result while the Apify
 * breaker is open (scrapeHashtag maps APIFY_EXHAUSTED to [] and the
 * TikTok/YouTube paths swallow errors): that is a failed run, not "nothing
 * on this hashtag", and must not be served as a 24 h negative hit.
 */
export function runHashtagSearchCoalesced(key: string, scrape: () => Promise<HashtagResult[]>): Promise<HashtagRunOutcome> {
  const existing = inFlight.get(key)
  if (existing) {
    console.log(`[Discover] coalescing identical in-flight search ${key}`)
    return existing
  }
  const p = (async (): Promise<HashtagRunOutcome> => {
    try {
      const results = await scrape()
      if (results.length === 0 && isApifyExhausted()) {
        console.warn(`[Discover] ${key}: empty run with the Apify breaker open — not cached`)
        return { results, cacheWritten: false, exhausted: true }
      }
      const cacheWritten = await setCachedHashtagSearch(key, results)
      return { results, cacheWritten, exhausted: false }
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, p)
  return p
}
