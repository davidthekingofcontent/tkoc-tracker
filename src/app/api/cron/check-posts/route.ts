import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { cronGate, cronSkipped, markCronRun } from '@/lib/cron-throttle'
import { campaignHasTargets, mediaMatchesCampaignRules, scrapedPostToRuleItem, upsertCampaignPost } from '@/lib/campaign-capture'
import { isApifyConfiguredAsync } from '@/lib/apify'
import { fetchProfile } from '@/lib/platform-client'
import { isYouTubeApiConfigured } from '@/lib/youtube-api'
import { notifyAllTeam } from '@/lib/notifications'
import { afterInfluencerUpsert, scrapedProfileUpdate } from '@/lib/influencer-upsert'
import type { ScrapedProfile } from '@/lib/apify'

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

  // The 24 h stamp is written AFTER the work (finally): stamping first meant a
  // redeploy mid-run skipped the remaining creators until the next day. It is
  // only written when the loop finished or at least one creator was checked;
  // per-creator progress lives in Setting checkposts_checked so a killed run
  // resumes where it stopped on the next tick.
  let finished = false
  let processed = 0
  try {
    const force = request.nextUrl.searchParams.get('force') === '1'
    // One profile scrape per confirmed creator of every active campaign: once a day (posts do not expire)
    const gate = await cronGate('check-posts', 24, force)
    if (!gate.allowed) return NextResponse.json(cronSkipped('check-posts', gate))

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
      finished = true
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

    // Resume support: creators checked < 20 h ago (by a run that was killed
    // before stamping) are skipped, unless ?force=1 asks for everything again.
    const checkedLog = await loadMap(CHECKED_KEY)
    const recheckMs = RECHECK_HOURS * 3_600_000
    const nowMs = Date.now()
    let alreadyChecked = 0
    if (!force) {
      for (const key of Array.from(influencerMap.keys())) {
        const t = Date.parse(checkedLog[key] || '')
        if (Number.isFinite(t) && nowMs - t < recheckMs) {
          influencerMap.delete(key)
          alreadyChecked++
        }
      }
    }

    console.log(`[Cron/CheckPosts] Checking ${influencerMap.size} influencers across ${activeCampaigns.length} campaigns (${alreadyChecked} checked < ${RECHECK_HOURS} h ago, skipped)`)

    let totalNewPosts = 0
    const errors: string[] = []

    // Check each influencer (rate limited to avoid overwhelming Apify)
    for (const [key, inf] of influencerMap) {
      try {
        console.log(`[Cron/CheckPosts] Fetching @${inf.username} on ${inf.platform}...`)
        const result = await fetchProfile(inf.username, inf.platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')

        // null = no scrape happened (Apify exhausted / not configured / all
        // sources failed): do not stamp the creator, so it is re-checked as
        // soon as the source recovers instead of after RECHECK_HOURS.
        if (!result) continue

        // The scrape (the paid part) is done: record it now so a run killed
        // later in this iteration does not pay for this creator again.
        processed++
        checkedLog[key] = new Date().toISOString()
        await saveMap(CHECKED_KEY, prune(checkedLog, 7))

        if (!result.profile.recentPosts.length) continue
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

        // Also update influencer profile data — through the shared guard: an empty
        // scrape never overwrites real followers/metrics nor stamps lastScraped
        await prisma.influencer.update({
          where: { id: inf.id },
          data: { ...scrapedProfileUpdate(profile as unknown as ScrapedProfile), dataSource },
        })
        afterInfluencerUpsert(inf.id, (profile as unknown as ScrapedProfile).avatarUrl)

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
    finished = true

    return NextResponse.json({
      success: true,
      influencersChecked: influencerMap.size,
      influencersSkipped: alreadyChecked,
      campaignsActive: activeCampaigns.length,
      newPosts: totalNewPosts,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[Cron/CheckPosts] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  } finally {
    if (finished || processed > 0) await markCronRun('check-posts')
  }
}

/** Setting checkposts_checked: "<PLATFORM>:<username>" → ISO of the last profile scrape (pruned after 7 days). */
const CHECKED_KEY = 'checkposts_checked'
const RECHECK_HOURS = 20

type IsoMap = Record<string, string>
async function loadMap(key: string): Promise<IsoMap> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } })
    const parsed = row?.value ? JSON.parse(row.value) as unknown : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as IsoMap) : {}
  } catch { return {} }
}
async function saveMap(key: string, map: IsoMap): Promise<void> {
  const value = JSON.stringify(map)
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }).catch(() => {})
}
function prune(map: IsoMap, days: number): IsoMap {
  const cutoff = Date.now() - days * 86_400_000
  return Object.fromEntries(Object.entries(map).filter(([, iso]) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= cutoff }))
}
