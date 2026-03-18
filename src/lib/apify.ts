import { ApifyClient } from 'apify-client'

// Initialize Apify client
function getClient(): ApifyClient | null {
  const token = process.env.APIFY_API_KEY
  if (!token) return null
  return new ApifyClient({ token })
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
  const client = getClient()
  if (!client) throw new Error('APIFY_API_KEY not configured')

  const run = await client.actor('apify/instagram-profile-scraper').call({
    usernames: [username],
  }, {
    waitSecs: 120,
  })

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  if (!items || items.length === 0) return null

  const profile = items[0] as Record<string, unknown>

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

    // Determine media type
    let mediaType: ScrapedPost['mediaType'] = 'POST'
    const type = (post.type as string) || ''
    if (type.includes('Video') || type.includes('Reel')) mediaType = 'REEL'
    else if (type.includes('Sidecar') || type.includes('Carousel')) mediaType = 'CAROUSEL'

    // Extract hashtags and mentions from caption
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
    country: null,
    city: null,
    recentPosts,
  }
}

// ============ TIKTOK ============

async function scrapeTikTokProfile(username: string): Promise<ScrapedProfile | null> {
  const client = getClient()
  if (!client) throw new Error('APIFY_API_KEY not configured')

  // Use the free TikTok scraper
  const run = await client.actor('clockworks/free-tiktok-scraper').call({
    profiles: [username],
    resultsPerPage: 12,
    shouldDownloadVideos: false,
  }, {
    waitSecs: 120,
  })

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  if (!items || items.length === 0) return null

  // The scraper returns posts, we need to extract profile info from them
  // First item usually has author info
  const firstItem = items[0] as Record<string, unknown>
  const authorMeta = (firstItem.authorMeta as Record<string, unknown>) || firstItem

  const followers = (authorMeta.fans as number) || (authorMeta.followers as number) || 0
  const following = (authorMeta.following as number) || 0

  // Process posts for metrics
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
      thumbnailUrl: (post.covers as Record<string, string>)?.default || null,
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
    ? parseFloat(((((totalLikes + totalComments + totalShares) / postCount) / followers) * 100).toFixed(2))
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
    country: null,
    city: null,
    recentPosts,
  }
}

// ============ YOUTUBE ============

async function scrapeYouTubeProfile(username: string): Promise<ScrapedProfile | null> {
  const client = getClient()
  if (!client) throw new Error('APIFY_API_KEY not configured')

  const run = await client.actor('streamers/youtube-channel-scraper').call({
    channelUrls: [`https://youtube.com/@${username}`],
    maxVideos: 12,
  }, {
    waitSecs: 120,
  })

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  if (!items || items.length === 0) return null

  const channel = items[0] as Record<string, unknown>

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

    // Determine if short
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
}

async function scrapeInstagramHashtag(hashtag: string, maxPosts = 20): Promise<HashtagResult[]> {
  const client = getClient()
  if (!client) throw new Error('APIFY_API_KEY not configured')

  const cleanTag = hashtag.replace(/^#/, '')

  const run = await client.actor('apify/instagram-hashtag-scraper').call({
    hashtags: [cleanTag],
    resultsLimit: maxPosts,
  }, {
    waitSecs: 180,
  })

  const { items } = await client.dataset(run.defaultDatasetId).listItems()

  if (!items || items.length === 0) return []

  return items.map((post: Record<string, unknown>) => {
    const owner = (post.ownerUsername as string) || ''
    const caption = (post.caption as string) || ''
    const hashtags = caption.match(/#\w+/g) || []
    const mentions = caption.match(/@\w+/g) || []

    return {
      posts: [{
        externalId: (post.id as string) || (post.shortCode as string) || '',
        caption,
        mediaUrl: (post.displayUrl as string) || null,
        thumbnailUrl: (post.thumbnailUrl as string) || null,
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
    }
  })
}

// ============ PUBLIC API ============

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
    // TikTok and YouTube hashtag scraping can be added later
    default:
      return []
  }
}

export function isApifyConfigured(): boolean {
  return !!process.env.APIFY_API_KEY
}
