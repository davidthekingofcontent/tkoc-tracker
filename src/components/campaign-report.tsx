'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { cn, formatNumber, formatEur, formatRatio, formatDate } from '@/lib/utils'
import { mediaThumbUrl, proxyImg } from '@/lib/proxy-image'
import type { BaselineComparison } from '@/lib/creator-baseline'
// Pure module (no Prisma): the ONE economic-wording test the server projection
// uses, kept here only as a last-resort print guard (see screenOnly below).
import { hasEconomicWording } from '@/lib/campaign-learnings'
import { useI18n } from '@/i18n/context'
import type { Locale, TranslationKeys } from '@/i18n/translations'
// Types only: '@/lib/report-config' imports Prisma and must never be bundled
// into this client component.
import type {
  DeliveryExtraRow,
  DeliveryOverride,
  DeliveryRowKey,
  HighlightedComment,
  ReportCommentSentiment,
  ReportConfig,
  ReportColumnId,
  ReportDeliveryConfig,
  ReportSectionId,
  ReportSentVersion,
} from '@/lib/report-config'
// Types only: the shapes of the server-side overview (src/lib/metrics.ts).
import type {
  AudienceBasis,
  AudienceTotals,
  BusinessResults,
  CampaignBalance,
  DeliveryChecklist,
  EngagementRateResult,
  TargetComparison,
  TargetKey,
  TargetVerdict,
} from '@/lib/metrics'
import {
  ArrowLeft,
  ArrowRight,
  Printer,
  Loader2,
  ExternalLink,
  Users,
  Image as ImageIcon,
  Eye,
  EyeOff,
  Heart,
  TrendingUp,
  BarChart3,
  Search,
  ShieldCheck,
  Building2,
  CalendarDays,
  Pencil,
  Send,
  Check,
  X,
  Trash2,
  Tag,
  ShoppingBag,
  Coins,
  Target,
  Lightbulb,
  Repeat,
  Film,
  Info,
  TriangleAlert,
  ClipboardList,
  Star,
  CircleCheck,
  CircleDashed,
  MessageSquare,
  Plus,
  FileDown,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Shared campaign report — rendered by BOTH the agency dashboard report page
// (/campaigns/[id]/report, data from /api/campaigns/[id]?view=report) and the
// client brand portal (/portal/campaigns/[id]/report, data from
// /api/portal/campaigns/[id]).
//
// EVERY figure comes from the server-side overview (computeCampaignOverview,
// definitions v2 in src/lib/metrics.ts) returned next to the campaign. This
// component never recomputes reach, ER, timelines or costs: it joins the
// media / roster rows with overview.perMedia / overview.perInfluencer by id
// and formats. The portal API strips ALL economic fields (fees, cost, CPM,
// Ratio EMV, basic EMV), so every fee-derived column is data-driven AND gated
// by !isPortal.
//
// Decision 4A/4B (David 2026-09-05) and the brand study (2026-09-08): REAL
// data only. Headline numbers are real (views, real audience, interactions,
// ER = interactions ÷ real views); impressions and estimated audiences are
// never shown to the client. ONE EMV figure, labelled "EMV", with a hover
// explanation on screen and a discreet footnote on paper. A "Prometido vs
// entregado" checklist and (agency only) the four-dimension balance come
// straight from overview.delivery / overview.balance. No daily chart.
//
// Print (David 2026-09-08, WYSIWYG): the printed page and the server PDF are
// the SAME visual as the screen report — same layout, cards, tables, fonts and
// logo placement — minus the agency-only elements. There is NO paper relayout:
// the print CSS only hides the app chrome, forces the light theme, pins the
// report to REPORT_PRINT_WIDTH_PX (the desktop layout) on an A4-proportioned
// page measured in screen pixels, and adds page-break hygiene. The body shows
// up to six pieces with REAL audience (never one without); the complete list
// is the annex. While printing, the learnings render the client projection.
// `printMode` (?print=1, the server-side PDF renderer) applies the same rules
// on screen, hides the top bar and flags <html data-report-ready="1"> once
// data and images have settled.
//
// The PM can tailor what the client sees (decision 16A): title/subtitle,
// an intro and a conclusions text, hidden sections/columns/rows. That config
// is stored per campaign (see src/lib/report-config.ts). Hidden rows are
// excluded from every figure BY THE API (view=report / portal); the client
// only keeps the row filtering as defense in depth.
// ---------------------------------------------------------------------------

// Types — defensive: every field is treated as potentially missing.

interface ReportInfluencer {
  id?: string
  username?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  platform?: string | null
  followers?: number | null
  engagementRate?: number | null
}

interface ReportMember {
  /** Agency response carries influencerId; the portal only influencer.id */
  influencerId?: string | null
  status?: string | null
  agreedFee?: number | null
  cost?: number | null
  negotiatedFormat?: string | null
  /** BaselineSnapshot Json (parsed defensively with parseBaseline) */
  baselineSnapshot?: unknown
  influencer?: ReportInfluencer | null
}

/** Per-row metrics: overview.perMedia entry, or the `metrics` object the agency API attaches to each row. */
interface ReportMediaMetrics {
  audience: number
  audienceBasis: AudienceBasis
  audienceEstimated: boolean
  engagements: number
  emvExtended: number
  isDeleted?: boolean
}

interface ReportMedia {
  id: string
  mediaType?: string | null
  caption?: string | null
  thumbnailUrl?: string | null
  permalink?: string | null
  likes?: number | null
  comments?: number | null
  views?: number | null
  shares?: number | null
  saves?: number | null
  reach?: number | null
  impressions?: number | null
  source?: string | null
  /**
   * Real statistics supplied by the creator ('creator_screenshot' |
   * 'creator_api' | 'manual'); null = public data only. Treated as real.
   */
  insightsSource?: string | null
  postedAt?: string | null
  /** Decision 7B: deleted posts stay in the report with a visible mark. Absent in old responses. */
  isDeleted?: boolean | null
  deletedAt?: string | null
  metrics?: ReportMediaMetrics | null
  influencer?: {
    id?: string | null
    username?: string | null
    avatarUrl?: string | null
  } | null
}

interface ReportBrand {
  name?: string | null
  logo?: string | null
}

interface ReportCampaign {
  id?: string
  name?: string
  status?: string
  startDate?: string | null
  endDate?: string | null
  platforms?: string[]
  /** Resolved by both APIs from Setting 'campaign_brand_{id}'; null when unassigned */
  brand?: ReportBrand | null
  influencers?: ReportMember[]
  media?: ReportMedia[]
}

// --- Overview (server-side single source of truth) ---------------------------
// Economic keys are optional: the portal projection drops them entirely.

interface ReportOverviewTotals {
  media: number
  mediaDeleted: number
  stories: number
  posts: number
  creatorsActive: number
  views: number
  likes: number
  comments: number
  shares: number
  saves: number
  engagements: number
  /** The portal projection only carries the real figures (real, realPieces, counts). */
  audience: Pick<AudienceTotals, 'real' | 'realPieces'> & Partial<AudienceTotals>
  reachReal: number
  /** Agency only (never shown; the portal projection drops it). */
  impressionsReal?: number | null
  er: EngagementRateResult
  members: number
  emvExtended: number
  /** Agency only (internal breakdown; the portal projection drops them). */
  emvEstimatedStories?: number
  emvRealStories: number
  emvEstimatedAudience?: number
  mediaCounts: Record<string, number>
  /** Agency only */
  cost?: number
  membersWithCost?: number
  emvBasic?: number
  emvRatio?: number | null
  cpm?: number | null
}

interface ReportPerInfluencer {
  influencerId: string
  username: string
  platform: string
  displayName: string | null
  followers: number
  media: number
  stories: number
  posts: number
  deleted: number
  views: number
  engagements: number
  audience: Pick<AudienceTotals, 'real' | 'realPieces'> & Partial<AudienceTotals>
  er: EngagementRateResult
  emvExtended: number
  deliverablesPlanned: number | null
  status: string
  /** Server-computed "×1,37 sobre su habitual" (median per piece vs frozen baseline). */
  vsBaseline?: (BaselineComparison & { piecesCompared?: number }) | null
  /** Agency only */
  cost?: number
  emvBasic?: number
  emvRatio?: number | null
  cpm?: number | null
}

interface ReportPerMedia extends ReportMediaMetrics {
  id: string
  isDeleted: boolean
  emvBasic?: number
}

interface ReportOverview {
  definitionsVersion?: number
  totals: ReportOverviewTotals
  perInfluencer: ReportPerInfluencer[]
  perMedia: ReportPerMedia[]
  targets: TargetComparison[]
  business: BusinessResults | null
  /** "Prometido vs entregado" (server-computed); null in an older response. */
  delivery: DeliveryChecklist | null
  /** Four labelled dimensions (agency only on screen); null in an older response. */
  balance: CampaignBalance | null
}

/** Sentiment counts of the captured comments (Comment.sentiment), from the report/portal APIs. */
interface ReportSentiment {
  positive: number
  neutral: number
  negative: number
  total: number
}

/** Real sentiment data is shown only from this many analysed comments. */
const SENTIMENT_MIN_COMMENTS = 20

// --- Learnings (built server-side by src/lib/campaign-learnings.ts) ----------
// The agency API sends BOTH projections: `learnings` (full, staff) and
// `learningsClient` (client-safe: no grade, ratio verdict, worst performer,
// skip list, budget advice or €/fee/budget wording). The portal API sends the
// client projection as `learnings`. The PM prints the client PDF from the
// agency view, so the report renders the client projection whenever it is
// printing (and always in the portal); the full object is screen only.

type LearningInsightType = 'success' | 'warning' | 'action' | 'insight' | 'info'

interface ReportLearningInsight {
  type: LearningInsightType
  icon: string
  text: string
}

interface ReportPerformer {
  username: string
  reason: string
}

interface ReportFormatVerdict {
  format: string
  reason: string
}

interface ReportLearnings {
  generatedAt: string | null
  grade: string | null
  ratioVerdict: string | null
  insights: ReportLearningInsight[]
  topPerformer: ReportPerformer | null
  worstPerformer: ReportPerformer | null
  repeatList: string[]
  skipList: string[]
  bestFormat: ReportFormatVerdict | null
  worstFormat: ReportFormatVerdict | null
  budgetAdvice: string | null
  nextCampaignRec: string | null
}

type ReportStrings = TranslationKeys['campaignReport']

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/** Accepts the overview of either API; null when the response predates definitions v2. */
function normalizeOverview(raw: unknown): ReportOverview | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const totals = r.totals as ReportOverviewTotals | undefined
  if (!totals || typeof totals !== 'object' || !totals.audience || typeof totals.audience !== 'object' || !totals.er || typeof totals.er !== 'object') {
    return null
  }
  const delivery = r.delivery && typeof r.delivery === 'object' ? (r.delivery as DeliveryChecklist) : null
  const balance = r.balance && typeof r.balance === 'object' ? (r.balance as CampaignBalance) : null
  return {
    definitionsVersion: typeof r.definitionsVersion === 'number' ? r.definitionsVersion : undefined,
    totals,
    perInfluencer: asArray<ReportPerInfluencer>(r.perInfluencer),
    perMedia: asArray<ReportPerMedia>(r.perMedia),
    targets: asArray<TargetComparison>(r.targets),
    business: r.business && typeof r.business === 'object' ? (r.business as BusinessResults) : null,
    delivery: delivery && delivery.creators && delivery.pieces && delivery.dates && delivery.disclosure ? delivery : null,
    balance: balance && typeof balance.execution === 'string' ? balance : null,
  }
}

/** Defensive parse of the `sentiment` key; null when absent or empty. */
function normalizeSentiment(raw: unknown): ReportSentiment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const positive = n(r.positive), neutral = n(r.neutral), negative = n(r.negative)
  const total = typeof r.total === 'number' ? n(r.total) : positive + neutral + negative
  return total > 0 ? { positive, neutral, negative, total } : null
}

const INSIGHT_TYPES: ReadonlySet<string> = new Set<LearningInsightType>(['success', 'warning', 'action', 'insight', 'info'])

/** Defensive parse of the `learnings` key; null when the API did not send one. */
function normalizeLearnings(raw: unknown): ReportLearnings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
  const performer = (v: unknown): ReportPerformer | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const username = str(o.username)
    return username ? { username, reason: str(o.reason) ?? '' } : null
  }
  const format = (v: unknown): ReportFormatVerdict | null => {
    if (!v || typeof v !== 'object') return null
    const o = v as Record<string, unknown>
    const f = str(o.format)
    return f ? { format: f, reason: str(o.reason) ?? '' } : null
  }
  const insights: ReportLearningInsight[] = asArray<unknown>(r.insights).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const o = item as Record<string, unknown>
    const text = str(o.text)
    if (!text) return []
    const type = typeof o.type === 'string' && INSIGHT_TYPES.has(o.type) ? (o.type as LearningInsightType) : 'info'
    return [{ type, icon: str(o.icon) ?? '', text }]
  })
  return {
    generatedAt: str(r.generatedAt),
    grade: str(r.grade),
    ratioVerdict: str(r.ratioVerdict),
    insights,
    topPerformer: performer(r.topPerformer),
    worstPerformer: performer(r.worstPerformer),
    repeatList: strList(r.repeatList),
    skipList: strList(r.skipList),
    bestFormat: format(r.bestFormat),
    worstFormat: format(r.worstFormat),
    budgetAdvice: str(r.budgetAdvice),
    nextCampaignRec: str(r.nextCampaignRec),
  }
}

/**
 * Every text the client projection carries. A staff text absent from this set
 * is "solo pantalla": shown to the PM, never printed (the PDF renders the
 * client projection itself; the set only drives the on-screen marker and the
 * CSS fallback). null when the API sent no client projection.
 */
function clientLearningTexts(client: ReportLearnings | null): Set<string> | null {
  if (!client) return null
  const texts = new Set<string>()
  for (const i of client.insights) texts.add(i.text)
  if (client.topPerformer?.reason) texts.add(client.topPerformer.reason)
  if (client.bestFormat?.reason) texts.add(client.bestFormat.reason)
  if (client.worstFormat?.reason) texts.add(client.worstFormat.reason)
  if (client.nextCampaignRec) texts.add(client.nextCampaignRec)
  return texts
}

// ---------------------------------------------------------------------------
// Report config (client side)
// ---------------------------------------------------------------------------

/**
 * Mirrors of DELIVERY_ROW_KEYS / REPORT_DELIVERY_EXTRA_MAX from
 * src/lib/report-config.ts. That module imports Prisma, so a client component
 * may only import its TYPES; the values are repeated here and typed against
 * the contract so a drift fails to compile.
 */
const DELIVERY_ROW_KEYS: readonly DeliveryRowKey[] = ['creators', 'pieces', 'dates', 'disclosure']
const DELIVERY_EXTRA_MAX = 4
const DELIVERY_LABEL_MAX = 80
const DELIVERY_VALUE_MAX = 40
const DELIVERY_NOTE_MAX = 120
/** Mirror of REPORT_DELIVERY_COUNT_MAX: the server rejects (400) counts above it. */
const DELIVERY_COUNT_MAX = 1_000_000

function emptyDelivery(): ReportDeliveryConfig {
  return { overrides: {}, extraRows: [] }
}

const EMPTY_CONFIG: ReportConfig = {
  hiddenSections: [],
  hiddenColumns: [],
  hiddenMediaIds: [],
  hiddenInfluencerIds: [],
  highlightedComments: [],
  delivery: emptyDelivery(),
  sentVersions: [],
}

const COMMENT_SENTIMENTS: ReadonlySet<string> = new Set<ReportCommentSentiment>(['positive', 'neutral', 'negative'])

/** Non-negative integer or null (a blank / invalid field keeps the computed value). */
function intOrNull(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v)
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

