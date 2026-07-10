import { prisma } from '@/lib/db'

// ---------------------------------------------------------------------------
// Brand scope resolution for BRAND-role portal users.
//
// Brands are NOT a Prisma model: they live as Setting rows key='brand_{id}'
// with a JSON value (see src/app/api/brands/route.ts). Campaign↔brand mapping
// lives as Setting rows key='campaign_brand_{campaignId}' value=brandId.
// ---------------------------------------------------------------------------

interface BrandData {
  id: string
  name: string
  website?: string
  logo?: string
  assignedEmployees: string[]
  brandUserId?: string
  createdBy: string
  createdAt: string
}

export interface BrandScope {
  brandId: string | null
  brandName: string | null
  brandLogo: string | null
  campaignIds: string[]
}

const EMPTY_SCOPE: BrandScope = {
  brandId: null,
  brandName: null,
  brandLogo: null,
  campaignIds: [],
}

const CAMPAIGN_BRAND_PREFIX = 'campaign_brand_'

function isBrandEntryKey(key: string): boolean {
  return (
    key.startsWith('brand_') &&
    !key.startsWith('brand_assignment_') &&
    !key.startsWith('brand_user_')
  )
}

async function findCampaignIdsForBrand(brandId: string): Promise<string[]> {
  const mappings = await prisma.setting.findMany({
    where: { key: { startsWith: CAMPAIGN_BRAND_PREFIX } },
  })
  return mappings
    .filter((s) => s.value === brandId)
    .map((s) => s.key.slice(CAMPAIGN_BRAND_PREFIX.length))
    .filter(Boolean)
}

/**
 * Resolve the scope for a BRAND user: which brand they belong to
 * (Setting JSON with brandUserId === userId) and which campaigns they may
 * see (campaign_brand_ mappings for that brand, unioned with explicit
 * CampaignAssignment rows for the user).
 */
export async function resolveBrandScope(userId: string): Promise<BrandScope> {
  const [brandSettings, assignments] = await Promise.all([
    prisma.setting.findMany({ where: { key: { startsWith: 'brand_' } } }),
    prisma.campaignAssignment.findMany({
      where: { userId },
      select: { campaignId: true },
    }),
  ])

  let brand: BrandData | null = null
  for (const setting of brandSettings) {
    if (!isBrandEntryKey(setting.key)) continue
    try {
      const data = JSON.parse(setting.value) as BrandData
      if (data && data.brandUserId === userId) {
        brand = data
        break
      }
    } catch {
      /* skip malformed entries */
    }
  }

  const campaignIds = new Set<string>()
  if (brand) {
    for (const id of await findCampaignIdsForBrand(brand.id)) {
      campaignIds.add(id)
    }
  }
  for (const a of assignments) {
    campaignIds.add(a.campaignId)
  }

  if (!brand && campaignIds.size === 0) {
    return { ...EMPTY_SCOPE }
  }

  return {
    brandId: brand?.id ?? null,
    brandName: brand?.name ?? null,
    brandLogo: brand?.logo ?? null,
    campaignIds: Array.from(campaignIds),
  }
}

/**
 * Resolve a scope directly from a brandId (used by ADMIN for testing the
 * portal as a given brand). No CampaignAssignment union — pure brand mapping.
 */
export async function resolveBrandScopeForBrandId(
  brandId: string
): Promise<BrandScope> {
  const setting = await prisma.setting.findUnique({ where: { key: brandId } })
  if (!setting || !isBrandEntryKey(setting.key)) {
    return { ...EMPTY_SCOPE }
  }

  let brand: BrandData
  try {
    brand = JSON.parse(setting.value) as BrandData
  } catch {
    return { ...EMPTY_SCOPE }
  }

  return {
    brandId: brand.id,
    brandName: brand.name ?? null,
    brandLogo: brand.logo ?? null,
    campaignIds: await findCampaignIdsForBrand(brand.id),
  }
}

// ---------------------------------------------------------------------------
// Confidential-field stripping.
//
// Brands must NEVER see agency economics or fulfillment PII:
// agreedFee / cost / commission / notes on CampaignInfluencer,
// budget / manualROI / manualROINotes on Campaign, shipping* fields,
// and derived totals like totalCost.
// ---------------------------------------------------------------------------

const CONFIDENTIAL_KEYS = new Set([
  'agreedFee',
  'cost',
  'commission',
  'notes',
  'manualROI',
  'manualROINotes',
  'budget',
  'totalCost',
])

function isConfidentialKey(key: string): boolean {
  return CONFIDENTIAL_KEYS.has(key) || key.startsWith('shipping')
}

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepStrip)
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isConfidentialKey(key)) continue
      out[key] = deepStrip(val)
    }
    return out
  }
  return value
}

/**
 * Deep-strips confidential fields from any campaign-shaped payload before it
 * is returned to a BRAND user. Keeps status / contentDelivered / public
 * influencer profile fields intact. Defense in depth: portal endpoints
 * already use narrow Prisma selects — this guarantees nothing leaks even if
 * a select widens later.
 */
export function sanitizeCampaignForBrand<T>(payload: T): T {
  return deepStrip(payload) as T
}
