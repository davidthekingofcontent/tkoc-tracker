import { prisma } from '@/lib/db'
import { isApifyExhausted, scrapeTikTokProfilesBatch } from '@/lib/apify'
import type { ScrapedPost, ScrapedProfile } from '@/lib/apify'
import {
  STORY_SCAN_STATUSES,
  campaignHasTargets,
  campaignWindowEndExclusive,
  loadCampaignBrandAccounts,
  mediaMatchesCampaignRules,
  normalizeTargets,
  scrapedPostToRuleItem,
  upsertCampaignPost,
} from '@/lib/campaign-capture'
import { loadCampaignRoster } from '@/lib/campaign-roster'
import { isBrandAccount, keywordNeedles } from '@/lib/campaign-targets'
import { afterInfluencerUpsert, scrapedProfileHasData, scrapedProfileUpdate } from '@/lib/influencer-upsert'
import { notifyCampaignTeam } from '@/lib/notifications'
import { PersonLinkError, describeMainProfileOfPerson, findInfluencerExact, findOrCreateInfluencerExact, linkProfile, normalizeHandle } from '@/lib/person-profiles'

/**
 * TIKTOK AUTO-LINK (Nov 2026).
 *
 * PMs add creators by their Instagram handle, and a TikTok video only counts
 * in a campaign when it is credited to one of its members: the campaign
 * "Dorco - Delyplus" had 28 Instagram members, TikTok among its platforms and
 * not one TikTok video, although two creators had already published theirs
 * there.
 *
 * A creator is a PERSON with several PROFILES (src/lib/person-profiles.ts).
 * Once a day, for every live campaign that includes TikTok, ONE batched actor
 * run reads:
 *
 *   1. The CANDIDATE TikTok account of each CONFIRMED Instagram member that
 *      has no TikTok profile yet: the tiktok.com/@user linked in her Instagram
 *      bio/website, else the same username. It is linked ON EVIDENCE only: a
 *      video inside the campaign dates that references the brand (the same
 *      rule engine as every other capture). A namesake who never publishes the
 *      campaign's content is never linked. The account becomes a PROFILE of
 *      her person (linkProfile, evidence 'autolink_video', actor = system) and
 *      NEVER a member of the campaign: the video is stored credited to the
 *      Instagram member (Media.influencerId) and published by the TikTok
 *      profile (Media.publishedByInfluencerId), so the campaign keeps the same
 *      creators.
 *   2. The TikTok profiles ALREADY linked to the person of a confirmed member
 *      (by this pass, or by a PM in "Añadir publicación por URL") that are not
 *      members themselves. No other cron reads a profile that is not a member
 *      yet, so this pass keeps reading them; no evidence is needed to link
 *      (they are linked), only the campaign rules to store each video.
 *
 * Guards: a TikTok account that already is a profile of ANOTHER person is
 * never linked (it is not even read) and is reported in the summary; when that
 * leaves the member's TikTok unread for the campaign, its team is told once
 * ("TikTok sin vincular": never a silent pause). An account that is one of the
 * campaign's "Cuentas de Marca Objetivo", or the brand's own connected
 * Instagram username, is the brand's: it is never read as the TikTok of a
 * creator, linked or not (every video of the brand would be stored in her row),
 * and is reported in the summary. No CampaignInfluencer row is ever created here.
 *
 * LEGACY TWINS: until 12 Nov 2026 the linked account was added as a second
 * member of the campaign, recorded in CampaignInfluencer.source as
 * 'tiktok_link:<instagram influencer id>'. Those rows are left exactly as they
 * are: they are members, the member crons read them and their content is
 * credited to themselves (rule 1 of src/lib/campaign-roster.ts). Their
 * Instagram member is not looked for again.
 */

/** LEGACY: CampaignInfluencer.source of a TikTok twin membership created before 12 Nov 2026. Never written any more. */
export const TIKTOK_LINK_SOURCE_PREFIX = 'tiktok_link:'
const CHECKED_KEY = 'tiktok_link_checked'
/** Setting: '<campaignId>:<member influencer id>:<handle>' → ISO time its team was told the account is not linked */
const NOT_LINKED_NOTIFIED_KEY = 'tiktok_link_not_linked_notified'
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

