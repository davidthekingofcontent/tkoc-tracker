// EMV (Earned Media Value) Calculator
// Formula: EMV = (Views / 1000 × CPM) + (Clicks × CPC) + Engagement Value
//
// Real data first: impressions > reach > views. The ONE exception is Instagram
// STORIES, whose views are never public: when a story carries no real
// views/reach, its audience is ESTIMATED as followers × tier rate (a decision
// by David on 2026-09-04 — see DEFAULT_EMV_RATES.storyReachRates), decaying
// 15% per consecutive story of the same creator (people drop off along the
// sequence). Estimated values are flagged so reports can mark them.
//
// Rates are editable in Ajustes → Benchmarks (Setting benchmark_emv_rates,
// optionally per brand); the defaults below are the fallback. Server code
// should load them with loadEmvRates() from '@/lib/emv-server' and pass them in.

export type MediaKind = 'POST' | 'REEL' | 'STORY' | 'VIDEO' | 'SHORT' | 'CAROUSEL' | string

export interface EMVInput {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | string
  impressions: number
  reach: number
  views: number
  clicks: number       // Usually 0 (not available from scraping)
  likes: number
  comments: number
  shares: number
  saves: number        // Instagram: saves, TikTok: favorites
  /** Content type — selects the CPM (post / reel / story). Unknown → post. */
  mediaType?: MediaKind | null
  /** Creator's followers — needed to estimate STORY audience. */
  followers?: number | null
  /** Position of this story in a consecutive sequence by the same creator (0 = first). */
  storyIndex?: number
  /** Creator's REAL story view rate (views ÷ followers) learned from stories with real data. */
  storyViewRate?: number | null
}

export interface EMVResult {
  basic: number     // Reach/views component only
  extended: number  // Full formula with engagement
  breakdown: {
    reachComponent: number
    clicksComponent: number
    engagementComponent: number
  }
  /** True when the audience was estimated (story without real views). */
  estimated: boolean
  /** Audience used for the reach component (real or estimated). */
  audience: number
}

export type FollowerTier = 'NANO' | 'MICRO' | 'MID' | 'MACRO' | 'MEGA'

export interface EmvRates {
  cpmRates: {
    INSTAGRAM: { post: number; reel: number; story: number }
    TIKTOK: { video: number; viral: number }
    YOUTUBE: { video: number; short: number }
  }
  cpc: number
  engagementValues: {
    INSTAGRAM: { like: number; comment: number; share: number; save: number }
    TIKTOK: { like: number; comment: number; share: number; save: number }
    YOUTUBE: { like: number; comment: number; share: number; save: number }
  }
  /** Share of followers assumed to see a story, by creator tier (no real views). */
  storyReachRates: Record<FollowerTier, number>
  /** Multiplier applied to each consecutive story of the same creator (drop-off). */
  storySequenceDecay: number
}

/**
 * Defaults (Spain/Europe 2025-2026). Story CPM and reel CPM set to the
 * "aggressive" end of the market range on David's decision (2026-09-04):
 * story 8 € (Meta Ads Stories placement 3.5–7 €, influencer platforms 4–8 €),
 * reel 14 € (only ever applied to REAL views), post 10 €.
 */
export const DEFAULT_EMV_RATES: EmvRates = {
  cpmRates: {
    INSTAGRAM: { post: 10.0, reel: 14.0, story: 8.0 },
    TIKTOK: { video: 7.5, viral: 5.0 },
    YOUTUBE: { video: 15.0, short: 6.0 },
  },
  cpc: 0.5,
  engagementValues: {
    INSTAGRAM: { like: 0.10, comment: 0.80, share: 1.50, save: 1.20 },
    TIKTOK: { like: 0.08, comment: 0.60, share: 1.20, save: 0.90 },
    YOUTUBE: { like: 0.12, comment: 1.00, share: 1.50, save: 0.00 },
  },
  // Instagram story reach as a share of followers. Public 2024-25 benchmarks
  // (Socialinsider, Rival IQ, Later, HypeAuditor): nano 8-15%, micro 5-9%,
  // mid 3-6%, macro 2-4%, mega 1.5-3%. Values chosen by David (upper end).
  storyReachRates: { NANO: 0.15, MICRO: 0.10, MID: 0.07, MACRO: 0.05, MEGA: 0.04 },
  storySequenceDecay: 0.85,
}

/** Two stories of the same creator closer than this are one "sequence". */
export const STORY_SEQUENCE_GAP_MS = 3 * 60 * 60 * 1000

export function getFollowerTier(followers: number): FollowerTier {
  if (followers >= 1_000_000) return 'MEGA'
  if (followers >= 250_000) return 'MACRO'
  if (followers >= 50_000) return 'MID'
  if (followers >= 10_000) return 'MICRO'
  return 'NANO'
}

