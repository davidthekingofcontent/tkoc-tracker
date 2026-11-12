import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Before any import: the secret that signs sessions, and no public address
// (every URL is built from the production default).
vi.hoisted(() => {
  process.env.JWT_SECRET = 'db-test-secret-activity-route'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
})

import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import * as activityRoute from '@/app/api/oauth/activity/route'
import { ACTIVITY_CALLS_LIMIT, STARTED_STALE_MS, toActivity, type Activity } from '@/components/mcp/activity-api'
import { MCP_GRANT_SCOPE, MCP_RESOURCE, MCP_SCOPE } from '@/lib/mcp/config'
import { claimApprovedAction, createPendingAction, decidePendingAction, PENDING_ACTION_TTL_MS } from '@/lib/mcp/confirm'
import { mintPlatformToken } from '@/lib/mcp/platform-client'
import { idInput } from '@/lib/mcp/tools/shared'
import { defineWriteTool } from '@/lib/mcp/write-tool'

/**
 * GET /api/oauth/activity, the activity part of the card «Conexiones con
 * Claude», with the route handler called directly against the throwaway
 * database. Sessions are REAL ones (a JWT signed like the login does, in the
 * `token` cookie). Fixtures are invented people and invented data.
 */

const tag = randomUUID().slice(0, 8)
const CLAUDE_AI = 'https://claude.ai/api/mcp/auth_callback'
const MINUTE = 60_000

type Role = 'ADMIN' | 'EMPLOYEE' | 'BRAND' | 'CREATOR'
interface TestUser {
  id: string
  name: string
  role: Role
}

const createdUsers: string[] = []

async function makeUser(role: Role, name: string, isActive = true): Promise<TestUser> {
  const user = await prisma.user.create({
    data: { email: `act-${role.toLowerCase()}-${randomUUID()}@correo-inventado.test`, password: 'not-a-real-hash', name, role, isActive },
  })
  createdUsers.push(user.id)
  return { id: user.id, name: user.name, role }
}

/** A grant as after a real connection (both scopes unless said otherwise). */
async function grantFor(userId: string, scope: string = MCP_GRANT_SCOPE): Promise<string> {
  const clientId = `client-${randomUUID()}`
  await prisma.mcpClient.create({ data: { clientId, name: 'Claude', redirectUris: [CLAUDE_AI] } })
  const grant = await prisma.mcpGrant.create({ data: { clientId, userId, scope, resource: MCP_RESOURCE } })
  return grant.id
}

/** The route, as a browser calls it (addressed to a host that is not ours). */
function get(headers: Record<string, string> = {}) {
  return activityRoute.GET(new NextRequest('https://evil.example/api/oauth/activity', { headers }))
}

/** The cookie a browser sends after logging in as this user. */
const cookieOf = (user: { id: string; role: string }) => ({ cookie: `token=${generateToken(user.id, user.role)}` })

async function readAs(user: TestUser): Promise<Activity> {
  const res = await get(cookieOf(user))
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  const body = (await res.json()) as Activity
  // The card accepts the answer exactly as it comes
  expect(toActivity(body)).toEqual(body)
  return body
}

async function wipe() {
  await prisma.mcpPendingAction.deleteMany()
  await prisma.mcpCallLog.deleteMany()
  await prisma.mcpToken.deleteMany()
  await prisma.mcpAuthCode.deleteMany()
  await prisma.mcpGrant.deleteMany()
  await prisma.mcpClient.deleteMany()
}

beforeEach(wipe)

afterAll(async () => {
  await wipe()
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } })
})

describe('route file', () => {
  it('exports only GET, on the Node runtime and never prerendered', () => {
    expect(Object.keys(activityRoute).sort()).toEqual(['GET', 'dynamic', 'runtime'])
    expect(activityRoute.runtime).toBe('nodejs')
    expect(activityRoute.dynamic).toBe('force-dynamic')
  })
})

