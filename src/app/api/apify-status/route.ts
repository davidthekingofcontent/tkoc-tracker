import { NextResponse } from 'next/server'
import { isApifyExhausted, getApifyResumeDate, getApifyBudget } from '@/lib/apify'

// GET /api/apify-status — public, no auth (it leaks nothing sensitive: no
// amounts, only booleans, a percentage of the plan and the cycle reset date).
// Reports whether live scraping via Apify is currently available and the
// state of the two budget gates (see the budget section of @/lib/apify).
//
// NOTE: the circuit-breaker state (`available`) lives in the memory of each
// server process. After a deploy/restart it reports { available: true } until
// the FIRST Apify call fails with the monthly-limit error, which trips the
// breaker for the rest of the usage cycle. That lag is fine and expected — the
// UI banners are best-effort hints, and the breaker itself protects every
// scrape path. `budget` comes from the live limits endpoint (15-min cache;
// after a failed read getApifyUsage backs off for 60 s and concurrent callers
// share one request, so this public route cannot be used to make Apify calls
// with the production token at request rate).

export const dynamic = 'force-dynamic'

export async function GET() {
  const budget = await getApifyBudget()
  return NextResponse.json({
    /** false only when the real monthly hard limit tripped the breaker */
    available: !isApifyExhausted(),
    resumesAt: getApifyResumeDate(),
    budget: {
      /** Discover paid search (and its enrichment) is paused by budget */
      optionalBlocked: budget.optionalBlocked,
      /** The stories and track crons are paused by budget (≥ 95 % of the plan) */
      coreBlocked: budget.coreBlocked,
      /** ISO instant the usage cycle ends; the pause lifts right after. null when unknown */
      cycleEndsAt: budget.cycleEndsAt,
      /** Percentage of the plan used (rounded); null when unknown */
      usedPct: budget.usedPct,
    },
  })
}
