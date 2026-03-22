/**
 * Unified Platform Client
 *
 * Abstraction layer over all data sources:
 * 1. YouTube Data API (API key — public data)
 * 2. Instagram Graph API (OAuth — connected accounts)
 * 3. Instagram Creator Marketplace API (OAuth — brand discovery)
 * 4. Facebook Creator Discovery API (OAuth — brand discovery)
 * 5. YouTube Analytics API (OAuth — channel owner)
 * 6. Apify (fallback — scraping)
 *
 * Each function tries the best available source first and falls back to Apify.
 */

import type { ScrapedProfile, ScrapedPost, HashtagResult } from './apify'
import * as youtubeApi from './youtube-api'
import * as instagramApi from './instagram-api'
import * as marketplace from './instagram-marketplace'
import * as fbDiscovery from './facebook-discovery'
import * as ytAnalytics from './youtube-analytics'
import { scrapeProfile, scrapeHashtag, searchInstagramAccounts } from './apify'
import { prisma } from './db'
import { decrypt } from './crypto'

// ============ TYPES ============

export type DataSource = 'api' | 'oauth' | 'marketplace' | 'apify'

export interface ProfileResult {
  profile: ScrapedProfile
  dataSource: DataSource
}

export interface MediaResult {
  posts: ScrapedPost[]
  dataSource: DataSource
}

export interface DiscoveryResult {
  username: string
  displayName: string | null
  avatarUrl: string | null
  followers: number
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  dataSource: DataSource
  // Marketplace-specific enrichment
  country?: string | null
  gender?: string | null
  ageBucket?: string | null
  isVerified?: boolean
  engagedAccounts?: number | null
  reelsInteractionRate?: number | null
  reelsHookRate?: number | null
  hasBrandPartnershipExperience?: boolean
  pastBrandPartners?: string[]
}

// ============ TOKEN HELPERS ============

/**
 * Get a valid Meta (Instagram/Facebook) page access token for the current user.
 * Returns null if no token is stored or if it's invalid.
 */
async function getMetaPageToken(userId: string): Promise<{ token: string; igUserId: string; pageId: string } | null> {
  try {
    const socialToken = await prisma.socialToken.findFirst({
      where: {
        userId,
        platform: 'INSTAGRAM',
        tokenType: 'page',
        isValid: true,
      },
      orderBy: { updatedAt: 'desc' },
    })

    if (!socialToken) return null

    // Check expiry
    if (socialToken.expiresAt && new Date(socialToken.expiresAt) < new Date()) {
      // Try to refresh
      const appId = process.env.META_APP_ID
      const appSecret = process.env.META_APP_SECRET
      if (appId && appSecret) {
        const decryptedToken = decrypt(socialToken.accessToken)
        const refreshed = await instagramApi.refreshLongLivedToken(decryptedToken, appId, appSecret)
        if (refreshed) {
          const { encrypt } = await import('./crypto')
          await prisma.socialToken.update({
            where: { id: socialToken.id },
            data: {
              accessToken: encrypt(refreshed.accessToken),
              expiresAt: refreshed.expiresIn
                ? new Date(Date.now() + refreshed.expiresIn * 1000)
                : null,
              lastUsedAt: new Date(),
            },
          })
          return {
            token: refreshed.accessToken,
            igUserId: socialToken.platformUserId || '',
            pageId: socialToken.platformPageId || '',
          }
        }
      }

      // Refresh failed — mark invalid
      await prisma.socialToken.update({
        where: { id: socialToken.id },
        data: { isValid: false, lastError: 'Token expired and refresh failed' },
      })
      return null
    }

    return {
      token: decrypt(socialToken.accessToken),
      igUserId: socialToken.platformUserId || '',
      pageId: socialToken.platformPageId || '',
    }
  } catch (error) {
    console.error('[PlatformClient] Error getting Meta token:', error)
    return null
  }
}

/**
 * Get a valid YouTube Analytics OAuth token for an influencer
 */
