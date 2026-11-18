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
 *
 * A creator is a person with several profiles (Nov 2026). Since the review of
 * 16 Nov 2026 (point 3) the history is the PERSON's, whichever of her profiles
 * is asked for: the memberships of every linked profile are added up, one row
 * per campaign, ordered by the campaign's start date (newest first; it used to
 * be the membership's createdAt, which is not chronological). Reliability is
 * computed only over the campaigns that were agreed (CLOSED_STATUSES, AGREED
 * or later): sitting in a pool as PROSPECT neither counts nor penalises. The
 * rest of the score formula is unchanged.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { InfluencerStatus, type Platform } from '@/generated/prisma/client'
import { CLOSED_STATUSES, computeCampaignOverview } from '@/lib/campaign-overview'
import { emvRatioOf, memberCost, type CampaignOverview } from '@/lib/metrics'

interface HistoryRow {
  influencerId: string
  agreedFee: number | null
  cost: number | null
  status: InfluencerStatus
  createdAt: Date
  campaign: {
    id: string
    name: string
    type: string
    startDate: Date | null
    endDate: Date | null
  }
}

/** Pipeline order, used only to pick one row when a person is (legacy data) twice in the same campaign. */
const STATUS_RANK: Record<InfluencerStatus, number> = {
  PROSPECT: 0,
  OUTREACH: 1,
  NEGOTIATING: 2,
  AGREED: 3,
  CONTRACTED: 4,
  SHIPPING: 5,
  POSTED: 6,
  COMPLETED: 7,
}

/**
 * One row per campaign. A person is one creator, so two of her profiles in the
 * same campaign (which the member guard forbids today but older data may hold)
 * must not show as two collaborations: the row of the profile asked for wins,
 * else the most advanced status, else the oldest membership.
 */
function onePerCampaign(rows: HistoryRow[], requestedId: string): HistoryRow[] {
  const byCampaign = new Map<string, HistoryRow>()
  for (const row of rows) {
    const prev = byCampaign.get(row.campaign.id)
    if (!prev) {
      byCampaign.set(row.campaign.id, row)
      continue
    }
    const better =
      Number(row.influencerId === requestedId) - Number(prev.influencerId === requestedId) ||
      STATUS_RANK[row.status] - STATUS_RANK[prev.status] ||
      prev.createdAt.getTime() - row.createdAt.getTime()
    if (better > 0) byCampaign.set(row.campaign.id, row)
  }
  return Array.from(byCampaign.values())
}

/** Newest campaign first by start date; campaigns without dates last; ties by the membership's createdAt (newest first). */
function byStartDateDesc(a: HistoryRow, b: HistoryRow): number {
  const as = a.campaign.startDate?.getTime() ?? null
  const bs = b.campaign.startDate?.getTime() ?? null
  if (as === null && bs === null) return b.createdAt.getTime() - a.createdAt.getTime()
  if (as === null) return 1
  if (bs === null) return -1
  return bs - as || b.createdAt.getTime() - a.createdAt.getTime()
}

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
        personId: true,
        engagementRate: true,
        followers: true,
      },
    })

    if (!influencer) {
      return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
    }

    // Every profile of the same person (a profile with no person is its own person)
    const profiles: Array<{ id: string; username: string; platform: Platform }> = influencer.personId
      ? await prisma.influencer.findMany({
          where: { personId: influencer.personId },
          select: { id: true, username: true, platform: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [{ id: influencer.id, username: influencer.username, platform: influencer.platform }]
    if (!profiles.some(p => p.id === influencer.id)) {
      profiles.unshift({ id: influencer.id, username: influencer.username, platform: influencer.platform })
    }
    const profileById = new Map(profiles.map(p => [p.id, p]))

    // Fetch all campaign participations of the person, with campaign details
    const memberships: HistoryRow[] = await prisma.campaignInfluencer.findMany({
      where: { influencerId: { in: profiles.map(p => p.id) } },
      select: {
        influencerId: true,
        agreedFee: true,
        cost: true,
        status: true,
        createdAt: true,
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
    })
    const campaignInfluencers = onePerCampaign(memberships, id).sort(byStartDateDesc)

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
      // The row of the MEMBER profile: the overview already credits to it what her other profiles published
      const mine = overviews[i]?.perInfluencer.find(p => p.influencerId === ci.influencerId) ?? null
      const cost = memberCost(ci)
      const emvExtended = mine?.emvExtended ?? 0
      const profile = profileById.get(ci.influencerId)
      return {
        campaignId: ci.campaign.id,
        campaignName: ci.campaign.name,
        campaignType: ci.campaign.type,
        /** The profile of the person that holds this membership (Instagram, TikTok...). */
        profile: profile
          ? { id: profile.id, username: profile.username, platform: profile.platform }
          : { id: ci.influencerId, username: influencer.username, platform: influencer.platform },
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
        /** Real views of the creator's publications in this campaign — the base of the ER (4B). */
        views: mine?.views ?? 0,
        audience: mine?.audience.total ?? 0,
        /** Tasa de engagement sobre vistas (4B); null when the real sample is insufficient. */
        engagementRate: mine?.er.value ?? null,
      }
    })

    // --- Scoring ---

    const totalCampaigns = campaignInfluencers.length

    // Engagement score (0-100): normalize engagement rate
    // Typical good ER is 3-6%, exceptional is 10%+
    const engagementScore = Math.min(100, (influencer.engagementRate / 6) * 100)

    // Delivery reliability: % of AGREED campaigns (CLOSED_STATUSES) reaching POSTED or COMPLETED.
    // A PROSPECT/OUTREACH/NEGOTIATING row (a pool, a creator never confirmed) is not in the denominator.
    const deliveredStatuses: InfluencerStatus[] = [
      InfluencerStatus.POSTED,
      InfluencerStatus.COMPLETED,
    ]
    const closedRows = campaignInfluencers.filter((ci) => CLOSED_STATUSES.has(ci.status))
    const deliveredCount = closedRows.filter((ci) =>
      deliveredStatuses.includes(ci.status)
    ).length
    const reliabilityScore =
      closedRows.length > 0 ? (deliveredCount / closedRows.length) * 100 : 0

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
      /** What the reliability is computed over: published campaigns among the agreed ones (0/0 = no agreed campaign yet). */
      reliabilityBasis: { delivered: deliveredCount, closed: closedRows.length },
      /** Ratio EMV score (kept under its old key for the widget). */
      roi: Math.round(ratioEmvScore),
      ratioEmv: Math.round(ratioEmvScore),
      consistency: Math.round(consistencyScore),
    }

    return NextResponse.json({
      influencerId: influencer.id,
      username: influencer.username,
      platform: influencer.platform,
      /** Every profile of the person whose history this is (the one asked for included). */
      profiles,
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
