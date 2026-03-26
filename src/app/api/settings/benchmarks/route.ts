import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// Base keys we store in the settings table
const BENCHMARK_BASE_KEYS = [
  'benchmark_fee_ranges',
  'benchmark_cpm_rates',
  'benchmark_emv_rates',
] as const

// Default fee ranges from market-benchmark-client.ts
const DEFAULT_FEE_RANGES: Record<string, Record<string, Record<string, [number, number, number, number]>>> = {
  INSTAGRAM: {
    NANO:  { POST: [40, 80, 150, 250],   REEL: [60, 120, 200, 350],   STORY: [20, 50, 100, 150] },
    MICRO: { POST: [120, 250, 450, 650],  REEL: [180, 350, 600, 900],  STORY: [60, 120, 200, 350] },
    MID:   { POST: [350, 650, 1100, 1600], REEL: [450, 800, 1400, 2200], STORY: [150, 300, 500, 800] },
    MACRO: { POST: [700, 1300, 2200, 3500], REEL: [900, 1700, 2800, 4500], STORY: [300, 600, 1000, 1600] },
    MEGA:  { POST: [1800, 3500, 6000, 10000], REEL: [2500, 5000, 8000, 14000], STORY: [800, 1500, 2500, 4000] },
  },
  TIKTOK: {
    NANO:  { VIDEO: [30, 70, 140, 220],   SHORT: [25, 55, 110, 180] },
    MICRO: { VIDEO: [100, 220, 400, 600], SHORT: [80, 170, 300, 480] },
    MID:   { VIDEO: [300, 600, 1000, 1500], SHORT: [220, 450, 750, 1100] },
    MACRO: { VIDEO: [600, 1200, 2000, 3200], SHORT: [450, 900, 1500, 2400] },
    MEGA:  { VIDEO: [1500, 3000, 5500, 9000], SHORT: [1100, 2200, 4000, 6500] },
  },
  YOUTUBE: {
    NANO:  { VIDEO: [100, 200, 400, 600],   SHORT: [50, 100, 200, 350] },
    MICRO: { VIDEO: [300, 550, 900, 1300],  SHORT: [150, 280, 450, 700] },
    MID:   { VIDEO: [700, 1300, 2200, 3200], SHORT: [350, 650, 1100, 1600] },
    MACRO: { VIDEO: [1500, 3000, 5000, 8000], SHORT: [700, 1400, 2300, 3800] },
    MEGA:  { VIDEO: [3500, 7000, 12000, 20000], SHORT: [1500, 3000, 5000, 8500] },
  },
}

// Default CPM thresholds from cpm-calculator.ts
const DEFAULT_CPM_RATES = [
  { platform: 'INSTAGRAM', tier: 'MACRO', cpmTarget: 16, cpmMax: 20 },
  { platform: 'INSTAGRAM', tier: 'MEGA',  cpmTarget: 13, cpmMax: 17 },
  { platform: 'TIKTOK',   tier: 'MACRO', cpmTarget: 9,  cpmMax: 11 },
  { platform: 'TIKTOK',   tier: 'MEGA',  cpmTarget: 9,  cpmMax: 12 },
]

// Default EMV rates from emv.ts
const DEFAULT_EMV_RATES = {
  cpmRates: {
    INSTAGRAM: { post: 8.50, reel: 12.00, story: 5.00 },
    TIKTOK:    { video: 7.50, viral: 5.00 },
    YOUTUBE:   { video: 15.00, short: 6.00 },
  },
  cpc: 0.50,
  engagementValues: {
    INSTAGRAM: { like: 0.10, comment: 0.80, share: 1.50, save: 1.20 },
    TIKTOK:    { like: 0.08, comment: 0.60, share: 1.20, save: 0.90 },
    YOUTUBE:   { like: 0.12, comment: 1.00, share: 1.50, save: 0.00 },
  },
}

/** Build the actual settings keys, optionally scoped to a brand */
function getBenchmarkKeys(brandId?: string): string[] {
  const suffix = brandId ? `_${brandId}` : ''
  return BENCHMARK_BASE_KEYS.map(k => `${k}${suffix}`)
}

/** Check if a key (possibly brand-scoped) is a valid benchmark key */
function isValidBenchmarkKey(key: string): boolean {
  // Match base keys or brand-scoped keys like benchmark_fee_ranges_brand_123_abc
  return BENCHMARK_BASE_KEYS.some(base => key === base || key.startsWith(`${base}_`))
}

