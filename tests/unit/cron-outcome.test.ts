/**
 * src/lib/cron-outcome.ts: what the internal scheduler concludes from one call
 * to a cron route (review of 16 Nov 2026). Pure, no network.
 *
 *  - a 200 whose body says `skipped` (too_soon, in_flight...) is neither a
 *    success nor a failure: the failure streak must not be reset by a gate;
 *  - a long route (check-posts, track) the client stopped waiting for, once it
 *    had connected, is "started", not "fetch failed";
 *  - a fast transport error, or any error of a short route, is still a failure.
 */
import { describe, expect, it } from 'vitest'
import {
  CONNECTED_AFTER_MS,
  CRON_FAILURE_ALERT_AFTER,
  LONG_RUNNING_CRONS,
  LONG_RUNNING_CRON_WAIT_MS,
  applyCronOutcome,
  classifyCronOutcome,
  isTimeoutError,
  skippedCodeOf,
  type CronOutcome,
  type CronStreakState,
} from '@/lib/cron-outcome'

const response = (status: number, body: unknown) => ({ kind: 'response' as const, status, body: typeof body === 'string' ? body : JSON.stringify(body) })
const failure = (error: unknown, elapsedMs: number, longRunning: boolean) => ({ kind: 'error' as const, error, elapsedMs, longRunning })
const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const undiciHeadersTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT', name: 'HeadersTimeoutError' }) })
const connectionRefused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })

describe('the long routes and how long the scheduler waits for them', () => {
  it('check-posts and track are long running; stories, watchdog and the others are not', () => {
    expect([...LONG_RUNNING_CRONS].sort()).toEqual(['check-posts', 'track'])
  })

  it('the wait is at least a minute and shorter than undici’s 5 min headers timeout, so the cut is ours and no retried GET runs the cron twice', () => {
    expect(LONG_RUNNING_CRON_WAIT_MS).toBeGreaterThanOrEqual(60_000)
    expect(LONG_RUNNING_CRON_WAIT_MS).toBeLessThan(5 * 60_000)
    expect(CONNECTED_AFTER_MS).toBeLessThan(LONG_RUNNING_CRON_WAIT_MS)
  })
})

describe('responses', () => {
  it('a 2xx with a real body is a completed run', () => {
    expect(classifyCronOutcome(response(200, { success: true, newPosts: 3 }))).toBe('completed')
    expect(classifyCronOutcome(response(200, { message: 'No active campaigns', newPosts: 0 }))).toBe('completed')
    expect(classifyCronOutcome(response(200, 'ok'))).toBe('completed')
    expect(classifyCronOutcome(response(200, ''))).toBe('completed')
  })

  it('a 2xx whose body says skipped (too_soon, in_flight, apify_budget, recent_failure) is skipped: nothing ran', () => {
    for (const skipped of ['too_soon', 'in_flight', 'apify_budget', 'recent_failure']) {
      expect(classifyCronOutcome(response(200, { skipped, cron: 'check-posts' })), skipped).toBe('skipped')
    }
  })

  it('any status from 400 up is a failure, whatever the body says', () => {
    expect(classifyCronOutcome(response(401, { error: 'Unauthorized' }))).toBe('failed')
    expect(classifyCronOutcome(response(500, { error: 'Internal server error' }))).toBe('failed')
    expect(classifyCronOutcome(response(503, { error: 'Apify rejects the token', skipped: 'apify_token' }))).toBe('failed')
  })

  it('skippedCodeOf reads only a string `skipped` of a JSON object', () => {
    expect(skippedCodeOf('{"skipped":"too_soon"}')).toBe('too_soon')
    expect(skippedCodeOf('{"skipped":""}')).toBeNull()
    expect(skippedCodeOf('{"skipped":true}')).toBeNull()
    expect(skippedCodeOf('[{"skipped":"x"}]')).toBeNull()
    expect(skippedCodeOf('not json')).toBeNull()
    expect(skippedCodeOf('')).toBeNull()
  })
})

