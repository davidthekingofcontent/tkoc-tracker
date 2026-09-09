/**
 * CAMPAIGN LEARNINGS — "qué hemos aprendido" for the report and the portal.
 *
 * Pure (no database, no network). Thin wrapper over the Campaign Playbook:
 *   overview → buildPlaybookInput (src/lib/aprender-input.ts, the ONE projection
 *   of the overview) → generatePlaybook (src/lib/campaign-playbook.ts, the ONE
 *   ranking and text renderer, per audience).
 * Nothing is recomputed here: every figure a sentence quotes comes from
 * overview.perInfluencer / perMedia / totals / delivery / targets / business,
 * with the report's definitions (interacciones 3A, vistas reales = plausible
 * views, ER on views with the ≥ 3 / ≥ 1 pieces and ≥ 500 views rules, CPM on
 * the same base, coste = fee acordado si no coste, Ratio EMV never "ROI").
 *
 * Two projections of the same facts:
 *   - buildCampaignLearnings → agency (grade, Ratio EMV verdict, worst
 *     performer, skip list, "sin dato real" list, budget advice, data actions).
 *     The object carries `facts` (the PlaybookInput) so the client projection
 *     can be regenerated from data instead of censored from prose.
 *   - toClientLearnings → brand portal / BRAND users: regenerated with
 *     audience 'client' (ER, real views, baseline, delivery; never cost, CPM,
 *     Ratio EMV, budget, nor the agency's data actions), then asserted with the
 *     anchored economic-wording regex as a last line of defence. `facts` is
 *     stripped. An object without `facts` (older cache) falls back to filtering.
 *
 * Wire contract (read by src/components/campaign-report.tsx): field names of
 * CampaignLearnings are stable; `noDataList`, `facts` and `isAgencyOnly` are
 * additive.
 */

import { buildPlaybookInput } from '@/lib/aprender-input'
import {
  generatePlaybook,
  playbookFormatLabel,
  type PlaybookInput,
  type PlaybookLocale,
  type PlaybookResult,
} from '@/lib/campaign-playbook'
import type { CampaignOverview } from '@/lib/metrics'

// ============ TYPES (the wire contract) ============

export type LearningsLocale = PlaybookLocale

export type LearningInsightType = 'success' | 'warning' | 'action' | 'insight' | 'info'

export interface LearningInsight {
  type: LearningInsightType
  icon: string
  text: string
  /** Stable, locale-independent key (playbook_* / learnings_*). */
  textKey: string
  /** true when the sentence is for the agency only (cost, data actions, skip advice). */
  isAgencyOnly?: boolean
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
  /** Creators with content but no real views to judge them (agency only; [] in the client projection). */
  noDataList: string[]
  bestFormat: LearningsFormat | null
  worstFormat: LearningsFormat | null
  /** Agency only; null in the client projection. */
  budgetAdvice: string | null
  nextCampaignRec: string
  /**
   * Structured facts the texts were generated from (the PlaybookInput). Agency
   * object only: the client projection regenerates its texts from them and
   * then drops them.
   */
  facts?: PlaybookInput | null
}

/**
 * The subset of a Media row older callers pass. Kept for compatibility: the
 * learnings no longer read the rows (formats, plausibility and interacciones
 * come from overview.perMedia / perInfluencer).
 */
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
  /** @deprecated ignored; kept so existing callers compile. */
  media?: LearningsMediaRow[] | null
  locale?: LearningsLocale
}

// ============ BUILD ============

function fromPlaybook(pb: PlaybookResult): Omit<CampaignLearnings, 'generatedAt' | 'locale' | 'facts'> {
  return {
    grade: pb.roiVerdict ? pb.campaignGrade : null,
    ratioVerdict: pb.roiVerdict || null,
    insights: pb.insights.map(i => ({
      type: i.type,
      icon: i.icon,
      text: i.text,
      textKey: i.textKey,
      ...(i.isAgencyOnly ? { isAgencyOnly: true } : {}),
    })),
    topPerformer: pb.topPerformer ? { username: pb.topPerformer.username, reason: pb.topPerformer.reason } : null,
    worstPerformer: pb.worstPerformer ? { username: pb.worstPerformer.username, reason: pb.worstPerformer.reason } : null,
    repeatList: [...pb.repeatList],
    skipList: [...pb.skipList],
    noDataList: [...pb.noDataList],
    bestFormat: pb.bestFormat ? { format: pb.bestFormat.format, reason: pb.bestFormat.reason } : null,
    worstFormat: pb.worstFormat ? { format: pb.worstFormat.format, reason: pb.worstFormat.reason } : null,
    budgetAdvice: pb.budgetAdvice || null,
    nextCampaignRec: pb.nextCampaignRec,
  }
}

