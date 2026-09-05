import { prisma } from '@/lib/db'
import { scrapeProfile, scrapeStories, isApifyExhausted } from '@/lib/apify'
import type { ScrapedPost, ScrapedStory } from '@/lib/apify'
import type { MediaType, Platform } from '@/generated/prisma/client'
import { computeBaseline } from '@/lib/creator-baseline'

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
 *       (normalized: lowercase, accents stripped, spaces/dots/_/-// removed).
 *       Rows from Meta's tagged edge (source 'meta_api') carry the tagged
 *       brand's handle in mentions[], so the same rule applies to them.
 *
 * Content a PM attaches by hand (source 'manual') is exempt from rule (3)
 * ONLY — the PM asserts relevance — but rules (1) and (2) still apply.
 *
 * A post counts in EVERY campaign whose rules it satisfies: there is one Media
 * row per (post, campaign) — unique on (externalId, platform, campaignId).
 * The date window and the creator's membership decide, never the order in
 * which campaigns were scraped. Rows a PM attached by hand ('manual') are
 * never re-tagged by a scrape.
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
  // meta_api rows carry the tagged brand's handle in mentions[] (written by
  // meta-materialize), so rule (3) is evaluated the same way for every source:
  // a post tagging @vileda.es never lands in another brand's campaign.
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

type ClaimDecision =
  | { kind: 'create' }
  | { kind: 'claim'; rowId: string }   // this campaign's row, or an unattached one → update + attach
  | { kind: 'refresh'; rowId: string } // this campaign's row is manual → metrics only

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

/**
 * Instagram shortcode from any permalink variant (/p/, /reel/, /tv/). The same
 * post gets a different externalId from Apify (numeric pk) and from the Meta
 * Graph API (media id), so externalId alone cannot dedupe across sources —
 * the shortcode in the permalink is the only shared key.
 */
export function instagramShortcode(permalink: string | null | undefined): string | null {
  if (!permalink) return null
  const m = permalink.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/)
  return m ? m[1] : null
}

/**
 * Identity of a POST across its per-campaign copies and across sources:
 * Instagram shortcode when available (Apify and Meta give the same post
 * different externalIds), else externalId, else the row id.
 */
export function mediaPostKey(row: { id: string; externalId: string | null; platform: string; permalink: string | null }): string {
  const sc = row.platform === 'INSTAGRAM' ? instagramShortcode(row.permalink) : null
  if (sc) return `${row.platform}|sc:${sc}`
  if (row.externalId) return `${row.platform}|${row.externalId}`
  return `id|${row.id}`
}

