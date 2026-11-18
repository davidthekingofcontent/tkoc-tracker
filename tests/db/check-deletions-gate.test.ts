/**
 * GET /api/cron/check-deletions opens its 24 h gate GATE_SLACK_MS early
 * (weekly review of 16 Nov 2026, point 8).
 *
 * The internal scheduler ticks every 24 h on the dot while the stamp lands a
 * few minutes into the run, so the tick arrived ~2 min before the gate opened,
 * was answered too_soon, and the job (the RGPD deletion queue) ran one day in
 * two (15 Nov 23:04:28 vs nextAllowed 23:06:24). With the slack a tick that is
 * a couple of minutes early works; a tick well inside the interval still waits.
 *
 * No network: the Instagram existence check and fetch are mocked, and the
 * database holds no media, so the route answers before any check.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.CRON_SECRET = 'db-test-secret-check-deletions'
})
vi.mock('@/lib/thumb-cache', () => ({
  checkInstagramPostsExist: vi.fn(async () => new Map()),
  cacheInfluencerAvatar: vi.fn(async () => {}),
  backfillMediaThumbs: vi.fn(async () => {}),
}))
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { GATE_SLACK_MS } from '@/lib/cron-throttle'
import { GET } from '@/app/api/cron/check-deletions/route'

const STAMP = 'cron_check-deletions_last_run'
const HOUR = 3_600_000
const MINUTE = 60_000

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany({ where: { key: { in: [STAMP, 'deletion_checked', 'deletion_suspects'] } } })
  await prisma.media.deleteMany()
}

beforeEach(reset)
afterAll(reset)

async function stampAgo(ms: number) {
  await prisma.setting.upsert({ where: { key: STAMP }, update: { value: new Date(Date.now() - ms).toISOString() }, create: { key: STAMP, value: new Date(Date.now() - ms).toISOString() } })
}

async function call(query = '') {
  const request = new NextRequest(`http://localhost/api/cron/check-deletions${query}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })
  const response = await GET(request)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const stamp = async () => (await prisma.setting.findUnique({ where: { key: STAMP } }))?.value ?? null

describe('GET /api/cron/check-deletions and its 24 h gate', () => {
  it('a tick 2 minutes before the 24 h mark works (the slack absorbs the scheduler drift)', async () => {
    const before = new Date(Date.now() - (24 * HOUR - 2 * MINUTE)).toISOString()
    await stampAgo(24 * HOUR - 2 * MINUTE)

    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.skipped).toBeUndefined()
    expect(body.message).toBe('No media to check')
    // The run stamped itself: the next tick, 24 h from now, is again inside the slack
    const after = await stamp()
    expect(after).not.toBeNull()
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(before))
  })

  it('a tick just outside the slack still waits', async () => {
    await stampAgo(24 * HOUR - GATE_SLACK_MS - MINUTE)
    const { status, body } = await call()
    expect(status).toBe(200)
    expect(body.skipped).toBe('too_soon')
    expect(body.cron).toBe('check-deletions')
  })

  it('a tick 2 hours after a run waits', async () => {
    const value = new Date(Date.now() - 2 * HOUR).toISOString()
    await stampAgo(2 * HOUR)
    const { body } = await call()
    expect(body.skipped).toBe('too_soon')
    // Nothing was stamped by a skipped call
    expect(await stamp()).toBe(value)
  })

  it('runs when there is no stamp at all, and with ?force=1 whatever the stamp', async () => {
    expect((await call()).body.skipped).toBeUndefined()
    await stampAgo(HOUR)
    expect((await call('?force=1')).body.skipped).toBeUndefined()
  })

  it('refuses a caller without the cron secret', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/check-deletions'))
    expect(response.status).toBe(401)
  })
})
