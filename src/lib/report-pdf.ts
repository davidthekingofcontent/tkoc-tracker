import { existsSync } from 'node:fs'
import puppeteer, { type Browser } from 'puppeteer-core'

/**
 * Server-side PDF of the campaign report.
 *
 * The report is rendered by a headless Chromium (system package in the Docker
 * image, Google Chrome locally) that opens the report page of THIS deployment
 * in print mode (`?print=1`: no top bar, no edit mode, agency-only blocks
 * hidden) with the caller's own auth cookie, waits for the component to flag
 * `document.documentElement[data-report-ready="1"]` (data + thumbnails loaded)
 * and prints it.
 *
 * WYSIWYG (David's requirement): the PDF must be a faithful copy of what the
 * screen shows when he clicks "Informe PDF" — same layout, same cards, same
 * tables, same fonts and logo placement — minus the agency-only elements. The
 * component therefore does NOT relayout for paper: its print CSS pins the
 * report to a fixed width (REPORT_PRINT_WIDTH_PX = 1100, the desktop layout)
 * and declares `@page { size: 1148px 1624px; margin: 24px }`, i.e. a page with
 * A4 proportions measured in screen pixels. This renderer only has to honour
 * that: a viewport wider than the report (so the desktop breakpoints apply),
 * print media emulation, and `page.pdf` with `preferCSSPageSize` and no
 * format/margin overrides so the CSS page size wins. Viewers print the
 * resulting PDF scaled to A4 and it looks like the screen did.
 *
 * Nothing is recomputed here: the figures are whatever the report page shows,
 * so a client PDF from the portal route carries exactly the portal projection.
 */

export interface RenderReportPdfOptions {
  /** Page path on this deployment, e.g. `/campaigns/{id}/report` or `/portal/campaigns/{id}/report`. */
  path: string
  /** The caller's JWT; it is replayed as the auth cookie so the page loads as that user. */
  cookieToken: string
  /** Cookie name; the app's auth cookie is 'token'. */
  cookieName?: string
  /**
   * The request's abort signal: a render that the client (or the proxy) has
   * given up on is not started, and one in flight is cut short.
   */
  signal?: AbortSignal
  /** UI language of the rendered report (the app stores it in localStorage; headless Chromium would default to English). */
  locale?: 'es' | 'en'
}

/** Thrown when the render queue is full or the caller waited too long for a slot: the route answers 503. */
export class ReportPdfBusyError extends Error {
  constructor(message = 'Report PDF renderer busy') {
    super(message)
    this.name = 'ReportPdfBusyError'
  }
}

/** Thrown when the caller aborted the request before the PDF was produced. */
export class ReportPdfAbortedError extends Error {
  constructor() {
    super('Report PDF request aborted')
    this.name = 'ReportPdfAbortedError'
  }
}

/** Headless Chromium flags shared by every server-side browser (PDF, thumbnail recovery). */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--font-render-hinting=none',
]

/** Candidate Chromium binaries, first match wins. */
const EXECUTABLE_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]

export function resolveChromiumExecutable(): string {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error(
    'No Chromium binary found. Set PUPPETEER_EXECUTABLE_PATH or install chromium (see Dockerfile).'
  )
}

export function reportPdfBaseUrl(): string {
  return process.env.REPORT_PDF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
}

// ---- In-process semaphore: at most MAX_CONCURRENT_RENDERS Chromium at a time ----
// A headless Chromium costs a few hundred MB; the Railway container is small.
// Every server-side Chromium counts: the PDF renders here and the thumbnail
// embed recovery (thumb-cache.ts) take a slot through acquireChromiumSlot().
// The queue behind the semaphore is bounded (MAX_QUEUED_RENDERS) and every
// waiter gives up after MAX_QUEUE_WAIT_MS or when its request is aborted, so
// a burst of requests can never pile up minutes of back-to-back renders.
const MAX_CONCURRENT_RENDERS = 2
const MAX_QUEUED_RENDERS = 4
const MAX_QUEUE_WAIT_MS = 30_000
let activeRenders = 0
const waiters: Array<() => void> = []

/**
 * Take one headless-Chromium slot (waits up to MAX_QUEUE_WAIT_MS behind a
 * bounded queue; throws ReportPdfBusyError / ReportPdfAbortedError). Pair with
 * releaseChromiumSlot() in a finally.
 */
export async function acquireChromiumSlot(signal?: AbortSignal): Promise<void> {
  return acquire(signal)
}

export function releaseChromiumSlot(): void {
  release()
}

