// Apify REST API client — uses fetch() directly, no external dependencies
// Docs: https://docs.apify.com/api/v2

import { prisma } from '@/lib/db'

const APIFY_BASE = 'https://api.apify.com/v2'

// ============ CIRCUIT BREAKER (monthly usage hard limit) ============
// When Apify returns 403 "platform-feature-disabled" / "Monthly usage hard
// limit exceeded", every actor start will keep failing until the usage cycle
// resets. Trip an in-memory breaker so subsequent calls fail fast (no network)
// instead of burning latency on doomed requests. Per-process state: resets on
// deploy/restart and re-trips on the first failed call — that is expected.

let apifyExhaustedUntil: number | null = null

export function isApifyExhausted(): boolean {
  return apifyExhaustedUntil !== null && Date.now() < apifyExhaustedUntil
}

/**
 * Soft monthly budget (David 2026-09-14: "que se use lo mínimo posible"). Above
 * APIFY_SOFT_LIMIT_USD (default 40 $) the NON-essential scrapes (stories) stop;
 * the cheap essentials (single-post views) keep running up to the hard limit.
 * Usage is read from Apify at most every 15 minutes; on any error we assume OK.
 */
export const APIFY_SOFT_LIMIT_USD = Number(process.env.APIFY_SOFT_LIMIT_USD || 40)
let _usageCache: { at: number; usd: number; limit: number } | null = null
export async function getApifyUsage(): Promise<{ usd: number; limit: number } | null> {
  if (_usageCache && Date.now() - _usageCache.at < 15 * 60 * 1000) return { usd: _usageCache.usd, limit: _usageCache.limit }
  try {
    const token = await getTokenWithDbFallback()
    if (!token) return null
    const res = await fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`)
    if (!res.ok) return null
    const json = await res.json() as { data?: { current?: { monthlyUsageUsd?: number }; limits?: { maxMonthlyUsageUsd?: number } } }
    const usd = json.data?.current?.monthlyUsageUsd
    const limit = json.data?.limits?.maxMonthlyUsageUsd
    if (typeof usd !== 'number' || typeof limit !== 'number') return null
    _usageCache = { at: Date.now(), usd, limit }
    return { usd, limit }
  } catch {
    return null
  }
}
export async function isApifyOverSoftLimit(): Promise<{ over: boolean; usd: number | null; softLimit: number }> {
  const u = await getApifyUsage()
  const softLimit = Math.min(APIFY_SOFT_LIMIT_USD, u?.limit ?? APIFY_SOFT_LIMIT_USD)
  return { over: u !== null && u.usd >= softLimit, usd: u?.usd ?? null, softLimit }
}

export function getApifyResumeDate(): string | null {
  if (!isApifyExhausted()) return null
  return new Date(apifyExhaustedUntil as number).toISOString()
}

/** Trip the breaker. Tries to read the real cycle end from the Apify limits
 *  endpoint; falls back to now + 6h. Never throws. */
async function tripApifyExhausted(token: string): Promise<void> {
  let until = Date.now() + 6 * 60 * 60 * 1000 // fallback: retry in 6 hours
  try {
    const res = await fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`)
    if (res.ok) {
      const json = await res.json() as { data?: { monthlyUsageCycle?: { endAt?: string } } }
      const endAt = json.data?.monthlyUsageCycle?.endAt
      if (endAt) {
        const parsed = Date.parse(endAt)
        if (!Number.isNaN(parsed) && parsed > Date.now()) until = parsed
      }
    }
  } catch {
    // keep the 6h fallback — this must never throw
  }
  apifyExhaustedUntil = until
  console.error(`[Apify] Monthly limit exhausted — circuit open until ${new Date(until).toISOString()}`)
}

function isExhaustedError(err: unknown): boolean {
  return err instanceof Error && err.message === 'APIFY_EXHAUSTED'
}

// Cache the DB token for 60s to avoid hitting DB on every call
let _cachedDbToken: string | null = null
let _cachedDbTokenAt = 0
const DB_TOKEN_TTL = 60_000 // 60 seconds

async function getTokenFromDb(): Promise<string | null> {
  const now = Date.now()
  if (_cachedDbToken !== null && now - _cachedDbTokenAt < DB_TOKEN_TTL) {
    return _cachedDbToken
  }
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'apify_api_key' } })
    _cachedDbToken = setting?.value || null
    _cachedDbTokenAt = now
    return _cachedDbToken
  } catch {
    return null
  }
}

function getToken(): string | null {
  return process.env.APIFY_API_KEY || null
}

async function getTokenWithDbFallback(): Promise<string | null> {
  const envToken = process.env.APIFY_API_KEY
  if (envToken) return envToken
  return getTokenFromDb()
}

/** Apify caps `waitForFinish` at 60 s server-side; longer waits are polling. */
const APIFY_WAIT_FOR_FINISH_MAX_SECS = 60
const APIFY_POLL_INTERVAL_MS = 5_000
/** Default polling after waitForFinish: 30 × 5 s. */
const APIFY_DEFAULT_POLL_MS = 150_000

interface ActorRunResult {
  items: Record<string, unknown>[]
  /**
   * false when the run was still RUNNING when we stopped waiting: `items` is
   * then whatever the dataset held at that moment (possibly nothing) and must
   * not be taken as the final answer for the inputs that are missing.
   */
  succeeded: boolean
}

/**
 * Run an Apify actor and return the dataset items plus whether the run had
 * actually finished. Waits `waitForFinish` (≤ 60 s, Apify's cap) and then
 * polls for at most `maxPollMs`.
 */
