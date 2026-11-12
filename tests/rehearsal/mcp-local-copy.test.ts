import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Before any import: a session secret that signs nothing real, every URL built
// from the production address, and no Apify token in the environment.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'rehearsal-secret-not-used-anywhere-else'
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXT_PUBLIC_MCP_BASE_URL
  delete process.env.APIFY_API_KEY
})

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { pkceChallengeS256, randomSecret } from '@/lib/mcp/crypto'
import { createGrantAndCode, exchangeCode, registerClient } from '@/lib/mcp/oauth'
import * as mcpRoute from '@/app/api/mcp/route'

/**
 * The read tools of the MCP connector on REAL-SIZED data: the local copy of
 * production that carries this branch's schema (the five mcp_* tables).
 *
 *   REHEARSAL_DATABASE_URL=postgresql://…@localhost:54329/<the copy with the mcp tables> \
 *     npx vitest run --project rehearsal rehearsal/mcp-local-copy.test.ts
 *
 * Every call goes through the real route handler of /api/mcp with a real
 * access token, exactly as Claude sends it. It measures the size of each
 * answer and how long it took, and checks that nothing private travels.
 *
 * What it writes in the copy, and deletes at the end: one temporary ADMIN
 * user, one client, one grant, its tokens and its call log lines. Nothing
 * else of the copy is changed.
 *
 * No network: fetch is replaced by one that throws. The copy keeps the Apify
 * token in `settings`, and capture_status would otherwise ask Apify with it.
 * So the Apify part of capture_status is measured as «unknown» here.
 *
 * MCP_REHEARSAL_REPORT=<file> also writes the figures as JSON.
 */

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const MCP_TABLES = ['mcp_clients', 'mcp_grants', 'mcp_auth_codes', 'mcp_tokens', 'mcp_call_logs']

/** Keys that must never be in an answer (spec: data minimisation). */
const FORBIDDEN_KEYS = new Set([
  'email', 'phone', 'password', 'passwordHash', 'shippingAddress1', 'shippingAddress2', 'shippingCity', 'shippingPostalCode',
  'address', 'notes', 'businessNotes', 'brief', 'caption', 'bio', 'accessToken', 'refreshToken', 'token', 'tokenHash',
  'inviteToken', 'invitationToken',
])
/** Keys of money and estimates: only inside internalEconomics, and only when asked for. */
const MONEY_KEY = /fee|cost|budget|emv|cpm|cpa|roas|revenue|sales|internalEconomics/i
/** Anything that looks like an e-mail address, anywhere in an answer. */
const EMAIL_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

interface Measure {
  call: string
  status: number
  ok: boolean
  routeMs: number
  toolMs: number | null
  chars: number
  /** Rough tokens for Claude Code's 25,000-token ceiling: JSON runs at about 3 to 4 characters a token. */
  tokensAtMost: number
  truncated: boolean | null
  rows: number | null
}

const made = { userId: '', clientId: '', grantId: '' }
let accessToken = ''
let rpcId = 0
/** Hosts the code tried to reach (never the URL: Apify's carries the token in its query). */
const blockedHosts: string[] = []
const measures: Measure[] = []
const answers: string[] = []

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

/** The envelope of the longest list in an answer, if any. */
function envelope(value: unknown): { truncated: boolean; returned: number } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.truncated === 'boolean' && typeof v.returned === 'number') return { truncated: v.truncated, returned: v.returned }
  for (const child of Object.values(v)) {
    const found = envelope(child)
    if (found) return found
  }
  return null
}

function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => keysOf(v, into))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k)
      keysOf(v, into)
    }
  }
  return into
}

