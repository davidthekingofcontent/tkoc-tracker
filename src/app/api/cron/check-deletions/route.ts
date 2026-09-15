import { NextRequest, NextResponse } from 'next/server'
import { cronGate, cronSkipped, markCronRun } from '@/lib/cron-throttle'
import { prisma } from '@/lib/db'
import { notifyCampaignTeam } from '@/lib/notifications'
import { mediaPostKey } from '@/lib/campaign-capture'
import { checkInstagramPostsExist, type PostExistence } from '@/lib/thumb-cache'


/**
 * Cron job: detect posts deleted by their creators (active campaigns).
 *
 * Instagram: the public embed page rendered in headless Chromium (see
 * checkInstagramPostsExist) — the cover image proves the post exists; a 404
 * or an explicit "not available" page says it is gone. A post is marked
 * deleted ONLY after two "missing" verdicts at least 20 h apart (Setting
 * deletion_suspects), never on a login redirect, timeout or empty shell
 * (that heuristic wrongly flagged 74 live posts on 2026-09-12). Posts already
 * marked deleted are re-checked and restored when they turn out to exist.
 * TikTok/YouTube: only an HTTP 404 on the permalink counts as missing.
 *
 * GET /api/cron/check-deletions
 * Authorization: Bearer <CRON_SECRET or JWT_SECRET>
 */
