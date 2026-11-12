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

/**
 * The schedulers tick on exact multiples of their interval while the stamp is
 * written a few hundred ms into the run, so a tick landing exactly one
 * interval later arrived a moment BEFORE the gate opened and was skipped:
 * the 12 h stories scan then waited for the following tick (16 to 24 h, and
 * stories die at 24 h). The gate opens this much early to absorb that drift.
 */
export const GATE_SLACK_MS = 10 * 60 * 1000

/**
 * `slackMs` is opt-in (default 0): only a cron whose cadence must not drift
 * passes GATE_SLACK_MS. The crons that stamp at the END of their run keep
 * their long-standing real cadence (and Apify spend) untouched.
 */
export async function cronGate(name: string, defaultHours: number, force = false, slackMs = 0): Promise<CronGate> {
  const minHours = cronMinHours(name, defaultHours)
  const row = await prisma.setting.findUnique({ where: { key: key(name) } }).catch(() => null)
  const lastAt = row?.value ? Date.parse(row.value) : NaN
  const lastRunAt = Number.isFinite(lastAt) ? new Date(lastAt).toISOString() : null
  const nextAllowedAt = Number.isFinite(lastAt) ? new Date(lastAt + minHours * 3_600_000).toISOString() : null
  const tooSoon = Number.isFinite(lastAt) && Date.now() - lastAt < minHours * 3_600_000 - Math.max(0, slackMs)
  return { allowed: force || !tooSoon, lastRunAt, nextAllowedAt, minHours }
}

export async function markCronRun(name: string): Promise<void> {
  const value = new Date().toISOString()
  await prisma.setting.upsert({ where: { key: key(name) }, update: { value }, create: { key: key(name), value } }).catch(() => {})
}

/**
 * Undo a markCronRun when the run it announced could not actually be done
 * (for example Apify rejected the token): put back the previous stamp, or
 * remove it if there was none, so the next tick retries instead of waiting a
 * whole interval behind a run that never happened. Never throws.
 */
export async function restoreCronRun(name: string, previousRunAt: string | null): Promise<void> {
  try {
    if (previousRunAt) {
      await prisma.setting.upsert({ where: { key: key(name) }, update: { value: previousRunAt }, create: { key: key(name), value: previousRunAt } })
    } else {
      await prisma.setting.deleteMany({ where: { key: key(name) } })
    }
  } catch (err) {
    console.error(`[cron-throttle] could not restore the ${name} stamp:`, err instanceof Error ? err.message : err)
  }
}

function failedKey(name: string): string {
  return `cron_${name}_last_failed`
}

/** Remember that a run just failed (a failed run may have charged money). Never throws. */
export async function markCronFailed(name: string): Promise<void> {
  const value = new Date().toISOString()
  await prisma.setting.upsert({ where: { key: failedKey(name) }, update: { value }, create: { key: failedKey(name), value } }).catch(() => {})
}

/**
 * Retry floor after a failed run: with the stamp restored the gate is open
 * again at once, and several schedulers tick independently, so without this
 * a failing (and possibly charged) run would be repeated by every tick.
 * Returns the ISO time of the failed attempt while it is younger than
 * `floorMs`, else null. Never throws (unknown = no floor).
 */
export async function cronFailedRecently(name: string, floorMs: number): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: failedKey(name) } })
    const at = row?.value ? Date.parse(row.value) : NaN
    return Number.isFinite(at) && Date.now() - at < floorMs ? new Date(at).toISOString() : null
  } catch {
    return null
  }
}

/** Standard JSON body for a throttled call. */
export function cronSkipped(name: string, gate: CronGate, extra: Record<string, unknown> = {}) {
  return { skipped: 'too_soon', cron: name, lastRunAt: gate.lastRunAt, nextAllowedAt: gate.nextAllowedAt, minHours: gate.minHours, ...extra }
}
