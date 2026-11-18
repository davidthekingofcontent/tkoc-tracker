/**
 * POST /api/discovery/search («Base de datos» tab): "Ordenar por seguidores /
 * engagement" is computed by PostgreSQL over every creator the filters match
 * (weekly review of 16 Nov 2026, point 8).
 *
 * Until then the route fetched min(total, 500) rows without ORDER BY and
 * sorted them in memory: with the real pool at 451 creators and growing ~100 a
 * month, from December the order would have covered an arbitrary subset. The
 * results must be the ones the old code gave for < 500 creators, and the
 * right ones past 500.
 *
 * The session is the test's (getSession is mocked); no network is involved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ session: { id: 'staff', email: 'pm@correo-inventado.test', name: 'PM', role: 'EMPLOYEE' } }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>()
  return { ...real, getSession: vi.fn(async () => auth.session) }
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import type { Platform } from '@/generated/prisma/client'
import { POST } from '@/app/api/discovery/search/route'

type Result = { id: string; displayName: string | null; followers: number; engagementRate: number; platform: string }
type Body = { results: Result[]; total: number; offset: number; limit: number; hasMore: boolean }

async function search(body: Record<string, unknown>): Promise<Body> {
  const request = new NextRequest('http://localhost/api/discovery/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await POST(request)
  expect(response.status).toBe(200)
  return (await response.json()) as Body
}

interface Seed { id: string; name: string; followers: number; engagementRate: number; platform?: Platform }

/** Pool creators whose display name carries `tag`, so `query: tag` lists exactly them. */
async function seed(tag: string, rows: Seed[]) {
  await prisma.creatorProfile.createMany({
    data: rows.map(r => ({ id: r.id, displayName: `${r.name} ${tag}`, primaryPlatform: r.platform ?? 'INSTAGRAM' })),
  })
  await prisma.creatorPlatformProfile.createMany({
    data: rows.map(r => ({
      creatorId: r.id,
      platform: r.platform ?? 'INSTAGRAM',
      username: `${r.name.toLowerCase().replace(/\s+/g, '_')}_${tag}`,
      followers: r.followers,
      engagementRate: r.engagementRate,
    })),
  })
}

const cleanup = (tag: string) => prisma.creatorProfile.deleteMany({ where: { displayName: { contains: tag } } })

describe('three creators (fewer than the old 500-row cap): the same results as before', () => {
  const tag = `t3-${randomUUID().slice(0, 8)}`
  const ids = { ana: `${tag}-ana`, bea: `${tag}-bea`, cris: `${tag}-cris` }

  beforeAll(async () => {
    await seed(tag, [
      { id: ids.ana, name: 'Ana', followers: 100, engagementRate: 10 },
      { id: ids.bea, name: 'Bea', followers: 5000, engagementRate: 1 },
      { id: ids.cris, name: 'Cris', followers: 900, engagementRate: 5 },
    ])
  })
  afterAll(() => cleanup(tag))

  it('orders by followers in both directions', async () => {
    const desc = await search({ query: tag, sortBy: 'followers', sortDir: 'desc' })
    expect(desc.results.map(r => r.id)).toEqual([ids.bea, ids.cris, ids.ana])
    expect(desc.results.map(r => r.followers)).toEqual([5000, 900, 100])
    expect(desc).toMatchObject({ total: 3, offset: 0, limit: 50, hasMore: false })

    const asc = await search({ query: tag, sortBy: 'followers', sortDir: 'asc' })
    expect(asc.results.map(r => r.id)).toEqual([ids.ana, ids.cris, ids.bea])
  })

  it('orders by engagement rate', async () => {
    const desc = await search({ query: tag, sortBy: 'engagementRate', sortDir: 'desc' })
    expect(desc.results.map(r => r.engagementRate)).toEqual([10, 5, 1])
    const asc = await search({ query: tag, sortBy: 'engagementRate', sortDir: 'asc' })
    expect(asc.results.map(r => r.engagementRate)).toEqual([1, 5, 10])
  })

  it('paginates the ordered list', async () => {
    const first = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', offset: 0, limit: 2 })
    expect(first.results.map(r => r.id)).toEqual([ids.bea, ids.cris])
    expect(first.hasMore).toBe(true)
    const second = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', offset: 2, limit: 2 })
    expect(second.results.map(r => r.id)).toEqual([ids.ana])
    expect(second).toMatchObject({ total: 3, offset: 2, limit: 2, hasMore: false })
  })

  it('keeps the filters while ordering (followers range, platform)', async () => {
    const ranged = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', minFollowers: 500, maxFollowers: 4000 })
    expect(ranged.results.map(r => r.id)).toEqual([ids.cris])
    expect(ranged.total).toBe(1)
    const tiktok = await search({ query: tag, sortBy: 'followers', platform: 'tiktok' })
    expect(tiktok.results).toEqual([])
    expect(tiktok.total).toBe(0)
  })

  it('the creator-level sorts are untouched', async () => {
    await prisma.creatorProfile.update({ where: { id: ids.ana }, data: { spainFitScore: 90 } })
    await prisma.creatorProfile.update({ where: { id: ids.bea }, data: { spainFitScore: 10 } })
    await prisma.creatorProfile.update({ where: { id: ids.cris }, data: { spainFitScore: 50 } })
    const fit = await search({ query: tag, sortBy: 'spainFitScore', sortDir: 'desc' })
    expect(fit.results.map(r => r.id)).toEqual([ids.ana, ids.cris, ids.bea])
  })
})