/** Merge partial (DB-stored) rates over the defaults, tolerating old shapes. */
export function mergeEmvRates(partial: unknown): EmvRates {
  const p = (partial && typeof partial === 'object' ? partial : {}) as Partial<EmvRates> & Record<string, unknown>
  const cpm = (p.cpmRates || {}) as Partial<EmvRates['cpmRates']>
  const eng = (p.engagementValues || {}) as Partial<EmvRates['engagementValues']>
  const reach = (p.storyReachRates || {}) as Partial<Record<FollowerTier, number>>
  return {
    cpmRates: {
      INSTAGRAM: { ...DEFAULT_EMV_RATES.cpmRates.INSTAGRAM, ...(cpm.INSTAGRAM || {}) },
      TIKTOK: { ...DEFAULT_EMV_RATES.cpmRates.TIKTOK, ...(cpm.TIKTOK || {}) },
      YOUTUBE: { ...DEFAULT_EMV_RATES.cpmRates.YOUTUBE, ...(cpm.YOUTUBE || {}) },
    },
    cpc: typeof p.cpc === 'number' ? p.cpc : DEFAULT_EMV_RATES.cpc,
    engagementValues: {
      INSTAGRAM: { ...DEFAULT_EMV_RATES.engagementValues.INSTAGRAM, ...(eng.INSTAGRAM || {}) },
      TIKTOK: { ...DEFAULT_EMV_RATES.engagementValues.TIKTOK, ...(eng.TIKTOK || {}) },
      YOUTUBE: { ...DEFAULT_EMV_RATES.engagementValues.YOUTUBE, ...(eng.YOUTUBE || {}) },
    },
    storyReachRates: { ...DEFAULT_EMV_RATES.storyReachRates, ...reach },
    storySequenceDecay:
      typeof p.storySequenceDecay === 'number' && p.storySequenceDecay > 0 && p.storySequenceDecay <= 1
        ? p.storySequenceDecay
        : DEFAULT_EMV_RATES.storySequenceDecay,
  }
}

type PlatformKey = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

function platformKeyOf(platform: string): PlatformKey {
  const p = (platform || '').toUpperCase()
  return p === 'TIKTOK' || p === 'YOUTUBE' ? p : 'INSTAGRAM'
}

/** CPM for a platform + content type. */
export function cpmFor(platform: string, mediaType: MediaKind | null | undefined, rates: EmvRates = DEFAULT_EMV_RATES): number {
  const key = platformKeyOf(platform)
  const type = (mediaType || '').toUpperCase()
  if (key === 'TIKTOK') return rates.cpmRates.TIKTOK.video
  if (key === 'YOUTUBE') return type === 'SHORT' ? rates.cpmRates.YOUTUBE.short : rates.cpmRates.YOUTUBE.video
  if (type === 'STORY') return rates.cpmRates.INSTAGRAM.story
  if (type === 'REEL' || type === 'VIDEO') return rates.cpmRates.INSTAGRAM.reel
  return rates.cpmRates.INSTAGRAM.post
}

export function calculateEMV(input: EMVInput, rates: EmvRates = DEFAULT_EMV_RATES): EMVResult {
  const platformKey = platformKeyOf(input.platform)
  const isStory = (input.mediaType || '').toUpperCase() === 'STORY'

  // Real data first: impressions > reach > views
  const realViews = input.impressions || input.reach || input.views || 0

  // Stories: no public view counts → estimate from followers (tier rate or the
  // creator's own real rate), decaying along a consecutive sequence.
  let audience = realViews
  let estimated = false
  if (isStory && realViews === 0 && platformKey === 'INSTAGRAM' && (input.followers || 0) > 0) {
    const followers = input.followers as number
    const rate = input.storyViewRate && input.storyViewRate > 0
      ? input.storyViewRate
      : rates.storyReachRates[getFollowerTier(followers)]
    const decay = Math.pow(rates.storySequenceDecay, Math.max(0, input.storyIndex || 0))
    audience = Math.round(followers * rate * decay)
    estimated = audience > 0
  }

  const cpmRate = cpmFor(input.platform, input.mediaType, rates)

  // 1. Reach component: (audience / 1000) × CPM
  const reachComponent = (audience / 1000) * cpmRate

  // 2. Clicks component: clicks × CPC
  const clicksComponent = input.clicks * rates.cpc

  // 3. Engagement component: real interactions × value per action
  const engValues = rates.engagementValues[platformKey]
  const engagementComponent =
    (input.likes * engValues.like) +
    (input.comments * engValues.comment) +
    (input.shares * engValues.share) +
    (input.saves * engValues.save)

  const basic = Math.round(reachComponent * 100) / 100
  const extended = Math.round((reachComponent + clicksComponent + engagementComponent) * 100) / 100

  return {
    basic,
    extended,
    breakdown: {
      reachComponent: Math.round(reachComponent * 100) / 100,
      clicksComponent: Math.round(clicksComponent * 100) / 100,
      engagementComponent: Math.round(engagementComponent * 100) / 100,
    },
    estimated,
    audience,
  }
}