/**
 * Full (agency) learnings for a campaign, generated from the overview alone.
 */
export function buildCampaignLearnings(input: BuildLearningsInput): CampaignLearnings {
  const locale: LearningsLocale = input.locale === 'en' ? 'en' : 'es'
  const facts = buildPlaybookInput({ overview: input.overview, campaignName: input.campaignName, objective: input.objective })
  const playbook = generatePlaybook(facts, locale, { audience: 'agency' })
  return {
    generatedAt: new Date().toISOString(),
    locale,
    ...fromPlaybook(playbook),
    facts,
  }
}

// ============ CLIENT PROJECTION ============

/**
 * Words that mark a sentence as economic or as a cost judgement: euros, CPM,
 * Ratio EMV, fees, budget, investment, efficiency. A client-facing text
 * containing any of them is dropped or rewritten, never sent as is. Both
 * languages; every word anchored so "concentration" / "duration" no longer
 * match "ratio".
 */
const ECONOMIC_WORDING = /€|\bcpm\b|\bcpc\b|\bcpa\b|\broas\b|\bratios?\b|\bemv\b|\bpresupuestos?\b|\binversi[oó]n(?:es)?\b|\bfees?\b|\btarifas?\b|\bcostes?\b|\bcosts?\b|\beuros?\b|\bbudgets?\b|\bspend(?:ing)?\b|\binvestments?\b|\bvalue picks?\b|calidad-precio|\bcheap(?:er|est)?\b|\beficiencia\b|\befficien(?:cy|t)\b|\bexpensive\b/i

export function hasEconomicWording(text: string): boolean {
  return ECONOMIC_WORDING.test(text)
}

/** Playbook insights that are, by construction, about cost or the Ratio EMV. */
const ECONOMIC_INSIGHT_KEYS = new Set([
  'playbook_no_cost',
  'playbook_no_content',
  'playbook_roi_strong',
  'playbook_roi_negative',
  'playbook_roi_positive',
  'playbook_value_picks',
  'playbook_cut_underperformers',
  'playbook_objective_awareness_cpm',
  'playbook_objective_traffic_cpc',
  'playbook_objective_conversion_economics',
  'playbook_no_real_data_creators',
  'playbook_formats_not_comparable',
])

/** Insight keys that come from the delivery checklist and are agency-only. */
const DELIVERY_AGENCY_KEYS = new Set([
  'learnings_delivery_creators',
  'learnings_delivery_pieces',
  'learnings_delivery_dates',
  'learnings_delivery_disclosure',
  'learnings_delivery_not_applicable',
])

function neutralPerformerReason(locale: LearningsLocale): string {
  return locale === 'es'
    ? 'El creador con mejor tasa de engagement sobre vistas reales de la campaña.'
    : 'The creator with the best engagement rate on real views in the campaign.'
}

function neutralNextRec(locale: LearningsLocale): string {
  return locale === 'es'
    ? 'Con más publicaciones con vistas reales afinaremos las recomendaciones para la próxima campaña.'
    : 'With more publications carrying real views we will sharpen the recommendations for the next campaign.'
}

/** Last line of defence over a regenerated client object: nothing economic leaves. */
function assertClientSafe(l: Omit<CampaignLearnings, 'generatedAt' | 'locale' | 'facts'>, locale: LearningsLocale): Omit<CampaignLearnings, 'generatedAt' | 'locale' | 'facts'> {
  const safeFormat = (f: LearningsFormat | null): LearningsFormat | null =>
    f && !hasEconomicWording(f.reason) ? { ...f } : null
  return {
    grade: null,
    ratioVerdict: null,
    insights: l.insights
      .filter(i => !i.isAgencyOnly && !ECONOMIC_INSIGHT_KEYS.has(i.textKey) && !DELIVERY_AGENCY_KEYS.has(i.textKey) && !hasEconomicWording(i.text))
      .map(i => ({ type: i.type, icon: i.icon, text: i.text, textKey: i.textKey })),
    topPerformer: l.topPerformer
      ? { username: l.topPerformer.username, reason: hasEconomicWording(l.topPerformer.reason) ? neutralPerformerReason(locale) : l.topPerformer.reason }
      : null,
    worstPerformer: null,
    repeatList: [...l.repeatList],
    skipList: [],
    noDataList: [],
    bestFormat: safeFormat(l.bestFormat),
    worstFormat: safeFormat(l.worstFormat),
    budgetAdvice: null,
    nextCampaignRec: hasEconomicWording(l.nextCampaignRec) ? neutralNextRec(locale) : l.nextCampaignRec,
  }
}

