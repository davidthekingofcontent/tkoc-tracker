import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { CampaignStatus, CampaignType, Prisma } from '@/generated/prisma/client'
import { campaignBrandId } from '@/lib/emv-server'
import { CAMPAIGN_OBJECTIVES } from '@/lib/campaign-intelligence'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import { loadReportConfig } from '@/lib/report-config'
import { sanitizeCampaignForBrand } from '@/lib/brand-scope'
import type { CampaignOverview } from '@/lib/metrics'

// ---- Numeric targets (decision 1B, David 2026-09-05) ----
// Objective + at least one target are mandatory in the UI; here we sanitize and
// freeze/log. A target that is not filled in is stored as null, never as 0.
const TARGET_KEYS = ['targetViews', 'targetReach', 'targetEngagement', 'targetER', 'targetCpmMax'] as const
type TargetKey = (typeof TARGET_KEYS)[number]

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

/** ER and CPM are decimals; views, reach and engagements are whole numbers. */
function sanitizeTarget(key: TargetKey, value: unknown): number | null {
  return key === 'targetER' || key === 'targetCpmMax' ? toPositiveFloat(value) : toPositiveInt(value)
}

// ---- Business results reported by the client (decision 14A) ----
// The PM types what the client sends (code redemptions, sales, leads, revenue,
// where it came from and when). Nothing is inferred: an empty field stays null
// and is therefore never shown. `undefined` from a parser means "invalid" → 400.

/** Optional non-negative integer: null/'' clears; undefined = invalid. */
function parseNonNegativeInt(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return undefined
  return n
}

/** Optional non-negative decimal (money): null/'' clears; undefined = invalid. */
function parseNonNegativeFloat(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return undefined
  return n
}

/** Optional trimmed text capped at `max` chars: null/'' clears; undefined = invalid (not a string / too long). */
function parseOptionalText(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= max ? trimmed : undefined
}

/** Optional ISO date (YYYY-MM-DD or full ISO 8601): null/'' clears; undefined = invalid. */
function parseIsoDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) return undefined
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? undefined : d
}

// Brands are not a Prisma model: Setting 'campaign_brand_{campaignId}' holds
// the brandId, and Setting key=brandId holds JSON { name, logo?, ... } (see
// src/lib/brand-scope.ts). The report cover needs name + logo. Never throws.
async function resolveCampaignBrand(
  campaignId: string
): Promise<{ name: string; logo: string | null } | null> {
  try {
    const mapping = await prisma.setting.findUnique({
      where: { key: `campaign_brand_${campaignId}` },
    })
    if (!mapping?.value) return null
    const brandSetting = await prisma.setting.findUnique({ where: { key: mapping.value } })
    if (!brandSetting) return null
    const data = JSON.parse(brandSetting.value) as { name?: unknown; logo?: unknown }
    if (!data || typeof data.name !== 'string' || !data.name.trim()) return null
    return {
      name: data.name.trim(),
      logo: typeof data.logo === 'string' && data.logo.trim() ? data.logo.trim() : null,
    }
  } catch {
    return null
  }
}

// ---- GET: campaign row + ONE page of media + the single overview ----
// Every figure comes from computeCampaignOverview (src/lib/campaign-overview.ts);
// nothing is aggregated here any more. `view=report` applies the ReportConfig
// (media/creators the PM hid from the client) to every figure AND to the lists,
// so the report's totals always match its tables. The legacy top-level keys of
// `overview` are plain aliases of `overview.totals` for older client code.

/** Per-publication figures attached to each media row of the page (from overview.perMedia). */
type MediaRowMetrics = Pick<
  CampaignOverview['perMedia'][number],
  'audience' | 'audienceBasis' | 'audienceEstimated' | 'engagements' | 'emvExtended'
>