/** "Prometido vs entregado" edits as the API sends them (normalised server-side); defensive anyway. */
function normalizeDelivery(v: unknown): ReportDeliveryConfig {
  const out = emptyDelivery()
  if (!v || typeof v !== 'object') return out
  const d = v as Record<string, unknown>
  const rawOverrides = d.overrides && typeof d.overrides === 'object' ? (d.overrides as Record<string, unknown>) : {}
  for (const key of DELIVERY_ROW_KEYS) {
    const item = rawOverrides[key]
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const entry: DeliveryOverride = {
      planned: intOrNull(r.planned),
      delivered: intOrNull(r.delivered),
      ok: typeof r.ok === 'boolean' ? r.ok : null,
      note: typeof r.note === 'string' && r.note.trim() ? r.note : null,
    }
    if (entry.planned !== null || entry.delivered !== null || entry.ok !== null || entry.note) out.overrides[key] = entry
  }
  if (Array.isArray(d.extraRows)) {
    d.extraRows.forEach((item, index) => {
      if (out.extraRows.length >= DELIVERY_EXTRA_MAX) return
      if (!item || typeof item !== 'object') return
      const r = item as Record<string, unknown>
      const label = typeof r.label === 'string' ? r.label : ''
      if (!label.trim()) return
      out.extraRows.push({
        id: typeof r.id === 'string' && r.id ? r.id : `d${index + 1}`,
        label,
        value: typeof r.value === 'string' ? r.value : null,
        ok: r.ok === true,
      })
    })
  }
  return out
}

function newExtraRowId(): string {
  return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** Highlighted comments as the API sends them (already normalised server-side); defensive anyway. */
function normalizeHighlighted(v: unknown): HighlightedComment[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text : ''
    if (!text.trim()) return []
    return [{
      id: typeof r.id === 'string' && r.id ? r.id : `c${index + 1}`,
      text,
      author: typeof r.author === 'string' ? r.author : '',
      sentiment: typeof r.sentiment === 'string' && COMMENT_SENTIMENTS.has(r.sentiment) ? (r.sentiment as ReportCommentSentiment) : 'neutral',
      mediaId: typeof r.mediaId === 'string' ? r.mediaId : null,
    }]
  })
}

function newCommentId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Defensive shape for whatever the API returns. The portal projection has no
 * sentVersions / updatedBy, and an old or failed response must still render
 * the default report.
 */
function normalizeClientConfig(raw: unknown): ReportConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined
  return {
    title: text(r.title),
    subtitle: text(r.subtitle),
    intro: text(r.intro),
    conclusions: text(r.conclusions),
    hiddenSections: list(r.hiddenSections),
    hiddenColumns: list(r.hiddenColumns),
    hiddenMediaIds: list(r.hiddenMediaIds),
    hiddenInfluencerIds: list(r.hiddenInfluencerIds),
    highlightedComments: normalizeHighlighted(r.highlightedComments),
    delivery: normalizeDelivery(r.delivery),
    sentVersions: Array.isArray(r.sentVersions) ? (r.sentVersions as ReportSentVersion[]) : [],
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : undefined,
  }
}

/**
 * The config can arrive twice (inline with the campaign payload and from the
 * report-config endpoint). Both describe the same saved state; the inline copy
 * may lack the audit trail, so never let it erase one we already have.
 */
function mergeConfig(prev: ReportConfig, next: ReportConfig): ReportConfig {
  return {
    ...next,
    sentVersions: next.sentVersions.length > 0 ? next.sentVersions : prev.sentVersions,
    updatedAt: next.updatedAt ?? prev.updatedAt,
    updatedBy: next.updatedBy ?? prev.updatedBy,
  }
}

/** "{n}" / "{date}" placeholders in translation strings */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

// ---------------------------------------------------------------------------
// Print layout
// ---------------------------------------------------------------------------

/**
 * Width the report is pinned to on paper. 1100px is the desktop layout (above
 * Tailwind's lg breakpoint, 1024px, and the widest breakpoint the report uses),
 * so every responsive grid prints its desktop variant — exactly what the PM
 * sees on screen. The server-side renderer opens the page in a 1200px viewport
 * for the same reason (src/lib/report-pdf.ts).
 */
const REPORT_PRINT_WIDTH_PX = 1100
/**
 * Page box: A4 proportions (210 × 297 mm ≈ 0.707) measured in screen pixels,
 * with 24px margins on every side, so the printable width is exactly
 * REPORT_PRINT_WIDTH_PX. Both the browser's print dialog and the server PDF
 * (`preferCSSPageSize`) use it; viewers print the result scaled to A4.
 */
const REPORT_PAGE_WIDTH_PX = REPORT_PRINT_WIDTH_PX + 2 * 24
const REPORT_PAGE_HEIGHT_PX = 1624

/**
 * Screen-identical print rules (WYSIWYG), emitted twice: under `@media print`
 * (the browser's print dialog and the PDF renderer's print media) and under
 * `html[data-report-print]` (the ?print=1 mode, which applies the same rules
 * on screen so the server-side PDF never depends on media emulation).
 *
 * Nothing here changes a size, a grid, a font or a width of the report: the
 * screen classes stay untouched. The rules only (a) hide the app chrome and
 * undo the dashboard sidebar offset, (b) force a white page with the screen
 * colours kept, (c) pin the report width so paper reflow cannot change the
 * layout, and (d) add page-break hygiene (cover on page 1, cards / rows /
 * list items never split, headings never orphaned, table headers repeated).
 */
function printLayoutRules(scope: string): string {
  const s = scope ? `${scope} ` : ''
  return `
    /* (a) App chrome: sidebar, headers, floating widgets and screen-only bits. */
    ${s}aside, ${s}header, ${s}.fixed, ${s}.no-print { display: none !important; }
    ${s}.print-only { display: block !important; }
    /* Undo the dashboard sidebar offset. The layout token is
       'lg:ml-[260px]', so the colon must be escaped for the selector to
       match above the lg breakpoint (the print page IS above it). */
    ${s}div.ml-\\[260px\\], ${s}div.lg\\:ml-\\[260px\\] { margin-left: 0 !important; }
    /* main is a scroll container (overflow-y-auto): scroll containers are
       monolithic when paginating, so it must become visible or the whole
       report would be clipped to one page. Padding off so the pinned width
       is the only horizontal metric. */
    ${s}main { padding: 0 !important; overflow: visible !important; max-width: none !important; }
    /* (b) White page, light theme (the dark class is dropped by the print
       handlers), screen colours kept on paper. */
    ${scope || 'html'}, ${s}body, ${s}main, ${s}div.ml-\\[260px\\], ${s}div.lg\\:ml-\\[260px\\], ${s}body > div { background: #ffffff !important; }
    ${s}#campaign-report, ${s}#campaign-report * {
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    /* (c) Fixed report width = the printable width of the page box. */
    ${s}#campaign-report { width: ${REPORT_PRINT_WIDTH_PX}px; max-width: none; margin: 0 auto; background: #ffffff; }
    /* (d) Page-break hygiene. The cover is page 1; the annex starts a page. */
    ${s}.print-cover { break-after: page; page-break-after: always; }
    ${s}.print-break-before { break-before: page; page-break-before: always; }
    /* Cards (.print-card: every rounded card of the summary, highlights,
       learnings and sentiment sections), table rows and list items never
       split across pages. Table cards are NOT .print-card: a long table must
       paginate row by row instead of being pushed whole to the next page. */
    ${s}.print-card,
    ${s}#campaign-report tr,
    ${s}#campaign-report li { break-inside: avoid; page-break-inside: avoid; }
    /* Table cards are overflow-hidden / overflow-x-auto on screen (rounded
       corners, horizontal scroll on narrow screens). Those are scroll
       containers, i.e. monolithic on paper: a long table would be clipped to
       one page. Visible overflow lets the rows paginate; at the pinned width
       the tables fit, so nothing else changes. */
    ${s}.print-table-card, ${s}.print-table-wrap { overflow: visible !important; }
    /* Section headings keep with the content that follows. SectionHeading
       wraps the h2 and its hint in .print-heading: the avoid must sit on that
       wrapper, otherwise (with a hint) it only binds the h2 to its hint <p>. */
    ${s}#campaign-report h2, ${s}.print-heading { break-after: avoid; page-break-after: avoid; }
    ${s}#campaign-report thead { display: table-header-group; }
  `
}

const REPORT_PRINT_CSS = `
  .print-only { display: none; }
  @media print {
    ${printLayoutRules('')}
    @page { size: ${REPORT_PAGE_WIDTH_PX}px ${REPORT_PAGE_HEIGHT_PX}px; margin: 24px; }
  }
  ${printLayoutRules('html[data-report-print]')}
`

/** ?print=1: flag readiness at most this long after the data has loaded, even if an image hangs. */
const READY_TIMEOUT_MS = 4000

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * Where the row's figures come from. Creator-supplied insights (screenshot
 * read by AI and confirmed by the PM, connected account or typed by the PM)
 * are real data and rank above the public scrape.
 */
function SourceBadge({ source, insightsSource, tr }: { source?: string | null; insightsSource?: string | null; tr: ReportStrings }) {
  if (insightsSource) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        {tr.sourceCreatorInsights}
      </span>
    )
  }
  if (source === 'meta_api') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        {tr.sourceMeta}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
      {tr.sourcePublic}
    </span>
  )
}

/** Decision 7B: a post the creator removed after publishing stays, marked. */
function DeletedBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
      <Trash2 className="h-3 w-3 shrink-0" />
      {label}
    </span>
  )
}

/** Edit-mode marker on rows the client will not see. */
function HiddenBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
      <EyeOff className="h-3 w-3 shrink-0" />
      {label}
    </span>
  )
}

/**
 * Real-data marker of one publication. Only real figures are named (reach
 * when the creator supplied it, otherwise views); an estimate is never shown
 * to the client, so anything else reads as "no audience data".
 */
function AudienceLabel({ metrics, tr }: { metrics: ReportMediaMetrics | null; tr: ReportStrings }) {
  if (!metrics || metrics.audienceEstimated || metrics.audienceBasis === 'none' || metrics.audience <= 0) {
    return <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">{tr.labelNoAudience}</span>
  }
  const label = metrics.audienceBasis === 'reach'
    ? tr.labelRealReach
    : metrics.audienceBasis === 'views'
      ? tr.labelRealViews
      : tr.labelRealData
  return <span className="text-[10px] font-medium text-green-700 dark:text-green-400">{label}</span>
}

/** Small circled "?" that reveals a one-sentence explanation on hover / focus (CSS only). */
function HelpTip({ text, label }: { text: string; label: string }) {
  return (
    <span className="group relative inline-flex no-print print:hidden">
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 transition-colors hover:border-purple-400 hover:text-purple-600 focus:outline-none focus-visible:border-purple-400 focus-visible:text-purple-600 dark:border-gray-600 dark:text-gray-400"
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-72 max-w-[80vw] rounded-lg border border-gray-200 bg-white px-3 py-2 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-gray-600 opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
      >
        {text}
      </span>
    </span>
  )
}

/** Tone dot of a highlighted comment. */
function ToneDot({ sentiment, label }: { sentiment: ReportCommentSentiment; label: string }) {
  const color = sentiment === 'positive' ? 'bg-green-500' : sentiment === 'negative' ? 'bg-red-500' : 'bg-gray-400'
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', color)} title={label} aria-label={label} />
}

/** Objective verdict (±10 % tolerance decided server-side). */
function VerdictBadge({ verdict, tr }: { verdict: TargetVerdict; tr: ReportStrings }) {
  const styles: Record<TargetVerdict, string> = {
    above: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400',
    on_target: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    below: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    no_data: 'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300',
  }
  const labels: Record<TargetVerdict, string> = {
    above: tr.verdictAbove,
    on_target: tr.verdictOnTarget,
    below: tr.verdictBelow,
    no_data: tr.verdictNoData,
  }
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', styles[verdict])}>
      {labels[verdict]}
    </span>
  )
}

/** Eye-off toggle used on media and creator rows while editing. */
function RowVisibilityToggle({
  hidden,
  disabled,
  title,
  onToggle,
}: {
  hidden: boolean
  disabled?: boolean
  title: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={hidden}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
        hidden
          ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          : 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-700 dark:border-gray-700 dark:hover:text-gray-200',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      {hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
    </button>
  )
}

/**
 * Thumbnail with an explicit pixel box. Inside a flex cell an <img> with only
 * Tailwind size classes collapses to a sliver when the row gets narrow (print,
 * annex), so the size lives on a wrapper with `flex: 0 0 <size>px` and the
 * image fills it.
 */
function MediaThumb({ mediaId, src, alt, size = 40 }: { mediaId?: string | null; src?: string | null; alt: string; size?: 28 | 40 | 64 }) {
  const [error, setError] = useState(false)
  // Durable copy (CDN URLs expire in days); without an id, the proxied CDN URL.
  const url = mediaId || src ? mediaThumbUrl({ id: mediaId, thumbnailUrl: src }) : ''
  const box = { width: size, height: size, flex: `0 0 ${size}px` } as const
  const radius = size >= 64 ? 'rounded-lg' : 'rounded-md'
  if (!url || error) {
    return (
      <div style={box} className={cn('flex shrink-0 items-center justify-center overflow-hidden bg-gray-100 dark:bg-gray-800', radius)}>
        <ImageIcon className={size <= 28 ? 'h-3.5 w-3.5 text-gray-400' : 'h-5 w-5 text-gray-400'} />
      </div>
    )
  }
  return (
    <div style={box} className={cn('shrink-0 overflow-hidden bg-gray-100 dark:bg-gray-800', radius)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="h-full w-full object-cover" onError={() => setError(true)} />
    </div>
  )
}

/** Avatar in a fixed 32px box so the flex cell can never squeeze it. */
function FixedAvatar({ src, name }: { src?: string | null; name: string }) {
  return (
    <div style={{ width: 32, height: 32, flex: '0 0 32px' }} className="shrink-0 overflow-hidden rounded-full">
      <Avatar src={src} name={name} size="sm" className="h-full w-full" />
    </div>
  )
}

/**
 * TKOC wordmark for the cover. The PNG is a 2084x2084 square with the logo
 * as a thin horizontal strip in the vertical centre (rows ~45%-55%), so we
 * crop with object-fit: cover on a 9:1 box instead of rendering the whole
 * (mostly transparent) square. Served straight from /public — no proxy.
 */
/**
 * The wordmark inside /public/images/tkoc-logo-full.png: a 1838×189 px strip
 * centred in the 2084×2084 square (rows 947–1136). Sizing the <img> by height
 * letterboxes the square and leaves a sliver, so the box takes the STRIP's
 * aspect ratio and object-fit: cover crops the transparent padding away.
 */

function TkocLogo({ className = '', size = 'small' }: { className?: string; size?: 'cover' | 'small' }) {
  // A dedicated wordmark asset (public/images/tkoc-wordmark.png, 1860×208,
  // transparent) instead of cropping the square logo with object-fit: a plain
  // <img> with an explicit height renders identically on screen, in the
  // browser's print preview, in the server PDF and in every PDF viewer
  // (object-fit crops became clipping paths that some viewers ignored).
  const height = size === 'cover' ? 56 : 22
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/images/tkoc-wordmark.png"
      alt="The King of Content"
      width={1860}
      height={208}
      style={{ height, width: 'auto', maxWidth: size === 'cover' ? '80%' : '100%' }}
      className={`block ${className}`}
    />
  )
}

