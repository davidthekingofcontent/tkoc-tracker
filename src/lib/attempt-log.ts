/**
 * Persistent attempt log: a JSON map id → ISO date kept in one Setting row,
 * so that rows a background job tried recently and could not resolve are not
 * retried on every run (media-enrich: reels whose views Instagram hides;
 * thumb-cache: posts whose embed page shows no image). Pruned on save.
 */

import { prisma } from '@/lib/db'

export type AttemptMap = Record<string, string>

export interface AttemptLogSpec {
  /** Setting key. */
  key: string
  /** An id tried within this window is not retried (unless forced). */
  retryAfterMs: number
  /** Entries older than this are pruned on save. */
  ttlMs: number
  /** Max entries kept (newest first). */
  max: number
}

export async function loadAttempts(spec: AttemptLogSpec): Promise<AttemptMap> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: spec.key } })
    if (!row?.value) return {}
    const parsed = JSON.parse(row.value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AttemptMap) : {}
  } catch {
    return {}
  }
}

export async function saveAttempts(spec: AttemptLogSpec, map: AttemptMap): Promise<void> {
  const cutoff = Date.now() - spec.ttlMs
  const entries = Object.entries(map)
    .filter(([, iso]) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= cutoff })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, spec.max)
  const value = JSON.stringify(Object.fromEntries(entries))
  try {
    await prisma.setting.upsert({ where: { key: spec.key }, update: { value }, create: { key: spec.key, value } })
  } catch (err) {
    console.error(`[attempt-log] could not save ${spec.key}:`, err instanceof Error ? err.message : err)
  }
}

export function attemptedRecently(spec: AttemptLogSpec, map: AttemptMap, id: string): boolean {
  const iso = map[id]
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.now() - t < spec.retryAfterMs
}

/** Ids of `map` tried within the retry window (for `id: { notIn }` filters). */
export function recentlyAttemptedIds(spec: AttemptLogSpec, map: AttemptMap): string[] {
  return Object.keys(map).filter(id => attemptedRecently(spec, map, id))
}
