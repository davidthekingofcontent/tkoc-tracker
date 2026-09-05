/**
 * Campaign Intelligence Engine
 *
 * Transforms raw campaign data into actionable insights.
 * Evaluates performance based on campaign objective and generates
 * traffic-light signals + strategic recommendations.
 *
 * Philosophy: A tracker should help decide quickly if a campaign worked,
 * if it was efficient, and if we'd work with that influencer again.
 *
 * Figures: whenever the caller has the campaign overview
 * (src/lib/campaign-overview.ts → PerInfluencerMetrics) it hands the engine
 * each creator's precomputed totals — views, audience (alcance → impresiones →
 * vistas → estimaciones etiquetadas, decision 5), the four-term interacciones
 * (3A), ER (4C), CPM, cost (6) and EMV — and the engine scores those as they
 * are, so the Aprender tab can never disagree with Resumen or Elegir. Media
 * rows are only a fallback when no overview is available.
 *
 * Wording: EMV ÷ fee is the "Ratio EMV" (×2,4) and is never called ROI; the
 * word ROI is reserved for real client data (decision 9B). Every text carries a
 * stable key (recommendationKey / overallRecommendationKey) that the UI resolves
 * in translations.*.intelligence; the Spanish string here is the fallback.
 */

import { audienceOf, cpmOf } from '@/lib/metrics'
import { formatEur, formatNumber, formatPercent, formatRatio } from '@/lib/utils'

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
  /** Audience base of the CPM and the ER: reach → impressions → views → labelled estimates (decision 5). */
  totalAudience: number
  /** Split figures below are 0 when the creator was scored from precomputed totals (the overview carries only their sums). */
  totalReach: number
  totalImpressions: number
  totalLikes: number
  totalComments: number
  totalShares: number
  totalSaves: number
  /** Interacciones (decision 3A): likes + comments + shares + saves. */
  totalEngagements: number
  totalClicks: number
  totalLeads: number
  totalRevenue: number
  postsCount: number
  contentPieces: number

  // Calculated KPIs
  cpm: number | null        // Cost per mille of audience
  cpv: number | null        // Cost per view
  cpe: number | null        // Cost per engagement
  cpc: number | null        // Cost per click
  cpa: number | null        // Cost per acquisition
  emv: number               // Earned media value
  emvCostRatio: number | null  // EMV / fee — the "Ratio EMV", above 1 = good value
  engagementRate: number | null // Total engagements / audience, in %
  costPerContent: number | null // Fee / content pieces

  // Intelligence
  signal: Signal
  score: number              // 0-100
  recommendation: string     // Strategic recommendation text (Spanish fallback)
  recommendationKey: string  // Machine-readable key, resolved in translations.*.intelligence
  highlights: string[]       // Key insights
}

export interface CampaignIntelligence {
  objective: CampaignObjective
  overallSignal: Signal
  overallScore: number
  overallRecommendation: string     // Spanish fallback
  overallRecommendationKey: string  // Resolved in translations.*.intelligence
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
  // CPM thresholds (€ per 1000 of audience)
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
    volume: number     // audience volume
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
  if (score >= 25) return 'yellow'
  return 'red'
}

// ============ KPI CALCULATIONS ============

/**
 * Per-creator figures already computed by the campaign overview
 * (PerInfluencerMetrics, src/lib/campaign-overview.ts). When present the engine
 * uses them verbatim and ignores `media`, so the Aprender table shows the same
 * numbers as the Resumen and Elegir cards.
 */
export interface PrecomputedInfluencerTotals {
  /** Real views of the creator's publications (perInfluencer.views). */
  views: number
  /** Audience base — reach → impressions → views → labelled estimates (perInfluencer.audience.total). */
  audience: number
  /** Interacciones: likes + comments + shares + saves (perInfluencer.engagements). */
  engagements: number
  /** Publications delivered in the campaign (perInfluencer.media). */
  pieces: number
  /** Cost of the creator: fee acordado, si no coste (perInfluencer.cost). */
  fee: number
  /** EMV extended with the brand's rates (perInfluencer.emvExtended). */
  emv: number
  /** Engagement rate in %, null without an audience base (perInfluencer.er.value). */
  er: number | null
  /** € per 1000 of audience, null without cost or base (perInfluencer.cpm). */
  cpm: number | null
}

/** One media row of the fallback path (no overview available). */
export interface RawInfluencerMediaRow {
  likes: number
  comments: number
  shares: number
  saves: number
  views: number
  reach: number
  impressions: number
  /** Media type as stored (REEL, POST, STORY…) — informational, the engine does not score by type. */
  mediaType?: string | null
}

