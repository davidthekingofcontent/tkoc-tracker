/**
 * Campaign Playbook™ — "qué hacer a continuación" built ONLY from the campaign
 * overview (src/lib/aprender-input.ts → src/lib/campaign-overview.ts →
 * src/lib/metrics.ts). Pure: no database, no network, no recomputed figure.
 *
 * Definitions (David, binding):
 *  - interacciones = likes + comentarios + shares + saves (3A).
 *  - vistas reales = platform views, and a piece's views count as REAL only
 *    when views ≥ likes (hasPlausibleViews); otherwise "sin dato real".
 *  - ER = interacciones ÷ vistas reales of the same pieces, published only with
 *    ≥ 3 pieces with views (campaign) / ≥ 1 (creator), ≥ 500 views, ≤ 100 %.
 *  - CPM = coste ÷ vistas reales × 1000 on the same reliable base (agency only).
 *  - Ratio EMV = EMV ÷ coste, shown as "×2,4"; never "ROI" (9B).
 *  - "×1,37 sobre su habitual" = perInfluencer.vsBaseline.
 *
 * Ranking (one list per audience, feeding "Mejor rendimiento", "Qué repetir"
 * and "Siguiente oleada" alike):
 *  - a creator QUALIFIES when its ER is published (er.value !== null): real,
 *    plausible views on ≥ 1 piece and ≥ 500 views;
 *  - agency: creators with cost AND a reliable base rank by real efficiency
 *    (views per euro, i.e. CPM ascending); the rest by ER; ties by baseline
 *    multiplier, then real views;
 *  - client: by ER (never a cost judgement), same tie-breaks;
 *  - creators without real views are never ranked: they are only mentioned for
 *    their interacciones, and the sentence says so. The words
 *    "eficiencia" / "CPM" / "vistas por euro" require cost + real views.
 *  - "Todavía no destaca ningún creador" only when nobody qualifies, and then
 *    "Siguiente oleada" recommends nobody;
 *  - "Qué repetir" / "Qué no repetir" judge each creator on the basis that
 *    ranked it (cost creators: CPM vs the campaign CPM; the rest: ER vs the
 *    campaign ER) and the first ranked creator is always repeated, so the
 *    "Mejor rendimiento" card, the repeat list, the value-picks / cut insights
 *    and the next-wave sentence never contradict each other (see rankCreators).
 *
 * Formats compare only on real views (median per piece) with ≥ 2 pieces with
 * real views per format and ≥ 2 formats; otherwise there is no comparison.
 *
 * Two audiences over the same facts: `audience: 'agency'` (everything) and
 * `audience: 'client'` (no cost, CPM, Ratio EMV, budget, worst performer, skip
 * list; data-status lines without the agency's action). Insights carry
 * `isAgencyOnly` so a projection can also filter an agency object.
 *
 * i18n: every generated string exists in Spanish (default) and English.
 * Numbers: formatInt ("1.059"), formatNumber for large view counts ("80,5K"),
 * formatPercent ("4,20 %"), formatRatio ("×2,3" / "×1,37"). No em dashes.
 */

import type { BusinessResults, CampaignBalance, DeliveryChecklist, EngagementRateResult, PerInfluencerMetrics, TargetComparison } from '@/lib/metrics'
import { ER_MIN_AUDIENCE, ER_MIN_PIECES_CAMPAIGN } from '@/lib/metrics'
import { formatInt, formatNumber, formatPercent, formatRatio } from '@/lib/utils'

// ============ TYPES ============

export type PlaybookLocale = 'es' | 'en'
export type PlaybookAudience = 'agency' | 'client'

/** One creator, straight from overview.perInfluencer (+ piece facts from perMedia). */
export interface PlaybookCreator {
  influencerId: string
  username: string
  platform: string
  media: number
  stories: number
  posts: number
  deleted: number
  /** Interacciones (3A). */
  engagements: number
  /** Σ plausible views (perInfluencer.er.denominator). */
  realViews: number
  /** Pieces behind realViews (perInfluencer.er.pieces). */
  realViewsPieces: number
  /** Pieces with views > 0 but below their likes (partial platform figure). */
  partialViewsPieces: number
  /** Pieces with no views at all. */
  noViewsPieces: number
  /** Creator ER on views (published with ≥ 1 piece, ≥ 500 views, ≤ 100 %). */
  er: EngagementRateResult
  /** Fee acordado, si no coste (6). 0 when unknown. */
  cost: number
  /** € per 1000 real views; null without cost or reliable base. */
  cpm: number | null
  emvExtended: number
  emvRatio: number | null
  vsBaseline: PerInfluencerMetrics['vsBaseline']
  deliverablesPlanned: number | null
  status: string
  /** Clicks on the creator's tracked link; null when not recorded. */
  clicks: number | null
  /** Distinct media types the creator published (deleted excluded). */
  formats: string[]
}

/** One format (media type) grouped from overview.perMedia. */
export interface PlaybookFormatGroup {
  format: string
  pieces: number
  piecesWithRealViews: number
  realViews: number
  /** Median real views per piece among pieces with real views; null when none. */
  medianRealViews: number | null
  engagements: number
  medianEngagements: number
}

export interface PlaybookTotals {
  media: number
  mediaDeleted: number
  stories: number
  posts: number
  creatorsActive: number
  members: number
  membersWithCost: number
  /** Raw Σ views (informative). */
  views: number
  /** Σ plausible views (totals.er.denominator). */
  realViews: number
  realViewsPieces: number
  partialViewsPieces: number
  reachReal: number
  engagements: number
  saves: number
  er: EngagementRateResult
  cost: number
  emvExtended: number
  emvRatio: number | null
  cpm: number | null
  /** Σ trackedClicks over creators with a recorded figure; null when none recorded. */
  clicks: number | null
  creatorsWithClicks: number
}

export interface PlaybookInput {
  campaignName: string
  objective: string         // awareness, engagement, traffic, conversion, content
  totals: PlaybookTotals
  creators: PlaybookCreator[]
  formats: PlaybookFormatGroup[]
  delivery: DeliveryChecklist | null
  balance: CampaignBalance | null
  targets: TargetComparison[]
  business: BusinessResults | null
}

export interface PlaybookFormatVerdict {
  format: string            // raw media type code (REEL, POST, STORY…)
  formatLabel: string       // localized, plural, lowercase ("reels", "publicaciones")
  reason: string            // localized explanation
}

export interface PlaybookInsight {
  type: 'success' | 'warning' | 'action' | 'insight' | 'info'
  icon: string              // emoji
  text: string              // localized
  textKey: string           // stable i18n key (locale-independent)
  /** true when the sentence is for the agency only (cost, data actions, skip advice). */
  isAgencyOnly?: boolean
}

export interface PlaybookResult {
  // Campaign summary (agency; 'N/A' / null / '' for the client audience)
  campaignGrade: string     // A+, A, B+, B, C, D, F, N/A
  roiRatio: number | null   // Ratio EMV (EMV ÷ cost) — wire name kept for compatibility; null without cost or content
  roiVerdict: string        // localized ("Ratio EMV sólido", "Sin coste registrado"…)

  insights: PlaybookInsight[]

  // Creator rankings (one ranked list per audience)
  topPerformer: { username: string; reason: string } | null
  worstPerformer: { username: string; reason: string } | null
  repeatList: string[]      // usernames to repeat
  skipList: string[]        // usernames to skip next time (agency only)
  /** Creators with content but without real views to judge them ("sin dato real"). */
  noDataList: string[]

  // Format analysis (real views only)
  bestFormat: PlaybookFormatVerdict | null
  worstFormat: PlaybookFormatVerdict | null

  budgetAdvice: string      // agency only ('' for the client audience)
  nextCampaignRec: string
}

export interface PlaybookOptions {
  audience?: PlaybookAudience
}

export type Objective = 'awareness' | 'engagement' | 'traffic' | 'conversion' | 'content'

// ============ FORMATTING ============

type Fmt = ReturnType<typeof makeFmt>

