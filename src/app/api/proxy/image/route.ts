import { NextRequest, NextResponse } from 'next/server'

/**
 * Image proxy that fetches external images and serves them from our domain.
 * Solves CORS issues and expired CDN tokens for Instagram/TikTok/YouTube avatars.
 *
 * Usage: /api/proxy/image?url=ENCODED_URL
 * Cache: 7 days browser cache, 1 day stale-while-revalidate
 */
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
      return new NextResponse('Failed to fetch image', { status: response.status })
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
    return new NextResponse('Image fetch failed', { status: 502 })
  }
}
