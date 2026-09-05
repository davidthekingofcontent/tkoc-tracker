/**
 * GET /api/influencers/[id]/history — price history and creator score.
 *
 * Definitions (src/lib/metrics.ts, David 2026-09-05):
 *  - coste por campaña = memberCost(ci): fee acordado; si no hay, coste (decisión 6).
 *  - EMV por campaña = the creator's row in computeCampaignOverview(...).perInfluencer
 *    (extended, the only EMV shown) — never the dead Media.mediaValue column.
 *  - EMV ÷ coste se llama "Ratio EMV" (×2,4), nunca ROI (decisión 9B). The
 *    `score.roi` key is kept for the existing widget; `score.ratioEmv` carries
 *    the same value under its right name.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus } from '@/generated/prisma/client'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { emvRatioOf, memberCost, type CampaignOverview } from '@/lib/metrics'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    // Fetch the influencer with their engagement rate
    const influencer = await prisma.influencer.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        platform: true,
        engagementRate: true,
        followers: true,
      },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Fetch all campaign participations with campaign details
    const campaignInfluencers = await prisma.campaignInfluencer.findMany({
      where: { influencerId: id },
      select: {
        agreedFee: true,
        cost: true,
        status: true,
        campaign: {
          select: {
            id: true,
            name: true,
            type: true,
            startDate: true,
            endDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // ONE overview per campaign (cached within this request), computed in parallel.
    const overviewCache = new Map<string, Promise<CampaignOverview | null>>()
    const overviewFor = (campaignId: string) => {
      let p = overviewCache.get(campaignId)
      if (!p) {
        p = computeCampaignOverview(campaignId).catch(err => {
          console.error(`[influencer history] overview failed for campaign ${campaignId}:`, err instanceof Error ? err.message : err)
          return null
        })
        overviewCache.set(campaignId, p)
      }
      return p
    }
    const overviews = await Promise.all(campaignInfluencers.map(ci => overviewFor(ci.campaign.id)))

    // Build price history
    const priceHistory = campaignInfluencers.map((ci, i) => {
      const mine = overviews[i]?.perInfluencer.find(p => p.influencerId === id) ?? null
      const cost = memberCost(ci)
      const emvExtended = mine?.emvExtended ?? 0
      return {
        campaignId: ci.campaign.id,
        campaignName: ci.campaign.name,
        campaignType: ci.campaign.type,
        agreedFee: ci.agreedFee,
        cost: ci.cost,
        /** Fee acordado; si no hay, coste (decisión 6). */
        effectiveCost: cost,
        status: ci.status,
        startDate: ci.campaign.startDate,
        endDate: ci.campaign.endDate,
        /** EMV extended of this creator in this campaign. */
        emvExtended,
        /** Legacy key read by the widget as "EMV" — same value as emvExtended. */
        mediaValue: emvExtended,
        /** EMV ÷ coste; null without cost. Displayed as "×2,4". */
        ratioEmv: emvRatioOf(emvExtended, cost),
        media: mine?.media ?? 0,
        engagements: mine?.engagements ?? 0,
        audience: mine?.audience.total ?? 0,
        engagementRate: mine?.er.value ?? null,
      }
    })

    // --- Scoring ---

    const totalCampaigns = campaignInfluencers.length

    // Engagement score (0-100): normalize engagement rate
    // Typical good ER is 3-6%, exceptional is 10%+
    const engagementScore = Math.min(100, (influencer.engagementRate / 6) * 100)

    // Delivery reliability: % of campaigns reaching POSTED or COMPLETED
    const deliveredStatuses: InfluencerStatus[] = [
      InfluencerStatus.POSTED,
      InfluencerStatus.COMPLETED,
    ]
    const deliveredCount = campaignInfluencers.filter((ci) =>
      deliveredStatuses.includes(ci.status)
    ).length
    const reliabilityScore =
      totalCampaigns > 0 ? (deliveredCount / totalCampaigns) * 100 : 0

    // Ratio EMV: total EMV (extended) vs total cost (fee acordado o coste)
    const totalEmvExtended = Math.round(priceHistory.reduce((sum, h) => sum + h.emvExtended, 0) * 100) / 100
    const totalCost = Math.round(campaignInfluencers.reduce((sum, ci) => sum + memberCost(ci), 0) * 100) / 100
    const ratioEmv = emvRatioOf(totalEmvExtended, totalCost)
    // Ratio EMV score: ×1 = 25, ×2 = 50, ×4+ = 100; without cost, 100 if there is EMV
    let ratioEmvScore: number
    if (ratioEmv === null) {
      ratioEmvScore = totalEmvExtended > 0 ? 100 : 0
    } else {
      ratioEmvScore = Math.min(100, ratioEmv * 25)
    }

    // Consistency: based on number of campaigns
    // 1 campaign = 20, 5+ = 100
    const consistencyScore = Math.min(100, (totalCampaigns / 5) * 100)

    // Weighted total
    const totalScore = Math.round(
      engagementScore * 0.3 +
        reliabilityScore * 0.3 +
        ratioEmvScore * 0.2 +
        consistencyScore * 0.2
    )

    const score = {
      total: Math.min(100, Math.max(0, totalScore)),
      engagement: Math.round(engagementScore),
      reliability: Math.round(reliabilityScore),
      /** Ratio EMV score (kept under its old key for the widget). */
      roi: Math.round(ratioEmvScore),
      ratioEmv: Math.round(ratioEmvScore),
      consistency: Math.round(consistencyScore),
    }

    return NextResponse.json({
      influencerId: influencer.id,
      username: influencer.username,
      platform: influencer.platform,
      totalCampaigns,
      priceHistory,
      totals: {
        cost: totalCost,
        emvExtended: totalEmvExtended,
        /** EMV ÷ coste across all campaigns; null without cost. Displayed as "×2,4". */
        ratioEmv,
      },
      score,
    })
  } catch (error) {
    console.error('Error fetching influencer history:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
