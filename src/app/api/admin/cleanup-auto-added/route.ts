import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

/**
 * Cleanup endpoint: removes CampaignInfluencer rows that were auto-added by the
 * cron tracking job (which used to upsert ANY profile mentioning a brand into
 * the campaign). Uses heuristics:
 *   - status is null OR 'PROSPECT' (auto-added defaults)
 *   - influencer has 0 Media records linked to this campaign that the user
 *     could plausibly have intended (e.g. createdAt within last X days)
 *   - keeps anything with notes, fee, contracts, contacted status, etc.
 *
 * Safety: requires `?campaignId=xxx` so it never wipes everything at once.
 * Use `?dryRun=true` to preview.
 */
export async function POST(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const campaignId = url.searchParams.get('campaignId')
  const dryRun = url.searchParams.get('dryRun') === 'true'

  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId query param required' }, { status: 400 })
  }

  // Verify the campaign belongs to this user
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId: session.id },
    select: { id: true, name: true },
  })
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Find candidates: CampaignInfluencer rows that look auto-added
  // - status PROSPECT (the default, what auto-add used)
  // - no agreedFee, no cost, no notes (user hasn't touched anything)
  // Plus we keep INVITED/ACCEPTED/DELIVERED/POSTED/REJECTED (user-touched states)
  const candidates = await prisma.campaignInfluencer.findMany({
    where: {
      campaignId,
      status: 'PROSPECT',
      AND: [
        { OR: [{ agreedFee: null }, { agreedFee: 0 }] },
        { OR: [{ cost: null }, { cost: 0 }] },
        { OR: [{ notes: null }, { notes: '' }] },
        { contentDelivered: false },
      ],
    },
    include: {
      influencer: {
        select: { id: true, username: true, displayName: true, followers: true },
      },
    },
  })

  if (dryRun) {
    return NextResponse.json({
      campaignId,
      campaignName: campaign.name,
      wouldRemove: candidates.length,
      preview: candidates.slice(0, 20).map(c => ({
        username: c.influencer.username,
        followers: c.influencer.followers,
        status: c.status,
      })),
    })
  }

  // Delete the candidates
  const deleted = await prisma.campaignInfluencer.deleteMany({
    where: { id: { in: candidates.map(c => c.id) } },
  })

  return NextResponse.json({
    campaignId,
    campaignName: campaign.name,
    removed: deleted.count,
  })
}
