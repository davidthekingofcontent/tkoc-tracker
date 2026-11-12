import { NextRequest, NextResponse } from 'next/server'
import { getSession, isStaffRole } from '@/lib/auth'
import { FoldError, foldTwins, listLiveFolds, listTwinMemberships, undoFold } from '@/lib/person-fold'

/**
 * /api/admin/fold-twins (ADMIN only).
 *
 * A twin is the second member a TikTok link created for a creator who already
 * was a member with her Instagram (until 12 Nov 2026). Folding it credits its
 * pieces and notes to her own row and removes the second row; fee, status and
 * shipping stay those of her own row. See src/lib/person-fold.ts.
 *
 * GET  [?campaignId=]                                  → the twins and what folding each would do, and the folds in force. Changes nothing.
 * POST { campaignId } | { membershipIds: [] } | { all: true } → folds every twin without blockers among those
 * POST { undo: <fold log id> }                          → puts one fold back
 */
export const dynamic = 'force-dynamic'

async function adminSession(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  // Staff first (the rule of every route), and of the staff only an ADMIN
  if (!isStaffRole(session.role) || session.role !== 'ADMIN') {
    return { error: NextResponse.json({ error: 'Solo un administrador puede fusionar miembros.' }, { status: 403 }) }
  }
  return { session }
}

export async function GET(request: NextRequest) {
  const auth = await adminSession(request)
  if (auth.error) return auth.error
  try {
    const campaignId = request.nextUrl.searchParams.get('campaignId') || undefined
    const [twins, folds] = await Promise.all([listTwinMemberships(campaignId), listLiveFolds(campaignId)])
    return NextResponse.json({ twins, foldable: twins.filter(t => t.blockers.length === 0).length, folds })
  } catch (err) {
    console.error('[fold-twins] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No he podido leer los miembros duplicados.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await adminSession(request)
  if (auth.error) return auth.error
  const actor = { id: auth.session.id, name: auth.session.name }
  const body = (await request.json().catch(() => null)) as { campaignId?: unknown; membershipIds?: unknown; all?: unknown; undo?: unknown } | null
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Falta el cuerpo de la petición.' }, { status: 400 })

  if (body.undo !== undefined) {
    if (typeof body.undo !== 'string' || !body.undo.trim()) return NextResponse.json({ error: 'Indica qué fusión quieres deshacer.' }, { status: 400 })
    try {
      return NextResponse.json({ undone: await undoFold(body.undo.trim(), actor) })
    } catch (err) {
      if (err instanceof FoldError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_found' ? 404 : 409 })
      console.error('[fold-twins] undo failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'No he podido deshacer la fusión. No ha cambiado nada.' }, { status: 500 })
    }
  }

  const campaignId = typeof body.campaignId === 'string' && body.campaignId.trim() ? body.campaignId.trim() : undefined
  let membershipIds: string[] | undefined
  if (body.membershipIds !== undefined) {
    if (!Array.isArray(body.membershipIds) || body.membershipIds.length === 0 || !body.membershipIds.every(x => typeof x === 'string' && x.trim())) {
      return NextResponse.json({ error: 'membershipIds tiene que ser una lista de ids.' }, { status: 400 })
    }
    membershipIds = (body.membershipIds as string[]).map(x => x.trim())
  }
  // Folding every campaign at once must be asked for explicitly
  if (!campaignId && !membershipIds && body.all !== true) {
    return NextResponse.json({ error: 'Indica la campaña (campaignId), los miembros (membershipIds) o all: true.' }, { status: 400 })
  }

  try {
    const report = await foldTwins({ campaignId, membershipIds, actor })
    return NextResponse.json(report)
  } catch (err) {
    console.error('[fold-twins] fold failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No he podido fusionar los miembros duplicados.' }, { status: 500 })
  }
}
