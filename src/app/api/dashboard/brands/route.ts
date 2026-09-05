/**
 * GET /api/dashboard/brands — the agency's campaigns grouped by brand (derived
 * from the first target account, else the first hashtag, else the campaign
 * name), each brand valued by SUMMING the per-campaign overviews built on
 * src/lib/metrics.ts (the single source of truth) — nothing is recomputed here.
 *
 *  - Posts that live in several campaigns of the same brand (annual + monthly)
 *    count ONCE: rows are deduplicated by post before summing.
 *  - Cost is per campaign membership (fee acordado, si no coste — decision 6).
 *  - Audiencia follows decision 5 (alcance real → impresiones → vistas →
 *    estimación etiquetada). The ER follows 4A: interacciones of the
 *    publications WITH a real audience figure ÷ that real audience — estimates
 *    are reported apart and never enter the ER.
 *  - EMV ÷ cost is the "Ratio EMV" (×2,4). It is never called ROI (decision 9B).
 *  - Deleted publications stay in the totals and are counted apart (7B).
 *
 * BRAND users never receive cost or the EMV ratio.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { computeCampaignOverviews } from '@/lib/campaign-overview'
import { dedupeMediaByPost } from '@/lib/campaign-capture'
import {
  emvRatioOf,
  engagementRateOf,
  engagementsOf,
  sumAudience,
  type AudienceResult,
  type AudienceTotals,
  type PerMediaMetrics,
} from '@/lib/metrics'

interface BrandData {
  brandName: string
  campaignCount: number
  totalInfluencers: number
  /** Distinct posts across the brand's campaigns. */
  totalMedia: number
  /** Publications the creators deleted — kept in the totals, counted apart (7B). */
  mediaDeleted: number
  /** Audiencia (real + estimada, with the split and the share that is estimated). */
  audience: AudienceTotals
  /** @deprecated Legacy alias of `audience.total`. */
  totalReach: number
  /** Interacciones = likes + comentarios + shares + saves (3A). */
  totalEngagements: number
  totalViews: number
  /** Σ fees acordados of the brand's campaign memberships; 0 for BRAND users. */
  totalCost: number
  /** Extended EMV — the one EMV the client sees ("Valor mediático equivalente (estimado)"). */
  totalEMV: number
  /** Interacciones of the real-audience publications ÷ audiencia real × 100 (4A); null without a real base. */
  engagementRate: number | null
  /** Always 0 since 4A (estimates never enter the ER); kept for old consumers. */
  erEstimatedShare: number
  /** @deprecated Legacy alias of `engagementRate` (0 when null). */
  avgEngagementRate: number
  /** Ratio EMV = EMV ÷ cost, shown as "×2,4"; null without cost and for BRAND users. Never ROI. */
  emvRatio: number | null
  topPlatforms: string[]
  campaigns: Array<{
    id: string
    name: string
    status: string
    type: string
    influencerCount: number
    mediaCount: number
    platforms: string[]
    startDate: string
    endDate: string | null
  }>
}

