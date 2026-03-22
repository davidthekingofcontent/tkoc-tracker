/**
 * Instagram Creator Marketplace API Client
 *
 * Enables brands to discover and evaluate Instagram creators for partnerships.
 * Uses Meta Graph API v21.0 via fetch().
 * Requires Page Access Token with `instagram_creator_marketplace_discovery` permission.
 *
 * Rate limits: 240 req/user/hour
 *
 * Key endpoint: GET /{ig-user-id}/creator_marketplace_creators
 */

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`

// ============ TYPES ============

export interface CreatorDiscoveryFilters {
  query?: string                    // Free-text keyword search
  creator_countries?: string[]      // ISO country codes ["ES", "US"]
  creator_min_followers?: number    // 0, 10000, 25000, 50000, 75000, 100000
  creator_max_followers?: number    // 10000, 25000, 50000, 75000, 100000
  creator_age_bucket?: string       // "18_to_24", "25_to_34", etc.
  creator_gender?: string           // "male", "female"
  creator_interests?: string[]      // Max 5 categories
  creator_min_engaged_accounts?: number
  creator_max_engaged_accounts?: number
  similar_to_creators?: string[]    // Up to 5 onboarded creator usernames
  username?: string                 // Specific creator username lookup
  major_audience_age_bucket?: string
  major_audience_gender?: string
  major_audience_countries?: string[]
}

export interface CreatorResult {
  id: string
  username: string
  biography: string | null
  country: string | null
  gender: string | null
  ageBucket: string | null
  isAccountVerified: boolean
  onboardedStatus: string | null
  email: string | null
  portfolioUrl: string | null
  hasBrandPartnershipExperience: boolean
  pastBrandPartners: string[]
  insights: CreatorInsights | null
}

export interface CreatorInsights {
  totalFollowers: number
  engagedAccounts: number | null
  reach: number | null
  reelsInteractionRate: number | null
  reelsHookRate: number | null
  breakdowns: {
    genderAge?: Array<{ dimension: string; value: number }>
    topCountries?: Array<{ country: string; value: number }>
    topCities?: Array<{ city: string; value: number }>
  }
}

export interface CreatorMediaItem {
  id: string
  productType: string | null
  mediaType: string | null
  permalink: string | null
  creationTime: string | null
  caption: string | null
  taggedBrand: string | null
  likes: number
  comments: number
  views: number
  shares: number
}

// Creator interest categories available in the API
export const CREATOR_INTERESTS = [
  'ANIMALS_AND_PETS',
  'ART_AND_CULTURE',
  'BEAUTY_FASHION',
  'BUSINESS',
  'EDUCATION',
  'ENTERTAINMENT',
  'FAMILY_AND_RELATIONSHIPS',
  'FITNESS_AND_WELLNESS',
  'FOOD_AND_DRINK',
  'GAMING',
  'HEALTH',
  'HOME_AND_GARDEN',
  'MUSIC_AND_DANCE',
  'NATURE_AND_OUTDOORS',
  'NEWS_AND_POLITICS',
  'SCIENCE_AND_TECHNOLOGY',
  'SPORTS',
  'TRAVEL_AND_LEISURE',
] as const

// ============ CORE FETCH ============

async function graphFetch<T>(endpoint: string, accessToken: string, params: Record<string, string> = {}): Promise<T | null> {
  const url = new URL(`${GRAPH_BASE_URL}${endpoint}`)
  url.searchParams.set('access_token', accessToken)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      const body = await res.text()
      console.error(`[IG Marketplace] ${res.status}: ${body.slice(0, 300)}`)
      return null
    }
    return await res.json() as T
  } catch (error) {
    console.error('[IG Marketplace] Fetch error:', error)
    return null
  }
}

// ============ DISCOVERY ============

/**
 * Discover creators using the Creator Marketplace API.
 * The igUserId must be the brand's IG Business Account ID.
 */
export async function discoverCreators(
  accessToken: string,
  igUserId: string,
  filters: CreatorDiscoveryFilters = {},
  limit = 25
): Promise<CreatorResult[]> {
  const params: Record<string, string> = {
    fields: [
      'id', 'username', 'biography', 'country', 'gender', 'age_bucket',
      'is_account_verified', 'onboarded_status', 'email', 'portfolio_url',
      'has_brand_partnership_experience', 'past_brand_partnership_partners',
      'insights.metric(total_followers,creator_engaged_accounts,creator_reach,reels_interaction_rate,reels_hook_rate).period(overall).timeframe(last_90_days)',
    ].join(','),
    limit: String(Math.min(limit, 50)),
  }

  // Apply filters
  if (filters.query) params.query = filters.query
  if (filters.username) params.username = filters.username
  if (filters.creator_countries?.length) params.creator_countries = JSON.stringify(filters.creator_countries)
  if (filters.creator_min_followers != null) params.creator_min_followers = String(filters.creator_min_followers)
  if (filters.creator_max_followers != null) params.creator_max_followers = String(filters.creator_max_followers)
  if (filters.creator_age_bucket) params.creator_age_bucket = filters.creator_age_bucket
  if (filters.creator_gender) params.creator_gender = filters.creator_gender
  if (filters.creator_interests?.length) params.creator_interests = JSON.stringify(filters.creator_interests.slice(0, 5))
  if (filters.creator_min_engaged_accounts != null) params.creator_min_engaged_accounts = String(filters.creator_min_engaged_accounts)
  if (filters.creator_max_engaged_accounts != null) params.creator_max_engaged_accounts = String(filters.creator_max_engaged_accounts)
  if (filters.similar_to_creators?.length) params.similar_to_creators = JSON.stringify(filters.similar_to_creators.slice(0, 5))
  if (filters.major_audience_age_bucket) params.major_audience_age_bucket = filters.major_audience_age_bucket
  if (filters.major_audience_gender) params.major_audience_gender = filters.major_audience_gender
  if (filters.major_audience_countries?.length) params.major_audience_countries = JSON.stringify(filters.major_audience_countries)

  const data = await graphFetch<{
    data: Array<Record<string, unknown>>
    paging?: { cursors: { after: string }; next?: string }
  }>(`/${igUserId}/creator_marketplace_creators`, accessToken, params)

  if (!data?.data?.length) return []

  return data.data.map(creator => mapCreator(creator))
}

/**
 * Get detailed insights for a specific creator
 */
export async function getCreatorInsights(
  accessToken: string,
  igUserId: string,
  creatorUsername: string,
  timeframe: 'this_week' | 'last_14_days' | 'this_month' | 'last_90_days' = 'last_90_days'
): Promise<CreatorInsights | null> {
  const params: Record<string, string> = {
    username: creatorUsername,
    fields: [
      `insights.metric(total_followers,creator_engaged_accounts,creator_reach,reels_interaction_rate,reels_hook_rate)` +
      `.period(overall).timeframe(${timeframe})` +
      `.breakdown(follow_type,gender,age,top_countries,top_cities)`,
    ].join(','),
  }

  const data = await graphFetch<{
    data: Array<Record<string, unknown>>
  }>(`/${igUserId}/creator_marketplace_creators`, accessToken, params)

  if (!data?.data?.[0]) return null

  return mapCreatorInsights(data.data[0])
}

/**
 * Get a creator's media (recent, branded content, or past partnership ads)
 */
export async function getCreatorMedia(
  accessToken: string,
  igUserId: string,
  creatorUsername: string,
  mediaType: 'recent_media' | 'branded_content_media' | 'past_partnership_ads_media' = 'recent_media',
  limit = 12
): Promise<CreatorMediaItem[]> {
  const params: Record<string, string> = {
    username: creatorUsername,
    fields: `${mediaType}{id,product_type,media_type,permalink,creation_time,caption,tagged_brand,insights.metrics(likes,comments,views,shares)}`,
    limit: String(Math.min(limit, 50)),
  }

  const data = await graphFetch<{
    data: Array<Record<string, unknown>>
  }>(`/${igUserId}/creator_marketplace_creators`, accessToken, params)

  if (!data?.data?.[0]) return []

  const mediaData = (data.data[0] as Record<string, unknown>)[mediaType] as {
    data?: Array<Record<string, unknown>>
  } | undefined

  if (!mediaData?.data?.length) return []

  return mediaData.data.map(m => ({
    id: String(m.id || ''),
    productType: (m.product_type as string) || null,
    mediaType: (m.media_type as string) || null,
    permalink: (m.permalink as string) || null,
    creationTime: (m.creation_time as string) || null,
    caption: (m.caption as string) || null,
    taggedBrand: (m.tagged_brand as string) || null,
    likes: extractMetric(m, 'likes'),
    comments: extractMetric(m, 'comments'),
    views: extractMetric(m, 'views'),
    shares: extractMetric(m, 'shares'),
  }))
}

// ============ MAPPERS ============

function mapCreator(raw: Record<string, unknown>): CreatorResult {
  const insights = raw.insights ? mapCreatorInsights(raw) : null
  const pastPartners = (raw.past_brand_partnership_partners as Array<{ name: string }>) || []

  return {
    id: String(raw.id || ''),
    username: String(raw.username || ''),
    biography: (raw.biography as string) || null,
    country: (raw.country as string) || null,
    gender: (raw.gender as string) || null,
    ageBucket: (raw.age_bucket as string) || null,
    isAccountVerified: !!(raw.is_account_verified),
    onboardedStatus: (raw.onboarded_status as string) || null,
    email: (raw.email as string) || null,
    portfolioUrl: (raw.portfolio_url as string) || null,
    hasBrandPartnershipExperience: !!(raw.has_brand_partnership_experience),
    pastBrandPartners: pastPartners.map(p => p.name),
    insights,
  }
}

function mapCreatorInsights(raw: Record<string, unknown>): CreatorInsights | null {
  const insightsData = raw.insights as { data?: Array<{ name: string; values?: Array<{ value: unknown }> }> } | undefined
  if (!insightsData?.data) return null

  const result: CreatorInsights = {
    totalFollowers: 0,
    engagedAccounts: null,
    reach: null,
    reelsInteractionRate: null,
    reelsHookRate: null,
    breakdowns: {},
  }

  for (const metric of insightsData.data) {
    const value = metric.values?.[0]?.value
    switch (metric.name) {
      case 'total_followers':
        result.totalFollowers = (value as number) || 0
        break
      case 'creator_engaged_accounts':
        result.engagedAccounts = (value as number) || null
        break
      case 'creator_reach':
        result.reach = (value as number) || null
        break
      case 'reels_interaction_rate':
        result.reelsInteractionRate = (value as number) || null
        break
      case 'reels_hook_rate':
        result.reelsHookRate = (value as number) || null
        break
    }
  }

  return result
}

function extractMetric(mediaItem: Record<string, unknown>, metricName: string): number {
  const insights = mediaItem.insights as { data?: Array<{ name: string; values?: Array<{ value: number }> }> } | undefined
  if (!insights?.data) return 0
  const metric = insights.data.find(m => m.name === metricName)
  return metric?.values?.[0]?.value || 0
}
