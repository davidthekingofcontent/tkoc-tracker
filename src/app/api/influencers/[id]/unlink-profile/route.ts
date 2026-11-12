/**
 * Staff (ADMIN/EMPLOYEE): undo a profile registered on the wrong creator.
 *
 * POST /api/influencers/[id]/unlink-profile   body { reason?: string }
 *   [id] = the PROFILE (Influencer row) that must stop being a profile of the
 *   person it is linked to.
 *
 * A creator is a person with several profiles (src/lib/person-profiles.ts). A
 * profile is registered on a creator by a PM in «Añadir publicación por URL»
 * or by the daily TikTok pass. When that was a mistake (the wrong creator
 * picked, an unverified @user that was not hers) the link stayed for good:
 * every later publication of that account was credited to the wrong creator
 * and the right one could not take it. This is the way out without touching
 * the database by hand. There is no screen for it yet.
 *
 * What it does (unlinkProfile, one transaction, logged in person_logs with the
 * state before and after and who did it): clears the profile's person, and the
 * person of the only profile left when two were linked. It NEVER moves,
 * detaches or deletes content, and never touches a campaign membership: a
 * publication already stored stays in the row of the member it was credited
 * to, and is removed from the campaign's Media tab like any other when it does
 * not belong there.
 *
 * Answers: 200 { logId, profile: { id, username, platform } } · 401 · 403 ·
 * 404 (no such profile) · 409 (the profile is not linked to anybody).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession, isStaffRole } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { PersonLinkError, unlinkProfile } from '@/lib/person-profiles'

const NOT_LINKED = 'Ese perfil no está vinculado a ninguna persona.'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession(request)
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // Agency staff only, checked here and not left to the middleware
    if (!isStaffRole(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { id } = await params

    // The body is optional: only a reason for the log
    let reason: string | undefined
    try {
      const body: unknown = await request.json()
      const raw = typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined
      if (typeof raw === 'string' && raw.trim()) reason = raw.trim().slice(0, 500)
    } catch {
      // no body, or not JSON: no reason given
    }

    const profile = await prisma.influencer.findUnique({
      where: { id },
      select: { id: true, username: true, platform: true, personId: true },
    })
    if (!profile) return NextResponse.json({ error: 'No encuentro ese perfil.' }, { status: 404 })
    if (!profile.personId) return NextResponse.json({ error: NOT_LINKED }, { status: 409 })

    try {
      const { logId } = await unlinkProfile({
        profileInfluencerId: profile.id,
        actor: { id: session.id, name: session.name },
        reason,
      })
      return NextResponse.json({ logId, profile: { id: profile.id, username: profile.username, platform: profile.platform } })
    } catch (err) {
      // Unlinked by somebody else between the check above and now
      if (err instanceof PersonLinkError) return NextResponse.json({ error: err.message }, { status: 409 })
      throw err
    }
  } catch (error) {
    console.error('Unlink profile error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
