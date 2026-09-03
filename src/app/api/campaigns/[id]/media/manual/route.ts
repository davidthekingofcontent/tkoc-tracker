import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { scrapeSinglePost, isApifyExhausted, isApifyConfiguredAsync } from '@/lib/apify'
import type { ScrapedSinglePost } from '@/lib/apify'
import { isWithinCampaignDates } from '@/lib/campaign-capture'
import type { MediaType, Platform } from '@/generated/prisma/client'

// POST /api/campaigns/[id]/media/manual
// Add ONE post / reel / video to a campaign by pasting its public URL.
// Manual additions are exempt from the brand-keyword rule ONLY (the PM asserts
// relevance): the content MUST belong to a creator who is already a member of
// the campaign AND must be dated inside the campaign window. Enriched through
// Apify when available; otherwise the metrics come from the body (or stay at
// 0) and the publication date MUST come from the body (`postedAt`) — an
// undated row can't be proven inside the window and is rejected.

type UrlPlatform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'

interface ParsedPostUrl {
  platform: UrlPlatform
  /** URL-derived id: IG shortcode, TikTok video id, YouTube video id */
  externalId: string
  mediaType: MediaType
  /** Clean permalink (no query string / hash) */
  canonicalUrl: string
  /** Substring that identifies this post inside any permalink variant */
  permalinkNeedle: string
  /** Username embedded in the URL, when the platform includes it */
  ownerHint: string | null
}

function parsePostUrl(input: string): ParsedPostUrl | null {
  let url: URL
  try {
    const trimmed = input.trim()
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname

  // Instagram: /p/{code}, /reel/{code}, /reels/{code}, /tv/{code}, optionally
  // prefixed by /{username}/ (newer share links)
  if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') {
    const m = path.match(/^\/(?:([A-Za-z0-9_.]+)\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/)
    if (!m) return null
    const [, owner, kind, code] = m
    const isReel = kind !== 'p'
    return {
      platform: 'INSTAGRAM',
      externalId: code,
      mediaType: isReel ? 'REEL' : 'POST',
      canonicalUrl: `https://www.instagram.com/${isReel ? 'reel' : 'p'}/${code}/`,
      permalinkNeedle: `/${code}`,
      ownerHint: owner && !['p', 'reel', 'reels', 'tv'].includes(owner) ? owner : null,
    }
  }

  // TikTok: /@user/video/{id} or /@user/photo/{id}. Short links (vm.tiktok.com,
  // tiktok.com/t/...) carry no id, so they are rejected with a clear message.
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const m = path.match(/^\/(?:@([A-Za-z0-9_.]+)\/)?(video|photo)\/(\d+)\/?/)
    if (!m) return null
    const [, owner, kind, id] = m
    return {
      platform: 'TIKTOK',
      externalId: id,
      mediaType: kind === 'photo' ? 'POST' : 'VIDEO',
      canonicalUrl: owner
        ? `https://www.tiktok.com/@${owner}/${kind}/${id}`
        : `https://www.tiktok.com/${kind}/${id}`,
      permalinkNeedle: `/${kind}/${id}`,
      ownerHint: owner || null,
    }
  }

  // YouTube: watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    let id: string | null = null
    let isShort = false
    if (host === 'youtu.be') {
      id = path.slice(1).split('/')[0] || null
    } else if (path === '/watch') {
      id = url.searchParams.get('v')
    } else {
      const m = path.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]+)/)
      if (m) {
        id = m[2]
        isShort = m[1] === 'shorts'
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
    return {
      platform: 'YOUTUBE',
      externalId: id,
      mediaType: isShort ? 'SHORT' : 'VIDEO',
      canonicalUrl: isShort
        ? `https://www.youtube.com/shorts/${id}`
        : `https://www.youtube.com/watch?v=${id}`,
      permalinkNeedle: id,
      ownerHint: null,
    }
  }

  return null
}

const PLATFORM_LABEL: Record<UrlPlatform, string> = {
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
}

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

    const parsed = parsePostUrl(rawUrl)
    if (!parsed) {
      return NextResponse.json(
        {
          error:
            'URL no reconocida. Usa el enlace de un post o reel de Instagram (instagram.com/p/… o /reel/…), un vídeo de TikTok (tiktok.com/@usuario/video/…) o un vídeo de YouTube (watch?v=… o /shorts/…). Los enlaces acortados no valen.',
        },
        { status: 400 }
      )
    }

    const influencerIdInput = typeof body.influencerId === 'string' && body.influencerId.trim()
      ? body.influencerId.trim()
      : null

    const manualLikes = optionalCount(body.likes)
    const manualComments = optionalCount(body.comments)
    const manualViews = optionalCount(body.views)
    if (manualLikes === null || manualComments === null || manualViews === null) {
      return NextResponse.json(
        { error: 'likes, comments y views deben ser números enteros positivos' },
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
              select: { id: true, username: true, platform: true },
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
    let scraped: ScrapedSinglePost | null = null
    if (!isApifyExhausted() && (await isApifyConfiguredAsync())) {
      scraped = await scrapeSinglePost(parsed.canonicalUrl)
    }
    const enriched = scraped !== null

    // ===== Resolve the creator (must be a campaign member) =====
    const ownerUsername = scraped?.ownerUsername || parsed.ownerHint || null

    let member: (typeof members)[number] | undefined
    if (influencerIdInput) {
      member = members.find((m) => m.id === influencerIdInput)
      if (!member) {
        return NextResponse.json(
          { error: 'El creador no está en esta campaña. Añádelo primero.' },
          { status: 400 }
        )
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

    // ===== Find an existing row for this post =====
    // Media has a GLOBAL unique on (externalId, platform). The tracking passes
    // store the numeric id while an un-enriched manual add only knows the
    // shortcode, so also match on the permalink needle (same trick as
    // meta-materialize) to avoid creating a duplicate row for the same post.
    const existing = await prisma.media.findFirst({
      where: {
        platform,
        OR: [
          { externalId },
          { externalId: parsed.externalId },
          { permalink: { contains: parsed.permalinkNeedle } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })

    if (existing && existing.influencerId !== member.id) {
      return NextResponse.json(
        { error: 'Este contenido ya está registrado para otro creador.' },
        { status: 409 }
      )
    }

    // A row belongs to at most ONE campaign: never steal another campaign's
    // attachment (detach it there first, then add it here).
    if (existing?.campaignId && existing.campaignId !== id) {
      return NextResponse.json(
        { error: 'Este contenido ya está asignado a otra campaña.' },
        { status: 409 }
      )
    }

    // ===== Build the row =====
    const likes = pickMetric(scraped?.likes, manualLikes, existing?.likes)
    const comments = pickMetric(scraped?.comments, manualComments, existing?.comments)
    const views = pickMetric(scraped?.views, manualViews, existing?.views)

    const postedAt: Date | null = scraped?.postedAt
      ? new Date(scraped.postedAt)
      : (manualPostedAt ?? existing?.postedAt ?? null)

    // ===== Rule (2): dated AND inside the campaign window =====
    // Manual additions skip the brand-keyword rule only; an undated row can't
    // be proven inside the window, so it is never attached.
    if (!postedAt || Number.isNaN(postedAt.getTime())) {
      return NextResponse.json(
        {
          error: enriched
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

    let media
    if (existing) {
      media = await prisma.media.update({
        where: { id: existing.id },
        data: {
          campaignId: id,
          likes,
          comments,
          views,
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
        // Concurrent add of the same post → unique (externalId, platform) violation
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
      { media, enriched, created: !existing },
      { status: existing ? 200 : 201 }
    )
  } catch (error) {
    console.error('Manual media add error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