async function runActorDetailed(
  actorId: string,
  input: Record<string, unknown>,
  timeoutSecs = 120,
  maxPollMs = APIFY_DEFAULT_POLL_MS
): Promise<ActorRunResult> {
  // Circuit breaker: fail fast (no network, no DB) while the monthly limit is exhausted
  if (isApifyExhausted()) throw new Error('APIFY_EXHAUSTED')

  const token = await getTokenWithDbFallback()
  if (!token) throw new Error('APIFY_API_KEY not configured')

  timeoutSecs = Math.min(Math.max(0, Math.round(timeoutSecs)), APIFY_WAIT_FOR_FINISH_MAX_SECS)
  const url = `${APIFY_BASE}/acts/${actorId}/runs?token=${token.substring(0, 8)}...&waitForFinish=${timeoutSecs}`
  console.log(`[Apify] Starting actor ${actorId} with input:`, JSON.stringify(input).substring(0, 200))
  console.log(`[Apify] Request URL pattern: ${url}`)

  // Start the actor run and wait for it to finish
  const runRes = await fetch(
    `${APIFY_BASE}/acts/${actorId}/runs?token=${token}&waitForFinish=${timeoutSecs}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  )

  console.log(`[Apify] Response status: ${runRes.status}`)

  if (!runRes.ok) {
    const errText = await runRes.text()
    console.error(`[Apify] Actor ${actorId} FAILED: ${runRes.status} ${errText}`)
    // Monthly usage hard limit → open the circuit breaker until the cycle resets
    if (
      runRes.status === 403 &&
      (errText.includes('platform-feature-disabled') || errText.toLowerCase().includes('hard limit'))
    ) {
      await tripApifyExhausted(token)
    }
    throw new Error(`Apify actor ${actorId} failed to start: ${runRes.status} ${errText}`)
  }

  const runData = await runRes.json() as { data?: { id?: string; defaultDatasetId?: string; status?: string } }
  const runId = runData.data?.id
  const datasetId = runData.data?.defaultDatasetId
  console.log(`[Apify] Run id: ${runId}, status: ${runData.data?.status}, datasetId: ${datasetId}`)

  if (!datasetId) {
    throw new Error(`Apify actor ${actorId} did not return a dataset ID`)
  }

  // If status is not SUCCEEDED, the run may still be running or failed
  let status = runData.data?.status
  if (status && status !== 'SUCCEEDED' && status !== 'READY') {
    // Wait a bit more and check
    if (status === 'RUNNING' && runId) {
      // Poll until done — use the run ID, not the dataset ID
      const polls = Math.floor(Math.max(0, maxPollMs) / APIFY_POLL_INTERVAL_MS)
      for (let i = 0; i < polls; i++) {
        await new Promise(r => setTimeout(r, APIFY_POLL_INTERVAL_MS))
        const checkRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`)
        if (checkRes.ok) {
          const checkData = await checkRes.json() as { data?: { status?: string } }
          status = checkData.data?.status
          if (status === 'SUCCEEDED') break
          if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            throw new Error(`Apify actor ${actorId} ${status}`)
          }
        }
      }
    }
  }
  const succeeded = status === 'SUCCEEDED' || status === 'READY' || !status
  if (!succeeded) {
    console.warn(`[Apify] Run ${runId} of ${actorId} still ${status} after the wait: reading the dataset as PARTIAL`)
  }

  // Fetch dataset items
  const dataRes = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=true`
  )

  if (!dataRes.ok) {
    throw new Error(`Failed to fetch dataset ${datasetId}: ${dataRes.status}`)
  }

  const items = await dataRes.json() as Record<string, unknown>[]
  console.log(`[Apify] Got ${items?.length || 0} items from dataset ${datasetId}${succeeded ? '' : ' (partial)'}`)
  return { items: items || [], succeeded }
}

/** Run an Apify actor and return the dataset items (partial if the run outlived the wait). */
async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  timeoutSecs = 120
): Promise<Record<string, unknown>[]> {
  const { items } = await runActorDetailed(actorId, input, timeoutSecs)
  return items
}

// ============ COUNTRY DETECTION ============

const LOCATION_TO_COUNTRY: Record<string, string> = {
  // Spain
  'spain': 'ES', 'españa': 'ES', 'madrid': 'ES', 'barcelona': 'ES', 'valencia': 'ES',
  'sevilla': 'ES', 'seville': 'ES', 'málaga': 'ES', 'malaga': 'ES', 'bilbao': 'ES',
  'zaragoza': 'ES', 'granada': 'ES', 'murcia': 'ES', 'palma': 'ES', 'alicante': 'ES',
  'ibiza': 'ES', 'tenerife': 'ES', 'marbella': 'ES', 'salamanca': 'ES',
  // Mexico
  'mexico': 'MX', 'méxico': 'MX', 'cdmx': 'MX', 'ciudad de mexico': 'MX',
  'guadalajara': 'MX', 'monterrey': 'MX', 'cancun': 'MX', 'cancún': 'MX',
  'puebla': 'MX', 'tijuana': 'MX', 'playa del carmen': 'MX',
  // Argentina
  'argentina': 'AR', 'buenos aires': 'AR', 'córdoba': 'AR', 'rosario': 'AR', 'mendoza': 'AR',
  // Colombia
  'colombia': 'CO', 'bogotá': 'CO', 'bogota': 'CO', 'medellín': 'CO', 'medellin': 'CO',
  'cali': 'CO', 'barranquilla': 'CO', 'cartagena': 'CO',
  // Chile
  'chile': 'CL', 'santiago': 'CL', 'valparaíso': 'CL',
  // Peru
  'peru': 'PE', 'perú': 'PE', 'lima': 'PE',
  // USA
  'united states': 'US', 'usa': 'US', 'new york': 'US', 'los angeles': 'US',
  'chicago': 'US', 'miami': 'US', 'san francisco': 'US', 'houston': 'US',
  'atlanta': 'US', 'dallas': 'US', 'seattle': 'US', 'boston': 'US',
  'las vegas': 'US', 'austin': 'US', 'denver': 'US', 'phoenix': 'US',
  'san diego': 'US', 'philadelphia': 'US', 'nashville': 'US', 'portland': 'US',
  // UK
  'united kingdom': 'GB', 'uk': 'GB', 'london': 'GB', 'manchester': 'GB',
  'birmingham': 'GB', 'liverpool': 'GB', 'edinburgh': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB',
  // Brazil
  'brazil': 'BR', 'brasil': 'BR', 'são paulo': 'BR', 'sao paulo': 'BR',
  'rio de janeiro': 'BR', 'rio': 'BR', 'brasília': 'BR',
  // France
  'france': 'FR', 'francia': 'FR', 'paris': 'FR', 'lyon': 'FR', 'marseille': 'FR',
  // Germany
  'germany': 'DE', 'alemania': 'DE', 'berlin': 'DE', 'munich': 'DE', 'münchen': 'DE',
  'hamburg': 'DE', 'frankfurt': 'DE',
  // Italy
  'italy': 'IT', 'italia': 'IT', 'rome': 'IT', 'roma': 'IT', 'milan': 'IT', 'milano': 'IT',
  'naples': 'IT', 'napoli': 'IT', 'florence': 'IT', 'firenze': 'IT',
  // Portugal
  'portugal': 'PT', 'lisbon': 'PT', 'lisboa': 'PT', 'porto': 'PT',
  // Canada
  'canada': 'CA', 'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA', 'montréal': 'CA',
  // Australia
  'australia': 'AU', 'sydney': 'AU', 'melbourne': 'AU', 'brisbane': 'AU',
  // Japan
  'japan': 'JP', 'tokyo': 'JP', 'osaka': 'JP',
  // South Korea
  'south korea': 'KR', 'korea': 'KR', 'seoul': 'KR',
  // India
  'india': 'IN', 'mumbai': 'IN', 'delhi': 'IN', 'bangalore': 'IN', 'bengaluru': 'IN',
  // Dominican Republic
  'república dominicana': 'DO', 'republica dominicana': 'DO', 'dominican republic': 'DO',
  'santo domingo': 'DO',
  // Venezuela
  'venezuela': 'VE', 'caracas': 'VE',
  // Ecuador
  'ecuador': 'EC', 'quito': 'EC', 'guayaquil': 'EC',
  // Uruguay
  'uruguay': 'UY', 'montevideo': 'UY',
  // Paraguay
  'paraguay': 'PY', 'asunción': 'PY',
  // Bolivia
  'bolivia': 'BO', 'la paz': 'BO',
  // Costa Rica
  'costa rica': 'CR', 'san josé': 'CR',
  // Panama
  'panama': 'PA', 'panamá': 'PA',
  // Cuba
  'cuba': 'CU', 'havana': 'CU', 'la habana': 'CU',
  // Puerto Rico
  'puerto rico': 'PR', 'san juan': 'PR',
}

// ISO country code map for direct matches (e.g. YouTube returns "US", "ES")
const ISO_COUNTRY_CODES = new Set([
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW',
])

/**
 * Detect country code from profile data fields.
 * Checks locationName, biography, city, and other location-related fields.
 * Returns a 2-letter ISO country code or null.
 */
export function detectCountry(profile: Record<string, unknown>): string | null {
  // 1. Check if there's already a direct country code (e.g. YouTube)
  const directCountry = (profile.country as string) || (profile.countryCode as string) || ''
  if (directCountry && ISO_COUNTRY_CODES.has(directCountry.toUpperCase())) {
    return directCountry.toUpperCase()
  }

  // 2. Collect all text fields that might contain location info
  const locationFields = [
    profile.locationName,
    profile.location,
    profile.city,
    profile.region,
    profile.addressStreet,
    profile.businessCategoryName,
    profile.contactPhoneNumber,
  ].filter(Boolean).map(f => String(f).toLowerCase().trim())

  // Also check bio but with lower priority
  const bio = ((profile.biography as string) || (profile.bio as string) || '').toLowerCase()

  // 3. Try matching location fields first (more reliable)
  for (const text of locationFields) {
    // Try multi-word matches first (longer keys first)
    const sortedKeys = Object.keys(LOCATION_TO_COUNTRY).sort((a, b) => b.length - a.length)
    for (const key of sortedKeys) {
      if (text.includes(key)) {
        return LOCATION_TO_COUNTRY[key]
      }
    }
  }

  // 4. Try matching in bio (less reliable, use flag emojis or explicit mentions)
  // Look for flag emojis
  const flagMatch = bio.match(/[\u{1F1E0}-\u{1F1FF}]{2}/u)
  if (flagMatch) {
    const flag = flagMatch[0]
    const first = flag.codePointAt(0)! - 0x1F1E5
    const second = flag.codePointAt(2)! - 0x1F1E5
    const code = String.fromCharCode(64 + first) + String.fromCharCode(64 + second)
    if (ISO_COUNTRY_CODES.has(code)) {
      return code
    }
  }

  // Look for location patterns in bio like "Based in Madrid" or "📍 Barcelona"
  const bioLocationPatterns = [
    /(?:based in|from|ubicad[oa] en|de|📍)\s+([a-záéíóúñü\s]+)/i,
  ]
  for (const pattern of bioLocationPatterns) {
    const match = bio.match(pattern)
    if (match) {
      const location = match[1].trim().toLowerCase()
      const sortedKeys = Object.keys(LOCATION_TO_COUNTRY).sort((a, b) => b.length - a.length)
      for (const key of sortedKeys) {
        if (location.includes(key)) {
          return LOCATION_TO_COUNTRY[key]
        }
      }
    }
  }

  return null
}

// ============ TYPES ============

export interface ScrapedProfile {
  username: string
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  followers: number
  following: number
  postsCount: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  isVerified: boolean
  website: string | null
  email: string | null
  country: string | null
  city: string | null
  recentPosts: ScrapedPost[]
}

export interface ScrapedPost {
  externalId: string
  caption: string | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  permalink: string | null
  mediaType: 'POST' | 'REEL' | 'STORY' | 'VIDEO' | 'SHORT' | 'CAROUSEL'
  likes: number
  comments: number
  shares: number
  saves: number
  views: number
  postedAt: string | null
  hashtags: string[]
  mentions: string[]
}

// ============ INSTAGRAM ============

/**
 * Maps one apify~instagram-profile-scraper dataset item to a ScrapedProfile.
 * Shared by the single-profile scraper and the batched one. Pure.
 */
export function mapInstagramProfileItem(profile: Record<string, unknown>, fallbackUsername: string): ScrapedProfile {
  // Extract email from bio if present
  const bio = (profile.biography as string) || ''
  const emailMatch = bio.match(/[\w.-]+@[\w.-]+\.\w+/)

  // Calculate engagement from recent posts
  const posts = ((profile.latestPosts as Record<string, unknown>[]) || []).slice(0, 12)
  const followers = (profile.followersCount as number) || 0

  let totalLikes = 0
  let totalComments = 0
  let totalViews = 0

  const recentPosts: ScrapedPost[] = posts.map((post: Record<string, unknown>) => {
    const likes = nonNegative(post.likesCount) // -1 = likes hidden by the creator
    const comments = (post.commentsCount as number) || 0
    const views = (post.videoViewCount as number) || (post.videoPlayCount as number) || 0

    totalLikes += likes
    totalComments += comments
    totalViews += views

    let mediaType: ScrapedPost['mediaType'] = 'POST'
    const type = (post.type as string) || ''
    if (type.includes('Video') || type.includes('Reel')) mediaType = 'REEL'
    else if (type.includes('Sidecar') || type.includes('Carousel')) mediaType = 'CAROUSEL'

    const caption = (post.caption as string) || ''
    const hashtags = caption.match(/#\w+/g) || []
    const mentions = caption.match(/@\w+/g) || []

    return {
      externalId: (post.id as string) || (post.shortCode as string) || '',
      caption,
      mediaUrl: (post.displayUrl as string) || (post.url as string) || null,
      thumbnailUrl: (post.thumbnailUrl as string) || (post.displayUrl as string) || null,
      permalink: post.shortCode ? `https://instagram.com/p/${post.shortCode}` : null,
      mediaType,
      likes,
      comments,
      shares: 0,
      saves: 0,
      views,
      postedAt: (post.timestamp as string) || null,
      hashtags,
      mentions,
    }
  })

  const postCount = posts.length || 1
  const avgLikes = Math.round(totalLikes / postCount)
  const avgComments = Math.round(totalComments / postCount)
  const avgViews = Math.round(totalViews / postCount)
  const engagementRate = followers > 0
    ? parseFloat(((((totalLikes + totalComments) / postCount) / followers) * 100).toFixed(2))
    : 0

  return {
    username: (profile.username as string) || fallbackUsername,
    displayName: (profile.fullName as string) || null,
    bio,
    avatarUrl: (profile.profilePicUrl as string) || (profile.profilePicUrlHD as string) || null,
    followers,
    following: (profile.followsCount as number) || (profile.followingCount as number) || 0,
    postsCount: (profile.postsCount as number) || 0,
    engagementRate,
    avgLikes,
    avgComments,
    avgViews,
    isVerified: (profile.verified as boolean) || (profile.isVerified as boolean) || false,
    website: (profile.externalUrl as string) || null,
    email: emailMatch ? emailMatch[0] : null,
    country: detectCountry(profile),
    city: (profile.locationName as string) || (profile.city as string) || null,
    recentPosts,
  }
}

