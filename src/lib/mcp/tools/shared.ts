/**
 * What every tool of the MCP connector shares: the shape of a tool, the input
 * pieces (ids, dates, limits), the list envelope that says when it was cut
 * and the text the call log may keep of the arguments.
 *
 * Pure module: no database, no network. Safe to import from unit tests.
 *
 * Rules that hold for every tool (see the spec's "Hard rules"):
 *  - read-only: a tool never writes to the platform's data;
 *  - a tool never spreads a database row into its answer. Rows go through the
 *    serializers of ./serializers.ts, which copy named fields one by one;
 *  - every list is capped (LIST_DEFAULT_LIMIT, at most LIST_MAX_LIMIT) and its
 *    envelope says how many rows exist and whether it was cut;
 *  - the call log keeps ids, handles, flags and limits. Never free text.
 */
import { z } from 'zod'
import { ARGS_SUMMARY_MAX_CHARS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from '../config'

// ============ The shape of a tool ============

/** Who a tool call acts for: the grant that carried the token and its administrator. */
export interface ToolCaller {
  grantId: string
  userId: string
}

/**
 * A failure whose message may be shown to the model as it is (campaign not
 * found, a date that is not a date). Anything else that a tool throws is
 * answered with a generic sentence, so no database detail ever leaves.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** What the call log may keep of the arguments: short scalars only. */
export type ArgsSummary = Record<string, string | number | boolean | null | undefined>

/** A tool as it is written in its own file. */
export interface ToolDefinition<Shape extends z.ZodRawShape> {
  /** At most 64 characters, snake_case. */
  name: string
  /** Shown to the person in Claude. Spanish, short. */
  title: string
  /** Written for the model: what it returns, when to use it, its limits. */
  description: string
  input: Shape
  /** Ids, handles, flags and limits of this call for the log. Never free text. */
  summarize(args: z.infer<z.ZodObject<Shape>>): ArgsSummary
  /** The answer: a plain object built only from serializers. Throw ToolError for an expected failure. */
  run(args: z.infer<z.ZodObject<Shape>>, caller: ToolCaller): Promise<unknown>
}

/** A tool as the server registers it (the argument types are erased). */
export interface McpTool {
  name: string
  title: string
  description: string
  input: z.ZodRawShape
  /**
   * Validates the arguments (again: the SDK already did) and returns what the
   * log may keep of them plus the function that produces the answer.
   * Throws ToolError when the arguments are not valid.
   */
  prepare(rawArgs: unknown): { summary: string; run(caller: ToolCaller): Promise<unknown> }
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): McpTool {
  const schema = z.object(def.input)
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    input: def.input,
    prepare(rawArgs: unknown) {
      const parsed = schema.safeParse(rawArgs ?? {})
      if (!parsed.success) throw new ToolError(`Invalid arguments for ${def.name}`)
      const args = parsed.data as z.infer<z.ZodObject<Shape>>
      return {
        summary: formatArgsSummary(def.summarize(args)),
        run: (caller: ToolCaller) => def.run(args, caller),
      }
    },
  }
}

// ============ Input pieces ============

/** A database id (cuid): letters, digits, `_` and `-`. Nothing else ever reaches a query. */
export const idInput = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'must be an id made of letters, digits, _ or -')
    .describe(what)

/** `limit` of every list: 1 to LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT when absent. */
export const limitInput = z
  .number()
  .int()
  .min(1)
  .max(LIST_MAX_LIMIT)
  .optional()
  .describe(`Maximum number of rows to return (default ${LIST_DEFAULT_LIMIT}, at most ${LIST_MAX_LIMIT}).`)

/** `includeEconomics`: the only way to get fees, costs and estimates. */
export const economicsInput = z
  .boolean()
  .optional()
  .describe(
    'Set to true only when the person explicitly asks for money figures. Adds the internal agency figures (fee, cost, CPM, budget) and the estimates (EMV, estimated audience), all labelled as internal. Default false.',
  )

/** A calendar day, `YYYY-MM-DD`. */
export const dayInput = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date written as YYYY-MM-DD')
    .refine(v => parseDay(v) !== null, 'is not a real date')
    .describe(what)

export const PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const
export const platformInput = (what: string) => z.enum(PLATFORMS).describe(what)

/** Midnight UTC of a `YYYY-MM-DD` day, or null when it is not a real date. */
export function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d
}

/** The start of the day after, UTC: the exclusive end of a day given as `until`. */
export function dayAfter(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1))
}

/**
 * A creator handle as typed by a person or a model: `@marta.fit`, `Marta.Fit `.
 * Returns it without the `@` and without spaces, or null when what is left is
 * not a handle (so it is never used in a query nor written to the log).
 */
export function cleanHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const handle = value.trim().replace(/^@+/, '').trim()
  return /^[A-Za-z0-9._-]{1,60}$/.test(handle) ? handle : null
}

