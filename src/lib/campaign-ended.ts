import { campaignWindowEndExclusive } from '@/lib/assignment-rules'

/**
 * When the capture crons stop reading a campaign that has ended (16 Nov 2026).
 *
 * The track cron (brand hashtags and mentions) and check-posts (the creators'
 * own accounts) read every ACTIVE campaign, including the eight whose end date
 * was months behind: nothing they found could be stored (rule 2 rejects what is
 * published after the end), so every actor run was paid for nothing and the
 * "creator discovered" notices came almost entirely from campaigns that were
 * over. A campaign is read until this many days after its end, the same grace
 * the daily TikTok pass already had: a video of the last day, or of a pause
 * that spans the end, is still read. A campaign without an end date (Social
 * Listening) never ends for the crons. The 7 and 14 day re-reading of views
 * (src/lib/media-enrich.ts) is per publication and does not go through here.
 */
export const CAMPAIGN_ENDED_GRACE_DAYS = 3
export const CAMPAIGN_ENDED_GRACE_MS = CAMPAIGN_ENDED_GRACE_DAYS * 86_400_000

/** True when `now` is at or past the end of the campaign's window plus the grace; false without an end date. */
export function campaignEndedForCrons(campaign: { endDate: Date | string | null | undefined }, now: Date = new Date()): boolean {
  const endExclusive = campaignWindowEndExclusive(campaign.endDate)
  if (!endExclusive) return false
  return now.getTime() >= endExclusive.getTime() + CAMPAIGN_ENDED_GRACE_MS
}

export interface SkippedCampaign {
  id: string
  name: string
  reason: 'ended' | 'future' | 'empty'
}
