/**
 * Routes external CDN image URLs through our server-side proxy
 * to avoid CORS issues and expired tokens from Instagram/TikTok/YouTube CDNs.
 */
/**
 * Thumbnail of a captured publication: the durable copy served by
 * /api/media/[id]/thumb (CDN URLs expire). Falls back to the proxied CDN URL
 * when the row has no id (e.g. a scraped post not yet stored).
 */
export function mediaThumbUrl(media: { id?: string | null; thumbnailUrl?: string | null; mediaUrl?: string | null }): string {
  if (media.id) return `/api/media/${media.id}/thumb`
  return proxyImg(media.thumbnailUrl || media.mediaUrl)
}

/**
 * Profile picture of a creator: the durable copy served by
 * /api/influencers/[id]/avatar (influencer_avatars; CDN URLs expire within
 * days). Falls back to the proxied CDN URL when there is no Influencer id
 * (a scraped profile not stored yet, a CreatorPlatformProfile row) and to ''
 * when there is nothing at all (the Avatar component then shows initials).
 */
export function avatarSrcOf(inf: { id?: string | null; avatarUrl?: string | null } | null | undefined): string {
  if (!inf) return ''
  if (inf.id) return `/api/influencers/${inf.id}/avatar`
  return proxyImg(inf.avatarUrl)
}

export function proxyImg(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const externalHosts = [
      'cdninstagram.com',
      'fbcdn.net',
      'googleusercontent.com',
      'ggpht.com',
      'ytimg.com',
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'muscdn.com',
      'pbs.twimg.com',
      'scontent.cdninstagram.com',
      'instagram.com',
    ]
    const isExternal = externalHosts.some(
      (h) => parsed.hostname.endsWith(h) || parsed.hostname === h
    )
    if (isExternal) {
      return `/api/proxy/image?url=${encodeURIComponent(url)}`
    }
  } catch {
    // Invalid URL, return as-is
  }
  return url
}
