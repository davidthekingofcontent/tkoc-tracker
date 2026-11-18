/**
 * Gender inference at intake (weekly review of 16 Nov 2026, point 8).
 *
 * Until then only the paid Discover pass and the one-off admin backfill
 * (8 Oct 2026) inferred a gender: 626 creators that entered afterwards had
 * none, so the «Mujer» filter hid them. Now every row that goes through
 * materializeInfluencerIntoPool (each scrape calls it through
 * afterInfluencerUpsert) gets its gender inferred from the PUBLIC NAME when it
 * has none, with genderSource 'inferred', and the pool mirrors it.
 *
 * Rules checked here: only the name (display name, else the handle), never the
 * bio nor the photo; nothing already stored is overwritten (a PM's 'manual'
 * value on the influencer or on the pool creator stands); an ambiguous name
 * stays null; a row without profile data (not pool-worthy) is inferred too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/db'
import { inferMissingInfluencerGender, materializeInfluencerIntoPool } from '@/lib/creator-pool'

const tag = randomUUID().slice(0, 8)
const created: string[] = []

interface Row { username: string; displayName: string | null; bio?: string | null; followers?: number; gender?: string; genderSource?: string }

async function influencer(row: Row) {
  const inf = await prisma.influencer.create({
    data: {
      username: `${row.username}_${tag}`,
      platform: 'INSTAGRAM',
      displayName: row.displayName,
      bio: row.bio ?? 'Madrid',
      followers: row.followers ?? 1200,
      dataSource: 'apify',
      lastScraped: new Date(),
      gender: row.gender,
      genderSource: row.genderSource,
    },
  })
  created.push(inf.id)
  return inf
}

const stored = (id: string) => prisma.influencer.findUniqueOrThrow({ where: { id }, select: { gender: true, genderSource: true } })
const pool = (influencerId: string) =>
  prisma.creatorPlatformProfile.findFirst({ where: { influencerId }, select: { creator: { select: { gender: true, genderSource: true } } } })

beforeAll(async () => {
  await prisma.influencer.deleteMany({ where: { username: { endsWith: `_${tag}` } } })
})

afterAll(async () => {
  await prisma.creatorPlatformProfile.deleteMany({ where: { OR: [{ influencerId: { in: created } }, { username: { endsWith: `_${tag}` } }] } })
  await prisma.creatorProfile.deleteMany({ where: { displayName: { contains: tag } } })
  await prisma.influencer.deleteMany({ where: { id: { in: created } } })
})

describe('materializeInfluencerIntoPool infers the gender of a row that has none', () => {
  it('from the display name, stored as inferred and mirrored onto the pool creator', async () => {
    const inf = await influencer({ username: 'marta_lopez', displayName: `Marta López ${tag}` })
    const outcome = await materializeInfluencerIntoPool(inf.id)
    expect(outcome).not.toBeNull()
    expect(await stored(inf.id)).toEqual({ gender: 'F', genderSource: 'inferred' })
    expect((await pool(inf.id))?.creator).toEqual({ gender: 'F', genderSource: 'inferred' })
  })

  it('from the handle when the display name has no letters', async () => {
    const inf = await influencer({ username: 'carlos.ruiz', displayName: null })
    await materializeInfluencerIntoPool(inf.id)
    expect(await stored(inf.id)).toEqual({ gender: 'M', genderSource: 'inferred' })
  })

  it('never from the bio: a neutral name with a telling bio stays "sin dato"', async () => {
    const inf = await influencer({ username: 'lumen', displayName: `Lumen ${tag}`, bio: 'Mamá de dos, creadora UGC apasionada de la decoración' })
    const outcome = await materializeInfluencerIntoPool(inf.id)
    expect(outcome).not.toBeNull()
    expect(await stored(inf.id)).toEqual({ gender: null, genderSource: null })
    expect((await pool(inf.id))?.creator).toEqual({ gender: null, genderSource: null })
  })

  it('an ambiguous first name stays "sin dato"', async () => {
    const inf = await influencer({ username: 'alex_torres', displayName: `Alex Torres ${tag}` })
    await materializeInfluencerIntoPool(inf.id)
    expect(await stored(inf.id)).toEqual({ gender: null, genderSource: null })
  })

  it('a value set by a PM on the influencer is never overwritten, and travels as manual', async () => {
    const inf = await influencer({ username: 'maria_f', displayName: `María Fernández ${tag}`, gender: 'M', genderSource: 'manual' })
    await materializeInfluencerIntoPool(inf.id)
    expect(await stored(inf.id)).toEqual({ gender: 'M', genderSource: 'manual' })
    expect((await pool(inf.id))?.creator).toEqual({ gender: 'M', genderSource: 'manual' })
  })

  it('a manual value on the pool creator stands while the influencer still gets its inferred one', async () => {
    const inf = await influencer({ username: 'marta_ruiz', displayName: `Marta Ruiz ${tag}` })
    const creator = await prisma.creatorProfile.create({
      data: {
        displayName: `Marta Ruiz ${tag}`,
        primaryPlatform: 'INSTAGRAM',
        gender: 'X',
        genderSource: 'manual',
        platformProfiles: { create: { platform: 'INSTAGRAM', username: inf.username, followers: 1200, influencerId: inf.id } },
      },
    })
    await materializeInfluencerIntoPool(inf.id)
    expect(await stored(inf.id)).toEqual({ gender: 'F', genderSource: 'inferred' })
    expect(await prisma.creatorProfile.findUniqueOrThrow({ where: { id: creator.id }, select: { gender: true, genderSource: true } })).toEqual({ gender: 'X', genderSource: 'manual' })
  })

  it('a row without profile data (not pool-worthy) is inferred all the same', async () => {
    const inf = await influencer({ username: 'laura_perez', displayName: `Laura Pérez ${tag}`, followers: 0 })
    expect(await materializeInfluencerIntoPool(inf.id)).toBeNull()
    expect(await stored(inf.id)).toEqual({ gender: 'F', genderSource: 'inferred' })
    expect(await pool(inf.id)).toBeNull()
  })

  it('a second pass changes nothing (idempotent)', async () => {
    const inf = await influencer({ username: 'paula_g', displayName: `Paula García ${tag}` })
    await materializeInfluencerIntoPool(inf.id)
    const first = await prisma.influencer.findUniqueOrThrow({ where: { id: inf.id }, select: { gender: true, genderSource: true, updatedAt: true } })
    await materializeInfluencerIntoPool(inf.id)
    const second = await prisma.influencer.findUniqueOrThrow({ where: { id: inf.id }, select: { gender: true, genderSource: true, updatedAt: true } })
    expect(second).toEqual(first)
  })
})

describe('inferMissingInfluencerGender', () => {
  it('a value written between the read and the write wins (the guard is gender IS NULL)', async () => {
    const inf = await influencer({ username: 'sofia_race', displayName: `Sofía Martín ${tag}` })
    // A PM sets a value after the caller read the row as null
    await prisma.influencer.update({ where: { id: inf.id }, data: { gender: 'X', genderSource: 'manual' } })
    const fields = await inferMissingInfluencerGender({ id: inf.id, displayName: inf.displayName, username: inf.username, gender: null, genderSource: null })
    expect(fields).toEqual({ gender: 'X', genderSource: 'manual' })
    expect(await stored(inf.id)).toEqual({ gender: 'X', genderSource: 'manual' })
  })

  it('returns what the row already holds without writing', async () => {
    const inf = await influencer({ username: 'ines_kept', displayName: `Inés Vega ${tag}`, gender: 'F', genderSource: 'manual' })
    const before = await prisma.influencer.findUniqueOrThrow({ where: { id: inf.id }, select: { updatedAt: true } })
    expect(await inferMissingInfluencerGender(inf)).toEqual({ gender: 'F', genderSource: 'manual' })
    const after = await prisma.influencer.findUniqueOrThrow({ where: { id: inf.id }, select: { updatedAt: true } })
    expect(after.updatedAt).toEqual(before.updatedAt)
  })
})
