/**
 * Campaign Playbook™ — Post-campaign intelligence that tells you
 * what to do NEXT based on what happened.
 *
 * Transforms "here's what happened" into "here's what to do next time":
 * - Which creators to repeat
 * - Which format worked best
 * - Where to shift budget
 * - What to scale and what to cut
 *
 * i18n: every generated string exists in Spanish (default) and English.
 * The headline metric is the EMV ratio (EMV / spend) — it is never
 * presented as "ROI" (product decision 9B) and it is written the way the rest
 * of the product writes it: formatRatio → "×2,3" (es) / "2.3×" (en).
 * Interacciones = likes + comentarios + shares + saves (decision 3A).
 */

import { formatRatio } from '@/lib/utils'

// ============ TYPES ============

export type PlaybookLocale = 'es' | 'en'

export interface PlaybookInput {
  campaignName: string
  objective: string         // awareness, engagement, traffic, conversion, content
  totalSpent: number
  totalEMV: number

  influencers: Array<{
    username: string
    platform: string
    agreedFee: number
    totalLikes: number
    totalComments: number
    totalViews: number
    totalShares: number
    totalSaves: number
    mediaPosts: number
    mediaTypes: string[]    // POST, REEL, VIDEO, SHORT, STORY, CAROUSEL
  }>
}

export interface PlaybookFormatVerdict {
  format: string            // raw media type code (REEL, POST, STORY…)
  formatLabel: string       // localized, plural, lowercase ("reels", "publicaciones")
  reason: string            // localized explanation
}

export interface PlaybookResult {
  // Campaign summary
  campaignGrade: string     // A+, A, B, C, D, F
  roiRatio: number          // EMV ratio (EMV / spend) — wire name kept for compatibility
  roiVerdict: string        // localized EMV-ratio verdict ("Ratio EMV sólido", "Strong EMV ratio")

  // Key insights (3-5 bullet points)
  insights: PlaybookInsight[]

  // Creator rankings
  topPerformer: { username: string; reason: string } | null
  worstPerformer: { username: string; reason: string } | null
  repeatList: string[]      // usernames to definitely repeat
  skipList: string[]        // usernames to skip next time

  // Format analysis
  bestFormat: PlaybookFormatVerdict | null
  worstFormat: PlaybookFormatVerdict | null

  // Budget recommendation
  budgetAdvice: string

  // Next campaign recommendation
  nextCampaignRec: string
}

export interface PlaybookInsight {
  type: 'success' | 'warning' | 'action' | 'insight' | 'info'
  icon: string              // emoji
  text: string              // localized
  textKey: string           // stable i18n key (locale-independent)
}

// ============ LOCALE HELPERS ============

/** Intl tag for the locale ('es-ES' | 'en-US'). */
function intlTag(locale: PlaybookLocale): string {
  return locale === 'es' ? 'es-ES' : 'en-US'
}

/** Integer with thousands separators in the locale's convention (1.234 / 1,234). */
function fmtInt(value: number, locale: PlaybookLocale): string {
  return Math.round(value).toLocaleString(intlTag(locale), { maximumFractionDigits: 0 })
}

/** Euro amount — Spanish puts the symbol after the number, English before. */
function fmtEur(value: number, locale: PlaybookLocale): string {
  const n = fmtInt(value, locale)
  return locale === 'es' ? `${n} €` : `€${n}`
}

/** Localized, plural, lowercase label for a media type code (REEL → "reels" / POST → "publicaciones"). */
export function playbookFormatLabel(format: string, locale: PlaybookLocale): string {
  const key = (format || '').toUpperCase()
  const labels: Record<string, { es: string; en: string }> = {
    REEL: { es: 'reels', en: 'reels' },
    POST: { es: 'publicaciones', en: 'posts' },
    STORY: { es: 'stories', en: 'stories' },
    VIDEO: { es: 'vídeos', en: 'videos' },
    SHORT: { es: 'shorts', en: 'shorts' },
    CAROUSEL: { es: 'carruseles', en: 'carousels' },
    LIVE: { es: 'directos', en: 'lives' },
  }
  const entry = labels[key]
  if (entry) return entry[locale]
  // Unknown code: show it lowercased rather than shouting the enum value.
  return (format || '').toLowerCase()
}