async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ReportPdfAbortedError()
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1
    return
  }
  if (waiters.length >= MAX_QUEUED_RENDERS) {
    throw new ReportPdfBusyError(`Report PDF queue full (${MAX_QUEUED_RENDERS} waiting)`)
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const leave = () => {
      const i = waiters.indexOf(wake)
      if (i >= 0) waiters.splice(i, 1)
    }
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (err) {
        leave()
        reject(err)
      } else {
        resolve()
      }
    }
    const wake = () => finish()
    const onAbort = () => finish(new ReportPdfAbortedError())
    const timer = setTimeout(
      () => finish(new ReportPdfBusyError(`Report PDF slot not available within ${MAX_QUEUE_WAIT_MS} ms`)),
      MAX_QUEUE_WAIT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    waiters.push(wake)
  })
  activeRenders += 1
}

function release(): void {
  activeRenders -= 1
  const next = waiters.shift()
  if (next) next()
}

const READY_TIMEOUT_MS = 20_000
const READY_FALLBACK_SLEEP_MS = 1_500
const NAVIGATION_TIMEOUT_MS = 60_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function renderReportPdf({
  path,
  cookieToken,
  cookieName = 'token',
  signal,
  locale = 'es',
}: RenderReportPdfOptions): Promise<Buffer> {
  if (!path.startsWith('/')) throw new Error('renderReportPdf: path must start with "/"')
  if (!cookieToken) throw new Error('renderReportPdf: missing auth token')

  const base = reportPdfBaseUrl()
  const baseUrl = new URL(base)
  const executablePath = resolveChromiumExecutable()
  const separator = path.includes('?') ? '&' : '?'
  const url = `${base}${path}${separator}print=1`

  await acquire(signal)
  let browser: Browser | null = null
  // An abort while rendering closes the browser, which fails the pending
  // puppeteer call; the caller then sees ReportPdfAbortedError.
  const onAbort = () => {
    if (browser) browser.close().catch(() => {})
  }
  const throwIfAborted = () => {
    if (signal?.aborted) throw new ReportPdfAbortedError()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    throwIfAborted()
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [...LAUNCH_ARGS, `--lang=${locale === 'en' ? 'en-US' : 'es-ES'}`],
    })
    throwIfAborted()

    // The auth cookie, scoped to this deployment's own origin only.
    await browser.setCookie({
      name: cookieName,
      value: cookieToken,
      domain: baseUrl.hostname,
      path: '/',
      httpOnly: true,
      secure: baseUrl.protocol === 'https:',
      sameSite: 'Lax',
    })

    const page = await browser.newPage()
    // The i18n provider reads localStorage('tkoc-locale') and otherwise falls back to navigator.language.
    await page.evaluateOnNewDocument((l: string) => { try { window.localStorage.setItem('tkoc-locale', l) } catch { /* private mode */ } }, locale)
    // The viewport must be at least as wide as the pinned report width
    // (REPORT_PRINT_WIDTH_PX = 1100) so Tailwind's desktop breakpoints apply and
    // the layout that prints is the one David sees on screen.
    await page.setViewport({ width: 1200, height: 1700, deviceScaleFactor: 1 })
    await page.emulateMediaType('print')
    await page.goto(url, { waitUntil: 'networkidle0', timeout: NAVIGATION_TIMEOUT_MS })
    throwIfAborted()

    // The report flags itself ready once data and thumbnails have settled. If
    // the flag never comes (older component, an image that never loads) we
    // still print after a short grace period rather than failing.
    try {
      await page.waitForFunction(
        () => document.documentElement.getAttribute('data-report-ready') === '1',
        { timeout: READY_TIMEOUT_MS, polling: 200 }
      )
    } catch {
      console.warn(`[report-pdf] data-report-ready not set within ${READY_TIMEOUT_MS} ms for ${path}; printing anyway`)
      await sleep(READY_FALLBACK_SLEEP_MS)
    }

    throwIfAborted()
    // No `format` and no `margin`: the component's `@page { size; margin }`
    // (A4-proportioned at screen pixels) is the single source of truth, and
    // scale 1 keeps CSS pixels 1:1 so the page renders exactly like the screen.
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      scale: 1,
    })
    return Buffer.from(pdf)
  } catch (error) {
    // Any puppeteer failure after an abort is the abort, not a render error.
    if (signal?.aborted) throw new ReportPdfAbortedError()
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (browser) {
      try {
        await browser.close()
      } catch (error) {
        console.error('[report-pdf] browser.close failed:', error)
      }
    }
    release()
  }
}
