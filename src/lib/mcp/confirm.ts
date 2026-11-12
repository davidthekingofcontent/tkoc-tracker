/**
 * Confirmations of the write layer of the MCP connector: the two-step
 * confirm token (money, bulk) and the pending action approved in the
 * platform (destructive, outbound). Enforced by the SERVER: no argument a
 * model sends can skip them.
 *
 * ============================== CONTRACT ==============================
 *
 * Classes (ConfirmationClass): 'none' | 'bulk' | 'money' | 'destructive' | 'outbound'.
 * write-tool.ts applies them; a tool only says which class a call is.
 *
 * 1. money and bulk: TWO-STEP TOKEN, confirmed by the person in the chat.
 *    signConfirmToken({ tool, args, grantId, confirmation?, fingerprint? }) → { token, expiresAt }
 *      HMAC-SHA256 (key derived from JWT_SECRET, own label) over: tool name,
 *      SHA-256 of canonicalJson(args), grant id, the class of the call (a token
 *      of a free 'bulk' preview never redeems a 'money' call), optional
 *      fingerprint of the state the preview described, expiry (5 minutes) and
 *      a random nonce.
 *    verifyConfirmToken(token, binding) → ok | malformed | signature | expired | mismatch
 *      `mismatch`: same token, other tool, other arguments (ANY change),
 *      other grant, other class or other state. Nothing runs; the caller shows
 *      a new preview.
 *    redeemConfirmToken(token, binding + { userId, confirmation, preview })
 *      → verify + single use: inserts an McpPendingAction of kind 'token'
 *      (status 'executed') under the unique SHA-256 of the token. A second
 *      redemption answers `used`. Redeem BEFORE executing: a failed or
 *      timed-out run consumes the token too.
 *
 * 2. destructive and outbound: PENDING ACTION, confirmed by a human in the
 *    platform, outside the model.
 *    createPendingAction({ grantId, userId, tool, confirmation, args, preview, fingerprint? })
 *      → { id, approveUrl, expiresAt }   status 'pending', 15 minutes.
 *      `args` are stored as canonical JSON: they are what will run.
 *      `stateHash` = stateDigest(confirmation, fingerprint): before the run the
 *      tool plans the stored arguments again, and a run whose class or state
 *      differs from what the administrator approved is refused
 *      (src/lib/mcp/write-tool.ts).
 *    decidePendingAction({ id, deciderId, decision: 'approve' | 'deny' })
 *      → POST /api/mcp/actions/[id] calls it after checking the ADMIN session
 *      and the CSRF token (signDecisionToken / verifyDecisionToken).
 *    claimApprovedAction({ id, grantId, tool }) → { ok, args } | refusal
 *      Atomic 'approved' → 'executed': the action runs AT MOST ONCE, only from
 *      the grant that asked for it, only through the same tool, only before
 *      it expires, and with the STORED arguments (whatever the second call sent).
 *    recordActionResult(id, httpStatus) after the run.
 *    reviewPendingAction(id, viewerId) → what /mcp/confirmar/[id] shows.
 *
 * WHO MAY CONFIRM (decided 12 Nov 2026): ONLY the administrator who
 * authorised the grant that asked for the action (McpPendingAction.userId,
 * which is McpGrant.userId), while he or she is still an active ADMIN and
 * the grant is still live. Another administrator, even an active one, sees
 * whose action it is and cannot confirm or cancel it; an EMPLOYEE cannot
 * even open the page. Reason: the confirmation is the human check of ONE
 * person's conversation with Claude. If any admin could approve, a request
 * planted in a caption or a bio could be approved by a colleague who never
 * saw that conversation, and the check would mean nothing.
 *
 * States: pending → approved → executed, pending → denied, pending|approved
 * → expired (15 minutes after creation, for the decision AND the run).
 * ======================================================================
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { APP_URL, MCP_RESOURCE } from './config'
import { sha256Hex, signConsentToken, verifyConsentToken } from './crypto'

// ============ Classes and lifetimes ============

export type ConfirmationClass = 'none' | 'bulk' | 'money' | 'destructive' | 'outbound'
export const CONFIRMATION_CLASSES: readonly ConfirmationClass[] = ['none', 'bulk', 'money', 'destructive', 'outbound']
/** Confirmed in the chat with a two-step token. */
export type TokenClass = 'money' | 'bulk'
/** Confirmed in the platform by the administrator. */
export type ApprovalClass = 'destructive' | 'outbound'

