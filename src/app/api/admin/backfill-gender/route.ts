/**
 * Admin: fill in the gender of creators that have none, from their public
 * name (src/lib/gender.ts — pure, offline, no Apify).
 *
 * POST { limit? (default 5000, max 20000), pool? (default true) }
 *   1. Influencers with gender null → inferGenderFromName(displayName,
 *      username); a non-null result is stored with genderSource 'inferred'
 *      (batched updateMany; a row that got a value meanwhile is left alone).
 *   2. The new values are mirrored onto the linked CreatorProfiles
 *      (creator_platform_profiles.influencerId), never over a 'manual' one.
 *   3. With `pool` (default): real CreatorProfiles (REAL_PROFILE_WHERE) with
 *      gender null and no linked influencer (Apify-only pool rows) get the
 *      same inference from their displayName + the username of their primary
 *      platform profile. Hashtag shells are never touched.
 *
 * Returns { scanned, inferred: { F, M, X }, unresolved, mirrored,
 *           pool: { scanned, inferred: { F, M, X }, unresolved } }.
 * Idempotent: a second run finds nothing to do. ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { inferGenderFromName, GENDER_VALUES, type Gender } from '@/lib/gender'
import { REAL_PROFILE_WHERE } from '@/lib/creator-pool'

export const maxDuration = 300

const DEFAULT_LIMIT = 5000
const MAX_LIMIT = 20000
const READ_BATCH = 1000
const WRITE_CHUNK = 500

type Counts = Record<Gender, number>

const zeroCounts = (): Counts => ({ F: 0, M: 0, X: 0 })

async function requireAdmin(request: NextRequest): Promise<NextResponse | null> {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return null
}

function parseLimit(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw), MAX_LIMIT) : fallback
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Pool rows a mirror may touch: no gender yet, or an inferred one (a PM's value is never overwritten). */
const NOT_MANUAL = { OR: [{ genderSource: null }, { genderSource: { not: 'manual' } }] }

/** Influencer.gender = null → inferred value, in cursor batches; returns the ids written per gender. */
async function backfillInfluencers(limit: number) {
  const inferred = zeroCounts()
  const idsByGender: Record<Gender, string[]> = { F: [], M: [], X: [] }
  let scanned = 0
  let unresolved = 0
  let cursor: string | undefined

  while (scanned < limit) {
    const take = Math.min(READ_BATCH, limit - scanned)
    // Strict keyset (id > last id) rather than cursor+skip: the loop writes
    // gender onto the cursor row itself, and once that row no longer matches
    // `gender: null` Prisma's OFFSET 1 would drop the next unresolved row.
    const batch = await prisma.influencer.findMany({
      where: { gender: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take,
      select: { id: true, displayName: true, username: true },
    })
    if (batch.length === 0) break

    const toWrite: Record<Gender, string[]> = { F: [], M: [], X: [] }
    for (const inf of batch) {
      scanned++
      const g = inferGenderFromName(inf.displayName, inf.username)
      if (g) toWrite[g].push(inf.id)
      else unresolved++
    }

    for (const g of GENDER_VALUES) {
      for (const ids of chunk(toWrite[g], WRITE_CHUNK)) {
        const res = await prisma.influencer.updateMany({
          where: { id: { in: ids }, gender: null },
          data: { gender: g, genderSource: 'inferred' },
        })
        inferred[g] += res.count
        idsByGender[g].push(...ids)
      }
    }

    cursor = batch[batch.length - 1].id
    if (batch.length < take) break
  }

  return { scanned, inferred, unresolved, idsByGender }
}

/** Copies the freshly inferred values onto the pool creators linked to those influencers. */
async function mirrorToPool(idsByGender: Record<Gender, string[]>): Promise<number> {
  let mirrored = 0
  for (const g of GENDER_VALUES) {
    for (const influencerIds of chunk(idsByGender[g], WRITE_CHUNK)) {
      const links = await prisma.creatorPlatformProfile.findMany({
        where: { influencerId: { in: influencerIds } },
        select: { creatorId: true },
      })
      const creatorIds = Array.from(new Set(links.map(l => l.creatorId)))
      if (creatorIds.length === 0) continue
      const res = await prisma.creatorProfile.updateMany({
        where: { id: { in: creatorIds }, ...NOT_MANUAL },
        data: { gender: g, genderSource: 'inferred' },
      })
      mirrored += res.count
    }
  }
  return mirrored
}

/**
 * Pool creators without a linked influencer and without gender: same
 * inference from displayName + primary handle. Only real profiles
 * (REAL_PROFILE_WHERE): the ~3k hashtag shells are never written.
 */
async function backfillPoolOnly(limit: number) {
  const inferred = zeroCounts()
  let scanned = 0
  let unresolved = 0
  let cursor: string | undefined

  while (scanned < limit) {
    const take = Math.min(READ_BATCH, limit - scanned)
    const batch = await prisma.creatorProfile.findMany({
      // Strict keyset, same reason as backfillInfluencers.
      where: {
        gender: null,
        platformProfiles: { some: REAL_PROFILE_WHERE, none: { influencerId: { not: null } } },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        displayName: true,
        primaryPlatform: true,
        platformProfiles: { select: { platform: true, username: true }, orderBy: { followers: 'desc' } },
      },
    })
    if (batch.length === 0) break

    const toWrite: Record<Gender, string[]> = { F: [], M: [], X: [] }
    for (const creator of batch) {
      scanned++
      const primary = creator.platformProfiles.find(p => p.platform === creator.primaryPlatform) ?? creator.platformProfiles[0]
      const g = inferGenderFromName(creator.displayName, primary?.username)
      if (g) toWrite[g].push(creator.id)
      else unresolved++
    }

    for (const g of GENDER_VALUES) {
      for (const ids of chunk(toWrite[g], WRITE_CHUNK)) {
        const res = await prisma.creatorProfile.updateMany({
          where: { id: { in: ids }, gender: null },
          data: { gender: g, genderSource: 'inferred' },
        })
        inferred[g] += res.count
      }
    }

    cursor = batch[batch.length - 1].id
    if (batch.length < take) break
  }

  return { scanned, inferred, unresolved }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request)
  if (denied) return denied

  let body: { limit?: unknown; pool?: unknown } = {}
  try { body = (await request.json().catch(() => ({}))) as typeof body } catch { /* no body */ }
  const limit = parseLimit(body.limit, DEFAULT_LIMIT)
  const includePool = body.pool !== false

  const started = Date.now()
  const influencers = await backfillInfluencers(limit)
  const mirrored = await mirrorToPool(influencers.idsByGender)
  const pool = includePool ? await backfillPoolOnly(limit) : { scanned: 0, inferred: zeroCounts(), unresolved: 0 }

  const summary = {
    limit,
    scanned: influencers.scanned,
    inferred: influencers.inferred,
    unresolved: influencers.unresolved,
    mirrored,
    pool,
    elapsedMs: Date.now() - started,
  }
  console.log('[backfill-gender]', JSON.stringify(summary))
  return NextResponse.json(summary)
}
