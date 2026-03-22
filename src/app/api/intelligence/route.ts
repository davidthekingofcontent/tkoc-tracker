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
import { getMarketBenchmark, evaluateFee, type BenchmarkQuery } from '@/lib/market-benchmark'
import { prisma } from '@/lib/db'
import { calculateCampaignEMV } from '@/lib/emv'

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
        return handleDealAdvisor(data as unknown as DealAdvisorInput)

      case 'risk-signals':
        return handleRiskSignals(data as unknown as RiskAssessmentInput)

      case 'repeat-radar':
        return handleRepeatRadar(data as { campaignId?: string })

      case 'playbook':
        return handlePlaybook(data as { campaignId: string })

      case 'benchmark':
        return handleBenchmark(data as unknown as BenchmarkQuery)

      case 'evaluate-fee':
        return handleEvaluateFee(data as { fee: number; platform: string; followers: number; format?: string })

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

function handleDealAdvisor(input: DealAdvisorInput) {
  const result = analyzeDeal(input)
  return NextResponse.json(result)
}

function handleRiskSignals(input: RiskAssessmentInput) {
  const result = assessRisks(input)
  return NextResponse.json(result)
}

async function handleRepeatRadar(data: { campaignId?: string }) {
  try {
    // Get all influencers with their campaign performance
    const where = data.campaignId
      ? { campaigns: { some: { campaignId: data.campaignId } } }
      : { campaigns: { some: {} } }

    const influencers = await prisma.influencer.findMany({
      where,
      include: {
        campaigns: {
          include: {
            campaign: { select: { id: true, name: true, status: true } },
          },
        },
        media: {
          select: {
            likes: true,
            comments: true,
            views: true,
            shares: true,
            saves: true,
            campaignId: true,
          },
        },
      },
      take: 100,
    })

    const inputs: RepeatRadarInput[] = influencers.map(inf => {
      // Group media by campaign
      const campaignMap = new Map<string, {
        campaignId: string
        campaignName: string
        agreedFee: number
        totalLikes: number
        totalComments: number
        totalViews: number
        totalShares: number
        totalSaves: number
        mediaPosts: number
        status: string
        contentDelivered: boolean
        emvGenerated: number
      }>()

      for (const ci of inf.campaigns) {
        const campaignMedia = inf.media.filter(m => m.campaignId === ci.campaignId)
        const totalLikes = campaignMedia.reduce((s, m) => s + m.likes, 0)
        const totalComments = campaignMedia.reduce((s, m) => s + m.comments, 0)
        const totalViews = campaignMedia.reduce((s, m) => s + m.views, 0)
        const totalShares = campaignMedia.reduce((s, m) => s + m.shares, 0)
        const totalSaves = campaignMedia.reduce((s, m) => s + m.saves, 0)

        const emvResult = calculateCampaignEMV(campaignMedia.map(m => ({
          platform: inf.platform,
          impressions: 0,
          reach: 0,
          views: m.views,
          likes: m.likes,
          comments: m.comments,
          shares: m.shares,
          saves: m.saves,
        })))

        campaignMap.set(ci.campaignId, {
          campaignId: ci.campaignId,
          campaignName: ci.campaign.name,
          agreedFee: ci.agreedFee || 0,
          totalLikes,
          totalComments,
          totalViews,
          totalShares,
          totalSaves,
          mediaPosts: campaignMedia.length,
          status: ci.status,
          contentDelivered: ci.contentDelivered,
          emvGenerated: emvResult.extended,
        })
      }

      return {
        influencerId: inf.id,
        username: inf.username,
        displayName: inf.displayName,
        avatarUrl: inf.avatarUrl,
        platform: inf.platform,
        followers: inf.followers,
        campaigns: Array.from(campaignMap.values()),
      }
    })

    const { analyzeRepeatBatch: analyze } = await import('@/lib/repeat-radar')
    const results = analyze(inputs)

    return NextResponse.json({ results })
  } catch (error) {
    console.error('[Intelligence] Repeat Radar error:', error)
    return NextResponse.json({ error: 'Failed to analyze repeat radar' }, { status: 500 })
  }
}

async function handlePlaybook(data: { campaignId: string }) {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: data.campaignId },
      include: {
        influencers: {
          include: { influencer: true },
        },
        media: true,
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const totalSpent = campaign.influencers.reduce((sum, ci) => sum + (ci.agreedFee || 0), 0)

    // Calculate EMV
    const emvResult = calculateCampaignEMV(campaign.media.map(m => ({
      platform: m.platform,
      impressions: m.impressions,
      reach: m.reach,
      views: m.views,
      likes: m.likes,
      comments: m.comments,
      shares: m.shares,
      saves: m.saves,
    })))

    const influencerData = campaign.influencers.map(ci => {
      const infMedia = campaign.media.filter(m => m.influencerId === ci.influencerId)
      return {
        username: ci.influencer.username,
        platform: ci.influencer.platform,
        agreedFee: ci.agreedFee || 0,
        totalLikes: infMedia.reduce((s, m) => s + m.likes, 0),
        totalComments: infMedia.reduce((s, m) => s + m.comments, 0),
        totalViews: infMedia.reduce((s, m) => s + m.views, 0),
        totalShares: infMedia.reduce((s, m) => s + m.shares, 0),
        totalSaves: infMedia.reduce((s, m) => s + m.saves, 0),
        mediaPosts: infMedia.length,
        mediaTypes: [...new Set(infMedia.map(m => m.mediaType))],
      }
    })

    const playbook = generatePlaybook({
      campaignName: campaign.name,
      objective: campaign.objective || 'awareness',
      totalSpent,
      totalEMV: emvResult.extended,
      influencers: influencerData,
    })

    return NextResponse.json(playbook)
  } catch (error) {
    console.error('[Intelligence] Playbook error:', error)
    return NextResponse.json({ error: 'Failed to generate playbook' }, { status: 500 })
  }
}

async function handleBenchmark(query: BenchmarkQuery) {
  const result = await getMarketBenchmark(query)
  return NextResponse.json(result)
}

function handleEvaluateFee(data: { fee: number; platform: string; followers: number; format?: string }) {
  const result = evaluateFee(data.fee, data.platform, data.followers, data.format)
  return NextResponse.json(result)
}
