/**
 * Pricing Analysis API — Orchestrates Deal Advisor + Market Benchmark + CPM Calculator
 * into a unified pricing analysis response.
 *
 * POST /api/pricing/analyze
 * Body: { username?, platform, followers, avgViews, avgLikes, avgComments, engagementRate, fee, format? }
 *
 * Can also accept a username to auto-lookup from database.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { analyzeDeal, type DealAdvisorResult } from '@/lib/deal-advisor'
import { calculateCPM, detectTier } from '@/lib/cpm-calculator'
import { prisma } from '@/lib/db'

interface PricingRequest {
  // Either provide username to lookup, or manual data
  username?: string
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  followers: number
  avgViews: number
  avgLikes: number
  avgComments: number
  engagementRate: number
  fee: number
  format?: string
}

export interface PricingAnalysisResult {
  // Deal Advisor results
  deal: DealAdvisorResult

  // CPM analysis
  cpm: {
    real: number | null
    target: number | null
    trafficLight: 'green' | 'yellow' | 'red' | 'gray'
  }

  // Three scenarios
  scenarios: {
    conservative: { fee: number; cpm: number; verdict: string }
    realistic: { fee: number; cpm: number; verdict: string }
    optimistic: { fee: number; cpm: number; verdict: string }
  }

  // Creator context
  creator: {
    username: string
    platform: string
    followers: number
    avgViews: number
    tier: string
    fromDatabase: boolean
  }

  // Macro/Micro rules
  tierWarnings: string[]
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as PricingRequest
    let { username, platform, followers, avgViews, avgLikes, avgComments, engagementRate, fee, format } = body

    if (!platform || !fee) {
      return NextResponse.json({ error: 'Platform and fee are required' }, { status: 400 })
    }

    let fromDatabase = false

    // If username provided, try to lookup from database
    if (username && (!followers || !avgViews)) {
      const influencer = await prisma.influencer.findFirst({
        where: {
          username: username.replace('@', '').toLowerCase(),
          platform: platform,
        },
      })

      if (influencer) {
        followers = followers || influencer.followers
        avgViews = avgViews || influencer.avgViews
        avgLikes = avgLikes || influencer.avgLikes
        avgComments = avgComments || influencer.avgComments
        engagementRate = engagementRate || influencer.engagementRate
        fromDatabase = true
      }
    }

    if (!followers || !avgViews) {
      return NextResponse.json({ error: 'Followers and avgViews are required (or provide a valid username)' }, { status: 400 })
    }

    const tier = detectTier(followers)

    // 1. Deal Advisor analysis
    const deal = analyzeDeal({
      username: username || 'creator',
      platform,
      followers,
      avgViews,
      avgLikes: avgLikes || 0,
      avgComments: avgComments || 0,
      engagementRate: engagementRate || 0,
      askedFee: fee,
      format,
    })

    // 2. CPM analysis
    const cpmResult = calculateCPM({
      platform: platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
      followers,
      avgViews,
      fee,
    })

    // 3. Three scenarios based on market range
    const scenarios = {
      conservative: {
        fee: deal.recommendedFeeMin,
        cpm: avgViews > 0 ? Math.round((deal.recommendedFeeMin / avgViews) * 1000 * 100) / 100 : 0,
        verdict: `At €${deal.recommendedFeeMin.toLocaleString()}, this would be an excellent deal with a CPM well below benchmark.`,
      },
      realistic: {
        fee: Math.round((deal.recommendedFeeMin + deal.recommendedFeeMax) / 2),
        cpm: avgViews > 0 ? Math.round((((deal.recommendedFeeMin + deal.recommendedFeeMax) / 2) / avgViews) * 1000 * 100) / 100 : 0,
        verdict: `At €${Math.round((deal.recommendedFeeMin + deal.recommendedFeeMax) / 2).toLocaleString()}, this is a fair market deal — good value for both sides.`,
      },
      optimistic: {
        fee: deal.recommendedFeeMax,
        cpm: avgViews > 0 ? Math.round((deal.recommendedFeeMax / avgViews) * 1000 * 100) / 100 : 0,
        verdict: `At €${deal.recommendedFeeMax.toLocaleString()}, this is at the top of the range — only justified if content quality or audience fit is exceptional.`,
      },
    }

    // 4. Tier-based warnings (Macro vs Micro rules)
    const tierWarnings: string[] = []
    if (tier === 'MACRO' || tier === 'MEGA') {
      tierWarnings.push('Macro/Mega creators should NEVER be gifting-only. Always negotiate a paid fee.')
      tierWarnings.push('Ensure usage rights and exclusivity terms are clearly defined in the contract.')
    }
    if (tier === 'NANO') {
      tierWarnings.push('Nano creators often accept gifting. Consider product-only collaborations for testing.')
      tierWarnings.push('High engagement but small reach — best for community and niche conversations.')
    }
    if (tier === 'MICRO') {
      tierWarnings.push('Micro creators can work with gifting or paid fees. Flexible negotiation possible.')
    }

    const result: PricingAnalysisResult = {
      deal,
      cpm: {
        real: cpmResult.cpmReal,
        target: cpmResult.cpmTarget,
        trafficLight: cpmResult.trafficLight,
      },
      scenarios,
      creator: {
        username: username || 'creator',
        platform,
        followers,
        avgViews,
        tier,
        fromDatabase,
      },
      tierWarnings,
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Pricing API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
