import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { calculateSpainFit, type SpainFitInput } from '@/lib/spain-fit'
import { detectCategories } from '@/lib/category-detector'
import type { ScrapedProfile } from '@/lib/apify'

// ============ TYPES ============

interface EnrichmentResult {
  creatorId: string
  platformProfileId: string
  spainFitScore: number | null
  spainFitLevel: string | null
  categories: string[]
  isNew: boolean
}

// ============ MAIN ENRICHMENT ============

/**
 * Takes a scraped profile and performs full enrichment:
 * 1. Create/update CreatorProfile
 * 2. Create/update CreatorPlatformProfile
 * 3. Calculate Spain Fit Score
 * 4. Detect categories
 * 5. Store geo signals
 * 6. Store brand mentions from recent posts
 * 7. Create a snapshot
 * 8. Log data provenance
 *
 * Returns the creatorId.
 */
export async function enrichCreatorFromApifyProfile(
  profile: ScrapedProfile,
  platform: Platform
): Promise<string> {
  const result = await performEnrichment(profile, platform)
  return result.creatorId
}

/**
 * Full enrichment returning all details.
 */
export async function enrichCreatorFull(
  profile: ScrapedProfile,
  platform: Platform
): Promise<EnrichmentResult> {
  return performEnrichment(profile, platform)
}

async function performEnrichment(
  profile: ScrapedProfile,
  platform: Platform
): Promise<EnrichmentResult> {
  // Step 1+2: Create/update platform profile and creator
  const { creatorId, platformProfileId, isNew } = await upsertCreatorAndPlatform(profile, platform)

  // Step 3: Calculate Spain Fit Score
  const spainFit = calculateSpainFitFromProfile(profile, platform)

  // Update CreatorProfile with Spain Fit data
  await prisma.creatorProfile.update({
    where: { id: creatorId },
    data: {
      spainFitScore: spainFit.score,
      spainFitLevel: spainFit.level,
      geoCity: spainFit.detectedCity || profile.city,
      geoProvince: spainFit.detectedProvince,
      geoCountry: spainFit.level === 'confirmed' || spainFit.level === 'probable' ? 'ES' : (profile.country || undefined),
      geoConfidence: spainFit.confidence > 0.7 ? 'observed' : spainFit.confidence > 0.3 ? 'inferred' : 'unknown',
      primaryLanguage: detectPrimaryLanguage(profile),
      lastEnriched: new Date(),
    },
  })

  // Store Spain Fit score record
  await prisma.creatorScoreRecord.create({
    data: {
      creatorId,
      scoreType: 'spain_fit',
      score: spainFit.score,
      signal: spainFit.signal,
      explanation: spainFit.explanation,
      components: spainFit.components as object,
      isInferred: spainFit.confidence < 0.7,
      confidence: spainFit.confidence,
    },
  })

  // Step 4: Detect categories
  const allHashtags = profile.recentPosts.flatMap(p => p.hashtags)
  const allMentions = profile.recentPosts.flatMap(p => p.mentions)
  const allCaptions = profile.recentPosts.map(p => p.caption).filter(Boolean) as string[]

  const categories = detectCategories({
    bio: profile.bio || undefined,
    hashtags: allHashtags,
    mentions: allMentions,
    brandMentions: allMentions,
  })

  const categorySlugs = categories.map(c => c.category)

  await prisma.creatorProfile.update({
    where: { id: creatorId },
    data: {
      primaryCategory: categorySlugs[0] || null,
      categories: categorySlugs,
    },
  })

  // Store category signals
  for (const cat of categories) {
    await prisma.creatorCategorySignal.create({
      data: {
        creatorId,
        category: cat.category,
        confidence: cat.confidence,
        source: cat.source,
      },
    })
  }

  // Step 5: Store geo signals
  await storeGeoSignals(creatorId, profile, spainFit)

  // Step 6: Store brand mentions from recent posts
  await storeBrandMentions(creatorId, profile, platform)

  // Step 7: Create snapshot
  await prisma.creatorSnapshot.create({
    data: {
      creatorId,
      platform,
      followers: profile.followers,
      engagementRate: profile.engagementRate,
      avgViews: profile.avgViews || undefined,
      avgLikes: profile.avgLikes || undefined,
      source: 'apify',
    },
  })

  // Step 8: Store recent posts
  for (const post of profile.recentPosts.slice(0, 20)) {
    await prisma.creatorPost.upsert({
      where: {
        platform_externalId: {
          platform,
          externalId: post.externalId,
        },
      },
      update: {
        likes: post.likes,
        comments: post.comments,
        views: post.views,
        shares: post.shares,
        saves: post.saves,
        capturedAt: new Date(),
      },
      create: {
        creatorId,
        platform,
        externalId: post.externalId,
        mediaType: post.mediaType,
        caption: post.caption,
        likes: post.likes,
        comments: post.comments,
        views: post.views,
        shares: post.shares,
        saves: post.saves,
        permalink: post.permalink,
        thumbnailUrl: post.thumbnailUrl,
        postedAt: post.postedAt ? new Date(post.postedAt) : null,
        hashtags: post.hashtags,
        mentions: post.mentions,
        source: 'apify',
      },
    })
  }

  // Step 9: Log data provenance
  await logProvenance(creatorId, profile, platform)

  // Step 10: Extract and store contact email if available
  const contactEmail = extractEmailFromBio(profile.bio) || profile.email
  if (contactEmail) {
    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: {
        contactEmail,
        contactEmailSource: profile.email ? 'profile' : 'bio',
        websiteUrl: profile.website,
      },
    })
  }

  return {
    creatorId,
    platformProfileId,
    spainFitScore: spainFit.score,
    spainFitLevel: spainFit.level,
    categories: categorySlugs,
    isNew,
  }
}

