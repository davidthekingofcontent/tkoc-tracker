import { SPAIN_CATEGORIES } from '@/lib/spain-categories'

export interface CategoryDetectionInput {
  bio?: string
  hashtags?: string[]
  mentions?: string[]
  brandMentions?: string[]
}

export interface CategoryMatch {
  category: string   // slug
  confidence: number // 0-1
  source: string     // keywords/hashtags/brands
}

/**
 * Detect categories from bio, hashtags, mentions, and brand mentions.
 * Uses the SPAIN_CATEGORIES taxonomy for matching.
 * Returns top 5 matches sorted by confidence.
 */
export function detectCategories(input: CategoryDetectionInput): CategoryMatch[] {
  const scores: Record<string, { total: number; sources: Set<string>; matches: number }> = {}

  const bioLower = (input.bio || '').toLowerCase()
  const hashtags = (input.hashtags || []).map(h => h.toLowerCase().replace('#', ''))
  const mentions = (input.mentions || []).map(m => m.toLowerCase().replace('@', ''))
  const brandMentions = (input.brandMentions || []).map(b => b.toLowerCase())

  for (const cat of SPAIN_CATEGORIES) {
    const slug = cat.slug

    if (!scores[slug]) {
      scores[slug] = { total: 0, sources: new Set(), matches: 0 }
    }

    // 1. Keyword matching in bio (weight: 0.3 per match, max ~0.6)
    if (bioLower) {
      let keywordHits = 0
      for (const kw of cat.keywords) {
        if (bioLower.includes(kw.toLowerCase())) {
          keywordHits++
        }
      }
      if (keywordHits > 0) {
        scores[slug].total += Math.min(0.6, keywordHits * 0.3)
        scores[slug].sources.add('keywords')
        scores[slug].matches += keywordHits
      }
    }

    // 2. Hashtag matching (weight: 0.25 per match, max ~0.5)
    if (hashtags.length > 0) {
      let hashtagHits = 0
      for (const catTag of cat.hashtagsEs) {
        const normalizedCatTag = catTag.toLowerCase().replace('#', '')
        if (hashtags.includes(normalizedCatTag)) {
          hashtagHits++
        }
      }
      // Also check keywords as hashtags (e.g., #receta matching "receta" keyword)
      for (const kw of cat.keywords) {
        if (hashtags.includes(kw.toLowerCase())) {
          hashtagHits++
        }
      }
      if (hashtagHits > 0) {
        scores[slug].total += Math.min(0.5, hashtagHits * 0.25)
        scores[slug].sources.add('hashtags')
        scores[slug].matches += hashtagHits
      }
    }

    // 3. Brand matching in mentions (weight: 0.4 per match, max ~0.6)
    if (mentions.length > 0 || brandMentions.length > 0) {
      let brandHits = 0
      const allMentionText = [...mentions, ...brandMentions]
      for (const brand of cat.brandsEs) {
        const brandLower = brand.toLowerCase()
        if (allMentionText.some(m => m.includes(brandLower) || brandLower.includes(m))) {
          brandHits++
        }
      }
      if (brandHits > 0) {
        scores[slug].total += Math.min(0.6, brandHits * 0.4)
        scores[slug].sources.add('brands')
        scores[slug].matches += brandHits
      }
    }

    // 4. Brand matching in bio (weight: 0.2 per match, max ~0.4)
    if (bioLower) {
      let bioBrandHits = 0
      for (const brand of cat.brandsEs) {
        if (bioLower.includes(brand.toLowerCase())) {
          bioBrandHits++
        }
      }
      if (bioBrandHits > 0) {
        scores[slug].total += Math.min(0.4, bioBrandHits * 0.2)
        scores[slug].sources.add('brands')
        scores[slug].matches += bioBrandHits
      }
    }
  }

  // Convert to array, cap confidence at 1.0, sort by confidence, take top 5
  const results: CategoryMatch[] = Object.entries(scores)
    .filter(([, v]) => v.total > 0)
    .map(([slug, v]) => ({
      category: slug,
      confidence: Math.round(Math.min(1.0, v.total) * 100) / 100,
      source: Array.from(v.sources).join('+'),
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)

  return results
}
