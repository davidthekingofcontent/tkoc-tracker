import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, isStaffRole } from '@/lib/auth'
import {
  STORIES_MAX_CAMPAIGN_DAYS,
  STORY_SCAN_STATUSES,
  findLateCopyElsewhere,
  findPostCopiesInOtherCampaigns,
  loadCampaignBrandAccounts,
  lockPostForCampaignChoice,
  storiesCampaignSkipReason,
  withCampaignMembership,
} from '@/lib/campaign-capture'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import { isBrandAccount } from '@/lib/campaign-targets'
import { daysSincePosted, storiesLastResultFor } from '@/lib/stories-notices'
import { countedElsewhereMessage, decideLateWindow, decideManualLate, outsideWindowMessage } from '@/lib/assignment-rules'
import type { LateDecision } from '@/lib/assignment-rules'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import type { Platform, Prisma } from '@/generated/prisma/client'

function normalizeHandle(s: string): string {
  return s.toLowerCase().replace(/^@/, '').trim()
}

/**
 * Every 400/409 of «Registrar Story» is written to the server log, so the
 * Monday review can see what the PMs tried without a new table
 * (`[manual-refusal]`, Railway). Nothing personal beyond the public username
 * in the message and the link pasted: never the figures typed.
 */
function logRefusal(details: { campaignId: string; influencerId: string | null; status: number; code: string; reason: string; url: string | null }): void {
  console.warn('[manual-refusal]', JSON.stringify({ route: 'stories', ...details }))
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

type LateRefusal = Extract<LateDecision, { ok: false }>

/** A late story refused inside the membership lock: answered as it is, nothing written. */
class LateStoryRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super('late story refused')
  }
}

function lateRefusalBody(decision: LateRefusal, postedAt: Date): Record<string, unknown> {
  return {
    code: decision.code,
    error: decision.message,
    postedAt: postedAt.toISOString(),
    ...(decision.lateDays !== undefined && { lateDays: decision.lateDays }),
  }
}

/**
 * Does the creator still owe a piece? Her status and deliverables, and the
 * pieces of the campaign credited to her, read with `db` (inside her
 * exclusive membership lock when the story is written).
 */