// ============ UPSERT LOGIC ============

async function upsertCreatorAndPlatform(
  profile: ScrapedProfile,
  platform: Platform
): Promise<{ creatorId: string; platformProfileId: string; isNew: boolean }> {
  // Check if platform profile already exists
  const existingPlatform = await prisma.creatorPlatformProfile.findUnique({
    where: { platform_username: { platform, username: profile.username } },
    include: { creator: true },
  })

  let creatorId: string
  let platformProfileId: string
  let isNew = false

  if (existingPlatform) {
    creatorId = existingPlatform.creatorId
    platformProfileId = existingPlatform.id

    // Update platform profile metrics
    await prisma.creatorPlatformProfile.update({
      where: { id: platformProfileId },
      data: {
        followers: profile.followers,
        following: profile.following,
        postsCount: profile.postsCount,
        engagementRate: profile.engagementRate,
        avgViews: profile.avgViews,
        avgLikes: profile.avgLikes,
        avgComments: profile.avgComments,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        isVerified: profile.isVerified,
        lastScraped: new Date(),
        scrapeCount: { increment: 1 },
      },
    })

    // Update creator display name
    await prisma.creatorProfile.update({
      where: { id: creatorId },
      data: {
        displayName: profile.displayName || existingPlatform.creator.displayName,
      },
    })
  } else {
    // Create new CreatorProfile + PlatformProfile
    isNew = true

    const creator = await prisma.creatorProfile.create({
      data: {
        displayName: profile.displayName,
        primaryPlatform: platform,
        platformProfiles: {
          create: {
            platform,
            username: profile.username,
            followers: profile.followers,
            following: profile.following,
            postsCount: profile.postsCount,
            engagementRate: profile.engagementRate,
            avgViews: profile.avgViews,
            avgLikes: profile.avgLikes,
            avgComments: profile.avgComments,
            bio: profile.bio,
            avatarUrl: profile.avatarUrl,
            isVerified: profile.isVerified,
            lastScraped: new Date(),
            dataSource: 'apify',
            scrapeCount: 1,
          },
        },
      },
      include: { platformProfiles: true },
    })

    creatorId = creator.id
    platformProfileId = creator.platformProfiles[0].id
  }

  return { creatorId, platformProfileId, isNew }
}

