import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { DEFAULT_EMV_RATES as EMV_DEFAULTS, mergeEmvRates } from '@/lib/emv'
import { mergeBenchmarkConfig } from '@/lib/benchmarks'
import { loadBenchmarkConfig, loadInternalStats, invalidateBenchmarkCaches } from '@/lib/benchmarks-server'

/**
 * Ajustes → Benchmarks.
 *
 * GET  (any authenticated user): the merged BenchmarkConfig the calculators
 *      consume (loadBenchmarkConfig), the EMV rates, the own-negotiation
 *      sample sizes and which keys a brand overrides. Legacy top-level keys
 *      feeRanges / cpmRates / emvRates are kept for old client code.
 * PUT  (ADMIN): { key, value, brandId? } — saves one Setting row and drops the
 *      server caches. Brand-scoped keys get the `_{brandId}` suffix; markets
 *      and meta are always global (loadBenchmarkConfig only reads them globally).
 * DELETE (ADMIN): ?key=benchmark_x[&brandId=y] — removes an override (brand or
 *      global). `key=all` with brandId removes every brand override.
 */

// Keys that may be scoped per brand (loadBenchmarkConfig reads `${key}_${brandId}` first).
const BRAND_SCOPED_KEYS = [
  'benchmark_fee_ranges',
  'benchmark_cpm_rates',
  'benchmark_emv_rates',
  'benchmark_modifiers',
] as const

// Keys that only exist globally.
const GLOBAL_ONLY_KEYS = ['benchmark_markets', 'benchmark_meta'] as const

const BENCHMARK_BASE_KEYS = [...BRAND_SCOPED_KEYS, ...GLOBAL_ONLY_KEYS] as const
type BenchmarkKey = (typeof BENCHMARK_BASE_KEYS)[number]

// Default EMV rates — single source of truth in src/lib/emv.ts
const DEFAULT_EMV_RATES = EMV_DEFAULTS

function isBenchmarkKey(key: unknown): key is BenchmarkKey {
  return typeof key === 'string' && (BENCHMARK_BASE_KEYS as readonly string[]).includes(key)
}

function isBrandScoped(key: BenchmarkKey): boolean {
  return (BRAND_SCOPED_KEYS as readonly string[]).includes(key)
}

/** Brand-scoped storage keys for a brand */
function brandKeys(brandId: string): string[] {
  return BRAND_SCOPED_KEYS.map(k => `${k}_${brandId}`)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Light shape validation: reject values whose top-level shape is wrong and make
 * sure mergeBenchmarkConfig can digest them (it is tolerant, so this mostly
 * catches "sent the wrong key" mistakes rather than bad numbers).
 */
function validateValue(key: BenchmarkKey, value: unknown): string | null {
  switch (key) {
    case 'benchmark_fee_ranges': {
      if (!isPlainObject(value)) return 'benchmark_fee_ranges must be an object { PLATFORM: { TIER: { FORMAT: [p25,p50,p75,p90] } } }'
      mergeBenchmarkConfig({ feeRanges: value })
      return null
    }
    case 'benchmark_cpm_rates': {
      if (!Array.isArray(value)) return 'benchmark_cpm_rates must be a list [{ platform, format, tier, cpmTarget, cpmMax }]'
      for (const row of value as unknown[]) {
        if (!isPlainObject(row)) return 'benchmark_cpm_rates rows must be objects'
        if (!Number.isFinite(Number(row.cpmTarget)) || !Number.isFinite(Number(row.cpmMax))) return 'cpmTarget and cpmMax must be numbers'
        if (Number(row.cpmTarget) < 0 || Number(row.cpmMax) < 0) return 'CPM thresholds cannot be negative'
      }
      mergeBenchmarkConfig({ cpmThresholds: value })
      return null
    }
    case 'benchmark_modifiers': {
      if (!isPlainObject(value)) return 'benchmark_modifiers must be an object'
      const numericLeaves: unknown[] = []
      for (const v of Object.values(value)) {
        if (isPlainObject(v)) numericLeaves.push(...Object.values(v))
        else numericLeaves.push(v)
      }
      if (numericLeaves.some(v => typeof v !== 'number' || !Number.isFinite(v))) return 'benchmark_modifiers values must be numbers (shares, e.g. 0.25)'
      mergeBenchmarkConfig({ modifiers: value })
      return null
    }
    case 'benchmark_markets': {
      if (!isPlainObject(value)) return 'benchmark_markets must be an object { ES: 1.0, PT: 0.8, ... }'
      for (const [code, mult] of Object.entries(value)) {
        if (!/^[A-Za-z]{2}$/.test(code)) return `Invalid country code "${code}" (ISO-3166 alpha-2 expected)`
        if (typeof mult !== 'number' || !Number.isFinite(mult) || mult <= 0) return `Multiplier for ${code} must be a positive number`
      }
      mergeBenchmarkConfig({ markets: value })
      return null
    }
    case 'benchmark_meta': {
      if (!isPlainObject(value)) return 'benchmark_meta must be an object { version, storyPackMultiplier, internalBlend }'
      if (value.version !== undefined && typeof value.version !== 'string') return 'version must be a string'
      if (value.storyPackMultiplier !== undefined && (typeof value.storyPackMultiplier !== 'number' || !(value.storyPackMultiplier > 0))) return 'storyPackMultiplier must be a positive number'
      if (value.internalBlend !== undefined && !isPlainObject(value.internalBlend)) return 'internalBlend must be an object { minSample, shrinkageK, trimPct }'
      mergeBenchmarkConfig({ version: value.version, storyPackMultiplier: value.storyPackMultiplier, internalBlend: value.internalBlend })
      return null
    }
    case 'benchmark_emv_rates': {
      if (!isPlainObject(value)) return 'benchmark_emv_rates must be an object'
      return null
    }
  }
}

// GET — merged config + EMV rates + own-negotiation sample sizes
// Accepts optional ?brandId=xxx to load brand-specific benchmarks
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const brandId = searchParams.get('brandId') || undefined

    const [config, stats, rows] = await Promise.all([
      loadBenchmarkConfig(brandId),
      loadInternalStats(),
      prisma.setting.findMany({
        where: { key: { in: [...BRAND_SCOPED_KEYS, ...(brandId ? brandKeys(brandId) : [])] } },
      }),
    ])
    const byKey = new Map(rows.map(r => [r.key, r.value]))
    const brandValue = (base: string) => (brandId ? byKey.get(`${base}_${brandId}`) : undefined)

    // EMV rates — same resolution as before: brand raw → global merged → defaults
    // (global scope: raw stored value → defaults).
    let emvRates: unknown
    if (brandId) {
      const brandEmv = brandValue('benchmark_emv_rates')
      const globalEmv = byKey.get('benchmark_emv_rates')
      emvRates = brandEmv
        ? JSON.parse(brandEmv)
        : globalEmv
          ? mergeEmvRates(JSON.parse(globalEmv))
          : DEFAULT_EMV_RATES
    } else {
      const globalEmv = byKey.get('benchmark_emv_rates')
      emvRates = globalEmv ? JSON.parse(globalEmv) : DEFAULT_EMV_RATES
    }

    const hasBrandOverrides = {
      feeRanges: !!brandValue('benchmark_fee_ranges'),
      cpmRates: !!brandValue('benchmark_cpm_rates'),
      modifiers: !!brandValue('benchmark_modifiers'),
      emvRates: !!brandValue('benchmark_emv_rates'),
    }

    return NextResponse.json({
      config,
      emvRates,
      internalStats: stats.map(s => ({
        platform: s.platform, tier: s.tier, format: s.format, n: s.n, updatedAt: s.updatedAt,
        brands: typeof s.brands === 'number' ? s.brands : null,
        nEffective: typeof s.nEffective === 'number' ? s.nEffective : null,
        eligible: s.eligible === true,
        reason: s.reason ?? null,
      })),
      hasBrandOverrides,
      brandId: brandId ?? null,
      // Legacy top-level keys for old client code
      feeRanges: config.feeRanges,
      cpmRates: config.cpmThresholds,
    })
  } catch (error) {
    console.error('Failed to load benchmarks:', error)
    return NextResponse.json({ error: 'Failed to load benchmarks' }, { status: 500 })
  }
}