describe('602 creators (past the old 500-row cap): the order covers all of them', () => {
  const tag = `big-${randomUUID().slice(0, 8)}`
  const top = `${tag}-top`
  const tiny = `${tag}-tiny`
  const TOTAL = 602

  beforeAll(async () => {
    const rows: Seed[] = []
    for (let i = 0; i < 300; i++) rows.push({ id: `${tag}-a${String(i).padStart(3, '0')}`, name: `Creadora A${i}`, followers: 1000 + i, engagementRate: (i % 50) + 1 })
    // The creator with most followers sits in the middle of the insertion order, on TikTok, with the lowest engagement
    rows.push({ id: top, name: 'Creadora Top', followers: 999_999, engagementRate: 0.5, platform: 'TIKTOK' })
    for (let i = 300; i < 600; i++) rows.push({ id: `${tag}-b${String(i).padStart(3, '0')}`, name: `Creadora B${i}`, followers: 1000 + i, engagementRate: (i % 50) + 1 })
    // The smallest account has the highest engagement rate
    rows.push({ id: tiny, name: 'Creadora Tiny', followers: 7, engagementRate: 500 })
    await seed(tag, rows)
  }, 120_000)
  afterAll(() => cleanup(tag))

  it('the first by followers is the right one, and the last page closes the list', async () => {
    const page = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', offset: 0, limit: 50 })
    expect(page.total).toBe(TOTAL)
    expect(page.results[0].id).toBe(top)
    expect(page.results[0].followers).toBe(999_999)
    expect(page.results[0].platform).toBe('TIKTOK')
    expect(page.results).toHaveLength(50)
    expect(page.hasMore).toBe(true)

    const last = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', offset: 600, limit: 50 })
    expect(last.results.map(r => r.id)).toEqual([`${tag}-a000`, tiny])
    expect(last.hasMore).toBe(false)
  })

  it('ascending by followers starts with the smallest account', async () => {
    const page = await search({ query: tag, sortBy: 'followers', sortDir: 'asc', offset: 0, limit: 3 })
    expect(page.results.map(r => r.id)).toEqual([tiny, `${tag}-a000`, `${tag}-a001`])
  })

  it('the first by engagement is the right one even though it has the fewest followers', async () => {
    const page = await search({ query: tag, sortBy: 'engagementRate', sortDir: 'desc', offset: 0, limit: 5 })
    expect(page.results[0].id).toBe(tiny)
    expect(page.results[0].engagementRate).toBe(500)
    expect(page.results.slice(1).every(r => r.engagementRate === 50)).toBe(true)
    const asc = await search({ query: tag, sortBy: 'engagementRate', sortDir: 'asc', offset: 0, limit: 1 })
    expect(asc.results[0].id).toBe(top)
  })

  it('walking every page by followers lists each creator exactly once, in order', async () => {
    const seen: Result[] = []
    for (let offset = 0; offset < TOTAL; offset += 100) {
      const page = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', offset, limit: 100 })
      seen.push(...page.results)
      expect(page.hasMore).toBe(offset + 100 < TOTAL)
    }
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen.map(r => r.id)).size).toBe(TOTAL)
    for (let i = 1; i < seen.length; i++) expect(seen[i - 1].followers).toBeGreaterThanOrEqual(seen[i].followers)
  })

  it('the platform filter applies before the order', async () => {
    const tiktok = await search({ query: tag, sortBy: 'followers', sortDir: 'asc', platform: 'tiktok' })
    expect(tiktok.results.map(r => r.id)).toEqual([top])
    expect(tiktok.total).toBe(1)
    const instagram = await search({ query: tag, sortBy: 'followers', sortDir: 'desc', platform: 'instagram', limit: 1 })
    expect(instagram.results[0].id).toBe(`${tag}-b599`)
    expect(instagram.total).toBe(TOTAL - 1)
  })
})
