/**
 * The single creator pool: CreatorProfile + CreatorPlatformProfile.
 *
 * Every Influencer row (legacy table, where the real creators of the agency
 * live) that carries real profile data is MATERIALIZED into the pool — linked
 * through CreatorPlatformProfile.influencerId — and classified there. Every
 * read surface (DB tab, category search, "Similares") must filter pool rows
 * with REAL_PROFILE_WHERE: the ~2.993 hashtag shells created by the old
 * discovery cron (0 followers, no bio, one post) are never deleted, only
 * excluded.
 *
 * Nothing in this module calls Apify: it only moves data we already own.
 */

import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/db'
import { detectCategories, type CategoryMatch } from '@/lib/category-detector'
import { calculateSpainFit } from '@/lib/spain-fit'

/** A platform profile carries real data; hashtag shells never pass. */
export const REAL_PROFILE_WHERE: Prisma.CreatorPlatformProfileWhereInput = { followers: { gt: 0 } }

/** How many recent posts (creator_posts / media) feed the classifier. */
const MAX_POSTS = 50
/** How many captions are joined to the bio for keyword/brand detection. */
const MAX_CAPTIONS = 30
const SYNC_BATCH = 100
const SYNC_DEFAULT_LIMIT = 2000
/** calculateSpainFit: a score of 60 or more is 'probable'. */
const PROBABLE_MIN_SCORE = 60

// ============ PURE HELPERS ============

/**
 * An Influencer row is worth materializing when it has followers AND at least
 * one sign of a real profile: a bio, a completed scrape, an engagement rate
 * or a campaign it took part in. Rows that only carry a follower count (bulk
 * imports without a profile) stay out until they get scraped.
 *
 * Outside a campaign the row must also have been written by a data pipeline
 * (`dataSource` 'apify' | 'api' | 'oauth' | 'marketplace'): the profile
 * analysis tool leaves dataSource null and is run on brands, shops and media
 * accounts (@pccom_spain, @nilait_es, @topesdegama…) that are not creators.
 * Pass the row's dataSource; a caller that omits it is treated as null.
 */
export function influencerHasProfileData(
  inf: { followers: number; bio: string | null; lastScraped: Date | null; engagementRate: number; dataSource?: string | null },
  inCampaign = false,
): boolean {
  if (!(inf.followers > 0)) return false
  if (inCampaign) return true
  if (!nonEmpty(inf.dataSource)) return false
  return Boolean(nonEmpty(inf.bio) || inf.lastScraped || inf.engagementRate > 0)
}

export interface CreatorTextInput {
  bio: string | null
  hashtags: string[]
  mentions: string[]
  captions: string[]
}

/**
 * Category detection over everything we know about a creator's content: the
 * bio, up to MAX_CAPTIONS captions (keyword and brand matching sees them; a
 * bio hit outranks a caption hit) and the hashtags/mentions of its posts. Pure.
 */
