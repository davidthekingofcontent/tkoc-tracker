/**
 * explain_missing_post: why is this publication in the campaign, or why is it
 * not? A read-only diagnosis. It NEVER reads the network: no scrape, no call
 * to Instagram, TikTok or YouTube. It works with three things only: what the
 * link itself says (src/lib/post-url.ts, src/lib/story-url.ts), what the
 * platform already stored, and the capture rules of src/lib/campaign-capture.ts
 * (the same functions the capture uses, so the diagnosis cannot disagree with
 * it). Everything that would need the network is listed as not determined.
 *
 * The rules, as the capture applies them. A publication belongs to a campaign
 * only if (1) its author is a member, (2) it is dated inside the campaign
 * dates and (3) it references the brand (a brand account, a brand hashtag or
 * a product keyword). A piece added by hand is exempt from (3), and from (2)
 * only as a late piece («fuera de plazo», src/lib/assignment-rules.ts): up to
 * 30 days after the end, for a member who still owed a piece.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import {
  STORY_SCAN_STATUSES,
  campaignHasTargets,
  isWithinCampaignDates,
  itemReferencesBrand,
  storiesCampaignSkipReason,
} from '@/lib/campaign-capture'
import { LATE_ACCEPT_MAX_DAYS, keepsLateHandAddedRow, lateDaysOf } from '@/lib/assignment-rules'
import { parsePostUrl } from '@/lib/post-url'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import type { Prisma } from '@/generated/prisma/client'
import { brandNamesByCampaign } from './brands'
import { serializeBrandTargets, serializeCampaign, serializeMediaRecord } from './serializers'
import { ToolError, defineTool, idInput, isoDay, isoInstant, shortText } from './shared'

// ============ The link ============

export interface PostTarget {
  platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'
  /** Id carried by the link: Instagram shortcode or story id, TikTok or YouTube video id. */
  externalId: string
  mediaType: string
  canonicalUrl: string
  permalinkNeedle: string
  /** Handle written in the link, when the network puts one there. A hint, not proof of authorship. */
  ownerHint: string | null
  isStory: boolean
  /** Publication time decoded from an Instagram story id. null for everything else. */
  postedAtHint: Date | null
}

export type ParsedLink = { kind: 'publication'; target: PostTarget } | { kind: 'highlight' } | { kind: 'unrecognised' }

/** What a pasted link is, using the platform's own parsers. Pure. */
export function parseLink(url: string): ParsedLink {
  const story = parseInstagramStoryUrl(url)
  if (story?.isHighlight) return { kind: 'highlight' }
  if (story) {
    return {
      kind: 'publication',
      target: {
        platform: 'INSTAGRAM',
        externalId: story.storyId,
        mediaType: 'STORY',
        canonicalUrl: story.canonicalUrl,
        permalinkNeedle: `/${story.storyId}`,
        ownerHint: story.username || null,
        isStory: true,
        postedAtHint: story.postedAtHint,
      },
    }
  }
  const post = parsePostUrl(url)
  if (!post) return { kind: 'unrecognised' }
  return {
    kind: 'publication',
    target: {
      platform: post.platform,
      externalId: post.externalId,
      mediaType: post.mediaType,
      canonicalUrl: post.canonicalUrl,
      permalinkNeedle: post.permalinkNeedle,
      ownerHint: post.ownerHint,
      isStory: false,
      postedAtHint: null,
    },
  }
}

/**
 * Is this stored row the publication of the link? The capture stores the
 * network's numeric id while a link carries the shortcode, so the permalink
 * is compared as well, with the same parsers. Pure.
 */
export function isSamePublication(target: PostTarget, row: { externalId: string | null; permalink: string | null }): boolean {
  const id = target.externalId
  if (row.externalId === id) return true
  if (target.isStory) {
    // Scraped stories are stored as `<storyId>_<ownerId>`
    if (row.externalId && row.externalId.startsWith(`${id}_`)) return true
    return !!row.permalink && parseInstagramStoryUrl(row.permalink)?.storyId === id
  }
  if (!row.permalink) return false
  const parsed = parsePostUrl(row.permalink)
  return !!parsed && parsed.platform === target.platform && parsed.externalId === id
}

// ============ The diagnosis (pure) ============

