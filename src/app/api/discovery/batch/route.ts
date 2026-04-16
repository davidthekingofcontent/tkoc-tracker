import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile } from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'

// Extract clean username from handle/URL
function extractUsername(handle: string): string {
  const trimmed = handle.trim()
  const patterns = [
    /instagram\.com\/([^/?]+)/,
    /tiktok\.com\/@?([^/?]+)/,
    /youtube\.com\/@?([^/?]+)/,
  ]
  for (const p of patterns) {
    const m = trimmed.match(p)
    if (m) return m[1]
  }
  return trimmed.replace(/^@/, '')
}

interface BatchResultItem {
  handle: string
  status: 'found' | 'scraped' | 'error'
  creatorId?: string
  username?: string
  followers?: number
  error?: string
}

// Simple semaphore for concurrency control
function createSemaphore(limit: number) {
  let running = 0
  const queue: Array<() => void> = []

  return {
    async acquire(): Promise<void> {
      if (running < limit) {
        running++
        return
      }
      return new Promise<void>((resolve) => {
        queue.push(() => {
          running++
          resolve()
        })
      })
    },
    release() {
      running--
      if (queue.length > 0) {
        const next = queue.shift()!
        next()
      }
    },
  }
}

// POST /api/discovery/batch — process a list of handles
export async function POST(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { handles, platform } = body as { handles: string[]; platform: string }

  if (!handles || !Array.isArray(handles) || handles.length === 0) {
    return NextResponse.json({ error: 'handles array is required' }, { status: 400 })
  }

  if (!platform) {
    return NextResponse.json({ error: 'platform is required' }, { status: 400 })
  }

  const normalizedPlatform = platform.toUpperCase() as Platform
  if (!['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(normalizedPlatform)) {
    return NextResponse.json({ error: 'Invalid platform' }, { status: 400 })
  }

  const semaphore = createSemaphore(3)
  const results: BatchResultItem[] = []

  const tasks = handles.slice(0, 200).map(async (handle) => {
    await semaphore.acquire()
    try {
      const username = extractUsername(handle)
      if (!username) {
        results.push({ handle, status: 'error', error: 'Could not extract username' })
        return
      }

      // Check if already exists in DB
      const existing = await prisma.creatorPlatformProfile.findFirst({
        where: {
          platform: normalizedPlatform,
          username: { equals: username, mode: 'insensitive' },
        },
        include: {
          creator: {
            select: { id: true },
          },
        },
      })

      if (existing) {
        results.push({
          handle,
          status: 'found',
          creatorId: existing.creator.id,
          username: existing.username,
          followers: existing.followers ?? undefined,
        })
        return
      }

      // Scrape and enrich
      try {
        const profile = await scrapeProfile(username, normalizedPlatform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
        if (!profile) {
          results.push({ handle, status: 'error', username, error: 'Profile not found or scrape failed' })
          return
        }

        const enrichResult = await enrichCreatorFull(profile, normalizedPlatform)
        results.push({
          handle,
          status: 'scraped',
          creatorId: enrichResult.creatorId,
          username: profile.username,
          followers: profile.followers,
        })
      } catch (scrapeErr) {
        results.push({
          handle,
          status: 'error',
          username,
          error: scrapeErr instanceof Error ? scrapeErr.message : 'Scrape/enrich failed',
        })
      }
    } finally {
      semaphore.release()
    }
  })

  await Promise.allSettled(tasks)

  const found = results.filter((r) => r.status === 'found').length
  const scraped = results.filter((r) => r.status === 'scraped').length
  const errors = results.filter((r) => r.status === 'error').length

  return NextResponse.json({
    results,
    total: results.length,
    found,
    scraped,
    errors,
  })
}
