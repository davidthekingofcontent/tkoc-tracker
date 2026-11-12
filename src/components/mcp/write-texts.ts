/**
 * Texts of the write layer of the Claude connector: the three lines of the
 * consent screen that describe what Claude can do with the new scope, and the
 * confirmation page of a pending action (/mcp/confirmar/[id]).
 *
 * They live in src/i18n/translations.ts under `mcp.write` (Spanish first,
 * English kept in step: every key exists in both). This module only hands
 * them to the components that render outside the i18n context (the server
 * pages) under one name, so the consent screen, the confirmation page and the
 * card in Ajustes always say the same thing.
 *
 * Placeholders `{name}`, `{owner}`, `{time}`, `{minutes}` and `{date}` are
 * filled by the components with fillText (a function replacement: literal text).
 */
import { translations, type Locale } from '@/i18n/translations'

export const MCP_WRITE_TEXTS: Record<Locale, (typeof translations)['es']['mcp']['write']> = {
  es: translations.es.mcp.write,
  en: translations.en.mcp.write,
}

/**
 * Fills every `{placeholder}` of a text. The replacement goes through a
 * function, so `$&`, `$1` and the like inside an untrusted value stay literal.
 */
export function fillText(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole))
}
