import { prisma } from '@/lib/db'
import { Platform, MediaType } from '@/generated/prisma/client'
import { isWithinCampaignDates, itemReferencesBrand, normalizeBrandToken } from '@/lib/campaign-capture'

/**
 * Materialize Meta Graph API content (MetaMedia + MetaStoryMention) into the
 * Media table for a campaign, so every existing aggregate (overview, timeline,
 * EMV, exports, report page) sees it without special-casing.
 *
 * - Matches poster username against the campaign's INSTAGRAM member influencers
 * - Respects campaign start/end dates
 * - One Media row per (post, campaign): a post counts in every campaign whose
 *   rules it satisfies. Within a campaign, dedups against Apify-captured rows
 *   by Instagram shortcode (Apify and Meta use different external IDs for the
 *   same post, but permalinks share the /p/{shortcode}/ or /reel/{shortcode}/
 *   segment) and upgrades that row in place with Meta's real metrics.
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

  // Which brand account each connection is (latest snapshot username). A
  // tagged post is attributed to a campaign ONLY if that brand handle is one of
  // the campaign's targetAccounts — otherwise a creator tagging @vileda.es would
  // land in another brand's campaign just for being a member with matching dates.
  const brandHandleByToken = new Map<string, string>()
  for (const tokenId of tokenIds) {
    const snap = await prisma.metaAccountSnapshot.findFirst({
      where: { socialTokenId: tokenId },
      orderBy: { capturedAt: 'desc' },
      select: { igUsername: true },
    })
    if (snap?.igUsername) brandHandleByToken.set(tokenId, snap.igUsername.toLowerCase().replace(/^@/, '').trim())
  }
  const campaignTargets = new Set((campaign.targetAccounts || []).map(a => normalizeBrandToken(a.replace(/^[@#]+/, ''))))
  const usableTokenIds = tokenIds.filter(id => {
    const h = brandHandleByToken.get(id)
    return !!h && campaignTargets.has(normalizeBrandToken(h))
  })
  if (usableTokenIds.length === 0) return stats // campaign has no target among the connected brands (or no targets at all)

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
      where: { socialTokenId: { in: usableTokenIds }, igUsername: { not: null } },
    }),
    prisma.metaStoryMention.findMany({
      where: { socialTokenId: { in: usableTokenIds } },
    }),
  ])
  const captionMentions = (caption: string | null | undefined) =>
    Array.from(new Set((caption || '').match(/@([A-Za-z0-9_.]+)/g)?.map(m => m.slice(1).toLowerCase()) ?? []))
  const mentionsFor = (tokenId: string, caption: string | null | undefined) => {
    const brand = brandHandleByToken.get(tokenId)!
    return Array.from(new Set([brand, ...captionMentions(caption)]))
  }

  const handledIgMediaIds = new Set<string>()

  for (const mm of metaMedia) {
    const member = mm.igUsername ? igMembers.get(normalize(mm.igUsername)) : undefined
    if (!member) continue
    if (!inRange(mm.postedAt)) continue
    const mentions = mentionsFor(mm.socialTokenId, mm.caption)
    // Rule (3) with the tagged brand as an explicit mention (also covers "no targets → nothing")
    if (!itemReferencesBrand(campaign, { caption: mm.caption, hashtags: [], mentions })) continue
    handledIgMediaIds.add(mm.igMediaId)

    try {
      // One row per (post, campaign): look for THIS campaign's row (by Graph id
      // or by shortcode, since an Apify row uses a different externalId) or an
      // unattached one to claim. Other campaigns' rows are their own copies.
      const shortcode = shortcodeOf(mm.permalink)
      const existing = await prisma.media.findFirst({
        where: {
          platform: 'INSTAGRAM' as Platform,
          AND: [
            {
              OR: [
                { externalId: mm.igMediaId },
                ...(shortcode ? [{ permalink: { contains: `/${shortcode}` } }] : []),
              ],
            },
            { OR: [{ campaignId }, { campaignId: null }] },
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
        await prisma.media.update({
          where: { id: existing.id },
          data: {
            ...metaMetrics,
            mentions: Array.from(new Set([...(existing.mentions || []), ...mentions])),
            // Manual rows keep their own bookkeeping; only enrich metrics.
            ...(existing.source === 'manual' ? { source: 'manual' } : {}),
            campaignId,
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
            mentions,
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
    const storyMentions = mentionsFor(sm.socialTokenId, null)
    if (!itemReferencesBrand(campaign, { caption: null, hashtags: [], mentions: storyMentions })) continue

    try {
      const existing = await prisma.media.findFirst({
        where: {
          platform: 'INSTAGRAM' as Platform,
          externalId: sm.mentionMediaId,
          OR: [{ campaignId }, { campaignId: null }],
        },
        orderBy: { campaignId: { sort: 'desc', nulls: 'last' } },
        select: { id: true, campaignId: true },
      })
      if (existing) {
        if (!existing.campaignId) await prisma.media.update({ where: { id: existing.id }, data: { campaignId } })
        continue // stories carry no new metrics — nothing else to upgrade
      }

      await prisma.media.create({
        data: {
          externalId: sm.mentionMediaId,
          platform: 'INSTAGRAM' as Platform,
          mediaType: 'STORY' as MediaType,
          source: 'meta_api',
          dataSource: 'api',
          mentions: storyMentions,
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
