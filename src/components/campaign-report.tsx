'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { flushSync } from 'react-dom'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { cn, formatNumber, formatEur, formatRatio, formatDate } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'
import type { BaselineComparison } from '@/lib/creator-baseline'
// Pure module (no Prisma): the ONE economic-wording test the server projection
// uses, kept here only as a last-resort print guard (see screenOnly below).
import { hasEconomicWording } from '@/lib/campaign-learnings'
import { useI18n } from '@/i18n/context'
import type { Locale, TranslationKeys } from '@/i18n/translations'
// Types only: '@/lib/report-config' imports Prisma and must never be bundled
// into this client component.
import type {
  ReportConfig,
  ReportColumnId,
  ReportSectionId,
  ReportSentVersion,
} from '@/lib/report-config'
// Types only: the shapes of the server-side overview (src/lib/metrics.ts).
import type {
  AudienceBasis,
  AudienceTotals,
  BusinessResults,
  EngagementRateResult,
  TargetComparison,
  TargetKey,
  TargetVerdict,
  TimelinePoint,
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
// Decision 4A (David 2026-09-05): REAL data first. Headline numbers are real
// (views, Σ real audience, interactions, ER on the real base); anything
// estimated is ONE separate, labelled, hideable line. Never mixed.
//
// Print: the report is laid out for A4 portrait with 12mm margins (content
// width ≈ 703px at 96 dpi). Every table is `table-layout: fixed` with widths
// that sum ≤ 100 %, grids are forced to three columns, thumbnails have explicit
// pixel boxes, and the daily chart renders with an explicit width because
// ResponsiveContainer measures 0 px while printing. The body shows up to six
// pieces with REAL audience (never one without); the complete list is a
// compact annex. While printing, the learnings render the client projection.
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
  audience: AudienceTotals
  reachReal: number
  impressionsReal: number | null
  er: EngagementRateResult
  members: number
  emvExtended: number
  emvEstimatedStories: number
  emvRealStories: number
  emvEstimatedAudience: number
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
  audience: AudienceTotals
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
  timeline: TimelinePoint[]
  targets: TargetComparison[]
  business: BusinessResults | null
}

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
  return {
    definitionsVersion: typeof r.definitionsVersion === 'number' ? r.definitionsVersion : undefined,
    totals,
    perInfluencer: asArray<ReportPerInfluencer>(r.perInfluencer),
    perMedia: asArray<ReportPerMedia>(r.perMedia),
    timeline: asArray<TimelinePoint>(r.timeline),
    targets: asArray<TargetComparison>(r.targets),
    business: r.business && typeof r.business === 'object' ? (r.business as BusinessResults) : null,
  }
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