describe('transport errors', () => {
  it('a long route cut by our own AbortSignal.timeout has started: the server keeps running it', () => {
    expect(classifyCronOutcome(failure(timeoutError(), LONG_RUNNING_CRON_WAIT_MS, true))).toBe('started')
  })

  it('a long route cut by undici’s headers timeout (the 15 Nov 2026 "fetch failed") has started too', () => {
    expect(classifyCronOutcome(failure(undiciHeadersTimeout(), 300_000, true))).toBe('started')
  })

  it('a long route that fails fast (connection refused, DNS) is a failure: it never connected', () => {
    expect(classifyCronOutcome(failure(connectionRefused(), 40, true))).toBe('failed')
    expect(classifyCronOutcome(failure(new TypeError('fetch failed'), 1_000, true))).toBe('failed')
  })

  it('a long route whose connection dropped long after it was accepted counts as started, whatever the error says', () => {
    expect(classifyCronOutcome(failure(new TypeError('fetch failed'), CONNECTED_AFTER_MS, true))).toBe('started')
    expect(classifyCronOutcome(failure(new Error('socket hang up'), 159_600, true))).toBe('started')
  })

  it('a short route (stories, watchdog, meta-sync) that errors is always a failure, even on a timeout', () => {
    expect(classifyCronOutcome(failure(timeoutError(), 300_000, false))).toBe('failed')
    expect(classifyCronOutcome(failure(undiciHeadersTimeout(), 300_000, false))).toBe('failed')
    expect(classifyCronOutcome(failure(connectionRefused(), 40, false))).toBe('failed')
  })

  it('isTimeoutError recognises the timeout shapes and nothing else', () => {
    expect(isTimeoutError(timeoutError())).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true)
    expect(isTimeoutError(undiciHeadersTimeout())).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(true)
    expect(isTimeoutError(connectionRefused())).toBe(false)
    expect(isTimeoutError(new Error('boom'))).toBe(false)
    expect(isTimeoutError('fetch failed')).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
  })
})

/**
 * The failure streak of one job (applyCronOutcome), as the scheduler drives
 * it. Review of 18 Nov 2026: check-posts and track (30-40 min) always end as
 * 'started' for the scheduler, and with only 'completed' closing the streak
 * the two jobs stayed mute after their first alert until the next redeploy.
 */
describe('the failure streak', () => {
  const fresh = (): CronStreakState => ({ consecutiveFailures: 0, alerted: false })
  const run = (state: CronStreakState, ...outcomes: CronOutcome[]) => outcomes.map(o => applyCronOutcome(state, o))

  it('alerts once at the second consecutive failure, and not again while the streak lasts', () => {
    expect(CRON_FAILURE_ALERT_AFTER).toBe(2)
    const state = fresh()
    expect(run(state, 'failed', 'failed', 'failed', 'failed')).toEqual([null, 'failure', null, null])
    expect(state).toEqual({ consecutiveFailures: 4, alerted: true })
  })

  it('a completed run closes the streak and, after an alert, asks for the recovery notice', () => {
    const state = fresh()
    expect(run(state, 'failed', 'failed', 'completed')).toEqual([null, 'failure', 'recovered'])
    expect(state).toEqual({ consecutiveFailures: 0, alerted: false })
    // No alert was sent: nothing to recover from
    expect(run(fresh(), 'failed', 'completed')).toEqual([null, null])
  })

  it("a long route the scheduler stopped waiting for ('started') is a real run: it closes the streak like 'completed'", () => {
    // The production sequence: 503 apify_token twice (alert), the token is fixed and the next
    // run is 'started'; a month later a real 500 twice must alert AGAIN
    const state = fresh()
    expect(run(state, 'failed', 'failed')).toEqual([null, 'failure'])
    expect(applyCronOutcome(state, 'started')).toBe('recovered')
    expect(state).toEqual({ consecutiveFailures: 0, alerted: false })
    expect(run(state, 'failed', 'failed')).toEqual([null, 'failure'])
    // And without a previous alert, 'started' is silent
    expect(run(fresh(), 'failed', 'started')).toEqual([null, null])
  })

  it("a skipped call (too_soon, in_flight, a budget pause) neither extends nor resets the streak", () => {
    const state = fresh()
    expect(run(state, 'failed', 'skipped', 'skipped')).toEqual([null, null, null])
    expect(state).toEqual({ consecutiveFailures: 1, alerted: false })
    // The second real failure, after any number of skips, is what alerts
    expect(applyCronOutcome(state, 'failed')).toBe('failure')
    expect(run(state, 'skipped')).toEqual([null])
    expect(state).toEqual({ consecutiveFailures: 2, alerted: true })
  })
})
