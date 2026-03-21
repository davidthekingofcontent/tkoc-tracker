// EMV (Earned Media Value) Calculator
// Formula: EMV = (Views / 1000 × CPM) + (Clicks × CPC) + Engagement Value
// ONLY uses real data — never estimates or invents numbers

export interface EMVInput {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | string
  impressions: number
  reach: number
  views: number
  clicks: number       // Usually 0 (not available from scraping)
  likes: number
  comments: number
  shares: number
  saves: number        // Instagram: saves, TikTok: favorites
}

export interface EMVResult {
  basic: number     // Reach/views component only
  extended: number  // Full formula with engagement
  breakdown: {
    reachComponent: number
    clicksComponent: number
    engagementComponent: number
  }
}

// Industry CPM rates by platform (€ per 1,000 impressions)
// Based on European market averages 2025-2026
const CPM_RATES = {
  INSTAGRAM: {
    post: 8.50,
    reel: 12.00,
    story: 5.00,
  },
  TIKTOK: {
    video: 7.50,
    viral: 5.00,
  },
  YOUTUBE: {
    video: 15.00,
    short: 6.00,
  },
}

// CPC (Cost Per Click) — €0.50 default
const CPC = 0.50

// Engagement value rates (€ per action)
const ENGAGEMENT_VALUES = {
  INSTAGRAM: {
    like: 0.10,
    comment: 0.80,
    share: 1.50,
    save: 1.20,
  },
  TIKTOK: {
    like: 0.08,
    comment: 0.60,
    share: 1.20,
    save: 0.90,
  },
  YOUTUBE: {
    like: 0.12,
    comment: 1.00,
    share: 1.50,
    save: 0.00,
  },
}

export function calculateEMV(input: EMVInput): EMVResult {
  const platform = input.platform.toUpperCase() as keyof typeof CPM_RATES
  const platformKey = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(platform) ? platform : 'INSTAGRAM'

  // Use ONLY real data: impressions > reach > views (whichever is available)
  const realViews = input.impressions || input.reach || input.views || 0

  // CPM rate for platform
  const cpmRate = platformKey === 'TIKTOK'
    ? CPM_RATES.TIKTOK.video
    : platformKey === 'YOUTUBE'
      ? CPM_RATES.YOUTUBE.video
      : CPM_RATES.INSTAGRAM.reel

  // 1. Reach component: (views / 1000) × CPM — only with real data
  const reachComponent = (realViews / 1000) * cpmRate

  // 2. Clicks component: clicks × CPC
  const clicksComponent = input.clicks * CPC

  // 3. Engagement component: sum of real interactions × value per action
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
  en: 'EMV = (Views/1000 × CPM) + (Clicks × CPC) + Engagement Value. Uses only real data from scraped posts. If a post has no views/impressions data, only engagement value is counted.',
  es: 'EMV = (Views/1000 × CPM) + (Clics × CPC) + Valor del engagement. Usa solo datos reales de los posts capturados. Si un post no tiene datos de views/impresiones, solo se cuenta el valor del engagement.',
}