function CoverBrandLogo({ src, name }: { src?: string | null; name: string }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
  if (!url || error) {
    return (
      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-purple-100 bg-purple-50 dark:border-purple-900/50 dark:bg-purple-900/30">
        <Building2 className="h-9 w-9 text-purple-600 dark:text-purple-400" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={name}
      className="h-20 w-20 shrink-0 rounded-2xl border border-gray-200 bg-white object-contain p-2 dark:border-gray-700"
      onError={() => setError(true)}
    />
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  muted,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
  /** Softer figure (e.g. "Sin dato real"). */
  muted?: boolean
}) {
  return (
    <div className="print-card min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Icon className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
        <span className="min-w-0">{label}</span>
      </div>
      <p
        className={cn(
          'mt-2 break-words font-bold tabular-nums',
          muted ? 'text-lg text-gray-500 dark:text-gray-400' : 'text-2xl text-gray-900 dark:text-gray-100'
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  )
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3 print-heading">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {children}
      </h2>
      {hint && <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{hint}</p>}
    </div>
  )
}

/** "solo pantalla" marker next to a staff text the client will not read. */
function ScreenOnlyBadge({ label }: { label: string }) {
  return (
    <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">{label}</span>
  )
}

/** Small card used inside the learnings section. */
function LearningCard({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('print-card min-w-0 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900', className)}>
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        <Icon className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
        {title}
      </div>
      {children}
    </div>
  )
}

function InsightIcon({ type }: { type: LearningInsightType }) {
  const cls = 'mt-0.5 h-4 w-4 shrink-0'
  switch (type) {
    case 'success': return <Check className={cn(cls, 'text-green-600 dark:text-green-400')} />
    case 'warning': return <TriangleAlert className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
    case 'action': return <ArrowRight className={cn(cls, 'text-purple-600 dark:text-purple-400')} />
    case 'insight': return <Lightbulb className={cn(cls, 'text-purple-600 dark:text-purple-400')} />
    default: return <Info className={cn(cls, 'text-gray-400')} />
  }
}

function mediaTypeLabel(type?: string | null): string {
  switch ((type || '').toUpperCase()) {
    case 'REEL': return 'Reel'
    case 'VIDEO': return 'Vídeo'
    case 'SHORT': return 'Short'
    case 'IMAGE': return 'Imagen'
    case 'PHOTO': return 'Imagen'
    case 'POST': return 'Publicación'
    case 'CAROUSEL':
    case 'SIDECAR': return 'Carrusel'
    case 'STORY': return 'Story'
    case 'LIVE': return 'Directo'
    default: return type || '—'
  }
}

function statusInfo(status?: string): { variant: 'active' | 'paused' | 'archived' | 'default'; label: string } {
  switch (status) {
    case 'ACTIVE': return { variant: 'active', label: 'Activa' }
    case 'PAUSED': return { variant: 'paused', label: 'Pausada' }
    case 'COMPLETED': return { variant: 'archived', label: 'Completada' }
    case 'DRAFT': return { variant: 'default', label: 'Borrador' }
    case 'ARCHIVED': return { variant: 'archived', label: 'Archivada' }
    default: return { variant: 'default', label: status || '—' }
  }
}

// Dates are always shown in the day PMs and clients live in (Europe/Madrid).
const MADRID = 'Europe/Madrid'

/**
 * Calendar day through the shared helper (Europe/Madrid, UI locale), but ''
 * instead of '—' for a missing or invalid date so callers can build ranges
 * and .filter(Boolean). 'long' → "3 de septiembre de 2026" / "3 September 2026".
 */
function reportDate(value: string | Date | null | undefined, locale: Locale, style: 'short' | 'long' = 'short'): string {
  if (!value) return ''
  const s = formatDate(value, { locale, style })
  return s === '—' ? '' : s
}

/**
 * Agency-only transparency note for creators hidden from the client. Their
 * content leaves the report with them, and the report response carries no
 * count of it, so the note says so instead of adding it to the media count.
 */
function hiddenCreatorsNote(n: number, locale: Locale): string {
  if (locale === 'es') {
    return n === 1
      ? '1 creador oculto por la agencia (todo su contenido queda fuera del informe)'
      : `${n} creadores ocultos por la agencia (todo su contenido queda fuera del informe)`
  }
  return n === 1
    ? '1 creator hidden by the agency (all their content is left out of the report)'
    : `${n} creators hidden by the agency (all their content is left out of the report)`
}

/** "5 sept 2026, 10:32" for the "sent" audit line */
function formatDateTime(value: string, locale: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  return d.toLocaleString(locale === 'es' ? 'es-ES' : 'en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: MADRID,
  })
}

