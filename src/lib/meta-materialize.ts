import { prisma } from '@/lib/db'
import { Platform, MediaType } from '@/generated/prisma/client'
import { isWithinCampaignDates } from '@/lib/campaign-capture'

/**
 * Materialize Meta Graph API content (MetaMedia + MetaStoryMention) into the
 * Media table for a campaign, so every existing aggregate (overview, timeline,
 * EMV, exports, report page) sees it without special-casing.
 *
 * - Matches poster username against the campaign's INSTAGRAM member influencers
 * - Respects campaign start/end dates
 * - Dedups against Apify-captured rows by Instagram shortcode (Apify and Meta
 *   use different external IDs for the same post, but permalinks share the
 *   /p/{shortcode}/ or /reel/{shortcode}/ segment). When both captured the same
 *   post, the row is upgraded in place with Meta's real metrics.
 */
/**
 * ACTIVE campaigns in materialization order: the most
 * specific campaign (shortest date window) first, "always on" (no end date)
 * last. A Media row belongs to ONE campaign and is never moved, so when a
 * creator sits in both a monthly campaign and an annual/always-on one, the
 * monthly campaign must get the first claim on their post.
 */
export async function listCampaignsForMaterialize(): Promise<string[]> {
  // All ACTIVE campaigns of the agency, whoever created them (see brandTokens
  // note in materializeMetaContent).
  const rows = await prisma.campaign.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, startDate: true, endDate: true, createdAt: true },
  })
  const span = (c: { startDate: Date | null; endDate: Date | null }) =>
    c.endDate ? c.endDate.getTime() - (c.startDate?.getTime() ?? 0) : Number.POSITIVE_INFINITY
  return rows
    .sort((a, b) => span(a) - span(b) || b.createdAt.getTime() - a.createdAt.getTime())
    .map(c => c.id)
}

