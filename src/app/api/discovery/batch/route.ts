import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { Platform } from '@/generated/prisma/client'
import { scrapeProfile, isApifyExhausted, getApifyResumeDate, type ScrapedProfile } from '@/lib/apify'
import { enrichCreatorFull } from '@/lib/creator-enrichment'
import { ensureContact } from '@/lib/contacts'

/**
 * Discovery only writes CreatorProfile/CreatorPlatformProfile rows, but Contacts
 * hang off the legacy Influencer model. Make sure the matching Influencer exists
 * (creating it from the scraped/stored profile data when missing), link it from
 * the platform profile, and register it as a Contact of the session user.
 * Never throws — a contact hiccup must not fail the batch item.
 */
async function materializeInfluencerAndContact(opts: {
  platform: Platform
  username: string
  displayName: string | null
  bio: string | null
  avatarUrl: string | null
  email?: string | null
  website?: string | null
  followers: number
  following: number
  postsCount: number
  engagementRate: number
  avgLikes: number
  avgComments: number
  avgViews: number
  isVerified: boolean
  country?: string | null
  city?: string | null
  platformProfileId?: string
  userId: string
}): Promise<string | undefined> {
  try {
    const { platform, username, userId, platformProfileId } = opts

    // Influencer.username is case-sensitive in the unique index; prefer an
    // existing row with a case-insensitive match before creating a new one.
    const existing = await prisma.influencer.findFirst({
      where: { platform, username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    })

    let influencerId: string
    if (existing) {
      influencerId = existing.id
      await prisma.influencer.update({
        where: { id: influencerId },
        data: {
          displayName: opts.displayName || undefined,
          bio: opts.bio || undefined,
          avatarUrl: opts.avatarUrl || undefined,
          email: opts.email || undefined,
          website: opts.website || undefined,
          followers: opts.followers,
          following: opts.following,
          postsCount: opts.postsCount,
          engagementRate: opts.engagementRate,
          avgLikes: opts.avgLikes,
          avgComments: opts.avgComments,
          avgViews: opts.avgViews,
          isVerified: opts.isVerified,
          country: opts.country || undefined,
          city: opts.city || undefined,
          lastScraped: new Date(),
          dataSource: 'apify',
        },
      })
    } else {
      const created = await prisma.influencer.create({
        data: {
          username,
          platform,
          displayName: opts.displayName,
          bio: opts.bio,
          avatarUrl: opts.avatarUrl,
          email: opts.email ?? null,
          website: opts.website ?? null,
          followers: opts.followers,
          following: opts.following,
          postsCount: opts.postsCount,
          engagementRate: opts.engagementRate,
          avgLikes: opts.avgLikes,
          avgComments: opts.avgComments,
          avgViews: opts.avgViews,
          isVerified: opts.isVerified,
          country: opts.country ?? null,
          city: opts.city ?? null,
          lastScraped: new Date(),
          dataSource: 'apify',
        },
        select: { id: true },
      })
      influencerId = created.id
    }

    // Keep the CreatorPlatformProfile → Influencer link in sync
    if (platformProfileId) {
      await prisma.creatorPlatformProfile.updateMany({
        where: { id: platformProfileId, influencerId: null },
        data: { influencerId },
      })
    }

    await ensureContact(influencerId, userId)
    return influencerId
  } catch (err) {
    console.error(
      `[discovery/batch] materializeInfluencerAndContact failed for ${opts.username}:`,
      err instanceof Error ? err.message : err
    )
    return undefined
  }
}

function fromScrapedProfile(profile: ScrapedProfile, platform: Platform, platformProfileId: string, userId: string) {
  return materializeInfluencerAndContact({
    platform,
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
    website: profile.website,
    followers: profile.followers,
    following: profile.following,
    postsCount: profile.postsCount,
    engagementRate: profile.engagementRate,
    avgLikes: profile.avgLikes,
    avgComments: profile.avgComments,
    avgViews: profile.avgViews,
    isVerified: profile.isVerified,
    country: profile.country,
    city: profile.city,
    platformProfileId,
    userId,
  })
}

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
  influencerId?: string
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
  let anyScrapeFailed = false

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
            select: { id: true, displayName: true, contactEmail: true, websiteUrl: true, geoCountry: true, geoCity: true },
          },
        },
      })

      if (existing) {
        // Already discovered: still make sure the Influencer row + Contact exist
        // for this user (a profile found by someone else has no Contact for us).
        const influencerId = await materializeInfluencerAndContact({
          platform: normalizedPlatform,
          username: existing.username,
          displayName: existing.creator.displayName,
          bio: existing.bio,
          avatarUrl: existing.avatarUrl,
          email: existing.creator.contactEmail,
          website: existing.creator.websiteUrl,
          followers: existing.followers,
          following: existing.following,
          postsCount: existing.postsCount,
          engagementRate: existing.engagementRate,
          avgLikes: existing.avgLikes,
          avgComments: existing.avgComments,
          avgViews: existing.avgViews,
          isVerified: existing.isVerified,
          country: existing.creator.geoCountry,
          city: existing.creator.geoCity,
          platformProfileId: existing.id,
          userId: session.id,
        })
        results.push({
          handle,
          status: 'found',
          creatorId: existing.creator.id,
          influencerId,
          username: existing.username,
          followers: existing.followers ?? undefined,
        })
        return
      }

      // Scrape and enrich
      try {
        const profile = await scrapeProfile(username, normalizedPlatform as 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE')
        if (!profile) {
          anyScrapeFailed = true
          results.push({ handle, status: 'error', username, error: 'Profile not found or scrape failed' })
          return
        }

        const enrichResult = await enrichCreatorFull(profile, normalizedPlatform)
        const influencerId = await fromScrapedProfile(
          profile,
          normalizedPlatform,
          enrichResult.platformProfileId,
          session.id
        )
        results.push({
          handle,
          status: 'scraped',
          creatorId: enrichResult.creatorId,
          influencerId,
          username: profile.username,
          followers: profile.followers,
        })
      } catch (scrapeErr) {
        anyScrapeFailed = true
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
    // Surface Apify monthly-limit exhaustion when scrapes came back empty
    ...(anyScrapeFailed && isApifyExhausted()
      ? { apifyExhausted: true, resumesAt: getApifyResumeDate() }
      : {}),
  })
}