// ---- Legacy path (object without facts): censor the agency prose ----

function legacyTopPerformerReason(agencyReason: string, locale: LearningsLocale): string {
  const stripped = agencyReason
    .replace(/\s+con un CPM de\s+[\d.,]+\s*€/i, '')
    .replace(/\s+at\s+€[\d.,]+\s+CPM/i, '')
  if (!hasEconomicWording(stripped)) return stripped
  return neutralPerformerReason(locale)
}

function legacyBestFormatInsight(best: LearningsFormat, locale: LearningsLocale): LearningInsight | null {
  if (hasEconomicWording(best.reason)) return null
  const label = playbookFormatLabel(best.format, locale)
  const article = best.format.toUpperCase() === 'POST' ? 'las' : 'los'
  const text = locale === 'es'
    ? `El formato que mejor funcionó fueron ${article} ${label}. ${best.reason}`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} performed best. ${best.reason}`
  return { type: 'action', icon: '🎬', text, textKey: 'playbook_best_format' }
}

function legacyNextCampaignRec(l: CampaignLearnings, locale: LearningsLocale): string {
  const es = locale === 'es'
  // Names come ONLY from the repeat list: never from an arbitrary top performer.
  const names = l.repeatList.slice(0, 5).map(u => `@${u}`)
  const format = l.bestFormat && !hasEconomicWording(l.bestFormat.reason) ? playbookFormatLabel(l.bestFormat.format, locale) : null
  if (names.length === 0 && !format) return neutralNextRec(locale)
  const parts: string[] = []
  if (names.length > 0) parts.push(es ? `repetir con ${names.join(', ')}` : `repeat with ${names.join(', ')}`)
  if (format) parts.push(es ? `centrar el contenido en ${format}` : `focus the content on ${format}`)
  const joined = parts.join(es ? ' y ' : ' and ')
  return es
    ? `Para la próxima campaña recomendamos ${joined}.`
    : `For the next campaign we recommend to ${joined}.`
}

function legacyClientProjection(l: CampaignLearnings): Omit<CampaignLearnings, 'generatedAt' | 'locale' | 'facts'> {
  const locale = l.locale
  const insights: LearningInsight[] = []
  for (const i of l.insights) {
    if (i.isAgencyOnly) continue
    if (ECONOMIC_INSIGHT_KEYS.has(i.textKey)) continue
    if (DELIVERY_AGENCY_KEYS.has(i.textKey)) continue
    if (i.textKey === 'playbook_best_format') {
      const rebuilt = l.bestFormat ? legacyBestFormatInsight(l.bestFormat, locale) : null
      if (rebuilt) insights.push(rebuilt)
      continue
    }
    if (hasEconomicWording(i.text)) continue
    insights.push({ type: i.type, icon: i.icon, text: i.text, textKey: i.textKey })
  }
  return assertClientSafe({
    grade: null,
    ratioVerdict: null,
    insights,
    topPerformer: l.topPerformer
      ? { username: l.topPerformer.username, reason: legacyTopPerformerReason(l.topPerformer.reason, locale) }
      : null,
    worstPerformer: null,
    repeatList: [...l.repeatList],
    skipList: [],
    noDataList: [],
    bestFormat: l.bestFormat ? { ...l.bestFormat } : null,
    worstFormat: l.worstFormat ? { ...l.worstFormat } : null,
    budgetAdvice: null,
    nextCampaignRec: legacyNextCampaignRec(l, locale),
  }, locale)
}

/**
 * Client-safe projection: no grade, no Ratio EMV verdict, no worst performer,
 * no skip / "sin dato" lists, no budget advice, no agency data actions and no
 * € / CPM / ratio / budget / efficiency wording in any remaining text. Lists
 * and verdicts are regenerated from the facts with client criteria (ER, real
 * views, baseline, delivery). Pure over the full object.
 */
export function toClientLearnings(l: CampaignLearnings): CampaignLearnings {
  const locale = l.locale
  const projected = l.facts
    ? assertClientSafe(fromPlaybook(generatePlaybook(l.facts, locale, { audience: 'client' })), locale)
    : legacyClientProjection(l)
  return {
    generatedAt: l.generatedAt,
    locale,
    ...projected,
  }
}