// ============ Dates in the answers ============

/** Full instant, ISO 8601 UTC, or null. */
export function isoInstant(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** The UTC day of an instant, `YYYY-MM-DD`, or null. Campaign dates are stored as UTC days. */
export function isoDay(value: Date | string | null | undefined): string | null {
  const iso = isoInstant(value)
  return iso ? iso.slice(0, 10) : null
}

// ============ Lists ============

/** The number of rows a list returns for a requested `limit`. */
export function clampLimit(limit: number | null | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return LIST_DEFAULT_LIMIT
  return Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

/**
 * Ceiling of the serialized rows of one list, in characters. Claude Code
 * cuts tool results above 25,000 tokens by default and claude.ai above about
 * 150,000 characters. Rows dense in ids, links, timestamps and counters
 * (list_campaign_media) come to about 2.5 characters per token, so 40,000
 * characters is about 16,000 tokens: under both, with room for the rest of
 * the answer. Over it, the envelope says the list was cut.
 */
export const LIST_MAX_CHARS = 40_000

export interface ListEnvelope<T> {
  /** Rows in this answer. */
  returned: number
  /** Rows that exist for this question. */
  total: number
  /** true when `items` is not the whole list. */
  truncated: boolean
  /** Why it was cut and how to see the rest. Only present when truncated. */
  truncation?: string
  items: T[]
}

/**
 * The envelope of every list. `rows` are the rows already limited by the
 * query, `total` the rows that exist. It also cuts by size: rows are dropped
 * from the end until the list fits LIST_MAX_CHARS. `narrowWith` tells the
 * model how to ask for less (the filters of that tool).
 */
export function listEnvelope<T>(rows: T[], total: number, limit: number, narrowWith: string): ListEnvelope<T> {
  let items = rows.slice(0, clampLimit(limit))
  let size = 0
  let fits = items.length
  for (let i = 0; i < items.length; i++) {
    size += JSON.stringify(items[i]).length + 1
    if (size > LIST_MAX_CHARS) {
      fits = i
      break
    }
  }
  const cutBySize = fits < items.length
  if (cutBySize) items = items.slice(0, Math.max(1, fits))
  const known = Math.max(total, items.length)
  const truncated = items.length < known
  return {
    returned: items.length,
    total: known,
    truncated,
    ...(truncated
      ? {
          truncation: `Showing ${items.length} of ${known}${cutBySize ? ' (cut to keep the answer small)' : ''}. ${narrowWith}`,
        }
      : {}),
    items,
  }
}

// ============ The call log ============

/** Control characters and line breaks never reach the log. */
function plain(value: string, max: number): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * `key=value` pairs of a call for `McpCallLog.argsSummary`, at most
 * ARGS_SUMMARY_MAX_CHARS characters. Absent values are left out.
 */
export function formatArgsSummary(summary: ArgsSummary): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(summary)) {
    if (value === undefined || value === null || value === '') continue
    const text = typeof value === 'string' ? plain(value, 80) : String(value)
    if (text) parts.push(`${plain(key, 40)}=${text}`)
  }
  return parts.join(' ').slice(0, ARGS_SUMMARY_MAX_CHARS)
}

/**
 * A handle as the call log may keep it, `@handle`, or null. Only a value that
 * is a handle AND has a letter in it: a run of digits typed into a search is
 * as likely to be a phone number as a handle, and the log keeps no personal
 * data beyond ids and handles.
 */
export function loggableHandle(value: unknown): string | null {
  const handle = cleanHandle(value)
  return handle && /[A-Za-z]/.test(handle) ? `@${handle}` : null
}

/**
 * How a free-text search is written to the log: as the handle it is when it
 * looks like one, otherwise only its length (a name or a number typed by a
 * person is personal data and the log keeps none).
 */
export function summarizeQuery(query: string): string {
  return loggableHandle(query) ?? `(text, ${query.trim().length} chars)`
}

/**
 * How a `handle` or `creator` argument is written to the log: `@handle`, or
 * only what kind of text it was. undefined when it was not given.
 */
export function summarizeHandleArg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return loggableHandle(value) ?? (cleanHandle(value) ? '(digits only)' : '(not a handle)')
}

// ============ Text that travels in an answer ============

/**
 * Short text typed by people on the platform (a campaign name, a brand name,
 * an alert): control and direction-override characters removed, length capped.
 * It is data for the model, never instructions.
 */
export function shortText(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const text = plain(value.normalize('NFC'), max)
  return text || null
}

/** A finite number, or null. */
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A list of short texts (handles, hashtags): only strings, capped in length and number. */
export function shortTexts(values: unknown, maxItems = 50, maxChars = 80): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  for (const v of values) {
    const text = shortText(v, maxChars)
    if (text) out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}
