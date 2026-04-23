/**
 * Meta Graph API Client — Facebook Graph API v19.0
 *
 * Implements OAuth flow, account discovery, IG Business content + insights,
 * audience demographics, mentions, and deauthorization.
 *
 * All tokens are passed in plaintext to these functions (caller decrypts them).
 * Never log tokens, not even partial.
 */

const GRAPH_VERSION = 'v19.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

// ============ TYPES ============

export interface IgMediaItem {
  id: string
  caption?: string
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS' | 'STORY'
  media_url?: string
  thumbnail_url?: string
  permalink: string
  timestamp: string
  username?: string
  like_count?: number
  comments_count?: number
}

export interface IgBusinessProfile {
  id: string
  username: string
  name: string
  profile_picture_url: string
  followers_count: number
  follows_count: number
  media_count: number
  biography: string
  website: string
}

export interface IgPage {
  id: string
  name: string
  access_token: string
  instagram_business_account?: { id: string }
}

export interface StoryMention {
  id: string
  username: string
  media_id: string
  timestamp: string
}

// ============ ERROR ============

export class MetaApiError extends Error {
  status: number
  responseBody: string
  constructor(message: string, status: number, responseBody: string) {
    super(message)
    this.name = 'MetaApiError'
    this.status = status
    this.responseBody = responseBody
  }
}

// ============ INTERNAL FETCH ============

interface GraphFetchOpts {
  method?: 'GET' | 'POST' | 'DELETE'
  params?: Record<string, string | number | undefined>
  accessToken?: string
}

async function graphFetch<T>(path: string, opts: GraphFetchOpts = {}): Promise<T> {
  const { method = 'GET', params = {}, accessToken } = opts
  const url = new URL(`${GRAPH_BASE}${path}`)
  if (accessToken) {
    url.searchParams.set('access_token', accessToken)
  }
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    url.searchParams.set(k, String(v))
  }

  let res: Response
  try {
    res = await fetch(url.toString(), { method })
  } catch (err) {
    throw new MetaApiError(
      `Network error calling Meta Graph API: ${err instanceof Error ? err.message : String(err)}`,
      0,
      ''
    )
  }

  const text = await res.text()
  if (!res.ok) {
    // Do NOT log the URL or tokens. Just path + status.
    throw new MetaApiError(
      `Meta Graph API ${method} ${path} failed with ${res.status}`,
      res.status,
      text.slice(0, 500)
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new MetaApiError(`Meta Graph API returned invalid JSON for ${path}`, res.status, text.slice(0, 500))
  }
}

function requireAppCreds(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) {
    throw new MetaApiError('META_APP_ID and META_APP_SECRET must be configured', 500, '')
  }
  return { appId, appSecret }
}

// ============ OAUTH FLOW ============

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; expires_in: number }> {
  const { appId, appSecret } = requireAppCreds()
  const res = await graphFetch<{ access_token: string; token_type: string; expires_in?: number }>(
    '/oauth/access_token',
    {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
    }
  )
  return {
    access_token: res.access_token,
    expires_in: res.expires_in ?? 60 * 60, // short-lived default: 1h
  }
}

export async function getLongLivedToken(
  shortToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const { appId, appSecret } = requireAppCreds()
  const res = await graphFetch<{ access_token: string; token_type: string; expires_in?: number }>(
    '/oauth/access_token',
    {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      },
    }
  )
  return {
    access_token: res.access_token,
    expires_in: res.expires_in ?? 60 * 60 * 24 * 60, // 60 days
  }
}

export async function refreshLongLivedToken(
  currentToken: string
): Promise<{ access_token: string; expires_in: number }> {
  // Refreshing a long-lived token uses the same fb_exchange_token endpoint.
  return getLongLivedToken(currentToken)
}

// ============ ACCOUNT DISCOVERY ============

export async function getUserInfo(token: string): Promise<{ id: string; name: string }> {
  const res = await graphFetch<{ id: string; name: string }>('/me', {
    accessToken: token,
    params: { fields: 'id,name' },
  })
  return { id: res.id, name: res.name }
}

export async function getUserPages(token: string): Promise<IgPage[]> {
  const res = await graphFetch<{
    data: IgPage[]
  }>('/me/accounts', {
    accessToken: token,
    params: { fields: 'id,name,access_token,instagram_business_account', limit: 100 },
  })
  return res.data ?? []
}