async function scrapeInstagramProfile(username: string): Promise<ScrapedProfile | null> {
  const items = await runActor('apify~instagram-profile-scraper', {
    usernames: [username],
  })

  if (!items || items.length === 0) return null

  return mapInstagramProfileItem(items[0], username)
}

// ============ TIKTOK ============

async function scrapeTikTokProfile(username: string): Promise<ScrapedProfile | null> {
  const items = await runActor('clockworks~free-tiktok-scraper', {
    profiles: [username],
    resultsPerPage: 12,
    shouldDownloadVideos: false,
  })

  if (!items || items.length === 0) return null

  const firstItem = items[0]
  const authorMeta = (firstItem.authorMeta as Record<string, unknown>) || firstItem

  const followers = (authorMeta.fans as number) || (authorMeta.followers as number) || 0
  const following = (authorMeta.following as number) || 0

  let totalLikes = 0
  let totalComments = 0
  let totalViews = 0
  let totalShares = 0

  const recentPosts: ScrapedPost[] = items.slice(0, 12).map((post: Record<string, unknown>) => {
    const likes = (post.diggCount as number) || (post.likes as number) || 0
    const comments = (post.commentCount as number) || (post.comments as number) || 0
    const views = (post.playCount as number) || (post.plays as number) || 0
    const shares = (post.shareCount as number) || (post.shares as number) || 0

    totalLikes += likes
    totalComments += comments
    totalViews += views
    totalShares += shares

    const text = (post.text as string) || ''
    const hashtags = (post.hashtags as { name: string }[] || []).map(h => `#${h.name}`)
    const mentions = text.match(/@\w+/g) || []

    return {
      externalId: (post.id as string) || '',
      caption: text,
      mediaUrl: (post.videoUrl as string) || null,
      thumbnailUrl: (post.covers as Record<string, string>)?.default || (post.coverUrl as string) || (post.cover as string) || (post.thumbnailUrl as string) || null,
      permalink: (post.webVideoUrl as string) || `https://tiktok.com/@${username}/video/${post.id}`,
      mediaType: 'VIDEO' as const,
      likes,
      comments,
      shares,
      saves: 0,
      views,
      postedAt: post.createTimeISO as string || null,
      hashtags,
      mentions,
    }
  })

  const postCount = recentPosts.length || 1
  const avgLikes = Math.round(totalLikes / postCount)
  const avgComments = Math.round(totalComments / postCount)
  const avgViews = Math.round(totalViews / postCount)
  const engagementRate = followers > 0
    ? parseFloat(((((totalLikes + totalComments) / postCount) / followers) * 100).toFixed(2))
    : 0

  const bio = (authorMeta.signature as string) || (authorMeta.bio as string) || ''
  const emailMatch = bio.match(/[\w.-]+@[\w.-]+\.\w+/)

  return {
    username: (authorMeta.name as string) || (authorMeta.uniqueId as string) || username,
    displayName: (authorMeta.nickName as string) || (authorMeta.nickname as string) || null,
    bio,
    avatarUrl: (authorMeta.avatar as string) || (authorMeta.avatarUrl as string) || null,
    followers,
    following,
    postsCount: (authorMeta.video as number) || (authorMeta.videoCount as number) || 0,
    engagementRate,
    avgLikes,
    avgComments,
    avgViews,
    isVerified: (authorMeta.verified as boolean) || false,
    website: null,
    email: emailMatch ? emailMatch[0] : null,
    country: detectCountry(authorMeta as Record<string, unknown>),
    city: null,
    recentPosts,
  }
}

// ============ YOUTUBE ============

