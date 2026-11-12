import { NextRequest, NextResponse } from 'next/server'

/**
 * Image proxy that fetches external images and serves them from our domain.
 * Solves CORS issues and expired CDN tokens for Instagram/TikTok/YouTube avatars.
 *
 * Usage: /api/proxy/image?url=ENCODED_URL
 * Cache: 7 days browser cache, 1 day stale-while-revalidate.
 * A dead URL (expired CDN token → 401/403, removed → 404/410) is answered
 * with the same status and a 6 h public cache: it is asked once per browser,
 * not on every page view (creator avatars go through
 * /api/influencers/[id]/avatar and their durable copy instead). Transient
 * failures (429 throttling, 5xx, network errors) are NOT cached — the URL
 * is still alive and the next view may succeed.
 */

const NEGATIVE_CACHE_HEADERS = { 'Cache-Control': 'public, max-age=21600' }
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }
const DEAD_URL_STATUSES = new Set([401, 403, 404, 410])
const MAX_REDIRECTS = 3
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url')

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 })
  }

  // Validate URL — only allow known CDN domains
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return new NextResponse('Invalid URL', { status: 400 })
  }

  const allowedHosts = [
    'scontent.cdninstagram.com',
    'instagram.com',
    'cdninstagram.com',
    'fbcdn.net',
    'googleusercontent.com',
    'ggpht.com',
    'ytimg.com',
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'muscdn.com',
    'p16-sign.tiktokcdn-us.com',
    'p16-sign-sg.tiktokcdn.com',
    'pbs.twimg.com',
  ]

  // Exact host or a real subdomain of it, over https. Until 12 Nov 2026 the
  // test was a bare endsWith(): "evil-fbcdn.net" passed as "fbcdn.net", the
  // fetch followed redirects anywhere and the upstream Content-Type was
  // relayed as-is, so this public route could serve someone else's HTML and
  // scripts from the platform's own origin.
  const hostAllowed = (hostname: string) =>
    allowedHosts.some((host) => hostname === host || hostname.endsWith('.' + host))

  if (parsedUrl.protocol !== 'https:' || !hostAllowed(parsedUrl.hostname)) {
    return new NextResponse('Domain not allowed', { status: 403 })
  }

  try {
    // Redirects are followed by hand, and every hop must be an allowed https host
    let current = parsedUrl
    let response: Response | null = null
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(current.toString(), {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Referer': `https://${current.hostname}/`,
        },
      })
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (!location || hop === MAX_REDIRECTS) {
        return new NextResponse('Too many redirects', { status: 502, headers: NO_STORE_HEADERS })
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        return new NextResponse('Invalid redirect', { status: 502, headers: NO_STORE_HEADERS })
      }
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname)) {
        return new NextResponse('Domain not allowed', { status: 403 })
      }
      current = next
    }
    if (!response) {
      return new NextResponse('Image fetch failed', { status: 502, headers: NO_STORE_HEADERS })
    }

    if (!response.ok) {
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502
      return new NextResponse('Failed to fetch image', { status, headers: DEAD_URL_STATUSES.has(status) ? NEGATIVE_CACHE_HEADERS : NO_STORE_HEADERS })
    }

    // Images only. SVG is a document that can carry scripts: never relayed.
    // Some CDNs label image bytes as a generic binary (or not at all): those
    // are served as image/jpeg, which with nosniff can only ever be drawn as
    // an image. Anything that declares itself a document is refused.
    const upstreamType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const genericBinary = upstreamType === '' || upstreamType === 'application/octet-stream' || upstreamType === 'binary/octet-stream'
    if (!genericBinary && (!upstreamType.startsWith('image/') || upstreamType === 'image/svg+xml')) {
      return new NextResponse('Not an image', { status: 415, headers: NO_STORE_HEADERS })
    }
    const contentType = genericBinary ? 'image/jpeg' : upstreamType
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return new NextResponse('Image too large', { status: 413, headers: NO_STORE_HEADERS })
    }

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
        // Never let a browser reinterpret the bytes as a page
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch {
    return new NextResponse('Image fetch failed', { status: 502, headers: NO_STORE_HEADERS })
  }
}