/** Creators whose profile the daily job reads for new posts (src/app/api/cron/check-posts/route.ts). */
export const POST_CHECK_STATUSES = ['AGREED', 'CONTRACTED', 'POSTED', 'COMPLETED']

export type CheckResult = 'pass' | 'fail' | 'unknown' | 'not_applicable'
export interface Check {
  rule: string
  /**
   * `belongs`: one of the three rules that decide whether a publication is
   * part of the campaign (a re-validation detaches a piece that fails one).
   * `capture`: a condition for the automatic jobs to read it at all. A piece
   * added by hand does not depend on these.
   */
  decides: 'belongs' | 'capture'
  result: CheckResult
  explanation: string
}

export interface DiagnosisCampaign {
  id: string
  name: string
  status: string
  type: string
  platforms: string[]
  startDate: Date
  endDate: Date | null
  targetAccounts: string[]
  targetHashtags: string[]
  targetKeywords: string[]
}

export interface DiagnosisRecord {
  id: string
  campaignId: string | null
  externalId: string | null
  mediaType: string
  postedAt: Date | null
  source: string
  isDeleted: boolean
  caption: string | null
  hashtags: string[]
  mentions: string[]
  influencerId: string
  influencer: { username: string } | null
  campaign: { id: string; name: string } | null
}

