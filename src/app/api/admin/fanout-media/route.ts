/**
 * Admin: one-off "fan-out" after the move to one Media row per (post, campaign).
 *
 * For every attached, non-manual Media row, create a copy in every OTHER
 * ACTIVE campaign whose rules the post satisfies: the creator is a member,
 * the post is inside the campaign's dates and (for scraped rows) it references
 * a brand target. Idempotent: existing (externalId, platform, campaignId) rows
 * are skipped. POST { dryRun?: boolean } — ADMIN only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { mediaMatchesCampaignRules, instagramShortcode } from '@/lib/campaign-capture'

export async function POST(request: NextRequest) {
  const session = await getSession(request)
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (session.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let dryRun = false
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = !!body?.dryRun
  } catch { /* no body */ }

  const campaigns = await prisma.campaign.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true, name: true, startDate: true, endDate: true,
      targetAccounts: true, targetHashtags: true,
      influencers: { select: { influencerId: true } },
    },
  })
  const membersByCampaign = new Map(campaigns.map(c => [c.id, new Set(c.influencers.map(i => i.influencerId))]))

  // Sources: attached, non-manual rows. Skip-set: EVERY attached row (manual
  // included), keyed by externalId AND by Instagram shortcode, because Apify
  // and Meta give the same post different externalIds.
  const attached = await prisma.media.findMany({
    where: { campaignId: { not: null } },
    orderBy: { postedAt: 'desc' },
  })
  const rows = attached.filter(r => r.source !== 'manual' && r.externalId)
  const postKeys = (r: { externalId: string | null; platform: string; permalink: string | null }, campaignId: string) => {
    const keys = [] as string[]
    if (r.externalId) keys.push(`${r.externalId}|${r.platform}|${campaignId}`)
    const sc = r.platform === 'INSTAGRAM' ? instagramShortcode(r.permalink) : null
    if (sc) keys.push(`sc:${sc}|${r.platform}|${campaignId}`)
    return keys
  }
  const existing = new Set(attached.flatMap(r => postKeys(r, r.campaignId!)))
  const byCampaign: Record<string, number> = {}
  let created = 0
  let candidates = 0

  for (const row of rows) {
    const item = {
      caption: row.caption,
      hashtags: row.hashtags,
      mentions: row.mentions,
      postedAt: row.postedAt,
      source: row.source,
    }
    for (const c of campaigns) {
      if (c.id === row.campaignId) continue
      if (!membersByCampaign.get(c.id)?.has(row.influencerId)) continue
      if (!mediaMatchesCampaignRules(c, item)) continue
      const keys = postKeys(row, c.id)
      if (keys.some(k => existing.has(k))) continue
      candidates++
      byCampaign[c.name] = (byCampaign[c.name] || 0) + 1
      if (dryRun) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, campaignId, createdAt, updatedAt, discoveredAt, ...copy } = row
        await prisma.media.create({ data: { ...copy, campaignId: c.id } })
        for (const k of keys) existing.add(k)
        created++
      } catch (err) {
        console.error('[Admin/FanOut] create failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  return NextResponse.json({ dryRun, scanned: rows.length, campaigns: campaigns.length, candidates, created, byCampaign })
}
