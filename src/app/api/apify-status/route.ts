import { NextResponse } from 'next/server'
import { isApifyExhausted, getApifyResumeDate } from '@/lib/apify'

// GET /api/apify-status — public, no auth (it leaks nothing sensitive).
// Reports whether live scraping via Apify is currently available.
//
// NOTE: the circuit-breaker state lives in the memory of each server process.
// After a deploy/restart it reports { available: true } until the FIRST Apify
// call fails with the monthly-limit error, which trips the breaker for the
// rest of the usage cycle. That lag is fine and expected — the UI banners are
// best-effort hints, and the breaker itself protects every scrape path.

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    available: !isApifyExhausted(),
    resumesAt: getApifyResumeDate(),
  })
}
