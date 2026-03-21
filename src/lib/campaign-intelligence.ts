/**
 * Campaign Intelligence Engine
 *
 * Transforms raw campaign data into actionable insights.
 * Evaluates performance based on campaign objective and generates
 * traffic-light signals + strategic recommendations.
 *
 * Philosophy: A tracker should help decide quickly if a campaign worked,
 * if it was efficient, and if we'd work with that influencer again.
 */

// ============ TYPES ============

export type CampaignObjective = 'awareness' | 'engagement' | 'traffic' | 'conversion' | 'content'

export type Signal = 'green' | 'yellow' | 'red' | 'gray'

export interface InfluencerKPIs {
  // Identity
  username: string
  platform: string
  influencerId: string

  // Raw data
  fee: number
  totalViews: number
  totalReach: number
  totalImpressions: number
  totalLikes: number
  totalComments: number
  totalShares: number
  totalSaves: number
  totalClicks: number
  totalLeads: number
  totalRevenue: number
  postsCount: number
  contentPieces: number

  // Calculated KPIs
  cpm: number | null        // Cost per mille (1000 views)
  cpv: number | null        // Cost per view
  cpe: number | null        // Cost per engagement
  cpc: number | null        // Cost per click
  cpa: number | null        // Cost per acquisition
  emv: number               // Earned media value
  emvCostRatio: number | null  // EMV / fee — above 1 = good value
  engagementRate: number | null // Total engagements / total views
  costPerContent: number | null // Fee / content pieces

  // Intelligence
  signal: Signal
  score: number              // 0-100
  recommendation: string     // Strategic recommendation text
  recommendationKey: string  // Machine-readable key
  highlights: string[]       // Key insights
}

export interface CampaignIntelligence {
  objective: CampaignObjective
  overallSignal: Signal
  overallScore: number
  overallRecommendation: string
  totalInvestment: number
  totalEMV: number
  emvRatio: number | null
  influencers: InfluencerKPIs[]
  topPerformer: string | null
  worstPerformer: string | null
}

// ============ THRESHOLDS ============
// Edit these to tune the intelligence engine

interface ObjectiveThresholds {
  // CPM thresholds (€ per 1000 views)
  cpmGreen: number
  cpmRed: number
  // CPE thresholds (€ per engagement)
  cpeGreen: number
  cpeRed: number
  // CPC thresholds (€ per click)
  cpcGreen: number
  cpcRed: number
  // CPA thresholds (€ per acquisition)
  cpaGreen: number
  cpaRed: number
  // EMV/Cost ratio
  emvRatioGreen: number
  emvRatioRed: number
  // Engagement rate thresholds (%)
  engRateGreen: number
  engRateRed: number
  // Metric weights for scoring (must sum to ~1.0)
  weights: {
    cpm: number
    cpe: number
    cpc: number
    cpa: number
    emvRatio: number
    engRate: number
    volume: number     // views/reach volume
    content: number    // content pieces delivered
  }
}

const THRESHOLDS: Record<CampaignObjective, ObjectiveThresholds> = {
  awareness: {
    cpmGreen: 12, cpmRed: 25,
    cpeGreen: 0.15, cpeRed: 0.50,
    cpcGreen: 0.50, cpcRed: 2.00,
    cpaGreen: 10, cpaRed: 30,
    emvRatioGreen: 2.0, emvRatioRed: 0.8,
    engRateGreen: 3, engRateRed: 1,
    weights: { cpm: 0.35, cpe: 0.10, cpc: 0.05, cpa: 0.00, emvRatio: 0.20, engRate: 0.10, volume: 0.20, content: 0.00 },
  },
  engagement: {
    cpmGreen: 15, cpmRed: 30,
    cpeGreen: 0.10, cpeRed: 0.40,
    cpcGreen: 0.80, cpcRed: 3.00,
    cpaGreen: 15, cpaRed: 40,
    emvRatioGreen: 2.5, emvRatioRed: 1.0,
    engRateGreen: 5, engRateRed: 2,
    weights: { cpm: 0.10, cpe: 0.35, cpc: 0.05, cpa: 0.00, emvRatio: 0.15, engRate: 0.30, volume: 0.05, content: 0.00 },
  },
  traffic: {
    cpmGreen: 15, cpmRed: 30,
    cpeGreen: 0.20, cpeRed: 0.60,
    cpcGreen: 0.30, cpcRed: 1.50,
    cpaGreen: 8, cpaRed: 25,
    emvRatioGreen: 1.5, emvRatioRed: 0.7,
    engRateGreen: 3, engRateRed: 1,
    weights: { cpm: 0.10, cpe: 0.10, cpc: 0.40, cpa: 0.05, emvRatio: 0.10, engRate: 0.10, volume: 0.10, content: 0.05 },
  },
  conversion: {
    cpmGreen: 20, cpmRed: 40,
    cpeGreen: 0.25, cpeRed: 0.80,
    cpcGreen: 0.50, cpcRed: 2.50,
    cpaGreen: 5, cpaRed: 20,
    emvRatioGreen: 3.0, emvRatioRed: 1.0,
    engRateGreen: 3, engRateRed: 1,
    weights: { cpm: 0.05, cpe: 0.05, cpc: 0.15, cpa: 0.40, emvRatio: 0.15, engRate: 0.05, volume: 0.05, content: 0.10 },
  },
  content: {
    cpmGreen: 20, cpmRed: 40,
    cpeGreen: 0.20, cpeRed: 0.60,
    cpcGreen: 1.00, cpcRed: 3.00,
    cpaGreen: 15, cpaRed: 40,
    emvRatioGreen: 1.5, emvRatioRed: 0.6,
    engRateGreen: 3, engRateRed: 1,
    weights: { cpm: 0.05, cpe: 0.10, cpc: 0.00, cpa: 0.00, emvRatio: 0.15, engRate: 0.10, volume: 0.10, content: 0.50 },
  },
}

