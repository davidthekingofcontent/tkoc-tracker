import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'

// ============ TYPES ============

export interface EnqueueJobInput {
  jobType: string
  platform?: Platform
  target: string
  priority?: number
  scheduledFor?: Date
  maxAttempts?: number
}

export interface QueueStats {
  pending: number
  running: number
  completed: number
  failed: number
}

// ============ QUEUE OPERATIONS ============

/**
 * Enqueue a new crawl job. Returns the job ID.
 * Deduplicates: if a pending/running job with same type+target exists, returns that ID instead.
 */
export async function enqueueCrawlJob(input: EnqueueJobInput): Promise<string> {
  // Check for existing pending/running job with same target
  const existing = await prisma.crawlJob.findFirst({
    where: {
      jobType: input.jobType,
      target: input.target,
      platform: input.platform,
      status: { in: ['pending', 'running'] },
    },
  })

  if (existing) {
    return existing.id
  }

  const job = await prisma.crawlJob.create({
    data: {
      jobType: input.jobType,
      platform: input.platform,
      target: input.target,
      priority: input.priority ?? 5,
      status: 'pending',
      maxAttempts: input.maxAttempts ?? 3,
      scheduledFor: input.scheduledFor,
    },
  })

  return job.id
}

/**
 * Atomically select the highest-priority pending job and mark it as running.
 * Uses a raw query with FOR UPDATE SKIP LOCKED for safe concurrent access.
 */
export async function getNextJob() {
  // Use raw query for atomic claim with row-level locking
  const now = new Date()
  const jobs = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "crawl_jobs_v2"
     SET status = 'running', "startedAt" = $1, attempts = attempts + 1
     WHERE id = (
       SELECT id FROM "crawl_jobs_v2"
       WHERE status = 'pending'
         AND (attempts < "maxAttempts")
         AND ("scheduledFor" IS NULL OR "scheduledFor" <= $1)
       ORDER BY priority ASC, "createdAt" ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id`,
    now
  )

  if (!jobs || jobs.length === 0) return null

  // Fetch the full job object
  return prisma.crawlJob.findUnique({ where: { id: jobs[0].id } })
}

/**
 * Mark a job as completed with its result.
 */
export async function completeJob(jobId: string, result: Record<string, unknown>): Promise<void> {
  await prisma.crawlJob.update({
    where: { id: jobId },
    data: {
      status: 'completed',
      result: result as object,
      itemsFound: typeof result.itemsFound === 'number' ? result.itemsFound : 0,
      completedAt: new Date(),
    },
  })
}

/**
 * Mark a job as failed with an error message.
 * If attempts < maxAttempts, resets to pending for retry.
 */
export async function failJob(jobId: string, error: string): Promise<void> {
  const job = await prisma.crawlJob.findUnique({ where: { id: jobId } })
  if (!job) return

  const shouldRetry = job.attempts < job.maxAttempts

  await prisma.crawlJob.update({
    where: { id: jobId },
    data: {
      status: shouldRetry ? 'pending' : 'failed',
      error,
      completedAt: shouldRetry ? null : new Date(),
      // Exponential backoff: schedule retry after 2^attempts minutes
      scheduledFor: shouldRetry
        ? new Date(Date.now() + Math.pow(2, job.attempts) * 60 * 1000)
        : null,
    },
  })
}

/**
 * Get queue statistics.
 */
export async function getQueueStats(): Promise<QueueStats> {
  const [pending, running, completed, failed] = await Promise.all([
    prisma.crawlJob.count({ where: { status: 'pending' } }),
    prisma.crawlJob.count({ where: { status: 'running' } }),
    prisma.crawlJob.count({ where: { status: 'completed' } }),
    prisma.crawlJob.count({ where: { status: 'failed' } }),
  ])

  return { pending, running, completed, failed }
}

/**
 * Mark stale running jobs (started over 10 minutes ago) as pending for retry.
 */
export async function recoverStaleJobs(): Promise<number> {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000) // 10 minutes

  const result = await prisma.crawlJob.updateMany({
    where: {
      status: 'running',
      startedAt: { lt: staleThreshold },
    },
    data: {
      status: 'pending',
      error: 'Job timed out and was reset',
    },
  })

  return result.count
}
