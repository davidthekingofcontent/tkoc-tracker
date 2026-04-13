import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeProfile, isApifyConfiguredAsync } from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { calculateWarmScore, type WarmScoreInput } from '@/lib/matching-engine'
import { Platform } from '@/generated/prisma/client'

const MAX_PER_BATCH = 10

/**
 * POST /api/live-capture/enrich
 *
 * Processes unprocessed Live Captures by:
 * 1. Scraping each handle via Apify
 * 2. Running full enrichment pipeline
 * 3. Creating ClientContact + ClientCreatorMatch
 * 4. Calculating Warm Creator Score
 *
 * Auth: session (dashboard) or x-cron-secret (cron)
 * Body: { captureId?: string }
 */
export async function POST(request: NextRequest) {
  // Auth: session or cron secret
  const session = await getSession(request)
  const cronSecret = process.env.CRON_SECRET
  const providedSecret =
    request.headers.get('x-cron-secret') ||
    request.headers.get('Authorization')?.replace('Bearer ', '')

  if (!session && !(cronSecret && providedSecret === cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check Apify is configured
  const apifyReady = await isApifyConfiguredAsync()
  if (!apifyReady) {
    return NextResponse.json(
      { error: 'Apify API key not configured' },
      { status: 503 }
    )
  }

  let body: { captureId?: string } = {}
  try {
    body = await request.json()
  } catch {
    // empty body is fine
  }

  const summary = {
    processed: 0,
    enriched: 0,
    matchesCreated: 0,
    errors: 0,
    details: [] as string[],
  }

  try {
    // Find unprocessed captures
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      isProcessed: false,
      matchedContactId: null,
    }

    if (body.captureId) {
      where.id = body.captureId
    }

    const captures = await prisma.liveCapture.findMany({
      where,
      take: MAX_PER_BATCH,
      orderBy: { createdAt: 'asc' },
      include: {
        widget: {
          select: { userId: true },
        },
      },
    })

    if (captures.length === 0) {
      return NextResponse.json({
        message: 'No unprocessed captures found',
        ...summary,
      })
    }

    for (const capture of captures) {
      try {
        const userId = capture.widget.userId
        const handles: { handle: string; platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' }[] = []

        if (capture.instagramHandle) {
          handles.push({ handle: capture.instagramHandle, platform: 'INSTAGRAM' })
        }
        if (capture.tiktokHandle) {
          handles.push({ handle: capture.tiktokHandle, platform: 'TIKTOK' })
        }
        if (capture.youtubeHandle) {
          handles.push({ handle: capture.youtubeHandle, platform: 'YOUTUBE' })
        }

        if (handles.length === 0) {
          // No handles to process, mark as processed with no match
          await prisma.liveCapture.update({
            where: { id: capture.id },
            data: { isProcessed: true },
          })
          summary.processed++
          continue
        }

        // Try to scrape and enrich each handle
        let enrichedCreatorId: string | null = null
        let enrichedPlatform: Platform | null = null
        let enrichedFollowers = 0
        let enrichedEngagement = 0
        let enrichedCategories: string[] = []
        let enrichedSpainFitScore: number | null = null

        for (const { handle, platform } of handles) {
          try {
            // First check if profile already exists (may have been added since capture was created)
            const existingProfile = await prisma.creatorPlatformProfile.findUnique({
              where: { platform_username: { platform, username: handle } },
              select: {
                creatorId: true,
                followers: true,
                engagementRate: true,
              },
            })

            if (existingProfile) {
              enrichedCreatorId = existingProfile.creatorId
              enrichedPlatform = platform as Platform
              enrichedFollowers = existingProfile.followers || 0
              enrichedEngagement = existingProfile.engagementRate || 0
              break
            }

            // Scrape via Apify
            console.log(`[LiveCapture Enrich] Scraping ${platform}:@${handle}...`)
            const scraped = await scrapeProfile(handle, platform)

            if (!scraped) {
              console.log(`[LiveCapture Enrich] No data returned for ${platform}:@${handle}`)
              continue
            }

            // Run full enrichment pipeline
            console.log(`[LiveCapture Enrich] Enriching ${platform}:@${handle}...`)
            const enrichResult = await enrichCreatorFull(scraped, platform as Platform)

            enrichedCreatorId = enrichResult.creatorId
            enrichedPlatform = platform as Platform
            enrichedFollowers = scraped.followers
            enrichedEngagement = scraped.engagementRate
            enrichedCategories = enrichResult.categories
            enrichedSpainFitScore = enrichResult.spainFitScore
            summary.enriched++

            console.log(`[LiveCapture Enrich] Enriched ${platform}:@${handle} -> creator ${enrichResult.creatorId} (${enrichResult.isNew ? 'new' : 'updated'})`)
            break // Use the first successfully enriched handle
          } catch (scrapeErr) {
            console.error(`[LiveCapture Enrich] Failed to scrape ${platform}:@${handle}:`, scrapeErr instanceof Error ? scrapeErr.message : scrapeErr)
            summary.details.push(`Failed ${platform}:@${handle}: ${scrapeErr instanceof Error ? scrapeErr.message : 'Unknown error'}`)
          }
        }

        if (enrichedCreatorId) {
          // Create ClientContact
          const socialHandles: Record<string, string> = {}
          if (capture.instagramHandle) socialHandles.instagram = capture.instagramHandle
          if (capture.tiktokHandle) socialHandles.tiktok = capture.tiktokHandle
          if (capture.youtubeHandle) socialHandles.youtube = capture.youtubeHandle

          const contact = await prisma.clientContact.create({
            data: {
              userId,
              source: 'API',
              contactName: capture.name || capture.instagramHandle || capture.tiktokHandle || capture.youtubeHandle || 'Unknown',
              contactEmail: capture.email || null,
              socialHandles,
              tags: ['live_capture', 'auto_enriched'],
              relationshipType: 'LEAD',
              relationshipStatus: 'ACTIVE',
            },
          })

          // Create ClientCreatorMatch
          const match = await prisma.clientCreatorMatch.create({
            data: {
              userId,
              clientContactId: contact.id,
              creatorProfileId: enrichedCreatorId,
              confidenceScore: 0.95,
              confidenceLevel: 'EXACT',
              matchSignals: [
                'live_capture_handle_exact',
                ...(enrichedFollowers > 0 ? [`followers:${enrichedFollowers}`] : []),
                ...(enrichedEngagement > 0 ? [`engagement:${enrichedEngagement.toFixed(2)}%`] : []),
                ...(enrichedCategories.length > 0 ? [`categories:${enrichedCategories.slice(0, 3).join(',')}`] : []),
              ],
              matchStatus: 'AUTO_DETECTED',
            },
          })

          // Calculate Warm Creator Score
          try {
            // Get creator data for scoring
            const creator = await prisma.creatorProfile.findUnique({
              where: { id: enrichedCreatorId },
              include: {
                platformProfiles: {
                  where: enrichedPlatform ? { platform: enrichedPlatform } : undefined,
                  take: 1,
                },
              },
            })

            if (creator) {
              const platformProfile = creator.platformProfiles[0]

              // Estimate posts per month from recent posts
              const recentPosts = await prisma.creatorPost.findMany({
                where: { creatorId: enrichedCreatorId },
                orderBy: { postedAt: 'desc' },
                take: 20,
                select: { postedAt: true },
              })

              let postsPerMonth = 4 // default
              if (recentPosts.length >= 2) {
                const validDates = recentPosts
                  .map(p => p.postedAt)
                  .filter((d): d is Date => d !== null)
                if (validDates.length >= 2) {
                  const newest = validDates[0].getTime()
                  const oldest = validDates[validDates.length - 1].getTime()
                  const monthSpan = Math.max((newest - oldest) / (1000 * 60 * 60 * 24 * 30), 1)
                  postsPerMonth = Math.round(validDates.length / monthSpan)
                }
              }

              // Check for brand mentions
              const brandMentions = await prisma.creatorBrandMention.count({
                where: { creatorId: enrichedCreatorId },
              })

              const warmInput: WarmScoreInput = {
                relationshipType: 'LEAD',
                relationshipStatus: 'ACTIVE',
                lastActivityAt: new Date(),
                followers: platformProfile?.followers || enrichedFollowers,
                engagementRate: platformProfile?.engagementRate || enrichedEngagement,
                postsPerMonth,
                avgViews: platformProfile?.avgViews || 0,
                confidenceScore: 0.95,
                hasMentionedBrand: brandMentions > 0,
                brandMentionCount: brandMentions,
                hasConsistentContent: postsPerMonth >= 4,
                promotionalRatio: 0.1, // conservative default
                nicheAlignment: enrichedCategories.length > 0 ? 0.6 : 0.3,
                geoAlignment: creator.geoCountry === 'ES',
              }

              const warmResult = calculateWarmScore(warmInput)

              await prisma.warmCreatorScore.create({
                data: {
                  userId,
                  matchId: match.id,
                  creatorProfileId: enrichedCreatorId,
                  opportunityScore: warmResult.opportunityScore,
                  opportunityGrade: warmResult.opportunityGrade,
                  opportunityReasons: warmResult.opportunityReasons,
                  riskFlags: warmResult.riskFlags,
                  recommendedUse: warmResult.recommendedUse,
                  brandFitScore: warmResult.brandFitScore,
                  easeOfActivation: warmResult.easeOfActivation,
                  expectedResponseRate: warmResult.expectedResponseRate,
                },
              })
            }
          } catch (scoreErr) {
            console.error(`[LiveCapture Enrich] Warm score error for capture ${capture.id}:`, scoreErr instanceof Error ? scoreErr.message : scoreErr)
          }

          // Mark capture as processed
          await prisma.liveCapture.update({
            where: { id: capture.id },
            data: {
              isProcessed: true,
              matchedContactId: contact.id,
            },
          })

          summary.matchesCreated++
          summary.processed++
        } else {
          // Could not enrich any handle — still mark as processed to avoid infinite retries
          await prisma.liveCapture.update({
            where: { id: capture.id },
            data: { isProcessed: true },
          })
          summary.processed++
          summary.details.push(`Capture ${capture.id}: no handles could be enriched`)
        }
      } catch (captureErr) {
        console.error(`[LiveCapture Enrich] Error processing capture ${capture.id}:`, captureErr instanceof Error ? captureErr.message : captureErr)
        summary.errors++
        summary.details.push(`Capture ${capture.id}: ${captureErr instanceof Error ? captureErr.message : 'Unknown error'}`)
      }
    }

    return NextResponse.json({
      message: `Processed ${summary.processed} captures`,
      ...summary,
    })
  } catch (error) {
    console.error('[LiveCapture Enrich] Fatal error:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