// PUT — save one benchmark key (ADMIN only)
// Body: { key, value, brandId? }. Brand-scoped keys are stored as `${key}_${brandId}`;
// benchmark_markets and benchmark_meta are always stored globally.
export async function PUT(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only administrators can manage benchmarks' }, { status: 403 })
    }

    const body = await request.json()
    const { key, value, brandId } = body as { key: string; value: unknown; brandId?: string }

    if (!key || value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 })
    }

    if (!isBenchmarkKey(key)) {
      return NextResponse.json({ error: 'Invalid benchmark key' }, { status: 400 })
    }

    let validationError: string | null = null
    try {
      validationError = validateValue(key, value)
    } catch (err) {
      validationError = err instanceof Error ? err.message : 'Invalid value'
    }
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const scoped = !!brandId && isBrandScoped(key)
    const storageKey = scoped ? `${key}_${brandId}` : key
    const serialized = JSON.stringify(value)

    await prisma.setting.upsert({
      where: { key: storageKey },
      update: { value: serialized },
      create: { key: storageKey, value: serialized },
    })

    invalidateBenchmarkCaches()

    return NextResponse.json({ success: true, key: storageKey, scope: scoped ? 'brand' : 'global' })
  } catch (error) {
    console.error('Failed to update benchmark:', error)
    return NextResponse.json({ error: 'Failed to update benchmark' }, { status: 500 })
  }
}

// DELETE — remove a benchmark override (ADMIN only)
//   ?brandId=xxx&key=all                → all brand overrides back to global
//   ?brandId=xxx&key=benchmark_fee_ranges → one brand override back to global
//   ?key=benchmark_fee_ranges           → the global override back to the seed defaults
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Only administrators can manage benchmarks' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const brandId = searchParams.get('brandId')
    const key = searchParams.get('key') // specific key or 'all'

    if (!key) {
      return NextResponse.json({ error: 'key parameter is required' }, { status: 400 })
    }

    let deleted: string[]
    if (key === 'all') {
      if (!brandId) {
        return NextResponse.json({ error: 'key=all requires brandId' }, { status: 400 })
      }
      deleted = brandKeys(brandId)
    } else if (isBenchmarkKey(key)) {
      if (brandId && !isBrandScoped(key)) {
        return NextResponse.json({ error: `${key} is global and has no brand override` }, { status: 400 })
      }
      deleted = [brandId ? `${key}_${brandId}` : key]
    } else {
      return NextResponse.json({ error: 'Invalid key parameter' }, { status: 400 })
    }

    await prisma.setting.deleteMany({ where: { key: { in: deleted } } })
    invalidateBenchmarkCaches()

    return NextResponse.json({ success: true, deleted })
  } catch (error) {
    console.error('Failed to reset benchmark:', error)
    return NextResponse.json({ error: 'Failed to reset benchmark' }, { status: 500 })
  }
}