export interface RawInfluencerData {
  username: string
  platform: string
  influencerId: string
  /** Cost of the creator (fee acordado, si no coste). Superseded by totals.fee when totals are given. */
  fee: number
  /** EMV of the creator. Superseded by totals.emv when totals are given. */
  emv: number
  /** Authoritative figures from the campaign overview — preferred whenever available. */
  totals?: PrecomputedInfluencerTotals | null
  /** Fallback only: the creator's media rows when no overview is available. */
  media?: RawInfluencerMediaRow[]
  clicks?: number
  leads?: number
  revenue?: number
  contentPieces?: number
}

function calculateInfluencerKPIs(
  data: RawInfluencerData,
  objective: CampaignObjective,
  thresholds: ObjectiveThresholds
): InfluencerKPIs {
  const totals = data.totals ?? null
  const media = data.media ?? []

  // Raw metrics: taken from the overview when it is there, aggregated from rows otherwise
  let totalViews = 0, totalAudience = 0, totalReach = 0, totalImpressions = 0
  let totalLikes = 0, totalComments = 0, totalShares = 0, totalSaves = 0
  let totalEngagements = 0

  if (totals) {
    totalViews = totals.views
    totalAudience = totals.audience
    totalEngagements = totals.engagements
  } else {
    for (const m of media) {
      totalViews += m.views || 0
      totalReach += m.reach || 0
      totalImpressions += m.impressions || 0
      totalLikes += m.likes || 0
      totalComments += m.comments || 0
      totalShares += m.shares || 0
      totalSaves += m.saves || 0
      // Audience per publication (decision 5) — real bases only: the fallback has
      // no follower / EMV context to label estimates, so a row without data adds 0.
      totalAudience += audienceOf({ id: '', ...m }, {}).value
    }
    // Interacciones (decision 3A)
    totalEngagements = totalLikes + totalComments + totalShares + totalSaves
  }

  const fee = totals ? totals.fee : data.fee
  const emv = totals ? totals.emv : data.emv
  const totalClicks = data.clicks || 0
  const totalLeads = data.leads || 0
  const totalRevenue = data.revenue || 0
  const postsCount = totals ? totals.pieces : media.length
  const contentPieces = totals ? totals.pieces : (data.contentPieces || media.length)

  // Calculate KPIs (null if data insufficient). CPM and ER over the audience (decisions 4C / 5).
  const cpm = totals ? totals.cpm : cpmOf(fee, totalAudience)
  const cpv = (fee > 0 && totalViews > 0) ? fee / totalViews : null
  const cpe = (fee > 0 && totalEngagements > 0) ? fee / totalEngagements : null
  const cpc = (fee > 0 && totalClicks > 0) ? fee / totalClicks : null
  const cpa = (fee > 0 && totalLeads > 0) ? fee / totalLeads : null
  const emvCostRatio = (fee > 0 && emv > 0) ? emv / fee : null
  const engagementRate = totals
    ? totals.er
    : (totalAudience > 0 ? Math.round((totalEngagements / totalAudience) * 100 * 100) / 100 : null)
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

  // Volume score (audience): >500K = 100, <10K = 0
  const volumeScore = totalAudience > 0
    ? Math.min(100, Math.round((totalAudience / 500000) * 100))
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

  // Require a minimum of scored metrics before judging a creator: with only
  // 1-2 data points (e.g. a post captured but no views/fee yet) the weighted
  // score reads like a disaster when the truth is we simply lack data.
  // Below the minimum the creator is shown as unscored (gray, "Faltan datos").
  const MIN_METRICS_TO_SCORE = 3
  const signal = validScores.length >= MIN_METRICS_TO_SCORE ? scoreToSignal(weightedScore) : 'gray'

  // Generate highlights (Spanish, internal — not rendered by the panel)
  const highlights: string[] = []
  if (cpm !== null && cpm <= thresholds.cpmGreen) highlights.push(`CPM excelente: ${formatEur(cpm, { maxFractionDigits: 2 })}`)
  if (cpm !== null && cpm >= thresholds.cpmRed) highlights.push(`CPM alto: ${formatEur(cpm, { maxFractionDigits: 2 })}`)
  if (engagementRate !== null && engagementRate >= thresholds.engRateGreen) highlights.push(`Gran engagement: ${formatPercent(engagementRate)}`)
  if (emvCostRatio !== null && emvCostRatio >= thresholds.emvRatioGreen) highlights.push(`Ratio EMV: ${formatRatio(emvCostRatio)}`)
  if (totalAudience >= 100000) highlights.push(`Alto alcance: ${formatNumber(totalAudience)}`)

  // Generate recommendation
  const { recommendation, recommendationKey } = generateRecommendation(
    objective, signal, weightedScore, {
      cpm, cpv, cpe, cpc, cpa, emvCostRatio, engagementRate,
      fee, audience: totalAudience, totalEngagements, contentPieces,
    }
  )

  return {
    username: data.username,
    platform: data.platform,
    influencerId: data.influencerId,
    fee,
    totalViews,
    totalAudience,
    totalReach,
    totalImpressions,
    totalLikes,
    totalComments,
    totalShares,
    totalSaves,
    totalEngagements,
    totalClicks,
    totalLeads,
    totalRevenue,
    postsCount,
    contentPieces,
    cpm, cpv, cpe, cpc, cpa,
    emv,
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
  /** Audience base (reach → impressions → views → estimates). */
  audience: number
  totalEngagements: number
  contentPieces: number
}

/**
 * Recommendation text (Spanish fallback) + its key. Every key exists in
 * translations.es.intelligence and translations.en.intelligence.
 */
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
      if (ctx.audience > 100000) {
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
          return { recommendation: 'Contratar de nuevo. CPA excelente', recommendationKey: 'rehire_conversion' }
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
  // An objective the engine does not know (a legacy value stored through PUT)
  // is scored as awareness instead of dereferencing undefined thresholds.
  const objective: CampaignObjective = THRESHOLDS[input.objective] ? input.objective : 'awareness'
  const thresholds = THRESHOLDS[objective]

  const influencerKPIs = input.influencers.map(inf =>
    calculateInfluencerKPIs(inf, objective, thresholds)
  )

  // Overall metrics
  const totalInvestment = influencerKPIs.reduce((sum, i) => sum + i.fee, 0)
  const totalEMV = influencerKPIs.reduce((sum, i) => sum + i.emv, 0)
  const emvRatio = totalInvestment > 0 ? totalEMV / totalInvestment : null

  // Overall score = average of SCORED influencer scores (weighted by fee).
  // Unscored creators (gray, insufficient data) are excluded — they'd drag a
  // healthy campaign into the red just because their data hasn't arrived yet.
  const scoredKPIs = influencerKPIs.filter(i => i.signal !== 'gray')
  const totalFee = scoredKPIs.reduce((sum, i) => sum + (i.fee || 1), 0)
  const overallScore = totalFee > 0
    ? Math.round(scoredKPIs.reduce((sum, i) => sum + (i.score * (i.fee || 1)), 0) / totalFee)
    : 0
  const overallSignal = scoredKPIs.length > 0 ? scoreToSignal(overallScore) : 'gray'

  // Find top and worst performers — only among scored creators
  const sorted = [...scoredKPIs].sort((a, b) => b.score - a.score)
  const topPerformer = sorted.length > 0 ? sorted[0].username : null
  const worstPerformer = sorted.length > 1 ? sorted[sorted.length - 1].username : null

  // Overall recommendation (Spanish fallback + key for the UI locale)
  let overallRecommendation = ''
  let overallRecommendationKey = ''
  if (overallSignal === 'green') {
    overallRecommendationKey = `campaign_success_${objective}`
    overallRecommendation = `Campaña exitosa. ${objective === 'awareness' ? 'Gran visibilidad obtenida' : objective === 'engagement' ? 'Alta interacción lograda' : objective === 'traffic' ? 'Buen tráfico generado' : objective === 'conversion' ? 'Conversiones rentables' : 'Contenido de calidad entregado'}.`
  } else if (overallSignal === 'yellow') {
    overallRecommendationKey = 'campaign_mixed'
    overallRecommendation = `Resultados mixtos. Revisar qué perfiles funcionaron y optimizar la selección para la próxima campaña.`
  } else if (overallSignal === 'red') {
    overallRecommendationKey = 'campaign_below'
    overallRecommendation = `Campaña por debajo de expectativas. Revisar la selección de perfiles, el fee negociado y la alineación con el objetivo.`
  } else {
    overallRecommendationKey = 'campaign_no_data'
    overallRecommendation = `Datos insuficientes para evaluar. Espera a que se recopilen más métricas.`
  }

  return {
    objective,
    overallSignal,
    overallScore,
    overallRecommendation,
    overallRecommendationKey,
    totalInvestment,
    totalEMV,
    emvRatio,
    influencers: influencerKPIs,
    topPerformer,
    worstPerformer,
  }
}

// ============ HELPERS ============

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
