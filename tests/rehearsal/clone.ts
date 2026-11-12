/**
 * A THROWAWAY CLONE of the local copy, for rehearsals that WRITE.
 *
 * The local copy (REHEARSAL_DATABASE_URL) must stay as it is: overviews.test.ts
 * compares it with a stored snapshot. A rehearsal that adds content therefore
 * works on a clone made on the same local server (CREATE DATABASE … TEMPLATE)
 * and dropped at the end. Nothing here ever writes to the copy itself.
 *
 * This file must not import anything that loads @/lib/db.
 */
import pg from 'pg'

const sourceUrl = new URL(process.env.REHEARSAL_DATABASE_URL || 'postgresql://x@localhost:1/none')
/** The local copy */
export const SOURCE_DB = sourceUrl.pathname.replace(/^\//, '')

function urlOf(database: string): string {
  const u = new URL(sourceUrl.toString())
  u.pathname = `/${database}`
  return u.toString()
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlOf('postgres') })
  await client.connect()
  try { return await run(client) } finally { await client.end() }
}

const COUNTED = ['media', 'influencers', 'campaign_influencers', 'persons', 'person_logs', 'campaigns', 'notifications', 'settings'] as const

/** Row counts of the LOCAL COPY (read-only): taken before and after a rehearsal to prove it was not written. */
export async function countSourceRows(): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: urlOf(SOURCE_DB) })
  await client.connect()
  try {
    await client.query('SET default_transaction_read_only = on')
    const out: Record<string, number> = {}
    for (const table of COUNTED) out[table] = Number((await client.query(`select count(*)::int as n from "${table}"`)).rows[0].n)
    return out
  } finally {
    await client.end()
  }
}

export interface Clone {
  /** Name of the clone database */
  name: string
  /** Its connection URL (same local server, user and password as the copy) */
  url: string
  /** Drops any leftover of a previous run and copies the local copy into the clone */
  create(): Promise<void>
  drop(): Promise<void>
}

/** A clone named `<copy>_<suffix>`. Refuses anything that is not a local database. */
export function cloneOfLocalCopy(suffix: string): Clone {
  const name = `${SOURCE_DB}_${suffix}`
  const safe = (id: string) => /^[a-z0-9_]+$/.test(id)
  return {
    name,
    url: urlOf(name),
    async create() {
      if (!safe(SOURCE_DB) || !safe(name) || !/^(localhost|127\.0\.0\.1)$/.test(sourceUrl.hostname)) {
        throw new Error('Refusing to clone: the rehearsal database must be a local one')
      }
      await admin(async client => {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
        // A template cannot be copied while a session is connected to it: the
        // connections of the previous test file may take a moment to close.
        let lastError: unknown = null
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            await client.query(`CREATE DATABASE "${name}" TEMPLATE "${SOURCE_DB}"`)
            return
          } catch (err) {
            lastError = err
            if ((err as { code?: string }).code !== '55006') break
            await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
        throw new Error(`Could not clone the local copy "${SOURCE_DB}" (is another session connected to it?): ${lastError instanceof Error ? lastError.message : lastError}`)
      })
    },
    async drop() {
      if (!safe(name)) return
      await admin(client => client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))
    },
  }
}
