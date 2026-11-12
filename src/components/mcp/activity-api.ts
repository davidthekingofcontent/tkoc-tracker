/**
 * The activity part of the card «Conexiones con Claude»: what Claude did
 * through the connector and the actions waiting for a confirmation.
 *
 * Plain module (no React, no 'use client'): it is the contract between the
 * route GET /api/oauth/activity and the card. The route builds its answer
 * with classifyCall and cardPreview; the card reads it with toActivity, which
 * keeps only the fields listed here. Testable without a browser or a database.
 *
 *   GET /api/oauth/activity    ADMIN session, from the `token` cookie only
 *     200 { pending: PendingActionRow[], calls: ActivityCall[] }
 *         calls: the last ACTIVITY_CALLS_LIMIT rows of McpCallLog, of every
 *         connection, newest first.
 *         pending: actions of live connections that wait for the
 *         administrator ('pending') or for Claude ('approved'), not expired,
 *         the viewer's own first. Only the viewer's own carry the link and
 *         the preview: only the administrator who authorised the connection
 *         may confirm (src/lib/mcp/confirm.ts).
 *     401 no session    403 not an administrator
 *
 * Nothing here ever carries a token, an argument or an answer of a tool: only
 * names, tool names, results and dates. User names are text typed by people:
 * the card renders them as text nodes only.
 */
export const ACTIVITY_ENDPOINT = '/api/oauth/activity'

/** How many calls the card lists. */
export const ACTIVITY_CALLS_LIMIT = 50
/** How many waiting actions the card lists at most. */
export const ACTIVITY_PENDING_LIMIT = 20
/** Longest preview the card shows; the confirmation page has the whole text. */
export const CARD_PREVIEW_MAX_CHARS = 600
/**
 * A write call opens its log line ('started') before anything runs and
 * completes it at the end. A platform call gives up after 200 seconds, so a
 * line still open after 10 minutes belongs to a run that never finished
 * (the server restarted in the middle). What it changed, if anything, is unknown.
 */
export const STARTED_STALE_MS = 10 * 60_000

/** How a call ended, as the card says it. */
export type CallResult =
  | 'read' // a read tool answered
  | 'done' // a write ran
  | 'preview' // it showed a preview in the chat and waited for a yes (money, bulk)
  | 'approval' // it created an action to confirm in the platform (destructive, outbound)
  | 'refused' // not done: no access, a limit of the day, Apify blocked, not confirmed yet...
  | 'failed' // the tool or the platform failed
  | 'limited' // over the per-connection call limit
  | 'invalid' // arguments not valid, or an unknown tool
  | 'running' // still running
  | 'unfinished' // a write that never completed its log line

export const CALL_RESULTS: readonly CallResult[] = [
  'read',
  'done',
  'preview',
  'approval',
  'refused',
  'failed',
  'limited',
  'invalid',
  'running',
  'unfinished',
]

/** Confirmation class of a write call (src/lib/mcp/confirm.ts). */
export type CallConfirmation = 'none' | 'bulk' | 'money' | 'client' | 'destructive' | 'outbound'
const CONFIRMATIONS: readonly CallConfirmation[] = ['none', 'bulk', 'money', 'client', 'destructive', 'outbound']

export type ApprovalKind = 'destructive' | 'outbound'

/** One line of the activity: one tool call. */
export interface ActivityCall {
  id: string
  /** ISO date of the call. */
  at: string
  /** Tool name (snake_case, at most 64 characters). */
  tool: string
  kind: 'read' | 'write'
  result: CallResult
  /** Write calls only: the confirmation class of that call. */
  confirmation: CallConfirmation | null
  /** Write calls only: HTTP status of the last platform call, or null. */
  httpStatus: number | null
  /** The administrator of the connection. null when the account no longer exists. */
  userName: string | null
}

/** One action waiting: for the administrator ('pending') or for Claude to run it ('approved'). */
export interface PendingActionRow {
  id: string
  tool: string
  confirmation: ApprovalKind
  status: 'pending' | 'approved'
  /** ISO dates. */
  createdAt: string
  expiresAt: string
  /** The administrator who authorised the connection that asked for it: the only one who may decide. */
  ownerName: string | null
  /** true when it belongs to the administrator who is looking. */
  mine: boolean
  /** Own pending actions only: the confirmation page, as a same-site path. */
  approvePath: string | null
  /** Own actions only: what it will do, cut to CARD_PREVIEW_MAX_CHARS, e-mails masked. */
  preview: string | null
}

export interface Activity {
  pending: PendingActionRow[]
  calls: ActivityCall[]
}

// ============ Reading a log line (used by the route) ============

/**
 * Prefix the write helper puts on every write line (src/lib/mcp/write-tool.ts):
 * `[class:step http=200,404] key=value ...`. The class is `-` when the call
 * stopped before it was known.
 */
const WRITE_PREFIX_RE = /^\[(none|bulk|money|destructive|outbound|-):(invalid|limited|refused|preview|approval|read|execute|failed)(?: http=([0-9a-z,]{1,120}))?\]/

export interface CallClassification {
  kind: 'read' | 'write'
  result: CallResult
  confirmation: CallConfirmation | null
  httpStatus: number | null
}

/**
 * What a row of McpCallLog says about how the call ended. Read lines carry
 * plain `key=value` pairs, or the two fixed sentences of the server for a
 * call that did not run; write lines carry the prefix above, or `started`
 * while they run.
 */