export interface DiagnosisMember {
  influencerId: string
  status: string
  username: string
  platform: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const RECORDS_SHOWN = 10

function windowText(c: DiagnosisCampaign): string {
  return `${isoDay(c.startDate)} to ${c.endDate ? `${isoDay(c.endDate)} (that whole day included)` : 'no end date'}`
}

/**
 * The diagnosis itself. Pure: the caller loads the campaign, its members and
 * the stored rows that are this publication. The answer never contains a
 * caption, only what was concluded from it.
 */
export function diagnosePost(input: {
  link: ParsedLink
  campaign: DiagnosisCampaign
  brand: string | null
  creators: number
  pieces: number
  records: DiagnosisRecord[]
  members: DiagnosisMember[]
  now: Date
}) {
  const { link, campaign, records, members, now } = input
  const campaignView = {
    ...serializeCampaign(campaign, { brand: input.brand, creators: input.creators, pieces: input.pieces }),
    brandTargets: serializeBrandTargets(campaign),
  }

  if (link.kind !== 'publication') {
    const explanation =
      link.kind === 'highlight'
        ? 'The link is an Instagram highlight. A highlight has no publication date, so it cannot be placed inside the campaign dates: the original story is what counts.'
        : 'The link is not a publication the platform recognises. It accepts: an Instagram post or reel (instagram.com/p/… or /reel/…), an Instagram story (instagram.com/stories/user/id), a TikTok video or photo (tiktok.com/@user/video/id) and a YouTube video or short. Shortened links (vm.tiktok.com, tiktok.com/t/…) carry no id and are not accepted.'
    const none: ReturnType<typeof serializeMediaRecord>[] = []
    return {
      link: { recognised: false },
      campaign: campaignView,
      inThisCampaign: false,
      platformRecords: { inThisCampaign: none, inOtherCampaigns: none, notInAnyCampaign: none },
      author: { handle: null, knownFrom: null, isMember: null, statusInCampaign: null },
      checks: [{ rule: 'link', decides: 'belongs', result: 'fail', explanation }] satisfies Check[],
      conclusion: explanation,
      notDeterminedWithoutReadingTheNetwork: [
        'Which publication the link points to. Ask for the full link opened in a browser.',
      ],
    }
  }

  const target = link.target
  const here = records.filter(r => r.campaignId === campaign.id)
  const elsewhere = records.filter(r => r.campaignId !== null && r.campaignId !== campaign.id)
  const unattached = records.filter(r => r.campaignId === null)
  const known = here[0] ?? unattached[0] ?? elsewhere[0] ?? null
  const checks: Check[] = []
  const notDetermined: string[] = []

  // ----- The campaign itself -----
  checks.push(
    campaign.status === 'ACTIVE'
      ? { rule: 'campaign_active', decides: 'capture', result: 'pass', explanation: 'The campaign is ACTIVE: the automatic capture jobs include it.' }
      : {
          rule: 'campaign_active',
          decides: 'capture',
          result: 'fail',
          explanation: `The campaign is ${campaign.status}. The automatic capture jobs only read ACTIVE campaigns, so nothing new enters by itself. A person can still add the piece by hand.`,
        },
  )
  const hasTargets = campaignHasTargets(campaign)
  checks.push(
    hasTargets
      ? { rule: 'brand_targets', decides: 'capture', result: 'pass', explanation: 'The campaign has brand targets (accounts, hashtags or product keywords).' }
      : {
          rule: 'brand_targets',
          decides: 'capture',
          result: 'fail',
          explanation: 'The campaign has no brand accounts, no hashtags and no product keywords. Without them the automatic capture collects nothing for it: only pieces added by hand enter.',
        },
  )

  // ----- Rule 1: the author is a member -----
  const handle = known?.influencer?.username ?? target.ownerHint
  const handleFrom = known?.influencer ? 'platform_record' : target.ownerHint ? 'link' : null
  const member = known
    ? (members.find(m => m.influencerId === known.influencerId) ?? null)
    : handle
      ? (members.find(m => m.platform === target.platform && same(m.username, handle)) ?? null)
      : null
  const otherNetworks = handle ? members.filter(m => m.platform !== target.platform && same(m.username, handle)) : []
  if (!handle) {
    checks.push({
      rule: 'membership',
      decides: 'belongs',
      result: 'unknown',
      explanation: 'The link does not say who published it and the platform has no record of this publication, so it cannot be checked whether the author is a member of the campaign.',
    })
    notDetermined.push('Who the author is. The link carries no handle.')
  } else if (member) {
    checks.push({
      rule: 'membership',
      decides: 'belongs',
      result: 'pass',
      explanation:
        `@${handle} is a member of the campaign on ${member.platform}, in status ${member.status}.` +
        (handleFrom === 'link' ? ' The handle was taken from the link, which is a hint and not proof of who published it.' : ''),
    })
    if (handleFrom === 'link') notDetermined.push('That the publication really belongs to the handle written in the link.')
  } else {
    checks.push({
      rule: 'membership',
      decides: 'belongs',
      result: 'fail',
      explanation:
        `@${handle} is not a member of this campaign on ${target.platform}. Only publications of members are kept.` +
        (otherNetworks.length > 0
          ? ` The same handle is a member on ${otherNetworks.map(m => m.platform).join(', ')}: each network is a separate account, so the ${target.platform} account has to be added to the campaign.`
          : '') +
        (target.platform === 'TIKTOK'
          ? ' The tiktok-link job adds the TikTok account of a confirmed Instagram member by itself (the user linked in the Instagram bio, or the same username) when the campaign lists TikTok among its networks and one of the videos, dated inside the campaign, references the brand.' +
            (campaign.platforms.includes('TIKTOK') ? '' : ' This campaign does not list TikTok among its networks, so that job does not run for it.')
          : ''),
    })
    if (handleFrom === 'link') notDetermined.push('That the publication really belongs to the handle written in the link.')
  }

  // ----- The status of the member decides whether the jobs read that account -----
  if (member) {
    if (target.isStory) {
      const scanned = (STORY_SCAN_STATUSES as readonly string[]).includes(member.status)
      checks.push({
        rule: 'creator_status',
        decides: 'capture',
        result: scanned ? 'pass' : 'fail',
        explanation: scanned
          ? `Stories are scanned for creators in ${STORY_SCAN_STATUSES.join(', ')}. This creator is in ${member.status}.`
          : `Stories are only scanned for creators in ${STORY_SCAN_STATUSES.join(', ')}. This creator is in ${member.status}, so the stories of this account are not read. A person can register the story by hand.`,
      })
    } else {
      const read = POST_CHECK_STATUSES.includes(member.status)
      checks.push({
        rule: 'creator_status',
        decides: 'capture',
        result: read ? 'pass' : 'fail',
        explanation: read
          ? `The daily job reads the new posts of creators in ${POST_CHECK_STATUSES.join(', ')}. This creator is in ${member.status}.`
          : `The daily job only reads the new posts of creators in ${POST_CHECK_STATUSES.join(', ')}. This creator is in ${member.status}, so the profile is not read every day. A person can run the tracking from the campaign page or add the piece by hand.`,
      })
    }
  }

  // ----- Rule 2: dated inside the campaign -----
  const postedAt = known?.postedAt ?? target.postedAtHint
  const dateFrom = known?.postedAt ? 'the platform record' : 'the story id in the link'
  if (!postedAt) {
    checks.push({
      rule: 'dates',
      decides: 'belongs',
      result: 'unknown',
      explanation: `The publication date is not known. It must fall inside the campaign dates, ${windowText(campaign)}. A piece without a date is never kept.`,
    })
    notDetermined.push('When it was published.')
  } else if (isWithinCampaignDates(campaign, postedAt)) {
    checks.push({
      rule: 'dates',
      decides: 'belongs',
      result: 'pass',
      explanation: `Published on ${isoInstant(postedAt)} (from ${dateFrom}), inside the campaign dates, ${windowText(campaign)}.`,
    })
  } else {
    // After the end: a piece added by hand may count as a LATE piece (src/lib/assignment-rules.ts)
    const lateDays = lateDaysOf(postedAt, campaign.endDate)
    const keptLate = !!known && here.length > 0 && keepsLateHandAddedRow(campaign, known)
    if (keptLate) {
      checks.push({
        rule: 'dates',
        decides: 'belongs',
        result: 'pass',
        explanation: `Published on ${isoInstant(postedAt)} (from ${dateFrom}), ${lateDays} day${lateDays === 1 ? '' : 's'} after the end of the campaign, ${windowText(campaign)}. It was added by hand as a late piece («fuera de plazo», shown to the team only): it is kept.`,
      })
    } else {
      const late = lateDays === null
        ? 'Publications before the start never count, also when added by hand.'
        : campaign.type === 'SOCIAL_LISTENING'
          ? 'A Social Listening campaign only counts what is published inside its dates, also when added by hand.'
          : lateDays > LATE_ACCEPT_MAX_DAYS
            ? `It is ${lateDays} days late: more than ${LATE_ACCEPT_MAX_DAYS} days after the end it never counts.`
            : `It is ${lateDays} day${lateDays === 1 ? '' : 's'} late. The automatic capture never keeps it. A person can add it by hand as a late piece («fuera de plazo», team only) while the campaign is ACTIVE and its creator is a member who still owes a piece (Agreed to Posted, below her number of deliverables, or with none yet without a number), up to ${LATE_ACCEPT_MAX_DAYS} days after the end; it then counts in this campaign only, never in another one as well.`
      checks.push({
        rule: 'dates',
        decides: 'belongs',
        result: 'fail',
        explanation: `Published on ${isoInstant(postedAt)} (from ${dateFrom}), outside the campaign dates, ${windowText(campaign)}. ${late}`,
      })
    }
  }

  // ----- Rule 3: it references the brand -----
  const exempt = (r: DiagnosisRecord) => r.source === 'manual' || (r.mediaType === 'STORY' && !r.externalId)
  if (known && here.length > 0 && exempt(known)) {
    checks.push({
      rule: 'brand_reference',
      decides: 'belongs',
      result: 'not_applicable',
      explanation: 'The piece was added to this campaign by hand: the brand-reference rule does not apply to it.',
    })
  } else if (known) {
    const references = itemReferencesBrand(campaign, { caption: known.caption, hashtags: known.hashtags, mentions: known.mentions })
    checks.push({
      rule: 'brand_reference',
      decides: 'belongs',
      result: references ? 'pass' : 'fail',
      explanation: references
        ? 'The text the platform stored for this publication (caption, mentions, hashtags) references the brand targets of the campaign.'
        : 'The text the platform stored for this publication (caption, mentions, hashtags) does not reference any brand account, hashtag or product keyword of the campaign, so the automatic capture rejects it. A person can add it by hand: pieces added by hand are exempt from this rule.',
    })
  } else {
    checks.push({
      rule: 'brand_reference',
      decides: 'belongs',
      result: 'unknown',
      explanation: 'The platform has no record of this publication, so its caption, mentions and hashtags are not known. To be captured by itself it must mention a brand account, use a brand hashtag or contain a product keyword.',
    })
    notDetermined.push(
      target.isStory
        ? 'Whether the story carries a mention or hashtag sticker of the brand, a link to the brand site, or a shared campaign post.'
        : 'Whether its caption, mentions or hashtags reference the brand.',
    )
  }

  // ----- Stories: is the campaign scanned at all -----
  if (target.isStory) {
    const reason = storiesCampaignSkipReason(campaign, postedAt ?? now)
    const when = postedAt ? 'on the day of the story' : 'today'
    const why: Record<string, string> = {
      window: 'The campaign dates do not include that day.',
      listening: 'It is a Social Listening campaign: stories are only scanned in influencer tracking and UGC campaigns.',
      no_targets: 'The campaign has no brand targets.',
      too_long: 'The campaign is too long for the stories scan, or it has no end date.',
    }
    checks.push(
      reason === null
        ? { rule: 'stories_scan', decides: 'capture', result: 'pass', explanation: `The campaign qualifies for the stories scan ${when}.` }
        : { rule: 'stories_scan', decides: 'capture', result: 'fail', explanation: `The stories scan leaves this campaign out ${when}. ${why[reason] ?? ''}`.trim() },
    )
    notDetermined.push('Whether the story was still online when the scan ran. Stories expire after 24 hours and a story that was not read in time cannot be recovered: it has to be registered by hand with the figures of the creator.')
  } else if (!known) {
    notDetermined.push('Whether the publication was among the recent posts the daily job read from the profile of its author. Older posts are not read again.')
  }
  if (!known) notDetermined.push('Whether the publication still exists and is public. See capture_status for the state of the automatic capture.')

  // ----- Conclusion -----
  const names = (list: Check[]) => list.map(c => c.rule).join(', ')
  const brokenRules = checks.filter(c => c.decides === 'belongs' && c.result === 'fail')
  const notRead = checks.filter(c => c.decides === 'capture' && c.result === 'fail')
  const unknown = checks.filter(c => c.result === 'unknown')
  let conclusion: string
  if (here.length > 0) {
    conclusion =
      `The publication IS in this campaign (piece ${here[0].id}, captured by ${here[0].source}).` +
      (here[0].isDeleted ? ' The creator deleted it afterwards: it stays in the totals, marked as deleted.' : '') +
      (brokenRules.length > 0
        ? ` Note: with the current rules it no longer qualifies (${names(brokenRules)}), so a re-validation of the campaign would detach it.`
        : '')
  } else if (brokenRules.length + notRead.length + unknown.length === 0) {
    conclusion =
      'The publication is NOT in this campaign although every check passes. The most likely cause is that the capture has not read it yet, or could not: see capture_status. A person can add it by hand from the campaign page.'
  } else {
    conclusion =
      'The publication is NOT in this campaign.' +
      (brokenRules.length > 0 ? ` It does not meet: ${names(brokenRules)}.` : '') +
      (notRead.length > 0 ? ` The automatic capture does not read it: ${names(notRead)}.` : '') +
      (unknown.length > 0 ? ` Could not be checked without reading the network: ${names(unknown)}.` : '') +
      (brokenRules.length === 0 && unknown.length > 0 ? ' No rule that can be checked rejects it.' : '')
  }
  if (here.length === 0 && elsewhere.length > 0) {
    conclusion += ` The platform does have it in ${elsewhere.length === 1 ? 'another campaign' : `${elsewhere.length} other campaigns`}: a publication counts in every campaign whose rules it satisfies.`
  }
  if (here.length === 0 && unattached.length > 0) {
    conclusion += ' The platform has a copy that is not attached to any campaign (read from a profile, or detached by a re-validation).'
  }

  return {
    link: {
      recognised: true,
      network: target.platform,
      type: target.mediaType,
      publicationId: target.externalId,
      canonicalUrl: target.canonicalUrl,
      handleInLink: shortText(target.ownerHint, 80),
      publishedAtFromLink: isoInstant(target.postedAtHint),
    },
    campaign: campaignView,
    inThisCampaign: here.length > 0,
    platformRecords: {
      inThisCampaign: here.slice(0, RECORDS_SHOWN).map(serializeMediaRecord),
      inOtherCampaigns: elsewhere.slice(0, RECORDS_SHOWN).map(serializeMediaRecord),
      notInAnyCampaign: unattached.slice(0, RECORDS_SHOWN).map(serializeMediaRecord),
    },
    author: {
      handle: shortText(handle, 80),
      knownFrom: handleFrom,
      isMember: handle ? member !== null : null,
      statusInCampaign: member?.status ?? null,
    },
    checks,
    conclusion,
    notDeterminedWithoutReadingTheNetwork: notDetermined,
  }
}

// ============ The tool ============

const RECORDS_READ = 50

export const explainMissingPost = defineTool({
  name: 'explain_missing_post',
  title: 'Explicar por qué falta una publicación',
  description:
    'Explains why a publication is, or is not, in a campaign. Give the campaign id and the full link of the ' +
    'publication (Instagram post, reel or story, TikTok video, YouTube video or short). It does NOT read the network ' +
    'and changes nothing: it uses the link itself, what the platform already stored and the capture rules. ' +
    'It answers whether a record of that publication exists (in this campaign, in another one, or in none), whether ' +
    'the handle in the link is a member and in which status, the campaign dates, and a list of checks, each with ' +
    'pass, fail or unknown and a short explanation. Checks marked decides: belongs are the three rules a publication ' +
    'must meet to be part of a campaign (membership, dates, brand reference). Checks marked decides: capture say ' +
    'whether the automatic jobs would read it at all (campaign active, brand targets, creator status, stories scan); ' +
    'a piece added by hand does not depend on those. It also lists what could not be determined without reading ' +
    'the network. ' +
    'Shortened links are not accepted. Use capture_status as well when nothing is coming in at all.',
  input: {
    campaignId: idInput('The campaign id, as returned by list_campaigns.'),
    url: z.string().trim().min(8).max(500).describe('The full link of the publication, as copied from the network.'),
  },
  summarize: args => {
    const link = parseLink(args.url)
    return {
      campaignId: args.campaignId,
      link: link.kind === 'publication' ? `${link.target.platform}:${link.target.mediaType}:${link.target.externalId}` : link.kind,
      handle: link.kind === 'publication' && link.target.ownerHint ? `@${link.target.ownerHint}` : undefined,
    }
  },
  async run(args) {
    const campaign = await prisma.campaign.findUnique({
      where: { id: args.campaignId },
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        platforms: true,
        startDate: true,
        endDate: true,
        targetAccounts: true,
        targetHashtags: true,
        targetKeywords: true,
        _count: { select: { influencers: true, media: true } },
      },
    })
    if (!campaign) throw new ToolError('Campaign not found. Use list_campaigns to get the id of a campaign.')

    const link = parseLink(args.url)
    const [brands, memberRows, records] = await Promise.all([
      brandNamesByCampaign([campaign.id]),
      link.kind === 'publication'
        ? prisma.campaignInfluencer.findMany({
            where: { campaignId: campaign.id },
            select: { influencerId: true, status: true, influencer: { select: { username: true, platform: true } } },
          })
        : Promise.resolve([]),
      link.kind === 'publication' ? findRecords(link.target) : Promise.resolve([]),
    ])

    return diagnosePost({
      link,
      campaign,
      brand: brands.get(campaign.id) ?? null,
      creators: campaign._count.influencers,
      pieces: campaign._count.media,
      records,
      members: memberRows.map(m => ({
        influencerId: m.influencerId,
        status: m.status,
        username: m.influencer.username,
        platform: m.influencer.platform,
      })),
      now: new Date(),
    })
  },
})

/** The stored rows that are the publication of the link, in any campaign or in none. */
async function findRecords(target: PostTarget): Promise<DiagnosisRecord[]> {
  const or: Prisma.MediaWhereInput[] = [
    { externalId: target.externalId },
    // A pattern match that can only widen the search: isSamePublication decides
    { permalink: { contains: target.permalinkNeedle } },
  ]
  if (target.isStory) or.push({ externalId: { startsWith: `${target.externalId}_` } })
  const rows = await prisma.media.findMany({
    where: { platform: target.platform, OR: or },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: RECORDS_READ,
    select: {
      id: true,
      campaignId: true,
      externalId: true,
      permalink: true,
      mediaType: true,
      postedAt: true,
      source: true,
      isDeleted: true,
      caption: true,
      hashtags: true,
      mentions: true,
      influencerId: true,
      influencer: { select: { username: true } },
      campaign: { select: { id: true, name: true } },
    },
  })
  return rows.filter(r => isSamePublication(target, r))
}
