'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar } from '@/components/ui/avatar'
import { cn, formatNumber, formatEur, formatRatio, formatDate } from '@/lib/utils'
import { proxyImg } from '@/lib/proxy-image'
import type { BaselineComparison } from '@/lib/creator-baseline'
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

/** 'YYYY-MM-DD' (Europe/Madrid day key) → local Date on that calendar day. */
function dayKeyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

const ReportAreaChart = dynamic(
  () => import('recharts').then(mod => {
    const { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = mod
    return function ChartWrapper({ data, labels, locale }: { data: TimelinePoint[]; labels: ChartLabels; locale: Locale }) {
      return (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
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
                shared helper renders it in that zone and in the UI locale. */}
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
            <Legend wrapperStyle={{ fontSize: '11px' }} />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="engagements"
              name={labels.engagements}
              stroke="#7c3aed"
              strokeWidth={2}
              fill="url(#grad_report_engagement)"
            />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="posts"
              name={labels.posts}
              stroke="#a78bfa"
              strokeWidth={2}
              fill="url(#grad_report_posts)"
            />
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

function SourceBadge({ source }: { source?: string | null }) {
  if (source === 'meta_api') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400">
        <ShieldCheck className="h-3 w-3" />
        Meta
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300">
      Público
    </span>
  )
}

/** Decision 7B: a post the creator removed after publishing stays, marked. */
function DeletedBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-400">
      <Trash2 className="h-3 w-3" />
      {label}
    </span>
  )
}

/** Edit-mode marker on rows the client will not see. */
function HiddenBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
      <EyeOff className="h-3 w-3" />
      {label}
    </span>
  )
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

function MediaThumb({ src, alt }: { src?: string | null; alt: string }) {
  const [error, setError] = useState(false)
  const url = src ? proxyImg(src) : ''
  if (!url || error) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800">
        <ImageIcon className="h-5 w-5 text-gray-400" />
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="h-12 w-12 shrink-0 rounded-lg object-cover"
      onError={() => setError(true)}
    />
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
      className={`block h-8 w-72 max-w-full object-cover object-center ${className}`}
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
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="print-card rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
        <Icon className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{sub}</p>}
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {children}
    </h2>
  )
}

