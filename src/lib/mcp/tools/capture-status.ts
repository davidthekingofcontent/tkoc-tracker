/**
 * capture_status: is the automatic capture of the platform working?
 *
 * It reads three things and changes none of the platform's data:
 *  - the stamps the capture jobs leave in the `settings` table
 *    (`cron_<job>_last_run`, and `cron_stories_last_failed`: no other job
 *    records its failures) and the two stored summaries
 *    (`cron_stories_last_result`, `cron_tiktok-link_last_result`). Only those
 *    exact keys are read: the table also holds secrets. A run stamp is not
 *    proof that a run completed: JOB_RUN_STAMP says when each job writes it;
 *  - Apify, through the platform's own helpers (src/lib/apify.ts): whether
 *    the token is accepted and which percentage of the monthly plan is used.
 *    Amounts are never returned (PMs and clients never see Apify prices);
 *  - the alerts about the capture that the platform sent to the
 *    administrators in the last 7 days. The alert types are shared with
 *    alerts that are not about the capture (a data-deletion request, for
 *    one): those are counted and never shown (selectCaptureAlerts).
 *
 * Side effects, both the platform's own and not new: checkApifyAuth and
 * getApifyBudget ask Apify at most every 5 and 15 minutes (cached), and when
 * Apify rejects the token the platform alerts the administrators once a day.
 */
import { prisma } from '@/lib/db'
import { checkApifyAuth, getApifyBudget, getApifyResumeDate, isApifyExhausted } from '@/lib/apify'
import {
  selectCaptureAlerts,
  serializeApify,
  serializeCaptureJob,
  serializeStoriesResult,
  serializeTikTokLinkResult,
} from './serializers'
import { defineTool, listEnvelope } from './shared'

/** The capture jobs, in the order they are reported. */
export const CAPTURE_JOBS = ['stories', 'track', 'check-posts', 'tiktok-link', 'watchdog'] as const

/**
 * The only jobs that write `cron_<job>_last_failed` (markCronFailed of
 * src/lib/cron-throttle.ts). For the others a failure is not recorded
 * anywhere but in the alerts. tests/unit/mcp-platform-sync.test.ts fails when
 * the platform's code starts or stops recording a job's failures.
 */
export const FAILURE_RECORDING_JOBS: readonly (typeof CAPTURE_JOBS)[number][] = ['stories']

/**
 * When each job writes its run stamp (`cron_<job>_last_run`), read from the
 * route of each job under src/app/api/cron. It is the gate that keeps a job
 * from running too often, not a record of completed runs, and it means
 * something else for each job.
 */
const JOB_RUN_STAMP: Record<(typeof CAPTURE_JOBS)[number], string> = {
  stories:
    'Written when a scan starts (also when there was nothing to scan), and put back to the previous value when the ' +
    'scan fails. A scan cut off by a restart keeps it although nothing was read: check storiesLastResult.',
  track:
    'Written when a run ends, also when it was cut short or failed after reading at least one brand hashtag or ' +
    'account. Not written when Apify rejected the token.',
  'check-posts': 'Written when a run ends, also when it failed after reading at least one creator.',
  'tiktok-link': 'Written when a full pass ends in which the reading service answered, also when the pass was partial.',
  watchdog: 'Never written: the watchdog does not record its runs.',
}

/** What each job does, for the model. */
const JOB_PURPOSE: Record<(typeof CAPTURE_JOBS)[number], string> = {
  stories: 'Reads the Instagram stories of the confirmed creators of live campaigns. Meant to complete every 12 hours.',
  track: 'Captures publications by brand hashtag and brand mention. Meant to complete once a day.',
  'check-posts': 'Reads the new publications of the confirmed creators of each active campaign. Meant to complete once a day.',
  'tiktok-link': 'Links the TikTok account of confirmed Instagram creators in campaigns that include TikTok. Meant to complete once a day.',
  watchdog:
    'Checks every 6 hours that the other jobs are completing and alerts the administrators when one is not. It does not record its own runs: look at the alerts instead.',
}