function deriveBrandName(campaign: {
  name: string
  targetAccounts: string[]
  targetHashtags: string[]
}): string {
  // Use first target account as the brand name (e.g. "@vileda.es" -> "Vileda")
  if (campaign.targetAccounts.length > 0) {
    const account = campaign.targetAccounts[0]
    const cleaned = account.replace(/^@/, '').replace(/\.\w{2,3}$/, '')
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }

  // Fallback: use the first hashtag (e.g. "#vileda" -> "Vileda")
  if (campaign.targetHashtags.length > 0) {
    const tag = campaign.targetHashtags[0]
    const cleaned = tag.replace(/^#/, '')
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }

  // Last fallback: extract from campaign name (first word)
  const firstWord = campaign.name.split(/[\s\-_]/)[0]
  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1)
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    const isBrand = session.role === 'BRAND'

    // Build where clause based on user role
    let campaignWhere: Record<string, unknown> = {}
    if (session.role === 'EMPLOYEE') {
      campaignWhere = {
        OR: [
          { userId: session.id },
          { assignments: { some: { userId: session.id } } },
        ],
      }
    } else if (isBrand) {
      campaignWhere = { userId: session.id }
    }

    // Campaign rows: only what the grouping and the post de-duplication need.
    // Every figure comes from the overviews below.
    const campaigns = await prisma.campaign.findMany({
      where: campaignWhere,
      select: {
        id: true, name: true, status: true, type: true, platforms: true,
        startDate: true, endDate: true, targetAccounts: true, targetHashtags: true,
        media: {
          select: {
            id: true, externalId: true, permalink: true, platform: true,
            views: true, likes: true, comments: true, shares: true, saves: true,
          },
        },
        _count: { select: { influencers: true, media: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // One overview per campaign (bounded concurrency), then sum per brand.
    const overviews = await computeCampaignOverviews(campaigns.map(c => c.id))

    const groups = new Map<string, typeof campaigns>()
    for (const campaign of campaigns) {
      const brandName = deriveBrandName(campaign)
      const list = groups.get(brandName) ?? []
      list.push(campaign)
      groups.set(brandName, list)
    }

    const brands: BrandData[] = []
    for (const [brandName, list] of groups) {
      const influencerIds = new Set<string>()
      const perMediaById = new Map<string, PerMediaMetrics>()
      const topPlatforms: string[] = []
      const rows: (typeof campaigns)[number]['media'] = []
      let cost = 0

      for (const campaign of list) {
        const overview = overviews.get(campaign.id)
        if (overview) {
          cost += overview.totals.cost
          for (const p of overview.perInfluencer) influencerIds.add(p.influencerId)
          for (const pm of overview.perMedia) perMediaById.set(pm.id, pm)
        }
        rows.push(...campaign.media)
        for (const p of campaign.platforms) if (!topPlatforms.includes(p)) topPlatforms.push(p)
      }

      // The same post in the annual and the monthly campaign counts once for the brand.
      const distinct = dedupeMediaByPost(rows)
      let engagements = 0, views = 0, emvExtended = 0, mediaDeleted = 0
      // 4A: ER numerator = interacciones of the SAME rows that carry a real audience
      // figure (mirrors isRealIdx in campaign-overview.ts), never the brand total.
      let engagementsReal = 0
      const audienceResults: AudienceResult[] = []
      for (const m of distinct) {
        views += m.views || 0
        engagements += engagementsOf(m)
        const pm = perMediaById.get(m.id)
        if (!pm) continue
        emvExtended += pm.emvExtended
        if (pm.isDeleted) mediaDeleted++
        audienceResults.push({ value: pm.audience, basis: pm.audienceBasis, estimated: pm.audienceEstimated })
        if (!pm.audienceEstimated && pm.audience > 0) engagementsReal += engagementsOf(m)
      }

      const audience = sumAudience(audienceResults)
      const er = engagementRateOf(engagementsReal, audience)
      cost = isBrand ? 0 : Math.round(cost * 100) / 100
      emvExtended = Math.round(emvExtended * 100) / 100

      brands.push({
        brandName,
        campaignCount: list.length,
        totalInfluencers: influencerIds.size,
        totalMedia: distinct.length,
        mediaDeleted,
        audience,
        totalReach: audience.total,
        totalEngagements: engagements,
        totalViews: views,
        totalCost: cost,
        totalEMV: emvExtended,
        engagementRate: er.value,
        erEstimatedShare: er.estimatedShare,
        avgEngagementRate: er.value ?? 0,
        emvRatio: isBrand ? null : emvRatioOf(emvExtended, cost),
        topPlatforms,
        campaigns: list.map(campaign => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          type: campaign.type,
          influencerCount: campaign._count.influencers,
          mediaCount: campaign._count.media,
          platforms: campaign.platforms,
          startDate: campaign.startDate.toISOString(),
          endDate: campaign.endDate?.toISOString() || null,
        })),
      })
    }

    // Sort brands by total EMV descending
    brands.sort((a, b) => b.totalEMV - a.totalEMV)

    // Aggregate totals (spend is withheld from BRAND users)
    const totals = {
      totalBrands: brands.length,
      totalCampaigns: campaigns.length,
      totalSpend: isBrand ? 0 : Math.round(brands.reduce((sum, b) => sum + b.totalCost, 0) * 100) / 100,
      totalEMV: Math.round(brands.reduce((sum, b) => sum + b.totalEMV, 0) * 100) / 100,
    }

    return NextResponse.json({ definitionsVersion: 2, brands, totals })
  } catch (error) {
    console.error('Brand dashboard error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