async function scrapeYouTubeProfile(username: string): Promise<ScrapedProfile | null> {
  const items = await runActor('streamers~youtube-channel-scraper', {
    channelUrls: [`https://youtube.com/@${username}`],
    maxVideos: 12,
  })

  if (!items || items.length === 0) return null

  const channel = items[0]

  const followers = (channel.subscriberCount as number) || (channel.numberOfSubscribers as number) || 0
  const videos = (channel.videos as Record<string, unknown>[]) || []

  let totalLikes = 0
  let totalComments = 0
  let totalViews = 0

  const recentPosts: ScrapedPost[] = videos.slice(0, 12).map((video: Record<string, unknown>) => {
    const likes = (video.likes as number) || 0
    const comments = (video.numberOfComments as number) || (video.commentCount as number) || 0
    const views = (video.viewCount as number) || (video.views as number) || 0

    totalLikes += likes
    totalComments += comments
    totalViews += views

    const title = (video.title as string) || ''
    const description = (video.description as string) || ''
    const hashtags = (title + ' ' + description).match(/#\w+/g) || []

    const duration = (video.duration as string) || ''
    const isShort = duration && parseInt(duration) < 61
    const mediaType = isShort ? 'SHORT' : 'VIDEO'

    return {
      externalId: (video.id as string) || (video.videoId as string) || '',
      caption: title,
      mediaUrl: null,
      thumbnailUrl: (video.thumbnailUrl as string) || (video.thumbnail as string) || null,
      permalink: video.url as string || (video.id ? `https://youtube.com/watch?v=${video.id}` : null),
      mediaType: mediaType as ScrapedPost['mediaType'],
      likes,
      comments,
      shares: 0,
      saves: 0,
      views,
      postedAt: (video.publishedAt as string) || (video.date as string) || null,
      hashtags,
      mentions: [],
    }
  })

  const postCount = recentPosts.length || 1
  const avgLikes = Math.round(totalLikes / postCount)
  const avgComments = Math.round(totalComments / postCount)
  const avgViews = Math.round(totalViews / postCount)
  const engagementRate = followers > 0
    ? parseFloat(((((totalLikes + totalComments) / postCount) / followers) * 100).toFixed(2))
    : 0

  const description = (channel.channelDescription as string) || (channel.description as string) || ''
  const emailMatch = description.match(/[\w.-]+@[\w.-]+\.\w+/)

  return {
    username: (channel.channelName as string) || (channel.title as string) || username,
    displayName: (channel.channelName as string) || (channel.title as string) || null,
    bio: description,
    avatarUrl: (channel.channelAvatarUrl as string) || (channel.avatar as string) || null,
    followers,
    following: 0,
    postsCount: (channel.numberOfVideos as number) || (channel.videoCount as number) || 0,
    engagementRate,
    avgLikes,
    avgComments,
    avgViews,
    isVerified: (channel.isVerified as boolean) || false,
    website: null,
    email: emailMatch ? emailMatch[0] : null,
    country: (channel.country as string) || null,
    city: null,
    recentPosts,
  }
}

// ============ HASHTAG SCRAPING (for Social Listening) ============

export interface HashtagResult {
  posts: ScrapedPost[]
  authorUsername: string
  authorDisplayName: string | null
  authorAvatarUrl: string | null
  authorFollowers: number
  authorCountry?: string | null
}

async function scrapeInstagramHashtag(hashtag: string, maxPosts = 20): Promise<HashtagResult[]> {
  const cleanTag = hashtag.replace(/^#/, '')

  const items = await runActor('apify~instagram-hashtag-scraper', {
    hashtags: [cleanTag],
    resultsLimit: maxPosts,
  })

  if (!items || items.length === 0) return []

  return items.map((post: Record<string, unknown>) => {
    const owner = (post.ownerUsername as string) || ''
    const caption = (post.caption as string) || ''
    const hashtags = caption.match(/#\w+/g) || []
    const mentions = caption.match(/@\w+/g) || []

    // Extract location data from post for country detection
    const locationName = (post.locationName as string) || ''
    const ownerBio = (post.ownerBiography as string) || ''
    const authorCountry = detectCountry({
      locationName,
      location: locationName,
      biography: ownerBio,
    })

    return {
      posts: [{
        externalId: (post.id as string) || (post.shortCode as string) || '',
        caption,
        mediaUrl: (post.displayUrl as string) || null,
        thumbnailUrl: (post.thumbnailUrl as string) || (post.displayUrl as string) || null,
        permalink: post.shortCode ? `https://instagram.com/p/${post.shortCode}` : null,
        mediaType: ((post.type as string) || '').includes('Video') ? 'REEL' as const : 'POST' as const,
        likes: nonNegative(post.likesCount),
        comments: (post.commentsCount as number) || 0,
        shares: 0,
        saves: 0,
        views: (post.videoViewCount as number) || 0,
        postedAt: (post.timestamp as string) || null,
        hashtags,
        mentions,
      }],
      authorUsername: owner,
      authorDisplayName: (post.ownerFullName as string) || null,
      authorAvatarUrl: null,
      authorFollowers: 0,
      authorCountry,
    }
  })
}

// ============ ACCOUNT MENTIONS / TAGGED POSTS ============

/**
 * Scrape posts where a specific account is tagged/mentioned.
 * Uses Instagram Hashtag Scraper with @mention search + account's own tagged posts.
 * This captures: posts where someone tags @account in caption or photo tag.
 */
async function scrapeInstagramAccountMentions(username: string, maxPosts = 50): Promise<HashtagResult[]> {
  const cleanUsername = username.replace(/^@/, '')

  // Strategy 1: Scrape the account's tagged posts (posts where they are tagged in photos)
  try {
    const items = await runActor('apify~instagram-scraper', {
      directUrls: [`https://www.instagram.com/${cleanUsername}/tagged/`],
      resultsType: 'posts',
      resultsLimit: maxPosts,
    }, 180) // 3 min timeout

    if (items && items.length > 0) {
      return items.map((post: Record<string, unknown>) => {
        const owner = (post.ownerUsername as string) || ''
        // Skip the brand's own posts
        if (owner.toLowerCase() === cleanUsername.toLowerCase()) return null

        const caption = (post.caption as string) || ''
        const hashtags = caption.match(/#\w+/g) || []
        const mentions = caption.match(/@\w+/g) || []
        const locationName = (post.locationName as string) || ''
        const ownerBio = (post.ownerBiography as string) || ''
        const authorCountry = detectCountry({
          locationName,
          location: locationName,
          biography: ownerBio,
        })

        return {
          posts: [{
            externalId: (post.id as string) || (post.shortCode as string) || '',
            caption,
            mediaUrl: (post.displayUrl as string) || null,
            thumbnailUrl: (post.thumbnailUrl as string) || (post.displayUrl as string) || null,
            permalink: post.shortCode ? `https://instagram.com/p/${post.shortCode}` : null,
            mediaType: ((post.type as string) || '').includes('Video') ? 'REEL' as const : 'POST' as const,
            likes: nonNegative(post.likesCount),
            comments: (post.commentsCount as number) || 0,
            shares: 0,
            saves: 0,
            views: (post.videoViewCount as number) || 0,
            postedAt: (post.timestamp as string) || null,
            hashtags,
            mentions,
          }],
          authorUsername: owner,
          authorDisplayName: (post.ownerFullName as string) || null,
          authorAvatarUrl: (post.ownerProfilePicUrl as string) || null,
          authorFollowers: (post.ownerFollowerCount as number) || 0,
          authorCountry,
        } as HashtagResult
      }).filter((r): r is HashtagResult => r !== null)
    }
  } catch (err) {
    console.warn(`[Apify] Tagged posts scraping for @${cleanUsername} failed:`, err)
  }

  return []
}

/**
 * Scrape mentions of an account across platforms.
 */
export async function scrapeAccountMentions(
  username: string,
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  maxPosts = 50
): Promise<HashtagResult[]> {
  if (platform !== 'INSTAGRAM') {
    console.log(`[Apify] Account mention scraping not supported for ${platform}`)
    return []
  }

  const cacheKey = `mentions:${platform}:${username.toLowerCase().replace(/^@/, '')}:${maxPosts}`
  const cached = cacheGet<HashtagResult[]>(cacheKey)
  if (cached !== undefined) {
    console.log(`[Apify] Cache hit for ${cacheKey} — skipping paid scrape`)
    return cached
  }

  const result = await scrapeInstagramAccountMentions(username, maxPosts)
  // Don't negative-cache empties caused by the exhausted-limit circuit breaker
  if (result.length === 0 && isApifyExhausted()) return result
  cacheSet(cacheKey, result, result.length > 0 ? LIST_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
  return result
}

// ============ INSTAGRAM STORIES ============

export interface ScrapedStory {
  externalId: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  /** https://www.instagram.com/stories/{username}/{pk}/ — valid while the story is live */
  permalink: string | null
  mediaType: 'STORY'
  views: number
  postedAt: string | null
  expiresAt: string | null
  mentions: string[]
  hashtags: string[]
  stickers: string[]
}

export interface StoryResult {
  username: string
  stories: ScrapedStory[]
}

async function parseStoryItems(items: Record<string, unknown>[]): Promise<StoryResult[]> {
  const storyMap = new Map<string, ScrapedStory[]>()
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null)

  for (const item of items) {
    // Raw IG story object (datavoyantlab / louisdeconinck) — owner under `user`;
    // older/other actors use ownerUsername / owner.username.
    const user = item.user as Record<string, unknown> | undefined
    const owner = item.owner as Record<string, unknown> | undefined
    const username = (str(user?.username) || str(item.ownerUsername) || str(owner?.username) || str(item.username) || '').replace(/^@/, '')
    if (!username) continue

    const pk = str(item.pk) || (str(item.id) || '').split('_')[0] || null
    const externalId = pk || str(item.id) || `story_${username}_${str(item.taken_at) || str(item.takenAtTimestamp) || Date.now()}`

    const imageCandidates = ((item.image_versions2 as Record<string, unknown> | undefined)?.candidates as Array<Record<string, unknown>> | undefined) || []
    const videoVersions = (item.video_versions as Array<Record<string, unknown>> | undefined) || []
    const imageUrl = str(imageCandidates[0]?.url) || str(item.displayUrl) || str(item.imageUrl) || null
    const videoUrl = str(videoVersions[0]?.url) || str(item.videoUrl) || null

    const takenAt = typeof item.taken_at === 'number' ? item.taken_at : typeof item.takenAtTimestamp === 'number' ? item.takenAtTimestamp : null
    const expiringAt = typeof item.expiring_at === 'number' ? item.expiring_at : typeof item.expiringAtTimestamp === 'number' ? item.expiringAtTimestamp : null

    // Mention stickers (`reel_mentions[].user.username`) and hashtag stickers
    // (`story_hashtags[].hashtag.name`) are what rule (3) matches against.
    const reelMentions = (item.reel_mentions as Array<Record<string, unknown>> | undefined) || []
    const storyHashtags = (item.story_hashtags as Array<Record<string, unknown>> | undefined) || []
    const linkStickers = (item.story_link_stickers as Array<Record<string, unknown>> | undefined) || []
    const mentions = Array.from(new Set([
      ...reelMentions.map(m => str((m.user as Record<string, unknown> | undefined)?.username)).filter((x): x is string => !!x),
      ...((item.mentions as string[] | undefined) || []),
    ].map(m => m.replace(/^@/, '').toLowerCase())))
    const hashtags = Array.from(new Set([
      ...storyHashtags.map(h => str((h.hashtag as Record<string, unknown> | undefined)?.name)).filter((x): x is string => !!x),
      ...((item.hashtags as string[] | undefined) || []),
    ].map(h => h.replace(/^#/, '').toLowerCase())))
    const stickers = [
      ...linkStickers.map(l => str((l.story_link as Record<string, unknown> | undefined)?.url)).filter((x): x is string => !!x),
      ...((item.stickers as string[] | undefined) || []),
    ]

    const story: ScrapedStory = {
      externalId,
      mediaUrl: videoUrl || imageUrl,
      thumbnailUrl: imageUrl || str(item.thumbnailUrl),
      permalink: pk ? `https://www.instagram.com/stories/${username}/${pk}/` : null,
      mediaType: 'STORY',
      views: (item.viewerCount as number) || (item.view_count as number) || (item.views as number) || 0,
      postedAt: takenAt ? new Date(takenAt * 1000).toISOString() : str(item.timestamp) || str(item.takenAt) || null,
      expiresAt: expiringAt ? new Date(expiringAt * 1000).toISOString() : null,
      mentions,
      hashtags,
      stickers,
    }

    const existing = storyMap.get(username) || []
    existing.push(story)
    storyMap.set(username, existing)
  }

  return Array.from(storyMap.entries()).map(([username, stories]) => ({ username, stories }))
}

/**
 * Instagram stories via Apify. `apify~instagram-story-scraper` no longer exists
 * (404 since at least Aug 2026) and `apify~instagram-scraper` does not return
 * stories, so nothing was ever captured. Measured 2026-09-04: these two
 * pay-per-result actors return the raw IG story objects for public accounts
 * (owner, taken_at/expiring_at, image/video urls, mention + hashtag stickers)
 * at ~$0.005-0.008 per story.
 */
const STORY_ACTORS = [
  'datavoyantlab~advanced-instagram-stories-scraper',
  'louisdeconinck~instagram-story-details-scraper',
]

/**
 * The stories actor charges 0,099 $ per START plus 0,003 $ per username and
 * accepts up to 100 usernames per run: one run for everybody is 5× cheaper
 * than five runs of 20. Never call it for a single creator.
 */
export const STORIES_BATCH_MAX = 100

async function scrapeInstagramStories(usernames: string[]): Promise<StoryResult[]> {
  const usernameSlice = usernames.slice(0, STORIES_BATCH_MAX)
  console.log(`[Apify] Story scrape requested for ${usernameSlice.length} usernames: ${usernameSlice.join(', ')}`)

  for (const actor of STORY_ACTORS) {
    try {
      console.log(`[Apify] Trying story actor: ${actor}`)
      const items = await runActor(actor, { usernames: usernameSlice }, 300)
      if (items && items.length > 0) {
        console.log(`[Apify] ${actor} returned ${items.length} story items`)
        return parseStoryItems(items)
      }
      // A clean empty result is a real answer (nobody has live stories) — no need to pay a second actor
      console.log(`[Apify] ${actor} returned 0 items for ${usernameSlice.length} usernames`)
      return []
    } catch (err) {
      if (err instanceof Error && err.message === 'APIFY_EXHAUSTED') throw err
      console.error(`[Apify] Story actor ${actor} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return []
}

export async function scrapeStories(usernames: string[], platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'): Promise<StoryResult[]> {
  if (platform !== 'INSTAGRAM') {
    // Stories only supported on Instagram for now
    return []
  }

  // Short TTL: stories expire in 24h so freshness matters, but a 30min cache
  // absorbs repeated "Track Now" clicks without paying Apify each time
  const cacheKey = `stories:${platform}:${usernames.map(u => u.toLowerCase()).sort().join(',')}`
  const cached = cacheGet<StoryResult[]>(cacheKey)
  if (cached !== undefined) {
    console.log(`[Apify] Cache hit for stories batch (${usernames.length} users) — skipping paid scrape`)
    return cached
  }

  const result = await scrapeInstagramStories(usernames)
  // Don't negative-cache empties caused by the exhausted-limit circuit breaker
  if (result.length === 0 && isApifyExhausted()) return result
  cacheSet(cacheKey, result, result.length > 0 ? 30 * 60 * 1000 : NEGATIVE_CACHE_TTL_MS)
  return result
}

// ============ PUBLIC API ============

// NOTE: the profile scraper's relatedProfiles field is always empty, so the
// former "Sugerido por Instagram" similar-accounts helper and the paid
// Instagram keyword-search actor are gone: similar creators and searches
// come from our own creator pool now.

// ============ IN-MEMORY SCRAPE CACHE (Apify cost saver) ============
// The production deployment is a long-lived Node process, so this cache
// persists across requests until redeploy. Repeated "Track Now" clicks and
// overlapping crons no longer pay Apify twice for the same target.
// Empty/failed results get a short negative-cache TTL so a transient Apify
// failure doesn't hide data for hours but also doesn't get hammered.

const SCRAPE_CACHE_MAX_ENTRIES = 500
const PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — matches track cron cadence
const LIST_CACHE_TTL_MS = 2 * 60 * 60 * 1000    // 2h — hashtag/mention feeds move faster
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000    // 10min — retry failures soon

interface CacheEntry<T> {
  data: T
  at: number
  ttl: number
}

const _scrapeCache = new Map<string, CacheEntry<unknown>>()

function cacheGet<T>(key: string): T | undefined {
  const entry = _scrapeCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > entry.ttl) {
    _scrapeCache.delete(key)
    return undefined
  }
  return entry.data as T
}

function cacheSet<T>(key: string, data: T, ttl: number) {
  // Simple FIFO eviction — oldest insertion goes first
  if (_scrapeCache.size >= SCRAPE_CACHE_MAX_ENTRIES) {
    const oldest = _scrapeCache.keys().next().value
    if (oldest !== undefined) _scrapeCache.delete(oldest)
  }
  _scrapeCache.set(key, { data, at: Date.now(), ttl })
}

/** Cache key of a profile scrape — shared by scrapeProfile and scrapeInstagramProfilesBatch. */
function profileCacheKey(platform: string, username: string): string {
  return `profile:${platform}:${username.toLowerCase()}`
}

export async function scrapeProfile(username: string, platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'): Promise<ScrapedProfile | null> {
  const cacheKey = profileCacheKey(platform, username)
  const cached = cacheGet<ScrapedProfile | null>(cacheKey)
  if (cached !== undefined) {
    console.log(`[Apify] Cache hit for ${cacheKey} — skipping paid scrape`)
    return cached
  }

  let result: ScrapedProfile | null
  try {
    switch (platform) {
      case 'INSTAGRAM':
        result = await scrapeInstagramProfile(username)
        break
      case 'TIKTOK':
        result = await scrapeTikTokProfile(username)
        break
      case 'YOUTUBE':
        result = await scrapeYouTubeProfile(username)
        break
      default:
        throw new Error(`Unsupported platform: ${platform}`)
    }
  } catch (err) {
    // Circuit breaker open: return null fast and do NOT negative-cache —
    // caching would mask recovery once the usage cycle resets
    if (isExhaustedError(err)) return null
    throw err
  }

  cacheSet(cacheKey, result, result ? PROFILE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
  return result
}

// ============ BATCHED INSTAGRAM PROFILES (Discover enrichment) ============

/** Usernames per apify~instagram-profile-scraper run in the batched path. */
export const PROFILE_BATCH_MAX = 25

/**
 * Scrapes many Instagram profiles with ONE actor run per chunk of up to
 * PROFILE_BATCH_MAX usernames (0,0023 $ per profile and no start fee, so the
 * price equals one-by-one scraping but the PM waits for a single run).
 *
 * Shares the profile cache with scrapeProfile: usernames with a cached entry
 * (positive or negative) are not sent again and every profile returned is
 * cached for PROFILE_CACHE_TTL_MS. Only handles the actor explicitly reports
 * as failed (not found / private) get the short negative TTL; usernames a run
 * simply omitted (rate-limited, renamed, or returned under another spelling)
 * are left uncached so a later single scrapeProfile() can still try them —
 * the cache key is shared with /analyze, /discovery/batch and the captures.
 *
 * Returns a map keyed by lowercased username. If the monthly limit trips
 * mid-way (APIFY_EXHAUSTED) the map built so far is returned; any other actor
 * error is logged and also yields the partial map — enrichment is best-effort.
 */
export async function scrapeInstagramProfilesBatch(usernames: string[]): Promise<Map<string, ScrapedProfile>> {
  const out = new Map<string, ScrapedProfile>()
  const pending: string[] = []
  const seen = new Set<string>()

  for (const raw of usernames) {
    const username = (raw || '').trim().replace(/^@+/, '')
    const key = username.toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const cached = cacheGet<ScrapedProfile | null>(profileCacheKey('INSTAGRAM', key))
    if (cached !== undefined) {
      if (cached) out.set(key, cached)
      continue
    }
    pending.push(username)
  }
  if (pending.length === 0) {
    if (seen.size > 0) console.log(`[Apify] Instagram profile batch: all ${seen.size} usernames served from cache`)
    return out
  }

  for (let i = 0; i < pending.length; i += PROFILE_BATCH_MAX) {
    const chunk = pending.slice(i, i + PROFILE_BATCH_MAX)
    let items: Record<string, unknown>[]
    let succeeded: boolean
    try {
      ;({ items, succeeded } = await runActorDetailed('apify~instagram-profile-scraper', { usernames: chunk }, 180))
    } catch (err) {
      if (!isExhaustedError(err)) {
        console.error('[Apify] Instagram profile batch error:', err instanceof Error ? err.message : err)
      }
      return out
    }

    const chunkKeys = new Set(chunk.map(u => u.toLowerCase()))
    const returned = new Set<string>()
    const failed = new Set<string>()
    for (const item of items || []) {
      if (!item || typeof item !== 'object') continue
      if (item.error) {
        // The actor names the account it could not load: only THAT handle is
        // negative-cached. Handles merely absent from the run stay uncached.
        const failedKey = typeof item.username === 'string' ? item.username.trim().replace(/^@+/, '').toLowerCase() : ''
        if (failedKey && chunkKeys.has(failedKey)) failed.add(failedKey)
        continue
      }
      const profile = mapInstagramProfileItem(item, '')
      const key = profile.username.toLowerCase()
      if (!key) continue
      returned.add(key)
      out.set(key, profile)
      cacheSet(profileCacheKey('INSTAGRAM', key), profile, PROFILE_CACHE_TTL_MS)
    }
    for (const key of failed) {
      if (!returned.has(key)) cacheSet(profileCacheKey('INSTAGRAM', key), null, NEGATIVE_CACHE_TTL_MS)
    }
    console.log(`[Apify] Instagram profile batch: ${chunk.length} sent, ${returned.size} returned, ${failed.size} reported failed${succeeded ? '' : ' (partial run)'}`)
  }

  return out
}

async function scrapeTikTokHashtag(hashtag: string, maxPosts = 20): Promise<HashtagResult[]> {

  const cleanTag = hashtag.replace(/^#/, '')

  try {
    // Use the free-tiktok-scraper actor with a hashtag search URL
    const items = await runActor('clockworks~free-tiktok-scraper', {
      hashtags: [cleanTag],
      resultsPerPage: maxPosts,
      shouldDownloadVideos: false,
    }, 180)

    if (!items || items.length === 0) {
      console.log(`[Apify] TikTok hashtag: free-tiktok-scraper returned 0 results for #${cleanTag}, trying fallback`)
      // Fallback: use apify~tiktok-scraper which supports hashtag search
      const fallbackItems = await runActor('apify~tiktok-scraper', {
        hashtags: [cleanTag],
        resultsPerPage: maxPosts,
        searchSection: '',
      }, 180)

      if (!fallbackItems || fallbackItems.length === 0) return []

      return fallbackItems.map((post: Record<string, unknown>) => {
        const authorMeta = (post.authorMeta as Record<string, unknown>) || {}
        const text = (post.text as string) || ''
        const hashtags = (post.hashtags as { name: string }[] || []).map(h => `#${h.name}`)
        const mentions = text.match(/@\w+/g) || []
        const authorCountry = detectCountry(authorMeta)

        return {
          posts: [{
            externalId: (post.id as string) || '',
            caption: text,
            mediaUrl: (post.videoUrl as string) || null,
            thumbnailUrl: (post.covers as Record<string, string>)?.default || (post.coverUrl as string) || (post.cover as string) || null,
            permalink: (post.webVideoUrl as string) || null,
            mediaType: 'VIDEO' as const,
            likes: nonNegative(post.diggCount) || nonNegative(post.likes),
            comments: (post.commentCount as number) || (post.comments as number) || 0,
            shares: (post.shareCount as number) || (post.shares as number) || 0,
            saves: 0,
            views: (post.playCount as number) || (post.plays as number) || 0,
            postedAt: (post.createTimeISO as string) || null,
            hashtags,
            mentions,
          }],
          authorUsername: (authorMeta.name as string) || (authorMeta.uniqueId as string) || '',
          authorDisplayName: (authorMeta.nickName as string) || (authorMeta.nickname as string) || null,
          authorAvatarUrl: (authorMeta.avatar as string) || null,
          authorFollowers: (authorMeta.fans as number) || (authorMeta.followers as number) || 0,
          authorCountry,
        }
      })
    }

    // Process results from free-tiktok-scraper
    return items.map((post: Record<string, unknown>) => {
      const authorMeta = (post.authorMeta as Record<string, unknown>) || {}
      const text = (post.text as string) || ''
      const postHashtags = (post.hashtags as { name: string }[] || []).map(h => `#${h.name}`)
      const mentions = text.match(/@\w+/g) || []
      const authorCountry = detectCountry(authorMeta)

      return {
        posts: [{
          externalId: (post.id as string) || '',
          caption: text,
          mediaUrl: (post.videoUrl as string) || null,
          thumbnailUrl: (post.covers as Record<string, string>)?.default || (post.coverUrl as string) || (post.cover as string) || null,
          permalink: (post.webVideoUrl as string) || `https://tiktok.com/@${(authorMeta.name as string) || ''}/video/${post.id}`,
          mediaType: 'VIDEO' as const,
          likes: nonNegative(post.diggCount) || nonNegative(post.likes),
          comments: (post.commentCount as number) || (post.comments as number) || 0,
          shares: (post.shareCount as number) || (post.shares as number) || 0,
          saves: 0,
          views: (post.playCount as number) || (post.plays as number) || 0,
          postedAt: (post.createTimeISO as string) || null,
          hashtags: postHashtags,
          mentions,
        }],
        authorUsername: (authorMeta.name as string) || (authorMeta.uniqueId as string) || '',
        authorDisplayName: (authorMeta.nickName as string) || (authorMeta.nickname as string) || null,
        authorAvatarUrl: (authorMeta.avatar as string) || null,
        authorFollowers: (authorMeta.fans as number) || (authorMeta.followers as number) || 0,
        authorCountry,
      }
    })
  } catch (err) {
    console.error(`[Apify] TikTok hashtag scraping error for #${cleanTag}:`, err)
    return []
  }
}

async function scrapeYouTubeHashtag(hashtag: string, maxPosts = 20): Promise<HashtagResult[]> {
  const cleanTag = hashtag.replace(/^#/, '')

  try {
    // Use the YouTube scraper actor to search for videos by keyword/hashtag
    const items = await runActor('streamers~youtube-channel-scraper', {
      searchKeywords: [cleanTag],
      maxVideos: maxPosts,
      searchType: 'video',
    }, 180)

    if (!items || items.length === 0) {
      console.log(`[Apify] YouTube hashtag: streamers actor returned 0, trying bernardo~youtube-scraper`)
      // Fallback actor
      const fallbackItems = await runActor('bernardo~youtube-scraper', {
        searchQueries: [`#${cleanTag}`],
        maxResults: maxPosts,
      }, 180)

      if (!fallbackItems || fallbackItems.length === 0) return []
      return mapYouTubeHashtagItems(fallbackItems)
    }

    return mapYouTubeHashtagItems(items)
  } catch (err) {
    console.error(`[Apify] YouTube hashtag scraping error for #${cleanTag}:`, err)
    return []
  }
}

function mapYouTubeHashtagItems(items: Record<string, unknown>[]): HashtagResult[] {
  return items.map((video: Record<string, unknown>) => {
    const title = (video.title as string) || ''
    const description = (video.description as string) || ''
    const hashtags = (title + ' ' + description).match(/#\w+/g) || []
    const channelName = (video.channelName as string) || (video.channelTitle as string) || (video.author as string) || ''
    const channelUrl = (video.channelUrl as string) || ''
    // Try to extract username from channel URL (e.g., https://youtube.com/@username)
    const usernameMatch = channelUrl.match(/@([^/]+)/)

    const duration = (video.duration as string) || ''
    const durationSecs = parseInt(duration) || 0
    const isShort = durationSecs > 0 && durationSecs < 61
    const mediaType = isShort ? 'SHORT' : 'VIDEO'

    return {
      posts: [{
        externalId: (video.id as string) || (video.videoId as string) || '',
        caption: title,
        mediaUrl: null,
        thumbnailUrl: (video.thumbnailUrl as string) || (video.thumbnail as string) || null,
        permalink: (video.url as string) || (video.id ? `https://youtube.com/watch?v=${video.id}` : null),
        mediaType: mediaType as ScrapedPost['mediaType'],
        likes: nonNegative(video.likes),
        comments: (video.numberOfComments as number) || (video.commentCount as number) || 0,
        shares: 0,
        saves: 0,
        views: (video.viewCount as number) || (video.views as number) || 0,
        postedAt: (video.publishedAt as string) || (video.date as string) || (video.uploadDate as string) || null,
        hashtags,
        mentions: [],
      }],
      authorUsername: usernameMatch?.[1] || channelName,
      authorDisplayName: channelName || null,
      authorAvatarUrl: (video.channelAvatarUrl as string) || null,
      authorFollowers: (video.subscriberCount as number) || 0,
      authorCountry: null,
    }
  })
}

export async function scrapeHashtag(hashtag: string, platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', maxPosts = 20): Promise<HashtagResult[]> {
  const cacheKey = `hashtag:${platform}:${hashtag.toLowerCase().replace(/^#/, '')}:${maxPosts}`
  const cached = cacheGet<HashtagResult[]>(cacheKey)
  if (cached !== undefined) {
    console.log(`[Apify] Cache hit for ${cacheKey} — skipping paid scrape`)
    return cached
  }

  let result: HashtagResult[]
  try {
    switch (platform) {
      case 'INSTAGRAM':
        result = await scrapeInstagramHashtag(hashtag, maxPosts)
        break
      case 'TIKTOK':
        result = await scrapeTikTokHashtag(hashtag, maxPosts)
        break
      case 'YOUTUBE':
        result = await scrapeYouTubeHashtag(hashtag, maxPosts)
        break
      default:
        return []
    }
  } catch (err) {
    if (isExhaustedError(err)) return []
    throw err
  }

  // Don't negative-cache breaker-caused empties (TikTok/YouTube paths catch internally)
  if (result.length === 0 && isApifyExhausted()) return result

  cacheSet(cacheKey, result, result.length > 0 ? LIST_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
  return result
}

// ============ COMMENT SCRAPING ============

export interface ScrapedComment {
  externalId: string
  text: string
  authorUsername: string
  authorAvatarUrl: string | null
  likes: number
  replies: number
  postedAt: string | null
}

async function scrapeInstagramComments(
  postUrls: string[],
  maxComments = 50
): Promise<ScrapedComment[]> {
  const items = await runActor('apify~instagram-comment-scraper', {
    directUrls: postUrls,
    resultsPerPage: maxComments,
  })

  if (!items || items.length === 0) return []

  return items
    .filter((item) => (item.text as string)?.trim())
    .map((item: Record<string, unknown>) => ({
      externalId: (item.id as string) || (item.pk as string) || `comment_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text: (item.text as string) || '',
      authorUsername: (item.ownerUsername as string) || (item.username as string) || 'unknown',
      authorAvatarUrl: (item.ownerProfilePicUrl as string) || (item.profilePicUrl as string) || null,
      likes: nonNegative(item.likesCount) || nonNegative(item.likes),
      replies: (item.repliesCount as number) || (item.replies as number) || 0,
      postedAt: (item.timestamp as string) || (item.createdAt as string) || null,
    }))
}

export async function scrapeComments(
  postUrls: string[],
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  maxComments = 50
): Promise<ScrapedComment[]> {
  switch (platform) {
    case 'INSTAGRAM':
      try {
        return await scrapeInstagramComments(postUrls, maxComments)
      } catch (err) {
        if (isExhaustedError(err)) return []
        throw err
      }
    default:
      // Only Instagram supported for now
      console.log(`[Apify] Comment scraping not yet supported for ${platform}`)
      return []
  }
}

export function isApifyConfigured(): boolean {
  return !!process.env.APIFY_API_KEY
}

/** Async version that also checks the DB setting */
export async function isApifyConfiguredAsync(): Promise<boolean> {
  if (process.env.APIFY_API_KEY) return true
  const dbToken = await getTokenFromDb()
  return !!dbToken
}

// ============ SINGLE POST BY URL (manual campaign additions) ============

export interface ScrapedSinglePost {
  externalId: string | null
  caption: string | null
  likes: number
  comments: number
  views: number
  thumbnailUrl: string | null
  postedAt: string | null
  ownerUsername: string | null
  mediaType: ScrapedPost['mediaType']
  hashtags: string[]
  mentions: string[]
}

function nonNegative(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function mapInstagramSinglePost(item: Record<string, unknown>): ScrapedSinglePost | null {
  // The Apify IG actors emit { error, errorDescription } items for private/removed posts
  if (item.error || item.errorDescription) return null
  const caption = (item.caption as string) || ''
  const type = ((item.type as string) || '').toLowerCase()
  const productType = ((item.productType as string) || '').toLowerCase()
  let mediaType: ScrapedPost['mediaType'] = 'POST'
  if (type.includes('video') || productType === 'clips' || productType === 'reels' || productType === 'igtv') mediaType = 'REEL'
  else if (type.includes('sidecar') || type.includes('carousel')) mediaType = 'CAROUSEL'

  // Keep the same '#tag' / '@user' shape the tracking passes store from captions
  const rawTags = Array.isArray(item.hashtags) ? (item.hashtags as unknown[]) : []
  const rawMentions = Array.isArray(item.mentions) ? (item.mentions as unknown[]) : []
  const hashtags = rawTags.length
    ? rawTags.map(h => `#${String(h).replace(/^#/, '')}`)
    : (caption.match(/#\w+/g) || [])
  const mentions = rawMentions.length
    ? rawMentions.map(m => `@${String(m).replace(/^@/, '')}`)
    : (caption.match(/@\w+/g) || [])

  return {
    // Same precedence as the tracking passes (numeric id first) so a later
    // profile/hashtag scrape upserts onto this row instead of duplicating it
    externalId: (item.id as string) || (item.shortCode as string) || null,
    caption: caption || null,
    likes: nonNegative(item.likesCount), // -1 when likes are hidden
    comments: nonNegative(item.commentsCount),
    views: nonNegative(item.videoViewCount) || nonNegative(item.videoPlayCount),
    thumbnailUrl: (item.thumbnailUrl as string) || (item.displayUrl as string) || null,
    postedAt: (item.timestamp as string) || null,
    ownerUsername: (item.ownerUsername as string) || null,
    mediaType,
    hashtags,
    mentions,
  }
}

function mapTikTokSinglePost(item: Record<string, unknown>): ScrapedSinglePost | null {
  if (item.error) return null
  const authorMeta = (item.authorMeta as Record<string, unknown>) || {}
  const text = (item.text as string) || ''
  const rawTags = Array.isArray(item.hashtags) ? (item.hashtags as { name?: string }[]) : []
  const covers = (item.covers as Record<string, string>) || {}
  const videoMeta = (item.videoMeta as Record<string, unknown>) || {}
  const createTime = item.createTime as number | undefined

  return {
    externalId: item.id != null ? String(item.id) : null,
    caption: text || null,
    likes: nonNegative(item.diggCount),
    comments: nonNegative(item.commentCount),
    views: nonNegative(item.playCount),
    thumbnailUrl: covers.default || (videoMeta.coverUrl as string) || (item.coverUrl as string) || null,
    postedAt: (item.createTimeISO as string)
      || (createTime ? new Date(createTime * 1000).toISOString() : null),
    ownerUsername: (authorMeta.name as string) || (authorMeta.uniqueId as string) || null,
    mediaType: 'VIDEO',
    hashtags: rawTags.filter(h => h?.name).map(h => `#${h.name}`),
    mentions: text.match(/@\w+/g) || [],
  }
}

/**
 * Enrich ONE post/reel/video from its public URL (used when a PM adds content
 * to a campaign by hand). Instagram: apify~instagram-post-scraper first, then
 * apify~instagram-scraper as fallback. TikTok: clockworks~free-tiktok-scraper.
 * YouTube: not supported (returns null → caller falls back to manual metrics).
 * Never throws — any failure (incl. exhausted monthly limit) returns null.
 */
export async function scrapeSinglePost(url: string): Promise<ScrapedSinglePost | null> {
  if (isApifyExhausted()) return null

  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }

  const cacheKey = `post:${url}`
  const cached = cacheGet<ScrapedSinglePost | null>(cacheKey)
  if (cached !== undefined) {
    console.log(`[Apify] Cache hit for ${cacheKey} — skipping paid scrape`)
    return cached
  }

  let result: ScrapedSinglePost | null = null
  try {
    if (host.includes('instagram.com') || host.includes('instagr.am')) {
      // instagram-scraper is the one that actually returns reels in our logs (the
      // post-scraper came back empty on every row, costing a wasted run each time):
      // try it first and keep the post-scraper only as the fallback.
      let items: Record<string, unknown>[] = []
      try {
        items = await runActor('apify~instagram-scraper', { directUrls: [url], resultsType: 'posts', resultsLimit: 1 })
      } catch (err) {
        if (isExhaustedError(err)) return null
        console.warn('[Apify] instagram-scraper failed for single post, trying instagram-post-scraper:', err instanceof Error ? err.message : err)
      }
      if (items.length === 0) {
        // The post-scraper's input field for URLs is `username` (it accepts post
        // URLs); it has no `directUrls`, which is why it "came back empty".
        items = await runActor('apify~instagram-post-scraper', { username: [url], resultsLimit: 1 })
      }
      for (const item of items) {
        result = mapInstagramSinglePost(item)
        if (result) break
      }
    } else if (host.includes('tiktok.com')) {
      const items = await runActor('clockworks~free-tiktok-scraper', {
        postURLs: [url],
        resultsPerPage: 1,
        shouldDownloadVideos: false,
      })
      for (const item of items) {
        result = mapTikTokSinglePost(item)
        if (result) break
      }
    } else {
      return null
    }
  } catch (err) {
    if (isExhaustedError(err)) return null
    console.error('[Apify] Single post scrape failed:', err instanceof Error ? err.message : err)
    return null
  }

  // Don't negative-cache empties caused by the exhausted-limit circuit breaker
  if (result === null && isApifyExhausted()) return null
  cacheSet(cacheKey, result, result ? LIST_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
  return result
}

// ============ BATCH SINGLE POSTS (views enrichment) ============

/**
 * Instagram shortcode of a post/reel permalink (/p/, /reel/, /reels/, /tv/).
 * Local twin of instagramShortcode() in campaign-capture.ts — that module
 * imports this one, so importing it back here would be a circular import.
 * Same regex; keep them in sync.
 */
export function instagramShortcodeOf(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/)
  return m ? m[1] : null
}

/**
 * Apify bills apify~instagram-scraper 0,099 $ per RUN START and
 * apify~instagram-post-scraper per RESULT (list price ≈ 0,002 $ — NOT yet
 * measured on this path: until 2026-09-14 the post-scraper was called with a
 * field it does not have and every batch silently paid the fallback start
 * instead; re-measure before quoting a per-post figure). One run per post
 * (scrapeSinglePost) is the most expensive way to read 50 posts: measured
 * 2026-09-14, 105 posts ≈ 0,8 $. One run for up to POSTS_BATCH_MAX permalinks
 * costs the same per post whatever the batch size. Callers with more rows
 * split them into batches of this size.
 */
export const POSTS_BATCH_MAX = 50

/**
 * Least wall time scrapePostsBatch needs to start a run: Apify's 60 s
 * waitForFinish plus a couple of polls. With less than this left before the
 * caller's deadline the run is not started (its posts come back unresolved).
 */
export const POSTS_BATCH_MIN_RUN_MS = APIFY_WAIT_FOR_FINISH_MAX_SECS * 1000 + 2 * APIFY_POLL_INTERVAL_MS

export interface PostsBatchResult {
  /** Fetched posts keyed by the INPUT url string. */
  posts: Map<string, ScrapedSinglePost>
  /**
   * Input urls whose run did not give a final answer: the actor failed to
   * start / crashed, the run outlived the wait (partial dataset), the breaker
   * tripped, or there was no time left to run. Not negative-cached — the
   * caller must NOT record them as attempted; they can be retried next run.
   */
  unresolved: Set<string>
}

export interface PostsBatchOptions {
  /**
   * Absolute time (Date.now() based) by which every run must have returned.
   * Each run's wait is clipped to it and no run is started with less than
   * POSTS_BATCH_MIN_RUN_MS left; the fallback run is skipped when it does not
   * fit. Without it a run waits up to 60 s + 150 s of polling.
   */
  deadlineAt?: number
}

/**
 * Fetch up to POSTS_BATCH_MAX Instagram posts/reels in ONE actor run.
 *
 * - apify~instagram-post-scraper first ({ username: [post urls], resultsLimit: 1 }
 *   — its URL input is the `username` field, which accepts post URLs; it has
 *   no `directUrls`): pay per result, the cheapest option. Only when that run
 *   FINISHED and returned nothing at all, one run of apify~instagram-scraper
 *   (0,099 $ per start — never per post).
 * - Results are matched back to the input permalinks by Instagram shortcode
 *   (/p/ and /reel/ forms of the same post map to the same result). Distinct
 *   input URLs of one shortcode are sent ONCE and share the result. The
 *   returned Map is keyed by the INPUT url string.
 * - Per-URL cache entries (post:<url>) are honoured and written exactly like
 *   scrapeSinglePost, so a later single fetch of the same post is free.
 * - A run that outlived the wait (Apify caps waitForFinish at 60 s; then
 *   polling) is PARTIAL: what it returned is used, the rest is `unresolved`
 *   (no negative cache, no fallback run while the first one may still be
 *   running and billing).
 * - Never throws. While the monthly-limit breaker is open (isApifyExhausted())
 *   it returns only cache hits and negative-caches nothing.
 * - Non-Instagram URLs and URLs without a shortcode are left out of the result.
 *
 * More than POSTS_BATCH_MAX distinct uncached posts are processed in successive
 * runs of POSTS_BATCH_MAX (one run each).
 */
export async function scrapePostsBatch(urls: string[], options: PostsBatchOptions = {}): Promise<PostsBatchResult> {
  const out = new Map<string, ScrapedSinglePost>()
  const unresolved = new Set<string>()

  // Cache hits first; then the distinct Instagram posts (by shortcode) still to fetch.
  const toFetch: Array<{ code: string; urls: string[] }> = []
  const byInputCode = new Map<string, { code: string; urls: string[] }>()
  const seen = new Set<string>()
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }
    if (!host.includes('instagram.com') && !host.includes('instagr.am')) continue
    const code = instagramShortcodeOf(url)
    if (!code) continue
    const cached = cacheGet<ScrapedSinglePost | null>(`post:${url}`)
    if (cached !== undefined) {
      if (cached) out.set(url, cached)
      continue
    }
    const entry = byInputCode.get(code)
    if (entry) { entry.urls.push(url); continue }
    const fresh = { code, urls: [url] }
    byInputCode.set(code, fresh)
    toFetch.push(fresh)
  }
  if (toFetch.length === 0) {
    if (urls.length > 0) console.log(`[Apify] Posts batch: ${out.size}/${urls.length} served from cache, nothing to fetch`)
    return { posts: out, unresolved }
  }
  const markUnresolvedFrom = (index: number) => {
    for (const entry of toFetch.slice(index)) for (const url of entry.urls) unresolved.add(url)
  }
  if (isApifyExhausted()) { markUnresolvedFrom(0); return { posts: out, unresolved } }

  // Wait allowed for one run from now: waitForFinish (≤ 60 s) + polling, clipped to the deadline.
  const runWait = (): { waitSecs: number; pollMs: number } | null => {
    const left = options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now()
    if (left < POSTS_BATCH_MIN_RUN_MS) return null
    const waitSecs = APIFY_WAIT_FOR_FINISH_MAX_SECS
    const pollMs = Math.min(APIFY_DEFAULT_POLL_MS, Math.max(0, left - waitSecs * 1000))
    return { waitSecs, pollMs }
  }

  for (let i = 0; i < toFetch.length; i += POSTS_BATCH_MAX) {
    const chunk = toFetch.slice(i, i + POSTS_BATCH_MAX)
    const chunkUrls = chunk.map(c => c.urls[0])

    const wait = runWait()
    if (!wait) {
      console.warn(`[Apify] Posts batch: no time left to run ${chunk.length} posts (deadline); left unresolved`)
      markUnresolvedFrom(i)
      break
    }
    console.log(`[Apify] Posts batch: fetching ${chunk.length} posts in one run (wait ≤ ${wait.waitSecs} s + ${Math.round(wait.pollMs / 1000)} s polling)`)

    let run: ActorRunResult | null = null
    try {
      run = await runActorDetailed('apify~instagram-post-scraper', { username: chunkUrls, resultsLimit: 1 }, wait.waitSecs, wait.pollMs)
    } catch (err) {
      if (isExhaustedError(err)) { markUnresolvedFrom(i); return { posts: out, unresolved } }
      console.warn('[Apify] instagram-post-scraper failed for posts batch, trying instagram-scraper:', err instanceof Error ? err.message : err)
    }
    if (run && run.succeeded && run.items.length === 0) {
      // Nothing at all from the pay-per-result actor: one run (one start fee) of the general scraper.
      run = null
    }
    if (run === null) {
      const fallbackWait = runWait()
      if (!fallbackWait) {
        console.warn(`[Apify] Posts batch: no time left for the fallback run of ${chunk.length} posts; left unresolved`)
        markUnresolvedFrom(i)
        break
      }
      try {
        run = await runActorDetailed(
          'apify~instagram-scraper',
          { directUrls: chunkUrls, resultsType: 'posts', resultsLimit: chunkUrls.length },
          fallbackWait.waitSecs,
          fallbackWait.pollMs
        )
      } catch (err) {
        if (isExhaustedError(err)) { markUnresolvedFrom(i); return { posts: out, unresolved } }
        console.error('[Apify] Posts batch: instagram-scraper failed too:', err instanceof Error ? err.message : err)
        // Transient actor failure: no negative cache, the rows can be retried next run.
        for (const entry of chunk) for (const url of entry.urls) unresolved.add(url)
        continue
      }
    }

    // Index results by shortcode. The actor emits { error } items for private/removed
    // posts — mapInstagramSinglePost returns null for those, so they stay unmatched.
    const byCode = new Map<string, ScrapedSinglePost>()
    for (const item of run.items) {
      const code = (typeof item.shortCode === 'string' && item.shortCode)
        || instagramShortcodeOf(typeof item.url === 'string' ? item.url : null)
        || instagramShortcodeOf(typeof item.inputUrl === 'string' ? item.inputUrl : null)
      if (!code || byCode.has(code)) continue
      const mapped = mapInstagramSinglePost(item)
      if (mapped) byCode.set(code, mapped)
    }

    let found = 0
    const tripped = isApifyExhausted()
    for (const { code, urls: entryUrls } of chunk) {
      const post = byCode.get(code) ?? null
      if (post) found++
      for (const url of entryUrls) {
        if (post) out.set(url, post)
        // A missing post from a PARTIAL run (or with the breaker open) is not an answer.
        if (post === null && (!run.succeeded || tripped)) { unresolved.add(url); continue }
        // Same per-URL cache as scrapeSinglePost.
        cacheSet(`post:${url}`, post, post ? LIST_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS)
      }
    }
    console.log(`[Apify] Posts batch: ${found}/${chunk.length} posts matched (${run.items.length} items returned${run.succeeded ? '' : ', PARTIAL run'})`)
    if (tripped) { markUnresolvedFrom(i + POSTS_BATCH_MAX); return { posts: out, unresolved } }
  }

  return { posts: out, unresolved }
}
