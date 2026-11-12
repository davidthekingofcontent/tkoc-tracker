/**
 * GET /api/oauth/grants
 *
 * The card «Conexiones con Claude» of Ajustes: every live authorisation of
 * the MCP connector, of ALL administrators, newest first (listGrants,
 * src/lib/mcp/oauth.ts). ADMIN session only.
 *
 *   200  { grants: [{ id, clientId, clientName, userId, userName, scope,
 *          createdAt, lastUsedAt }] }
 *        clientName is free text the client chose: escape it when shown.
 *        clientName and userName are null when that row no longer exists.
 *        Dates are ISO strings; lastUsedAt is null until the first call.
 *   401  no session          403  not an administrator
 *
 * No token, no hash and no e-mail ever leaves this route.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { listGrants } from '@/lib/mcp/oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // getSession re-reads the user: active, and the role is the one in the database
    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const grants = await listGrants()
    return NextResponse.json({ grants }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[oauth/grants] list error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
