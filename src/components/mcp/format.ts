/**
 * Dates of the card «Conexiones con Claude», in the house style: the date of
 * formatDate (Europe/Madrid) plus the time of day. Plain module, no React.
 */
import { formatDate, type EurLocale } from '@/lib/utils'

/** `HH:MM` in Europe/Madrid, or '' when the value is not a date. */
export function formatTimeOfDay(value: string | Date, locale: EurLocale): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** House date (formatDate, Europe/Madrid) plus the time of day. */
export function formatDateTime(value: string | Date, locale: EurLocale): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return formatDate(value, { locale })
  return `${formatDate(date, { locale })}, ${formatTimeOfDay(date, locale)}`
}
