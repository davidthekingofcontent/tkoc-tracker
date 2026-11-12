/**
 * The two creator tools of the MCP connector: find_creator and get_creator.
 * Read-only. A creator is returned as her public identity on one network and
 * her public profile figures. No contact data, ever: the queries below do not
 * even select e-mail, phone, website, bio, city or the usual fee.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { escapeForInsensitiveEquals } from '@/lib/auth'
import type { Prisma } from '@/generated/prisma/client'
import { brandNamesByCampaign } from './brands'
import { serializeCreator, serializeCreatorCampaign, serializeCreatorProfile } from './serializers'
import {
  ToolError,
  clampLimit,
  cleanHandle,
  defineTool,
  idInput,
  limitInput,
  listEnvelope,
  platformInput,
  summarizeHandleArg,
  summarizeQuery,
} from './shared'
import { LIST_MAX_LIMIT } from '../config'

/** The only columns of a creator the connector ever reads. */
const CREATOR_SELECT = {
  id: true,
  username: true,
  platform: true,
  displayName: true,
  followers: true,
  country: true,
  isVerified: true,
} as const

const CREATOR_PROFILE_SELECT = {
  ...CREATOR_SELECT,
  following: true,
  postsCount: true,
  engagementRate: true,
  avgLikes: true,
  avgComments: true,
  avgViews: true,
  language: true,
  lastScraped: true,
} as const

// ============ find_creator ============

export const findCreator = defineTool({
  name: 'find_creator',
  title: 'Buscar creadoras',
  description:
    'Searches the creators stored on TKOC Intelligence by handle or by public name (a part of either is enough, ' +
    'upper or lower case). Each match has the creator id, handle, network, public name, followers, country and the ' +
    'number of campaigns she is in, most followers first. The same person on two networks is two rows. ' +
    'Use it to get the id that get_creator needs. It does not search the networks: only creators already on the ' +
    'platform. No contact data is ever returned. Capped at 200 rows; the answer says when it was cut.',
  input: {
    query: z.string().trim().min(2).max(80).describe('A handle (with or without @) or a part of the public name. At least 2 characters.'),
    platform: platformInput('Only creators on this network.').optional(),
    limit: limitInput,
  },
  summarize: args => ({ query: summarizeQuery(args.query), platform: args.platform, limit: args.limit }),
  async run(args) {
    const limit = clampLimit(args.limit)
    const byHandleOnly = args.query.startsWith('@')
    const text = args.query.replace(/^@+/, '').trim()
    if (text.length < 2) throw new ToolError('query needs at least 2 characters.')
    // % and _ are wildcards in ILIKE: the text is matched literally
    const needle = escapeForInsensitiveEquals(text)
    const where: Prisma.InfluencerWhereInput = {
      ...(args.platform ? { platform: args.platform } : {}),
      OR: [
        { username: { contains: needle, mode: 'insensitive' } },
        ...(byHandleOnly ? [] : [{ displayName: { contains: needle, mode: 'insensitive' as const } }]),
      ],
    }
    const [rows, total] = await Promise.all([
      prisma.influencer.findMany({
        where,
        orderBy: [{ followers: 'desc' }, { id: 'asc' }],
        take: limit,
        select: { ...CREATOR_SELECT, _count: { select: { campaigns: true } } },
      }),
      prisma.influencer.count({ where }),
    ])
    const items = rows.map(r => ({ ...serializeCreator(r), campaigns: r._count.campaigns }))
    return {
      network: args.platform ?? 'all',
      creators: listEnvelope(items, total, limit, 'Type more of the handle, filter by platform or raise limit (at most 200).'),
    }
  },
})

// ============ get_creator ============

export const getCreator = defineTool({
  name: 'get_creator',
  title: 'Ver una creadora',
  description:
    'Returns one creator: her public profile on one network (handle, public name, followers, following, posts, ' +
    'profile engagement rate, average likes, comments and views, country, language, when the profile was last read) ' +
    'and the campaigns she is in, newest first, with the brand, the campaign status, her status in it and her ' +
    'number of publications. Identify her with influencerId (from find_creator or list_campaign_creators), or with ' +
    'handle and platform. With a handle and no platform, if the handle exists on several networks the answer lists ' +
    'them so you can ask again. No e-mail, phone, address, notes or fee is ever returned. ' +
    'For her figures inside one campaign use list_campaign_creators.',
  input: {
    influencerId: idInput('The creator id, as returned by find_creator or list_campaign_creators.').optional(),
    handle: z.string().trim().min(1).max(61).optional().describe('Her handle, with or without @. Used when influencerId is not given.'),
    platform: platformInput('The network of that handle.').optional(),
  },
  summarize: args => ({
    influencerId: args.influencerId,
    handle: summarizeHandleArg(args.handle),
    platform: args.platform,
  }),
  async run(args) {
    let creatorId = args.influencerId ?? null
    if (!creatorId) {
      if (args.handle === undefined) throw new ToolError('Give influencerId, or handle (and platform).')
      const handle = cleanHandle(args.handle)
      if (!handle) throw new ToolError('handle must be made of letters, digits, dots, underscores and hyphens.')
      const candidates = await prisma.influencer.findMany({
        where: {
          username: { equals: escapeForInsensitiveEquals(handle), mode: 'insensitive' },
          ...(args.platform ? { platform: args.platform } : {}),
        },
        orderBy: [{ followers: 'desc' }, { id: 'asc' }],
        take: 10,
        select: CREATOR_SELECT,
      })
      // Compared again in code: the database match is a pattern match
      const matches = candidates.filter(c => c.username.toLowerCase() === handle.toLowerCase())
      if (matches.length === 0) {
        throw new ToolError('No creator with that handle on the platform. Use find_creator to search by a part of the handle or name.')
      }
      if (matches.length > 1) {
        return {
          found: false,
          reason: 'The handle exists on several networks. Ask again with platform, or with one of these ids.',
          candidates: matches.map(serializeCreator),
        }
      }
      creatorId = matches[0].id
    }

    const creator = await prisma.influencer.findUnique({ where: { id: creatorId }, select: CREATOR_PROFILE_SELECT })
    if (!creator) throw new ToolError('Creator not found. Use find_creator to get the id of a creator.')

    const [memberships, total, piecesByCampaign] = await Promise.all([
      prisma.campaignInfluencer.findMany({
        where: { influencerId: creator.id },
        orderBy: [{ campaign: { startDate: 'desc' } }, { id: 'asc' }],
        take: LIST_MAX_LIMIT,
        select: {
          status: true,
          campaign: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
        },
      }),
      prisma.campaignInfluencer.count({ where: { influencerId: creator.id } }),
      prisma.media.groupBy({
        by: ['campaignId'],
        where: { influencerId: creator.id, campaignId: { not: null } },
        _count: { _all: true },
      }),
    ])
    const pieces = new Map<string, number>()
    for (const g of piecesByCampaign) if (g.campaignId) pieces.set(g.campaignId, g._count._all)
    const brands = await brandNamesByCampaign(memberships.map(m => m.campaign.id))

    return {
      found: true,
      creator: serializeCreatorProfile(creator),
      campaigns: listEnvelope(
        memberships.map(m =>
          serializeCreatorCampaign(m, { brand: brands.get(m.campaign.id) ?? null, pieces: pieces.get(m.campaign.id) ?? 0 }),
        ),
        total,
        LIST_MAX_LIMIT,
        'Only the 200 most recent campaigns are listed.',
      ),
    }
  },
})
