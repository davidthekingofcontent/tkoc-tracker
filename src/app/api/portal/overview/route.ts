import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import {
  resolveBrandScope,
  resolveBrandScopeForBrandId,
} from '@/lib/brand-scope'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import { loadReportConfig } from '@/lib/report-config'
import type { CampaignOverview } from '@/lib/metrics'

// GET /api/portal/overview
// Brand-scoped, read-only overview: the brand's campaigns with the public
// figures of the SAME computation the portal campaign page and the report use
// (computeCampaignOverview, src/lib/campaign-overview.ts), with each campaign's
// ReportConfig applied — what the agency hid from this client leaves every
// figure — and the economics stripped. NO fees, NO budget, NO costs — ever.
// ADMIN may pass ?brandId= to preview the portal as a given brand.

const OVERVIEW_CONCURRENCY = 5

/**
 * One overview per campaign with that campaign's own hidden media/creators
 * excluded (the exclusions differ per campaign, so computeCampaignOverviews'
 * shared options cannot be used). Bounded concurrency; a campaign whose
 * computation fails is simply absent from the map (logged).
 */
async function computeBrandOverviews(campaignIds: string[]): Promise<Map<string, CampaignOverview>> {
  const out = new Map<string, CampaignOverview>()
  const ids = Array.from(new Set(campaignIds))
  for (let i = 0; i < ids.length; i += OVERVIEW_CONCURRENCY) {
    const chunk = ids.slice(i, i + OVERVIEW_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          const config = await loadReportConfig(id)
          const overview = await computeCampaignOverview(id, {
            exclude: { mediaIds: config.hiddenMediaIds, influencerIds: config.hiddenInfluencerIds },
          })
          return [id, overview ? stripEconomics(overview) : null] as const
        } catch (err) {
          console.error(`[portal/overview] overview failed for ${id}:`, err instanceof Error ? err.message : err)
          return [id, null] as const
        }
      })
    )
    for (const [id, ov] of results) if (ov) out.set(id, ov)
  }
  return out
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'BRAND' && session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const brandIdParam = searchParams.get('brandId')

    const scope =
      session.role === 'ADMIN' && brandIdParam
        ? await resolveBrandScopeForBrandId(brandIdParam)
        : await resolveBrandScope(session.id)

    // ?meta=1 — brand identity only (portal layout header); skips the campaign computations
    if (searchParams.get('meta') === '1') {
      return NextResponse.json({ brandName: scope.brandName, brandLogo: scope.brandLogo, campaigns: [] })
    }

    if (scope.campaignIds.length === 0) {
      return NextResponse.json({
        brandName: scope.brandName,
        brandLogo: scope.brandLogo,
        campaigns: [],
      })
    }

    const [campaigns, overviews] = await Promise.all([
      prisma.campaign.findMany({
        where: { id: { in: scope.campaignIds } },
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          platforms: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      computeBrandOverviews(scope.campaignIds),
    ])

    return NextResponse.json({
      brandName: scope.brandName,
      brandLogo: scope.brandLogo,
      campaigns: campaigns.map((c) => {
        const t = overviews.get(c.id)?.totals
        return {
          id: c.id,
          name: c.name,
          status: c.status,
          startDate: c.startDate,
          endDate: c.endDate,
          platforms: c.platforms,
          // null when the computation failed for this campaign: the page shows
          // nothing rather than a figure from another definition.
          counts: t
            ? {
                /** Members of the campaign (minus creators hidden from this client). */
                influencers: t.members,
                /** Creators with at least one publication. */
                creatorsActive: t.creatorsActive,
                /** Publications (minus the ones hidden from this client); deleted ones stay counted. */
                media: t.media,
                mediaDeleted: t.mediaDeleted,
              }
            : null,
          metrics: t
            ? {
                likes: t.likes,
                comments: t.comments,
                shares: t.shares,
                saves: t.saves,
                views: t.views,
                /** Interacciones = likes + comentarios + shares + saves (decision 3A). */
                engagements: t.engagements,
                /** @deprecated legacy alias of engagements (old clients summed views into it). */
                interactions: t.engagements,
                /** Audiencia total (real + estimada) with its estimated share, 0–1. */
                audience: {
                  total: t.audience.total,
                  real: t.audience.real,
                  estimated: t.audience.estimated,
                  estimatedShare: t.audience.estimatedShare,
                },
                /** ER = interacciones ÷ audiencia × 100; null without audience base. */
                engagementRate: t.er.value,
              }
            : null,
        }
      }),
    })
  } catch (error) {
    console.error('Portal overview error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
