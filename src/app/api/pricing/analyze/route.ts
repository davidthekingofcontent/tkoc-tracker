/**
 * Pricing Analysis API — Orchestrates Deal Advisor + Market Benchmark + CPM Calculator
 * into a unified pricing analysis response.
 *
 * POST /api/pricing/analyze
 * Body: {
 *   username?, platform, followers, avgViews, avgLikes, avgComments, engagementRate, fee,
 *   format?      — REEL | POST | STORY | VIDEO | INTEGRATION | DEDICATED | SHORT (normalized)
 *   country?     — ISO-3166 alpha-2 of the campaign/creator → market multiplier (ES = 1.0)
 *   terms?       — DealTerms: rightsDays, whitelisting, exclusivityDays, urgent, crossposting, bundle3, recurring6m
 *   brandId?     — use the brand's benchmark overrides (Ajustes → Benchmarks)
 *   locale?      — 'es' (default) | 'en' for the narratives
 * }
 *
 * Can also accept a username to auto-lookup from database.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { analyzeDeal, type DealAdvisorResult } from '@/lib/deal-advisor'
import { calculateCPM, detectTier, formatLabel } from '@/lib/cpm-calculator'
import { loadBenchmarkConfig } from '@/lib/benchmarks-server'
import { normalizeFormat, normalizePlatform, type AppliedModifier, type DealTerms, type FeeFormat, type PercentileLabels } from '@/lib/benchmarks'
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
  format?: string | null
  country?: string | null
  terms?: DealTerms | null
  brandId?: string | null
  locale?: 'es' | 'en'
}

export interface PricingScenario {
  fee: number
  cpm: number
  verdict: string
  /** Percentile the scenario corresponds to and its label ("Buen precio"…). */
  percentile: 'p25' | 'p50' | 'p75'
  label: string
}

export interface PricingAnalysisResult {
  // Deal Advisor results
  deal: DealAdvisorResult

  // CPM analysis
  cpm: {
    real: number | null
    target: number | null
    max: number | null
    trafficLight: 'green' | 'yellow' | 'red' | 'gray'
    feeRecommended: number | null
    feeMax: number | null
  }

