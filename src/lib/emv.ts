// EMV (Earned Media Value) Calculator
// Based on industry standards adapted for TKOC
//
// Sources: Influencer Marketing Hub, AInfluencer, CreatorIQ benchmarks
// CPM rates calibrated for European/Spanish market 2025-2026

export interface EMVInput {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | string
  impressions: number  // Use reach or views as proxy if 0
  reach: number
  views: number
  clicks: number       // Usually 0 (not available from scraping)
  likes: number
  comments: number
  shares: number
  saves: number        // Instagram: saves, TikTok: favorites
  followers?: number   // Used to estimate reach when no data available
}

export interface EMVResult {
  basic: number     // Reach/impressions only
  extended: number  // Full formula with engagement
  breakdown: {
    reachComponent: number
    clicksComponent: number
    engagementComponent: number
  }
}

/**
 * Estimate reach when we don't have real reach/impressions data.
 *
 * Instagram avg reach rates (% of followers):
 * - Posts: 20-35% for <10K, 15-25% for 10K-100K, 10-15% for 100K-1M, 5-10% for >1M
 * - Reels: 30-50% for <10K, 20-35% for 10K-100K, 15-25% for 100K-1M, 10-20% for >1M
 *
 * When we have engagement data, we can reverse-estimate:
 * avg IG engagement rate ~1-3%, so reach ≈ (likes + comments) / 0.02
 */
function estimateReach(input: EMVInput): number {
  // 1. If we have real impressions, reach, or views, use those
  const directData = input.impressions || input.reach || input.views
  if (directData > 0) return directData

  // 2. If we have followers, estimate reach based on platform averages
  if (input.followers && input.followers > 0) {
    const platform = input.platform.toUpperCase()
    let reachRate: number

    if (platform === 'TIKTOK') {
      // TikTok has higher organic reach
      if (input.followers < 10000) reachRate = 0.40
      else if (input.followers < 100000) reachRate = 0.25
      else if (input.followers < 1000000) reachRate = 0.15
      else reachRate = 0.10
    } else if (platform === 'YOUTUBE') {
      // YouTube reach is view-based
      if (input.followers < 10000) reachRate = 0.30
      else if (input.followers < 100000) reachRate = 0.20
      else if (input.followers < 1000000) reachRate = 0.12
      else reachRate = 0.08
    } else {
      // Instagram
      if (input.followers < 10000) reachRate = 0.30
      else if (input.followers < 100000) reachRate = 0.20
      else if (input.followers < 1000000) reachRate = 0.12
      else reachRate = 0.07
    }

    return Math.round(input.followers * reachRate)
  }

  // 3. Last resort: estimate from engagement (likes + comments)
  // Typical engagement rate is ~2% of people who see a post
  const totalEngagement = input.likes + input.comments
  if (totalEngagement > 0) {
    return Math.round(totalEngagement / 0.02) // ~2% interaction rate
  }

  return 0
}

// Industry CPM rates by platform (€ per 1,000 impressions)
// Based on European market averages 2025-2026
const CPM_RATES = {
  INSTAGRAM: {
    post: 8.50,    // Static posts
    reel: 12.00,   // Reels (higher due to algorithm boost)
    story: 5.00,   // Stories (lower retention)
  },
  TIKTOK: {
    video: 7.50,   // Standard videos
    viral: 5.00,   // Viral content (lower CPM at scale)
  },
  YOUTUBE: {
    video: 15.00,  // Standard videos (highest CPM)
    short: 6.00,   // YouTube Shorts
  },
}

// Engagement value rates (€ per action)
// Based on what advertisers would pay for equivalent actions
const ENGAGEMENT_VALUES = {
  INSTAGRAM: {
    like: 0.10,       // Low intent but high volume
    comment: 0.80,    // High intent, requires effort
    share: 1.50,      // Very high value - viral distribution
    save: 1.20,       // High intent - content marked for later
  },
  TIKTOK: {
    like: 0.08,
    comment: 0.60,
    share: 1.20,
    save: 0.90,       // favorites
  },
  YOUTUBE: {
    like: 0.12,
    comment: 1.00,
    share: 1.50,
    save: 0.00,       // not applicable
  },
}

export function calculateEMV(input: EMVInput): EMVResult {
  const platform = input.platform.toUpperCase() as keyof typeof CPM_RATES
  const platformKey = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(platform) ? platform : 'INSTAGRAM'

  // Estimate reach if not directly available
  const estimatedReach = estimateReach(input)

  // Get CPM for platform (use standard post/video rate)
  const cpmRate = platformKey === 'TIKTOK'
    ? CPM_RATES.TIKTOK.video
    : platformKey === 'YOUTUBE'
      ? CPM_RATES.YOUTUBE.video
      : CPM_RATES.INSTAGRAM.reel // Use reel CPM as default (most common format now)

  // 1. Reach component: (reach / 1000) × CPM
  const reachComponent = (estimatedReach / 1000) * cpmRate

  // 2. Clicks component (usually 0 from scraping, kept for future API data)
  const clicksComponent = input.clicks * 0.50

  // 3. Engagement component
  const engValues = ENGAGEMENT_VALUES[platformKey] || ENGAGEMENT_VALUES.INSTAGRAM
  const engagementComponent =
    (input.likes * engValues.like) +
    (input.comments * engValues.comment) +
    (input.shares * engValues.share) +
    (input.saves * engValues.save)

  const basic = Math.round(reachComponent * 100) / 100
  const extended = Math.round((reachComponent + clicksComponent + engagementComponent) * 100) / 100

  return {
    basic,
    extended,
    breakdown: {
      reachComponent: Math.round(reachComponent * 100) / 100,
      clicksComponent: Math.round(clicksComponent * 100) / 100,
      engagementComponent: Math.round(engagementComponent * 100) / 100,
    },
  }
}

export function calculateCampaignEMV(media: Array<{
  platform: string
  impressions?: number
  reach?: number
  views?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
  followers?: number
}>): { basic: number; extended: number } {
  let totalBasic = 0
  let totalExtended = 0

  for (const m of media) {
    const result = calculateEMV({
      platform: m.platform || 'INSTAGRAM',
      impressions: m.impressions || 0,
      reach: m.reach || 0,
      views: m.views || 0,
      clicks: 0,
      likes: m.likes || 0,
      comments: m.comments || 0,
      shares: m.shares || 0,
      saves: m.saves || 0,
      followers: m.followers || 0,
    })
    totalBasic += result.basic
    totalExtended += result.extended
  }

  return {
    basic: Math.round(totalBasic * 100) / 100,
    extended: Math.round(totalExtended * 100) / 100,
  }
}

export const EMV_METHODOLOGY = {
  en: 'EMV is an estimate of the equivalent cost of achieving similar reach, interaction, and intent through paid media. When reach data is not available from scraping, it is estimated based on follower count and platform-specific average reach rates. It does not represent sales or direct ROI.',
  es: 'El EMV es una estimación del coste equivalente que habría supuesto obtener un alcance, interacción e intención similares mediante medios pagados. Cuando los datos de alcance no están disponibles del scraping, se estiman en base a los seguidores y las tasas medias de alcance por plataforma. No representa ventas ni ROI directo.',
}
