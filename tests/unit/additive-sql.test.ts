import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A schema change may only ADD: until 12 Nov 2026 the build ran
 * `prisma db push --accept-data-loss`, and that push (by hand, or the build of
 * an older commit) still drops whatever the schema it runs with lacks. This
 * guard reads the SQL of the person/profiles change (generated offline from
 * the two schema files) and fails if it ever contains anything that could lose
 * or rewrite existing data.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const UP = path.join(root, 'prisma', 'additive', '2026-11-12-person-profiles.sql')
const DOWN = path.join(root, 'prisma', 'additive', '2026-11-12-person-profiles.down.sql')

/** SQL statements of a script, without comments, whitespace collapsed. */
function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['DROP', /\bDROP\b/i],
  ['RENAME', /\bRENAME\b/i],
  ['ALTER COLUMN', /\bALTER\s+COLUMN\b/i],
  ['TYPE change', /\b(SET\s+DATA\s+)?TYPE\b/i],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/i],
  ['DELETE', /\bDELETE\b(?!\s+(SET|CASCADE|RESTRICT|NO))/i],
  ['UPDATE', /\bUPDATE\b(?!\s+(SET\s+NULL|CASCADE|RESTRICT|NO))/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['INSERT', /\bINSERT\b/i],
]

const ALLOWED: RegExp[] = [
  /^CREATE TABLE "[a-z_]+" \(.+\)$/i,
  /^ALTER TABLE "[a-z_]+" ADD COLUMN "[A-Za-z]+" [A-Z0-9() ]+(, ADD COLUMN "[A-Za-z]+" [A-Z0-9() ]+)*$/i,
  /^CREATE (UNIQUE )?INDEX "[A-Za-z_]+" ON "[a-z_]+"\("[A-Za-z]+"(, "[A-Za-z]+")*\)$/i,
  /^ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[A-Za-z_]+" FOREIGN KEY \("[A-Za-z]+"\) REFERENCES "[a-z_]+"\("[A-Za-z]+"\) ON DELETE SET NULL ON UPDATE CASCADE$/i,
]

/** Why a script is not additive (empty = it is). */
function violations(sql: string): string[] {
  const out: string[] = []
  for (const stmt of statements(sql)) {
    for (const [name, rx] of FORBIDDEN) if (rx.test(stmt)) out.push(`${name}: ${stmt}`)
    if (!ALLOWED.some(rx => rx.test(stmt))) out.push(`not an allowed statement: ${stmt}`)
    // A new column on an existing table must accept the rows that are already there
    if (/^ALTER TABLE .* ADD COLUMN/i.test(stmt) && /\bNOT\s+NULL\b/i.test(stmt)) out.push(`required column: ${stmt}`)
    // An existing table may not get a new unique constraint (existing rows could violate it)
    if (/^CREATE UNIQUE INDEX/i.test(stmt) && !/ ON "(persons|person_logs)"/i.test(stmt)) out.push(`unique index on an existing table: ${stmt}`)
  }
  return out
}