/** "3 creadores" / "3 creators" — with singular handling. */
function creatorsCount(n: number, locale: PlaybookLocale): string {
  if (locale === 'es') return n === 1 ? '1 creador' : `${n} creadores`
  return n === 1 ? '1 creator' : `${n} creators`
}

// ============ MAIN FUNCTION ============

export function generatePlaybook(input: PlaybookInput, locale: PlaybookLocale = 'es'): PlaybookResult {
  const { influencers, totalSpent, totalEMV } = input

  if (influencers.length === 0) {
    return createEmptyPlaybook(locale)
  }

  // EMV ratio (EMV / spend). Drives the grade; never described as ROI.
  // Without any recorded cost there is no ratio to judge: say so instead of "×0,0 / Ratio EMV bajo".
  const hasSpend = totalSpent > 0
  const roiRatio = hasSpend ? Math.round((totalEMV / totalSpent) * 100) / 100 : 0
  const campaignGrade = hasSpend ? gradeEmvRatio(roiRatio) : 'N/A'
  const roiVerdict = hasSpend
    ? emvVerdict(roiRatio, locale)
    : (locale === 'es' ? 'Sin coste registrado' : 'No cost recorded')

  // Analyze each influencer
  const influencerAnalysis = influencers.map(inf => {
    // Interacciones (decision 3A): likes + comentarios + shares + saves
    const totalEngagement = inf.totalLikes + inf.totalComments + inf.totalShares + inf.totalSaves
    const emvShare = totalEMV > 0 ? ((inf.agreedFee > 0 ? inf.agreedFee : 1) / totalSpent) : 0
    const cpm = inf.totalViews > 0 ? (inf.agreedFee / inf.totalViews) * 1000 : Infinity
    const engagementPerEuro = inf.agreedFee > 0 ? totalEngagement / inf.agreedFee : 0

    return {
      ...inf,
      totalEngagement,
      emvShare,
      cpm,
      engagementPerEuro,
    }
  })

  // Sort by engagement per euro (efficiency)
  const sorted = [...influencerAnalysis].sort((a, b) => b.engagementPerEuro - a.engagementPerEuro)

  // Top/worst performers
  const topPerformer = sorted[0] ? {
    username: sorted[0].username,
    reason: topPerformerReason(sorted[0], locale),
  } : null

  const worstPerformer = sorted.length > 1 ? {
    username: sorted[sorted.length - 1].username,
    reason: worstPerformerReason(sorted[sorted.length - 1], locale),
  } : null

  // Repeat / skip lists
  const repeatList = sorted
    .filter(inf => inf.engagementPerEuro >= (sorted[0]?.engagementPerEuro || 0) * 0.5 && inf.cpm < 30)
    .map(inf => inf.username)
  const skipList = sorted
    .filter(inf => inf.engagementPerEuro < (sorted[0]?.engagementPerEuro || 0) * 0.2 || inf.cpm > 50)
    .map(inf => inf.username)

  // Format analysis
  const formatMap = new Map<string, { views: number; engagement: number; posts: number }>()
  for (const inf of influencerAnalysis) {
    for (const type of inf.mediaTypes) {
      const existing = formatMap.get(type) || { views: 0, engagement: 0, posts: 0 }
      existing.views += inf.totalViews / (inf.mediaTypes.length || 1)
      existing.engagement += inf.totalEngagement / (inf.mediaTypes.length || 1)
      existing.posts += inf.mediaPosts / (inf.mediaTypes.length || 1)
      formatMap.set(type, existing)
    }
  }

  let bestFormat: PlaybookResult['bestFormat'] = null
  let worstFormat: PlaybookResult['worstFormat'] = null
  if (formatMap.size > 1) {
    const formats = Array.from(formatMap.entries())
      .map(([format, data]) => ({ format, engPerPost: data.posts > 0 ? data.engagement / data.posts : 0 }))
      .sort((a, b) => b.engPerPost - a.engPerPost)

    const best = formats[0]
    const worst = formats[formats.length - 1]
    const bestLabel = playbookFormatLabel(best.format, locale)
    const worstLabel = playbookFormatLabel(worst.format, locale)
    const multiplier = Math.round(best.engPerPost / (worst.engPerPost || 1))
    const bestEng = fmtInt(best.engPerPost, locale)
    const worstEng = fmtInt(worst.engPerPost, locale)

    bestFormat = {
      format: best.format,
      formatLabel: bestLabel,
      reason: locale === 'es'
        ? `${bestEng} interacciones de media por publicación — ${multiplier}x más que ${worstLabel}.`
        : `${bestEng} avg engagements per post — ${multiplier}x better than ${worstLabel}.`,
    }
    worstFormat = {
      format: worst.format,
      formatLabel: worstLabel,
      reason: locale === 'es'
        ? `Solo ${worstEng} interacciones de media por publicación.`
        : `Only ${worstEng} avg engagements per post.`,
    }
  }

  // Generate insights
  const insights = generateInsights(input, influencerAnalysis, sorted, hasSpend ? roiRatio : null, bestFormat, locale)

  // Budget advice
  const budgetAdvice = hasSpend
    ? generateBudgetAdvice(roiRatio, locale)
    : (locale === 'es'
        ? 'Registra los fees o costes de los creadores en la pestaña Elegir para obtener el Ratio EMV y el consejo de presupuesto.'
        : 'Record the creators\' fees or costs in the Elegir tab to get the EMV ratio and budget advice.')

  // Next campaign recommendation
  const nextCampaignRec = generateNextCampaignRec(roiRatio, sorted, bestFormat, locale)

  return {
    campaignGrade,
    roiRatio,
    roiVerdict,
    insights,
    topPerformer,
    worstPerformer,
    repeatList,
    skipList,
    bestFormat,
    worstFormat,
    budgetAdvice,
    nextCampaignRec,
  }
}

