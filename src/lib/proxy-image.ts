/**
 * Routes external CDN image URLs through our server-side proxy
 * to avoid CORS issues and expired tokens from Instagram/TikTok/YouTube CDNs.
 */
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
