import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guard of the hand-applied SQL of the MCP connector.
 *
 * The deploy does not push the schema: prisma/additive/2026-11-12-mcp.sql is
 * run by hand against production before the code ships. It may ONLY create
 * the new tables and their indexes. This test fails if the file ever contains
 * a DROP, a RENAME, an ALTER of a table that already exists, or anything else
 * that is not on the short list of allowed statements.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const UP = path.join(root, 'prisma', 'additive', '2026-11-12-mcp.sql')
const DOWN = path.join(root, 'prisma', 'additive', '2026-11-12-mcp.down.sql')
const SCHEMA = path.join(root, 'prisma', 'schema.prisma')

/** The executable part of a SQL file: comments removed, one entry per statement. */
function statements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Every reason why a script is not purely additive for the given new tables. Empty when it is. */
function violations(sql: string, newTables: readonly string[]): string[] {
  const out: string[] = []
  const isNew = (table: string) => newTables.includes(table)
  for (const s of statements(sql)) {
    const short = s.slice(0, 90)
    // Words that have no place in an additive script, wherever they appear
    const banned = /\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE|DO|EXECUTE|COPY|CALL|REFERENCES|CASCADE|TRIGGER|FUNCTION|EXTENSION|SCHEMA|VIEW|RULE|POLICY|OWNER)\b/i.exec(s)
    if (banned) out.push(`"${banned[1]}" in: ${short}`)
    if (/\$/.test(s)) out.push(`dollar quoting in: ${short}`)

    const createTable = /^CREATE TABLE "([^"]+)" \(/i.exec(s)
    const createIndex = /^CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"\s?\((?:"[A-Za-z]+"(?:, )?)+\)$/i.exec(s)
    const alterTable = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT /i.exec(s)
    const target = createTable?.[1] ?? createIndex?.[1] ?? alterTable?.[1]
    if (!target) {
      out.push(`statement that is not CREATE TABLE / CREATE INDEX / ADD CONSTRAINT: ${short}`)
    } else if (!isNew(target)) {
      out.push(`touches a table that is not new ("${target}"): ${short}`)
    }
  }
  return out
}

/** The models of the connector as schema.prisma declares them: table name → column names. */
function connectorModels(): Map<string, string[]> {
  const schema = fs.readFileSync(SCHEMA, 'utf8')
  const models = new Map<string, string[]>()
  for (const m of schema.matchAll(/^model (Mcp\w+) \{\n([\s\S]*?)^\}/gm)) {
    const body = m[2]
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1]
    if (!table) throw new Error(`model ${m[1]} has no @@map`)
    const columns = body
      .split('\n')
      .map(line => /^\s+([a-z]\w*)\s+[A-Z]\w*(\[\])?\??(\s|$)/.exec(line)?.[1])
      .filter((c): c is string => !!c)
    models.set(table, columns)
  }
  return models
}

const NEW_TABLES = ['mcp_clients', 'mcp_grants', 'mcp_auth_codes', 'mcp_tokens', 'mcp_call_logs']