export function classifyCreatorText(input: CreatorTextInput): CategoryMatch[] {
  const captions = (input.captions || []).filter(c => nonEmpty(c)).slice(0, MAX_CAPTIONS)
  const mentions = (input.mentions || []).filter(Boolean)
  return detectCategories({
    bio: nonEmpty(input.bio) ?? undefined,
    captions,
    hashtags: (input.hashtags || []).filter(Boolean),
    mentions,
    brandMentions: mentions,
  })
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed ? trimmed : null
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 'ES' | 'España' | 'Spain' | 'es' → 'ES'; any other code is kept as typed; empty → null. */
function normalizeCountry(raw: string | null | undefined): string | null {
  const value = nonEmpty(raw)
  if (!value) return null
  const key = value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
  if (key === 'es' || key === 'espana' || key === 'spain') return 'ES'
  return value
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

// ============ MATERIALIZATION ============

type InfluencerRow = Prisma.InfluencerGetPayload<{ include: { _count: { select: { campaigns: true } } } }>

type PoolProfileRow = { id: string; creatorId: string; lastScraped: Date | null }

const poolProfileSelect = { id: true, creatorId: true, lastScraped: true } as const

/** Pool row for an influencer: by link first, then by (platform, username) ignoring case. */
async function findPoolProfile(inf: Pick<InfluencerRow, 'id' | 'platform' | 'username'>): Promise<PoolProfileRow | null> {
  const linked = await prisma.creatorPlatformProfile.findFirst({
    where: { influencerId: inf.id },
    select: poolProfileSelect,
  })
  if (linked) return linked
  return prisma.creatorPlatformProfile.findFirst({
    where: { platform: inf.platform, username: { equals: inf.username, mode: 'insensitive' } },
    select: poolProfileSelect,
  })
}

/** Metrics from the Influencer row, only the positive ones (a 0 never overwrites a value). */
function influencerMetrics(inf: InfluencerRow): Prisma.CreatorPlatformProfileUpdateInput {
  return {
    followers: positive(inf.followers),
    following: positive(inf.following),
    postsCount: positive(inf.postsCount),
    engagementRate: positive(inf.engagementRate),
    avgViews: positive(inf.avgViews),
    avgLikes: positive(inf.avgLikes),
    avgComments: positive(inf.avgComments),
  }
}

/**
 * Copies an Influencer row into the pool (creating CreatorProfile +
 * CreatorPlatformProfile when missing), links it, refreshes the
 * CreatorProfile identity fields and classifies it from bio + media.
 *
 * Returns null when the influencer does not exist or carries no profile data
 * (see influencerHasProfileData). Idempotent; safe to run concurrently for
 * different influencers (a lost race on (platform, username) adopts the row
 * that won).
 */
export async function materializeInfluencerIntoPool(
  influencerId: string,
): Promise<{ creatorId: string; created: boolean; categories: string[] } | null> {
  const inf = await prisma.influencer.findUnique({
    where: { id: influencerId },
    include: { _count: { select: { campaigns: true } } },
  })
  if (!inf) return null
  if (!influencerHasProfileData(inf, inf._count.campaigns > 0)) return null

  const username = inf.username.trim().replace(/^@+/, '')
  if (!username) return null

  const lastScraped = inf.lastScraped ?? inf.updatedAt
  const metrics = influencerMetrics(inf)
  const bio = nonEmpty(inf.bio)
  const avatarUrl = nonEmpty(inf.avatarUrl)

  let created = false
  let target = await findPoolProfile({ id: inf.id, platform: inf.platform, username })

  if (!target) {
    try {
      const creator = await prisma.creatorProfile.create({
        data: {
          displayName: nonEmpty(inf.displayName) ?? username,
          primaryPlatform: inf.platform,
          platformProfiles: {
            create: {
              platform: inf.platform,
              username,
              followers: inf.followers,
              following: positive(inf.following) ?? 0,
              postsCount: positive(inf.postsCount) ?? 0,
              engagementRate: positive(inf.engagementRate) ?? 0,
              avgViews: positive(inf.avgViews) ?? 0,
              avgLikes: positive(inf.avgLikes) ?? 0,
              avgComments: positive(inf.avgComments) ?? 0,
              bio,
              avatarUrl,
              isVerified: inf.isVerified,
              lastScraped,
              dataSource: 'influencer',
              influencerId: inf.id,
            },
          },
        },
        select: { id: true, platformProfiles: { select: poolProfileSelect } },
      })
      target = creator.platformProfiles[0] ?? { id: '', creatorId: creator.id, lastScraped }
      created = true
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // Another writer created (platform, username) meanwhile: adopt it.
      target = await findPoolProfile({ id: inf.id, platform: inf.platform, username })
      if (!target) throw err
    }
  }

  if (!created) {
    await prisma.creatorPlatformProfile.update({
      where: { id: target.id },
      data: {
        ...metrics,
        bio: bio ?? undefined,
        avatarUrl: avatarUrl ?? undefined,
        isVerified: inf.isVerified ? true : undefined,
        lastScraped: target.lastScraped && target.lastScraped > lastScraped ? undefined : lastScraped,
        dataSource: 'influencer',
        influencerId: inf.id,
      },
    })
  }

  const creatorId = target.creatorId
  const geoCountry = normalizeCountry(inf.country)
  const email = nonEmpty(inf.email)
  const before = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: { displayName: true, spainFitLevel: true, spainFitScore: true },
  })
  const keepsSpainLevel = before?.spainFitLevel === 'confirmed' || before?.spainFitLevel === 'probable'

  // Loaded once (after the platform profile carries the bio and the link):
  // feeds both the Spain fit and the classification.
  const content = await loadCreatorContent(creatorId)
  const fit = content ? spainFitFor(inf, geoCountry, inf._count.campaigns > 0, content) : null
  // A stronger fit already on the row (a full Apify enrichment with comments,
  // audience…) is never lowered by the legacy data.
  const writeFit =
    fit !== null && !(keepsSpainLevel && typeof before?.spainFitScore === 'number' && before.spainFitScore > fit.score)
  const fitSaysSpain = writeFit && (fit.level === 'confirmed' || fit.level === 'probable')

  await prisma.creatorProfile.update({
    where: { id: creatorId },
    data: {
      displayName: nonEmpty(inf.displayName) ?? before?.displayName ?? username,
      geoCountry: geoCountry ?? (fitSaysSpain ? 'ES' : undefined),
      geoCity: nonEmpty(inf.city) ?? (writeFit ? fit.detectedCity : undefined) ?? undefined,
      geoProvince: writeFit ? fit.detectedProvince ?? undefined : undefined,
      geoConfidence: writeFit ? (fit.confidence > 0.7 ? 'observed' : fit.confidence > 0.3 ? 'inferred' : 'unknown') : undefined,
      spainFitScore: writeFit ? fit.score : undefined,
      spainFitLevel: writeFit ? fit.level : geoCountry === 'ES' && !keepsSpainLevel ? 'probable' : undefined,
      contactEmail: email ?? undefined,
      contactEmailSource: email ? 'profile' : undefined,
      primaryLanguage: nonEmpty(inf.language) ?? undefined,
      lastEnriched: new Date(),
    },
  })

  const categories = content ? await writeClassification(creatorId, content) : []
  return { creatorId, created, categories }
}

