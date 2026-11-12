/**
 * DELETE /api/oauth/grants/[id]
 *
 * «Revocar» in the card «Conexiones con Claude» of Ajustes: ends one
 * authorisation of the MCP connector at once (revokeGrant, src/lib/mcp/oauth.ts:
 * the grant is marked and its tokens and codes are deleted). ADMIN session
 * only; any administrator may revoke the connection of any other.
 *
 *   200  { success: true }
 *   401  no session          403  not an administrator
 *   404  no live authorisation with that id (unknown, or already revoked)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { revokeGrant } from '@/lib/mcp/oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // getSession re-reads the user: active, and the role is the one in the database
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    // Who revoked it stays on the grant (revokedReason), never shown to the client
    const revoked = typeof id === 'string' && id.length <= 64 && (await revokeGrant(id, `admin:${session.id}`))
    if (!revoked) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[oauth/grants] revoke error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
