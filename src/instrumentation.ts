const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000

async function executeTracking() {
  try {
    console.log('[TKOC Auto-Tracker] Starting scheduled tracking run...')
    const { runCronTracking } = await import('./app/api/cron/track/route')
    const results = await runCronTracking()
    console.log('[TKOC Auto-Tracker] Tracking completed:', JSON.stringify(results))
  } catch (error) {
    console.error('[TKOC Auto-Tracker] Tracking failed:', error instanceof Error ? error.message : error)
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NODE_ENV !== 'production') return

  console.log('[TKOC Auto-Tracker] Registering auto-tracking instrumentation')

  // Initial catch-up run 5 minutes after server start
  setTimeout(() => {
    console.log('[TKOC Auto-Tracker] Running initial catch-up tracking')
    executeTracking()
  }, FIVE_MINUTES_MS)

  // Recurring run every 4 hours (dedup logic in runCronTracking prevents duplicate scrapes)
  setInterval(() => {
    executeTracking()
  }, FOUR_HOURS_MS)

  console.log('[TKOC Auto-Tracker] Scheduled: initial run in 5 min, then every 4 hours')
}
