/**
 * Intelligence API — Serves Creator Score, Deal Advisor, Risk Signals,
 * Repeat Radar, Campaign Playbook, and Market Benchmarks.
 *
 * POST /api/intelligence
 * Body: { type: "creator-score" | "deal-advisor" | "risk-signals" | "repeat-radar" | "playbook" | "benchmark", data: {...} }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { calculateCreatorScore, type CreatorScoreInput } from '@/lib/creator-score'
import { analyzeDeal, type DealAdvisorInput } from '@/lib/deal-advisor'
import { assessRisks, type RiskAssessmentInput } from '@/lib/risk-signals'
import { analyzeRepeatBatch, type RepeatRadarInput } from '@/lib/repeat-radar'
import { generatePlaybook, type PlaybookInput } from '@/lib/campaign-playbook'
import { getMarketBenchmark, evaluateFeeBlended, type BenchmarkQuery } from '@/lib/market-benchmark'
import { loadBenchmarkConfig, loadInternalStats } from '@/lib/benchmarks-server'
import { detectTier, getCpmThreshold, normalizeFormat, normalizePlatform } from '@/lib/benchmarks'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { memberCost, type CampaignOverview, type PerInfluencerMetrics } from '@/lib/metrics'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { type, data } = body as { type: string; data: Record<string, unknown> }

    switch (type) {
      case 'creator-score':
        return handleCreatorScore(data as unknown as CreatorScoreInput)

      case 'deal-advisor':
        return handleDealAdvisor(data as unknown as DealAdvisorRequest)

      case 'risk-signals':
        return handleRiskSignals(data as unknown as RiskAssessmentInput)

      case 'repeat-radar':
        return handleRepeatRadar(data as { campaignId?: string })

      case 'playbook':
        return handlePlaybook(data as unknown as PlaybookRequest)

      case 'benchmark':
        return handleBenchmark(data as unknown as BenchmarkQuery)

      case 'evaluate-fee':
        return handleEvaluateFee(data as unknown as EvaluateFeeRequest)

      default:
        return NextResponse.json({ error: `Unknown intelligence type: ${type}` }, { status: 400 })
    }
  } catch (error) {
    console.error('[Intelligence API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ============ HANDLERS ============

function handleCreatorScore(input: CreatorScoreInput) {
  const result = calculateCreatorScore(input)
  return NextResponse.json(result)
}

/**
 * Deal Advisor request = DealAdvisorInput (+ format, country, terms) plus
 * brandId (benchmark overrides) and locale ('es' default | 'en').
 */
type DealAdvisorRequest = DealAdvisorInput & { brandId?: string | null; locale?: 'es' | 'en' }

async function handleDealAdvisor(data: DealAdvisorRequest) {
  const { brandId, locale, ...input } = data
  const [config, internalStats] = await Promise.all([loadBenchmarkConfig(brandId), loadInternalStats()])
  const result = analyzeDeal(input, { config, locale: locale === 'en' ? 'en' : 'es', internalStats })
  return NextResponse.json(result)
}

/** Risk signals with the CPM ceiling taken from the shared benchmarks (format × tier, brand override). */
async function handleRiskSignals(data: RiskAssessmentInput & { brandId?: string | null }) {
  const { brandId, ...input } = data
  if (!(typeof input.cpmMax === 'number' && input.cpmMax > 0)) {
    const config = await loadBenchmarkConfig(brandId)
    const platform = normalizePlatform(input.platform)
    const threshold = getCpmThreshold(config, platform, detectTier(input.followers || 0), normalizeFormat(platform, input.format))
    input.cpmMax = threshold?.cpmMax ?? null
  }
  const result = assessRisks(input)
  return NextResponse.json(result)
}

