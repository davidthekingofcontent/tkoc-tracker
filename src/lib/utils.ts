import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ============ ONE WAY TO FORMAT ============
// Spanish is the product default; English only when the UI toggle says so.
// Every number, amount, percentage and date shown to a person goes through one
// of the helpers below, driven by the UI locale (`useI18n().locale`); server
// code passes 'es'. Nothing is ever shown in dollars.

/** UI locale as exposed by useI18n(): Spanish by default, English on toggle. */
export type EurLocale = 'es' | 'en'

/** BCP-47 tag for Intl: Spain Spanish / British English (day-month order, "€"). */
function intlTag(locale: EurLocale): string {
  return locale === 'es' ? 'es-ES' : 'en-GB'
}

interface FormatNumberOptions {
  /** Decimal separator of the compact form: es → "1,5K" · en → "1.5K". Defaults to Spanish. */
  locale?: EurLocale
}

/**
 * Compact count with the K / M / B suffixes the UI uses everywhere.
 *   formatNumber(1500)                    → "1,5K"
 *   formatNumber(1500, { locale: 'en' })  → "1.5K"
 *   formatNumber(1000)                    → "1K"
 *   formatNumber(999)                     → "999"
 * Backwards compatible: the second argument is optional.
 */
export function formatNumber(num: number, opts: FormatNumberOptions = {}): string {
  const { locale = 'es' } = opts
  const tag = intlTag(locale)
  const n = Number.isFinite(num) ? num : 0
  const abs = Math.abs(n)
  const compact = (value: number, suffix: string) =>
    `${value.toLocaleString(tag, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}${suffix}`
  if (abs >= 1_000_000_000) return compact(n / 1_000_000_000, 'B')
  if (abs >= 1_000_000) return compact(n / 1_000_000, 'M')
  if (abs >= 1_000) return compact(n / 1_000, 'K')
  return n.toLocaleString(tag, { maximumFractionDigits: 2 })
}

// ============ EUROS & RATIOS (decision 9B) ============
// The platform has ONE currency, the euro. Nothing is ever shown in dollars.

interface FormatEurOptions {
  /** "8,5 K €" / "€8.5K" instead of the full amount (for KPI cards). */
  compact?: boolean
  /** es-ES → "12.345 €" · en-GB → "€12,345". Defaults to Spanish. */
  locale?: EurLocale
  /** Decimals of the full (non-compact) form; 0 by default, 2 for CPMs. */
  maxFractionDigits?: number
}

/** Intl's compact magnitude tokens ("mil", "k", "m", "bn") normalised to the K / M / B the rest of the UI uses. */
const COMPACT_SUFFIX: Record<string, string> = {
  mil: 'K', k: 'K', K: 'K',
  m: 'M', M: 'M',
  bn: 'B', B: 'B', 'mil M': 'B',
}

/**
 * Formats an amount in euros.
 *   formatEur(8500)                                  → "8500 €"   (es-ES omits the separator below 10.000)
 *   formatEur(12345, { locale: 'en' })               → "€12,345"
 *   formatEur(8500, { compact: true })               → "8,5 K €"
 *   formatEur(8500, { compact: true, locale: 'en' }) → "€8.5K"
 *   formatEur(12.5, { maxFractionDigits: 2 })        → "12,5 €"
 * Non-finite input renders as 0 € rather than "NaN €".
 */
export function formatEur(value: number, opts: FormatEurOptions = {}): string {
  const { compact = false, locale = 'es', maxFractionDigits = 0 } = opts
  const tag = intlTag(locale)
  const amount = Number.isFinite(value) ? value : 0

  if (compact && Math.abs(amount) >= 1000) {
    // Intl's compact notation already places the currency and spaces correctly per
    // locale ("8,5 mil €" / "€8.5k"); only the magnitude token is swapped for K / M / B.
    return new Intl.NumberFormat(tag, { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 })
      .formatToParts(amount)
      .map(part => (part.type === 'compact' ? COMPACT_SUFFIX[part.value] ?? part.value : part.value))
      .join('')
  }

  return new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  }).format(amount)
}

interface FormatRatioOptions {
  locale?: EurLocale
  /** Decimals shown; 1 by default ("×2,4"). */
  digits?: number
}

/**
 * A "times" multiple such as the Ratio EMV (EMV ÷ cost): "×2,4" (es) / "2.4×" (en).
 * Never a percentage and never called ROI — EMV is an equivalence estimate, not revenue.
 */
export function formatRatio(value: number, opts: FormatRatioOptions = {}): string {
  const { locale = 'es', digits = 1 } = opts
  const tag = intlTag(locale)
  const n = (Number.isFinite(value) ? value : 0).toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return locale === 'es' ? `×${n}` : `${n}×`
}

/**
 * @deprecated The USD formatter is gone; this is an EUR alias kept so old callers compile.
 * Use formatEur(value, { locale }) instead.
 */
export function formatCurrency(amount: number): string {
  return formatEur(amount)
}

// ============ PERCENTAGES ============

interface FormatPercentOptions {
  /** Decimals shown; 2 by default ("3,25 %"). Use 1 for creator ERs, 0 for shares. */
  digits?: number
  locale?: EurLocale
}

/**
 * A percentage that is ALREADY in percent units (3.25 means 3,25 %).
 *   formatPercent(3.25)                    → "3,25 %"   (es: space before the sign, as the RAE writes it)
 *   formatPercent(3.25, { locale: 'en' })  → "3.25%"
 *   formatPercent(null)                    → "—"        (a datum not filled in is not shown as 0)
 * The space in Spanish is non-breaking so the figure never splits across lines.
 */
export function formatPercent(value: number | null | undefined, opts: FormatPercentOptions = {}): string {
  const { digits = 2, locale = 'es' } = opts
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const n = value.toLocaleString(intlTag(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return locale === 'es' ? `${n} %` : `${n}%`
}

// ============ DATES (Europe/Madrid — the day PMs and clients live in) ============

interface FormatDateOptions {
  locale?: EurLocale
  /** 'short' → "5 sept 2026" / "5 Sept 2026" · 'long' → "5 de septiembre de 2026" / "5 September 2026". */
  style?: 'short' | 'long'
}

/**
 * Formats an instant as a calendar day in Europe/Madrid.
 *   formatDate('2026-09-05T10:00:00Z')                          → "5 sept 2026"
 *   formatDate(date, { locale: 'en' })                          → "5 Sept 2026"
 *   formatDate(date, { style: 'long' })                         → "5 de septiembre de 2026"
 *   formatDate(null) / formatDate('not a date')                 → "—"
 * Backwards compatible with the old one-argument call.
 */
export function formatDate(value: Date | string | number | null | undefined, opts: FormatDateOptions = {}): string {
  const { locale = 'es', style = 'short' } = opts
  if (value === null || value === undefined || value === '') return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(intlTag(locale), {
    timeZone: 'Europe/Madrid',
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  }).format(d)
}

// ============ LEGACY CALCULATIONS ============

export function calculateEngagementRate(
  likes: number,
  comments: number,
  followers: number
): number {
  if (followers === 0) return 0
  return ((likes + comments) / followers) * 100
}

export function calculateMediaValue(
  impressions: number,
  engagementRate: number
): number {
  // Rough EMV calculation based on industry standards
  // Base CPM of 5 €, adjusted by engagement rate multiplier
  const baseCPM = 5
  const engagementMultiplier = 1 + engagementRate / 100
  return (impressions / 1000) * baseCPM * engagementMultiplier
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