function makeFmt(locale: PlaybookLocale) {
  const es = locale === 'es'
  const tag = es ? 'es-ES' : 'en-GB'
  const int = (n: number) => formatInt(n, { locale })
  /** Views: compact from 10.000 ("80,5K"), exact below ("8.500"). */
  const views = (n: number) => (Math.abs(n) >= 10_000 ? formatNumber(n, { locale }) : int(n))
  const eur = (n: number, digits = 0) =>
    new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR', useGrouping: 'always', minimumFractionDigits: 0, maximumFractionDigits: digits })
      .format(Number.isFinite(n) ? n : 0)
  const pct = (n: number | null, digits = 2) => formatPercent(n, { locale, digits })
  const ratio = (n: number, digits = 1) => formatRatio(n, { locale, digits })
  const L = (esText: string, enText: string) => (es ? esText : enText)
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
  return { locale, es, int, views, eur, pct, ratio, L, plural }
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
  return (format || '').toLowerCase()
}

/** "los reels" / "las publicaciones" (Spanish article for a format label). */
function formatWithArticle(format: string, locale: PlaybookLocale): string {
  const label = playbookFormatLabel(format, locale)
  if (locale !== 'es') return label
  return `${format.toUpperCase() === 'POST' ? 'las' : 'los'} ${label}`
}

