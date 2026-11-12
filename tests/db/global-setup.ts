/**
 * Starts a throwaway PostgreSQL (real binaries, no Docker) with the schema of
 * prisma/schema.prisma and points DATABASE_URL at it for the test workers.
 * The data directory lives under tests/.pgdata and is recreated on every run.
 */
import EmbeddedPostgres from 'embedded-postgres'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const PORT = Number(process.env.TEST_PG_PORT || 54331)
// One data directory per port, so several runs (different TEST_PG_PORT) can coexist
const dataDir = path.resolve(here, '..', '.pgdata', String(PORT))
const URL = `postgresql://tkoc_test:local-only@localhost:${PORT}/tkoc_test`

let pg: EmbeddedPostgres | null = null

export async function setup() {
  fs.rmSync(dataDir, { recursive: true, force: true })
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'tkoc_test', password: 'local-only', port: PORT, persistent: false, onLog: () => {}, onError: () => {} })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('tkoc_test')

  // The schema is applied with an EXPLICIT local URL. prisma.config.ts loads
  // .env through dotenv, which never overrides a variable that is already set.
  const out = execFileSync('npx', ['prisma', 'db', 'push'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: URL },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (!out.includes(`localhost:${PORT}`)) {
    await pg.stop()
    throw new Error('prisma db push did not report the local test database; aborting')
  }
  process.env.DATABASE_URL = URL
}

export async function teardown() {
  if (pg) await pg.stop().catch(() => {})
  fs.rmSync(dataDir, { recursive: true, force: true })
}