/** Alert types the capture uses. Other alerts use them too: selectCaptureAlerts keeps the ones about the capture. */
const ALERT_TYPES = ['apify_budget', 'cron_stale', 'cron_failure']
const ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const ALERTS_SHOWN = 50
const ALERT_ROWS_READ = 500

export const captureStatus = defineTool({
  name: 'capture_status',
  title: 'Ver el estado de la captura',
  description:
    'Reports whether the automatic capture of the platform is working. For each capture job (stories, track, ' +
    'check-posts, tiktok-link, watchdog): when it last wrote its run stamp and how many hours ago. The run stamp is ' +
    'NOT proof that a run completed: stories writes it when a scan starts (and removes it if the scan fails), and ' +
    'track and check-posts also stamp runs that were cut short; runStampMeans says what it means for each job. ' +
    'Only stories records its failures (lastFailedAt); for the other jobs lastFailedAt is not_recorded and a ' +
    'failure only shows in the alerts. ' +
    'For stories and tiktok-link also the summary of the last run (creators read, new stories, campaigns scanned, ' +
    'campaigns left out and why: listening, no_targets or too_long). For Apify, the service that reads the ' +
    'networks: whether its token is accepted (ok, rejected or unknown), whether the monthly limit was reached, ' +
    'the percentage of the plan used and whether the budget paused the capture (never an amount). And the alerts ' +
    'sent to the administrators in the last 7 days about the capture; other alerts of the same kind are only ' +
    'counted (otherAlertsNotShown) and are read in the notifications of the platform. Takes no arguments. ' +
    'Use it first when someone says that stories or publications are not coming in.',
  input: {},
  summarize: () => ({}),
  async run() {
    const now = new Date()
    const settingKeys = [
      ...CAPTURE_JOBS.map(job => `cron_${job}_last_run`),
      ...FAILURE_RECORDING_JOBS.map(job => `cron_${job}_last_failed`),
      'cron_stories_last_result',
      'cron_tiktok-link_last_result',
    ]
    const [settings, admins, auth, budget] = await Promise.all([
      prisma.setting.findMany({ where: { key: { in: settingKeys } }, select: { key: true, value: true } }),
      prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } }),
      checkApifyAuth(),
      getApifyBudget(),
    ])
    const setting = new Map(settings.map(s => [s.key, s.value]))

    // One alert reaches every administrator as its own row: they are shown once
    const alertRows = admins.length
      ? await prisma.notification.findMany({
          where: {
            userId: { in: admins.map(a => a.id) },
            type: { in: ALERT_TYPES },
            createdAt: { gte: new Date(now.getTime() - ALERT_WINDOW_MS) },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: ALERT_ROWS_READ,
          select: { type: true, title: true, message: true, createdAt: true },
        })
      : []
    const { alerts, notShown } = selectCaptureAlerts(alertRows)

    return {
      checkedAt: now.toISOString(),
      jobs: CAPTURE_JOBS.map(job => ({
        ...serializeCaptureJob(
          job,
          setting.get(`cron_${job}_last_run`),
          setting.get(`cron_${job}_last_failed`),
          now,
          FAILURE_RECORDING_JOBS.includes(job),
        ),
        runStampMeans: JOB_RUN_STAMP[job],
        purpose: JOB_PURPOSE[job],
      })),
      storiesLastResult: serializeStoriesResult(setting.get('cron_stories_last_result')),
      tiktokLinkLastResult: serializeTikTokLinkResult(setting.get('cron_tiktok-link_last_result')),
      apify: serializeApify({ auth, exhausted: isApifyExhausted(), resumesAt: getApifyResumeDate(), budget }),
      alertsLast7Days: listEnvelope(
        alerts.slice(0, ALERTS_SHOWN),
        alerts.length,
        ALERTS_SHOWN,
        'Only the 50 most recent alerts are listed.',
      ),
      // Alerts of the same types that are not about the capture: a number, nothing of their text
      otherAlertsNotShown: notShown,
    }
  },
})
