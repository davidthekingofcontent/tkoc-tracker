/**
 * The brand (client) of a campaign, for the MCP tools.
 *
 * Brands are not a Prisma model: Setting `campaign_brand_<campaignId>` holds
 * the brand id and Setting `<brandId>` holds a JSON document (see
 * src/lib/brand-scope.ts). The `settings` table also holds secrets (API keys,
 * tokens), so this file reads it with two closed doors: it only follows a
 * brand id that looks like one, and it copies ONE field of the document, the
 * name. Nothing else of a setting ever leaves.
 */
import { prisma } from '@/lib/db'

const CAMPAIGN_BRAND_PREFIX = 'campaign_brand_'
/** Setting families that start with `brand_` and are not a brand document. */
const NOT_A_BRAND = ['brand_assignment_', 'brand_user_', 'brand_ig_', 'brand_connect']

/** `brand_<digits>_<random>` as src/app/api/brands/route.ts generates it, never one of the other `brand_` families. */
export function isBrandId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^brand_[A-Za-z0-9_-]{1,80}$/.test(value) &&
    !NOT_A_BRAND.some(prefix => value.startsWith(prefix))
  )
}

/** The name inside a brand document, or null. The rest of the document is ignored. */
export function brandNameFromSetting(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const data = JSON.parse(value) as { name?: unknown } | null
    return data && typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null
  } catch {
    return null
  }
}

/** campaignId → brand name, for the campaigns that have a brand. Two queries whatever the number of campaigns. */
export async function brandNamesByCampaign(campaignIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = Array.from(new Set(campaignIds.filter(Boolean)))
  if (ids.length === 0) return out

  const mappings = await prisma.setting.findMany({
    where: { key: { in: ids.map(id => `${CAMPAIGN_BRAND_PREFIX}${id}`) } },
    select: { key: true, value: true },
  })
  const brandOf = new Map<string, string>()
  for (const m of mappings) {
    if (isBrandId(m.value)) brandOf.set(m.key.slice(CAMPAIGN_BRAND_PREFIX.length), m.value)
  }
  if (brandOf.size === 0) return out

  const brands = await prisma.setting.findMany({
    where: { key: { in: Array.from(new Set(brandOf.values())) } },
    select: { key: true, value: true },
  })
  const nameOf = new Map<string, string>()
  for (const b of brands) {
    const name = brandNameFromSetting(b.value)
    if (name) nameOf.set(b.key, name)
  }
  for (const [campaignId, brandId] of brandOf) {
    const name = nameOf.get(brandId)
    if (name) out.set(campaignId, name)
  }
  return out
}
