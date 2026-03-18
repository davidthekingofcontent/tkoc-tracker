import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params
    const format = request.nextUrl.searchParams.get('format') || 'csv'

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        influencers: {
          include: {
            influencer: true,
          },
        },
        media: {
          orderBy: { postedAt: 'desc' },
          include: {
            influencer: {
              select: {
                username: true,
                displayName: true,
                platform: true,
                followers: true,
                engagementRate: true,
              },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    if (session.role === 'BRAND' && campaign.userId !== session.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (format === 'csv') {
      return generateCSV(campaign)
    }

    return NextResponse.json({ error: 'Unsupported format. Use csv.' }, { status: 400 })
  } catch (error) {
    console.error('Export campaign error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

interface CampaignData {
  name: string
  status: string
  startDate: Date | null
  endDate: Date | null
  platforms: string[]
  targetHashtags: string[]
  targetAccounts: string[]
  influencers: {
    influencer: {
      username: string
      displayName: string | null
      platform: string
      followers: number
      following: number
      engagementRate: number
      avgLikes: number
      avgComments: number
      avgViews: number
      email: string | null
      website: string | null
      country: string | null
      city: string | null
    }
  }[]
  media: {
    mediaType: string
    caption: string | null
    permalink: string | null
    likes: number
    comments: number
    shares: number
    saves: number
    views: number
    reach: number
    impressions: number
    postedAt: Date | null
    influencer: {
      username: string
      displayName: string | null
      platform: string
      followers: number
      engagementRate: number
    } | null
  }[]
}

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function generateCSV(campaign: CampaignData): NextResponse {
  const lines: string[] = []

  // Campaign Summary Section
  lines.push('CAMPAIGN REPORT')
  lines.push(`Campaign Name,${escapeCSV(campaign.name)}`)
  lines.push(`Status,${escapeCSV(campaign.status)}`)
  lines.push(`Start Date,${campaign.startDate ? new Date(campaign.startDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`End Date,${campaign.endDate ? new Date(campaign.endDate).toLocaleDateString() : 'N/A'}`)
  lines.push(`Platforms,${escapeCSV(campaign.platforms.join(', '))}`)
  lines.push(`Hashtags,${escapeCSV(campaign.targetHashtags.join(', '))}`)
  lines.push(`Tracked Accounts,${escapeCSV(campaign.targetAccounts.join(', '))}`)
  lines.push('')

  // Aggregate metrics
  let totalReach = 0
  let totalLikes = 0
  let totalComments = 0
  let totalShares = 0
  let totalViews = 0

  for (const m of campaign.media) {
    totalReach += m.reach || 0
    totalLikes += m.likes || 0
    totalComments += m.comments || 0
    totalShares += m.shares || 0
    totalViews += m.views || 0
  }

  const totalEngagements = totalLikes + totalComments + totalShares
  const engRate = totalReach > 0 ? ((totalEngagements / totalReach) * 100).toFixed(2) : '0'

  lines.push('OVERVIEW')
  lines.push(`Total Influencers,${campaign.influencers.length}`)
  lines.push(`Total Media,${campaign.media.length}`)
  lines.push(`Total Reach,${totalReach}`)
  lines.push(`Total Engagements,${totalEngagements}`)
  lines.push(`Engagement Rate,${engRate}%`)
  lines.push(`Total Likes,${totalLikes}`)
  lines.push(`Total Comments,${totalComments}`)
  lines.push(`Total Shares,${totalShares}`)
  lines.push(`Total Views,${totalViews}`)
  lines.push('')

  // Influencers Section
  lines.push('INFLUENCERS')
  lines.push('Username,Display Name,Platform,Followers,Engagement Rate,Avg Likes,Avg Comments,Avg Views,Email,Website,Location')

  for (const ci of campaign.influencers) {
    const inf = ci.influencer
    lines.push([
      escapeCSV(inf.username),
      escapeCSV(inf.displayName),
      escapeCSV(inf.platform),
      inf.followers,
      `${inf.engagementRate}%`,
      inf.avgLikes,
      inf.avgComments,
      inf.avgViews,
      escapeCSV(inf.email),
      escapeCSV(inf.website),
      escapeCSV([inf.city, inf.country].filter(Boolean).join(', ')),
    ].join(','))
  }

  lines.push('')

  // Media Section
  lines.push('MEDIA')
  lines.push('Date,Influencer,Platform,Type,Likes,Comments,Shares,Views,Reach,Impressions,Link,Caption')

  for (const media of campaign.media) {
    lines.push([
      media.postedAt ? new Date(media.postedAt).toLocaleDateString() : '',
      escapeCSV(media.influencer?.username || ''),
      escapeCSV(media.influencer?.platform || ''),
      escapeCSV(media.mediaType),
      media.likes,
      media.comments,
      media.shares,
      media.views,
      media.reach,
      media.impressions,
      escapeCSV(media.permalink),
      escapeCSV(media.caption?.substring(0, 200)),
    ].join(','))
  }

  const csvContent = lines.join('\n')

  // Add BOM for Excel UTF-8 compatibility
  const bom = '\uFEFF'

  const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_report.csv`

  return new NextResponse(bom + csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
