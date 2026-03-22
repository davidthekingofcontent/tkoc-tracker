/**
 * YouTube Data API v3 Client
 *
 * Uses only fetch() — no SDK dependency.
 * Provides public data access with just an API key (no OAuth needed).
 *
 * Quota: 10,000 units/day
 * - channels.list: 1 unit
 * - playlistItems.list: 1 unit
 * - videos.list: 1 unit
 * - search.list: 100 units (use sparingly!)
 */

import type { ScrapedProfile, ScrapedPost } from './apify'
import { prisma } from './db'

const BASE_URL = 'https://www.googleapis.com/youtube/v3'

// ============ API KEY MANAGEMENT ============

let _cachedKey: string | null = null
let _cacheTime = 0
const CACHE_TTL = 60_000 // 60 seconds

async function getApiKey(): Promise<string | null> {
  // 1. Environment variable (highest priority)
  if (process.env.YOUTUBE_API_KEY) {
    return process.env.YOUTUBE_API_KEY
  }

  // 2. Database setting (with cache)
  const now = Date.now()
  if (_cachedKey && now - _cacheTime < CACHE_TTL) {
    return _cachedKey
  }

  try {
    const setting = await prisma.setting.findFirst({
      where: { key: 'youtube_api_key' },
    })
    _cachedKey = setting?.value || null
    _cacheTime = now
    return _cachedKey
  } catch {
    return null
  }
}

export function isYouTubeApiConfigured(): boolean {
  return !!(process.env.YOUTUBE_API_KEY)
}

// ============ QUOTA TRACKING ============

let _dailyQuotaUsed = 0
let _quotaResetDate = new Date().toDateString()

function trackQuota(units: number): void {
  const today = new Date().toDateString()
  if (today !== _quotaResetDate) {
    _dailyQuotaUsed = 0
    _quotaResetDate = today
  }
  _dailyQuotaUsed += units
  if (_dailyQuotaUsed > 9000) {
    console.warn(`[YouTube API] ⚠️ Approaching daily quota: ${_dailyQuotaUsed}/10000 units`)
  }
}

export function getQuotaUsed(): number {
  const today = new Date().toDateString()
  if (today !== _quotaResetDate) return 0
  return _dailyQuotaUsed
}

function hasQuota(unitsNeeded: number): boolean {
  const today = new Date().toDateString()
  if (today !== _quotaResetDate) return true
  return (_dailyQuotaUsed + unitsNeeded) <= 10000
}

// ============ CORE API FUNCTIONS ============

interface YouTubeApiOptions {
  endpoint: string
  params: Record<string, string>
  quotaCost: number
}

async function youtubeApiFetch<T>(options: YouTubeApiOptions): Promise<T | null> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    console.warn('[YouTube API] No API key configured')
    return null
  }

  if (!hasQuota(options.quotaCost)) {
    console.warn(`[YouTube API] Daily quota exceeded (${_dailyQuotaUsed}/10000), skipping call`)
    return null
  }

  const url = new URL(`${BASE_URL}/${options.endpoint}`)
  url.searchParams.set('key', apiKey)
  for (const [key, value] of Object.entries(options.params)) {
    url.searchParams.set(key, value)
  }

  try {
    const res = await fetch(url.toString())
    trackQuota(options.quotaCost)

    if (!res.ok) {
      const errorBody = await res.text()
      console.error(`[YouTube API] ${res.status} ${res.statusText}: ${errorBody.slice(0, 200)}`)
      return null
    }

    return await res.json() as T
  } catch (error) {
    console.error('[YouTube API] Fetch error:', error)
    return null
  }
}

// ============ TYPE DEFINITIONS ============

interface YTChannelResponse {
  items?: Array<{
    id: string
    snippet: {
      title: string
      description: string
      customUrl?: string
      thumbnails: { high?: { url: string }; medium?: { url: string }; default?: { url: string } }
      country?: string
    }
    statistics: {
      subscriberCount: string
      viewCount: string
      videoCount: string
      hiddenSubscriberCount: boolean
    }
    contentDetails?: {
      relatedPlaylists: { uploads: string }
    }
  }>
}

interface YTPlaylistItemsResponse {
  items?: Array<{
    snippet: {
      resourceId: { videoId: string }
      title: string
      description: string
      thumbnails: { high?: { url: string }; medium?: { url: string } }
      publishedAt: string
    }
  }>
  nextPageToken?: string
}

interface YTVideoResponse {
  items?: Array<{
    id: string
    snippet: {
      title: string
      description: string
      thumbnails: { high?: { url: string }; medium?: { url: string } }
      publishedAt: string
      tags?: string[]
    }
    statistics: {
      viewCount: string
      likeCount: string
      commentCount: string
    }
    contentDetails: {
      duration: string // ISO 8601 e.g. "PT1M30S"
    }
  }>
}