export async function GET(request: NextRequest) {
  // Auth: Bearer token from CRON_SECRET, fallback to JWT_SECRET
  const cronSecret = process.env.CRON_SECRET || process.env.JWT_SECRET
  if (cronSecret) {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const fallback = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (token !== cronSecret && fallback !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // The 24 h stamp is written AFTER the work (finally): stamping first meant a
  // redeploy mid-run skipped the rest until the next day. It is only written
  // when the run finished or at least one post was actually checked.
  let finished = false
  let processed = 0
  try {
    const gate = await cronGate('check-deletions', 24, request.nextUrl.searchParams.get('force') === '1')
    if (!gate.allowed) return NextResponse.json(cronSkipped('check-deletions', gate))

    const startedAt = Date.now()
    const TIME_BUDGET_MS = 270_000
    const MAX_POSTS = Number(process.env.CHECK_DELETIONS_MAX_POSTS || 80)
    const RECHECK_HOURS = 20

    const allMedia = await prisma.media.findMany({
      where: { permalink: { not: null }, campaign: { status: 'ACTIVE' } },
      include: {
        influencer: { select: { id: true, username: true, platform: true } },
        campaign: { select: { id: true, name: true } },
      },
      orderBy: { postedAt: 'desc' },
    })
    if (allMedia.length === 0) {
      finished = true
      return NextResponse.json({ message: 'No media to check', checked: 0, deleted: 0, restored: 0 })
    }

    // One check per post (a post can live in several campaigns)
    const groups = new Map<string, typeof allMedia>()
    for (const m of allMedia) {
      const k = mediaPostKey(m)
      const g = groups.get(k)
      if (g) g.push(m); else groups.set(k, [m])
    }

    const checkedLog = await loadMap('deletion_checked')
    const suspects = await loadMap('deletion_suspects')
    const now = Date.now()
    const recheckMs = RECHECK_HOURS * 3_600_000

    // Never-checked first, then the oldest checks; live posts before deleted ones (the latter only to self-heal)
    const candidates = Array.from(groups.values())
      .filter(copies => copies[0].permalink)
      .filter(copies => { const t = Date.parse(checkedLog[copies[0].permalink as string] || ''); return !Number.isFinite(t) || now - t >= recheckMs })
      .sort((a, b) => Number(a.some(c => c.isDeleted)) - Number(b.some(c => c.isDeleted)))
      .slice(0, MAX_POSTS)

    const ig = candidates.filter(c => c[0].platform === 'INSTAGRAM')
    const other = candidates.filter(c => c[0].platform !== 'INSTAGRAM')

    const verdicts = new Map<string, PostExistence>()
    if (ig.length > 0) {
      const res = await checkInstagramPostsExist(ig.map(c => c[0].permalink as string), { timeBudgetMs: TIME_BUDGET_MS - (Date.now() - startedAt) })
      for (const [k, v] of res) verdicts.set(k, v)
    }
    for (const copies of other) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      verdicts.set(copies[0].permalink as string, await headExists(copies[0].permalink as string))
    }
    processed = verdicts.size

    let checked = 0, deleted = 0, restored = 0, suspected = 0
    const nowIso = new Date().toISOString()
    for (const copies of candidates) {
      const permalink = copies[0].permalink as string
      const verdict = verdicts.get(permalink)
      if (!verdict || verdict === 'unknown') continue
      checked++
      checkedLog[permalink] = nowIso
      const wasDeleted = copies.some(c => c.isDeleted)
      if (verdict === 'exists') {
        delete suspects[permalink]
        if (wasDeleted) {
          await prisma.media.updateMany({ where: { id: { in: copies.map(c => c.id) } }, data: { isDeleted: false, deletedAt: null } })
          restored++
          console.log(`[Cron/CheckDeletions] Restored (exists): ${permalink}`)
        }
        continue
      }
      if (wasDeleted) continue
      const firstSeen = Date.parse(suspects[permalink] || '')
      if (!Number.isFinite(firstSeen)) { suspects[permalink] = nowIso; suspected++; continue }
      if (now - firstSeen < recheckMs) { suspected++; continue }
      await prisma.media.updateMany({ where: { id: { in: copies.map(c => c.id) } }, data: { isDeleted: true, deletedAt: new Date() } })
      delete suspects[permalink]
      deleted++
      const username = copies[0].influencer?.username || 'Unknown'
      const campaignNames = Array.from(new Set(copies.map(c => c.campaign?.name).filter(Boolean))) as string[]
      const campaignIds = Array.from(new Set(copies.map(c => c.campaign?.id).filter(Boolean))) as string[]
      // Only the teams of the campaigns that hold this post (creator + assigned PMs)
      await notifyCampaignTeam(campaignIds, {
        type: 'post_deleted',
        title: 'Post eliminado detectado',
        message: `⚠️ El influencer @${username} ha eliminado un post de ${campaignNames.length > 1 ? 'las campañas' : 'la campaña'} ${campaignNames.join(', ') || 'Unknown'}`,
        link: copies[0].campaign?.id ? `/campaigns/${copies[0].campaign.id}` : undefined,
      })
      console.log(`[Cron/CheckDeletions] Deleted (missing twice): ${permalink} by @${username}`)
    }
    await saveMap('deletion_checked', prune(checkedLog, 7))
    await saveMap('deletion_suspects', prune(suspects, 14))

    const summary = { success: true, candidates: candidates.length, checked, deleted, restored, suspected, unknown: candidates.length - checked, durationMs: Date.now() - startedAt }
    console.log('[Cron/CheckDeletions]', JSON.stringify(summary))
    finished = true
    return NextResponse.json(summary)
  } catch (error) {
    console.error('[Cron/CheckDeletions] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    if (finished || processed > 0) await markCronRun('check-deletions')
  }
}

export const maxDuration = 300

type IsoMap = Record<string, string>
async function loadMap(key: string): Promise<IsoMap> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } })
    const parsed = row?.value ? JSON.parse(row.value) as unknown : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as IsoMap) : {}
  } catch { return {} }
}
async function saveMap(key: string, map: IsoMap): Promise<void> {
  const value = JSON.stringify(map)
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }).catch(() => {})
}
function prune(map: IsoMap, days: number): IsoMap {
  const cutoff = Date.now() - days * 86_400_000
  return Object.fromEntries(Object.entries(map).filter(([, iso]) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= cutoff }))
}

/** TikTok / YouTube: only a hard 404 counts; redirects and errors are unknown. */
async function headExists(permalink: string): Promise<PostExistence> {
  try {
    const response = await fetch(permalink, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TKOCBot/1.0)' } })
    if (response.status === 200) return 'exists'
    if (response.status === 404) return 'missing'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
