import { prisma } from '@/lib/db'
import { scrapeProfile, scrapeStories, isApifyExhausted } from '@/lib/apify'
import type { ScrapedPost, ScrapedStory } from '@/lib/apify'
import type { MediaType, Platform, Prisma } from '@/generated/prisma/client'
import { computeBaseline } from '@/lib/creator-baseline'
import { afterInfluencerUpsert, scrapedProfileUpdate } from '@/lib/influencer-upsert'
import { accountCoreStems, captionWords, keywordNeedles, normalizeStem, tagCarriesKeyword, textTokens, tokensContain, tokensContainWords } from '@/lib/campaign-targets'
import { campaignWindowEndExclusive, isHandAddedRow, keepsLateHandAddedRow, lateCopyElsewhere } from '@/lib/assignment-rules'

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
 *       The brand NAME inside a qualified target handle counts too
 *       ('@vileda.es' → 'vileda'): a mention or hashtag starting with it, or
 *       the name as a whole word in the caption (2026-10-08, doc item 6 —
 *       TikTok handles differ from Instagram's and TikTok mentions are cut
 *       at the dot). Only a lead segment of 5+ letters that is not an
 *       everyday/qualifier word ('@casa.decor', '@hola.com', '@nike_spain'
 *       derive nothing). See accountCoreStems in campaign-targets.ts.
 *       Rows from Meta's tagged edge (source 'meta_api') carry the tagged
 *       brand's handle in mentions[], so the same rule applies to them.
 *
 * Content a PM attaches by hand (source 'manual') is exempt from rule (3)
 * — the PM asserts relevance — and rules (1) and (2) still apply, with ONE
 * exception to (2) (Nov 2026, src/lib/assignment-rules.ts): a piece added by
 * hand up to LATE_ACCEPT_MAX_DAYS after the end, for a member who still owed
 * one, counts in the campaign marked late («fuera de plazo», team only).
 * Nothing before the start ever counts, and the automatic capture never files
 * anything after the end.
 *
 * A post counts in EVERY campaign whose rules it satisfies: there is one Media
 * row per (post, campaign) — unique on (externalId, platform, campaignId).
 * The date window and the creator's membership decide, never the order in
 * which campaigns were scraped. Rows a PM attached by hand ('manual') are
 * never re-tagged by a scrape. A LATE piece is the exception: it counts in
 * one campaign only, so no automatic path files it in another campaign
 * (findLateCopyElsewhere).
 *
 * A campaign with NO targetAccounts and NO targetHashtags captures NOTHING
 * from scraped sources — the UI warns the PM to configure targets.
 */

export interface CampaignRules {
  targetAccounts: string[]
  targetHashtags: string[]
  /**
   * Product keywords ("Flection System"): searched as whole words in the
   * content of the campaign's creators, never scraped as hashtags/mentions.
   * Optional so a caller that did not select the column simply has none.
   */
  targetKeywords?: string[] | null
  startDate: Date
  endDate: Date | null
}

