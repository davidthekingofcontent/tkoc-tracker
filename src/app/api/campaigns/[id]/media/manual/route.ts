import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession, isStaffRole } from '@/lib/auth'
import { scrapeSinglePost, isApifyExhausted, isApifyConfiguredAsync } from '@/lib/apify'
import type { ScrapedSinglePost } from '@/lib/apify'
import { findLateCopyElsewhere, findPostCopiesInOtherCampaigns, loadCampaignBrandAccounts, lockPostForCampaignChoice, withCampaignMembership } from '@/lib/campaign-capture'
import type { CampaignPostCopy, PostIdentity } from '@/lib/campaign-capture'
import { countedElsewhereMessage, decideLateWindow, decideManualLate, lateDaysOf, outsideWindowMessage } from '@/lib/assignment-rules'
import type { LateDecision } from '@/lib/assignment-rules'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import type { Roster, RosterMember } from '@/lib/campaign-roster'
import { isBrandAccount } from '@/lib/campaign-targets'
import {
  PersonLinkError,
  describeMainProfileOfPerson,
  findInfluencerExact,
  findOrCreateInfluencerExact,
  linkProfile,
  normalizeHandle,
} from '@/lib/person-profiles'
import type { Actor } from '@/lib/person-profiles'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import { parsePostUrl, PLATFORM_LABEL } from '@/lib/post-url'
import type { ParsedPostUrl, UrlPlatform } from '@/lib/post-url'
import { isShortPostUrl, resolveShortUrl } from '@/lib/resolve-short-url'
import { tiktokCandidateHandle } from '@/lib/tiktok-autolink'
import { tiktokIdPostedAt } from '@/lib/tiktok-id'
import type { Platform, Prisma } from '@/generated/prisma/client'

// POST /api/campaigns/[id]/media/manual
// Add ONE post / reel / video / story to a campaign by pasting its public URL.
// Manual additions are exempt from the brand-keyword rule ONLY (the PM asserts
// relevance): the content MUST belong to a creator who is already a member of
// the campaign AND must be dated inside the campaign window. Enriched through
// Apify when available; otherwise the metrics come from the body (or stay at
// 0) and the publication date comes from the id in the link (stories and
// TikTok) or from the body (`postedAt`) — an undated row can't be proven
// inside the window and is rejected.
//
// LATE PIECES (Nov 2026, src/lib/assignment-rules.ts): content published
// AFTER the end is accepted, marked late (the answer carries `lateDays`), when
// the campaign is an ACTIVE collaboration (not Social Listening), it is at
// most LATE_ACCEPT_MAX_DAYS (30) days late, the member still owes a piece
// (AGREED…POSTED; her number of deliverables, or one piece without a number)
// and the same post does not have a row in another campaign (a late piece
// counts in ONE campaign: 409 `counted_elsewhere`). What she has delivered is
// counted inside the membership lock, held exclusively for a late piece, so
// two late adds for a creator who owes one cannot both pass. Content before
// the start is refused as always. «Fuera de plazo» is team only. The other
// way round too: content inside this window whose post already counts LATE in
// another campaign is refused with the same 409 (it counts there).
//
// Instagram STORIES (instagram.com/stories/{user}/{id}/) are never sent to
// Apify: they expire after 24 h and the single-post scraper does not read
// story URLs. Their publication date is decoded from the id (snowflake) and
// views/reach come only from the body — the creator is the only source.
//
// A CREATOR IS A PERSON WITH SEVERAL PROFILES (Nov 2026). The content may be
// published by ANY profile of a member: it is stored with `influencerId` = the
// member (who it counts for), `publishedByInfluencerId` = the profile that
// published it when that is not the member's own, and `platform` = the network
// of the publication. Who is credited is decided by the campaign roster
// (src/lib/campaign-roster.ts). When the author is not a registered profile of
// any member, the answer is 409 `profile_not_linked` and nothing is created:
// the PM says whose profile it is (`linkProfileTo`) and the same request,
// sent again, registers that profile on her and stores the publication. This
// route NEVER creates a campaign member.
//
// Body: url (required), influencerId, likes, comments, views, reach (stories),
// postedAt, linkProfileTo (a MEMBER's influencerId: "the author is another
// profile of hers"), confirmUnverified (required with linkProfileTo when the
// author could not be read from the network, only from the link),
// linkProfileAuthor + linkProfileAuthorPlatform (the author and network the PM
// was shown when she answered: when the author read now is another one, or on
// another network, nothing is linked and she is asked again; when no author can
// be read now, nothing is stored).
//
// A "Cuenta de Marca Objetivo" of the campaign, and the brand's own Instagram
// account connected through Meta, are never registered as a profile of a
// creator, nor credited to one: every publication of the brand would end up in
// her row.

