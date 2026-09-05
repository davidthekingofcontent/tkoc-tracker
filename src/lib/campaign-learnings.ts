/**
 * CAMPAIGN LEARNINGS — "qué hemos aprendido" for the report and the portal.
 *
 * Pure (no database, no network): consumes the ONE campaign overview
 * (src/lib/campaign-overview.ts → src/lib/metrics.ts definitions) plus the
 * campaign meta and a minimal set of media rows, and reuses the Campaign
 * Playbook (src/lib/campaign-playbook.ts) for the creator/format ranking. It
 * never recomputes a campaign figure: cost, EMV, views, interacciones and
 * media counts per creator come straight from overview.perInfluencer; the rows
 * only contribute the likes/comments/shares/saves split and the formats.
 *
 * Two projections of the same object (contract 2026-09-05, streams B/C):
 *   - buildCampaignLearnings → the agency sees everything (grade, Ratio EMV
 *     verdict, worst performer, skip list, budget advice).
 *   - toClientLearnings → the brand portal / BRAND users: grade, ratio verdict,
 *     worst performer, skip list and budget advice are removed, and every text
 *     that carries € / CPM / Ratio EMV / budget wording is dropped or rewritten.
 *     Clients never see cost, CPM, ratio or basic EMV (David).
 *
 * Decision 4A (David 2026-09-05): ER and CPM use REAL audience only. The
 * data-quality insights added here say how many publications carry a real
 * audience figure so the reader knows what the rates stand on.
 */

import { generatePlaybook, playbookFormatLabel, type PlaybookInput, type PlaybookLocale, type PlaybookResult } from '@/lib/campaign-playbook'
import type { CampaignOverview } from '@/lib/metrics'

// ============ TYPES (the wire contract) ============

export type LearningsLocale = PlaybookLocale

export type LearningInsightType = 'success' | 'warning' | 'action' | 'insight' | 'info'

export interface LearningInsight {
  type: LearningInsightType
  icon: string
  text: string
  /**
   * Stable, locale-independent key (playbook_* from the playbook, learnings_*
   * from this module). Not part of the minimal contract but harmless for
   * consumers and the reason toClientLearnings can filter deterministically.
   */
  textKey: string
}

export interface LearningsPerformer {
  username: string
  reason: string
}

export interface LearningsFormat {
  /** Raw media type code (REEL, POST, STORY…). */
  format: string
  reason: string
}

export interface CampaignLearnings {
  /** ISO timestamp of the computation. */
  generatedAt: string
  locale: LearningsLocale
  /** Letter grade from the Ratio EMV (agency only; null in the client projection). */
  grade: string | null
  /** "Ratio EMV sólido" etc. (agency only; null in the client projection). */
  ratioVerdict: string | null
  insights: LearningInsight[]
  topPerformer: LearningsPerformer | null
  /** Agency only; null in the client projection. */
  worstPerformer: LearningsPerformer | null
  /** Creators to repeat next time (usernames without @). */
  repeatList: string[]
  /** Creators to skip next time (agency only; [] in the client projection). */
  skipList: string[]
  bestFormat: LearningsFormat | null
  worstFormat: LearningsFormat | null
  /** Agency only; null in the client projection. */
  budgetAdvice: string | null
  nextCampaignRec: string
}

/** The subset of a Media row the learnings need (same select the intelligence playbook uses). */
export interface LearningsMediaRow {
  influencerId: string
  likes?: number | null
  comments?: number | null
  shares?: number | null
  saves?: number | null
  mediaType: string
}

export interface BuildLearningsInput {
  overview: CampaignOverview
  campaignName: string
  /** awareness | engagement | traffic | conversion | content (null → 'awareness'). */
  objective?: string | null
  media: LearningsMediaRow[]
  locale?: LearningsLocale
}

// ============ BUILD (agency projection) ============

interface EngagementPieces { likes: number; comments: number; shares: number; saves: number }

function toPlaybookInput(input: BuildLearningsInput): PlaybookInput {
  const { overview } = input
  const pieces = new Map<string, EngagementPieces>()
  const formats = new Map<string, Set<string>>()
  for (const m of input.media) {
    const p = pieces.get(m.influencerId) || { likes: 0, comments: 0, shares: 0, saves: 0 }
    p.likes += m.likes || 0
    p.comments += m.comments || 0
    p.shares += m.shares || 0
    p.saves += m.saves || 0
    pieces.set(m.influencerId, p)
    const f = formats.get(m.influencerId) || new Set<string>()
    if (m.mediaType) f.add(m.mediaType)
    formats.set(m.influencerId, f)
  }

  return {
    campaignName: input.campaignName,
    objective: input.objective || 'awareness',
    totalSpent: overview.totals.cost,
    totalEMV: overview.totals.emvExtended,
    influencers: overview.perInfluencer.map(p => {
      const e = pieces.get(p.influencerId)
      return {
        username: p.username,
        platform: p.platform,
        agreedFee: p.cost,
        totalLikes: e?.likes ?? 0,
        totalComments: e?.comments ?? 0,
        totalViews: p.views,
        totalShares: e?.shares ?? 0,
        totalSaves: e?.saves ?? 0,
        mediaPosts: p.media,
        mediaTypes: Array.from(formats.get(p.influencerId) ?? []),
      }
    }),
  }
}