describe('who may read it', () => {
  it('only an active ADMIN, from the session cookie; everybody else gets an error and no data', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const grantId = await grantFor(ada.id)
    await prisma.mcpCallLog.create({ data: { grantId, userId: ada.id, tool: 'list_campaigns', argsSummary: 'limit=50', ok: true, ms: 10, resultChars: 100 } })

    const expectRefused = async (headers: Record<string, string>, status: number) => {
      const res = await get(headers)
      expect(res.status).toBe(status)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await res.json()
      expect(Object.keys(body)).toEqual(['error'])
    }

    // No session, or not a valid one
    await expectRefused({}, 401)
    await expectRefused({ cookie: 'token=' }, 401)
    await expectRefused({ cookie: 'token=garbage' }, 401)
    await expectRefused({ cookie: `token=${generateToken(ada.id, 'ADMIN')}x` }, 401)
    await expectRefused({ cookie: `other=${generateToken(ada.id, 'ADMIN')}` }, 401)
    // A header is not a session here: neither the admin's own JWT nor the one the connector mints for itself
    await expectRefused({ authorization: `Bearer ${generateToken(ada.id, 'ADMIN')}` }, 401)
    await expectRefused({ authorization: `Bearer ${mintPlatformToken({ userId: ada.id, grantId })}` }, 401)

    // Signed in, but not an administrator
    for (const role of ['EMPLOYEE', 'BRAND', 'CREATOR'] as const) {
      const user = await makeUser(role, `Test ${role}`)
      await expectRefused(cookieOf(user), 403)
      // Claiming ADMIN in the cookie does not make anyone an administrator
      await expectRefused({ cookie: `token=${generateToken(user.id, 'ADMIN')}` }, 401)
    }

    // An administrator who was deactivated
    const gone = await makeUser('ADMIN', 'Admin Desactivado', false)
    await expectRefused(cookieOf(gone), 401)

    // The administrator
    const body = await readAs(ada)
    expect(body.calls).toHaveLength(1)
  })
})

