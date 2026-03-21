import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { Platform } from '@/generated/prisma/client'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const platformFilter = searchParams.get('platform') as Platform | null

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const whereClause: Record<string, unknown> = {
      postedAt: { gte: thirtyDaysAgo },
      hashtags: { isEmpty: false },
    }
    if (platformFilter && ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'].includes(platformFilter)) {
      whereClause.platform = platformFilter
    }

    const media = await prisma.media.findMany({
      where: whereClause,
      select: {
        hashtags: true,
        likes: true,
        comments: true,
        views: true,
      },
    })

    // Aggregate hashtags
    const hashtagMap = new Map<
      string,
      { count: number; totalLikes: number; totalComments: number; totalViews: number; totalEngagement: number }
    >()

    for (const m of media) {
      const engagement = m.likes + m.comments
      for (const tag of m.hashtags) {
        const normalized = tag.startsWith('#') ? tag.toLowerCase() : `#${tag.toLowerCase()}`
        const entry = hashtagMap.get(normalized) ?? {
          count: 0,
          totalLikes: 0,
          totalComments: 0,
          totalViews: 0,
          totalEngagement: 0,
        }
        entry.count++
        entry.totalLikes += m.likes
        entry.totalComments += m.comments
        entry.totalViews += m.views
        entry.totalEngagement += engagement
        hashtagMap.set(normalized, entry)
      }
    }

    const trending = Array.from(hashtagMap.entries())
      .map(([hashtag, data]) => ({
        hashtag,
        count: data.count,
        avgEngagement: Math.round(data.totalEngagement / data.count),
        avgLikes: Math.round(data.totalLikes / data.count),
        avgViews: Math.round(data.totalViews / data.count),
      }))
      .sort((a, b) => b.count - a.count || b.avgEngagement - a.avgEngagement)
      .slice(0, 50)

    return NextResponse.json({ trending })
  } catch (error) {
    console.error('Trending hashtags error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
