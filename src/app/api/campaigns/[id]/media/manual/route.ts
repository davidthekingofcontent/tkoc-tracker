import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeSinglePost, isApifyExhausted, isApifyConfiguredAsync } from '@/lib/apify'
import type { ScrapedSinglePost } from '@/lib/apify'
import { isWithinCampaignDates } from '@/lib/campaign-capture'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import { parsePostUrl, PLATFORM_LABEL } from '@/lib/post-url'
import type { ParsedPostUrl, UrlPlatform } from '@/lib/post-url'
import { ensureTikTokTwin, tiktokCandidateHandle } from '@/lib/tiktok-autolink'
import type { MediaType, Platform } from '@/generated/prisma/client'

// POST /api/campaigns/[id]/media/manual
// Add ONE post / reel / video / story to a campaign by pasting its public URL.
// Manual additions are exempt from the brand-keyword rule ONLY (the PM asserts
// relevance): the content MUST belong to a creator who is already a member of
// the campaign AND must be dated inside the campaign window. Enriched through
// Apify when available; otherwise the metrics come from the body (or stay at
// 0) and the publication date MUST come from the body (`postedAt`) — an
// undated row can't be proven inside the window and is rejected.
//
// Instagram STORIES (instagram.com/stories/{user}/{id}/) are never sent to
// Apify: they expire after 24 h and the single-post scraper does not read
// story URLs. Their publication date is decoded from the id (snowflake) and
// views/reach come only from the body — the creator is the only source.

function normalizeHandle(s: string): string {
  return s.toLowerCase().replace(/^@/, '').trim()
}