export async function materializeMetaContent(campaignId: string): Promise<{ created: number; updated: number }> {
  const stats = { created: 0, updated: 0 }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { influencers: { include: { influencer: true } } },
  })
  if (!campaign) return stats

  const igMembers = new Map<string, { id: string }>()
  for (const ci of campaign.influencers) {
    if (ci.influencer.platform === 'INSTAGRAM') {
      igMembers.set(ci.influencer.username.toLowerCase().replace(/^@/, '').trim(), { id: ci.influencer.id })
    }
  }
  if (igMembers.size === 0) return stats

  // Brand connections are AGENCY-wide: the Vileda account was connected by
  // the owner, but the monthly campaigns are created by the project managers
  // (other users). Scoping tokens by campaign.userId left every PM campaign
  // without Meta content.
  const brandTokens = await prisma.socialToken.findMany({
    where: { platform: 'INSTAGRAM', tokenType: 'brand', isValid: true },
    select: { id: true },
  })
  if (brandTokens.length === 0) return stats
  const tokenIds = brandTokens.map(t => t.id)

  // Rule (2) of precise capture: undated items can't be proven inside the
  // campaign window → NOT captured. Same window logic as every other capture
  // path (endDate's whole day counts). Meta rows are brand-tagged by
  // construction (rule 3), and membership (rule 1) is enforced via igMembers.
  const inRange = (d: Date | null) => isWithinCampaignDates(campaign, d)
  const normalize = (u: string) => u.toLowerCase().replace(/^@/, '').trim()
  const shortcodeOf = (permalink: string | null) => {
    if (!permalink) return null
    const m = permalink.match(/\/(?:p|reel|tv)\/([^/?#]+)/)
    return m ? m[1] : null
  }
  const mapMediaType = (t: string): MediaType => {
    switch (t) {
      case 'REELS': return 'REEL'
      case 'STORY': return 'STORY'
      case 'VIDEO': return 'VIDEO'
      case 'CAROUSEL_ALBUM': return 'CAROUSEL'
      default: return 'POST'
    }
  }

  const [metaMedia, storyMentions] = await Promise.all([
    prisma.metaMedia.findMany({
      where: { socialTokenId: { in: tokenIds }, igUsername: { not: null } },
    }),
    prisma.metaStoryMention.findMany({
      where: { socialTokenId: { in: tokenIds } },
    }),
  ])

  const handledIgMediaIds = new Set<string>()

  for (const mm of metaMedia) {
    const member = mm.igUsername ? igMembers.get(normalize(mm.igUsername)) : undefined
    if (!member) continue
    if (!inRange(mm.postedAt)) continue
    handledIgMediaIds.add(mm.igMediaId)

    try {
      // Prefer upgrading an existing row for the same post. Apify and Meta use
      // different externalIds for the same post, so the shortcode in the
      // permalink is the only cross-source key — and the lookup must be
      // platform-wide (NOT scoped to this campaign): an Apify row that is
      // unattached or attached to another campaign would otherwise be invisible
      // here and we'd create a twin. Media has a GLOBAL unique on
      // (externalId, platform), so neither branch may be campaign-scoped.
      const shortcode = shortcodeOf(mm.permalink)
      const existing = await prisma.media.findFirst({
        where: {
          platform: 'INSTAGRAM' as Platform,
          OR: [
            { externalId: mm.igMediaId },
            ...(shortcode ? [{ permalink: { contains: `/${shortcode}` } }] : []),
          ],
        },
        orderBy: { campaignId: { sort: 'desc', nulls: 'last' } },
      })

      const metaMetrics = {
        likes: mm.likeCount || 0,
        comments: mm.commentsCount || 0,
        shares: mm.shares || 0,
        saves: mm.saved || 0,
        reach: mm.reach || 0,
        impressions: mm.impressions || 0,
        source: 'meta_api',
        dataSource: 'api',
      }

      if (existing) {
        const ours = !existing.campaignId || existing.campaignId === campaignId
        await prisma.media.update({
          where: { id: existing.id },
          data: {
            ...metaMetrics,
            // Manual rows keep their own bookkeeping; only enrich metrics.
            ...(existing.source === 'manual' ? { source: 'manual' } : {}),
            // Claim for this campaign only when the row is unattached or
            // already ours — a row can belong to ONE campaign and another
            // campaign's attachment must not be stolen (same as the Apify pass)
            ...(ours ? { campaignId } : {}),
            // Keep the larger like/comment counts (Apify sometimes sees more
            // recent numbers than a stale Meta sync)
            likes: Math.max(existing.likes, metaMetrics.likes),
            comments: Math.max(existing.comments, metaMetrics.comments),
          },
        })
        if (ours) stats.updated++
      } else {
        await prisma.media.create({
          data: {
            externalId: mm.igMediaId,
            platform: 'INSTAGRAM' as Platform,
            mediaType: mapMediaType(mm.mediaType),
            caption: mm.caption,
            mediaUrl: mm.mediaUrl,
            thumbnailUrl: mm.thumbnailUrl,
            permalink: mm.permalink,
            ...metaMetrics,
            postedAt: mm.postedAt,
            influencerId: member.id,
            campaignId,
          },
        })
        stats.created++
      }
    } catch (err) {
      console.error('[meta-materialize] media upsert failed:', err instanceof Error ? err.message : err)
    }
  }

  for (const sm of storyMentions) {
    const member = igMembers.get(normalize(sm.mentionUsername))
    if (!member) continue
    if (!inRange(sm.mentionedAt)) continue
    if (handledIgMediaIds.has(sm.mentionMediaId)) continue // richer MetaMedia row already handled it

    try {
      const existing = await prisma.media.findFirst({
        where: { platform: 'INSTAGRAM' as Platform, externalId: sm.mentionMediaId },
      })
      if (existing) continue // stories carry no new metrics — nothing to upgrade

      await prisma.media.create({
        data: {
          externalId: sm.mentionMediaId,
          platform: 'INSTAGRAM' as Platform,
          mediaType: 'STORY' as MediaType,
          source: 'meta_api',
          dataSource: 'api',
          postedAt: sm.mentionedAt,
          influencerId: member.id,
          campaignId,
        },
      })
      stats.created++
    } catch (err) {
      console.error('[meta-materialize] story upsert failed:', err instanceof Error ? err.message : err)
    }
  }

  return stats
}
