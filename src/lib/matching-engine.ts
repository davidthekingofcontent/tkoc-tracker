/**
 * Client-Creator Matching Engine
 * Cross-references imported client contacts against creator profiles
 * to identify "warm creator opportunities"
 */

// ============ TYPES ============

export interface MatchSignal {
  type: string
  weight: number
  detail: string
}

export interface MatchResult {
  creatorProfileId: string
  clientContactId: string
  confidenceScore: number
  confidenceLevel: 'EXACT' | 'PROBABLE' | 'POSSIBLE'
  signals: MatchSignal[]
}

export interface ClientContactData {
  id: string
  contactName: string
  contactEmail: string | null
  companyName: string | null
  companyDomain: string | null
  socialHandles: Record<string, string> | null
  phone: string | null
}

export interface CreatorProfileData {
  id: string
  displayName: string | null
  contactEmail: string | null
  websiteUrl: string | null
  platformProfiles: {
    platform: string
    username: string
    bio: string | null
  }[]
  geoCity: string | null
  geoCountry: string | null
}

// ============ HELPERS ============

function normalizeString(str: string | null | undefined): string {
  if (!str) return ''
  return str.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function normalizeEmail(email: string | null | undefined): string {
  if (!email) return ''
  return email.toLowerCase().trim()
}

function extractDomain(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return ''
  const domain = email.split('@')[1]?.toLowerCase().trim() || ''
  // Skip generic email providers
  const genericProviders = [
    'gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'live.com',
    'icloud.com', 'protonmail.com', 'mail.com', 'aol.com', 'zoho.com',
    'yandex.com', 'gmx.com', 'tutanota.com', 'fastmail.com',
    'hotmail.es', 'yahoo.es', 'outlook.es', 'live.es',
  ]
  if (genericProviders.includes(domain)) return ''
  return domain
}

function extractDomainFromUrl(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`)
    return parsed.hostname.replace('www.', '').toLowerCase()
  } catch {
    return ''
  }
}

function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return ''
  return handle.toLowerCase().trim().replace(/^@/, '').replace(/[._-]/g, '')
}

/**
 * Common Spanish names that are very frequent — penalize confidence
 * when matching only by name with these
 */
const COMMON_NAMES = new Set([
  'maria garcia', 'jose garcia', 'antonio lopez', 'maria lopez',
  'juan martinez', 'maria martinez', 'francisco garcia', 'ana garcia',
  'maria fernandez', 'jose martinez', 'maria rodriguez', 'carlos garcia',
  'david garcia', 'maria gonzalez', 'pedro garcia', 'laura garcia',
  'maria sanchez', 'jose lopez', 'juan garcia', 'carmen garcia',
  'maria perez', 'jose rodriguez', 'daniel garcia', 'pablo garcia',
  'sergio garcia', 'maria diaz', 'alejandro garcia', 'andrea garcia',
])

function isCommonName(name: string): boolean {
  return COMMON_NAMES.has(normalizeString(name))
}

function nameSimilarity(name1: string, name2: string): number {
  const n1 = normalizeString(name1)
  const n2 = normalizeString(name2)

  if (!n1 || !n2) return 0
  if (n1 === n2) return 1.0

  // Check if one contains the other
  if (n1.includes(n2) || n2.includes(n1)) return 0.8

  // Check word overlap
  const words1 = new Set(n1.split(/\s+/).filter(w => w.length > 2))
  const words2 = new Set(n2.split(/\s+/).filter(w => w.length > 2))

  if (words1.size === 0 || words2.size === 0) return 0

  let overlap = 0
  for (const w of words1) {
    if (words2.has(w)) overlap++
  }

  const total = Math.max(words1.size, words2.size)
  return overlap / total
}

function handleSimilarity(h1: string, h2: string): number {
  const n1 = normalizeHandle(h1)
  const n2 = normalizeHandle(h2)

  if (!n1 || !n2) return 0
  if (n1 === n2) return 1.0

  // Check if one contains the other (e.g. "vileda_es" vs "viledaes")
  if (n1.includes(n2) || n2.includes(n1)) {
    const longer = Math.max(n1.length, n2.length)
    const shorter = Math.min(n1.length, n2.length)
    return shorter / longer
  }

  return 0
}

// ============ MAIN MATCHING FUNCTION ============

export function matchClientToCreators(
  client: ClientContactData,
  creators: CreatorProfileData[]
): MatchResult[] {
  const results: MatchResult[] = []

  for (const creator of creators) {
    const signals: MatchSignal[] = []

    // --- Signal 1: Email exact match ---
    const clientEmail = normalizeEmail(client.contactEmail)
    const creatorEmail = normalizeEmail(creator.contactEmail)
    if (clientEmail && creatorEmail && clientEmail === creatorEmail) {
      signals.push({
        type: 'email_exact',
        weight: 50,
        detail: `Email match: ${clientEmail}`,
      })
    }

    // --- Signal 2: Domain match (email domain vs website) ---
    const clientDomain = extractDomain(client.contactEmail)
    const clientCompanyDomain = client.companyDomain ? extractDomainFromUrl(client.companyDomain) : ''
    const creatorWebDomain = extractDomainFromUrl(creator.websiteUrl)
    const creatorEmailDomain = extractDomain(creator.contactEmail)

    const domainsToCheck = [clientDomain, clientCompanyDomain].filter(Boolean)
    const creatorDomains = [creatorWebDomain, creatorEmailDomain].filter(Boolean)

    for (const cd of domainsToCheck) {
      for (const crd of creatorDomains) {
        if (cd && crd && cd === crd) {
          signals.push({
            type: 'domain_match',
            weight: 30,
            detail: `Domain match: ${cd}`,
          })
          break
        }
      }
    }

    // --- Signal 3: Handle exact match ---
    if (client.socialHandles && typeof client.socialHandles === 'object') {
      for (const [platform, handle] of Object.entries(client.socialHandles)) {
        for (const pp of creator.platformProfiles) {
          if (pp.platform.toLowerCase() === platform.toLowerCase()) {
            const sim = handleSimilarity(handle, pp.username)
            if (sim === 1.0) {
              signals.push({
                type: 'handle_exact',
                weight: 45,
                detail: `Handle exact match: @${pp.username} on ${pp.platform}`,
              })
            } else if (sim >= 0.8) {
              signals.push({
                type: 'handle_similar',
                weight: 20,
                detail: `Handle similar: ${handle} ≈ ${pp.username} on ${pp.platform}`,
              })
            }
          }
        }
      }
    }

    // --- Signal 4: Name + Company match ---
    const clientName = normalizeString(client.contactName)
    const creatorName = normalizeString(creator.displayName)
    const nameScore = nameSimilarity(client.contactName, creator.displayName || '')

    if (nameScore >= 0.8 && client.companyName) {
      // Check if company appears in creator bio or display name
      const companyNorm = normalizeString(client.companyName)
      for (const pp of creator.platformProfiles) {
        const bioNorm = normalizeString(pp.bio)
        if (bioNorm.includes(companyNorm) || normalizeString(pp.username).includes(companyNorm.replace(/\s+/g, ''))) {
          signals.push({
            type: 'name_company_match',
            weight: 35,
            detail: `Name "${client.contactName}" + company "${client.companyName}" found in profile`,
          })
          break
        }
      }
    }

    // --- Signal 5: Name-only match (weak) ---
    if (nameScore >= 0.9 && signals.length === 0) {
      const penalty = isCommonName(client.contactName) ? 0.5 : 1.0
      signals.push({
        type: 'name_only',
        weight: 15 * penalty,
        detail: `Name similarity: "${client.contactName}" ≈ "${creator.displayName}"${penalty < 1 ? ' (common name penalty)' : ''}`,
      })
    }

    // --- Signal 6: Bio mentions company ---
    if (client.companyName && signals.every(s => s.type !== 'name_company_match')) {
      const companyNorm = normalizeString(client.companyName)
      if (companyNorm.length >= 4) { // Skip very short company names
        for (const pp of creator.platformProfiles) {
          const bioNorm = normalizeString(pp.bio)
          if (bioNorm.includes(companyNorm)) {
            signals.push({
              type: 'bio_mentions_company',
              weight: 20,
              detail: `Bio mentions "${client.companyName}"`,
            })
            break
          }
        }
      }
    }

    // --- Calculate final score ---
    if (signals.length === 0) continue

    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0)
    // Normalize to 0-100 scale, cap at 100
    const rawScore = Math.min(totalWeight, 100)

    // Determine confidence level
    let confidenceLevel: 'EXACT' | 'PROBABLE' | 'POSSIBLE'
    if (rawScore >= 95 || signals.some(s => s.type === 'email_exact')) {
      confidenceLevel = 'EXACT'
    } else if (rawScore >= 70 || (signals.length >= 2 && rawScore >= 50)) {
      confidenceLevel = 'PROBABLE'
    } else {
      confidenceLevel = 'POSSIBLE'
    }

    // Rule: single weak signal cannot be PROBABLE
    if (signals.length === 1 && signals[0].weight < 30) {
      confidenceLevel = 'POSSIBLE'
    }

    results.push({
      creatorProfileId: creator.id,
      clientContactId: client.id,
      confidenceScore: rawScore / 100, // Store as 0.00-1.00
      confidenceLevel,
      signals,
    })
  }

  // Sort by confidence score descending
  return results.sort((a, b) => b.confidenceScore - a.confidenceScore)
}

// ============ WARM OPPORTUNITY SCORING ============

export interface WarmScoreInput {
  // Relationship data
  relationshipType: string
  relationshipStatus: string
  lastActivityAt: Date | null

  // Creator data
  followers: number
  engagementRate: number
  postsPerMonth: number // estimated from recent posts
  avgViews: number

  // Match data
  confidenceScore: number

  // Brand mentions
  hasMentionedBrand: boolean
  brandMentionCount: number

  // Content analysis
  hasConsistentContent: boolean
  promotionalRatio: number // 0-1, what % of posts are promos

  // Optional niche alignment
  nicheAlignment: number // 0-1
  geoAlignment: boolean
}

export interface WarmScoreResult {
  opportunityScore: number
  opportunityGrade: 'A' | 'B' | 'C' | 'D' | 'F'
  opportunityReasons: string[]
  riskFlags: string[]
  recommendedUse: string[]
  brandFitScore: number
  easeOfActivation: number
  expectedResponseRate: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW'
}

export function calculateWarmScore(input: WarmScoreInput): WarmScoreResult {
  const reasons: string[] = []
  const risks: string[] = []
  let score = 0
  let brandFit = 50
  let easeOfActivation = 50

  // ---- POSITIVE FACTORS ----

  // Relationship strength (max 25 points)
  if (input.relationshipStatus === 'ACTIVE') {
    if (input.relationshipType === 'CUSTOMER') {
      score += 20
      easeOfActivation += 20
      reasons.push('active_customer')
    } else if (input.relationshipType === 'PARTNER') {
      score += 18
      easeOfActivation += 15
      reasons.push('active_partner')
    } else {
      score += 12
      easeOfActivation += 10
      reasons.push('active_relationship')
    }
  } else if (input.relationshipStatus === 'INACTIVE') {
    const monthsAgo = input.lastActivityAt
      ? (Date.now() - input.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24 * 30)
      : 999
    if (monthsAgo <= 12) {
      score += 15
      easeOfActivation += 10
      reasons.push('recent_relationship')
    } else {
      score += 5
      reasons.push('past_relationship')
    }
  } else if (input.relationshipStatus === 'CHURNED') {
    score += 2
    easeOfActivation -= 10
    risks.push('churned_client')
  }

  // Content consistency (max 15 points)
  if (input.postsPerMonth >= 8) {
    score += 15
    reasons.push('very_consistent_content')
  } else if (input.postsPerMonth >= 4) {
    score += 10
    reasons.push('consistent_content')
  } else if (input.postsPerMonth >= 2) {
    score += 5
    reasons.push('some_content')
  } else {
    risks.push('low_content_frequency')
    score -= 5
  }

  // Engagement rate (max 10 points)
  if (input.engagementRate >= 5) {
    score += 10
    reasons.push('excellent_engagement')
  } else if (input.engagementRate >= 2) {
    score += 7
    reasons.push('good_engagement')
  } else if (input.engagementRate >= 1) {
    score += 3
    reasons.push('average_engagement')
  } else {
    risks.push('low_engagement')
  }

  // Audience size (max 10 points)
  if (input.followers >= 100000) {
    score += 10
    reasons.push('large_audience')
  } else if (input.followers >= 10000) {
    score += 8
    reasons.push('medium_audience')
  } else if (input.followers >= 1000) {
    score += 5
    reasons.push('small_audience')
  } else {
    score += 2
    risks.push('very_small_audience')
  }

  // Brand mentions (max 15 points)
  if (input.hasMentionedBrand) {
    if (input.brandMentionCount >= 3) {
      score += 15
      brandFit += 20
      reasons.push('multiple_organic_mentions')
    } else {
      score += 10
      brandFit += 10
      reasons.push('has_mentioned_brand')
    }
  }

  // Niche alignment (max 10 points)
  if (input.nicheAlignment >= 0.8) {
    score += 10
    brandFit += 15
    reasons.push('strong_niche_alignment')
  } else if (input.nicheAlignment >= 0.5) {
    score += 5
    brandFit += 5
    reasons.push('moderate_niche_alignment')
  } else if (input.nicheAlignment < 0.3) {
    risks.push('weak_niche_alignment')
    brandFit -= 15
  }

  // Geo alignment (max 5 points)
  if (input.geoAlignment) {
    score += 5
    reasons.push('geographic_alignment')
  }

  // Match confidence bonus (max 5 points)
  score += Math.round(input.confidenceScore * 5)

  // ---- NEGATIVE FACTORS ----

  // Promotional overload
  if (input.promotionalRatio > 0.5) {
    score -= 10
    brandFit -= 10
    risks.push('excessive_promotions')
  } else if (input.promotionalRatio > 0.3) {
    score -= 5
    risks.push('high_promotional_ratio')
  }

  // ---- CLAMP SCORES ----
  score = Math.max(0, Math.min(100, score))
  brandFit = Math.max(0, Math.min(100, brandFit))
  easeOfActivation = Math.max(0, Math.min(100, easeOfActivation))

  // ---- DETERMINE GRADE ----
  let grade: 'A' | 'B' | 'C' | 'D' | 'F'
  if (score >= 80) grade = 'A'
  else if (score >= 60) grade = 'B'
  else if (score >= 40) grade = 'C'
  else if (score >= 20) grade = 'D'
  else grade = 'F'

  // ---- RECOMMENDED USE ----
  const recommendedUse: string[] = []
  if (risks.includes('churned_client') || score < 20) {
    recommendedUse.push('not_recommended')
  } else {
    if (input.followers >= 10000 && input.engagementRate >= 2) {
      recommendedUse.push('influencer')
    }
    if (input.hasConsistentContent && brandFit >= 50) {
      recommendedUse.push('ugc_organic')
    }
    if (input.hasConsistentContent && input.engagementRate >= 1.5) {
      recommendedUse.push('ugc_ads')
    }
    if (recommendedUse.length === 0) {
      recommendedUse.push('ugc_organic') // Default fallback
    }
  }

  // ---- EXPECTED RESPONSE RATE ----
  let expectedResponseRate: 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW'
  if (input.relationshipStatus === 'ACTIVE' && input.confidenceScore >= 0.9) {
    expectedResponseRate = 'VERY_HIGH'
  } else if (input.relationshipStatus === 'ACTIVE' || input.confidenceScore >= 0.7) {
    expectedResponseRate = 'HIGH'
  } else if (input.confidenceScore >= 0.4) {
    expectedResponseRate = 'MEDIUM'
  } else {
    expectedResponseRate = 'LOW'
  }

  return {
    opportunityScore: score,
    opportunityGrade: grade,
    opportunityReasons: reasons,
    riskFlags: risks,
    recommendedUse,
    brandFitScore: brandFit,
    easeOfActivation,
    expectedResponseRate,
  }
}