/** What a handle of Instagram or TikTok can look like once normalised. Nothing else ever becomes a profile row. */
const PLAUSIBLE_HANDLE = /^[a-z0-9._]{1,40}$/

const UNKNOWN_AUTHOR_ERROR =
  'No he podido leer de quién es esta publicación. Inténtalo en unos minutos o pega el enlace con el usuario.'

type SuggestionReason = 'selected' | 'bio_link' | 'same_handle'

interface Suggestion {
  influencerId: string
  username: string
  platform: Platform
  reason: SuggestionReason
}

/** Optional non-negative integer from the body; `undefined` when absent, `null` when invalid */
function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

/** Optional id from the body: a non-empty string, else null */
function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Scraped value wins when it carries signal; otherwise the PM's number; otherwise what we already had */
function pickMetric(scraped: number | undefined, manual: number | undefined, existing: number | undefined): number {
  if (scraped && scraped > 0) return scraped
  if (manual !== undefined) return manual
  return existing ?? 0
}

function networkLabel(platform: string): string {
  return PLATFORM_LABEL[platform as UrlPlatform] ?? platform
}

/**
 * Members the author may belong to, strongest first and without repeats: the
 * one the PM chose, then Instagram members whose bio or website links that
 * TikTok user, then members with the same handle on another network. Only
 * suggestions: nothing is linked until the PM confirms one.
 */
function suggestMembers(roster: Roster, platform: Platform, authorHandle: string, chosen: RosterMember | null): Suggestion[] {
  const suggestions: Suggestion[] = []
  const add = (m: RosterMember, reason: SuggestionReason) => {
    if (suggestions.some(s => s.influencerId === m.influencerId)) return
    suggestions.push({ influencerId: m.influencerId, username: m.username, platform: m.platform, reason })
  }
  if (chosen) add(chosen, 'selected')
  if (platform === 'TIKTOK') {
    for (const m of roster.members) {
      if (m.platform !== 'INSTAGRAM') continue
      const candidate = tiktokCandidateHandle(m)
      if (candidate.via === 'bio' && candidate.handle === authorHandle) add(m, 'bio_link')
    }
  }
  for (const m of roster.members) {
    if (m.platform !== platform && normalizeHandle(m.username) === authorHandle) add(m, 'same_handle')
  }
  return suggestions
}

type LateRefusal = Extract<LateDecision, { ok: false }>

/** A late piece refused inside the membership lock: answered as it is, nothing written. */
class LateRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super('late piece refused')
  }
}

/** The answer of a refused late piece: { code, error, postedAt, lateDays? } */
function lateRefusalBody(decision: LateRefusal, postedAt: Date): Record<string, unknown> {
  return {
    code: decision.code,
    error: decision.message,
    postedAt: postedAt.toISOString(),
    ...(decision.lateDays !== undefined && { lateDays: decision.lateDays }),
  }
}

/**
 * 409 of a piece that counts in another campaign: a late piece whose post
 * already has a row there, or (lateThere) a post that already counts LATE there.
 */
function countedElsewhereBody(copy: CampaignPostCopy, subject: 'post' | 'story', lateThere = false): Record<string, unknown> {
  return {
    code: 'counted_elsewhere',
    error: countedElsewhereMessage(copy.campaign.name, { subject, lateThere }),
    campaign: { id: copy.campaign.id, name: copy.campaign.name },
  }
}