/** One overview per campaign, a few at a time so the connection pool is not flooded. */
async function computeOverviews(ids: string[]): Promise<Map<string, CampaignOverview>> {
  const out = new Map<string, CampaignOverview>()
  const CHUNK = 5
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const results = await Promise.all(chunk.map(id => computeCampaignOverview(id)))
    results.forEach((o, j) => { if (o) out.set(chunk[j], o) })
  }
  return out
}

/** likes / comments / shares / saves split per creator (the overview only carries their sum). */
interface EngagementPieces { likes: number; comments: number; shares: number; saves: number }

function addPieces(acc: EngagementPieces | undefined, m: { likes: number; comments: number; shares: number; saves: number }): EngagementPieces {
  const a = acc || { likes: 0, comments: 0, shares: 0, saves: 0 }
  a.likes += m.likes || 0
  a.comments += m.comments || 0
  a.shares += m.shares || 0
  a.saves += m.saves || 0
  return a
}

/**
 * Repeat Radar: every (creator, campaign) figure comes from that campaign's
 * overview — EMV = perInfluencer.emvExtended, cost = fee acordado si no coste
 * (memberCost), views / audience (audience.total, the ER and CPM base) / posts
 * = the overview's — so the radar can never disagree with the campaign page.
 * Only the likes/comments/shares/saves split is read from the media rows, once
 * for all campaigns involved.
 */
async function handleRepeatRadar(data: { campaignId?: string }) {
  try {
    const where = data.campaignId
      ? { campaigns: { some: { campaignId: data.campaignId } } }
      : { campaigns: { some: {} } }

    const influencers = await prisma.influencer.findMany({
      where,
      select: {
        id: true, username: true, displayName: true, avatarUrl: true, platform: true, followers: true,
        campaigns: {
          select: {
            campaignId: true, agreedFee: true, cost: true, status: true, contentDelivered: true,
            campaign: { select: { id: true, name: true, status: true } },
          },
        },
      },
      take: 100,
    })

    const campaignIds = Array.from(new Set(influencers.flatMap(inf => inf.campaigns.map(ci => ci.campaignId))))
    const influencerIds = influencers.map(inf => inf.id)

    const [overviews, mediaRows] = await Promise.all([
      computeOverviews(campaignIds),
      campaignIds.length > 0
        ? prisma.media.findMany({
            where: { campaignId: { in: campaignIds }, influencerId: { in: influencerIds } },
            select: { campaignId: true, influencerId: true, likes: true, comments: true, shares: true, saves: true },
          })
        : Promise.resolve([]),
    ])

    // perInfluencer of every campaign, keyed campaignId → influencerId
    const perInfluencerByCampaign = new Map<string, Map<string, PerInfluencerMetrics>>()
    for (const [cid, ov] of overviews) {
      perInfluencerByCampaign.set(cid, new Map(ov.perInfluencer.map(p => [p.influencerId, p])))
    }

    // Engagement split per (campaign, creator) — same rows the overview valued
    const pieces = new Map<string, EngagementPieces>()
    for (const m of mediaRows) {
      const key = `${m.campaignId ?? ''}|${m.influencerId}`
      pieces.set(key, addPieces(pieces.get(key), m))
    }

    const inputs: RepeatRadarInput[] = influencers.map(inf => ({
      influencerId: inf.id,
      username: inf.username,
      displayName: inf.displayName,
      avatarUrl: inf.avatarUrl,
      platform: inf.platform,
      followers: inf.followers,
      campaigns: inf.campaigns.map(ci => {
        const p = perInfluencerByCampaign.get(ci.campaignId)?.get(inf.id)
        const e = pieces.get(`${ci.campaignId}|${inf.id}`)
        return {
          campaignId: ci.campaignId,
          campaignName: ci.campaign.name,
          agreedFee: p?.cost ?? memberCost(ci),
          totalLikes: e?.likes ?? 0,
          totalComments: e?.comments ?? 0,
          totalViews: p?.views ?? 0,
          audience: p?.audience.total ?? 0,
          totalShares: e?.shares ?? 0,
          totalSaves: e?.saves ?? 0,
          mediaPosts: p?.media ?? 0,
          status: ci.status,
          contentDelivered: ci.contentDelivered,
          emvGenerated: p?.emvExtended ?? 0,
        }
      }),
    }))

    const results = analyzeRepeatBatch(inputs)

    return NextResponse.json({ results })
  } catch (error) {
    console.error('[Intelligence] Repeat Radar error:', error)
    return NextResponse.json({ error: 'Failed to analyze repeat radar' }, { status: 500 })
  }
}