async function callTool(label: string, name: string, args: Record<string, unknown>, economics = false) {
  const before = new Date()
  const res = await post({ id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  expect(res.status, label).toBe(200)
  const result = (JSON.parse(res.body) as { result: { isError?: boolean; content: { type: string; text: string }[] } }).result
  const text = result.content[0].text
  expect(result.isError ?? false, `${label}: ${text.slice(0, 300)}`).toBe(false)
  const parsed = JSON.parse(text) as unknown

  const keys = keysOf(parsed)
  expect(keys.filter(k => FORBIDDEN_KEYS.has(k) || /^shipping/i.test(k)), `${label}: forbidden keys`).toEqual([])
  if (!economics) expect(keys.filter(k => MONEY_KEY.test(k)), `${label}: money keys without includeEconomics`).toEqual([])
  expect(EMAIL_VALUE.exec(text)?.[0] ?? null, `${label}: an e-mail address`).toBeNull()

  const log = await prisma.mcpCallLog.findFirst({
    where: { grantId: made.grantId, tool: name, createdAt: { gte: before } },
    orderBy: { createdAt: 'desc' },
    select: { ok: true, ms: true, resultChars: true },
  })
  expect(log, `${label}: call log line`).toMatchObject({ ok: true, resultChars: text.length })

  const list = envelope(parsed)
  measures.push({
    call: label,
    status: res.status,
    ok: true,
    routeMs: res.ms,
    toolMs: log?.ms ?? null,
    chars: text.length,
    tokensAtMost: Math.ceil(text.length / 3),
    truncated: list?.truncated ?? null,
    rows: list?.returned ?? null,
  })
  answers.push(text)
  return parsed as Record<string, unknown>
}

beforeAll(async () => {
  // The copy must carry this branch's tables: checked before anything is written
  const present = await prisma.$queryRawUnsafe<{ name: string | null }[]>(
    `select ${MCP_TABLES.map(t => `to_regclass('public.${t}')::text as "${t}"`).join(', ')}`,
  )
  const row = present[0] as unknown as Record<string, string | null>
  const missing = MCP_TABLES.filter(t => !row[t])
  if (missing.length) throw new Error(`This database has no ${missing.join(', ')}: it is not the copy of this branch. Nothing was written.`)

  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    try {
      blockedHosts.push(new URL(String(input instanceof Request ? input.url : input)).host)
    } catch {
      blockedHosts.push('(unparseable)')
    }
    throw new Error('network access is not allowed in this rehearsal')
  }))

  const tag = randomUUID().slice(0, 8)
  const user = await prisma.user.create({
    data: { email: `rehearsal-mcp-${tag}@correo-inventado.test`, password: await hashPassword(randomUUID()), name: `Ensayo MCP ${tag}`, role: 'ADMIN' },
    select: { id: true },
  })
  made.userId = user.id
  const client = await registerClient({ client_name: 'Claude (ensayo)', redirect_uris: [CLAUDE_CALLBACK] }, `rehearsal-${tag}`)
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
  vi.unstubAllGlobals()
  if (made.grantId) {
    await prisma.mcpCallLog.deleteMany({ where: { grantId: made.grantId } })
    await prisma.mcpToken.deleteMany({ where: { grantId: made.grantId } })
  }
  if (made.clientId) {
    await prisma.mcpAuthCode.deleteMany({ where: { clientId: made.clientId } })
    await prisma.mcpGrant.deleteMany({ where: { clientId: made.clientId } })
    await prisma.mcpClient.deleteMany({ where: { clientId: made.clientId } })
  }
  if (made.userId) await prisma.user.deleteMany({ where: { id: made.userId } })
})