export interface RuleItem {
  caption: string | null
  hashtags: string[]
  mentions: string[]
  postedAt: Date | null
  source?: string
  /** Stories only: decoded link stickers */
  links?: string[]
  /** Stories only: feed posts/reels shared into the story (IG media ids / shortcodes) */
  resharedMediaIds?: string[]
  resharedShortcodes?: string[]
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

/**
 * Canonical form of a campaign's target list (accounts or hashtags), as it is
 * STORED and as it is SENT to the scrapers: one token per element, no leading
 * @/#, trimmed, lowercase, de-duplicated, empties dropped. A PM typing
 * "#vileda #viledaturbo" or "h2pro, spin" in one field yields two targets —
 * before 2026-09-14 that string reached Apify as ONE hashtag (a wasted run
 * per tick). Handles are case-insensitive on every platform, so lowercase is
 * safe for accounts too.
 */
export function normalizeTargets(values: string[]): string[] {
  const out = new Set<string>()
  for (const value of Array.isArray(values) ? values : []) {
    for (const token of String(value ?? '').split(/[\s,]+/)) {
      const clean = stripSigil(token).toLowerCase()
      if (clean) out.add(clean)
    }
  }
  return Array.from(out)
}

/** Confirmed statuses whose creators are scanned for stories (pay-per-run actor): the PM must set them. */
export const STORY_SCAN_STATUSES = ['AGREED', 'CONTRACTED', 'SHIPPING', 'POSTED', 'COMPLETED'] as const

/**
 * Safety cap on a campaign's length for the stories scan. Listening campaigns
 * are excluded by TYPE (David 2026-09-14: the annual contracts campaign was the
 * bulk of the stories bill); at 62 days this cap silently dropped "Macros
 * Septiembre" and its 13 creators the day a PM extended it to 67 (Oct 2026).
 */
export const STORIES_MAX_CAMPAIGN_DAYS = Number(process.env.STORIES_MAX_CAMPAIGN_DAYS || 100)

export type StoriesSkipReason = 'window' | 'listening' | 'no_targets' | 'too_long'

/** Length of the campaign window in days, null without both dates. */
export function campaignSpanDays(campaign: Pick<CampaignRules, 'startDate' | 'endDate'>): number | null {
  const start = campaign.startDate ? new Date(campaign.startDate).getTime() : NaN
  const end = campaign.endDate ? new Date(campaign.endDate).getTime() : NaN
  const days = Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 86_400_000 : NaN
  return Number.isFinite(days) ? Math.round(days) : null
}

/**
 * The ONE eligibility rule for the stories scan, shared by the stories cron
 * and the watchdog so they can never disagree: null when the campaign is
 * scanned today, else why it is not.
 */
export function storiesCampaignSkipReason(
  campaign: Pick<CampaignRules, 'startDate' | 'endDate' | 'targetAccounts' | 'targetHashtags' | 'targetKeywords'> & { type: string },
  now: Date = new Date()
): StoriesSkipReason | null {
  if (!isWithinCampaignDates(campaign, now)) return 'window'
  if (campaign.type === 'SOCIAL_LISTENING') return 'listening'
  if (!campaignHasTargets(campaign)) return 'no_targets'
  const days = campaignSpanDays(campaign)
  if (days === null || days > STORIES_MAX_CAMPAIGN_DAYS) return 'too_long'
  return null
}

export function campaignHasTargets(campaign: Pick<CampaignRules, 'targetAccounts' | 'targetHashtags' | 'targetKeywords'>): boolean {
  const accounts = (campaign.targetAccounts || []).map(stripSigil).filter(Boolean)
  const hashtags = (campaign.targetHashtags || []).map(stripSigil).filter(Boolean)
  return accounts.length + hashtags.length + keywordNeedles(campaign.targetKeywords).length > 0
}

/**
 * The accounts that belong to the BRAND of a campaign, which a creator's
 * profile can never be (Nov 2026: a brand's reel pasted in «Añadir publicación
 * por URL» could be registered as a profile of a creator in one click, and from
 * then on every publication of the brand was credited to her):
 *   targets → its "Cuentas de Marca Objetivo" as typed (one handle per token)
 *   own     → the Instagram account the brand attached to the campaign
 *             connected through Meta (Setting campaign_brand_<campaignId> →
 *             brand id; Setting brand_ig_<brandId> → that account's username),
 *             also when the PM did not type it among the targets
 * Compare with isBrandAccount (src/lib/campaign-targets.ts). Never throws: when
 * the settings cannot be read, `own` is empty.
 */
export interface CampaignBrandAccounts {
  targets: string[]
  own: string[]
}

export async function loadCampaignBrandAccounts(
  campaigns: ReadonlyArray<{ id: string; targetAccounts: string[] | null }>
): Promise<Map<string, CampaignBrandAccounts>> {
  const out = new Map<string, CampaignBrandAccounts>()
  for (const c of campaigns) out.set(c.id, { targets: normalizeTargets(c.targetAccounts || []), own: [] })
  if (campaigns.length === 0) return out
  try {
    const mappings = await prisma.setting.findMany({
      where: { key: { in: campaigns.map(c => `campaign_brand_${c.id}`) } },
      select: { key: true, value: true },
    })
    const brandOf = new Map<string, string>()
    for (const m of mappings) {
      const brandId = (m.value || '').trim()
      if (brandId) brandOf.set(m.key.slice('campaign_brand_'.length), brandId)
    }
    const brandIds = Array.from(new Set(brandOf.values()))
    if (brandIds.length === 0) return out
    const accounts = await prisma.setting.findMany({
      where: { key: { in: brandIds.map(id => `brand_ig_${id}`) } },
      select: { key: true, value: true },
    })
    const igOf = new Map(accounts.map(a => [a.key.slice('brand_ig_'.length), normalizeTargets([a.value || ''])]))
    for (const [campaignId, brandId] of brandOf) {
      const entry = out.get(campaignId)
      if (entry) entry.own = igOf.get(brandId) ?? []
    }
  } catch (err) {
    console.error('[campaign-capture] could not read the brand accounts:', err instanceof Error ? err.message : err)
  }
  return out
}

/**
 * Exclusive upper bound of the campaign window (the start of the UTC day after
 * endDate). It lives in src/lib/assignment-rules.ts, the one source of truth
 * of the window and of the late rule; re-exported here for its old callers.
 */
export { campaignWindowEndExclusive }

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
  campaign: Pick<CampaignRules, 'targetAccounts' | 'targetHashtags' | 'targetKeywords'>,
  item: Pick<RuleItem, 'caption' | 'hashtags' | 'mentions'> & { links?: string[] }
): boolean {
  // A target field may hold several tokens typed together ("#vileda #viledaturbo"):
  // split on whitespace/commas so each one counts (2026-09-14: that field made
  // every hashtag match fail silently).
  const splitTargets = (values: string[] | null | undefined): string[] =>
    (values || []).flatMap(v => String(v).split(/[\s,]+/)).map(v => normalizeBrandToken(stripSigil(v))).filter(Boolean)
  const targetAccounts = new Set(splitTargets(campaign.targetAccounts))
  const targetHashtags = new Set(splitTargets(campaign.targetHashtags))
  // Product keywords ("flection system" → 'flectionsystem'): searched like the
  // brand name below, never matched as an exact @mention/#hashtag target.
  const productNeedles = keywordNeedles(campaign.targetKeywords)
  if (targetAccounts.size === 0 && targetHashtags.size === 0 && productNeedles.length === 0) return false

  const mentions = (item.mentions || []).map(m => normalizeBrandToken(stripSigil(m))).filter(Boolean)
  const hashtags = (item.hashtags || []).map(h => normalizeBrandToken(stripSigil(h))).filter(Boolean)

  // Exact matches: @mention ↔ target account, #hashtag ↔ target hashtag
  for (const m of mentions) if (targetAccounts.has(m)) return true
  for (const h of hashtags) if (targetHashtags.has(h)) return true

  // Brand name in the text (caption, each tag, each mention), so
  // "PC Componentes" in a caption matches the target "pccomponentes" and
  // "#viledaespaña" matches "#vileda". Token-aware (tokensContain): until Nov
  // 2026 the spaces were removed before searching and "jugador con" contained
  // "dorco". Guarded by a minimum length.
  const brandNeedles = Array.from(new Set(
    [...targetAccounts, ...targetHashtags].map(normalizeStem).filter(kw => kw.length >= MIN_FUZZY_KEYWORD_LENGTH)
  ))
  const captionTokens = textTokens(item.caption)
  const tags = [...(item.hashtags || []), ...(item.mentions || [])]
  const segments: string[][] = [captionTokens, ...tags.map(tag => textTokens(tag))].filter(tokens => tokens.length > 0)
  for (const tokens of segments) {
    for (const needle of brandNeedles) if (tokensContain(tokens, needle)) return true
  }

  // Product keywords: WHOLE WORDS in the caption ("Flection System",
  // "flection-system"); in a hashtag/mention also at its start or end
  // (#flectionsystem6, #deliplusflectionsystem). Never inside another word.
  for (const needle of productNeedles) {
    if (tokensContainWords(captionTokens, needle)) return true
    for (const tag of tags) if (tagCarriesKeyword(tag, needle)) return true
  }

  // A link sticker to the brand's site is a brand reference too (stories,
  // 2026-10-27): 'https://www.vileda.es/mopa-h2pro' → tokens 'https', 'www',
  // 'vileda', 'es', … which contain the brand token ('viledaes', 'vileda').
  for (const link of item.links || []) {
    const tokens = textTokens(link)
    for (const needle of brandNeedles) if (tokensContain(tokens, needle)) return true
    for (const needle of productNeedles) if (tokensContainWords(tokens, needle)) return true
  }
  if (segments.length === 0) return false

  // The brand name carried by a qualified handle ('@vileda.es' → 'vileda'):
  // the brand's TikTok handle rarely equals its Instagram one and TikTok's
  // mention extraction stops at the dot ('@vileda.es' → '@vileda'), so a
  // mention/hashtag that STARTS with the name, or the name as a WHOLE word in
  // the caption, is a brand reference on every platform. Whole-word (not
  // substring) on purpose, and only for leads of 5+ letters outside the
  // everyday-word stoplist: the stem is derived, the PM never sees it, and a
  // '@casa.viva' handle must not capture every "nueva casa" post.
  const stems = accountCoreStems(campaign.targetAccounts || [])
  if (stems.length > 0) {
    for (const token of [...mentions, ...hashtags]) {
      for (const stem of stems) if (token.startsWith(stem)) return true
    }
    const words = captionWords(item.caption)
    for (const stem of stems) if (words.has(stem)) return true
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

export function scrapedStoryToRuleItem(
  story: Pick<ScrapedStory, 'hashtags' | 'mentions' | 'postedAt' | 'links' | 'resharedMediaIds' | 'resharedShortcodes'>
): RuleItem {
  return {
    caption: null,
    hashtags: story.hashtags || [],
    mentions: story.mentions || [],
    postedAt: toDate(story.postedAt),
    source: 'apify',
    links: story.links || [],
    resharedMediaIds: story.resharedMediaIds || [],
    resharedShortcodes: story.resharedShortcodes || [],
  }
}

/** Instagram media/story ids are 15+ digit snowflakes; webhook and manual placeholder ids are not. */
export function isInstagramMediaId(id: string | null | undefined): boolean {
  return !!id && /^\d{15,}$/.test(id)
}

export interface StoryVerdict {
  ok: boolean
  /** Why the story counts: a mention/hashtag sticker, a link sticker to the brand's site, or a shared campaign post */
  via?: 'mention' | 'link' | 'reshare'
  /**
   * Brand tokens written to the row (mentions[] / hashtags[]) when the evidence
   * is a link or a shared post, so the stored row passes rule (3) on its own
   * when revalidateCampaignMedia re-judges it from caption/mentions/hashtags.
   */
  mentions: string[]
  hashtags: string[]
  /** Short note stored as the story's caption (a story has none): the link or the shared post */
  caption: string | null
}

const NO_STORY_MATCH: StoryVerdict = { ok: false, mentions: [], hashtags: [], caption: null }

/** 'https://www.vileda.es/Mopa-H2PRO/p/177871?utm_source=…' → 'vileda.es/Mopa-H2PRO/p/177871' (what a report can show). */
function shortLink(raw: string): string {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./i, '')
    const path = url.pathname.replace(/\/+$/, '')
    return (host + path).slice(0, 120)
  } catch {
    return raw.slice(0, 120)
  }
}