// ============ SPAIN FIT FROM PROFILE ============

function calculateSpainFitFromProfile(
  profile: ScrapedProfile,
  _platform: Platform
) {
  const allCaptions = profile.recentPosts
    .map(p => p.caption)
    .filter(Boolean) as string[]

  const allHashtags = profile.recentPosts.flatMap(p => p.hashtags)
  const allMentions = profile.recentPosts.flatMap(p => p.mentions)

  const postTimestamps = profile.recentPosts
    .map(p => p.postedAt ? new Date(p.postedAt) : null)
    .filter((d): d is Date => d !== null && !isNaN(d.getTime()))

  const input: SpainFitInput = {
    bio: profile.bio,
    captions: allCaptions,
    hashtags: allHashtags,
    mentions: allMentions,
    postTimestamps,
    city: profile.city,
    country: profile.country,
  }

  return calculateSpainFit(input)
}

// ============ GEO SIGNALS ============

async function storeGeoSignals(
  creatorId: string,
  profile: ScrapedProfile,
  spainFit: ReturnType<typeof calculateSpainFit>
): Promise<void> {
  const signals: Array<{ signalType: string; value: string; confidence: number; source: string }> = []

  if (profile.country) {
    signals.push({
      signalType: 'country_field',
      value: profile.country,
      confidence: 0.9,
      source: 'profile_data',
    })
  }

  if (profile.city) {
    signals.push({
      signalType: 'city_field',
      value: profile.city,
      confidence: 0.9,
      source: 'profile_data',
    })
  }

  if (spainFit.detectedCity) {
    signals.push({
      signalType: 'city_mention',
      value: spainFit.detectedCity,
      confidence: 0.7,
      source: 'bio_analysis',
    })
  }

  // Check for Spain flag emoji in bio
  if ((profile.bio || '').includes('🇪🇸')) {
    signals.push({
      signalType: 'flag_emoji',
      value: '🇪🇸',
      confidence: 0.8,
      source: 'bio_analysis',
    })
  }

  // Store timezone signal based on posting hours
  if (spainFit.components.timezoneScore.score > 50) {
    signals.push({
      signalType: 'posting_hours',
      value: 'CET_compatible',
      confidence: spainFit.components.timezoneScore.score / 100,
      source: 'inferred',
    })
  }

  for (const signal of signals) {
    await prisma.creatorGeoSignal.create({
      data: {
        creatorId,
        ...signal,
      },
    })
  }
}

// ============ BRAND MENTIONS ============

async function storeBrandMentions(
  creatorId: string,
  profile: ScrapedProfile,
  platform: Platform
): Promise<void> {
  const { SPAIN_CATEGORIES: cats } = await import('@/lib/spain-categories')
  const allBrandsMap: Record<string, string[]> = {} // brand -> categories

  for (const cat of cats) {
    for (const brand of cat.brandsEs) {
      if (!allBrandsMap[brand.toLowerCase()]) {
        allBrandsMap[brand.toLowerCase()] = []
      }
      allBrandsMap[brand.toLowerCase()].push(cat.slug)
    }
  }

  for (const post of profile.recentPosts) {
    const captionLower = (post.caption || '').toLowerCase()
    const mentionsLower = post.mentions.map(m => m.toLowerCase().replace('@', ''))

    for (const [brandLower] of Object.entries(allBrandsMap)) {
      let mentionType: string | null = null

      if (mentionsLower.some(m => m.includes(brandLower) || brandLower.includes(m))) {
        mentionType = 'tag'
      } else if (captionLower.includes(brandLower)) {
        mentionType = 'caption'
      }

      if (mentionType) {
        await prisma.creatorBrandMention.create({
          data: {
            creatorId,
            brandName: brandLower,
            platform,
            mentionType,
            confidence: mentionType === 'tag' ? 0.9 : 0.6,
          },
        })
      }
    }
  }

  // Also check bio for brand mentions
  if (profile.bio) {
    const bioLower = profile.bio.toLowerCase()
    for (const [brandLower] of Object.entries(allBrandsMap)) {
      if (bioLower.includes(brandLower)) {
        await prisma.creatorBrandMention.create({
          data: {
            creatorId,
            brandName: brandLower,
            platform,
            mentionType: 'bio',
            confidence: 0.7,
          },
        })
      }
    }
  }
}