/** Playbook request: campaignId plus the UI locale ('es' default | 'en') the generated texts should use. */
interface PlaybookRequest {
  campaignId: string
  locale?: 'es' | 'en'
}

async function handlePlaybook(data: PlaybookRequest) {
  try {
    // Spanish is the product default; English only when the client explicitly asks for it.
    const locale: 'es' | 'en' = data.locale === 'en' ? 'en' : 'es'

    // The overview is the one source of truth: cost (fee acordado si no coste),
    // EMV extended with the brand's rates, views and publications per creator.
    const [campaign, overview, mediaRows] = await Promise.all([
      prisma.campaign.findUnique({ where: { id: data.campaignId }, select: { name: true, objective: true } }),
      computeCampaignOverview(data.campaignId),
      prisma.media.findMany({
        where: { campaignId: data.campaignId },
        select: { influencerId: true, likes: true, comments: true, shares: true, saves: true, mediaType: true },
      }),
    ])

    if (!campaign || !overview) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Only the likes/comments/shares/saves split and the formats come from the rows
    const pieces = new Map<string, EngagementPieces>()
    const formats = new Map<string, Set<string>>()
    for (const m of mediaRows) {
      pieces.set(m.influencerId, addPieces(pieces.get(m.influencerId), m))
      const f = formats.get(m.influencerId) || new Set<string>()
      f.add(m.mediaType)
      formats.set(m.influencerId, f)
    }

    const influencerData = overview.perInfluencer.map(p => {
      const e = pieces.get(p.influencerId)
      return {
        username: p.username,
        platform: p.platform,
        agreedFee: p.cost,
        totalLikes: e?.likes ?? 0,
        totalComments: e?.comments ?? 0,
        totalViews: p.views,
        totalShares: e?.shares ?? 0,
        totalSaves: e?.saves ?? 0,
        mediaPosts: p.media,
        mediaTypes: Array.from(formats.get(p.influencerId) ?? []),
      }
    })

    const playbook = generatePlaybook({
      campaignName: campaign.name,
      objective: campaign.objective || 'awareness',
      totalSpent: overview.totals.cost,
      totalEMV: overview.totals.emvExtended,
      influencers: influencerData,
    }, locale)

    return NextResponse.json(playbook)
  } catch (error) {
    console.error('[Intelligence] Playbook error:', error)
    return NextResponse.json({ error: 'Failed to generate playbook' }, { status: 500 })
  }
}

/** Benchmark query: platform, followers, format?, country?, brandId?, locale? — config + own stats are loaded inside. */
async function handleBenchmark(query: BenchmarkQuery) {
  const result = await getMarketBenchmark({
    ...query,
    locale: query.locale === 'en' ? 'en' : 'es',
  })
  return NextResponse.json(result)
}

interface EvaluateFeeRequest {
  fee: number
  platform: string
  followers: number
  format?: string | null
  country?: string | null
  brandId?: string | null
  locale?: 'es' | 'en'
}

/** Same blended, market-scaled range as the benchmark and the deal advisor. */
async function handleEvaluateFee(data: EvaluateFeeRequest) {
  const result = await evaluateFeeBlended(data.fee, {
    platform: data.platform,
    followers: data.followers,
    format: data.format,
    country: data.country,
    brandId: data.brandId,
    locale: data.locale === 'en' ? 'en' : 'es',
  })
  return NextResponse.json(result)
}