// ============ HELPERS ============

/** Letter grade from the EMV ratio. Thresholds are the product's, unchanged. */
function gradeEmvRatio(ratio: number): string {
  if (ratio >= 3.0) return 'A+'
  if (ratio >= 2.5) return 'A'
  if (ratio >= 2.0) return 'B+'
  if (ratio >= 1.5) return 'B'
  if (ratio >= 1.0) return 'C'
  if (ratio >= 0.5) return 'D'
  return 'F'
}

/** One-line verdict on the EMV ratio, localized. */
function emvVerdict(ratio: number, locale: PlaybookLocale): string {
  if (locale === 'es') {
    return ratio >= 2.5 ? 'Ratio EMV excelente' :
           ratio >= 1.5 ? 'Ratio EMV sólido' :
           ratio >= 1.0 ? 'Ratio EMV positivo' :
           ratio >= 0.5 ? 'Por debajo del objetivo' :
           'Ratio EMV bajo'
  }
  return ratio >= 2.5 ? 'Excellent EMV ratio' :
         ratio >= 1.5 ? 'Strong EMV ratio' :
         ratio >= 1.0 ? 'Positive EMV ratio' :
         ratio >= 0.5 ? 'Below target' :
         'Low EMV ratio'
}

type AnalyzedInfluencer = {
  username: string
  totalEngagement: number
  cpm: number
  engagementPerEuro: number
  totalViews: number
  agreedFee: number
}

/** Why the MVP is the MVP. The CPM clause is omitted when there are no views to compute it from. */
function topPerformerReason(inf: AnalyzedInfluencer, locale: PlaybookLocale): string {
  const eng = fmtInt(inf.totalEngagement, locale)
  const hasCpm = Number.isFinite(inf.cpm)
  if (locale === 'es') {
    return hasCpm
      ? `Generó ${eng} interacciones con un CPM de ${fmtEur(inf.cpm, locale)} — la mejor eficiencia de la campaña.`
      : `Generó ${eng} interacciones — la mejor eficiencia de la campaña.`
  }
  return hasCpm
    ? `Generated ${eng} engagements at ${fmtEur(inf.cpm, locale)} CPM — best efficiency in the campaign.`
    : `Generated ${eng} engagements — best efficiency in the campaign.`
}

/** Why the weakest creator ranks last. */
function worstPerformerReason(inf: AnalyzedInfluencer, locale: PlaybookLocale): string {
  const eng = fmtInt(inf.totalEngagement, locale)
  const hasCpm = Number.isFinite(inf.cpm)
  if (locale === 'es') {
    return hasCpm
      ? `El ratio de interacciones por euro más bajo. CPM de ${fmtEur(inf.cpm, locale)} con solo ${eng} interacciones.`
      : `El ratio de interacciones por euro más bajo. Solo ${eng} interacciones y sin visualizaciones registradas.`
  }
  return hasCpm
    ? `Lowest engagement-per-euro ratio. CPM of ${fmtEur(inf.cpm, locale)} with only ${eng} engagements.`
    : `Lowest engagement-per-euro ratio. Only ${eng} engagements and no views tracked.`
}

