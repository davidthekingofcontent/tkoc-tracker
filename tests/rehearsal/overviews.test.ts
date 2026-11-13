/**
 * Golden snapshot of every campaign's figures on the local copy.
 *
 *   GOLDEN=write  → stores the snapshot (run BEFORE a change)
 *   (default)     → compares with the stored snapshot (run AFTER the change)
 *
 * "The figures of campaigns already delivered must not change": with no
 * profile linked, the overview of every campaign has to be identical.
 *
 *   REHEARSAL_UNDO_MERGES=1 → first undoes the merges the merge rehearsal
 *                             (merge-and-late.test.ts) leaves on the copy, and
 *                             nothing else (it refuses any other merge): the
 *                             snapshot of before the merges compares with the
 *                             copy as it was. Run merge-and-late.test.ts after
 *                             it to leave the copy merged again.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Nothing here may reach the network (the undo reads and writes the copy only)
vi.mock('@/lib/apify', () => {
  const blocked = (name: string) => vi.fn(async () => { throw new Error(`${name}: the network is mocked in the rehearsal`) })
  return {
    scrapeSinglePost: blocked('scrapeSinglePost'),
    scrapeProfile: blocked('scrapeProfile'),
    scrapeStories: blocked('scrapeStories'),
    scrapeTikTokProfilesBatch: blocked('scrapeTikTokProfilesBatch'),
    isApifyExhausted: vi.fn(() => false),
    isApifyConfiguredAsync: vi.fn(async () => false),
  }
})

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'
import { assertOnTheCopy, rehearsalAdmin, undoRehearsalMerges } from './merge-pairs'

beforeAll(async () => {
  if (process.env.REHEARSAL_UNDO_MERGES !== '1') return
  await assertOnTheCopy()
  const undone = await undoRehearsalMerges(await rehearsalAdmin())
  console.log(`[overviews] undid ${undone} merges of the merge rehearsal before comparing`)
})

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN = process.env.GOLDEN_FILE || path.join(here, '.golden-overviews.json')

/** Keys added by later deliveries are ignored when comparing with an older snapshot. */
const ADDED_KEYS = new Set((process.env.GOLDEN_IGNORE_KEYS || '').split(',').map(k => k.trim()).filter(Boolean))

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !ADDED_KEYS.has(k))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)])
    )
  }
  return value
}

/**
 * The arrays whose order comes from a query without ORDER BY are compared as
 * sets: creators by influencerId, pieces by id, the ids missing a disclosure.
 * An undone merge puts a membership row back as a new heap tuple, so the
 * database may return the same rows in another order.
 */
function unordered(overview: unknown): unknown {
  if (!overview || typeof overview !== 'object') return overview
  const o = JSON.parse(JSON.stringify(overview)) as {
    perInfluencer?: Array<{ influencerId: string }>
    perMedia?: Array<{ id: string }>
    delivery?: { disclosure?: { missingMediaIds?: string[] } }
  }
  o.perInfluencer?.sort((a, b) => a.influencerId.localeCompare(b.influencerId))
  o.perMedia?.sort((a, b) => a.id.localeCompare(b.id))
  o.delivery?.disclosure?.missingMediaIds?.sort()
  return o
}

describe('campaign overviews on the local copy', () => {
  it('are identical to the stored snapshot', async () => {
    const campaigns = await prisma.campaign.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } })
    expect(campaigns.length).toBeGreaterThan(0)
    const now = new Date('2026-11-12T12:00:00Z')
    const current: Record<string, unknown> = {}
    for (const c of campaigns) {
      const o = await computeCampaignOverview(c.id, { now } as never)
      current[`${c.name} [${c.id}]`] = JSON.parse(JSON.stringify(stable(o)))
    }
    if (process.env.GOLDEN === 'write') {
      fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 1))
      console.log(`golden snapshot written: ${campaigns.length} campaigns → ${GOLDEN}`)
      return
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
    for (const key of Object.keys(golden)) {
      expect(unordered(current[key]), key).toEqual(unordered(JSON.parse(JSON.stringify(stable(golden[key])))))
    }
    console.log(`[overviews] ${Object.keys(golden).length} campaigns identical to the snapshot (ignoring ${Array.from(ADDED_KEYS).join(', ') || 'nothing'})`)
    expect(Object.keys(current).sort()).toEqual(Object.keys(golden).sort())
  })
})
