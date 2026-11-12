import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: a session secret that signs nothing real, every URL built
// from the production address, and no Apify token in the environment.
const h = vi.hoisted(() => {
  process.env.JWT_SECRET = 'rehearsal-secret-write-layer-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
  return {
    /** Every scraper of @/lib/apify that was called (it must stay empty). */
    scrapers: [] as string[],
    /** Every e-mail function that was called (it must stay empty). */
    mails: [] as string[],
    /** Host and path of every request that tried to leave this process (never the query: Apify's carries the token). */
    blocked: [] as string[],
  }
})

// The scrapers are replaced by functions that record the call and fail: a
// preview must never read anything from Apify
vi.mock('@/lib/apify', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apify')>()
  const guarded: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function' && name.startsWith('scrape')) {
      guarded[name] = () => {
        h.scrapers.push(name)
        throw new Error(`the scraper must not be called in this rehearsal: ${name}`)
      }
    }
  }
  return { ...actual, ...guarded }
})
// Nobody gets an e-mail from a rehearsal
vi.mock('@/lib/email', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/email')>()
  const guarded: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      guarded[name] = () => {
        h.mails.push(name)
        throw new Error(`no e-mail may be sent in this rehearsal: ${name}`)
      }
    }
  }
  return { ...actual, ...guarded }
})

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { createGrantAndCode, exchangeCode, registerClient } from '@/lib/mcp/oauth'
import { setPlatformTransport } from '@/lib/mcp/platform-client'
import { WRITE_TOOLS } from '@/lib/mcp/tools/write'
import { projectRevalidation } from '@/lib/mcp/tools/write/campaigns'
import * as mcpRoute from '@/app/api/mcp/route'
import { createPlatformRouter } from '../helpers/platform-router'

/**
 * The write layer of the MCP connector on REAL-SIZED data: the local copy of
 * production that carries this branch's schema (the six mcp_* tables).
 *
 *   REHEARSAL_DATABASE_URL=postgresql://…@localhost:54329/<the copy with the mcp tables> \
 *     npx vitest run --project rehearsal rehearsal/mcp-write-local-copy.test.ts
 *
 * Every call goes through the real route handler of /api/mcp with a real
 * access token, exactly as Claude sends it; the platform calls of the write
 * tools go to the real route handlers in-process (tests/helpers/platform-router.ts).
 * It runs, in order: tools/list, one read, one safe write (an internal note on
 * a creator of a campaign), the FIRST step of a paid tool (launch_campaign_tracking:
 * only the preview) and the FIRST step of a destructive tool
 * (remove_creator_from_campaign: only the pending action).
 *
 * No network: fetch is replaced by one that throws, every Apify scraper and
 * every e-mail function by one that records the call and fails, and the run
 * asserts that none was called.
 *
 * What it writes in the copy, and deletes at the end: one temporary ADMIN
 * user, its client, grant, tokens, call log lines and pending action, the note
 * and the notifications the note sent to the campaign team. Nothing else of
 * the copy is changed.
 *
 * MCP_REHEARSAL_REPORT=<file> also writes the figures as JSON.
 */

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const MCP_TABLES = ['mcp_clients', 'mcp_grants', 'mcp_auth_codes', 'mcp_tokens', 'mcp_call_logs', 'mcp_pending_actions']
const NOTE_TEXT = 'Nota de ensayo del conector en la copia local (se borra al terminar).'

const made = { userId: '', userName: '', clientId: '', grantId: '', noteId: '' }
const router = createPlatformRouter()
let accessToken = ''
let rpcId = 0

interface Measure {
  call: string
  ms: number
  chars: number
  isError: boolean
}
const measures: Measure[] = []

async function post(message: Record<string, unknown>) {
  const request = new Request('https://intelligence.thekingofcontent.agency/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  })
  const started = performance.now()
  const response = await mcpRoute.POST(request)
  const body = await response.text()
  return { status: response.status, body, ms: Math.round(performance.now() - started) }
}

async function callTool(label: string, name: string, args: Record<string, unknown>) {
  const res = await post({ id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  expect(res.status, label).toBe(200)
  const result = (JSON.parse(res.body) as { result: { isError?: boolean; content: { type: string; text: string }[] } }).result
  const text = result.content[0].text
  measures.push({ call: label, ms: res.ms, chars: text.length, isError: result.isError === true })
  expect(result.isError ?? false, `${label}: ${text.slice(0, 400)}`).toBe(false)
  return { text, data: JSON.parse(text) as Record<string, unknown> }
}

const routed = (method: string, pattern: string) => router.calls.filter(c => c.method === method && c.pattern === pattern).length

beforeAll(async () => {
  // The copy must carry this branch's tables: checked before anything is written
  const present = await prisma.$queryRawUnsafe<Record<string, string | null>[]>(
    `select ${MCP_TABLES.map(t => `to_regclass('public.${t}')::text as "${t}"`).join(', ')}`,
  )
  const missing = MCP_TABLES.filter(t => !present[0][t])
  if (missing.length) throw new Error(`This database has no ${missing.join(', ')}: it is not the copy of this branch. Nothing was written.`)

  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    try {
      const url = new URL(String(input instanceof Request ? input.url : input))
      h.blocked.push(`${url.host}${url.pathname}`)
    } catch {
      h.blocked.push('(unparseable)')
    }
    throw new Error('network access is not allowed in this rehearsal')
  }))
  setPlatformTransport(router.transport)

  const tag = randomUUID().slice(0, 8)
  made.userName = `Ensayo MCP escritura ${tag}`
  const user = await prisma.user.create({
    data: { email: `rehearsal-mcp-write-${tag}@correo-inventado.test`, password: await hashPassword(randomUUID()), name: made.userName, role: 'ADMIN' },
    select: { id: true },
  })
  made.userId = user.id
  const client = await registerClient({ client_name: 'Claude (ensayo de escritura)', redirect_uris: [CLAUDE_CALLBACK] }, `rehearsal-write-${tag}`)
  made.clientId = client.client_id
  const verifier = randomSecret()
  const { grantId, code } = await createGrantAndCode({
    userId: user.id, clientId: client.client_id, redirectUri: CLAUDE_CALLBACK, codeChallenge: pkceChallengeS256(verifier),
  })
  made.grantId = grantId
  const tokens = await exchangeCode(new URLSearchParams({ code, client_id: client.client_id, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK }))
  accessToken = tokens.access_token
})