async function getYouTubeAnalyticsToken(influencerId: string): Promise<{ token: string; channelId: string } | null> {
  try {
    const socialToken = await prisma.socialToken.findFirst({
      where: {
        influencerId,
        platform: 'YOUTUBE',
        tokenType: 'user',
        isValid: true,
      },
    })

    if (!socialToken) return null

    // Check expiry and refresh if needed
    if (socialToken.expiresAt && new Date(socialToken.expiresAt) < new Date()) {
      const clientId = process.env.GOOGLE_CLIENT_ID
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET
      const refreshTokenStr = socialToken.refreshToken ? decrypt(socialToken.refreshToken) : null

      if (clientId && clientSecret && refreshTokenStr) {
        const refreshed = await ytAnalytics.refreshGoogleToken(refreshTokenStr, clientId, clientSecret)
        if (refreshed) {
          const { encrypt } = await import('./crypto')
          await prisma.socialToken.update({
            where: { id: socialToken.id },
            data: {
              accessToken: encrypt(refreshed.accessToken),
              expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
              lastUsedAt: new Date(),
            },
          })
          return {
            token: refreshed.accessToken,
            channelId: socialToken.platformUserId || '',
          }
        }
      }

      await prisma.socialToken.update({
        where: { id: socialToken.id },
        data: { isValid: false, lastError: 'Token expired and refresh failed' },
      })
      return null
    }

    return {
      token: decrypt(socialToken.accessToken),
      channelId: socialToken.platformUserId || '',
    }
  } catch (error) {
    console.error('[PlatformClient] Error getting YouTube Analytics token:', error)
    return null
  }
}

// ============ PUBLIC API ============

/**
 * Fetch an influencer's profile from the best available source.
 *
 * Priority:
 * 1. YouTube Data API (for YouTube — API key only, no OAuth needed)
 * 2. Instagram Graph API (for Instagram — if OAuth token available)
 * 3. Apify (fallback for all platforms)
 */
export async function fetchProfile(
  username: string,
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  options?: { userId?: string; influencerId?: string }
): Promise<ProfileResult | null> {
  // --- YouTube: always try API key first ---
  if (platform === 'YOUTUBE') {
    try {
      const profile = await youtubeApi.getFullProfile(username)
      if (profile) {
        return { profile, dataSource: 'api' }
      }
    } catch (error) {
      console.warn(`[PlatformClient] YouTube API failed for ${username}:`, error)
    }
  }

  // --- Instagram: try Graph API if connected ---
  if (platform === 'INSTAGRAM' && options?.userId) {
    try {
      const meta = await getMetaPageToken(options.userId)
      if (meta?.token && meta.igUserId) {
        const profile = await instagramApi.getIGProfile(meta.token, meta.igUserId)
        if (profile) {
          const media = await instagramApi.getIGMedia(meta.token, meta.igUserId, 12)
          profile.recentPosts = media
          if (media.length > 0) {
            profile.avgLikes = Math.round(media.reduce((sum, m) => sum + m.likes, 0) / media.length)
            profile.avgComments = Math.round(media.reduce((sum, m) => sum + m.comments, 0) / media.length)
          }
          return { profile, dataSource: 'oauth' }
        }
      }
    } catch (error) {
      console.warn(`[PlatformClient] Instagram API failed for ${username}:`, error)
    }
  }

  // --- Fallback: Apify ---
  try {
    const profile = await scrapeProfile(username, platform)
    if (profile) {
      return { profile, dataSource: 'apify' }
    }
  } catch (error) {
    console.warn(`[PlatformClient] Apify failed for ${username}:`, error)
  }

  return null
}

/**
 * Fetch recent media for an influencer.
 */
