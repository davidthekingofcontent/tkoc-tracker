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

  const isAllowed = allowedHosts.some(
    (host) => parsedUrl.hostname.endsWith(host) || parsedUrl.hostname === host
  )

  if (!isAllowed) {
    return new NextResponse('Domain not allowed', { status: 403 })
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': `https://${parsedUrl.hostname}/`,
      },
    })

    if (!response.ok) {
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502
      return new NextResponse('Failed to fetch image', { status, headers: DEAD_URL_STATUSES.has(status) ? NEGATIVE_CACHE_HEADERS : NO_STORE_HEADERS })
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const buffer = await response.arrayBuffer()

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return new NextResponse('Image fetch failed', { status: 502, headers: NO_STORE_HEADERS })
  }
}
