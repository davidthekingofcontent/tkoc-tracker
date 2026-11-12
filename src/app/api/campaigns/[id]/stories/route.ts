import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { isWithinCampaignDates } from '@/lib/campaign-capture'
import { parseInstagramStoryUrl } from '@/lib/story-url'

function normalizeHandle(s: string): string {
  return s.toLowerCase().replace(/^@/, '').trim()
}

/** Largest figure a story count may carry (the columns are 32-bit integers). */
const STORY_COUNT_MAX = 2_000_000_000
/** Longest mentions / hashtags list, and longest item. */
const STORY_LIST_MAX = 50
const STORY_LIST_ITEM_MAX = 100

/** A count typed by the PM: empty/absent → 0; a number (or numeric text) 0..STORY_COUNT_MAX, rounded. undefined = invalid. */
function parseStoryCount(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return 0
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : NaN
  if (!Number.isFinite(n) || n < 0 || n > STORY_COUNT_MAX) return undefined
  return Math.round(n)
}

/** mentions / hashtags: absent → []; a list of short texts. undefined = invalid. */
function parseStringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > STORY_LIST_MAX) return undefined
  if (!v.every((s) => typeof s === 'string' && s.length <= STORY_LIST_ITEM_MAX)) return undefined
  return v as string[]
}