/** LEGACY twins only: the Instagram influencer id a TikTok membership was linked from, or null. */
export function linkedInstagramId(source: string | null | undefined): string | null {
  return source && source.startsWith(TIKTOK_LINK_SOURCE_PREFIX) ? source.slice(TIKTOK_LINK_SOURCE_PREFIX.length) || null : null
}

type LinkOutcome =
  | { kind: 'linked'; profile: { id: string; username: string }; alreadyLinked: boolean }
  | { kind: 'other_person'; profileId: string; personId: string | null }

/**
 * Adds the TikTok account `handle` as a PROFILE of the person behind the
 * Instagram member, on the evidence of `evidence` (a video of the campaign it
 * published). Reuses the TikTok Influencer row when one exists under any
 * casing (hashtag scrapes and profile analyses create them), creates it
 * otherwise, and enriches it with the scraped profile. Never creates a
 * membership and never touches Media. A TikTok account that already belongs to
 * ANOTHER person is left alone: { kind: 'other_person' }.
 */
async function linkTikTokOnEvidence(params: {
  member: { id: string; username: string }
  handle: string
  scraped: ScrapedProfile
  campaignName: string
  evidence: ScrapedPost
}): Promise<LinkOutcome> {
  const { member, handle, scraped } = params
  // The casing TikTok reports, when it is the account that was asked for
  const reported = String(scraped.username || '').trim().replace(/^@+/, '')
  const username = normalizeHandle(reported) === handle ? reported : handle
  const row = await findOrCreateInfluencerExact('TIKTOK', username, null)

  let alreadyLinked: boolean
  try {
    const linked = await linkProfile({
      memberInfluencerId: member.id,
      profileInfluencerId: row.id,
      actor: null,
      evidence: 'autolink_video',
      summary: `@${row.username} (TikTok) añadido como perfil de @${member.username} (Instagram). Publicó un vídeo de la campaña "${params.campaignName}"${params.evidence.permalink ? `: ${params.evidence.permalink}` : ''}`,
    })
    alreadyLinked = linked.alreadyLinked
  } catch (err) {
    if (err instanceof PersonLinkError && err.code === 'profile_has_other_person') return { kind: 'other_person', profileId: row.id, personId: err.personId }
    throw err
  }

  try {
    if (row.created) {
      // A bare row was just created: everything the scrape knows is better than nothing
      await prisma.influencer.update({ where: { id: row.id }, data: { ...scrapedProfileUpdate(scraped, {}), dataSource: 'apify' } })
    } else if (scrapedProfileHasData(scraped)) {
      await prisma.influencer.update({ where: { id: row.id }, data: scrapedProfileUpdate(scraped) })
    }
  } catch (err) {
    console.error(`[TikTokAutolink] could not refresh the profile @${row.username}:`, err instanceof Error ? err.message : err)
  }
  afterInfluencerUpsert(row.id, scraped.avatarUrl)

  return { kind: 'linked', profile: { id: row.id, username: row.username }, alreadyLinked }
}

/**
 * Keeps a linked TikTok profile fresh from the daily read. No other cron
 * reads it while it is not a member, and its followers feed the estimates of
 * the pieces it publishes. A windowed read is not a profile analysis: the
 * averages of the few videos of the window only fill a row that was never
 * analysed, they never replace the ones of a real analysis.
 */
async function refreshLinkedProfile(profile: { id: string; username: string; analysed: boolean }, scraped: ScrapedProfile): Promise<void> {
  try {
    if (scrapedProfileHasData(scraped)) {
      const data = scrapedProfileUpdate(scraped)
      if (profile.analysed) {
        for (const key of ['engagementRate', 'avgLikes', 'avgComments', 'avgViews'] as const) delete data[key]
      }
      await prisma.influencer.update({ where: { id: profile.id }, data })
    }
  } catch (err) {
    console.error(`[TikTokAutolink] could not refresh the profile @${profile.username}:`, err instanceof Error ? err.message : err)
  }
  afterInfluencerUpsert(profile.id, scraped.avatarUrl)
}

