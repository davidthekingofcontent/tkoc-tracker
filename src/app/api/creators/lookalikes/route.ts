import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Platform, Prisma } from '@/generated/prisma/client'
import {
  isApifyConfigured,
  isApifyExhausted,
  scrapeProfile,
  scrapeInstagramSimilarAccounts,
} from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { parseCreatorHandle } from '@/lib/handles'

// ---------------------------------------------------------------------------
// Types
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
  origin: 'creator_profile' | 'influencer' | 'apify'
}

interface LookalikeResult {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  platform: string
  followers: number
  engagementRate: number
  matchScore: number
  matchReasons: string[]
  categories: string[]
  spainFitLevel: string | null
  geoCity: string | null
  source: 'creator_profile' | 'influencer' | 'apify'
  profileUrl: string
}

/** Uniform candidate shape, whatever table it came from. */
interface Candidate {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  engagementRate: number
  bio: string | null
  categories: string[]
  primaryCategory: string | null
  spainFitLevel: string | null
  geoCity: string | null
  geoProvince: string | null
  geoCountry: string | null
  primaryLanguage: string | null
  brandNames: string[]
  linkedInfluencerId: string | null
  source: 'creator_profile' | 'influencer' | 'apify'
}

type Signal = { score: number; reasons: string[] }

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
  const normalized = bio
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  for (const tok of normalized.split(/[^a-z0-9]+/)) {
    if (tok.length < 3) continue
    if (/^\d+$/.test(tok)) continue
    if (STOPWORDS.has(tok)) continue
    out.add(tok)
  }
  return out
}

// ---------------------------------------------------------------------------
// Scoring signals (weights sum to 100)
//   category 30 · followers 20 · engagement 12 · geo 13 · bio 12 · brands 8
//   spain fit 3 · language 2
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

