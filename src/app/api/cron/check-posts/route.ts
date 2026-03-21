import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { isApifyConfiguredAsync, scrapeProfile } from '@/lib/apify'
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
    const isConfigured = await isApifyConfiguredAsync()
    if (!isConfigured) {
      return NextResponse.json({ error: 'Apify not configured' }, { status: 400 })
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
        console.log(`[Cron/CheckPosts] Scraping @${inf.username} on ${inf.platform}...`)
        const profile = await scrapeProfile(inf.username, inf.platform)

        if (!profile || !profile.recentPosts.length) continue

        // Check which posts are new (not in our DB yet)
        const existingExternalIds = new Set(
          (await prisma.media.findMany({
            where: {
              influencerId: inf.id,
              externalId: { in: profile.recentPosts.map(p => p.externalId).filter(Boolean) },
            },
            select: { externalId: true },
          })).map(m => m.externalId).filter(Boolean)
        )

        const newPosts = profile.recentPosts.filter(p =>
          p.externalId && !existingExternalIds.has(p.externalId)
        )

        if (newPosts.length === 0) continue

        console.log(`[Cron/CheckPosts] Found ${newPosts.length} new posts from @${inf.username}`)

        // Save new posts to DB and check if they match campaign hashtags/mentions
        for (const post of newPosts) {
          for (const campaignId of inf.campaignIds) {
            const campaign = activeCampaigns.find(c => c.id === campaignId)
            if (!campaign) continue

            // Check if post is relevant to this campaign (mentions target accounts or uses target hashtags)
            const postHashtags = post.hashtags.map(h => h.toLowerCase().replace('#', ''))
            const postMentions = post.mentions.map(m => m.toLowerCase().replace('@', ''))
            const campaignHashtags = campaign.targetHashtags.map(h => h.toLowerCase().replace('#', ''))
            const campaignAccounts = campaign.targetAccounts.map(a => a.toLowerCase().replace('@', ''))

            const matchesHashtag = campaignHashtags.length === 0 || campaignHashtags.some(h => postHashtags.includes(h))
            const matchesMention = campaignAccounts.length === 0 || campaignAccounts.some(a => postMentions.includes(a))

            // If campaign has targets, at least one must match
            if (campaignHashtags.length > 0 || campaignAccounts.length > 0) {
              if (!matchesHashtag && !matchesMention) continue
            }

            try {
              await prisma.media.create({
                data: {
                  externalId: post.externalId,
                  platform: inf.platform,
                  mediaType: post.mediaType,
                  caption: post.caption,
                  mediaUrl: post.mediaUrl,
                  thumbnailUrl: post.thumbnailUrl,
                  permalink: post.permalink,
                  likes: post.likes,
                  comments: post.comments,
                  shares: post.shares,
                  saves: post.saves,
                  views: post.views,
                  postedAt: post.postedAt ? new Date(post.postedAt) : null,
                  hashtags: post.hashtags,
                  mentions: post.mentions,
                  influencerId: inf.id,
                  campaignId,
                  isAdDisclosed: campaign.paymentType === 'PAID' ? hasAdDisclosure(post.caption) : false,
                },
              })
              totalNewPosts++

              // Send notification
              const platformName = inf.platform === 'INSTAGRAM' ? 'Instagram' : inf.platform === 'TIKTOK' ? 'TikTok' : 'YouTube'
              notifyAllTeam({
                type: 'media_posted',
                title: `@${inf.username} ha publicado`,
                message: `@${inf.username} ha publicado en ${platformName} para la campaña "${campaign.name}". ${post.permalink ? `Ver: ${post.permalink}` : ''} Consejo: espera 7 días antes de revisar las métricas.`,
                link: `/campaigns/${campaignId}`,
              }).catch(() => {})

            } catch {
              // Skip duplicates
            }
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
          },
        })

        // Small delay between profiles to be nice to Apify
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