export async function getIgBusinessAccount(
  _pageId: string,
  pageToken: string
): Promise<IgBusinessProfile | null> {
  // Given a page token, fetch the linked instagram_business_account and its details.
  // Caller already knows the IG business id from page discovery, but we still need full profile.
  const pageInfo = await graphFetch<{
    instagram_business_account?: { id: string }
  }>('/me', {
    accessToken: pageToken,
    params: { fields: 'instagram_business_account' },
  }).catch(() => null)

  const igId = pageInfo?.instagram_business_account?.id
  if (!igId) return null

  const profile = await graphFetch<IgBusinessProfile>(`/${igId}`, {
    accessToken: pageToken,
    params: {
      fields:
        'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    },
  })
  return profile
}

// Alternate helper used when IG business id is already known.
export async function getIgProfileById(
  igBusinessId: string,
  token: string
): Promise<IgBusinessProfile> {
  return graphFetch<IgBusinessProfile>(`/${igBusinessId}`, {
    accessToken: token,
    params: {
      fields:
        'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography,website',
    },
  })
}

// ============ CONTENT ============

function mapMediaItem(m: RawMediaItem): IgMediaItem {
  return {
    id: m.id,
    caption: m.caption,
    media_type: (m.media_product_type === 'REELS' ? 'REELS' : m.media_type) as IgMediaItem['media_type'],
    media_url: m.media_url,
    thumbnail_url: m.thumbnail_url,
    permalink: m.permalink,
    timestamp: m.timestamp,
    username: m.username,
    like_count: m.like_count,
    comments_count: m.comments_count,
  }
}

interface RawMediaItem {
  id: string
  caption?: string
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM'
  media_product_type?: 'REELS' | 'AD' | 'FEED' | 'STORY'
  media_url?: string
  thumbnail_url?: string
  permalink: string
  timestamp: string
  username?: string
  like_count?: number
  comments_count?: number
}

export async function getIgMedia(
  igBusinessId: string,
  token: string,
  limit = 25
): Promise<IgMediaItem[]> {
  const res = await graphFetch<{ data: RawMediaItem[] }>(`/${igBusinessId}/media`, {
    accessToken: token,
    params: {
      fields:
        'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,username,like_count,comments_count',
      limit,
    },
  })
  return (res.data ?? []).map(mapMediaItem)
}

export async function getIgMediaInsights(
  mediaId: string,
  mediaType: string,
  token: string
): Promise<Record<string, number>> {
  // Metric set varies by type — select relevant metrics per Meta docs.
  let metrics: string
  switch (mediaType) {
    case 'STORY':
      metrics = 'impressions,reach,replies,exits,taps_forward,taps_back'
      break
    case 'REELS':
    case 'VIDEO':
      metrics = 'reach,plays,total_interactions,likes,comments,shares,saved'
      break
    case 'CAROUSEL_ALBUM':
      metrics = 'reach,impressions,engagement,saved,shares'
      break
    default:
      metrics = 'reach,impressions,engagement,saved,shares'
  }

  try {
    const res = await graphFetch<{
      data: Array<{ name: string; values: Array<{ value: number }> }>
    }>(`/${mediaId}/insights`, {
      accessToken: token,
      params: { metric: metrics },
    })
    const out: Record<string, number> = {}
    for (const m of res.data ?? []) {
      out[m.name] = m.values?.[0]?.value ?? 0
    }
    return out
  } catch (err) {
    // Some metrics may be unavailable for specific media types/permissions — return empty.
    if (err instanceof MetaApiError && (err.status === 400 || err.status === 404)) {
      return {}
    }
    throw err
  }
}

export async function getIgStories(igBusinessId: string, token: string): Promise<IgMediaItem[]> {
  try {
    const res = await graphFetch<{ data: RawMediaItem[] }>(`/${igBusinessId}/stories`, {
      accessToken: token,
      params: {
        fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username',
      },
    })
    return (res.data ?? []).map(m => ({
      ...mapMediaItem(m),
      media_type: 'STORY',
    }))
  } catch (err) {
    if (err instanceof MetaApiError && (err.status === 400 || err.status === 404)) {
      return []
    }
    throw err
  }
}

// ============ AUDIENCE INSIGHTS ============

export async function getIgAudienceInsights(
  igBusinessId: string,
  token: string
): Promise<{
  audience_gender_age: Record<string, number>
  audience_country: Record<string, number>
  audience_city: Record<string, number>
  audience_locale: Record<string, number>
  online_followers: Record<string, number>
}> {
  const result = {
    audience_gender_age: {} as Record<string, number>,
    audience_country: {} as Record<string, number>,
    audience_city: {} as Record<string, number>,
    audience_locale: {} as Record<string, number>,
    online_followers: {} as Record<string, number>,
  }

  // Lifetime demographics (gender_age, country, city, locale)
  try {
    const res = await graphFetch<{
      data: Array<{
        name: string
        values: Array<{ value: Record<string, number> }>
      }>
    }>(`/${igBusinessId}/insights`, {
      accessToken: token,
      params: {
        metric: 'audience_gender_age,audience_country,audience_city,audience_locale',
        period: 'lifetime',
      },
    })
    for (const m of res.data ?? []) {
      const value = m.values?.[0]?.value ?? {}
      if (m.name === 'audience_gender_age') result.audience_gender_age = value
      else if (m.name === 'audience_country') result.audience_country = value
      else if (m.name === 'audience_city') result.audience_city = value
      else if (m.name === 'audience_locale') result.audience_locale = value
    }
  } catch (err) {
    if (!(err instanceof MetaApiError) || (err.status !== 400 && err.status !== 404)) {
      throw err
    }
  }

  // Online followers (lifetime) — hour-by-hour distribution
  try {
    const res = await graphFetch<{
      data: Array<{
        name: string
        values: Array<{ value: Record<string, number> }>
      }>
    }>(`/${igBusinessId}/insights`, {
      accessToken: token,
      params: { metric: 'online_followers', period: 'lifetime' },
    })
    for (const m of res.data ?? []) {
      const value = m.values?.[0]?.value ?? {}
      if (m.name === 'online_followers') result.online_followers = value
    }
  } catch (err) {
    if (!(err instanceof MetaApiError) || (err.status !== 400 && err.status !== 404)) {
      throw err
    }
  }

  return result
}

// ============ MENTIONS ============

export async function getStoryMentions(
  igBusinessId: string,
  token: string,
  since?: Date
): Promise<StoryMention[]> {
  // Story mentions subscribe via webhook in production. This polling fallback uses
  // the /tags endpoint filtered to stories if available; otherwise we use mentioned_media.
  try {
    interface TagNode {
      id: string
      username?: string
      caption?: string
      media_type: string
      timestamp: string
    }
    const params: Record<string, string | number> = {
      fields: 'id,username,caption,media_type,timestamp',
      limit: 50,
    }
    if (since) {
      params.since = Math.floor(since.getTime() / 1000)
    }
    const res = await graphFetch<{ data: TagNode[] }>(`/${igBusinessId}/tags`, {
      accessToken: token,
      params,
    })
    return (res.data ?? [])
      .filter(t => t.media_type === 'STORY' || t.media_type === 'VIDEO' || t.media_type === 'IMAGE')
      .map(t => ({
        id: t.id,
        username: t.username || '',
        media_id: t.id,
        timestamp: t.timestamp,
      }))
  } catch (err) {
    if (err instanceof MetaApiError && (err.status === 400 || err.status === 404)) {
      return []
    }
    throw err
  }
}

export async function getTaggedMedia(
  igBusinessId: string,
  token: string,
  limit = 25
): Promise<IgMediaItem[]> {
  try {
    const res = await graphFetch<{ data: RawMediaItem[] }>(`/${igBusinessId}/tags`, {
      accessToken: token,
      params: {
        fields:
          'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,username,like_count,comments_count',
        limit,
      },
    })
    return (res.data ?? []).map(mapMediaItem)
  } catch (err) {
    if (err instanceof MetaApiError && (err.status === 400 || err.status === 404)) {
      return []
    }
    throw err
  }
}

// ============ DELETION ============

/**
 * Revoke the app's permissions for the user tied to this access token.
 * Meta endpoint: DELETE /me/permissions
 */
export async function deauthorize(token: string): Promise<void> {
  try {
    await graphFetch('/me/permissions', {
      method: 'DELETE',
      accessToken: token,
    })
  } catch (err) {
    // Token may already be invalid — do not throw on 4xx.
    if (err instanceof MetaApiError && err.status >= 400 && err.status < 500) {
      return
    }
    throw err
  }
}
