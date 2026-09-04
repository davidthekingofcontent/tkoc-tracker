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
import { mediaMatchesCampaignRules } from '@/lib/campaign-capture'

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

  const rows = await prisma.media.findMany({
    where: { campaignId: { not: null }, source: { not: 'manual' }, externalId: { not: null } },
    orderBy: { postedAt: 'desc' },
  })

  const existing = new Set(rows.map(r => `${r.externalId}|${r.platform}|${r.campaignId}`))
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
      const key = `${row.externalId}|${row.platform}|${c.id}`
      if (existing.has(key)) continue
      candidates++
      byCampaign[c.name] = (byCampaign[c.name] || 0) + 1
      if (dryRun) continue
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, campaignId, createdAt, updatedAt, discoveredAt, ...copy } = row
        await prisma.media.create({ data: { ...copy, campaignId: c.id } })
        existing.add(key)
        created++
      } catch (err) {
        console.error('[Admin/FanOut] create failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  return NextResponse.json({ dryRun, scanned: rows.length, campaigns: campaigns.length, candidates, created, byCampaign })
}