/**
 * Rules (2) and (3) for a scraped STORY, including the two brand signals a
 * story carries that a post does not (2026-10-27, after a month in which 27
 * of the 47 Vileda stories the scraper saw were rejected): a link sticker to
 * the brand's site, and the creator sharing a feed post/reel INTO the story
 * (story_feed_media) when that post is campaign content — a row of THIS
 * campaign, a row of this creator that itself references the brand, or a
 * post of the brand's own connected account. Rule (1), membership, is the
 * caller's.
 */
export async function storyMatchesCampaign(
  campaign: CampaignRules & { id: string },
  influencerId: string,
  story: ScrapedStory
): Promise<StoryVerdict> {
  const item = scrapedStoryToRuleItem(story)
  if (!isWithinCampaignDates(campaign, item.postedAt)) return NO_STORY_MATCH
  const links = story.links || []
  // (a) mention or hashtag sticker: the row carries its own evidence
  if (itemReferencesBrand(campaign, { ...item, links: [] })) {
    return { ok: true, via: 'mention', mentions: [], hashtags: [], caption: links.length ? `Enlace en la story: ${shortLink(links[0])}` : null }
  }
  // Tokens a link/reshare row must carry to pass rule (3) on its own: the
  // brand handle when the campaign targets an account, else its hashtags.
  const brandHandles = normalizeTargets(campaign.targetAccounts || [])
  const brandHashtags = normalizeTargets(campaign.targetHashtags || [])
  const brandTokens = brandHandles.length > 0
    ? { mentions: brandHandles, hashtags: [] as string[] }
    : { mentions: [] as string[], hashtags: brandHashtags.length > 0 ? brandHashtags : keywordNeedles(campaign.targetKeywords) }
  // (b) link sticker to the brand's site: store the link that MATCHED
  const matchedLink = links.find(link => itemReferencesBrand(campaign, { caption: null, hashtags: [], mentions: [], links: [link] }))
  if (matchedLink) return { ok: true, via: 'link', ...brandTokens, caption: `Enlace en la story: ${shortLink(matchedLink)}` }

  // (c) a feed post/reel shared into the story
  const ids = (story.resharedMediaIds || []).filter(isInstagramMediaId)
  const codes = (story.resharedShortcodes || []).filter(c => /^[A-Za-z0-9_-]{5,}$/.test(c))
  if (ids.length === 0 && codes.length === 0) return NO_STORY_MATCH
  const rows = await prisma.media.findMany({
    where: {
      platform: 'INSTAGRAM',
      OR: [
        ...(ids.length ? [{ externalId: { in: ids } }, ...ids.map(id => ({ externalId: { startsWith: `${id}_` } }))] : []),
        ...codes.map(code => ({ permalink: { contains: `/${code}` } })),
      ],
    },
    select: { campaignId: true, influencerId: true, permalink: true, caption: true, hashtags: true, mentions: true },
  })
  const shared =
    rows.find(r => r.campaignId === campaign.id) ||
    rows.find(r => r.influencerId === influencerId && itemReferencesBrand(campaign, r))
  if (shared) {
    return { ok: true, via: 'reshare', ...brandTokens, caption: `Comparte en la story: ${shared.permalink ? shortLink(shared.permalink) : codes[0] || ids[0]}` }
  }
  // A post of the brand's own CONNECTED Instagram (MetaMedia): its igMediaId is
  // a Graph API id, not the Instagram pk a story carries, so the shortcode in
  // the Graph permalink is the key that works (plus the id, in case).
  if (brandHandles.length > 0) {
    const brandPost = await prisma.metaMedia.findFirst({
      where: {
        igUsername: { in: brandHandles, mode: 'insensitive' },
        OR: [
          ...(ids.length ? [{ igMediaId: { in: ids } }] : []),
          ...codes.map(code => ({ permalink: { contains: `/${code}` } })),
        ],
      },
      select: { permalink: true },
    })
    if (brandPost) {
      return { ok: true, via: 'reshare', ...brandTokens, caption: `Comparte en la story: ${brandPost.permalink ? shortLink(brandPost.permalink) : codes[0] || ids[0]}` }
    }
  }
  return NO_STORY_MATCH
}