export function classifyCall(argsSummary: string, ok: boolean, createdAt: Date, now: Date = new Date()): CallClassification {
  const summary = typeof argsSummary === 'string' ? argsSummary : ''

  if (summary === 'started') {
    const stale = now.getTime() - createdAt.getTime() > STARTED_STALE_MS
    return { kind: 'write', result: stale ? 'unfinished' : 'running', confirmation: null, httpStatus: null }
  }

  const m = WRITE_PREFIX_RE.exec(summary)
  if (m) {
    const confirmation = m[1] === '-' ? null : (m[1] as CallConfirmation)
    const statuses = (m[3] ?? '').split(',').filter(Boolean)
    const last = statuses.length > 0 ? statuses[statuses.length - 1] : ''
    const httpStatus = /^\d{3}$/.test(last) ? Number(last) : null
    const step = m[2]
    let result: CallResult
    switch (step) {
      case 'execute':
        result = ok ? 'done' : 'failed'
        break
      case 'read':
        // A write tool's call that changed nothing (a platform_request GET): «Consulta», never «Hecho»
        result = ok ? 'read' : 'failed'
        break
      case 'preview':
        result = ok ? 'preview' : 'refused'
        break
      case 'approval':
        result = ok ? 'approval' : 'refused'
        break
      case 'failed':
        result = 'failed'
        break
      case 'limited':
        result = 'limited'
        break
      case 'invalid':
        result = 'invalid'
        break
      default:
        result = 'refused'
    }
    return { kind: 'write', result, confirmation, httpStatus }
  }

  // A read tool (src/lib/mcp/server.ts)
  if (ok) return { kind: 'read', result: 'read', confirmation: null, httpStatus: null }
  if (summary.startsWith('not run: rate limit')) return { kind: 'read', result: 'limited', confirmation: null, httpStatus: null }
  if (summary.startsWith('not run: unknown tool or invalid arguments')) return { kind: 'read', result: 'invalid', confirmation: null, httpStatus: null }
  return { kind: 'read', result: 'failed', confirmation: null, httpStatus: null }
}

/** Control and direction characters out, spaces folded, cut with an ellipsis. */
export function cardPreview(text: string, max: number = CARD_PREVIEW_MAX_CHARS): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

// ============ Reading the answer (used by the card) ============

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TOOL_RE = /^[A-Za-z0-9_.-]{1,64}$/
/** What src/lib/mcp/server.ts logs for a call to a tool whose name is not one (loggableToolName). */
export const INVALID_TOOL_NAME = '(invalid name)'
/** A tool name as the call log keeps it: a real name, or the fixed label of an invalid one. */
export const isToolName = (value: string): boolean => TOOL_RE.test(value) || value === INVALID_TOOL_NAME
/** The only links the card ever renders: the confirmation page of an action. */
const APPROVE_PATH_RE = /^\/mcp\/confirmar\/[A-Za-z0-9_-]{1,64}$/

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)
const isoDate = (value: unknown): string | null => {
  const s = text(value)
  return s && !Number.isNaN(new Date(s).getTime()) ? s : null
}
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null

function toCall(item: unknown): ActivityCall | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const id = text(row.id)
  const at = isoDate(row.at)
  const tool = text(row.tool)
  const result = oneOf(row.result, CALL_RESULTS)
  if (!id || !ID_RE.test(id) || !at || !tool || !isToolName(tool) || !result) return null
  const status = row.httpStatus
  return {
    id,
    at,
    tool,
    kind: row.kind === 'write' ? 'write' : 'read',
    result,
    confirmation: oneOf(row.confirmation, CONFIRMATIONS),
    httpStatus: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    userName: text(row.userName),
  }
}

function toPending(item: unknown): PendingActionRow | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const id = text(row.id)
  const tool = text(row.tool)
  const confirmation = oneOf(row.confirmation, ['destructive', 'outbound'] as const)
  const status = oneOf(row.status, ['pending', 'approved'] as const)
  const createdAt = isoDate(row.createdAt)
  const expiresAt = isoDate(row.expiresAt)
  if (!id || !ID_RE.test(id) || !tool || !TOOL_RE.test(tool) || !confirmation || !status || !createdAt || !expiresAt) return null
  const mine = row.mine === true
  const path = text(row.approvePath)
  return {
    id,
    tool,
    confirmation,
    status,
    createdAt,
    expiresAt,
    ownerName: text(row.ownerName),
    mine,
    // A link only to the confirmation page of THIS action, and only for the viewer's own pending ones
    approvePath: mine && status === 'pending' && path && APPROVE_PATH_RE.test(path) && path.endsWith(`/${id}`) ? path : null,
    preview: mine ? text(row.preview) : null,
  }
}

/**
 * The answer of the route as the card shows it, or null when it is not one
 * (an error object, a login page). Malformed rows are dropped, unknown fields
 * never reach the page.
 */
export function toActivity(data: unknown): Activity | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const body = data as { pending?: unknown; calls?: unknown }
  if (!Array.isArray(body.pending) || !Array.isArray(body.calls)) return null
  const pending: PendingActionRow[] = []
  for (const item of body.pending.slice(0, ACTIVITY_PENDING_LIMIT)) {
    const row = toPending(item)
    if (row) pending.push(row)
  }
  const calls: ActivityCall[] = []
  for (const item of body.calls.slice(0, ACTIVITY_CALLS_LIMIT)) {
    const row = toCall(item)
    if (row) calls.push(row)
  }
  return { pending, calls }
}

type Fetch = typeof fetch

/** The activity, or null when it could not be loaded (network, no session, not an administrator). */
export async function loadActivity(fetchImpl: Fetch = fetch): Promise<Activity | null> {
  try {
    const res = await fetchImpl(ACTIVITY_ENDPOINT, { cache: 'no-store' })
    if (!res.ok) return null
    return toActivity(await res.json())
  } catch {
    return null
  }
}
