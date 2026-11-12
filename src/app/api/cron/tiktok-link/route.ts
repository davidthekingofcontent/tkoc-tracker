import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { checkApifyAuth, isApifyConfiguredAsync, isApifyExhausted, isApifyOverCoreReserve } from '@/lib/apify'
import { cronGate, cronSkipped, markCronRun } from '@/lib/cron-throttle'
import { notifyApifyBudgetPauseOnce, notifyApifyTokenRejectedOnce } from '@/lib/notifications'
import { runTikTokAutolink } from '@/lib/tiktok-autolink'

/**
 * GET /api/cron/tiktok-link (header x-cron-secret) — TikTok auto-link, once a
 * day (12 h ticks, 20 h gate: a 24 h gate would skip the tick that lands on it).
 *
 * Links the TikTok account of confirmed Instagram members of live campaigns
 * that include TikTok, when it publishes the campaign's content (see
 * src/lib/tiktok-autolink.ts). CORE capture: runs until 95 % of the Apify
 * plan; a pause alerts the ADMINs (shared with the posts capture alert). The
 * watchdog reads the stamp written here, so a run with nothing to do stamps too.
 *
 * ?force=1 skips the throttle and the budget gate; ?campaign=<id> limits the
 * pass to one campaign (support use): such a run is NOT the daily run — it
 * neither stamps the cron nor replaces the summary of the last full pass.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    if (!(await isApifyConfiguredAsync())) {
      return NextResponse.json({ error: 'Apify not configured' }, { status: 400 })
    }
    if (isApifyExhausted()) {
      return NextResponse.json({ skipped: 'apify_exhausted', cron: 'tiktok-link' })
    }
    const force = request.nextUrl.searchParams.get('force') === '1'
    const campaignId = request.nextUrl.searchParams.get('campaign') || undefined
    if (!campaignId) {
      const gate = await cronGate('tiktok-link', Number(process.env.TIKTOK_LINK_MIN_INTERVAL_HOURS || 20), force)
      if (!gate.allowed) {
        return NextResponse.json(cronSkipped('tiktok-link', gate))
      }
    } else if (!force) {
      return NextResponse.json({ error: 'A single-campaign run needs force=1' }, { status: 400 })
    }
    const budget = await isApifyOverCoreReserve()
    if (budget.over && !force) {
      console.log(`[Cron/TikTokLink] Skipped: Apify usage at ${budget.usedPct} % of the plan`)
      await notifyApifyBudgetPauseOnce('track', { usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt })
      return NextResponse.json({ skipped: 'apify_budget', cron: 'tiktok-link', usedPct: budget.usedPct, cycleEndsAt: budget.cycleEndsAt })
    }
    // Rejected token: nothing can be read. Not run, not stamped, ADMINs told.
    if ((await checkApifyAuth(true)) === 'rejected') {
      console.error('[Cron/TikTokLink] NOT RUN: Apify rejects the token (401). Replace APIFY_API_KEY; the next tick retries.')
      await notifyApifyTokenRejectedOnce()
      return NextResponse.json({ error: 'Apify rejects the token', skipped: 'apify_token', cron: 'tiktok-link' }, { status: 503 })
    }

    const summary = await runTikTokAutolink({ campaignId })
    console.log(`[Cron/TikTokLink] Done. Campaigns: ${summary.campaigns.length}, handles scanned: ${summary.handlesScanned}, linked: ${summary.linked}, videos: ${summary.videos}, not linked or not read (profile of another person, brand account): ${summary.notLinked.length}, failed: ${summary.failed.length}${summary.partial ? ' (PARTIAL)' : ''}${summary.skipped ? ` (skipped: ${summary.skipped})` : ''}`)

    // A completed full pass — also one with nothing to scan — is a completed
    // pass. One in which the actor answered for nobody is not: the next tick
    // retries and the watchdog sees the gap.
    const answeredNothing = summary.handlesScanned > 0 && summary.answered === 0
    if (!campaignId && summary.skipped !== 'error' && !answeredNothing) await markCronRun('tiktok-link')
    try {
      const value = JSON.stringify(summary)
      const key = campaignId ? 'cron_tiktok-link_last_result_campaign' : 'cron_tiktok-link_last_result'
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      })
    } catch (err) {
      console.error('[Cron/TikTokLink] could not record the run summary:', err instanceof Error ? err.message : err)
    }

    return NextResponse.json({ success: summary.skipped !== 'error', ...summary })
  } catch (error) {
    console.error('[Cron/TikTokLink] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