export const isTokenClass = (c: ConfirmationClass): c is TokenClass => c === 'money' || c === 'bulk'
export const isApprovalClass = (c: ConfirmationClass): c is ApprovalClass => c === 'destructive' || c === 'outbound'

/** A confirm token works for 5 minutes. */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60_000
/** A pending action can be confirmed AND run within 15 minutes of its creation. */
export const PENDING_ACTION_TTL_MS = 15 * 60_000
/** Longest preview stored or shown. */
export const PREVIEW_MAX_CHARS = 4_000

export type PendingActionStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'expired'

// ============ Canonical arguments ============

/**
 * JSON with the keys of every object sorted, `undefined` left out and
 * nothing else changed: two argument objects that mean the same produce the
 * same text, and any real difference (a value, a key, the order of an array)
 * produces another. Throws on values JSON cannot carry faithfully
 * (non-finite numbers, bigints, functions, cycles).
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): string => {
    if (v === null) return 'null'
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v)
      case 'boolean':
        return v ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(v)) throw new Error('canonicalJson: non-finite number')
        return JSON.stringify(v)
      case 'object':
        break
      default:
        throw new Error(`canonicalJson: cannot encode a ${typeof v}`)
    }
    if (v instanceof Date) return JSON.stringify(v.toISOString())
    const obj = v as object
    if (seen.has(obj)) throw new Error('canonicalJson: cycle')
    seen.add(obj)
    try {
      if (Array.isArray(obj)) return `[${obj.map(item => (item === undefined ? 'null' : walk(item))).join(',')}]`
      const entries = Object.entries(obj as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, child]) => `${JSON.stringify(k)}:${walk(child)}`).join(',')}}`
    } finally {
      seen.delete(obj)
    }
  }
  return walk(value)
}

/** SHA-256 (hex) of the canonical JSON of some arguments. */
export function argsDigest(args: unknown): string {
  return sha256Hex(canonicalJson(args))
}

// ============ Confirm token (money, bulk) ============

/** What a confirm token is bound to. */
export interface ConfirmBinding {
  tool: string
  /** The validated arguments of the call, WITHOUT confirmToken and actionId. */
  args: unknown
  grantId: string
  /** Optional summary of the state the preview described (counts, current values). A change makes the token stale. */
  fingerprint?: string | null
  /** The class of the call the preview was for. A token of one class never redeems a call of another. */
  confirmation?: TokenClass | null
}

export type ConfirmTokenCheck =
  | { ok: true; expiresAt: Date }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' }

const CONFIRM_VERSION = 'c1'
const CONFIRM_MAX_CHARS = 1024

function confirmKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is not set: confirm tokens cannot be signed')
  return createHmac('sha256', secret).update('tkoc-mcp-confirm-token-v1').digest()
}

function confirmSignature(body: string): Buffer {
  return createHmac('sha256', confirmKey()).update(body, 'utf8').digest()
}

function bindingFields(b: ConfirmBinding) {
  return { t: b.tool, g: b.grantId, a: argsDigest(b.args), c: b.confirmation ?? '', f: b.fingerprint ? sha256Hex(b.fingerprint) : '' }
}

/**
 * The token returned with a preview of a money or bulk call. Valid 5 minutes,
 * for this tool, these exact arguments, this grant and (when given) this state.
 */
