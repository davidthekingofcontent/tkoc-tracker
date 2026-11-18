/**
 * Staff (ADMIN/EMPLOYEE): register another profile of a creator by hand, with
 * no publication to prove it («Añadir perfil de TikTok» in Elegir, 16 Nov 2026).
 *
 * POST /api/influencers/[id]/link-profile
 *   body { platform: 'TIKTOK' | 'INSTAGRAM' | 'YOUTUBE', username: string, campaignId?: string }
 *   [id] = the creator (Influencer row of the member in Elegir) the profile is
 *   added to. `username` may carry a leading @ or be the profile's URL.
 *
 * Until now a creator's TikTok was only registered when a video of hers
 * entered: pasted in «Añadir publicación por URL» or found by the daily pass
 * (which looks for the same username or the one in her bio). A creator who
 * uses another name on TikTok and has not published yet could not be set up.
 *
 * What it does: finds the profile row (any casing) or creates a bare one
 * (followers 0 until the next reading; never scrapes, never calls Apify), then
 * linkProfile (src/lib/person-profiles.ts) with evidence 'pm_manual', one
 * transaction and a PersonLog row. From then on the profile is a linked
 * profile of the creator: the daily TikTok pass reads it as "known" once she is
 * in Acordado or later, the roster credits its publications to her row, and
 * unlink-profile undoes it. It never creates a membership and never touches Media.
 *
 * Refused: a brand account of any campaign she is in (its targets or the
 * brand's connected Instagram) or of the campaign `campaignId` names (checked
 * too, even when she is not in it), a profile that already belongs to ANOTHER
 * person, and her own row.
 *
 * Answers: 200 { logId, personId, alreadyLinked, profile: { id, username,
 * platform, created } } · 400 (platform / username) · 401 · 403 · 404 (no such
 * creator) · 409 { code: 'brand_account' | 'other_person' | 'same_profile' }.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSession, isStaffRole } from '@/lib/auth'
import { prisma } from '@/lib/db'
import type { Platform } from '@/generated/prisma/client'
import { loadCampaignBrandAccounts } from '@/lib/campaign-capture'
import { isBrandAccount } from '@/lib/campaign-targets'
import {
  PersonLinkError,
  describeMainProfileOfPerson,
  findInfluencerExact,
  findOrCreateInfluencerExact,
  linkProfile,
  normalizeHandle,
  parseProfileHandle,
} from '@/lib/person-profiles'

const PLATFORMS: ReadonlySet<string> = new Set(['TIKTOK', 'INSTAGRAM', 'YOUTUBE'])
const NETWORK_LABEL: Record<string, string> = { INSTAGRAM: 'Instagram', TIKTOK: 'TikTok', YOUTUBE: 'YouTube' }

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

    let body: { platform?: unknown; username?: unknown; campaignId?: unknown } = {}
    try {
      const parsed: unknown = await request.json()
      if (typeof parsed === 'object' && parsed !== null) body = parsed as typeof body
    } catch {
      // not JSON: validated below as missing fields
    }
    const platform = typeof body.platform === 'string' ? body.platform.toUpperCase() : ''
    if (!PLATFORMS.has(platform)) {
      return NextResponse.json({ error: 'Indica la red del perfil: TikTok, Instagram o YouTube.', code: 'invalid_platform' }, { status: 400 })
    }
    const handle = parseProfileHandle(platform, body.username)
    if (!handle) {
      return NextResponse.json({ error: 'Escribe el usuario del perfil (con o sin @) o pega la URL de su perfil.', code: 'invalid_username' }, { status: 400 })
    }
    const campaignId = typeof body.campaignId === 'string' && body.campaignId.trim() ? body.campaignId.trim() : null

    const member = await prisma.influencer.findUnique({
      where: { id },
      select: { id: true, username: true, platform: true, personId: true },
    })
    if (!member) return NextResponse.json({ error: 'No encuentro esa creadora.' }, { status: 404 })

    const network = NETWORK_LABEL[platform] ?? platform
    if (member.platform === platform && normalizeHandle(member.username) === normalizeHandle(handle)) {
      return NextResponse.json({ error: `@${handle} (${network}) ya es el perfil de esa creadora.`, code: 'same_profile' }, { status: 409 })
    }

    // Brand guard: the accounts of the brand of her campaigns (targets and the
    // brand's connected Instagram) are never a creator's profile. Checked on
    // EVERY campaign she is in and, when the body names one, on that campaign
    // too: a union, never a narrowing (18 Nov 2026: `campaignId` used to
    // restrict the check, so a campaign she was not in, or an invented id, left
    // nothing to check and the brand's own handle could be linked as her profile).
    const memberships = await prisma.campaignInfluencer.findMany({
      where: { influencerId: member.id },
      select: { campaign: { select: { id: true, name: true, targetAccounts: true } } },
    })
    const campaigns = memberships.map(m => m.campaign)
    if (campaignId && !campaigns.some(c => c.id === campaignId)) {
      const named = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true, name: true, targetAccounts: true } })
      if (named) campaigns.push(named)
    }
    const brandAccounts = await loadCampaignBrandAccounts(campaigns)
    const brandOf = campaigns.find(c => {
      const accounts = brandAccounts.get(c.id)
      return !!accounts && (isBrandAccount(accounts.targets, handle) || isBrandAccount(accounts.own, handle))
    })
    if (brandOf) {
      return NextResponse.json(
        { error: `@${handle} es una cuenta de la marca de "${brandOf.name}", no un perfil de la creadora.`, code: 'brand_account' },
        { status: 409 },
      )
    }

    // A profile that already belongs to ANOTHER person is never taken from her
    const existing = await findInfluencerExact(platform as Platform, handle)
    if (existing?.personId && existing.personId !== member.personId) {
      const owner = await describeMainProfileOfPerson(existing.personId, existing.id)
      return NextResponse.json(
        { error: `@${existing.username} (${network}) ya es perfil de otra persona${owner ? `: ${owner}` : ''}. Si es un error, deshaz esa vinculación antes.`, code: 'other_person' },
        { status: 409 },
      )
    }

    const actor = { id: session.id, name: session.name }
    const profile = await findOrCreateInfluencerExact(platform as Platform, handle, actor)
    const campaignNote = campaignId ? campaigns.find(c => c.id === campaignId)?.name : null
    try {
      const linked = await linkProfile({
        memberInfluencerId: member.id,
        profileInfluencerId: profile.id,
        actor,
        evidence: 'pm_manual',
        summary: `@${profile.username} (${network}) añadido como perfil de @${member.username} (${NETWORK_LABEL[member.platform] ?? member.platform}) por ${session.name} desde Elegir${campaignNote ? ` ("${campaignNote}")` : ''}, sin publicación que lo pruebe`,
      })
      console.log(`[link-profile] @${profile.username} (${platform}) linked to @${member.username} (${member.platform}) by user ${session.id}${profile.created ? ' (new row)' : ''}${linked.alreadyLinked ? ' (already linked)' : ''}`)
      return NextResponse.json({
        logId: linked.logId,
        personId: linked.personId,
        alreadyLinked: linked.alreadyLinked,
        profile: { id: profile.id, username: profile.username, platform, created: profile.created },
      })
    } catch (err) {
      // Linked to somebody else between the check above and now
      if (err instanceof PersonLinkError) {
        const code = err.code === 'profile_has_other_person' ? 'other_person' : err.code === 'same_profile' ? 'same_profile' : 'not_found'
        return NextResponse.json({ error: err.message, code }, { status: code === 'not_found' ? 404 : 409 })
      }
      throw err
    }
  } catch (error) {
    console.error('Link profile error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
