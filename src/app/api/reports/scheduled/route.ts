/**
 * POST /api/reports/scheduled — generates a campaign report body on demand
 * (scheduled delivery is not implemented yet; the report is returned now).
 *
 * Every figure comes from the ONE campaign computation
 * (src/lib/campaign-overview.ts) so this report can never disagree with the
 * campaign page, the printable report or the portal. Definitions
 * (src/lib/metrics.ts, David 2026-09-05): interacciones = likes + comentarios +
 * shares + saves; audiencia = alcance real → impresiones → vistas → estimación
 * etiquetada; ER = interacciones ÷ audiencia; coste = fee acordado o coste;
 * EMV visible = extended; EMV ÷ coste se llama "Ratio EMV" (×2,4), nunca ROI.
 * Money is EUR, formatted es-ES. BRAND users never receive cost, CPM or ratio.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import type { AudienceBasis, CampaignOverview, PerInfluencerMetrics } from '@/lib/metrics'

// ============ es-ES formatting (no '$' anywhere) ============

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const INT = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })
const PCT = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function eur(v: number | null | undefined): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? EUR.format(v) : null
}
function int(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? INT.format(v) : '—'
}
function pct(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${PCT.format(v)} %` : '—'
}
/** "×2,4" — the Ratio EMV display form (decision 9B). */
function ratio(v: number | null | undefined): string | null {
  if (!(typeof v === 'number' && Number.isFinite(v))) return null
  return `×${new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v)}`
}

function basisLabel(b: AudienceBasis): string {
  switch (b) {
    case 'reach': return 'alcance real'
    case 'impressions': return 'impresiones reales'
    case 'views': return 'vistas reales'
    case 'estimated_story': return 'estimado (story)'
    case 'estimated_post': return 'estimado (post)'
    default: return 'sin base'
  }
}

// ============ report body ============

function influencerRow(p: PerInfluencerMetrics, showEconomics: boolean) {
  const base = {
    influencerId: p.influencerId,
    username: p.username,
    displayName: p.displayName,
    platform: p.platform,
    followers: p.followers,
    status: p.status,
    deliverablesPlanned: p.deliverablesPlanned,
    metrics: {
      mediaCount: p.media,
      stories: p.stories,
      posts: p.posts,
      deleted: p.deleted,
      views: p.views,
      engagements: p.engagements,
      audience: p.audience.total,
      audienceReal: p.audience.real,
      audienceEstimated: p.audience.estimated,
      audienceEstimatedShare: p.audience.estimatedShare,
      engagementRate: p.er.value,
      emvExtended: p.emvExtended,
      emvExtendedFormatted: eur(p.emvExtended),
    },
  }
  if (!showEconomics) return base
  return {
    ...base,
    metrics: {
      ...base.metrics,
      /** Fee acordado; si no hay, coste (decisión 6). */
      cost: p.cost,
      costFormatted: eur(p.cost),
      ratioEmv: p.emvRatio,
      ratioEmvFormatted: ratio(p.emvRatio),
      cpm: p.cpm,
      cpmFormatted: eur(p.cpm),
    },
  }
}

function buildOverview(ov: CampaignOverview, showEconomics: boolean) {
  const t = ov.totals
  const byBasis = (Object.entries(t.audience.byBasis) as [AudienceBasis, number][])
    .filter(([, v]) => v > 0)
    .map(([basis, value]) => ({ basis, label: basisLabel(basis), value }))

  const base = {
    definitionsVersion: ov.definitionsVersion,
    totalInfluencers: t.members,
    creatorsActive: t.creatorsActive,
    totalMedia: t.media,
    mediaDeleted: t.mediaDeleted,
    stories: t.stories,
    posts: t.posts,
    mediaCounts: t.mediaCounts,
    totalLikes: t.likes,
    totalComments: t.comments,
    totalShares: t.shares,
    totalSaves: t.saves,
    totalViews: t.views,
    /** Interacciones = likes + comentarios + shares + saves (decisión 3A). */
    totalEngagements: t.engagements,
    /** Audiencia total = real + estimada (decisión 5). */
    audience: t.audience.total,
    audienceReal: t.audience.real,
    audienceEstimated: t.audience.estimated,
    audienceEstimatedShare: t.audience.estimatedShare,
    audienceByBasis: byBasis,
    audienceWithoutBase: t.audience.withoutBase,
    reachReal: t.reachReal,
    impressionsReal: t.impressionsReal,
    /** ER = interacciones ÷ audiencia (real + estimada) × 100 (decisión 4C). */
    engagementRate: t.er.value,
    engagementRateEstimatedShare: t.er.estimatedShare,
    /** The only EMV shown to clients (decisión 9B). */
    emvExtended: t.emvExtended,
    emvExtendedFormatted: eur(t.emvExtended),
    emvEstimatedStories: t.emvEstimatedStories,
    emvRealStories: t.emvRealStories,
    emvEstimatedAudience: t.emvEstimatedAudience,
    targets: ov.targets.filter(tc => showEconomics || tc.key !== 'cpm'),
    business: ov.business,
  }
  if (!showEconomics) return base
  return {
    ...base,
    totalCost: t.cost,
    totalCostFormatted: eur(t.cost),
    membersWithCost: t.membersWithCost,
    ratioEmv: t.emvRatio,
    ratioEmvFormatted: ratio(t.emvRatio),
    cpm: t.cpm,
    cpmFormatted: eur(t.cpm),
  }
}