// ---------------------------------------------------------------------------
// Persistence helpers (shared by the track routes)
// ---------------------------------------------------------------------------

type ClaimDecision =
  | { kind: 'create' }
  // this campaign's row, or an unattached one (`loose`: the profile it was credited as published by, null = its own) → update + attach
  | { kind: 'claim'; rowId: string; loose?: { publishedByInfluencerId: string | null } }
  | { kind: 'refresh'; rowId: string } // this campaign's row is manual → metrics only

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

type CaptureDb = Prisma.TransactionClient | typeof prisma

/**
 * Runs `write` while the membership (campaignId, influencerId) is held, and
 * only if it exists: every piece attached to a campaign is filed under a
 * MEMBER. A piece filed under a profile that is not a member counts in the
 * campaign totals and shows in no creator row (the next revalidation then
 * detaches it).
 *
 * The lock matters because the callers decide who gets the credit from a list
 * read before the write, sometimes minutes before (check-posts reads one
 * profile after another; the manual endpoint waits for the scraper). A fold of
 * a TikTok twin (src/lib/person-fold.ts) deletes the twin's membership under
 * FOR UPDATE: it waits for this transaction and then moves the piece written
 * here, or this one waits for the fold and then finds no membership. FOR KEY
 * SHARE (the lock of a foreign-key check) only stops the row from being
 * deleted or locked FOR UPDATE: a PM editing the member's status or fee is
 * never kept waiting by a capture.
 *
 * `exclusive` (a LATE piece added by hand, Nov 2026): the membership is held
 * FOR NO KEY UPDATE instead, which two such writes cannot hold at once. The
 * caller reads what the creator has delivered INSIDE `write`, so two late adds
 * for a creator who owes one piece run one after the other and the second one
 * sees the first piece (READ COMMITTED: each statement reads what is
 * committed when it starts). It still does not wait for a capture (FOR KEY
 * SHARE) and a fold (FOR UPDATE) still waits for it.
 *
 * null = not a member (any more): nothing was written.
 */