// ============ SCORING FUNCTIONS ============

/**
 * Score a metric value against thresholds.
 * Returns 0-100 where 100 = best (green), 0 = worst (red).
 * For "lower is better" metrics like CPM, CPC, CPA, CPE.
 */
function scoreLowerIsBetter(value: number | null, greenThreshold: number, redThreshold: number): number | null {
  if (value === null || value <= 0) return null
  if (value <= greenThreshold) return 100
  if (value >= redThreshold) return 0
  // Linear interpolation between green and red
  return Math.round(((redThreshold - value) / (redThreshold - greenThreshold)) * 100)
}

/**
 * Score a metric where higher is better (EMV ratio, engagement rate).
 */
function scoreHigherIsBetter(value: number | null, greenThreshold: number, redThreshold: number): number | null {
  if (value === null) return null
  if (value >= greenThreshold) return 100
  if (value <= redThreshold) return 0
  return Math.round(((value - redThreshold) / (greenThreshold - redThreshold)) * 100)
}

/**
 * Convert a score (0-100) to a signal color.
 */
function scoreToSignal(score: number): Signal {
  if (score >= 65) return 'green'
  if (score >= 35) return 'yellow'
  return 'red'
}

// ============ KPI CALCULATIONS ============

interface RawInfluencerData {
  username: string
  platform: string
  influencerId: string
  fee: number
  media: Array<{
    likes: number
    comments: number
    shares: number
    saves: number
    views: number
    reach: number
    impressions: number
    mediaType: string
  }>
  clicks?: number
  leads?: number
  revenue?: number
  emv: number
  contentPieces?: number
}

