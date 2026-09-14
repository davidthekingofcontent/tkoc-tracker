import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { getNextJob, completeJob, failJob, recoverStaleJobs } from '@/lib/crawl-queue'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { scrapeHashtag, scrapeProfile, isApifyConfigured } from '@/lib/apify'
import type { HashtagResult } from '@/lib/apify'

const MAX_JOBS_PER_RUN = 5

/**
 * Platforms whose hashtag scraper reports the author's follower count
 * (TikTok: authorMeta.fans; YouTube: subscriberCount). Instagram's hashtag
 * scraper never does (apify.ts hard-codes authorFollowers 0), so an Instagram
 * hashtag job could neither create nor refresh anything: it is completed
 * without paying for the scrape.
 */
const HASHTAG_PLATFORMS_WITH_FOLLOWERS: ReadonlySet<Platform> = new Set<Platform>([Platform.TIKTOK, Platform.YOUTUBE])

/**
 * GET /api/cron/discovery
 *
 * Cron-compatible endpoint that:
 * 1. Recovers stale jobs
 * 2. Picks up pending CrawlJobs from the queue
 * 3. Executes them (hashtag jobs only refresh follower counts of creators
 *    already in the pool; profile_scrape/enrichment jobs enrich, score and
 *    categorize the requested creator)
 * 4. Limit: max 5 jobs per run
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
    skippedUnknownAuthors: number
    errors: string[]
    staleRecovered: number
  } = {
    jobsProcessed: 0,
    creatorsDiscovered: 0,
    creatorsUpdated: 0,
    skippedUnknownAuthors: 0,
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

/**
 * Hashtag discovery never CREATES a creator and never bills a profile scrape:
 * the hashtag scraper only knows the author's username/name (Instagram: never
 * followers, bio or avatar), and creating rows from that is how the ~2.993
 * zero-follower shells were born in April 2026. The only write is a targeted
 * follower refresh for an author that already is a REAL creator in the pool
 * (followers > 0) when the scraper did report a count; engagement rate,
 * averages, bio and lastScraped are never touched, so a real refresh stays
 * due. Unknown authors are counted
 * in `skippedUnknownAuthors`, shells in `skippedShellAuthors`.
 */
async function processHashtagDiscovery(
  jobId: string,
  hashtag: string,
  platform: Platform,
  results: { creatorsDiscovered: number; creatorsUpdated: number; skippedUnknownAuthors: number; errors: string[] }
): Promise<void> {
  if (!HASHTAG_PLATFORMS_WITH_FOLLOWERS.has(platform)) {
    await completeJob(jobId, {
      itemsFound: 0,
      skippedUnknownAuthors: 0,
      disabled: true,
      hashtag,
      message: `Hashtag discovery disabled for ${platform}: its hashtag scraper reports no follower data, so nothing could be created or refreshed (scrape not run)`,
    })
    return
  }

  const platformStr = platform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  const hashtagResults: HashtagResult[] = await scrapeHashtag(hashtag, platformStr, 30)

  if (!hashtagResults || hashtagResults.length === 0) {
    await completeJob(jobId, { itemsFound: 0, skippedUnknownAuthors: 0, message: 'No results from hashtag scrape' })
    return
  }

  let processedCount = 0
  let skippedUnknownAuthors = 0
  let skippedShellAuthors = 0
  let knownAuthorsWithoutData = 0

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
      const existing = await prisma.creatorPlatformProfile.findUnique({
        where: { platform_username: { platform, username } },
        select: { id: true, followers: true },
      })

      // Hashtag data alone may only refresh a creator that already exists — never create one.
      if (!existing) {
        skippedUnknownAuthors++
        results.skippedUnknownAuthors++
        continue
      }

      // A shell (followers 0) is never promoted by a hashtag result: it would
      // pass the real-profile gate with no bio, ER or averages.
      if (!(existing.followers > 0)) {
        skippedShellAuthors++
        continue
      }

      const reportedFollowers = Math.floor(hashtagResult.authorFollowers || 0)
      if (reportedFollowers > 0) {
        await prisma.creatorPlatformProfile.update({
          where: { id: existing.id },
          data: { followers: reportedFollowers },
        })
        results.creatorsUpdated++
        processedCount++
      } else {
        knownAuthorsWithoutData++
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      results.errors.push(`Creator ${username}: ${errMsg}`)
    }
  }

  await completeJob(jobId, {
    itemsFound: processedCount,
    totalAuthors: authorMap.size,
    skippedUnknownAuthors,
    skippedShellAuthors,
    knownAuthorsWithoutData,
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