/** Optional non-negative integer from the body; `undefined` when absent, `null` when invalid */
function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/** Scraped value wins when it carries signal; otherwise the PM's number; otherwise what we already had */
function pickMetric(scraped: number | undefined, manual: number | undefined, existing: number | undefined): number {
  if (scraped && scraped > 0) return scraped
  if (manual !== undefined) return manual
  return existing ?? 0
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { id } = await params

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
    }

    // ===== Validate input =====
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
    if (!rawUrl) {
      return NextResponse.json({ error: 'Indica la URL del contenido' }, { status: 400 })
    }

    // Instagram story first: /stories/{user}/{id}/ (never scraped, dated from the id)
    const story = parseInstagramStoryUrl(rawUrl)
    if (story?.isHighlight) {
      return NextResponse.json(
        {
          error:
            'Los destacados (highlights) no son stories con fecha: registra la story original o usa "Registrar Story" con la fecha.',
        },
        { status: 400 }
      )
    }

    const parsed: ParsedPostUrl | null = story
      ? {
          platform: 'INSTAGRAM',
          externalId: story.storyId,
          mediaType: 'STORY',
          canonicalUrl: story.canonicalUrl,
          permalinkNeedle: `/${story.storyId}`,
          ownerHint: story.username || null,
          isStory: true,
          postedAtHint: story.postedAtHint,
        }
      : parsePostUrl(rawUrl)
    if (!parsed) {
      return NextResponse.json(
        {
          error:
            'URL no reconocida. Usa el enlace de un post o reel de Instagram (instagram.com/p/… o /reel/…), una story de Instagram (instagram.com/stories/usuario/…), un vídeo de TikTok (tiktok.com/@usuario/video/…) o un vídeo de YouTube (watch?v=… o /shorts/…). Los enlaces acortados no valen.',
        },
        { status: 400 }
      )
    }
    const isStory = parsed.isStory === true

    const influencerIdInput = typeof body.influencerId === 'string' && body.influencerId.trim()
      ? body.influencerId.trim()
      : null

    const manualLikes = optionalCount(body.likes)
    const manualComments = optionalCount(body.comments)
    const manualViews = optionalCount(body.views)
    // Reach is only meaningful for a story (the creator's insights); ignored otherwise
    const manualReach = isStory ? optionalCount(body.reach) : undefined
    if (manualLikes === null || manualComments === null || manualViews === null || manualReach === null) {
      return NextResponse.json(
        { error: 'likes, comments, views y reach deben ser números enteros positivos' },
        { status: 400 }
      )
    }

    let manualPostedAt: Date | undefined
    if (body.postedAt !== undefined && body.postedAt !== null && body.postedAt !== '') {
      const d = new Date(String(body.postedAt))
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'postedAt no es una fecha válida' }, { status: 400 })
      }
      manualPostedAt = d
    }

    // ===== Campaign + members =====
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true,
        startDate: true,
        endDate: true,
        influencers: {
          select: {
            influencer: {
              select: { id: true, username: true, platform: true, bio: true, website: true },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    const fmtDate = (d: Date) => d.toISOString().slice(0, 10)
    const windowLabel = `${fmtDate(campaign.startDate)} – ${campaign.endDate ? fmtDate(campaign.endDate) : 'sin fecha de fin'}`

    const members = campaign.influencers.map((ci) => ci.influencer)

    // ===== Enrich via Apify when available (never blocks the add) =====
    // Never for a story: it has expired or will within 24 h, and the single-post
    // scraper does not read story URLs — a paid call that can only fail.
    let scraped: ScrapedSinglePost | null = null
    if (!isStory && !isApifyExhausted() && (await isApifyConfiguredAsync())) {
      scraped = await scrapeSinglePost(parsed.canonicalUrl)
    }
    const enriched = scraped !== null

    // ===== Resolve the creator (must be a campaign member) =====
    const ownerUsername = scraped?.ownerUsername || parsed.ownerHint || null

    // TikTok auto-link (Nov 2026): a TikTok video whose author — the SCRAPED
    // owner, never the URL's @user — is the TikTok account of an Instagram
    // member (the user she links in her Instagram bio, else the same username)
    // links that account to the campaign instead of being refused. Only the
    // INTENT is recorded here: the account is created right before the media
    // row is written, so a request refused later (undated, outside the
    // campaign dates, already filed under someone else) leaves nothing behind.
    const twin: { intent: { igMember: (typeof members)[number]; handle: string } | null } = { intent: null }
    const provisionalTwin = async (igMember: (typeof members)[number], tiktokHandle: string) => {
      twin.intent = { igMember, handle: tiktokHandle }
      const lookalikes = await prisma.influencer.findMany({
        where: { platform: 'TIKTOK', username: { equals: tiktokHandle, mode: 'insensitive' } },
        select: { id: true, username: true },
      })
      const row = lookalikes.find((r) => r.username.toLowerCase() === tiktokHandle)
      return {
        id: row?.id ?? `pending-tiktok:${tiktokHandle}`,
        username: row?.username ?? tiktokHandle,
        platform: 'TIKTOK' as const,
        bio: null,
        website: null,
      }
    }

    let member: (typeof members)[number] | undefined
    if (influencerIdInput) {
      member = members.find((m) => m.id === influencerIdInput)
      if (!member) {
        return NextResponse.json(
          { error: 'El creador no está en esta campaña. Añádelo primero.' },
          { status: 400 }
        )
      }
      if (parsed.platform === 'TIKTOK' && member.platform === 'INSTAGRAM' && scraped?.ownerUsername) {
        const owner = normalizeHandle(scraped.ownerUsername)
        const tiktokMember = members.find((m) => m.platform === 'TIKTOK' && normalizeHandle(m.username) === owner)
        if (tiktokMember) {
          // The author's TikTok account is already in the campaign: file it there
          member = tiktokMember
        } else if (tiktokCandidateHandle(member).handle === owner) {
          member = await provisionalTwin(member, owner)
        } else {
          // A different username that her Instagram does not link: never guess identity
          return NextResponse.json(
            {
              error: `Este vídeo es de @${owner} en TikTok. Si es la cuenta de TikTok de @${member.username}, añádela en Elegir con su URL (https://www.tiktok.com/@${owner}) y vuelve a pegar el enlace.`,
              ownerUsername: owner,
            },
            { status: 400 }
          )
        }
      }
      // The scraped owner is authoritative: refuse to file someone else's post
      // under this creator. (The URL's @user is only a hint — TikTok resolves
      // any @user with a valid video id — so it is not used for rejection.)
      if (
        scraped?.ownerUsername &&
        normalizeHandle(scraped.ownerUsername) !== normalizeHandle(member.username)
      ) {
        return NextResponse.json(
          {
            error: `Este contenido es de @${normalizeHandle(scraped.ownerUsername)}, no de @${member.username}.`,
            ownerUsername: normalizeHandle(scraped.ownerUsername),
          },
          { status: 400 }
        )
      }
    } else if (ownerUsername) {
      const wanted = normalizeHandle(ownerUsername)
      member = members.find(
        (m) => m.platform === parsed.platform && normalizeHandle(m.username) === wanted
      )
      if (!member && parsed.platform === 'TIKTOK' && scraped?.ownerUsername) {
        // Same person, other network: an Instagram member whose TikTok (the one
        // linked in her Instagram bio, else the same username) is the author
        const igMember = members.find(
          (m) => m.platform === 'INSTAGRAM' && tiktokCandidateHandle(m).handle === wanted
        )
        if (igMember) member = await provisionalTwin(igMember, wanted)
      }
      if (!member) {
        return NextResponse.json(
          {
            error: `Indica el creador: @${wanted} no está en esta campaña.`,
            ownerUsername: wanted,
          },
          { status: 400 }
        )
      }
    } else {
      return NextResponse.json(
        { error: 'Indica el creador', ownerUsername: null },
        { status: 400 }
      )
    }

    if (member.platform !== parsed.platform) {
      return NextResponse.json(
        {
          error: `La URL es de ${PLATFORM_LABEL[parsed.platform]} pero @${member.username} está registrado en ${PLATFORM_LABEL[member.platform as UrlPlatform] ?? member.platform}.`,
        },
        { status: 400 }
      )
    }

    const platform = member.platform as Platform
    const externalId = scraped?.externalId || parsed.externalId

    // ===== Find an existing row for this post IN THIS CAMPAIGN =====
    // Media is unique per (externalId, platform, campaignId): the same post may
    // legitimately live in several campaigns. The tracking passes store the
    // numeric id while an un-enriched manual add only knows the shortcode, so
    // also match on the permalink needle (same trick as meta-materialize). An
    // unattached row (campaignId null) can be claimed for this campaign.
    const existing = await prisma.media.findFirst({
      where: {
        platform,
        AND: [
          {
            OR: [
              { externalId },
              { externalId: parsed.externalId },
              { permalink: { contains: parsed.permalinkNeedle } },
            ],
          },
          { OR: [{ campaignId: id }, { campaignId: null }] },
        ],
      },
      orderBy: [{ campaignId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
    })

    if (existing && existing.influencerId !== member.id) {
      return NextResponse.json(
        { error: 'Este contenido ya está registrado para otro creador.' },
        { status: 409 }
      )
    }

    // ===== Build the row =====
    // A story has no likes/comments (only views and reach, typed by the PM)
    const likes = isStory ? (existing?.likes ?? 0) : pickMetric(scraped?.likes, manualLikes, existing?.likes)
    const comments = isStory ? (existing?.comments ?? 0) : pickMetric(scraped?.comments, manualComments, existing?.comments)
    const views = pickMetric(scraped?.views, manualViews, existing?.views)
    const reach: number | undefined = isStory && manualReach !== undefined ? manualReach : undefined

    // A story's id encodes its exact publication time (snowflake): it wins over
    // the PM's typed date, which is a guess (hours off in practice, Oct 2026).
    // A post keeps the PM's date when Apify did not read one.
    const postedAt: Date | null = scraped?.postedAt
      ? new Date(scraped.postedAt)
      : (parsed.postedAtHint ?? manualPostedAt ?? existing?.postedAt ?? null)

    // ===== Rule (2): dated AND inside the campaign window =====
    // Manual additions skip the brand-keyword rule only; an undated row can't
    // be proven inside the window, so it is never attached.
    if (!postedAt || Number.isNaN(postedAt.getTime())) {
      return NextResponse.json(
        {
          error: isStory
            ? 'No se pudo leer la fecha de la story del enlace: indica la fecha de publicación (o regístrala en Stories → "Registrar Story" con la fecha).'
            : enriched
              ? 'No se pudo determinar la fecha de publicación del contenido. Indica postedAt (fecha de publicación) para añadirlo.'
              : 'Apify no está disponible para leer la fecha de publicación. Indica postedAt (fecha de publicación) para añadir el contenido.',
          needsPostedAt: true,
        },
        { status: 400 }
      )
    }

    if (!isWithinCampaignDates(campaign, postedAt)) {
      return NextResponse.json(
        {
          error: `El contenido se publicó el ${fmtDate(postedAt)}, fuera del periodo de la campaña (${windowLabel}).`,
          postedAt: postedAt.toISOString(),
        },
        { status: 400 }
      )
    }

    const include = {
      influencer: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, platform: true },
      },
    }

    // Every check has passed: now the creator's TikTok account joins the campaign
    if (twin.intent) {
      const linked = await ensureTikTokTwin({ campaignId: id, igInfluencerId: twin.intent.igMember.id, handle: twin.intent.handle })
      if (!linked) {
        return NextResponse.json(
          { error: 'No se pudo vincular la cuenta de TikTok. Añádela en Elegir con su URL completa y vuelve a pegar el enlace.' },
          { status: 400 }
        )
      }
      member = { ...member, id: linked.influencerId, username: linked.username }
    }

    let media
    if (existing) {
      media = await prisma.media.update({
        where: { id: existing.id },
        data: {
          campaignId: id,
          likes,
          comments,
          views,
          ...(reach !== undefined && { reach }),
          postedAt,
          permalink: existing.permalink || parsed.canonicalUrl,
          ...(scraped?.caption && { caption: scraped.caption }),
          ...(scraped?.thumbnailUrl && { thumbnailUrl: scraped.thumbnailUrl }),
          ...(scraped && { mediaType: scraped.mediaType }),
          ...(scraped && scraped.hashtags.length > 0 && { hashtags: scraped.hashtags }),
          ...(scraped && scraped.mentions.length > 0 && { mentions: scraped.mentions }),
          // Mark as manual so revalidation keeps it, but never downgrade a Meta
          // Graph API row (real reach/impressions) to 'manual'.
          ...(existing.source !== 'meta_api' && { source: 'manual' }),
        },
        include,
      })
    } else {
      try {
        media = await prisma.media.create({
          data: {
            externalId,
            platform,
            mediaType: scraped?.mediaType ?? parsed.mediaType,
            caption: scraped?.caption ?? null,
            thumbnailUrl: scraped?.thumbnailUrl ?? null,
            permalink: parsed.canonicalUrl,
            likes,
            comments,
            views,
            ...(reach !== undefined && { reach }),
            hashtags: scraped?.hashtags ?? [],
            mentions: scraped?.mentions ?? [],
            postedAt,
            source: 'manual',
            dataSource: enriched ? 'apify' : 'manual',
            influencerId: member.id,
            campaignId: id,
          },
          include,
        })
      } catch (err) {
        // Concurrent add of the same post → unique (externalId, platform, campaignId) violation
        if ((err as { code?: string })?.code === 'P2002') {
          return NextResponse.json(
            { error: 'Este contenido ya está registrado.' },
            { status: 409 }
          )
        }
        throw err
      }
    }

    return NextResponse.json(
      { media, enriched, created: !existing, isStory },
      { status: existing ? 200 : 201 }
    )
  } catch (error) {
    console.error('Manual media add error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