export async function withCampaignMembership<T>(
  campaignId: string,
  influencerId: string,
  write: (db: Prisma.TransactionClient) => Promise<T>,
  options: { exclusive?: boolean } = {}
): Promise<T | null> {
  return prisma.$transaction(async tx => {
    const held = options.exclusive
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM campaign_influencers WHERE "campaignId" = ${campaignId} AND "influencerId" = ${influencerId} FOR NO KEY UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM campaign_influencers WHERE "campaignId" = ${campaignId} AND "influencerId" = ${influencerId} FOR KEY SHARE`
    if (held.length === 0) return null
    return write(tx)
  }, { maxWait: 10_000, timeout: 30_000 })
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
): Promise<{ id: string; externalId: string | null; campaignId: string | null; source: string; likes: number; comments: number; publishedByInfluencerId: string | null } | null> {
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
    select: { id: true, externalId: true, campaignId: true, source: true, likes: true, comments: true, publishedByInfluencerId: true },
  })
}

/**
 * The keys a post is known by. The same Instagram post has a numeric id in
 * Apify, another id in Meta's Graph API and a shortcode in its link (an
 * un-enriched manual add stores the shortcode as externalId): the shortcode
 * in the permalink is the key they share. Other networks share the id.
 */
export interface PostIdentity {
  platform: Platform
  externalIds: ReadonlyArray<string | null | undefined>
  permalinks?: ReadonlyArray<string | null | undefined>
  /** The shortcode of an Instagram link, when the caller has it */
  shortcode?: string | null
}

export interface CampaignPostCopy {
  id: string
  campaignId: string
  postedAt: Date | null
  influencerId: string
  source: string
  mediaType: string
  externalId: string | null
  campaign: { id: string; name: string; endDate: Date | null; status: string; type: string }
}

/**
 * Rows of the same post attached to campaigns OTHER than `campaignId`
 * (unattached rows are not a campaign), with the campaign they are in.
 * Matched on the externalId, and on Instagram also on the shortcode.
 */
export async function findPostCopiesInOtherCampaigns(
  post: PostIdentity,
  campaignId: string,
  db: CaptureDb = prisma
): Promise<CampaignPostCopy[]> {
  const ids = Array.from(new Set(post.externalIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')))
  const codes = new Set<string>()
  if (post.platform === 'INSTAGRAM') {
    if (post.shortcode && /^[A-Za-z0-9_-]{5,}$/.test(post.shortcode)) codes.add(post.shortcode)
    for (const link of post.permalinks ?? []) {
      const code = instagramShortcode(link)
      if (code) codes.add(code)
    }
  }
  if (ids.length === 0 && codes.size === 0) return []
  // An un-enriched manual add stores the shortcode itself as externalId
  const keys = Array.from(new Set([...ids, ...codes]))
  const rows = await db.media.findMany({
    where: {
      platform: post.platform,
      AND: [{ campaignId: { not: null } }, { campaignId: { not: campaignId } }],
      OR: [
        { externalId: { in: keys } },
        ...Array.from(codes).map(code => ({ permalink: { contains: `/${code}` } })),
      ],
    },
    select: {
      id: true, campaignId: true, postedAt: true, influencerId: true, source: true, externalId: true, permalink: true, mediaType: true,
      campaign: { select: { id: true, name: true, endDate: true, status: true, type: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  const out: CampaignPostCopy[] = []
  for (const r of rows) {
    if (!r.campaignId || !r.campaign) continue
    // `contains '/CODE'` also matches '/CODEx': keep exact shortcodes only
    const sameId = !!r.externalId && keys.includes(r.externalId)
    const sameCode = codes.size > 0 && codes.has(instagramShortcode(r.permalink) ?? '')
    if (!sameId && !sameCode) continue
    out.push({ id: r.id, campaignId: r.campaignId, postedAt: r.postedAt, influencerId: r.influencerId, source: r.source, mediaType: r.mediaType, externalId: r.externalId, campaign: r.campaign })
  }
  return out
}

/**
 * The row of the same post that counts LATE in another campaign (a piece a PM
 * added there «fuera de plazo»: hand-added, at most LATE_ACCEPT_MAX_DAYS after
 * that campaign's end), or null. A late piece counts in one campaign only:
 * the automatic capture never files the post in `campaignId` while such a row
 * exists (assignment-rules.ts, lateCopyElsewhere).
 */
export async function findLateCopyElsewhere(post: PostIdentity, campaignId: string, db: CaptureDb = prisma): Promise<CampaignPostCopy | null> {
  const copies = await findPostCopiesInOtherCampaigns(post, campaignId, db)
  const late = lateCopyElsewhere(copies.map(c => ({ ...c, campaignEndDate: c.campaign.endDate, campaignType: c.campaign.type })), campaignId)
  return late ? copies.find(c => c.id === late.id) ?? null : null
}

/**
 * Serialises, until the end of the transaction `db` belongs to, every
 * manual write that decides whether ONE post counts in one campaign only
 * (a late piece, or an in-window add of a post that may count late
 * elsewhere): two such adds of the same post to two campaigns at once run
 * one after the other, so the second one sees the first one's row. The key
 * is the post as both requests know it: the Instagram shortcode of a feed
 * post, else its id. Must be called inside a transaction.
 */
export async function lockPostForCampaignChoice(db: Prisma.TransactionClient, platform: Platform, key: string | null | undefined): Promise<void> {
  if (!key) return
  await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`late-post:${platform}:${key}`}))) AS l`
}

/**
 * A STORY that counts LATE in another campaign for the same creator (her
 * member profile or any profile of her person) published within
 * STORY_TWIN_TOLERANCE_MS of `postedAt`: the same story reaching another
 * campaign under another id (a Meta story mention has a Graph id; a story
 * registered from its link keeps the id of the link). Only rows that count
 * late there (keepsLateHandAddedRow). `onlyWithoutInstagramId`: for the
 * Apify story pass, which shares the id of the link and treats a row that
 * carries an Instagram id as ANOTHER slide (upsertCampaignStory's twin rule).
 */
export async function findLateStoryElsewhere(
  campaignId: string,
  influencerId: string,
  postedAt: Date | null,
  options: { onlyWithoutInstagramId?: boolean } = {}
): Promise<{ id: string; campaignId: string; campaign: { id: string; name: string } } | null> {
  if (!postedAt) return null
  const me = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { personId: true } })
  const profileIds = me?.personId
    ? (await prisma.influencer.findMany({ where: { personId: me.personId }, select: { id: true } })).map(p => p.id)
    : [influencerId]
  if (!profileIds.includes(influencerId)) profileIds.push(influencerId)
  const rows = await prisma.media.findMany({
    where: {
      platform: 'INSTAGRAM',
      mediaType: 'STORY',
      postedAt: { gte: new Date(postedAt.getTime() - STORY_TWIN_TOLERANCE_MS), lte: new Date(postedAt.getTime() + STORY_TWIN_TOLERANCE_MS) },
      AND: [{ campaignId: { not: null } }, { campaignId: { not: campaignId } }],
      OR: [{ influencerId: { in: profileIds } }, { publishedByInfluencerId: { in: profileIds } }],
    },
    select: { id: true, campaignId: true, source: true, mediaType: true, externalId: true, postedAt: true, campaign: { select: { id: true, name: true, endDate: true, type: true } } },
    orderBy: { createdAt: 'asc' },
  })
  for (const r of rows) {
    if (!r.campaignId || !r.campaign) continue
    if (options.onlyWithoutInstagramId && isInstagramMediaId(r.externalId)) continue
    if (keepsLateHandAddedRow(r.campaign, r)) return { id: r.id, campaignId: r.campaignId, campaign: { id: r.campaign.id, name: r.campaign.name } }
  }
  return null
}

/**
 * What an automatic path did NOT store and why, for its run summary. Every
 * skip is also logged with its reason: a skip is never silent.
 */