function creatorsCount(n: number, locale: PlaybookLocale): string {
  if (locale === 'es') return n === 1 ? '1 creador' : `${n} creadores`
  return n === 1 ? '1 creator' : `${n} creators`
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

export function normalizeObjective(value: string | null | undefined): Objective {
  const v = (value || '').toLowerCase()
  return v === 'engagement' || v === 'traffic' || v === 'conversion' || v === 'content' ? v : 'awareness'
}

// ============ RANKING ============

export type RankBasis = 'views_per_euro' | 'er'

export interface CreatorRanking {
  /** Qualified creators (ER published), best first. */
  ranked: PlaybookCreator[]
  /** Creators with content but no published ER ("sin dato real"). */
  noData: PlaybookCreator[]
  /** Members without any piece. */
  silent: PlaybookCreator[]
  basisOf: (c: PlaybookCreator) => RankBasis
  /** Campaign ER (or the median of the qualified creators' ERs) every creator is judged against. */
  erBenchmark: number | null
  repeat: PlaybookCreator[]
  skip: PlaybookCreator[]
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** ±10 % around the campaign figure counts as "at the campaign's level". */
const LEVEL_TOLERANCE = 0.10
/** A cost creator is "skip" only when its CPM is above this multiple of the campaign CPM AND its ER is below the campaign's. */
const SKIP_CPM_MULTIPLE = 3

/**
 * The one ranked list per audience. Only creators with a published ER are
 * ranked; the agency ranks cost + reliable base by real efficiency (CPM asc =
 * views per euro desc), the rest by ER; the client always by ER.
 *
 * "Qué repetir" / "Qué no repetir" judge every creator on the SAME basis the
 * ranking used, so the three verdicts (Mejor rendimiento, Qué repetir,
 * Siguiente oleada) can never contradict each other:
 *  - views_per_euro basis: repeat when the CPM is at the campaign's level
 *    (≤ campaign CPM +10 %); skip when the CPM is above 3× the campaign CPM
 *    AND the ER is below the campaign's (expensive and below-average);
 *  - er basis: repeat when the ER is at the campaign's level (≥ campaign ER
 *    −10 %); skip when the ER is below half the campaign's;
 *  - both: repeat also needs deliverables met and a baseline ≥ 0,9 when known;
 *    a baseline < 0,5 is always a skip;
 *  - the first ranked creator (the "Mejor rendimiento" card) is always in the
 *    repeat list.
 */
export function rankCreators(input: PlaybookInput, audience: PlaybookAudience): CreatorRanking {
  const withContent = input.creators.filter(c => c.media > 0)
  const silent = input.creators.filter(c => c.media === 0)
  const qualified = withContent.filter(c => c.er.value !== null)
  const noData = withContent.filter(c => c.er.value === null)

  // ONE ranking for both audiences (the client must never read a list that
  // contradicts the agency's): cost creators with a reliable base by views per
  // euro, the rest by ER. Only the WORDING differs per audience (no cost/CPM
  // figures for the client). `audience` still decides whether a skip list exists.
  const basisOf = (c: PlaybookCreator): RankBasis =>
    c.cost > 0 && c.cpm !== null && c.er.value !== null ? 'views_per_euro' : 'er'

  const ranked = [...qualified].sort((a, b) => {
    const ta = basisOf(a) === 'views_per_euro' ? 0 : 1
    const tb = basisOf(b) === 'views_per_euro' ? 0 : 1
    if (ta !== tb) return ta - tb
    if (ta === 0) {
      const d = (a.cpm as number) - (b.cpm as number)
      if (d !== 0) return d
    } else {
      const d = (b.er.value as number) - (a.er.value as number)
      if (d !== 0) return d
    }
    const ba = a.vsBaseline?.multiplier ?? -1
    const bb = b.vsBaseline?.multiplier ?? -1
    if (bb !== ba) return bb - ba
    return b.realViews - a.realViews
  })

  const erBenchmark = input.totals.er.value ?? medianOf(qualified.map(c => c.er.value as number))
  const campaignCpm = input.totals.cpm

  const deliveredAll = (c: PlaybookCreator) => c.deliverablesPlanned === null || c.deliverablesPlanned <= 0 || c.media >= c.deliverablesPlanned
  const baselineOk = (c: PlaybookCreator) => c.vsBaseline?.multiplier == null || c.vsBaseline.multiplier >= 1 - LEVEL_TOLERANCE
  const baselineBad = (c: PlaybookCreator) => c.vsBaseline?.multiplier != null && c.vsBaseline.multiplier < 0.5
  const erAtLevel = (c: PlaybookCreator) => erBenchmark !== null && (c.er.value as number) >= erBenchmark * (1 - LEVEL_TOLERANCE)
  const erHalf = (c: PlaybookCreator) => erBenchmark !== null && (c.er.value as number) < erBenchmark * 0.5
  const erBelow = (c: PlaybookCreator) => erBenchmark !== null && (c.er.value as number) < erBenchmark
  // Cost creators: the bar is the campaign CPM (overview.totals.cpm); without one, ER decides.
  const cpmAtLevel = (c: PlaybookCreator) => campaignCpm !== null && (c.cpm as number) <= campaignCpm * (1 + LEVEL_TOLERANCE)
  const cpmFar = (c: PlaybookCreator) => campaignCpm !== null && (c.cpm as number) > campaignCpm * SKIP_CPM_MULTIPLE

  const meetsLevel = (c: PlaybookCreator) =>
    basisOf(c) === 'views_per_euro' && campaignCpm !== null ? cpmAtLevel(c) : erAtLevel(c)
  const farBelow = (c: PlaybookCreator) =>
    basisOf(c) === 'views_per_euro' && campaignCpm !== null ? cpmFar(c) && erBelow(c) : erHalf(c)

  const top = ranked[0] ?? null
  const repeat = ranked.filter(c =>
    c === top
    || (meetsLevel(c) && baselineOk(c) && deliveredAll(c))
  )
  const repeatSet = new Set(repeat.map(c => c.influencerId))
  // "No repetir" only for creators who COST money: a zero-cost collaboration
  // (product only) with real views is never a reason to drop someone.
  const skip = audience === 'agency'
    ? ranked.filter(c => c.cost > 0 && !repeatSet.has(c.influencerId) && (farBelow(c) || baselineBad(c)))
    : []

  return { ranked, noData, silent, basisOf, erBenchmark, repeat, skip }
}

// ============ MAIN ============

export function generatePlaybook(input: PlaybookInput, locale: PlaybookLocale = 'es', options: PlaybookOptions = {}): PlaybookResult {
  const audience: PlaybookAudience = options.audience === 'client' ? 'client' : 'agency'
  const agency = audience === 'agency'
  const f = makeFmt(locale)
  const t = input.totals
  const objective = normalizeObjective(input.objective)

  if (input.creators.length === 0 && t.media === 0) {
    return createEmptyPlaybook(locale, agency)
  }

  // Ratio EMV: only with cost AND content (never "×0,0 / Ratio EMV bajo" when nothing was judged)
  const hasRatio = agency && t.emvRatio !== null && t.media > 0
  const roiRatio = hasRatio ? (t.emvRatio as number) : null
  const campaignGrade = hasRatio ? gradeEmvRatio(roiRatio as number) : 'N/A'
  const roiVerdict = !agency
    ? ''
    : hasRatio
      ? emvVerdict(roiRatio as number, locale)
      : t.media === 0
        ? f.L('Sin contenido capturado todavía', 'No content captured yet')
        : f.L('Sin coste registrado', 'No cost recorded')

  const ranking = rankCreators(input, audience)
  const top = ranking.ranked[0] ?? null
  const topPerformer = top ? { username: top.username, reason: topPerformerReason(top, ranking, input, objective, audience, f) } : null
  // Worst (agency): the last of the cost creators when at least two were judged on
  // views per euro (the agency's efficiency verdict); otherwise the last ranked.
  const costRanked = ranking.ranked.filter(c => ranking.basisOf(c) === 'views_per_euro')
  const worst = !agency || ranking.ranked.length < 2
    ? null
    : costRanked.length >= 2
      ? costRanked[costRanked.length - 1]
      : ranking.ranked[ranking.ranked.length - 1]
  const worstPerformer = worst ? { username: worst.username, reason: worstPerformerReason(worst, ranking, f) } : null

  const formats = compareFormats(input, locale, f)

  const insights = generateInsights(input, ranking, formats, objective, audience, f, locale).slice(0, MAX_INSIGHTS)

  const budgetAdvice = agency ? generateBudgetAdvice(input, roiRatio, f) : ''
  const nextCampaignRec = generateNextCampaignRec(input, ranking, formats.best, roiRatio, audience, f, locale)

  return {
    campaignGrade,
    roiRatio,
    roiVerdict,
    insights,
    topPerformer,
    worstPerformer,
    repeatList: ranking.repeat.map(c => c.username),
    skipList: ranking.skip.map(c => c.username),
    noDataList: ranking.noData.map(c => c.username),
    bestFormat: formats.best,
    worstFormat: formats.worst,
    budgetAdvice,
    nextCampaignRec,
  }
}

const MAX_INSIGHTS = 10

// ============ RATIO EMV ============

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

// ============ CREATOR SENTENCES ============

/** "×1,37 sobre su habitual" clause; '' without a usable baseline. */
function baselineClause(c: PlaybookCreator, f: Fmt): string {
  const m = c.vsBaseline?.multiplier
  if (m == null) return ''
  return f.L(`${f.ratio(m, 2)} sobre su habitual`, `${f.ratio(m, 2)} vs their usual`)
}

function publicationsWord(n: number, f: Fmt): string {
  return f.L(f.plural(n, 'publicación', 'publicaciones'), f.plural(n, 'publication', 'publications'))
}

/**
 * Why the top creator ranks first, from structured facts only. The metric that
 * decided the ranking closes the sentence; the objective's metric leads it.
 */
function topPerformerReason(c: PlaybookCreator, ranking: CreatorRanking, input: PlaybookInput, objective: Objective, audience: PlaybookAudience, f: Fmt): string {
  const basis = ranking.basisOf(c)
  const parts: string[] = []
  const erPart = f.L(
    `ER ${f.pct(c.er.value)} sobre ${f.views(c.realViews)} vistas reales`,
    `ER ${f.pct(c.er.value)} on ${f.views(c.realViews)} real views`
  )
  const viewsPart = f.L(
    `${f.views(c.realViews)} vistas reales en ${f.int(c.realViewsPieces)} ${publicationsWord(c.realViewsPieces, f)}`,
    `${f.views(c.realViews)} real views across ${f.int(c.realViewsPieces)} ${publicationsWord(c.realViewsPieces, f)}`
  )
  const engPart = f.L(`${f.int(c.engagements)} interacciones`, `${f.int(c.engagements)} interactions`)

  if (audience === 'client') {
    // The client never reads cost or CPM. The ranking is the agency's (views per
    // euro for cost creators), so the closing claims only what is TRUE for the
    // client's numbers: most real views, or best ER, or nothing superlative.
    parts.push(viewsPart)
    parts.push(f.L(`ER ${f.pct(c.er.value)}`, `ER ${f.pct(c.er.value)}`))
    if (objective === 'engagement') parts.push(engPart)
    const base0 = baselineClause(c, f)
    if (base0) parts.push(base0)
    const maxViews = Math.max(...ranking.ranked.map(r => r.realViews))
    const maxEr = Math.max(...ranking.ranked.map(r => r.er.value as number))
    const closingClient = c.realViews >= maxViews
      ? f.L('el creador con más vistas reales de la campaña', 'the creator with the most real views in the campaign')
      : (c.er.value as number) >= maxEr
        ? f.L('la mejor tasa de engagement sobre vistas reales de la campaña', 'the best engagement rate on real views in the campaign')
        : f.L('uno de los creadores con mejor resultado de la campaña', 'one of the best-performing creators of the campaign')
    return `${parts.join(', ')}: ${closingClient}.`
  }

  if (basis === 'views_per_euro') {
    parts.push(f.L(
      `${f.views(c.realViews)} vistas reales por ${f.eur(c.cost)} (CPM ${f.eur(c.cpm as number, 2)})`,
      `${f.views(c.realViews)} real views for ${f.eur(c.cost)} (CPM ${f.eur(c.cpm as number, 2)})`
    ))
    parts.push(f.L(`ER ${f.pct(c.er.value)}`, `ER ${f.pct(c.er.value)}`))
  } else if (objective === 'awareness') {
    parts.push(viewsPart)
    parts.push(f.L(`ER ${f.pct(c.er.value)}`, `ER ${f.pct(c.er.value)}`))
  } else {
    parts.push(erPart)
  }
  if (objective === 'engagement' || basis === 'er') parts.push(engPart)
  if (objective === 'traffic' && c.clicks !== null && c.clicks > 0) {
    parts.push(f.L(`${f.int(c.clicks)} clics`, `${f.int(c.clicks)} clicks`))
  }
  if (objective === 'content') {
    parts.push(f.L(`${f.int(c.media)} piezas`, `${f.int(c.media)} pieces`))
  }
  const base = baselineClause(c, f)
  if (base) parts.push(base)

  const closing = basis === 'views_per_euro'
    ? f.L('la mejor relación vistas por euro de la campaña', 'the best views-per-euro of the campaign')
    : audience === 'agency' && input.totals.membersWithCost > 0 && c.cost === 0
      ? f.L('la mejor tasa de engagement sobre vistas reales de la campaña (sin coste registrado para medir eficiencia)', 'the best engagement rate on real views in the campaign (no cost recorded to measure efficiency)')
      : f.L('la mejor tasa de engagement sobre vistas reales de la campaña', 'the best engagement rate on real views in the campaign')
  return `${parts.join(', ')}: ${closing}.`
}

/** Why the last qualified creator ranks last (agency only). */
function worstPerformerReason(c: PlaybookCreator, ranking: CreatorRanking, f: Fmt): string {
  const bench = ranking.erBenchmark
  if (ranking.basisOf(c) === 'views_per_euro') {
    // An ER above the campaign's is said, so "worst" reads as what it is: the costliest views, not a bad creator.
    const erNote = bench !== null && (c.er.value as number) >= bench
      ? f.L(', aunque con un ER por encima del de la campaña', ', although with an ER above the campaign\'s')
      : ''
    return f.L(
      `CPM ${f.eur(c.cpm as number, 2)} (${f.views(c.realViews)} vistas reales por ${f.eur(c.cost)}), ER ${f.pct(c.er.value)}: el CPM más alto entre los creadores con coste y vistas reales${erNote}.`,
      `CPM ${f.eur(c.cpm as number, 2)} (${f.views(c.realViews)} real views for ${f.eur(c.cost)}), ER ${f.pct(c.er.value)}: the highest CPM among creators with cost and real views${erNote}.`
    )
  }
  const base = baselineClause(c, f)
  // Honest scope: the ER group may sit behind cost creators with an even lower ER.
  const minEr = Math.min(...ranking.ranked.map(r => r.er.value as number))
  const lowestOverall = (c.er.value as number) <= minEr
  const scope = lowestOverall
    ? f.L('la tasa más baja entre los creadores con vistas reales', 'the lowest rate among creators with real views')
    : f.L('la tasa más baja entre los creadores sin coste registrado con vistas reales', 'the lowest rate among creators without a recorded cost and with real views')
  return f.L(
    `ER ${f.pct(c.er.value)} sobre ${f.views(c.realViews)} vistas reales${base ? `, ${base}` : ''}: ${scope}.`,
    `ER ${f.pct(c.er.value)} on ${f.views(c.realViews)} real views${base ? `, ${base}` : ''}: ${scope}.`
  )
}

/** Short "why there is no real data" for a creator with content but no published ER. */
function noDataReason(c: PlaybookCreator, f: Fmt): string {
  if (c.realViews <= 0) {
    return c.partialViewsPieces > 0
      ? f.L('vistas por debajo de sus likes, dato parcial', 'views below its likes, partial figure')
      : f.L('sin vistas reales', 'no real views')
  }
  if (c.er.reason === 'implausible') return f.L('interacciones por encima de las vistas registradas, dato parcial', 'interactions above the views on record, partial figure')
  return f.L(
    `solo ${f.views(c.realViews)} vistas reales en ${f.int(c.realViewsPieces)} ${publicationsWord(c.realViewsPieces, f)}, mínimo ${f.int(ER_MIN_AUDIENCE)}`,
    `only ${f.views(c.realViews)} real views across ${f.int(c.realViewsPieces)} ${publicationsWord(c.realViewsPieces, f)}, minimum ${f.int(ER_MIN_AUDIENCE)}`
  )
}

// ============ FORMATS ============

interface FormatComparison {
  best: PlaybookFormatVerdict | null
  worst: PlaybookFormatVerdict | null
  /** Formats with pieces but too few pieces with real views to compare. */
  comparable: PlaybookFormatGroup[]
  present: PlaybookFormatGroup[]
}

const FORMAT_MIN_PIECES = 2

/** Formats compared on the median of real views per piece, ≥ 2 pieces with real views per format, ≥ 2 formats. */
function compareFormats(input: PlaybookInput, locale: PlaybookLocale, f: Fmt): FormatComparison {
  const present = input.formats.filter(g => g.pieces > 0)
  const comparable = present.filter(g => g.piecesWithRealViews >= FORMAT_MIN_PIECES && g.medianRealViews !== null)
  if (comparable.length < 2) return { best: null, worst: null, comparable, present }

  const sorted = [...comparable].sort((a, b) => (b.medianRealViews as number) - (a.medianRealViews as number))
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  const piecesLabel = (g: PlaybookFormatGroup) => f.L(
    `${f.int(g.piecesWithRealViews)} ${f.plural(g.piecesWithRealViews, 'pieza', 'piezas')} con vistas reales`,
    `${f.int(g.piecesWithRealViews)} ${f.plural(g.piecesWithRealViews, 'piece', 'pieces')} with real views`
  )
  const multiplier = (worst.medianRealViews as number) > 0 ? (best.medianRealViews as number) / (worst.medianRealViews as number) : null
  const multiplierClause = multiplier !== null && multiplier >= 1.05
    ? f.L(`, ${f.ratio(multiplier)} sobre ${playbookFormatLabel(worst.format, locale)}`, `, ${f.ratio(multiplier)} vs ${playbookFormatLabel(worst.format, locale)}`)
    : ''

  return {
    best: {
      format: best.format,
      formatLabel: playbookFormatLabel(best.format, locale),
      reason: f.L(
        `Mediana de ${f.views(best.medianRealViews as number)} vistas reales por pieza (${piecesLabel(best)})${multiplierClause}.`,
        `Median of ${f.views(best.medianRealViews as number)} real views per piece (${piecesLabel(best)})${multiplierClause}.`
      ),
    },
    worst: {
      format: worst.format,
      formatLabel: playbookFormatLabel(worst.format, locale),
      reason: f.L(
        `Mediana de ${f.views(worst.medianRealViews as number)} vistas reales por pieza (${piecesLabel(worst)}).`,
        `Median of ${f.views(worst.medianRealViews as number)} real views per piece (${piecesLabel(worst)}).`
      ),
    },
    comparable,
    present,
  }
}

// ============ INSIGHTS ============

function generateInsights(
  input: PlaybookInput,
  ranking: CreatorRanking,
  formats: FormatComparison,
  objective: Objective,
  audience: PlaybookAudience,
  f: Fmt,
  locale: PlaybookLocale
): PlaybookInsight[] {
  const agency = audience === 'agency'
  const out: PlaybookInsight[] = []
  const push = (i: PlaybookInsight) => { if (agency || !i.isAgencyOnly) out.push(i) }

  // 1. Data coverage first: the caveat every other sentence stands on
  for (const i of coverageInsights(input, agency, f)) push(i)
  // 2. Prometido vs entregado
  for (const i of deliveryInsights(input, agency, f)) push(i)
  // 3. The objective, judged on its own metric
  for (const i of objectiveInsights(input, objective, agency, f)) push(i)
  // 4. Creators
  for (const i of creatorInsights(input, ranking, agency, f)) push(i)
  // 5. Formats
  for (const i of formatInsights(formats, agency, f, locale)) push(i)
  // 6. Ratio EMV and cost (agency)
  if (agency) for (const i of economicInsights(input, ranking, f)) push(i)

  return out
}

function coverageInsights(input: PlaybookInput, agency: boolean, f: Fmt): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  const t = input.totals
  if (t.media === 0) return out
  const er = t.er
  const askStats = agency ? f.L(' Pide a los creadores sus estadísticas para completarla.', ' Ask the creators for their insights to complete it.') : ''

  if (er.value === null) {
    if (er.reason === 'implausible') {
      out.push({
        type: 'info', icon: '📐', textKey: 'learnings_er_implausible',
        text: f.L(
          `La tasa de engagement no se publica: las interacciones superan las vistas reales registradas (el dato de vistas es parcial). Nunca se estima.${askStats}`,
          `The engagement rate is not published: the interactions exceed the real views on record (the views figure is partial). It is never estimated.${askStats}`
        ),
      })
    } else if (er.reason === 'insufficient_sample') {
      out.push({
        type: 'info', icon: '📐', textKey: 'learnings_er_insufficient_sample',
        text: f.L(
          `Muestra real insuficiente para la tasa de engagement: solo ${f.int(er.pieces)} ${publicationsWord(er.pieces, f)} ${f.plural(er.pieces, 'tiene', 'tienen')} vistas reales (${f.views(er.denominator)} vistas). Hacen falta al menos ${ER_MIN_PIECES_CAMPAIGN} publicaciones con vistas y ${f.int(ER_MIN_AUDIENCE)} vistas; nunca se estima.${askStats}`,
          `Insufficient real sample for the engagement rate: only ${f.int(er.pieces)} ${publicationsWord(er.pieces, f)} ${f.plural(er.pieces, 'has', 'have')} real views (${f.views(er.denominator)} views). At least ${ER_MIN_PIECES_CAMPAIGN} publications with views and ${f.int(ER_MIN_AUDIENCE)} views are needed; it is never estimated.${askStats}`
        ),
      })
    } else {
      out.push({
        type: 'info', icon: '📐', textKey: 'learnings_no_real_audience',
        text: f.L(
          `Ninguna de las ${f.int(t.media)} publicaciones tiene vistas reales, así que la tasa de engagement (interacciones ÷ vistas) no se calcula: no se estima nunca.${askStats}`,
          `None of the ${f.int(t.media)} publications has real views, so the engagement rate (interactions ÷ views) is not computed: it is never estimated.${askStats}`
        ),
      })
    }
  } else if (er.pieces < t.media) {
    const missing = t.media - er.pieces
    const shareReal = Math.round((er.pieces / t.media) * 100)
    out.push({
      type: 'info', icon: '📐', textKey: 'learnings_partial_real_audience',
      text: f.L(
        `La tasa de engagement se calcula sobre las ${f.int(er.pieces)} publicaciones con vistas reales (${shareReal} % del total); ${f.int(missing)} ${publicationsWord(missing, f)} ${f.plural(missing, 'queda', 'quedan')} fuera de esa base por no tener vistas reales.`,
        `The engagement rate stands on the ${f.int(er.pieces)} publications with real views (${shareReal}% of the total); ${f.int(missing)} ${publicationsWord(missing, f)} ${f.plural(missing, 'is', 'are')} left out of that base for lack of real views.`
      ),
    })
  }

  if (t.partialViewsPieces > 0) {
    const n = t.partialViewsPieces
    out.push({
      type: 'info', icon: '🔁', textKey: 'learnings_partial_views_pieces',
      text: f.L(
        `${f.int(n)} ${publicationsWord(n, f)} con vistas por debajo de sus likes: dato parcial, se ${f.plural(n, 'vuelve', 'vuelven')} a consultar.`,
        `${f.int(n)} ${publicationsWord(n, f)} with views below ${f.plural(n, 'its', 'their')} likes: partial figure, to be fetched again.`
      ),
    })
  }
  return out
}

function deliveryInsights(input: PlaybookInput, agency: boolean, f: Fmt): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  const d = input.delivery
  if (!d) return out

  if (d.allOk) {
    out.push({
      type: 'success', icon: '✅', textKey: 'learnings_delivery_all_ok',
      text: f.L(
        'Todo lo prometido se entregó: creadores, piezas, fechas dentro del periodo e identificación legal de la publicidad.',
        'Everything promised was delivered: creators, pieces, dates inside the campaign window and legal ad identification.'
      ),
    })
    return out
  }
  if (!agency) return out

  let warned = false
  if (!d.creators.ok && d.creators.planned > 0) {
    const missing = d.creators.planned - d.creators.delivered
    warned = true
    out.push({
      type: 'warning', icon: '⚠️', textKey: 'learnings_delivery_creators', isAgencyOnly: true,
      text: f.L(
        `${f.int(missing)} de ${f.int(d.creators.planned)} creadores acordados no ${f.plural(missing, 'ha publicado', 'han publicado')} todavía.`,
        `${f.int(missing)} of ${f.int(d.creators.planned)} agreed creators ${f.plural(missing, 'has', 'have')} not published yet.`
      ),
    })
  }
  if (!d.pieces.ok) {
    if (d.pieces.planned !== null && d.pieces.planned > 0) {
      const missing = Math.max(0, d.pieces.planned - d.pieces.delivered)
      warned = true
      out.push({
        type: 'warning', icon: '⚠️', textKey: 'learnings_delivery_pieces', isAgencyOnly: true,
        text: f.L(
          `Faltan ${f.int(missing)} de las ${f.int(d.pieces.planned)} piezas comprometidas (${f.int(d.pieces.delivered)} entregadas).`,
          `${f.int(missing)} of the ${f.int(d.pieces.planned)} committed pieces are missing (${f.int(d.pieces.delivered)} delivered).`
        ),
      })
    } else if (d.pieces.delivered === 0) {
      warned = true
      out.push({
        type: 'warning', icon: '⚠️', textKey: 'learnings_delivery_pieces', isAgencyOnly: true,
        text: f.L('Todavía no se ha entregado ninguna pieza.', 'No piece has been delivered yet.'),
      })
    }
  }
  if (!d.dates.ok && d.dates.total > 0) {
    const outside = d.dates.total - d.dates.inWindow
    warned = true
    out.push({
      type: 'warning', icon: '📅', textKey: 'learnings_delivery_dates', isAgencyOnly: true,
      text: f.L(
        `${f.int(outside)} ${publicationsWord(outside, f)} se ${f.plural(outside, 'publicó', 'publicaron')} fuera del periodo de la campaña (${f.int(d.dates.inWindow)} de ${f.int(d.dates.total)} dentro).`,
        `${f.int(outside)} ${publicationsWord(outside, f)} ${f.plural(outside, 'was', 'were')} published outside the campaign window (${f.int(d.dates.inWindow)} of ${f.int(d.dates.total)} inside).`
      ),
    })
  }
  if (!d.disclosure.ok && d.disclosure.total > 0) {
    const missing = d.disclosure.total - d.disclosure.disclosed
    warned = true
    out.push({
      type: 'warning', icon: '⚖️', textKey: 'learnings_delivery_disclosure', isAgencyOnly: true,
      text: f.L(
        `${f.int(missing)} ${publicationsWord(missing, f)} sin identificación #publicidad / colaboración pagada (${f.int(d.disclosure.disclosed)} de ${f.int(d.disclosure.total)} identificadas). Pide al creador que la añada.`,
        `${f.int(missing)} ${publicationsWord(missing, f)} without #ad / paid partnership identification (${f.int(d.disclosure.disclosed)} of ${f.int(d.disclosure.total)} identified). Ask the creator to add it.`
      ),
    })
  }
  if (!warned) {
    // Not ok, yet nothing to warn about: a dimension has nothing to check (no
    // agreed creators, no dated pieces, stories only). Say so instead of staying silent.
    const gaps: string[] = []
    if (d.creators.planned === 0) gaps.push(f.L('sin creadores en estado acordado o posterior', 'no creators in agreed status or later'))
    if (d.dates.total === 0) gaps.push(f.L('sin fechas de publicación', 'no publication dates'))
    if (d.disclosure.total === 0) gaps.push(f.L('sin piezas de feed para comprobar la identificación (solo stories)', 'no feed pieces to check the identification (stories only)'))
    if (gaps.length > 0) {
      out.push({
        type: 'info', icon: '📋', textKey: 'learnings_delivery_not_applicable', isAgencyOnly: true,
        text: f.L(
          `Checklist de entrega sin cerrar: ${gaps.join('; ')}.`,
          `Delivery checklist not closed: ${gaps.join('; ')}.`
        ),
      })
    }
  }
  return out
}

