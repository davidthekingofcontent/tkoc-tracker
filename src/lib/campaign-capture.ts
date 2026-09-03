import { prisma } from '@/lib/db'
import { scrapeProfile, scrapeStories, isApifyExhausted } from '@/lib/apify'
import type { ScrapedPost, ScrapedStory } from '@/lib/apify'
import type { MediaType, Platform } from '@/generated/prisma/client'

/**
 * PRECISE CONTENT CAPTURE — the single source of truth for "does this piece
 * of content belong to this campaign?".
 *
 * A Media row belongs to a campaign ONLY IF all three hold:
 *   (1) its creator is a MEMBER of the campaign (CampaignInfluencer row)
 *   (2) it was posted within [startDate, endDate] (endDate null → up to now;
 *       endDate is a date-only value, so its WHOLE day counts);
 *       undated content can't be proven in range → NOT captured
 *   (3) it references the brand: a target account in mentions[], a target
 *       hashtag in hashtags[], or a target keyword inside the caption
 *       (normalized: lowercase, accents stripped, spaces/dots/_/-// removed),
 *       OR it came from Meta's tagged/mention edges (source 'meta_api' is
 *       brand-tagged by construction — rules 1 and 2 still apply).
 *
 * Content a PM attaches by hand (source 'manual') is exempt from rule (3)
 * ONLY — the PM asserts relevance — but rules (1) and (2) still apply.
 *
 * A Media row can belong to at most ONE campaign (global unique on
 * externalId + platform). The automated passes never re-point a row that
 * another campaign already holds and never touch a 'manual' row.
 *
 * A campaign with NO targetAccounts and NO targetHashtags captures NOTHING
 * from scraped sources — the UI warns the PM to configure targets.
 */

export interface CampaignRules {
  targetAccounts: string[]
  targetHashtags: string[]
  startDate: Date
  endDate: Date | null
}

export interface RuleItem {
  caption: string | null
  hashtags: string[]
  mentions: string[]
  postedAt: Date | null
  source?: string
}

/** Minimum normalized keyword length for fuzzy (substring) caption matching.
 *  Shorter targets (e.g. "@hp") only match as exact @mention / #hashtag, so a
 *  two-letter brand never matches random words inside a caption. */
const MIN_FUZZY_KEYWORD_LENGTH = 3

/** lowercase, strip accents, remove spaces/dots/underscores/hyphens/slashes */
export function normalizeBrandToken(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritics (accents)
    .replace(/[\s._\-/]/g, '')
}

function stripSigil(s: string): string {
  return (s || '').trim().replace(/^[@#]+/, '')
}

export function campaignHasTargets(campaign: Pick<CampaignRules, 'targetAccounts' | 'targetHashtags'>): boolean {
  const accounts = (campaign.targetAccounts || []).map(stripSigil).filter(Boolean)
  const hashtags = (campaign.targetHashtags || []).map(stripSigil).filter(Boolean)
  return accounts.length + hashtags.length > 0
}

/**
 * Exclusive upper bound of the campaign window: the start of the UTC day
 * AFTER endDate. The campaign forms send a date-only value that is stored as
 * midnight UTC, so a plain `posted > endDate` would reject (and detach)
 * everything published during the campaign's last day.
 */
export function campaignWindowEndExclusive(endDate: Date | string | null | undefined): Date | null {
  if (!endDate) return null
  const end = endDate instanceof Date ? endDate : new Date(endDate)
  if (Number.isNaN(end.getTime())) return null
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1))
}

/** Rule (2): dated, inside the campaign window (endDate's whole day included). */
export function isWithinCampaignDates(
  campaign: Pick<CampaignRules, 'startDate' | 'endDate'>,
  postedAt: Date | null
): boolean {
  if (!postedAt) return false
  const posted = postedAt instanceof Date ? postedAt : new Date(postedAt)
  if (Number.isNaN(posted.getTime())) return false
  const start = campaign.startDate ? new Date(campaign.startDate) : null
  const endExclusive = campaignWindowEndExclusive(campaign.endDate)
  if (start && posted < start) return false
  if (endExclusive && posted >= endExclusive) return false
  return true
}

