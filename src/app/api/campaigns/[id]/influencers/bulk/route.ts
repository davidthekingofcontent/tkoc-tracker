import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile, scrapeStories, isApifyConfigured, isApifyExhausted } from '@/lib/apify'
import { parseCreatorHandle } from '@/lib/handles'
import { ensureContact } from '@/lib/contacts'
import {
  captureMemberContent,
  campaignHasTargets,
  mediaMatchesCampaignRules,
  scrapedStoryToRuleItem,
  upsertCampaignStory,
} from '@/lib/campaign-capture'
import type { CampaignRules } from '@/lib/campaign-capture'
import { notifyAllTeam } from '@/lib/notifications'

const MAX_HANDLES = 200
const CONCURRENCY = 3
/** Instagram usernames per batched story scrape (Apify actor limit) */
const STORY_BATCH = 20

type BulkStatus =
  | 'added'
  | 'already_member'
  | 'created_and_added'
  | 'not_found'
  | 'apify_unavailable'
  | 'error'

interface BulkResult {
  handle: string
  username: string
  status: BulkStatus
  error?: string
}

interface ParsedHandle {
  handle: string
  username: string
  platform: Platform
}

/** A creator that became a member during this request → content capture pending */
interface NewMember {
  id: string
  username: string
  platform: Platform
}

interface ProcessOutcome {
  result: BulkResult
  newMember?: NewMember
}

type CampaignForCapture = CampaignRules & { id: string; name: string }

/**
 * Runs `worker` over `items` with at most `limit` in flight at once,
 * preserving input order in the returned array.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function run() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

async function processHandle(
  campaignId: string,
  userId: string,
  parsed: ParsedHandle
): Promise<ProcessOutcome> {
  const { handle, username, platform } = parsed

  try {
    let influencer = await prisma.influencer.findUnique({
      where: { username_platform: { username, platform } },
      select: { id: true, username: true },
    })

    let created = false

    if (!influencer) {
      if (!isApifyConfigured()) {
        return { result: { handle, username, status: 'apify_unavailable', error: 'Apify not configured' } }
      }
      if (isApifyExhausted()) {
        return { result: { handle, username, status: 'apify_unavailable', error: 'Apify monthly limit reached' } }
      }

      const scraped = await scrapeProfile(username, platform)

      if (!scraped) {
        // The scrape itself may have flagged the monthly limit
        if (isApifyExhausted()) {
          return { result: { handle, username, status: 'apify_unavailable', error: 'Apify monthly limit reached' } }
        }
        return { result: { handle, username, status: 'not_found' } }
      }

      // Upsert (not create) so a concurrent worker / prior scrape of the same
      // profile never trips the (username, platform) unique constraint.
      influencer = await prisma.influencer.upsert({
        where: { username_platform: { username, platform } },
        create: {
          username,
          platform,
          displayName: scraped.displayName,
          bio: scraped.bio,
          avatarUrl: scraped.avatarUrl,
          email: scraped.email,
          website: scraped.website,
          followers: scraped.followers,
          following: scraped.following,
          postsCount: scraped.postsCount,
          engagementRate: scraped.engagementRate,
          avgLikes: scraped.avgLikes,
          avgComments: scraped.avgComments,
          avgViews: scraped.avgViews,
          isVerified: scraped.isVerified,
          country: scraped.country,
          city: scraped.city,
          dataSource: 'apify',
          lastScraped: new Date(),
        },
        update: {
          displayName: scraped.displayName,
          bio: scraped.bio,
          avatarUrl: scraped.avatarUrl,
          email: scraped.email || undefined,
          website: scraped.website || undefined,
          followers: scraped.followers,
          following: scraped.following,
          postsCount: scraped.postsCount,
          engagementRate: scraped.engagementRate,
          avgLikes: scraped.avgLikes,
          avgComments: scraped.avgComments,
          avgViews: scraped.avgViews,
          isVerified: scraped.isVerified,
          country: scraped.country || undefined,
          city: scraped.city || undefined,
          lastScraped: new Date(),
        },
        select: { id: true, username: true },
      })
      created = true
    }

    const existingMembership = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId, influencerId: influencer.id } },
      select: { id: true },
    })

    if (existingMembership) {
      return { result: { handle, username: influencer.username, status: 'already_member' } }
    }

    await prisma.campaignInfluencer.create({
      data: {
        campaignId,
        influencerId: influencer.id,
        source: 'manual',
        status: 'PROSPECT',
      },
    })

    await ensureContact(influencer.id, userId)

    // Content capture is NOT started here: it is queued once for all new
    // members (see captureNewMembers) so it runs with bounded concurrency
    // instead of one unbounded Apify run per pasted handle.
    return {
      result: {
        handle,
        username: influencer.username,
        status: created ? 'created_and_added' : 'added',
      },
      newMember: { id: influencer.id, username: influencer.username, platform },
    }
  } catch (error) {
    console.error(`[BulkAdd] Error processing "${handle}":`, error)
    return {
      result: {
        handle,
        username,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    }
  }
}

/**
 * Pull the new members' brand-tagged content into the campaign. Runs AFTER
 * the response so the PM is not kept waiting, but with the same limiter as
 * the membership work: at most CONCURRENCY profile scrapes in flight (never
 * 200 at once), and Instagram stories fetched in one batched Apify call per
 * STORY_BATCH creators instead of one actor run per member. Never throws.
 */