/** " (objetivo 50.000: por encima, +12 %)" for the target row `key`; '' when no target or no data. */
function targetClause(input: PlaybookInput, key: TargetComparison['key'], f: Fmt): string {
  const row = input.targets.find(r => r.key === key)
  if (!row || row.actual === null || row.variationPct === null) return ''
  const target = key === 'er' ? f.pct(row.target) : key === 'cpm' ? f.eur(row.target, 2) : f.views(row.target)
  // compareTargets flips the sign for lowerIsBetter rows (CPM): there 'above'
  // means "better than the target" although the value is numerically below it.
  const verdict = row.verdict === 'above'
    ? (row.lowerIsBetter ? f.L('mejor que el objetivo', 'better than target') : f.L('por encima', 'above'))
    : row.verdict === 'below'
      ? (row.lowerIsBetter ? f.L('peor que el objetivo', 'worse than target') : f.L('por debajo', 'below'))
      : f.L('en objetivo', 'on target')
  const sign = row.variationPct > 0 ? '+' : ''
  const pct = f.pct(row.variationPct, 0)
  return f.L(` (objetivo ${target}: ${verdict}, ${sign}${pct})`, ` (target ${target}: ${verdict}, ${sign}${pct})`)
}

function objectiveInsights(input: PlaybookInput, objective: Objective, agency: boolean, f: Fmt): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  const t = input.totals
  if (t.media === 0) return out

  switch (objective) {
    case 'awareness': {
      if (t.realViews > 0) {
        const reach = t.reachReal > 0 ? f.L(` y ${f.views(t.reachReal)} de alcance real`, ` and ${f.views(t.reachReal)} real reach`) : ''
        out.push({
          type: 'insight', icon: '👁️', textKey: 'playbook_objective_awareness',
          text: f.L(
            `Objetivo visibilidad: ${f.views(t.realViews)} vistas reales en ${f.int(t.realViewsPieces)} de ${f.int(t.media)} publicaciones${reach}${targetClause(input, 'views', f)}.`,
            `Awareness objective: ${f.views(t.realViews)} real views across ${f.int(t.realViewsPieces)} of ${f.int(t.media)} publications${reach}${targetClause(input, 'views', f)}.`
          ),
        })
      } else {
        out.push({
          type: 'info', icon: '👁️', textKey: 'playbook_objective_awareness_no_data',
          text: f.L(
            `Objetivo visibilidad: sin vistas reales registradas en las ${f.int(t.media)} publicaciones; el alcance no se estima.`,
            `Awareness objective: no real views on record across the ${f.int(t.media)} publications; reach is never estimated.`
          ),
        })
      }
      if (agency && t.cpm !== null) {
        out.push({
          type: 'info', icon: '💶', textKey: 'playbook_objective_awareness_cpm', isAgencyOnly: true,
          text: f.L(
            `CPM de campaña ${f.eur(t.cpm, 2)} sobre ${f.views(t.realViews)} vistas reales${targetClause(input, 'cpm', f)}.`,
            `Campaign CPM ${f.eur(t.cpm, 2)} on ${f.views(t.realViews)} real views${targetClause(input, 'cpm', f)}.`
          ),
        })
      }
      break
    }
    case 'engagement': {
      const saves = f.L(`${f.int(t.saves)} guardados`, `${f.int(t.saves)} saves`)
      if (t.er.value !== null) {
        out.push({
          type: 'insight', icon: '💬', textKey: 'playbook_objective_engagement',
          text: f.L(
            `Objetivo interacción: ${f.int(t.engagements)} interacciones (${saves}) y ER ${f.pct(t.er.value)} sobre ${f.views(t.realViews)} vistas reales${targetClause(input, 'er', f)}.`,
            `Engagement objective: ${f.int(t.engagements)} interactions (${saves}) and ER ${f.pct(t.er.value)} on ${f.views(t.realViews)} real views${targetClause(input, 'er', f)}.`
          ),
        })
      } else {
        out.push({
          type: 'info', icon: '💬', textKey: 'playbook_objective_engagement_no_er',
          text: f.L(
            `Objetivo interacción: ${f.int(t.engagements)} interacciones (${saves})${targetClause(input, 'engagement', f)}; la tasa de engagement no se publica por falta de vistas reales suficientes.`,
            `Engagement objective: ${f.int(t.engagements)} interactions (${saves})${targetClause(input, 'engagement', f)}; the engagement rate is not published for lack of sufficient real views.`
          ),
        })
      }
      break
    }
    case 'traffic': {
      if (t.clicks !== null && t.clicks > 0) {
        out.push({
          type: 'insight', icon: '🔗', textKey: 'playbook_objective_traffic',
          text: f.L(
            `Objetivo tráfico: ${f.int(t.clicks)} clics registrados en los enlaces de ${creatorsCount(t.creatorsWithClicks, f.locale)}.`,
            `Traffic objective: ${f.int(t.clicks)} clicks recorded on the links of ${creatorsCount(t.creatorsWithClicks, f.locale)}.`
          ),
        })
        if (agency && t.cost > 0) {
          out.push({
            type: 'info', icon: '💶', textKey: 'playbook_objective_traffic_cpc', isAgencyOnly: true,
            text: f.L(
              `Coste por clic ${f.eur(t.cost / t.clicks, 2)} (${f.eur(t.cost)} entre ${f.int(t.clicks)} clics).`,
              `Cost per click ${f.eur(t.cost / t.clicks, 2)} (${f.eur(t.cost)} over ${f.int(t.clicks)} clicks).`
            ),
          })
        }
      } else {
        const action = agency ? f.L(' Añade los clics de los enlaces UTM en la pestaña Elegir.', ' Add the UTM link clicks in the Elegir tab.') : ''
        out.push({
          type: 'info', icon: '🔗', textKey: 'playbook_objective_traffic_no_data',
          text: f.L(
            `Objetivo tráfico: sin clics registrados; el objetivo no se puede juzgar todavía.${action}`,
            `Traffic objective: no clicks recorded; the objective cannot be judged yet.${action}`
          ),
        })
      }
      break
    }
    case 'conversion': {
      const b = input.business
      const parts: string[] = []
      if (b) {
        if ((b.codeRedemptions ?? 0) > 0) parts.push(f.L(`${f.int(b.codeRedemptions as number)} canjes${b.promoCode ? ` del código ${b.promoCode}` : ''}`, `${f.int(b.codeRedemptions as number)} redemptions${b.promoCode ? ` of code ${b.promoCode}` : ''}`))
        if ((b.clientReportedSales ?? 0) > 0) parts.push(f.L(`${f.int(b.clientReportedSales as number)} ventas`, `${f.int(b.clientReportedSales as number)} sales`))
        if ((b.clientReportedLeads ?? 0) > 0) parts.push(f.L(`${f.int(b.clientReportedLeads as number)} leads`, `${f.int(b.clientReportedLeads as number)} leads`))
      }
      if (parts.length > 0) {
        out.push({
          type: 'insight', icon: '🛒', textKey: 'playbook_objective_conversion',
          text: f.L(
            `Objetivo conversión (datos aportados por el cliente): ${parts.join(', ')}.`,
            `Conversion objective (client-provided data): ${parts.join(', ')}.`
          ),
        })
        if (agency && b && ((b.clientReportedRevenue ?? 0) > 0 || b.cpa !== null)) {
          const bits: string[] = []
          if ((b.clientReportedRevenue ?? 0) > 0) bits.push(f.L(`${f.eur(b.clientReportedRevenue as number)} de ingresos`, `${f.eur(b.clientReportedRevenue as number)} revenue`))
          if (b.cpa !== null) bits.push(f.L(`coste por conversión ${f.eur(b.cpa, 2)}`, `cost per conversion ${f.eur(b.cpa, 2)}`))
          if (b.roas !== null) bits.push(f.L(`ROAS ${f.ratio(b.roas)}`, `ROAS ${f.ratio(b.roas)}`))
          out.push({
            type: 'info', icon: '💶', textKey: 'playbook_objective_conversion_economics', isAgencyOnly: true,
            text: f.L(`Resultados de negocio: ${bits.join(', ')} (aportados por el cliente).`, `Business results: ${bits.join(', ')} (client-provided).`),
          })
        }
      } else {
        const action = agency ? f.L(' Regístralos en Resultados de negocio cuando el cliente los facilite.', ' Record them under Business results once the client provides them.') : ''
        out.push({
          type: 'info', icon: '🛒', textKey: 'playbook_objective_conversion_no_data',
          text: f.L(
            `Objetivo conversión: sin resultados de negocio aportados por el cliente; el objetivo no se puede juzgar con las métricas de la plataforma.${action}`,
            `Conversion objective: no client-provided business results; the objective cannot be judged from platform metrics.${action}`
          ),
        })
      }
      break
    }
    case 'content': {
      const present = input.formats.filter(g => g.pieces > 0)
      const list = present.map(g => `${playbookFormatLabel(g.format, f.locale)} ${f.int(g.pieces)}`).join(', ')
      const planned = input.delivery?.pieces.planned
      const plannedClause = planned && planned > 0 ? f.L(` de ${f.int(planned)} comprometidas`, ` of ${f.int(planned)} committed`) : ''
      // Same base as the per-format counts (buildFormatGroups skips deleted pieces).
      const delivered = Math.max(0, t.media - t.mediaDeleted)
      out.push({
        type: 'insight', icon: '🎬', textKey: 'playbook_objective_content',
        text: f.L(
          `Objetivo contenido: ${f.int(delivered)} piezas entregadas${plannedClause} en ${f.int(present.length)} ${f.plural(present.length, 'formato', 'formatos')}${list ? ` (${list})` : ''}.`,
          `Content objective: ${f.int(delivered)} pieces delivered${plannedClause} across ${f.int(present.length)} ${f.plural(present.length, 'format', 'formats')}${list ? ` (${list})` : ''}.`
        ),
      })
      break
    }
  }
  return out
}