/** Rule (3): the item references one of the campaign's brand targets. */
export function itemReferencesBrand(
  campaign: Pick<CampaignRules, 'targetAccounts' | 'targetHashtags'>,
  item: Pick<RuleItem, 'caption' | 'hashtags' | 'mentions'>
): boolean {
  const targetAccounts = new Set(
    (campaign.targetAccounts || []).map(a => normalizeBrandToken(stripSigil(a))).filter(Boolean)
  )
  const targetHashtags = new Set(
    (campaign.targetHashtags || []).map(h => normalizeBrandToken(stripSigil(h))).filter(Boolean)
  )
  if (targetAccounts.size === 0 && targetHashtags.size === 0) return false

  const mentions = (item.mentions || []).map(m => normalizeBrandToken(stripSigil(m))).filter(Boolean)
  const hashtags = (item.hashtags || []).map(h => normalizeBrandToken(stripSigil(h))).filter(Boolean)

  // Exact matches: @mention ↔ target account, #hashtag ↔ target hashtag
  for (const m of mentions) if (targetAccounts.has(m)) return true
  for (const h of hashtags) if (targetHashtags.has(h)) return true

  // Keyword match on the normalized text (caption + tags), so "PC Componentes"
  // in a caption matches the target "pccomponentes" and "#viledaespaña"
  // matches "#vileda". Guarded by a minimum keyword length.
  const haystack = normalizeBrandToken(
    [item.caption || '', ...(item.hashtags || []), ...(item.mentions || [])].join(' ')
  )
  if (!haystack) return false
  for (const kw of [...targetAccounts, ...targetHashtags]) {
    if (kw.length >= MIN_FUZZY_KEYWORD_LENGTH && haystack.includes(kw)) return true
  }
  return false
}

/**
 * Rules (2) and (3). Rule (1) — membership — is enforced by the callers
 * (captureMemberContent / revalidateCampaignMedia / the track routes).
 */
