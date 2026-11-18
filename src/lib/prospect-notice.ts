import { prisma } from '@/lib/db'
import { STORY_SCAN_STATUSES, campaignWindowEndExclusive } from '@/lib/campaign-capture'
import { campaignTeamUserIds } from '@/lib/notifications'

/**
 * «Creadoras en Prospecto: la captura no las lee» (16 Nov 2026).
 *
 * Every automatic reading of a creator's own account (check-posts, the stories
 * scan, the daily TikTok pass) only covers members in Acordado or later
 * (STORY_SCAN_STATUSES). PMs leave their creators in Prospecto for the whole
 * campaign and set Completado at the end: «11.- Vileda - Micros Noviembre» had
 * 33 of 33 in PROSPECT on day 16 and nothing was read, in silence. This module
 * is the ONE rule behind the notice on the campaign page (GET
 * /api/campaigns/[id] → captureNotice) and the weekly notification the
 * watchdog sends, so they can never disagree.
 */

/** Days after the start before the notice applies: the first days are for the PM to confirm the creators. */
export const PROSPECT_NOTICE_MIN_DAYS = 3
/** Share of members still in PROSPECT from which the notice applies. */
export const PROSPECT_NOTICE_SHARE = 0.5
/** The notification is repeated no sooner than this while the notice persists. */
export const PROSPECT_NOTICE_REPEAT_DAYS = 7
/** Notification.type of the weekly notice. */
export const PROSPECT_NOTICE_TYPE = 'capture_prospects'

export function prospectNoticeSettingKey(campaignId: string): string {
  return `prospect_notice_${campaignId}`
}

export interface ProspectNotice {
  /** Members of the campaign (every network, every status) */
  members: number
  /** Members still in PROSPECT */
  prospects: number
  /** Members in Acordado or later: the ones the automatic capture reads */
  scanning: number
  /** Whole days since the campaign started */
  startedDays: number
}

export interface ProspectNoticeCampaign {
  type: string
  startDate: Date | string
  endDate: Date | string | null
  influencers: ReadonlyArray<{ status: string }>
}

/**
 * The notice of a campaign, or null when it does not apply: the campaign must
 * have started PROSPECT_NOTICE_MIN_DAYS ago or more, still be inside its
 * dates, not be Social Listening (its members are not read for stories and are
 * not the point of the campaign), have members, and either half or more of
 * them in PROSPECT or none at all in Acordado or later.
 */
export function prospectNoticeFor(campaign: ProspectNoticeCampaign, now: Date = new Date()): ProspectNotice | null {
  if (campaign.type === 'SOCIAL_LISTENING') return null
  const start = new Date(campaign.startDate).getTime()
  if (!Number.isFinite(start)) return null
  const startedDays = Math.floor((now.getTime() - start) / 86_400_000)
  if (startedDays < PROSPECT_NOTICE_MIN_DAYS) return null
  const endExclusive = campaignWindowEndExclusive(campaign.endDate)
  if (endExclusive && now >= endExclusive) return null

  const members = campaign.influencers.length
  if (members === 0) return null
  const prospects = campaign.influencers.filter(ci => ci.status === 'PROSPECT').length
  const scanning = campaign.influencers.filter(ci => (STORY_SCAN_STATUSES as readonly string[]).includes(ci.status)).length
  if (prospects / members < PROSPECT_NOTICE_SHARE && scanning > 0) return null
  return { members, prospects, scanning, startedDays }
}

/** The sentence of the notice, in Spanish (the language of every notification). */
export function prospectNoticeMessage(notice: ProspectNotice): string {
  const base = `La captura automática (publicaciones, stories, TikTok) solo lee creadoras en Acordado o posterior: ${notice.prospects} de ${notice.members} están en Prospecto`
  return notice.scanning === 0 && notice.prospects < notice.members ? `${base} y ninguna está en Acordado o posterior.` : `${base}.`
}

export interface ProspectNoticeOutcome {
  campaignId: string
  name: string
  notice: ProspectNotice
  /** A notification was created in this call */
  notified: boolean
  /** The notice was already sent this recently (ISO), so nothing was sent now */
  lastNoticeAt: string | null
  recipients: number
}

/**
 * The weekly notification, from the watchdog: for every live campaign whose
 * notice applies, tell its team (creator + assigned PMs) AND every active
 * ADMIN, each person once, unless it was told less than
 * PROSPECT_NOTICE_REPEAT_DAYS ago (Setting prospect_notice_<id> = ISO of the
 * last notice). A campaign whose notice no longer applies loses that setting,
 * so a relapse is told at once. Never throws; one campaign's failure does not
 * stop the others.
 */
export async function notifyProspectNotices(
  campaigns: ReadonlyArray<ProspectNoticeCampaign & { id: string; name: string }>,
  now: Date = new Date()
): Promise<ProspectNoticeOutcome[]> {
  const out: ProspectNoticeOutcome[] = []
  let adminIds: string[] | null = null
  for (const campaign of campaigns) {
    const key = prospectNoticeSettingKey(campaign.id)
    try {
      const notice = prospectNoticeFor(campaign, now)
      if (!notice) {
        await prisma.setting.deleteMany({ where: { key } })
        continue
      }
      const row = await prisma.setting.findUnique({ where: { key } })
      const lastAt = row?.value ? Date.parse(row.value) : NaN
      if (Number.isFinite(lastAt) && now.getTime() - lastAt < PROSPECT_NOTICE_REPEAT_DAYS * 86_400_000) {
        out.push({ campaignId: campaign.id, name: campaign.name, notice, notified: false, lastNoticeAt: new Date(lastAt).toISOString(), recipients: 0 })
        continue
      }
      if (adminIds === null) {
        adminIds = (await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } })).map(u => u.id)
      }
      const recipients = Array.from(new Set([...(await campaignTeamUserIds(campaign.id)), ...adminIds]))
      if (recipients.length === 0) {
        out.push({ campaignId: campaign.id, name: campaign.name, notice, notified: false, lastNoticeAt: null, recipients: 0 })
        continue
      }
      const message = `En "${campaign.name}", ${prospectNoticeMessage(notice).replace(/^La /, 'la ')} Cambia el estado en Elegir cuando la creadora confirme; hasta entonces sus publicaciones, stories y TikTok no se leen solos.`
      await prisma.notification.createMany({
        data: recipients.map(userId => ({
          userId,
          type: PROSPECT_NOTICE_TYPE,
          title: 'Creadoras en Prospecto: la captura no las lee',
          message,
          link: `/campaigns/${campaign.id}`,
          metadata: { campaignId: campaign.id, prospects: notice.prospects, members: notice.members },
        })),
      })
      const value = now.toISOString()
      await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
      console.log(`[prospect-notice] "${campaign.name}": ${notice.prospects} of ${notice.members} members in PROSPECT (${notice.scanning} readable) — ${recipients.length} people told`)
      out.push({ campaignId: campaign.id, name: campaign.name, notice, notified: true, lastNoticeAt: null, recipients: recipients.length })
    } catch (err) {
      console.error(`[prospect-notice] "${campaign.name}" failed:`, err instanceof Error ? err.message : err)
    }
  }
  return out
}
