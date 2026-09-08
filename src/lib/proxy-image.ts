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