// GET — return current benchmark settings (from DB or defaults)
// Accepts optional ?brandId=xxx to load brand-specific benchmarks
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const brandId = searchParams.get('brandId') || undefined

    const keys = getBenchmarkKeys(brandId)

    // Read brand-specific benchmark settings from DB
    const settings = await prisma.setting.findMany({
      where: { key: { in: keys } },
    })

    const settingsMap: Record<string, string> = {}
    for (const s of settings) {
      settingsMap[s.key] = s.value
    }

    const suffix = brandId ? `_${brandId}` : ''

    // If brand-specific, try brand keys first; if not found, fall back to global, then defaults
    let feeRanges: unknown
    let cpmRates: unknown
    let emvRates: unknown

    if (brandId) {
      // Try brand-specific first
      const brandFee = settingsMap[`benchmark_fee_ranges${suffix}`]
      const brandCpm = settingsMap[`benchmark_cpm_rates${suffix}`]
      const brandEmv = settingsMap[`benchmark_emv_rates${suffix}`]

      // For brand-specific, also fetch global as fallback
      const globalKeys = getBenchmarkKeys()
      const globalSettings = await prisma.setting.findMany({
        where: { key: { in: globalKeys } },
      })
      const globalMap: Record<string, string> = {}
      for (const s of globalSettings) {
        globalMap[s.key] = s.value
      }

      feeRanges = brandFee
        ? JSON.parse(brandFee)
        : globalMap['benchmark_fee_ranges']
          ? JSON.parse(globalMap['benchmark_fee_ranges'])
          : DEFAULT_FEE_RANGES

      cpmRates = brandCpm
        ? JSON.parse(brandCpm)
        : globalMap['benchmark_cpm_rates']
          ? JSON.parse(globalMap['benchmark_cpm_rates'])
          : DEFAULT_CPM_RATES

      emvRates = brandEmv
        ? JSON.parse(brandEmv)
        : globalMap['benchmark_emv_rates']
          ? JSON.parse(globalMap['benchmark_emv_rates'])
          : DEFAULT_EMV_RATES

      // Tell the client which keys have brand-specific overrides
      return NextResponse.json({
        feeRanges,
        cpmRates,
        emvRates,
        brandId,
        hasBrandOverrides: {
          feeRanges: !!brandFee,
          cpmRates: !!brandCpm,
          emvRates: !!brandEmv,
        },
      })
    }

    // Global (no brandId)
    feeRanges = settingsMap['benchmark_fee_ranges']
      ? JSON.parse(settingsMap['benchmark_fee_ranges'])
      : DEFAULT_FEE_RANGES

    cpmRates = settingsMap['benchmark_cpm_rates']
      ? JSON.parse(settingsMap['benchmark_cpm_rates'])
      : DEFAULT_CPM_RATES

    emvRates = settingsMap['benchmark_emv_rates']
      ? JSON.parse(settingsMap['benchmark_emv_rates'])
      : DEFAULT_EMV_RATES

    return NextResponse.json({
      feeRanges,
      cpmRates,
      emvRates,
    })
  } catch (error) {
    console.error('Failed to load benchmarks:', error)
    return NextResponse.json({ error: 'Failed to load benchmarks' }, { status: 500 })
  }
}

// PUT — save benchmark overrides (ADMIN only)
// Accepts optional brandId in body to save brand-specific benchmarks
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

    // Validate that the base key is valid
    if (!BENCHMARK_BASE_KEYS.includes(key as typeof BENCHMARK_BASE_KEYS[number])) {
      return NextResponse.json({ error: 'Invalid benchmark key' }, { status: 400 })
    }

    // Build the actual storage key (brand-scoped if brandId provided)
    const storageKey = brandId ? `${key}_${brandId}` : key
    const serialized = JSON.stringify(value)

    await prisma.setting.upsert({
      where: { key: storageKey },
      update: { value: serialized },
      create: { key: storageKey, value: serialized },
    })

    return NextResponse.json({ success: true, key: storageKey })
  } catch (error) {
    console.error('Failed to update benchmark:', error)
    return NextResponse.json({ error: 'Failed to update benchmark' }, { status: 500 })
  }
}

// DELETE — reset brand-specific benchmarks back to global (ADMIN only)
// Accepts ?brandId=xxx&key=benchmark_fee_ranges (or 'all' to reset all)
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

    if (!brandId) {
      return NextResponse.json({ error: 'brandId is required' }, { status: 400 })
    }

    if (key === 'all') {
      // Delete all brand-specific benchmark overrides
      const brandKeys = getBenchmarkKeys(brandId)
      await prisma.setting.deleteMany({
        where: { key: { in: brandKeys } },
      })
    } else if (key && isValidBenchmarkKey(key)) {
      const storageKey = `${key}_${brandId}`
      await prisma.setting.deleteMany({
        where: { key: storageKey },
      })
    } else {
      return NextResponse.json({ error: 'Invalid key parameter' }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to reset benchmark:', error)
    return NextResponse.json({ error: 'Failed to reset benchmark' }, { status: 500 })
  }
}