function creatorInsights(input: PlaybookInput, ranking: CreatorRanking, agency: boolean, f: Fmt): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  const withContent = input.creators.filter(c => c.media > 0)
  if (withContent.length === 0) return out

  // Nobody qualifies: the creator with most interacciones is mentioned for them alone, and the sentence says so
  if (ranking.ranked.length === 0) {
    const most = [...withContent].sort((a, b) => b.engagements - a.engagements)[0]
    if (most && most.engagements > 0) {
      out.push({
        type: 'info', icon: '💬', textKey: 'playbook_interactions_only',
        text: agency
          ? f.L(
              `@${most.username} sumó ${f.int(most.engagements)} interacciones en ${f.int(most.media)} ${publicationsWord(most.media, f)}, sin vistas reales para medir su eficiencia (${noDataReason(most, f)}).`,
              `@${most.username} totalled ${f.int(most.engagements)} interactions across ${f.int(most.media)} ${publicationsWord(most.media, f)}, with no real views to measure efficiency (${noDataReason(most, f)}).`
            )
          : f.L(
              `@${most.username} sumó ${f.int(most.engagements)} interacciones en ${f.int(most.media)} ${publicationsWord(most.media, f)}, sin vistas reales para medir su rendimiento.`,
              `@${most.username} totalled ${f.int(most.engagements)} interactions across ${f.int(most.media)} ${publicationsWord(most.media, f)}, with no real views to measure performance.`
            ),
      })
    }
  }

  // Concentration risk: the creator holding most interacciones (not the efficiency winner)
  if (withContent.length >= 3) {
    const totalEng = withContent.reduce((s, c) => s + c.engagements, 0)
    const top = [...withContent].sort((a, b) => b.engagements - a.engagements)[0]
    const share = totalEng > 0 ? top.engagements / totalEng : 0
    if (share > 0.5) {
      const pct = Math.round(share * 100)
      out.push({
        type: 'insight', icon: '📊', textKey: 'playbook_concentration_risk',
        text: f.L(
          `@${top.username} generó el ${pct} % de todas las interacciones: alto riesgo de concentración, diversifica la próxima vez.`,
          `@${top.username} generated ${pct}% of all interactions: high concentration risk, diversify next time.`
        ),
      })
    }
  }

  // Creators the data cannot judge (agency: ask for their insights)
  if (agency && ranking.noData.length > 0) {
    const n = ranking.noData.length
    const list = ranking.noData.slice(0, 4).map(c => `@${c.username}: ${noDataReason(c, f)}`).join('; ')
    const more = n > 4 ? f.L(` y ${n - 4} más`, ` and ${n - 4} more`) : ''
    out.push({
      type: 'warning', icon: '📥', textKey: 'playbook_no_real_data_creators', isAgencyOnly: true,
      text: f.L(
        `${creatorsCount(n, 'es')} sin vistas reales suficientes para ${n === 1 ? 'valorarlo' : 'valorarlos'} (${list}${more}): pide sus estadísticas antes de decidir.`,
        `${creatorsCount(n, 'en')} without enough real views to be judged (${list}${more}): ask for their insights before deciding.`
      ),
    })
  }
  return out
}

