/**
 * Write tools of the MCP connector for PUBLICATIONS: add a piece by its URL,
 * register stories by hand, correct the figures of a piece with the creator's
 * real statistics and tag pieces (angle, hook, benefit).
 *
 * Built with defineWriteTool (../../write-tool.ts); bodies checked against the
 * routes of this working copy:
 *   POST  /api/campaigns/[id]/media/manual         { url, influencerId?, likes?, comments?, views?, reach?, postedAt? }
 *   POST  /api/campaigns/[id]/stories              { influencerId, permalink?, views?, reach?, impressions?, replies?, postedAt?, mentions?, hashtags? }
 *   PATCH /api/campaigns/[id]/media/[mediaId]      { insights: { source, overwrite, ...figures } } | { contentAngle?, hook?, productBenefit? }
 *
 * The current figures and tags of a piece are read from the database (READS
 * ONLY, one row or a handful by id): the platform has no route that returns
 * one piece, and the JSON export recomputes the whole campaign and omits
 * impressions.
 */
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { parsePostUrl, type ParsedPostUrl } from '@/lib/post-url'
import { parseInstagramStoryUrl } from '@/lib/story-url'
import { defineWriteTool, type WriteContext, type WriteTool } from '../../write-tool'
import { ToolError, idInput, shortText } from '../shared'
import {
  NOT_ATTEMPTED,
  SKIPPED_AFTER_TIMEOUT,
  UNKNOWN_AFTER_TIMEOUT,
  asArray,
  asNumber,
  asObject,
  asString,
  at,
  attempt,
  countInput,
  echo,
  isoDateInput,
  listText,
  named,
  plural,
  readCampaign,
  requireMembers,
  timeBudget,
  usageText,
  type CampaignMember,
  type CampaignSnapshot,
  type Json,
} from './creators'

