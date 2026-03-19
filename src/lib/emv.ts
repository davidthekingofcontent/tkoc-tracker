// EMV (Earned Media Value) Calculator
// Based on TKOC custom formula

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

export function calculateEMV(input: EMVInput): EMVResult {
  const platform = input.platform.toUpperCase()

  // Use best available proxy for impressions: impressions > reach > views
  const proxyImpressions = input.impressions || input.reach || input.views || 0

  if (platform === 'TIKTOK') {
    // TikTok EMV
    const reachComponent = (input.views / 1000) * 7.5
    const clicksComponent = input.clicks * 0.50
    const engagementComponent =
      (input.likes * 0.025) +
      (input.comments * 0.15) +
      (input.shares * 0.22) +
      (input.saves * 0.18) // favorites

    return {
      basic: Math.round(reachComponent * 100) / 100,
      extended: Math.round((reachComponent + clicksComponent + engagementComponent) * 100) / 100,
      breakdown: {
        reachComponent: Math.round(reachComponent * 100) / 100,
        clicksComponent: Math.round(clicksComponent * 100) / 100,
        engagementComponent: Math.round(engagementComponent * 100) / 100,
      },
    }
  }

  // Instagram (default)
  const reachComponent = (proxyImpressions / 1000) * 8
  const clicksComponent = input.clicks * 0.36
  const engagementComponent =
    (input.likes * 0.03) +
    (input.comments * 0.18) +
    (input.shares * 0.25) +
    (input.saves * 0.20)

  return {
    basic: Math.round(reachComponent * 100) / 100,
    extended: Math.round((reachComponent + clicksComponent + engagementComponent) * 100) / 100,
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
  en: 'EMV is an estimate of the equivalent cost of achieving similar reach, interaction, and intent through paid media. It does not represent sales or direct ROI.',
  es: 'El EMV es una estimación del coste equivalente que habría supuesto obtener un alcance, interacción e intención similares mediante medios pagados. No representa ventas ni ROI directo.',
}