export interface TikTokAutolinkSummary {
  at: string
  campaigns: Array<{
    id: string
    name: string
    /** Instagram members whose TikTok account was looked for */
    candidates: number
    /** TikTok profiles already linked to a member's person that were read (not members: no other cron reads them) */
    known: number
    /** TikTok usernames added as a profile of a member in this pass */
    linked: string[]
    /** Videos that ENTERED the campaign in this pass (a video it already held is refreshed, not counted) */
    videos: number
  }>
  handlesScanned: number
  /** Handles the actor answered for (profile read or reported missing) */
  answered: number
  notFound: number
  /** TikTok accounts added as a profile of a creator in this pass (each account once) */
  linked: number
  videos: number
  /** Handles that returned as many videos as were asked for: older videos of the window may not have been read */
  truncated: string[]
  /**
   * Accounts that were NOT linked or not read, never silently. 'other_person':
   * the candidate TikTok account already is a profile of another person (it is
   * not read). 'brand_account': the account is one of the campaign's "Cuentas
   * de Marca Objetivo" (never read as the TikTok of a creator, linked or not).
   */
  notLinked: Array<{ campaignId: string; campaign: string; member: string; handle: string; reason: 'other_person' | 'brand_account' }>
  /** Accounts whose linking or storing failed: not recorded as read, the next pass reads them again */
  failed: Array<{ campaignId: string; campaign: string; member: string; handle: string }>
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

async function loadMemo(key: string): Promise<Record<string, string>> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } })
    const parsed = row?.value ? JSON.parse(row.value) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function saveMemo(key: string, map: Record<string, string>): Promise<void> {
  const value = JSON.stringify(map)
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }).catch(() => {})
}

const loadChecked = (): Promise<CheckedMap> => loadMemo(CHECKED_KEY)
const saveChecked = (map: CheckedMap): Promise<void> => saveMemo(CHECKED_KEY, map)

/** A candidate TikTok account that is not linked because it already is a profile of another person. */
interface OtherPersonSkip {
  campaignId: string
  campaign: string
  memberId: string
  member: string
  handle: string
  /** The TikTok profile row and the person it belongs to */
  profileId: string | null
  personId: string | null
}

const notLinkedKey = (skip: Pick<OtherPersonSkip, 'campaignId' | 'memberId' | 'handle'>) => `${skip.campaignId}:${skip.memberId}:${skip.handle}`

/**
 * NEVER A SILENT PAUSE. A candidate account that already is a profile of
 * another person is not linked and, from then on, not read for this campaign:
 * the videos the member publishes there stop entering on their own (and the
 * manual endpoint refuses them too). The campaign team is told ONCE per
 * (campaign, member, account), naming both creators. `memo` records who was
 * told; returns true when a notice was sent.
 */
