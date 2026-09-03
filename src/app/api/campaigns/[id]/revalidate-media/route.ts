import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { revalidateCampaignMedia, campaignHasTargets } from '@/lib/campaign-capture'

/**
 * POST /api/campaigns/[id]/revalidate-media
 *
 * Re-judges every Media row attached to the campaign against the precise
 * capture rules (member + inside campaign dates + references a target).
 * Rows that no longer qualify are DETACHED (campaignId = null) — never
 * deleted. Manual rows are always kept.
 *
 * ADMIN: any campaign. EMPLOYEE: campaigns they own, are assigned to, or
 * that belong to a brand user assigned to them (same scope as the list).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        targetAccounts: true,
        targetHashtags: true,
        assignments: { where: { userId: session.id }, select: { id: true } },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (session.role === 'EMPLOYEE') {
      let allowed = campaign.userId === session.id || campaign.assignments.length > 0
      if (!allowed) {
        // Brand-level assignment: Setting key 'brand_assignment_{brandUserId}' → JSON string[] of employee ids
        const brandAssignment = await prisma.setting.findUnique({
          where: { key: `brand_assignment_${campaign.userId}` },
        })
        if (brandAssignment) {
          try {
            const employeeIds = JSON.parse(brandAssignment.value) as string[]
            allowed = Array.isArray(employeeIds) && employeeIds.includes(session.id)
          } catch { /* malformed entry → not allowed */ }
        }
      }
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const result = await revalidateCampaignMedia(id)

    return NextResponse.json({
      message: 'Revalidation completed',
      targetsConfigured: campaignHasTargets(campaign),
      kept: result.kept,
      detached: result.detached,
    })
  } catch (error) {
    console.error('Revalidate campaign media error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