// ============ SPAIN FIT ============

/**
 * Spain fit for a materialized influencer, with the calculator
 * enrichCreatorFull uses (bio, captions, hashtags, mentions, post dates,
 * city, country, language). Legacy rows carry no comments or audience data,
 * so the calculator alone leaves most agency creators at 'unknown': a creator
 * the agency already ran a campaign with, or whose profile says Spain, is
 * raised to at least 'probable' — unless the row names another country or
 * the text reads as LATAM.
 */
function spainFitFor(inf: InfluencerRow, geoCountry: string | null, inCampaign: boolean, content: CreatorContent) {
  const text = textInputOf(content)
  const fit = calculateSpainFit({
    bio: nonEmpty(inf.bio) ?? content.bio,
    captions: text.captions,
    hashtags: text.hashtags,
    mentions: text.mentions,
    postTimestamps: content.rows
      .map(r => r.postedAt)
      .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime())),
    city: inf.city,
    country: geoCountry ?? inf.country,
    language: inf.language,
  })
  let { score, level } = fit
  const foreign = geoCountry !== null && geoCountry !== 'ES'
  if ((inCampaign || geoCountry === 'ES') && !foreign && level !== 'latam' && score < PROBABLE_MIN_SCORE) {
    score = PROBABLE_MIN_SCORE
    level = 'probable'
  }
  return { score, level, detectedCity: fit.detectedCity, detectedProvince: fit.detectedProvince, confidence: fit.confidence }
}

// ============ CLASSIFICATION ============

const postOrder = [
  { postedAt: { sort: 'desc', nulls: 'last' } },
  { capturedAt: 'desc' },
] satisfies Prisma.CreatorPostOrderByWithRelationInput[]

const mediaOrder = [
  { postedAt: { sort: 'desc', nulls: 'last' } },
  { discoveredAt: 'desc' },
] satisfies Prisma.MediaOrderByWithRelationInput[]

type ContentRow = { hashtags: string[]; mentions: string[]; caption: string | null; postedAt: Date | null }

/** Everything a pool creator owns as text: platform bios + latest posts/media. */
interface CreatorContent {
  bio: string | null
  influencerIds: string[]
  rows: ContentRow[]
}

const contentSelect = { hashtags: true, mentions: true, caption: true, postedAt: true } as const

/** The bios of the creator's platform profiles, its latest creator_posts and the media of the linked Influencer rows. */
async function loadCreatorContent(creatorId: string): Promise<CreatorContent | null> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: creatorId },
    select: {
      id: true,
      platformProfiles: { select: { bio: true, influencerId: true } },
      posts: { orderBy: postOrder, take: MAX_POSTS, select: contentSelect },
    },
  })
  if (!creator) return null

  const influencerIds = Array.from(
    new Set(creator.platformProfiles.map(p => p.influencerId).filter((id): id is string => Boolean(id))),
  )
  const media = influencerIds.length
    ? await prisma.media.findMany({
        where: { influencerId: { in: influencerIds } },
        orderBy: mediaOrder,
        take: MAX_POSTS,
        select: contentSelect,
      })
    : []

  return {
    bio: creator.platformProfiles.map(p => nonEmpty(p.bio)).filter(Boolean).join('\n') || null,
    influencerIds,
    rows: [...creator.posts, ...media],
  }
}