describe('the last calls', () => {
  it('lists the 50 newest of every connection, newest first, with tool, result, when and who, and nothing else', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const bea = await makeUser('ADMIN', 'Bea Admin')
    const grantAda = await grantFor(ada.id)
    const grantBea = await grantFor(bea.id)
    const base = Date.now() - 2 * 60 * MINUTE
    for (let i = 0; i < 55; i++) {
      const mine = i % 2 === 0
      await prisma.mcpCallLog.create({
        data: {
          grantId: mine ? grantAda : grantBea,
          userId: mine ? ada.id : bea.id,
          tool: `tool_${i}`,
          argsSummary: `[none:execute http=200] campaignId=MARCA-SECRETA-${i}`,
          ok: true,
          ms: 25,
          resultChars: 999,
          createdAt: new Date(base + i * 1000),
        },
      })
    }

    const body = await readAs(bea)
    expect(body.calls).toHaveLength(ACTIVITY_CALLS_LIMIT)
    expect(body.calls.map(c => c.tool)).toEqual(Array.from({ length: 50 }, (_, k) => `tool_${54 - k}`))
    for (const call of body.calls) {
      expect(Object.keys(call).sort()).toEqual(['at', 'confirmation', 'httpStatus', 'id', 'kind', 'result', 'tool', 'userName'])
      expect(call).toMatchObject({ kind: 'write', result: 'done', confirmation: 'none', httpStatus: 200 })
    }
    expect(body.calls[0].userName).toBe('Ada Admin') // tool_54
    expect(body.calls[1].userName).toBe('Bea Admin') // tool_53
    expect(body.calls[0].at).toBe(new Date(base + 54 * 1000).toISOString())
    // Never the arguments, the size of the answer or the connection
    const text = JSON.stringify(body)
    for (const leak of ['MARCA-SECRETA', 'argsSummary', 'resultChars', grantAda, grantBea, ada.id, bea.id]) expect(text).not.toContain(leak)
  })

  it('reads every kind of line: reads, refused calls, writes still running or never finished, a deleted administrator', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const ghost = await makeUser('ADMIN', 'Admin Borrado')
    const grantAda = await grantFor(ada.id)
    const grantGhost = await grantFor(ghost.id)
    const now = Date.now()
    const line = (tool: string, argsSummary: string, ok: boolean, msAgo: number, who: TestUser = ada, grantId = grantAda) =>
      prisma.mcpCallLog.create({ data: { grantId, userId: who.id, tool, argsSummary, ok, ms: 5, resultChars: 0, createdAt: new Date(now - msAgo) } })

    await line('read_ok', 'campaignId=c1', true, 9000)
    await line('read_limited', 'not run: rate limit', false, 8000)
    await line('(invalid name)', 'not run: unknown tool or invalid arguments', false, 7000)
    await line('read_failed', 'campaignId=c1', false, 6000)
    await line('write_old', 'started', false, STARTED_STALE_MS + MINUTE)
    await line('write_now', 'started', false, 5000)
    await line('write_paid', '[money:preview http=200] campaignId=c1', true, 4000)
    await line('by_ghost', 'limit=5', true, 3000, ghost, grantGhost)
    await prisma.user.delete({ where: { id: ghost.id } })
    // A name the log should never hold is shown as the fixed label, not dropped
    await line('<b>odd name</b>', 'x=1', false, 60 * MINUTE) // the oldest line

    const { calls } = await readAs(ada)
    expect(calls).toHaveLength(9)
    expect(calls[calls.length - 1]).toMatchObject({ tool: '(invalid name)', result: 'failed' })
    expect(JSON.stringify(calls)).not.toContain('odd name')
    const byTool = new Map(calls.slice(0, -1).map(c => [c.tool, c]))
    expect(byTool.get('read_ok')).toMatchObject({ kind: 'read', result: 'read', confirmation: null })
    expect(byTool.get('read_limited')?.result).toBe('limited')
    expect(byTool.get('(invalid name)')?.result).toBe('invalid')
    expect(byTool.get('read_failed')?.result).toBe('failed')
    expect(byTool.get('write_old')?.result).toBe('unfinished')
    expect(byTool.get('write_now')?.result).toBe('running')
    expect(byTool.get('write_paid')).toMatchObject({ kind: 'write', result: 'preview', confirmation: 'money', httpStatus: 200 })
    expect(byTool.get('by_ghost')?.userName).toBeNull()
  })

  it('reads the lines the real write helper writes', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const grantAda = await grantFor(ada.id)
    const grantOld = await grantFor(ada.id, MCP_SCOPE) // authorised before the write layer: read only

    const note = defineWriteTool({
      name: 'test_activity_note',
      title: 'Nota (prueba)',
      description: 'Writes nothing; answers at once.',
      input: { campaignId: idInput('Campaign id') },
      confirmations: ['none'],
      annotations: { destructiveHint: false },
      summarize: a => ({ campaignId: a.campaignId }),
      plan: async () => ({ confirmation: 'none' }),
      execute: async a => ({ saved: true, campaignId: a.campaignId }),
    })
    const remove = defineWriteTool({
      name: 'test_activity_remove',
      title: 'Quitar (prueba)',
      description: 'Asks for an approval in the platform.',
      input: { campaignId: idInput('Campaign id'), email: z.string().email() },
      confirmations: ['destructive'],
      annotations: { destructiveHint: true },
      summarize: a => ({ campaignId: a.campaignId }),
      plan: async a => ({ confirmation: 'destructive', preview: `Vas a borrar la campaña ${a.campaignId} y avisar a ${a.email}. ¿Confirmas?` }),
      execute: async () => ({ removed: true }),
    })
    const caller = { grantId: grantAda, userId: ada.id }

    expect((await note.call({ campaignId: 'camp_1' }, caller)).isError).toBeUndefined()
    const asked = await remove.call({ campaignId: 'camp_2', email: 'marta@correo-inventado.test' }, caller)
    expect(asked.isError).toBeUndefined()
    expect((await note.call({ campaignId: 'no spaces allowed' }, caller)).isError).toBe(true)
    expect((await note.call({ campaignId: 'camp_3' }, { grantId: grantOld, userId: ada.id })).isError).toBe(true)

    const body = await readAs(ada)
    expect(body.calls.map(c => [c.tool, c.result, c.confirmation])).toEqual([
      ['test_activity_note', 'refused', null],
      ['test_activity_note', 'invalid', null],
      ['test_activity_remove', 'approval', 'destructive'],
      ['test_activity_note', 'done', 'none'],
    ])
    // The action it created waits for Ada, with its link, and the e-mail masked
    expect(body.pending).toHaveLength(1)
    const [pending] = body.pending
    expect(pending).toMatchObject({ tool: 'test_activity_remove', confirmation: 'destructive', status: 'pending', mine: true, ownerName: 'Ada Admin' })
    expect(pending.approvePath).toBe(`/mcp/confirmar/${pending.id}`)
    expect(pending.preview).toContain('[correo oculto]')
    expect(JSON.stringify(body)).not.toContain('marta@correo-inventado.test')
  })
})