/** Percentages always carry 2 decimals ("3,25 %" / "3.25%"). */
function formatPct(value: number, locale: Locale, digits = 2): string {
  const n = (Number.isFinite(value) ? value : 0).toLocaleString(locale === 'es' ? 'es-ES' : 'en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return locale === 'es' ? `${n} %` : `${n}%`
}

function formatSignedPct(value: number, locale: Locale): string {
  return `${value > 0 ? '+' : ''}${formatPct(value, locale)}`
}

function kpiLabel(key: TargetKey, tr: ReportStrings): string {
  switch (key) {
    case 'views': return tr.kpiViews
    case 'reach': return tr.cardRealAudience
    case 'engagement': return tr.kpiEngagement
    case 'er': return tr.kpiEr
    case 'cpm': return tr.kpiCpm
  }
}

function formatTargetValue(key: TargetKey, value: number, locale: Locale): string {
  if (key === 'er') return formatPct(value, locale)
  if (key === 'cpm') return formatEur(value, { locale, maxFractionDigits: 2 })
  return formatNumber(value, { locale })
}

/** Stable key for a roster member: Influencer id (agency: influencerId; portal: influencer.id). */
function memberKey(ci: ReportMember): string {
  return ci.influencerId || ci.influencer?.id || ''
}

// --- Audience helpers (labels and counts only; every figure is the overview's) ---

const ZERO_COUNTS: Record<AudienceBasis, number> = {
  reach: 0, impressions: 0, views: 0, estimated_story: 0, estimated_post: 0, none: 0,
}

/** countsByBasis is new (4A); an older cached response may lack it. */
function countsOf(a: Partial<AudienceTotals>): Record<AudienceBasis, number> {
  const c = a.countsByBasis
  return c && typeof c === 'object' ? { ...ZERO_COUNTS, ...c } : ZERO_COUNTS
}

function realPiecesOf(a: Partial<AudienceTotals>): number {
  const n = a.realPieces
  if (typeof n === 'number') return n
  const c = countsOf(a)
  return c.reach + c.impressions + c.views
}

/** Real audience of one publication (reach → impressions → views); 0 when estimated or absent. */
function realAudienceOf(metrics: ReportMediaMetrics | null): number {
  return metrics && !metrics.audienceEstimated && metrics.audience > 0 ? metrics.audience : 0
}

/**
 * Column width hints (inline `width` on each <th>, identical on screen and on
 * paper). Weights of the visible columns are normalised to percentages that
 * sum to ≤ 100 %, so the table can never grow past its container. Screen-only
 * columns count too: in print they disappear and the remaining columns share
 * the freed width.
 */
function columnWidths(entries: Array<readonly [string, number] | false | null | undefined>): Record<string, string> {
  const list = entries.filter((e): e is readonly [string, number] => Array.isArray(e))
  const total = list.reduce((s, [, w]) => s + w, 0) || 1
  const out: Record<string, string> = {}
  for (const [key, w] of list) out[key] = `${Math.floor((w / total) * 10000) / 100}%`
  return out
}

// ---------------------------------------------------------------------------
// Edit panel (agency only, never printed)
// ---------------------------------------------------------------------------

const TEXTAREA_CLASS =
  'block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 transition-colors focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500'
const INPUT_CLASS = `${TEXTAREA_CLASS} py-2`

/**
 * One computed row of "Prometido vs entregado" (from overview.delivery), the
 * base a manual override is applied to and the placeholder the edit form shows.
 */
interface DeliveryComputedRow {
  key: DeliveryRowKey
  label: string
  /** null = no denominator known (pieces without a recorded commitment, or no overview.delivery yet) */
  planned: number | null
  delivered: number | null
  ok: boolean
  /** Zero denominator: the row reads as pending, never as "0 de 0 · Revisar". */
  empty: boolean
  /** Formatted value as the report shows it ("3 de 5", "sin compromiso…"). */
  value: string
  sub?: string
}

/** A row as rendered: a computed row with its override applied, or an extra row. */
interface DeliveryDisplayRow {
  key: string
  label: string
  value: string
  sub?: string
  ok: boolean
  empty: boolean
  /** Set by the PM (manual override or extra row): the agency screen marks it. */
  manual: boolean
}

function ReportEditPanel({
  draft,
  tr,
  error,
  deliveryComputed,
  onChange,
}: {
  draft: ReportConfig
  tr: ReportStrings
  error: string | null
  /** The four system rows, so the form can show what the system says as placeholders. */
  deliveryComputed: DeliveryComputedRow[]
  onChange: (patch: Partial<ReportConfig>) => void
}) {
  const sections: Array<{ id: ReportSectionId; label: string }> = [
    { id: 'summary', label: tr.sectionSummary },
    { id: 'content', label: tr.sectionHighlights },
    { id: 'creators', label: tr.sectionCreators },
    { id: 'sentiment', label: tr.sectionSentiment },
    { id: 'quality', label: tr.sectionQuality },
    { id: 'business', label: tr.sectionBusiness },
    { id: 'learnings', label: tr.sectionLearnings },
    { id: 'conclusions', label: tr.learningsDecisionsTitle },
    { id: 'annex', label: tr.sectionAnnex },
  ]
  const columns: Array<{ id: ReportColumnId; label: string }> = [
    { id: 'summary.views', label: tr.colSummaryViews },
    { id: 'summary.reach', label: tr.colSummaryRealAudience },
    { id: 'summary.engagement', label: tr.colSummaryEngagement },
    { id: 'summary.er', label: tr.colSummaryEr },
    { id: 'content.views', label: tr.colContentViews },
    { id: 'content.reach', label: tr.colContentReach },
    { id: 'content.source', label: tr.colContentSource },
    { id: 'creators.posts', label: tr.colCreatorsPosts },
    { id: 'creators.views', label: tr.colCreatorsViews },
    { id: 'creators.er', label: tr.colCreatorsEr },
    { id: 'creators.followers', label: tr.colCreatorsFollowers },
    { id: 'creators.cpm', label: tr.colCreatorsCpm },
  ]

  // "Qué dijo la audiencia": the PM quotes up to 12 comments by hand.
  const comments = draft.highlightedComments
  const setComments = (next: HighlightedComment[]) => onChange({ highlightedComments: next })
  const updateComment = (index: number, patch: Partial<HighlightedComment>) =>
    setComments(comments.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  const removeComment = (index: number) => setComments(comments.filter((_, i) => i !== index))
  const addComment = () => {
    if (comments.length >= 12) return
    setComments([...comments, { id: newCommentId(), text: '', author: '', sentiment: 'positive', mediaId: null }])
  }

  // "Prometido vs entregado": each system row is Automático (computed) or
  // Manual (the PM sets promised / delivered / state / note; a blank field keeps
  // the computed value), plus up to DELIVERY_EXTRA_MAX rows of her own.
  const delivery = draft.delivery
  const setDelivery = (next: ReportDeliveryConfig) => onChange({ delivery: next })
  const setOverride = (key: DeliveryRowKey, override: DeliveryOverride | null) => {
    const overrides = { ...delivery.overrides }
    if (override) overrides[key] = override
    else delete overrides[key]
    setDelivery({ ...delivery, overrides })
  }
  const patchOverride = (key: DeliveryRowKey, patch: DeliveryOverride) =>
    setOverride(key, { planned: null, delivered: null, ok: null, note: null, ...delivery.overrides[key], ...patch })
  const extraRows = delivery.extraRows
  const setExtraRows = (next: DeliveryExtraRow[]) => setDelivery({ ...delivery, extraRows: next })
  const updateExtraRow = (index: number, patch: Partial<DeliveryExtraRow>) =>
    setExtraRows(extraRows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  const removeExtraRow = (index: number) => setExtraRows(extraRows.filter((_, i) => i !== index))
  const addExtraRow = () => {
    if (extraRows.length >= DELIVERY_EXTRA_MAX) return
    setExtraRows([...extraRows, { id: newExtraRowId(), label: '', value: '', ok: true }])
  }
  /** Number input → integer ≥ 0, or null when blank / invalid (keeps the computed figure). */
  const countValue = (raw: string): number | null => {
    if (raw.trim() === '') return null
    const n = intOrNull(raw)
    return n === null ? null : Math.min(n, DELIVERY_COUNT_MAX)
  }
  const stateLabel = (ok: boolean, empty: boolean) => (ok ? tr.deliveryOk : empty ? tr.deliveryPending : tr.deliveryStateReview)

  const checkbox = (checked: boolean, onToggle: () => void, label: string, key: string) => (
    <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 dark:border-gray-600"
      />
      <span className={checked ? 'line-through decoration-gray-400' : ''}>{label}</span>
    </label>
  )

  return (
    <div className="no-print rounded-xl border border-purple-200 bg-purple-50/40 p-5 print:hidden dark:border-purple-900/60 dark:bg-purple-900/10">
      <div className="mb-4 flex items-start gap-2">
        <Pencil className="mt-0.5 h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{tr.editPanelTitle}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{tr.editPanelHint}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{tr.totalsRecomputeOnSave}</p>
        </div>
      </div>

      {/* Texts */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">{tr.titleLabel}</label>
          <input
            type="text"
            maxLength={2000}
            value={draft.title ?? ''}
            placeholder={tr.titlePlaceholder}
            onChange={e => onChange({ title: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">{tr.subtitleLabel}</label>
          <input
            type="text"
            maxLength={2000}
            value={draft.subtitle ?? ''}
            placeholder={tr.subtitlePlaceholder}
            onChange={e => onChange({ subtitle: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">{tr.introLabel}</label>
          <textarea
            rows={4}
            maxLength={2000}
            value={draft.intro ?? ''}
            placeholder={tr.introPlaceholder}
            onChange={e => onChange({ intro: e.target.value })}
            className={TEXTAREA_CLASS}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">
            {tr.learningsDecisionsTitle} · {tr.conclusionsLabel}
          </label>
          <textarea
            rows={4}
            maxLength={2000}
            value={draft.conclusions ?? ''}
            placeholder={tr.conclusionsPlaceholder}
            onChange={e => onChange({ conclusions: e.target.value })}
            className={TEXTAREA_CLASS}
          />
        </div>
      </div>

      {/* Hide sections / columns */}
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {tr.sectionsLabel} — {tr.hideFromClient}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {sections.map(s =>
              checkbox(
                draft.hiddenSections.includes(s.id),
                () => onChange({ hiddenSections: toggleId(draft.hiddenSections, s.id) }),
                s.label,
                s.id
              )
            )}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {tr.columnsLabel} — {tr.hideFromClient}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {columns.map(c =>
              checkbox(
                draft.hiddenColumns.includes(c.id),
                () => onChange({ hiddenColumns: toggleId(draft.hiddenColumns, c.id) }),
                c.label,
                c.id
              )
            )}
          </div>
        </div>
      </div>

      {/* Highlighted comments */}
      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.commentsLabel}</p>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{tr.commentsHint}</p>
        {comments.length > 0 && (
          <div className="space-y-2">
            {comments.map((c, i) => (
              <div
                key={c.id}
                className="grid gap-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto_auto] md:items-start"
              >
                <input
                  type="text"
                  maxLength={80}
                  value={c.author}
                  placeholder={tr.commentAuthorPlaceholder}
                  aria-label={tr.commentAuthorPlaceholder}
                  onChange={e => updateComment(i, { author: e.target.value })}
                  className={INPUT_CLASS}
                />
                <textarea
                  rows={2}
                  maxLength={300}
                  value={c.text}
                  placeholder={tr.commentTextPlaceholder}
                  aria-label={tr.commentTextPlaceholder}
                  onChange={e => updateComment(i, { text: e.target.value })}
                  className={TEXTAREA_CLASS}
                />
                <select
                  value={c.sentiment}
                  aria-label={tr.commentTone}
                  onChange={e => updateComment(i, { sentiment: e.target.value as ReportCommentSentiment })}
                  className={INPUT_CLASS}
                >
                  <option value="positive">{tr.sentimentPositive}</option>
                  <option value="neutral">{tr.sentimentNeutral}</option>
                  <option value="negative">{tr.sentimentNegative}</option>
                </select>
                <button
                  type="button"
                  onClick={() => removeComment(i)}
                  title={tr.removeComment}
                  aria-label={tr.removeComment}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 text-gray-400 transition-colors hover:border-red-300 hover:text-red-600 dark:border-gray-700 dark:hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2">
          {comments.length < 12 ? (
            <Button variant="secondary" size="sm" onClick={addComment}>
              <Plus className="h-4 w-4" />
              {tr.addComment}
            </Button>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">{tr.commentsMax}</p>
          )}
        </div>
      </div>

      {/* Prometido vs entregado: the PM completes the checklist */}
      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.deliveryTitle}</p>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{tr.deliveryEditHint}</p>
        <div className="space-y-2">
          {deliveryComputed.map(row => {
            const override = delivery.overrides[row.key]
            const manual = override !== undefined
            const computedState = stateLabel(row.ok, row.empty)
            return (
              <div key={row.key} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{row.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {fill(tr.deliverySystemSays, { value: row.value, state: computedState })}
                    </p>
                  </div>
                  <select
                    value={manual ? 'manual' : 'auto'}
                    aria-label={`${row.label} · ${tr.deliveryModeLabel}`}
                    onChange={e => setOverride(row.key, e.target.value === 'manual' ? { planned: null, delivered: null, ok: null, note: null } : null)}
                    className={cn(INPUT_CLASS, 'w-auto')}
                  >
                    <option value="auto">{tr.deliveryModeAuto}</option>
                    <option value="manual">{tr.deliveryModeManual}</option>
                  </select>
                </div>
                {manual && override && (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,2fr)]">
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">{tr.deliveryPlannedLabel}</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={override.planned ?? ''}
                        placeholder={row.planned !== null ? String(row.planned) : '—'}
                        onChange={e => patchOverride(row.key, { planned: countValue(e.target.value) })}
                        className={INPUT_CLASS}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">{tr.deliveryDeliveredLabel}</span>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={override.delivered ?? ''}
                        placeholder={row.delivered !== null ? String(row.delivered) : '—'}
                        onChange={e => patchOverride(row.key, { delivered: countValue(e.target.value) })}
                        className={INPUT_CLASS}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">{tr.deliveryStateLabel}</span>
                      <select
                        value={override.ok === true ? 'ok' : override.ok === false ? 'review' : 'auto'}
                        onChange={e => patchOverride(row.key, { ok: e.target.value === 'ok' ? true : e.target.value === 'review' ? false : null })}
                        className={INPUT_CLASS}
                      >
                        <option value="auto">{fill(tr.deliveryStateAuto, { state: computedState })}</option>
                        <option value="ok">{tr.deliveryOk}</option>
                        <option value="review">{tr.deliveryStateReview}</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-gray-500 dark:text-gray-400">{tr.deliveryNoteLabel}</span>
                      <input
                        type="text"
                        maxLength={DELIVERY_NOTE_MAX}
                        value={override.note ?? ''}
                        placeholder={row.sub || tr.deliveryNotePlaceholder}
                        onChange={e => patchOverride(row.key, { note: e.target.value })}
                        className={INPUT_CLASS}
                      />
                    </label>
                  </div>
                )}
                {manual && override && override.planned == null && override.delivered == null && override.ok == null && !override.note && (
                  // The server drops an override with nothing set (same as Automático), so
                  // an empty Manual row would silently revert after saving. Say so.
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{tr.deliveryManualEmptyHint}</p>
                )}
              </div>
            )
          })}
        </div>

        {/* Extra promises */}
        <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.deliveryExtraLabel}</p>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">{tr.deliveryExtraHint}</p>
        {extraRows.length > 0 && (
          <div className="space-y-2">
            {extraRows.map((r, i) => (
              <div
                key={r.id}
                className="grid gap-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] md:items-center"
              >
                <input
                  type="text"
                  maxLength={DELIVERY_LABEL_MAX}
                  value={r.label}
                  placeholder={tr.deliveryExtraLabelPlaceholder}
                  aria-label={tr.deliveryExtraLabelPlaceholder}
                  onChange={e => updateExtraRow(i, { label: e.target.value })}
                  className={INPUT_CLASS}
                />
                <input
                  type="text"
                  maxLength={DELIVERY_VALUE_MAX}
                  value={r.value ?? ''}
                  placeholder={tr.deliveryExtraValuePlaceholder}
                  aria-label={tr.deliveryExtraValuePlaceholder}
                  onChange={e => updateExtraRow(i, { value: e.target.value })}
                  className={INPUT_CLASS}
                />
                <select
                  value={r.ok ? 'ok' : 'review'}
                  aria-label={tr.deliveryStateLabel}
                  onChange={e => updateExtraRow(i, { ok: e.target.value === 'ok' })}
                  className={INPUT_CLASS}
                >
                  <option value="ok">{tr.deliveryOk}</option>
                  <option value="review">{tr.deliveryStateReview}</option>
                </select>
                <button
                  type="button"
                  onClick={() => removeExtraRow(i)}
                  title={tr.removeDeliveryRow}
                  aria-label={tr.removeDeliveryRow}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 text-gray-400 transition-colors hover:border-red-300 hover:text-red-600 dark:border-gray-700 dark:hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2">
          {extraRows.length < DELIVERY_EXTRA_MAX ? (
            <Button variant="secondary" size="sm" onClick={addExtraRow}>
              <Plus className="h-4 w-4" />
              {tr.addDeliveryRow}
            </Button>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">{tr.deliveryExtraMax}</p>
          )}
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CampaignReportProps {
  campaignId: string
  /** API base: `${apiBase}/${campaignId}?mediaLimit=..&mediaOffset=..` */
  apiBase?: string
  /** Where the "Volver" button points */
  backHref?: string
  /**
   * Portal (client-facing) mode: hides agency-internal hints and links,
   * and never shows economic columns.
   */
  isPortal?: boolean
  /**
   * `?print=1` — the server-side PDF renderer: no top bar, no edit mode, the
   * print rules applied on screen, and <html data-report-ready="1"> set once
   * the data and the thumbnails have settled (or READY_TIMEOUT_MS after load).
   */
  printMode?: boolean
}

const PAGE = 100
/** Safety cap: 20 pages = 2000 posts. */
const MAX_PAGES = 20
/** Body: the publications with most real audience; the rest live in the annex. */
const HIGHLIGHT_COUNT = 6

interface MediaItem {
  media: ReportMedia
  /** overview.perMedia entry (or the row's own `metrics`); null for rows outside the report */
  metrics: ReportMediaMetrics | null
  /** Real audience of the piece (reach → impressions → views); 0 when estimated/absent */
  real: number
  creatorKey: string
  hiddenById: boolean
  hiddenByCreator: boolean
  hidden: boolean
}

interface CreatorRow {
  key: string
  inf: ReportInfluencer
  /** overview.perInfluencer entry; null for a creator hidden from the report (edit mode only) */
  p: ReportPerInfluencer | null
  hidden: boolean
  baseline: BaselineComparison | null
}

export function CampaignReport({
  campaignId,
  apiBase = '/api/campaigns',
  backHref,
  isPortal = false,
  printMode = false,
}: CampaignReportProps) {
  const { t, locale } = useI18n()
  const tr = t.campaignReport
  // Every count in the report follows the UI locale, like the amounts and ratios next to it.
  const fmtN = (v: number) => formatNumber(v, { locale })

  const [campaign, setCampaign] = useState<ReportCampaign | null>(null)
  const [overview, setOverview] = useState<ReportOverview | null>(null)
  // Full (staff) learnings and the client-safe projection. In the portal both
  // hold the projection the API sends; in the agency view the projection is
  // what gets printed.
  const [learnings, setLearnings] = useState<ReportLearnings | null>(null)
  const [learningsClient, setLearningsClient] = useState<ReportLearnings | null>(null)
  // Sentiment counts of the captured comments (null when none were analysed).
  const [sentiment, setSentiment] = useState<ReportSentiment | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Bumped after a config save so the server recomputes the report figures.
  const [reloadKey, setReloadKey] = useState(0)
  // Edit mode only: the unfiltered media/roster (no view=report) so the PM can
  // see and restore rows already hidden in the saved config.
  const [fullData, setFullData] = useState<{ media: ReportMedia[]; influencers: ReportMember[] } | null>(null)
  // True while the page is being printed (beforeprint / matchMedia('print')),
  // and permanently in printMode: the learnings render the client projection
  // and the agency-only blocks disappear.
  const [printing, setPrinting] = useState(printMode)
  const readyFlagged = useRef(false)

  // Saved config vs. the draft being edited. `draft !== null` == edit mode.
  const [config, setConfig] = useState<ReportConfig>(EMPTY_CONFIG)
  // The agency API does not inline the config: ?print=1 must not flag readiness before this fetch settles.
  const [configSettled, setConfigSettled] = useState(false)
  const [draft, setDraft] = useState<ReportConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sentOpen, setSentOpen] = useState(false)
  const [sentNote, setSentNote] = useState('')
  const [marking, setMarking] = useState(false)
  const [sentError, setSentError] = useState<string | null>(null)

  // Brands never write: no edit affordances in portal mode (the API also
  // rejects BRAND writes with 403). The PDF renderer never edits either.
  const canEdit = !isPortal && !printMode
  const editing = canEdit && draft !== null
  // What the report renders: the live draft while editing (preview), else the saved config.
  const view: ReportConfig = draft ?? config

  const resolvedBackHref = backHref || (isPortal ? `/portal/campaigns/${campaignId}` : `/campaigns/${campaignId}`)
  const configUrl = `${apiBase}/${campaignId}/report-config`

  // Campaign + overview (+ learnings). The agency asks for the report view
  // (hidden rows out of every figure and of the media list); the portal API
  // always behaves so.
  useEffect(() => {
    let cancelled = false
    async function fetchCampaign() {
      if (reloadKey > 0) setRefreshing(true)
      try {
        // The API caps mediaLimit at 100, so paginate the media list until
        // exhausted. The overview (over ALL media) travels with page 0.
        const viewParam = isPortal ? '' : `&view=report&locale=${locale}`
        let base: ReportCampaign | null = null
        let firstOverview: ReportOverview | null = null
        let firstLearnings: ReportLearnings | null = null
        let firstLearningsClient: ReportLearnings | null = null
        let firstSentiment: ReportSentiment | null = null
        let inlineConfig: unknown = undefined
        let allMedia: ReportMedia[] = []

        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetch(`${apiBase}/${campaignId}?mediaLimit=${PAGE}&mediaOffset=${page * PAGE}${viewParam}`)
          if (!res.ok) break
          const data = await res.json()
          if (!data.campaign) break
          if (page === 0) {
            base = data.campaign
            firstOverview = normalizeOverview(data.overview)
            firstLearnings = normalizeLearnings(data.learnings)
            // The portal API only sends the client projection (as `learnings`).
            firstLearningsClient = normalizeLearnings(data.learningsClient) ?? (isPortal ? firstLearnings : null)
            firstSentiment = normalizeSentiment(data.sentiment)
            inlineConfig = data.reportConfig
          }
          const pageMedia: ReportMedia[] = data.campaign.media || []
          allMedia = allMedia.concat(pageMedia)
          if (pageMedia.length < PAGE) break
        }

        if (!cancelled && base) {
          setCampaign({ ...base, media: allMedia })
          setOverview(firstOverview)
          setLearnings(firstLearnings)
          setLearningsClient(firstLearningsClient)
          setSentiment(firstSentiment)
          if (inlineConfig && typeof inlineConfig === 'object') {
            const next = normalizeClientConfig(inlineConfig)
            setConfig(prev => mergeConfig(prev, next))
          }
        }
      } catch (err) {
        console.error('Error fetching campaign report data:', err)
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setRefreshing(false)
        }
      }
    }
    fetchCampaign()
    return () => { cancelled = true }
  }, [campaignId, apiBase, isPortal, reloadKey])

  // Report config — a failure here must never block the report: fall back to defaults.
  useEffect(() => {
    let cancelled = false
    setConfigSettled(false)
    fetch(configUrl)
      .then(async res => {
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data?.config) setConfig(normalizeClientConfig(data.config))
      })
      .catch(err => console.error('Error fetching report config:', err))
      .finally(() => { if (!cancelled) setConfigSettled(true) })
    return () => { cancelled = true }
  }, [configUrl])

  // Edit mode (agency): rows hidden in the SAVED config are not in the report
  // response, so load the unfiltered list once to show them muted/restorable.
  const needsFullData = editing && !isPortal && (config.hiddenMediaIds.length > 0 || config.hiddenInfluencerIds.length > 0)
  useEffect(() => {
    if (!needsFullData || fullData !== null) return
    let cancelled = false
    async function fetchFull() {
      try {
        let influencers: ReportMember[] = []
        let media: ReportMedia[] = []
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await fetch(`${apiBase}/${campaignId}?mediaLimit=${PAGE}&mediaOffset=${page * PAGE}`)
          if (!res.ok) return
          const data = await res.json()
          if (!data.campaign) return
          if (page === 0) influencers = data.campaign.influencers || []
          const pageMedia: ReportMedia[] = data.campaign.media || []
          media = media.concat(pageMedia)
          if (pageMedia.length < PAGE) break
        }
        if (!cancelled) setFullData({ media, influencers })
      } catch (err) {
        console.error('Error fetching unfiltered campaign data:', err)
      }
    }
    fetchFull()
    return () => { cancelled = true }
  }, [needsFullData, fullData, apiBase, campaignId])

  // Print fidelity: the PDF is always the light theme. Drop the `dark` class
  // from <html> while printing and put it back afterwards (the ThemeProvider
  // only touches the class on user action, so this does not fight it).
  useEffect(() => {
    let restoreDark = false
    const onBeforePrint = () => {
      const root = document.documentElement
      restoreDark = root.classList.contains('dark')
      if (restoreDark) root.classList.remove('dark')
    }
    const onAfterPrint = () => {
      if (restoreDark) {
        document.documentElement.classList.add('dark')
        restoreDark = false
      }
    }
    window.addEventListener('beforeprint', onBeforePrint)
    window.addEventListener('afterprint', onAfterPrint)
    return () => {
      window.removeEventListener('beforeprint', onBeforePrint)
      window.removeEventListener('afterprint', onAfterPrint)
    }
  }, [])

  // ?print=1: apply the print rules on screen (html[data-report-print] mirrors
  // the @media print rules: chrome hidden, report pinned to its print width),
  // always the light theme, and never a stray dark class from the theme provider.
  useEffect(() => {
    if (!printMode) return
    const root = document.documentElement
    const hadDark = root.classList.contains('dark')
    root.setAttribute('data-report-print', '1')
    root.classList.remove('dark')
    return () => {
      root.removeAttribute('data-report-print')
      root.removeAttribute('data-report-ready')
      if (hadDark) root.classList.add('dark')
    }
  }, [printMode])

  // ?print=1: once the data AND the report config have loaded, wait for the
  // thumbnails to settle (or READY_TIMEOUT_MS at most) and flag readiness for
  // the PDF renderer.
  useEffect(() => {
    if (!printMode || isLoading || !configSettled || readyFlagged.current) return
    let cancelled = false
    const flag = () => {
      if (cancelled || readyFlagged.current) return
      readyFlagged.current = true
      document.documentElement.setAttribute('data-report-ready', '1')
    }
    const timer = window.setTimeout(flag, READY_TIMEOUT_MS)
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('#campaign-report img'))
    const settled = images.map(img => img.complete
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        }))
    // A short beat after the last image so the layout is final when flagged.
    let afterImages: number | undefined
    Promise.all(settled).then(() => { afterImages = window.setTimeout(flag, 150) })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (afterImages !== undefined) window.clearTimeout(afterImages)
    }
  }, [printMode, isLoading, configSettled, campaign, overview])

  // Print mode for the screen-only blocks. beforeprint fires right before the
  // browser lays the page out for paper, so the state change is flushed
  // synchronously (flushSync) — a batched render would land after the pages
  // were captured. matchMedia('print') covers print preview and headless print
  // emulation, where beforeprint is not always fired. ?print=1 is permanent.
  useEffect(() => {
    if (printMode) return
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null
    const apply = (value: boolean) => { flushSync(() => setPrinting(value)) }
    const onBefore = () => apply(true)
    const onAfter = () => apply(false)
    const onChange = (e: MediaQueryListEvent) => apply(e.matches)
    if (mq?.matches) setPrinting(true)
    window.addEventListener('beforeprint', onBefore)
    window.addEventListener('afterprint', onAfter)
    mq?.addEventListener?.('change', onChange)
    return () => {
      window.removeEventListener('beforeprint', onBefore)
      window.removeEventListener('afterprint', onAfter)
      mq?.removeEventListener?.('change', onChange)
    }
  }, [printMode])

  // --- Edit actions -------------------------------------------------------

  const startEdit = useCallback(() => {
    setSaveError(null)
    setSentOpen(false)
    setDraft({ ...config })
  }, [config])

  const cancelEdit = useCallback(() => {
    setDraft(null)
    setSaveError(null)
  }, [])

  const patchDraft = useCallback((patch: Partial<ReportConfig>) => {
    setDraft(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const saveDraft = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(configUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title ?? '',
          subtitle: draft.subtitle ?? '',
          intro: draft.intro ?? '',
          conclusions: draft.conclusions ?? '',
          hiddenSections: draft.hiddenSections,
          hiddenColumns: draft.hiddenColumns,
          hiddenMediaIds: draft.hiddenMediaIds,
          hiddenInfluencerIds: draft.hiddenInfluencerIds,
          // Empty rows are dropped here; the server trims and caps the rest.
          highlightedComments: draft.highlightedComments
            .map(c => ({ ...c, text: c.text.trim(), author: c.author.trim().replace(/^@+/, '') }))
            .filter(c => c.text.length > 0),
          // "Prometido vs entregado": overrides as edited (a null field keeps the
          // computed value; the server drops an override with nothing set) and
          // the extra rows with a label. The server trims and caps the rest.
          delivery: {
            overrides: draft.delivery.overrides,
            extraRows: draft.delivery.extraRows
              .map(r => ({ ...r, label: r.label.trim(), value: (r.value ?? '').trim() || null }))
              .filter(r => r.label.length > 0),
          },
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setConfig(normalizeClientConfig(data.config))
      setDraft(null)
      // Hidden rows changed on the server: refetch so every figure follows.
      setFullData(null)
      setReloadKey(k => k + 1)
    } catch (err) {
      console.error('Error saving report config:', err)
      setSaveError(tr.saveError)
    } finally {
      setSaving(false)
    }
  }, [draft, configUrl, tr.saveError])

  const markSent = useCallback(async () => {
    setMarking(true)
    setSentError(null)
    try {
      const res = await fetch(configUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markSent: true, note: sentNote.trim() || undefined }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setConfig(normalizeClientConfig(data.config))
      setSentOpen(false)
      setSentNote('')
    } catch (err) {
      console.error('Error marking report as sent:', err)
      setSentError(tr.sentError)
    } finally {
      setMarking(false)
    }
  }, [configUrl, sentNote, tr.sentError])

  // --- Joins (no figure is computed here: everything comes from the overview) ---

  const hiddenMediaIds = view.hiddenMediaIds
  const hiddenInfluencerIds = view.hiddenInfluencerIds

  const report = useMemo(() => {
    const hiddenMedia = new Set(hiddenMediaIds)
    const hiddenCreators = new Set(hiddenInfluencerIds)
    const perMediaById = new Map<string, ReportPerMedia>()
    for (const p of overview?.perMedia ?? []) perMediaById.set(p.id, p)
    const perInfluencerIds = new Set((overview?.perInfluencer ?? []).map(p => p.influencerId))

    // Roster lookup (report response first, unfiltered roster as fallback in edit mode)
    const memberById = new Map<string, ReportMember>()
    for (const ci of [...(campaign?.influencers ?? []), ...(fullData?.influencers ?? [])]) {
      const id = memberKey(ci)
      if (id && !memberById.has(id)) memberById.set(id, ci)
    }

    // Media rows. In edit mode the unfiltered list (when loaded) adds the
    // rows already hidden in the saved config, muted, so they can be restored.
    const mediaSource = editing && fullData ? fullData.media : (campaign?.media ?? [])
    const allItems: MediaItem[] = mediaSource.map(m => {
      const creatorKey = m.influencer?.id || ''
      const hiddenById = hiddenMedia.has(m.id)
      const hiddenByCreator = !!creatorKey && hiddenCreators.has(creatorKey)
      const metrics: ReportMediaMetrics | null = perMediaById.get(m.id) ?? m.metrics ?? null
      return { media: m, metrics, real: realAudienceOf(metrics), creatorKey, hiddenById, hiddenByCreator, hidden: hiddenById || hiddenByCreator }
    })
    // Real audience DESC, then interacciones DESC (hidden rows kept for edit mode).
    // The first HIGHLIGHT_COUNT visible rows are the body's "Contenidos destacados".
    const sortedItems = [...allItems].sort((a, b) =>
      (b.real - a.real) || ((b.metrics?.engagements ?? 0) - (a.metrics?.engagements ?? 0))
    )
    // Transparency counts come from the (saved or draft) config, never from the
    // rows: in view mode the API already filtered hidden rows out, so counting
    // rows gave a different number (or none) than edit mode for the same config.
    // Media hidden one by one and creators hidden with all their content are
    // stated separately because the report response carries no count of the
    // hidden creators' media.
    const hiddenMediaCount = hiddenMediaIds.length
    const hiddenCreatorCount = hiddenInfluencerIds.length

    // Creators: figures from overview.perInfluencer, profile/baseline from the roster
    const creators: CreatorRow[] = (overview?.perInfluencer ?? []).map(p => {
      const member = memberById.get(p.influencerId)
      const inf: ReportInfluencer = {
        id: p.influencerId,
        username: p.username,
        displayName: p.displayName,
        platform: p.platform,
        followers: p.followers,
        avatarUrl: member?.influencer?.avatarUrl ?? null,
      }
      // Server-computed per piece (median of the campaign pieces of the same family ÷ baseline median)
      const baseline: BaselineComparison | null = p.vsBaseline ?? null
      return { key: p.influencerId, inf, p, hidden: hiddenCreators.has(p.influencerId), baseline }
    })
    if (editing && fullData) {
      // Creators hidden in the saved config are not in the overview: list them
      // without figures so the PM can restore them.
      for (const ci of fullData.influencers) {
        const id = memberKey(ci)
        if (!id || perInfluencerIds.has(id) || !ci.influencer) continue
        creators.push({ key: id, inf: { ...ci.influencer, id }, p: null, hidden: hiddenCreators.has(id), baseline: null })
      }
    }
    creators.sort((a, b) => (b.p?.engagements ?? -1) - (a.p?.engagements ?? -1))
    const hasBaseline = creators.some(c => !c.hidden && c.baseline !== null)

    // Publications whose figures the creator supplied (labels, not figures)
    const creatorInsightsCount = allItems.filter(x => !x.hidden && !!x.media.insightsSource).length

    return { sortedItems, hiddenMediaCount, hiddenCreatorCount, creators, hasBaseline, creatorInsightsCount }
  }, [campaign, overview, fullData, editing, hiddenMediaIds, hiddenInfluencerIds])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        <span className="ml-3 text-gray-500 dark:text-gray-400">Cargando informe...</span>
      </div>
    )
  }

  if (!campaign) {
    return (
      <div className="py-24 text-center">
        <p className="text-gray-500 dark:text-gray-400">No se encontró la campaña</p>
        <Link
          href={isPortal ? '/portal' : '/campaigns'}
          className="mt-4 inline-block text-purple-600 hover:underline dark:text-purple-400"
        >
          Volver a campañas
        </Link>
      </div>
    )
  }

  // --- Visibility helpers driven by the (saved or draft) config -------------
  const hiddenSections = new Set(view.hiddenSections)
  const hiddenColumns = new Set(view.hiddenColumns)
  const showSection = (id: ReportSectionId) => !hiddenSections.has(id)
  const showCol = (id: ReportColumnId) => !hiddenColumns.has(id)

  const totals = overview?.totals ?? null
  const status = statusInfo(campaign.status)
  const dateRange = [reportDate(campaign.startDate, locale), reportDate(campaign.endDate, locale)]
    .filter(Boolean)
    .join(' — ')
  const hasMedia = (totals?.media ?? 0) > 0 || (editing && report.sortedItems.length > 0)

  // Economic columns: agency only (the portal API never returns them — brands
  // must never see fees/cost/CPM), data-driven, and hideable by the PM before
  // the PDF goes out ('creators.cpm' covers both cost and CPM).
  // The printed / server-rendered PDF is ALWAYS the client version: no fee, cost,
  // CPM or Ratio EMV can leave the agency by accident. On screen the PM keeps them.
  const clientView = isPortal || printing
  const showCostCol = !clientView && showCol('creators.cpm') && report.creators.some(c => (c.p?.cost ?? 0) > 0)
  const showCpmCol = !clientView && showCol('creators.cpm') && report.creators.some(c => typeof c.p?.cpm === 'number')
  const showCpmTotal = !clientView && showCol('creators.cpm') && typeof totals?.cpm === 'number'

  // Rows the client sees (edit mode keeps hidden rows, muted, so they can be restored).
  // The API already excluded them from the figures; this is defense in depth.
  const visibleItems = editing ? report.sortedItems : report.sortedItems.filter(x => !x.hidden)
  // Creators without a single publication are a roster fact, not a result: they
  // never appear in the client's creators table (the campaign page keeps the roster).
  const publishedCreators = report.creators.filter(c => !c.p || (c.p.posts + c.p.stories) > 0)
  const visibleCreators = editing ? publishedCreators : publishedCreators.filter(c => !c.hidden)
  // Body highlights: only publications with a REAL audience figure (possibly
  // fewer than HIGHLIGHT_COUNT, or none), and never a row the client will not
  // see, even while editing. The heading states how many there are.
  const highlightItems = report.sortedItems.filter(x => !x.hidden && x.real > 0).slice(0, HIGHLIGHT_COUNT)

  // Objectives (decision 1B): only the targets the PM filled in; the CPM row
  // compares against cost and never reaches the portal.
  const targetRows = (overview?.targets ?? []).filter(tg => !(isPortal && tg.key === 'cpm'))

  // Title / subtitle overrides (decision 16A)
  const reportTitle = view.title?.trim() || campaign.name || 'Campaña'
  const coverSubtitle = view.subtitle?.trim() || 'Informe de resultados'
  const headerSubtitle = view.subtitle?.trim() || 'Informe de rendimiento'
  const intro = view.intro?.trim() || ''
  const conclusions = view.conclusions?.trim() || ''
  const lastSent = config.sentVersions.length > 0
    ? config.sentVersions[config.sentVersions.length - 1]
    : null

  // Cover data — brand is optional (falls back to campaign name only)
  const brandName = campaign.brand?.name?.trim() || ''
  const coverStart = reportDate(campaign.startDate, locale, 'long')
  const coverEnd = reportDate(campaign.endDate, locale, 'long')
  const coverDateRange = coverStart
    ? (coverEnd
      ? `${coverStart} — ${coverEnd}`
      : locale === 'es' ? `Desde el ${coverStart} · en curso` : `From ${coverStart} · ongoing`)
    : (coverEnd ? (locale === 'es' ? `Hasta el ${coverEnd}` : `Until ${coverEnd}`) : '')
  const generatedOn = formatDate(new Date(), { locale, style: 'long' })
  const generatedOnLabel = locale === 'es' ? 'Generado el' : 'Generated on'
  const platformsLabel = (campaign.platforms || [])
    .map(p => p.charAt(0) + p.slice(1).toLowerCase())
    .join(' · ')

  // Business results (decision 14A): only what the client actually provided.
  // CPA / ROAS derive from cost: the portal projection nulls them; gate anyway.
  const biz = overview?.business ?? null
  const showBusiness = biz !== null && showSection('business')

  // Learnings (server-built). The portal and the printed PDF always render the
  // CLIENT projection; the full object is screen only, for staff. The
  // conclusions text becomes "Decisiones acordadas" inside that section;
  // without learnings it keeps its own section.
  const clientLearningsView = clientView
  const shownLearnings = clientLearningsView ? (learningsClient ?? learnings) : learnings
  const showLearnings = shownLearnings !== null && showSection('learnings')
  const showDecisions = conclusions.length > 0 && showSection('conclusions')
  const showStandaloneConclusions = showDecisions && !showLearnings
  // Agency-only learnings (grade, ratio verdict, worst performer, skip list, budget):
  // on screen for the PM, never printed, never in the portal.
  const internalLearnings = !clientLearningsView && learnings !== null && (
    !!learnings.grade || !!learnings.ratioVerdict || learnings.worstPerformer !== null
    || learnings.skipList.length > 0 || !!learnings.budgetAdvice
  )
  // "Solo pantalla": a staff text the client projection does not carry. The
  // marker tells the PM what the client will not read; the no-print class is
  // only a CSS fallback should the print state ever fail to flip. Without a
  // client projection (older API response) the economic-wording test decides.
  const screenOnlyLabel = locale === 'es' ? 'solo pantalla' : 'screen only'
  const clientTexts = clientLearningTexts(learningsClient)
  const screenOnly = (text: string | null | undefined): boolean => {
    if (!text) return false
    if (clientTexts) return clientLearningsView ? false : !clientTexts.has(text)
    return hasEconomicWording(text)
  }

  // Annex: complete list. While editing it stays visible even when hidden for
  // the client, so the PM keeps the row toggles; the print preview follows the client.
  const annexHiddenForClient = !showSection('annex')
  const showAnnex = hasMedia && (!annexHiddenForClient || editing)

  // Audience counts — labels and counts, never figures
  const realPieces = totals ? realPiecesOf(totals.audience) : 0
  const withoutRealData = totals ? Math.max(0, totals.media - realPieces) : 0
  // Publications with real views, counted from the rows the client sees. A
  // count, never a figure.
  const realViewsCount = report.sortedItems.filter(x => !x.hidden && (x.media.views || 0) > 0).length

  // Tasa de engagement (4B): interacciones ÷ vistas reales. Published only
  // with a meaningful, plausible sample; otherwise "Muestra real insuficiente".
  const er = totals?.er ?? null
  const erPieces = er?.pieces ?? realViewsCount
  const erNullHint = er?.reason === 'no_real_base'
    ? tr.erNoViewsHint
    : er?.reason === 'implausible'
      ? fill(tr.erImplausibleHint, { n: erPieces })
      : erPieces === 1 ? tr.erInsufficientHintOne : fill(tr.erInsufficientHint, { n: erPieces })

  // "Prometido vs entregado" — four rows computed by the server (overview.delivery).
  // Green only when the server says ok; otherwise an amber warning. A zero
  // denominator (nothing agreed / dated / in the feed yet) is neither: the row
  // reads as pending, never as "0 de 0 · Revisar". Without an overview.delivery
  // (older response) the rows exist with no figures, so a manual override can
  // still fill them in.
  const delivery = overview?.delivery ?? null
  const ratio = (delivered: number, planned: number) =>
    fill(tr.deliveryRatio, { delivered: fmtN(delivered), planned: fmtN(planned) })
  const computedDeliveryRows: DeliveryComputedRow[] = [
    {
      key: 'creators',
      label: tr.deliveryCreators,
      planned: delivery ? delivery.creators.planned : null,
      delivered: delivery ? delivery.creators.delivered : null,
      ok: delivery?.creators.ok ?? false,
      empty: !delivery || delivery.creators.planned === 0,
      value: delivery && delivery.creators.planned > 0 ? ratio(delivery.creators.delivered, delivery.creators.planned) : tr.deliveryCreatorsNone,
    },
    {
      key: 'pieces',
      label: tr.deliveryPieces,
      planned: delivery ? delivery.pieces.planned : null,
      delivered: delivery ? delivery.pieces.delivered : null,
      ok: delivery?.pieces.ok ?? false,
      empty: !delivery,
      value: delivery
        ? (delivery.pieces.planned !== null ? ratio(delivery.pieces.delivered, delivery.pieces.planned) : fmtN(delivery.pieces.delivered))
        : '—',
      sub: !delivery || delivery.pieces.planned === null ? tr.deliveryNoPlan : undefined,
    },
    {
      key: 'dates',
      label: tr.deliveryDates,
      planned: delivery ? delivery.dates.total : null,
      delivered: delivery ? delivery.dates.inWindow : null,
      ok: delivery?.dates.ok ?? false,
      empty: !delivery || delivery.dates.total === 0,
      value: delivery && delivery.dates.total > 0 ? ratio(delivery.dates.inWindow, delivery.dates.total) : tr.deliveryDatesNone,
    },
    {
      key: 'disclosure',
      label: tr.deliveryDisclosure,
      planned: delivery ? delivery.disclosure.total : null,
      delivered: delivery ? delivery.disclosure.disclosed : null,
      ok: delivery?.disclosure.ok ?? false,
      empty: !delivery || delivery.disclosure.total === 0,
      value: delivery && delivery.disclosure.total > 0 ? ratio(delivery.disclosure.disclosed, delivery.disclosure.total) : tr.deliveryDisclosureNone,
      sub: tr.deliveryDisclosureSub,
    },
  ]
  // The PM's edits (saved config, or the live draft while editing): a manual
  // override replaces the computed planned / delivered / ok / sub-line of its
  // row (a null field keeps the computed one); her extra promises are appended.
  const deliveryConfig = view.delivery
  const deliveryRows: DeliveryDisplayRow[] = computedDeliveryRows
    .filter(row => delivery !== null || deliveryConfig.overrides[row.key] !== undefined)
    .map(row => {
      const o = deliveryConfig.overrides[row.key]
      if (!o) return { key: row.key, label: row.label, value: row.value, sub: row.sub, ok: row.ok, empty: row.empty, manual: false }
      const planned = o.planned ?? row.planned
      const delivered = o.delivered ?? row.delivered
      const ok = o.ok ?? row.ok
      const note = o.note?.trim() || undefined
      const hasFigures = o.planned != null || o.delivered != null
      // An unknown delivered figure (no overview.delivery, only "Prometido" set
      // by hand) reads as "— de N": an unknown is never presented as zero.
      const value = planned !== null && planned > 0
        ? (delivered !== null ? ratio(delivered, planned) : fill(tr.deliveryRatio, { delivered: '—', planned: fmtN(planned) }))
        : delivered !== null ? fmtN(delivered) : row.value
      // A note replaces the computed sub-line. The pieces row's "no commitment
      // recorded" hint follows the EFFECTIVE denominator (a manual one removes it).
      const computedSub = row.key === 'pieces' ? (planned === null ? tr.deliveryNoPlan : undefined) : row.sub
      return {
        key: row.key,
        label: row.label,
        value,
        sub: note ?? computedSub,
        ok,
        // A row the PM has resolved (state or figures set) is no longer pending.
        empty: row.empty && o.ok == null && !hasFigures,
        manual: true,
      }
    })
  for (const extra of deliveryConfig.extraRows) {
    const label = extra.label.trim()
    if (!label) continue
    deliveryRows.push({ key: `extra:${extra.id}`, label, value: (extra.value ?? '').trim(), ok: extra.ok, empty: false, manual: true })
  }
  // The client (portal, print, PDF) only sees the rows that are TRUE: an "in
  // review" row is an internal to-do (fix the roster, the dates or the
  // #publicidad flag), never a client-facing claim. On screen the PM sees all.
  const shownDeliveryRows = clientView ? deliveryRows.filter(r => r.ok) : deliveryRows
  const deliveryRowsHiddenFromClient = deliveryRows.filter(r => !r.ok).length

  // Balance in four labelled dimensions — agency only, on screen only.
  const balance = overview?.balance ?? null
  const showBalance = !isPortal && !printing && balance !== null
  type Tone = 'good' | 'mid' | 'bad' | 'none'
  const toneClass: Record<Tone, string> = {
    good: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400',
    mid: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    bad: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    none: 'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300',
  }
  const balanceRows: Array<{ key: string; label: string; value: string; tone: Tone }> = balance
    ? [
        {
          key: 'execution',
          label: tr.balanceExecution,
          value: balance.execution === 'complete' ? tr.balanceExecComplete : balance.execution === 'issues' ? tr.balanceExecIssues : balance.execution === 'incomplete' ? tr.balanceExecIncomplete : tr.balanceNoData,
          tone: balance.execution === 'complete' ? 'good' : balance.execution === 'issues' ? 'mid' : balance.execution === 'incomplete' ? 'bad' : 'none',
        },
        {
          key: 'results',
          label: tr.balanceResults,
          value: balance.results === 'above' ? tr.balanceResAbove : balance.results === 'on_target' ? tr.balanceResOnTarget : balance.results === 'below' ? tr.balanceResBelow : tr.balanceResNoTargets,
          tone: balance.results === 'above' ? 'good' : balance.results === 'on_target' ? 'mid' : balance.results === 'below' ? 'bad' : 'none',
        },
        {
          key: 'efficiency',
          label: tr.balanceEfficiency,
          value: balance.efficiency === 'better' ? tr.balanceEffBetter : balance.efficiency === 'in_range' ? tr.balanceEffInRange : balance.efficiency === 'worse' ? tr.balanceEffWorse : tr.balanceNoData,
          tone: balance.efficiency === 'better' ? 'good' : balance.efficiency === 'in_range' ? 'mid' : balance.efficiency === 'worse' ? 'bad' : 'none',
        },
        {
          key: 'reliability',
          label: tr.balanceReliability,
          value: balance.dataReliability === 'high' ? tr.balanceRelHigh : balance.dataReliability === 'medium' ? tr.balanceRelMedium : balance.dataReliability === 'low' ? tr.balanceRelLow : tr.balanceNoData,
          tone: balance.dataReliability === 'high' ? 'good' : balance.dataReliability === 'medium' ? 'mid' : balance.dataReliability === 'low' ? 'bad' : 'none',
        },
      ]
    : []

  // "Qué dijo la audiencia": the PM's highlighted comments, plus the positive
  // share of the captured comments only with ≥ SENTIMENT_MIN_COMMENTS analysed.
  const highlightedComments = view.highlightedComments.filter(c => c.text.trim().length > 0)
  const sentimentShare = sentiment && sentiment.total >= SENTIMENT_MIN_COMMENTS
    ? Math.round((sentiment.positive / sentiment.total) * 100)
    : null
  const showSentiment = showSection('sentiment') && (highlightedComments.length > 0 || sentimentShare !== null)
  const toneLabel = (t: ReportCommentSentiment) =>
    t === 'positive' ? tr.sentimentPositive : t === 'negative' ? tr.sentimentNegative : tr.sentimentNeutral

  // Fixed-layout column widths (percentages that sum ≤ 100 %)
  const objW = columnWidths([['kpi', 40], ['target', 20], ['actual', 20], ['variation', 20]])
  const creatorsW = columnWidths([
    editing && ['toggle', 4],
    ['creator', 20],
    ['platform', 11],
    showCol('creators.posts') && ['posts', 6],
    showCol('creators.posts') && ['stories', 7],
    showCol('creators.views') && ['views', 10],
    ['interactions', 12],
    ['audience', 12],
    showCol('creators.er') && ['er', 6],
    showCol('creators.followers') && ['followers', 10],
    report.hasBaseline && ['baseline', 9],
    showCostCol && ['cost', 8],
    showCpmCol && ['cpm', 8],
  ])
  const annexW = columnWidths([
    editing && ['toggle', 4],
    ['thumb', 5],
    ['content', 30],
    ['type', 9],
    ['date', 10],
    showCol('content.views') && ['views', 9],
    showCol('content.reach') && ['reach', 11],
    ['interactions', 11],
    showCol('content.source') && ['source', 11],
    ['link', 4],
  ])

  const thBase = 'px-2.5 py-2.5 align-bottom leading-tight'
  const tdNum = 'px-3 py-2.5 text-right tabular-nums'

  return (
    <div id="campaign-report" className="space-y-6">
      {/* Print styles (WYSIWYG): hide app chrome, white page, keep the screen
          colours (print-color-adjust: exact), pin the report to its desktop
          width on an A4-proportioned page — no relayout, so paper looks like
          the screen. The light theme is forced by the beforeprint handler
          above (and by printMode). The same rules apply on screen under
          html[data-report-print] (?print=1). */}
      <style>{REPORT_PRINT_CSS}</style>

      {/* 0. Actions — screen only, never printed, absent in the PDF renderer */}
      {!printMode && (
      <div className="no-print flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
          {canEdit && (
            lastSent ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Send className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {fill(tr.versionSent, { n: lastSent.version, date: formatDateTime(lastSent.sentAt, locale) })}
                </span>
                <span>{tr.by} {lastSent.sentBy}</span>
                {lastSent.note && <span className="italic">· {lastSent.note}</span>}
              </span>
            ) : (
              <span>{tr.neverSent}</span>
            )
          )}
          {refreshing && (
            <span className="ml-3 inline-flex items-center gap-1.5 text-purple-600 dark:text-purple-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {tr.refreshing}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href={resolvedBackHref}>
            <Button variant="secondary" size="sm">
              <ArrowLeft className="h-4 w-4" />
              {tr.backLabel}
            </Button>
          </Link>
          {canEdit && !editing && (
            <>
              <Button variant="secondary" size="sm" onClick={startEdit}>
                <Pencil className="h-4 w-4" />
                {tr.editReport}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => { setSentError(null); setSentOpen(o => !o) }}>
                <Send className="h-4 w-4" />
                {tr.markSent}
              </Button>
            </>
          )}
          {canEdit && editing && (
            <>
              <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={saving}>
                <X className="h-4 w-4" />
                {t.common.cancel}
              </Button>
              <Button variant="primary" size="sm" onClick={saveDraft} loading={saving}>
                <Check className="h-4 w-4" />
                {saving ? tr.saving : t.common.save}
              </Button>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            {tr.printReport}
          </Button>
          {/* Server-side PDF (same report, ?print=1 rendered headless) */}
          <Button as="a" variant="primary" size="sm" href={`${apiBase}/${campaignId}/report/pdf?locale=${locale}`} target="_blank" rel="noopener noreferrer" title={tr.pdfClientNote}>
            <FileDown className="h-4 w-4" />
            {tr.downloadPdf}
          </Button>
        </div>
      </div>
      )}

      {/* 0b. "Mark as sent" inline form — agency only */}
      {canEdit && sentOpen && !editing && (
        <div className="no-print flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3 print:hidden dark:border-gray-700 dark:bg-gray-900">
          <input
            type="text"
            maxLength={2000}
            value={sentNote}
            onChange={e => setSentNote(e.target.value)}
            placeholder={tr.sendNotePlaceholder}
            className={`${INPUT_CLASS} min-w-0 flex-1`}
          />
          <Button variant="primary" size="sm" onClick={markSent} loading={marking}>
            <Check className="h-4 w-4" />
            {tr.confirmSent}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSentOpen(false)} disabled={marking}>
            {t.common.cancel}
          </Button>
          {sentError && <p className="w-full text-xs text-red-600 dark:text-red-400">{sentError}</p>}
        </div>
      )}

      {/* 0c. Edit panel — agency only */}
      {editing && draft && (
        <ReportEditPanel draft={draft} tr={tr} error={saveError} deliveryComputed={computedDeliveryRows} onChange={patchDraft} />
      )}

      {/* 1. Cover — TKOC standard: page 1 of the PDF, tall hero on screen.
          Same markup for dashboard and portal. */}
      <section
        aria-label="Portada del informe"
        className="print-cover relative flex min-h-[70vh] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white p-8 shadow-sm sm:p-12 dark:border-gray-700 dark:bg-gray-900"
      >
        {/* Purple accent stripe */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-purple-700 via-purple-500 to-purple-300"
        />
        {/* Soft glow — screen only */}
        <div
          aria-hidden="true"
          className="no-print pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-purple-200/40 blur-3xl print:hidden dark:bg-purple-700/15"
        />

        {/* Top: agency wordmark, clearly readable on the cover */}
        <div className="relative">
          <TkocLogo size="cover" />
        </div>

        {/* Middle: brand, campaign, report kind, period */}
        <div className="relative flex flex-1 flex-col justify-center py-14">
          {brandName && (
            <div className="mb-8 flex items-center gap-4">
              <CoverBrandLogo src={campaign.brand?.logo} name={brandName} />
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Marca
                </p>
                <p className="truncate text-xl font-semibold text-gray-900 dark:text-gray-100">
                  {brandName}
                </p>
              </div>
            </div>
          )}
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-gray-900 sm:text-5xl dark:text-gray-100">
            {reportTitle}
          </h1>
          <p className="mt-3 text-xl font-medium text-purple-600 dark:text-purple-400">
            {coverSubtitle}
          </p>
          {(coverDateRange || platformsLabel) && (
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-600 dark:text-gray-300">
              {coverDateRange && (
                <span className="inline-flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
                  {coverDateRange}
                </span>
              )}
              {platformsLabel && <span>{platformsLabel}</span>}
            </div>
          )}
        </div>

        {/* Bottom: provenance */}
        <div className="relative flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-5 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span>{generatedOnLabel} {generatedOn}</span>
          <span>
            Elaborado por{' '}
            <span className="font-semibold text-gray-900 dark:text-gray-100">The King of Content</span>
          </span>
        </div>
      </section>

      {/* 1b. Header — compact running header for page 2 onwards */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {reportTitle}
            </h1>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-purple-600 dark:text-purple-400">{headerSubtitle}</span>
            {dateRange && (
              <>
                <span>&middot;</span>
                <span>{dateRange}</span>
              </>
            )}
            {(campaign.platforms?.length || 0) > 0 && (
              <>
                <span>&middot;</span>
                <span>{(campaign.platforms || []).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(', ')}</span>
              </>
            )}
            <span>&middot;</span>
            <span>{generatedOnLabel} {formatDate(new Date(), { locale })}</span>
          </div>
        </div>
        <div className="shrink-0 pt-1">
          <TkocLogo size="small" />
        </div>
      </div>

      {!totals ? (
        <div className="print-card rounded-xl border border-amber-200 bg-amber-50/60 px-5 py-8 text-center text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          {tr.overviewUnavailable}
        </div>
      ) : !hasMedia ? (
        <div className="print-card rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-900">
          <Search className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" />
          <p className="mt-4 font-medium text-gray-900 dark:text-gray-100">
            Aún no hay contenido capturado
          </p>
          {isPortal ? (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              En cuanto los creadores publiquen, el contenido y sus métricas aparecerán aquí.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Usa &laquo;Rastrear Ahora&raquo; en la página de la campaña para capturar publicaciones.
              </p>
              <Link
                href={`/campaigns/${campaignId}`}
                className="mt-4 inline-block text-sm font-medium text-purple-600 hover:underline dark:text-purple-400"
              >
                Ir a la campaña
              </Link>
            </>
          )}
        </div>
      ) : (
        <>
          {/* 2. Executive summary — REAL data only (decisions 4A/4B, brand study) */}
          {showSection('summary') && (
            <section>
              <SectionHeading>{tr.sectionSummary}</SectionHeading>
              {intro && (
                <p className="print-card mb-4 whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                  {intro}
                </p>
              )}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <StatCard icon={Users} label={tr.cardCreators} value={fmtN(totals.creatorsActive)} />
                <StatCard
                  icon={ImageIcon}
                  label={tr.cardContent}
                  value={fmtN(totals.media)}
                  sub={totals.stories > 0 ? fill(tr.cardStoriesSub, { n: totals.stories }) : undefined}
                />
                {showCol('summary.views') && (
                  <StatCard
                    icon={Eye}
                    label={tr.cardViews}
                    value={totals.views > 0 ? fmtN(totals.views) : '—'}
                    sub={totals.views > 0 ? tr.viewsRealSub : undefined}
                  />
                )}
                {showCol('summary.reach') && (
                  <StatCard
                    icon={BarChart3}
                    label={tr.cardRealAudience}
                    value={totals.audience.real > 0 ? fmtN(totals.audience.real) : '—'}
                    sub={fill(tr.cardRealReachSub, { n: realPieces, m: totals.media })}
                  />
                )}
                {showCol('summary.engagement') && (
                  <StatCard
                    icon={Heart}
                    label={tr.cardEngagements}
                    value={fmtN(totals.engagements)}
                    sub={tr.engagementsSub}
                  />
                )}
                {showCol('summary.er') && (
                  er && er.value !== null ? (
                    <StatCard
                      icon={TrendingUp}
                      label={tr.cardEr}
                      value={formatPct(er.value, locale)}
                      sub={fill(tr.erOnViewsSub, { n: fmtN(erPieces) })}
                    />
                  ) : (
                    <StatCard
                      icon={TrendingUp}
                      label={tr.cardEr}
                      value={tr.erInsufficientSample}
                      sub={erNullHint}
                      muted
                    />
                  )
                )}
              </div>

              {/* EMV: ONE figure for the client (the extended one, stories included),
                  labelled "EMV" with a hover explanation on screen and a footnote on
                  paper. Ratio EMV (never "ROI") and the real CPM only in the agency view. */}
              {(totals.emvExtended > 0 || showCpmTotal) && (
                <div className="print-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  {totals.emvExtended > 0 && (
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                        <Coins className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
                        <span>{tr.emvLabel}</span>
                        <HelpTip text={tr.emvTooltip} label={tr.emvHelp} />
                      </div>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatEur(totals.emvExtended, { locale })}
                      </p>
                    </div>
                  )}
                  {!clientView && totals.emvExtended > 0 && typeof totals.emvRatio === 'number' && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{tr.emvRatioLabel}</p>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatRatio(totals.emvRatio, { locale })}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{tr.emvRatioOnViewsSub}</p>
                    </div>
                  )}
                  {showCpmTotal && typeof totals.cpm === 'number' && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{tr.cpmRealLabel}</p>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatEur(totals.cpm, { locale, maxFractionDigits: 2 })}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{tr.cpmOnViewsSub}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Objectives vs results (decision 1B) — only the targets the PM filled in */}
              {targetRows.length > 0 && (
                <div className="print-card mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <Target className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
                    {tr.objectivesTitle}
                  </div>
                  <div className="print-table-wrap overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                          <th className={thBase} style={{ width: objW.kpi }}>{tr.objKpi}</th>
                          <th className={cn(thBase, 'text-right')} style={{ width: objW.target }}>{tr.objTarget}</th>
                          <th className={cn(thBase, 'text-right')} style={{ width: objW.actual }}>{tr.objActual}</th>
                          <th className={cn(thBase, 'text-right')} style={{ width: objW.variation }}>{tr.objVariation}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targetRows.map(tg => (
                          <tr key={tg.key} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                            <td className="px-3 py-2.5 font-medium text-gray-900 dark:text-gray-100">{kpiLabel(tg.key, tr)}</td>
                            <td className={cn(tdNum, 'text-gray-700 dark:text-gray-300')}>
                              {formatTargetValue(tg.key, tg.target, locale)}
                            </td>
                            <td className={cn(tdNum, 'text-gray-700 dark:text-gray-300')}>
                              {tg.actual !== null ? formatTargetValue(tg.key, tg.actual, locale) : '—'}
                            </td>
                            <td className={tdNum}>
                              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                                <span className="text-gray-700 dark:text-gray-300">
                                  {tg.variationPct !== null ? formatSignedPct(tg.variationPct, locale) : '—'}
                                </span>
                                <VerdictBadge verdict={tg.verdict} tr={tr} />
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-gray-800 dark:text-gray-500">
                    {tr.objectivesFootnote}
                  </p>
                </div>
              )}

              {/* Prometido vs entregado — four rows from overview.delivery; green only when true */}
              {shownDeliveryRows.length > 0 && (
                <div className="print-card mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <ClipboardList className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
                    {tr.deliveryTitle}
                    {!clientView && deliveryRowsHiddenFromClient > 0 && (
                      <span className="no-print font-normal normal-case tracking-normal text-amber-600 dark:text-amber-400 print:hidden">
                        — {fill(tr.deliveryClientHint, { n: deliveryRowsHiddenFromClient })}
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {shownDeliveryRows.map(row => (
                      <li key={row.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <div className="flex min-w-0 items-center gap-2.5">
                          {row.ok ? (
                            <CircleCheck className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
                          ) : row.empty ? (
                            <CircleDashed className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                          ) : (
                            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                          )}
                          <div className="min-w-0">
                            <p className="font-medium text-gray-900 dark:text-gray-100">
                              {row.label}
                              {/* Agency screen only: this row (or part of it) was set by the PM */}
                              {!clientView && row.manual && (
                                <span className="no-print ml-2 text-[10px] font-medium uppercase tracking-wide text-purple-500 print:hidden dark:text-purple-400">
                                  {tr.deliveryManualMark}
                                </span>
                              )}
                            </p>
                            {row.sub && <p className="text-[11px] text-gray-400 dark:text-gray-500">{row.sub}</p>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2 tabular-nums">
                          {row.value && <span className="text-gray-700 dark:text-gray-300">{row.value}</span>}
                          <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', row.ok ? toneClass.good : row.empty ? toneClass.none : toneClass.bad)}>
                            {row.ok ? tr.deliveryOk : row.empty ? tr.deliveryPending : tr.deliveryWarn}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Balance in four dimensions — agency only, screen only (never printed, never in the portal) */}
              {showBalance && balance && (
                <div className="no-print mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-4 print:hidden dark:border-amber-900/60 dark:bg-amber-900/10">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    <EyeOff className="h-3.5 w-3.5 shrink-0" />
                    {tr.balanceTitle}
                    <span className="rounded border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium tracking-wide dark:border-amber-700">{screenOnlyLabel}</span>
                    <span className="font-normal normal-case tracking-normal text-amber-600/80 dark:text-amber-400/80">— {tr.balanceHint}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {balanceRows.map(row => (
                      <div key={row.key} className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{row.label}</p>
                        <span className={cn('mt-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium', toneClass[row.tone])}>
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-400">
                    {fill(tr.balanceRealShare, { pct: Math.round((balance.realShare || 0) * 100) })}
                  </p>
                </div>
              )}

              {/* Paper has no hover: ONE discreet line with the EMV explanation */}
              {totals.emvExtended > 0 && (
                <p className="print-only mt-3 text-[10px] leading-snug text-gray-400">
                  {tr.emvLabel}: {tr.emvTooltip}
                </p>
              )}
            </section>
          )}

          {/* 4. Contenidos destacados — the pieces with REAL audience, most first, as
              cards (only rows with a real figure; the heading states how many).
              None with real data → one disclaimer; the complete list is the annex. */}
          {showSection('content') && (
            <section>
              <SectionHeading hint={highlightItems.length === 1 ? tr.highlightsSubOne : highlightItems.length > 0 ? fill(tr.highlightsSub, { n: highlightItems.length }) : undefined}>
                {tr.sectionHighlights}
              </SectionHeading>
              {highlightItems.length === 0 ? (
                <p className="print-card rounded-xl border border-gray-200 bg-white px-5 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  {tr.highlightsEmpty}
                </p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {highlightItems.map(({ media: m, metrics }) => {
                      const deleted = m.isDeleted === true || metrics?.isDeleted === true
                      return (
                        <div
                          key={m.id}
                          className={cn(
                            'print-card flex min-w-0 gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900',
                            deleted && 'bg-gray-50/60 dark:bg-gray-800/40'
                          )}
                        >
                          <div className={cn('shrink-0', deleted && 'opacity-50 grayscale')}>
                            <MediaThumb mediaId={m.id} src={m.thumbnailUrl} alt={m.caption || 'Contenido'} size={64} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <p className={cn('truncate text-xs font-semibold', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-purple-600 dark:text-purple-400')}>
                                @{m.influencer?.username || 'desconocido'}
                              </p>
                              <Badge variant="default" className="px-2 py-0 text-[10px]">{mediaTypeLabel(m.mediaType)}</Badge>
                            </div>
                            <p className={cn('mt-0.5 line-clamp-1 text-[11px]', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300')}>
                              {m.caption || 'Sin descripción'}
                            </p>
                            <dl className={cn('mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')}>
                              {showCol('content.views') && (
                                <div className="flex items-baseline gap-1">
                                  <dt className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{tr.colViews}</dt>
                                  <dd className="font-semibold">{(m.views || 0) > 0 ? fmtN(m.views as number) : '—'}</dd>
                                </div>
                              )}
                              {showCol('content.reach') && metrics && !metrics.audienceEstimated && metrics.audience > 0 && metrics.audienceBasis === 'reach' && (
                                <div className="flex items-baseline gap-1">
                                  <dt className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{tr.colRealReach}</dt>
                                  <dd className="font-semibold">{fmtN(metrics.audience)}</dd>
                                </div>
                              )}
                              <div className="flex items-baseline gap-1">
                                <dt className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{tr.colInteractions}</dt>
                                <dd className="font-semibold">{metrics ? fmtN(metrics.engagements) : '—'}</dd>
                              </div>
                            </dl>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <AudienceLabel metrics={metrics} tr={tr} />
                              {deleted && <DeletedBadge label={tr.deletedBadge} />}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </section>
          )}

          {/* 5. Per-creator performance (overview.perInfluencer) */}
          {showSection('creators') && visibleCreators.length > 0 && (
            <section>
              <SectionHeading>{tr.sectionCreators}</SectionHeading>
              <div className="print-table-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <div className="print-table-wrap overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        {editing && (
                          <th className={cn(thBase, 'no-print print:hidden')} style={{ width: creatorsW.toggle }} title={tr.hideFromClient}>
                            <EyeOff className="h-3.5 w-3.5" />
                          </th>
                        )}
                        <th className={thBase} style={{ width: creatorsW.creator }}>{tr.colCreator}</th>
                        <th className={thBase} style={{ width: creatorsW.platform }}>{locale === 'es' ? 'Red' : 'Network'}</th>
                        {showCol('creators.posts') && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.posts }}>Posts</th>}
                        {showCol('creators.posts') && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.stories }}>{tr.colStories}</th>}
                        {showCol('creators.views') && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.views }}>{tr.colViews}</th>}
                        <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.interactions }}>{tr.colInteractions}</th>
                        <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.audience }}>{tr.colRealAudience}</th>
                        {showCol('creators.er') && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.er }}>ER</th>}
                        {showCol('creators.followers') && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.followers }}>Seguidores</th>}
                        {report.hasBaseline && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.baseline }}>{tr.colBaseline}</th>}
                        {showCostCol && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.cost }}>{tr.colCost}</th>}
                        {showCpmCol && <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.cpm }}>{tr.colCpm}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCreators.map((c, idx) => {
                        const p = c.p
                        const num = cn(tdNum, 'text-gray-700 dark:text-gray-300')
                        return (
                          <tr
                            key={c.key || idx}
                            className={cn(
                              'border-b border-gray-100 last:border-0 dark:border-gray-800',
                              c.hidden && 'no-print bg-amber-50/40 opacity-60 print:hidden dark:bg-amber-900/10'
                            )}
                          >
                            {editing && (
                              <td className="no-print px-3 py-2.5 print:hidden">
                                <RowVisibilityToggle
                                  hidden={c.hidden}
                                  disabled={!c.key}
                                  title={c.hidden ? tr.showRow : tr.hideRow}
                                  onToggle={() => patchDraft({ hiddenInfluencerIds: toggleId(draft?.hiddenInfluencerIds || [], c.key) })}
                                />
                              </td>
                            )}
                            <td className="px-3 py-2.5">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <FixedAvatar src={c.inf.avatarUrl} name={c.inf.displayName || c.inf.username || '?'} />
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-gray-900 dark:text-gray-100">
                                    @{c.inf.username || '—'}
                                  </p>
                                  {c.inf.displayName && (
                                    <p className="truncate text-xs text-gray-500 dark:text-gray-400">{c.inf.displayName}</p>
                                  )}
                                  {c.hidden && (
                                    <div className="mt-1" title={p ? undefined : tr.hiddenCreatorNoFigures}>
                                      <HiddenBadge label={tr.hiddenRow} />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <Badge
                                variant={
                                  c.inf.platform === 'INSTAGRAM' ? 'instagram'
                                    : c.inf.platform === 'TIKTOK' ? 'tiktok'
                                    : c.inf.platform === 'YOUTUBE' ? 'youtube'
                                    : 'default'
                                }
                              >
                                {c.inf.platform ? c.inf.platform.charAt(0) + c.inf.platform.slice(1).toLowerCase() : '—'}
                              </Badge>
                            </td>
                            {showCol('creators.posts') && <td className={num}>{p ? p.posts : '—'}</td>}
                            {showCol('creators.posts') && <td className={num}>{p ? p.stories : '—'}</td>}
                            {showCol('creators.views') && (
                              <td className={num}>{p && p.views > 0 ? fmtN(p.views) : '—'}</td>
                            )}
                            <td className={num}>{p ? fmtN(p.engagements) : '—'}</td>
                            <td className={num}>{p && p.audience.real > 0 ? fmtN(p.audience.real) : '—'}</td>
                            {showCol('creators.er') && (
                              <td className={cn(num, 'whitespace-nowrap')}>
                                {p && p.er.value !== null ? formatPct(p.er.value, locale) : '—'}
                              </td>
                            )}
                            {showCol('creators.followers') && (
                              <td className={num}>{fmtN(c.inf.followers || 0)}</td>
                            )}
                            {report.hasBaseline && (
                              <td className={num}>
                                {c.baseline && c.baseline.multiplier !== null
                                  ? `${formatRatio(c.baseline.multiplier, { locale, digits: 2 })} (n=${c.baseline.n})`
                                  : '—'}
                              </td>
                            )}
                            {showCostCol && (
                              <td className={num}>{p && (p.cost ?? 0) > 0 ? formatEur(p.cost as number, { locale }) : '—'}</td>
                            )}
                            {showCpmCol && (
                              <td className={num}>
                                {p && typeof p.cpm === 'number' ? formatEur(p.cpm, { locale, maxFractionDigits: 2 }) : '—'}
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 text-[11px] text-gray-400 dark:text-gray-500">
                <p>{tr.creatorsFootnoteViews}</p>
                {report.hasBaseline && <p>{tr.baselineFootnote}</p>}
                {(showCostCol || showCpmCol) && <p>{tr.costFootnoteViews}</p>}
              </div>
            </section>
          )}

          {/* 5b. Qué dijo la audiencia — the PM's highlighted comments (quote cards)
              and, only with ≥ 20 analysed comments, the real positive share. Hidden
              automatically when there is neither. */}
          {showSentiment && (
            <section>
              <SectionHeading hint={highlightedComments.length > 0 ? tr.sentimentSub : undefined}>
                {tr.sectionSentiment}
              </SectionHeading>
              {sentimentShare !== null && sentiment && (
                <div className="print-card mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <MessageSquare className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
                    <span>{fill(tr.sentimentShareLine, { pct: sentimentShare, total: fmtN(sentiment.total) })}</span>
                  </div>
                  <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700" aria-hidden="true">
                    {sentiment.positive > 0 && <div className="h-full bg-green-500" style={{ width: `${(sentiment.positive / sentiment.total) * 100}%` }} />}
                    {sentiment.neutral > 0 && <div className="h-full bg-gray-400" style={{ width: `${(sentiment.neutral / sentiment.total) * 100}%` }} />}
                    {sentiment.negative > 0 && <div className="h-full bg-red-400" style={{ width: `${(sentiment.negative / sentiment.total) * 100}%` }} />}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    <span className="inline-flex items-center gap-1.5"><ToneDot sentiment="positive" label={tr.sentimentPositive} />{tr.sentimentPositive} {fmtN(sentiment.positive)}</span>
                    <span className="inline-flex items-center gap-1.5"><ToneDot sentiment="neutral" label={tr.sentimentNeutral} />{tr.sentimentNeutral} {fmtN(sentiment.neutral)}</span>
                    <span className="inline-flex items-center gap-1.5"><ToneDot sentiment="negative" label={tr.sentimentNegative} />{tr.sentimentNegative} {fmtN(sentiment.negative)}</span>
                  </div>
                </div>
              )}
              {highlightedComments.length > 0 && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {highlightedComments.map(c => (
                    <figure key={c.id} className="print-card min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                      <blockquote className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                        &ldquo;{c.text.trim()}&rdquo;
                      </blockquote>
                      <figcaption className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <ToneDot sentiment={c.sentiment} label={toneLabel(c.sentiment)} />
                        {c.author.trim() && <span className="truncate font-medium text-purple-600 dark:text-purple-400">@{c.author.trim().replace(/^@+/, '')}</span>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 6. Datos: qué es real — counts per audience basis. Agency screen only:
              the client never sees estimates, so a "92 % sin dato" bar is an
              internal to-do (capture the creators' statistics), not a result. */}
          {showSection('quality') && !clientView && (
            <section className="no-print print:hidden">
              <SectionHeading>{tr.sectionQualityReal}</SectionHeading>
              <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                {(() => {
                  const total = totals.media
                  const realPct = total > 0 ? Math.round((realPieces / total) * 100) : 0
                  const noRealPct = total > 0 ? 100 - realPct : 0
                  return (
                    <>
                      <div className="mb-2 flex items-center justify-between text-xs font-medium">
                        <span className="text-green-700 dark:text-green-400">
                          {fmtN(realPieces)} {tr.qualityBarReal} ({formatPct(realPct, locale, 0)})
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {fmtN(withoutRealData)} {tr.qualityBarNoReal} ({formatPct(noRealPct, locale, 0)})
                        </span>
                      </div>
                      <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        {realPct > 0 && <div className="h-full bg-green-500" style={{ width: `${realPct}%` }} />}
                        {noRealPct > 0 && <div className="h-full bg-gray-400 dark:bg-gray-500" style={{ width: `${noRealPct}%` }} />}
                      </div>
                      <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                        <li>{fill(tr.qualityRealViewsLine, { n: fmtN(realViewsCount) })}</li>
                        <li>{fill(tr.qualityNoRealDataLine, { n: fmtN(withoutRealData) })}</li>
                        {report.creatorInsightsCount > 0 && (
                          <li>{fill(tr.qualityCreatorInsightsLine, { n: report.creatorInsightsCount })}</li>
                        )}
                        <li>{fill(tr.qualityDeletedLine, { n: totals.mediaDeleted })}</li>
                      </ul>
                    </>
                  )
                })()}
              </div>
            </section>
          )}
        </>
      )}

      {/* 7. Business results (decision 14A) — only when the client filled something in.
          Rendered even without captured content: sales data can arrive before tracking does. */}
      {showBusiness && biz && (
        <section>
          <SectionHeading>{tr.businessTitle}</SectionHeading>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {biz.promoCode && (
              <StatCard icon={Tag} label={tr.promoCode} value={biz.promoCode} />
            )}
            {biz.codeRedemptions !== null && (
              <StatCard icon={Tag} label={tr.codeRedemptions} value={fmtN(biz.codeRedemptions)} />
            )}
            {biz.clientReportedSales !== null && (
              <StatCard icon={ShoppingBag} label={tr.clientSales} value={fmtN(biz.clientReportedSales)} />
            )}
            {biz.clientReportedLeads !== null && (
              <StatCard icon={Users} label={tr.clientLeads} value={fmtN(biz.clientReportedLeads)} />
            )}
            {biz.clientReportedRevenue !== null && (
              <StatCard icon={Coins} label={tr.clientRevenue} value={formatEur(biz.clientReportedRevenue, { locale })} />
            )}
            {/* CPA / ROAS derive from cost: agency only, and only when the overview carries them */}
            {!clientView && biz.cpa !== null && (
              <StatCard icon={Coins} label={tr.cpaLabel} value={formatEur(biz.cpa, { locale, maxFractionDigits: 2 })} sub={tr.cpaSubFull} />
            )}
            {!clientView && biz.roas !== null && (
              <StatCard icon={TrendingUp} label={tr.roasLabel} value={formatRatio(biz.roas, { locale, digits: 2 })} sub={tr.roasSubFull} />
            )}
          </div>
          <div className="mt-2 space-y-0.5 text-[11px] text-gray-400 dark:text-gray-500">
            {(biz.source || biz.reportedAt) && (
              <p>
                {biz.source && <span>{tr.businessSource}: {biz.source}</span>}
                {biz.source && biz.reportedAt && <span> · </span>}
                {biz.reportedAt && <span>{tr.businessReportedAt}: {formatDate(biz.reportedAt, { locale, style: 'long' })}</span>}
              </p>
            )}
            {biz.businessNotes && <p className="whitespace-pre-line">{tr.businessNotes}: {biz.businessNotes}</p>}
            <p>{tr.businessDisclaimer}</p>
          </div>
        </section>
      )}

      {/* 8. Aprendizajes y próximos pasos — built server-side. `shownLearnings`
          is the CLIENT projection in the portal and while printing (the PDF the
          PM sends), the full staff object on screen. Texts the client will not
          read carry a "solo pantalla" marker. Not rendered without learnings. */}
      {showLearnings && shownLearnings && (
        <section>
          <SectionHeading hint={shownLearnings.generatedAt ? fill(tr.learningsGeneratedAt, { date: formatDate(shownLearnings.generatedAt, { locale }) }) : undefined}>
            {tr.sectionLearnings}
          </SectionHeading>

          {shownLearnings.insights.length > 0 && (
            <LearningCard icon={Lightbulb} title={tr.learningsInsightsTitle} className="mb-4">
              <ul className="space-y-2">
                {shownLearnings.insights.map((ins, i) => {
                  const internal = screenOnly(ins.text)
                  return (
                    <li key={i} className={cn('flex items-start gap-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300', internal && 'no-print print:hidden')}>
                      <InsightIcon type={ins.type} />
                      <span className="min-w-0">
                        {ins.text}
                        {internal && <ScreenOnlyBadge label={screenOnlyLabel} />}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </LearningCard>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Qué repetir */}
            <LearningCard icon={Repeat} title={tr.learningsRepeatTitle}>
              {shownLearnings.repeatList.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {shownLearnings.repeatList.map(u => (
                    <span key={u} className="inline-flex items-center rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                      @{u.replace(/^@/, '')}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">{tr.learningsRepeatEmpty}</p>
              )}
              {shownLearnings.topPerformer && (
                <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    <Star className="h-3 w-3 shrink-0 text-amber-500" />
                    <span className="shrink-0">{tr.learningsTopPerformer}:</span> <span className="min-w-0 truncate normal-case text-gray-700 dark:text-gray-300">@{shownLearnings.topPerformer.username.replace(/^@/, '')}</span>
                  </p>
                  {shownLearnings.topPerformer.reason && (
                    <p className={cn('mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400', screenOnly(shownLearnings.topPerformer.reason) && 'no-print print:hidden')}>
                      {shownLearnings.topPerformer.reason}
                      {screenOnly(shownLearnings.topPerformer.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                </div>
              )}
            </LearningCard>

            {/* Formato ganador */}
            <LearningCard icon={Film} title={tr.learningsFormatTitle}>
              {shownLearnings.bestFormat ? (
                <>
                  <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{mediaTypeLabel(shownLearnings.bestFormat.format)}</p>
                  {shownLearnings.bestFormat.reason && (
                    <p className={cn('mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400', screenOnly(shownLearnings.bestFormat.reason) && 'no-print print:hidden')}>
                      {shownLearnings.bestFormat.reason}
                      {screenOnly(shownLearnings.bestFormat.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                  {shownLearnings.worstFormat && (
                    <p className={cn('mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400', screenOnly(shownLearnings.worstFormat.reason) && 'no-print print:hidden')}>
                      <span className="font-semibold text-gray-600 dark:text-gray-300">{tr.learningsWorstFormat}: {mediaTypeLabel(shownLearnings.worstFormat.format)}.</span>{' '}
                      {shownLearnings.worstFormat.reason}
                      {screenOnly(shownLearnings.worstFormat.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">{tr.learningsFormatEmpty}</p>
              )}
            </LearningCard>

            {/* Siguiente oleada. The staff text is rewritten for the client
                (no budget / fee wording): on screen the PM sees both. */}
            <LearningCard icon={ArrowRight} title={tr.learningsNextTitle}>
              <p className={cn('text-sm leading-relaxed text-gray-700 dark:text-gray-300', screenOnly(shownLearnings.nextCampaignRec) && 'no-print print:hidden')}>
                {shownLearnings.nextCampaignRec || '—'}
                {screenOnly(shownLearnings.nextCampaignRec) && <ScreenOnlyBadge label={screenOnlyLabel} />}
              </p>
              {screenOnly(shownLearnings.nextCampaignRec) && learningsClient?.nextCampaignRec && (
                <p className="mt-2 border-t border-gray-100 pt-2 text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <span className="font-semibold text-gray-600 dark:text-gray-300">{locale === 'es' ? 'En el informe del cliente' : 'In the client report'}:</span>{' '}
                  {learningsClient.nextCampaignRec}
                </p>
              )}
            </LearningCard>
          </div>

          {/* Agency-only block: screen only ("solo pantalla"), never printed, never in the portal */}
          {internalLearnings && learnings && (
            <div className="no-print mt-4 rounded-xl border border-amber-200 bg-amber-50/40 p-5 print:hidden dark:border-amber-900/60 dark:bg-amber-900/10">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                <EyeOff className="h-3.5 w-3.5 shrink-0" />
                {tr.learningsInternalTitle}
                <span className="rounded border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium tracking-wide dark:border-amber-700">{screenOnlyLabel}</span>
                <span className="font-normal normal-case tracking-normal text-amber-600/80 dark:text-amber-400/80">— {tr.learningsInternalHint}</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {(learnings.grade || learnings.ratioVerdict) && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.learningsGrade}</p>
                    <p className="mt-1 text-sm text-gray-800 dark:text-gray-200">
                      {learnings.grade && <span className="text-xl font-bold">{learnings.grade}</span>}
                      {learnings.grade && learnings.ratioVerdict && <span className="mx-2 text-gray-400">·</span>}
                      {learnings.ratioVerdict}
                    </p>
                  </div>
                )}
                {learnings.worstPerformer && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.learningsWorstPerformer}</p>
                    <p className="mt-1 text-sm font-medium text-gray-800 dark:text-gray-200">@{learnings.worstPerformer.username.replace(/^@/, '')}</p>
                    {learnings.worstPerformer.reason && (
                      <p className="mt-0.5 text-xs leading-relaxed text-gray-600 dark:text-gray-400">{learnings.worstPerformer.reason}</p>
                    )}
                  </div>
                )}
                {learnings.skipList.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.learningsReviewTitle}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {learnings.skipList.map(u => (
                        <span key={u} className="inline-flex items-center rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:border-amber-700 dark:bg-gray-900 dark:text-amber-300">
                          @{u.replace(/^@/, '')}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {learnings.budgetAdvice && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{tr.learningsBudgetTitle}</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-700 dark:text-gray-300">{learnings.budgetAdvice}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Decisiones acordadas — the PM's editable conclusions text */}
          {showDecisions && (
            <LearningCard icon={ClipboardList} title={tr.learningsDecisionsTitle} className="mt-4">
              <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                {conclusions}
              </p>
            </LearningCard>
          )}
        </section>
      )}

      {/* 8b. Conclusions on their own — only without a learnings section */}
      {showStandaloneConclusions && (
        <section>
          <SectionHeading>{tr.conclusionsTitle}</SectionHeading>
          <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {conclusions}
            </p>
          </div>
        </section>
      )}

      {/* 9. Anexo · Todos los contenidos — one compact line per piece, on a new page */}
      {showAnnex && (
        <section className={cn('print-break-before', annexHiddenForClient && 'no-print print:hidden')}>
          <SectionHeading hint={tr.annexSub}>{tr.sectionAnnex}</SectionHeading>
          {annexHiddenForClient && (
            <div className="no-print mb-3 print:hidden">
              <HiddenBadge label={tr.sectionHiddenPreview} />
            </div>
          )}
          <div className="print-table-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className="print-table-wrap overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    {editing && (
                      <th className={cn(thBase, 'no-print print:hidden')} style={{ width: annexW.toggle }} title={tr.hideFromClient}>
                        <EyeOff className="h-3.5 w-3.5" />
                      </th>
                    )}
                    <th className={thBase} style={{ width: annexW.thumb }} aria-label={tr.colContent} />
                    <th className={thBase} style={{ width: annexW.content }}>{tr.colContent}</th>
                    <th className={thBase} style={{ width: annexW.type }}>{tr.colType}</th>
                    <th className={thBase} style={{ width: annexW.date }}>{tr.colDate}</th>
                    {showCol('content.views') && <th className={cn(thBase, 'text-right')} style={{ width: annexW.views }}>{tr.colViews}</th>}
                    {showCol('content.reach') && <th className={cn(thBase, 'text-right')} style={{ width: annexW.reach }}>{tr.colRealAudience}</th>}
                    <th className={cn(thBase, 'text-right')} style={{ width: annexW.interactions }}>{tr.colInteractions}</th>
                    {showCol('content.source') && <th className={thBase} style={{ width: annexW.source }}>{tr.colSource}</th>}
                    <th className={cn(thBase, 'no-print print:hidden')} style={{ width: annexW.link }}>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map(({ media: m, metrics, real, hidden, hiddenById, hiddenByCreator }) => {
                    const deleted = m.isDeleted === true || metrics?.isDeleted === true
                    const cell = cn(tdNum, deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')
                    const posted = reportDate(m.postedAt, locale)
                    return (
                      <tr
                        key={m.id}
                        className={cn(
                          'border-b border-gray-100 last:border-0 dark:border-gray-800',
                          deleted && 'bg-gray-50/60 text-gray-400 dark:bg-gray-800/40',
                          hidden && 'no-print bg-amber-50/40 opacity-60 print:hidden dark:bg-amber-900/10'
                        )}
                      >
                        {editing && (
                          <td className="no-print px-3 py-2 print:hidden">
                            <RowVisibilityToggle
                              hidden={hiddenById || hiddenByCreator}
                              disabled={hiddenByCreator && !hiddenById}
                              title={hidden ? tr.showRow : tr.hideRow}
                              onToggle={() => patchDraft({ hiddenMediaIds: toggleId(draft?.hiddenMediaIds || [], m.id) })}
                            />
                          </td>
                        )}
                        <td className="px-2 py-2">
                          <div className={cn('flex', deleted && 'opacity-50 grayscale')}>
                            <MediaThumb mediaId={m.id} src={m.thumbnailUrl} alt={m.caption || 'Contenido'} size={28} />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="min-w-0">
                            <p className={cn('truncate text-xs font-medium', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-purple-600 dark:text-purple-400')}>
                              @{m.influencer?.username || 'desconocido'}
                            </p>
                            <p className={cn('line-clamp-1 text-[11px]', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300')}>
                              {m.caption || 'Sin descripción'}
                            </p>
                            {(deleted || hidden) && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {deleted && <DeletedBadge label={tr.deletedBadge} />}
                                {hidden && <HiddenBadge label={tr.hiddenRow} />}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-300">{mediaTypeLabel(m.mediaType)}</td>
                        <td className="px-3 py-2 text-xs tabular-nums text-gray-700 dark:text-gray-300">{posted || '—'}</td>
                        {showCol('content.views') && (
                          <td className={cell}>{(m.views || 0) > 0 ? fmtN(m.views as number) : '—'}</td>
                        )}
                        {showCol('content.reach') && (
                          <td className={cell}>
                            {real > 0 ? (
                              <>
                                <span>{fmtN(real)}</span>
                                {metrics && metrics.audienceBasis === 'reach' && (
                                  <span className="block text-[10px] text-gray-400 dark:text-gray-500">{tr.basisReach}</span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        )}
                        <td className={cell}>{metrics ? fmtN(metrics.engagements) : '—'}</td>
                        {showCol('content.source') && (
                          <td className="px-3 py-2">
                            <SourceBadge source={m.source} insightsSource={m.insightsSource} tr={tr} />
                          </td>
                        )}
                        <td className="no-print px-3 py-2 print:hidden">
                          {m.permalink ? (
                            <a
                              href={m.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex text-gray-400 transition-colors hover:text-purple-600 dark:hover:text-purple-400"
                              title="Ver publicación"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600">—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-2 space-y-0.5 text-[11px] text-gray-400 dark:text-gray-500">
            {showCol('content.reach') && <p>{tr.audienceFootnoteReal}</p>}
            {/* Decision 7B: deleted posts stay in the totals, disclosed */}
            {totals && totals.mediaDeleted > 0 && (
              <p>
                {totals.mediaDeleted === 1
                  ? tr.deletedFootnoteOne
                  : fill(tr.deletedFootnote, { n: totals.mediaDeleted })}
                .
              </p>
            )}
            {/* Agency-only transparency note (screen only, never in the
                portal and never in the PDF that goes to the client). */}
            {!isPortal && (report.hiddenMediaCount > 0 || report.hiddenCreatorCount > 0) && (
              <p className="no-print text-amber-600 print:hidden dark:text-amber-400">
                {[
                  report.hiddenMediaCount > 0
                    ? (report.hiddenMediaCount === 1 ? tr.excludedFootnoteOne : fill(tr.excludedFootnote, { n: report.hiddenMediaCount }))
                    : null,
                  report.hiddenCreatorCount > 0 ? hiddenCreatorsNote(report.hiddenCreatorCount, locale) : null,
                ].filter(Boolean).join(' · ')}
                .
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