/**
 * The whole late decision for `member`: what she has delivered in the campaign
 * (pieces credited to her) and her status/deliverables, read with `db` (inside
 * her membership lock when it matters). Not a member any more → ok: the write
 * finds no membership and the caller answers that.
 */
async function decideForMember(
  db: Prisma.TransactionClient | typeof prisma,
  campaignId: string,
  campaign: { name: string; type: string; status: string; startDate: Date; endDate: Date | null },
  member: RosterMember,
  postedAt: Date,
  subject: 'post' | 'story'
): Promise<LateDecision> {
  const membership = await db.campaignInfluencer.findUnique({
    where: { campaignId_influencerId: { campaignId, influencerId: member.influencerId } },
    select: { status: true, deliverablesPlanned: true },
  })
  if (!membership) return { ok: true, lateDays: null }
  const delivered = await db.media.count({ where: { campaignId, influencerId: member.influencerId } })
  return decideManualLate(
    {
      campaign,
      member: { status: membership.status, deliverablesPlanned: membership.deliverablesPlanned, delivered, handle: member.username },
      postedAt,
    },
    { subject }
  )
}

async function otherPersonResponse(args: {
  authorHandle: string
  platform: Platform
  member: RosterMember
  personId: string | null
  profileId: string | null
}) {
  const main = args.personId ? await describeMainProfileOfPerson(args.personId, args.profileId) : null
  return NextResponse.json(
    {
      code: 'profile_of_other_person',
      error: `@${args.authorHandle} en ${networkLabel(args.platform)} ya es un perfil de ${main ?? 'otra creadora'}. No puede ser también un perfil de @${args.member.username}.`,
    },
    { status: 409 }
  )
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
    // Agency staff only, checked here and not left to the middleware
    if (!isStaffRole(session.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const actor: Actor = { id: session.id, name: session.name }

    const { id } = await params

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 })
    }

    // ===== Validate input =====
    let rawUrl = typeof body.url === 'string' ? body.url.trim() : ''
    if (!rawUrl) {
      return NextResponse.json({ error: 'Indica la URL del contenido' }, { status: 400 })
    }

    // Short share links (vm.tiktok.com/…, tiktok.com/t/…, instagram.com/share/…)
    // carry no id: they are opened first, and everything below — the duplicate
    // check included — works on the real link.
    if (isShortPostUrl(rawUrl)) {
      const resolved = await resolveShortUrl(rawUrl)
      if (!resolved.ok) {
        return NextResponse.json(
          { error: 'No he podido abrir ese enlace corto. Abre la publicación en el navegador y pega el enlace completo.' },
          { status: 400 }
        )
      }
      rawUrl = resolved.url
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
            'URL no reconocida. Usa el enlace de un post o reel de Instagram (instagram.com/p/… o /reel/…), una story de Instagram (instagram.com/stories/usuario/…), un vídeo de TikTok (tiktok.com/@usuario/video/…) o un vídeo de YouTube (watch?v=… o /shorts/…).',
        },
        { status: 400 }
      )
    }
    const isStory = parsed.isStory === true
    // The network of the PUBLICATION. It is what the row stores and what the
    // duplicate lookup uses: not the network of the member it is credited to.
    const platform: Platform = parsed.platform

    const influencerIdInput = optionalId(body.influencerId)
    const linkProfileTo = optionalId(body.linkProfileTo)
    const confirmUnverified = body.confirmUnverified === true
    /** The author the PM had in front of her when she said whose profile it is ('' = not sent) */
    const confirmedAuthor = typeof body.linkProfileAuthor === 'string' ? normalizeHandle(body.linkProfileAuthor) : ''
    /** ...and the network she was told it is on ('' = not sent) */
    const confirmedPlatform = typeof body.linkProfileAuthorPlatform === 'string' ? body.linkProfileAuthorPlatform.trim().toUpperCase() : ''

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

    // ===== Campaign + roster (members and the other profiles of their persons) =====
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, name: true, type: true, status: true, startDate: true, endDate: true, targetAccounts: true },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // The brand's accounts: never a creator's profile (see the guard below)
    const brandAccounts = (await loadCampaignBrandAccounts([campaign])).get(campaign.id) ?? { targets: [], own: [] }
    /** 'target' = a "Cuenta de Marca Objetivo"; 'own' = the brand's connected Instagram; null = not the brand's */
    const brandAccountKind = (handle: string): 'target' | 'own' | null =>
      isBrandAccount(brandAccounts.targets, handle) ? 'target' : isBrandAccount(brandAccounts.own, handle) ? 'own' : null

    const roster = await loadCampaignRoster(id)
    const memberById = new Map(roster.members.map((m) => [m.influencerId, m]))

    // The members the PM names must be members: nobody joins a campaign here
    const selected = influencerIdInput ? memberById.get(influencerIdInput) ?? null : null
    if (influencerIdInput && !selected) {
      return NextResponse.json(
        { error: 'El creador no está en esta campaña. Añádelo primero.' },
        { status: 400 }
      )
    }
    const linkTarget = linkProfileTo ? memberById.get(linkProfileTo) ?? null : null
    if (linkProfileTo && !linkTarget) {
      return NextResponse.json(
        { error: 'La creadora elegida no está en esta campaña. Añádela primero.' },
        { status: 400 }
      )
    }
    // Whose content the PM says it is: her answer to "whose profile is it?" wins over the form's selector
    const claimed = linkTarget ?? selected

    // ===== Enrich via Apify when available (never blocks the add) =====
    // Never for a story: it has expired or will within 24 h, and the single-post
    // scraper does not read story URLs — a paid call that can only fail.
    let scraped: ScrapedSinglePost | null = null
    if (!isStory && !isApifyExhausted() && (await isApifyConfiguredAsync())) {
      scraped = await scrapeSinglePost(parsed.canonicalUrl)
    }
    const enriched = scraped !== null

    // ===== Author of the publication =====
    // Verified = read from the network by the scraper. Otherwise the @user of
    // the link, which is only a hint (TikTok opens any @user with a valid id).
    const scrapedOwner = scraped?.ownerUsername ? normalizeHandle(scraped.ownerUsername) : ''
    const hintedOwner = parsed.ownerHint ? normalizeHandle(parsed.ownerHint) : ''
    const author: { handle: string; verified: boolean } | null = scrapedOwner
      ? { handle: scrapedOwner, verified: true }
      : hintedOwner
        ? { handle: hintedOwner, verified: false }
        : null

    // ===== Who it counts for (always a member; decided by the roster) =====
    let member: RosterMember | null = null
    /** The profile that published it, when it is not the member's own profile */
    let publisherId: string | null = null
    /** The PM confirmed whose profile the author is: registered right before the row is written */
    let pendingLink: { handle: string; verified: boolean; profileId: string | null } | null = null
    /** The author is nobody's registered profile and the PM has not said whose it is (or has not confirmed it) */
    let askWhoseProfile = false

    if (author) {
      const credit = roster.creditFor(platform, author.handle)
      // A "Cuenta de Marca Objetivo" of this campaign, or the brand's own
      // connected Instagram, is the BRAND's account. It keeps its own content
      // when it is itself a member (the brand added as a creator). Otherwise it
      // is never credited to a creator nor registered as a profile of hers:
      // every publication of the brand would land in her row, here and in every
      // campaign she is in. The only member it may belong to is one that is a
      // brand account of the campaign too.
      const brandKind = brandAccountKind(author.handle)
      if (brandKind && !credit?.self) {
        const goesTo = credit?.member ?? claimed
        if (!goesTo || !brandAccountKind(goesTo.username)) {
          const error = brandKind === 'target'
            ? credit
              ? `@${author.handle} es una Cuenta de Marca Objetivo de esta campaña. Su contenido no se guarda en la fila de @${credit.member.username}.`
              : `@${author.handle} es una Cuenta de Marca Objetivo de esta campaña. No se puede registrar como perfil de una creadora.`
            : credit
              ? `@${author.handle} es la cuenta de la marca de esta campaña. Su contenido no se guarda en la fila de @${credit.member.username}.`
              : `@${author.handle} es la cuenta de la marca de esta campaña. No se puede registrar como perfil de una creadora.`
          return NextResponse.json({ error }, { status: 400 })
        }
      }
      if (credit) {
        member = credit.member
        publisherId = credit.self ? null : credit.publisher.influencerId
        if (claimed && claimed.influencerId !== member.influencerId) {
          // Not a contradiction when the PM picked ANOTHER ROW OF THE SAME
          // CREATOR: a member of the same person, or (legacy double memberships
          // and TikTok twins, which are not linked as one person) her row of
          // another network while the account that published is itself a member
          // (same handle, or the TikTok her Instagram links). The content is then
          // filed under the account that published it, as it always was.
          const samePerson = !!claimed.personId && claimed.personId === member.personId
          const herRowOfAnotherNetwork =
            credit.self &&
            claimed.platform !== platform &&
            (normalizeHandle(claimed.username) === author.handle ||
              (platform === 'TIKTOK' && claimed.platform === 'INSTAGRAM' && tiktokCandidateHandle(claimed).handle === author.handle))
          if (!samePerson && !herRowOfAnotherNetwork) {
            return NextResponse.json(
              {
                error: credit.self
                  ? `Este contenido es de @${author.handle}, no de @${claimed.username}.`
                  : `Este contenido es de @${author.handle}, que es un perfil de @${member.username}, no de @${claimed.username}.`,
                // The creator the form should preselect: the member it counts
                // for, whose handle may differ from the profile that published
                ownerUsername: credit.self ? author.handle : member.username,
              },
              { status: 400 }
            )
          }
        }
      } else if (!PLAUSIBLE_HANDLE.test(author.handle)) {
        // Whatever was read is not a username: never ask to register it as a profile
        return NextResponse.json({ error: UNKNOWN_AUTHOR_ERROR }, { status: 400 })
      } else if (
        linkTarget &&
        (author.verified || confirmUnverified) &&
        (!confirmedAuthor || confirmedAuthor === author.handle) &&
        (!confirmedPlatform || confirmedPlatform === platform)
      ) {
        // Her answer is about the author she was SHOWN (linkProfileAuthor, on
        // linkProfileAuthorPlatform). When the author read now is another one
        // (the scraper answered this time and not before, or the other way
        // round, and the @user of the link is not the real one) or is on
        // another network, nothing is linked: the branch below asks again, with
        // the author of this request. Without those fields (a page loaded before
        // they existed) the answer is taken as before.
        //
        // Only the INTENT is recorded here: the profile and the link are created
        // right before the media row is written, so a request refused below
        // (outside the campaign dates, already filed under someone else) leaves
        // nothing behind.
        const profile = await findInfluencerExact(platform, author.handle)
        if (profile?.personId) {
          // Not a profile of any member (the roster would have credited her): another person's
          return otherPersonResponse({
            authorHandle: author.handle,
            platform,
            member: linkTarget,
            personId: profile.personId,
            profileId: profile.id,
          })
        }
        member = linkTarget
        pendingLink = { handle: author.handle, verified: author.verified, profileId: profile?.id ?? null }
      } else {
        askWhoseProfile = true
      }
    } else {
      // Nobody could be read as the author (an Instagram /p or /reel link with
      // no scrape, a YouTube video): the PM says whose it is, and it can only be
      // filed as published by that member's own profile.
      if (linkTarget && (confirmedAuthor || confirmedPlatform)) {
        // She answered "@x is another profile of hers", and @x cannot be read
        // now: filing it as published by the member herself is not what she
        // confirmed. Nothing is stored; she tries again in a few minutes.
        return NextResponse.json({ error: UNKNOWN_AUTHOR_ERROR }, { status: 400 })
      }
      if (!claimed) {
        return NextResponse.json(
          { error: 'Indica el creador', ownerUsername: null },
          { status: 400 }
        )
      }
      if (claimed.platform !== platform) {
        return NextResponse.json(
          {
            // A YouTube link never carries the user and is never scraped: say what is wrong instead
            error: platform === 'YOUTUBE'
              ? `La URL es de ${networkLabel(platform)} pero @${claimed.username} está registrado en ${networkLabel(claimed.platform)}.`
              : UNKNOWN_AUTHOR_ERROR,
          },
          { status: 400 }
        )
      }
      member = claimed
    }

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
    /** An unattached row (left by a profile analysis) that this request attaches to the campaign */
    const claimsLooseRow = !!existing && existing.campaignId === null

    if (existing && member) {
      // A row already in this campaign belongs to the member it was filed under.
      // An unattached row hangs from whoever published it: it can be claimed
      // when that is the member herself or the profile that published this.
      const knownPublisherId = publisherId ?? pendingLink?.profileId ?? null
      const sameMember = existing.influencerId === member.influencerId
      const samePublisher =
        claimsLooseRow &&
        (existing.publishedByInfluencerId ?? existing.influencerId) === (knownPublisherId ?? member.influencerId)
      if (!sameMember && !samePublisher) {
        return NextResponse.json(
          { error: 'Este contenido ya está registrado para otro creador.' },
          { status: 409 }
        )
      }
    }

    // ===== Build the row =====
    // A story has no likes/comments (only views and reach, typed by the PM)
    const likes = isStory ? (existing?.likes ?? 0) : pickMetric(scraped?.likes, manualLikes, existing?.likes)
    const comments = isStory ? (existing?.comments ?? 0) : pickMetric(scraped?.comments, manualComments, existing?.comments)
    const views = pickMetric(scraped?.views, manualViews, existing?.views)
    const reach: number | undefined = isStory && manualReach !== undefined ? manualReach : undefined

    // The id in the link encodes the exact publication time of a story
    // (snowflake) and of a TikTok video (top 32 bits): it wins over the PM's
    // typed date, which is a guess (hours off in practice, Oct 2026), and makes
    // typing one unnecessary when the scraper is not available. A post keeps
    // the PM's date when Apify did not read one.
    const idDate: Date | null = isStory
      ? (parsed.postedAtHint ?? null)
      : platform === 'TIKTOK'
        ? tiktokIdPostedAt(parsed.externalId)
        : null
    const postedAt: Date | null = scraped?.postedAt
      ? new Date(scraped.postedAt)
      : (idDate ?? manualPostedAt ?? existing?.postedAt ?? null)

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

    // Inside the window as always; AFTER it, a late piece when the campaign
    // allows it (the creator's part is checked once she is known, below).
    // Before the start: refused with the same answer as always.
    const wording = { subject: isStory ? 'story' as const : 'post' as const }
    const window = decideLateWindow({ campaign, postedAt }, wording)
    if (!window.ok) {
      return NextResponse.json(
        window.code === 'before_start'
          ? { error: outsideWindowMessage(campaign, postedAt), postedAt: postedAt.toISOString() }
          : lateRefusalBody(window, postedAt),
        { status: 400 }
      )
    }
    /** Days after the end of the campaign; null = inside the window */
    const lateDays = window.lateDays
    /** A row of this post already in this campaign is refreshed: it is not a new piece */
    const refreshesOwnRow = !!existing && existing.campaignId === id
    // A refresh never turns a piece the campaign holds INSIDE its dates into a
    // late one (a date typed or read after the end): that would skip whether
    // she still owes it. Refused as before the late rule; the stored date stays.
    if (refreshesOwnRow && lateDays !== null && lateDaysOf(existing!.postedAt, campaign.endDate) === null) {
      return NextResponse.json({ error: outsideWindowMessage(campaign, postedAt, wording), postedAt: postedAt.toISOString() }, { status: 400 })
    }
    /** The post, by every key it may be stored under in another campaign */
    const identity: PostIdentity = {
      platform,
      externalIds: [externalId, parsed.externalId],
      permalinks: [parsed.canonicalUrl],
      shortcode: platform === 'INSTAGRAM' && !isStory ? parsed.externalId : null,
    }

    if (lateDays !== null && !refreshesOwnRow) {
      // A late piece counts in ONE campaign: not here when the post already has a row in another
      const elsewhere = await findPostCopiesInOtherCampaigns(identity, id)
      if (elsewhere.length > 0) return NextResponse.json(countedElsewhereBody(elsewhere[0], wording.subject), { status: 409 })
      // Her part (does she still owe a piece?), before anything is linked. Checked
      // again, authoritatively, inside her membership lock when the row is written.
      if (member && !askWhoseProfile) {
        const decision = await decideForMember(prisma, id, campaign, member, postedAt, wording.subject)
        if (!decision.ok) return NextResponse.json(lateRefusalBody(decision, postedAt), { status: 400 })
      }
    } else if (!refreshesOwnRow) {
      // Inside the window as always, unless the post already counts LATE in another
      // campaign: a late piece counts in one campaign only (the other way round of
      // the check above; the automatic capture skips it the same way)
      const lateThere = await findLateCopyElsewhere(identity, id)
      if (lateThere) return NextResponse.json(countedElsewhereBody(lateThere, wording.subject, true), { status: 409 })
    }

    // ===== The author is nobody's registered profile: ask, create nothing =====
    // Asked last, once the content itself is acceptable, so the PM's answer
    // leads straight to the publication being stored. A non-member stays
    // refused: this answer creates and links nothing.
    if (askWhoseProfile || !member) {
      if (!author) {
        return NextResponse.json({ error: UNKNOWN_AUTHOR_ERROR }, { status: 400 })
      }
      return NextResponse.json(
        {
          code: 'profile_not_linked',
          error: `Este contenido es de @${author.handle} en ${networkLabel(platform)}, que no está registrado como perfil de ninguna creadora de esta campaña.`,
          author: { handle: author.handle, platform, verified: author.verified },
          suggestions: suggestMembers(roster, platform, author.handle, claimed),
        },
        { status: 409 }
      )
    }

    // ===== Every check has passed: register the author as a profile of the member =====
    // No membership is created: the profile joins the member's person and the
    // publication is credited to the member.
    let linkedProfile: { handle: string; platform: Platform; memberUsername: string } | null = null
    if (pendingLink) {
      let profile: Awaited<ReturnType<typeof findOrCreateInfluencerExact>> | null = null
      try {
        profile = await findOrCreateInfluencerExact(platform, pendingLink.handle, actor)
        await linkProfile({
          memberInfluencerId: member.influencerId,
          profileInfluencerId: profile.id,
          actor,
          evidence: pendingLink.verified ? 'pm_confirmed' : 'pm_confirmed_unverified',
        })
      } catch (err) {
        if (!(err instanceof PersonLinkError)) throw err
        if (err.code === 'profile_has_other_person') {
          // Someone linked it to another person between the check above and now
          return otherPersonResponse({
            authorHandle: pendingLink.handle,
            platform,
            member,
            personId: err.personId,
            profileId: profile?.id ?? null,
          })
        }
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      publisherId = profile.id
      linkedProfile = { handle: profile.username, platform, memberUsername: member.username }
    }

    const include = {
      influencer: {
        select: { id: true, username: true, displayName: true, avatarUrl: true, platform: true },
      },
      publishedBy: {
        select: { id: true, username: true, platform: true },
      },
    }

    /** A new late piece: her part and the exclusivity are checked again inside her (exclusive) membership lock */
    const checksLate = lateDays !== null && !refreshesOwnRow

    /**
     * The row, written for `credited` (published by `publishedBy`) only while
     * she is a member of the campaign: withCampaignMembership holds her
     * membership until the write is done. null = she is not a member any more.
     * A late piece that is no longer acceptable throws LateRefused (nothing written).
     */
    const writeRow = (credited: RosterMember, publishedBy: string | null) =>
      withCampaignMembership(id, credited.influencerId, async db => {
        if (!refreshesOwnRow) {
          // One campaign only for a late piece: two adds of this post to two
          // campaigns at once wait for each other here, so the second one sees
          // the row of the first (checked again below, inside this lock)
          await lockPostForCampaignChoice(db, platform, parsed.externalId)
        }
        if (checksLate) {
          const elsewhere = await findPostCopiesInOtherCampaigns(identity, id, db)
          if (elsewhere.length > 0) throw new LateRefused(409, countedElsewhereBody(elsewhere[0], wording.subject))
          const decision = await decideForMember(db, id, campaign, credited, postedAt, wording.subject)
          if (!decision.ok) throw new LateRefused(400, lateRefusalBody(decision, postedAt))
        } else if (!refreshesOwnRow) {
          const lateThere = await findLateCopyElsewhere(identity, id, db)
          if (lateThere) throw new LateRefused(409, countedElsewhereBody(lateThere, wording.subject, true))
        }
        if (existing) {
          // An unattached row is credited to the member and remembers who published
          // it. A row already in the campaign keeps the member it has; who PUBLISHED
          // it is filled in when it was not known (the row was stored while the
          // network could not say) and corrected when the network now says
          // otherwise. Without it the piece would keep counting as published from
          // the member's own profile ("vs su habitual", estimates by her followers).
          const credit = claimsLooseRow
            ? { influencerId: credited.influencerId, publishedByInfluencerId: publishedBy }
            : existing.influencerId === credited.influencerId &&
                existing.publishedByInfluencerId !== publishedBy &&
                (author?.verified === true || existing.publishedByInfluencerId === null)
              ? { publishedByInfluencerId: publishedBy }
              : {}
          return db.media.update({
            where: { id: existing.id },
            data: {
              campaignId: id,
              ...credit,
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
              // Graph API row (real reach/impressions) to 'manual'. A LATE piece
              // is the exception: only a hand-added row is kept after the end
              // (keepsLateHandAddedRow), so a Meta row claimed late becomes
              // 'manual' (it keeps its Meta figures; only its origin badge changes)
              ...((existing.source !== 'meta_api' || checksLate) && { source: 'manual' }),
            },
            include,
          })
        }
        return db.media.create({
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
            influencerId: credited.influencerId,
            publishedByInfluencerId: publishedBy,
            campaignId: id,
          },
          include,
        })
      }, { exclusive: checksLate })

    let media
    try {
      media = await writeRow(member, publisherId)
      if (media === null) {
        // She stopped being a member while the link was read (the scraper can
        // take 20 s): her TikTok row folded into her own row
        // (src/lib/person-fold.ts), for instance. The piece is credited where
        // the roster says NOW, never under a profile that is not a member.
        const now = (await loadCampaignRoster(id)).creditForInfluencer(publisherId ?? member.influencerId)
        if (now) {
          member = now.member
          publisherId = now.self ? null : now.publisher.influencerId
          media = await writeRow(member, publisherId)
        }
      }
    } catch (err) {
      // A late piece that stopped being acceptable while it was read (another late
      // piece of hers, or of this post in another campaign, was stored meanwhile)
      if (err instanceof LateRefused) return NextResponse.json(err.body, { status: err.status })
      // Concurrent add of the same post → unique (externalId, platform, campaignId) violation
      if ((err as { code?: string })?.code === 'P2002') {
        return NextResponse.json(
          { error: 'Este contenido ya está registrado.' },
          { status: 409 }
        )
      }
      throw err
    }
    if (media === null) {
      return NextResponse.json(
        { error: `@${member.username} ya no está en esta campaña. Recarga la página y vuelve a pegar el enlace.` },
        { status: 409 }
      )
    }
    if (linkedProfile) linkedProfile = { ...linkedProfile, memberUsername: member.username }

    // New in the campaign: a row created now, or an unattached one this request attached
    const created = !existing || claimsLooseRow
    // lateDays: days after the end of the campaign (team only), null inside the window
    return NextResponse.json(
      { media, enriched, created, isStory, linkedProfile, lateDays },
      { status: created ? 201 : 200 }
    )
  } catch (error) {
    console.error('Manual media add error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
