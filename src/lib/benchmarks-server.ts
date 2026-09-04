/**
 * Server side of the benchmarks: load the merged config from Settings (global
 * + optional brand override) and the agency's own negotiation statistics.
 * Keep '@/lib/benchmarks' free of Prisma so client components can import it.
 *
 * Setting keys:
 *   benchmark_fee_ranges[_brandId]   { INSTAGRAM: { NANO: { POST: [p25,p50,p75,p90], ... } } }
 *   benchmark_cpm_rates[_brandId]    [{ platform, format?, tier, cpmTarget, cpmMax }]
 *   benchmark_modifiers[_brandId]    CommercialModifiers
 *   benchmark_markets                { ES: 1.0, PT: 0.8, ... }
 *   benchmark_meta                   { version, storyPackMultiplier, internalBlend }
 *   benchmark_internal_stats         InternalCellStats[] (written by the recompute job)
 */

import { prisma } from '@/lib/db'
import {
  DEFAULT_BENCHMARKS,
  mergeBenchmarkConfig,
  type BenchmarkConfig,
  findInternalCell,
  type InternalCellStats,
  type Platform,
  type Tier,
  type FeeFormat,
} from '@/lib/benchmarks'

const CACHE_TTL_MS = 5 * 60 * 1000
const configCache = new Map<string, { at: number; config: BenchmarkConfig }>()
let statsCache: { at: number; stats: InternalCellStats[] } | null = null

function parse(v: string | undefined | null): unknown {
  if (!v) return undefined
  try { return JSON.parse(v) } catch { return undefined }
}

export async function loadBenchmarkConfig(brandId?: string | null): Promise<BenchmarkConfig> {
  const cacheKey = brandId || '__global__'
  const hit = configCache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.config
  try {
    const bases = ['benchmark_fee_ranges', 'benchmark_cpm_rates', 'benchmark_modifiers']
    const keys = [
      ...bases,
      ...(brandId ? bases.map(b => `${b}_${brandId}`) : []),
      'benchmark_markets',
      'benchmark_meta',
    ]
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } } })
    const byKey = new Map(rows.map(r => [r.key, r.value]))
    const pick = (base: string) => (brandId && byKey.get(`${base}_${brandId}`)) || byKey.get(base)
    const meta = (parse(byKey.get('benchmark_meta')) || {}) as Record<string, unknown>
    const config = mergeBenchmarkConfig({
      feeRanges: parse(pick('benchmark_fee_ranges')),
      cpmThresholds: parse(pick('benchmark_cpm_rates')),
      modifiers: parse(pick('benchmark_modifiers')),
      markets: parse(byKey.get('benchmark_markets')),
      version: meta.version,
      storyPackMultiplier: meta.storyPackMultiplier,
      internalBlend: meta.internalBlend,
    })
    configCache.set(cacheKey, { at: Date.now(), config })
    return config
  } catch (err) {
    console.error('[benchmarks-server] loadBenchmarkConfig failed, using defaults:', err instanceof Error ? err.message : err)
    return DEFAULT_BENCHMARKS
  }
}

/** Own-negotiation statistics per cell, as written by the recompute job. */
export async function loadInternalStats(): Promise<InternalCellStats[]> {
  if (statsCache && Date.now() - statsCache.at < CACHE_TTL_MS) return statsCache.stats
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'benchmark_internal_stats' } })
    const stats = (parse(row?.value) as InternalCellStats[] | undefined) || []
    statsCache = { at: Date.now(), stats: Array.isArray(stats) ? stats : [] }
    return statsCache.stats
  } catch {
    return []
  }
}

export function findCell(stats: InternalCellStats[], platform: Platform, tier: Tier, format: FeeFormat): InternalCellStats | null {
  return findInternalCell(stats, platform, tier, format)
}

/** Drop caches (call after saving benchmarks or recomputing stats). */
export function invalidateBenchmarkCaches(): void {
  configCache.clear()
  statsCache = null
}