function fmtInt(value: number, locale: LearningsLocale): string {
  return Math.round(value).toLocaleString(locale === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 0 })
}

/**
 * Data-quality insights derived from the overview (4A): how much of the
 * campaign stands on real audience data. Client-safe by construction (no
 * economics) — they survive toClientLearnings.
 */
function audienceCoverageInsights(overview: CampaignOverview, locale: LearningsLocale): LearningInsight[] {
  const out: LearningInsight[] = []
  const t = overview.totals
  const es = locale === 'es'
  if (t.media === 0) return out

  const realPieces = t.audience.realPieces
  if (t.er.value === null) {
    out.push({
      type: 'info',
      icon: '📐',
      text: es
        ? `Ninguna de las ${fmtInt(t.media, locale)} publicaciones tiene audiencia real (alcance, impresiones o visualizaciones), así que la tasa de engagement no se calcula: no se estima nunca. Pide a los creadores sus estadísticas para completarla.`
        : `None of the ${fmtInt(t.media, locale)} publications has a real audience figure (reach, impressions or views), so the engagement rate is not computed — it is never estimated. Ask the creators for their insights to complete it.`,
      textKey: 'learnings_no_real_audience',
    })
    return out
  }

  if (realPieces < t.media) {
    const missing = t.media - realPieces
    const shareReal = Math.round((realPieces / t.media) * 100)
    out.push({
      type: 'info',
      icon: '📐',
      text: es
        ? `La tasa de engagement y el alcance se calculan sobre las ${fmtInt(realPieces, locale)} publicaciones con audiencia real (${shareReal} % del total); ${fmtInt(missing, locale)} ${missing === 1 ? 'publicación queda' : 'publicaciones quedan'} fuera de esa base por no tener alcance, impresiones ni visualizaciones reales.`
        : `The engagement rate and the reach stand on the ${fmtInt(realPieces, locale)} publications with a real audience figure (${shareReal}% of the total); ${fmtInt(missing, locale)} ${missing === 1 ? 'publication is' : 'publications are'} left out of that base because they have no real reach, impressions or views.`,
      textKey: 'learnings_partial_real_audience',
    })
  }

  return out
}

function fromPlaybook(pb: PlaybookResult): Omit<CampaignLearnings, 'generatedAt' | 'locale'> {
  return {
    grade: pb.campaignGrade,
    ratioVerdict: pb.roiVerdict,
    insights: pb.insights.map(i => ({ type: i.type, icon: i.icon, text: i.text, textKey: i.textKey })),
    topPerformer: pb.topPerformer ? { username: pb.topPerformer.username, reason: pb.topPerformer.reason } : null,
    worstPerformer: pb.worstPerformer ? { username: pb.worstPerformer.username, reason: pb.worstPerformer.reason } : null,
    repeatList: [...pb.repeatList],
    skipList: [...pb.skipList],
    bestFormat: pb.bestFormat ? { format: pb.bestFormat.format, reason: pb.bestFormat.reason } : null,
    worstFormat: pb.worstFormat ? { format: pb.worstFormat.format, reason: pb.worstFormat.reason } : null,
    budgetAdvice: pb.budgetAdvice,
    nextCampaignRec: pb.nextCampaignRec,
  }
}

const MAX_INSIGHTS = 6

/**
 * Full (agency) learnings for a campaign. Creators are ranked by the playbook
 * (interacciones por euro, CPM) fed exclusively from the overview.
 */
export function buildCampaignLearnings(input: BuildLearningsInput): CampaignLearnings {
  const locale: LearningsLocale = input.locale === 'en' ? 'en' : 'es'
  const playbook = generatePlaybook(toPlaybookInput(input), locale)
  const base = fromPlaybook(playbook)
  const insights = [...base.insights, ...audienceCoverageInsights(input.overview, locale)].slice(0, MAX_INSIGHTS)
  return {
    generatedAt: new Date().toISOString(),
    locale,
    ...base,
    insights,
  }
}

// ============ CLIENT PROJECTION ============

/**
 * Words that mark a sentence as economic: euros, CPM, Ratio EMV, fees, budget,
 * investment. A client-facing text containing any of them is dropped or
 * rewritten — never sent as is. Both languages.
 */
