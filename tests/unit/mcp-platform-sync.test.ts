import { describe, expect, it, vi } from 'vitest'

// The tool file imports the database client; nothing here uses it
vi.mock('@/lib/db', () => ({ prisma: {} }))

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPTURE_JOBS, FAILURE_RECORDING_JOBS } from '@/lib/mcp/tools/capture-status'
import { POST_CHECK_STATUSES } from '@/lib/mcp/tools/explain-missing-post'
import { CAPTURE_ALERT_TITLES, selectCaptureAlerts } from '@/lib/mcp/tools/serializers'

/**
 * The MCP tools repeat two things that the platform decides elsewhere. These
 * tests read the platform's own source, so that a change there cannot leave
 * the connector saying something that is no longer true without a test failing:
 *
 *  - which alerts are about the capture (capture_status only shows those);
 *  - which capture jobs record their failures and which write a run stamp
 *    (capture_status says "not_recorded" for the others);
 *  - which creators the daily job reads (explain_missing_post says so).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const source = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

/** Where the platform writes the alerts of the capture. */
const ALERT_SOURCES = [
  'src/lib/notifications.ts',
  'src/app/api/cron/watchdog/route.ts',
  'src/app/api/cron/stories/route.ts',
  'src/lib/campaign-target-guard.ts',
  'src/instrumentation.ts',
]
/** Sent with the type `cron_stale`, and not about the capture: its text names a person. */
const DATA_DELETION_TITLE = 'Solicitud de borrado de datos de Meta'

const at = (iso: string) => new Date(iso)

describe('capture_status: which alerts are about the capture', () => {
  it('every title on the list is a title the platform still writes', () => {
    const code = ALERT_SOURCES.map(source).join('\n')
    expect(CAPTURE_ALERT_TITLES.length).toBeGreaterThan(0)
    for (const title of CAPTURE_ALERT_TITLES) {
      expect(code.includes(`'${title}'`), `"${title}" is no longer in the platform's code`).toBe(true)
    }
    expect(new Set(CAPTURE_ALERT_TITLES).size).toBe(CAPTURE_ALERT_TITLES.length)
  })

  it('the data-deletion request of Meta shares the alert type and is not on the list', () => {
    const route = source('src/app/api/data-deletion/route.ts')
    // The reason this list exists: if this stops being true, the comment in serializers.ts needs a new example
    expect(route).toContain("type: 'cron_stale'")
    expect(route).toContain(`'${DATA_DELETION_TITLE}'`)
    expect(CAPTURE_ALERT_TITLES).not.toContain(DATA_DELETION_TITLE)
  })

  it('shows only the alerts on the list, each once, and counts the rest without a word of them', () => {
    const rows = [
      { type: 'apify_budget', title: 'Apify ha rechazado el token', message: 'La captura automática está parada.', createdAt: at('2026-11-12T08:00:00.000Z') },
      // The same alert, as the second administrator received it a moment later
      { type: 'apify_budget', title: 'Apify ha rechazado el token', message: 'La captura automática está parada.', createdAt: at('2026-11-12T08:00:01.000Z') },
      {
        type: 'cron_stale',
        title: DATA_DELETION_TITLE,
        message: 'Meta ha enviado una solicitud de borrado de datos del usuario de Meta 10203040506070 (código de confirmación abcdef0123456789abcdef0123456789).',
        createdAt: at('2026-11-11T08:00:00.000Z'),
      },
      { type: 'cron_stale', title: 'Un aviso que todavía no existe', message: 'TEXTO-DE-UN-AVISO-DESCONOCIDO', createdAt: at('2026-11-10T08:00:00.000Z') },
      // A title that only looks like one of the list
      { type: 'cron_stale', title: 'Stories sin rastrear ', message: 'TEXTO-CASI-IGUAL', createdAt: at('2026-11-09T08:00:00.000Z') },
      { type: 'cron_stale', title: 'Stories sin rastrear', message: 'Las stories de "Campaña Inventada" no se están rastreando: no tiene objetivos.', createdAt: at('2026-11-08T08:00:00.000Z') },
    ]
    const { alerts, notShown } = selectCaptureAlerts(rows)
    expect(alerts.map(a => a.title)).toEqual(['Apify ha rechazado el token', 'Stories sin rastrear'])
    expect(notShown).toBe(3)
    const text = JSON.stringify({ alerts, notShown })
    for (const secret of ['10203040506070', 'abcdef0123456789', DATA_DELETION_TITLE, 'TEXTO-DE-UN-AVISO-DESCONOCIDO', 'TEXTO-CASI-IGUAL', 'todavía no existe']) {
      expect(text, secret).not.toContain(secret)
    }
    for (const alert of alerts) expect(Object.keys(alert)).toEqual(['type', 'title', 'message', 'at'])
    expect(selectCaptureAlerts([])).toEqual({ alerts: [], notShown: 0 })
  })

  it('cuts out of «Fallo en tarea automática» the text the failed job answered', () => {
    const excerpt = 'HTTP 500: {"error":"fetch https://api.apify.com/v2/acts?token=TOKEN-QUE-NO-DEBE-SALIR (x). Los datos "}'
    const message = `La tarea automática 'track' ha fallado 2 veces seguidas (último error: ${excerpt}). Los datos podrían no estar actualizándose.`
    const { alerts, notShown } = selectCaptureAlerts([{ type: 'cron_failure', title: 'Fallo en tarea automática', message, createdAt: at('2026-11-12T08:00:00.000Z') }])
    expect(notShown).toBe(0)
    expect(alerts).toEqual([
      {
        type: 'cron_failure',
        title: 'Fallo en tarea automática',
        message: "La tarea automática 'track' ha fallado 2 veces seguidas. Los datos podrían no estar actualizándose.",
        at: '2026-11-12T08:00:00.000Z',
      },
    ])
    // The sentence is the one src/instrumentation.ts writes: if it changes there, this must be looked at again
    const instrumentation = source('src/instrumentation.ts')
    expect(instrumentation).toContain('(último error: ${truncated}). Los datos podrían no estar actualizándose.')

    // A sentence the cut does not recognise is withheld whole, whatever the type says
    const odd = selectCaptureAlerts([
      { type: 'cron_stale', title: 'Fallo en tarea automática', message: 'Ha fallado. Último error: TOKEN-QUE-NO-DEBE-SALIR', createdAt: at('2026-11-12T09:00:00.000Z') },
    ])
    expect(odd.alerts).toEqual([{ type: 'cron_stale', title: 'Fallo en tarea automática', message: null, at: '2026-11-12T09:00:00.000Z' }])
  })
})