export async function fetchMedia(
  username: string,
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  options?: { userId?: string; influencerId?: string; maxResults?: number }
): Promise<MediaResult | null> {
  const maxResults = options?.maxResults || 12

  // YouTube: API key
  if (platform === 'YOUTUBE') {
    try {
      // First get channel ID
      const channelData = await youtubeApi.getChannelByHandle(username)
      if (channelData) {
        // We need the channel ID — fetch it
        const handle = username.startsWith('@') ? username : `@${username}`
        const response = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${process.env.YOUTUBE_API_KEY}`
        )
        if (response.ok) {
          const data = await response.json() as { items?: Array<{ id: string }> }
          const channelId = data.items?.[0]?.id
          if (channelId) {
            const posts = await youtubeApi.getChannelVideos(channelId, maxResults)
            if (posts.length > 0) {
              return { posts, dataSource: 'api' }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`[PlatformClient] YouTube media fetch failed for ${username}:`, error)
    }
  }

  // Fallback to profile scrape which includes recent posts
  try {
    const profile = await scrapeProfile(username, platform)
    if (profile?.recentPosts?.length) {
      return { posts: profile.recentPosts, dataSource: 'apify' }
    }
  } catch {
    // ignore
  }

  return null
}

/**
 * Discover creators/influencers.
 *
 * Priority:
 * 1. Instagram Creator Marketplace API (best data, requires Meta OAuth)
 * 2. Facebook Creator Discovery API (for Facebook creators)
 * 3. Apify Instagram search (fallback)
 */
export async function discoverCreators(
  query: string,
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  options?: {
    userId?: string
    filters?: marketplace.CreatorDiscoveryFilters
    maxResults?: number
  }
): Promise<DiscoveryResult[]> {
  const maxResults = options?.maxResults || 25

  // Instagram: try Creator Marketplace first
  if (platform === 'INSTAGRAM' && options?.userId) {
    try {
      const meta = await getMetaPageToken(options.userId)
      if (meta?.token && meta.igUserId) {
        const filters = options?.filters || {}
        if (!filters.query && query) filters.query = query

        const creators = await marketplace.discoverCreators(meta.token, meta.igUserId, filters, maxResults)

        if (creators.length > 0) {
          return creators.map(c => ({
            username: c.username,
            displayName: c.username,
            avatarUrl: null,
            followers: c.insights?.totalFollowers || 0,
            platform: 'INSTAGRAM' as const,
            dataSource: 'marketplace' as const,
            country: c.country,
            gender: c.gender,
            ageBucket: c.ageBucket,
            isVerified: c.isAccountVerified,
            engagedAccounts: c.insights?.engagedAccounts,
            reelsInteractionRate: c.insights?.reelsInteractionRate,
            reelsHookRate: c.insights?.reelsHookRate,
            hasBrandPartnershipExperience: c.hasBrandPartnershipExperience,
            pastBrandPartners: c.pastBrandPartners,
          }))
        }
      }
    } catch (error) {
      console.warn('[PlatformClient] Creator Marketplace search failed:', error)
    }
  }

  // YouTube: search via Data API
  if (platform === 'YOUTUBE') {
    try {
      const channels = await youtubeApi.searchChannels(query, maxResults)
      if (channels.length > 0) {
        return channels.map(ch => ({
          username: ch.username,
          displayName: ch.displayName,
          avatarUrl: ch.avatarUrl,
          followers: ch.followers,
          platform: 'YOUTUBE' as const,
          dataSource: 'api' as const,
        }))
      }
    } catch (error) {
      console.warn('[PlatformClient] YouTube search failed:', error)
    }
  }

  // Fallback: Apify Instagram search
  if (platform === 'INSTAGRAM') {
    try {
      const results = await searchInstagramAccounts(query, { limit: maxResults })
      return results.map(r => ({
        username: r.username,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        followers: r.followers,
        platform: 'INSTAGRAM' as const,
        dataSource: 'apify' as const,
      }))
    } catch (error) {
      console.warn('[PlatformClient] Apify search failed:', error)
    }
  }

  return []
}

/**
 * Get YouTube Analytics for a connected influencer.
 * Returns null if the influencer hasn't connected their YouTube account.
 */
export async function getYouTubeChannelAnalytics(
  influencerId: string,
  startDate: string,
  endDate: string
): Promise<ytAnalytics.YouTubeAnalyticsData | null> {
  const token = await getYouTubeAnalyticsToken(influencerId)
  if (!token) return null

  return ytAnalytics.getChannelAnalytics(token.token, token.channelId, startDate, endDate)
}

/**
 * Get YouTube audience demographics for a connected influencer.
 */
export async function getYouTubeAudienceDemographics(
  influencerId: string,
  startDate: string,
  endDate: string
): Promise<ytAnalytics.AudienceDemographics | null> {
  const token = await getYouTubeAnalyticsToken(influencerId)
  if (!token) return null

  return ytAnalytics.getAudienceDemographics(token.token, token.channelId, startDate, endDate)
}

/**
 * Check which data sources are available for a given platform.
 * Useful for UI to show connection status.
 */
export async function getAvailableDataSources(
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
  userId?: string
): Promise<{
  api: boolean        // YouTube API key
  oauth: boolean      // Connected via OAuth
  marketplace: boolean // Creator Marketplace available
  apify: boolean      // Apify configured
}> {
  const result = { api: false, oauth: false, marketplace: false, apify: false }

  // Apify is always available if configured
  result.apify = !!(process.env.APIFY_API_KEY)

  if (platform === 'YOUTUBE') {
    result.api = youtubeApi.isYouTubeApiConfigured()
  }

  if (userId) {
    try {
      const metaToken = await prisma.socialToken.findFirst({
        where: { userId, platform: 'INSTAGRAM', tokenType: 'page', isValid: true },
      })
      if (metaToken) {
        result.oauth = true
        result.marketplace = metaToken.scopes.includes('instagram_creator_marketplace_discovery')
      }
    } catch {
      // ignore
    }
  }

  return result
}
