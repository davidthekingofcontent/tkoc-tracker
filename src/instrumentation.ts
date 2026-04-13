const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const ONE_HOUR_MS = 1 * 60 * 60 * 1000
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000

interface CronJob {
  name: string
  path: string
  intervalMs: number
  /** Initial delay before first run (ms) */
  initialDelayMs: number
  /** Auth style: 'bearer' uses Authorization: Bearer, 'header' uses x-cron-secret */
  auth: 'bearer' | 'header'
}

const CRON_JOBS: CronJob[] = [
  { name: 'track',            path: '/api/cron/track',            intervalMs: TWO_HOURS_MS,    initialDelayMs: FIVE_MINUTES_MS,      auth: 'bearer' },
  { name: 'discovery',        path: '/api/cron/discovery',        intervalMs: ONE_HOUR_MS,     initialDelayMs: 10 * 60 * 1000,       auth: 'header' },
  { name: 'stories',          path: '/api/cron/stories',          intervalMs: FOUR_HOURS_MS,   initialDelayMs: 15 * 60 * 1000,       auth: 'header' },
  { name: 'check-posts',      path: '/api/cron/check-posts',      intervalMs: SIX_HOURS_MS,    initialDelayMs: 20 * 60 * 1000,       auth: 'header' },
  { name: 'check-deletions',  path: '/api/cron/check-deletions',  intervalMs: TWELVE_HOURS_MS, initialDelayMs: 25 * 60 * 1000,       auth: 'bearer' },
]

async function executeCron(job: CronJob) {
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL || 'http://localhost:3000'
    const baseUrl = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`
    const cronSecret = process.env.CRON_SECRET || process.env.JWT_SECRET || ''

    const headers: Record<string, string> = {}
    if (job.auth === 'bearer') {
      headers['Authorization'] = `Bearer ${cronSecret}`
    } else {
      headers['x-cron-secret'] = cronSecret
    }

    console.log(`[TKOC Cron] Running ${job.name}...`)
    const res = await fetch(`${baseUrl}${job.path}`, { headers })
    const text = await res.text()
    console.log(`[TKOC Cron] ${job.name} completed (${res.status}):`, text.substring(0, 300))
  } catch (error) {
    console.error(`[TKOC Cron] ${job.name} failed:`, error instanceof Error ? error.message : error)
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NODE_ENV !== 'production') return

  console.log('[TKOC Cron] Registering auto-scheduling instrumentation')

  for (const job of CRON_JOBS) {
    // Initial delayed run (staggered to avoid all hitting at once)
    setTimeout(() => {
      console.log(`[TKOC Cron] Running initial ${job.name}`)
      executeCron(job)
    }, job.initialDelayMs)

    // Recurring interval
    setInterval(() => {
      executeCron(job)
    }, job.intervalMs)

    console.log(`[TKOC Cron] Scheduled: ${job.name} — initial in ${Math.round(job.initialDelayMs / 60000)}min, then every ${Math.round(job.intervalMs / 3600000)}h`)
  }
}