describe('additive SQL of the MCP connector', () => {
  const up = fs.readFileSync(UP, 'utf8')
  const down = fs.readFileSync(DOWN, 'utf8')

  it('only creates the five new tables and their indexes', () => {
    expect(violations(up, NEW_TABLES)).toEqual([])
    const created = statements(up)
      .map(s => /^CREATE TABLE "([^"]+)"/.exec(s)?.[1])
      .filter(Boolean)
    expect(created.sort()).toEqual([...NEW_TABLES].sort())
    expect(statements(up).filter(s => /^CREATE (UNIQUE )?INDEX/.test(s))).toHaveLength(6)
    expect(statements(up)).toHaveLength(11)
  })

  it('contains no DROP, no RENAME and no ALTER at all', () => {
    const executable = statements(up).join(';\n')
    expect(executable).not.toMatch(/\bDROP\b/i)
    expect(executable).not.toMatch(/\bRENAME\b/i)
    expect(executable).not.toMatch(/\bALTER\b/i)
  })

  it('matches the models of schema.prisma: same tables, every field a column', () => {
    const models = connectorModels()
    expect([...models.keys()].sort()).toEqual([...NEW_TABLES].sort())
    for (const [table, columns] of models) {
      const create = statements(up).find(s => s.startsWith(`CREATE TABLE "${table}" (`))
      expect(create, table).toBeTruthy()
      const inSql = [...(create as string).matchAll(/"([A-Za-z]+)" [A-Z]/g)].map(m => m[1]).filter(c => c !== `${table}_pkey`)
      expect(inSql.sort(), table).toEqual([...columns].sort())
    }
    // What the specification asks of each table
    expect(models.get('mcp_clients')).toEqual(['id', 'clientId', 'name', 'redirectUris', 'createdAt', 'lastUsedAt', 'createdFromIp'])
    expect(models.get('mcp_grants')).toEqual(['id', 'clientId', 'userId', 'scope', 'resource', 'createdAt', 'lastUsedAt', 'revokedAt', 'revokedReason'])
    expect(models.get('mcp_auth_codes')).toEqual(['id', 'codeHash', 'clientId', 'userId', 'redirectUri', 'codeChallenge', 'resource', 'scope', 'expiresAt', 'usedAt', 'grantId'])
    expect(models.get('mcp_tokens')).toEqual(['id', 'grantId', 'kind', 'tokenHash', 'expiresAt', 'rotatedAt', 'createdAt'])
    expect(models.get('mcp_call_logs')).toEqual(['id', 'grantId', 'userId', 'tool', 'argsSummary', 'ok', 'ms', 'resultChars', 'createdAt'])
  })

  it('the models are decoupled: no relation to the existing schema', () => {
    const schema = fs.readFileSync(SCHEMA, 'utf8')
    for (const m of schema.matchAll(/^model (Mcp\w+) \{\n([\s\S]*?)^\}/gm)) {
      expect(m[2], m[1]).not.toMatch(/@relation/)
    }
    // And no existing model points at them
    const others = schema.replace(/^model Mcp\w+ \{\n[\s\S]*?^\}/gm, '')
    expect(others).not.toMatch(/\bMcp(Client|Grant|AuthCode|Token|CallLog)\b/)
  })

  it('the guard itself catches what it must', () => {
    const poisoned: string[] = [
      'DROP TABLE "users";',
      'ALTER TABLE "users" ADD COLUMN "mcp" TEXT;',
      'ALTER TABLE "users" ADD CONSTRAINT "x" UNIQUE ("email");',
      'ALTER TABLE "campaigns" RENAME TO "old_campaigns";',
      'ALTER TABLE "mcp_tokens" RENAME COLUMN "kind" TO "type";',
      'ALTER TABLE "mcp_grants" DROP COLUMN "scope";',
      'CREATE TABLE "users_copy" ("id" TEXT NOT NULL);',
      'CREATE INDEX "users_email_idx" ON "users"("email");',
      'CREATE UNIQUE INDEX "mcp_x" ON "campaigns"("name");',
      'ALTER TABLE "mcp_grants" ADD CONSTRAINT "fk" FOREIGN KEY ("userId") REFERENCES "users"("id");',
      'CREATE TABLE "mcp_tokens" ("id" TEXT NOT NULL); DELETE FROM "users";',
      'UPDATE "users" SET "role" = \'ADMIN\';',
      'TRUNCATE "media";',
      'DO $$ BEGIN EXECUTE \'DROP TABLE users\'; END $$;',
      'ALTER TYPE "UserRole" ADD VALUE \'MCP\';',
      'DROP INDEX "users_email_key";',
      'create table "mcp_tokens" ("id" text); drop table "users";',
      'CREATE TABLE "mcp_clients" ("id" TEXT NOT NULL);\n-- harmless comment\nALTER TABLE "users" DROP COLUMN "password";',
    ]
    for (const sql of poisoned) expect(violations(sql, NEW_TABLES), sql).not.toEqual([])
    // A statement hidden in a comment is not executed, so it is not a violation
    expect(violations('-- DROP TABLE "users";\n/* ALTER TABLE "users" */\nCREATE TABLE "mcp_clients" (\n "id" TEXT NOT NULL\n);', NEW_TABLES)).toEqual([])
  })

  it('the rollback drops the five new tables and nothing else', () => {
    const drops = statements(down)
    expect(drops).toHaveLength(5)
    const dropped = drops.map(s => /^DROP TABLE IF EXISTS "([^"]+)"$/.exec(s)?.[1])
    expect([...dropped].sort()).toEqual([...NEW_TABLES].sort())
    expect(drops.join(' ')).not.toMatch(/\bCASCADE\b/i)
  })
})
