import type { Prisma } from '@/generated/prisma/client'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000

interface CronJob {
  name: string
  path: string
  intervalMs: number
  /** Initial delay before first run (ms) */
  initialDelayMs: number
  /** Auth style: 'bearer' uses Authorization: Bearer, 'header' uses x-cron-secret */
  auth: 'bearer' | 'header'
  /** HTTP method override (defaults to GET) */
  method?: 'GET' | 'POST'
}

// Cron cadence optimized to reduce Apify cost:
// - discovery reduced from 1h → 12h (was the biggest cost center)
// - track reduced from 2h → 6h (Apify-based; Meta API sync via meta-sync runs 4h)
// - stories reduced from 4h → 6h (24h expiry means 4x/day is enough)
// - live-capture-enrich reduced from 30min → 4h (was scraping every 30min on empty queues)
// - meta-sync increased frequency 6h → 4h (free via Meta API, no cost concern)
const CRON_JOBS: CronJob[] = [
  { name: 'track',            path: '/api/cron/track',            intervalMs: SIX_HOURS_MS,    initialDelayMs: FIVE_MINUTES_MS,      auth: 'bearer' },
  { name: 'discovery',        path: '/api/cron/discovery',        intervalMs: TWELVE_HOURS_MS, initialDelayMs: 10 * 60 * 1000,       auth: 'header' },
  { name: 'stories',          path: '/api/cron/stories',          intervalMs: SIX_HOURS_MS,    initialDelayMs: 15 * 60 * 1000,       auth: 'header' },
  { name: 'check-posts',      path: '/api/cron/check-posts',      intervalMs: TWELVE_HOURS_MS, initialDelayMs: 20 * 60 * 1000,       auth: 'header' },
  { name: 'check-deletions',  path: '/api/cron/check-deletions',  intervalMs: TWENTY_FOUR_HOURS_MS, initialDelayMs: 25 * 60 * 1000,  auth: 'bearer' },
  { name: 'live-capture-enrich', path: '/api/live-capture/enrich', intervalMs: FOUR_HOURS_MS,   initialDelayMs: 8 * 60 * 1000,        auth: 'header', method: 'POST' },
  { name: 'meta-sync',          path: '/api/cron/meta-sync',          intervalMs: FOUR_HOURS_MS,       initialDelayMs: 12 * 60 * 1000, auth: 'header' },
  { name: 'meta-token-refresh', path: '/api/cron/meta-token-refresh', intervalMs: TWENTY_FOUR_HOURS_MS, initialDelayMs: 30 * 60 * 1000, auth: 'header' },
]

// Per-job failure tracking. State is per-process and resets on every deploy/restart — acceptable.
interface CronJobState {
  consecutiveFailures: number
  alerted: boolean
}

const cronJobStates = new Map<string, CronJobState>()

function getJobState(name: string): CronJobState {
  let state = cronJobStates.get(name)
  if (!state) {
    state = { consecutiveFailures: 0, alerted: false }
    cronJobStates.set(name, state)
  }
  return state
}

/**
 * Create a Notification for every active ADMIN user.
 * Prisma is imported lazily: '@/lib/db' opens a pg Pool at module import time,
 * and we don't want that side effect at build/registration time.
 * Must NEVER throw — alerting failures cannot break the cron loop.
 */
async function notifyAdmins(notification: { type: string; title: string; message: string; metadata?: Prisma.InputJsonValue }) {
  try {
    const { prisma } = await import('@/lib/db')
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true },
      select: { id: true },
    })
    if (admins.length === 0) return
    await prisma.notification.createMany({
      data: admins.map((admin) => ({
        userId: admin.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        metadata: notification.metadata ?? undefined,
      })),
    })
  } catch (error) {
    console.error('[TKOC Cron] Failed to create admin notifications:', error instanceof Error ? error.message : error)
  }
}

async function handleCronFailure(job: CronJob, errorDetail: string) {
  const state = getJobState(job.name)
  state.consecutiveFailures++

  if (state.consecutiveFailures >= 2 && !state.alerted) {
    state.alerted = true // fire once per failure streak
    const truncated = errorDetail.substring(0, 120)
    await notifyAdmins({
      type: 'cron_failure',
      title: 'Fallo en tarea automática',
      message: `La tarea automática '${job.name}' ha fallado ${state.consecutiveFailures} veces seguidas (último error: ${truncated}). Los datos podrían no estar actualizándose.`,
      metadata: { jobName: job.name, consecutiveFailures: state.consecutiveFailures, lastError: truncated },
    })
  }
}

async function handleCronSuccess(job: CronJob) {
  const state = getJobState(job.name)
  const wasAlerted = state.alerted
  state.consecutiveFailures = 0
  state.alerted = false

  if (wasAlerted) {
    await notifyAdmins({
      type: 'cron_recovered',
      title: 'Tarea automática recuperada',
      message: `La tarea '${job.name}' se ha recuperado y vuelve a funcionar.`,
      metadata: { jobName: job.name },
    })
  }
}

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
    const res = await fetch(`${baseUrl}${job.path}`, {
      method: job.method || 'GET',
      headers: {
        ...headers,
        ...(job.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(job.method === 'POST' ? { body: '{}' } : {}),
    })
    const text = await res.text()
    console.log(`[TKOC Cron] ${job.name} completed (${res.status}):`, text.substring(0, 300))

    if (res.status >= 400) {
      await handleCronFailure(job, `HTTP ${res.status}: ${text.substring(0, 100)}`)
    } else {
      await handleCronSuccess(job)
    }
  } catch (error) {
    console.error(`[TKOC Cron] ${job.name} failed:`, error instanceof Error ? error.message : error)
    await handleCronFailure(job, error instanceof Error ? error.message : String(error))
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