  // Three scenarios = p25 / p50 / p75 of the market-scaled, modifier-adjusted range
  scenarios: {
    conservative: PricingScenario
    realistic: PricingScenario
    optimistic: PricingScenario
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

  // Benchmark context
  format: FeeFormat
  country: string | null
  marketMultiplier: number
  labels: PercentileLabels
  appliedModifiers: AppliedModifier[]
  /** p50 after market and modifiers — the reference price to negotiate around. */
  referenceFee: number
  benchmarkVersion: string
  locale: 'es' | 'en'
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json() as PricingRequest
    let { username, followers, avgViews, avgLikes, avgComments, engagementRate } = body
    const { platform, fee, terms, brandId } = body
    let country = body.country ? String(body.country).toUpperCase() : null
    const locale: 'es' | 'en' = body.locale === 'en' ? 'en' : 'es'
    const es = locale === 'es'

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
        country = country || (influencer.country ? influencer.country.toUpperCase() : null)
        fromDatabase = true
      }
    }

    if (!followers || !avgViews) {
      return NextResponse.json({ error: 'Followers and avgViews are required (or provide a valid username)' }, { status: 400 })
    }

    const config = await loadBenchmarkConfig(brandId)
    const plat = normalizePlatform(platform)
    const format = normalizeFormat(plat, body.format)
    const tier = detectTier(followers)

    // 1. Deal Advisor analysis (market range × country × modifiers × performance)
    const deal = analyzeDeal({
      username: username || 'creator',
      platform: plat,
      followers,
      avgViews,
      avgLikes: avgLikes || 0,
      avgComments: avgComments || 0,
      engagementRate: engagementRate || 0,
      askedFee: fee,
      format,
      country,
      terms: terms || null,
    }, { config, locale })

    // 2. CPM analysis (fee ÷ median views of the format × 1000 vs format × tier thresholds)
    const cpmResult = calculateCPM({
      platform: plat,
      followers,
      avgViews,
      fee,
      format,
    }, locale, config)

    // 3. Three scenarios = p25 / p50 / p75 of the market-scaled, modifier-adjusted range
    const labels = deal.percentileLabels
    const fmtStr = formatLabel(format, locale)
    const cpmAt = (f: number) => (avgViews > 0 ? Math.round((f / avgViews) * 1000 * 100) / 100 : 0)
    const cpmNote = (f: number) => {
      const c = cpmAt(f)
      if (cpmResult.cpmTarget === null || cpmResult.cpmMax === null) return ''
      if (c <= cpmResult.cpmTarget) return es ? ` CPM €${c.toFixed(1)}, dentro del objetivo (€${cpmResult.cpmTarget}).` : ` CPM €${c.toFixed(1)}, within target (€${cpmResult.cpmTarget}).`
      if (c <= cpmResult.cpmMax) return es ? ` CPM €${c.toFixed(1)}, por encima del objetivo (€${cpmResult.cpmTarget}) pero bajo el máximo (€${cpmResult.cpmMax}).` : ` CPM €${c.toFixed(1)}, above target (€${cpmResult.cpmTarget}) but under the max (€${cpmResult.cpmMax}).`
      return es ? ` CPM €${c.toFixed(1)}, por encima del máximo aceptable (€${cpmResult.cpmMax}).` : ` CPM €${c.toFixed(1)}, above the max acceptable (€${cpmResult.cpmMax}).`
    }
    const eur = (n: number) => `€${Math.round(n).toLocaleString()}`
    const { p25, p50, p75 } = deal.marketRange
    const scenarios: PricingAnalysisResult['scenarios'] = {
      conservative: {
        fee: p25,
        cpm: cpmAt(p25),
        percentile: 'p25',
        label: labels.p25,
        verdict: es
          ? `A ${eur(p25)} por ${fmtStr} sería un ${labels.p25.toLowerCase()} (p25 del mercado para su tier).${cpmNote(p25)}`
          : `At ${eur(p25)} per ${fmtStr} this would be a ${labels.p25.toLowerCase()} (market p25 for this tier).${cpmNote(p25)}`,
      },
      realistic: {
        fee: p50,
        cpm: cpmAt(p50),
        percentile: 'p50',
        label: labels.p50,
        verdict: es
          ? `A ${eur(p50)} por ${fmtStr} es el ${labels.p50.toLowerCase()} (p50): un acuerdo justo para ambas partes.${cpmNote(p50)}`
          : `At ${eur(p50)} per ${fmtStr} this is the ${labels.p50.toLowerCase()} (p50): a fair deal for both sides.${cpmNote(p50)}`,
      },
      optimistic: {
        fee: p75,
        cpm: cpmAt(p75),
        percentile: 'p75',
        label: labels.p75,
        verdict: es
          ? `A ${eur(p75)} por ${fmtStr} estamos en el ${labels.p75.toLowerCase()} (p75): solo si la calidad del contenido o el encaje de audiencia son excepcionales.${cpmNote(p75)}`
          : `At ${eur(p75)} per ${fmtStr} we are at the ${labels.p75.toLowerCase()} (p75): only if content quality or audience fit is exceptional.${cpmNote(p75)}`,
      },
    }

    // 4. Tier-based warnings (Macro vs Micro rules)
    const tierWarnings: string[] = []
    if (tier === 'MACRO' || tier === 'MEGA') {
      tierWarnings.push(es
        ? 'Los creadores Macro/Mega NUNCA deberían ir solo a gifting. Negociar siempre un fee.'
        : 'Macro/Mega creators should NEVER be gifting-only. Always negotiate a paid fee.')
      tierWarnings.push(es
        ? 'Dejar claros en el contrato los derechos de uso y la exclusividad (y cobrarlos como modificadores).'
        : 'Ensure usage rights and exclusivity terms are clearly defined in the contract (and priced as modifiers).')
    }
    if (tier === 'NANO') {
      tierWarnings.push(es
        ? 'Los creadores Nano suelen aceptar gifting. Valorar colaboraciones solo producto para testar.'
        : 'Nano creators often accept gifting. Consider product-only collaborations for testing.')
      tierWarnings.push(es
        ? 'Mucho engagement pero poco alcance: ideales para comunidad y conversaciones de nicho.'
        : 'High engagement but small reach — best for community and niche conversations.')
    }
    if (tier === 'MICRO') {
      tierWarnings.push(es
        ? 'Los creadores Micro funcionan con gifting o con fee. Negociación flexible.'
        : 'Micro creators can work with gifting or paid fees. Flexible negotiation possible.')
    }
    if (format === 'STORY') {
      tierWarnings.push(es
        ? `El rango es por UNA story; un pack de 3 stories se valora en ×${config.storyPackMultiplier}.`
        : `The range is for ONE story; a pack of 3 stories is valued at ×${config.storyPackMultiplier}.`)
    }

    const result: PricingAnalysisResult = {
      deal,
      cpm: {
        real: cpmResult.cpmReal,
        target: cpmResult.cpmTarget,
        max: cpmResult.cpmMax,
        trafficLight: cpmResult.trafficLight,
        feeRecommended: cpmResult.feeRecommended,
        feeMax: cpmResult.feeMax,
      },
      scenarios,
      creator: {
        username: username || 'creator',
        platform: plat,
        followers,
        avgViews,
        tier,
        fromDatabase,
      },
      tierWarnings,
      format,
      country,
      marketMultiplier: deal.marketMultiplier,
      labels,
      appliedModifiers: deal.appliedModifiers,
      referenceFee: deal.referenceFee,
      benchmarkVersion: config.version,
      locale,
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('[Pricing API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