function generateInsights(
  input: PlaybookInput,
  analysis: AnalyzedInfluencer[],
  sorted: AnalyzedInfluencer[],
  /** EMV ratio; null when the campaign has no recorded cost (no ratio insight then). */
  ratio: number | null,
  bestFormat: PlaybookResult['bestFormat'],
  locale: PlaybookLocale
): PlaybookInsight[] {
  const insights: PlaybookInsight[] = []
  const es = locale === 'es'

  // EMV-ratio insight (only when there is a cost to compare against)
  if (ratio === null) {
    insights.push({
      type: 'info',
      icon: 'ℹ️',
      text: es
        ? 'Sin fees ni costes registrados: el Ratio EMV no se puede calcular. Regístralos en la pestaña Elegir.'
        : 'No fees or costs recorded: the EMV ratio cannot be computed. Record them in the Elegir tab.',
      textKey: 'playbook_no_cost',
    })
  } else if (ratio >= 2.0) {
    insights.push({
      type: 'success',
      icon: '🎯',
      text: es
        ? `La campaña generó un ratio EMV de ${formatRatio(ratio, { locale })}. Rendimiento sólido.`
        : `The campaign generated a ${formatRatio(ratio, { locale })} EMV ratio. Strong performance.`,
      textKey: 'playbook_roi_strong',
    })
  } else if (ratio < 1.0) {
    insights.push({
      type: 'warning',
      icon: '⚠️',
      text: es
        ? `El EMV de la campaña (${fmtEur(input.totalEMV, locale)}) quedó por debajo de la inversión (${fmtEur(input.totalSpent, locale)}). El ratio EMV es ${formatRatio(ratio, { locale })}.`
        : `Campaign EMV (${fmtEur(input.totalEMV, locale)}) was below the investment (${fmtEur(input.totalSpent, locale)}). The EMV ratio is ${formatRatio(ratio, { locale })}.`,
      textKey: 'playbook_roi_negative',
    })
  }

  // Concentration risk
  if (sorted.length >= 3) {
    const totalEng = analysis.reduce((sum, a) => sum + a.totalEngagement, 0)
    const topShare = totalEng > 0 ? sorted[0].totalEngagement / totalEng : 0
    if (topShare > 0.5) {
      const pct = Math.round(topShare * 100)
      insights.push({
        type: 'insight',
        icon: '📊',
        text: es
          ? `@${sorted[0].username} generó el ${pct} % de todas las interacciones. Alto riesgo de concentración — diversifica la próxima vez.`
          : `@${sorted[0].username} generated ${pct}% of all engagement. High concentration risk — diversify next time.`,
        textKey: 'playbook_concentration_risk',
      })
    }
  }

  // Format insight
  if (bestFormat) {
    insights.push({
      type: 'action',
      icon: '🎬',
      text: es
        ? `Los ${bestFormat.formatLabel} fueron el formato que mejor funcionó. ${bestFormat.reason} Concentra el presupuesto en este formato la próxima vez.`
        : `${capitalize(bestFormat.formatLabel)} performed best. ${bestFormat.reason} Focus budget on this format next time.`,
      textKey: 'playbook_best_format',
    })
  }

  // Cost efficiency
  // Only creators with a recorded fee can be judged on CPM (fee 0 → CPM 0 is not 'good value')
  const cheapHighPerformers = sorted.filter(inf => inf.agreedFee > 0 && Number.isFinite(inf.cpm) && inf.cpm <= 15 && inf.totalEngagement > 100)
  if (cheapHighPerformers.length > 0) {
    const n = cheapHighPerformers.length
    insights.push({
      type: 'success',
      icon: '💰',
      text: es
        ? `${creatorsCount(n, locale)} ${n === 1 ? 'logró' : 'lograron'} buenos resultados con un CPM inferior a ${fmtEur(15, locale)}. Son tus mejores apuestas en relación calidad-precio.`
        : `${creatorsCount(n, locale)} delivered strong results at a CPM under ${fmtEur(15, locale)}. These are your best value picks.`,
      textKey: 'playbook_value_picks',
    })
  }

  // Underperformers
  const expensive = sorted.filter(inf => inf.agreedFee > 0 && Number.isFinite(inf.cpm) && inf.cpm > 30 && inf.totalEngagement < 500)
  if (expensive.length > 0) {
    const n = expensive.length
    insights.push({
      type: 'warning',
      icon: '📉',
      text: es
        ? `${creatorsCount(n, locale)} ${n === 1 ? 'tuvo' : 'tuvieron'} un CPM alto (>${fmtEur(30, locale)}) con pocas interacciones. Descarta o renegocia para la próxima campaña.`
        : `${creatorsCount(n, locale)} had a high CPM (>${fmtEur(30, locale)}) with low engagement. Cut or renegotiate for the next campaign.`,
      textKey: 'playbook_cut_underperformers',
    })
  }

  return insights.slice(0, 5) // Max 5 insights
}