const EMPTY_CONFIG: ReportConfig = {
  hiddenSections: [],
  hiddenColumns: [],
  hiddenMediaIds: [],
  hiddenInfluencerIds: [],
  sentVersions: [],
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
// Recharts (client-side only, same dynamic-import pattern as the detail page)
// ---------------------------------------------------------------------------

interface ChartLabels {
  engagements: string
  posts: string
}

/**
 * Print chart box. A4 portrait minus 12mm margins ≈ 703px; the card keeps
 * 12px of padding and a 1px border per side while printing, so 640px always
 * fits without scaling. (ResponsiveContainer measures 0px in print.)
 */
const PRINT_CHART_WIDTH = 640
const PRINT_CHART_HEIGHT = 220

/** 'YYYY-MM-DD' (Europe/Madrid day key) → local Date on that calendar day. */
function dayKeyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

const ReportAreaChart = dynamic(
  () => import('recharts').then(mod => {
    const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = mod
    return function ChartWrapper({
      data,
      labels,
      locale,
      print,
    }: {
      data: TimelinePoint[]
      labels: ChartLabels
      locale: Locale
      /** Explicit pixel size instead of ResponsiveContainer (which measures 0 while printing). */
      print: boolean
    }) {
      const body = (
        <>
          <defs>
            <linearGradient id="grad_report_engagement" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="grad_report_posts" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickFormatter={(v: string) => {
              const d = dayKeyToDate(String(v))
              return `${d.getDate()}/${d.getMonth() + 1}`
            }}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickFormatter={(v: number) => formatNumber(v, { locale })}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            allowDecimals={false}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
          />
          {/* The day key is a Europe/Madrid calendar day ('YYYY-MM-DD'): the
              shared helper renders it in that zone and in the UI locale. A
              tooltip has no place on paper. */}
          {!print && (
            <Tooltip
              contentStyle={{
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                boxShadow: '0 4px 6px -1px rgba(0,0,0,.1)',
                fontSize: '12px',
              }}
              labelFormatter={(v) => formatDate(String(v), { locale })}
              formatter={(value, name) => [formatNumber(Number(value), { locale }), String(name)]}
            />
          )}
          <Legend wrapperStyle={{ fontSize: '11px' }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="engagements"
            name={labels.engagements}
            stroke="#7c3aed"
            strokeWidth={2}
            fill="url(#grad_report_engagement)"
            isAnimationActive={!print}
          />
          <Area
            yAxisId="right"
            type="monotone"
            dataKey="posts"
            name={labels.posts}
            stroke="#a78bfa"
            strokeWidth={2}
            fill="url(#grad_report_posts)"
            isAnimationActive={!print}
          />
        </>
      )
      const margin = { top: 5, right: 10, left: 0, bottom: 5 }
      if (print) {
        return (
          <AreaChart data={data} width={PRINT_CHART_WIDTH} height={PRINT_CHART_HEIGHT} margin={margin}>
            {body}
          </AreaChart>
        )
      }
      return (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={data} margin={margin}>
            {body}
          </AreaChart>
        </ResponsiveContainer>
      )
    }
  }),
  {
    ssr: false,
    loading: () => <div className="h-[260px] animate-pulse rounded-xl bg-gray-100 dark:bg-gray-800" />,
  }
)

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

/** Real / estimated / no-data marker of one publication (decision 4A). */
function AudienceLabel({ metrics, tr }: { metrics: ReportMediaMetrics | null; tr: ReportStrings }) {
  if (!metrics || metrics.audienceBasis === 'none' || metrics.audience <= 0) {
    return <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">{tr.labelNoAudience}</span>
  }
  if (metrics.audienceEstimated) {
    return <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500">{tr.labelEstimated}</span>
  }
  const label =
    metrics.audienceBasis === 'reach' ? tr.labelRealReach
      : metrics.audienceBasis === 'impressions' ? tr.labelRealImpressions
      : tr.labelRealViews
  return <span className="text-[10px] font-medium text-green-700 dark:text-green-400">{label}</span>
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
function MediaThumb({ src, alt, size = 40 }: { src?: string | null; alt: string; size?: 28 | 40 | 64 }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
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
function TkocLogo({ className = '' }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/images/tkoc-logo-full.png"
      alt="The King of Content"
      className={`block h-8 w-72 max-w-full object-contain object-left ${className}`}
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
    <div className="print-card print-kpi min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="print-kpi-label flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Icon className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
        <span className="min-w-0">{label}</span>
      </div>
      <p
        className={cn(
          'print-kpi-value mt-2 break-words font-bold tabular-nums',
          muted ? 'text-lg text-gray-500 dark:text-gray-400' : 'text-2xl text-gray-900 dark:text-gray-100'
        )}
      >
        {value}
      </p>
      {sub && <p className="print-kpi-sub mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  )
}

function SectionHeading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3">
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
    case 'reach': return tr.cardRealReach
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
function countsOf(a: AudienceTotals): Record<AudienceBasis, number> {
  const c = (a as Partial<AudienceTotals>).countsByBasis
  return c && typeof c === 'object' ? { ...ZERO_COUNTS, ...c } : ZERO_COUNTS
}

function realPiecesOf(a: AudienceTotals): number {
  const n = (a as Partial<AudienceTotals>).realPieces
  if (typeof n === 'number') return n
  const c = countsOf(a)
  return c.reach + c.impressions + c.views
}

/** Real audience of one publication (reach → impressions → views); 0 when estimated or absent. */
function realAudienceOf(metrics: ReportMediaMetrics | null): number {
  return metrics && !metrics.audienceEstimated && metrics.audience > 0 ? metrics.audience : 0
}

/**
 * Column widths for `table-layout: fixed`. Weights of the visible columns are
 * normalised to percentages that sum to ≤ 100 %, so the table can never grow
 * past its container (the production defect: 1.100px tables in a 792px page).
 * Screen-only columns count too: in print they disappear and the remaining
 * columns share the freed width.
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

function ReportEditPanel({
  draft,
  tr,
  error,
  onChange,
}: {
  draft: ReportConfig
  tr: ReportStrings
  error: string | null
  onChange: (patch: Partial<ReportConfig>) => void
}) {
  const sections: Array<{ id: ReportSectionId; label: string }> = [
    { id: 'summary', label: tr.sectionSummary },
    { id: 'timeline', label: tr.sectionTimeline },
    { id: 'content', label: tr.sectionHighlights },
    { id: 'creators', label: tr.sectionCreators },
    { id: 'quality', label: tr.sectionQuality },
    { id: 'business', label: tr.sectionBusiness },
    { id: 'learnings', label: tr.sectionLearnings },
    { id: 'conclusions', label: tr.learningsDecisionsTitle },
    { id: 'annex', label: tr.sectionAnnex },
  ]
  const columns: Array<{ id: ReportColumnId; label: string }> = [
    { id: 'summary.views', label: tr.colSummaryViews },
    { id: 'summary.reach', label: tr.colSummaryRealReach },
    { id: 'summary.engagement', label: tr.colSummaryEngagement },
    { id: 'summary.er', label: tr.colSummaryEr },
    { id: 'summary.audience_estimated', label: tr.colSummaryAudienceEstimated },
    { id: 'content.views', label: tr.colContentViews },
    { id: 'content.reach', label: tr.colContentReach },
    { id: 'content.source', label: tr.colContentSource },
    { id: 'creators.posts', label: tr.colCreatorsPosts },
    { id: 'creators.er', label: tr.colCreatorsEr },
    { id: 'creators.followers', label: tr.colCreatorsFollowers },
    { id: 'creators.cpm', label: tr.colCreatorsCpm },
  ]

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
}

const PAGE = 100
/** Safety cap: 20 pages = 2000 posts. */
const MAX_PAGES = 20
/** Body: the publications with most real audience; the rest live in the annex. */
const HIGHLIGHT_COUNT = 6
/** Fewer dated days than this → a sentence instead of a chart. */
const MIN_CHART_DAYS = 3

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
  const [isLoading, setIsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Bumped after a config save so the server recomputes the report figures.
  const [reloadKey, setReloadKey] = useState(0)
  // Edit mode only: the unfiltered media/roster (no view=report) so the PM can
  // see and restore rows already hidden in the saved config.
  const [fullData, setFullData] = useState<{ media: ReportMedia[]; influencers: ReportMember[] } | null>(null)
  // True while the page is being printed (beforeprint / matchMedia('print')):
  // the chart switches to an explicit pixel size.
  const [printing, setPrinting] = useState(false)

  // Saved config vs. the draft being edited. `draft !== null` == edit mode.
  const [config, setConfig] = useState<ReportConfig>(EMPTY_CONFIG)
  const [draft, setDraft] = useState<ReportConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sentOpen, setSentOpen] = useState(false)
  const [sentNote, setSentNote] = useState('')
  const [marking, setMarking] = useState(false)
  const [sentError, setSentError] = useState<string | null>(null)

  // Brands never write: no edit affordances in portal mode (the API also
  // rejects BRAND writes with 403).
  const canEdit = !isPortal
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
        const viewParam = isPortal ? '' : '&view=report'
        let base: ReportCampaign | null = null
        let firstOverview: ReportOverview | null = null
        let firstLearnings: ReportLearnings | null = null
        let firstLearningsClient: ReportLearnings | null = null
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
    fetch(configUrl)
      .then(async res => {
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && data?.config) setConfig(normalizeClientConfig(data.config))
      })
      .catch(err => console.error('Error fetching report config:', err))
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

  // Print mode for the chart. beforeprint fires right before the browser lays
  // the page out for paper, so the state change is flushed synchronously
  // (flushSync) — a batched render would land after the pages were captured.
  // matchMedia('print') covers print preview and headless print emulation,
  // where beforeprint is not always fired.
  useEffect(() => {
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
  }, [])

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
  const showCostCol = !isPortal && showCol('creators.cpm') && report.creators.some(c => (c.p?.cost ?? 0) > 0)
  const showCpmCol = !isPortal && showCol('creators.cpm') && report.creators.some(c => typeof c.p?.cpm === 'number')
  const showCpmTotal = !isPortal && showCol('creators.cpm') && typeof totals?.cpm === 'number'

  // Rows the client sees (edit mode keeps hidden rows, muted, so they can be restored).
  // The API already excluded them from the figures; this is defense in depth.
  const visibleItems = editing ? report.sortedItems : report.sortedItems.filter(x => !x.hidden)
  const visibleCreators = editing ? report.creators : report.creators.filter(c => !c.hidden)
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
  const clientLearningsView = isPortal || printing
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

  // Audience counts (decision 4A) — labels and counts, never figures
  const counts = totals ? countsOf(totals.audience) : ZERO_COUNTS
  const realPieces = totals ? realPiecesOf(totals.audience) : 0
  const withoutRealData = totals ? Math.max(0, totals.media - realPieces) : 0
  const estimatedPosts = counts.estimated_post + counts.none
  const showEstimatedLine = !!totals && showCol('summary.audience_estimated') && totals.audience.estimated > 0
  // Publications with real views, counted from the rows the client sees. Not
  // countsByBasis.views: that is the number of pieces whose audience BASIS is
  // views (views but no reach/impressions), so a reel with reach AND views
  // would be missed. A count, never a figure.
  const realViewsCount = report.sortedItems.filter(x => !x.hidden && (x.media.views || 0) > 0).length
  // The audience basis of the real figure, per publication (counts by basis).
  const basisLine = locale === 'es'
    ? `Base de la audiencia real por publicación: alcance en ${fmtN(counts.reach)}, impresiones en ${fmtN(counts.impressions)} y solo vistas en ${fmtN(counts.views)}`
    : `Real audience basis per publication: reach for ${fmtN(counts.reach)}, impressions for ${fmtN(counts.impressions)} and views only for ${fmtN(counts.views)}`

  // Timeline: fewer than MIN_CHART_DAYS dated days → one sentence, no chart
  const timeline = overview?.timeline ?? []
  const timelineDates = timeline.map(p => reportDate(p.date, locale)).filter(Boolean)
  const timelineSentence = timelineDates.length === 0
    ? tr.timelineNoDates
    : fill(tr.timelineTooShort, { dates: timelineDates.join(locale === 'es' ? ' y ' : ' and ') })

  // Fixed-layout column widths (percentages that sum ≤ 100 %)
  const objW = columnWidths([['kpi', 40], ['target', 20], ['actual', 20], ['variation', 20]])
  const creatorsW = columnWidths([
    editing && ['toggle', 4],
    ['creator', 20],
    ['platform', 12],
    showCol('creators.posts') && ['posts', 6],
    showCol('creators.posts') && ['stories', 6],
    ['interactions', 9],
    ['audience', 11],
    showCol('creators.er') && ['er', 8],
    showCol('creators.followers') && ['followers', 9],
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

  const thBase = 'px-3 py-2.5 align-bottom whitespace-nowrap'
  const tdNum = 'px-3 py-2.5 text-right tabular-nums'

  return (
    <div id="campaign-report" className="space-y-6">
      {/* Print styles: hide app chrome, white page, keep the screen colours
          (print-color-adjust: exact) so the PDF looks like the screen. The
          light theme is forced by the beforeprint handler above. Layout is
          A4 portrait, 12mm margins: content ≈ 703px wide, nothing may overflow. */}
      <style>{`
        @media print {
          aside, header, .fixed, .no-print { display: none !important; }
          /* Undo the dashboard sidebar offset. The layout token is
             'lg:ml-[260px]', so the colon must be escaped for the
             selector to match on landscape / A3 sheets above the lg breakpoint. */
          div.ml-\\[260px\\], div.lg\\:ml-\\[260px\\] { margin-left: 0 !important; }
          main { padding: 0 !important; overflow: visible !important; max-width: none !important; }
          html, body { background: #ffffff !important; }
          #campaign-report { background: #ffffff; width: 100%; max-width: 100%; overflow-x: hidden; }
          #campaign-report, #campaign-report * {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          #campaign-report img { max-width: 100%; }
          #campaign-report section { break-inside: auto; }
          .print-card { break-inside: avoid; page-break-inside: avoid; box-shadow: none !important; min-width: 0; }
          /* Cover = page 1: fill the sheet (92vh leaves slack so it never
             spills into a blank page 2), then force a page break. */
          .print-cover {
            min-height: 92vh;
            break-after: page;
            page-break-after: always;
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            padding: 0 !important;
          }
          .print-break-before { break-before: page; page-break-before: always; }
          /* Card grids: always three columns that fit the sheet */
          .print-grid-3 { display: grid !important; grid-template-columns: repeat(3, minmax(0, 1fr)) !important; gap: 8px !important; }
          .print-kpi { padding: 10px 12px !important; overflow: hidden; }
          .print-kpi .print-kpi-label { font-size: 10px !important; }
          .print-kpi .print-kpi-value { font-size: 18px !important; line-height: 1.2 !important; margin-top: 4px !important; }
          .print-kpi .print-kpi-sub { font-size: 9px !important; line-height: 1.3 !important; }
          .print-pad { padding: 12px !important; }
          /* Tables: fixed layout so the column widths (≤ 100 %) are honoured,
             compact type, headers repeated on every page, rows never split. */
          .print-table-card { overflow: visible !important; box-shadow: none !important; }
          .print-table-wrap { overflow: visible !important; }
          .print-table { table-layout: fixed !important; width: 100% !important; font-size: 10px !important; }
          .print-table th, .print-table td {
            padding: 4px 6px !important;
            overflow-wrap: anywhere;
            word-break: break-word;
            vertical-align: middle;
          }
          .print-table thead { display: table-header-group; }
          .print-table tr { break-inside: avoid; page-break-inside: avoid; }
          .print-table .text-xs, .print-table .text-sm { font-size: 10px !important; }
          .print-table .text-\\[11px\\], .print-table .text-\\[10px\\] { font-size: 9px !important; }
          .print-clamp-1 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
          .print-text-xs { font-size: 10px !important; line-height: 1.35 !important; }
          /* Chart: rendered at an explicit ${PRINT_CHART_WIDTH}px; the viewBox lets it shrink if ever needed. */
          .print-chart { width: 100%; overflow: hidden; }
          .recharts-wrapper, .recharts-surface { max-width: 100% !important; }
          .recharts-tooltip-wrapper { display: none !important; }
          @page { size: A4 portrait; margin: 12mm; }
        }
      `}</style>

      {/* 0. Actions — screen only, never printed */}
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
              Volver
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
          <Button variant="primary" size="sm" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Exportar PDF
          </Button>
        </div>
      </div>

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
        <ReportEditPanel draft={draft} tr={tr} error={saveError} onChange={patchDraft} />
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
          className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-purple-200/40 blur-3xl print:hidden dark:bg-purple-700/15"
        />

        {/* Top: agency wordmark */}
        <div className="relative">
          <TkocLogo />
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
          {/* 2. Executive summary — REAL data first (decision 4A) */}
          {showSection('summary') && (
            <section>
              <SectionHeading>{tr.sectionSummary}</SectionHeading>
              {intro && (
                <p className="print-card print-text-xs mb-4 whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                  {intro}
                </p>
              )}
              <div className="print-grid-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
                    label={tr.cardRealReach}
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
                  totals.er.value !== null ? (
                    <StatCard
                      icon={TrendingUp}
                      label={tr.cardEr}
                      value={formatPct(totals.er.value, locale)}
                      sub={fill(tr.erRealBaseSub, { n: totals.er.pieces ?? realPieces })}
                    />
                  ) : (
                    <StatCard
                      icon={TrendingUp}
                      label={tr.cardEr}
                      value={totals.er.reason === 'insufficient_sample' || totals.er.reason === 'implausible' ? tr.erInsufficientSample : tr.erNoRealData}
                      sub={totals.er.reason === 'insufficient_sample' || totals.er.reason === 'implausible' ? fill(tr.erInsufficientHint, { n: totals.er.pieces ?? realPieces }) : tr.erNoRealHint}
                      muted
                    />
                  )
                )}
              </div>

              {/* ONE separate, informative line for the estimates: never mixed into a headline figure. */}
              {showEstimatedLine && (
                <div className="print-card print-text-xs mt-3 rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-4 py-2 text-[11px] leading-relaxed text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
                  <span className="font-medium text-gray-600 dark:text-gray-300">
                    {fill(tr.estimatedAudienceLine, { total: `~${fmtN(totals.audience.estimated)}`, stories: counts.estimated_story, posts: estimatedPosts })}
                  </span>
                  {' — '}
                  {tr.estimatedAudienceHint}
                </div>
              )}

              {/* Valor mediático equivalente: ONE figure for the client (extended), labelled as
                  an estimate. Ratio EMV (never "ROI") and the real CPM only in the agency view. */}
              {(totals.emvExtended > 0 || showCpmTotal) && (
                <div className="print-card print-pad mt-4 flex flex-wrap items-start justify-between gap-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  {totals.emvExtended > 0 && (
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                        <Coins className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
                        {tr.emvTitle}
                      </div>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatEur(totals.emvExtended, { locale })}
                      </p>
                      <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
                        {tr.emvDefinition}
                      </p>
                    </div>
                  )}
                  {!isPortal && totals.emvExtended > 0 && typeof totals.emvRatio === 'number' && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{tr.emvRatioLabel}</p>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatRatio(totals.emvRatio, { locale })}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{tr.emvRatioSub}</p>
                    </div>
                  )}
                  {showCpmTotal && typeof totals.cpm === 'number' && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{tr.cpmRealLabel}</p>
                      <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-100">
                        {formatEur(totals.cpm, { locale, maxFractionDigits: 2 })}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{tr.cpmRealSub}</p>
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
                    <table className="print-table w-full text-sm">
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
            </section>
          )}

          {/* 3. Timeline (Europe/Madrid days, from the overview). In print the
              chart gets an explicit width; with too few days, one sentence. */}
          {showSection('timeline') && (
            <section>
              <SectionHeading>{tr.sectionTimeline}</SectionHeading>
              <div className="print-card print-pad rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <h3 className="mb-4 text-sm font-semibold text-gray-700 dark:text-gray-300">
                  {tr.timelineTitle}
                </h3>
                {timeline.length >= MIN_CHART_DAYS ? (
                  <div className="print-chart">
                    <ReportAreaChart
                      data={timeline}
                      labels={{ engagements: tr.chartEngagements, posts: tr.chartPosts }}
                      locale={locale}
                      print={printing}
                    />
                  </div>
                ) : (
                  <p className="print-text-xs py-4 text-sm text-gray-500 dark:text-gray-400">
                    {timelineSentence}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* 4. Contenidos destacados — the pieces with REAL audience, most first, as
              cards (only rows with a real figure; the heading states how many).
              None with real data → one disclaimer; the complete list is the annex. */}
          {showSection('content') && (
            <section>
              <SectionHeading hint={highlightItems.length > 0 ? fill(tr.highlightsSub, { n: highlightItems.length }) : undefined}>
                {tr.sectionHighlights}
              </SectionHeading>
              {highlightItems.length === 0 ? (
                <p className="print-card rounded-xl border border-gray-200 bg-white px-5 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                  {tr.highlightsEmpty}
                </p>
              ) : (
                <>
                  <div className="print-grid-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                            <MediaThumb src={m.thumbnailUrl} alt={m.caption || 'Contenido'} size={64} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <p className={cn('truncate text-xs font-semibold', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-purple-600 dark:text-purple-400')}>
                                @{m.influencer?.username || 'desconocido'}
                              </p>
                              <Badge variant="default" className="px-2 py-0 text-[10px]">{mediaTypeLabel(m.mediaType)}</Badge>
                            </div>
                            <p className={cn('print-clamp-1 mt-0.5 line-clamp-1 text-[11px]', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300')}>
                              {m.caption || 'Sin descripción'}
                            </p>
                            <dl className={cn('mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')}>
                              {showCol('content.views') && (
                                <div className="flex items-baseline gap-1">
                                  <dt className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{tr.colViews}</dt>
                                  <dd className="font-semibold">{(m.views || 0) > 0 ? fmtN(m.views as number) : '—'}</dd>
                                </div>
                              )}
                              {showCol('content.reach') && metrics && !metrics.audienceEstimated && metrics.audience > 0 && metrics.audienceBasis !== 'views' && (
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
                  <table className="print-table w-full text-sm">
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
                        <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.interactions }}>{tr.colInteractions}</th>
                        <th className={cn(thBase, 'text-right')} style={{ width: creatorsW.audience }}>{tr.colRealReach}</th>
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
                            <td className={num}>{p ? fmtN(p.engagements) : '—'}</td>
                            <td className={num}>
                              {p && p.audience.real > 0 ? (
                                <>
                                  <span>{fmtN(p.audience.real)}</span>
                                  {showCol('summary.audience_estimated') && p.audience.estimated > 0 && (
                                    <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                      ~{fmtN(p.audience.estimated)} {tr.basisEstimated}
                                    </span>
                                  )}
                                </>
                              ) : p && showCol('summary.audience_estimated') && p.audience.estimated > 0 ? (
                                <>
                                  <span className="text-gray-400 dark:text-gray-500">—</span>
                                  <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                    ~{fmtN(p.audience.estimated)} {tr.basisEstimated}
                                  </span>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            {showCol('creators.er') && (
                              <td className={num}>
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
                <p>{tr.creatorsFootnote}</p>
                {report.hasBaseline && <p>{tr.baselineFootnote}</p>}
                {(showCostCol || showCpmCol) && <p>{tr.costFootnote}</p>}
              </div>
            </section>
          )}

          {/* 6. Datos: qué es real — counts per audience basis (decision 4A) */}
          {showSection('quality') && (
            <section>
              <SectionHeading>{tr.sectionQualityReal}</SectionHeading>
              <div className="print-card print-pad rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
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
                      <ul className="print-text-xs mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                        <li>{fill(tr.qualityRealViewsLine, { n: fmtN(realViewsCount) })}</li>
                        <li>{basisLine}</li>
                        <li>{fill(tr.qualityNoAudienceLine, { n: withoutRealData })}</li>
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
          <div className="print-grid-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
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
            {!isPortal && biz.cpa !== null && (
              <StatCard icon={Coins} label={tr.cpaLabel} value={formatEur(biz.cpa, { locale, maxFractionDigits: 2 })} sub={tr.cpaSubFull} />
            )}
            {!isPortal && biz.roas !== null && (
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
            <LearningCard icon={Lightbulb} title={tr.learningsInsightsTitle} className="print-pad mb-4">
              <ul className="space-y-2">
                {shownLearnings.insights.map((ins, i) => {
                  const internal = screenOnly(ins.text)
                  return (
                    <li key={i} className={cn('flex items-start gap-2 text-sm leading-relaxed text-gray-700 dark:text-gray-300 print-text-xs', internal && 'no-print print:hidden')}>
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

          <div className="print-grid-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Qué repetir */}
            <LearningCard icon={Repeat} title={tr.learningsRepeatTitle} className="print-pad">
              {shownLearnings.repeatList.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {shownLearnings.repeatList.map(u => (
                    <span key={u} className="inline-flex items-center rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700 dark:border-purple-800 dark:bg-purple-900/30 dark:text-purple-300">
                      @{u.replace(/^@/, '')}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 print-text-xs">{tr.learningsRepeatEmpty}</p>
              )}
              {shownLearnings.topPerformer && (
                <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                  <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
                    <Star className="h-3 w-3 shrink-0 text-amber-500" />
                    {tr.learningsTopPerformer}: <span className="normal-case text-gray-700 dark:text-gray-300">@{shownLearnings.topPerformer.username.replace(/^@/, '')}</span>
                  </p>
                  {shownLearnings.topPerformer.reason && (
                    <p className={cn('print-text-xs mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400', screenOnly(shownLearnings.topPerformer.reason) && 'no-print print:hidden')}>
                      {shownLearnings.topPerformer.reason}
                      {screenOnly(shownLearnings.topPerformer.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                </div>
              )}
            </LearningCard>

            {/* Formato ganador */}
            <LearningCard icon={Film} title={tr.learningsFormatTitle} className="print-pad">
              {shownLearnings.bestFormat ? (
                <>
                  <p className="text-lg font-bold text-gray-900 dark:text-gray-100">{mediaTypeLabel(shownLearnings.bestFormat.format)}</p>
                  {shownLearnings.bestFormat.reason && (
                    <p className={cn('print-text-xs mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400', screenOnly(shownLearnings.bestFormat.reason) && 'no-print print:hidden')}>
                      {shownLearnings.bestFormat.reason}
                      {screenOnly(shownLearnings.bestFormat.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                  {shownLearnings.worstFormat && (
                    <p className={cn('print-text-xs mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400', screenOnly(shownLearnings.worstFormat.reason) && 'no-print print:hidden')}>
                      <span className="font-semibold text-gray-600 dark:text-gray-300">{tr.learningsWorstFormat}: {mediaTypeLabel(shownLearnings.worstFormat.format)}.</span>{' '}
                      {shownLearnings.worstFormat.reason}
                      {screenOnly(shownLearnings.worstFormat.reason) && <ScreenOnlyBadge label={screenOnlyLabel} />}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 print-text-xs">{tr.learningsFormatEmpty}</p>
              )}
            </LearningCard>

            {/* Siguiente oleada. The staff text is rewritten for the client
                (no budget / fee wording): on screen the PM sees both. */}
            <LearningCard icon={ArrowRight} title={tr.learningsNextTitle} className="print-pad">
              <p className={cn('print-text-xs text-sm leading-relaxed text-gray-700 dark:text-gray-300', screenOnly(shownLearnings.nextCampaignRec) && 'no-print print:hidden')}>
                {shownLearnings.nextCampaignRec || '—'}
                {screenOnly(shownLearnings.nextCampaignRec) && <ScreenOnlyBadge label={screenOnlyLabel} />}
              </p>
              {screenOnly(shownLearnings.nextCampaignRec) && learningsClient?.nextCampaignRec && (
                <p className="print-text-xs mt-2 border-t border-gray-100 pt-2 text-xs leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">
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
            <LearningCard icon={ClipboardList} title={tr.learningsDecisionsTitle} className="print-pad mt-4">
              <p className="print-text-xs whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
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
          <div className="print-card print-pad rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="print-text-xs whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
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
              <table className="print-table w-full text-sm">
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
                    {showCol('content.reach') && <th className={cn(thBase, 'text-right')} style={{ width: annexW.reach }}>{tr.colRealReach}</th>}
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
                            <MediaThumb src={m.thumbnailUrl} alt={m.caption || 'Contenido'} size={28} />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="min-w-0">
                            <p className={cn('truncate text-xs font-medium', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-purple-600 dark:text-purple-400')}>
                              @{m.influencer?.username || 'desconocido'}
                            </p>
                            <p className={cn('print-clamp-1 line-clamp-1 text-[11px]', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300')}>
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
                                {metrics && metrics.audienceBasis !== 'views' && (
                                  <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                    {metrics.audienceBasis === 'impressions' ? tr.basisImpressions : tr.basisReach}
                                  </span>
                                )}
                              </>
                            ) : metrics && metrics.audienceEstimated && metrics.audience > 0 && showCol('summary.audience_estimated') ? (
                              <>
                                <span className="text-gray-400 dark:text-gray-500">—</span>
                                <span className="block text-[10px] text-gray-400 dark:text-gray-500">~{fmtN(metrics.audience)} {tr.basisEstimated}</span>
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
            {showCol('content.reach') && <p>{tr.audienceFootnote}</p>}
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
