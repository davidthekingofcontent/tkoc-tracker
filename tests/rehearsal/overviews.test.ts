/**
 * Golden snapshot of every campaign's figures on the local copy.
 *
 *   GOLDEN=write  → stores the snapshot (run BEFORE a change)
 *   (default)     → compares with the stored snapshot (run AFTER the change)
 *
 * "The figures of campaigns already delivered must not change": with no
 * profile linked, the overview of every campaign has to be identical.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@/lib/db'
import { computeCampaignOverview } from '@/lib/campaign-overview'

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
      expect(current[key], key).toEqual(JSON.parse(JSON.stringify(stable(golden[key]))))
    }
    expect(Object.keys(current).sort()).toEqual(Object.keys(golden).sort())
  })
})