function scoreCandidate(source: SourceData, c: Candidate): { score: number; reasons: string[] } {
  const signals = [
    scoreCategoryMatch(source, c),
    scoreBioOverlap(source, c),
    scoreGeoMatch(source, c),
    scoreBrandOverlap(source.brandNames, c.brandNames),
    scoreFollowerSimilarity(source.followers, c.followers),
    scoreEngagementSimilarity(source.engagementRate, c.engagementRate),
    scoreLanguage(source, c),
    scoreSpainFitAlignment(source.spainFitLevel, c.spainFitLevel),
  ]
  let score = 0
  const reasons: string[] = []
  for (const s of signals) {
    score += s.score
    reasons.push(...s.reasons)
  }
  return { score: Math.min(100, score), reasons: reasons.slice(0, 5) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProfileUrl(username: string, platform: string): string {
  switch (platform.toUpperCase()) {
    case 'TIKTOK':
      return `https://tiktok.com/@${username}`
    case 'YOUTUBE':
      return `https://youtube.com/@${username}`
    default:
      return `https://instagram.com/${username}`
  }
}

const platformInclude = {
  creator: { include: { brandMentions: { select: { brandName: true } } } },
} satisfies Prisma.CreatorPlatformProfileInclude

type PlatformProfileWithCreator = Prisma.CreatorPlatformProfileGetPayload<{
  include: typeof platformInclude
}>

function sourceFromPlatformProfile(pp: PlatformProfileWithCreator, platform: Platform): SourceData {
  const cp = pp.creator
  return {
    id: cp.id,
    username: pp.username,
    displayName: cp.displayName || pp.username,
    avatarUrl: pp.avatarUrl,
    platform,
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

function candidateFromPlatformProfile(pp: PlatformProfileWithCreator): Candidate {
  const cp = pp.creator
  return {
    id: cp.id,
    username: pp.username,
    displayName: cp.displayName || pp.username,
    avatarUrl: pp.avatarUrl,
    followers: pp.followers,
    engagementRate: pp.engagementRate,
    bio: pp.bio,
    categories: cp.categories,
    primaryCategory: cp.primaryCategory,
    spainFitLevel: cp.spainFitLevel,
    geoCity: cp.geoCity,
    geoProvince: cp.geoProvince,
    geoCountry: cp.geoCountry,
    primaryLanguage: cp.primaryLanguage,
    brandNames: cp.brandMentions.map((bm) => bm.brandName),
    linkedInfluencerId: pp.influencerId,
    source: 'creator_profile',
  }
}

async function findPlatformProfileByHandle(platform: Platform, username: string) {
  return prisma.creatorPlatformProfile.findFirst({
    where: { platform, username: { equals: username, mode: 'insensitive' } },
    include: platformInclude,
  })
}

function unavailableMessage(): string {
  return 'No conocemos ese perfil todavía y la búsqueda de perfiles nuevos no está disponible ahora mismo (límite mensual de scraping alcanzado). Prueba con un creador que ya esté guardado o vuelve a intentarlo más tarde.'
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { handle, platform: rawPlatform, creatorId } = body as {
      handle?: string
      platform?: string
      creatorId?: string
    }

    // ---- Resolve handle + platform (URL-inferred platform wins over the dropdown)
    const parsed = parseCreatorHandle(handle || '')
    const dropdownPlatform = (rawPlatform || 'INSTAGRAM').toUpperCase()
    if (!['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(dropdownPlatform)) {
      return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
    }
    const platform = (parsed.platform || dropdownPlatform) as Platform
    const platformSource: 'url' | 'selector' = parsed.platform ? 'url' : 'selector'
    const cleanHandle = parsed.username

    if (!cleanHandle && !creatorId) {
      const looksLikeUrl = /(instagram\.com|tiktok\.com|youtube\.com|youtu\.be)/i.test(handle || '')
      return NextResponse.json(
        {
          error: looksLikeUrl
            ? 'No se pudo extraer el usuario de esa URL. Pega la URL del perfil (no de un vídeo o post) o escribe @usuario.'
            : 'Introduce un @usuario o la URL del perfil.',
          detectedPlatform: platform,
          platformSource,
        },
        { status: 400 }
      )
    }

    // ===================================================================
    // Stage A: Resolve the source creator
    //   creatorId → CreatorPlatformProfile by handle → Influencer table →
    //   Apify scrape + enrichment (creates a CreatorProfile) → unavailable
    // ===================================================================

    let sourceData: SourceData | null = null

    // A1: by creatorId
    if (creatorId) {
      const cp = await prisma.creatorProfile.findUnique({
        where: { id: creatorId },
        include: { platformProfiles: true, brandMentions: { select: { brandName: true } } },
      })
      if (cp) {
        const pp = cp.platformProfiles.find((p) => p.platform === platform) || cp.platformProfiles[0]
        sourceData = {
          id: cp.id,
          username: pp?.username || cleanHandle,
          displayName: cp.displayName || pp?.username || null,
          avatarUrl: pp?.avatarUrl || null,
          platform: pp?.platform || platform,
          followers: pp?.followers || 0,
          engagementRate: pp?.engagementRate || 0,
          categories: cp.categories,
          primaryCategory: cp.primaryCategory,
          spainFitLevel: cp.spainFitLevel,
          geoCity: cp.geoCity,
          geoProvince: cp.geoProvince,
          geoCountry: cp.geoCountry,
          primaryLanguage: cp.primaryLanguage,
          brandNames: cp.brandMentions.map((bm) => bm.brandName),
          bio: pp?.bio || null,
          bioTokens: tokenizeBio(pp?.bio),
          linkedInfluencerId: pp?.influencerId || null,
          origin: 'creator_profile',
        }
      }
    }

    // A2: CreatorPlatformProfile by handle (case-insensitive)
    if (!sourceData && cleanHandle) {
      const pp = await findPlatformProfileByHandle(platform, cleanHandle)
      if (pp) sourceData = sourceFromPlatformProfile(pp, platform)
    }

    // A3: legacy Influencer table
    if (!sourceData && cleanHandle) {
      const inf = await prisma.influencer.findFirst({
        where: { platform, username: { equals: cleanHandle, mode: 'insensitive' } },
      })
      if (inf) {
        sourceData = {
          id: inf.id,
          username: inf.username,
          displayName: inf.displayName || inf.username,
          avatarUrl: inf.avatarUrl || null,
          platform,
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
    }

    // A4: unknown creator → scrape + enrich (only when Apify can actually run)
    let scrapeAttempted = false
    if (!sourceData && cleanHandle) {
      const apifyReady = isApifyConfigured() && !isApifyExhausted()
      if (!apifyReady) {
        return NextResponse.json({
          source: null,
          lookalikes: [],
          reason: 'source_unknown_apify_unavailable',
          message: unavailableMessage(),
          detectedPlatform: platform,
          platformSource,
          parsedHandle: cleanHandle,
        })
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
            if (pp) sourceData = sourceFromPlatformProfile(pp, platform)
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
      return NextResponse.json({
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
      })
    }

    // ===================================================================
    // Stage B: Build the candidate pool
    //   B1 affinity (categories / geo / brands) on the same platform
    //   B2 follower band 0.2x–5x on the same platform, closest first
    //   B3 legacy Influencer table, same band
    //   Never empty as long as the platform has any profiles in range.
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
      if (c.source === 'creator_profile' && seenCreatorIds.has(c.id)) return
      if (c.source === 'influencer' && seenInfluencerIds.has(c.id)) return
      seenUsernames.add(key)
      if (c.source === 'creator_profile') {
        seenCreatorIds.add(c.id)
        if (c.linkedInfluencerId) seenInfluencerIds.add(c.linkedInfluencerId)
      } else if (c.source === 'influencer') {
        seenInfluencerIds.add(c.id)
      }
      candidates.push(c)
    }

    const creatorBaseWhere = {
      platform,
      creator: { isSuppressed: false, id: { not: sourceData.id } },
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
            platform,
            creator: { isSuppressed: false, id: { not: sourceData.id }, OR: affinityOr },
          },
          include: platformInclude,
          take: 150,
        })
      : Promise.resolve([] as PlatformProfileWithCreator[])

    // B2: follower band, closest to the source on each side
    const bandBelowQuery = prisma.creatorPlatformProfile.findMany({
      where: { ...creatorBaseWhere, followers: { gte: minFollowers, lte: hasFollowerBand ? sourceFollowers : maxFollowers } },
      include: platformInclude,
      orderBy: { followers: 'desc' },
      take: hasFollowerBand ? 75 : 120,
    })
    const bandAboveQuery = hasFollowerBand
      ? prisma.creatorPlatformProfile.findMany({
          where: { ...creatorBaseWhere, followers: { gt: sourceFollowers, lte: maxFollowers } },
          include: platformInclude,
          orderBy: { followers: 'asc' },
          take: 75,
        })
      : Promise.resolve([] as PlatformProfileWithCreator[])

    // B3: legacy Influencer table, same band
    const infBelowQuery = prisma.influencer.findMany({
      where: { platform, followers: { gte: minFollowers, lte: hasFollowerBand ? sourceFollowers : maxFollowers } },
      orderBy: { followers: 'desc' },
      take: hasFollowerBand ? 60 : 100,
    })
    const infAboveQuery = hasFollowerBand
      ? prisma.influencer.findMany({
          where: { platform, followers: { gt: sourceFollowers, lte: maxFollowers } },
          orderBy: { followers: 'asc' },
          take: 60,
        })
      : Promise.resolve([])

    const [affinity, bandBelow, bandAbove, infBelow, infAbove] = await Promise.all([
      affinityQuery,
      bandBelowQuery,
      bandAboveQuery,
      infBelowQuery,
      infAboveQuery,
    ])

    for (const pp of [...affinity, ...bandBelow, ...bandAbove]) {
      if (pp.creator.isSuppressed) continue
      pushCandidate(candidateFromPlatformProfile(pp))
    }

    for (const inf of [...infBelow, ...infAbove]) {
      pushCandidate({
        id: inf.id,
        username: inf.username,
        displayName: inf.displayName || inf.username,
        avatarUrl: inf.avatarUrl || null,
        followers: inf.followers,
        engagementRate: inf.engagementRate,
        bio: inf.bio,
        categories: [],
        primaryCategory: null,
        spainFitLevel: null,
        geoCity: inf.city || null,
        geoProvince: null,
        geoCountry: inf.country || null,
        primaryLanguage: inf.language || null,
        brandNames: [],
        linkedInfluencerId: inf.id,
        source: 'influencer',
      })
    }

    // ===================================================================
    // Stage C: Score
    // ===================================================================

    const scored: LookalikeResult[] = []
    for (const c of candidates) {
      const { score, reasons } = scoreCandidate(sourceData, c)
      if (score <= 0) continue
      // Legacy rows carry fewer signals; cap so they never outrank an enriched profile
      const matchScore = c.source === 'influencer' ? Math.min(70, score) : score
      scored.push({
        id: c.id,
        username: c.username,
        displayName: c.displayName,
        avatarUrl: c.avatarUrl,
        platform,
        followers: c.followers,
        engagementRate: c.engagementRate,
        matchScore,
        matchReasons: reasons.length > 0 ? reasons : ['Audiencia comparable'],
        categories: c.categories,
        spainFitLevel: c.spainFitLevel,
        geoCity: c.geoCity,
        source: c.source,
        profileUrl: getProfileUrl(c.username, platform),
      })
    }

    scored.sort((a, b) => b.matchScore - a.matchScore || b.followers - a.followers)
    const strong = scored.filter((r) => r.matchScore >= 15)
    let results = (strong.length >= 5 ? strong : scored).slice(0, 20)

    // ===================================================================
    // Stage D: Instagram "suggested accounts" via Apify when the DB is thin
    // ===================================================================

    if (results.length < 5 && platform === 'INSTAGRAM' && isApifyConfigured() && !isApifyExhausted()) {
      try {
        const similar = await scrapeInstagramSimilarAccounts(sourceData.username)
        const extras: LookalikeResult[] = []
        for (const account of similar) {
          if (!account.username) continue
          const key = account.username.toLowerCase()
          if (seenUsernames.has(key)) continue
          seenUsernames.add(key)

          const c: Candidate = {
            id: `ext_${account.username}`,
            username: account.username,
            displayName: account.displayName || account.username,
            avatarUrl: account.avatarUrl,
            followers: account.followers,
            engagementRate: 0,
            bio: account.bio,
            categories: [],
            primaryCategory: null,
            spainFitLevel: null,
            geoCity: null,
            geoProvince: null,
            geoCountry: null,
            primaryLanguage: null,
            brandNames: [],
            linkedInfluencerId: null,
            source: 'apify',
          }
          const fol = scoreFollowerSimilarity(sourceFollowers, account.followers)
          const bio = scoreBioOverlap(sourceData, c)
          extras.push({
            id: c.id,
            username: c.username,
            displayName: c.displayName,
            avatarUrl: c.avatarUrl,
            platform: 'INSTAGRAM',
            followers: c.followers,
            engagementRate: 0,
            matchScore: Math.min(50, 15 + fol.score + bio.score),
            matchReasons: ['Sugerido por Instagram', ...fol.reasons, ...bio.reasons].slice(0, 5),
            categories: [],
            spainFitLevel: null,
            geoCity: null,
            source: 'apify',
            profileUrl: getProfileUrl(c.username, 'INSTAGRAM'),
          })
        }
        results = [...results, ...extras]
          .sort((a, b) => b.matchScore - a.matchScore || b.followers - a.followers)
          .slice(0, 20)
      } catch (err) {
        console.error('[Lookalikes] Apify similar accounts failed:', err)
      }
    }

    return NextResponse.json({
      source: {
        id: sourceData.id,
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
            reason: 'no_candidates',
            message: `Todavía no hay perfiles comparables de ${platformLabel(platform)} en la base de datos. Analiza o descubre más creadores de esta plataforma y vuelve a intentarlo.`,
          }
        : {}),
    })
  } catch (error) {
    console.error('[Lookalikes] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
