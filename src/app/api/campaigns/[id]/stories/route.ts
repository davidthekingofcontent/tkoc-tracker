import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { isWithinCampaignDates } from '@/lib/campaign-capture'

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

    // Get all stories for this campaign
    const stories = await prisma.media.findMany({
      where: {
        campaignId: id,
        mediaType: 'STORY',
      },
      include: {
        influencer: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            platform: true,
          },
        },
      },
      orderBy: { postedAt: 'desc' },
    })

    // Calculate story stats
    const now = new Date()
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const activeStories = stories.filter(
      (s) => s.postedAt && new Date(s.postedAt) > twentyFourHoursAgo
    )
    const expiredStories = stories.filter(
      (s) => !s.postedAt || new Date(s.postedAt) <= twentyFourHoursAgo
    )

    const totalReach = stories.reduce((sum, s) => sum + s.reach, 0)
    const totalImpressions = stories.reduce((sum, s) => sum + s.impressions, 0)
    const totalViews = stories.reduce((sum, s) => sum + s.views, 0)
    const totalReplies = stories.reduce((sum, s) => sum + s.comments, 0)

    // Group by influencer
    const byInfluencer = new Map<
      string,
      {
        influencer: (typeof stories)[0]['influencer']
        stories: typeof stories
        totalViews: number
        totalReach: number
      }
    >()

    for (const story of stories) {
      const key = story.influencerId
      if (!byInfluencer.has(key)) {
        byInfluencer.set(key, {
          influencer: story.influencer,
          stories: [],
          totalViews: 0,
          totalReach: 0,
        })
      }
      const group = byInfluencer.get(key)!
      group.stories.push(story)
      group.totalViews += story.views
      group.totalReach += story.reach
    }

    return NextResponse.json({
      stories: stories.map((s) => ({
        ...s,
        isActive: s.postedAt ? new Date(s.postedAt) > twentyFourHoursAgo : false,
        expiresAt: s.postedAt
          ? new Date(new Date(s.postedAt).getTime() + 24 * 60 * 60 * 1000)
          : null,
      })),
      byInfluencer: Array.from(byInfluencer.values()).sort(
        (a, b) => b.totalViews - a.totalViews
      ),
      stats: {
        total: stories.length,
        active: activeStories.length,
        expired: expiredStories.length,
        totalReach,
        totalImpressions,
        totalViews,
        totalReplies,
      },
    })
  } catch (error) {
    console.error('Stories tracking error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Manually add a story record
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params
    const body = await request.json()
    const {
      influencerId,
      permalink,
      mediaUrl,
      thumbnailUrl,
      views,
      reach,
      impressions,
      replies,
      postedAt,
      mentions,
      hashtags,
    } = body

    if (!influencerId) {
      return NextResponse.json(
        { error: 'influencerId is required' },
        { status: 400 }
      )
    }

    // Rule (1): the creator must be a member of this campaign
    const ci = await prisma.campaignInfluencer.findFirst({
      where: { campaignId: id, influencerId },
      include: {
        influencer: { select: { platform: true } },
        campaign: { select: { startDate: true, endDate: true } },
      },
    })

    if (!ci) {
      return NextResponse.json(
        { error: 'Influencer not in this campaign' },
        { status: 400 }
      )
    }

    // Rule (2): dated inside the campaign window. A hand-added story defaults
    // to "now"; once the campaign has ended that default falls outside the
    // window, so the PM must supply the real publication date.
    let resolvedPostedAt: Date
    if (postedAt !== undefined && postedAt !== null && postedAt !== '') {
      resolvedPostedAt = new Date(String(postedAt))
      if (Number.isNaN(resolvedPostedAt.getTime())) {
        return NextResponse.json({ error: 'postedAt no es una fecha válida' }, { status: 400 })
      }
    } else {
      resolvedPostedAt = new Date()
    }

    if (!isWithinCampaignDates(ci.campaign, resolvedPostedAt)) {
      const fmt = (d: Date) => d.toISOString().slice(0, 10)
      const window = `${fmt(ci.campaign.startDate)} – ${ci.campaign.endDate ? fmt(ci.campaign.endDate) : 'sin fecha de fin'}`
      return NextResponse.json(
        {
          error: postedAt
            ? `La story se publicó el ${fmt(resolvedPostedAt)}, fuera del periodo de la campaña (${window}).`
            : `La campaña ya terminó (${window}): indica la fecha de publicación de la story (postedAt).`,
          needsPostedAt: !postedAt,
        },
        { status: 400 }
      )
    }

    // Manual additions are exempt from the brand-keyword rule only (the PM
    // asserts relevance); `source: 'manual'` is what keeps revalidation from
    // detaching a hand-added story that carries no mentions/hashtags.
    const story = await prisma.media.create({
      data: {
        platform: ci.influencer.platform,
        mediaType: 'STORY',
        permalink: permalink || null,
        mediaUrl: mediaUrl || null,
        thumbnailUrl: thumbnailUrl || null,
        views: views || 0,
        reach: reach || 0,
        impressions: impressions || 0,
        comments: replies || 0,
        postedAt: resolvedPostedAt,
        mentions: mentions || [],
        hashtags: hashtags || [],
        source: 'manual',
        dataSource: 'manual',
        influencerId,
        campaignId: id,
      },
    })

    return NextResponse.json({ story }, { status: 201 })
  } catch (error) {
    console.error('Add story error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
