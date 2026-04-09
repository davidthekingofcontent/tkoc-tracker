import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { getNextJob, completeJob, failJob, recoverStaleJobs } from '@/lib/crawl-queue'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { scrapeHashtag, scrapeProfile, isApifyConfigured } from '@/lib/apify'
import type { ScrapedProfile, HashtagResult } from '@/lib/apify'

const MAX_JOBS_PER_RUN = 5

/**
 * GET /api/cron/discovery
 *
 * Cron-compatible endpoint that:
 * 1. Recovers stale jobs
 * 2. Picks up pending CrawlJobs from the queue
 * 3. Executes them (scrape hashtag, process results)
 * 4. For each discovered creator: enriches, scores, categorizes
 * 5. Limit: max 5 jobs per run
 *
 * Auth: x-cron-secret header or ?secret= query param
 */
export async function GET(request: NextRequest) {
  // Auth check
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (provided !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const results: {
    jobsProcessed: number
    creatorsDiscovered: number
    creatorsUpdated: number
    errors: string[]
    staleRecovered: number
  } = {
    jobsProcessed: 0,
    creatorsDiscovered: 0,
    creatorsUpdated: 0,
    errors: [],
    staleRecovered: 0,
  }

  try {
    // Check Apify is configured
    if (!isApifyConfigured()) {
      return NextResponse.json({ error: 'Apify not configured' }, { status: 400 })
    }

    // Recover stale jobs first
    results.staleRecovered = await recoverStaleJobs()

    // Process up to MAX_JOBS_PER_RUN jobs
    for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
      const job = await getNextJob()
      if (!job) break // No more pending jobs

      results.jobsProcessed++

      try {
        switch (job.jobType) {
          case 'hashtag_discovery':
            await processHashtagDiscovery(job.id, job.target, job.platform || Platform.INSTAGRAM, results)
            break

          case 'profile_scrape':
            await processProfileScrape(job.id, job.target, job.platform || Platform.INSTAGRAM, results)
            break

          case 'enrichment':
            await processEnrichment(job.id, job.target, job.platform || Platform.INSTAGRAM, results)
            break

          default:
            await failJob(job.id, `Unknown job type: ${job.jobType}`)
            results.errors.push(`Unknown job type: ${job.jobType}`)
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        await failJob(job.id, errMsg)
        results.errors.push(`Job ${job.id} (${job.jobType}): ${errMsg}`)
      }
    }

    return NextResponse.json({
      success: true,
      ...results,
    })
  } catch (error) {
    console.error('[Discovery Cron] Error:', error)
    return NextResponse.json(
      { error: 'Discovery cron failed', details: String(error), ...results },
      { status: 500 }
    )
  }
}

// ============ JOB PROCESSORS ============

async function processHashtagDiscovery(
  jobId: string,
  hashtag: string,
  platform: Platform,
  results: { creatorsDiscovered: number; creatorsUpdated: number; errors: string[] }
): Promise<void> {
  const platformStr = platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  const hashtagResults: HashtagResult[] = await scrapeHashtag(hashtag, platformStr, 30)

  if (!hashtagResults || hashtagResults.length === 0) {
    await completeJob(jobId, { itemsFound: 0, message: 'No results from hashtag scrape' })
    return
  }

  let processedCount = 0

  // Group posts by author and process each unique creator
  const authorMap = new Map<string, HashtagResult>()
  for (const result of hashtagResults) {
    if (result.authorUsername && !authorMap.has(result.authorUsername)) {
      authorMap.set(result.authorUsername, result)
    }
  }

  for (const [username, hashtagResult] of authorMap) {
    if (!username) continue

    try {
      // Check if creator already exists to avoid unnecessary full scrapes
      const existing = await prisma.creatorPlatformProfile.findUnique({
        where: { platform_username: { platform, username } },
      })

      // Build a minimal ScrapedProfile from hashtag data for enrichment
      const minimalProfile: ScrapedProfile = {
        username,
        displayName: hashtagResult.authorDisplayName,
        bio: null,
        avatarUrl: hashtagResult.authorAvatarUrl,
        followers: hashtagResult.authorFollowers || 0,
        following: 0,
        postsCount: 0,
        engagementRate: 0,
        avgLikes: 0,
        avgComments: 0,
        avgViews: 0,
        isVerified: false,
        website: null,
        email: null,
        country: hashtagResult.authorCountry || null,
        city: null,
        recentPosts: hashtagResult.posts || [],
      }

      // If creator is new or hasn't been scraped recently, do full enrichment
      const needsFullScrape = !existing ||
        !existing.lastScraped ||
        (Date.now() - existing.lastScraped.getTime()) > 7 * 24 * 60 * 60 * 1000 // 7 days

      if (needsFullScrape && hashtagResult.authorFollowers >= 1000) {
        // Try full profile scrape for better data
        try {
          const fullProfile = await scrapeProfile(username, platformStr)
          if (fullProfile) {
            const enrichResult = await enrichCreatorFull(fullProfile, platform)
            if (enrichResult.isNew) {
              results.creatorsDiscovered++
            } else {
              results.creatorsUpdated++
            }
            processedCount++
            continue
          }
        } catch {
          // Full scrape failed, fall back to minimal profile
        }
      }

      // Use minimal profile from hashtag data
      if (minimalProfile.followers >= 500 || !existing) {
        const enrichResult = await enrichCreatorFull(minimalProfile, platform)
        if (enrichResult.isNew) {
          results.creatorsDiscovered++
        } else {
          results.creatorsUpdated++
        }
        processedCount++
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      results.errors.push(`Creator ${username}: ${errMsg}`)
    }
  }

  await completeJob(jobId, {
    itemsFound: processedCount,
    totalAuthors: authorMap.size,
    hashtag,
  })
}

async function processProfileScrape(
  jobId: string,
  username: string,
  platform: Platform,
  results: { creatorsDiscovered: number; creatorsUpdated: number; errors: string[] }
): Promise<void> {
  const platformStr = platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  const profile = await scrapeProfile(username, platformStr)

  if (!profile) {
    await failJob(jobId, `Could not scrape profile: ${username}`)
    return
  }

  const enrichResult = await enrichCreatorFull(profile, platform)

  if (enrichResult.isNew) {
    results.creatorsDiscovered++
  } else {
    results.creatorsUpdated++
  }

  await completeJob(jobId, {
    itemsFound: 1,
    creatorId: enrichResult.creatorId,
    spainFitScore: enrichResult.spainFitScore,
    categories: enrichResult.categories,
  })
}

async function processEnrichment(
  jobId: string,
  username: string,
  platform: Platform,
  results: { creatorsDiscovered: number; creatorsUpdated: number; errors: string[] }
): Promise<void> {
  // Find existing platform profile
  const existing = await prisma.creatorPlatformProfile.findUnique({
    where: { platform_username: { platform, username } },
  })

  if (!existing) {
    // Need to scrape first
    return processProfileScrape(jobId, username, platform, results)
  }

  // Re-scrape and enrich
  const platformStr = platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  const profile = await scrapeProfile(username, platformStr)

  if (!profile) {
    await failJob(jobId, `Could not scrape profile for enrichment: ${username}`)
    return
  }

  const enrichResult = await enrichCreatorFull(profile, platform)
  results.creatorsUpdated++

  await completeJob(jobId, {
    itemsFound: 1,
    creatorId: enrichResult.creatorId,
    spainFitScore: enrichResult.spainFitScore,
    categories: enrichResult.categories,
  })
}