describe('additive SQL of the person/profiles change', () => {
  const up = fs.readFileSync(UP, 'utf8')

  it('contains only CREATE TABLE, ADD COLUMN, CREATE INDEX and ADD FOREIGN KEY', () => {
    expect(statements(up).length).toBeGreaterThan(0)
    expect(violations(up)).toEqual([])
  })

  it('adds exactly the tables, columns, indexes and keys of this delivery', () => {
    const stmts = statements(up)
    const created = stmts.map(s => s.match(/^CREATE TABLE "([a-z_]+)"/i)?.[1]).filter(Boolean).sort()
    expect(created).toEqual(['person_logs', 'persons'])

    const added: string[] = []
    for (const s of stmts) {
      const table = s.match(/^ALTER TABLE "([a-z_]+)" ADD COLUMN/i)?.[1]
      if (!table) continue
      for (const m of s.matchAll(/ADD COLUMN "([A-Za-z]+)" ([A-Z0-9() ]+)/gi)) added.push(`${table}.${m[1]} ${m[2].trim()}`)
    }
    expect(added.sort()).toEqual([
      'campaign_influencers.addedById TEXT',
      'campaign_influencers.addedByName TEXT',
      'influencers.addedById TEXT',
      'influencers.addedByName TEXT',
      'influencers.personId TEXT',
      'media.publishedByInfluencerId TEXT',
    ])

    const indexes = stmts.map(s => s.match(/^CREATE (?:UNIQUE )?INDEX "([A-Za-z_]+)"/i)?.[1]).filter(Boolean).sort()
    expect(indexes).toEqual([
      'influencers_personId_idx',
      'media_publishedByInfluencerId_idx',
      'person_logs_createdAt_idx',
      'person_logs_personId_idx',
    ])

    const keys = stmts.map(s => s.match(/ADD CONSTRAINT "([A-Za-z_]+)" FOREIGN KEY/i)?.[1]).filter(Boolean).sort()
    expect(keys).toEqual(['influencers_personId_fkey', 'media_publishedByInfluencerId_fkey'])
  })

  it('matches prisma/schema.prisma: the new columns exist there and are optional', () => {
    const schema = fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'), 'utf8')
    const model = (name: string): string => {
      const m = schema.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, 'm'))
      expect(m, `model ${name}`).not.toBeNull()
      return m![0]
    }
    expect(model('Person')).toMatch(/@@map\("persons"\)/)
    expect(model('PersonLog')).toMatch(/@@map\("person_logs"\)/)
    for (const field of ['personId', 'addedById', 'addedByName']) expect(model('Influencer')).toMatch(new RegExp(`^\\s+${field}\\s+String\\?`, 'm'))
    for (const field of ['addedById', 'addedByName']) expect(model('CampaignInfluencer')).toMatch(new RegExp(`^\\s+${field}\\s+String\\?`, 'm'))
    expect(model('Media')).toMatch(/^\s+publishedByInfluencerId\s+String\?/m)
    // The member relation keeps deleting content with its creator; the new ones only clear the pointer
    expect(model('Media')).toMatch(/@relation\("MediaMember", fields: \[influencerId\], references: \[id\], onDelete: Cascade\)/)
    expect(model('Media')).toMatch(/@relation\("MediaPublishedBy", fields: \[publishedByInfluencerId\], references: \[id\], onDelete: SetNull\)/)
    expect(model('Influencer')).toMatch(/@relation\(fields: \[personId\], references: \[id\], onDelete: SetNull\)/)
  })

  it('the guard itself rejects anything destructive', () => {
    const bad = [
      'DROP TABLE "media";',
      'ALTER TABLE "media" DROP COLUMN "views";',
      'ALTER TABLE "influencers" RENAME COLUMN "username" TO "handle";',
      'ALTER TABLE "influencers" RENAME TO "profiles";',
      'ALTER TABLE "media" ALTER COLUMN "views" TYPE BIGINT;',
      'ALTER TABLE "media" ALTER COLUMN "views" SET DATA TYPE BIGINT;',
      'ALTER TABLE "media" ALTER COLUMN "campaignId" SET NOT NULL;',
      'ALTER TABLE "media" ADD COLUMN "publishedByInfluencerId" TEXT NOT NULL;',
      'ALTER TABLE "media" ADD COLUMN "x" TEXT, DROP COLUMN "views";',
      'DELETE FROM "media";',
      'UPDATE "media" SET "views" = 0;',
      'TRUNCATE "media";',
      'CREATE UNIQUE INDEX "influencers_username_key" ON "influencers"("username");',
      'ALTER TABLE "media" ADD CONSTRAINT "media_publishedByInfluencerId_fkey" FOREIGN KEY ("publishedByInfluencerId") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      '-- harmless comment\nDROP INDEX "media_externalId_platform_idx";',
    ]
    for (const sql of bad) expect(violations(sql), sql).not.toEqual([])
    // ...and is not fooled by a comment
    expect(violations('-- DROP TABLE "media";\nCREATE INDEX "media_x_idx" ON "media"("views");')).toEqual([])
  })
})