describe('MCP read tools on the local copy of production data', () => {
  it('answers within the client limits, fast enough and with nothing private', async () => {
    const hello = await post({ id: ++rpcId, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rehearsal', version: '0' } } })
    expect(hello.status).toBe(200)

    // 1. Every campaign (the copy has fewer than the maximum of 200)
    const all = await callTool('list_campaigns (limit 200)', 'list_campaigns', { limit: 200 })
    const items = (all.campaigns as { items: { id: string; pieces: number }[]; total: number }).items
    expect(items.length).toBe(await prisma.campaign.count())
    await callTool('list_campaigns (default limit)', 'list_campaigns', {})

    // The campaign with most pieces, by the tool's own count, cross-checked with the database
    const biggest = [...items].sort((a, b) => b.pieces - a.pieces)[0]
    const byDb = await prisma.media.groupBy({ by: ['campaignId'], where: { campaignId: { not: null } }, _count: { _all: true }, orderBy: { _count: { campaignId: 'desc' } }, take: 1 })
    expect(biggest.id).toBe(byDb[0].campaignId)
    expect(biggest.pieces).toBe(byDb[0]._count._all)

    // 2. Its overview, without and with the internal figures
    const overview = await callTool('get_campaign', 'get_campaign', { campaignId: biggest.id })
    expect(overview.economicsIncluded).toBe(false)
    const withMoney = await callTool('get_campaign (includeEconomics)', 'get_campaign', { campaignId: biggest.id, includeEconomics: true }, true)
    expect(withMoney.economicsIncluded).toBe(true)
    expect((withMoney.internalEconomics as { internal: boolean }).internal).toBe(true)

    // 3. Its publications: the default page and the largest one
    const media50 = await callTool('list_campaign_media (default limit)', 'list_campaign_media', { campaignId: biggest.id })
    const media200 = await callTool('list_campaign_media (limit 200)', 'list_campaign_media', { campaignId: biggest.id, limit: 200 })
    expect((media200.pieces as { total: number }).total).toBe(biggest.pieces)
    expect((media50.pieces as { returned: number }).returned).toBe(Math.min(50, biggest.pieces))

    // Its creators too, the other per-campaign list
    await callTool('list_campaign_creators (limit 200)', 'list_campaign_creators', { campaignId: biggest.id, limit: 200 })

    // 4. The state of the capture
    const capture = await callTool('capture_status', 'capture_status', {})
    expect((capture.apify as { tokenState: string }).tokenState).toBe('unknown') // the network is closed here

    // What the capture jobs really stored in the copy is read, not lost to a shape the tool does not expect
    const stored = new Map(
      (await prisma.setting.findMany({ where: { key: { startsWith: 'cron_' } }, select: { key: true, value: true } })).map(s => [s.key, s.value]),
    )
    const jobs = capture.jobs as { job: string; lastRunStampAt: string | null }[]
    for (const job of jobs) {
      if (stored.get(`cron_${job.job}_last_run`)) expect(job.lastRunStampAt, job.job).toEqual(expect.any(String))
    }
    const rawStories = stored.get('cron_stories_last_result')
    if (rawStories) {
      const raw = JSON.parse(rawStories) as Record<string, unknown>
      const read = capture.storiesLastResult as Record<string, unknown> | null
      expect(read, 'storiesLastResult').not.toBeNull()
      for (const [from, to] of [['usernamesChecked', 'creatorsChecked'], ['totalStories', 'storiesSeen'], ['newStories', 'newStories']] as const) {
        if (typeof raw[from] === 'number') expect(read?.[to], to).toBe(raw[from])
      }
      if (Array.isArray(raw.campaigns)) expect((read?.campaignsScanned as unknown[]).length).toBe(Math.min(50, raw.campaigns.length))
    }
    const rawTikTok = stored.get('cron_tiktok-link_last_result')
    if (rawTikTok) {
      const raw = JSON.parse(rawTikTok) as Record<string, unknown>
      const read = capture.tiktokLinkLastResult as Record<string, unknown> | null
      expect(read, 'tiktokLinkLastResult').not.toBeNull()
      for (const [from, to] of [['handlesScanned', 'handlesRead'], ['linked', 'accountsLinked'], ['videos', 'videosCaptured']] as const) {
        if (typeof raw[from] === 'number') expect(read?.[to], to).toBe(raw[from])
      }
      if (Array.isArray(raw.campaigns)) expect((read?.campaigns as unknown[]).length).toBe(Math.min(50, raw.campaigns.length))
    }

    // Nothing private of that campaign is in any answer: its creators' contact data,
    // the notes and shipping data of their memberships and the captions of its publications
    const members = await prisma.campaignInfluencer.findMany({
      where: { campaignId: biggest.id },
      select: {
        notes: true, shippingName: true, shippingAddress1: true, shippingPhone: true, shippingEmail: true,
        influencer: { select: { email: true, phone: true, bio: true } },
      },
    })
    const captions = await prisma.media.findMany({ where: { campaignId: biggest.id, caption: { not: null } }, select: { caption: true } })
    const secrets = [
      ...members.flatMap(m => [
        m.notes, m.shippingName, m.shippingAddress1, m.shippingPhone, m.shippingEmail,
        m.influencer.email, m.influencer.phone, m.influencer.bio,
      ]),
      ...captions.map(c => c.caption),
    ]
      .filter((s): s is string => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => s.length >= 12)
      .map(s => s.slice(0, 40))
    for (const answer of answers) {
      for (const secret of secrets) expect(answer.includes(secret), 'private text of the campaign in an answer').toBe(false)
    }

    // Claude's limits: about 150,000 characters (claude.ai) and 25,000 tokens (Claude Code)
    for (const m of measures) {
      expect(m.chars, m.call).toBeLessThan(150_000)
      expect(m.tokensAtMost, m.call).toBeLessThan(25_000)
    }

    const report = {
      database: (await prisma.$queryRawUnsafe<{ db: string }[]>('select current_database() as db'))[0].db,
      campaigns: items.length,
      biggestCampaign: { id: biggest.id, pieces: biggest.pieces, members: members.length },
      privateStringsChecked: secrets.length,
      captureSettingsRead: [...stored.keys()].sort(),
      captureJobsWithDate: jobs.filter(j => j.lastRunStampAt).map(j => j.job),
      storiesLastResultRead: capture.storiesLastResult !== null,
      tiktokLinkLastResultRead: capture.tiktokLinkLastResult !== null,
      blockedHosts: [...new Set(blockedHosts)],
      measures,
    }
    console.table(measures)
    console.log(JSON.stringify({ ...report, measures: undefined }))
    if (process.env.MCP_REHEARSAL_REPORT) fs.writeFileSync(process.env.MCP_REHEARSAL_REPORT, JSON.stringify(report, null, 1))
  })
})
