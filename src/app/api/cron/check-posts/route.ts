import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { campaignHasTargets, mediaMatchesCampaignRules, scrapedPostToRuleItem, upsertCampaignPost } from '@/lib/campaign-capture'
import { isApifyConfiguredAsync } from '@/lib/apify'
import { fetchProfile } from '@/lib/platform-client'
import { isYouTubeApiConfigured } from '@/lib/youtube-api'
import { notifyAllTeam } from '@/lib/notifications'

/** Ad disclosure markers to detect paid partnership disclosures */
const AD_MARKERS = [
  '#ad', '#publi', '#publicidad', '#sponsored',
  '#colaboración', '#colaboracion', '#collab',
  'partnership', 'paid partnership',
  'colaboración pagada', 'colaboracion pagada',
]

function hasAdDisclosure(caption: string | null): boolean {
  if (!caption) return false
  const lower = caption.toLowerCase()
  return AD_MARKERS.some(marker => lower.includes(marker))
}

/**
 * Cron job: Check for new posts from influencers in active campaigns.
 * Compares scraped posts against existing media in DB.
 * When new posts are detected, saves them and sends notifications.
 *
 * Should be called every 6-12 hours via an external cron service.
 * GET /api/cron/check-posts (with header x-cron-secret)
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const apifyConfigured = await isApifyConfiguredAsync()
    const youtubeConfigured = isYouTubeApiConfigured()
    if (!apifyConfigured && !youtubeConfigured) {
      return NextResponse.json({ error: 'No data source configured (Apify or YouTube API)' }, { status: 400 })
    }

    // Find active campaigns with their influencers
    const activeCampaigns = await prisma.campaign.findMany({
      where: {
        status: 'ACTIVE',
      },
      include: {
        influencers: {
          where: {
            status: { in: ['POSTED', 'CONTRACTED', 'AGREED', 'COMPLETED'] },
          },
          include: {
            influencer: {
              select: { id: true, username: true, platform: true, displayName: true },
            },
          },
        },
      },
    })

    if (activeCampaigns.length === 0) {
      return NextResponse.json({ message: 'No active campaigns', newPosts: 0 })
    }

    // Build a map of unique influencers to check
    const influencerMap = new Map<string, {
      id: string
      username: string
      platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
      displayName: string | null
      campaignIds: string[]
      campaignNames: string[]
    }>()

    for (const campaign of activeCampaigns) {
      for (const ci of campaign.influencers) {
        const inf = ci.influencer
        const key = `${inf.platform}:${inf.username}`
        const existing = influencerMap.get(key)
        if (existing) {
          if (!existing.campaignIds.includes(campaign.id)) {
            existing.campaignIds.push(campaign.id)
            existing.campaignNames.push(campaign.name)
          }
        } else {
          influencerMap.set(key, {
            id: inf.id,
            username: inf.username,
            platform: inf.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE',
            displayName: inf.displayName,
            campaignIds: [campaign.id],
            campaignNames: [campaign.name],
          })
        }
      }
    }

    console.log(`[Cron/CheckPosts] Checking ${influencerMap.size} influencers across ${activeCampaigns.length} campaigns`)

    let totalNewPosts = 0
    const errors: string[] = []

    // Check each influencer (rate limited to avoid overwhelming Apify)
    for (const [key, inf] of influencerMap) {
      try {
        console.log(`[Cron/CheckPosts] Fetching @${inf.username} on ${inf.platform}...`)
        const result = await fetchProfile(inf.username, inf.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')

        if (!result || !result.profile.recentPosts.length) continue
        const profile = result.profile
        const dataSource = result.dataSource

        // Which (post, campaign) pairs do we already hold? One row per campaign.
        const existingPairs = new Set(
          (await prisma.media.findMany({
            where: {
              influencerId: inf.id,
              externalId: { in: profile.recentPosts.map(p => p.externalId).filter(Boolean) },
            },
            select: { externalId: true, campaignId: true },
          })).map(m => `${m.externalId}|${m.campaignId ?? ''}`)
        )

        const newPosts = profile.recentPosts.filter(p =>
          p.externalId && inf.campaignIds.some(cid => !existingPairs.has(`${p.externalId}|${cid}`))
        )

        if (newPosts.length === 0) continue

        console.log(`[Cron/CheckPosts] Found ${newPosts.length} new posts from @${inf.username}`)

        // Save new posts: one row per (post, campaign) for EVERY campaign whose
        // rules the post satisfies (member + brand reference + inside dates —
        // the shared rule engine; a campaign without targets captures nothing).
        for (const post of newPosts) {
          const attachedTo: Array<{ id: string; name: string }> = []
          const item = scrapedPostToRuleItem(post)
          for (const campaignId of inf.campaignIds) {
            const campaign = activeCampaigns.find(c => c.id === campaignId)
            if (!campaign) continue
            if (existingPairs.has(`${post.externalId}|${campaignId}`)) continue
            if (!campaignHasTargets(campaign) || !mediaMatchesCampaignRules(campaign, item)) continue

            try {
              const ok = await upsertCampaignPost(campaignId, inf.id, inf.platform, post)
              if (!ok) continue
              await prisma.media.updateMany({
                where: { externalId: post.externalId, platform: inf.platform, campaignId },
                data: {
                  dataSource,
                  isAdDisclosed: campaign.paymentType === 'PAID' ? hasAdDisclosure(post.caption) : false,
                },
              })
              existingPairs.add(`${post.externalId}|${campaignId}`)
              totalNewPosts++
              attachedTo.push({ id: campaign.id, name: campaign.name })
            } catch (err) {
              console.error('[Cron/CheckPosts] save failed:', err instanceof Error ? err.message : err)
            }
          }

          // One notification per post (not per campaign copy)
          if (attachedTo.length > 0) {
            const platformName = inf.platform === 'INSTAGRAM' ? 'Instagram' : inf.platform === 'TIKTOK' ? 'TikTok' : 'YouTube'
            const names = attachedTo.map(c => `"${c.name}"`).join(', ')
            notifyAllTeam({
              type: 'media_posted',
              title: `@${inf.username} ha publicado`,
              message: `@${inf.username} ha publicado en ${platformName} para ${attachedTo.length > 1 ? 'las campañas' : 'la campaña'} ${names}. ${post.permalink ? `Ver: ${post.permalink}` : ''} Consejo: espera 7 días antes de revisar las métricas.`,
              link: `/campaigns/${attachedTo[0].id}`,
            }).catch(() => {})
          }
        }

        // Also update influencer profile data
        await prisma.influencer.update({
          where: { id: inf.id },
          data: {
            followers: profile.followers,
            following: profile.following,
            postsCount: profile.postsCount,
            engagementRate: profile.engagementRate,
            avgLikes: profile.avgLikes,
            avgComments: profile.avgComments,
            avgViews: profile.avgViews,
            avatarUrl: profile.avatarUrl || undefined,
            bio: profile.bio || undefined,
            dataSource,
            lastScraped: new Date(),
          },
        })

        // Small delay between profiles to respect rate limits
        await new Promise(r => setTimeout(r, 2000))
      } catch (err) {
        const errMsg = `Error checking @${inf.username}: ${err}`
        console.error(`[Cron/CheckPosts] ${errMsg}`)
        errors.push(errMsg)
      }
    }

    // Post-processing: check ad disclosure on all media for PAID campaigns
    let adDisclosureUpdated = 0
    try {
      const paidCampaignIds = activeCampaigns
        .filter(c => c.paymentType === 'PAID')
        .map(c => c.id)

      if (paidCampaignIds.length > 0) {
        const mediaToCheck = await prisma.media.findMany({
          where: {
            campaignId: { in: paidCampaignIds },
            isDeleted: false,
          },
          select: { id: true, caption: true, isAdDisclosed: true },
        })

        for (const m of mediaToCheck) {
          const disclosed = hasAdDisclosure(m.caption)
          if (disclosed !== m.isAdDisclosed) {
            await prisma.media.update({
              where: { id: m.id },
              data: { isAdDisclosed: disclosed },
            })
            adDisclosureUpdated++
          }
        }
      }
    } catch (err) {
      console.error('[Cron/CheckPosts] Ad disclosure check error:', err)
    }

    console.log(`[Cron/CheckPosts] Done. New posts: ${totalNewPosts}, Ad disclosure updated: ${adDisclosureUpdated}, Errors: ${errors.length}`)

    return NextResponse.json({
      success: true,
      influencersChecked: influencerMap.size,
      campaignsActive: activeCampaigns.length,
      newPosts: totalNewPosts,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[Cron/CheckPosts] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
