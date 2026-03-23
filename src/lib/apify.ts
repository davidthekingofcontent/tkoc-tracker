// Apify REST API client — uses fetch() directly, no external dependencies
// Docs: https://docs.apify.com/api/v2

import { prisma } from '@/lib/db'

const APIFY_BASE = 'https://api.apify.com/v2'

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

/** Run an Apify actor and return the dataset items */
async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  timeoutSecs = 120
): Promise<Record<string, unknown>[]> {
  const token = await getTokenWithDbFallback()
  if (!token) throw new Error('APIFY_API_KEY not configured')

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
    throw new Error(`Apify actor ${actorId} failed to start: ${runRes.status} ${errText}`)
  }

  const runData = await runRes.json() as { data?: { defaultDatasetId?: string; status?: string } }
  const datasetId = runData.data?.defaultDatasetId
  console.log(`[Apify] Run status: ${runData.data?.status}, datasetId: ${datasetId}`)

  if (!datasetId) {
    throw new Error(`Apify actor ${actorId} did not return a dataset ID`)
  }

  // If status is not SUCCEEDED, the run may still be running or failed
  const status = runData.data?.status
  if (status && status !== 'SUCCEEDED' && status !== 'READY') {
    // Wait a bit more and check
    if (status === 'RUNNING') {
      // Poll until done
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 5000))
        const checkRes = await fetch(`${APIFY_BASE}/actor-runs/${datasetId}?token=${token}`)
        if (checkRes.ok) {
          const checkData = await checkRes.json() as { data?: { status?: string } }
          if (checkData.data?.status === 'SUCCEEDED') break
          if (checkData.data?.status === 'FAILED' || checkData.data?.status === 'ABORTED') {
            throw new Error(`Apify actor ${actorId} ${checkData.data.status}`)
          }
        }
      }
    }
  }

  // Fetch dataset items
  const dataRes = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&format=json&clean=true`
  )

  if (!dataRes.ok) {
    throw new Error(`Failed to fetch dataset ${datasetId}: ${dataRes.status}`)
  }

  const items = await dataRes.json() as Record<string, unknown>[]
  console.log(`[Apify] Got ${items?.length || 0} items from dataset ${datasetId}`)
  return items || []
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

async function scrapeInstagramProfile(username: string): Promise<ScrapedProfile | null> {
  const items = await runActor('apify~instagram-profile-scraper', {
    usernames: [username],
  })

  if (!items || items.length === 0) return null

  const profile = items[0]

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
    const likes = (post.likesCount as number) || 0
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
    username: (profile.username as string) || username,
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
        likes: (post.likesCount as number) || 0,
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
            likes: (post.likesCount as number) || 0,
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
  switch (platform) {
    case 'INSTAGRAM':
      return scrapeInstagramAccountMentions(username, maxPosts)
    default:
      console.log(`[Apify] Account mention scraping not supported for ${platform}`)
      return []
  }
}

// ============ INSTAGRAM STORIES ============

export interface ScrapedStory {
  externalId: string
  mediaUrl: string | null
  thumbnailUrl: string | null
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

async function scrapeInstagramStories(usernames: string[]): Promise<StoryResult[]> {
  try {
    const items = await runActor('apify~instagram-story-scraper', {
      usernames: usernames.slice(0, 20), // Max 20 at a time
      resultsLimit: 100,
    }, 300) // 5 min timeout for stories

    if (!items || items.length === 0) return []

    // Group by username
    const storyMap = new Map<string, ScrapedStory[]>()

    for (const item of items) {
      const owner = item.owner as Record<string, unknown> | undefined
      const username = (item.ownerUsername as string) || (owner?.username as string) || (item.user as Record<string, unknown>)?.username as string || ''
      if (!username) continue

      const story: ScrapedStory = {
        externalId: (item.id as string) || (item.pk as number | string)?.toString() || `story_${username}_${(item.takenAtTimestamp as number) || Date.now()}`,
        mediaUrl: (item.videoUrl as string) || (item.displayUrl as string) || (item.imageUrl as string) || null,
        thumbnailUrl: (item.displayUrl as string) || (item.imageUrl as string) || (item.thumbnailUrl as string) || null,
        mediaType: 'STORY',
        views: (item.viewerCount as number) || (item.views as number) || 0,
        postedAt: (item.takenAtTimestamp as number)
          ? new Date((item.takenAtTimestamp as number) * 1000).toISOString()
          : (item.timestamp as string) || (item.takenAt as string) || null,
        expiresAt: (item.expiringAtTimestamp as number)
          ? new Date((item.expiringAtTimestamp as number) * 1000).toISOString()
          : null,
        mentions: ((item.mentions as string[]) || []),
        hashtags: ((item.hashtags as string[]) || []),
        stickers: ((item.stickers as string[]) || []),
      }

      const existing = storyMap.get(username) || []
      existing.push(story)
      storyMap.set(username, existing)
    }

    return Array.from(storyMap.entries()).map(([username, stories]) => ({
      username,
      stories,
    }))
  } catch (err) {
    console.error('[Apify] Story scraping error:', err)
    return []
  }
}

export async function scrapeStories(usernames: string[], platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'): Promise<StoryResult[]> {
  switch (platform) {
    case 'INSTAGRAM':
      return scrapeInstagramStories(usernames)
    default:
      // Stories only supported on Instagram for now
      return []
  }
}

// ============ PUBLIC API ============

// ============ INSTAGRAM SEARCH (for Discovery & Lookalikes) ============

export interface InstagramSearchResult {
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  bio: string | null
  isVerified: boolean
}

/**
 * Search Instagram for accounts matching a query (keyword, category, or name).
 * Uses the apify~instagram-search actor.
 * Returns an array of profile summaries.
 */
export async function searchInstagramAccounts(
  query: string,
  options?: { limit?: number }
): Promise<InstagramSearchResult[]> {
  const limit = options?.limit || 20

  try {
    const items = await runActor('apify~instagram-search', {
      search: query,
      resultsLimit: limit,
      searchType: 'user',
    })

    if (!items || items.length === 0) return []

    return items.map((item: Record<string, unknown>) => ({
      username: (item.username as string) || (item.login as string) || '',
      displayName: (item.fullName as string) || (item.full_name as string) || null,
      avatarUrl: (item.profilePicUrl as string) || (item.profile_pic_url as string) || null,
      followers: (item.followersCount as number) || (item.follower_count as number) || 0,
      bio: (item.biography as string) || (item.bio as string) || null,
      isVerified: (item.isVerified as boolean) || (item.is_verified as boolean) || false,
    })).filter((r: InstagramSearchResult) => r.username)
  } catch (err) {
    console.error('[Apify] Instagram search error:', err)
    return []
  }
}

/**
 * Scrape Instagram's "similar accounts" / suggested profiles for a given username.
 * Uses the same apify~instagram-profile-scraper actor and extracts the relatedProfiles
 * or similarAccounts field from the result.
 */
export async function scrapeInstagramSimilarAccounts(
  username: string
): Promise<InstagramSearchResult[]> {
  try {
    const items = await runActor('apify~instagram-profile-scraper', {
      usernames: [username],
    })

    if (!items || items.length === 0) return []

    const profile = items[0]

    // The actor may return related profiles under different field names
    const relatedProfiles =
      (profile.relatedProfiles as Record<string, unknown>[]) ||
      (profile.similarAccounts as Record<string, unknown>[]) ||
      (profile.suggestedUsers as Record<string, unknown>[]) ||
      (profile.relatedAccounts as Record<string, unknown>[]) ||
      (profile.edgeRelatedProfiles as Record<string, unknown>[]) ||
      []

    if (!Array.isArray(relatedProfiles) || relatedProfiles.length === 0) {
      console.log(`[Apify] No similar accounts found for @${username}`)
      return []
    }

    console.log(`[Apify] Found ${relatedProfiles.length} similar accounts for @${username}`)

    return relatedProfiles
      .map((rp: Record<string, unknown>) => ({
        username: (rp.username as string) || (rp.login as string) || '',
        displayName: (rp.fullName as string) || (rp.full_name as string) || (rp.name as string) || null,
        avatarUrl: (rp.profilePicUrl as string) || (rp.profile_pic_url as string) || (rp.avatarUrl as string) || null,
        followers: (rp.followersCount as number) || (rp.follower_count as number) || (rp.followers as number) || 0,
        bio: (rp.biography as string) || (rp.bio as string) || null,
        isVerified: (rp.isVerified as boolean) || (rp.is_verified as boolean) || (rp.verified as boolean) || false,
      }))
      .filter((r) => r.username)
  } catch (err) {
    console.error('[Apify] Similar accounts scraping error:', err)
    return []
  }
}

export async function scrapeProfile(username: string, platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'): Promise<ScrapedProfile | null> {
  switch (platform) {
    case 'INSTAGRAM':
      return scrapeInstagramProfile(username)
    case 'TIKTOK':
      return scrapeTikTokProfile(username)
    case 'YOUTUBE':
      return scrapeYouTubeProfile(username)
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

export async function scrapeHashtag(hashtag: string, platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE', maxPosts = 20): Promise<HashtagResult[]> {
  switch (platform) {
    case 'INSTAGRAM':
      return scrapeInstagramHashtag(hashtag, maxPosts)
    default:
      return []
  }
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
      likes: (item.likesCount as number) || (item.likes as number) || 0,
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
      return scrapeInstagramComments(postUrls, maxComments)
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