describe('the warning about `prisma db push --accept-data-loss`', () => {
  /** The comment lines of a script, as one text. */
  const header = (sql: string) => sql.split('\n').filter(line => line.startsWith('--')).map(line => line.replace(/^--\s?/, '')).join(' ').replace(/\s+/g, ' ')
  const up = header(fs.readFileSync(UP, 'utf8'))
  const down = header(fs.readFileSync(DOWN, 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

  it('matches the build: the build no longer pushes, and both scripts say so and point at the README', () => {
    // The build of this commit never touches a database (tests/unit/build-script.test.ts has the exact script)
    expect(pkg.scripts.build).not.toMatch(/db\s+push|accept-data-loss/)
    for (const text of [up, down]) {
      expect(text).toMatch(/Until 12 Nov 2026 the build (command was|command ran)/)
      expect(text).toContain('prisma/additive/README.md')
      // ...and neither tells the reader the build of today still pushes
      expect(text).not.toMatch(/The build command is `prisma/)
    }
  })

  it('is still needed: both scripts say that pushing a schema without this delivery drops its tables and columns with their data', () => {
    for (const text of [up, down]) {
      expect(text).toContain('prisma db push --accept-data-loss')
      // The two ways that are still open: a push by hand from an old checkout, and the build of an older commit
      expect(text).toContain('railway run prisma db push')
      expect(text).toMatch(/commit from before 12 Nov 2026 \(its build script still pushes\)/)
      expect(text).toMatch(/Rebase (or merge )?(EVERY|every) branch that can reach production onto this (prisma\/schema\.prisma|schema)/)
      // How to roll back without losing the data: the previous image, or a revert that keeps the schema
      expect(text).toMatch(/redeploy the previous (IMAGE|image) in Railway/)
      expect(text).toMatch(/KEEPS? prisma\/schema\.prisma|keeps prisma\/schema\.prisma/)
    }
    expect(up).toContain('NEVER BUILD OR PUSH A SCHEMA THAT LACKS THIS DELIVERY')
    expect(down).toContain('Never rebuild or push a commit whose schema lacks these models')
  })

  it('the additive script says to apply it by hand and check the columns before the code goes live, and why nothing else will', () => {
    expect(up).toContain('BEFORE THE CODE GOES LIVE, apply this file by hand first and check that the columns exist')
    expect(up).toMatch(/fails\s+without them/)
    // The old build skipped the push silently when it could not reach the database; nobody verified the Railway build did
    expect(up).toContain('db push skipped')
    expect(up).toContain('has not been verified')
    expect(up).toContain('nothing applies this file but a person')
  })

  it('the inverse script no longer tells anyone to deploy the older code with a build', () => {
    expect(down).not.toMatch(/Deploy the code of BEFORE this delivery first:/)
    expect(down).toContain('WITHOUT A BUILD')
  })
})

describe('inverse script', () => {
  const up = fs.readFileSync(UP, 'utf8')
  const down = fs.readFileSync(DOWN, 'utf8')

  it('undoes every object the additive script creates, and nothing else', () => {
    const stmts = statements(down).filter(s => !/^(BEGIN|COMMIT)$/i.test(s))
    const upStmts = statements(up)
    const tables = upStmts.map(s => s.match(/^CREATE TABLE "([a-z_]+)"/i)?.[1]).filter((t): t is string => !!t)
    const indexes = upStmts.map(s => s.match(/^CREATE (?:UNIQUE )?INDEX "([A-Za-z_]+)" ON "([a-z_]+)"/i)).filter((m): m is RegExpMatchArray => !!m)
    const keys = upStmts.map(s => s.match(/^ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([A-Za-z_]+)"/i)).filter((m): m is RegExpMatchArray => !!m)
    const columns: Array<[string, string]> = []
    for (const s of upStmts) {
      const table = s.match(/^ALTER TABLE "([a-z_]+)" ADD COLUMN/i)?.[1]
      if (table) for (const m of s.matchAll(/ADD COLUMN "([A-Za-z]+)"/gi)) columns.push([table, m[1]])
    }

    const expected = new Set<string>()
    for (const t of tables) expected.add(`DROP TABLE "${t}"`)
    for (const [, name, table] of indexes) if (!tables.includes(table)) expected.add(`DROP INDEX "${name}"`)
    for (const [, table, name] of keys) expected.add(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`)
    const dropsByTable = new Map<string, string[]>()
    for (const [table, column] of columns) dropsByTable.set(table, [...(dropsByTable.get(table) ?? []), column])

    const seen = new Set<string>()
    for (const s of stmts) {
      const dropColumns = s.match(/^ALTER TABLE "([a-z_]+)" (DROP COLUMN "[A-Za-z]+"(, DROP COLUMN "[A-Za-z]+")*)$/i)
      if (dropColumns) {
        const dropped = Array.from(dropColumns[2].matchAll(/DROP COLUMN "([A-Za-z]+)"/gi)).map(m => m[1]).sort()
        expect(dropped, s).toEqual([...(dropsByTable.get(dropColumns[1]) ?? [])].sort())
        dropsByTable.delete(dropColumns[1])
        continue
      }
      expect(expected.has(s), `unexpected statement in the inverse script: ${s}`).toBe(true)
      seen.add(s)
    }
    expect(Array.from(expected).filter(s => !seen.has(s))).toEqual([])
    expect(Array.from(dropsByTable.keys())).toEqual([])
  })

  it('is never run automatically: no build or deploy file mentions it', () => {
    for (const file of ['package.json', 'Dockerfile', 'railway.toml', 'prisma.config.ts', path.join('tests', 'package.json')]) {
      const full = path.join(root, file)
      if (!fs.existsSync(full)) continue
      const text = fs.readFileSync(full, 'utf8')
      expect(text, file).not.toMatch(/prisma\/additive|\.down\.sql|person-profiles\.sql/)
    }
  })
})
