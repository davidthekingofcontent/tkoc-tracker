/**
 * "Similares" (lookalikes) engine.
 *
 * Single source of truth for /api/creators/lookalikes (POST, the Similares
 * page) and /api/influencers/[id]/lookalikes (GET, the Analizar Perfil page).
 *
 * The candidate pool is the creator pool (CreatorProfile +
 * CreatorPlatformProfile) filtered with REAL_PROFILE_WHERE, so the ~2.993
 * hashtag shells (0 followers, no bio) never appear. Legacy Influencer rows
 * are materialized into the pool on demand (see creator-pool.ts) before they
 * are used as a source, so they carry categories like any other creator.
 *
 * Apify is only reached in one place: an unknown handle that nobody has ever
 * analysed (profile scrape + enrichment, exactly as before). The former
 * "Sugerido por Instagram" stage is gone: the actor's relatedProfiles field is
 * always empty, so it cost money and time and never returned anything.
 */

import { Platform, Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { isApifyConfigured, isApifyExhausted, scrapeProfile } from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { parseCreatorHandle } from '@/lib/handles'
import {
  REAL_PROFILE_WHERE,
  influencerHasProfileData,
  materializeInfluencerIntoPool,
} from '@/lib/creator-pool'
import { normalizeForMatch } from '@/lib/category-detector'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LookalikeOrigin = 'creator_profile' | 'influencer' | 'apify'
export type LookalikePlatformSource = 'url' | 'selector'
export type LookalikeReason = 'source_unknown_apify_unavailable' | 'source_not_found' | 'no_candidates'

export interface LookalikeInput {
  handle?: string
  platform?: string
  creatorId?: string
  influencerId?: string
}

export interface LookalikeResult {
  /** CreatorProfile id (every candidate comes from the pool). */
  id: string
  /** Legacy Influencer id when the pool row is linked to one (durable avatar, "Añadir a…"). */
  influencerId: string | null
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  matchScore: number
  matchReasons: string[]
  /** True when the candidate shares a topic signal (category, bio or brands) with the source. */
  topical: boolean
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
  source: LookalikeOrigin
  profileUrl: string
}

export interface LookalikeSource {
  id: string
  influencerId: string | null
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: Platform
  followers: number
  engagementRate: number
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
  origin: LookalikeOrigin
}

export interface LookalikeResponse {
  source: LookalikeSource | null
  lookalikes: LookalikeResult[]
  detectedPlatform: Platform
  platformSource: LookalikePlatformSource
  parsedHandle: string
  reason?: LookalikeReason
  message?: string
}

/** Bad input (no handle, unparseable URL, unknown platform). Routes answer 400. */
export class LookalikeInputError extends Error {
  detectedPlatform: string
  platformSource: LookalikePlatformSource

  constructor(message: string, detectedPlatform: string, platformSource: LookalikePlatformSource) {
    super(message)
    this.name = 'LookalikeInputError'
    this.detectedPlatform = detectedPlatform
    this.platformSource = platformSource
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SourceData {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: Platform
  followers: number
  engagementRate: number
  categories: string[]
  primaryCategory: string | null
  spainFitLevel: string | null
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  primaryLanguage: string | null
  brandNames: string[]
  bio: string | null
  bioTokens: Set<string>
  linkedInfluencerId: string | null
  origin: LookalikeOrigin
}

interface Candidate {
  id: string
  influencerId: string | null
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  email: string | null
  bio: string | null
  categories: string[]
  primaryCategory: string | null
  spainFitLevel: string | null
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  primaryLanguage: string | null
  brandNames: string[]
}

type Signal = { score: number; reasons: string[] }

const MAX_RESULTS = 20
/** Below this many topical matches the list is padded with audience-only matches. */
const MIN_TOPICAL_BEFORE_PADDING = 8
/** Audience-only matches never outrank a topical one. */
const NON_TOPICAL_SCORE_CAP = 40

const REASON_NO_TOPIC_MATCH = 'Audiencia comparable (sin afinidad temática confirmada)'
const REASON_SOURCE_WITHOUT_TOPIC = 'Audiencia comparable (el creador fuente no tiene categoría asignada)'

// ---------------------------------------------------------------------------
// Bio tokenisation (keyword overlap signal)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  // Spanish
  'de', 'la', 'el', 'en', 'los', 'las', 'del', 'con', 'por', 'para', 'un', 'una', 'unos', 'unas',
  'que', 'es', 'se', 'su', 'sus', 'al', 'lo', 'le', 'les', 'mi', 'mis', 'tu', 'tus', 'te', 'me', 'nos',
  'no', 'si', 'ya', 'como', 'pero', 'sobre', 'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa',
  'eso', 'aqui', 'hay', 'muy', 'mas', 'tambien', 'desde', 'hasta', 'entre', 'sin', 'ser', 'son', 'fue',
  'esta', 'estan', 'tiene', 'tienen', 'tengo', 'hacer', 'hago', 'hace', 'soy', 'eres', 'somos', 'todo',
  'todos', 'toda', 'todas', 'cada', 'dia', 'dias', 'semana', 'ano', 'anos', 'hola', 'bienvenido',
  'bienvenidos', 'bienvenida', 'sigueme', 'suscribete', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'aqui',
  'donde', 'cuando', 'porque', 'algo', 'otro', 'otra', 'otros', 'otras', 'mucho', 'mucha', 'muchos',
  'muchas', 'poco', 'solo', 'mismo', 'misma', 'via', 'canal', 'cuenta', 'oficial', 'contacto',
  'colaboraciones', 'colabos', 'colabs', 'negocios', 'publicidad', 'info', 'mail', 'correo',
  // Generic bio filler that says nothing about the topic
  'enlaces', 'enlace', 'ideas', 'idea', 'faciles', 'facil', 'tips', 'consejos', 'trucos', 'vida',
  'amor', 'mundo', 'gracias', 'mejor', 'mejores', 'gratis', 'descuento', 'descuentos', 'codigo',
  'cupon', 'colaboracion', 'pedidos', 'envios', 'whatsapp', 'telegram', 'mama', 'papa',
  // Places: geography is scored on its own (geoCity/geoProvince/geoCountry), never as a topic
  'espana', 'spain', 'madrid', 'barcelona', 'valencia', 'sevilla', 'malaga', 'bilbao', 'zaragoza',
  'mexico', 'argentina', 'colombia', 'chile', 'peru', 'latam', 'usa',
  // English
  'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'is', 'are', 'was',
  'be', 'been', 'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our', 'their', 'you',
  'we', 'they', 'he', 'she', 'me', 'us', 'them', 'not', 'but', 'so', 'if', 'as', 'all', 'any', 'can',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'just', 'about', 'into', 'over', 'out',
  'up', 'down', 'than', 'then', 'there', 'here', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
  'get', 'got', 'also', 'very', 'only', 'new', 'more', 'most', 'some', 'such', 'nor', 'own', 'same',
  'too', 'hello', 'welcome', 'follow', 'subscribe', 'official', 'account', 'channel', 'contact',
  'business', 'inquiries', 'enquiries', 'collab', 'collabs', 'collaborations', 'partnerships', 'email',
  'dms', 'link', 'links', 'below', 'bio', 'daily', 'every', 'day', 'days', 'week', 'year', 'years',
  // Social / URL noise
  'instagram', 'tiktok', 'youtube', 'insta', 'gmail', 'hotmail', 'outlook', 'yahoo', 'com', 'www',
  'http', 'https', 'linktr', 'linktree', 'beacons', 'amzn', 'amazon', 'bit', 'youtu',
  // Too generic in a creator database to carry signal
  'creator', 'creators', 'creadora', 'creador', 'creadores', 'content', 'contenido', 'contenidos',
  'video', 'videos', 'post', 'posts', 'reels', 'reel', 'shorts', 'live', 'directo', 'directos',
])

function tokenizeBio(bio: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (!bio) return out
  for (const tok of normalizeForMatch(bio).split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue
    if (/^\d+$/.test(tok)) continue
    if (STOPWORDS.has(tok)) continue
    out.add(tok)
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring signals (weights sum to 100)
//   TOPIC (50):    category 30 · bio 12 · brands 8
//   AUDIENCE (50): followers 20 · engagement 12 · geo 13 · spain fit 3 · language 2
// ---------------------------------------------------------------------------

function scoreCategoryMatch(source: SourceData, c: Candidate): Signal {
  let score = 0
  const reasons: string[] = []

  if (
    source.primaryCategory &&
    c.primaryCategory &&
    source.primaryCategory.toLowerCase() === c.primaryCategory.toLowerCase()
  ) {
    score += 18
    reasons.push(`Misma categoría: ${c.primaryCategory}`)
  }

  const sourceSet = new Set(source.categories.map((x) => x.toLowerCase()))
  let overlap = 0
  for (const cat of c.categories) {
    if (sourceSet.has(cat.toLowerCase())) overlap++
  }
  score += Math.min(12, overlap * 4)
  if (overlap > 0 && reasons.length === 0) {
    reasons.push(overlap === 1 ? '1 categoría en común' : `${overlap} categorías en común`)
  }

  return { score: Math.min(30, score), reasons }
}

function scoreFollowerSimilarity(sourceFollowers: number, candidateFollowers: number): Signal {
  if (sourceFollowers <= 0 || candidateFollowers <= 0) return { score: 0, reasons: [] }
  const ratio =
    Math.min(sourceFollowers, candidateFollowers) / Math.max(sourceFollowers, candidateFollowers)
  const score = Math.round(ratio * 20)
  return { score, reasons: ratio > 0.5 ? ['Seguidores similares'] : [] }
}

function scoreEngagementSimilarity(sourceER: number, candidateER: number): Signal {
  // Unknown ER on either side: no evidence, no penalty
  if (sourceER <= 0 || candidateER <= 0) return { score: 0, reasons: [] }
  const diff = Math.abs(sourceER - candidateER)
  const score = Math.max(0, Math.round(12 - (diff / 6) * 12))
  return { score, reasons: score >= 8 ? ['Engagement similar'] : [] }
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

function scoreGeoMatch(source: SourceData, c: Candidate): Signal {
  if (sameText(source.geoCity, c.geoCity)) {
    return { score: 13, reasons: [`Misma ciudad: ${c.geoCity}`] }
  }
  if (sameText(source.geoProvince, c.geoProvince)) {
    return { score: 9, reasons: [`Misma provincia: ${c.geoProvince}`] }
  }
  if (sameText(source.geoCountry, c.geoCountry)) {
    return { score: 5, reasons: [`Mismo país: ${c.geoCountry}`] }
  }
  return { score: 0, reasons: [] }
}

function scoreBioOverlap(source: SourceData, c: Candidate): Signal {
  if (source.bioTokens.size === 0 || !c.bio) return { score: 0, reasons: [] }
  const shared: string[] = []
  for (const tok of tokenizeBio(c.bio)) {
    if (source.bioTokens.has(tok)) shared.push(tok)
  }
  if (shared.length === 0) return { score: 0, reasons: [] }
  const score = Math.min(12, shared.length * 4)
  return { score, reasons: [`Bio: ${shared.slice(0, 3).join(', ')}`] }
}

function scoreBrandOverlap(sourceBrands: string[], candidateBrands: string[]): Signal {
  if (sourceBrands.length === 0 || candidateBrands.length === 0) return { score: 0, reasons: [] }
  const sourceSet = new Set(sourceBrands.map((b) => b.toLowerCase()))
  const shared = new Set<string>()
  for (const b of candidateBrands) {
    if (sourceSet.has(b.toLowerCase())) shared.add(b.toLowerCase())
  }
  if (shared.size === 0) return { score: 0, reasons: [] }
  return {
    score: Math.min(8, shared.size * 3),
    reasons: [shared.size === 1 ? '1 marca en común' : `${shared.size} marcas en común`],
  }
}

function scoreSpainFitAlignment(sourceLevel: string | null, candidateLevel: string | null): Signal {
  if (sameText(sourceLevel, candidateLevel) && sourceLevel!.toLowerCase() !== 'unknown') {
    return { score: 3, reasons: ['Mismo Spain Fit'] }
  }
  return { score: 0, reasons: [] }
}

function scoreLanguage(source: SourceData, c: Candidate): Signal {
  if (sameText(source.primaryLanguage, c.primaryLanguage)) {
    return { score: 2, reasons: ['Mismo idioma'] }
  }
  return { score: 0, reasons: [] }
}

function sumSignals(signals: Signal[]): Signal {
  let score = 0
  const reasons: string[] = []
  for (const s of signals) {
    score += s.score
    reasons.push(...s.reasons)
  }
  return { score, reasons }
}

interface CandidateScore {
  topic: number
  audience: number
  total: number
  reasons: string[]
}

function scoreCandidate(source: SourceData, c: Candidate): CandidateScore {
  const topic = sumSignals([
    scoreCategoryMatch(source, c),
    scoreBioOverlap(source, c),
    scoreBrandOverlap(source.brandNames, c.brandNames),
  ])
  const audience = sumSignals([
    scoreFollowerSimilarity(source.followers, c.followers),
    scoreEngagementSimilarity(source.engagementRate, c.engagementRate),
    scoreGeoMatch(source, c),
    scoreLanguage(source, c),
    scoreSpainFitAlignment(source.spainFitLevel, c.spainFitLevel),
  ])
  return {
    topic: topic.score,
    audience: audience.score,
    total: Math.min(100, topic.score + audience.score),
    reasons: [...topic.reasons, ...audience.reasons].slice(0, 5),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getProfileUrl(username: string, platform: string): string {
  switch (platform.toUpperCase()) {
    case 'TIKTOK':
      return `https://tiktok.com/@${username}`
    case 'YOUTUBE':
      return `https://youtube.com/@${username}`
    default:
      return `https://instagram.com/${username}`
  }
}

function platformLabel(platform: string): string {
  switch (platform.toUpperCase()) {
    case 'TIKTOK':
      return 'TikTok'
    case 'YOUTUBE':
      return 'YouTube'
    default:
      return 'Instagram'
  }
}

function unavailableMessage(): string {
  return 'No conocemos ese perfil todavía y la búsqueda de perfiles nuevos no está disponible ahora mismo (límite mensual de scraping alcanzado). Prueba con un creador que ya esté guardado o vuelve a intentarlo más tarde.'
}

const platformInclude = {
  creator: { include: { brandMentions: { select: { brandName: true } } } },
} satisfies Prisma.CreatorPlatformProfileInclude

type PlatformProfileWithCreator = Prisma.CreatorPlatformProfileGetPayload<{
  include: typeof platformInclude
}>

const influencerInclude = { _count: { select: { campaigns: true } } } satisfies Prisma.InfluencerInclude

type InfluencerWithCount = Prisma.InfluencerGetPayload<{ include: typeof influencerInclude }>

function sourceFromPlatformProfile(pp: PlatformProfileWithCreator): SourceData {
  const cp = pp.creator
  return {
    id: cp.id,
    username: pp.username,
    displayName: cp.displayName || pp.username,
    avatarUrl: pp.avatarUrl,
    platform: pp.platform,
    followers: pp.followers,
    engagementRate: pp.engagementRate,
    categories: cp.categories,
    primaryCategory: cp.primaryCategory,
    spainFitLevel: cp.spainFitLevel,
    geoCity: cp.geoCity,
    geoProvince: cp.geoProvince,
    geoCountry: cp.geoCountry,
    primaryLanguage: cp.primaryLanguage,
    brandNames: cp.brandMentions.map((bm) => bm.brandName),
    bio: pp.bio,
    bioTokens: tokenizeBio(pp.bio),
    linkedInfluencerId: pp.influencerId,
    origin: 'creator_profile',
  }
}

/** Raw Influencer row as a source (no categories): only when it cannot be materialized. */
function sourceFromInfluencerRow(inf: InfluencerWithCount): SourceData {
  return {
    id: inf.id,
    username: inf.username,
    displayName: inf.displayName || inf.username,
    avatarUrl: inf.avatarUrl || null,
    platform: inf.platform,
    followers: inf.followers,
    engagementRate: inf.engagementRate,
    categories: [],
    primaryCategory: null,
    spainFitLevel: null,
    geoCity: inf.city || null,
    geoProvince: null,
    geoCountry: inf.country || null,
    primaryLanguage: inf.language || null,
    brandNames: [],
    bio: inf.bio,
    bioTokens: tokenizeBio(inf.bio),
    linkedInfluencerId: inf.id,
    origin: 'influencer',
  }
}

/**
 * Influencer → source. Rows with real profile data are materialized into the
 * pool first (idempotent; classifies them), so the source carries categories;
 * rows without data (or a failed materialization) fall back to the raw fields.
 */
async function resolveInfluencerSource(inf: InfluencerWithCount): Promise<SourceData> {
  if (influencerHasProfileData(inf, inf._count.campaigns > 0)) {
    try {
      const outcome = await materializeInfluencerIntoPool(inf.id)
      if (outcome) {
        const pp =
          (await prisma.creatorPlatformProfile.findFirst({
            where: { influencerId: inf.id, platform: inf.platform },
            include: platformInclude,
          })) ??
          (await prisma.creatorPlatformProfile.findFirst({
            where: { creatorId: outcome.creatorId, platform: inf.platform },
            include: platformInclude,
          }))
        if (pp) return sourceFromPlatformProfile(pp)
      }
    } catch (err) {
      console.error('[Lookalikes] Materialization failed, using raw influencer row:', err)
    }
  }
  return sourceFromInfluencerRow(inf)
}

function candidateFromPlatformProfile(pp: PlatformProfileWithCreator): Candidate {
  const cp = pp.creator
  return {
    id: cp.id,
    influencerId: pp.influencerId,
    username: pp.username,
    displayName: cp.displayName || pp.username,
    avatarUrl: pp.avatarUrl,
    followers: pp.followers,
    engagementRate: pp.engagementRate,
    avgLikes: pp.avgLikes,
    avgComments: pp.avgComments,
    avgViews: pp.avgViews,
    email: cp.contactEmail,
    bio: pp.bio,
    categories: cp.categories,
    primaryCategory: cp.primaryCategory,
    spainFitLevel: cp.spainFitLevel,
    geoCity: cp.geoCity,
    geoProvince: cp.geoProvince,
    geoCountry: cp.geoCountry,
    primaryLanguage: cp.primaryLanguage,
    brandNames: cp.brandMentions.map((bm) => bm.brandName),
  }
}

function toResult(c: Candidate, platform: Platform, matchScore: number, matchReasons: string[], topical: boolean): LookalikeResult {
  return {
    id: c.id,
    influencerId: c.influencerId,
    username: c.username,
    displayName: c.displayName,
    avatarUrl: c.avatarUrl,
    platform,
    followers: c.followers,
    engagementRate: c.engagementRate,
    avgLikes: c.avgLikes,
    avgComments: c.avgComments,
    avgViews: c.avgViews,
    email: c.email,
    matchScore,
    matchReasons,
    topical,
    categories: c.categories,
    spainFitLevel: c.spainFitLevel,
    geoCity: c.geoCity,
    source: 'creator_profile',
    profileUrl: getProfileUrl(c.username, platform),
  }
}

function sourceHasTopicSignal(source: SourceData): boolean {
  return (
    source.categories.length > 0 ||
    !!source.primaryCategory ||
    source.bioTokens.size > 0 ||
    source.brandNames.length > 0
  )
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export async function findLookalikes(input: LookalikeInput): Promise<LookalikeResponse> {
  const { handle, creatorId, influencerId } = input

  // ---- Resolve handle + platform (URL-inferred platform wins over the dropdown)
  const parsed = parseCreatorHandle(handle || '')
  const dropdownPlatform = (input.platform || 'INSTAGRAM').toUpperCase()
  const platformSource: LookalikePlatformSource = parsed.platform ? 'url' : 'selector'
  if (!['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(dropdownPlatform)) {
    throw new LookalikeInputError('Invalid platform', parsed.platform || dropdownPlatform, platformSource)
  }
  let platform = (parsed.platform || dropdownPlatform) as Platform
  const cleanHandle = parsed.username

  if (!cleanHandle && !creatorId && !influencerId) {
    const looksLikeUrl = /(instagram\.com|tiktok\.com|youtube\.com|youtu\.be)/i.test(handle || '')
    throw new LookalikeInputError(
      looksLikeUrl
        ? 'No se pudo extraer el usuario de esa URL. Pega la URL del perfil (no de un vídeo o post) o escribe @usuario.'
        : 'Introduce un @usuario o la URL del perfil.',
      platform,
      platformSource,
    )
  }

  // ===================================================================
  // Stage A: Resolve the source creator
  //   creatorId → influencerId → pool by handle → Influencer by handle →
  //   Apify scrape + enrichment (creates a CreatorProfile) → unavailable
  // ===================================================================

  let sourceData: SourceData | null = null

  // A1: by creatorId
  if (creatorId) {
    const cp = await prisma.creatorProfile.findUnique({
      where: { id: creatorId },
      include: { platformProfiles: true, brandMentions: { select: { brandName: true } } },
    })
    // Only a real profile (REAL_PROFILE_WHERE: followers > 0) can be the source;
    // a creator whose rows are all hashtag shells falls through to the handle path.
    const pp = cp
      ? (cp.platformProfiles.find((p) => p.platform === platform && p.followers > 0) ??
        cp.platformProfiles.find((p) => p.followers > 0))
      : undefined
    if (cp && pp) {
      sourceData = {
        id: cp.id,
        username: pp.username,
        displayName: cp.displayName || pp.username,
        avatarUrl: pp.avatarUrl,
        platform: pp.platform,
        followers: pp.followers,
        engagementRate: pp.engagementRate,
        categories: cp.categories,
        primaryCategory: cp.primaryCategory,
        spainFitLevel: cp.spainFitLevel,
        geoCity: cp.geoCity,
        geoProvince: cp.geoProvince,
        geoCountry: cp.geoCountry,
        primaryLanguage: cp.primaryLanguage,
        brandNames: cp.brandMentions.map((bm) => bm.brandName),
        bio: pp.bio,
        bioTokens: tokenizeBio(pp.bio),
        linkedInfluencerId: pp.influencerId,
        origin: 'creator_profile',
      }
    }
  }

  // A2: by influencerId (Analizar Perfil). A missing row is reported as source_not_found.
  if (!sourceData && influencerId) {
    const inf = await prisma.influencer.findUnique({ where: { id: influencerId }, include: influencerInclude })
    if (!inf) {
      return {
        source: null,
        lookalikes: [],
        reason: 'source_not_found',
        message: 'Influencer not found',
        detectedPlatform: platform,
        platformSource,
        parsedHandle: cleanHandle,
      }
    }
    sourceData = await resolveInfluencerSource(inf)
  }

  // A3: pool by handle (case-insensitive), real profiles only: a hashtag shell
  //   (0 followers) must not become the source — it falls through to A4/A5, and
  //   A5's enrichment upserts the same (platform, username) row, repairing it.
  if (!sourceData && cleanHandle) {
    const pp = await prisma.creatorPlatformProfile.findFirst({
      where: { AND: [REAL_PROFILE_WHERE, { platform, username: { equals: cleanHandle, mode: 'insensitive' } }] },
      include: platformInclude,
    })
    if (pp) sourceData = sourceFromPlatformProfile(pp)
  }

  // A4: legacy Influencer table by handle (materialized into the pool on the way)
  if (!sourceData && cleanHandle) {
    const inf = await prisma.influencer.findFirst({
      where: { platform, username: { equals: cleanHandle, mode: 'insensitive' } },
      include: influencerInclude,
    })
    if (inf) sourceData = await resolveInfluencerSource(inf)
  }

  // A5: unknown creator → scrape + enrich (only when Apify can actually run)
  let scrapeAttempted = false
  if (!sourceData && cleanHandle) {
    const apifyReady = isApifyConfigured() && !isApifyExhausted()
    if (!apifyReady) {
      return {
        source: null,
        lookalikes: [],
        reason: 'source_unknown_apify_unavailable',
        message: unavailableMessage(),
        detectedPlatform: platform,
        platformSource,
        parsedHandle: cleanHandle,
      }
    }

    scrapeAttempted = true
    try {
      const scraped = await scrapeProfile(cleanHandle, platform)
      if (scraped) {
        let enrichedCreatorId: string | null = null
        try {
          const enriched = await enrichCreatorFull(scraped, platform)
          enrichedCreatorId = enriched.creatorId
        } catch (err) {
          console.error('[Lookalikes] Enrichment failed, using raw scrape:', err)
        }

        if (enrichedCreatorId) {
          const pp = await prisma.creatorPlatformProfile.findFirst({
            where: { creatorId: enrichedCreatorId, platform },
            include: platformInclude,
          })
          if (pp) sourceData = sourceFromPlatformProfile(pp)
        }

        if (!sourceData) {
          sourceData = {
            id: `ext_${scraped.username}`,
            username: scraped.username,
            displayName: scraped.displayName,
            avatarUrl: scraped.avatarUrl,
            platform,
            followers: scraped.followers,
            engagementRate: scraped.engagementRate,
            categories: [],
            primaryCategory: null,
            spainFitLevel: null,
            geoCity: scraped.city || null,
            geoProvince: null,
            geoCountry: scraped.country || null,
            primaryLanguage: null,
            brandNames: [],
            bio: scraped.bio,
            bioTokens: tokenizeBio(scraped.bio),
            linkedInfluencerId: null,
            origin: 'apify',
          }
        }
      }
    } catch (err) {
      console.error('[Lookalikes] Apify scrape failed:', err)
    }
  }

  if (!sourceData) {
    // The scrape ran (or the breaker tripped mid-flight) and nothing came back
    const exhaustedNow = isApifyExhausted()
    return {
      source: null,
      lookalikes: [],
      reason: exhaustedNow ? 'source_unknown_apify_unavailable' : 'source_not_found',
      message: exhaustedNow
        ? unavailableMessage()
        : scrapeAttempted
          ? `No encontramos @${cleanHandle} en ${platformLabel(platform)}. Comprueba que el usuario existe y que la plataforma es la correcta.`
          : 'No se pudo identificar el creador.',
      detectedPlatform: platform,
      platformSource,
      parsedHandle: cleanHandle,
    }
  }

  // The source decides the platform of the search (an influencerId/creatorId carries its own)
  platform = sourceData.platform

  // ===================================================================
  // Stage B: Candidate pool — creator_platform_profiles only, real
  //   profiles only (REAL_PROFILE_WHERE), same platform, not suppressed.
  //   B1 affinity (categories / geo / brands) · B2 follower band 0.2x–5x
  // ===================================================================

  const seenUsernames = new Set<string>([sourceData.username.toLowerCase()])
  const seenCreatorIds = new Set<string>([sourceData.id])
  const seenInfluencerIds = new Set<string>()
  if (sourceData.linkedInfluencerId) seenInfluencerIds.add(sourceData.linkedInfluencerId)

  const INT4_MAX = 2147483647
  const sourceFollowers = sourceData.followers
  const hasFollowerBand = sourceFollowers > 0
  const minFollowers = hasFollowerBand ? Math.floor(sourceFollowers * 0.2) : 0
  const maxFollowers = hasFollowerBand ? Math.min(INT4_MAX, Math.ceil(sourceFollowers * 5)) : INT4_MAX

  const candidates: Candidate[] = []
  const pushCandidate = (c: Candidate) => {
    const key = c.username.toLowerCase()
    if (seenUsernames.has(key)) return
    if (seenCreatorIds.has(c.id)) return
    if (c.influencerId && seenInfluencerIds.has(c.influencerId)) return
    seenUsernames.add(key)
    seenCreatorIds.add(c.id)
    if (c.influencerId) seenInfluencerIds.add(c.influencerId)
    candidates.push(c)
  }

  const excludeSourceCreator: Prisma.CreatorProfileWhereInput = {
    isSuppressed: false,
    id: { not: sourceData.id },
  }

  // B1: affinity pool
  const affinityOr: Prisma.CreatorProfileWhereInput[] = []
  if (sourceData.categories.length > 0) affinityOr.push({ categories: { hasSome: sourceData.categories } })
  if (sourceData.primaryCategory) affinityOr.push({ primaryCategory: { equals: sourceData.primaryCategory, mode: 'insensitive' } })
  if (sourceData.geoCity) affinityOr.push({ geoCity: { equals: sourceData.geoCity, mode: 'insensitive' } })
  if (sourceData.geoProvince) affinityOr.push({ geoProvince: { equals: sourceData.geoProvince, mode: 'insensitive' } })
  if (sourceData.brandNames.length > 0) {
    affinityOr.push({ brandMentions: { some: { brandName: { in: sourceData.brandNames, mode: 'insensitive' } } } })
  }

  const affinityQuery = affinityOr.length
    ? prisma.creatorPlatformProfile.findMany({
        where: {
          AND: [REAL_PROFILE_WHERE, { platform, creator: { ...excludeSourceCreator, OR: affinityOr } }],
        },
        include: platformInclude,
        take: 200,
      })
    : Promise.resolve([] as PlatformProfileWithCreator[])

  // B2: follower band, closest to the source on each side
  const bandBelowQuery = prisma.creatorPlatformProfile.findMany({
    where: {
      AND: [
        REAL_PROFILE_WHERE,
        {
          platform,
          creator: excludeSourceCreator,
          followers: { gte: minFollowers, lte: hasFollowerBand ? sourceFollowers : maxFollowers },
        },
      ],
    },
    include: platformInclude,
    orderBy: { followers: 'desc' },
    take: 100,
  })
  const bandAboveQuery = hasFollowerBand
    ? prisma.creatorPlatformProfile.findMany({
        where: {
          AND: [
            REAL_PROFILE_WHERE,
            { platform, creator: excludeSourceCreator, followers: { gt: sourceFollowers, lte: maxFollowers } },
          ],
        },
        include: platformInclude,
        orderBy: { followers: 'asc' },
        take: 100,
      })
    : Promise.resolve([] as PlatformProfileWithCreator[])

  const [affinity, bandBelow, bandAbove] = await Promise.all([affinityQuery, bandBelowQuery, bandAboveQuery])

  for (const pp of [...affinity, ...bandBelow, ...bandAbove]) {
    if (pp.creator.isSuppressed) continue
    pushCandidate(candidateFromPlatformProfile(pp))
  }

  // ===================================================================
  // Stage C: Score and rank
  //   Topical candidates (topic > 0) first, by total score; when fewer
  //   than MIN_TOPICAL_BEFORE_PADDING, audience-only candidates follow,
  //   capped at NON_TOPICAL_SCORE_CAP so they never outrank a topical one.
  //   A source without any topic signal yields audience-only results.
  // ===================================================================

  const sourceHasTopic = sourceHasTopicSignal(sourceData)
  const byScoreThenFollowers = (a: LookalikeResult, b: LookalikeResult) =>
    b.matchScore - a.matchScore || b.followers - a.followers

  const topical: LookalikeResult[] = []
  // Padding keeps the raw audience score: the displayed matchScore is capped at
  // NON_TOPICAL_SCORE_CAP, so sorting by it would tie every audience >= 40.
  const nonTopical: { result: LookalikeResult; audience: number }[] = []

  for (const c of candidates) {
    const s = scoreCandidate(sourceData, c)
    if (sourceHasTopic && s.topic > 0) {
      topical.push(toResult(c, platform, s.total, s.reasons.length > 0 ? s.reasons : ['Audiencia comparable'], true))
      continue
    }
    if (s.audience <= 0) continue
    nonTopical.push({
      audience: s.audience,
      result: toResult(
        c,
        platform,
        Math.min(NON_TOPICAL_SCORE_CAP, s.audience),
        [sourceHasTopic ? REASON_NO_TOPIC_MATCH : REASON_SOURCE_WITHOUT_TOPIC],
        false,
      ),
    })
  }

  topical.sort(byScoreThenFollowers)
  nonTopical.sort((a, b) => b.audience - a.audience || b.result.followers - a.result.followers)

  const results =
    topical.length >= MIN_TOPICAL_BEFORE_PADDING
      ? topical.slice(0, MAX_RESULTS)
      : [...topical, ...nonTopical.map((n) => n.result)].slice(0, MAX_RESULTS)

  return {
    source: {
      id: sourceData.id,
      influencerId: sourceData.linkedInfluencerId,
      username: sourceData.username,
      displayName: sourceData.displayName,
      avatarUrl: sourceData.avatarUrl,
      platform: sourceData.platform,
      followers: sourceData.followers,
      engagementRate: sourceData.engagementRate,
      categories: sourceData.categories,
      spainFitLevel: sourceData.spainFitLevel,
      geoCity: sourceData.geoCity,
      origin: sourceData.origin,
    },
    lookalikes: results,
    detectedPlatform: platform,
    platformSource,
    parsedHandle: cleanHandle || sourceData.username,
    ...(results.length === 0
      ? {
          reason: 'no_candidates' as const,
          message: `Todavía no hay perfiles comparables de ${platformLabel(platform)} en la base de datos. Analiza o descubre más creadores de esta plataforma y vuelve a intentarlo.`,
        }
      : {}),
  }
}