async function captureNewMembers(campaign: CampaignForCapture, newMembers: NewMember[]): Promise<void> {
  if (newMembers.length === 0) return

  if (!campaignHasTargets(campaign)) {
    console.warn(`[BulkAdd] Campaign "${campaign.name}" has no target accounts/hashtags — capture skipped for ${newMembers.length} new member(s)`)
    return
  }

  // ----- Profile + recent posts (bounded) -----
  let captured = 0
  let skipped = 0
  await mapWithConcurrency(newMembers, CONCURRENCY, async (member) => {
    if (isApifyExhausted()) return
    const r = await captureMemberContent(campaign.id, member.id, { skipStories: true })
    captured += r.captured
    skipped += r.skipped
  })

  // ----- Stories (Instagram only, batched) -----
  let storiesCaptured = 0
  const igMembers = newMembers.filter(m => m.platform === 'INSTAGRAM')
  for (let i = 0; i < igMembers.length; i += STORY_BATCH) {
    if (isApifyExhausted()) break
    const batch = igMembers.slice(i, i + STORY_BATCH)
    try {
      const storyResults = await scrapeStories(batch.map(m => m.username), 'INSTAGRAM')
      for (const sr of storyResults) {
        const member = batch.find(m => m.username.toLowerCase() === sr.username.toLowerCase())
        if (!member) continue
        for (const story of sr.stories) {
          if (!story.externalId) continue
          if (!mediaMatchesCampaignRules(campaign, scrapedStoryToRuleItem(story))) continue
          if (await upsertCampaignStory(campaign.id, member.id, story)) storiesCaptured++
        }
      }
    } catch (err) {
      console.error(`[BulkAdd] story scrape failed for campaign "${campaign.name}":`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`[BulkAdd] Capture for "${campaign.name}" (${newMembers.length} new members): ${captured} posts captured, ${skipped} skipped, ${storiesCaptured} stories captured`)
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id: campaignId } = await params

    let body: { handles?: unknown; platform?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const rawHandles = Array.isArray(body.handles)
      ? body.handles.filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : []

    if (rawHandles.length === 0) {
      return NextResponse.json({ error: 'handles must be a non-empty array of strings' }, { status: 400 })
    }

    let defaultPlatform: Platform = 'INSTAGRAM'
    if (body.platform !== undefined && body.platform !== null) {
      if (typeof body.platform !== 'string' || !Object.values(Platform).includes(body.platform as Platform)) {
        return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
      }
      defaultPlatform = body.platform as Platform
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, name: true, targetAccounts: true, targetHashtags: true, startDate: true, endDate: true },
    })
    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // Parse + dedupe on (platform, username), then cap
    const invalid: BulkResult[] = []
    const parsed: ParsedHandle[] = []
    const seen = new Set<string>()

    for (const raw of rawHandles) {
      const handle = raw.trim()
      const { username, platform: urlPlatform } = parseCreatorHandle(handle)
      if (!username) {
        invalid.push({ handle, username: '', status: 'error', error: 'Invalid handle' })
        continue
      }
      const platform: Platform = urlPlatform ?? defaultPlatform
      const key = `${platform}:${username.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      parsed.push({ handle, username, platform })
    }

    const toProcess = parsed.slice(0, MAX_HANDLES)

    const outcomes = await mapWithConcurrency(toProcess, CONCURRENCY, (item) =>
      processHandle(campaignId, session.id, item)
    )

    const processed = outcomes.map(o => o.result)
    const newMembers = outcomes.flatMap(o => (o.newMember ? [o.newMember] : []))

    // Background, bounded: the response does not wait for Apify
    captureNewMembers(campaign, newMembers).catch((err: unknown) => {
      console.error(`[BulkAdd] captureNewMembers failed for campaign ${campaignId}:`, err instanceof Error ? err.message : err)
    })

    const results: BulkResult[] = [...processed, ...invalid]

    let added = 0
    let skipped = 0
    let errors = 0
    for (const r of results) {
      if (r.status === 'added' || r.status === 'created_and_added') added++
      else if (r.status === 'error') errors++
      else skipped++
    }

    if (added > 0) {
      notifyAllTeam({
        type: 'influencer_added',
        title: 'Influencers añadidos',
        message: `${added} influencer${added === 1 ? '' : 's'} añadido${added === 1 ? '' : 's'} a la campaña "${campaign.name}"`,
        link: `/campaigns/${campaignId}`,
      }, session.id).catch(() => {})
    }

    return NextResponse.json({ results, added, skipped, errors, captureQueued: newMembers.length })
  } catch (error) {
    console.error('Bulk add influencers to campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
