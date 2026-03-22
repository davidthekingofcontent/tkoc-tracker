/**
 * YouTube Analytics API v2 Client
 *
 * Provides access to private channel analytics (demographics, watch time, traffic sources).
 * Requires OAuth 2.0 from the channel owner.
 * Scope: https://www.googleapis.com/auth/yt-analytics.readonly
 *
 * Uses fetch() — no SDK.
 */

const ANALYTICS_BASE_URL = 'https://youtubeanalytics.googleapis.com/v2'
const OAUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// ============ TYPES ============

export interface YouTubeAnalyticsData {
  period: { startDate: string; endDate: string }
  totals: {
    views: number
    estimatedMinutesWatched: number
    averageViewDuration: number
    subscribersGained: number
    subscribersLost: number
    likes: number
    comments: number
    shares: number
  }
  timeSeries?: Array<{
    date: string
    views: number
    estimatedMinutesWatched: number
    subscribersGained: number
  }>
}

export interface AudienceDemographics {
  countries: Array<{ country: string; views: number; percentage: number }>
  ageGroups: Array<{ ageGroup: string; viewerPercentage: number }>
  genders: Array<{ gender: string; viewerPercentage: number }>
  deviceTypes: Array<{ deviceType: string; views: number }>
  trafficSources: Array<{ source: string; views: number }>
}

export interface VideoAnalyticsItem {
  videoId: string
  title?: string
  views: number
  estimatedMinutesWatched: number
  averageViewDuration: number
  likes: number
  comments: number
  subscribersGained: number
}

export interface GoogleTokenData {
  accessToken: string
  refreshToken?: string
  expiresIn: number
  tokenType: string
  scope: string
}

// ============ OAUTH FLOW ============

/**
 * Generate the Google OAuth authorization URL
 */
export function getGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const scopes = [
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.readonly',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline', // Get refresh token
    prompt: 'consent',
    state,
  })

  return `${OAUTH_BASE_URL}?${params.toString()}`
}

/**
 * Exchange authorization code for access + refresh tokens
 */
export async function exchangeGoogleCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<GoogleTokenData | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[YouTube Analytics] Token exchange failed:', body.slice(0, 300))
      return null
    }

    const data = await res.json() as {
      access_token: string
      refresh_token?: string
      expires_in: number
      token_type: string
      scope: string
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    }
  } catch (error) {
    console.error('[YouTube Analytics] Token exchange error:', error)
    return null
  }
}

/**
 * Refresh an expired access token using the refresh token
 */
export async function refreshGoogleToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<GoogleTokenData | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      console.error('[YouTube Analytics] Token refresh failed:', body.slice(0, 300))
      return null
    }

    const data = await res.json() as {
      access_token: string
      expires_in: number
      token_type: string
      scope: string
    }

    return {
      accessToken: data.access_token,
      refreshToken, // Keep the existing refresh token
      expiresIn: data.expires_in,
      tokenType: data.token_type,
      scope: data.scope,
    }
  } catch (error) {
    console.error('[YouTube Analytics] Token refresh error:', error)
    return null
  }
}

// ============ CORE FETCH ============

async function analyticsFetch<T>(endpoint: string, accessToken: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`${ANALYTICS_BASE_URL}${endpoint}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!res.ok) {
      const body = await res.text()
      console.error(`[YouTube Analytics] ${res.status}: ${body.slice(0, 300)}`)
      return null
    }

    return await res.json() as T
  } catch (error) {
    console.error('[YouTube Analytics] Fetch error:', error)
    return null
  }
}

// ============ ANALYTICS QUERIES ============

interface YTAnalyticsResponse {
  kind: string
  columnHeaders: Array<{ name: string; columnType: string; dataType: string }>
  rows?: Array<Array<string | number>>
}

/**
 * Get channel overview analytics for a date range
 */
export async function getChannelAnalytics(
  accessToken: string,
  channelId: string,
  startDate: string, // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
): Promise<YouTubeAnalyticsData | null> {
  const data = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares',
  })

  if (!data?.rows?.length) return null

  const row = data.rows[0]
  const totals = {
    views: Number(row[0]) || 0,
    estimatedMinutesWatched: Number(row[1]) || 0,
    averageViewDuration: Number(row[2]) || 0,
    subscribersGained: Number(row[3]) || 0,
    subscribersLost: Number(row[4]) || 0,
    likes: Number(row[5]) || 0,
    comments: Number(row[6]) || 0,
    shares: Number(row[7]) || 0,
  }

  // Also get time series
  const tsData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,subscribersGained',
    dimensions: 'day',
    sort: 'day',
  })

  const timeSeries = tsData?.rows?.map(r => ({
    date: String(r[0]),
    views: Number(r[1]) || 0,
    estimatedMinutesWatched: Number(r[2]) || 0,
    subscribersGained: Number(r[3]) || 0,
  }))

  return {
    period: { startDate, endDate },
    totals,
    timeSeries,
  }
}

/**
 * Get audience demographics breakdown
 */
export async function getAudienceDemographics(
  accessToken: string,
  channelId: string,
  startDate: string,
  endDate: string
): Promise<AudienceDemographics | null> {
  // Country breakdown
  const countryData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views',
    dimensions: 'country',
    sort: '-views',
    maxResults: '25',
  })

  // Age group breakdown
  const ageData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'viewerPercentage',
    dimensions: 'ageGroup',
  })

  // Gender breakdown
  const genderData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'viewerPercentage',
    dimensions: 'gender',
  })

  // Device type breakdown
  const deviceData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views',
    dimensions: 'deviceType',
    sort: '-views',
  })

  // Traffic source breakdown
  const trafficData = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views',
    dimensions: 'insightTrafficSourceType',
    sort: '-views',
    maxResults: '15',
  })

  // Calculate total views for percentages
  const totalViews = countryData?.rows?.reduce((sum, r) => sum + Number(r[1]), 0) || 1

  return {
    countries: (countryData?.rows || []).map(r => ({
      country: String(r[0]),
      views: Number(r[1]) || 0,
      percentage: Math.round(((Number(r[1]) || 0) / totalViews) * 10000) / 100,
    })),
    ageGroups: (ageData?.rows || []).map(r => ({
      ageGroup: String(r[0]),
      viewerPercentage: Number(r[1]) || 0,
    })),
    genders: (genderData?.rows || []).map(r => ({
      gender: String(r[0]),
      viewerPercentage: Number(r[1]) || 0,
    })),
    deviceTypes: (deviceData?.rows || []).map(r => ({
      deviceType: String(r[0]),
      views: Number(r[1]) || 0,
    })),
    trafficSources: (trafficData?.rows || []).map(r => ({
      source: String(r[0]),
      views: Number(r[1]) || 0,
    })),
  }
}

/**
 * Get top performing videos with analytics
 */
export async function getTopVideos(
  accessToken: string,
  channelId: string,
  startDate: string,
  endDate: string,
  maxResults = 20
): Promise<VideoAnalyticsItem[]> {
  const data = await analyticsFetch<YTAnalyticsResponse>('/reports', accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained',
    dimensions: 'video',
    sort: '-views',
    maxResults: String(maxResults),
  })

  if (!data?.rows?.length) return []

  return data.rows.map(row => ({
    videoId: String(row[0]),
    views: Number(row[1]) || 0,
    estimatedMinutesWatched: Number(row[2]) || 0,
    averageViewDuration: Number(row[3]) || 0,
    likes: Number(row[4]) || 0,
    comments: Number(row[5]) || 0,
    subscribersGained: Number(row[6]) || 0,
  }))
}