export interface CampaignEmvItem {
  platform: string
  impressions?: number | null
  reach?: number | null
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  saves?: number | null
  mediaType?: MediaKind | null
  postedAt?: Date | string | null
  influencerId?: string | null
  followers?: number | null
}

export interface CampaignEmvOptions {
  rates?: EmvRates
  /** Real story view rates per influencerId (views ÷ followers), learned from stories with real data. */
  storyViewRates?: Map<string, number> | Record<string, number>
}

export interface CampaignEmvResult {
  basic: number
  extended: number
  /** Stories valued with an ESTIMATED audience (no real views). */
  estimatedStories: number
  /** Stories valued with real views/reach. */
  realStories: number
  /** Sum of estimated story audience (for "≈ N vistas estimadas"). */
  estimatedAudience: number
}

/**
 * Campaign EMV. Assigns each STORY without real views its position in the
 * creator's consecutive sequence (gap ≤ 3h) so the drop-off decay applies.
 */
export function calculateCampaignEMV(media: CampaignEmvItem[], options: CampaignEmvOptions = {}): CampaignEmvResult {
  const rates = options.rates ?? DEFAULT_EMV_RATES
  const rateMap: Map<string, number> = options.storyViewRates instanceof Map
    ? options.storyViewRates
    : new Map(Object.entries(options.storyViewRates || {}))

  // Story sequence index per creator (only stories that will be estimated)
  const storyIndex = new Map<CampaignEmvItem, number>()
  const byCreator = new Map<string, CampaignEmvItem[]>()
  media.forEach((m, i) => {
    const isStory = (m.mediaType || '').toUpperCase() === 'STORY'
    const hasReal = (m.impressions || 0) > 0 || (m.reach || 0) > 0 || (m.views || 0) > 0
    if (!isStory || hasReal) return
    const key = m.influencerId || `idx:${i}`
    const arr = byCreator.get(key) || []
    arr.push(m)
    byCreator.set(key, arr)
  })
  for (const items of byCreator.values()) {
    items.sort((a, b) => toMs(a.postedAt) - toMs(b.postedAt))
    let idx = 0
    let prev: number | null = null
    for (const it of items) {
      const t = toMs(it.postedAt)
      if (prev !== null && t - prev <= STORY_SEQUENCE_GAP_MS) idx++
      else idx = 0
      storyIndex.set(it, idx)
      prev = t
    }
  }

  let totalBasic = 0
  let totalExtended = 0
  let estimatedStories = 0
  let realStories = 0
  let estimatedAudience = 0

  for (const m of media) {
    const result = calculateEMV({
      platform: m.platform || 'INSTAGRAM',
      impressions: m.impressions || 0,
      reach: m.reach || 0,
      views: m.views || 0,
      clicks: 0,
      likes: m.likes || 0,
      comments: m.comments || 0,
      shares: m.shares || 0,
      saves: m.saves || 0,
      mediaType: m.mediaType,
      followers: m.followers ?? null,
      storyIndex: storyIndex.get(m) ?? 0,
      storyViewRate: m.influencerId ? rateMap.get(m.influencerId) ?? null : null,
    }, rates)
    totalBasic += result.basic
    totalExtended += result.extended
    if ((m.mediaType || '').toUpperCase() === 'STORY') {
      if (result.estimated) { estimatedStories++; estimatedAudience += result.audience }
      else if (result.audience > 0) realStories++
    }
  }

  return {
    basic: Math.round(totalBasic * 100) / 100,
    extended: Math.round(totalExtended * 100) / 100,
    estimatedStories,
    realStories,
    estimatedAudience,
  }
}

function toMs(d: Date | string | null | undefined): number {
  if (!d) return 0
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isNaN(t) ? 0 : t
}

export const EMV_METHODOLOGY = {
  en: 'EMV = (Audience/1000 × CPM by content type) + (Clicks × CPC) + Engagement Value. Posts and reels use only real data (impressions > reach > views). Instagram stories without real views are valued with an ESTIMATED audience: followers × tier rate (nano 15%, micro 10%, mid 7%, macro 5%, mega 4%), −15% per consecutive story; real views entered by the PM always win. Estimated values are flagged.',
  es: 'EMV = (Audiencia/1000 × CPM por tipo de contenido) + (Clics × CPC) + Valor del engagement. Posts y reels usan solo datos reales (impresiones > alcance > vistas). Las stories de Instagram sin vistas reales se valoran con una audiencia ESTIMADA: seguidores × porcentaje por tier (nano 15 %, micro 10 %, mid 7 %, macro 5 %, mega 4 %), −15 % por cada story consecutiva; si la PM registra las vistas reales, mandan. Los valores estimados se marcan como tales.',
}