export function mediaMatchesCampaignRules(campaign: CampaignRules, item: RuleItem): boolean {
  if (!isWithinCampaignDates(campaign, item.postedAt)) return false
  if (item.source === 'meta_api') return true // brand-tagged by construction
  return itemReferencesBrand(campaign, item)
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function scrapedPostToRuleItem(post: Pick<ScrapedPost, 'caption' | 'hashtags' | 'mentions' | 'postedAt'>): RuleItem {
  return {
    caption: post.caption ?? null,
    hashtags: post.hashtags || [],
    mentions: post.mentions || [],
    postedAt: toDate(post.postedAt),
    source: 'apify',
  }
}

export function scrapedStoryToRuleItem(story: Pick<ScrapedStory, 'hashtags' | 'mentions' | 'postedAt'>): RuleItem {
  return {
    caption: null,
    hashtags: story.hashtags || [],
    mentions: story.mentions || [],
    postedAt: toDate(story.postedAt),
    source: 'apify',
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers (shared by the track routes)
// ---------------------------------------------------------------------------

type ClaimDecision = 'create' | 'claim' | 'refresh' | 'skip'

/**
 * Ownership guard for the automated passes. A Media row can belong to at
 * most ONE campaign, so a scrape run for campaign B must never re-point a row
 * that campaign A already holds (otherwise two campaigns sharing a creator
 * flip the row back and forth on every run), and a row a PM attached by hand
 * (source 'manual') is never re-claimed or re-tagged by a scrape.
 *
 *   create  → no row yet
 *   claim   → row is unattached (previously detached) or already ours
 *   refresh → ours, but manual: refresh metrics only, keep source/campaign
 *   skip    → held by another campaign, or manual content of another campaign
 */
async function decideClaim(
  externalId: string,
  platform: Platform,
  campaignId: string
): Promise<ClaimDecision> {
  const existing = await prisma.media.findUnique({
    where: { externalId_platform: { externalId, platform } },
    select: { campaignId: true, source: true },
  })
  if (!existing) return 'create'
  if (existing.source === 'manual') return existing.campaignId === campaignId ? 'refresh' : 'skip'
  if (existing.campaignId && existing.campaignId !== campaignId) return 'skip'
  return 'claim'
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

/**
 * Upsert a rule-passing scraped post as campaign Media. Never throws.
 * Returns true when the post is (now) attached to this campaign.
 */
export async function upsertCampaignPost(
  campaignId: string,
  influencerId: string,
  platform: Platform,
  post: ScrapedPost
): Promise<boolean> {
  if (!post.externalId) return false
  const where = { externalId_platform: { externalId: post.externalId, platform } }
  const metrics = {
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    saves: post.saves,
    views: post.views,
  }
  try {
    const decision = await decideClaim(post.externalId, platform, campaignId)
    switch (decision) {
      case 'skip':
        return false
      case 'refresh':
        await prisma.media.update({ where, data: metrics })
        return true
      case 'claim':
        await prisma.media.update({
          where,
          data: {
            ...metrics,
            // Keep the rule inputs fresh so revalidation judges current data
            ...(post.caption ? { caption: post.caption } : {}),
            ...(post.hashtags?.length ? { hashtags: post.hashtags } : {}),
            ...(post.mentions?.length ? { mentions: post.mentions } : {}),
            ...(toDate(post.postedAt) ? { postedAt: toDate(post.postedAt) } : {}),
            campaignId,
          },
        })
        return true
      case 'create':
        await prisma.media.create({
          data: {
            externalId: post.externalId,
            platform,
            mediaType: post.mediaType as MediaType,
            caption: post.caption,
            mediaUrl: post.mediaUrl,
            thumbnailUrl: post.thumbnailUrl,
            permalink: post.permalink,
            ...metrics,
            hashtags: post.hashtags || [],
            mentions: post.mentions || [],
            postedAt: toDate(post.postedAt),
            influencerId,
            campaignId,
            source: 'apify',
          },
        })
        return true
    }
  } catch (err) {
    // A concurrent pass created the row between our lookup and the create:
    // it is theirs now, the next run will judge it again.
    if (!isUniqueViolation(err)) {
      console.error('[campaign-capture] post upsert failed:', err instanceof Error ? err.message : err)
    }
    return false
  }
}

/**
 * Upsert a rule-passing scraped story as campaign Media (STORY). Never throws.
 * Returns true when the story is (now) attached to this campaign.
 */
export async function upsertCampaignStory(
  campaignId: string,
  influencerId: string,
  story: ScrapedStory
): Promise<boolean> {
  if (!story.externalId) return false
  const where = { externalId_platform: { externalId: story.externalId, platform: 'INSTAGRAM' as Platform } }
  try {
    const decision = await decideClaim(story.externalId, 'INSTAGRAM', campaignId)
    switch (decision) {
      case 'skip':
        return false
      case 'refresh':
        await prisma.media.update({ where, data: { views: story.views } })
        return true
      case 'claim':
        await prisma.media.update({
          where,
          data: {
            views: story.views,
            ...(story.mentions?.length ? { mentions: story.mentions } : {}),
            ...(story.hashtags?.length ? { hashtags: story.hashtags } : {}),
            campaignId,
          },
        })
        return true
      case 'create':
        await prisma.media.create({
          data: {
            externalId: story.externalId,
            platform: 'INSTAGRAM',
            mediaType: 'STORY',
            mediaUrl: story.mediaUrl,
            thumbnailUrl: story.thumbnailUrl,
            views: story.views,
            mentions: story.mentions || [],
            hashtags: story.hashtags || [],
            postedAt: toDate(story.postedAt),
            influencerId,
            campaignId,
            source: 'apify',
          },
        })
        return true
    }
  } catch (err) {
    if (!isUniqueViolation(err)) {
      console.error('[campaign-capture] story upsert failed:', err instanceof Error ? err.message : err)
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Member capture
// ---------------------------------------------------------------------------

export interface CaptureOptions {
  /** Skip the per-member story scrape (the campaign track route batches
   *  stories for all Instagram members in one Apify call instead). */
  skipStories?: boolean
}

/**
 * Scrape one campaign member's profile (+ stories on Instagram) and store
 * ONLY the content that passes the campaign rules. Never throws.
 */
export async function captureMemberContent(
  campaignId: string,
  influencerId: string,
  options: CaptureOptions = {}
): Promise<{ captured: number; skipped: number }> {
  const result = { captured: 0, skipped: 0 }

  try {
    const membership = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId, influencerId } },
      include: {
        influencer: { select: { id: true, username: true, platform: true } },
        campaign: {
          select: { id: true, name: true, targetAccounts: true, targetHashtags: true, startDate: true, endDate: true },
        },
      },
    })
    if (!membership) return result // rule (1): not a member → nothing to capture

    const campaign = membership.campaign
    const influencer = membership.influencer

    if (!campaignHasTargets(campaign)) {
      console.warn(`[campaign-capture] Campaign "${campaign.name}" has no target accounts/hashtags — nothing captured for @${influencer.username}`)
      return result
    }

    if (isApifyExhausted()) {
      console.warn(`[campaign-capture] Apify exhausted — skipping capture for @${influencer.username} in "${campaign.name}"`)
      return result
    }

    // ----- Profile + recent posts -----
    let scraped: Awaited<ReturnType<typeof scrapeProfile>> = null
    try {
      scraped = await scrapeProfile(influencer.username, influencer.platform)
    } catch (err) {
      console.error(`[campaign-capture] profile scrape failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
    }

    if (scraped) {
      try {
        await prisma.influencer.update({
          where: { id: influencer.id },
          data: {
            displayName: scraped.displayName,
            bio: scraped.bio,
            avatarUrl: scraped.avatarUrl,
            followers: scraped.followers,
            following: scraped.following,
            postsCount: scraped.postsCount,
            engagementRate: scraped.engagementRate,
            avgLikes: scraped.avgLikes,
            avgComments: scraped.avgComments,
            avgViews: scraped.avgViews,
            isVerified: scraped.isVerified,
            lastScraped: new Date(),
          },
        })
      } catch (err) {
        console.error(`[campaign-capture] influencer refresh failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
      }

      for (const post of scraped.recentPosts || []) {
        if (!post.externalId) { result.skipped++; continue }
        if (!mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post))) { result.skipped++; continue }
        const ok = await upsertCampaignPost(campaign.id, influencer.id, influencer.platform, post)
        if (ok) result.captured++
        else result.skipped++
      }
    }

    // ----- Stories (Instagram only) -----
    if (influencer.platform === 'INSTAGRAM' && !options.skipStories && !isApifyExhausted()) {
      try {
        const storyResults = await scrapeStories([influencer.username], 'INSTAGRAM')
        for (const sr of storyResults) {
          if (sr.username.toLowerCase() !== influencer.username.toLowerCase()) continue
          for (const story of sr.stories) {
            if (!story.externalId) { result.skipped++; continue }
            if (!mediaMatchesCampaignRules(campaign, scrapedStoryToRuleItem(story))) { result.skipped++; continue }
            const ok = await upsertCampaignStory(campaign.id, influencer.id, story)
            if (ok) result.captured++
            else result.skipped++
          }
        }
      } catch (err) {
        console.error(`[campaign-capture] story scrape failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
      }
    }

    console.log(`[campaign-capture] @${influencer.username} in "${campaign.name}": ${result.captured} captured, ${result.skipped} skipped`)
  } catch (err) {
    console.error('[campaign-capture] captureMemberContent failed:', err instanceof Error ? err.message : err)
  }

  return result
}

// ---------------------------------------------------------------------------
// Revalidation
// ---------------------------------------------------------------------------

/**
 * Re-judge every Media row attached to the campaign against the current
 * rules. Rows that no longer qualify are DETACHED (campaignId = null) —
 * never deleted — so a PM can still find them and re-attach manually.
 *
 *   every row         → rules (1) membership + (2) dated inside the window
 *   source 'manual'   → exempt from rule (3) only (a PM asserted relevance)
 *   source 'meta_api' → exempt from rule (3) (brand-tagged by construction)
 *   anything else     → rule (3) as well
 *
 * Stories added by hand before `source` existed carry the schema default
 * 'apify' but no externalId (every scraped/Meta row has one), so a STORY
 * without externalId is treated as manual rather than detached.
 */
export async function revalidateCampaignMedia(campaignId: string): Promise<{ kept: number; detached: number }> {
  const result = { kept: 0, detached: 0 }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      targetAccounts: true,
      targetHashtags: true,
      startDate: true,
      endDate: true,
      influencers: { select: { influencerId: true } },
    },
  })
  if (!campaign) return result

  const memberIds = new Set(campaign.influencers.map(ci => ci.influencerId))

  const rows = await prisma.media.findMany({
    where: { campaignId },
    select: {
      id: true,
      influencerId: true,
      externalId: true,
      mediaType: true,
      caption: true,
      hashtags: true,
      mentions: true,
      postedAt: true,
      source: true,
    },
  })

  const toDetach: string[] = []
  for (const row of rows) {
    // Rules (1) and (2) hold for EVERY row, manual included
    if (!memberIds.has(row.influencerId)) { toDetach.push(row.id); continue }
    if (!isWithinCampaignDates(campaign, row.postedAt)) { toDetach.push(row.id); continue }

    const isManual = row.source === 'manual' || (row.mediaType === 'STORY' && !row.externalId)
    if (isManual || row.source === 'meta_api') { result.kept++; continue }

    // Rule (3) only for scraped rows
    if (itemReferencesBrand(campaign, row)) result.kept++
    else toDetach.push(row.id)
  }

  if (toDetach.length > 0) {
    const BATCH = 500
    for (let i = 0; i < toDetach.length; i += BATCH) {
      const ids = toDetach.slice(i, i + BATCH)
      const updated = await prisma.media.updateMany({
        where: { id: { in: ids }, campaignId },
        data: { campaignId: null },
      })
      result.detached += updated.count
    }
    console.log(`[campaign-capture] Revalidated campaign ${campaignId}: ${result.kept} kept, ${result.detached} detached`)
  }

  return result
}