describe('actions waiting for a confirmation', () => {
  it('shows the live ones, the viewer’s own first with link and preview, the others only with whose they are; the route changes nothing', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const bea = await makeUser('ADMIN', 'Bea Admin')
    const grantAda = await grantFor(ada.id)
    const grantBea = await grantFor(bea.id)
    const grantClosed = await grantFor(ada.id)
    const now = Date.now()
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4eXoifQ.c2lnbmF0dXJlLW5vdC1yZWFs'

    const make = (who: TestUser, grantId: string, tool: string, confirmation: 'destructive' | 'outbound', preview: string, at = new Date(now)) =>
      createPendingAction({ grantId, userId: who.id, tool, confirmation, args: { tool }, preview }, at)

    // Waiting for Ada (two minutes old) and for Bea (one minute old)
    const adaPending = await make(ada, grantAda, 'delete_list', 'destructive', `Vas a BORRAR la lista «Verano». Token: ${jwtLike}`, new Date(now - 2 * MINUTE))
    const adaOutbound = await make(ada, grantAda, 'invite_creator_to_connect', 'outbound', 'Vas a ENVIAR UN CORREO a nora@correo-inventado.test. ¿Confirmas?', new Date(now - 3 * MINUTE))
    const beaPending = await make(bea, grantBea, 'remove_creator_from_campaign', 'destructive', 'Vas a quitar a @luis de «Otoño».', new Date(now - MINUTE))
    // Confirmed by Ada, waiting for Claude
    const adaApproved = await make(ada, grantAda, 'delete_brand', 'destructive', 'Vas a BORRAR la marca «Ejemplo».', new Date(now - 4 * MINUTE))
    expect((await decidePendingAction({ id: adaApproved.id, deciderId: ada.id, decision: 'approve' })).ok).toBe(true)
    // Not waiting for anybody: cancelled, already run, expired, of a revoked connection
    const denied = await make(ada, grantAda, 'delete_campaign', 'destructive', 'Cancelada.')
    await decidePendingAction({ id: denied.id, deciderId: ada.id, decision: 'deny' })
    const executed = await make(ada, grantAda, 'remove_creators_from_list', 'destructive', 'Ejecutada.')
    await decidePendingAction({ id: executed.id, deciderId: ada.id, decision: 'approve' })
    expect((await claimApprovedAction({ id: executed.id, grantId: grantAda, tool: 'remove_creators_from_list' })).ok).toBe(true)
    const expired = await make(ada, grantAda, 'delete_list', 'destructive', 'Caducada.', new Date(now - PENDING_ACTION_TTL_MS - MINUTE))
    const closed = await make(ada, grantClosed, 'delete_list', 'destructive', 'Conexión revocada.')
    await prisma.mcpGrant.update({ where: { id: grantClosed }, data: { revokedAt: new Date(), revokedReason: 'test' } })
    // The single use of a confirm token (money, bulk) is not an action waiting for anybody
    await prisma.mcpPendingAction.create({
      data: {
        kind: 'token', confirmation: 'money', grantId: grantAda, userId: ada.id, tool: 'launch_campaign_tracking', argsJson: '{}',
        preview: 'Token.', status: 'pending', expiresAt: new Date(now + MINUTE), tokenHash: `hash-${tag}`,
      },
    })
    const before = await prisma.mcpPendingAction.findMany({ orderBy: { id: 'asc' } })

    // ---- As Ada ----
    const asAda = await readAs(ada)
    expect(asAda.pending.map(p => p.id)).toEqual([adaPending.id, adaOutbound.id, adaApproved.id, beaPending.id])
    const [p1, p2, p3, p4] = asAda.pending
    expect(p1).toMatchObject({ tool: 'delete_list', confirmation: 'destructive', status: 'pending', mine: true, ownerName: 'Ada Admin', approvePath: `/mcp/confirmar/${adaPending.id}` })
    expect(p1.preview).toBe('Vas a BORRAR la lista «Verano». Token: [oculto]')
    expect(p1.expiresAt).toBe(adaPending.expiresAt.toISOString())
    expect(p2).toMatchObject({ confirmation: 'outbound', mine: true, preview: 'Vas a ENVIAR UN CORREO a [correo oculto]. ¿Confirmas?' })
    expect(p3).toMatchObject({ tool: 'delete_brand', status: 'approved', mine: true, approvePath: null, preview: 'Vas a BORRAR la marca «Ejemplo».' })
    expect(p4).toMatchObject({ tool: 'remove_creator_from_campaign', mine: false, ownerName: 'Bea Admin', approvePath: null, preview: null })
    const adaText = JSON.stringify(asAda)
    for (const leak of [jwtLike, 'nora@correo-inventado.test', 'quitar a @luis', 'argsJson', 'grantId', 'userId', 'tokenHash', 'Cancelada', 'Ejecutada', 'Caducada', 'Conexión revocada', 'Token.']) {
      expect(adaText).not.toContain(leak)
    }

    // ---- As Bea: her own first, Ada's only say whose they are ----
    const asBea = await readAs(bea)
    expect(asBea.pending.map(p => p.id)).toEqual([beaPending.id, adaPending.id, adaOutbound.id, adaApproved.id])
    expect(asBea.pending[0]).toMatchObject({ mine: true, approvePath: `/mcp/confirmar/${beaPending.id}`, preview: 'Vas a quitar a @luis de «Otoño».' })
    for (const row of asBea.pending.slice(1)) expect(row).toMatchObject({ mine: false, ownerName: 'Ada Admin', approvePath: null, preview: null })
    expect(JSON.stringify(asBea)).not.toContain('Verano')

    // Reading changed nothing (not even the expired one, which the confirmation page would close)
    expect(await prisma.mcpPendingAction.findMany({ orderBy: { id: 'asc' } })).toEqual(before)
    expect((await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('pending')
    expect((await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: closed.id } })).status).toBe('pending')
  })

  it('an EMPLOYEE never sees them', async () => {
    const ada = await makeUser('ADMIN', 'Ada Admin')
    const emp = await makeUser('EMPLOYEE', 'Elena Empleada')
    const grantAda = await grantFor(ada.id)
    await createPendingAction({ grantId: grantAda, userId: ada.id, tool: 'delete_list', confirmation: 'destructive', args: {}, preview: 'Vas a BORRAR la lista «Verano».' })
    const res = await get(cookieOf(emp))
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('Verano')
  })
})
