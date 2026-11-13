import { NextRequest, NextResponse } from 'next/server'
import { getSession, isStaffRole } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  MergeError,
  applyMerge,
  countSameCampaignCandidates,
  dismissCandidate,
  findMergeCandidates,
  listMergeHistory,
  previewMerge,
  undoMerge,
} from '@/lib/person-merge'

/**
 * /api/admin/person-merge (ADMIN only, checked here on the server).
 *
 * Two records of one creator (her Instagram and her TikTok as two members of
 * a campaign, or a wrong handle next to her real one): find them, preview the
 * merge, apply it once confirmed, undo it. See src/lib/person-merge.ts.
 * Never reachable through the Claude connector (src/lib/mcp/platform-client.ts).
 *
 * GET  [?campaignId=]                → { campaign, candidates, history }      (changes nothing)
 * GET  ?campaignId=&countOnly=1      → { count } of «cuenta doble» candidates of that campaign (the banner)
 * POST { action: 'preview', keepId, otherId, mode, choices? }              → { preview }   (changes nothing)
 * POST { action: 'apply', keepId, otherId, mode, choices?, fingerprint }   → { result }
 * POST { action: 'undo', logId, force?, differencesHash? }                → { undone }
 * POST { action: 'dismiss', aId, bId }                                     → { dismissed }
 * Errors: { error, code, ...details } with 400 / 401 / 403 / 404 / 409 (stale,
 * needs_choice, busy, changed_since with `differences` and `differencesHash`
 * (send it back with force: true to undo anyway), cannot_undo).
 */
export const dynamic = 'force-dynamic'

async function adminSession(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  // Staff first (the rule of every route), and of the staff only an ADMIN
  if (!isStaffRole(session.role) || session.role !== 'ADMIN') {
    return { error: NextResponse.json({ error: 'Solo un administrador puede fusionar fichas de creadoras.' }, { status: 403 }) }
  }
  return { session }
}

function mergeErrorResponse(err: MergeError) {
  return NextResponse.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, { status: err.status })
}

export async function GET(request: NextRequest) {
  const auth = await adminSession(request)
  if (auth.error) return auth.error
  const params = request.nextUrl.searchParams
  const campaignId = params.get('campaignId')?.trim() || undefined
  try {
    if (params.get('countOnly') === '1') {
      if (!campaignId) return NextResponse.json({ error: 'Indica la campaña (campaignId).' }, { status: 400 })
      return NextResponse.json({ count: await countSameCampaignCandidates(campaignId) })
    }
    const campaign = campaignId ? await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true } }) : null
    if (campaignId && !campaign) return NextResponse.json({ error: 'No encuentro esa campaña.' }, { status: 404 })
    const [candidates, history] = await Promise.all([findMergeCandidates({ campaignId }), listMergeHistory(50)])
    return NextResponse.json({ campaign, candidates, history })
  } catch (err) {
    if (err instanceof MergeError) return mergeErrorResponse(err)
    console.error('[person-merge] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No he podido buscar las fichas duplicadas.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await adminSession(request)
  if (auth.error) return auth.error
  const actor = { id: auth.session.id, name: auth.session.name }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Falta el cuerpo de la petición.' }, { status: 400 })

  try {
    switch (body.action) {
      case 'preview':
        return NextResponse.json({
          preview: await previewMerge({
            keepId: body.keepId as string,
            otherId: body.otherId as string,
            mode: body.mode as 'link' | 'absorb',
            choices: body.choices as Record<string, Record<string, 'keep' | 'other' | 'add'>> | undefined,
          }),
        })
      case 'apply':
        return NextResponse.json({
          result: await applyMerge({
            keepId: body.keepId as string,
            otherId: body.otherId as string,
            mode: body.mode as 'link' | 'absorb',
            choices: body.choices as Record<string, Record<string, 'keep' | 'other' | 'add'>> | undefined,
            fingerprint: body.fingerprint as string,
          }, actor),
        })
      case 'undo':
        if (body.force !== undefined && typeof body.force !== 'boolean') return NextResponse.json({ error: 'force tiene que ser true o false.' }, { status: 400 })
        if (body.differencesHash !== undefined && typeof body.differencesHash !== 'string') return NextResponse.json({ error: 'differencesHash tiene que ser el texto que devolvió el 409.' }, { status: 400 })
        // A forced undo overwrites only the differences the ADMIN was shown (their hash, from the 409)
        return NextResponse.json({ undone: await undoMerge(body.logId as string, actor, { force: body.force === true, differencesHash: body.differencesHash as string | undefined }) })
      case 'dismiss':
        return NextResponse.json({ dismissed: await dismissCandidate(body.aId as string, body.bId as string, actor) })
      default:
        return NextResponse.json({ error: "Indica la acción: 'preview', 'apply', 'undo' o 'dismiss'." }, { status: 400 })
    }
  } catch (err) {
    if (err instanceof MergeError) return mergeErrorResponse(err)
    console.error(`[person-merge] ${String(body.action)} failed:`, err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'No he podido completar la operación. No ha cambiado nada.' }, { status: 500 })
  }
}
