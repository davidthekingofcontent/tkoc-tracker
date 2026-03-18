import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

const DAYS_OF_WEEK = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession(request)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const influencer = await prisma.influencer.findUnique({
    where: { id },
    include: {
      media: {
        orderBy: { postedAt: 'desc' },
      },
    },
  })

  if (!influencer) {
    return NextResponse.json(
      { error: 'Influencer not found' },
      { status: 404 }
    )
  }

  const { media, followers } = influencer
  const safeFollowers = followers > 0 ? followers : 1

  // ── Content type breakdown ──
  const typeGroups = new Map<
    string,
    { count: number; totalLikes: number; totalComments: number; totalViews: number; totalEngagement: number }
  >()

  for (const m of media) {
    const key = m.mediaType
    const group = typeGroups.get(key) ?? {
      count: 0,
      totalLikes: 0,
      totalComments: 0,
      totalViews: 0,
      totalEngagement: 0,
    }
    group.count++
    group.totalLikes += m.likes
    group.totalComments += m.comments
    group.totalViews += m.views
    group.totalEngagement += ((m.likes + m.comments) / safeFollowers) * 100
    typeGroups.set(key, group)
  }

  const contentBreakdown = Array.from(typeGroups.entries()).map(
    ([type, g]) => ({
      type,
      count: g.count,
      avgLikes: Math.round(g.totalLikes / g.count),
      avgComments: Math.round(g.totalComments / g.count),
      avgViews: Math.round(g.totalViews / g.count),
      avgEngagement: parseFloat((g.totalEngagement / g.count).toFixed(2)),
    })
  )

  // ── Top performing posts (top 3 by engagement rate) ──
  const postsWithEngagement = media.map((m) => ({
    id: m.id,
    caption: m.caption,
    thumbnailUrl: m.thumbnailUrl,
    permalink: m.permalink,
    mediaType: m.mediaType,
    likes: m.likes,
    comments: m.comments,
    views: m.views,
    engagementRate: parseFloat(
      (((m.likes + m.comments) / safeFollowers) * 100).toFixed(2)
    ),
    postedAt: m.postedAt ? m.postedAt.toISOString() : null,
  }))

  const topPosts = postsWithEngagement
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 3)

  // ── Hashtag analysis ──
  const hashtagMap = new Map<
    string,
    { count: number; totalLikes: number; totalEngagement: number }
  >()

  for (const m of media) {
    const engagement = ((m.likes + m.comments) / safeFollowers) * 100
    for (const tag of m.hashtags) {
      const normalized = tag.startsWith('#') ? tag : `#${tag}`
      const entry = hashtagMap.get(normalized) ?? {
        count: 0,
        totalLikes: 0,
        totalEngagement: 0,
      }
      entry.count++
      entry.totalLikes += m.likes
      entry.totalEngagement += engagement
      hashtagMap.set(normalized, entry)
    }
  }

  const topHashtags = Array.from(hashtagMap.entries())
    .map(([tag, h]) => ({
      tag,
      count: h.count,
      avgLikes: Math.round(h.totalLikes / h.count),
      avgEngagement: parseFloat((h.totalEngagement / h.count).toFixed(2)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // ── Posting frequency ──
  const datedPosts = media
    .filter((m) => m.postedAt !== null)
    .sort(
      (a, b) =>
        new Date(a.postedAt!).getTime() - new Date(b.postedAt!).getTime()
    )

  let postsPerWeek = 0
  let avgDaysBetweenPosts = 0
  let mostActiveDay: string | null = null

  if (datedPosts.length >= 2) {
    const firstDate = new Date(datedPosts[0].postedAt!).getTime()
    const lastDate = new Date(
      datedPosts[datedPosts.length - 1].postedAt!
    ).getTime()
    const totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24)
    const totalWeeks = totalDays / 7

    postsPerWeek =
      totalWeeks > 0
        ? parseFloat((datedPosts.length / totalWeeks).toFixed(2))
        : datedPosts.length
    avgDaysBetweenPosts =
      datedPosts.length > 1
        ? parseFloat((totalDays / (datedPosts.length - 1)).toFixed(2))
        : 0

    // Most active day of week
    const dayCounts = new Array(7).fill(0)
    for (const m of datedPosts) {
      dayCounts[new Date(m.postedAt!).getDay()]++
    }
    const maxDayIndex = dayCounts.indexOf(Math.max(...dayCounts))
    mostActiveDay = DAYS_OF_WEEK[maxDayIndex]
  } else if (datedPosts.length === 1) {
    postsPerWeek = 1
    avgDaysBetweenPosts = 0
    mostActiveDay = DAYS_OF_WEEK[new Date(datedPosts[0].postedAt!).getDay()]
  }

  const postingFrequency = {
    postsPerWeek,
    avgDaysBetweenPosts,
    mostActiveDay,
  }

  // ── Engagement analysis ──
  const totalLikes = media.reduce((sum, m) => sum + m.likes, 0)
  const totalComments = media.reduce((sum, m) => sum + m.comments, 0)
  const totalViews = media.reduce((sum, m) => sum + m.views, 0)
  const postCount = media.length || 1

  const avgLikes = totalLikes / postCount
  const avgComments = totalComments / postCount
  const avgViews = totalViews / postCount

  const likeToFollowerRatio = parseFloat(
    (avgLikes / safeFollowers).toFixed(4)
  )
  const commentToLikeRatio =
    totalLikes > 0
      ? parseFloat((totalComments / totalLikes).toFixed(4))
      : 0
  const viewToFollowerRatio = parseFloat(
    (avgViews / safeFollowers).toFixed(4)
  )

  const avgEngagementRate =
    ((avgLikes + avgComments) / safeFollowers) * 100

  const estimatedReach = Math.round(
    safeFollowers *
      (avgViews > 0
        ? avgViews / safeFollowers
        : avgEngagementRate / 100)
  )

  // Engagement trend: compare first half vs second half of posts by date
  let engagementTrend: 'rising' | 'stable' | 'declining' = 'stable'

  if (datedPosts.length >= 4) {
    const midpoint = Math.floor(datedPosts.length / 2)
    const firstHalf = datedPosts.slice(0, midpoint)
    const secondHalf = datedPosts.slice(midpoint)

    const avgEngFirst =
      firstHalf.reduce(
        (sum, m) =>
          sum + ((m.likes + m.comments) / safeFollowers) * 100,
        0
      ) / firstHalf.length

    const avgEngSecond =
      secondHalf.reduce(
        (sum, m) =>
          sum + ((m.likes + m.comments) / safeFollowers) * 100,
        0
      ) / secondHalf.length

    const changePct =
      avgEngFirst > 0
        ? ((avgEngSecond - avgEngFirst) / avgEngFirst) * 100
        : 0

    if (changePct > 10) {
      engagementTrend = 'rising'
    } else if (changePct < -10) {
      engagementTrend = 'declining'
    }
  }

  // Audience quality based on comment-to-like ratio
  let audienceQuality: 'high' | 'medium' | 'low' = 'low'
  if (commentToLikeRatio > 0.03) {
    audienceQuality = 'high'
  } else if (commentToLikeRatio > 0.01) {
    audienceQuality = 'medium'
  }

  const engagementAnalysis = {
    likeToFollowerRatio,
    commentToLikeRatio,
    viewToFollowerRatio,
    estimatedReach,
    engagementTrend,
  }

  // ── Best content type ──
  const bestContentType =
    contentBreakdown.length > 0
      ? contentBreakdown.sort((a, b) => b.avgEngagement - a.avgEngagement)[0]
          .type
      : null

  // ── Best posting time (hour of day with highest avg engagement) ──
  let bestPostingTime: string | null = null

  if (datedPosts.length > 0) {
    const hourMap = new Map<
      number,
      { totalEngagement: number; count: number }
    >()

    for (const m of datedPosts) {
      const hour = new Date(m.postedAt!).getUTCHours()
      const entry = hourMap.get(hour) ?? { totalEngagement: 0, count: 0 }
      entry.totalEngagement +=
        ((m.likes + m.comments) / safeFollowers) * 100
      entry.count++
      hourMap.set(hour, entry)
    }

    let bestHour = 0
    let bestAvg = 0
    for (const [hour, data] of hourMap) {
      const avg = data.totalEngagement / data.count
      if (avg > bestAvg) {
        bestAvg = avg
        bestHour = hour
      }
    }

    const formattedHour = bestHour.toString().padStart(2, '0')
    bestPostingTime = `${formattedHour}:00 UTC`
  }

  return NextResponse.json({
    contentBreakdown,
    topPosts,
    topHashtags,
    postingFrequency,
    engagementAnalysis,
    bestContentType,
    bestPostingTime,
    audienceQuality,
  })
}
