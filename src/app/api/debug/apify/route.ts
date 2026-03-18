import { NextResponse } from 'next/server'

export async function GET() {
  const token = process.env.APIFY_API_KEY
  const hasToken = !!token
  const tokenPreview = token ? `${token.substring(0, 12)}...${token.substring(token.length - 4)}` : 'NOT SET'

  const results: Record<string, unknown> = {
    hasToken,
    tokenPreview,
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

  return NextResponse.json(results)
}
