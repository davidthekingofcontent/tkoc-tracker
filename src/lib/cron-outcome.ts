/**
 * What the internal scheduler (src/instrumentation.ts) concludes from one call
 * to a cron route. Pure: no network, no database, so it can be tested alone.
 *
 * Born 16 Nov 2026 from two facts of production:
 *  - the fetch to check-posts (a 30-40 min route) was cut by undici's 5 min
 *    headers timeout and logged as "check-posts failed: fetch failed" although
 *    the server kept running the whole cron;
 *  - a 200 `{skipped: 'too_soon'}` counted as a success and reset the failure
 *    streak, so the 'cron_failure' alert could never fire for a route that is
 *    skipped by its own gate between two real failures.
 */

export type CronOutcome =
  /** 2xx with a real body: the run completed (or the route refused with a clear answer) */
  | 'completed'
  /** 2xx whose body says `skipped` (too_soon, in_flight, apify_budget...): nothing ran, nothing failed */
  | 'skipped'
  /** HTTP ≥ 400 or a transport error before the route answered */
  | 'failed'
  /** The client stopped waiting for a long route after it had connected: the server keeps running it */
  | 'started'

/** Crons whose route works for longer than any client should wait. */
export const LONG_RUNNING_CRONS: ReadonlySet<string> = new Set(['check-posts', 'track'])

/**
 * How long the scheduler waits for a long-running route before letting go of
 * the connection. Shorter than undici's 5 min headers timeout so the cut is
 * ours (logged as "started", not "fetch failed") and happens before the proxy
 * closes the idle connection and undici retries the GET (seen 15 Nov 2026:
 * one fetch, two requests, two runs). A refused call (401, too_soon,
 * in_flight) answers in well under a second, so it is never mistaken for a run.
 */
export const LONG_RUNNING_CRON_WAIT_MS = 2 * 60 * 1000

/** A transport error this long after the request was sent means the route had accepted it and was working. */
export const CONNECTED_AFTER_MS = 30 * 1000

/** Error codes undici uses when it gave up waiting for a server that had accepted the request. */
const TIMEOUT_CAUSE_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])

export type CronCallResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'error'; error: unknown; elapsedMs: number; longRunning: boolean }

/** True for the errors a timed-out wait produces: our own AbortSignal.timeout or undici's timeouts. */
export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const err = error as { name?: unknown; code?: unknown; cause?: unknown }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true
  if (typeof err.code === 'string' && TIMEOUT_CAUSE_CODES.has(err.code)) return true
  const cause = err.cause as { code?: unknown; name?: unknown } | undefined
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string' && TIMEOUT_CAUSE_CODES.has(cause.code)) return true
    if (cause.name === 'HeadersTimeoutError' || cause.name === 'BodyTimeoutError') return true
  }
  return false
}

/** The `skipped` code of a 2xx body, or null when the body is not a JSON object with a string `skipped`. */
export function skippedCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const skipped = (parsed as { skipped?: unknown }).skipped
    return typeof skipped === 'string' && skipped ? skipped : null
  } catch {
    return null
  }
}

export function classifyCronOutcome(result: CronCallResult): CronOutcome {
  if (result.kind === 'response') {
    if (result.status >= 400) return 'failed'
    return skippedCodeOf(result.body) ? 'skipped' : 'completed'
  }
  // A long route the client stopped waiting for, once it had clearly connected:
  // the server keeps running it (seen 15 Nov 2026: two "Done" after one "fetch
  // failed"). A fast transport error (DNS, refused connection) is a failure.
  if (result.longRunning && (isTimeoutError(result.error) || result.elapsedMs >= CONNECTED_AFTER_MS)) return 'started'
  return 'failed'
}

// ---------------------------------------------------------------------------
// The failure streak of one job (per process; resets on every deploy)
// ---------------------------------------------------------------------------

export interface CronStreakState {
  consecutiveFailures: number
  /** 'cron_failure' was sent for the current streak; cleared by the next real run */
  alerted: boolean
}

/** What the scheduler must tell the ADMINs after applying an outcome, if anything. */
export type CronStreakAlert = 'failure' | 'recovered' | null

/** Consecutive failures from which 'cron_failure' is sent (once per streak). */
export const CRON_FAILURE_ALERT_AFTER = 2

/**
 * Applies one outcome to the job's streak, mutating `state`, and says which
 * alert is due:
 *  - 'failed' extends the streak; the CRON_FAILURE_ALERT_AFTER-th failure of a
 *    streak that has not alerted yet asks for 'failure';
 *  - 'completed' AND 'started' close the streak: a route that accepted the
 *    request and is working is a real run (check-posts and track, 30-40 min,
 *    always end as 'started' for the scheduler: before 18 Nov 2026 only
 *    'completed' closed the streak, so after one alert those two jobs stayed
 *    mute until the next redeploy and 'cron_recovered' was never sent). A run
 *    that starts and dies is the watchdog's to catch;
 *  - 'skipped' (too_soon, in_flight, a budget pause) changes nothing: nothing
 *    ran, so the streak is neither extended nor reset.
 */
export function applyCronOutcome(state: CronStreakState, outcome: CronOutcome): CronStreakAlert {
  switch (outcome) {
    case 'failed':
      state.consecutiveFailures++
      if (state.consecutiveFailures >= CRON_FAILURE_ALERT_AFTER && !state.alerted) {
        state.alerted = true
        return 'failure'
      }
      return null
    case 'completed':
    case 'started': {
      const wasAlerted = state.alerted
      state.consecutiveFailures = 0
      state.alerted = false
      return wasAlerted ? 'recovered' : null
    }
    case 'skipped':
      return null
  }
}