/** `2026-11-05 18:42 UTC` */
function instantText(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return 'sin fecha'
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// =====================================================================
// add_publications_by_url
// =====================================================================

interface ParsedPublication {
  url: string
  parsed: ParsedPostUrl
  isStory: boolean
  member: CampaignMember | null
  /** Who it will be filed under, as far as the connector can tell before reading it. */
  authorText: string
}

interface PublicationsPlan {
  snapshot: CampaignSnapshot
  items: ParsedPublication[]
}
const publicationPlans = new WeakMap<WriteContext, PublicationsPlan>()

async function resolvePublications(
  args: { campaignId: string; publications: { url: string; influencerId?: string }[] },
  ctx: WriteContext,
): Promise<PublicationsPlan> {
  const invalid: string[] = []
  const parsedAll: { url: string; parsed: ParsedPostUrl; isStory: boolean; influencerId?: string }[] = []
  for (const p of args.publications) {
    const story = parseInstagramStoryUrl(p.url)
    if (story?.isHighlight) {
      invalid.push(`${echo(p.url, 80)} (es un destacado, no una story con fecha)`)
      continue
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
      : parsePostUrl(p.url)
    if (!parsed) {
      invalid.push(echo(p.url, 80))
      continue
    }
    parsedAll.push({ url: parsed.canonicalUrl, parsed, isStory: parsed.isStory === true, influencerId: p.influencerId })
  }
  if (invalid.length > 0) {
    throw new ToolError(
      `No son enlaces de publicación válidos: ${listText(invalid, 5)}. Valen posts y reels de Instagram (instagram.com/p/… o /reel/…), stories de Instagram (instagram.com/stories/usuario/…), vídeos de TikTok (tiktok.com/@usuario/video/…) y vídeos de YouTube; los enlaces acortados y los destacados no. No se ha hecho nada.`,
    )
  }
  const seen = new Set<string>()
  for (const p of parsedAll) {
    const key = `${p.parsed.platform}:${p.parsed.externalId}`
    if (seen.has(key)) throw new ToolError(`La publicación ${p.url} está repetida en la llamada. No se ha hecho nada.`)
    seen.add(key)
  }
  const snapshot = await readCampaign(ctx, args.campaignId)
  const given = parsedAll.map(p => p.influencerId).filter((id): id is string => !!id)
  if (given.length > 0) requireMembers(snapshot, given)
  const items = parsedAll.map(p => {
    let member: CampaignMember | null = p.influencerId ? (snapshot.byInfluencer.get(p.influencerId) ?? null) : null
    if (!member && p.parsed.ownerHint) {
      const hint = p.parsed.ownerHint.toLowerCase().replace(/^@/, '')
      member = snapshot.members.find(m => m.platform === p.parsed.platform && m.username.toLowerCase() === hint) ?? null
    }
    return { url: p.url, parsed: p.parsed, isStory: p.isStory, member, authorText: member ? at(member.username) : 'autora por resolver' }
  })
  return { snapshot, items }
}

export const addPublicationsByUrl = defineWriteTool({
  name: 'add_publications_by_url',
  title: 'Añadir publicaciones por URL',
  description:
    'Adds publications (post, reel, video, short or Instagram story) to a campaign from their public URL, one row each. ' +
    'The author must be a member of the campaign and the publication date must fall inside the campaign dates; hand-added pieces are exempt from the brand-reference rule. ' +
    'Each URL that is not a story costs one Apify single-post read (stories are never scraped and are free); a read figure greater than 0 wins over the typed one. ' +
    'A TikTok video published by the TikTok account of an Instagram member (same username or linked in her bio) links that account to the campaign automatically. ' +
    "Use for 'añade este reel'. Returns one result per URL with the platform's Spanish reason when refused (other author, outside the dates, publication date needed, already filed under another creator). " +
    'It does NOT accept shortened links or highlights, does not add the author as a member and never retries a URL after a timeout.',
  input: {
    campaignId: idInput('The campaign id.'),
    publications: z
      .array(
        z.object({
          url: z.string().trim().min(8).max(500).describe('Public URL of the post, reel, TikTok or YouTube video, or Instagram story.'),
          influencerId: idInput('Optional: the campaign member it belongs to. Omit to resolve the author from the URL or the read.').optional(),
          likes: countInput('Likes, when they cannot be read.').optional(),
          comments: countInput('Comments, when they cannot be read.').optional(),
          views: countInput('Views, when they cannot be read.').optional(),
          reach: countInput('Reach (stories only).').optional(),
          postedAt: isoDateInput('Publication date, ISO 8601: needed when the date cannot be read.').optional(),
        }),
      )
      .min(1)
      .max(10),
  },
  confirmations: ['none', 'bulk', 'money'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  summarize: a => ({ campaignId: a.campaignId, publications: a.publications.length }),
  async plan(args, ctx) {
    const p = await resolvePublications(args, ctx)
    publicationPlans.set(ctx, p)
    const paid = p.items.filter(i => !i.isStory).length
    const stories = p.items.length - paid
    const lines = p.items.map(i => `${i.url} → ${i.authorText}`)
    const rules =
      'Solo entran si la autora es integrante y la fecha cae dentro de la campaña; cuentan desde ya en los totales, el informe y el portal del cliente. ¿Confirmas?'
    const head = `Vas a añadir ${plural(p.items.length, 'publicación', 'publicaciones')} a ${named(p.snapshot.name)}: ${listText(lines, 10)}.`
    const base = { urls: p.items.map(i => i.url), members: p.snapshot.members.length }
    let fingerprint = JSON.stringify(base)
    if (paid > 0) {
      const apify = await ctx.apifyStatus()
      // Whether Apify reads is part of the state: a free preview (Apify down) never redeems a paid run
      fingerprint = JSON.stringify({ ...base, apifyAvailable: apify.available })
      if (apify.available) {
        return {
          confirmation: 'money',
          spend: 'core',
          fingerprint,
          preview: `${head} ${paid} se ${paid === 1 ? 'lee' : 'leen'} en Apify, una lectura por publicación (${usageText(apify)}); ${stories > 0 ? `las ${stories} stories no cuestan` : 'no hay stories'}. ${rules}`,
        }
      }
      if (p.items.length > 5) {
        return {
          confirmation: 'bulk',
          fingerprint,
          preview: `${head} Apify no está disponible ahora: no se lee nada y hace falta la fecha (postedAt) de cada publicación que no sea una story. ${rules}`,
        }
      }
      return { confirmation: 'none' }
    }
    if (p.items.length > 5) return { confirmation: 'bulk', fingerprint, preview: `${head} Son stories: no se lee nada ni cuesta. ${rules}` }
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const p = publicationPlans.get(ctx) ?? (await resolvePublications(args, ctx))
    const budget = timeBudget()
    const results: Json[] = []
    let stop = false
    for (let i = 0; i < p.items.length; i++) {
      const item = p.items[i]
      const input = args.publications[i]
      if (stop || budget.left() < 15_000) {
        results.push({ url: item.url, result: 'not_attempted', reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const body: Json = { url: input.url }
      for (const k of ['influencerId', 'likes', 'comments', 'views', 'reach', 'postedAt'] as const) if (input[k] !== undefined) body[k] = input[k]
      const out = await attempt(ctx, { method: 'POST', path: `/api/campaigns/${p.snapshot.id}/media/manual`, body, timeoutMs: budget.timeout(120_000) })
      if (!out.ok) {
        if (out.timeout) stop = true
        results.push({
          url: item.url,
          result: out.timeout ? 'unknown' : 'refused',
          reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message,
          ...(out.json.needsPostedAt === true ? { needsPostedAt: true } : {}),
        })
        continue
      }
      const media = asObject(out.json.media)
      const inf = asObject(media.influencer)
      results.push({
        url: item.url,
        result: out.json.created === true ? 'added' : 'updated',
        mediaId: asString(media.id),
        creator: at(inf.username),
        creatorId: asString(inf.id),
        type: asString(media.mediaType),
        postedAt: asString(media.postedAt),
        readFromApify: out.json.enriched === true,
        likes: asNumber(media.likes),
        comments: asNumber(media.comments),
        views: asNumber(media.views),
        ...(item.isStory ? { reach: asNumber(media.reach) } : {}),
      })
    }
    const added = results.filter(r => r.result === 'added' || r.result === 'updated').length
    return {
      campaign: { id: p.snapshot.id, name: shortText(p.snapshot.name, 120) },
      added,
      results,
      ...(added > 0 ? { notice: 'Cuentan desde ya en los totales, el informe y el portal del cliente.' } : {}),
    }
  },
})

// =====================================================================
// register_stories
// =====================================================================

const DUPLICATE_WINDOW_MS = 60_000

interface StoryEntry {
  member: CampaignMember
  /** Exact time from the story link, or the typed postedAt. */
  postedAt: Date | null
  fromLink: boolean
}

interface StoriesPlan {
  snapshot: CampaignSnapshot
  entries: StoryEntry[]
}
const storyPlans = new WeakMap<WriteContext, StoriesPlan>()

type StoryInput = {
  influencerId: string
  permalink?: string
  views?: number
  reach?: number
  impressions?: number
  replies?: number
  postedAt?: string
  allowDuplicate?: boolean
}

interface StoryFigures {
  views: number
  reach: number
  impressions: number
  replies: number
}
/** As the route stores them: an absent count is 0, replies land in `comments`. */
const figuresOfInput = (s: StoryInput): StoryFigures => ({ views: s.views ?? 0, reach: s.reach ?? 0, impressions: s.impressions ?? 0, replies: s.replies ?? 0 })
const figuresOfRow = (row: Json): StoryFigures => ({
  views: asNumber(row.views) ?? 0,
  reach: asNumber(row.reach) ?? 0,
  impressions: asNumber(row.impressions) ?? 0,
  replies: asNumber(row.comments) ?? 0,
})
const sameFigures = (a: StoryFigures, b: StoryFigures) =>
  a.views === b.views && a.reach === b.reach && a.impressions === b.impressions && a.replies === b.replies

async function resolveStories(args: { campaignId: string; stories: StoryInput[] }, ctx: WriteContext): Promise<StoriesPlan> {
  const snapshot = await readCampaign(ctx, args.campaignId)
  requireMembers(snapshot, args.stories.map(s => s.influencerId))
  const problems: string[] = []
  const entries: StoryEntry[] = args.stories.map((s, i) => {
    const member = snapshot.byInfluencer.get(s.influencerId) as CampaignMember
    const n = i + 1
    if (member.platform !== 'INSTAGRAM') problems.push(`${n}: ${at(member.username)} no es de Instagram (las stories solo existen allí)`)
    if (s.permalink) {
      const story = parseInstagramStoryUrl(s.permalink)
      if (!story) problems.push(`${n}: ${echo(s.permalink, 80)} no es un enlace de story de Instagram (instagram.com/stories/usuario/…)`)
      else if (story.isHighlight) problems.push(`${n}: es un destacado, no una story con fecha`)
      else if (story.username && story.username.toLowerCase() !== member.username.toLowerCase()) {
        problems.push(`${n}: el enlace es de ${at(story.username)}, no de ${at(member.username)}`)
      } else return { member, postedAt: story.postedAtHint ?? (s.postedAt ? new Date(s.postedAt) : null), fromLink: true }
      return { member, postedAt: null, fromLink: true }
    }
    if (!s.postedAt) problems.push(`${n}: sin enlace de la story hace falta postedAt (fecha y hora de publicación)`)
    return { member, postedAt: s.postedAt ? new Date(s.postedAt) : null, fromLink: false }
  })
  if (problems.length > 0) throw new ToolError(`No se puede registrar: ${problems.join('; ')}. No se ha hecho nada.`)

  // WITHOUT a link the platform creates a new row on every call: a retry would count the story twice
  const unlinked = args.stories.map((s, i) => ({ s, e: entries[i] })).filter(x => !x.e.fromLink)
  if (unlinked.length > 0) {
    const data = asObject(await ctx.platformJson({ method: 'GET', path: `/api/campaigns/${snapshot.id}/stories` }))
    const existing = asArray(data.stories)
      .map(asObject)
      .map(row => ({
        influencerId: asString(row.influencerId),
        at: typeof row.postedAt === 'string' ? new Date(row.postedAt).getTime() : NaN,
        figures: figuresOfRow(row),
      }))
    const duplicates: string[] = []
    unlinked.forEach(({ s, e }, idx) => {
      if (s.allowDuplicate || !e.postedAt) return
      const t = e.postedAt.getTime()
      const mine = figuresOfInput(s)
      const close = (other: number) => Number.isFinite(other) && Math.abs(other - t) < DUPLICATE_WINDOW_MS
      const inDb = existing.some(row => row.influencerId === s.influencerId && close(row.at) && sameFigures(row.figures, mine))
      const inCall = unlinked
        .slice(0, idx)
        .some(o => o.s.influencerId === s.influencerId && !!o.e.postedAt && close(o.e.postedAt.getTime()) && sameFigures(figuresOfInput(o.s), mine))
      if (inDb || inCall) duplicates.push(`${at(e.member.username)} · ${instantText(e.postedAt)}`)
    })
    if (duplicates.length > 0) {
      throw new ToolError(
        `Ya hay registrada una story idéntica (misma creadora, misma hora y mismas cifras): ${listText(duplicates, 10)}. Parece un reintento: no se ha registrado nada. Si de verdad son stories distintas, vuelve a llamar con allowDuplicate: true en esas.`,
      )
    }
  }
  return { snapshot, entries }
}

export const registerStories = defineWriteTool({
  name: 'register_stories',
  title: 'Registrar stories a mano',
  description:
    "Registers Instagram stories by hand for creators of a campaign with the figures from the creator's statistics (views, reach, impressions, replies), or updates the figures of a story already registered with the same story link. " +
    "Free: nothing is scraped. Use for 'registra la story de @x con 1.200 vistas'. Prefer the story link (instagram.com/stories/<user>/<id>/): it identifies the story and carries its exact time. " +
    'WITHOUT a link the platform creates a new row on every call, so postedAt is required, a story identical to one already registered for that creator (same time and figures) is refused unless allowDuplicate is true, and you must never retry. ' +
    'Counts at once in the campaign totals, the report and the portal. It does NOT upload images and does not accept highlights.',
  input: {
    campaignId: idInput('The campaign id.'),
    stories: z
      .array(
        z.object({
          influencerId: idInput('The creator, an Instagram member of the campaign.'),
          permalink: z.string().trim().min(10).max(300).optional().describe('The story link of that creator: instagram.com/stories/<user>/<id>/.'),
          views: countInput('Views.').optional(),
          reach: countInput('Reach.').optional(),
          impressions: countInput('Impressions.').optional(),
          replies: countInput('Replies.').optional(),
          postedAt: isoDateInput('Date and time of publication, ISO 8601. Required without a link; inside the campaign dates.').optional(),
          mentions: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe('Accounts mentioned in the story.'),
          hashtags: z.array(z.string().trim().min(1).max(100)).max(30).optional().describe('Hashtags of the story.'),
          allowDuplicate: z.boolean().optional().describe('true only when the person confirms it is a different story with the same time and figures.'),
        }),
      )
      .min(1)
      .max(10),
  },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  summarize: a => ({ campaignId: a.campaignId, stories: a.stories.length, withLink: a.stories.filter(s => !!s.permalink).length }),
  async plan(args, ctx) {
    const p = await resolveStories(args, ctx)
    storyPlans.set(ctx, p)
    if (p.entries.length <= 5) return { confirmation: 'none' }
    const lines = p.entries.map((e, i) => {
      const s = args.stories[i]
      return `${at(e.member.username)} · ${instantText(e.postedAt)} · ${s.views ?? 0} vistas / ${s.reach ?? 0} de alcance`
    })
    return {
      confirmation: 'bulk',
      fingerprint: JSON.stringify(p.entries.map(e => [e.member.influencerId, e.postedAt?.toISOString() ?? null])),
      preview: `Vas a registrar ${p.entries.length} stories en ${named(p.snapshot.name)}: ${listText(lines, 10)}. Se suman desde ya a los totales, al informe y al portal del cliente. No se rastrea nada ni cuesta. ¿Confirmas?`,
    }
  },
  async execute(args, ctx) {
    const p = storyPlans.get(ctx) ?? (await resolveStories(args, ctx))
    const budget = timeBudget()
    const results: Json[] = []
    let stop = false
    for (let i = 0; i < args.stories.length; i++) {
      const s = args.stories[i]
      const e = p.entries[i]
      if (stop || budget.left() < 5_000) {
        results.push({ creator: at(e.member.username), result: 'not_attempted', reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const body: Json = { influencerId: s.influencerId }
      for (const k of ['permalink', 'views', 'reach', 'impressions', 'replies', 'postedAt', 'mentions', 'hashtags'] as const) if (s[k] !== undefined) body[k] = s[k]
      // The route refuses the same creator + date + figures without a link too when asked to (dedupe),
      // unless told it is another story: a retry of this call never counts a story twice
      if (s.allowDuplicate === true) body.allowDuplicate = true
      else body.dedupe = true
      const out = await attempt(ctx, { method: 'POST', path: `/api/campaigns/${p.snapshot.id}/stories`, body, timeoutMs: budget.timeout(60_000) })
      if (!out.ok) {
        if (out.timeout) stop = true
        results.push({ creator: at(e.member.username), result: out.timeout ? 'unknown' : 'refused', reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message })
        continue
      }
      const story = asObject(out.json.story)
      results.push({
        creator: at(e.member.username),
        result: out.json.updated === true ? 'updated' : 'created',
        mediaId: asString(story.id),
        postedAt: asString(story.postedAt),
        views: asNumber(story.views),
        reach: asNumber(story.reach),
        impressions: asNumber(story.impressions),
        replies: asNumber(story.comments),
      })
    }
    return {
      campaign: { id: p.snapshot.id, name: shortText(p.snapshot.name, 120) },
      results,
      notice: 'Se suman desde ya a los totales, al informe y al portal del cliente. No repitas la llamada si alguna quedó en resultado desconocido: compruébalo antes con una lectura.',
    }
  },
})

// =====================================================================
// correct_publication_metrics
// =====================================================================

const INSIGHT_FIELDS = ['reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'saves'] as const
type InsightField = (typeof INSIGHT_FIELDS)[number]

const MEDIA_FIGURES_SELECT = {
  id: true,
  mediaType: true,
  permalink: true,
  reach: true,
  impressions: true,
  views: true,
  likes: true,
  comments: true,
  shares: true,
  saves: true,
  influencer: { select: { username: true } },
} as const

async function readPiece(campaignId: string, mediaId: string) {
  const row = await prisma.media.findFirst({ where: { id: mediaId, campaignId }, select: MEDIA_FIGURES_SELECT })
  if (!row) throw new ToolError('Esa publicación no está en esta campaña. Usa list_campaign_media para ver sus ids. No se ha hecho nada.')
  return row
}
type Piece = Awaited<ReturnType<typeof readPiece>>
const piecePlans = new WeakMap<WriteContext, Piece>()

export const correctPublicationMetrics = defineWriteTool({
  name: 'correct_publication_metrics',
  title: 'Corregir las métricas de una publicación',
  description:
    "Writes the real statistics of one publication or story (reach, impressions, views, likes, comments, shares, saves) as shown in the creator's screenshot or typed by the person. " +
    'They are stamped as real insights with the admin as author and become the audience used in every total, the report and the client portal. ' +
    "Use for 'corrige las vistas de este reel'. If the person shares a screenshot, read the figures yourself and pass source 'creator_screenshot'. " +
    'By default likes, comments and views never go down (the higher public figure is kept and reported); set overwrite true only when the person explicitly wants to lower them. ' +
    'Previous values are not stored anywhere: the answer shows each figure as before and after. It does NOT change the date, author or type of the piece and cannot remove it.',
  input: {
    campaignId: idInput('The campaign id.'),
    mediaId: idInput('The publication, a piece of this campaign (list_campaign_media).'),
    source: z.enum(['creator_screenshot', 'manual']).describe("'creator_screenshot' when read from the creator's statistics, 'manual' when typed."),
    reach: countInput('Real reach.').optional(),
    impressions: countInput('Impressions.').optional(),
    views: countInput('Views.').optional(),
    likes: countInput('Likes.').optional(),
    comments: countInput('Comments.').optional(),
    shares: countInput('Shares.').optional(),
    saves: countInput('Saves.').optional(),
    overwrite: z.boolean().optional().describe('true lets likes, comments and views go down. Only on explicit request.'),
  },
  confirmations: ['none'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({
    campaignId: a.campaignId,
    mediaId: a.mediaId,
    source: a.source,
    fields: INSIGHT_FIELDS.filter(f => a[f] !== undefined).join(','),
    overwrite: a.overwrite,
  }),
  async plan(args, ctx) {
    if (INSIGHT_FIELDS.every(f => args[f] === undefined)) throw new ToolError('Indica al menos una cifra (reach, impressions, views, likes, comments, shares o saves). No se ha hecho nada.')
    piecePlans.set(ctx, await readPiece(args.campaignId, args.mediaId))
    return { confirmation: 'none' }
  },
  async execute(args, ctx) {
    const before = piecePlans.get(ctx) ?? (await readPiece(args.campaignId, args.mediaId))
    const insights: Json = { source: args.source, overwrite: args.overwrite === true }
    for (const f of INSIGHT_FIELDS) if (args[f] !== undefined) insights[f] = args[f]
    const out = asObject(
      await ctx.platformJson({ method: 'PATCH', path: `/api/campaigns/${args.campaignId}/media/${args.mediaId}`, body: { insights } }),
    )
    const media = asObject(out.media)
    const figures: Json = {}
    for (const f of INSIGHT_FIELDS) {
      if (args[f] === undefined) continue
      figures[f] = { before: before[f as InsightField], after: asNumber(media[f]) }
    }
    return {
      mediaId: args.mediaId,
      creator: at(before.influencer.username),
      type: before.mediaType,
      figures,
      keptBecausePublicFigureWasHigher: asArray(out.keptHigherPublic).filter((x): x is string => typeof x === 'string'),
      source: args.source,
      notice: 'Estas cifras cuentan ya como audiencia real en los totales, el informe y el portal del cliente.',
    }
  },
})

// =====================================================================
// tag_publications
// =====================================================================

const CONTENT_ANGLES = ['problema_solucion', 'tutorial', 'unboxing', 'testimonio', 'humor', 'comparativa', 'dia_a_dia', 'otro'] as const
const TAG_FIELDS = ['contentAngle', 'hook', 'productBenefit'] as const

type TagItem = { mediaId: string; contentAngle?: string | null; hook?: string | null; productBenefit?: string | null }

async function readTags(campaignId: string, items: readonly TagItem[]) {
  const ids = items.map(i => i.mediaId)
  if (new Set(ids).size !== ids.length) throw new ToolError('Hay publicaciones repetidas en items. No se ha hecho nada.')
  const empty = items.filter(i => TAG_FIELDS.every(f => i[f] === undefined)).map(i => i.mediaId)
  if (empty.length > 0) throw new ToolError(`Cada publicación necesita al menos una etiqueta: ${listText(empty, 10)}. No se ha hecho nada.`)
  const rows = await prisma.media.findMany({
    where: { id: { in: ids }, campaignId },
    select: { id: true, contentAngle: true, hook: true, productBenefit: true, influencer: { select: { username: true } } },
  })
  const found = new Map(rows.map(r => [r.id, r]))
  const missing = ids.filter(id => !found.has(id))
  if (missing.length > 0) throw new ToolError(`No están en esta campaña: ${listText(missing, 10)}. Usa list_campaign_media para ver sus ids. No se ha hecho nada.`)
  return found
}
const tagPlans = new WeakMap<WriteContext, Awaited<ReturnType<typeof readTags>>>()

export const tagPublications = defineWriteTool({
  name: 'tag_publications',
  title: 'Etiquetar publicaciones (ángulo, gancho, beneficio)',
  description:
    'Classifies publications of a campaign with their content angle, hook and product benefit, the tags behind the learnings of the report. ' +
    "Use for 'etiqueta las piezas de la campaña'; base each tag on the caption and never invent what the content does not show. null clears a tag. " +
    'The answer shows each tag as before and after. It does NOT change metrics.',
  input: {
    campaignId: idInput('The campaign id.'),
    items: z
      .array(
        z.object({
          mediaId: idInput('A publication of this campaign.'),
          contentAngle: z.enum(CONTENT_ANGLES).nullable().optional().describe('Angle of the piece.'),
          hook: z.string().trim().min(1).max(120).nullable().optional().describe('Hook of the first seconds.'),
          productBenefit: z.string().trim().min(1).max(120).nullable().optional().describe('Product benefit it pushes.'),
        }),
      )
      .min(1)
      .max(50),
  },
  confirmations: ['none', 'bulk'],
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  summarize: a => ({ campaignId: a.campaignId, items: a.items.length }),
  async plan(args, ctx) {
    const current = await readTags(args.campaignId, args.items)
    tagPlans.set(ctx, current)
    if (args.items.length <= 5) return { confirmation: 'none' }
    const overwritten = args.items.filter(i => {
      const row = current.get(i.mediaId)!
      return TAG_FIELDS.some(f => i[f] !== undefined && row[f] !== null && row[f] !== (i[f] ?? null))
    }).length
    const snapshot = await readCampaign(ctx, args.campaignId)
    return {
      confirmation: 'bulk',
      fingerprint: JSON.stringify(args.items.map(i => TAG_FIELDS.map(f => current.get(i.mediaId)![f]))),
      preview:
        `Vas a etiquetar ${args.items.length} publicaciones de ${named(snapshot.name)} (ángulo, gancho y beneficio). ` +
        `${overwritten > 0 ? `${plural(overwritten, 'ya tenía etiquetas y se sobrescribe', 'ya tenían etiquetas y se sobrescriben')}. ` : ''}` +
        'Afecta a los aprendizajes del informe. ¿Confirmas?',
    }
  },
  async execute(args, ctx) {
    const current = tagPlans.get(ctx) ?? (await readTags(args.campaignId, args.items))
    const budget = timeBudget()
    const results: Json[] = []
    let stop = false
    for (const item of args.items) {
      const row = current.get(item.mediaId)!
      if (stop || budget.left() < 5_000) {
        results.push({ mediaId: item.mediaId, result: 'not_attempted', reason: stop ? SKIPPED_AFTER_TIMEOUT : NOT_ATTEMPTED })
        continue
      }
      const body: Json = {}
      for (const f of TAG_FIELDS) if (item[f] !== undefined) body[f] = item[f]
      const out = await attempt(ctx, { method: 'PATCH', path: `/api/campaigns/${args.campaignId}/media/${item.mediaId}`, body, timeoutMs: budget.timeout(30_000) })
      if (!out.ok) {
        results.push({ mediaId: item.mediaId, result: out.timeout ? 'unknown' : 'refused', reason: out.timeout ? UNKNOWN_AFTER_TIMEOUT : out.message })
        if (out.timeout) stop = true
        continue
      }
      const media = asObject(out.json.media)
      const tags: Json = {}
      for (const f of TAG_FIELDS) if (item[f] !== undefined) tags[f] = { before: row[f], after: asString(media[f]) }
      results.push({ mediaId: item.mediaId, creator: at(row.influencer.username), result: 'tagged', tags })
    }
    return { campaignId: args.campaignId, tagged: results.filter(r => r.result === 'tagged').length, results }
  },
})

// =====================================================================
// Registration
// =====================================================================

export const PUBLICATION_WRITE_TOOLS: readonly WriteTool[] = [addPublicationsByUrl, registerStories, correctPublicationMetrics, tagPublications]

/** Hands every publication write tool to `register` (server.ts: server.registerTool with writeToolConfig). */
export function registerPublicationWriteTools(register: (tool: WriteTool) => void): void {
  for (const tool of PUBLICATION_WRITE_TOOLS) register(tool)
}
