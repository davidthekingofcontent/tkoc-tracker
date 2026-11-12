/**
 * GET /api/oauth/activity
 *
 * The activity part of the card «Conexiones con Claude» of Ajustes: what
 * Claude did through the connector and what waits for a confirmation. ADMIN
 * only. Read only: this route changes nothing.
 *
 *   200  { pending: [...], calls: [...] }   as src/components/mcp/activity-api.ts describes
 *   401  no session          403  not an administrator
 *
 *  - calls: the last 50 rows of McpCallLog, of every connection, newest
 *    first: tool, how it ended, when, and the administrator of that
 *    connection. Never the arguments, never an answer.
 *  - pending: the actions of live connections that wait for the
 *    administrator ('pending') or for Claude to run them ('approved') and have
 *    not expired. Only the administrator who authorised the connection may
 *    confirm (src/lib/mcp/confirm.ts), so only the viewer's own carry the
 *    link to /mcp/confirmar/<id> and the preview (e-mails masked, secrets
 *    blanked); the others only say whose they are.
 *
 * The session is read from the `token` cookie ONLY, never from an
 * Authorization header, and re-read from the database (checkAdminSession).
 * The connector calls the platform with a Bearer token of its own
 * (src/lib/mcp/platform-client.ts, which also refuses /api/oauth): even if
 * that list changed, Claude could not read its own activity through here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkAdminSession } from '@/lib/mcp/oauth'
import { maskEmailsInText, redactSecretsInText } from '@/lib/mcp/output-filter'
import { actionPagePath } from '@/components/mcp/action-form'
import {
  ACTIVITY_CALLS_LIMIT,
  ACTIVITY_PENDING_LIMIT,
  INVALID_TOOL_NAME,
  cardPreview,
  classifyCall,
  isToolName,
  type Activity,
  type ActivityCall,
  type ApprovalKind,
  type PendingActionRow,
} from '@/components/mcp/activity-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/** More than ACTIVITY_PENDING_LIMIT are read so that actions of closed connections can be left out first. */
const PENDING_SCAN = ACTIVITY_PENDING_LIMIT * 5

export async function GET(request: NextRequest) {
  try {
    const session = await checkAdminSession(request.cookies.get('token')?.value)
    if (session.status === 'anonymous') return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
    if (session.status === 'forbidden') return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE })
    const viewerId = session.user.id
    const now = new Date()

    const [logs, waiting] = await Promise.all([
      prisma.mcpCallLog.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ACTIVITY_CALLS_LIMIT,
        select: { id: true, userId: true, tool: true, argsSummary: true, ok: true, createdAt: true },
      }),
      prisma.mcpPendingAction.findMany({
        where: { kind: 'approval', status: { in: ['pending', 'approved'] }, expiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PENDING_SCAN,
        select: { id: true, grantId: true, userId: true, tool: true, confirmation: true, status: true, preview: true, createdAt: true, expiresAt: true },
      }),
    ])

    // An action of a revoked connection can never run: it is not waiting for anybody
    const grantIds = [...new Set(waiting.map(a => a.grantId))]
    const liveGrants = grantIds.length
      ? await prisma.mcpGrant.findMany({ where: { id: { in: grantIds }, revokedAt: null }, select: { id: true, userId: true } })
      : []
    const grantOwner = new Map(liveGrants.map(g => [g.id, g.userId]))
    const open = waiting
      .filter(a => grantOwner.get(a.grantId) === a.userId && (a.confirmation === 'destructive' || a.confirmation === 'outbound'))
      // The viewer's own first (the ones this administrator can act on), newest first within each group
      .sort((a, b) => Number(b.userId === viewerId) - Number(a.userId === viewerId))
      .slice(0, ACTIVITY_PENDING_LIMIT)

    const userIds = [...new Set([...logs.map(l => l.userId), ...open.map(a => a.userId)])]
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
    const userName = new Map(users.map(u => [u.id, u.name]))

    const pending: PendingActionRow[] = open.map(a => {
      const mine = a.userId === viewerId
      const status = a.status === 'approved' ? 'approved' : 'pending'
      return {
        id: a.id,
        tool: a.tool,
        confirmation: a.confirmation as ApprovalKind,
        status,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
        ownerName: userName.get(a.userId) ?? null,
        mine,
        approvePath: mine && status === 'pending' ? actionPagePath(a.id) : null,
        preview: mine ? cardPreview(maskEmailsInText(redactSecretsInText(a.preview))) : null,
      }
    })

    const calls: ActivityCall[] = logs.map(l => {
      const how = classifyCall(l.argsSummary, l.ok, l.createdAt, now)
      return {
        id: l.id,
        at: l.createdAt.toISOString(),
        // The log only holds real names and the fixed label; anything else is shown as that label, never dropped
        tool: isToolName(l.tool) ? l.tool : INVALID_TOOL_NAME,
        kind: how.kind,
        result: how.result,
        confirmation: how.confirmation,
        httpStatus: how.httpStatus,
        userName: userName.get(l.userId) ?? null,
      }
    })

    const body: Activity = { pending, calls }
    return NextResponse.json(body, { headers: NO_STORE })
  } catch (error) {
    console.error('[oauth/activity] error:', error instanceof Error ? error.message.slice(0, 300) : 'unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE })
  }
}
