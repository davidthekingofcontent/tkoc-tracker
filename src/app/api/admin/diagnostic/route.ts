import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { isApifyConfigured } from '@/lib/apify'

/**
 * Diagnostic endpoint: returns detailed info about why tracking may not
 * be capturing data. Per-campaign view of scrape jobs, member coverage,
 * and recent failures.
 *
 * GET /api/admin/diagnostic?campaignId=XXX
 */
export async function GET(req: NextRequest) {
  const session = await getSession(req)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const campaignId = url.searchParams.get('campaignId')
  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId required' }, { status: 400 })
  }

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId: session.id },
    include: {
      influencers: {
        include: {
          influencer: true,
        },
      },
    },
  })
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Last 30 scrape jobs for this campaign
  const recentJobs = await prisma.scrapeJob.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  // Media counts per influencer in this campaign
  const memberStats = await Promise.all(
    campaign.influencers.map(async (ci) => {
      const inf = ci.influencer
      const mediaCount = await prisma.media.count({
        where: { campaignId, influencerId: inf.id },
      })
      const lastMedia = await prisma.media.findFirst({
        where: { campaignId, influencerId: inf.id },
        orderBy: { postedAt: 'desc' },
        select: { postedAt: true, mediaType: true, permalink: true, likes: true, comments: true, views: true },
      })
      return {
        username: inf.username,
        displayName: inf.displayName,
        platform: inf.platform,
        followers: inf.followers,
        status: ci.status,
        source: ci.source,
        lastScraped: inf.lastScraped,
        mediaInCampaign: mediaCount,
        lastPost: lastMedia,
      }
    })
  )

  // Aggregate stats
  const totalJobs = recentJobs.length
  const completedJobs = recentJobs.filter(j => j.status === 'COMPLETED').length
  const failedJobs = recentJobs.filter(j => j.status === 'FAILED').length
  const totalItemsFound = recentJobs.reduce((sum, j) => sum + (j.itemsFound || 0), 0)
  const lastJob = recentJobs[0]
  const lastSuccessfulJob = recentJobs.find(j => j.status === 'COMPLETED')

  return NextResponse.json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      targetHashtags: campaign.targetHashtags,
      targetAccounts: campaign.targetAccounts,
      platforms: campaign.platforms,
      country: campaign.country,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      membersCount: campaign.influencers.length,
    },
    apify: {
      configured: isApifyConfigured(),
      apiKeySet: !!process.env.APIFY_API_KEY,
    },
    scrapeJobs: {
      total: totalJobs,
      completed: completedJobs,
      failed: failedJobs,
      totalItemsFound,
      lastJob: lastJob ? {
        type: lastJob.jobType,
        platform: lastJob.platform,
        target: lastJob.targetUsername,
        status: lastJob.status,
        itemsFound: lastJob.itemsFound,
        error: lastJob.errorMessage,
        startedAt: lastJob.startedAt,
        completedAt: lastJob.completedAt,
      } : null,
      lastSuccessfulJob: lastSuccessfulJob ? {
        type: lastSuccessfulJob.jobType,
        target: lastSuccessfulJob.targetUsername,
        itemsFound: lastSuccessfulJob.itemsFound,
        completedAt: lastSuccessfulJob.completedAt,
      } : null,
      recent: recentJobs.slice(0, 15).map(j => ({
        type: j.jobType,
        platform: j.platform,
        target: j.targetUsername,
        status: j.status,
        itemsFound: j.itemsFound,
        error: j.errorMessage,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
    },
    members: memberStats,
    summary: {
      membersWithMedia: memberStats.filter(m => m.mediaInCampaign > 0).length,
      membersWithoutMedia: memberStats.filter(m => m.mediaInCampaign === 0).length,
      totalMediaInCampaign: memberStats.reduce((s, m) => s + m.mediaInCampaign, 0),
      membersNeverScraped: memberStats.filter(m => !m.lastScraped).length,
    },
  })
}