function formatInsights(formats: FormatComparison, agency: boolean, f: Fmt, locale: PlaybookLocale): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  if (formats.best) {
    const label = formatWithArticle(formats.best.format, locale)
    out.push({
      type: 'action', icon: '🎬', textKey: 'playbook_best_format',
      text: agency
        ? f.L(
            `${capitalize(label)} fueron el formato con más vistas reales por pieza. ${formats.best.reason} Prioriza este formato en la siguiente oleada.`,
            `${capitalize(label)} were the format with most real views per piece. ${formats.best.reason} Prioritise it in the next wave.`
          )
        : f.L(
            `El formato que mejor funcionó fueron ${label}. ${formats.best.reason}`,
            `${capitalize(label)} performed best. ${formats.best.reason}`
          ),
    })
  } else if (agency && formats.present.length >= 2) {
    const detail = formats.present
      .map(g => `${playbookFormatLabel(g.format, locale)} ${f.int(g.piecesWithRealViews)}/${f.int(g.pieces)}`)
      .join(', ')
    out.push({
      type: 'info', icon: '🎬', textKey: 'playbook_formats_not_comparable', isAgencyOnly: true,
      text: f.L(
        `Sin comparación entre formatos: hacen falta al menos ${FORMAT_MIN_PIECES} piezas con vistas reales por formato (con vistas reales: ${detail}).`,
        `No format comparison: at least ${FORMAT_MIN_PIECES} pieces with real views per format are needed (with real views: ${detail}).`
      ),
    })
  }
  return out
}

