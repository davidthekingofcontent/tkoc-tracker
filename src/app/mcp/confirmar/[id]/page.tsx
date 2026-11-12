/**
 * GET /mcp/confirmar/[id]: where an administrator confirms or cancels an
 * action Claude asked for (deleting something, writing to a person). Claude
 * itself never reaches this page: the confirmation happens OUTSIDE the model.
 *
 * SERVER component, same rules as the OAuth consent page (deny by default):
 *
 *  1. Session. The `token` cookie is verified and the user is re-read from the
 *     database (checkAdminSession). No valid session: to /login, which comes
 *     back here. BRAND and CREATOR go to their own home (the middleware
 *     already keeps them out); an EMPLOYEE gets a refusal.
 *  2. The action. Only the administrator who authorised the grant that asked
 *     for it may decide it (src/lib/mcp/confirm.ts explains why). Anyone else
 *     only learns whose it is. Expired, cancelled, already run or unknown
 *     actions show a notice and no buttons.
 *  3. The form carries a token signed for THIS administrator and THIS action
 *     (10 minutes): POST /api/mcp/actions/[id] verifies it together with the
 *     session, so the decision cannot be forged from another site. «Confirmar»
 *     also asks for the administrator's own password: a browser driven by
 *     Claude could press the button, but it does not know the password. Nothing
 *     is decided by rendering this page.
 */
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ActionApprovalScreen, ActionNotice } from '@/components/mcp/action-approval'
import { ACTION_ERROR_PARAM, ACTION_ERROR_PASSWORD, actionPagePath } from '@/components/mcp/action-form'
import { MCP_WRITE_TEXTS } from '@/components/mcp/write-texts'
import { isActionId, reviewPendingAction, signDecisionToken } from '@/lib/mcp/confirm'
import { checkAdminSession } from '@/lib/mcp/oauth'

// Reads the session cookie and the database on every request: never prerendered, never cached
export const dynamic = 'force-dynamic'
// jsonwebtoken, node:crypto and Prisma need the Node runtime
export const runtime = 'nodejs'

export const metadata: Metadata = {
  title: MCP_WRITE_TEXTS.es.action.pageTitle,
  robots: { index: false, follow: false },
  referrer: 'same-origin',
}

/** Whole minutes from now until `date` (never negative): computed once, on the server. */
function minutesUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 60_000))
}

export default async function ConfirmActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  // Only the one known value is read: nothing of the query is ever printed
  const passwordRefused = (await searchParams)?.[ACTION_ERROR_PARAM] === ACTION_ERROR_PASSWORD

  // ---- 1. Who is looking: an active ADMIN, checked against the database ----
  const session = await checkAdminSession((await cookies()).get('token')?.value)
  if (session.status === 'anonymous') {
    // Back to this very page after signing in (the login honours only this shape)
    redirect(isActionId(id) ? `/login?next=${encodeURIComponent(actionPagePath(id))}` : '/login')
  }
  if (session.status === 'forbidden') {
    if (session.role === 'BRAND') redirect('/portal')
    if (session.role === 'CREATOR') redirect('/dashboard')
    return <ActionNotice kind="forbidden" />
  }

  // ---- 2. The action, and whether this administrator may decide it ----
  if (!isActionId(id)) return <ActionNotice kind="notFound" />
  const review = await reviewPendingAction(id, session.user.id)
  if (!review.found) return <ActionNotice kind="notFound" />
  if (review.foreign) return <ActionNotice kind="foreign" ownerName={review.ownerName} />

  const action = review.action
  switch (action.status) {
    case 'approved':
      return <ActionNotice kind={action.connectionClosed ? 'closed' : 'approved'} at={action.expiresAt.toISOString()} />
    case 'denied':
      return <ActionNotice kind="denied" />
    case 'executed':
      return <ActionNotice kind="executed" at={(action.executedAt ?? action.decidedAt ?? action.createdAt).toISOString()} />
    case 'expired':
      return <ActionNotice kind="expired" />
    case 'pending':
      break
    default:
      return <ActionNotice kind="notFound" />
  }
  if (action.connectionClosed) return <ActionNotice kind="closed" />

  // ---- 3. The decision form, bound to this administrator and this action ----
  const minutesLeft = minutesUntil(action.expiresAt)
  return (
    <ActionApprovalScreen
      actionId={action.id}
      preview={action.preview}
      confirmation={action.confirmation}
      tool={action.tool}
      clientName={action.clientName}
      ownerName={action.ownerName ?? session.user.name}
      expiresAt={action.expiresAt.toISOString()}
      minutesLeft={minutesLeft}
      decisionToken={signDecisionToken(action.id, session.user.id)}
      passwordRefused={passwordRefused}
    />
  )
}
