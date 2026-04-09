import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { SPAIN_CATEGORIES, seedSpainCategories } from '@/lib/spain-categories'
import { enqueueCrawlJob } from '@/lib/crawl-queue'

/**
 * POST /api/discovery/seed
 *
 * Seeds the discovery engine by:
 * 1. Inserting/updating Spain categories in the DB
 * 2. Enqueuing CrawlJobs for hashtag discovery per category
 *
 * Body (all optional):
 *   categories?: string[]    - specific category slugs to seed (default: all)
 *   hashtags?: string[]      - additional custom hashtags to crawl
 *   platforms?: Platform[]   - platforms to target (default: [INSTAGRAM, TIKTOK])
 *
 * Requires ADMIN role.
 */
export async function POST(request: NextRequest) {
  // Auth check
  const session = await getSession(request)
  if (!session || session.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized - Admin only' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({})) as {
      categories?: string[]
      hashtags?: string[]
      platforms?: Platform[]
    }

    const platforms = body.platforms || [Platform.INSTAGRAM, Platform.TIKTOK]

    // Step 1: Seed categories into DB
    const seedResult = await seedSpainCategories()

    // Step 2: Determine which categories to crawl
    let categoriesToCrawl = SPAIN_CATEGORIES
    if (body.categories && body.categories.length > 0) {
      categoriesToCrawl = SPAIN_CATEGORIES.filter(c => body.categories!.includes(c.slug))
    }

    // Step 3: Enqueue crawl jobs for each category's hashtags on each platform
    const jobIds: string[] = []
    let jobsEnqueued = 0

    for (const cat of categoriesToCrawl) {
      for (const hashtag of cat.hashtagsEs) {
        for (const platform of platforms) {
          const jobId = await enqueueCrawlJob({
            jobType: 'hashtag_discovery',
            platform,
            target: hashtag.replace('#', ''),
            priority: 5,
          })
          jobIds.push(jobId)
          jobsEnqueued++
        }
      }
    }

    // Step 4: Enqueue additional custom hashtags if provided
    if (body.hashtags && body.hashtags.length > 0) {
      for (const hashtag of body.hashtags) {
        for (const platform of platforms) {
          const jobId = await enqueueCrawlJob({
            jobType: 'hashtag_discovery',
            platform,
            target: hashtag.replace('#', ''),
            priority: 3, // Higher priority for custom hashtags
          })
          jobIds.push(jobId)
          jobsEnqueued++
        }
      }
    }

    // Get queue stats
    const queueStats = await prisma.crawlJob.groupBy({
      by: ['status'],
      _count: true,
    })

    return NextResponse.json({
      success: true,
      seed: {
        categoriesCreated: seedResult.created,
        categoriesUpdated: seedResult.updated,
        totalCategories: SPAIN_CATEGORIES.length,
      },
      crawl: {
        jobsEnqueued,
        categoriesCrawled: categoriesToCrawl.length,
        platforms,
      },
      queue: Object.fromEntries(queueStats.map(s => [s.status, s._count])),
    })
  } catch (error) {
    console.error('[Discovery Seed] Error:', error)
    return NextResponse.json(
      { error: 'Seed failed', details: String(error) },
      { status: 500 }
    )
  }
}
