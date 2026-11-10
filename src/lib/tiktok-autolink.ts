import { prisma } from '@/lib/db'
import { isApifyExhausted, scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedPost, ScrapedProfile } from '@/lib/apify'
import type { InfluencerStatus } from '@/generated/prisma/client'
import {
  STORY_SCAN_STATUSES,
  campaignHasTargets,
  campaignWindowEndExclusive,
  mediaMatchesCampaignRules,
  normalizeTargets,
  scrapedPostToRuleItem,
  upsertCampaignPost,
} from '@/lib/campaign-capture'
import { keywordNeedles } from '@/lib/campaign-targets'
import { afterInfluencerUpsert, scrapedProfileHasData, scrapedProfileUpdate } from '@/lib/influencer-upsert'
import { notifyCampaignTeam } from '@/lib/notifications'

/**
 * TIKTOK AUTO-LINK (Nov 2026).
 *
 * A TikTok video is only ever attached to a campaign when that TikTok ACCOUNT
 * is a member of it, and PMs add creators by their Instagram handle: the
 * campaign "Dorco - Delyplus" had 28 Instagram members, TikTok among its
 * platforms and not one TikTok video, although two creators had already
 * published theirs there.
 *
 * For every live campaign that includes TikTok, the latest TikTok videos of
 * each CONFIRMED Instagram member without a TikTok account in the campaign are
 * read from her candidate profile — the tiktok.com/@user linked in her
 * Instagram bio/website, else the same username — in ONE batched actor run.
 * The account is linked ON EVIDENCE only: a video inside the campaign dates
 * that references the brand (the same rule engine as every other capture). A
 * namesake who never publishes the campaign's content is never added. The
 * link is recorded in CampaignInfluencer.source as 'tiktok_link:<instagram
 * influencer id>' (free-text column, nothing else reads it).
 */

export const TIKTOK_LINK_SOURCE_PREFIX = 'tiktok_link:'
const CHECKED_KEY = 'tiktok_link_checked'
/** Videos read per profile and pass (paid per video actually returned): the first pass goes back to the campaign start. */
const FIRST_PASS_VIDEOS = 100
const DAILY_PASS_VIDEOS = 40
/** A first pass never reads further back than this, however old the campaign is. */
const FIRST_PASS_MAX_DAYS = 45
/**
 * A campaign keeps being scanned this long after its end date: videos of the
 * last day (the usual deadline) and of a pause that spans the end would
 * otherwise never be read. Only videos dated inside the campaign count.
 */
const GRACE_AFTER_END_MS = 3 * 86_400_000

const TIKTOK_URL_RX = /tiktok\.com\/@([A-Za-z0-9_.]{2,24})/i

function cleanHandle(handle: string): string {
  return String(handle || '').trim().replace(/^@+/, '').replace(/\.+$/, '').toLowerCase()
}

/** The TikTok user a creator links in her Instagram bio/website, else her Instagram username. */
export function tiktokCandidateHandle(influencer: { username: string; bio?: string | null; website?: string | null }): { handle: string; via: 'bio' | 'same' } {
  const hit = (influencer.website || '').match(TIKTOK_URL_RX) || (influencer.bio || '').match(TIKTOK_URL_RX)
  const linked = hit ? cleanHandle(hit[1]) : ''
  return linked ? { handle: linked, via: 'bio' } : { handle: cleanHandle(influencer.username), via: 'same' }
}

/** The Instagram influencer id a TikTok membership was linked from, or null. */
export function linkedInstagramId(source: string | null | undefined): string | null {
  return source && source.startsWith(TIKTOK_LINK_SOURCE_PREFIX) ? source.slice(TIKTOK_LINK_SOURCE_PREFIX.length) || null : null
}

/**
 * Makes the TikTok account `handle` a member of the campaign as the TikTok of
 * the Instagram member `igInfluencerId`. Reuses the TikTok Influencer row when
 * one exists under any casing (hashtag scrapes create them), enriches it when
 * a scraped profile is given, and never copies fees or deliverables (the deal
 * belongs to the Instagram membership). Returns null when the Instagram
 * account is not a member; `created` says whether a membership was added now.
 */