const ECONOMIC_WORDING = /€|\bcpm\b|ratio|×|\bemv\b|presupuesto|inversi[oó]n|\bfees?\b|tarifas?|costes?|\bcosts?\b|\beuros?\b|\bbudget\b|\bspend\b|\binvestment\b|\bvalue picks?\b|calidad-precio|\bcheap/i

export function hasEconomicWording(text: string): boolean {
  return ECONOMIC_WORDING.test(text)
}

/** Playbook insights that are, by construction, about cost or the Ratio EMV. */
const ECONOMIC_INSIGHT_KEYS = new Set([
  'playbook_no_cost',
  'playbook_roi_strong',
  'playbook_roi_negative',
  'playbook_value_picks',
  'playbook_cut_underperformers',
])

function clientTopPerformerReason(agencyReason: string, locale: LearningsLocale): string {
  // Playbook wording: "Generó 1.234 interacciones con un CPM de 12 € — la mejor…" /
  // "Generated 1,234 engagements at €12 CPM — best…". Drop the CPM clause; if
  // any economic term survives, fall back to a neutral sentence.
  const stripped = agencyReason
    .replace(/\s+con un CPM de\s+[\d.,]+\s*€/i, '')
    .replace(/\s+at\s+€[\d.,]+\s+CPM/i, '')
  if (!hasEconomicWording(stripped)) return stripped
  return locale === 'es'
    ? 'El creador con mejor rendimiento de la campaña.'
    : 'The best-performing creator of the campaign.'
}

function clientBestFormatInsight(best: LearningsFormat, locale: LearningsLocale): LearningInsight | null {
  if (hasEconomicWording(best.reason)) return null
  const label = playbookFormatLabel(best.format, locale)
  // "las publicaciones" is feminine; every other format label is masculine ("los reels", "los stories").
  const article = best.format.toUpperCase() === 'POST' ? 'las' : 'los'
  const text = locale === 'es'
    ? `El formato que mejor funcionó fueron ${article} ${label}. ${best.reason}`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} performed best. ${best.reason}`
  return { type: 'action', icon: '🎬', text, textKey: 'playbook_best_format' }
}

function clientNextCampaignRec(l: CampaignLearnings, locale: LearningsLocale): string {
  const es = locale === 'es'
  const names = (l.repeatList.length > 0 ? l.repeatList : l.topPerformer ? [l.topPerformer.username] : [])
    .slice(0, 5)
    .map(u => `@${u}`)
  const format = l.bestFormat && !hasEconomicWording(l.bestFormat.reason) ? playbookFormatLabel(l.bestFormat.format, locale) : null
  if (names.length === 0 && !format) {
    return es
      ? 'Con más publicaciones registradas afinaremos las recomendaciones para la próxima campaña.'
      : 'With more publications tracked we will sharpen the recommendations for the next campaign.'
  }
  const parts: string[] = []
  if (names.length > 0) parts.push(es ? `repetir con ${names.join(', ')}` : `repeat with ${names.join(', ')}`)
  if (format) parts.push(es ? `centrar el contenido en ${format}` : `focus the content on ${format}`)
  const joined = parts.join(es ? ' y ' : ' and ')
  return es
    ? `Para la próxima campaña recomendamos ${joined}.`
    : `For the next campaign we recommend to ${joined}.`
}

/**
 * Client-safe projection: no grade, no Ratio EMV verdict, no worst performer,
 * no skip list, no budget advice, and no € / CPM / ratio / budget wording in
 * any remaining text. Pure over the full object.
 */
export function toClientLearnings(l: CampaignLearnings): CampaignLearnings {
  const locale = l.locale
  const insights: LearningInsight[] = []
  for (const i of l.insights) {
    if (ECONOMIC_INSIGHT_KEYS.has(i.textKey)) continue
    if (i.textKey === 'playbook_best_format') {
      // Its playbook text ends with budget advice — rebuild it from the format verdict.
      const rebuilt = l.bestFormat ? clientBestFormatInsight(l.bestFormat, locale) : null
      if (rebuilt) insights.push(rebuilt)
      continue
    }
    if (hasEconomicWording(i.text)) continue
    insights.push({ ...i })
  }

  const safeFormat = (f: LearningsFormat | null): LearningsFormat | null =>
    f && !hasEconomicWording(f.reason) ? { ...f } : null

  return {
    generatedAt: l.generatedAt,
    locale,
    grade: null,
    ratioVerdict: null,
    insights,
    topPerformer: l.topPerformer
      ? { username: l.topPerformer.username, reason: clientTopPerformerReason(l.topPerformer.reason, locale) }
      : null,
    worstPerformer: null,
    repeatList: [...l.repeatList],
    skipList: [],
    bestFormat: safeFormat(l.bestFormat),
    worstFormat: safeFormat(l.worstFormat),
    budgetAdvice: null,
    nextCampaignRec: clientNextCampaignRec(l, locale),
  }
}