function economicInsights(input: PlaybookInput, ranking: CreatorRanking, f: Fmt): PlaybookInsight[] {
  const out: PlaybookInsight[] = []
  const t = input.totals

  if (t.media === 0) {
    out.push({
      type: 'info', icon: 'ℹ️', textKey: 'playbook_no_content', isAgencyOnly: true,
      text: f.L(
        'Sin contenido capturado todavía: el Ratio EMV se calculará con las primeras publicaciones.',
        'No content captured yet: the EMV ratio will be computed with the first publications.'
      ),
    })
  } else if (t.emvRatio === null || t.cost <= 0) {
    out.push({
      type: 'info', icon: 'ℹ️', textKey: 'playbook_no_cost', isAgencyOnly: true,
      text: f.L(
        'Sin fees ni costes registrados: el Ratio EMV no se puede calcular. Regístralos en la pestaña Elegir.',
        'No fees or costs recorded: the EMV ratio cannot be computed. Record them in the Elegir tab.'
      ),
    })
  } else if (t.emvRatio >= 2.0) {
    out.push({
      type: 'success', icon: '🎯', textKey: 'playbook_roi_strong', isAgencyOnly: true,
      text: f.L(
        `La campaña generó un Ratio EMV de ${f.ratio(t.emvRatio)} (EMV ${f.eur(t.emvExtended)} sobre ${f.eur(t.cost)} de inversión). Rendimiento sólido.`,
        `The campaign generated a ${f.ratio(t.emvRatio)} EMV ratio (EMV ${f.eur(t.emvExtended)} on ${f.eur(t.cost)} invested). Strong performance.`
      ),
    })
  } else if (t.emvRatio < 1.0) {
    out.push({
      type: 'warning', icon: '⚠️', textKey: 'playbook_roi_negative', isAgencyOnly: true,
      text: f.L(
        `El EMV de la campaña (${f.eur(t.emvExtended)}) quedó por debajo de la inversión (${f.eur(t.cost)}). El Ratio EMV es ${f.ratio(t.emvRatio)}.`,
        `Campaign EMV (${f.eur(t.emvExtended)}) was below the investment (${f.eur(t.cost)}). The EMV ratio is ${f.ratio(t.emvRatio)}.`
      ),
    })
  } else {
    out.push({
      type: 'info', icon: '📈', textKey: 'playbook_roi_positive', isAgencyOnly: true,
      text: f.L(
        `Ratio EMV ${f.ratio(t.emvRatio)}: el EMV (${f.eur(t.emvExtended)}) supera la inversión (${f.eur(t.cost)}).`,
        `EMV ratio ${f.ratio(t.emvRatio)}: the EMV (${f.eur(t.emvExtended)}) exceeds the investment (${f.eur(t.cost)}).`
      ),
    })
  }

  // Cost efficiency, on the SAME repeat / skip sets the lists show, restricted to
  // creators whose CPM the report itself publishes: an insight can never call
  // "mejor apuesta" a creator the skip list rejects, or vice versa.
  if (t.cpm === null) return out
  const isCostBasis = (c: PlaybookCreator) => ranking.basisOf(c) === 'views_per_euro'
  // The repeat set also admits the +10 % band and the forced top creator; the
  // sentence promises "igual o mejor", so only creators at or below the
  // campaign CPM are named here.
  const campaignCpm = t.cpm
  const valuePicks = ranking.repeat.filter(c => isCostBasis(c) && (c.cpm as number) <= campaignCpm)
  if (valuePicks.length > 0) {
    const n = valuePicks.length
    const names = valuePicks.map(c => `@${c.username} (${f.eur(c.cpm as number, 2)})`).join(', ')
    out.push({
      type: 'success', icon: '💰', textKey: 'playbook_value_picks', isAgencyOnly: true,
      text: f.L(
        `${creatorsCount(n, 'es')} con CPM igual o mejor que el de la campaña (${f.eur(t.cpm, 2)}) sobre vistas reales: ${names}. ${n === 1 ? 'Tu mejor apuesta' : 'Tus mejores apuestas'} en relación calidad-precio.`,
        `${creatorsCount(n, 'en')} with a CPM at or better than the campaign's (${f.eur(t.cpm, 2)}) on real views: ${names}. Your best value ${n === 1 ? 'pick' : 'picks'}.`
      ),
    })
  }
  const expensive = ranking.skip.filter(isCostBasis)
  if (expensive.length > 0) {
    const n = expensive.length
    const names = expensive.map(c => `@${c.username} (${f.eur(c.cpm as number, 2)}, ER ${f.pct(c.er.value)})`).join(', ')
    out.push({
      type: 'warning', icon: '📉', textKey: 'playbook_cut_underperformers', isAgencyOnly: true,
      text: f.L(
        `${creatorsCount(n, 'es')} con CPM más de ${SKIP_CPM_MULTIPLE} veces el de la campaña y ER por debajo del de la campaña (${names}): descarta o renegocia para la próxima campaña.`,
        `${creatorsCount(n, 'en')} with a CPM more than ${SKIP_CPM_MULTIPLE} times the campaign's and an ER below the campaign's (${names}): cut or renegotiate for the next campaign.`
      ),
    })
  }
  return out
}

// ============ ADVICE ============

function generateBudgetAdvice(input: PlaybookInput, ratio: number | null, f: Fmt): string {
  const t = input.totals
  if (t.media === 0) {
    return f.L(
      'Sin contenido capturado: el consejo de presupuesto llegará con las primeras publicaciones.',
      'No content captured: budget advice will follow the first publications.'
    )
  }
  if (ratio === null) {
    return f.L(
      'Registra los fees o costes de los creadores en la pestaña Elegir para obtener el Ratio EMV y el consejo de presupuesto.',
      'Record the creators\' fees or costs in the Elegir tab to get the EMV ratio and budget advice.'
    )
  }
  if (ratio >= 2.0) {
    return f.L(
      `Ratio EMV sólido de ${f.ratio(ratio)}. Plantéate aumentar el presupuesto un 20-30 % y concentrarlo en los creadores de la lista "Repetir".`,
      `Strong EMV ratio at ${f.ratio(ratio)}. Consider increasing the budget by 20-30% and concentrating it on the "Repeat" list.`
    )
  }
  if (ratio >= 1.0) {
    return f.L(
      `Ratio EMV positivo pero modesto (${f.ratio(ratio)}). Misma inversión, mejor reparto: mueve presupuesto hacia los creadores de la lista "Repetir".`,
      `Positive but modest EMV ratio (${f.ratio(ratio)}). Same spend, better distribution: move budget towards the "Repeat" list.`
    )
  }
  return f.L(
    `Ratio EMV por debajo del objetivo (${f.ratio(ratio)}). Reduce el presupuesto total o concéntralo en menos creadores con vistas reales probadas. Calidad antes que cantidad.`,
    `EMV ratio below target (${f.ratio(ratio)}). Reduce the total budget or concentrate it on fewer creators with proven real views. Quality over quantity.`
  )
}

