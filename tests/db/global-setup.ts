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

/**
 * embedded-postgres registers async-exit-hook, whose `beforeExit` handler ends
 * the process with process.exit(0). vitest reports failed tests by leaving
 * process.exitCode at 1 and letting the process end by itself, so that
 * explicit 0 won: a run with failed db tests exited with code 0 and anything
 * that trusted the exit code believed it had passed (seen 12 Nov 2026:
 * "1 failed", exit 0). From here on an exit that asks for 0 keeps the failure
 * that is waiting in process.exitCode. An exit with any other code is untouched.
 */
let exitCodeKept = false
function keepFailureExitCode() {
  if (exitCodeKept) return
  exitCodeKept = true
  const realExit = process.exit.bind(process)
  process.exit = ((code?: number | string | null) => {
    const waiting = Number(process.exitCode) || 0
    const asked = code === undefined || code === null ? waiting : Number(code) || 0
    return realExit(asked === 0 ? waiting : asked)
  }) as typeof process.exit
}

export async function setup() {
  keepFailureExitCode()
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
