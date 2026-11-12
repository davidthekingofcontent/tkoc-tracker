/**
 * The build never touches a database (review of delivery 1, 12 Nov 2026).
 *
 * `npm run build` used to run `prisma db push --accept-data-loss`, which makes
 * the database EQUAL to the schema of the commit being built: a build of an
 * older commit, or a local build pointed at production, dropped the new tables
 * and columns with their data. The Railway build never reached the database
 * (no DATABASE_URL in the Docker build), so dropping the push changes nothing
 * there. Schema changes are applied by hand: prisma/additive/README.md says how.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

describe('npm run build', () => {
  it('is exactly: generate the client, then build Next with the memory it needs', () => {
    expect(pkg.scripts.build).toBe("prisma generate && NODE_OPTIONS='--max-old-space-size=4096' next build")
  })

  it('no script of the application pushes, migrates or resets a database', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).not.toMatch(/db\s+push|accept-data-loss|migrate\s+(deploy|dev|reset)|db\s+execute|force-reset/)
    }
  })

  it('the Docker build only generates the client and runs that script', () => {
    const docker = read('Dockerfile')
    expect(docker).not.toMatch(/db\s+push|accept-data-loss|migrate\s+(deploy|dev|reset)/)
    expect(docker).toContain('RUN npm run build')
  })
})

describe('prisma/additive/README.md: how a schema change reaches production', () => {
  const readme = read('prisma', 'additive', 'README.md')

  it('names every script of the folder', () => {
    for (const file of fs.readdirSync(path.join(root, 'prisma', 'additive')).filter(f => f.endsWith('.sql'))) {
      expect(readme, file).toContain(file)
    }
  })

  it('has the DEPLOY procedure: backup, read-only preview, apply in one transaction, verify, then the code', () => {
    const deploy = readme.slice(readme.indexOf('## DEPLOY'))
    expect(readme).toContain('## DEPLOY')
    const steps = [
      'Backup',
      'npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script',
      'psql "$PROD_URL" -v ON_ERROR_STOP=1 --single-transaction -f prisma/additive/2026-11-12-person-profiles.sql',
      'information_schema.columns',
      'Deploy the code',
    ]
    let at = -1
    for (const step of steps) {
      const next = deploy.indexOf(step, at + 1)
      expect(next, step).toBeGreaterThan(at)
      at = next
    }
    // The verification lists every new column and both tables
    for (const column of ['personId', 'addedById', 'addedByName', 'publishedByInfluencerId']) expect(deploy).toContain(`'${column}'`)
    expect(deploy).toContain("to_regclass('public.persons')")
    expect(deploy).toContain("to_regclass('public.person_logs')")
  })

  it('says SQL first, code second, and how to roll back without losing data', () => {
    expect(readme).toContain('SQL first, code second')
    expect(readme).toContain('Redeploy the previous image in Railway')
    expect(readme).toMatch(/Never run `prisma db push`/)
  })

  it('rolling back: the folds in force are undone BEFORE the previous image (it would create the second members again)', () => {
    const rollback = readme.slice(readme.indexOf('### Rolling back'), readme.indexOf('### A new schema change'))
    const undo = rollback.indexOf('POST /api/admin/fold-twins {"undo": "<logId>"}')
    const list = rollback.indexOf('GET /api/admin/fold-twins')
    const redeploy = rollback.indexOf('Redeploy the previous image in Railway')
    expect(list).toBeGreaterThan(-1)
    expect(undo).toBeGreaterThan(list)
    expect(redeploy).toBeGreaterThan(undo)
    expect(rollback).toContain("create a second member again (`source 'tiktok_link:<id>'`)")
    // The old claim, false once a fold has run
    expect(rollback).not.toContain('nothing is lost')
  })

  it('is never part of a build: the Docker context leaves Markdown out', () => {
    expect(read('.dockerignore').split('\n').map(l => l.trim())).toContain('*.md')
  })
})
