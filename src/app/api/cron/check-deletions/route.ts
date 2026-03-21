import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { notifyAllTeam } from '@/lib/notifications'

const BATCH_SIZE = 50
const DELAY_MS = 2000

/**
 * Cron job: Detect deleted posts from influencers in active campaigns.
 * Makes HEAD requests to post permalinks to check if they still exist.
 *
 * GET /api/cron/check-deletions
 * Authorization: Bearer <CRON_SECRET or JWT_SECRET>
 */
export async function GET(request: NextRequest) {
  // Auth: Bearer token from CRON_SECRET, fallback to JWT_SECRET
  const cronSecret = process.env.CRON_SECRET || process.env.JWT_SECRET
  if (cronSecret) {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    const fallback = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret')
    if (token !== cronSecret && fallback !== cronSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    // Get all non-deleted media with permalinks from active campaigns
    const allMedia = await prisma.media.findMany({
      where: {
        isDeleted: false,
        permalink: { not: null },
        campaign: {
          status: 'ACTIVE',
        },
      },
      include: {
        influencer: {
          select: { id: true, username: true, platform: true },
        },
        campaign: {
          select: { id: true, name: true },
        },
      },
    })

    if (allMedia.length === 0) {
      return NextResponse.json({ message: 'No media to check', checked: 0, deleted: 0 })
    }

    console.log(`[Cron/CheckDeletions] Checking ${allMedia.length} posts...`)

    let totalChecked = 0
    let totalDeleted = 0
    const errors: string[] = []

    // Process in batches
    for (let i = 0; i < allMedia.length; i += BATCH_SIZE) {
      const batch = allMedia.slice(i, i + BATCH_SIZE)

      for (const media of batch) {
        if (!media.permalink) continue

        try {
          const isDeleted = await checkIfDeleted(media.permalink)

          if (isDeleted) {
            // Mark as deleted
            await prisma.media.update({
              where: { id: media.id },
              data: {
                isDeleted: true,
                deletedAt: new Date(),
              },
            })

            totalDeleted++

            // Notify team
            const campaignName = media.campaign?.name || 'Unknown'
            const username = media.influencer?.username || 'Unknown'
            const campaignId = media.campaign?.id

            notifyAllTeam({
              type: 'post_deleted',
              title: `Post eliminado detectado`,
              message: `⚠️ El influencer @${username} ha eliminado un post de la campaña ${campaignName}`,
              link: campaignId ? `/campaigns/${campaignId}` : undefined,
            }).catch(() => {})

            console.log(`[Cron/CheckDeletions] Detected deleted post: ${media.permalink} by @${username}`)
          }

          totalChecked++

          // Rate limit: wait between checks
          await new Promise(r => setTimeout(r, DELAY_MS))
        } catch (err) {
          const errMsg = `Error checking ${media.permalink}: ${err}`
          console.error(`[Cron/CheckDeletions] ${errMsg}`)
          errors.push(errMsg)
        }
      }
    }

    console.log(`[Cron/CheckDeletions] Done. Checked: ${totalChecked}, Deleted: ${totalDeleted}, Errors: ${errors.length}`)

    return NextResponse.json({
      success: true,
      checked: totalChecked,
      deleted: totalDeleted,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error('[Cron/CheckDeletions] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * Check if a post has been deleted by making a HEAD request to its permalink.
 * - 200 = still exists
 * - 404 / redirect to login = deleted
 */
async function checkIfDeleted(permalink: string): Promise<boolean> {
  try {
    const response = await fetch(permalink, {
      method: 'HEAD',
      redirect: 'manual', // Don't follow redirects
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TKOCBot/1.0)',
      },
    })

    const status = response.status

    // 200 = exists
    if (status === 200) {
      return false
    }

    // 404 = clearly deleted
    if (status === 404) {
      return true
    }

    // 301/302 redirects - check if redirecting to login (Instagram pattern)
    if (status === 301 || status === 302) {
      const location = response.headers.get('location') || ''
      // Instagram redirects deleted posts to login page
      if (
        location.includes('/accounts/login') ||
        location.includes('/login') ||
        location.includes('instagram.com/accounts/')
      ) {
        return true
      }
    }

    // Other statuses (403, 5xx, etc.) - don't mark as deleted, could be temporary
    return false
  } catch {
    // Network errors - don't mark as deleted
    return false
  }
}
