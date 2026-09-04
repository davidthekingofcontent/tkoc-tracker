/**
 * Server-side helpers for EMV: rates from Ajustes → Benchmarks and each
 * creator's REAL story view rate learned from stories with real numbers.
 * Keep '@/lib/emv' free of Prisma so client components can import it.
 */

import { prisma } from '@/lib/db'
import { DEFAULT_EMV_RATES, mergeEmvRates, type EmvRates } from '@/lib/emv'

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; rates: EmvRates }>()

/** EMV rates for a brand (brand override → global → defaults), cached 5 min. */
export async function loadEmvRates(brandId?: string | null): Promise<EmvRates> {
  const key = brandId || '__global__'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rates
  try {
    const keys = ['benchmark_emv_rates', ...(brandId ? [`benchmark_emv_rates_${brandId}`] : [])]
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    const byKey = new Map(rows.map(r => [r.key, r.value]))
    const raw = (brandId && byKey.get(`benchmark_emv_rates_${brandId}`)) || byKey.get('benchmark_emv_rates')
    const rates = raw ? mergeEmvRates(JSON.parse(raw)) : DEFAULT_EMV_RATES
    cache.set(key, { at: Date.now(), rates })
    return rates
  } catch (err) {
    console.error('[emv-server] loadEmvRates failed, using defaults:', err instanceof Error ? err.message : err)
    return DEFAULT_EMV_RATES
  }
}

/** Brand id of a campaign (Setting campaign_brand_{id}) or null. */
export async function campaignBrandId(campaignId: string): Promise<string | null> {
  const s = await prisma.setting.findUnique({ where: { key: `campaign_brand_${campaignId}` } }).catch(() => null)
  return s?.value || null
}

/**
 * Real story view rate per creator: average of views ÷ followers over their
 * stories that carry REAL views (registered by a PM or from the API). Used
 * instead of the generic tier rate — after a few campaigns every creator has
 * her own benchmark.
 */
export async function getCreatorStoryViewRates(influencerIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (influencerIds.length === 0) return out
  const rows = await prisma.media.findMany({
    where: {
      influencerId: { in: influencerIds },
      platform: 'INSTAGRAM',
      mediaType: 'STORY',
      OR: [{ views: { gt: 0 } }, { reach: { gt: 0 } }, { impressions: { gt: 0 } }],
    },
    select: { influencerId: true, views: true, reach: true, impressions: true, influencer: { select: { followers: true } } },
  })
  const acc = new Map<string, { sum: number; n: number }>()
  for (const r of rows) {
    const followers = r.influencer?.followers || 0
    const audience = r.impressions || r.reach || r.views || 0
    if (followers <= 0 || audience <= 0) continue
    const ratio = Math.min(1, audience / followers)
    const a = acc.get(r.influencerId) || { sum: 0, n: 0 }
    a.sum += ratio; a.n++
    acc.set(r.influencerId, a)
  }
  for (const [id, a] of acc) out.set(id, a.sum / a.n)
  return out
}