afterAll(async () => {
  setPlatformTransport(null)
  vi.unstubAllGlobals()
  if (made.noteId) await prisma.campaignNote.deleteMany({ where: { id: made.noteId } })
  if (made.userName) {
    // The note's notice to the campaign team is sent without waiting: give it a moment, then remove it
    await new Promise(resolve => setTimeout(resolve, 1500))
    await prisma.notification.deleteMany({ where: { message: { contains: made.userName } } })
  }
  if (made.grantId) {
    await prisma.mcpPendingAction.deleteMany({ where: { grantId: made.grantId } })
    await prisma.mcpCallLog.deleteMany({ where: { grantId: made.grantId } })
    await prisma.mcpToken.deleteMany({ where: { grantId: made.grantId } })
  }
  if (made.clientId) {
    await prisma.mcpAuthCode.deleteMany({ where: { clientId: made.clientId } })
    await prisma.mcpGrant.deleteMany({ where: { clientId: made.clientId } })
    await prisma.mcpClient.deleteMany({ where: { clientId: made.clientId } })
  }
  if (made.userId) {
    await prisma.notification.deleteMany({ where: { userId: made.userId } })
    await prisma.user.deleteMany({ where: { id: made.userId } })
  }
})

describe('MCP write tools on the local copy of production data', () => {
  it('lists every tool, reads, writes a note, and stops the paid and the destructive tool at their first step', async () => {
    const hello = await post({ id: ++rpcId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rehearsal', version: '0' } } })
    expect(hello.status).toBe(200)

    // 1. tools/list: how many and how large, as Claude receives it
    const listed = await post({ id: ++rpcId, method: 'tools/list' })
    expect(listed.status).toBe(200)
    const tools = (JSON.parse(listed.body) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools
    expect(tools).toHaveLength(8 + WRITE_TOOLS.length)
    const toolSizes = tools.map(t => ({ name: t.name, chars: JSON.stringify(t).length })).sort((a, b) => b.chars - a.chars)
    const toolsList = { tools: tools.length, readTools: tools.filter(t => t.annotations?.readOnlyHint === true).length, bodyChars: listed.body.length, toolsJsonChars: JSON.stringify(tools).length, largest: toolSizes.slice(0, 5) }

    // The campaign to work on: an active one with creators, Dorco's if there is one
    const candidates = await prisma.campaign.findMany({
      where: { status: 'ACTIVE', influencers: { some: {} } },
      select: { id: true, name: true, _count: { select: { influencers: true } } },
      orderBy: { createdAt: 'desc' },
    })
    expect(candidates.length, 'an active campaign with creators').toBeGreaterThan(0)
    const campaign = candidates.find(c => /dorco/i.test(c.name)) ?? [...candidates].sort((a, b) => b._count.influencers - a._count.influencers)[0]
    const member = await prisma.campaignInfluencer.findFirstOrThrow({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, influencerId: true, influencer: { select: { username: true } } },
    })
    const scrapeJobsBefore = await prisma.scrapeJob.count({ where: { campaignId: campaign.id } })

    // 2. A read
    const read = await callTool('list_campaigns (limit 5)', 'list_campaigns', { limit: 5 })
    const readItems = (read.data.campaigns as { items: unknown[]; total: number })

    // 3. A safe write: an internal note on a creator of that campaign
    const notesBefore = await prisma.campaignNote.count({ where: { campaignId: campaign.id, influencerId: member.influencerId } })
    const note = await callTool('add_creator_note', 'add_creator_note', { campaignId: campaign.id, influencerId: member.influencerId, text: NOTE_TEXT })
    expect(note.data.saved).toBe(true)
    made.noteId = String(note.data.noteId)
    const stored = await prisma.campaignNote.findUniqueOrThrow({ where: { id: made.noteId } })
    expect(stored).toMatchObject({ campaignId: campaign.id, influencerId: member.influencerId, userId: made.userId })
    expect(stored.text.startsWith(NOTE_TEXT)).toBe(true)
    expect(await prisma.campaignNote.count({ where: { campaignId: campaign.id, influencerId: member.influencerId } })).toBe(notesBefore + 1)
    const noteLog = await prisma.mcpCallLog.findFirstOrThrow({ where: { grantId: made.grantId, tool: 'add_creator_note' } })

    // 4. A paid tool, first step only: the preview and a token, nothing read from Apify, no run.
    // launch_campaign_tracking refuses a campaign without rules, or one whose final revalidation would
    // take pieces out (fix of 12 Nov 2026): it is rehearsed on the first active campaign it accepts
    let trackable: (typeof candidates)[number] | null = null
    for (const c of [campaign, ...candidates.filter(x => x.id !== campaign.id)]) {
      const projected = await projectRevalidation(c.id)
      if (projected.hasTargets && projected.leave === 0) {
        trackable = c
        break
      }
    }
    expect(trackable, 'an active campaign the tracking tool accepts').not.toBeNull()
    const trackedId = (trackable as (typeof candidates)[number]).id
    const trackJobsBefore = await prisma.scrapeJob.count({ where: { campaignId: trackedId } })
    const tracking = await callTool('launch_campaign_tracking (1st step)', 'launch_campaign_tracking', { campaignId: trackedId })
    expect(tracking.data.needsConfirmation).toBe(true)
    expect(String(tracking.data.confirmToken)).toMatch(/\S{20,}/)
    expect(String(tracking.data.preview)).toContain('Rastrear ahora')
    expect(routed('POST', '/api/campaigns/[id]/track')).toBe(0)
    expect(await prisma.scrapeJob.count({ where: { campaignId: campaign.id } })).toBe(scrapeJobsBefore)
    expect(await prisma.scrapeJob.count({ where: { campaignId: trackedId } })).toBe(trackJobsBefore)
    const trackingLog = await prisma.mcpCallLog.findFirstOrThrow({ where: { grantId: made.grantId, tool: 'launch_campaign_tracking' } })

    // 5. A destructive tool, first step only: a pending action, the creator stays
    const removal = await callTool('remove_creator_from_campaign (1st step)', 'remove_creator_from_campaign', { campaignId: campaign.id, influencerId: member.influencerId })
    expect(removal.data.needsApproval).toBe(true)
    expect(String(removal.data.approveUrl)).toBe(`https://intelligence.thekingofcontent.agency/mcp/confirmar/${String(removal.data.actionId)}`)
    const pending = await prisma.mcpPendingAction.findUniqueOrThrow({ where: { id: String(removal.data.actionId) } })
    expect(pending).toMatchObject({ grantId: made.grantId, userId: made.userId, tool: 'remove_creator_from_campaign', status: 'pending', confirmation: 'destructive' })
    expect(routed('DELETE', '/api/campaigns/[id]/influencers')).toBe(0)
    expect(await prisma.campaignInfluencer.count({ where: { id: member.id } })).toBe(1)
    const removalLog = await prisma.mcpCallLog.findFirstOrThrow({ where: { grantId: made.grantId, tool: 'remove_creator_from_campaign' } })

    // Nothing left the process: no scraper, no e-mail, and every write went through the platform's own routes
    expect(h.scrapers).toEqual([])
    expect(h.mails).toEqual([])
    const writes = router.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.pattern} ${c.status}`)
    expect(writes).toEqual([`POST /api/campaigns/[id]/notes 201`])
    expect(await prisma.mcpCallLog.count({ where: { grantId: made.grantId } })).toBe(4)

    const report = {
      database: (await prisma.$queryRawUnsafe<{ db: string }[]>('select current_database() as db'))[0].db,
      toolsList,
      campaign: { id: campaign.id, members: campaign._count.influencers, isDorco: /dorco/i.test(campaign.name) },
      read: { tool: 'list_campaigns', returned: readItems.items.length, total: readItems.total },
      safeWrite: { tool: 'add_creator_note', answer: { ...note.data, text: undefined }, log: noteLog.argsSummary },
      moneyFirstStep: { tool: 'launch_campaign_tracking', needsConfirmation: tracking.data.needsConfirmation, preview: tracking.data.preview, validForMinutes: tracking.data.validForMinutes, log: trackingLog.argsSummary },
      destructiveFirstStep: { tool: 'remove_creator_from_campaign', needsApproval: removal.data.needsApproval, preview: removal.data.preview, validForMinutes: removal.data.validForMinutes, pendingStatus: pending.status, log: removalLog.argsSummary },
      platformCalls: router.calls.map(c => `${c.method} ${c.pattern} ${c.status}`),
      scrapersCalled: h.scrapers,
      mailsSent: h.mails,
      blockedRequests: [...new Set(h.blocked)],
      measures,
    }
    console.table(measures)
    console.log(JSON.stringify(report, null, 1))
    if (process.env.MCP_REHEARSAL_REPORT) fs.writeFileSync(process.env.MCP_REHEARSAL_REPORT, JSON.stringify(report, null, 1))
  })
})