function textInputOf(content: CreatorContent): CreatorTextInput {
  return {
    bio: content.bio,
    hashtags: content.rows.flatMap(r => r.hashtags ?? []),
    mentions: content.rows.flatMap(r => r.mentions ?? []),
    captions: content.rows.map(r => r.caption ?? '').filter(Boolean),
  }
}

/**
 * Recomputes categories/primaryCategory and replaces creator_category_signals
 * for a pool creator from everything it owns: the bios of its platform
 * profiles, its latest creator_posts and the media of the linked Influencer
 * rows. Returns the category slugs (best first); [] when the creator is gone.
 */
export async function reclassifyCreator(creatorId: string): Promise<string[]> {
  const content = await loadCreatorContent(creatorId)
  if (!content) return []
  return writeClassification(creatorId, content)
}

/** Classifies `content` and persists categories/primaryCategory + signals for the creator. */
async function writeClassification(creatorId: string, content: CreatorContent): Promise<string[]> {
  const matches = classifyCreatorText(textInputOf(content))
  const slugs = matches.map(m => m.category)
  const sourcePrefix = content.influencerIds.length ? 'influencer:' : 'pool:'

  await prisma.$transaction([
    prisma.creatorProfile.update({
      where: { id: creatorId },
      data: { primaryCategory: slugs[0] ?? null, categories: slugs },
    }),
    prisma.creatorCategorySignal.deleteMany({ where: { creatorId } }),
    ...(matches.length
      ? [
          prisma.creatorCategorySignal.createMany({
            data: matches.map(m => ({
              creatorId,
              category: m.category,
              confidence: m.confidence,
              source: sourcePrefix + m.source,
            })),
          }),
        ]
      : []),
  ])

  return slugs
}

// ============ BULK SYNC ============

export interface SyncCreatorPoolResult {
  scanned: number
  materialized: number
  created: number
  skipped: number
  reclassified: number
  elapsedMs: number
}

/**
 * Materializes every Influencer with followers into the pool, in sequential
 * batches of 100 (default limit 2000). With `reclassifyRealCreators` it also
 * re-runs classification on the pool creators that pass REAL_PROFILE_WHERE
 * and are not linked to an influencer (Apify-only rows), so the precise
 * detector applies to the whole real pool. Skipped = no profile data or error.
 */
export async function syncCreatorPool(
  opts: { limit?: number; reclassifyRealCreators?: boolean } = {},
): Promise<SyncCreatorPoolResult> {
  const started = Date.now()
  const limit = Math.max(1, Math.floor(opts.limit ?? SYNC_DEFAULT_LIMIT))
  const result: SyncCreatorPoolResult = { scanned: 0, materialized: 0, created: 0, skipped: 0, reclassified: 0, elapsedMs: 0 }

  console.log(`[creator-pool] sync start (limit ${limit}, reclassifyRealCreators ${opts.reclassifyRealCreators === true})`)

  let cursor: string | undefined
  while (result.scanned < limit) {
    const take = Math.min(SYNC_BATCH, limit - result.scanned)
    const batch = await prisma.influencer.findMany({
      where: { followers: { gt: 0 } },
      orderBy: { id: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, username: true, platform: true },
    })
    if (batch.length === 0) break

    for (const inf of batch) {
      result.scanned++
      try {
        const outcome = await materializeInfluencerIntoPool(inf.id)
        if (outcome) {
          result.materialized++
          if (outcome.created) result.created++
        } else {
          result.skipped++
        }
      } catch (err) {
        result.skipped++
        console.error(`[creator-pool] ${inf.platform} @${inf.username} (${inf.id}):`, err instanceof Error ? err.message : err)
      }
    }

    cursor = batch[batch.length - 1].id
    console.log(`[creator-pool] scanned ${result.scanned} · materialized ${result.materialized} (created ${result.created}) · skipped ${result.skipped}`)
    if (batch.length < take) break
  }

  if (opts.reclassifyRealCreators) {
    const creators = await prisma.creatorProfile.findMany({
      where: { platformProfiles: { some: REAL_PROFILE_WHERE, none: { influencerId: { not: null } } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    console.log(`[creator-pool] reclassifying ${creators.length} real pool creators without influencer link`)
    for (const creator of creators) {
      try {
        await reclassifyCreator(creator.id)
        result.reclassified++
      } catch (err) {
        console.error(`[creator-pool] reclassify ${creator.id}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  result.elapsedMs = Date.now() - started
  console.log(`[creator-pool] sync done in ${result.elapsedMs} ms:`, JSON.stringify(result))
  return result
}
