import { NextRequest, NextResponse } from 'next/server'
import { scrapeProfile, isApifyConfigured } from '@/lib/apify'

export async function GET(request: NextRequest) {
  const token = process.env.APIFY_API_KEY
  const hasToken = !!token
  const tokenPreview = token ? `${token.substring(0, 12)}...${token.substring(token.length - 4)}` : 'NOT SET'

  const results: Record<string, unknown> = {
    hasToken,
    tokenPreview,
    isApifyConfigured: isApifyConfigured(),
    nodeVersion: process.version,
    envKeys: Object.keys(process.env).filter(k => k.includes('APIFY') || k.includes('apify')),
  }

  // Try a simple Apify API call - just check user info
  if (token) {
    try {
      const res = await fetch(`https://api.apify.com/v2/users/me?token=${token}`)
      results.apifyStatus = res.status
      results.apifyOk = res.ok
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        results.apifyUser = (data as { data?: { username?: string } }).data?.username || 'unknown'
        results.apifyResponse = 'SUCCESS'
      } else {
        results.apifyError = await res.text()
      }
    } catch (fetchError) {
      results.fetchError = fetchError instanceof Error ? fetchError.message : String(fetchError)
    }
  }

  // Test actual scrape if ?test=username is provided
  const testUsername = request.nextUrl.searchParams.get('test')
  const testPlatform = (request.nextUrl.searchParams.get('platform') || 'INSTAGRAM') as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

  if (testUsername && isApifyConfigured()) {
    const startTime = Date.now()
    try {
      console.log(`[Debug] Testing scrape for ${testUsername} on ${testPlatform}`)
      const scraped = await scrapeProfile(testUsername, testPlatform)
      const elapsed = Date.now() - startTime
      results.scrapeTest = {
        success: !!scraped,
        elapsedMs: elapsed,
        username: scraped?.username,
        followers: scraped?.followers,
        engagementRate: scraped?.engagementRate,
        postsFound: scraped?.recentPosts?.length || 0,
      }
    } catch (scrapeError) {
      const elapsed = Date.now() - startTime
      results.scrapeTest = {
        success: false,
        elapsedMs: elapsed,
        error: scrapeError instanceof Error ? scrapeError.message : String(scrapeError),
        stack: scrapeError instanceof Error ? scrapeError.stack : undefined,
      }
    }
  }

  return NextResponse.json(results)
}
