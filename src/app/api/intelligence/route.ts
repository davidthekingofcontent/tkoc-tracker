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
import { generatePlaybook } from '@/lib/campaign-playbook'
import { buildPlaybookInput } from '@/lib/aprender-input'
import { getMarketBenchmark, evaluateFeeBlended, type BenchmarkQuery } from '@/lib/market-benchmark'
import { loadBenchmarkConfig, loadInternalStats } from '@/lib/benchmarks-server'
import { detectTier, getCpmThreshold, normalizeFormat, normalizePlatform } from '@/lib/benchmarks'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { memberCost, type CampaignOverview, type PerInfluencerMetrics } from '@/lib/metrics'

type SessionUser = NonNullable<Awaited<ReturnType<typeof getSession>>>

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
        return handlePlaybook(data as unknown as PlaybookRequest, session)

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

/**
 * Repeat Radar: every (creator, campaign) figure comes from that campaign's
 * overview — EMV = perInfluencer.emvExtended, cost = fee acordado si no coste
 * (perInfluencer.cost, memberCost as fallback), posts = perInfluencer.media —
 * so the radar can never disagree with the campaign page.
 *
 * Decision 4B: the radar's ER and CPM stand on REAL views only. The caller
 * hands over perInfluencer.er.{numerator, denominator, pieces} of each campaign
 * (interacciones and plausible views of the SAME pieces, as the overview
 * published them); the radar aggregates those and applies the same publication
 * rules (≥ 1 piece, ≥ 500 views, ≤ 100 %). Estimates, raw views and profile
 * ERs never enter the radar.
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
    const overviews = await computeOverviews(campaignIds)

    // perInfluencer of every campaign, keyed campaignId → influencerId
    const perInfluencerByCampaign = new Map<string, Map<string, PerInfluencerMetrics>>()
    for (const [cid, ov] of overviews) {
      perInfluencerByCampaign.set(cid, new Map(ov.perInfluencer.map(p => [p.influencerId, p])))
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
        return {
          campaignId: ci.campaignId,
          campaignName: ci.campaign.name,
          agreedFee: p?.cost ?? memberCost(ci),
          // 4B: the overview's real-views base of this creator in this campaign
          realViews: p?.er.denominator ?? 0,
          realViewsPieces: p?.er.pieces ?? 0,
          engagementsOnViews: p?.er.numerator ?? 0,
          engagements: p?.engagements ?? 0,
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

/**
 * Campaign Playbook (Aprender tab). Built from the SAME projection of the
 * overview the report learnings use (buildPlaybookInput → generatePlaybook), so
 * the tab and the report never name different creators. A BRAND session only
 * gets the client audience (no cost, CPM, Ratio EMV, budget, skip list) and
 * only for its own campaigns.
 */
async function handlePlaybook(data: PlaybookRequest, session: SessionUser) {
  try {
    // Spanish is the product default; English only when the client explicitly asks for it.
    const locale: 'es' | 'en' = data.locale === 'en' ? 'en' : 'es'
    if (!data.campaignId || typeof data.campaignId !== 'string') {
      return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    }

    const [campaign, overview] = await Promise.all([
      prisma.campaign.findUnique({ where: { id: data.campaignId }, select: { name: true, objective: true, userId: true } }),
      computeCampaignOverview(data.campaignId),
    ])

    if (!campaign || !overview) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }
    const isBrand = session.role === 'BRAND'
    if (isBrand && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const playbook = generatePlaybook(
      buildPlaybookInput({ overview, campaignName: campaign.name, objective: campaign.objective }),
      locale,
      { audience: isBrand ? 'client' : 'agency' }
    )

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
