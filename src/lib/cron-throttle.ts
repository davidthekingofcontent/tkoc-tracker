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
 * passes GATE_SLACK_MS (stories, 12 h; check-deletions, the daily RGPD queue,
 * which stamps at the END and ran one day in two without it, 16 Nov 2026).
 * The other crons that stamp at the END of their run keep their
 * long-standing real cadence (and Apify spend) untouched.
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

// ---------------------------------------------------------------------------
// In-flight lock (16 Nov 2026). The gate alone does not stop a SECOND call that
// arrives while a run is still working: on 15 Nov the internal scheduler's one
// fetch to check-posts reached the server as two requests (the client gave up
// at undici's 5 min headers timeout and retried) and both ran the whole cron in
// parallel, paying Apify twice for 75 creators. The lock is a settings row
// (`cron_<name>_inflight` = ISO time the holder took it, or last renewed it:
// see renewCronLock) so it survives redeploys and is shared by every instance;
// a run that dies without releasing it (a redeploy mid-run) leaves it behind,
// which is why a holder silent for longer than CRON_LOCK_TTL_MS is taken over.
// Advisory locks were not an option: Prisma pools connections and a 30-40 min
// run is never one transaction.
// ---------------------------------------------------------------------------

/** A holder silent (no take, no renewal) for longer than this is dead: its lock is taken over by the next call. */
export const CRON_LOCK_TTL_MS = 60 * 60 * 1000

export interface CronLock {
  name: string
  /** The value written in the settings row: the ISO time this holder took the lock or last renewed it. Only its owner releases it. */
  token: string
}

function lockKey(name: string): string {
  return `cron_${name}_inflight`
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * Take the in-flight lock of a cron, or null when another call holds it and
 * took it less than `ttlMs` ago. Atomic: the row is created (unique key) or,
 * when it exists, updated with a single conditional UPDATE that only one of
 * two simultaneous callers can win. A database error other than "already
 * exists" is thrown: a cron that cannot read its lock must not run blind.
 */
export async function acquireCronLock(name: string, ttlMs = CRON_LOCK_TTL_MS): Promise<CronLock | null> {
  const k = lockKey(name)
  const token = new Date().toISOString()
  try {
    await prisma.setting.create({ data: { key: k, value: token } })
    return { name, token }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }
  // Held by somebody: take it over only when that holder has been silent (no
  // take, no renewal) for longer than the TTL (ISO strings of equal length
  // compare in time order). Said out loud in the log: a takeover means a run
  // died without releasing, or a live run went longer than the TTL without a
  // heartbeat, and the Monday review should see it.
  const stale = await prisma.setting.findUnique({ where: { key: k }, select: { value: true } }).catch(() => null)
  const cutoff = new Date(Date.now() - ttlMs).toISOString()
  const taken = await prisma.setting.updateMany({ where: { key: k, value: { lt: cutoff } }, data: { value: token } })
  if (taken.count !== 1) return null
  console.warn(`[cron-throttle] ${name}: lock taken over from a run last alive at ${stale?.value ?? 'unknown'} (silent for more than ${Math.round(ttlMs / 60_000)} min, presumed dead)`)
  return { name, token }
}

/** Release a lock this call took. Only its own token is removed: a lock taken over by a later call is left alone. Never throws. */
export async function releaseCronLock(lock: CronLock | null | undefined): Promise<void> {
  if (!lock) return
  await prisma.setting.deleteMany({ where: { key: lockKey(lock.name), value: lock.token } }).catch(err => {
    console.error(`[cron-throttle] could not release the ${lock.name} lock:`, err instanceof Error ? err.message : err)
  })
}

/**
 * Heartbeat of the run that holds the lock (18 Nov 2026). A run longer than
 * CRON_LOCK_TTL_MS (check-posts took 37 min for 175 creators on 16 Nov; twice
 * the creators or a slow Apify passes the hour) looked dead to the next caller,
 * which took the lock over and ran in parallel with it: the very double run
 * the lock exists to stop. The holder refreshes its time every so often
 * (check-posts: every few creators; track: every campaign and every scrape),
 * and `lock.token` follows the row so the release still matches. Returns
 * false, without throwing, when the row is gone or was taken over: the run
 * keeps going (its work is paid for) and the log says another may be running.
 */
export async function renewCronLock(lock: CronLock | null | undefined): Promise<boolean> {
  if (!lock) return false
  const token = new Date().toISOString()
  if (token <= lock.token) return true
  try {
    const renewed = await prisma.setting.updateMany({ where: { key: lockKey(lock.name), value: lock.token }, data: { value: token } })
    if (renewed.count === 1) {
      lock.token = token
      return true
    }
    console.error(`[cron-throttle] ${lock.name}: the lock taken at ${lock.token} is no longer this run's (released or taken over): this run finishes its work, but another may be running too`)
    return false
  } catch (err) {
    console.error(`[cron-throttle] could not renew the ${lock.name} lock:`, err instanceof Error ? err.message : err)
    return false
  }
}

/** ISO time the run holding the lock took it or last renewed it (its last sign of life), or null when nobody holds it. Never throws. */
export async function cronLockHeldSince(name: string): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: lockKey(name) } })
    const at = row?.value ? Date.parse(row.value) : NaN
    return Number.isFinite(at) ? new Date(at).toISOString() : null
  } catch {
    return null
  }
}

/** Standard JSON body for a call refused because a run is still in flight. */
export function cronInFlight(name: string, since: string | null, extra: Record<string, unknown> = {}) {
  return { skipped: 'in_flight', cron: name, since, ...extra }
}