async function notifyNotLinkedOnce(skip: OtherPersonSkip, memo: Record<string, string>, now: Date): Promise<boolean> {
  const key = notLinkedKey(skip)
  if (memo[key]) return false
  const owner = skip.personId ? await describeMainProfileOfPerson(skip.personId, skip.profileId).catch(() => null) : null
  const sent = await notifyCampaignTeam(skip.campaignId, {
    type: 'cron_stale',
    title: 'TikTok sin vincular',
    message: `@${skip.handle} (TikTok) no se ha añadido como perfil de @${skip.member} en "${skip.campaign}": ya es un perfil de ${owner ?? 'otra creadora'}. Sus vídeos de TikTok no entran solos en esta campaña. Si son la misma persona, avisa a David: todavía no se pueden unir desde la plataforma.`,
    link: `/campaigns/${skip.campaignId}`,
  })
  // Nobody to tell (a campaign with no active team) is not "told": the next pass tries again
  if (sent === 0) return false
  memo[key] = now.toISOString()
  return true
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/**
 * One pass of the auto-link over every eligible campaign (or one campaign).
 * Budget gates and the daily throttle are the caller's (the cron route); this
 * only stops on the Apify hard limit. Never throws.
 */
export async function runTikTokAutolink(opts: { campaignId?: string; now?: Date } = {}): Promise<TikTokAutolinkSummary> {
  const now = opts.now ?? new Date()
  const summary: TikTokAutolinkSummary = { at: now.toISOString(), campaigns: [], handlesScanned: 0, answered: 0, notFound: 0, linked: 0, videos: 0, truncated: [], notLinked: [], failed: [], partial: false }
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
          // Oldest membership first: when two members point at the same TikTok account, the same one always gets it
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            status: true,
            source: true,
            influencer: { select: { id: true, username: true, platform: true, bio: true, website: true, personId: true } },
          },
        },
      },
    })

    /**
     * One TikTok account to read for one campaign. `profile` set = it already
     * is a linked profile of the member's person (kept being read); null = the
     * candidate of an Instagram member, to be linked on evidence.
     */
    interface Candidate {
      campaignIndex: number
      /** The member the videos are credited to */
      memberId: string
      memberUsername: string
      handle: string
      profile: { id: string; username: string; analysed: boolean } | null
    }
    const live = campaigns.filter(c => {
      if (!campaignHasTargets(c)) return false
      if (now < new Date(c.startDate)) return false
      const endExclusive = campaignWindowEndExclusive(c.endDate)
      return !endExclusive || now.getTime() < endExclusive.getTime() + GRACE_AFTER_END_MS
    })
    const isConfirmed = (status: string) => (STORY_SCAN_STATUSES as readonly string[]).includes(status)
    // The brand's accounts of each live campaign: its targets and its own connected Instagram
    const brandAccountsOf = await loadCampaignBrandAccounts(live)

    // Every TikTok profile of the persons behind the members of the live campaigns
    const personIds = Array.from(new Set(
      live.flatMap(c => c.influencers.map(ci => ci.influencer.personId)).filter((id): id is string => !!id)
    ))
    const linkedTikToks = personIds.length === 0
      ? []
      : await prisma.influencer.findMany({
          where: { platform: 'TIKTOK', personId: { in: personIds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, username: true, personId: true, lastScraped: true },
        })
    const tiktoksOfPerson = new Map<string, typeof linkedTikToks>()
    for (const row of linkedTikToks) {
      if (!row.personId) continue
      const list = tiktoksOfPerson.get(row.personId)
      if (list) list.push(row)
      else tiktoksOfPerson.set(row.personId, [row])
    }

    // The TikTok row that already exists for a candidate handle (one lookup per handle)
    const existingByHandle = new Map<string, Awaited<ReturnType<typeof findInfluencerExact>>>()
    const existingTikTok = async (handle: string) => {
      if (!existingByHandle.has(handle)) existingByHandle.set(handle, await findInfluencerExact('TIKTOK', handle))
      return existingByHandle.get(handle) ?? null
    }

    const candidates: Candidate[] = []
    /** Candidate accounts left unread because they are a profile of another person: their teams are told (once) */
    const otherPersonSkips: OtherPersonSkip[] = []
    for (let campaignIndex = 0; campaignIndex < live.length; campaignIndex++) {
      const campaign = live[campaignIndex]
      const entry: TikTokAutolinkSummary['campaigns'][number] = { id: campaign.id, name: campaign.name, candidates: 0, known: 0, linked: [], videos: 0 }
      summary.campaigns.push(entry)

      const memberIds = new Set(campaign.influencers.map(ci => ci.influencer.id))
      // TikTok accounts that are MEMBERS (added by a PM, or legacy twins): the
      // member crons read them and their content is their own. Never touched here.
      const tiktokHandles = new Set<string>()
      const linkedIgIds = new Set<string>()
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'TIKTOK') continue
        tiktokHandles.add(cleanHandle(ci.influencer.username))
        const igId = linkedInstagramId(ci.source)
        if (igId) linkedIgIds.add(igId)
      }

      // (2) Profiles already linked to the person of a confirmed member and
      // that are not members themselves: keep reading them.
      const confirmedPersons = new Set<string>()
      for (const ci of campaign.influencers) {
        if (ci.influencer.personId && isConfirmed(ci.status)) confirmedPersons.add(ci.influencer.personId)
      }
      // The brand's own account (a "Cuenta de Marca Objetivo", or the brand's
      // connected Instagram under the same username) is never read as the
      // TikTok of a creator: every video of the brand references the brand and
      // would be stored in her row. The one member it may belong to is a brand
      // account of the campaign too.
      const brand = brandAccountsOf.get(campaign.id) ?? { targets: [], own: [] }
      const isBrand = (handle: string) => isBrandAccount(brand.targets, handle) || isBrandAccount(brand.own, handle)
      const brandAccountOfAnother = (handle: string, memberUsername: string) => isBrand(handle) && !isBrand(memberUsername)
      const linkedProfiles = Array.from(confirmedPersons)
        .flatMap(personId => tiktoksOfPerson.get(personId) ?? [])
        .filter(row => !memberIds.has(row.id))
      if (linkedProfiles.length > 0) {
        // Who is credited is the roster's decision, the same one the manual endpoint takes
        const roster = await loadCampaignRoster(campaign.id)
        for (const row of linkedProfiles) {
          const handle = normalizeHandle(row.username)
          const credit = roster.creditForInfluencer(row.id)
          if (!handle || !credit || credit.self) continue
          if (brandAccountOfAnother(handle, credit.member.username)) {
            summary.notLinked.push({ campaignId: campaign.id, campaign: campaign.name, member: credit.member.username, handle, reason: 'brand_account' })
            continue
          }
          candidates.push({
            campaignIndex,
            memberId: credit.member.influencerId,
            memberUsername: credit.member.username,
            handle,
            profile: { id: row.id, username: row.username, analysed: !!row.lastScraped },
          })
          entry.known++
        }
      }

      // (1) Confirmed Instagram members with no TikTok profile: look for it
      for (const ci of campaign.influencers) {
        if (ci.influencer.platform !== 'INSTAGRAM') continue
        if (!isConfirmed(ci.status)) continue
        // Legacy twin: her TikTok already is a member of the campaign
        if (linkedIgIds.has(ci.influencer.id)) continue
        // Her person already has a TikTok profile (read above, or a member): nothing to look for
        if (ci.influencer.personId && (tiktoksOfPerson.get(ci.influencer.personId)?.length ?? 0) > 0) continue
        const { handle } = tiktokCandidateHandle(ci.influencer)
        if (!handle || tiktokHandles.has(handle)) continue
        // Guard: a brand account of the campaign (her bio links the brand's TikTok) is not hers
        if (brandAccountOfAnother(handle, ci.influencer.username)) {
          summary.notLinked.push({ campaignId: campaign.id, campaign: campaign.name, member: ci.influencer.username, handle, reason: 'brand_account' })
          continue
        }
        // Guard: an account that already is a profile of ANOTHER person is
        // never linked, so it is not read either. Reported, never silent: the
        // team is told, unless that person has a confirmed member in this very
        // campaign (the account is then read above and its videos enter under her).
        const existing = await existingTikTok(handle)
        if (existing?.personId) {
          summary.notLinked.push({ campaignId: campaign.id, campaign: campaign.name, member: ci.influencer.username, handle, reason: 'other_person' })
          if (!confirmedPersons.has(existing.personId)) {
            otherPersonSkips.push({ campaignId: campaign.id, campaign: campaign.name, memberId: ci.influencer.id, member: ci.influencer.username, handle, profileId: existing.id, personId: existing.personId })
          }
          continue
        }
        candidates.push({ campaignIndex, memberId: ci.influencer.id, memberUsername: ci.influencer.username, handle, profile: null })
        entry.candidates++
      }
    }
    if (summary.notLinked.length > 0) {
      console.warn(`[TikTokAutolink] ${summary.notLinked.length} TikTok account(s) not linked or not read: ${summary.notLinked.map(n => `@${n.handle} (${n.reason === 'brand_account' ? 'a brand account of the campaign' : 'a profile of another person'}; candidate of @${n.member})`).join(', ')}`)
    }
    // Never a silent pause: each team is told once which account is left unread
    // and whose it is. The memo forgets the pairs that are no longer skipped, so
    // a pair that comes back is told again (a single-campaign run only judges
    // its own campaign).
    const told = await loadMemo(NOT_LINKED_NOTIFIED_KEY)
    {
      const skippedNow = new Set(otherPersonSkips.map(notLinkedKey))
      let changed = false
      for (const key of Object.keys(told)) {
        if (skippedNow.has(key) || (opts.campaignId && key.split(':')[0] !== opts.campaignId)) continue
        delete told[key]
        changed = true
      }
      for (const skip of otherPersonSkips) {
        if (await notifyNotLinkedOnce(skip, told, now)) changed = true
      }
      if (changed) await saveMemo(NOT_LINKED_NOTIFIED_KEY, told)
    }
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
    const readBefore = new Map<string, Date>()
    for (const [handle, since] of sinceByHandle) (freshHandles.has(handle) ? fresh : readBefore).set(handle, since)
    const earliest = (m: Map<string, Date>) => new Date(Math.min(...Array.from(m.values()).map(d => d.getTime())))

    const profiles = new Map<string, ScrapedProfile>()
    const notFound = new Set<string>()
    const incomplete = new Set<string>()
    for (const [group, videos] of [[fresh, FIRST_PASS_VIDEOS], [readBefore, DAILY_PASS_VIDEOS]] as Array<[Map<string, Date>, number]>) {
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
    summary.handlesScanned = fresh.size + readBefore.size
    summary.answered = profiles.size + notFound.size
    summary.notFound = notFound.size
    if (summary.truncated.length > 0) {
      console.warn(`[TikTokAutolink] ${summary.truncated.length} profile(s) returned the maximum number of videos — older ones were not read: ${summary.truncated.join(', ')}`)
    }

    /** TikTok profiles added to a creator during THIS pass (a creator of two campaigns is linked once) */
    const linkedNow = new Set<string>()
    for (const c of candidates) {
      const campaign = live[c.campaignIndex]
      const entry = summary.campaigns[c.campaignIndex]
      const scraped = profiles.get(c.handle)
      // A handle the run did not answer for is UNKNOWN: not stamped, read again next pass
      if (!scraped && !notFound.has(c.handle)) continue
      // A handle of an unfinished run may lack its OLDER videos: link on what
      // matched, but do not record the pair as read
      const key = pairKey(c)
      const previousStamp = checked[key]
      if (!incomplete.has(c.handle)) checked[key] = `${now.toISOString()}|${fingerprints[c.campaignIndex]}`
      if (!scraped) continue

      const matching: ScrapedPost[] = scraped.recentPosts.filter(
        post => !!post.externalId && mediaMatchesCampaignRules(campaign, scrapedPostToRuleItem(post))
      )

      try {
        let profile: { id: string; username: string }
        let memberId = c.memberId
        let memberUsername = c.memberUsername
        let publishedBy: string | null
        if (c.profile) {
          profile = c.profile
          publishedBy = profile.id
          await refreshLinkedProfile(c.profile, scraped)
          if (matching.length === 0) continue
        } else {
          // EVIDENCE: without a video of the campaign nothing is linked or created
          if (matching.length === 0) continue
          const outcome = await linkTikTokOnEvidence({
            member: { id: c.memberId, username: c.memberUsername },
            handle: c.handle,
            scraped,
            campaignName: campaign.name,
            evidence: matching[0],
          })
          if (outcome.kind === 'other_person') {
            summary.notLinked.push({ campaignId: campaign.id, campaign: campaign.name, member: c.memberUsername, handle: c.handle, reason: 'other_person' })
            console.warn(`[TikTokAutolink] @${c.handle} published content of "${campaign.name}" but already is a profile of another person: not linked to @${c.memberUsername}`)
            // From the next pass on it is not read for this member: tell the
            // team now, unless its person has a confirmed member in this campaign
            // (its videos then enter under her; asked again here because that
            // person may have been created by this very pass)
            const readForHerPerson = outcome.personId
              ? await prisma.campaignInfluencer.count({
                  where: { campaignId: campaign.id, status: { in: [...STORY_SCAN_STATUSES] }, influencer: { personId: outcome.personId } },
                })
              : 0
            if (readForHerPerson === 0) {
              const skip = { campaignId: campaign.id, campaign: campaign.name, memberId: c.memberId, member: c.memberUsername, handle: c.handle, profileId: outcome.profileId, personId: outcome.personId }
              if (await notifyNotLinkedOnce(skip, told, now)) await saveMemo(NOT_LINKED_NOTIFIED_KEY, told)
            }
            continue
          }
          profile = outcome.profile
          publishedBy = profile.id
          if (!outcome.alreadyLinked) linkedNow.add(profile.id)
          // Who is credited is the roster's decision (the Instagram member,
          // unless her person has several members in this campaign)
          const credit = (await loadCampaignRoster(campaign.id)).creditForInfluencer(profile.id)
          if (credit) {
            memberId = credit.member.influencerId
            memberUsername = credit.member.username
            if (credit.self) publishedBy = null
          }
        }

        // Store the videos: credited to the member, published by the TikTok profile
        const entered: ScrapedPost[] = []
        let notStored = 0
        for (const post of matching) {
          const held = await prisma.media.count({ where: { externalId: post.externalId, platform: 'TIKTOK', campaignId: campaign.id } })
          const ok = await upsertCampaignPost(campaign.id, memberId, 'TIKTOK', post, { publishedByInfluencerId: publishedBy })
          if (!ok) { notStored++; continue }
          // Already in the campaign (added by hand, or by an earlier pass): refreshed, not new
          if (held > 0) continue
          entered.push(post)
          await prisma.media.updateMany({
            where: { externalId: post.externalId, platform: 'TIKTOK', campaignId: campaign.id },
            data: { dataSource: 'apify' },
          }).catch(() => {})
        }
        entry.videos += entered.length
        summary.videos += entered.length

        if (linkedNow.has(profile.id)) {
          entry.linked.push(profile.username)
          const captured = entered.length === 0
            ? `Su vídeo de "${campaign.name}" ya estaba en la campaña.`
            : `${entered.length === 1 ? 'Se ha capturado 1 vídeo' : `Se han capturado ${entered.length} vídeos`} en "${campaign.name}".`
          await notifyCampaignTeam(campaign.id, {
            type: 'influencer_added',
            title: 'TikTok vinculado',
            message: `@${profile.username} (TikTok) se ha añadido como perfil de @${memberUsername}. ${captured} La campaña sigue con las mismas creadoras.`,
            link: `/campaigns/${campaign.id}`,
          })
        } else {
          // A profile linked earlier: the same notice a member's new post gets from check-posts
          for (const post of entered) {
            await notifyCampaignTeam(campaign.id, {
              type: 'media_posted',
              title: `@${memberUsername} ha publicado`,
              message: `@${memberUsername} ha publicado en TikTok desde su perfil @${profile.username} para la campaña "${campaign.name}". ${post.permalink ? `Ver: ${post.permalink} ` : ''}Consejo: espera 7 días antes de revisar las métricas.`,
              link: `/campaigns/${campaign.id}`,
            })
          }
        }
        // A video that could not be stored must not be lost: later passes only
        // read what is new, so the pair is left as not read (see the catch)
        if (notStored > 0) throw new Error(`${notStored} video(s) of the campaign could not be stored`)
      } catch (err) {
        // One account failing never stops the rest. The pair is NOT recorded as
        // read, so the next pass reads it again as far back as this one did.
        if (previousStamp === undefined) delete checked[key]
        else checked[key] = previousStamp
        summary.partial = true
        summary.failed.push({ campaignId: campaign.id, campaign: campaign.name, member: c.memberUsername, handle: c.handle })
        console.error(`[TikTokAutolink] @${c.handle} in "${campaign.name}" failed:`, err instanceof Error ? err.message : err)
      }
    }
    summary.linked = linkedNow.size

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