function calculateInfluencerKPIs(
  data: RawInfluencerData,
  objective: CampaignObjective,
  thresholds: ObjectiveThresholds
): InfluencerKPIs {
  const { fee, media } = data

  // Aggregate raw metrics
  let totalViews = 0, totalReach = 0, totalImpressions = 0
  let totalLikes = 0, totalComments = 0, totalShares = 0, totalSaves = 0

  for (const m of media) {
    totalViews += m.views || 0
    totalReach += m.reach || 0
    totalImpressions += m.impressions || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalSaves += m.saves || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares + totalSaves
  const totalClicks = data.clicks || 0
  const totalLeads = data.leads || 0
  const totalRevenue = data.revenue || 0
  const contentPieces = data.contentPieces || media.length
  const bestViewMetric = totalImpressions || totalReach || totalViews

  // Calculate KPIs (null if data insufficient)
  const cpm = (fee > 0 && bestViewMetric > 0) ? (fee / bestViewMetric) * 1000 : null
  const cpv = (fee > 0 && totalViews > 0) ? fee / totalViews : null
  const cpe = (fee > 0 && totalEngagements > 0) ? fee / totalEngagements : null
  const cpc = (fee > 0 && totalClicks > 0) ? fee / totalClicks : null
  const cpa = (fee > 0 && totalLeads > 0) ? fee / totalLeads : null
  const emvCostRatio = (fee > 0 && data.emv > 0) ? data.emv / fee : null
  const engagementRate = bestViewMetric > 0 ? (totalEngagements / bestViewMetric) * 100 : null
  const costPerContent = (fee > 0 && contentPieces > 0) ? fee / contentPieces : null

  // Score each KPI
  const scores: { metric: string; score: number | null; weight: number }[] = [
    { metric: 'cpm', score: scoreLowerIsBetter(cpm, thresholds.cpmGreen, thresholds.cpmRed), weight: thresholds.weights.cpm },
    { metric: 'cpe', score: scoreLowerIsBetter(cpe, thresholds.cpeGreen, thresholds.cpeRed), weight: thresholds.weights.cpe },
    { metric: 'cpc', score: scoreLowerIsBetter(cpc, thresholds.cpcGreen, thresholds.cpcRed), weight: thresholds.weights.cpc },
    { metric: 'cpa', score: scoreLowerIsBetter(cpa, thresholds.cpaGreen, thresholds.cpaRed), weight: thresholds.weights.cpa },
    { metric: 'emvRatio', score: scoreHigherIsBetter(emvCostRatio, thresholds.emvRatioGreen, thresholds.emvRatioRed), weight: thresholds.weights.emvRatio },
    { metric: 'engRate', score: scoreHigherIsBetter(engagementRate, thresholds.engRateGreen, thresholds.engRateRed), weight: thresholds.weights.engRate },
  ]

  // Volume score (views): >500K = 100, <10K = 0
  const volumeScore = bestViewMetric > 0
    ? Math.min(100, Math.round((bestViewMetric / 500000) * 100))
    : null
  scores.push({ metric: 'volume', score: volumeScore, weight: thresholds.weights.volume })

  // Content score: delivered pieces vs expected (assume 1 per post minimum)
  const contentScore = contentPieces > 0 ? Math.min(100, contentPieces * 25) : null
  scores.push({ metric: 'content', score: contentScore, weight: thresholds.weights.content })

  // Weighted average score (only use metrics with data)
  const validScores = scores.filter(s => s.score !== null)
  const totalWeight = validScores.reduce((sum, s) => sum + s.weight, 0)
  const weightedScore = totalWeight > 0
    ? Math.round(validScores.reduce((sum, s) => sum + (s.score! * s.weight), 0) / totalWeight)
    : 0

  const signal = validScores.length > 0 ? scoreToSignal(weightedScore) : 'gray'

  // Generate highlights
  const highlights: string[] = []
  if (cpm !== null && cpm <= thresholds.cpmGreen) highlights.push(`CPM excelente: €${cpm.toFixed(2)}`)
  if (cpm !== null && cpm >= thresholds.cpmRed) highlights.push(`CPM alto: €${cpm.toFixed(2)}`)
  if (engagementRate !== null && engagementRate >= thresholds.engRateGreen) highlights.push(`Gran engagement: ${engagementRate.toFixed(2)}%`)
  if (emvCostRatio !== null && emvCostRatio >= thresholds.emvRatioGreen) highlights.push(`EMV/Coste: ${emvCostRatio.toFixed(1)}x`)
  if (bestViewMetric >= 100000) highlights.push(`Alto alcance: ${formatCompact(bestViewMetric)} views`)

  // Generate recommendation
  const { recommendation, recommendationKey } = generateRecommendation(
    objective, signal, weightedScore, {
      cpm, cpv, cpe, cpc, cpa, emvCostRatio, engagementRate,
      fee, totalViews: bestViewMetric, totalEngagements, contentPieces,
    }
  )

  return {
    username: data.username,
    platform: data.platform,
    influencerId: data.influencerId,
    fee,
    totalViews,
    totalReach,
    totalImpressions,
    totalLikes,
    totalComments,
    totalShares,
    totalSaves,
    totalClicks,
    totalLeads,
    totalRevenue,
    postsCount: media.length,
    contentPieces,
    cpm, cpv, cpe, cpc, cpa,
    emv: data.emv,
    emvCostRatio,
    engagementRate,
    costPerContent,
    signal,
    score: weightedScore,
    recommendation,
    recommendationKey,
    highlights,
  }
}

// ============ RECOMMENDATION ENGINE ============

interface RecommendationContext {
  cpm: number | null
  cpv: number | null
  cpe: number | null
  cpc: number | null
  cpa: number | null
  emvCostRatio: number | null
  engagementRate: number | null
  fee: number
  totalViews: number
  totalEngagements: number
  contentPieces: number
}

function generateRecommendation(
  objective: CampaignObjective,
  signal: Signal,
  score: number,
  ctx: RecommendationContext
): { recommendation: string; recommendationKey: string } {
  // No data
  if (signal === 'gray') {
    return { recommendation: 'Faltan datos para evaluar', recommendationKey: 'no_data' }
  }

  // Objective-specific recommendations
  switch (objective) {
    case 'awareness':
      if (signal === 'green') {
        if (ctx.emvCostRatio && ctx.emvCostRatio >= 3) {
          return { recommendation: 'Contratar de nuevo. Excelente relación visibilidad/coste', recommendationKey: 'rehire_excellent' }
        }
        return { recommendation: 'Buen perfil para awareness. Resultados sólidos en alcance', recommendationKey: 'rehire_good_awareness' }
      }
      if (signal === 'yellow') {
        if (ctx.cpm && ctx.cpm > 20) {
          return { recommendation: 'Renegociar fee. Buen alcance pero CPM elevado', recommendationKey: 'renegotiate_cpm' }
        }
        return { recommendation: 'Resultado aceptable pero no sobresaliente. Revisar alternativas', recommendationKey: 'review_alternatives' }
      }
      return { recommendation: 'No recomendable para awareness a este coste. Bajo retorno en visibilidad', recommendationKey: 'not_recommended_awareness' }

    case 'engagement':
      if (signal === 'green') {
        if (ctx.engagementRate && ctx.engagementRate >= 5) {
          return { recommendation: 'Contratar de nuevo. Audiencia muy comprometida', recommendationKey: 'rehire_engagement' }
        }
        return { recommendation: 'Buen creador para engagement. Interacciones de calidad', recommendationKey: 'good_engagement' }
      }
      if (signal === 'yellow') {
        return { recommendation: 'Engagement medio. Valorar si el perfil encaja con la marca', recommendationKey: 'medium_engagement' }
      }
      if (ctx.totalViews > 100000) {
        return { recommendation: 'Buen alcance pero bajo engagement. Mejor para awareness que para interacción', recommendationKey: 'good_reach_low_engagement' }
      }
      return { recommendation: 'No recomendable para engagement. Baja interacción con su audiencia', recommendationKey: 'not_recommended_engagement' }

    case 'traffic':
      if (signal === 'green') {
        return { recommendation: 'Contratar de nuevo. Genera tráfico a buen coste', recommendationKey: 'rehire_traffic' }
      }
      if (signal === 'yellow') {
        if (ctx.cpc && ctx.cpc > 1) {
          return { recommendation: 'Renegociar. CPC aceptable pero mejorable', recommendationKey: 'renegotiate_cpc' }
        }
        return { recommendation: 'Resultado medio en tráfico. Probar con CTA más directo', recommendationKey: 'medium_traffic' }
      }
      return { recommendation: 'No recomendable para tráfico. CPC demasiado alto', recommendationKey: 'not_recommended_traffic' }

    case 'conversion':
      if (signal === 'green') {
        if (ctx.cpa && ctx.cpa < 5) {
          return { recommendation: 'Contratar de nuevo. CPA excelente. Alto ROI', recommendationKey: 'rehire_conversion' }
        }
        return { recommendation: 'Buen perfil para conversión. Resultados rentables', recommendationKey: 'good_conversion' }
      }
      if (signal === 'yellow') {
        return { recommendation: 'Conversión media. Optimizar landing o creatividad antes de repetir', recommendationKey: 'medium_conversion' }
      }
      if (ctx.engagementRate && ctx.engagementRate >= 3) {
        return { recommendation: 'Buen creador para contenido, no para performance. Reubicar en awareness', recommendationKey: 'redirect_to_awareness' }
      }
      return { recommendation: 'No recomendable para conversión a este coste', recommendationKey: 'not_recommended_conversion' }

    case 'content':
      if (signal === 'green') {
        return { recommendation: 'Contratar de nuevo. Buen contenido a precio razonable', recommendationKey: 'rehire_content' }
      }
      if (signal === 'yellow') {
        if (ctx.contentPieces >= 3) {
          return { recommendation: 'Buen volumen de contenido. Renegociar precio para repetir', recommendationKey: 'renegotiate_content' }
        }
        return { recommendation: 'Contenido aceptable. Valorar calidad vs coste', recommendationKey: 'review_content_quality' }
      }
      return { recommendation: 'No recomendable. Coste por contenido demasiado alto', recommendationKey: 'not_recommended_content' }
  }
}

// ============ MAIN FUNCTION ============

export interface CampaignIntelligenceInput {
  objective: CampaignObjective
  influencers: RawInfluencerData[]
}

export function analyzeCampaign(input: CampaignIntelligenceInput): CampaignIntelligence {
  const { objective } = input
  const thresholds = THRESHOLDS[objective]

  const influencerKPIs = input.influencers.map(inf =>
    calculateInfluencerKPIs(inf, objective, thresholds)
  )

  // Overall metrics
  const totalInvestment = influencerKPIs.reduce((sum, i) => sum + i.fee, 0)
  const totalEMV = influencerKPIs.reduce((sum, i) => sum + i.emv, 0)
  const emvRatio = totalInvestment > 0 ? totalEMV / totalInvestment : null

  // Overall score = average of influencer scores (weighted by fee)
  const totalFee = influencerKPIs.reduce((sum, i) => sum + (i.fee || 1), 0)
  const overallScore = totalFee > 0
    ? Math.round(influencerKPIs.reduce((sum, i) => sum + (i.score * (i.fee || 1)), 0) / totalFee)
    : 0
  const overallSignal = influencerKPIs.length > 0 ? scoreToSignal(overallScore) : 'gray'

  // Find top and worst performers
  const sorted = [...influencerKPIs].sort((a, b) => b.score - a.score)
  const topPerformer = sorted.length > 0 ? sorted[0].username : null
  const worstPerformer = sorted.length > 1 ? sorted[sorted.length - 1].username : null

  // Overall recommendation
  let overallRecommendation = ''
  if (overallSignal === 'green') {
    overallRecommendation = `Campaña exitosa. ${objective === 'awareness' ? 'Gran visibilidad obtenida' : objective === 'engagement' ? 'Alta interacción lograda' : objective === 'traffic' ? 'Buen tráfico generado' : objective === 'conversion' ? 'Conversiones rentables' : 'Contenido de calidad entregado'}.`
  } else if (overallSignal === 'yellow') {
    overallRecommendation = `Resultados mixtos. Revisar qué perfiles funcionaron y optimizar la selección para la próxima campaña.`
  } else if (overallSignal === 'red') {
    overallRecommendation = `Campaña por debajo de expectativas. Revisar la selección de perfiles, el fee negociado y la alineación con el objetivo.`
  } else {
    overallRecommendation = `Datos insuficientes para evaluar. Espera a que se recopilen más métricas.`
  }

  return {
    objective,
    overallSignal,
    overallScore,
    overallRecommendation,
    totalInvestment,
    totalEMV,
    emvRatio,
    influencers: influencerKPIs,
    topPerformer,
    worstPerformer,
  }
}

// ============ HELPERS ============

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

/**
 * Get the list of valid objectives for UI dropdowns.
 */
export const CAMPAIGN_OBJECTIVES: { value: CampaignObjective; labelEs: string; labelEn: string; icon: string }[] = [
  { value: 'awareness', labelEs: 'Visibilidad / Awareness', labelEn: 'Awareness / Visibility', icon: '👁️' },
  { value: 'engagement', labelEs: 'Engagement / Interacción', labelEn: 'Engagement / Interaction', icon: '💬' },
  { value: 'traffic', labelEs: 'Tráfico web', labelEn: 'Web Traffic', icon: '🔗' },
  { value: 'conversion', labelEs: 'Conversión / Ventas', labelEn: 'Conversion / Sales', icon: '💰' },
  { value: 'content', labelEs: 'Contenido / UGC', labelEn: 'Content / UGC', icon: '🎬' },
]

/**
 * Get display config for a signal color.
 */
export function getSignalConfig(signal: Signal) {
  switch (signal) {
    case 'green': return { color: 'text-green-700', bg: 'bg-green-100', border: 'border-green-300', dot: 'bg-green-500', label: '✅' }
    case 'yellow': return { color: 'text-yellow-700', bg: 'bg-yellow-100', border: 'border-yellow-300', dot: 'bg-yellow-500', label: '⚠️' }
    case 'red': return { color: 'text-red-700', bg: 'bg-red-100', border: 'border-red-300', dot: 'bg-red-500', label: '🔴' }
    default: return { color: 'text-gray-500', bg: 'bg-gray-100', border: 'border-gray-300', dot: 'bg-gray-400', label: '⏳' }
  }
}

/**
 * Format currency value.
 */
export function formatCurrency(value: number | null): string {
  if (value === null || value === undefined) return '—'
  return `€${value.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Format KPI value with appropriate precision.
 */
export function formatKPI(value: number | null, suffix = ''): string {
  if (value === null || value === undefined) return '—'
  if (value >= 1000) return `${formatCompact(value)}${suffix}`
  return `${value.toFixed(2)}${suffix}`
}
