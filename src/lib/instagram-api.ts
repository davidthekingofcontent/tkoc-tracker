/**
 * Instagram Graph API Client (with Facebook Login)
 *
 * Uses Meta Graph API v21.0 via fetch().
 * Requires a Page Access Token from a Facebook Page connected to an IG Business Account.
 *
 * Rate limits: 240 req/user/hour, app-level = 200 × active users
 *
 * Key endpoints:
 * - GET /{ig-user-id} — Profile info
 * - GET /{ig-user-id}/media — List media
 * - GET /{media-id}/insights — Media insights (reach, impressions, saves)
 * - GET /{ig-user-id}/insights — Audience demographics
 */

import type { ScrapedProfile, ScrapedPost } from './apify'

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`

// ============ TYPES ============

export interface MetaTokenData {
  accessToken: string
  tokenType: string
  expiresIn?: number // seconds
}

export interface IGBusinessAccount {
  igUserId: string
  username: string
  name: string
  pageId: string
  pageName: string
}

export interface MediaInsights {
  engagement: number
  impressions: number
  reach: number
  saved: number
}

export interface AudienceData {
  genderAge: Array<{ dimension: string; value: number }>
  countries: Array<{ country: string; value: number }>
  cities: Array<{ city: string; value: number }>
}

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
      console.error(`[Instagram API] ${res.status}: ${body.slice(0, 300)}`)
      return null
    }
    return await res.json() as T
  } catch (error) {
    console.error('[Instagram API] Fetch error:', error)
    return null
  }
}

// ============ OAUTH FLOW ============

/**
 * Generate the Facebook OAuth authorization URL
 */
export function getAuthorizationUrl(appId: string, redirectUri: string, state: string): string {
  // Only request permissions we actually use — Meta rejects unnecessary scopes
  const scopes = [
    'instagram_basic',           // Read IG profile info + media
    'instagram_manage_insights', // Read media insights (reach, impressions, saves)
    'pages_show_list',           // List FB pages connected to IG
    'pages_read_engagement',     // Read page engagement metrics
  ].join(',')

  return `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?` +
    `client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state)}`
}

/**
 * Exchange authorization code for short-lived access token
 */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<MetaTokenData | null> {
  const data = await graphFetch<{
    access_token: string
    token_type: string
    expires_in?: number
  }>('/oauth/access_token', '', {
    client_id: appId,
    client_secret: appSecret,
    redirect_uri: redirectUri,
    code,
  })

  // Special case: OAuth token exchange doesn't use Bearer token in URL
  // Re-fetch without access_token param
  const url = new URL(`${GRAPH_BASE_URL}/oauth/access_token`)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code', code)

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      const body = await res.text()
      console.error('[Instagram API] Token exchange failed:', body.slice(0, 300))
      return null
    }
    const result = await res.json() as { access_token: string; token_type: string; expires_in?: number }
    return {
      accessToken: result.access_token,
      tokenType: result.token_type,
      expiresIn: result.expires_in,
    }
  } catch (error) {
    console.error('[Instagram API] Token exchange error:', error)
    return null
  }
}

/**
 * Exchange short-lived token for long-lived token (60 days)
 */
export async function getLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string
): Promise<MetaTokenData | null> {
  const url = new URL(`${GRAPH_BASE_URL}/oauth/access_token`)
  url.searchParams.set('grant_type', 'fb_exchange_token')
  url.searchParams.set('client_id', appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('fb_exchange_token', shortLivedToken)

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      const body = await res.text()
      console.error('[Instagram API] Long-lived token exchange failed:', body.slice(0, 300))
      return null
    }
    const result = await res.json() as { access_token: string; token_type: string; expires_in?: number }
    return {
      accessToken: result.access_token,
      tokenType: result.token_type,
      expiresIn: result.expires_in,
    }
  } catch (error) {
    console.error('[Instagram API] Long-lived token error:', error)
    return null
  }
}

/**
 * Refresh a long-lived token (must be done before expiry)
 */
export async function refreshLongLivedToken(
  currentToken: string,
  appId: string,
  appSecret: string
): Promise<MetaTokenData | null> {
  return getLongLivedToken(currentToken, appId, appSecret)
}

// ============ DISCOVER IG BUSINESS ACCOUNT ============

/**
 * Find the Instagram Business Account connected to the user's Facebook Pages.
 * Returns the first IG Business Account found.
 */
export async function discoverIGBusinessAccount(accessToken: string): Promise<IGBusinessAccount | null> {
  // Get user's pages
  const pagesData = await graphFetch<{
    data: Array<{
      id: string
      name: string
      access_token: string
      instagram_business_account?: { id: string }
    }>
  }>('/me/accounts', accessToken, {
    fields: 'id,name,access_token,instagram_business_account',
  })

  if (!pagesData?.data?.length) return null

  // Find first page with IG business account
  for (const page of pagesData.data) {
    if (page.instagram_business_account?.id) {
      // Get IG account details
      const igData = await graphFetch<{
        id: string
        username: string
        name: string
      }>(`/${page.instagram_business_account.id}`, accessToken, {
        fields: 'id,username,name',
      })

      if (igData) {
        return {
          igUserId: igData.id,
          username: igData.username,
          name: igData.name,
          pageId: page.id,
          pageName: page.name,
        }
      }
    }
  }

  return null
}

/**
 * Get the Page Access Token for a specific page
 */
export async function getPageAccessToken(userToken: string, pageId: string): Promise<string | null> {
  const data = await graphFetch<{
    data: Array<{ id: string; access_token: string }>
  }>('/me/accounts', userToken, {
    fields: 'id,access_token',
  })

  const page = data?.data?.find(p => p.id === pageId)
  return page?.access_token || null
}

// ============ PROFILE & MEDIA ============

/**
 * Get Instagram Business/Creator profile info
 */
export async function getIGProfile(accessToken: string, igUserId: string): Promise<ScrapedProfile | null> {
  const data = await graphFetch<{
    id: string
    username: string
    name: string
    biography: string
    followers_count: number
    follows_count: number
    media_count: number
    profile_picture_url: string
    website: string
  }>(`/${igUserId}`, accessToken, {
    fields: 'id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website',
  })

  if (!data) return null

  return {
    username: data.username,
    displayName: data.name || null,
    bio: data.biography || null,
    avatarUrl: data.profile_picture_url || null,
    followers: data.followers_count || 0,
    following: data.follows_count || 0,
    postsCount: data.media_count || 0,
    engagementRate: 0,
    avgLikes: 0,
    avgComments: 0,
    avgViews: 0,
    isVerified: false,
    website: data.website || null,
    email: null,
    country: null,
    city: null,
    recentPosts: [],
  }
}

/**
 * Get recent media from an IG Business account
 */
export async function getIGMedia(accessToken: string, igUserId: string, limit = 12): Promise<ScrapedPost[]> {
  const data = await graphFetch<{
    data: Array<{
      id: string
      caption: string
      media_type: string
      media_url: string
      permalink: string
      thumbnail_url: string
      timestamp: string
      like_count: number
      comments_count: number
    }>
  }>(`/${igUserId}/media`, accessToken, {
    fields: 'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count',
    limit: String(limit),
  })

  if (!data?.data?.length) return []

  return data.data.map(m => ({
    externalId: m.id,
    caption: m.caption || null,
    mediaUrl: m.media_url || null,
    thumbnailUrl: m.thumbnail_url || m.media_url || null,
    permalink: m.permalink || null,
    mediaType: mapIGMediaType(m.media_type),
    likes: m.like_count || 0,
    comments: m.comments_count || 0,
    shares: 0,
    saves: 0,
    views: 0,
    postedAt: m.timestamp || null,
    hashtags: extractHashtags(m.caption || ''),
    mentions: extractMentions(m.caption || ''),
  }))
}

/**
 * Get media insights (requires owner's token)
 */
export async function getMediaInsights(accessToken: string, mediaId: string): Promise<MediaInsights | null> {
  const data = await graphFetch<{
    data: Array<{ name: string; values: Array<{ value: number }> }>
  }>(`/${mediaId}/insights`, accessToken, {
    metric: 'engagement,impressions,reach,saved',
  })

  if (!data?.data?.length) return null

  const result: MediaInsights = { engagement: 0, impressions: 0, reach: 0, saved: 0 }
  for (const metric of data.data) {
    const value = metric.values?.[0]?.value || 0
    if (metric.name === 'engagement') result.engagement = value
    if (metric.name === 'impressions') result.impressions = value
    if (metric.name === 'reach') result.reach = value
    if (metric.name === 'saved') result.saved = value
  }
  return result
}

/**
 * Get audience demographics (requires owner's token)
 */
export async function getAudienceInsights(accessToken: string, igUserId: string): Promise<AudienceData | null> {
  const data = await graphFetch<{
    data: Array<{
      name: string
      values: Array<{ value: Record<string, number> }>
    }>
  }>(`/${igUserId}/insights`, accessToken, {
    metric: 'audience_city,audience_country,audience_gender_age',
    period: 'lifetime',
  })

  if (!data?.data?.length) return null

  const result: AudienceData = { genderAge: [], countries: [], cities: [] }

  for (const metric of data.data) {
    const values = metric.values?.[0]?.value || {}
    if (metric.name === 'audience_gender_age') {
      result.genderAge = Object.entries(values).map(([dimension, value]) => ({ dimension, value }))
    }
    if (metric.name === 'audience_country') {
      result.countries = Object.entries(values).map(([country, value]) => ({ country, value }))
    }
    if (metric.name === 'audience_city') {
      result.cities = Object.entries(values).map(([city, value]) => ({ city, value }))
    }
  }

  return result
}

// ============ HELPERS ============

function mapIGMediaType(type: string): ScrapedPost['mediaType'] {
  switch (type) {
    case 'IMAGE': return 'POST'
    case 'VIDEO': return 'REEL'
    case 'CAROUSEL_ALBUM': return 'CAROUSEL'
    case 'REELS': return 'REEL'
    default: return 'POST'
  }
}

function extractHashtags(text: string): string[] {
  return (text.match(/#[\w\u00C0-\u024F]+/g) || []).map(h => h.toLowerCase())
}

function extractMentions(text: string): string[] {
  return (text.match(/@[\w.]+/g) || []).map(m => m.toLowerCase())
}