export interface CaptureSkips {
  /** Posts not filed here because a late row of them counts in another campaign */
  lateElsewhere: number
  /** A few of them, "PLATFORM:id → «campaign»", for the summary */
  examples: string[]
}

export function newCaptureSkips(): CaptureSkips {
  return { lateElsewhere: 0, examples: [] }
}

/**
 * The guard of every automatic write that brings a post INTO a campaign:
 * true (and logged with the reason, and counted in `skips`) when a late row of
 * it counts in another campaign. `path` names the caller in the log.
 */
export async function skippedForLateCopy(
  post: PostIdentity & {
    label: string
    /** A story: also the same creator's late story elsewhere at the same time (findLateStoryElsewhere) */
    story?: { influencerId: string; postedAt: Date | null; onlyWithoutInstagramId?: boolean }
  },
  campaignId: string,
  skips: CaptureSkips | undefined,
  path: string
): Promise<boolean> {
  const late = (await findLateCopyElsewhere(post, campaignId)) ??
    (post.story ? await findLateStoryElsewhere(campaignId, post.story.influencerId, post.story.postedAt, { onlyWithoutInstagramId: post.story.onlyWithoutInstagramId }) : null)
  if (!late) return false
  if (skips) {
    skips.lateElsewhere++
    if (skips.examples.length < 10) skips.examples.push(`${post.label} → «${late.campaign.name}»`)
  }
  console.warn(
    `[${path}] ${post.label} not stored in campaign ${campaignId}: it already counts late («fuera de plazo») in «${late.campaign.name}» (${late.campaignId}); a late piece counts in one campaign only`
  )
  return true
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
    select: { id: true, publishedByInfluencerId: true },
    orderBy: { createdAt: 'asc' },
  })
  if (loose) return { kind: 'claim', rowId: loose.id, loose: { publishedByInfluencerId: loose.publishedByInfluencerId } }
  return { kind: 'create' }
}

export interface UpsertPostOptions {
  /**
   * The profile that PUBLISHED the post when it is not the credited member's
   * own profile but another profile of the same person (her TikTok, a second
   * Instagram). Omitted, null or equal to `influencerId` = the member herself,
   * which is what every caller did before Nov 2026.
   */
  publishedByInfluencerId?: string | null
  /**
   * The run summary of the calling path: a post not stored because a LATE row
   * of it counts in another campaign is counted here (and always logged).
   */
  skips?: CaptureSkips
}

/**
 * Store a post for a campaign.
 *
 *   influencerId → the CREDITED MEMBER (a CampaignInfluencer of the campaign;
 *                  decided by src/lib/campaign-roster.ts)
 *   platform     → the network of the PUBLICATION, which is not the member's
 *                  network when another profile of hers published it
 *   options.publishedByInfluencerId → that other profile (see UpsertPostOptions)
 *
 * Without options the behaviour is exactly the one before Nov 2026.
 *
 * A post never JOINS this campaign (a new row, or an unattached one claimed
 * here) while a row of it counts LATE in another campaign: a piece a PM added
 * «fuera de plazo» counts in that campaign only. It answers false, logs the
 * reason and counts it in options.skips. Rows already in this campaign are
 * refreshed as always.
 */
export async function upsertCampaignPost(
  campaignId: string,
  influencerId: string,
  platform: Platform,
  post: ScrapedPost,
  options: UpsertPostOptions = {}
): Promise<boolean> {
  if (!post.externalId) return false
  const publishedByInfluencerId =
    options.publishedByInfluencerId && options.publishedByInfluencerId !== influencerId
      ? options.publishedByInfluencerId
      : null
  /**
   * An UNATTACHED row of this post hangs from whoever it was last filed under.
   * Left by a profile analysis, that is the profile that published it; detached
   * from a campaign where another profile of the creator published it, that is
   * the MEMBER OF THAT CAMPAIGN, with the publisher in publishedByInfluencerId.
   * Attaching either as it is could put a non-member's content in this
   * campaign (the next revalidation would detach it, the next pass attach it
   * again): whenever a publisher is involved, in this call or in the row, the
   * row is credited to the member and the publisher of THIS call. A row with no
   * publisher claimed by a call with no publisher is left as it always was.
   * Rows already in this campaign keep whoever they belong to.
   */
  const creditLoose = (row: { publishedByInfluencerId: string | null }) =>
    publishedByInfluencerId || row.publishedByInfluencerId ? { influencerId, publishedByInfluencerId } : {}
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
  /**
   * A row that JOINS the campaign here (a new one, or an unattached one) is
   * written only while `influencerId` is a member (withCampaignMembership).
   * A row already in the campaign is refreshed as it is: it keeps its member.
   */
  const write = async (joins: boolean, run: (db: CaptureDb) => Promise<unknown>): Promise<boolean> => {
    if (!joins) {
      await run(prisma)
      return true
    }
    const done = await withCampaignMembership(campaignId, influencerId, async tx => { await run(tx); return true })
    if (done === null) {
      console.warn(`[campaign-capture] post ${platform}:${post.externalId} not stored in campaign ${campaignId}: ${influencerId} is not a member of it (any more)`)
      return false
    }
    return true
  }
  /** The guard of every write that brings the post INTO this campaign (see the doc above) */
  const lateElsewhere = () =>
    skippedForLateCopy(
      { platform, externalIds: [post.externalId], permalinks: [post.permalink], label: `${platform}:${post.externalId}` },
      campaignId,
      options.skips,
      'campaign-capture'
    )
  try {
    // Every write is AWAITED inside this try: a refused write (a duplicate, a value the
    // database does not take) answers false, as it always did, and never throws to the caller
    const decision = await decideClaim(post.externalId, platform, campaignId)
    // An unattached row of this id is claimed only when the campaign does not
    // already hold the post under ANOTHER id (Meta's and Apify's ids of one
    // Instagram post differ): that is the duplicate a merge or a revalidation
    // detached, and attaching it again would count the post twice. The
    // campaign's own row is refreshed instead (the 'create' path below).
    const ownTwin = decision.kind === 'claim' && decision.loose ? await findMediaBySameLink(platform, post.permalink, campaignId) : null
    const chosen: ClaimDecision = ownTwin?.campaignId === campaignId ? { kind: 'create' } : decision
    switch (chosen.kind) {
      case 'refresh':
        await prisma.media.update({ where: { id: chosen.rowId }, data: await raiseOnly(chosen.rowId) })
        return true
      case 'claim': {
        if (chosen.loose && (await lateElsewhere())) return false
        const data = { ...(await raiseOnly(chosen.rowId)), ...freshRuleInputs, campaignId, ...(chosen.loose ? creditLoose(chosen.loose) : {}) }
        return await write(!!chosen.loose, db => db.media.update({ where: { id: chosen.rowId }, data }))
      }
      case 'create': {
        // Same post already stored for this campaign under another source's
        // externalId (Meta materialized it first)? Upgrade that row instead of
        // creating a twin that would double-count in the campaign.
        const twin = ownTwin ?? await findMediaBySameLink(platform, post.permalink, campaignId)
        // Only a row that is already this campaign's stays out of the guard
        if (!twin?.campaignId && (await lateElsewhere())) return false
        if (twin) {
          if (twin.source === 'manual') {
            // A detached manual row may be re-claimed by this campaign (rules
            // 1-3 were just proven by the caller); keep source 'manual'.
            const data = { ...(await raiseOnly(twin.id)), ...(twin.campaignId ? {} : { campaignId, ...creditLoose(twin) }) }
            return await write(!twin.campaignId, db => db.media.update({ where: { id: twin.id }, data }))
          }
          const data = {
            // Apify's public counts can be fresher than a stale Meta sync
            ...(await raiseOnly(twin.id)),
            ...freshRuleInputs,
            ...(post.thumbnailUrl ? { thumbnailUrl: post.thumbnailUrl } : {}),
            ...(post.mediaUrl ? { mediaUrl: post.mediaUrl } : {}),
            campaignId,
            ...(twin.campaignId ? {} : creditLoose(twin)),
          }
          return await write(!twin.campaignId, db => db.media.update({ where: { id: twin.id }, data }))
        }
        return await write(true, db => db.media.create({
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
            publishedByInfluencerId,
            campaignId,
            source: 'apify',
          },
        }))
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
): Promise<{ id: string; externalId: string | null; source: string; views: number; mentions: string[]; campaignId: string | null } | null> {
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
    select: { id: true, externalId: true, source: true, views: true, mentions: true, campaignId: true },
  })
}

