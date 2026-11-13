/**
 * The three merges the owner asked for (13 Nov 2026), shared by the
 * rehearsals that run on the LOCAL COPY of production data:
 *   - merge-and-late.test.ts applies them (and leaves the copy merged);
 *   - overviews.test.ts, with REHEARSAL_UNDO_MERGES=1, undoes them first, so
 *     the copy can be compared with the golden snapshot taken before them.
 * Profiles are addressed by their ids; no creator is named here.
 */
import { prisma } from '@/lib/db'
import { pairKey, undoMerge } from '@/lib/person-merge'
import type { MergeMode } from '@/lib/person-merge'

/** «10.- Vileda - Micros Octubre» and «6.- Vileda - Micros Junio 2026» on the copy */
export const OCTOBER = 'cmtif1vzv0ddg01pcs30xx4jt'
export const JUNE = 'cmtimq4hj0drb01pckz3ecalf'

/** The three merges, in the order they are applied */
export const MERGES: Array<{ label: string; keepId: string; otherId: string; mode: MergeMode }> = [
  // Two real accounts of hers (Instagram and TikTok): the Instagram profile stays, the TikTok one joins her person
  { label: 'pair 1 (Instagram + TikTok)', keepId: 'cmtinc2og0e9q01pcqnfe3dbl', otherId: 'cmvfcj0bg05ss01n0xasm963a', mode: 'link' },
  // Her TikTok handle saved as an Instagram profile (0 followers): absorbed by her real Instagram
  { label: 'pair 2 (wrong handle)', keepId: 'cmvfccjzp05s301n0u7ll8ols', otherId: 'cmtjucf7j0fb601pc27vqoeus', mode: 'absorb' },
  // The same, and the wrong profile is also a member of June: that row moves to the real profile
  { label: 'pair 3 (wrong handle, also in June)', keepId: 'cmvz8umka0cud01nzqcfi1vxh', otherId: 'cmtinbkv40e9a01pc0jcf28lg', mode: 'absorb' },
]

/** Refuses unless the connection is the database named in REHEARSAL_DATABASE_URL (never anything else). */
export async function assertOnTheCopy(): Promise<void> {
  const [{ current }] = await prisma.$queryRaw<Array<{ current: string }>>`select current_database() as current`
  const wanted = new URL(process.env.REHEARSAL_DATABASE_URL || 'postgresql://x@localhost:1/none').pathname.replace(/^\//, '')
  if (current !== wanted) throw new Error(`Refusing to run: connected to "${current}", not to "${wanted}"`)
}

/** The ADMIN of the copy the rehearsal acts as (the oldest active one). */
export async function rehearsalAdmin(): Promise<{ id: string; name: string; email: string }> {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, name: true, email: true } })
  if (!admin) throw new Error('The copy has no active ADMIN user to act as')
  return admin
}

/**
 * Undoes, newest first, the merges in force of the rehearsal's three pairs
 * (a previous run leaves the copy merged). Refuses to touch any other merge.
 * Not forced: when something changed since a merge, it stops and says so.
 * Returns how many merges it undid.
 */
export async function undoRehearsalMerges(actor: { id: string; name: string }): Promise<number> {
  const ours = new Set(MERGES.map(m => pairKey(m.keepId, m.otherId)))
  const live = await prisma.personLog.findMany({ where: { action: 'merge', undoneAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, after: true } })
  let undone = 0
  for (const log of live) {
    const pair = (log.after as { pair?: [string, string] } | null)?.pair
    if (!pair || !ours.has(pairKey(pair[0], pair[1]))) throw new Error(`The copy holds a merge this rehearsal did not make (${log.id}): refusing to touch it`)
    await undoMerge(log.id, actor)
    undone++
  }
  return undone
}