export function signConfirmToken(binding: ConfirmBinding, nowMs: number = Date.now()): { token: string; expiresAt: Date } {
  const exp = nowMs + CONFIRM_TOKEN_TTL_MS
  const payload = { ...bindingFields(binding), e: exp, n: randomBytes(12).toString('base64url') }
  const body = `${CONFIRM_VERSION}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  return { token: `${body}.${confirmSignature(body).toString('base64url')}`, expiresAt: new Date(exp) }
}

/** Signature first (constant time), then expiry, then the binding. */
export function verifyConfirmToken(token: unknown, binding: ConfirmBinding, nowMs: number = Date.now()): ConfirmTokenCheck {
  if (typeof token !== 'string' || token.length === 0 || token.length > CONFIRM_MAX_CHARS) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== CONFIRM_VERSION || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' }
  const given = Buffer.from(parts[2], 'base64url')
  if (given.toString('base64url') !== parts[2]) return { ok: false, reason: 'malformed' }
  const expected = confirmSignature(`${parts[0]}.${parts[1]}`)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' }

  let p: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'malformed' }
    p = parsed as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof p.e !== 'number' || !Number.isFinite(p.e)) return { ok: false, reason: 'malformed' }
  if (p.e <= nowMs) return { ok: false, reason: 'expired' }

  const want = bindingFields(binding)
  const same = (a: unknown, b: string) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  if (!same(p.t, want.t) || !same(p.g, want.g) || !same(p.a, want.a) || !same(p.c, want.c) || !same(p.f, want.f)) {
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true, expiresAt: new Date(p.e) }
}

export type RedeemResult =
  | { ok: true; recordId: string }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' | 'used' }

export interface RedeemInput extends ConfirmBinding {
  /** The administrator of the grant. */
  userId: string
  confirmation: TokenClass
  /** The preview of this call, kept for the record. */
  preview: string
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * Verifies the token and spends it, atomically: the unique hash of the token
 * lets ONE redemption through. Call it right before executing; whatever
 * happens after, the token is gone.
 */
export async function redeemConfirmToken(token: unknown, input: RedeemInput, now: Date = new Date()): Promise<RedeemResult> {
  const check = verifyConfirmToken(token, input, now.getTime())
  if (!check.ok) return check
  try {
    const row = await prisma.mcpPendingAction.create({
      data: {
        kind: 'token',
        confirmation: input.confirmation,
        grantId: input.grantId,
        userId: input.userId,
        tool: input.tool.slice(0, 64),
        argsJson: canonicalJson(input.args),
        preview: input.preview.slice(0, PREVIEW_MAX_CHARS),
        status: 'executed',
        decidedAt: now,
        expiresAt: check.expiresAt,
        executedAt: now,
        tokenHash: sha256Hex(token as string),
      },
      select: { id: true },
    })
    return { ok: true, recordId: row.id }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'used' }
    throw err
  }
}

// ============ Pending actions (destructive, outbound) ============

const ACTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Shape check of an action id before any lookup. */
export function isActionId(value: unknown): value is string {
  return typeof value === 'string' && ACTION_ID_RE.test(value)
}

/**
 * What an approval is bound to besides its arguments: the class of the call
 * and the state its preview described (the tool's fingerprint). SHA-256, hex.
 * The run plans the stored arguments again and compares: a different class
 * or state means the administrator approved something else.
 */
export function stateDigest(confirmation: ConfirmationClass, fingerprint: string | null | undefined): string {
  return sha256Hex(`tkoc-mcp-approval-state-v1|${confirmation}|${fingerprint ?? ''}`)
}

/** The page where the administrator confirms or cancels. Built from APP_URL, never from a request. */
export function approveUrlFor(id: string): string {
  return `${APP_URL}/mcp/confirmar/${encodeURIComponent(id)}`
}

export interface PendingActionInput {
  grantId: string
  /** The administrator who authorised the grant: the only one who may confirm. */
  userId: string
  tool: string
  confirmation: ApprovalClass
  /** The validated arguments, WITHOUT confirmToken and actionId. Stored: they are what will run. */
  args: unknown
  /** Plain Spanish: exactly what will happen. */
  preview: string
  /** The state the preview described (the plan's fingerprint). Stored as stateDigest(confirmation, fingerprint). */
  fingerprint?: string | null
}

/** Creates the action, waiting for the administrator. Nothing runs here. */
export async function createPendingAction(
  input: PendingActionInput,
  now: Date = new Date(),
): Promise<{ id: string; approveUrl: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + PENDING_ACTION_TTL_MS)
  const row = await prisma.mcpPendingAction.create({
    data: {
      kind: 'approval',
      confirmation: input.confirmation,
      grantId: input.grantId,
      userId: input.userId,
      tool: input.tool.slice(0, 64),
      argsJson: canonicalJson(input.args),
      preview: input.preview.slice(0, PREVIEW_MAX_CHARS),
      status: 'pending',
      createdAt: now,
      expiresAt,
      stateHash: stateDigest(input.confirmation, input.fingerprint),
    },
    select: { id: true },
  })
  return { id: row.id, approveUrl: approveUrlFor(row.id), expiresAt }
}

/** Marks as expired what is still pending or approved after its deadline. Returns how many. */
export async function expireStaleActions(now: Date = new Date()): Promise<number> {
  const r = await prisma.mcpPendingAction.updateMany({
    where: { kind: 'approval', status: { in: ['pending', 'approved'] }, expiresAt: { lte: now } },
    data: { status: 'expired' },
  })
  return r.count
}

async function expireOne(id: string, now: Date): Promise<void> {
  await prisma.mcpPendingAction.updateMany({
    where: { id, status: { in: ['pending', 'approved'] }, expiresAt: { lte: now } },
    data: { status: 'expired' },
  })
}

/** An active ADMIN in the database, or null. */
async function liveAdmin(userId: string): Promise<{ id: string; name: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isActive: true } })
  return user && user.isActive && user.role === 'ADMIN' ? { id: user.id, name: user.name } : null
}

async function grantIsLive(grantId: string, userId: string): Promise<boolean> {
  const grant = await prisma.mcpGrant.findUnique({ where: { id: grantId }, select: { userId: true, revokedAt: true } })
  return !!grant && !grant.revokedAt && grant.userId === userId
}

export type DecisionRefusal =
  | 'not_found' // no such approval action
  | 'not_admin' // the decider is not an active ADMIN
  | 'foreign' // the action belongs to another administrator's grant
  | 'expired'
  | 'already_decided' // approved, denied or executed before
  | 'connection_closed' // the grant that asked for it was revoked: it can no longer run

export type DecisionResult =
  | { ok: true; status: 'approved' | 'denied' }
  | { ok: false; reason: DecisionRefusal; status?: PendingActionStatus }

/**
 * «Confirmar» / «Cancelar» from the platform. The route checked the session
 * and the CSRF token; everything is checked again here against the database:
 * the decider is an active ADMIN AND the very administrator who authorised
 * the grant; the action is pending and alive; to approve, the grant must
 * still be live. One transition only (pending → approved | denied).
 */
export async function decidePendingAction(
  input: { id: string; deciderId: string; decision: 'approve' | 'deny' },
  now: Date = new Date(),
): Promise<DecisionResult> {
  if (!isActionId(input.id)) return { ok: false, reason: 'not_found' }
  const row = await prisma.mcpPendingAction.findUnique({ where: { id: input.id } })
  if (!row || row.kind !== 'approval') return { ok: false, reason: 'not_found' }
  const decider = await liveAdmin(input.deciderId)
  if (!decider) return { ok: false, reason: 'not_admin' }
  if (row.userId !== decider.id) return { ok: false, reason: 'foreign' }
  if (row.status !== 'pending') {
    if (row.status === 'approved' && row.expiresAt.getTime() <= now.getTime()) {
      await expireOne(row.id, now)
      return { ok: false, reason: 'expired', status: 'expired' }
    }
    return { ok: false, reason: row.status === 'expired' ? 'expired' : 'already_decided', status: row.status as PendingActionStatus }
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    await expireOne(row.id, now)
    return { ok: false, reason: 'expired', status: 'expired' }
  }
  if (input.decision === 'approve' && !(await grantIsLive(row.grantId, row.userId))) {
    return { ok: false, reason: 'connection_closed', status: 'pending' }
  }
  const status = input.decision === 'approve' ? 'approved' : 'denied'
  const moved = await prisma.mcpPendingAction.updateMany({
    where: { id: row.id, kind: 'approval', status: 'pending', expiresAt: { gt: now } },
    data: { status, decidedAt: now, decidedById: decider.id },
  })
  if (moved.count !== 1) {
    const current = await prisma.mcpPendingAction.findUnique({ where: { id: row.id }, select: { status: true } })
    const s = (current?.status ?? 'expired') as PendingActionStatus
    return { ok: false, reason: s === 'expired' ? 'expired' : 'already_decided', status: s }
  }
  return { ok: true, status }
}

export type ClaimRefusal =
  | 'not_found' // no such action for THIS grant
  | 'other_tool' // it belongs to another tool
  | 'pending' // nobody has confirmed it yet
  | 'denied'
  | 'executed' // it already ran: it never runs twice
  | 'expired'

export type ClaimResult =
  | { ok: true; id: string; args: unknown; confirmation: ApprovalClass }
  | { ok: false; reason: ClaimRefusal; tool?: string; approveUrl?: string; expiresAt?: Date }

/**
 * The second call of the model, with `actionId`. Atomically moves an
 * APPROVED action of THIS grant and THIS tool to 'executed' and returns the
 * STORED arguments. Exactly one caller can win; a pending, denied, expired or
 * already executed action never runs.
 */
export async function claimApprovedAction(
  input: { id: string; grantId: string; tool: string },
  now: Date = new Date(),
): Promise<ClaimResult> {
  if (!isActionId(input.id)) return { ok: false, reason: 'not_found' }
  const row = await prisma.mcpPendingAction.findUnique({ where: { id: input.id } })
  if (!row || row.kind !== 'approval' || row.grantId !== input.grantId) return { ok: false, reason: 'not_found' }
  if (row.tool !== input.tool) return { ok: false, reason: 'other_tool', tool: row.tool }
  const alive = row.expiresAt.getTime() > now.getTime()
  if ((row.status === 'pending' || row.status === 'approved') && !alive) {
    await expireOne(row.id, now)
    return { ok: false, reason: 'expired' }
  }
  if (row.status === 'pending') return { ok: false, reason: 'pending', approveUrl: approveUrlFor(row.id), expiresAt: row.expiresAt }
  if (row.status === 'denied' || row.status === 'executed' || row.status === 'expired') return { ok: false, reason: row.status }
  // Approved: only by the administrator of the grant (decidePendingAction guarantees it; checked again)
  if (row.status !== 'approved' || row.decidedById !== row.userId) return { ok: false, reason: 'not_found' }

  const claimed = await prisma.mcpPendingAction.updateMany({
    where: { id: row.id, kind: 'approval', grantId: input.grantId, tool: input.tool, status: 'approved', expiresAt: { gt: now } },
    data: { status: 'executed', executedAt: now },
  })
  if (claimed.count !== 1) {
    const current = await prisma.mcpPendingAction.findUnique({ where: { id: row.id }, select: { status: true } })
    return { ok: false, reason: current?.status === 'expired' ? 'expired' : 'executed' }
  }
  return { ok: true, id: row.id, args: JSON.parse(row.argsJson) as unknown, confirmation: row.confirmation as ApprovalClass }
}

/** The HTTP status of the platform call that ran an action (0: no answer). Never fails the caller. */
export async function recordActionResult(id: string, resultStatus: number): Promise<void> {
  await prisma.mcpPendingAction
    .updateMany({ where: { id }, data: { resultStatus: Math.max(0, Math.min(999, Math.round(resultStatus))) } })
    .catch(() => {})
}

/**
 * How many actions of a class this grant RAN since `since` (daily caps:
 * paid actions; outbound actions, counted per tool when `tool` is given).
 */
export async function countExecutedSince(input: {
  grantId: string
  confirmation: TokenClass | ApprovalClass
  since: Date
  tool?: string
}): Promise<number> {
  return prisma.mcpPendingAction.count({
    where: {
      grantId: input.grantId,
      confirmation: input.confirmation,
      status: 'executed',
      executedAt: { gte: input.since },
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
    },
  })
}

/**
 * What the second call of an approval needs to know BEFORE claiming it: the
 * stored arguments and state of an APPROVED, unexpired action of this grant
 * and this tool. null for anything else (claimApprovedAction then says why).
 */
export async function approvedActionToRun(
  input: { id: string; grantId: string; tool: string },
  now: Date = new Date(),
): Promise<{ args: unknown; confirmation: ApprovalClass; stateHash: string | null } | null> {
  if (!isActionId(input.id)) return null
  const row = await prisma.mcpPendingAction.findUnique({ where: { id: input.id } })
  if (!row || row.kind !== 'approval' || row.grantId !== input.grantId || row.tool !== input.tool) return null
  if (row.status !== 'approved' || row.expiresAt.getTime() <= now.getTime()) return null
  if (row.confirmation !== 'destructive' && row.confirmation !== 'outbound') return null
  let args: unknown
  try {
    args = JSON.parse(row.argsJson) as unknown
  } catch {
    return null
  }
  return { args, confirmation: row.confirmation, stateHash: row.stateHash }
}

// ============ What the confirmation page shows ============

export interface ActionReview {
  id: string
  tool: string
  confirmation: ApprovalClass
  preview: string
  status: PendingActionStatus
  createdAt: Date
  expiresAt: Date
  decidedAt: Date | null
  executedAt: Date | null
  /** Name of the Claude client that asked (untrusted text typed at registration: escape it). */
  clientName: string | null
  /** The administrator who authorised the grant. */
  ownerName: string | null
  /** The grant was revoked: the action can no longer run. */
  connectionClosed: boolean
}

export type ReviewResult =
  | { found: false }
  /** The action belongs to another administrator: only who it is, nothing else. */
  | { found: true; foreign: true; ownerName: string | null }
  | { found: true; foreign: false; action: ActionReview }

/**
 * For /mcp/confirmar/[id], with the viewer already checked as an active
 * ADMIN. Expires the action first when its time is over.
 */
export async function reviewPendingAction(id: string, viewerId: string, now: Date = new Date()): Promise<ReviewResult> {
  if (!isActionId(id)) return { found: false }
  await expireOne(id, now)
  const row = await prisma.mcpPendingAction.findUnique({ where: { id } })
  if (!row || row.kind !== 'approval') return { found: false }
  const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { name: true } })
  if (row.userId !== viewerId) return { found: true, foreign: true, ownerName: owner?.name ?? null }
  const grant = await prisma.mcpGrant.findUnique({ where: { id: row.grantId }, select: { clientId: true, revokedAt: true, userId: true } })
  const client = grant ? await prisma.mcpClient.findUnique({ where: { clientId: grant.clientId }, select: { name: true } }) : null
  return {
    found: true,
    foreign: false,
    action: {
      id: row.id,
      tool: row.tool,
      confirmation: row.confirmation as ApprovalClass,
      preview: row.preview,
      status: row.status as PendingActionStatus,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      decidedAt: row.decidedAt,
      executedAt: row.executedAt,
      clientName: client?.name ?? null,
      ownerName: owner?.name ?? null,
      connectionClosed: !grant || !!grant.revokedAt || grant.userId !== row.userId,
    },
  }
}

// ============ CSRF token of the decision form ============

/**
 * The decision form reuses the signed consent token of the OAuth consent
 * screen (./crypto: HMAC-SHA256 with JWT_SECRET, 10 minutes), with fields
 * that cannot be mistaken for an OAuth request: the client is not a client id
 * (those are 43 random characters), the redirect URI is not a URL any client
 * could register, and the scope is not an OAuth scope. Posted to
 * /api/oauth/authorize it is refused; an OAuth consent token posted here is
 * refused too.
 */
const DECISION_CLIENT = 'mcp-pending-action'
const DECISION_SCOPE = 'mcp.action.decide'
const decisionTarget = (actionId: string) => `urn:tkoc:mcp-action:${actionId}`

/** The token of the «Confirmar» / «Cancelar» form, bound to this administrator and this action. */
export function signDecisionToken(actionId: string, adminId: string, nowMs: number = Date.now()): string {
  return signConsentToken(
    {
      userId: adminId,
      clientId: DECISION_CLIENT,
      redirectUri: decisionTarget(actionId),
      codeChallenge: actionId,
      state: null,
      resource: MCP_RESOURCE,
      scope: DECISION_SCOPE,
    },
    nowMs,
  )
}

export type DecisionTokenCheck = { ok: true } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'mismatch' }

/** Valid only for this action AND this administrator. */
export function verifyDecisionToken(token: unknown, actionId: string, adminId: string, nowMs: number = Date.now()): DecisionTokenCheck {
  const check = verifyConsentToken(token, nowMs)
  if (!check.ok) return check
  const f = check.fields
  const matches =
    f.clientId === DECISION_CLIENT &&
    f.scope === DECISION_SCOPE &&
    f.resource === MCP_RESOURCE &&
    f.state === null &&
    f.codeChallenge === actionId &&
    f.redirectUri === decisionTarget(actionId) &&
    f.userId === adminId
  return matches ? { ok: true } : { ok: false, reason: 'mismatch' }
}