interface YTSearchResponse {
  items?: Array<{
    id: { channelId: string }
    snippet: {
      channelId: string
      title: string
      description: string
      thumbnails: { high?: { url: string }; medium?: { url: string } }
    }
  }>
}

// ============ HELPER FUNCTIONS ============

/**
 * Parse ISO 8601 duration (PT1H2M30S) to seconds
 */
function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return 0
  const hours = parseInt(match[1] || '0')
  const minutes = parseInt(match[2] || '0')
  const seconds = parseInt(match[3] || '0')
  return hours * 3600 + minutes * 60 + seconds
}

/**
 * Determine media type based on video duration
 */
function getMediaType(durationIso: string): 'VIDEO' | 'SHORT' {
  const seconds = parseDuration(durationIso)
  return seconds <= 60 ? 'SHORT' : 'VIDEO'
}

/**
 * Extract hashtags from text
 */
function extractHashtags(text: string): string[] {
  return (text.match(/#[\w\u00C0-\u024F]+/g) || []).map(h => h.toLowerCase())
}

/**
 * Extract mentions from text
 */
function extractMentions(text: string): string[] {
  return (text.match(/@[\w.]+/g) || []).map(m => m.toLowerCase())
}

// ============ PUBLIC API ============

/**
 * Get channel info by @handle (e.g. "@MrBeast")
 * Quota cost: 1 unit
 */
export async function getChannelByHandle(handle: string): Promise<ScrapedProfile | null> {
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`

  const data = await youtubeApiFetch<YTChannelResponse>({
    endpoint: 'channels',
    params: {
      part: 'snippet,statistics,contentDetails',
      forHandle: cleanHandle,
    },
    quotaCost: 1,
  })

  if (!data?.items?.length) return null
  return channelToProfile(data.items[0])
}

/**
 * Get channel info by channel ID
 * Quota cost: 1 unit
 */
export async function getChannelById(channelId: string): Promise<ScrapedProfile | null> {
  const data = await youtubeApiFetch<YTChannelResponse>({
    endpoint: 'channels',
    params: {
      part: 'snippet,statistics,contentDetails',
      id: channelId,
    },
    quotaCost: 1,
  })

  if (!data?.items?.length) return null
  return channelToProfile(data.items[0])
}

/**
 * Get recent videos for a channel
 * Quota cost: 2 units (1 for playlist + 1 for video stats)
 */
export async function getChannelVideos(channelId: string, maxResults = 12): Promise<ScrapedPost[]> {
  // Step 1: Get uploads playlist ID
  const channelData = await youtubeApiFetch<YTChannelResponse>({
    endpoint: 'channels',
    params: {
      part: 'contentDetails',
      id: channelId,
    },
    quotaCost: 1,
  })

  const uploadsPlaylistId = channelData?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsPlaylistId) return []

  // Step 2: Get video IDs from uploads playlist
  const playlistData = await youtubeApiFetch<YTPlaylistItemsResponse>({
    endpoint: 'playlistItems',
    params: {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(maxResults, 50)),
    },
    quotaCost: 1,
  })

  if (!playlistData?.items?.length) return []

  const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId)

  // Step 3: Get video statistics (batch — up to 50 IDs per call)
  const videosData = await youtubeApiFetch<YTVideoResponse>({
    endpoint: 'videos',
    params: {
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
    },
    quotaCost: 1,
  })

  if (!videosData?.items?.length) return []

  return videosData.items.map(video => videoToPost(video))
}

/**
 * Search for channels by keyword
 * Quota cost: 100 units — use sparingly!
 */
export async function searchChannels(query: string, maxResults = 10): Promise<ScrapedProfile[]> {
  if (!hasQuota(100)) {
    console.warn('[YouTube API] Skipping search — insufficient quota')
    return []
  }

  const searchData = await youtubeApiFetch<YTSearchResponse>({
    endpoint: 'search',
    params: {
      part: 'snippet',
      q: query,
      type: 'channel',
      maxResults: String(Math.min(maxResults, 25)),
    },
    quotaCost: 100,
  })

  if (!searchData?.items?.length) return []

  // Get full channel details for each result
  const channelIds = searchData.items.map(item => item.id.channelId || item.snippet.channelId)

  const channelsData = await youtubeApiFetch<YTChannelResponse>({
    endpoint: 'channels',
    params: {
      part: 'snippet,statistics,contentDetails',
      id: channelIds.join(','),
    },
    quotaCost: 1,
  })

  if (!channelsData?.items?.length) return []

  return channelsData.items.map(ch => channelToProfile(ch, false))
}

/**
 * Search for videos by keyword/hashtag
 * Quota cost: 100 units — use sparingly!
 */
export async function searchVideos(query: string, maxResults = 20): Promise<ScrapedPost[]> {
  if (!hasQuota(100)) {
    console.warn('[YouTube API] Skipping video search — insufficient quota')
    return []
  }

  const searchData = await youtubeApiFetch<{
    items?: Array<{ id: { videoId: string } }>
  }>({
    endpoint: 'search',
    params: {
      part: 'id',
      q: query,
      type: 'video',
      maxResults: String(Math.min(maxResults, 50)),
      order: 'date',
    },
    quotaCost: 100,
  })

  if (!searchData?.items?.length) return []

  const videoIds = searchData.items.map(item => item.id.videoId)

  const videosData = await youtubeApiFetch<YTVideoResponse>({
    endpoint: 'videos',
    params: {
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
    },
    quotaCost: 1,
  })

  if (!videosData?.items?.length) return []

  return videosData.items.map(video => videoToPost(video))
}

// ============ MAPPERS ============

/**
 * Convert YouTube channel data to ScrapedProfile format
 */
function channelToProfile(
  channel: NonNullable<YTChannelResponse['items']>[0],
  includeRecentPosts = false
): ScrapedProfile {
  const stats = channel.statistics
  const snippet = channel.snippet
  const followers = stats.hiddenSubscriberCount ? 0 : parseInt(stats.subscriberCount || '0')
  const videoCount = parseInt(stats.videoCount || '0')

  // Extract username from customUrl (e.g. "@MrBeast" → "MrBeast")
  const username = snippet.customUrl
    ? snippet.customUrl.replace(/^@/, '')
    : channel.id

  return {
    username,
    displayName: snippet.title,
    bio: snippet.description?.slice(0, 500) || null,
    avatarUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || null,
    followers,
    following: 0, // YouTube doesn't expose this
    postsCount: videoCount,
    engagementRate: 0, // Calculated separately
    avgLikes: 0, // Calculated from recent videos
    avgComments: 0,
    avgViews: 0,
    isVerified: false, // YouTube API doesn't expose verification badge
    website: null,
    email: null,
    country: snippet.country || null,
    city: null,
    recentPosts: [],
  }
}

/**
 * Convert YouTube video data to ScrapedPost format
 */
function videoToPost(video: NonNullable<YTVideoResponse['items']>[0]): ScrapedPost {
  const stats = video.statistics
  const snippet = video.snippet
  const caption = snippet.title + (snippet.description ? `\n${snippet.description.slice(0, 300)}` : '')

  return {
    externalId: video.id,
    caption: snippet.title,
    mediaUrl: null,
    thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || null,
    permalink: `https://www.youtube.com/watch?v=${video.id}`,
    mediaType: getMediaType(video.contentDetails.duration),
    likes: parseInt(stats.likeCount || '0'),
    comments: parseInt(stats.commentCount || '0'),
    shares: 0, // YouTube doesn't expose share count
    saves: 0,
    views: parseInt(stats.viewCount || '0'),
    postedAt: snippet.publishedAt,
    hashtags: [
      ...extractHashtags(caption),
      ...(snippet.tags || []).map(t => `#${t.toLowerCase()}`),
    ],
    mentions: extractMentions(caption),
  }
}

/**
 * Get a full profile with recent videos (combined call)
 * Quota cost: ~4 units (channel + uploads playlist + video stats)
 */
export async function getFullProfile(username: string): Promise<ScrapedProfile | null> {
  // Try by handle first
  const profile = await getChannelByHandle(username)
  if (!profile) return null

  // Get the channel ID to fetch videos
  const channelData = await youtubeApiFetch<YTChannelResponse>({
    endpoint: 'channels',
    params: {
      part: 'contentDetails',
      forHandle: username.startsWith('@') ? username : `@${username}`,
    },
    quotaCost: 1,
  })

  const channelId = channelData?.items?.[0]?.id
  if (!channelId) return profile

  // Get recent videos
  const videos = await getChannelVideos(channelId, 12)

  // Calculate averages from recent videos
  if (videos.length > 0) {
    profile.avgLikes = Math.round(videos.reduce((sum, v) => sum + v.likes, 0) / videos.length)
    profile.avgComments = Math.round(videos.reduce((sum, v) => sum + v.comments, 0) / videos.length)
    profile.avgViews = Math.round(videos.reduce((sum, v) => sum + v.views, 0) / videos.length)

    if (profile.followers > 0) {
      const avgEngagement = (profile.avgLikes + profile.avgComments) / profile.followers
      profile.engagementRate = Math.round(avgEngagement * 10000) / 100 // 2 decimal percent
    }
  }

  profile.recentPosts = videos
  return profile
}