export async function ensureTikTokTwin(params: {
  campaignId: string
  igInfluencerId: string
  handle: string
  profile?: ScrapedProfile | null
}): Promise<{ influencerId: string; username: string; created: boolean } | null> {
  const handle = cleanHandle(params.handle)
  if (!handle) return null
  const igMembership = await prisma.campaignInfluencer.findUnique({
    where: { campaignId_influencerId: { campaignId: params.campaignId, influencerId: params.igInfluencerId } },
    select: { status: true },
  })
  if (!igMembership) return null

  const profile = params.profile || null
  // Case-insensitive lookup compiles to ILIKE, where '_' in a handle is a
  // wildcard ('maria_garcia' would also hit 'maria.garcia'): keep only an
  // exact match once lowercased, preferring the same casing.
  const lookalikes = await prisma.influencer.findMany({
    where: { platform: 'TIKTOK', username: { equals: handle, mode: 'insensitive' } },
    select: { id: true, username: true },
  })
  const exact = lookalikes.filter(row => row.username.toLowerCase() === handle)
  let influencer: { id: string; username: string } | null =
    exact.find(row => row.username === (profile?.username || handle)) ?? exact[0] ?? null
  if (influencer) {
    if (profile && scrapedProfileHasData(profile)) {
      await prisma.influencer.update({ where: { id: influencer.id }, data: scrapedProfileUpdate(profile) }).catch(() => {})
    }
  } else {
    const username = profile?.username || handle
    influencer = await prisma.influencer.upsert({
      where: { username_platform: { username, platform: 'TIKTOK' } },
      create: {
        username,
        platform: 'TIKTOK',
        displayName: profile?.displayName ?? null,
        bio: profile?.bio ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        email: profile?.email ?? null,
        website: profile?.website ?? null,
        followers: profile?.followers ?? 0,
        following: profile?.following ?? 0,
        postsCount: profile?.postsCount ?? 0,
        engagementRate: profile?.engagementRate ?? 0,
        avgLikes: profile?.avgLikes ?? 0,
        avgComments: profile?.avgComments ?? 0,
        avgViews: profile?.avgViews ?? 0,
        isVerified: profile?.isVerified ?? false,
        country: profile?.country ?? null,
        city: profile?.city ?? null,
        dataSource: 'apify',
        lastScraped: profile && scrapedProfileHasData(profile) ? new Date() : null,
      },
      update: profile ? scrapedProfileUpdate(profile) : {},
      select: { id: true, username: true },
    })
  }
  if (profile) afterInfluencerUpsert(influencer.id, profile.avatarUrl)

  const existing = await prisma.campaignInfluencer.findUnique({
    where: { campaignId_influencerId: { campaignId: params.campaignId, influencerId: influencer.id } },
    select: { id: true },
  })
  if (existing) return { influencerId: influencer.id, username: influencer.username, created: false }

  // Linked because she PUBLISHED: Publicado (or Completado when the Instagram
  // deal is closed), so the daily post check keeps reading this account.
  const status: InfluencerStatus = igMembership.status === 'COMPLETED' ? 'COMPLETED' : 'POSTED'
  try {
    await prisma.campaignInfluencer.create({
      data: {
        campaignId: params.campaignId,
        influencerId: influencer.id,
        status,
        source: `${TIKTOK_LINK_SOURCE_PREFIX}${params.igInfluencerId}`,
      },
    })
  } catch (err) {
    // A concurrent run created it: fine
    if ((err as { code?: string })?.code !== 'P2002') throw err
    return { influencerId: influencer.id, username: influencer.username, created: false }
  }
  return { influencerId: influencer.id, username: influencer.username, created: true }
}

export interface TikTokAutolinkSummary {
  at: string
  campaigns: Array<{ id: string; name: string; candidates: number; linked: string[]; videos: number }>
  handlesScanned: number
  /** Handles the actor answered for (profile read or reported missing) */
  answered: number
  notFound: number
  linked: number
  videos: number
  /** Handles that returned as many videos as were asked for: older videos of the window may not have been read */
  truncated: string[]
  partial: boolean
  skipped?: string
}

/** '<campaignId>:<handle>' → '<ISO time of the last complete read>|<fingerprint of the rules it was judged with>' */
type CheckedMap = Record<string, string>

/**
 * What a read was judged with. When the campaign's brand accounts, hashtags,
 * keywords or start date change, every pair is read again from the campaign
 * start: the videos already published must be re-judged with the new rules
 * (Dorco: its two TikTok videos pre-dated the corrected targets).
 */
function rulesFingerprint(campaign: { targetAccounts: string[]; targetHashtags: string[]; targetKeywords?: string[] | null; startDate: Date; endDate: Date | null }): string {
  const text = JSON.stringify([
    normalizeTargets(campaign.targetAccounts || []).sort(),
    normalizeTargets(campaign.targetHashtags || []).sort(),
    keywordNeedles(campaign.targetKeywords).sort(),
    new Date(campaign.startDate).toISOString().slice(0, 10),
    // the end too: a video rejected as "after the end" must be re-judged when the campaign is extended
    campaign.endDate ? new Date(campaign.endDate).toISOString().slice(0, 10) : 'open',
  ])
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

async function loadChecked(): Promise<CheckedMap> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: CHECKED_KEY } })
    const parsed = row?.value ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CheckedMap) : {}
  } catch {
    return {}
  }
}

