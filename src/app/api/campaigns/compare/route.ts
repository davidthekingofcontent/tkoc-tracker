import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { computeCampaignOverviews, stripEconomics } from '@/lib/campaign-overview'

function getInfluencerTier(followers: number): string {
  if (followers >= 1_000_000) return 'mega'
  if (followers >= 500_000) return 'macro'
  if (followers >= 100_000) return 'mid'
  if (followers >= 10_000) return 'micro'
  return 'nano'
}

// GET /api/campaigns/compare?ids=a,b[,c]
// Every figure comes from computeCampaignOverview (src/lib/campaign-overview.ts,
// definitions in src/lib/metrics.ts): audience = reach → impressions → views →
// labelled estimate, ER = interacciones ÷ audiencia, cost = agreedFee (else
// cost), EMV from the live valuation, Ratio EMV = EMV ÷ coste. Nothing is
// aggregated here any more. Brands get the economics stripped.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const ids = searchParams.get('ids')?.split(',').filter(Boolean) || []

    if (ids.length < 2 || ids.length > 3) {
      return NextResponse.json(
        { error: 'Please provide 2 or 3 campaign IDs' },
        { status: 400 }
      )
    }

    // Campaign rows: identity fields plus what the breakdowns need (platform of
    // each publication, followers of each member). No metric columns.
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        paymentType: true,
        startDate: true,
        endDate: true,
        country: true,
        userId: true,
        influencers: {
          select: { influencer: { select: { followers: true } } },
        },
        media: { select: { platform: true } },
      },
    })

    if (campaigns.length !== ids.length) {
      const foundIds = campaigns.map((c) => c.id)
      const missing = ids.filter((id) => !foundIds.includes(id))
      return NextResponse.json(
        { error: `Campaigns not found: ${missing.join(', ')}` },
        { status: 404 }
      )
    }

    // BRAND users can only compare their own campaigns
    const isBrand = session.role === 'BRAND'
    if (isBrand) {
      const forbidden = campaigns.filter((c) => c.userId !== session.id)
      if (forbidden.length > 0) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    // The single source of truth, over ALL media of each campaign.
    const overviews = await computeCampaignOverviews(ids)
    const uncomputed = ids.filter((id) => !overviews.has(id))
    if (uncomputed.length > 0) {
      console.error('Compare campaigns: overview unavailable for', uncomputed.join(', '))
      return NextResponse.json(
        { error: 'Could not compute the campaign figures. Try again.' },
        { status: 500 }
      )
    }

    // Build comparison data for each campaign, preserving the requested order
    const comparisons = ids.map((id) => {
      const campaign = campaigns.find((c) => c.id === id)!
      const full = overviews.get(id)!
      // Brands never see cost, CPM, Ratio EMV or the basic EMV.
      const overview = isBrand ? stripEconomics(full) : full
      const t = overview.totals

      // Platform breakdown: count media by platform
      const platformBreakdown: Record<string, number> = {}
      for (const m of campaign.media) {
        platformBreakdown[m.platform] = (platformBreakdown[m.platform] || 0) + 1
      }

      // Tier breakdown: count influencers by follower tier
      const tierBreakdown: Record<string, number> = {
        nano: 0,
        micro: 0,
        mid: 0,
        macro: 0,
        mega: 0,
      }
      for (const ci of campaign.influencers) {
        const tier = getInfluencerTier(ci.influencer.followers)
        tierBreakdown[tier]++
      }

      return {
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        status: campaign.status,
        paymentType: campaign.paymentType,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        country: campaign.country,
        influencerCount: t.members,
        mediaCount: t.media,
        /** Audiencia total (real + estimada) — what the compare page labels "Alcance Total". */
        totalReach: t.audience.total,
        /** Real reach only (Σ reach). */
        totalReachReal: t.reachReal,
        /** Share (0–1) of the audience that is estimated. */
        audienceEstimatedShare: t.audience.estimatedShare,
        totalImpressions: t.impressionsReal ?? 0,
        /** Interacciones = likes + comentarios + shares + saves. */
        totalEngagements: t.engagements,
        /** ER = interacciones ÷ audiencia × 100; 0 when there is no audience base. */
        engagementRate: t.er.value ?? 0,
        engagementRateEstimatedShare: t.er.estimatedShare,
        totalViews: t.views,
        /** Coste = fee acordado, si no coste registrado (0 for brands). */
        totalCost: t.cost,
        emvExtended: t.emvExtended,
        /** Ratio EMV (decision 9B): EMV ÷ coste, shown as "×2,4". Never ROI. */
        emvRatio: t.emvRatio,
        /** @deprecated legacy alias of emvRatio; kept so older clients keep working */
        roi: t.emvRatio,
        cpm: t.cpm,
        platformBreakdown,
        tierBreakdown,
      }
    })

    return NextResponse.json({ campaigns: comparisons })
  } catch (error) {
    console.error('Compare campaigns error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
