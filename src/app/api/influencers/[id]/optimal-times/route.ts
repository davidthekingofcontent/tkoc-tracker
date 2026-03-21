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
        where: { postedAt: { not: null } },
        orderBy: { postedAt: 'desc' },
      },
    },
  })

  if (!influencer) {
    return NextResponse.json({ error: 'Influencer not found' }, { status: 404 })
  }

  const { media } = influencer

  if (media.length === 0) {
    return NextResponse.json({
      bestDays: [],
      bestHours: [],
      bestSlots: [],
      heatmap: [],
    })
  }

  // Build a map: day -> hour -> { totalEngagement, posts }
  const slotMap = new Map<string, Map<number, { totalEngagement: number; posts: number }>>()
  // Also aggregate by day and by hour independently
  const dayMap = new Map<string, { totalEngagement: number; posts: number }>()
  const hourMap = new Map<number, { totalEngagement: number; posts: number }>()

  for (const m of media) {
    if (!m.postedAt) continue
    const date = new Date(m.postedAt)
    const dayIndex = date.getUTCDay()
    const day = DAYS_OF_WEEK[dayIndex]
    const hour = date.getUTCHours()
    const engagement = m.likes + m.comments

    // Slot map (day x hour)
    if (!slotMap.has(day)) slotMap.set(day, new Map())
    const hourSlots = slotMap.get(day)!
    const slot = hourSlots.get(hour) ?? { totalEngagement: 0, posts: 0 }
    slot.totalEngagement += engagement
    slot.posts++
    hourSlots.set(hour, slot)

    // Day aggregation
    const dayEntry = dayMap.get(day) ?? { totalEngagement: 0, posts: 0 }
    dayEntry.totalEngagement += engagement
    dayEntry.posts++
    dayMap.set(day, dayEntry)

    // Hour aggregation
    const hourEntry = hourMap.get(hour) ?? { totalEngagement: 0, posts: 0 }
    hourEntry.totalEngagement += engagement
    hourEntry.posts++
    hourMap.set(hour, hourEntry)
  }

  // Best days sorted by avg engagement
  const bestDays = Array.from(dayMap.entries())
    .map(([day, data]) => ({
      day,
      avgEngagement: Math.round(data.totalEngagement / data.posts),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)

  // Best hours sorted by avg engagement
  const bestHours = Array.from(hourMap.entries())
    .map(([hour, data]) => ({
      hour,
      avgEngagement: Math.round(data.totalEngagement / data.posts),
    }))
    .sort((a, b) => b.avgEngagement - a.avgEngagement)

  // Best slots: top 5 day+hour combos
  const allSlots: { day: string; hour: number; avgEngagement: number }[] = []
  for (const [day, hours] of slotMap) {
    for (const [hour, data] of hours) {
      allSlots.push({
        day,
        hour,
        avgEngagement: Math.round(data.totalEngagement / data.posts),
      })
    }
  }
  const bestSlots = allSlots
    .sort((a, b) => b.avgEngagement - a.avgEngagement)
    .slice(0, 5)

  // Full heatmap: every day x hour with data
  const heatmap: { day: number; hour: number; posts: number; avgEngagement: number }[] = []
  for (const [day, hours] of slotMap) {
    const dayIndex = DAYS_OF_WEEK.indexOf(day)
    for (const [hour, data] of hours) {
      heatmap.push({
        day: dayIndex,
        hour,
        posts: data.posts,
        avgEngagement: Math.round(data.totalEngagement / data.posts),
      })
    }
  }

  return NextResponse.json({
    bestDays,
    bestHours,
    bestSlots,
    heatmap,
  })
}
