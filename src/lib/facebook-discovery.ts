/**
 * Facebook Creator Discovery API Client
 *
 * Enables brands to discover and evaluate Facebook creators for partnerships.
 * Uses Meta Graph API v21.0 via fetch().
 * Requires Page Access Token with `facebook_creator_marketplace_discovery` permission.
 *
 * Rate limits: 2,000 req/user/hour, 10,000/app/hour
 *
 * Key endpoints:
 * - GET /creator_marketplace/creators — Discover creators
 * - GET /creator_marketplace/content — Search creator content
 */

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`

// ============ TYPES ============

export interface FBCreatorDiscoveryFilters {
  query?: string                    // Semantic keyword search
  creator_categories?: string[]     // digital_creator, video_creator, artist, comedian, etc.
  creator_countries?: string[]      // ISO country codes
  follower_count_min?: number
  follower_count_max?: number
  interaction_rate_min?: number
  interaction_rate_max?: number
  reach_min?: number
  reach_max?: number
  major_audience_age_bucket?: string
  major_audience_gender?: string
  creator_id?: string               // Specific creator lookup
}

export interface FBCreatorResult {
  id: string
  name: string | null
  biography: string | null
  profileUrl: string | null
  followerCount: number
  interests: string[]
  languages: string[]
  categories: string[]
  pastPartnerships: string[]
  insights: FBCreatorInsights | null
}

export interface FBCreatorInsights {
  views: number | null
  reach: number | null
  interactions: number | null
  interactionRate: number | null
  publishingActivity: number | null
  audienceGender: Array<{ dimension: string; value: number }>
  audienceAge: Array<{ dimension: string; value: number }>
  audienceCountries: Array<{ country: string; value: number }>
  audienceCities: Array<{ city: string; value: number }>
}

export interface FBContentResult {
  id: string
  contentType: string | null
  creationTime: string | null
  caption: string | null
  contentUrl: string | null
  thumbnailUrl: string | null
  taggedBrands: string[]
  metrics: {
    reach: number
    views: number
    clicks: number
    interactions: number
    reactions: number
    comments: number
    shares: number
    saves: number
  }
}

export interface FBContentFilters {
  creator_id?: string
  content_type?: 'LINKS' | 'LIVE' | 'PHOTOS' | 'REELS' | 'TEXT' | 'VIDEOS'
  sort_by?: 'create_time' | 'clicks' | 'comments' | 'interactions' | 'reach' | 'reactions' | 'shares' | 'views'
  time_range?: 'L1' | 'L7' | 'L14' | 'L28' | 'L90'
  views_min?: number
  reach_min?: number
  interactions_min?: number
}

// Available creator categories
export const FB_CREATOR_CATEGORIES = [
  'digital_creator',
  'video_creator',
  'artist',
  'comedian',
  'athlete',
  'entrepreneur',
  'blogger',
  'gamer',
  'writer',
  'musician',
  'photographer',
  'public_figure',
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
      console.error(`[FB Discovery] ${res.status}: ${body.slice(0, 300)}`)
      return null
    }
    return await res.json() as T
  } catch (error) {
    console.error('[FB Discovery] Fetch error:', error)
    return null
  }
}

// ============ CREATOR DISCOVERY ============

/**
 * Discover Facebook creators with filters and insights
 */
export async function discoverFBCreators(
  accessToken: string,
  filters: FBCreatorDiscoveryFilters = {},
  limit = 25
): Promise<{ creators: FBCreatorResult[]; nextCursor?: string }> {
  const params: Record<string, string> = {
    fields: [
      'id', 'name', 'biography', 'profile_url', 'follower_count',
      'creator_interests', 'languages', 'creator_categories',
      'past_brand_partnerships',
      'insights.metric(creator_views,creator_reach,creator_interactions,creator_interaction_rate,publishing_activity)' +
      '.period(overall).timeframe(L90)',
    ].join(','),
    limit: String(Math.min(limit, 50)),
  }

  // Apply filters
  if (filters.query) params.query = filters.query
  if (filters.creator_id) params.creator_id = filters.creator_id
  if (filters.creator_categories?.length) params.creator_categories = JSON.stringify(filters.creator_categories)
  if (filters.creator_countries?.length) params.creator_countries = JSON.stringify(filters.creator_countries)
  if (filters.follower_count_min != null || filters.follower_count_max != null) {
    const range: Record<string, number> = {}
    if (filters.follower_count_min != null) range.min = filters.follower_count_min
    if (filters.follower_count_max != null) range.max = filters.follower_count_max
    params.follower_count = JSON.stringify(range)
  }
  if (filters.interaction_rate_min != null || filters.interaction_rate_max != null) {
    const range: Record<string, number> = {}
    if (filters.interaction_rate_min != null) range.min = filters.interaction_rate_min
    if (filters.interaction_rate_max != null) range.max = filters.interaction_rate_max
    params.interaction_rate = JSON.stringify(range)
  }
  if (filters.major_audience_age_bucket) params.major_audience_age_bucket = filters.major_audience_age_bucket
  if (filters.major_audience_gender) params.major_audience_gender = filters.major_audience_gender

  const data = await graphFetch<{
    data: Array<Record<string, unknown>>
    paging?: { cursors: { after: string }; next?: string }
  }>('/creator_marketplace/creators', accessToken, params)

  if (!data?.data?.length) return { creators: [] }

  const creators = data.data.map(raw => mapFBCreator(raw))
  return {
    creators,
    nextCursor: data.paging?.cursors?.after,
  }
}

// ============ CONTENT DISCOVERY ============

/**
 * Search and browse creator content with filters
 */
export async function searchFBContent(
  accessToken: string,
  filters: FBContentFilters = {},
  limit = 25
): Promise<{ content: FBContentResult[]; nextCursor?: string }> {
  const params: Record<string, string> = {
    fields: [
      'id', 'content_type', 'creation_time', 'caption', 'content_url', 'thumbnail_url',
      'tagged_brands',
      'insights.metric(reach,views,clicks,interactions,reactions,comments,shares,saves).period(overall)',
    ].join(','),
    limit: String(Math.min(limit, 50)),
  }

  if (filters.creator_id) params.creator_id = filters.creator_id
  if (filters.content_type) params.content_type = filters.content_type
  if (filters.sort_by) params.sort_by = filters.sort_by
  if (filters.time_range) params.time_range = filters.time_range
  if (filters.views_min != null) params.views = JSON.stringify({ min: filters.views_min })
  if (filters.reach_min != null) params.reach = JSON.stringify({ min: filters.reach_min })
  if (filters.interactions_min != null) params.interactions = JSON.stringify({ min: filters.interactions_min })

  const data = await graphFetch<{
    data: Array<Record<string, unknown>>
    paging?: { cursors: { after: string }; next?: string }
  }>('/creator_marketplace/content', accessToken, params)

  if (!data?.data?.length) return { content: [] }

  const content = data.data.map(raw => mapFBContent(raw))
  return {
    content,
    nextCursor: data.paging?.cursors?.after,
  }
}

// ============ MAPPERS ============

function mapFBCreator(raw: Record<string, unknown>): FBCreatorResult {
  const insightsData = raw.insights as { data?: Array<{ name: string; values?: Array<{ value: unknown }> }> } | undefined

  let insights: FBCreatorInsights | null = null
  if (insightsData?.data?.length) {
    insights = {
      views: null,
      reach: null,
      interactions: null,
      interactionRate: null,
      publishingActivity: null,
      audienceGender: [],
      audienceAge: [],
      audienceCountries: [],
      audienceCities: [],
    }

    for (const metric of insightsData.data) {
      const value = metric.values?.[0]?.value
      switch (metric.name) {
        case 'creator_views': insights.views = (value as number) || null; break
        case 'creator_reach': insights.reach = (value as number) || null; break
        case 'creator_interactions': insights.interactions = (value as number) || null; break
        case 'creator_interaction_rate': insights.interactionRate = (value as number) || null; break
        case 'publishing_activity': insights.publishingActivity = (value as number) || null; break
      }
    }
  }

  return {
    id: String(raw.id || ''),
    name: (raw.name as string) || null,
    biography: (raw.biography as string) || null,
    profileUrl: (raw.profile_url as string) || null,
    followerCount: (raw.follower_count as number) || 0,
    interests: (raw.creator_interests as string[]) || [],
    languages: (raw.languages as string[]) || [],
    categories: (raw.creator_categories as string[]) || [],
    pastPartnerships: ((raw.past_brand_partnerships as Array<{ name: string }>) || []).map(p => p.name),
    insights,
  }
}

function mapFBContent(raw: Record<string, unknown>): FBContentResult {
  const insightsData = raw.insights as { data?: Array<{ name: string; values?: Array<{ value: number }> }> } | undefined

  const metrics = { reach: 0, views: 0, clicks: 0, interactions: 0, reactions: 0, comments: 0, shares: 0, saves: 0 }
  if (insightsData?.data) {
    for (const metric of insightsData.data) {
      const value = metric.values?.[0]?.value || 0
      if (metric.name in metrics) {
        (metrics as Record<string, number>)[metric.name] = value
      }
    }
  }

  const taggedBrands = (raw.tagged_brands as Array<{ name: string }>) || []

  return {
    id: String(raw.id || ''),
    contentType: (raw.content_type as string) || null,
    creationTime: (raw.creation_time as string) || null,
    caption: (raw.caption as string) || null,
    contentUrl: (raw.content_url as string) || null,
    thumbnailUrl: (raw.thumbnail_url as string) || null,
    taggedBrands: taggedBrands.map(b => b.name),
    metrics,
  }
}