/** Why nobody can be recommended, from the campaign ER reason (client-safe wording). */
function noQualifiedReason(input: PlaybookInput, f: Fmt): string {
  const t = input.totals
  if (t.media === 0) return f.L('todavía no hay publicaciones registradas', 'no publications are tracked yet')
  if (t.er.reason === 'implausible' || (t.realViewsPieces === 0 && t.partialViewsPieces > 0)) {
    return f.L(
      'las vistas registradas están por debajo de las interacciones (dato parcial) y ningún creador tiene una base real suficiente',
      'the views on record are below the interactions (partial figure) and no creator has a sufficient real base'
    )
  }
  if (t.realViewsPieces === 0) {
    return f.L(
      `ninguna de las ${f.int(t.media)} publicaciones tiene vistas reales`,
      `none of the ${f.int(t.media)} publications has real views`
    )
  }
  const missing = t.media - t.realViewsPieces
  return f.L(
    `faltan vistas reales en ${f.int(missing)} de las ${f.int(t.media)} publicaciones y ningún creador alcanza las ${f.int(ER_MIN_AUDIENCE)} vistas reales necesarias`,
    `real views are missing on ${f.int(missing)} of the ${f.int(t.media)} publications and no creator reaches the ${f.int(ER_MIN_AUDIENCE)} real views required`
  )
}

function generateNextCampaignRec(
  input: PlaybookInput,
  ranking: CreatorRanking,
  bestFormat: PlaybookFormatVerdict | null,
  ratio: number | null,
  audience: PlaybookAudience,
  f: Fmt,
  locale: PlaybookLocale
): string {
  const agency = audience === 'agency'
  // Every creator of the repeat list is named (the first five, then "y N más"),
  // so the sentence and the "Qué repetir" list always agree.
  const MAX_NAMES = 5
  const restCount = Math.max(0, ranking.repeat.length - MAX_NAMES)
  const names = ranking.repeat.slice(0, MAX_NAMES).map(c => `@${c.username}`).join(', ')
    + (restCount > 0 ? f.L(` y ${f.int(restCount)} más`, ` and ${f.int(restCount)} more`) : '')
  const formatRec = bestFormat
    ? f.L(` y céntrate en ${bestFormat.formatLabel}`, ` and focus on ${bestFormat.formatLabel}`)
    : ''

  // Nobody qualifies: recommend nobody, and say why
  if (ranking.ranked.length === 0) {
    const why = noQualifiedReason(input, f)
    if (agency) {
      return f.L(
        `No se puede recomendar a ningún creador: ${why}. Pide a los creadores sus estadísticas antes de decidir la siguiente oleada.`,
        `No creator can be recommended: ${why}. Ask the creators for their insights before deciding the next wave.`
      )
    }
    return f.L(
      `Todavía no recomendamos creadores para la próxima campaña: ${why}. Con las vistas reales completas afinaremos la recomendación.`,
      `We do not recommend creators for the next campaign yet: ${why}. With the real views completed we will sharpen the recommendation.`
    )
  }

  // Qualified creators, none over the bar
  if (ranking.repeat.length === 0) {
    const bench = ranking.erBenchmark !== null ? f.pct(ranking.erBenchmark) : null
    if (agency) {
      const cpm = input.totals.cpm
      const criteria = [
        cpm !== null
          ? f.L(`CPM al nivel de la campaña (${f.eur(cpm, 2)}) para los creadores con coste, ER al nivel de la campaña${bench ? ` (${bench})` : ''} para el resto`, `CPM at the campaign's level (${f.eur(cpm, 2)}) for creators with cost, ER at the campaign's level${bench ? ` (${bench})` : ''} for the rest`)
          : bench ? f.L(`ER al nivel de la campaña (${bench})`, `ER at the campaign's level (${bench})`) : f.L('ER al nivel de la campaña', 'ER at the campaign\'s level'),
        f.L('entregables completos', 'deliverables complete'),
        f.L('resultado en línea con su habitual', 'in line with their usual'),
      ].join(', ')
      return f.L(
        `Ningún creador cumple los criterios para repetir (${criteria}). Revisa el roster antes de la siguiente oleada${bestFormat ? ` y prioriza ${bestFormat.formatLabel}` : ''}.`,
        `No creator meets the repeat criteria (${criteria}). Review the roster before the next wave${bestFormat ? ` and prioritise ${bestFormat.formatLabel}` : ''}.`
      )
    }
    return f.L(
      `Ningún creador destaca todavía sobre la media de la campaña${bestFormat ? `; el formato que mejor funcionó fueron ${formatWithArticle(bestFormat.format, locale)}` : ''}. Afinaremos la recomendación con la siguiente oleada.`,
      `No creator stands out above the campaign average yet${bestFormat ? `; ${bestFormat.formatLabel} performed best` : ''}. We will sharpen the recommendation with the next wave.`
    )
  }

  if (!agency) {
    return f.L(
      `Para la próxima campaña recomendamos repetir con ${names}${bestFormat ? ` y centrar el contenido en ${bestFormat.formatLabel}` : ''}.`,
      `For the next campaign we recommend repeating with ${names}${bestFormat ? ` and focusing the content on ${bestFormat.formatLabel}` : ''}.`
    )
  }

  const t = input.totals
  if (ratio === null) {
    const dataStatus = t.cost <= 0
      ? f.L('Sin coste registrado no hay Ratio EMV que valide escalar: registra los fees en la pestaña Elegir.', 'Without a recorded cost there is no EMV ratio to validate scaling: record the fees in the Elegir tab.')
      : f.L('El Ratio EMV llegará con las primeras publicaciones.', 'The EMV ratio will follow the first publications.')
    return f.L(
      `Repite con ${names}${formatRec}. ${dataStatus}`,
      `Repeat with ${names}${formatRec}. ${dataStatus}`
    )
  }
  if (ratio >= 2.0) {
    return f.L(
      `Escala esta campaña: mantén a ${names}${formatRec}. El Ratio EMV ${f.ratio(ratio)} respalda aumentar la inversión para amplificar lo que funciona.`,
      `Scale this campaign: keep ${names}${formatRec}. The ${f.ratio(ratio)} EMV ratio supports increasing the investment to amplify what works.`
    )
  }
  if (ratio >= 1.0) {
    return f.L(
      `Repite con un roster más ajustado: ${names}${formatRec}. Con un Ratio EMV ${f.ratio(ratio)}, mantén la inversión y repártela hacia estos creadores.`,
      `Repeat with a tighter roster: ${names}${formatRec}. With a ${f.ratio(ratio)} EMV ratio, keep the investment and shift it towards these creators.`
    )
  }
  return f.L(
    `Replantea el enfoque: el Ratio EMV ${f.ratio(ratio)} no llegó a la inversión. Prueba con ${names} con tarifas más bajas${formatRec}; valida antes de escalar.`,
    `Rethink the approach: the ${f.ratio(ratio)} EMV ratio did not reach the investment. Test with ${names} at lower fees${formatRec}; validate before scaling.`
  )
}

function createEmptyPlaybook(locale: PlaybookLocale, agency: boolean): PlaybookResult {
  const es = locale === 'es'
  return {
    campaignGrade: 'N/A',
    roiRatio: null,
    roiVerdict: agency ? (es ? 'Sin datos' : 'No data') : '',
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
    noDataList: [],
    bestFormat: null,
    worstFormat: null,
    budgetAdvice: agency ? (es ? 'Datos insuficientes.' : 'Insufficient data.') : '',
    nextCampaignRec: es
      ? 'Empieza a registrar el contenido de los creadores para generar recomendaciones.'
      : 'Start tracking creator content to generate recommendations.',
  }
}