/** Plain-Spanish lines for the e-mail body. Estimates are always labelled. */
function buildSummary(campaignName: string, ov: CampaignOverview, showEconomics: boolean): string[] {
  const t = ov.totals
  const lines: string[] = []
  lines.push(`Campaña: ${campaignName}`)
  lines.push(`Publicaciones: ${int(t.media)} (${int(t.stories)} stories, ${int(t.posts)} posts)${t.mediaDeleted > 0 ? ` · ${int(t.mediaDeleted)} borradas por el creador, mantenidas en los totales` : ''}`)
  lines.push(`Creadores con contenido publicado: ${int(t.creatorsActive)} de ${int(t.members)}`)
  const estPct = Math.round(t.audience.estimatedShare * 100)
  lines.push(`Audiencia: ${int(t.audience.total)}${t.audience.estimated > 0 ? ` (${int(t.audience.real)} real + ${int(t.audience.estimated)} estimada, ${estPct} % estimado)` : ' (100 % datos reales)'}`)
  if (t.reachReal > 0) lines.push(`Alcance real: ${int(t.reachReal)}`)
  lines.push(`Vistas: ${int(t.views)}`)
  lines.push(`Interacciones: ${int(t.engagements)} (${int(t.likes)} me gusta, ${int(t.comments)} comentarios, ${int(t.shares)} compartidos, ${int(t.saves)} guardados)`)
  lines.push(`Tasa de engagement: ${pct(t.er.value)}${t.er.value !== null && t.er.estimatedShare > 0 ? ` (base ${Math.round(t.er.estimatedShare * 100)} % estimada)` : ''}`)
  lines.push(`EMV: ${eur(t.emvExtended) ?? '—'}${t.emvEstimatedStories > 0 ? ` (${int(t.emvEstimatedStories)} stories con audiencia estimada)` : ''}`)
  if (showEconomics) {
    lines.push(`Coste: ${eur(t.cost) ?? '—'}${t.membersWithCost < t.members ? ` (${int(t.membersWithCost)} de ${int(t.members)} creadores con coste registrado)` : ''}`)
    lines.push(`Ratio EMV: ${ratio(t.emvRatio) ?? '—'}`)
    if (t.cpm !== null) lines.push(`CPM real: ${eur(t.cpm)}`)
  }
  return lines
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { campaignId, email, frequency } = body

    if (!campaignId) {
      return NextResponse.json({ error: 'campaignId is required' }, { status: 400 })
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    if (frequency && !['weekly', 'monthly'].includes(frequency)) {
      return NextResponse.json({ error: 'Frequency must be "weekly" or "monthly"' }, { status: 400 })
    }

    // Verify campaign exists and user has access (metadata only — the numbers
    // come from computeCampaignOverview, which loads ALL media itself).
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, name: true, type: true, status: true, startDate: true, endDate: true,
        country: true, platforms: true, objective: true, targetHashtags: true, targetAccounts: true, userId: true,
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const full = await computeCampaignOverview(campaign.id)
    if (!full) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Brands never receive fees, costs, CPM or the ratio.
    const showEconomics = session.role !== 'BRAND'
    const ov = showEconomics ? full : stripEconomics(full)

    const report = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        status: campaign.status,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        country: campaign.country,
        platforms: campaign.platforms,
        objective: campaign.objective,
        targetHashtags: campaign.targetHashtags,
        targetAccounts: campaign.targetAccounts,
      },
      currency: 'EUR',
      locale: 'es-ES',
      summary: buildSummary(campaign.name, ov, showEconomics),
      overview: buildOverview(ov, showEconomics),
      influencers: ov.perInfluencer.map(p => influencerRow(p, showEconomics)),
      timeline: ov.timeline,
      generatedAt: new Date().toISOString(),
      scheduledConfig: {
        email: email || null,
        frequency: frequency || null,
        status: 'generated',
        note: 'Scheduled delivery is not yet implemented. Report generated immediately.',
      },
    }

    return NextResponse.json(report)
  } catch (error) {
    console.error('Scheduled report error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