// ============ DATA PROVENANCE ============

async function logProvenance(
  creatorId: string,
  profile: ScrapedProfile,
  _platform: Platform
): Promise<void> {
  const fields: Array<{ field: string; value: string; method: string; confidence: number; isInferred: boolean }> = [
    { field: 'followers', value: String(profile.followers), method: 'scrape', confidence: 0.95, isInferred: false },
    { field: 'engagementRate', value: String(profile.engagementRate), method: 'scrape', confidence: 0.9, isInferred: false },
  ]

  if (profile.country) {
    fields.push({ field: 'country', value: profile.country, method: 'scrape', confidence: 0.9, isInferred: false })
  }
  if (profile.city) {
    fields.push({ field: 'city', value: profile.city, method: 'scrape', confidence: 0.9, isInferred: false })
  }

  for (const f of fields) {
    await prisma.dataProvenance.create({
      data: {
        entityType: 'creator',
        entityId: creatorId,
        field: f.field,
        value: f.value,
        source: 'apify',
        method: f.method,
        confidence: f.confidence,
        isInferred: f.isInferred,
      },
    })
  }
}

// ============ LINK TO EXISTING INFLUENCER ============

/**
 * Syncs CreatorPlatformProfile records with existing Influencer records.
 * Links them by matching platform + username.
 */
export async function syncCreatorInfluencerLinks(): Promise<{ linked: number }> {
  // Find all platform profiles without an influencerId link
  const unlinked = await prisma.creatorPlatformProfile.findMany({
    where: { influencerId: null },
    select: { id: true, platform: true, username: true },
  })

  let linked = 0

  for (const pp of unlinked) {
    const influencer = await prisma.influencer.findUnique({
      where: { username_platform: { username: pp.username, platform: pp.platform } },
    })

    if (influencer) {
      await prisma.creatorPlatformProfile.update({
        where: { id: pp.id },
        data: { influencerId: influencer.id },
      })
      linked++
    }
  }

  return { linked }
}

// ============ HELPERS ============

function extractEmailFromBio(bio: string | null): string | null {
  if (!bio) return null
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
  const match = bio.match(emailRegex)
  return match ? match[0] : null
}

function detectPrimaryLanguage(profile: ScrapedProfile): string | null {
  const texts = [
    profile.bio || '',
    ...profile.recentPosts.map(p => p.caption || ''),
  ].filter(Boolean)

  if (texts.length === 0) return null

  const combined = texts.join(' ').toLowerCase()

  // Simple heuristic: check for Spanish indicators
  const spanishWords = ['de', 'la', 'el', 'en', 'los', 'las', 'del', 'con', 'para', 'por', 'que']
  const englishWords = ['the', 'and', 'is', 'in', 'to', 'of', 'for', 'with', 'on', 'at']

  const words = combined.split(/\s+/)
  const spanishCount = words.filter(w => spanishWords.includes(w)).length
  const englishCount = words.filter(w => englishWords.includes(w)).length

  if (spanishCount > englishCount * 1.5) return 'es'
  if (englishCount > spanishCount * 1.5) return 'en'
  if (spanishCount > 0 && englishCount > 0) return 'es' // Default to Spanish if mixed
  if (spanishCount > 0) return 'es'
  if (englishCount > 0) return 'en'

  return null
}