/** Legacy aliases (same values as overview.totals) kept for existing consumers. */
function legacyOverviewKeys(ov: CampaignOverview) {
  const t = ov.totals
  return {
    totalReach: t.audience.total,
    totalReachReal: t.reachReal,
    totalImpressions: t.impressionsReal,
    totalEngagements: t.engagements,
    engagementRate: t.er.value ?? 0,
    engagementRateEstimatedShare: t.er.estimatedShare,
    totalViews: t.views,
    profilesPosted: t.creatorsActive,
    totalMedia: t.media,
    totalCost: t.cost,
    membersWithCost: t.membersWithCost,
    mediaCounts: t.mediaCounts,
    emvBasic: t.emvBasic,
    emvExtended: t.emvExtended,
    emvEstimatedStories: t.emvEstimatedStories,
    emvEstimatedAudience: t.emvEstimatedAudience,
    emvRealStories: t.emvRealStories,
    emvRatio: t.emvRatio,
    cpm: t.cpm,
  }
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

    const { searchParams } = new URL(request.url)
    const mediaOffset = Math.max(parseInt(searchParams.get('mediaOffset') || '0', 10) || 0, 0)
    const mediaLimit = Math.min(Math.max(parseInt(searchParams.get('mediaLimit') || '50', 10) || 50, 1), 100)
    const reportView = searchParams.get('view') === 'report'

    // Report view: what the PM hid from the client (ReportConfig) leaves the
    // figures and the lists alike. The PM's campaign page never passes it.
    const reportConfig = reportView ? await loadReportConfig(id) : null
    const hiddenMediaIds = reportConfig?.hiddenMediaIds ?? []
    const hiddenInfluencerIds = reportConfig?.hiddenInfluencerIds ?? []
    const mediaWhere: Prisma.MediaWhereInput | undefined =
      hiddenMediaIds.length > 0 || hiddenInfluencerIds.length > 0
        ? {
            ...(hiddenMediaIds.length > 0 ? { id: { notIn: hiddenMediaIds } } : {}),
            ...(hiddenInfluencerIds.length > 0 ? { influencerId: { notIn: hiddenInfluencerIds } } : {}),
          }
        : undefined
    const influencersWhere: Prisma.CampaignInfluencerWhereInput | undefined =
      hiddenInfluencerIds.length > 0 ? { influencerId: { notIn: hiddenInfluencerIds } } : undefined

    // The campaign row (with ONE page of media) and the overview (over ALL media,
    // never a page) are independent: load them together with the brand info.
    const [campaign, fullOverview, brand, brandId] = await Promise.all([
      prisma.campaign.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, name: true, email: true } },
          influencers: {
            where: influencersWhere,
            include: { influencer: true },
          },
          // `include` (not `select`) returns every Media scalar, so isDeleted,
          // deletedAt and source travel to the client: the report marks deleted
          // posts and badges Meta vs public data.
          media: {
            where: mediaWhere,
            orderBy: { postedAt: 'desc' },
            skip: mediaOffset,
            take: mediaLimit,
            include: {
              influencer: {
                select: { id: true, username: true, displayName: true, avatarUrl: true, platform: true },
              },
            },
          },
        },
      }),
      computeCampaignOverview(
        id,
        reportView ? { exclude: { mediaIds: hiddenMediaIds, influencerIds: hiddenInfluencerIds } } : {}
      ),
      // Brand info for the report cover ({ name, logo } | null) and the brandId so the client
      // can load that brand's benchmark overrides (Deal Advisor, CPM row, fee badge).
      resolveCampaignBrand(id),
      campaignBrandId(id),
    ])

    if (!campaign || !fullOverview) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // BRAND users can only view their own campaigns
    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Brands never see fees, cost, CPM, ratio EMV or the basic EMV.
    const isBrand = session.role === 'BRAND'
    const overview = isBrand ? stripEconomics(fullOverview) : fullOverview

    // Per-publication figures for this page of media, from the same computation
    // (matched by id). `null` only if a row was created after the overview ran.
    const perMediaById = new Map(overview.perMedia.map(m => [m.id, m]))
    const media = campaign.media.map(m => {
      const pm = perMediaById.get(m.id)
      const metrics: MediaRowMetrics | null = pm
        ? {
            audience: pm.audience,
            audienceBasis: pm.audienceBasis,
            audienceEstimated: pm.audienceEstimated,
            engagements: pm.engagements,
            emvExtended: pm.emvExtended,
          }
        : null
      return { ...m, metrics }
    })

    const payload = {
      campaign: { ...campaign, media, brand, brandId },
      overview: { ...overview, ...legacyOverviewKeys(overview) },
      timeline: overview.timeline,
    }

    if (isBrand) {
      // Drop the confidential field names too (agreedFee, cost, budget, notes,
      // shipping*, totalCost…) plus the fee figures deepStrip does not know about:
      // the asking fee of each creator and the CPM cap of the campaign.
      const { targetCpmMax: _cpmMax, ...campaignForBrand } = payload.campaign
      void _cpmMax
      const influencers = campaignForBrand.influencers.map(ci => {
        const { askingFee: _askingFee, ...rest } = ci
        void _askingFee
        return rest
      })
      return NextResponse.json(
        sanitizeCampaignForBrand({ ...payload, campaign: { ...campaignForBrand, influencers } })
      )
    }

    return NextResponse.json(payload)
  } catch (error) {
    console.error('Get campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params
    const body = await request.json()

    const existing = await prisma.campaign.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const {
      name, status, budget, isPinned, startDate, endDate, platforms, targetAccounts, targetHashtags, targetKeywords, country, paymentType, briefText, briefFiles, objective, manualROI, manualROINotes,
      targetsChangeReason,
      // Business results reported by the client (decision 14A)
      promoCode, codeRedemptions, clientReportedSales, clientReportedLeads, clientReportedRevenue,
      businessResultsSource, businessResultsReportedAt, businessResultsNotes,
    } = body

    // BRAND users cannot edit campaign data fields
    if (session.role === 'BRAND') {
      // Brands can only update status (pause/activate) and isPinned
      const allowedForBrand = { status, isPinned }
      const hasDisallowedFields = Object.keys(body).some(k => !['status', 'isPinned'].includes(k))
      if (hasDisallowedFields) {
        return NextResponse.json({ error: 'Brands cannot edit campaign data' }, { status: 403 })
      }
    }

    // ---- Business results: validate only the keys that came in (absent = untouched) ----
    const business: {
      promoCode?: string | null
      codeRedemptions?: number | null
      clientReportedSales?: number | null
      clientReportedLeads?: number | null
      clientReportedRevenue?: number | null
      businessResultsSource?: string | null
      businessResultsReportedAt?: Date | null
      businessResultsNotes?: string | null
    } = {}
    const invalid = (message: string) => NextResponse.json({ error: message }, { status: 400 })
    if (promoCode !== undefined) {
      const v = parseOptionalText(promoCode, 100)
      if (v === undefined) return invalid('promoCode must be text of at most 100 characters')
      business.promoCode = v
    }
    if (codeRedemptions !== undefined) {
      const v = parseNonNegativeInt(codeRedemptions)
      if (v === undefined) return invalid('codeRedemptions must be a non-negative integer')
      business.codeRedemptions = v
    }
    if (clientReportedSales !== undefined) {
      const v = parseNonNegativeInt(clientReportedSales)
      if (v === undefined) return invalid('clientReportedSales must be a non-negative integer')
      business.clientReportedSales = v
    }
    if (clientReportedLeads !== undefined) {
      const v = parseNonNegativeInt(clientReportedLeads)
      if (v === undefined) return invalid('clientReportedLeads must be a non-negative integer')
      business.clientReportedLeads = v
    }
    if (clientReportedRevenue !== undefined) {
      const v = parseNonNegativeFloat(clientReportedRevenue)
      if (v === undefined) return invalid('clientReportedRevenue must be a non-negative number')
      business.clientReportedRevenue = v
    }
    if (businessResultsSource !== undefined) {
      const v = parseOptionalText(businessResultsSource, 200)
      if (v === undefined) return invalid('businessResultsSource must be text of at most 200 characters')
      business.businessResultsSource = v
    }
    if (businessResultsReportedAt !== undefined) {
      const v = parseIsoDate(businessResultsReportedAt)
      if (v === undefined) return invalid('businessResultsReportedAt must be an ISO date (YYYY-MM-DD)')
      business.businessResultsReportedAt = v
    }
    if (businessResultsNotes !== undefined) {
      const v = parseOptionalText(businessResultsNotes, 2000)
      if (v === undefined) return invalid('businessResultsNotes must be text of at most 2000 characters')
      business.businessResultsNotes = v
    }

    // ---- Objective: same rule as POST (decision 1B) ----
    // Only one of CAMPAIGN_OBJECTIVES is stored; an unknown value would crash
    // the intelligence panel (THRESHOLDS[objective]). Clearing it (null/'') is
    // allowed only for Social Listening, which has no deliverables.
    let nextObjective: string | null | undefined
    if (objective !== undefined) {
      if (objective !== null && typeof objective !== 'string') {
        return invalid(`Objetivo no válido. Usa uno de: ${CAMPAIGN_OBJECTIVES.map(o => o.value).join(', ')}.`)
      }
      const objectiveValue = typeof objective === 'string' ? objective.trim() : ''
      if (!objectiveValue) {
        if (existing.type !== CampaignType.SOCIAL_LISTENING) {
          return invalid('El objetivo de la campaña es obligatorio (notoriedad, engagement, tráfico, conversión o contenido).')
        }
        nextObjective = null
      } else if (!CAMPAIGN_OBJECTIVES.some(o => o.value === objectiveValue)) {
        return invalid(`Objetivo no válido: "${objectiveValue}". Usa uno de: ${CAMPAIGN_OBJECTIVES.map(o => o.value).join(', ')}.`)
      } else {
        nextObjective = objectiveValue
      }
    }

    // ---- Numeric targets: sanitize what came in, merge with what is stored ----
    const incomingTargets: Partial<Record<TargetKey, number | null>> = {}
    for (const key of TARGET_KEYS) {
      if (body[key] !== undefined) incomingTargets[key] = sanitizeTarget(key, body[key])
    }
    const mergedTargets = Object.fromEntries(
      TARGET_KEYS.map(key => [key, key in incomingTargets ? incomingTargets[key] ?? null : existing[key]])
    ) as Record<TargetKey, number | null>
    const hasAnyTarget = TARGET_KEYS.some(key => mergedTargets[key] !== null)

    const nextStatus: CampaignStatus =
      status !== undefined && Object.values(CampaignStatus).includes(status) ? status : existing.status
    const now = new Date()

    // Freeze: the first time an ACTIVE campaign has at least one target.
    const shouldFreeze = nextStatus === CampaignStatus.ACTIVE && hasAnyTarget && !existing.targetsFrozenAt

    // After freezing, every target change is appended to targetsChangeLog with who/when/why.
    let nextChangeLog: Prisma.InputJsonValue | undefined
    if (existing.targetsFrozenAt) {
      const reason =
        typeof targetsChangeReason === 'string' && targetsChangeReason.trim() ? targetsChangeReason.trim() : null
      const entries = TARGET_KEYS
        .filter(key => key in incomingTargets && (incomingTargets[key] ?? null) !== existing[key])
        .map(key => ({
          at: now.toISOString(),
          by: session.email || session.id,
          field: key,
          from: existing[key],
          to: incomingTargets[key] ?? null,
          reason,
        }))
      if (entries.length > 0) {
        const previous = Array.isArray(existing.targetsChangeLog) ? existing.targetsChangeLog : []
        nextChangeLog = [...previous, ...entries] as unknown as Prisma.InputJsonValue
      }
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(status !== undefined && Object.values(CampaignStatus).includes(status) && { status }),
        ...(budget !== undefined && { budget }),
        ...(isPinned !== undefined && { isPinned }),
        ...(startDate !== undefined && startDate && { startDate: new Date(startDate) }),
        ...(endDate !== undefined && { endDate: endDate ? new Date(endDate) : undefined }),
        ...(platforms !== undefined && { platforms }),
        ...(targetAccounts !== undefined && { targetAccounts }),
        ...(targetHashtags !== undefined && { targetHashtags }),
        ...(targetKeywords !== undefined && { targetKeywords }),
        ...(country !== undefined && { country: country || null }),
        ...(paymentType !== undefined && ['PAID', 'GIFTED'].includes(paymentType) && { paymentType }),
        ...(briefText !== undefined && { briefText: briefText || null }),
        ...(briefFiles !== undefined && { briefFiles }),
        ...(nextObjective !== undefined && { objective: nextObjective }),
        ...(manualROI !== undefined && { manualROI: manualROI !== null ? parseFloat(manualROI) : null }),
        ...(manualROINotes !== undefined && { manualROINotes: manualROINotes || null }),
        // Numeric targets (decision 1B)
        ...incomingTargets,
        ...(shouldFreeze && { targetsFrozenAt: now }),
        ...(nextChangeLog !== undefined && { targetsChangeLog: nextChangeLog }),
        // Business results reported by the client (decision 14A) — only the keys that came in
        ...business,
      },
      include: {
        _count: { select: { influencers: true, media: true } },
      },
    })

    return NextResponse.json({ campaign })
  } catch (error) {
    console.error('Update campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role === 'BRAND') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    const existing = await prisma.campaign.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Hard delete: remove ALL associated data completely
    // Cascade-deleted: BriefFile, CampaignAssignment, CampaignInfluencer, Media (→Comments)
    // Manually cleaned: CampaignNote (no FK), related Notifications
    await prisma.$transaction([
      prisma.campaignNote.deleteMany({ where: { campaignId: id } }),
      prisma.notification.deleteMany({ where: { link: { contains: id } } }),
      prisma.campaign.delete({ where: { id } }),
    ])

    return NextResponse.json({ message: 'Campaign permanently deleted' })
  } catch (error) {
    console.error('Delete campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