async function saveChecked(map: CheckedMap): Promise<void> {
  const value = JSON.stringify(map)
  await prisma.setting.upsert({ where: { key: CHECKED_KEY }, update: { value }, create: { key: CHECKED_KEY, value } }).catch(() => {})
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/**
 * One pass of the auto-link over every eligible campaign (or one campaign).
 * Budget gates and the daily throttle are the caller's (the cron route); this
 * only stops on the Apify hard limit. Never throws.
 */
export async function runTikTokAutolink(opts: { campaignId?: string; now?: Date } = {}): Promise<TikTokAutolinkSummary> {
  const now = opts.now ?? new Date()
  const summary: TikTokAutolinkSummary = { at: now.toISOString(), campaigns: [], handlesScanned: 0, answered: 0, notFound: 0, linked: 0, videos: 0, truncated: [], partial: false }
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { status: 'ACTIVE', platforms: { has: 'TIKTOK' }, ...(opts.campaignId ? { id: opts.campaignId } : {}) },
      select: {
        id: true,
        name: true,
        paymentType: true,
        targetAccounts: true,
        targetHashtags: true,
        targetKeywords: true,
        startDate: true,
        endDate: true,
        influencers: {
          select: {
            status: true,
            source: true,
            influencer: { select: { id: true, username: true, platform: true, bio: true, website: true } },
          },
        },
      },
    })

    interface Candidate { campaignIndex: number; igInfluencerId: string; igUsername: string; handle: string }
    const live = campaigns.filter(c => {
      if (!campaignHasTargets(c)) return false
      if (now < new Date(c.startDate)) return false
      const endExclusive = campaignWindowEndExclusive(c.endDate)
      return !endExclusive || now.getTime() < endExclusive.getTime() + GRACE_AFTER_END_MS
    })
    const candidates: Candidate[] = []
    live.forEach((campaign, campaignIndex) => {
      const tiktokHandles = new Set<string>()
      const linkedIgIds = new Set<string>()
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'TIKTOK') continue
        tiktokHandles.add(cleanHandle(ci.influencer.username))
        const igId = linkedInstagramId(ci.source)
        if (igId) linkedIgIds.add(igId)
      }
      let count = 0
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'INSTAGRAM') continue
        if (!(STORY_SCAN_STATUSES as readonly string[]).includes(ci.status)) continue
        if (linkedIgIds.has(ci.influencer.id)) continue
        const { handle } = tiktokCandidateHandle(ci.influencer)
        if (!handle || tiktokHandles.has(handle)) continue
        candidates.push({ campaignIndex, igInfluencerId: ci.influencer.id, igUsername: ci.influencer.username, handle })
        count++
      }
      summary.campaigns.push({ id: campaign.id, name: campaign.name, candidates: count, linked: [], videos: 0 })
    })
    if (candidates.length === 0) {
      // Nothing to read: still drop the memo of campaigns that are no longer scanned
      if (!opts.campaignId) {
        const memo = await loadChecked()
        const liveIds = new Set(live.map(c => c.id))
        const stale = Object.keys(memo).filter(key => !liveIds.has(key.split(':')[0]))
        if (stale.length > 0) {
          for (const key of stale) delete memo[key]
          await saveChecked(memo)
        }
      }
      return summary
    }
    if (isApifyExhausted()) { summary.skipped = 'apify_exhausted'; return summary }

    // First pass of a (campaign, handle) pair reads back to the campaign start;
    // later passes only what is new since the last one (minus a day of margin).
    const checked = await loadChecked()
    const fingerprints = live.map(rulesFingerprint)
    const pairKey = (c: Candidate) => `${live[c.campaignIndex].id}:${c.handle}`
    /** Time of the last complete read of the pair UNDER THE CURRENT RULES, or NaN (never / rules changed). */
    const lastRead = (c: Candidate): number => {
      const [iso, fingerprint] = String(checked[pairKey(c)] || '').split('|')
      return fingerprint === fingerprints[c.campaignIndex] ? Date.parse(iso) : NaN
    }
    const sinceOf = (c: Candidate): Date => {
      const stamp = lastRead(c)
      if (Number.isFinite(stamp)) return new Date(stamp - 86_400_000)
      const start = new Date(live[c.campaignIndex].startDate).getTime()
      return new Date(Math.max(start, now.getTime() - FIRST_PASS_MAX_DAYS * 86_400_000))
    }
    // One read per handle, as far back as ANY of its campaigns needs: a handle
    // that is new for one campaign and already read for another must not lose
    // what the second one has not seen yet (both pairs are stamped afterwards).
    const sinceByHandle = new Map<string, Date>()
    const freshHandles = new Set<string>()
    for (const c of candidates) {
      const since = sinceOf(c)
      const prev = sinceByHandle.get(c.handle)
      if (!prev || since < prev) sinceByHandle.set(c.handle, since)
      if (!Number.isFinite(lastRead(c))) freshHandles.add(c.handle)
    }
    const fresh = new Map<string, Date>()
    const known = new Map<string, Date>()
    for (const [handle, since] of sinceByHandle) (freshHandles.has(handle) ? fresh : known).set(handle, since)
    const earliest = (m: Map<string, Date>) => new Date(Math.min(...Array.from(m.values()).map(d => d.getTime())))

    const profiles = new Map<string, ScrapedProfile>()
    const notFound = new Set<string>()
    const incomplete = new Set<string>()
    for (const [group, videos] of [[fresh, FIRST_PASS_VIDEOS], [known, DAILY_PASS_VIDEOS]] as Array<[Map<string, Date>, number]>) {
      if (group.size === 0) continue
      const batch = await scrapeTikTokProfilesBatch(Array.from(group.keys()), { resultsPerPage: videos, oldestPostDate: dayOf(earliest(group)) })
      for (const [h, p] of batch.profiles) {
        profiles.set(h, p)
        // As many videos as were asked for: older ones of the window may be missing
        if (p.recentPosts.length >= videos) summary.truncated.push(h)
      }
      for (const h of batch.notFound) notFound.add(h)
      for (const h of batch.incomplete) incomplete.add(h)
      if (batch.partial) summary.partial = true
    }
    summary.handlesScanned = fresh.size + known.size
    summary.answered = profiles.size + notFound.size
    summary.notFound = notFound.size
    if (summary.truncated.length > 0) {
      console.warn(`[TikTokAutolink] ${summary.truncated.length} profile(s) returned the maximum number of videos — older ones were not read: ${summary.truncated.join(', ')}`)
    }

    for (const c of candidates) {
      const campaign = live[c.campaignIndex]
      const entry = summary.campaigns[c.campaignIndex]
      const profile = profiles.get(c.handle)
      // A handle the run did not answer for is UNKNOWN: not stamped, read again next pass
      if (!profile && !notFound.has(c.handle)) continue
      // A handle of an unfinished run may lack its OLDER videos: link on what
      // matched, but do not record the pair as read
      if (!incomplete.has(c.handle)) checked[pairKey(c)] = `${now.toISOString()}|${fingerprints[c.campaignIndex]}`
      if (!profile) continue

      const matching: ScrapedPost[] = profile.recentPosts.filter(
        post => !!post.externalId && mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post))
      )
      if (matching.length === 0) continue

      const twin = await ensureTikTokTwin({ campaignId: campaign.id, igInfluencerId: c.igInfluencerId, handle: c.handle, profile })
      if (!twin) continue
      let attached = 0
      for (const post of matching) {
        const ok = await upsertCampaignPost(campaign.id, twin.influencerId, 'TIKTOK', post)
        if (!ok) continue
        attached++
        await prisma.media.updateMany({
          where: { externalId: post.externalId, platform: 'TIKTOK', campaignId: campaign.id },
          data: { dataSource: 'apify' },
        }).catch(() => {})
      }
      entry.videos += attached
      summary.videos += attached
      if (twin.created) {
        entry.linked.push(twin.username)
        summary.linked++
        await notifyCampaignTeam(campaign.id, {
          type: 'influencer_added',
          title: 'TikTok vinculado',
          message: `@${twin.username} (TikTok de @${c.igUsername}) se ha vinculado a "${campaign.name}" y ${attached === 1 ? 'se ha capturado 1 vídeo' : `se han capturado ${attached} vídeos`} de la campaña.`,
          link: `/campaigns/${campaign.id}`,
        })
      }
    }

    // Keep the memo small: only pairs of campaigns that are still live
    const liveIds = new Set(live.map(c => c.id))
    for (const key of Object.keys(checked)) {
      if (!liveIds.has(key.split(':')[0]) && !opts.campaignId) delete checked[key]
    }
    await saveChecked(checked)
    return summary
  } catch (err) {
    console.error('[TikTokAutolink] failed:', err instanceof Error ? err.message : err)
    summary.skipped = 'error'
    return summary
  }
}