function generateBudgetAdvice(ratio: number, locale: PlaybookLocale): string {
  const es = locale === 'es'
  if (ratio >= 2.0) {
    return es
      ? `Ratio EMV sólido de ${formatRatio(ratio, { locale })}. Plantéate aumentar el presupuesto un 20-30 % y concentrarlo en los creadores con mejor rendimiento.`
      : `Strong EMV ratio at ${formatRatio(ratio, { locale })}. Consider increasing budget by 20-30% and concentrating on top performers.`
  }
  if (ratio >= 1.0) {
    return es
      ? 'Ratio EMV positivo pero modesto. Reasigna presupuesto de los creadores con peor rendimiento a los mejores. Misma inversión, mejor reparto.'
      : 'Positive but modest EMV ratio. Reallocate budget from bottom performers to top creators. Same spend, better distribution.'
  }
  return es
    ? 'Ratio EMV por debajo del objetivo. Reduce el presupuesto total o concéntralo en menos creadores con mejor rendimiento. Calidad antes que cantidad.'
    : 'EMV ratio below target. Reduce total budget or shift decisively to fewer, better-performing creators. Quality over quantity.'
}

function generateNextCampaignRec(
  ratio: number,
  sorted: Array<{ username: string }>,
  bestFormat: PlaybookResult['bestFormat'],
  locale: PlaybookLocale
): string {
  const es = locale === 'es'
  const topCreators = sorted.slice(0, Math.ceil(sorted.length * 0.4)).map(s => `@${s.username}`).join(', ')
  const formatRec = bestFormat
    ? (es ? ` Céntrate en ${bestFormat.formatLabel}.` : ` Focus on ${bestFormat.formatLabel}.`)
    : ''

  if (ratio >= 2.0) {
    return es
      ? `Escala esta campaña. Mantén a ${topCreators}.${formatRec} Aumenta el presupuesto para amplificar lo que funciona.`
      : `Scale this campaign. Keep ${topCreators}.${formatRec} Increase budget to amplify what works.`
  }
  if (ratio >= 1.0) {
    return es
      ? `Repite con un roster más ajustado: ${topCreators}.${formatRec} Descarta a los de menor rendimiento para mejorar la eficiencia.`
      : `Repeat with a tighter roster: ${topCreators}.${formatRec} Cut underperformers to improve efficiency.`
  }
  return es
    ? `Replantea el enfoque. Prueba con 2-3 creadores ya validados (${topCreators}) con tarifas más bajas.${formatRec} Valida antes de escalar.`
    : `Rethink the approach. Test with 2-3 proven creators (${topCreators}) at lower fees.${formatRec} Validate before scaling.`
}

function createEmptyPlaybook(locale: PlaybookLocale): PlaybookResult {
  const es = locale === 'es'
  return {
    campaignGrade: 'N/A',
    roiRatio: 0,
    roiVerdict: es ? 'Sin datos' : 'No data',
    insights: [{
      type: 'info' as const,
      icon: 'ℹ️',
      text: es
        ? 'Todavía no hay datos de creadores. El playbook se generará cuando haya contenido registrado.'
        : 'No creator data available yet. The playbook will be generated once content is tracked.',
      textKey: 'playbook_no_data',
    }],
    topPerformer: null,
    worstPerformer: null,
    repeatList: [],
    skipList: [],
    bestFormat: null,
    worstFormat: null,
    budgetAdvice: es ? 'Datos insuficientes.' : 'Insufficient data.',
    nextCampaignRec: es
      ? 'Empieza a registrar el contenido de los creadores para generar recomendaciones accionables.'
      : 'Start tracking creator content to generate actionable recommendations.',
  }
}

/** Capitalize the first character (for sentence-initial format labels in English). */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
