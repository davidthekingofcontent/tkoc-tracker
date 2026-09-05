import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { dedupeMediaByPost } from '@/lib/campaign-capture'
import { getSession } from '@/lib/auth'
import { CampaignStatus, CampaignType, Prisma } from '@/generated/prisma/client'
import { notifyAllTeam } from '@/lib/notifications'
import { CAMPAIGN_OBJECTIVES } from '@/lib/campaign-intelligence'

// ---- Numeric targets (decision 1B, David 2026-09-05) ----
// A target that is not filled in is stored as null, never as 0.
function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function toPositiveFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : parseFloat(String(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const type = searchParams.get('type')
    const pinned = searchParams.get('pinned')
    const search = searchParams.get('search')

    const where: Prisma.CampaignWhereInput = {}

    // ADMIN sees all campaigns
    // EMPLOYEE sees campaigns they created OR are assigned to OR from assigned brands
    // BRAND sees only campaigns they created
    if (session.role === 'EMPLOYEE') {
      // Look up brands assigned to this employee
      const brandAssignmentSettings = await prisma.setting.findMany({
        where: { key: { startsWith: 'brand_assignment_' } },
      })
      const assignedBrandIds: string[] = []
      for (const setting of brandAssignmentSettings) {
        try {
          const employeeIds = JSON.parse(setting.value) as string[]
          if (employeeIds.includes(session.id)) {
            // Extract brand user ID from key pattern: brand_assignment_{brandUserId}
            const brandUserId = setting.key.replace('brand_assignment_', '')
            assignedBrandIds.push(brandUserId)
          }
        } catch { /* skip malformed entries */ }
      }

      const orConditions: Prisma.CampaignWhereInput[] = [
        { userId: session.id },
        { assignments: { some: { userId: session.id } } },
      ]
      if (assignedBrandIds.length > 0) {
        orConditions.push({ user: { id: { in: assignedBrandIds } } })
      }
      where.OR = orConditions
    } else if (session.role === 'BRAND') {
      where.userId = session.id
    }

    if (status && Object.values(CampaignStatus).includes(status as CampaignStatus)) {
      where.status = status as CampaignStatus
    } else {
      // By default exclude archived
      where.status = { not: CampaignStatus.ARCHIVED }
    }

    if (type && Object.values(CampaignType).includes(type as CampaignType)) {
      where.type = type as CampaignType
    }

    if (pinned === 'true') {
      where.isPinned = true
    }

    if (search) {
      where.name = { contains: search, mode: 'insensitive' }
    }

    const campaigns = await prisma.campaign.findMany({
      where,
      include: {
        _count: {
          select: {
            influencers: true,
            media: true,
          },
        },
        user: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
    })

    // Look up brand names for campaigns
    const campaignBrandSettings = await prisma.setting.findMany({
      where: { key: { startsWith: 'campaign_brand_' } },
    })
    const campaignBrandMap = new Map<string, string>()
    for (const s of campaignBrandSettings) {
      const campaignId = s.key.replace('campaign_brand_', '')
      campaignBrandMap.set(campaignId, s.value)
    }

    // Fetch brand names
    const brandIds = new Set(campaignBrandMap.values())
    const brandNameMap = new Map<string, string>()
    if (brandIds.size > 0) {
      const brandSettings = await prisma.setting.findMany({
        where: { key: { in: Array.from(brandIds) } },
      })
      for (const bs of brandSettings) {
        try {
          const data = JSON.parse(bs.value)
          brandNameMap.set(bs.key, data.name)
        } catch { /* skip */ }
      }
    }

    const campaignsWithBrand = campaigns.map((c) => {
      const brandId = campaignBrandMap.get(c.id)
      return {
        ...c,
        brandId: brandId || null,
        brandName: brandId ? brandNameMap.get(brandId) || null : null,
      }
    })

    // Summary strip: DISTINCT posts across the listed campaigns (a post that
    // qualifies for several campaigns has one row per campaign).
    let distinctMediaTotal = 0
    try {
      const rows = await prisma.media.findMany({
        where: { campaignId: { in: campaigns.map(c => c.id) } },
        select: { id: true, externalId: true, platform: true, permalink: true },
      })
      distinctMediaTotal = dedupeMediaByPost(rows).length
    } catch {
      distinctMediaTotal = campaigns.reduce((sum, c) => sum + (c._count?.media || 0), 0)
    }

    return NextResponse.json({ campaigns: campaignsWithBrand, distinctMediaTotal })
  } catch (error) {
    console.error('List campaigns error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json(
        { error: 'Only employees and admins can create campaigns' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const {
      name, type, platforms, targetAccounts, targetHashtags, targetKeywords, startDate, endDate, country, paymentType, briefText, objective, brandId,
      targetViews, targetReach, targetEngagement, targetER, targetCpmMax,
    } = body

    if (!name) {
      return NextResponse.json({ error: 'Campaign name is required' }, { status: 400 })
    }

    // Numeric targets. New campaigns are ACTIVE by default (schema), so when at
    // least one target is set the targets are frozen right away (targetsFrozenAt);
    // later changes go through PUT /api/campaigns/[id] and land in targetsChangeLog.
    const targets = {
      targetViews: toPositiveInt(targetViews),
      targetReach: toPositiveInt(targetReach),
      targetEngagement: toPositiveInt(targetEngagement),
      targetER: toPositiveFloat(targetER),
      targetCpmMax: toPositiveFloat(targetCpmMax),
    }
    const hasAnyTarget = Object.values(targets).some(v => v !== null)

    // Decision 1B (David, 2026-09-05): objective AND at least one numeric target
    // are mandatory. Social Listening has no deliverables, so it is exempt.
    const resolvedType: CampaignType = type && Object.values(CampaignType).includes(type) ? type : CampaignType.INFLUENCER_TRACKING
    if (type !== 'SOCIAL_LISTENING') {
      const objectiveValue = typeof objective === 'string' ? objective.trim() : ''
      if (!objectiveValue) {
        return NextResponse.json(
          { error: 'El objetivo de la campaña es obligatorio (notoriedad, engagement, tráfico, conversión o contenido).' },
          { status: 400 }
        )
      }
      if (!CAMPAIGN_OBJECTIVES.some(o => o.value === objectiveValue)) {
        return NextResponse.json(
          { error: `Objetivo no válido: "${objectiveValue}". Usa uno de: ${CAMPAIGN_OBJECTIVES.map(o => o.value).join(', ')}.` },
          { status: 400 }
        )
      }
      if (!hasAnyTarget) {
        return NextResponse.json(
          { error: 'Define al menos un objetivo numérico mayor que 0: vistas, alcance, interacciones, ER (%) o CPM máximo (€).' },
          { status: 400 }
        )
      }
    }

    const campaign = await prisma.campaign.create({
      data: {
        name,
        type: resolvedType,
        platforms: platforms && platforms.length > 0 ? platforms : ['INSTAGRAM'],
        targetAccounts: targetAccounts || [],
        targetHashtags: targetHashtags || [],
        targetKeywords: targetKeywords || [],
        briefFiles: [],
        startDate: startDate ? new Date(startDate) : new Date(),
        ...(endDate && { endDate: new Date(endDate) }),
        ...(country && { country }),
        paymentType: type === 'UGC' ? 'PAID' : (paymentType && ['PAID', 'GIFTED'].includes(paymentType) ? paymentType : 'PAID'),
        ...(briefText !== undefined && { briefText }),
        ...(typeof objective === 'string' && objective.trim() && { objective: objective.trim() }),
        ...targets,
        // Born ACTIVE (schema default, no status override accepted here) → freeze now.
        ...(hasAnyTarget && { targetsFrozenAt: new Date() }),
        userId: session.id,
        // Auto-assign creator
        assignments: {
          create: { userId: session.id },
        },
      },
      include: {
        _count: {
          select: { influencers: true, media: true },
        },
      },
    })

    // Store brand association if provided
    if (brandId) {
      await prisma.setting.upsert({
        where: { key: `campaign_brand_${campaign.id}` },
        update: { value: brandId },
        create: { key: `campaign_brand_${campaign.id}`, value: brandId },
      })
    }

    // Notify team about new campaign
    notifyAllTeam(
      {
        type: 'campaign_created',
        title: 'New Campaign Created',
        message: `${session.name || 'A team member'} created campaign "${campaign.name}"`,
        link: `/campaigns/${campaign.id}`,
      },
      session.id
    ).catch(() => {})

    return NextResponse.json({ campaign }, { status: 201 })
  } catch (error) {
    console.error('Create campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
