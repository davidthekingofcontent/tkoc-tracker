/**
 * The four campaign tools of the MCP connector: list_campaigns, get_campaign,
 * list_campaign_creators and list_campaign_media. All read-only.
 *
 * Every figure of a campaign comes from computeCampaignOverview
 * (src/lib/campaign-overview.ts), the same computation the platform's screens,
 * the report and the exports use, so a number read through Claude is the
 * number on the screen. The overview is passed through stripEconomics before
 * its public figures are serialized; fees, costs and estimates are only added
 * when the caller asked with `includeEconomics: true`.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { escapeForInsensitiveEquals } from '@/lib/auth'
import { computeCampaignOverview, stripEconomics } from '@/lib/campaign-overview'
import type { Prisma } from '@/generated/prisma/client'
import { brandNamesByCampaign } from './brands'
import {
  INTERNAL_NOTICE,
  serializeBrandTargets,
  serializeCampaign,
  serializeCampaignCreator,
  serializeCampaignCreatorEconomics,
  serializeCampaignEconomics,
  serializeCampaignResults,
  serializeMedia,
} from './serializers'
import {
  ToolError,
  clampLimit,
  cleanHandle,
  dayAfter,
  dayInput,
  defineTool,
  economicsInput,
  idInput,
  limitInput,
  listEnvelope,
  parseDay,
  shortText,
  summarizeHandleArg,
} from './shared'

const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
const MEDIA_TYPES = ['POST', 'REEL', 'STORY', 'VIDEO', 'SHORT', 'CAROUSEL'] as const

const CAMPAIGN_NOT_FOUND = 'Campaign not found. Use list_campaigns to get the id of a campaign.'

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  status: true,
  type: true,
  platforms: true,
  startDate: true,
  endDate: true,
  _count: { select: { influencers: true, media: true } },
} as const

// ============ list_campaigns ============

export const listCampaigns = defineTool({
  name: 'list_campaigns',
  title: 'Listar campañas',
  description:
    'Lists the campaigns of the agency on TKOC Intelligence, pinned first and then the most recently updated. ' +
    'Each row has the campaign id, name, brand (the client), status (ACTIVE, PAUSED or ARCHIVED), type ' +
    '(INFLUENCER_TRACKING, UGC or SOCIAL_LISTENING), networks, start and end dates (UTC days) and the number of ' +
    'creators and of publications. Use it first to find the id that the other campaign tools need. ' +
    'No results or money figures here: use get_campaign for those. Capped at 200 rows; the answer says when it was cut.',
  input: {
    status: z.enum(CAMPAIGN_STATUSES).optional().describe('Only campaigns in this status. Leave out for all of them.'),
    limit: limitInput,
  },
  summarize: args => ({ status: args.status, limit: args.limit }),
  async run(args) {
    const limit = clampLimit(args.limit)
    const where: Prisma.CampaignWhereInput = args.status ? { status: args.status } : {}
    const [rows, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
        select: CAMPAIGN_SELECT,
      }),
      prisma.campaign.count({ where }),
    ])
    const brands = await brandNamesByCampaign(rows.map(r => r.id))
    const items = rows.map(r =>
      serializeCampaign(r, { brand: brands.get(r.id) ?? null, creators: r._count.influencers, pieces: r._count.media }),
    )
    return {
      status: args.status ?? 'all',
      campaigns: listEnvelope(items, total, limit, 'Filter by status or raise limit (at most 200).'),
    }
  },
})

// ============ get_campaign ============

export const getCampaign = defineTool({
  name: 'get_campaign',
  title: 'Ver una campaña',
  description:
    'Returns one campaign with the same figures the platform shows on its screens: totals (publications, posts, ' +
    'stories, views, likes, comments, shares, saves, interactions, real reach), the engagement rate (interactions ' +
    'divided by real views; null with a reason when the sample is too small), the numeric objectives against what ' +
    'was achieved, the delivery checklist (creators, pieces, dates, ad disclosure) and the brand targets that decide ' +
    'which publications count (brand accounts, hashtags, product keywords). ' +
    'By default it returns NO money and NO estimates. With includeEconomics: true it adds an internalEconomics block ' +
    '(budget, cost, CPM, EMV, estimated audience, results reported by the client), which is internal to the agency. ' +
    'For the per-creator breakdown use list_campaign_creators; for the publications use list_campaign_media.',
  input: {
    campaignId: idInput('The campaign id, as returned by list_campaigns.'),
    includeEconomics: economicsInput,
  },
  summarize: args => ({ campaignId: args.campaignId, includeEconomics: args.includeEconomics === true }),
  async run(args) {
    const withEconomics = args.includeEconomics === true
    const campaign = await prisma.campaign.findUnique({
      where: { id: args.campaignId },
      select: { ...CAMPAIGN_SELECT, targetAccounts: true, targetHashtags: true, targetKeywords: true },
    })
    if (!campaign) throw new ToolError(CAMPAIGN_NOT_FOUND)
    const [overview, brands] = await Promise.all([
      computeCampaignOverview(campaign.id),
      brandNamesByCampaign([campaign.id]),
    ])
    if (!overview) throw new ToolError(CAMPAIGN_NOT_FOUND)

    // The money columns are only read from the database when they were asked for
    const money = withEconomics
      ? await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { budget: true } })
      : null

    return {
      campaign: serializeCampaign(campaign, {
        brand: brands.get(campaign.id) ?? null,
        creators: campaign._count.influencers,
        pieces: campaign._count.media,
      }),
      brandTargets: serializeBrandTargets(campaign),
      ...serializeCampaignResults(stripEconomics(overview)),
      economicsIncluded: withEconomics,
      ...(withEconomics ? { internalEconomics: serializeCampaignEconomics(overview, { budget: money?.budget }) } : {}),
    }
  },
})

// ============ list_campaign_creators ============

export const listCampaignCreators = defineTool({
  name: 'list_campaign_creators',
  title: 'Ver creadoras de una campaña',
  description:
    'Lists the creators of one campaign with their figures in it, most views first. Each row has the creator id, ' +
    'handle, network, status in the campaign (PROSPECT, OUTREACH, NEGOTIATING, AGREED, CONTRACTED, SHIPPING, POSTED ' +
    'or COMPLETED), followers, publications (posts and stories), publications planned, views, interactions and her ' +
    'engagement rate. Same computation as the campaign screen. ' +
    'By default NO fee and NO cost. With includeEconomics: true each row gets an internalEconomics block (agreed fee, ' +
    'cost, CPM, EMV), which is internal to the agency. No contact data is ever returned. ' +
    'Capped at 200 rows; the answer says when it was cut.',
  input: {
    campaignId: idInput('The campaign id, as returned by list_campaigns.'),
    includeEconomics: economicsInput,
    limit: limitInput,
  },
  summarize: args => ({
    campaignId: args.campaignId,
    includeEconomics: args.includeEconomics === true,
    limit: args.limit,
  }),
  async run(args) {
    const withEconomics = args.includeEconomics === true
    const limit = clampLimit(args.limit)
    const campaign = await prisma.campaign.findUnique({ where: { id: args.campaignId }, select: { id: true, name: true } })
    if (!campaign) throw new ToolError(CAMPAIGN_NOT_FOUND)
    const overview = await computeCampaignOverview(campaign.id)
    if (!overview) throw new ToolError(CAMPAIGN_NOT_FOUND)

    const publicRows = [...stripEconomics(overview).perInfluencer].sort(
      (a, b) => b.views - a.views || b.media - a.media || a.username.localeCompare(b.username),
    )
    const shown = publicRows.slice(0, limit)

    // Fees are only read from the database when they were asked for
    const fees = new Map<string, { agreedFee: number | null }>()
    if (withEconomics && shown.length > 0) {
      const memberships = await prisma.campaignInfluencer.findMany({
        where: { campaignId: campaign.id, influencerId: { in: shown.map(p => p.influencerId) } },
        select: { influencerId: true, agreedFee: true },
      })
      for (const m of memberships) fees.set(m.influencerId, { agreedFee: m.agreedFee })
    }
    const withMoney = new Map(overview.perInfluencer.map(p => [p.influencerId, p]))

    const items = shown.map(p => {
      const full = withMoney.get(p.influencerId)
      return {
        ...serializeCampaignCreator(p),
        ...(withEconomics && full
          ? { internalEconomics: serializeCampaignCreatorEconomics(full, fees.get(p.influencerId)) }
          : {}),
      }
    })
    return {
      campaignId: campaign.id,
      campaign: shortText(campaign.name) ?? '',
      economicsIncluded: withEconomics,
      ...(withEconomics ? { internalNotice: INTERNAL_NOTICE } : {}),
      creators: listEnvelope(items, publicRows.length, limit, 'Raise limit (at most 200).'),
    }
  },
})

// ============ list_campaign_media ============

export const listCampaignMedia = defineTool({
  name: 'list_campaign_media',
  title: 'Ver publicaciones de una campaña',
  description:
    'Lists the publications captured for one campaign, newest first. Each row has the piece id, permalink, creator ' +
    'handle, network, type (POST, REEL, STORY, VIDEO, SHORT or CAROUSEL), publication time (UTC), likes, comments, ' +
    'shares, saves, views, reach, how it entered the platform (capturedBy: apify = public scrape, meta_api = ' +
    'connected account, manual = added by a person), where the creator statistics came from (statsFrom) and whether ' +
    'the creator deleted it. views, reach, saves and shares are null when that figure is not known for the piece ' +
    '(the network does not publish it, or it was not captured): null is NOT zero, never report it as 0. Views are ' +
    'only given when they are real (above 0 and at least the likes), the same rule as the screens of the platform. ' +
    'Captions are not returned. Filter by creator handle, type and date range to keep the ' +
    'answer small. Capped at 200 rows; the answer says when it was cut and how many exist. ' +
    'To find out why a publication is missing use explain_missing_post.',
  input: {
    campaignId: idInput('The campaign id, as returned by list_campaigns.'),
    creator: z
      .string()
      .trim()
      .min(1)
      .max(61)
      .optional()
      .describe('Only publications of this creator: her handle, with or without @.'),
    type: z.enum(MEDIA_TYPES).optional().describe('Only publications of this type.'),
    since: dayInput('Only publications from this day on (YYYY-MM-DD, UTC, inclusive).').optional(),
    until: dayInput('Only publications up to this day (YYYY-MM-DD, UTC, the whole day included).').optional(),
    limit: limitInput,
  },
  summarize: args => ({
    campaignId: args.campaignId,
    creator: summarizeHandleArg(args.creator),
    type: args.type,
    since: args.since,
    until: args.until,
    limit: args.limit,
  }),
  async run(args) {
    const limit = clampLimit(args.limit)
    const campaign = await prisma.campaign.findUnique({ where: { id: args.campaignId }, select: { id: true, name: true } })
    if (!campaign) throw new ToolError(CAMPAIGN_NOT_FOUND)

    const where: Prisma.MediaWhereInput = { campaignId: campaign.id }
    let handle: string | null = null
    if (args.creator !== undefined) {
      handle = cleanHandle(args.creator)
      if (!handle) throw new ToolError('creator must be a handle: letters, digits, dots, underscores and hyphens.')
      where.influencer = { username: { equals: escapeForInsensitiveEquals(handle), mode: 'insensitive' } }
    }
    if (args.type) where.mediaType = args.type
    const since = args.since ? parseDay(args.since) : null
    const until = args.until ? parseDay(args.until) : null
    if (since && until && since.getTime() > until.getTime()) throw new ToolError('since must not be after until.')
    if (since || until) {
      where.postedAt = { ...(since ? { gte: since } : {}), ...(until ? { lt: dayAfter(until) } : {}) }
    }

    const [rows, total] = await Promise.all([
      prisma.media.findMany({
        where,
        orderBy: [{ postedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          permalink: true,
          platform: true,
          mediaType: true,
          postedAt: true,
          likes: true,
          comments: true,
          shares: true,
          saves: true,
          views: true,
          reach: true,
          source: true,
          insightsSource: true,
          isDeleted: true,
          influencer: { select: { username: true } },
        },
      }),
      prisma.media.count({ where }),
    ])
    return {
      campaignId: campaign.id,
      campaign: shortText(campaign.name) ?? '',
      filters: {
        creator: handle ? `@${handle}` : null,
        type: args.type ?? null,
        since: args.since ?? null,
        until: args.until ?? null,
      },
      pieces: listEnvelope(
        rows.map(serializeMedia),
        total,
        limit,
        'Narrow with creator, type, since and until, or raise limit (at most 200).',
      ),
    }
  },
})