describe('capture_status: what the capture jobs record', () => {
  /** Every source file under a folder of the platform. */
  const filesUnder = (relative: string): string[] =>
    fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
      const child = path.join(relative, entry.name)
      return entry.isDirectory() ? filesUnder(child) : /\.tsx?$/.test(entry.name) ? [child] : []
    })
  const platformCode = () =>
    [...filesUnder('src/app'), ...filesUnder('src/lib')]
      .filter(f => !f.startsWith(path.join('src', 'lib', 'mcp')))
      .map(source)
      .join('\n')
  const namesPassedTo = (code: string, fn: string) => new Set([...code.matchAll(new RegExp(`\\b${fn}\\('([a-z-]+)'\\)`, 'g'))].map(m => m[1]))

  it('only the jobs on the list record their failures', () => {
    const code = platformCode()
    expect([...namesPassedTo(code, 'markCronFailed')].sort()).toEqual([...FAILURE_RECORDING_JOBS].sort())
    // The helper writes exactly the key capture_status reads
    expect(source('src/lib/cron-throttle.ts')).toContain('return `cron_${name}_last_failed`')
  })

  it('every capture job but the watchdog writes a run stamp, and the watchdog none', () => {
    const stamped = namesPassedTo(platformCode(), 'markCronRun')
    for (const job of CAPTURE_JOBS) expect(stamped.has(job), job).toBe(job !== 'watchdog')
    expect(source('src/lib/cron-throttle.ts')).toContain('return `cron_${name}_last_run`')
  })
})

describe('explain_missing_post: which creators the daily job reads', () => {
  it('names the same statuses as the check-posts job', () => {
    const route = source('src/app/api/cron/check-posts/route.ts')
    const lists = [...route.matchAll(/status:\s*\{\s*in:\s*\[([^\]]*)\]/g)]
      .map(m => [...m[1].matchAll(/'([A-Z_]+)'/g)].map(s => s[1]))
      // The members' statuses, not the campaign's
      .filter(list => list.includes('AGREED'))
    expect(lists).toHaveLength(1)
    expect([...lists[0]].sort()).toEqual([...POST_CHECK_STATUSES].sort())
  })
})
