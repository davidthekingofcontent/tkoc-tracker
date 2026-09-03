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
 * ACTIVE campaigns of the given owners in materialization order: the most
 * specific campaign (shortest date window) first, "always on" (no end date)
 * last. A Media row belongs to ONE campaign and is never moved, so when a
 * creator sits in both a monthly campaign and an annual/always-on one, the
 * monthly campaign must get the first claim on their post.
 */
export async function listCampaignsForMaterialize(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return []
  const rows = await prisma.campaign.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE' },
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

  const brandTokens = await prisma.socialToken.findMany({
    where: { platform: 'INSTAGRAM', tokenType: 'brand', userId: campaign.userId },
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
      // Prefer upgrading an Apify row for the same post (matched by shortcode).
      // Media has a GLOBAL unique on (externalId, platform), so the externalId
      // branch must not be scoped to this campaign or create() would collide.
      const shortcode = shortcodeOf(mm.permalink)
      const existing = await prisma.media.findFirst({
        where: {
          platform: 'INSTAGRAM' as Platform,
          OR: [
            { externalId: mm.igMediaId },
            ...(shortcode ? [{ campaignId, permalink: { contains: `/${shortcode}` } }] : []),
          ],
        },
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
        await prisma.media.update({
          where: { id: existing.id },
          data: {
            ...metaMetrics,
            // Claim for this campaign only when the row is unattached or
            // already ours — a row can belong to ONE campaign and another
            // campaign's attachment must not be stolen (same as the Apify pass)
            ...(!existing.campaignId || existing.campaignId === campaignId ? { campaignId } : {}),
            // Keep the larger like/comment counts (Apify sometimes sees more
            // recent numbers than a stale Meta sync)
            likes: Math.max(existing.likes, metaMetrics.likes),
            comments: Math.max(existing.comments, metaMetrics.comments),
          },
        })
        stats.updated++
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