/**
 * Store a scraped story for a campaign. Like upsertCampaignPost, a story never
 * JOINS this campaign while a row of it counts LATE in another campaign (the
 * same story id, or a story of hers registered by hand without an id at the
 * same time): false, logged, counted in options.skips.
 */
export async function upsertCampaignStory(
  campaignId: string,
  influencerId: string,
  story: ScrapedStory,
  verdict?: Pick<StoryVerdict, 'mentions' | 'hashtags' | 'caption'>,
  options: { skips?: CaptureSkips } = {}
): Promise<boolean> {
  if (!story.externalId) return false
  const lateElsewhere = () =>
    skippedForLateCopy(
      {
        platform: 'INSTAGRAM',
        externalIds: [story.externalId],
        label: `INSTAGRAM:${story.externalId} (story)`,
        // The same story registered by hand without its link (no id) late elsewhere: matched by time, as the twin rule below does here
        story: { influencerId, postedAt: toDate(story.postedAt), onlyWithoutInstagramId: true },
      },
      campaignId,
      options.skips,
      'campaign-capture'
    )
  // What the row must carry for rule (3) to hold on revalidation: the sticker
  // mentions/hashtags plus, for a story captured through a link or a shared
  // post, the brand tokens; the link / shared post as the caption (a story has none).
  const mentions = Array.from(new Set([...(story.mentions || []), ...(verdict?.mentions || [])]))
  const hashtags = Array.from(new Set([...(story.hashtags || []), ...(verdict?.hashtags || [])]))
  const caption = verdict?.caption ?? null
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
        if (decision.loose && (await lateElsewhere())) return false
        await prisma.media.update({
          where: { id: decision.rowId },
          data: {
            ...(await raiseViews(decision.rowId)),
            ...(mentions.length ? { mentions } : {}),
            ...(hashtags.length ? { hashtags } : {}),
            ...(caption ? { caption } : {}),
            campaignId,
          },
        })
        return true
      case 'create': {
        // The same story may already be here as a Meta story_mention row
        // (webhook) or as a story a PM registered without its link: different
        // id space (message id / placeholder vs IG pk), no shortcode to match
        // on, but the publish time is the same → upgrade that row in place
        // instead of creating a twin. NEVER another Apify story, nor a row
        // that already carries an Instagram id: two stories minutes apart are
        // two SLIDES of the creator's story, and merging them (Oct 2026) lost
        // two of every three slides and re-announced the same stories daily.
        const twin = await findStoryTwin(campaignId, influencerId, toDate(story.postedAt))
        const upgradesTwin = !!twin && twin.source !== 'apify' && !isInstagramMediaId(twin.externalId)
        // A twin already in this campaign is refreshed; anything else joins it
        if (!(upgradesTwin && twin?.campaignId) && (await lateElsewhere())) return false
        if (twin && upgradesTwin) {
          await prisma.media.update({
            where: { id: twin.id },
            data: {
              externalId: story.externalId,
              permalink: story.permalink ?? undefined,
              ...(story.thumbnailUrl ? { thumbnailUrl: story.thumbnailUrl } : {}),
              ...(story.mediaUrl ? { mediaUrl: story.mediaUrl } : {}),
              views: Math.max(twin.views, story.views || 0),
              mentions: Array.from(new Set([...(twin.mentions || []), ...mentions])),
              ...(hashtags.length ? { hashtags } : {}),
              ...(caption ? { caption } : {}),
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
            caption,
            views: story.views,
            mentions,
            hashtags,
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
  /** @deprecated stories are never scraped per member any more (see includeStories). */
  skipStories?: boolean
  /**
   * Scrape THIS member's stories in its own Apify run (0,099 $ per run start).
   * Off by default since 2026-09-14: the stories cron scans every confirmed
   * creator of every live campaign in ONE run twice a day, so a per-member run
   * on each status change only burned budget (16 € in two days).
   */
  includeStories?: boolean
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
/** Best-effort durable copy of the thumbnails captured for a campaign (URLs expire in days). */
async function cacheCampaignThumbs(campaignId: string): Promise<void> {
  try {
    const { backfillMediaThumbs } = await import('@/lib/thumb-cache')
    await backfillMediaThumbs({ campaignId, limit: 40, timeBudgetMs: 30_000, refresh: true })
  } catch (err) {
    console.error('[campaign-capture] thumb cache failed:', err instanceof Error ? err.message : err)
  }
}

export async function captureMemberContent(
  campaignId: string,
  influencerId: string,
  options: CaptureOptions = {}
): Promise<{ captured: number; skipped: number; skippedLateElsewhere: number }> {
  const result = { captured: 0, skipped: 0, skippedLateElsewhere: 0 }
  // Posts left out because a late row of them counts in another campaign (also in `skipped`)
  const skips = newCaptureSkips()

  try {
    const membership = await prisma.campaignInfluencer.findUnique({
      where: { campaignId_influencerId: { campaignId, influencerId } },
      include: {
        influencer: { select: { id: true, username: true, platform: true } },
        campaign: {
          select: { id: true, name: true, targetAccounts: true, targetHashtags: true, targetKeywords: true, startDate: true, endDate: true },
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
        // Empty scrapes never zero out real metrics nor stamp lastScraped
        await prisma.influencer.update({
          where: { id: influencer.id },
          data: scrapedProfileUpdate(scraped),
        })
        afterInfluencerUpsert(influencer.id, scraped.avatarUrl)
      } catch (err) {
        console.error(`[campaign-capture] influencer refresh failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
      }

      for (const post of scraped.recentPosts || []) {
        if (!post.externalId) { result.skipped++; continue }
        if (!mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post))) { result.skipped++; continue }
        const ok = await upsertCampaignPost(campaign.id, influencer.id, influencer.platform, post, { skips })
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
    if (influencer.platform === 'INSTAGRAM' && options.includeStories === true && !options.skipStories && !isApifyExhausted()) {
      try {
        const storyResults = await scrapeStories([influencer.username], 'INSTAGRAM')
        for (const sr of storyResults) {
          if (sr.username.toLowerCase() !== influencer.username.toLowerCase()) continue
          for (const story of sr.stories) {
            if (!story.externalId) { result.skipped++; continue }
            const verdict = await storyMatchesCampaign(campaign, influencer.id, story)
            if (!verdict.ok) { result.skipped++; continue }
            const ok = await upsertCampaignStory(campaign.id, influencer.id, story, verdict, { skips })
            if (ok) result.captured++
            else result.skipped++
          }
        }
      } catch (err) {
        console.error(`[campaign-capture] story scrape failed for @${influencer.username}:`, err instanceof Error ? err.message : err)
      }
    }

    result.skippedLateElsewhere = skips.lateElsewhere
    console.log(
      `[campaign-capture] @${influencer.username} in "${campaign.name}": ${result.captured} captured, ${result.skipped} skipped` +
        (skips.lateElsewhere > 0 ? ` (${skips.lateElsewhere} already counted late in another campaign: ${skips.examples.join(', ')})` : '')
    )
  } catch (err) {
    result.skippedLateElsewhere = skips.lateElsewhere
    console.error('[campaign-capture] captureMemberContent failed:', err instanceof Error ? err.message : err)
  }

  if (result.captured > 0) await cacheCampaignThumbs(campaignId)
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
 *
 * A hand-added row dated AFTER the window is a piece a PM added «fuera de
 * plazo» (src/lib/assignment-rules.ts): it is kept while it is at most
 * LATE_ACCEPT_MAX_DAYS days late (Social Listening keeps the strict window).
 * Whether the creator still owed it is not re-checked: that piece is what
 * completed her. Scraped rows after the window, and rows before the start or
 * undated, go as always.
 */
export type RevalidationVerdict = 'keep_rules' | 'keep_manual' | 'keep_late_manual' | 'out_member' | 'out_dates' | 'out_brand'

/**
 * The verdict of the revalidation for one row (pure): shared by
 * revalidateCampaignMedia and every preview of it (the Claude connector), so
 * they can never disagree.
 */
export function revalidationVerdict(
  campaign: Pick<CampaignRules, 'targetAccounts' | 'targetHashtags' | 'targetKeywords' | 'startDate' | 'endDate'> & { type?: string | null },
  memberIds: ReadonlySet<string>,
  row: Pick<RuleItem, 'caption' | 'hashtags' | 'mentions' | 'postedAt'> & { influencerId: string; source: string; mediaType: string; externalId: string | null }
): RevalidationVerdict {
  // Rules (1) and (2) hold for EVERY row, manual included (but a hand-added late piece)
  if (!memberIds.has(row.influencerId)) return 'out_member'
  if (!isWithinCampaignDates(campaign, row.postedAt)) {
    return keepsLateHandAddedRow(campaign, row) ? 'keep_late_manual' : 'out_dates'
  }
  if (isHandAddedRow(row)) return 'keep_manual'
  // Rule (3) only for scraped rows
  return itemReferencesBrand(campaign, row) ? 'keep_rules' : 'out_brand'
}

export async function revalidateCampaignMedia(campaignId: string): Promise<{ kept: number; detached: number }> {
  const result = { kept: 0, detached: 0 }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      type: true,
      targetAccounts: true,
      targetHashtags: true,
      targetKeywords: true,
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
    if (revalidationVerdict(campaign, memberIds, row).startsWith('keep')) result.kept++
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