function mediaTypeLabel(type?: string | null): string {
  switch ((type || '').toUpperCase()) {
    case 'REEL': return 'Reel'
    case 'VIDEO': return 'Vídeo'
    case 'IMAGE': return 'Imagen'
    case 'PHOTO': return 'Imagen'
    case 'CAROUSEL':
    case 'SIDECAR': return 'Carrusel'
    case 'STORY': return 'Story'
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

/** Whole-number share for the "estimated X %" sub-labels (0–1 → 0–100). */
function sharePct(share: number): number {
  return Math.round((Number.isFinite(share) ? share : 0) * 100)
}

function kpiLabel(key: TargetKey, tr: ReportStrings): string {
  switch (key) {
    case 'views': return tr.kpiViews
    case 'reach': return tr.kpiReach
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

function basisLabel(basis: AudienceBasis, tr: ReportStrings): string {
  switch (basis) {
    case 'reach': return tr.basisReach
    case 'impressions': return tr.basisImpressions
    case 'views': return tr.basisViews
    default: return tr.basisEstimated
  }
}

/** Stable key for a roster member: Influencer id (agency: influencerId; portal: influencer.id). */
function memberKey(ci: ReportMember): string {
  return ci.influencerId || ci.influencer?.id || ''
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
    { id: 'content', label: tr.sectionContent },
    { id: 'creators', label: tr.sectionCreators },
    { id: 'quality', label: tr.sectionQuality },
    { id: 'business', label: tr.sectionBusiness },
    { id: 'conclusions', label: tr.sectionConclusions },
  ]
  const columns: Array<{ id: ReportColumnId; label: string }> = [
    { id: 'summary.views', label: tr.colSummaryViews },
    { id: 'summary.engagement', label: tr.colSummaryEngagement },
    { id: 'summary.er', label: tr.colSummaryEr },
    { id: 'summary.reach', label: tr.colSummaryReach },
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
          <label className="mb-1.5 block text-xs font-medium text-gray-700 dark:text-gray-300">{tr.conclusionsLabel}</label>
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

interface MediaItem {
  media: ReportMedia
  /** overview.perMedia entry (or the row's own `metrics`); null for rows outside the report */
  metrics: ReportMediaMetrics | null
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
  const [isLoading, setIsLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Bumped after a config save so the server recomputes the report figures.
  const [reloadKey, setReloadKey] = useState(0)
  // Edit mode only: the unfiltered media/roster (no view=report) so the PM can
  // see and restore rows already hidden in the saved config.
  const [fullData, setFullData] = useState<{ media: ReportMedia[]; influencers: ReportMember[] } | null>(null)

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

  // Campaign + overview. The agency asks for the report view (hidden rows out
  // of every figure and of the media list); the portal API always behaves so.
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
            inlineConfig = data.reportConfig
          }
          const pageMedia: ReportMedia[] = data.campaign.media || []
          allMedia = allMedia.concat(pageMedia)
          if (pageMedia.length < PAGE) break
        }

        if (!cancelled && base) {
          setCampaign({ ...base, media: allMedia })
          setOverview(firstOverview)
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
      return { media: m, metrics, creatorKey, hiddenById, hiddenByCreator, hidden: hiddenById || hiddenByCreator }
    })
    // Sorted by interacciones DESC (hidden rows kept for edit mode)
    const sortedItems = [...allItems].sort((a, b) => (b.metrics?.engagements ?? 0) - (a.metrics?.engagements ?? 0))
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

    // Data quality: how many publications had their audience estimated (labels, not figures)
    const perMedia = overview?.perMedia ?? []
    const estimatedStories = perMedia.filter(p => p.audienceBasis === 'estimated_story').length
    const postsWithoutData = perMedia.filter(p => p.audienceBasis === 'estimated_post' || p.audienceBasis === 'none').length

    return { sortedItems, hiddenMediaCount, hiddenCreatorCount, creators, hasBaseline, estimatedStories, postsWithoutData }
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

  // Rows the client sees (edit mode keeps hidden rows, muted, so they can be restored).
  // The API already excluded them from the figures; this is defense in depth.
  const visibleItems = editing ? report.sortedItems : report.sortedItems.filter(x => !x.hidden)
  const visibleCreators = editing ? report.creators : report.creators.filter(c => !c.hidden)

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
  const showConclusions = conclusions.length > 0 && showSection('conclusions')

  const audienceCardSub = (a: AudienceTotals): string =>
    a.total > 0 && a.estimatedShare > 0
      ? fill(tr.audienceMixSub, { real: fmtN(a.real), estimated: fmtN(a.estimated), pct: sharePct(a.estimatedShare) })
      : tr.audienceRealSub

  return (
    <div id="campaign-report" className="space-y-6">
      {/* Print styles: hide app chrome, white page, keep the screen colours
          (print-color-adjust: exact) so the PDF looks like the screen. The
          light theme is forced by the beforeprint handler above. */}
      <style>{`
        @media print {
          aside, header, .fixed, .no-print { display: none !important; }
          /* Undo the dashboard sidebar offset. The layout token is
             'lg:ml-[260px]', so the colon must be escaped for the
             selector to match on landscape / A3 sheets above the lg breakpoint. */
          div.ml-\\[260px\\], div.lg\\:ml-\\[260px\\] { margin-left: 0 !important; }
          main { padding: 0 !important; overflow: visible !important; }
          html, body { background: #ffffff !important; }
          #campaign-report { background: #ffffff; }
          #campaign-report, #campaign-report * {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          .print-card { break-inside: avoid; page-break-inside: avoid; box-shadow: none !important; }
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
          /* Recharts sizes itself to the screen; let the SVG shrink to the
             page (it carries a viewBox) and never print a floating tooltip. */
          .recharts-wrapper, .recharts-surface { max-width: 100% !important; height: auto !important; }
          .recharts-tooltip-wrapper { display: none !important; }
          @page { margin: 12mm; }
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
        <div>
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
          {/* 2. Executive summary */}
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
                  <StatCard icon={Eye} label={tr.cardViews} value={totals.views > 0 ? fmtN(totals.views) : '—'} />
                )}
                {showCol('summary.reach') && (
                  <StatCard
                    icon={BarChart3}
                    label={tr.cardAudience}
                    value={totals.audience.total > 0 ? fmtN(totals.audience.total) : '—'}
                    sub={totals.audience.total > 0 ? audienceCardSub(totals.audience) : undefined}
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
                  <StatCard
                    icon={TrendingUp}
                    label={tr.cardEr}
                    value={totals.er.value !== null ? formatPct(totals.er.value, locale) : '—'}
                    sub={
                      totals.er.value === null
                        ? undefined
                        : totals.er.estimatedShare > 0
                          ? fill(tr.erSub, { pct: sharePct(totals.er.estimatedShare) })
                          : tr.erSubReal
                    }
                  />
                )}
              </div>

              {/* Valor mediático equivalente: ONE figure for the client (extended), labelled as
                  an estimate. Ratio EMV (never "ROI") only in the agency view. */}
              {totals.emvExtended > 0 && (
                <div className="print-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                      <Coins className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                      {tr.emvTitle}
                    </div>
                    <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
                      {formatEur(totals.emvExtended, { locale })}
                    </p>
                    <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
                      {tr.emvDefinition}
                    </p>
                  </div>
                  {!isPortal && typeof totals.emvRatio === 'number' && (
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{tr.emvRatioLabel}</p>
                      <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
                        {formatRatio(totals.emvRatio, { locale })}
                      </p>
                      <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{tr.emvRatioSub}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Objectives vs results (decision 1B) — only the targets the PM filled in */}
              {targetRows.length > 0 && (
                <div className="print-card mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                  <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <Target className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                    {tr.objectivesTitle}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                          <th className="px-4 py-2.5">{tr.objKpi}</th>
                          <th className="px-4 py-2.5 text-right">{tr.objTarget}</th>
                          <th className="px-4 py-2.5 text-right">{tr.objActual}</th>
                          <th className="px-4 py-2.5 text-right">{tr.objVariation}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {targetRows.map(tg => (
                          <tr key={tg.key} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                            <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-gray-100">{kpiLabel(tg.key, tr)}</td>
                            <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300">
                              {formatTargetValue(tg.key, tg.target, locale)}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-700 dark:text-gray-300">
                              {tg.actual !== null ? formatTargetValue(tg.key, tg.actual, locale) : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <span className="inline-flex items-center justify-end gap-2">
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

          {/* 3. Timeline (Europe/Madrid days, from the overview) */}
          {showSection('timeline') && (
            <section>
              <SectionHeading>{tr.sectionTimeline}</SectionHeading>
              <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <h3 className="mb-4 text-sm font-semibold text-gray-700 dark:text-gray-300">
                  {tr.timelineTitle}
                </h3>
                {(overview?.timeline.length ?? 0) > 0 ? (
                  <ReportAreaChart
                    data={overview?.timeline ?? []}
                    labels={{ engagements: tr.chartEngagements, posts: tr.chartPosts }}
                    locale={locale}
                  />
                ) : (
                  <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
                    Sin fechas de publicación disponibles
                  </p>
                )}
              </div>
            </section>
          )}

          {/* 4. Content table */}
          {showSection('content') && (
            <section>
              <SectionHeading>{tr.sectionContent}</SectionHeading>
              <div className="print-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        {editing && (
                          <th className="no-print px-3 py-3 print:hidden" title={tr.hideFromClient}>
                            <EyeOff className="h-3.5 w-3.5" />
                          </th>
                        )}
                        <th className="px-4 py-3">Contenido</th>
                        <th className="px-4 py-3">Tipo</th>
                        <th className="px-4 py-3 text-right">Likes</th>
                        <th className="px-4 py-3 text-right">Comentarios</th>
                        <th className="px-4 py-3 text-right">{tr.colInteractions}</th>
                        {showCol('content.views') && <th className="px-4 py-3 text-right">Vistas</th>}
                        {showCol('content.reach') && <th className="px-4 py-3 text-right">{tr.colAudience}</th>}
                        {showCol('content.source') && <th className="px-4 py-3">Fuente</th>}
                        <th className="no-print px-4 py-3 print:hidden">Link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map(({ media: m, metrics, hidden, hiddenById, hiddenByCreator }) => {
                        const deleted = m.isDeleted === true || metrics?.isDeleted === true
                        const cell = cn('px-4 py-3 text-right', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')
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
                              <td className="no-print px-3 py-3 print:hidden">
                                <RowVisibilityToggle
                                  hidden={hiddenById || hiddenByCreator}
                                  disabled={hiddenByCreator && !hiddenById}
                                  title={hidden ? tr.showRow : tr.hideRow}
                                  onToggle={() => patchDraft({ hiddenMediaIds: toggleId(draft?.hiddenMediaIds || [], m.id) })}
                                />
                              </td>
                            )}
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <div className={deleted ? 'opacity-50 grayscale' : ''}>
                                  <MediaThumb src={m.thumbnailUrl} alt={m.caption || 'Contenido'} />
                                </div>
                                <div className="min-w-0 max-w-xs">
                                  <p className={cn('line-clamp-2 text-xs', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300')}>
                                    {m.caption || 'Sin descripción'}
                                  </p>
                                  <p className={cn('mt-0.5 text-xs font-medium', deleted ? 'text-gray-400 dark:text-gray-500' : 'text-purple-600 dark:text-purple-400')}>
                                    @{m.influencer?.username || 'desconocido'}
                                  </p>
                                  {(deleted || hidden) && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {deleted && <DeletedBadge label={tr.deletedBadge} />}
                                      {hidden && <HiddenBadge label={tr.hiddenRow} />}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <Badge variant="default">{mediaTypeLabel(m.mediaType)}</Badge>
                            </td>
                            <td className={cell}>{fmtN(m.likes || 0)}</td>
                            <td className={cell}>{fmtN(m.comments || 0)}</td>
                            <td className={cell}>{metrics ? fmtN(metrics.engagements) : '—'}</td>
                            {showCol('content.views') && (
                              <td className={cell}>{m.views ? fmtN(m.views) : '—'}</td>
                            )}
                            {showCol('content.reach') && (
                              <td className={cell}>
                                {metrics && metrics.audience > 0 ? (
                                  <>
                                    <span>{metrics.audienceEstimated ? '~' : ''}{fmtN(metrics.audience)}</span>
                                    <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                      {basisLabel(metrics.audienceBasis, tr)}
                                    </span>
                                  </>
                                ) : (
                                  '—'
                                )}
                              </td>
                            )}
                            {showCol('content.source') && (
                              <td className="px-4 py-3">
                                <SourceBadge source={m.source} />
                              </td>
                            )}
                            <td className="no-print px-4 py-3 print:hidden">
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
                {totals.mediaDeleted > 0 && (
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

          {/* 5. Per-creator performance (overview.perInfluencer) */}
          {showSection('creators') && visibleCreators.length > 0 && (
            <section>
              <SectionHeading>{tr.sectionCreators}</SectionHeading>
              <div className="print-card overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        {editing && (
                          <th className="no-print px-3 py-3 print:hidden" title={tr.hideFromClient}>
                            <EyeOff className="h-3.5 w-3.5" />
                          </th>
                        )}
                        <th className="px-4 py-3">Creador</th>
                        <th className="px-4 py-3">Plataforma</th>
                        {showCol('creators.posts') && <th className="px-4 py-3 text-right">Posts</th>}
                        {showCol('creators.posts') && <th className="px-4 py-3 text-right">{tr.colStories}</th>}
                        <th className="px-4 py-3 text-right">{tr.colInteractions}</th>
                        <th className="px-4 py-3 text-right">{tr.colAudience}</th>
                        {showCol('creators.er') && <th className="px-4 py-3 text-right">ER</th>}
                        {showCol('creators.followers') && <th className="px-4 py-3 text-right">Seguidores</th>}
                        {report.hasBaseline && <th className="px-4 py-3 text-right">{tr.colBaseline}</th>}
                        {showCostCol && <th className="px-4 py-3 text-right">{tr.colCost}</th>}
                        {showCpmCol && <th className="px-4 py-3 text-right">{tr.colCpm}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleCreators.map((c, idx) => {
                        const p = c.p
                        const num = 'px-4 py-3 text-right text-gray-700 dark:text-gray-300'
                        return (
                          <tr
                            key={c.key || idx}
                            className={cn(
                              'border-b border-gray-100 last:border-0 dark:border-gray-800',
                              c.hidden && 'no-print bg-amber-50/40 opacity-60 print:hidden dark:bg-amber-900/10'
                            )}
                          >
                            {editing && (
                              <td className="no-print px-3 py-3 print:hidden">
                                <RowVisibilityToggle
                                  hidden={c.hidden}
                                  disabled={!c.key}
                                  title={c.hidden ? tr.showRow : tr.hideRow}
                                  onToggle={() => patchDraft({ hiddenInfluencerIds: toggleId(draft?.hiddenInfluencerIds || [], c.key) })}
                                />
                              </td>
                            )}
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-3">
                                <Avatar
                                  src={c.inf.avatarUrl}
                                  name={c.inf.displayName || c.inf.username || '?'}
                                  size="sm"
                                />
                                <div>
                                  <p className="font-medium text-gray-900 dark:text-gray-100">
                                    @{c.inf.username || '—'}
                                  </p>
                                  {c.inf.displayName && (
                                    <p className="text-xs text-gray-500 dark:text-gray-400">{c.inf.displayName}</p>
                                  )}
                                  {c.hidden && (
                                    <div className="mt-1" title={p ? undefined : tr.hiddenCreatorNoFigures}>
                                      <HiddenBadge label={tr.hiddenRow} />
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3">
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
                              {p && p.audience.total > 0 ? (
                                <>
                                  <span>{fmtN(p.audience.total)}</span>
                                  {p.audience.estimated > 0 && (
                                    <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                      {fill(tr.creatorAudienceSub, { real: fmtN(p.audience.real), estimated: fmtN(p.audience.estimated) })}
                                    </span>
                                  )}
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            {showCol('creators.er') && (
                              <td className={num}>
                                {p && p.er.value !== null ? (
                                  <>
                                    <span>{formatPct(p.er.value, locale)}</span>
                                    {p.er.estimatedShare > 0 && (
                                      <span className="block text-[10px] text-gray-400 dark:text-gray-500">
                                        {fill(tr.creatorErEstimatedSub, { pct: sharePct(p.er.estimatedShare) })}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  '—'
                                )}
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
                {report.hasBaseline && <p>{tr.baselineFootnote}</p>}
                {(showCostCol || showCpmCol) && <p>{tr.costFootnote}</p>}
              </div>
            </section>
          )}

          {/* 6. Data quality — real vs estimated share of the audience base */}
          {showSection('quality') && (
            <section>
              <SectionHeading>{tr.sectionQuality}</SectionHeading>
              <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
                {(() => {
                  const estPct = totals.audience.total > 0 ? sharePct(totals.audience.estimatedShare) : 0
                  const realPct = totals.audience.total > 0 ? 100 - estPct : 0
                  return (
                    <>
                      <div className="mb-2 flex items-center justify-between text-xs font-medium">
                        <span className="text-green-700 dark:text-green-400">
                          {tr.qualityRealLegend}: {formatPct(realPct, locale, 0)}
                        </span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {tr.qualityEstimatedLegend}: {formatPct(estPct, locale, 0)}
                        </span>
                      </div>
                      <div className="flex h-4 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                        {realPct > 0 && <div className="h-full bg-green-500" style={{ width: `${realPct}%` }} />}
                        {estPct > 0 && <div className="h-full bg-gray-400 dark:bg-gray-500" style={{ width: `${estPct}%` }} />}
                      </div>
                      <ul className="mt-3 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                        <li>{fill(tr.qualityRealLine, { pct: realPct })}</li>
                        <li>{fill(tr.qualityEstimatedLine, { pct: estPct, stories: report.estimatedStories, posts: report.postsWithoutData })}</li>
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

      {/* 8. Conclusions and next steps — only when the PM wrote them */}
      {showConclusions && (
        <section>
          <SectionHeading>{tr.conclusionsTitle}</SectionHeading>
          <div className="print-card rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700 dark:text-gray-300">
              {conclusions}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
