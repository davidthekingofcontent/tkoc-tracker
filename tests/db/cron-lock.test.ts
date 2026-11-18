/**
 * The in-flight lock of the cron routes (review of 16 Nov 2026, point 7).
 *
 * On 15 Nov the scheduler's one fetch to check-posts reached the server as two
 * requests and both ran the whole cron in parallel: the route had no lock and
 * stamped at the END. Here: two simultaneous calls → one works and the other
 * answers 200 {skipped: 'in_flight'} without reading anybody; a lock left by a
 * dead run (older than the TTL) is taken over; a run that errors releases it;
 * check-posts stamps only when it FINISHES (never while it runs): a run that
 * breaks or is killed half way leaves no stamp and the next tick retries, while
 * the lock holds every other caller off in the meantime.
 *
 * The network is mocked: the profile read answers from a table, the hashtag
 * scrapes answer [] and Apify reports itself out of budget so the views
 * refresh does not run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  profiles: new Map<string, unknown>(),
  reads: [] as string[],
  readDelayMs: 0,
  configuredFails: false,
  /** The campaign filter (right after the campaigns are read, before anybody is read) throws */
  endedFails: false,
}))

vi.mock('@/lib/apify', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/apify')>()
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in tests`) })
  return {
    ...real,
    isApifyConfigured: vi.fn(() => true),
    isApifyConfiguredAsync: vi.fn(async () => {
      if (net.configuredFails) throw new Error('settings unreadable (test)')
      return true
    }),
    checkApifyAuth: vi.fn(async () => 'ok'),
    isApifyExhausted: vi.fn(() => true),
    isApifyOverCoreReserve: vi.fn(async () => ({ over: false, usd: 1, coreLimit: 100, usedPct: 10, cycleEndsAt: null })),
    detectCountry: vi.fn(() => null),
    scrapeHashtag: vi.fn(async () => []),
    scrapeAccountMentions: vi.fn(async () => []),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapePostsBatch: blocked('scrapePostsBatch'),
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
  }
})
vi.mock('@/lib/platform-client', () => ({
  fetchProfile: vi.fn(async (username: string, platform: string) => {
    net.reads.push(`${platform}:${username}`)
    if (net.readDelayMs > 0) await new Promise(r => setTimeout(r, net.readDelayMs))
    const profile = net.profiles.get(`${platform}:${username}`)
    return profile ? { profile, dataSource: 'apify' } : null
  }),
}))
vi.mock('@/lib/youtube-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/youtube-api')>()), isYouTubeApiConfigured: vi.fn(() => false) }))
// campaignEndedForCrons runs on the campaigns just read, AFTER the stamp and BEFORE the first creator:
// the one place a failure must put the previous stamp back (restoreCronRun)
vi.mock('@/lib/campaign-ended', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/campaign-ended')>()
  return {
    ...real,
    campaignEndedForCrons: vi.fn((...args: Parameters<typeof real.campaignEndedForCrons>) => {
      if (net.endedFails) throw new Error('campaign filter broke (test)')
      return real.campaignEndedForCrons(...args)
    }),
  }
})
vi.mock('@/lib/thumb-cache', () => ({ cacheInfluencerAvatar: vi.fn(async () => {}), backfillMediaThumbs: vi.fn(async () => {}) }))
vi.mock('@/lib/creator-pool', () => ({ materializeInfluencerIntoPool: vi.fn(async () => {}) }))

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { ScrapedProfile } from '@/lib/apify'
import { scrapeHashtag } from '@/lib/apify'
import { GET as checkPosts } from '@/app/api/cron/check-posts/route'
import { GET as track } from '@/app/api/cron/track/route'
import { CRON_LOCK_TTL_MS, acquireCronLock, cronLockHeldSince, releaseCronLock, renewCronLock } from '@/lib/cron-throttle'

vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch: the network is mocked in tests') }))

const SECRET = 'cron-secret-of-the-test'

async function reset() {
  await prisma.notification.deleteMany()
  await prisma.setting.deleteMany()
  await prisma.scrapeJob.deleteMany()
  await prisma.media.deleteMany()
  await prisma.campaignInfluencer.deleteMany()
  await prisma.campaign.deleteMany()
  await prisma.influencer.deleteMany()
  await prisma.user.deleteMany()
}

beforeEach(async () => {
  await reset()
  vi.clearAllMocks()
  net.profiles.clear()
  net.reads.length = 0
  net.readDelayMs = 0
  net.configuredFails = false
  net.endedFails = false
  process.env.CRON_SECRET = SECRET
})
afterAll(async () => {
  await reset()
  delete process.env.CRON_SECRET
  vi.unstubAllGlobals()
})

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const setting = (key: string) => prisma.setting.findUnique({ where: { key } }).then(r => r?.value ?? null)

function serve(username: string, platform: 'INSTAGRAM' | 'TIKTOK' = 'INSTAGRAM') {
  const profile: ScrapedProfile = {
    username, displayName: null, bio: null, avatarUrl: null, followers: 1000, following: 10, postsCount: 50, engagementRate: 2.5,
    avgLikes: 100, avgComments: 5, avgViews: 4000, isVerified: false, website: null, email: null, country: null, city: null, recentPosts: [],
  }
  net.profiles.set(`${platform}:${username}`, profile)
}

/** A live campaign with `n` confirmed Instagram creators the run must read. */
async function liveCampaign(n: number, over: { targetHashtags?: string[]; targetAccounts?: string[] } = {}) {
  const pm = await prisma.user.create({ data: { email: `pm-${Math.random()}@example.test`, password: 'x', name: 'Laura PM', role: 'EMPLOYEE' } })
  const campaign = await prisma.campaign.create({
    data: {
      name: 'Marca Demo - Noviembre (test)', status: 'ACTIVE', country: 'ES',
      startDate: new Date(Date.now() - 10 * 86_400_000), endDate: new Date(Date.now() + 10 * 86_400_000),
      targetAccounts: over.targetAccounts ?? [], targetHashtags: over.targetHashtags ?? ['marcademo'], targetKeywords: [], platforms: ['INSTAGRAM'], userId: pm.id,
    },
  })
  for (let i = 0; i < n; i++) {
    const row = await prisma.influencer.create({ data: { username: `creadora_demo_${i}`, platform: 'INSTAGRAM' } })
    await prisma.campaignInfluencer.create({ data: { campaignId: campaign.id, influencerId: row.id, status: 'CONTRACTED' } })
    serve(row.username)
  }
  return campaign
}

async function callCheckPosts(query = '') {
  const res = await checkPosts(new NextRequest(`http://localhost/api/cron/check-posts${query}`, { headers: { 'x-cron-secret': SECRET } }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
async function callTrack(query = '') {
  const res = await track(new NextRequest(`http://localhost/api/cron/track${query}`, { headers: { authorization: `Bearer ${SECRET}` } }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('acquireCronLock / releaseCronLock', () => {
  it('of ten simultaneous takers exactly one gets the lock; the others get null while it is held', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireCronLock('demo')))
    const winners = results.filter(r => r !== null)
    expect(winners).toHaveLength(1)
    expect(await cronLockHeldSince('demo')).toBe(winners[0]!.token)
    expect(await acquireCronLock('demo')).toBeNull()
  })

  it('only the owner releases it: a foreign token leaves it in place; once released the next taker wins', async () => {
    const lock = (await acquireCronLock('demo'))!
    await releaseCronLock({ name: 'demo', token: hoursAgo(0.5) })
    expect(await cronLockHeldSince('demo')).toBe(lock.token)
    await releaseCronLock(lock)
    expect(await cronLockHeldSince('demo')).toBeNull()
    expect(await acquireCronLock('demo')).not.toBeNull()
  })

  it('a holder older than the TTL is dead (a redeploy mid-run): its lock is taken over, a younger one is not', async () => {
    expect(CRON_LOCK_TTL_MS).toBe(60 * 60 * 1000)
    await prisma.setting.create({ data: { key: 'cron_demo_inflight', value: hoursAgo(1.01) } })
    const taken = await acquireCronLock('demo')
    expect(taken).not.toBeNull()
    expect(await cronLockHeldSince('demo')).toBe(taken!.token)
    await releaseCronLock(taken)

    await prisma.setting.create({ data: { key: 'cron_demo_inflight', value: hoursAgo(0.9) } })
    expect(await acquireCronLock('demo')).toBeNull()
    // The release of a lock we never got touches nothing
    await releaseCronLock(null)
    expect(await cronLockHeldSince('demo')).toBe(await setting('cron_demo_inflight'))
  })

  it('renewCronLock (heartbeat) moves the holder’s time forward, so a run longer than the TTL is not taken over; a lost lock is reported, not thrown', async () => {
    const lock = (await acquireCronLock('demo'))!
    // The run has been working for two hours: the row still says when it took the lock
    const twoHoursAgo = hoursAgo(2)
    await prisma.setting.update({ where: { key: 'cron_demo_inflight' }, data: { value: twoHoursAgo } })
    lock.token = twoHoursAgo
    expect(await renewCronLock(lock)).toBe(true)
    expect(Date.parse(lock.token)).toBeGreaterThan(Date.now() - 5_000)
    expect(await cronLockHeldSince('demo')).toBe(lock.token)
    // Renewed: the next caller sees a live run, although the lock was first taken 2 h ago
    expect(await acquireCronLock('demo')).toBeNull()
    // And the owner still releases it with its renewed token
    await releaseCronLock(lock)
    expect(await cronLockHeldSince('demo')).toBeNull()

    // A lock that was taken over (or released) by somebody else is not renewed; the holder is told (false)
    const other = (await acquireCronLock('demo'))!
    expect(await renewCronLock({ name: 'demo', token: hoursAgo(1) })).toBe(false)
    expect(await cronLockHeldSince('demo')).toBe(other.token)
    expect(await renewCronLock(null)).toBe(false)
    await releaseCronLock(other)
  })
})

describe('check-posts', () => {
  it('a second call while a run is in flight answers 200 {skipped: in_flight} and reads nobody; after the run the lock is gone', async () => {
    await liveCampaign(2)
    const other = (await acquireCronLock('check-posts'))!
    const refused = await callCheckPosts('?force=1')
    expect(refused.status).toBe(200)
    expect(refused.body).toEqual({ skipped: 'in_flight', cron: 'check-posts', since: other.token })
    expect(net.reads).toEqual([])
    expect(await setting('cron_check-posts_last_run')).toBeNull()

    await releaseCronLock(other)
    const run = await callCheckPosts('?force=1')
    expect(run.body).toMatchObject({ success: true, influencersChecked: 2, campaignsSkipped: [] })
    expect(net.reads.sort()).toEqual(['INSTAGRAM:creadora_demo_0', 'INSTAGRAM:creadora_demo_1'])
    expect(await cronLockHeldSince('check-posts')).toBeNull()
  })

  it('two simultaneous calls: one works, the other is refused, every creator is read once', async () => {
    await liveCampaign(3)
    net.readDelayMs = 150
    const [a, b] = await Promise.all([callCheckPosts('?force=1'), callCheckPosts('?force=1')])
    const bodies = [a.body, b.body]
    const worked = bodies.filter(x => x.success === true)
    const refused = bodies.filter(x => typeof x.skipped === 'string')
    expect(worked).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect(['in_flight', 'too_soon']).toContain(refused[0].skipped)
    expect(worked[0]).toMatchObject({ influencersChecked: 3 })
    expect(net.reads).toHaveLength(3)
    expect(new Set(net.reads).size).toBe(3)
    expect(await cronLockHeldSince('check-posts')).toBeNull()
  })

  it('a lock left by a dead run is taken over once it is older than the TTL', async () => {
    await liveCampaign(1)
    await prisma.setting.create({ data: { key: 'cron_check-posts_inflight', value: hoursAgo(2) } })
    const run = await callCheckPosts('?force=1')
    expect(run.body).toMatchObject({ success: true, influencersChecked: 1 })
    expect(await cronLockHeldSince('check-posts')).toBeNull()
  })

  it('stamps only when the run ENDS (no stamp while the first creator is being read) and then tells the next caller too_soon', async () => {
    await liveCampaign(1)
    let stampDuringRead: string | null = 'not read'
    const { fetchProfile } = await import('@/lib/platform-client')
    vi.mocked(fetchProfile).mockImplementationOnce(async (username: string, platform: string) => {
      stampDuringRead = await setting('cron_check-posts_last_run')
      net.reads.push(`${platform}:${username}`)
      const profile = net.profiles.get(`${platform}:${username}`)
      return profile ? { profile: profile as ScrapedProfile, dataSource: 'apify' } : null
    })
    const before = Date.now()
    const run = await callCheckPosts()
    expect(run.body).toMatchObject({ success: true, influencersChecked: 1 })
    // While the first creator was being read there was no stamp yet (the lock protects the run)
    expect(stampDuringRead).toBeNull()
    const stampAfter = await setting('cron_check-posts_last_run')
    expect(stampAfter).not.toBeNull()
    expect(Date.parse(stampAfter!)).toBeGreaterThanOrEqual(before - 1000)
    // Written at the end: the figures of the run, readable without the logs
    const result = JSON.parse((await setting('cron_check-posts_last_result'))!)
    expect(result).toMatchObject({ campaignsActive: 1, campaignsSkipped: [], influencersChecked: 1, newPosts: 0, errors: 0 })
    // The gate now says too_soon to the next caller
    expect((await callCheckPosts()).body).toMatchObject({ skipped: 'too_soon', cron: 'check-posts' })
  })

  it('an error before anybody was read releases the lock and does not stamp the day (the next tick retries)', async () => {
    await liveCampaign(1)
    await prisma.setting.create({ data: { key: 'cron_check-posts_last_run', value: hoursAgo(30) } })
    const previous = await setting('cron_check-posts_last_run')
    net.configuredFails = true
    const failed = await callCheckPosts()
    expect(failed.status).toBe(500)
    expect(await cronLockHeldSince('check-posts')).toBeNull()
    expect(await setting('cron_check-posts_last_run')).toBe(previous)
    expect(net.reads).toEqual([])

    // The next call is not refused by a stale lock and works
    net.configuredFails = false
    const run = await callCheckPosts()
    expect(run.body).toMatchObject({ success: true, influencersChecked: 1 })
    expect(await cronLockHeldSince('check-posts')).toBeNull()
  })

  it('an error after the campaigns were read and before anybody was read leaves the previous stamp as it was (or none), records failed: true and releases the lock', async () => {
    await liveCampaign(1)
    await prisma.setting.create({ data: { key: 'cron_check-posts_last_run', value: hoursAgo(30) } })
    const previous = await setting('cron_check-posts_last_run')
    net.endedFails = true
    const failed = await callCheckPosts()
    expect(failed.status).toBe(500)
    expect(net.reads).toEqual([])
    // No stamp is written by a run that did not finish: the previous one stays
    expect(await setting('cron_check-posts_last_run')).toBe(previous)
    expect(JSON.parse((await setting('cron_check-posts_last_result'))!)).toMatchObject({ failed: true, influencersChecked: 0 })
    expect(await cronLockHeldSince('check-posts')).toBeNull()

    // With no previous stamp at all, there is still none afterwards
    await prisma.setting.deleteMany({ where: { key: 'cron_check-posts_last_run' } })
    expect((await callCheckPosts()).status).toBe(500)
    expect(await setting('cron_check-posts_last_run')).toBeNull()

    // The next tick retries at once and works
    net.endedFails = false
    expect((await callCheckPosts()).body).toMatchObject({ success: true, influencersChecked: 1 })
    expect(await setting('cron_check-posts_last_run')).not.toBeNull()
  })

  it('renews the lock every 10 creators (heartbeat): the lock’s time at the 11th read is later than at the 1st', async () => {
    await liveCampaign(11)
    const { fetchProfile } = await import('@/lib/platform-client')
    const original = vi.mocked(fetchProfile).getMockImplementation()
    const seen: string[] = []
    vi.mocked(fetchProfile).mockImplementation(async (username: string, platform: string) => {
      seen.push((await cronLockHeldSince('check-posts')) ?? 'none')
      net.reads.push(`${platform}:${username}`)
      const profile = net.profiles.get(`${platform}:${username}`)
      return profile ? { profile: profile as ScrapedProfile, dataSource: 'apify' } : null
    })
    try {
      const run = await callCheckPosts('?force=1')
      expect(run.body).toMatchObject({ success: true, influencersChecked: 11 })
      expect(seen).toHaveLength(11)
      expect(seen.slice(0, 10).every(t => t === seen[0])).toBe(true)
      expect(Date.parse(seen[10])).toBeGreaterThan(Date.parse(seen[0]))
      expect(await cronLockHeldSince('check-posts')).toBeNull()
    } finally {
      if (original) vi.mocked(fetchProfile).mockImplementation(original)
    }
  }, 90_000)
})

describe('track', () => {
  it('a second call while a run is in flight answers {skipped: in_flight} and scrapes nothing; after the run the lock is gone', async () => {
    await liveCampaign(0, { targetHashtags: ['marcademo'] })
    const other = (await acquireCronLock('track'))!
    const refused = await callTrack('?force=1')
    expect(refused.body).toEqual({ skipped: 'in_flight', cron: 'track', since: other.token })
    expect(vi.mocked(scrapeHashtag)).not.toHaveBeenCalled()

    await releaseCronLock(other)
    const run = await callTrack('?force=1')
    expect(run.body).toMatchObject({ message: 'Cron tracking completed' })
    expect(vi.mocked(scrapeHashtag)).toHaveBeenCalledTimes(1)
    expect(await cronLockHeldSince('track')).toBeNull()
    expect(await setting('cron_track_last_run')).not.toBeNull()
  })

  it('two simultaneous calls: one scrapes, the other is refused', async () => {
    await liveCampaign(0, { targetHashtags: ['marcademo'] })
    vi.mocked(scrapeHashtag).mockImplementation(async () => { await new Promise(r => setTimeout(r, 150)); return [] })
    const [a, b] = await Promise.all([callTrack('?force=1'), callTrack('?force=1')])
    const bodies = [a.body, b.body]
    expect(bodies.filter(x => x.message === 'Cron tracking completed')).toHaveLength(1)
    const refused = bodies.filter(x => typeof x.skipped === 'string')
    expect(refused).toHaveLength(1)
    expect(['in_flight', 'too_soon']).toContain(refused[0].skipped)
    expect(vi.mocked(scrapeHashtag)).toHaveBeenCalledTimes(1)
    expect(await cronLockHeldSince('track')).toBeNull()
  })
})