/** Keep the first row of every distinct post (see mediaPostKey). */
export function dedupeMediaByPost<T extends { id: string; externalId: string | null; platform: string; permalink: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(r => {
    const k = mediaPostKey(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Existing Media row for the same post found via a different source (e.g. a
 * meta_api row materialized before Apify saw the post), limited to THIS
 * campaign's row or an unattached one — rows of other campaigns are their own
 * legitimate copies. Instagram only — other platforms share ids across sources.
 */
export async function findMediaBySameLink(
  platform: Platform,
  permalink: string | null | undefined,
  campaignId: string
): Promise<{ id: string; externalId: string | null; campaignId: string | null; source: string; likes: number; comments: number } | null> {
  if (platform !== 'INSTAGRAM') return null
  const code = instagramShortcode(permalink)
  if (!code) return null
  return prisma.media.findFirst({
    where: {
      platform,
      permalink: { contains: `/${code}` },
      OR: [{ campaignId }, { campaignId: null }],
    },
    orderBy: { campaignId: { sort: 'desc', nulls: 'last' } },
    select: { id: true, externalId: true, campaignId: true, source: true, likes: true, comments: true },
  })
}

/**
 * Which row a scrape for `campaignId` should write:
 *   claim   → this campaign already has a row for the post (refresh + keep
 *             attached), or an unattached row exists (attach it here)
 *   refresh → this campaign's row is 'manual': metrics only, keep source
 *   create  → no row for this campaign yet (other campaigns' rows don't matter)
 */
async function decideClaim(
  externalId: string,
  platform: Platform,
  campaignId: string
): Promise<ClaimDecision> {
  const ours = await prisma.media.findFirst({
    where: { externalId, platform, campaignId },
    select: { id: true, source: true },
  })
  if (ours) return ours.source === 'manual' ? { kind: 'refresh', rowId: ours.id } : { kind: 'claim', rowId: ours.id }
  const loose = await prisma.media.findFirst({
    where: { externalId, platform, campaignId: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  if (loose) return { kind: 'claim', rowId: loose.id }
  return { kind: 'create' }
}

export async function upsertCampaignPost(
  campaignId: string,
  influencerId: string,
  platform: Platform,
  post: ScrapedPost
): Promise<boolean> {
  if (!post.externalId) return false
  const metrics = {
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
    saves: post.saves,
    views: post.views,
  }
  /**
   * Public counts may only RAISE what we hold. Apify returns 0 for shares and
   * saves (not public) and can lag on views, and a PM may have registered the
   * creator's real statistics (insightsSource) — a refresh must never lower or
   * wipe them. Reach/impressions are never touched here (Apify has none).
   */
  const raiseOnly = async (rowId: string) => {
    const row = await prisma.media.findUnique({
      where: { id: rowId },
      select: { likes: true, comments: true, shares: true, saves: true, views: true },
    })
    if (!row) return metrics
    return {
      likes: Math.max(row.likes, post.likes || 0),
      comments: Math.max(row.comments, post.comments || 0),
      shares: Math.max(row.shares, post.shares || 0),
      saves: Math.max(row.saves, post.saves || 0),
      views: Math.max(row.views, post.views || 0),
    }
  }
  const freshRuleInputs = {
    ...(post.caption ? { caption: post.caption } : {}),
    ...(post.hashtags?.length ? { hashtags: post.hashtags } : {}),
    ...(post.mentions?.length ? { mentions: post.mentions } : {}),
    ...(toDate(post.postedAt) ? { postedAt: toDate(post.postedAt) } : {}),
  }
  try {
    const decision = await decideClaim(post.externalId, platform, campaignId)
    switch (decision.kind) {
      case 'refresh':
        await prisma.media.update({ where: { id: decision.rowId }, data: await raiseOnly(decision.rowId) })
        return true
      case 'claim':
        await prisma.media.update({
          where: { id: decision.rowId },
          data: { ...(await raiseOnly(decision.rowId)), ...freshRuleInputs, campaignId },
        })
        return true
      case 'create': {
        // Same post already stored for this campaign under another source's
        // externalId (Meta materialized it first)? Upgrade that row instead of
        // creating a twin that would double-count in the campaign.
        const twin = await findMediaBySameLink(platform, post.permalink, campaignId)
        if (twin) {
          if (twin.source === 'manual') {
            // A detached manual row may be re-claimed by this campaign (rules
            // 1-3 were just proven by the caller); keep source 'manual'.
            await prisma.media.update({
              where: { id: twin.id },
              data: { ...(await raiseOnly(twin.id)), ...(twin.campaignId ? {} : { campaignId }) },
            })
            return true
          }
          await prisma.media.update({
            where: { id: twin.id },
            data: {
              // Apify's public counts can be fresher than a stale Meta sync
              ...(await raiseOnly(twin.id)),
              ...freshRuleInputs,
              ...(post.thumbnailUrl ? { thumbnailUrl: post.thumbnailUrl } : {}),
              ...(post.mediaUrl ? { mediaUrl: post.mediaUrl } : {}),
              campaignId,
            },
          })
          return true
        }
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
    }
  } catch (err) {
    // A concurrent pass created this campaign's row between our lookup and the
    // create: it exists now, the next run will refresh it.
    if (!isUniqueViolation(err)) {
      console.error('[campaign-capture] post upsert failed:', err instanceof Error ? err.message : err)
    }
    return false
  }
}

/** Tolerance for matching the same story across sources by publish time. */
export const STORY_TWIN_TOLERANCE_MS = 5 * 60 * 1000

/**
 * An existing STORY row of the same creator in this campaign (or unattached)
 * published within ±5 minutes: the Meta story_mention webhook and the Apify
 * stories scraper give the same story different ids, so time is the only key.
 */
export async function findStoryTwin(
  campaignId: string,
  influencerId: string,
  postedAt: Date | null,
  excludeExternalId?: string | null
): Promise<{ id: string; externalId: string | null; views: number; mentions: string[]; campaignId: string | null } | null> {
  if (!postedAt) return null
  return prisma.media.findFirst({
    where: {
      influencerId,
      platform: 'INSTAGRAM',
      mediaType: 'STORY',
      postedAt: { gte: new Date(postedAt.getTime() - STORY_TWIN_TOLERANCE_MS), lte: new Date(postedAt.getTime() + STORY_TWIN_TOLERANCE_MS) },
      OR: [{ campaignId }, { campaignId: null }],
      ...(excludeExternalId ? { NOT: { externalId: excludeExternalId } } : {}),
    },
    orderBy: { campaignId: { sort: 'desc', nulls: 'last' } },
    select: { id: true, externalId: true, views: true, mentions: true, campaignId: true },
  })
}

export async function upsertCampaignStory(
  campaignId: string,
  influencerId: string,
  story: ScrapedStory
): Promise<boolean> {
  if (!story.externalId) return false
  /**
   * Story views may only RAISE what we hold (same rule as upsertCampaignPost's
   * raiseOnly). Apify cannot see other accounts' story view counts — it reports
   * 0 — and the creator's figure a PM registered from the screenshot
   * (insightsSource) is the ONLY real audience a story can ever have (reach and
   * impressions are never scraped): a re-scrape must never lower or wipe it.
   * Reach/impressions are not touched here.
   */
  const raiseViews = async (rowId: string): Promise<{ views: number }> => {
    const row = await prisma.media.findUnique({ where: { id: rowId }, select: { views: true } })
    return { views: Math.max(row?.views ?? 0, story.views || 0) }
  }
  try {
    const decision = await decideClaim(story.externalId, 'INSTAGRAM', campaignId)
    switch (decision.kind) {
      case 'refresh':
        await prisma.media.update({ where: { id: decision.rowId }, data: await raiseViews(decision.rowId) })
        return true
      case 'claim':
        await prisma.media.update({
          where: { id: decision.rowId },
          data: {
            ...(await raiseViews(decision.rowId)),
            ...(story.mentions?.length ? { mentions: story.mentions } : {}),
            ...(story.hashtags?.length ? { hashtags: story.hashtags } : {}),
            campaignId,
          },
        })
        return true
      case 'create': {
        // The same story may already be here as a Meta story_mention row
        // (webhook): different id space (message id vs IG pk), no shortcode to
        // match on, but the publish time is the same → upgrade that row in
        // place instead of creating a twin.
        const twin = await findStoryTwin(campaignId, influencerId, toDate(story.postedAt))
        if (twin) {
          await prisma.media.update({
            where: { id: twin.id },
            data: {
              externalId: story.externalId,
              permalink: story.permalink ?? undefined,
              ...(story.thumbnailUrl ? { thumbnailUrl: story.thumbnailUrl } : {}),
              ...(story.mediaUrl ? { mediaUrl: story.mediaUrl } : {}),
              views: Math.max(twin.views, story.views || 0),
              mentions: Array.from(new Set([...(twin.mentions || []), ...(story.mentions || [])])),
              ...(story.hashtags?.length ? { hashtags: story.hashtags } : {}),
              campaignId,
            },
          })
          return true
        }
        await prisma.media.create({
          data: {
            externalId: story.externalId,
            platform: 'INSTAGRAM',
            mediaType: 'STORY',
            mediaUrl: story.mediaUrl,
            thumbnailUrl: story.thumbnailUrl,
            permalink: story.permalink ?? null,
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
 * The instant the creator baseline must be sampled BEFORE (decision 2): the
 * earliest of the deal close, the campaign start and the first campaign
 * publication of this member. Never "now" while any of those exists — a late
 * or gifted freeze would otherwise sample the campaign period itself and admit
 * untagged campaign posts into the creator's "normal".
 */
async function baselineBeforeInstant(
  campaign: { id: string; startDate: Date },
  influencerId: string,
  dealClosedAt: Date | null
): Promise<Date> {
  const firstPost = await prisma.media.findFirst({
    where: { campaignId: campaign.id, influencerId, postedAt: { not: null } },
    orderBy: { postedAt: 'asc' },
    select: { postedAt: true },
  })
  // David (decision 2): the baseline is "before the deal". When the deal close is
  // stamped it wins outright — a creator who joins a long campaign late must not be
  // sampled from before the campaign start. Without a stamp (gifted / fee-less
  // deals) we take the earliest defensible instant: campaign start or the first
  // campaign post of this creator, whichever came first; last resort: now.
  if (dealClosedAt instanceof Date && Number.isFinite(dealClosedAt.getTime())) return dealClosedAt
  const candidates = [campaign.startDate, firstPost?.postedAt ?? null]
    .filter((d): d is Date => d instanceof Date && Number.isFinite(d.getTime()))
  if (candidates.length === 0) return new Date()
  return new Date(Math.min(...candidates.map(d => d.getTime())))
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
    const CLOSED = new Set(['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'])
    // A member already POSTED/COMPLETED without a deal-close instant has nothing
    // defensible to anchor the baseline on: leave it to the manual baseline.
    const LATE = new Set(['POSTED', 'COMPLETED'])
    const lateWithoutDeal = LATE.has(membership.status) && !membership.dealClosedAt
    const needsBaseline = CLOSED.has(membership.status) && !membership.baselineAt && !lateWithoutDeal

    const campaign = membership.campaign
    const influencer = membership.influencer

    if (CLOSED.has(membership.status) && !membership.baselineAt && lateWithoutDeal) {
      console.log(`[campaign-capture] baseline not frozen for @${influencer.username} in "${campaign.name}": ${membership.status} without dealClosedAt — PM can enter it manually`)
    }

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

      // ----- Creator baseline (decision 2): frozen once, from THIS scrape, at zero extra cost -----
      if (needsBaseline) {
        try {
          const before = await baselineBeforeInstant(campaign, influencer.id, membership.dealClosedAt)
          const snapshot = computeBaseline(scraped.recentPosts || [], {
            format: membership.negotiatedFormat,
            before,
            isCampaignPost: post => mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post)),
            source: 'apify',
          })
          if (snapshot) {
            await prisma.campaignInfluencer.update({
              where: { campaignId_influencerId: { campaignId, influencerId } },
              data: { baselineSnapshot: snapshot as object, baselineAt: new Date() },
            })
            console.log(`[campaign-capture] baseline frozen for @${influencer.username} in "${campaign.name}": ${snapshot.family} n=${snapshot.n} medianViews=${snapshot.medianViews} medianEng=${snapshot.medianEngagement} before=${before.toISOString()}`)
          } else {
            console.log(`[campaign-capture] baseline not yet available for @${influencer.username} (sample < ${6} eligible posts) — PM can enter it manually`)
          }
        } catch (err) {
          console.error(`[campaign-capture] baseline failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
        }
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
      platform: true,
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
    if (isManual) { result.kept++; continue }

    // Rule (3) only for scraped rows
    if (itemReferencesBrand(campaign, row)) result.kept++
    else toDetach.push(row.id)
  }

  if (toDetach.length > 0) {
    // One row per (post, campaign): if the post still lives in another campaign
    // (or an unattached copy already exists) this copy is redundant → delete it;
    // otherwise keep it as the single unattached copy (campaignId null).
    const byId = new Map(rows.map(r => [r.id, r]))
    for (const rowId of toDetach) {
      const row = byId.get(rowId)!
      const otherCopy = row.externalId
        ? await prisma.media.findFirst({
            where: { externalId: row.externalId, platform: row.platform, id: { not: rowId } },
            select: { id: true },
          })
        : null
      if (otherCopy) {
        await prisma.media.delete({ where: { id: rowId } }).catch(() => {})
      } else {
        await prisma.media.update({ where: { id: rowId }, data: { campaignId: null } }).catch(() => {})
      }
      result.detached++
    }
    console.log(`[campaign-capture] Revalidated campaign ${campaignId}: ${result.kept} kept, ${result.detached} detached`)
  }

  return result
}