/** mediaUrl / thumbnailUrl: absent or empty → null; an absolute http(s) URL. undefined = invalid. */
function parseOptionalHttpUrl(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 2000) return undefined
  try {
    const url = new URL(v)
    return url.protocol === 'http:' || url.protocol === 'https:' ? v : undefined
  } catch {
    return undefined
  }
}

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
      allowDuplicate,
      dedupe,
    } = body

    if (!influencerId || typeof influencerId !== 'string') {
      return NextResponse.json(
        { error: 'influencerId is required' },
        { status: 400 }
      )
    }

    // Counts typed by the PM (empty/absent → 0). Text or a negative number used
    // to become 0 in silence (12 Nov 2026): now it is a 400.
    const counts = [views, reach, impressions, replies].map(parseStoryCount)
    if (counts.some((c) => c === undefined)) {
      return NextResponse.json(
        { error: `Las cifras de la story (vistas, alcance, impresiones, respuestas) deben ser números entre 0 y ${STORY_COUNT_MAX}.` },
        { status: 400 }
      )
    }
    const cleanMentions = parseStringList(mentions)
    const cleanHashtags = parseStringList(hashtags)
    if (cleanMentions === undefined || cleanHashtags === undefined) {
      return NextResponse.json(
        { error: `mentions y hashtags deben ser listas de como mucho ${STORY_LIST_MAX} textos cortos.` },
        { status: 400 }
      )
    }
    const cleanMediaUrl = parseOptionalHttpUrl(mediaUrl)
    const cleanThumbnailUrl = parseOptionalHttpUrl(thumbnailUrl)
    if (cleanMediaUrl === undefined || cleanThumbnailUrl === undefined) {
      return NextResponse.json(
        { error: 'mediaUrl y thumbnailUrl deben ser direcciones http(s) completas.' },
        { status: 400 }
      )
    }

    // Rule (1): the creator must be a member of this campaign
    const ci = await prisma.campaignInfluencer.findFirst({
      where: { campaignId: id, influencerId },
      include: {
        influencer: { select: { platform: true, username: true } },
        campaign: { select: { startDate: true, endDate: true } },
      },
    })

    if (!ci) {
      return NextResponse.json(
        { error: 'Influencer not in this campaign' },
        { status: 400 }
      )
    }

    // An Instagram story link (instagram.com/stories/{user}/{id}/) names its
    // owner and encodes its publication time in the id: use both. The link is
    // optional, so anything that is not a story URL is stored as pasted.
    const rawPermalink = typeof permalink === 'string' ? permalink.trim() : ''
    const parsedStory = rawPermalink ? parseInstagramStoryUrl(rawPermalink) : null
    if (parsedStory && !parsedStory.isHighlight && parsedStory.username) {
      const linkOwner = normalizeHandle(parsedStory.username)
      const member = normalizeHandle(ci.influencer.username)
      if (linkOwner !== member) {
        return NextResponse.json(
          { error: `El enlace es de @${linkOwner}, no de @${member}.`, ownerUsername: linkOwner },
          { status: 400 }
        )
      }
    }

    // Rule (2): dated inside the campaign window. The PM's date wins; a story
    // link supplies the date encoded in its id; otherwise a hand-added story
    // defaults to "now". Once the campaign has ended that default falls
    // outside the window, so the PM must supply the real publication date.
    let resolvedPostedAt: Date
    let dateSource: 'body' | 'link' | 'now'
    if (parsedStory?.postedAtHint) {
      // The story id encodes its exact publication time: it wins over the PM's
      // typed date, which is a guess (two to four hours off in Oct 2026).
      resolvedPostedAt = parsedStory.postedAtHint
      dateSource = 'link'
    } else if (postedAt !== undefined && postedAt !== null && postedAt !== '') {
      resolvedPostedAt = new Date(String(postedAt))
      if (Number.isNaN(resolvedPostedAt.getTime())) {
        return NextResponse.json({ error: 'postedAt no es una fecha válida' }, { status: 400 })
      }
      dateSource = 'body'
    } else {
      resolvedPostedAt = new Date()
      dateSource = 'now'
    }

    if (!isWithinCampaignDates(ci.campaign, resolvedPostedAt)) {
      const fmt = (d: Date) => d.toISOString().slice(0, 10)
      const window = `${fmt(ci.campaign.startDate)} – ${ci.campaign.endDate ? fmt(ci.campaign.endDate) : 'sin fecha de fin'}`
      return NextResponse.json(
        {
          error: dateSource === 'now'
            ? `La campaña ya terminó (${window}): indica la fecha de publicación de la story.`
            : `La story se publicó el ${fmt(resolvedPostedAt)}${dateSource === 'link' ? ' (según el enlace)' : ''}, fuera del periodo de la campaña (${window}).`,
          needsPostedAt: dateSource === 'now',
          postedAt: resolvedPostedAt.toISOString(),
        },
        { status: 400 }
      )
    }

    // Counts (validated above). A story has no likes; the "replies" field lands in `comments`.
    const [nViews, nReach, nImpressions, nReplies] = counts as number[]

    const linkStory = parsedStory && !parsedStory.isHighlight ? parsedStory : null
    const storyId = linkStory?.storyId ?? null
    const canonicalPermalink = linkStory ? linkStory.canonicalUrl : (rawPermalink || null)

    // Without a story id nothing below de-duplicates, so a retry (a client that
    // timed out and sends again) added the same story twice and inflated the
    // campaign totals. A caller that ASKS for it with `dedupe: true` (the
    // Claude connector does) gets the same creator + date + link + figures
    // already in the campaign refused as that retry, unless allowDuplicate is
    // true. Without a date ("now") two calls never share a date.
    // The form of the platform does not ask for it on purpose: two stories of
    // the same minute with the same figures (0 until the creator sends her
    // statistics) are two stories, and the form has no way to say "it is
    // another one". A double click there is prevented by the form itself.
    if (!storyId && dateSource !== 'now' && dedupe === true && allowDuplicate !== true) {
      const twin = await prisma.media.findFirst({
        where: {
          campaignId: id,
          influencerId,
          mediaType: 'STORY',
          externalId: null,
          permalink: canonicalPermalink,
          postedAt: resolvedPostedAt,
          views: nViews,
          reach: nReach,
          impressions: nImpressions,
          comments: nReplies,
        },
        select: { id: true },
      })
      if (twin) {
        return NextResponse.json(
          {
            error: 'Esta story ya está registrada (misma creadora, misma fecha y mismas cifras). Si es otra story, indica su enlace o su hora exacta.',
            duplicate: true,
            storyId: twin.id,
          },
          { status: 409 }
        )
      }
    }

    // Dedupe by story id INSIDE this campaign: the same link may already be a
    // row from the cron (externalId = id) or from Media → "Añadir publicación
    // por URL" (externalId = id, permalink = canonical URL). Media is unique
    // per (externalId, platform, campaignId), so a second create would fail:
    // update the metrics of the existing row instead of duplicating it.
    const existing = storyId
      ? await prisma.media.findFirst({
          where: {
            campaignId: id,
            platform: ci.influencer.platform,
            mediaType: 'STORY',
            OR: [{ externalId: storyId }, { permalink: { contains: `/${storyId}` } }],
          },
          orderBy: { createdAt: 'asc' },
        })
      : null

    if (existing) {
      if (existing.influencerId !== influencerId) {
        return NextResponse.json(
          { error: 'Esta story ya está registrada para otro creador.' },
          { status: 409 }
        )
      }
      // A typed count > 0 wins; an empty field never wipes what we already had.
      // The date is only replaced when the PM typed it or the link encodes it.
      const story = await prisma.media.update({
        where: { id: existing.id },
        data: {
          views: nViews > 0 ? nViews : existing.views,
          reach: nReach > 0 ? nReach : existing.reach,
          impressions: nImpressions > 0 ? nImpressions : existing.impressions,
          comments: nReplies > 0 ? nReplies : existing.comments,
          ...(dateSource !== 'now' && { postedAt: resolvedPostedAt }),
          ...(!existing.externalId && { externalId: storyId }),
          ...(!existing.permalink && { permalink: canonicalPermalink }),
          // Mark as manual so revalidation keeps it, but never downgrade a Meta
          // Graph API row (real reach/impressions) to 'manual'.
          ...(existing.source !== 'meta_api' && { source: 'manual' }),
        },
      })
      return NextResponse.json({ story, updated: true }, { status: 200 })
    }

    // Manual additions are exempt from the brand-keyword rule only (the PM
    // asserts relevance); `source: 'manual'` is what keeps revalidation from
    // detaching a hand-added story that carries no mentions/hashtags.
    let story
    try {
      story = await prisma.media.create({
        data: {
          externalId: storyId,
          platform: ci.influencer.platform,
          mediaType: 'STORY',
          permalink: canonicalPermalink,
          mediaUrl: cleanMediaUrl,
          thumbnailUrl: cleanThumbnailUrl,
          views: nViews,
          reach: nReach,
          impressions: nImpressions,
          comments: nReplies,
          postedAt: resolvedPostedAt,
          mentions: cleanMentions,
          hashtags: cleanHashtags,
          source: 'manual',
          dataSource: 'manual',
          influencerId,
          campaignId: id,
        },
      })
    } catch (err) {
      // Concurrent "Registrar Story" for the same link → unique (externalId, platform, campaignId)
      if ((err as { code?: string })?.code === 'P2002') {
        return NextResponse.json({ error: 'Esta story ya está registrada.' }, { status: 409 })
      }
      throw err
    }

    return NextResponse.json({ story, updated: false }, { status: 201 })
  } catch (error) {
    console.error('Add story error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
