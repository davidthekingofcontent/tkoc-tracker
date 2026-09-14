/**
 * Server-side throttle for the cron endpoints.
 *
 * The crons are fired by an EXTERNAL scheduler we do not control from the
 * code. Every paid scrape they trigger charges Apify per actor start, so each
 * route refuses to run more often than its minimum interval, whatever the
 * caller does. State lives in the settings table (key cron_<name>_last_run),
 * so it survives redeploys. `?force=1` (with the cron secret) bypasses it.
 */

import { prisma } from '@/lib/db'

export interface CronGate {
  allowed: boolean
  lastRunAt: string | null
  nextAllowedAt: string | null
  minHours: number
}

function key(name: string): string {
  return `cron_${name}_last_run`
}

/** Hours from the env (CRON_<NAME>_MIN_HOURS) or the given default; never below 1. */
export function cronMinHours(name: string, defaultHours: number): number {
  const raw = process.env[`CRON_${name.toUpperCase().replace(/-/g, '_')}_MIN_HOURS`]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 1 ? n : defaultHours
}

export async function cronGate(name: string, defaultHours: number, force = false): Promise<CronGate> {
  const minHours = cronMinHours(name, defaultHours)
  const row = await prisma.setting.findUnique({ where: { key: key(name) } }).catch(() => null)
  const lastAt = row?.value ? Date.parse(row.value) : NaN
  const lastRunAt = Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : null
  const nextAllowedAt = Number.isFinite(lastAt) ? new Date(lastAt + minHours * 3_600_000).toISOString() : null
  const tooSoon = Number.isFinite(lastAt) && Date.now() - lastAt < minHours * 3_600_000
  return { allowed: force || !tooSoon, lastRunAt, nextAllowedAt, minHours }
}

export async function markCronRun(name: string): Promise<void> {
  const value = new Date().toISOString()
  await prisma.setting.upsert({ where: { key: key(name) }, update: { value }, create: { key: key(name), value } }).catch(() => {})
}

/** Standard JSON body for a throttled call. */
export function cronSkipped(name: string, gate: CronGate, extra: Record<string, unknown> = {}) {
  return { skipped: 'too_soon', cron: name, lastRunAt: gate.lastRunAt, nextAllowedAt: gate.nextAllowedAt, minHours: gate.minHours, ...extra }
}