async function decideForCreator(
  db: Prisma.TransactionClient | typeof prisma,
  campaignId: string,
  influencerId: string,
  handle: string,
  campaign: { name: string; type: string; status: string; startDate: Date; endDate: Date | null },
  postedAt: Date
): Promise<LateDecision> {
  const membership = await db.campaignInfluencer.findUnique({
    where: { campaignId_influencerId: { campaignId, influencerId } },
    select: { status: true, deliverablesPlanned: true },
  })
  if (!membership) return { ok: true, lateDays: null }
  const delivered = await db.media.count({ where: { campaignId, influencerId } })
  return decideManualLate(
    { campaign, member: { status: membership.status, deliverablesPlanned: membership.deliverablesPlanned, delivered, handle }, postedAt },
    { subject: 'story' }
  )
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

    // The campaign's stories, and what the automatic scan does with the
    // campaign (the `scan` block below), read together
    const [stories, campaign, scanSettings] = await Promise.all([
      prisma.media.findMany({
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
      }),
      prisma.campaign.findUnique({
        where: { id },
        select: {
          type: true,
          status: true,
          startDate: true,
          endDate: true,
          targetAccounts: true,
          targetHashtags: true,
          targetKeywords: true,
          influencers: { select: { status: true, influencer: { select: { platform: true } } } },
        },
      }),
      prisma.setting.findMany({
        where: { key: { in: ['cron_stories_last_run', 'cron_stories_last_result'] } },
        select: { key: true, value: true },
      }),
    ])

    // Calculate story stats
    const now = new Date()
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    // SCAN BLOCK (16 Nov 2026): why the stories cron does or does not read this
    // campaign today, with the same rule the cron applies
    // (storiesCampaignSkipReason), how many of its Instagram creators it would
    // read (STORY_SCAN_STATUSES), and what the last run did with it. The tab
    // used to show nothing: a campaign without brand targets or with every
    // creator in Prospecto looked like a scan that found no stories.
    const settingOf = (key: string) => scanSettings.find(s => s.key === key)?.value ?? null
    const lastRunRaw = settingOf('cron_stories_last_run')
    const lastRunAt = lastRunRaw && Number.isFinite(Date.parse(lastRunRaw)) ? new Date(Date.parse(lastRunRaw)).toISOString() : null
    const lastResultForCampaign = storiesLastResultFor(settingOf('cron_stories_last_result'), id)
    const instagramMembers = campaign ? campaign.influencers.filter(ci => ci.influencer.platform === 'INSTAGRAM') : []
    const scanStatuses: readonly string[] = STORY_SCAN_STATUSES
    const scan = campaign
      ? {
          // A paused or archived campaign is read by no cron, whatever its
          // dates or targets say: 'inactive' (18 Nov 2026). The cron's own
          // reasons apply to an ACTIVE campaign only.
          reason: campaign.status === 'ACTIVE' ? storiesCampaignSkipReason(campaign, now) : ('inactive' as const),
          /** The campaign has an end date: a 'too_long' then means "shorten it", not "set one" */
          hasEndDate: campaign.endDate !== null,
          /** Instagram creators in Acordado or later: the ones the cron reads today */
          confirmedCreators: instagramMembers.filter(ci => scanStatuses.includes(ci.status)).length,
          /** All the Instagram creators of the campaign (the N of «0 de N») */
          instagramCreators: instagramMembers.length,
          /** Creators read for this campaign in the last run; null when that run did not list it */
          scannedCreators: lastResultForCampaign?.scanned ? lastResultForCampaign.creators : null,
          lastRunAt,
          lastResultForCampaign,
          /** Longest campaign the scan accepts (STORIES_MAX_CAMPAIGN_DAYS), for the «pon una fecha de fin» hint */
          maxCampaignDays: STORIES_MAX_CAMPAIGN_DAYS,
        }
      : null

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

    // isActive / expiresAt: the story is still live on Instagram (24 h).
    // daysSincePosted: what the tab shows afterwards («Publicada hace N días»);
    // the row never expires in the report.
    const withLife = (s: (typeof stories)[number]) => ({
      ...s,
      isActive: s.postedAt ? new Date(s.postedAt) > twentyFourHoursAgo : false,
      expiresAt: s.postedAt
        ? new Date(new Date(s.postedAt).getTime() + 24 * 60 * 60 * 1000)
        : null,
      daysSincePosted: daysSincePosted(s.postedAt, now),
    })

    return NextResponse.json({
      stories: stories.map(withLife),
      byInfluencer: Array.from(byInfluencer.values())
        .sort((a, b) => b.totalViews - a.totalViews)
        .map(group => ({ ...group, stories: group.stories.map(withLife) })),
      stats: {
        total: stories.length,
        active: activeStories.length,
        // Stories no longer live on Instagram (older than 24 h): still counted in the report
        expired: expiredStories.length,
        totalReach,
        totalImpressions,
        totalViews,
        totalReplies,
      },
      scan,
    })
  } catch (error) {
    console.error('Stories tracking error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Manually add a story record ("Registrar Story"). Agency staff only.
//
// LATE STORIES (Nov 2026, src/lib/assignment-rules.ts): a story dated AFTER
// the end of the campaign (from its link or the date typed) is accepted,
// marked late (`lateDays` in the answer, team only), when the campaign is an
// ACTIVE collaboration, the story is at most 30 days late, the creator still
// owes a piece, and the same story (by its id) has no row in another campaign
// (409 `counted_elsewhere`). The pieces she has delivered are counted inside
// her membership lock, held exclusively. A story before the start, or one
// without a date once the campaign has ended, is refused as always. A story
// inside the window whose id already counts LATE in another campaign gets the
// same 409.
//
// WHO IT COUNTS FOR (16 Nov 2026): the owner of a story link is resolved with
// the campaign roster (src/lib/campaign-roster.ts), so a story published from
// any profile of the creator's person is accepted and credited to her member
// row with `publishedByInfluencerId` = the profile that published it. The
// brand's accounts are never credited to a creator (same guard as the manual
// route). A highlight link is refused unless the PM types the date. Every
// 400/409 is logged as `[manual-refusal]` for the Monday review.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    // Checked here and not left to the middleware
    if (!isStaffRole(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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

    const rawPermalink = typeof permalink === 'string' ? permalink.trim() : ''
    /** Answers a 400/409 and leaves its trace in the log ([manual-refusal]); the link is cut at 500 characters like the manual route does */
    const refuse = (status: number, code: string, body: Record<string, unknown>) => {
      logRefusal({
        campaignId: id,
        influencerId: typeof influencerId === 'string' ? influencerId : null,
        status,
        code,
        reason: typeof body.error === 'string' ? body.error : code,
        url: rawPermalink ? rawPermalink.slice(0, 500) : null,
      })
      return NextResponse.json(body, { status })
    }

    if (!influencerId || typeof influencerId !== 'string') {
      return refuse(400, 'invalid_input', { error: 'influencerId is required' })
    }

    // Counts typed by the PM (empty/absent → 0). Text or a negative number used
    // to become 0 in silence (12 Nov 2026): now it is a 400.
    const counts = [views, reach, impressions, replies].map(parseStoryCount)
    if (counts.some((c) => c === undefined)) {
      return refuse(400, 'invalid_input', {
        error: `Las cifras de la story (vistas, alcance, impresiones, respuestas) deben ser números entre 0 y ${STORY_COUNT_MAX}.`,
      })
    }
    const cleanMentions = parseStringList(mentions)
    const cleanHashtags = parseStringList(hashtags)
    if (cleanMentions === undefined || cleanHashtags === undefined) {
      return refuse(400, 'invalid_input', {
        error: `mentions y hashtags deben ser listas de como mucho ${STORY_LIST_MAX} textos cortos.`,
      })
    }
    const cleanMediaUrl = parseOptionalHttpUrl(mediaUrl)
    const cleanThumbnailUrl = parseOptionalHttpUrl(thumbnailUrl)
    if (cleanMediaUrl === undefined || cleanThumbnailUrl === undefined) {
      return refuse(400, 'invalid_input', { error: 'mediaUrl y thumbnailUrl deben ser direcciones http(s) completas.' })
    }

    // Rule (1): the creator must be a member of this campaign
    const ci = await prisma.campaignInfluencer.findFirst({
      where: { campaignId: id, influencerId },
      include: {
        influencer: { select: { platform: true, username: true, personId: true } },
        campaign: { select: { name: true, type: true, status: true, startDate: true, endDate: true, targetAccounts: true } },
      },
    })

    if (!ci) {
      return refuse(400, 'not_member', { error: 'Influencer not in this campaign' })
    }

    // An Instagram story link (instagram.com/stories/{user}/{id}/) names its
    // owner and encodes its publication time in the id: use both. The link is
    // optional, so anything that is not a story URL is stored as pasted.
    const parsedStory = rawPermalink ? parseInstagramStoryUrl(rawPermalink) : null
    const typedPostedAt = postedAt !== undefined && postedAt !== null && postedAt !== ''

    // A link that is not a story URL is stored as pasted, so it must at least
    // be an http(s) URL of at most 2000 characters, like mediaUrl and
    // thumbnailUrl (18 Nov 2026: 'javascript:…' and a 20 kB string were stored
    // and rendered as <a href>). A link typed without its scheme gets https://.
    let storedPermalink: string | null = parsedStory ? parsedStory.canonicalUrl : null
    if (!parsedStory && rawPermalink) {
      const asTyped = parseOptionalHttpUrl(rawPermalink)
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawPermalink)
      const withScheme = asTyped === undefined && !hasScheme ? parseOptionalHttpUrl(`https://${rawPermalink}`) : undefined
      const clean = asTyped ?? withScheme
      if (!clean) {
        return refuse(400, 'invalid_input', {
          error: 'El enlace de la story tiene que ser una dirección web (http o https) de como mucho 2000 caracteres.',
        })
      }
      storedPermalink = clean
    }

    // A HIGHLIGHT (instagram.com/stories/highlights/{id}/) is a saved reel of
    // stories: its id is not a story id, it carries no date and the link names
    // no owner. Until 16 Nov 2026 it was stored dated "now". Same rule as
    // «Añadir publicación por URL» now: refused, unless the PM types the
    // publication date, in which case it is stored as a hand-added story with
    // that date (source 'manual', no story id to de-duplicate by).
    if (parsedStory?.isHighlight && !typedPostedAt) {
      return refuse(400, 'highlight_needs_date', {
        error: 'Los destacados (highlights) no son stories con fecha: registra la story original o indica la "Fecha de publicación" para guardarlo con esa fecha.',
        needsPostedAt: true,
      })
    }

    // WHO IT COUNTS FOR (Nov 2026: a creator is a person with several
    // profiles). The owner of the link is resolved with the campaign roster, as
    // «Añadir publicación por URL» does: a story published from another profile
    // of the same person is accepted, credited to her member row and remembers
    // the profile that published it (publishedByInfluencerId). The old check
    // compared the link's @user with the member's username alone, so the story
    // of a creator's second account was refused as «de otra creadora».
    /** The member row the story is credited to: the one picked, unless the roster names another row of the same person */
    let credited = { influencerId, username: ci.influencer.username, platform: ci.influencer.platform as Platform }
    /** The profile that published it, when it is not the credited member's own */
    let publishedByInfluencerId: string | null = null
    const linkStory = parsedStory && !parsedStory.isHighlight ? parsedStory : null
    if (linkStory?.username) {
      const linkOwner = normalizeHandle(linkStory.username)
      const roster = await loadCampaignRoster(id)
      const credit = roster.creditFor('INSTAGRAM', linkOwner)
      // The brand's accounts (a "Cuenta de Marca Objetivo", or the Instagram the
      // brand connected through Meta) are never credited to a creator: every
      // story of the brand would land in her row. The same guard as the manual
      // route; the brand's own row, when the brand was added as a creator, keeps
      // its own stories.
      const brand = (await loadCampaignBrandAccounts([{ id, targetAccounts: ci.campaign.targetAccounts }])).get(id) ?? { targets: [], own: [] }
      const brandKind = (handle: string): 'target' | 'own' | null =>
        isBrandAccount(brand.targets, handle) ? 'target' : isBrandAccount(brand.own, handle) ? 'own' : null
      const ownerBrandKind = brandKind(linkOwner)
      if (ownerBrandKind && !credit?.self) {
        const goesTo = credit?.member.username ?? ci.influencer.username
        if (!brandKind(goesTo)) {
          return refuse(400, 'brand_account', {
            error: ownerBrandKind === 'target'
              ? `@${linkOwner} es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @${goesTo}.`
              : `@${linkOwner} es la cuenta de la marca de esta campaña. Su contenido no se guarda en la fila de @${goesTo}.`,
          })
        }
      }
      const samePerson = !!credit && !!ci.influencer.personId && credit.member.personId === ci.influencer.personId
      if (!credit || (credit.member.influencerId !== influencerId && !samePerson)) {
        // Nobody's profile in this campaign, or another creator's: refused only
        // now that no profile of the person matches, naming the member it counts
        // for so the form can preselect her
        const owner = credit ? credit.member.username : linkOwner
        return refuse(400, 'link_owner', {
          error: credit && !credit.self
            ? `El enlace es de @${linkOwner}, que es un perfil de @${owner}, no de @${ci.influencer.username}.`
            : `El enlace es de @${owner}, no de @${ci.influencer.username}.`,
          ownerUsername: owner,
        })
      }
      // Her own row, or another member row of the same person (a legacy double
      // membership): credited where the roster says, as the manual route does
      credited = { influencerId: credit.member.influencerId, username: credit.member.username, platform: credit.member.platform }
      publishedByInfluencerId = credit.self ? null : credit.publisher.influencerId
    }
    /** The network of the publication: an Instagram story link is Instagram whatever row it is credited to */
    const platform: Platform = linkStory ? 'INSTAGRAM' : credited.platform

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
        return refuse(400, 'invalid_input', { error: 'postedAt no es una fecha válida' })
      }
      dateSource = 'body'
    } else {
      resolvedPostedAt = new Date()
      dateSource = 'now'
    }

    // Inside the window as always. After it: a late story when the campaign and
    // the creator allow it (decideLateWindow here, her part below). Before the
    // start, or "now" once the campaign has ended: refused as always.
    const wording = { subject: 'story' as const, dateNote: dateSource === 'link' ? ' (según el enlace)' : '' }
    const window = decideLateWindow({ campaign: ci.campaign, postedAt: resolvedPostedAt }, wording)
    if (!window.ok || (window.lateDays !== null && dateSource === 'now')) {
      const fmt = (d: Date) => d.toISOString().slice(0, 10)
      const span = `${fmt(ci.campaign.startDate)} – ${ci.campaign.endDate ? fmt(ci.campaign.endDate) : 'sin fecha de fin'}`
      if (dateSource === 'now' || window.ok || window.code === 'before_start') {
        return refuse(400, dateSource === 'now' ? 'needs_posted_at' : 'outside_window', {
          error: dateSource === 'now'
            ? `La campaña ya terminó (${span}): indica la fecha de publicación de la story.`
            : outsideWindowMessage(ci.campaign, resolvedPostedAt, wording),
          needsPostedAt: dateSource === 'now',
          postedAt: resolvedPostedAt.toISOString(),
        })
      }
      return refuse(400, window.code, lateRefusalBody(window, resolvedPostedAt))
    }
    /** Days after the end of the campaign; null = inside the window */
    const lateDays = window.lateDays

    // Counts (validated above). A story has no likes; the "replies" field lands in `comments`.
    const [nViews, nReach, nImpressions, nReplies] = counts as number[]

    const storyId = linkStory?.storyId ?? null
    // A story link or a highlight link is stored clean; anything else as the http(s) URL checked above
    const canonicalPermalink = storedPermalink

    /** A late story counts in ONE campaign: the rows of the same story (by its id) in other campaigns */
    const storyElsewhere = (db: Prisma.TransactionClient | typeof prisma = prisma) =>
      storyId ? findPostCopiesInOtherCampaigns({ platform, externalIds: [storyId] }, id, db) : Promise.resolve([])
    const countedElsewhere = (copy: { campaign: { id: string; name: string } }, lateThere = false) => ({
      code: 'counted_elsewhere',
      error: countedElsewhereMessage(copy.campaign.name, { subject: 'story', lateThere }),
      campaign: { id: copy.campaign.id, name: copy.campaign.name },
    })
    // Inside the window as always, unless the same story already counts LATE in
    // another campaign: a late piece counts in one campaign only
    if (lateDays === null && storyId) {
      const lateThere = await findLateCopyElsewhere({ platform, externalIds: [storyId] }, id)
      const ownRow = lateThere
        ? await prisma.media.findFirst({ where: { campaignId: id, platform, externalId: storyId }, select: { id: true } })
        : null
      if (lateThere && !ownRow) return refuse(409, 'counted_elsewhere', countedElsewhere(lateThere, true))
    }

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
          influencerId: credited.influencerId,
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
        return refuse(409, 'duplicate', {
          error: 'Esta story ya está registrada (misma creadora, misma fecha y mismas cifras). Si es otra story, indica su enlace o su hora exacta.',
          duplicate: true,
          storyId: twin.id,
        })
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
            platform,
            mediaType: 'STORY',
            OR: [{ externalId: storyId }, { permalink: { contains: `/${storyId}` } }],
          },
          orderBy: { createdAt: 'asc' },
        })
      : null

    if (existing) {
      if (existing.influencerId !== credited.influencerId) {
        return refuse(409, 'other_creator', { error: 'Esta story ya está registrada para otro creador.' })
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
          // Who published it, when the row did not know (stored before the roster existed)
          ...(publishedByInfluencerId && !existing.publishedByInfluencerId && { publishedByInfluencerId }),
          // Mark as manual so revalidation keeps it, but never downgrade a Meta
          // Graph API row (real reach/impressions) to 'manual'.
          ...(existing.source !== 'meta_api' && { source: 'manual' }),
        },
      })
      // Already a piece of this campaign: a late one is refreshed, not counted again
      return NextResponse.json({ story, updated: true, lateDays }, { status: 200 })
    }

    // Manual additions are exempt from the brand-keyword rule only (the PM
    // asserts relevance); `source: 'manual'` is what keeps revalidation from
    // detaching a hand-added story that carries no mentions/hashtags.
    const data = {
      externalId: storyId,
      platform,
      mediaType: 'STORY' as const,
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
      // Credited to the member; published by another profile of hers when the link says so
      influencerId: credited.influencerId,
      publishedByInfluencerId,
      campaignId: id,
    }
    let story
    try {
      if (lateDays === null) {
        story = await prisma.media.create({ data })
      } else {
        // A late story: the same story in another campaign, and whether she still
        // owes a piece, are read inside her membership lock (held exclusively), so
        // two late stories for a creator who owes one cannot both be stored.
        story = await withCampaignMembership(id, credited.influencerId, async tx => {
          // Two late adds of this story to two campaigns at once wait for each other here
          await lockPostForCampaignChoice(tx, platform, storyId)
          const elsewhere = await storyElsewhere(tx)
          if (elsewhere.length > 0) throw new LateStoryRefused(409, countedElsewhere(elsewhere[0]))
          const decision = await decideForCreator(tx, id, credited.influencerId, credited.username, ci.campaign, resolvedPostedAt)
          if (!decision.ok) throw new LateStoryRefused(400, lateRefusalBody(decision, resolvedPostedAt))
          return tx.media.create({ data })
        }, { exclusive: true })
        if (story === null) {
          return refuse(409, 'not_member_anymore', {
            error: `@${credited.username} ya no está en esta campaña. Recarga la página y vuelve a registrar la story.`,
          })
        }
      }
    } catch (err) {
      if (err instanceof LateStoryRefused) {
        return refuse(err.status, typeof err.body.code === 'string' ? err.body.code : 'late_refused', err.body)
      }
      // Concurrent "Registrar Story" for the same link → unique (externalId, platform, campaignId)
      if ((err as { code?: string })?.code === 'P2002') {
        return refuse(409, 'duplicate', { error: 'Esta story ya está registrada.' })
      }
      throw err
    }

    // lateDays: days after the end of the campaign (team only), null inside the window
    return NextResponse.json({ story, updated: false, lateDays }, { status: 201 })
  } catch (error) {
    console.error('Add story error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
